# 26 — 跨 App 共用登入／註冊（單一帳號中心）

> 建立：2026-11-04｜狀態：**評估／設計（待 owner 決策）**
> 需求（owner）：其他 App 系統共用 mail 的登入與註冊，**不重開發**；個人帳號的修改與管理**統一**

## 1. 現況（實查）

| 項目 | 現況 |
|---|---|
| 帳號資料 | ✅ `users`（username／display_name／password_hash argon2id／role owner\|visitor／status）＋ `email_addresses`（可獨立登入的信箱帳號）|
| Session | ✅ **JWT HS256**（`JWT_SECRET`）；payload：owner `{scope:'owner', sub:userId, pca}`、mailbox `{scope:'mailbox', sub:addressId, email, pca}` |
| 既有端點 | ✅ `/api/auth/login`、`/mailbox-login`、**`/whoami`**、`/owner-password`、`/owner-password/self`、`/register*`、`/registration-mode` |
| 註冊 | ✅ Email 驗證碼（D21）＋ 可分享連結（D22）|
| 別的 App | ❌ 目前無任何跨 App 認證機制 |

## 2. 三個方案比較

| 方案 | 做法 | 其他 App 改動 | AtWhoMail 改動 | 安全性 | 建議 |
|---|---|---|---|---|---|
| **A. 共用 `JWT_SECRET`** | 各 App 用同一把密鑰驗 JWT | 極小（1 行）| 0 | 🔴 **差**：任一 App 可**偽造**任何使用者的 token | ❌ 不建議 |
| **B. Redirect ＋ 一次性 code 交換**（本文件）| 導到 AtWhoMail 登入 → 回跳帶 `code` → App 後端用 `app_secret` 換 token | 小（1–2h）| 中（~6h）| 🟢 **好**：每個 App 獨立密鑰、可撤銷、token 有 `aud` | ✅ **推薦（現在做）** |
| **C. 完整 OIDC Provider** | `/.well-known/openid-configuration`＋`/authorize`＋`/token`＋`/userinfo`＋JWKS | 中（2h）| 大（~24–32h）| 🟢 最好（標準）| 🟡 未來升級 |

> 💡 **B 與 C 相容**：B 的 token 已是 JWT ✅ → 之後包成 OIDC 是「加殼」不是重寫 ✅

## 3. 方案 B 設計

### 3.1 資料表（migration 0011）

```sql
CREATE TABLE app_clients (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id        TEXT NOT NULL UNIQUE,        -- 例：'mycrm'
  name          TEXT NOT NULL,
  secret_hash   TEXT NOT NULL,               -- SHA-256(secret)
  redirect_uris TEXT NOT NULL,               -- JSON array，白名單（必填）
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    INTEGER NOT NULL
);

CREATE TABLE auth_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash  TEXT NOT NULL UNIQUE,           -- SHA-256(code)
  user_id    INTEGER NOT NULL REFERENCES users(id),
  app_id     TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,               -- 60 秒
  consumed_at INTEGER
);
```

### 3.2 流程

```
① 其他 App 的「登入」按鈕 →
   https://app.atwho.org/?app=mycrm&redirect_uri=https://crm.example.com/auth/cb

② 使用者在 AtWhoMail 登入（既有流程 ✅：信箱登入／管理員登入／註冊）

③ 導回：https://crm.example.com/auth/cb?code=<一次性 code>（60 秒、只能用一次 ✅）

④ CRM 後端：
   POST https://atwhomail-api.ulhome.workers.dev/api/auth/exchange
   { "app_id": "mycrm", "app_secret": "…", "code": "…", "redirect_uri": "…" }
   → 200 { "token": "<JWT>", "user": { id, username, display_name, role } }

⑤ CRM 用 token 呼叫 /api/auth/me 取得最新資料（或自行驗 JWT）
```

**Token 設計**：`{ scope:'app', aud:'mycrm', sub:userId, username, role, iat, exp }`
- ✅ 其他 App **只驗不簽**（用 `/api/auth/jwks` 的公鑰，或走 `exchange` 後自行保存 session）
- ✅ 每個 App 有獨立 `app_secret`（可撤銷 ✅、可輪替 ✅）
- ✅ `redirect_uri` **白名單**（防開放轉址 ✅）
- ✅ code 60 秒過期 ＋ 一次性 ✅

### 3.3 統一帳號管理

| 功能 | 在哪裡 |
|---|---|
| 修改密碼／顯示名稱 | ✅ **只在 AtWhoMail**（`https://app.atwho.org` → 帳號設定）|
| 註冊 | ✅ 只在 AtWhoMail（D21／D22 ✅）|
| 停權／刪除 | ✅ 只在 AtWhoMail（owner ✅）|
| 其他 App 讀取資料 | ✅ `GET /api/auth/me`（帶 token ✅）|
| 其他 App 的額外資料 | ✅ 存在**各 App 自己的表**（用 `user_id` 當外鍵），**不要**改 `users` 結構 ✅ |

> 🔑 **單一來源原則**：`users` 表是唯一權威 ✅；其他 App **永不存密碼** ✅、**永不建帳號表** ✅

## 4. 其他 App 需要做的事（每支約 1–2 小時）

```ts
// 1. 登入按鈕
location.href = "https://app.atwho.org/?app=mycrm&redirect_uri=" + encodeURIComponent(cbUrl);

// 2. 回呼：用 code 換 token（後端）
const r = await fetch("https://atwhomail-api.ulhome.workers.dev/api/auth/exchange", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ app_id: "mycrm", app_secret: SECRET, code, redirect_uri })
});
const { token, user } = await r.json();
// 3. 存進自己的 session（或驗 JWT 後發自己的 cookie）
```

## 5. 工作量

| 項目 | 估時 |
|---|---|
| AtWhoMail：migration 0011 ＋ `/api/auth/app-login`（redirect ＋ 發 code）＋ `/api/auth/exchange` ＋ `/api/auth/me` ＋ `app_clients` 管理（owner 產生 app_id／secret）| ~6h |
| AtWhoMail：帳號設定頁（改密碼／顯示名稱，若尚未有 ✅）| ~4h |
| 每個其他 App 接入 | ~1–2h |
| 測試 T119–T126（code 過期／重複使用／redirect 白名單／錯誤 secret／token aud）| ~3h |
| **合計（不含各 App）** | **~13h（2 天）** |

## 6. 風險與配套

| 風險 | 配套 |
|---|---|
| `redirect_uri` 被改成釣魚站 | ✅ 白名單比對（完全相符 ✅）|
| code 被攔截 | ✅ 60 秒 ＋ 一次性 ＋ 只走 HTTPS ✅ |
| `app_secret` 洩漏 | ✅ 每 App 獨立、可撤銷、可輪替；`secret_hash` 儲存 ✅ |
| 使用者停權後其他 App 仍有效 | ⚠️ token 短效（15 分）＋ 各 App 每次可呼叫 `/api/auth/me` 驗 status ✅ |
| 其他 App 濫發通知信 | ✅ 若要用寄信 → 另發「寄信專用 API key」，計入配額 ✅ |

## 7. 建議

1. ✅ **現在做方案 B**（~13h）→ 其他 App 立刻能共用登入／註冊／帳號
2. 🟡 未來若有第三方或手機 App 要接 → 再包 **OIDC**（方案 C，加殼不重寫 ✅）
3. ❌ **不要**共用 `JWT_SECRET`（偽造風險 ✅）

## 8. 待 owner 決定

| # | 問題 | 建議 |
|---|---|---|
| 1 | 其他 App 的網域是否都在 `*.atwho.org`？ | 若是 → 可加「共用 cookie（SSO 免轉址）」，更順 ✅ |
| 2 | 其他 App 需要「寄通知信」嗎？ | ✅ 需要 → 另建寄信 API key（計入 `alerts@` 配額）|
| 3 | 是否要讓其他 App 看到 `role`（owner／visitor）？ | ✅ 建議提供（讓 App 自行決定權限）|

---

## 9. OAuth 登入（owner 2026-11-04 決策）

### 9.1 採用組合：**B ＋ B+ Lite ＋ OAuth ＋ 忘記密碼**

| 元件 | 決策 |
|---|---|
| 對外網址 | ✅ **`https://auth.atwho.org`**（薄代理 → mail API，共用同一 D1）|
| 登入方式 | ✅ **本機帳密**（`itag` 或 `itag@gmail.com` ＋ 密碼）＋ ✅ **Google OAuth** 並存 |
| OAuth 是否需驗證碼 | ❌ **不需要**（Google 已驗證 `email_verified=true`）|
| 帳號建立 | ✅ OAuth 首次登入**自動建立 visitor 帳號**（無密碼）|
| contact_email | ✅ 每次 OAuth 登入**自動更新**（不同就更新＋稽核）|
| 忘記密碼 | ✅ 寄重設連結（30 分鐘、一次性）→ 點連結設定新密碼 |

### 9.2 密碼規則

| 情境 | 行為 |
|---|---|
| 純 OAuth 帳號用「信箱登入」| `400 NO_PASSWORD_SET` → 提示「請用 Google 登入或使用忘記密碼」|
| 忘記密碼 | 一律回 200（不洩漏帳號存在 ✅）→ 有帳號才寄信 |
| 重設成功 | ✅ 更新 `password_hash` ＋ **更新 `pca`（撤銷所有舊 JWT）** ＋ 寄「密碼已變更」通知 |

### 9.3 ID 分配規則（owner 2026-11-04 決策）

| 步驟 | 規則 |
|---|---|
| 1 | 取 OAuth email 的 local part（`luke@gmail.com` → `luke`）|
| 2 | 只保留英文字母（數字／符號／點全部移除；全空或 <3 → 用 `user`）|
| 3 | 截斷至 **12 字元** |
| 4 | **檢查二級網域**（D20）：`<id>.<tld>` 任一存在 → **不可用** ⚠️ |
| 5 | 撞網域／已被使用 → **比照別名命名原則**：`<id>` ＋ **3 位流水號**（`hp` → `hp001`；再撞 → `hp002`）|
| 6 | 仍衝突（極少）→ 繼續遞增；上限 999 次 |
| 7 | 保留字（`admin`／`postmaster`／…）→ 同樣走流水號（`admin001`）hmm — ⚠️ 改為：**保留字一律拒絕並改配 `user` 系列** ✅ |

> ⚠️ 這使 **D20（ID 撞二級網域偵測）成為前置需求** —— 先做 D20，再做 OAuth。

### 9.4 權限分級（owner 決策：OAuth 也要有信箱地址）

| 身分 | 信箱地址 | 收信 | 寄信配額 | 別名 |
|---|---|---|---|---|
| owner | ✅ | ✅ | 20／日 | ✅ |
| visitor（Email 驗證碼註冊）| ✅ | ✅ | 50／日（暖機 20／24h，可調）| ✅ |
| **visitor（OAuth）** | ✅ **自動配發** | ✅ | **50／日**（D33 與其他訪客一致）| ✅ |

### 9.5 實作順序（建議）

| 順序 | 項目 | 估時 |
|---|---|---|
| 1 | **D20**：ID 撞二級網域偵測（fail-open ＋ 25 個 TLD ＋ 不快取既有地址）| ~6h |
| 2 | **D26**：`auth.atwho.org` 薄代理 ＋ `/api/auth/exchange`（code 交換）| ~6h |
| 3 | **D27**：Google OAuth ＋ contact_email ＋ `user-login` ＋ 忘記密碼／重設 | ~15h |
| 4 | 測試 T119–T138 | 含在內 |
| **合計** | | **~27h（3.5 天）** |
