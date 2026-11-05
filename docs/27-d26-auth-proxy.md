# 27 — D26 實作規格：`auth.atwho.org` 薄代理 ＋ App code 交換

> 建立：2026-11-05｜狀態：**待派工**
> 依據：`docs/26` §3（方案 B）＋ §9.5 順序第 2 步
> 目標：其他 App 用**穩定網址** `https://auth.atwho.org` 取得登入／註冊／身分，統一帳號來源仍是 AtWhoMail 的 D1

## 1. 架構

```
其他 App（crm.example.com）
   │ ① 導去登入
   ▼
https://app.atwho.org/?app=<app_id>&redirect_uri=<https://crm.example.com/cb>
   │ ② 使用者登入（既有流程：Email 驗證碼註冊 / 信箱登入 / 管理員登入）
   │ ③ 前端呼叫 POST https://auth.atwho.org/api/auth/app-login
   ▼
https://auth.atwho.org  ──(薄代理，只轉 /api/auth/*)──▶  atwhomail-api（同一 D1）
   │ ④ 回傳 { redirect: "<redirect_uri>?code=..." }
   ▼
https://crm.example.com/cb?code=…        （60 秒、一次性）
   │ ⑤ 後端呼叫 POST https://auth.atwho.org/api/auth/exchange
   ▼
{ token, user }   ← JWT（HS256，aud=<app_id>、scope='app'）
```

## 2. 新 Worker：`packages/auth`（薄代理）

- `wrangler.jsonc`：`name: "atwhomail-auth"`、`routes: [{ pattern: "auth.atwho.org", custom_domain: true }]`
- 只允許 `/api/auth/*`（其他路徑 → `404 { error: { code: "NOT_FOUND" } }`）
- 轉發：保留 method／headers（`content-type`、`authorization`、`cookie`、`user-agent`、`cf-connecting-ip`）／body／status
- 加上 `X-Forwarded-Host: auth.atwho.org`（供 API 判斷來源，僅記錄用，不作為授權依據）
- 上游固定 `https://atwhomail-api.ulhome.workers.dev`
- **不新增任何 secret／KV**（純代理 ✅）

## 3. Migration `0012_app_clients.sql`（只 CREATE）

```sql
CREATE TABLE IF NOT EXISTS app_clients (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id        TEXT NOT NULL UNIQUE,        -- 例如 'mycrm'（^[a-z][a-z0-9-]{1,31}$）
  name          TEXT NOT NULL,
  secret_hash   TEXT NOT NULL,               -- SHA-256(secret + JWT_SECRET)
  redirect_uris TEXT NOT NULL,               -- JSON array（完全相符比對）
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_codes (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash    TEXT NOT NULL UNIQUE,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  app_id       TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,             -- 60 秒
  consumed_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_auth_codes_exp ON auth_codes(expires_at);
```

## 4. API（`packages/api`）

### 4.1 App client 管理（owner only）
| 端點 | 說明 |
|---|---|
| `POST /api/apps` | body `{app_id, name, redirect_uris: string[]}` → 產生 32-byte secret，**只回一次** `{app_id, app_secret, redirect_uris}`；DB 存 SHA-256(secret + JWT_SECRET) |
| `GET /api/apps` | 列表（不含 secret）|
| `PATCH /api/apps/:id` | `{status?, redirect_uris?, name?}` |
| `DELETE /api/apps/:id` | 軟停用（status='disabled'）|
- 稽核：`app_created`／`app_updated`（只記 app_id、名稱、狀態；**不記 secret** ✅）

### 4.2 登入 → 發 code
`POST /api/auth/app-login`（需既有 session：`requireSession` 或 owner JWT）

```jsonc
{ "app": "mycrm", "redirect_uri": "https://crm.example.com/cb" }
```

1. 驗 `app`（app_clients.status='active'）→ 否則 `400 UNKNOWN_APP`
2. 驗 `redirect_uri` **完全相符** 白名單 → 否則 `400 INVALID_REDIRECT_URI`
3. `code = random 32 bytes hex`；`code_hash = SHA-256(code + JWT_SECRET)`
4. 寫 `auth_codes`（60 秒）
5. 回 `{ redirect: "<redirect_uri>?code=<code>" }`（前端 `location.assign` ✅）
- ⚠️ owner JWT 也要能呼叫（`scope='owner'` → `user_id = sub` ✅）；mailbox scope → 需有 `user_id`（用該地址的 `user_id` ✅）

### 4.3 code → token
`POST /api/auth/exchange`（公開，但需 secret）

```jsonc
{ "app_id": "mycrm", "app_secret": "...", "code": "...", "redirect_uri": "..." }
```

1. 驗 `app_id` 存在且 active；`SHA-256(app_secret + JWT_SECRET)` 與 `secret_hash` 比對（timing-safe 比較 ✅）
2. 驗 code：存在、未過期（60 秒）、`consumed_at IS NULL`、`app_id` 相同、`redirect_uri` 相同
3. 一次性消費（`UPDATE ... WHERE consumed_at IS NULL` → 影響列數必須為 1 ✅，否則 `409 CODE_ALREADY_USED`）
4. 簽 JWT `{ scope: "app", aud: app_id, sub: user_id, username, role, iat, exp }`（TTL 與既有 JWT_TTL_SEC 一致 ✅）
5. 回 `{ token, user: { id, username, display_name, role } }`
6. 錯誤碼：`INVALID_CLIENT`(401)、`INVALID_CODE`(400)、`CODE_ALREADY_USED`(409)、`INVALID_REDIRECT_URI`(400)
- 稽核：`app_login`（app_id、user_id）、`app_exchanged`（app_id、user_id）✅ N9 不含內容
- 速率限制：`exchange:<app_id>` 每分鐘 30 次 ✅

### 4.4 身分查詢
`GET /api/auth/me`（`requireSession`，含 app scope ✅）

```jsonc
{ "id": 2, "username": "itag", "display_name": null, "role": "owner", "created_at": 1793… }
```

- `scope='app'` → `sub` 是 **user id** ✅ → 查 `users`
- `scope='owner'` → 同上
- `scope='mailbox'` → 查該地址所屬 user ✅
- 回傳**不得**含 `password_hash`／`contact_email`（除非是本人且 scope='owner' 或 'app' ✅ → 允許 contact_email ✅）

### 4.5 session 解析擴充
- 現有 `resolveSession`／`resolveScope` 需要接受 `scope='app'` 的 JWT（驗簽後視為「使用者層級」✅）
- ⚠️ `scope='app'` **不得**用於 `/api/mail/*`（那些需要 owner／mailbox ✅）→ 一律 403 `SCOPE_NOT_ALLOWED`

## 5. 前端（`app.atwho.org`）

- 讀 query `app` ＋ `redirect_uri`：登入成功後（既有登入流程 ✅）自動呼叫 `app-login` → `location.assign(redirect)` ✅
- 若未登入 → 顯示登入／註冊（既有 ✅），登入後再呼叫 ✅
- 參數驗證失敗 → 顯示錯誤訊息（不要導向 ❌）
- 既有 `?register=1`／`?invite=` 行為**不變** ✅

## 6. 管理 UI（最小）

- `mail.atwho.org` 的「應用程式（App Clients）」區塊：
  - 列表（app_id／名稱／狀態／redirect_uris ✅）
  - 新增：輸入 app_id、名稱、redirect_uris → 顯示 secret **一次**（含複製 ✅）
  - 停用／啟用 ✅

## 7. 測試 T151–T160

- T151 `POST /api/apps` 建立 → 回 secret（一次）；DB 只存 hash
- T152 `app-login` 以 owner JWT → 回 `redirect` 含 code；`redirect_uri` 不在白名單 → 400
- T153 `exchange` 正確 secret/code → 200 + JWT（`aud=app_id`、`scope='app'`）
- T154 code 重複使用 → 409 `CODE_ALREADY_USED`
- T155 code 過期（60 秒）→ 400 `INVALID_CODE`
- T156 錯 secret → 401 `INVALID_CLIENT`
- T157 `GET /api/auth/me` 以 app token → 回 user；以 mailbox token → 回該 user
- T158 app token 呼叫 `/api/mail/inbox` → 403 `SCOPE_NOT_ALLOWED`
- T159 薄代理：`/api/auth/registration-mode` 可通過、`/api/mail/inbox` 被代理擋（404）
- T160 既有 T1–T150 零回歸

## 8. 部署順序（完成後由助手執行）

1. 套 migration `0012`
2. 部署 API（`atwhomail-api`）
3. 部署新 Worker（`atwhomail-auth`，自訂網域 `auth.atwho.org`）
4. 部署前端（`atwhomail-web`）

## 9. 不做（後續）

- Google OAuth（D27）
- refresh token／撤銷清單（目前靠短 TTL ＋ `/api/auth/me` 檢查 status）
