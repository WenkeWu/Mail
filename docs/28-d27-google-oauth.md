---
title: D27 實作規格：Google OAuth 登入 ＋ 忘記密碼
status: 現況
updated: 2026-11-08
read-when: 改 Google 登入／忘記密碼時（D27）
---

# 28 — D27 實作規格：Google OAuth 登入 ＋ 忘記密碼

> 建立：2026-11-05｜狀態：**待派工**
> 依據：`docs/26` §9（owner 決策）＋ §9.5 順序第 3 步

## 0. 已完成的前置（勿重做）

| 項目 | 狀態 |
|---|---|
| Google OAuth Client | ✅ 已建立並驗證（client_id／secret 皆實測通過）|
| Redirect URI | ✅ `https://auth.atwho.org/api/auth/oauth/google/callback` 已登記在 Google ✅ |
| Worker secret | ✅ `GOOGLE_CLIENT_SECRET` 已設定 |
| Worker vars | ✅ `GOOGLE_CLIENT_ID`、`OAUTH_REDIRECT_URI` 已在 `wrangler.jsonc` |
| `auth.atwho.org` 代理 | ✅ 上線（只轉 `/api/auth/*` ✅）|
| `assignAvailableLocalPart()` | ✅ 已由 D20 提供（撞網域自動加 3 碼流水號 ✅）|

## 1. Migration `0013_oauth_identity.sql`（只新增）

```sql
ALTER TABLE users ADD COLUMN provider       TEXT NOT NULL DEFAULT 'local';  -- local | google
ALTER TABLE users ADD COLUMN provider_sub   TEXT;
ALTER TABLE users ADD COLUMN contact_email  TEXT;
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_provider ON users(provider, provider_sub);
CREATE INDEX IF NOT EXISTS idx_users_contact_email ON users(contact_email);

CREATE TABLE IF NOT EXISTS password_resets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT NOT NULL UNIQUE,          -- SHA-256(token + JWT_SECRET)
  user_id     INTEGER NOT NULL REFERENCES users(id),
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,              -- 30 分鐘
  consumed_at INTEGER,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS idx_password_resets_user ON password_resets(user_id);
```

## 2. Google OAuth

### 2.1 `GET /api/auth/oauth/google/start`
- query：`redirect_after`（可選；登入完成後要導回的站內路徑，預設 `/`）
- 產生 `state` = 32 bytes hex（**存 cookie** `awo_state`：HttpOnly、Secure、SameSite=Lax、Path=/、Max-Age=600）
- 302 到：
  `https://accounts.google.com/o/oauth2/v2/auth?client_id=<GOOGLE_CLIENT_ID>&redirect_uri=<OAUTH_REDIRECT_URI>&response_type=code&scope=openid%20email%20profile&state=<state>&prompt=select_account`
- ⚠️ 不得接受外部傳入的 `redirect_uri`（固定用 `OAUTH_REDIRECT_URI` ✅，防開放轉址）

### 2.2 `GET /api/auth/oauth/google/callback?code=&state=`
1. 驗 `state` 與 cookie 相符（不符 → 400 `INVALID_STATE`，並清 cookie）
2. `POST https://oauth2.googleapis.com/token`（`code`、`client_id`、`client_secret`、`redirect_uri`、`grant_type=authorization_code`）
3. `GET https://openidconnect.googleapis.com/v1/userinfo`（Bearer access_token）→ `{ sub, email, email_verified, name }`
4. ⚠️ **只接受 `email_verified === true`**（否則 403 `EMAIL_NOT_VERIFIED`）
5. 帳號比對（依序）：
   a. `users.provider='google' AND provider_sub=sub` → 登入
   b. `users.contact_email = email`（大小寫不敏感）→ **連結**（更新 provider／provider_sub ✅＋稽核 `oauth_linked`）
   c. 都沒有 → **自動建立帳號**（見 §3）
6. 每次登入都：`contact_email` 不同 → 更新 ✅、`email_verified=1` ✅、稽核 `oauth_login`（只記 sub 前 8 碼與 user id，不記 email 全文 ✅）
7. 簽 session JWT（`scope='owner'` if role=owner else `scope='mailbox'`？⚠️ 見 §4）→ 302 導回 `redirect_after`（只允許站內相對路徑 ✅，否則 `/`）

### 2.3 自動建立帳號（首登）
- `users`：`username` = 由 email local part 推導 ✅、`provider='google'`、`provider_sub=sub`、`contact_email=email`、`email_verified=1`、`role='visitor'`、`status='active'`、`password_hash=NULL` ✅
- `username` 推導：local part → 只保留英文字母（小寫）→ 截 12 字 → 空或 <3 → `user` → 再用 `assignAvailableLocalPart()`（D20 ✅ 撞二級網域 → `hp001` ✅）
- `email_addresses`：同一 `username` 建立 `<username>@atwho.org`，`daily_send_quota = 5` ✅（OAuth 使用者較嚴格）、`warmup_exempt=0` ✅
- 稽核：`oauth_registered`（username、provider、address ✅）

## 3. 登入（本機帳密）擴充：`POST /api/auth/user-login`

```jsonc
{ "identifier": "itag",  "password": "..." }   // identifier 可為 username 或 contact_email
```

- 查詢：`users.username = ?` **OR** `lower(users.contact_email) = lower(?)`（兩者都接受 ✅）
- 帳號 `status='suspended'` → 403 `ACCOUNT_SUSPENDED`
- `password_hash IS NULL` → 400 `NO_PASSWORD_SET`（訊息：「此帳號尚未設定密碼，請用 Google 登入，或使用『忘記密碼』設定」）
- 驗密碼（沿用既有 argon2id ✅）→ 簽 JWT（依 role 決定 scope ✅）
- 失敗計數沿用既有 `auth_attempts`（key = `login:<identifier>` ✅）

## 4. Session scope 決策（重要）

| role | 登入後 scope | 可用範圍 |
|---|---|---|
| `owner` | `owner` | 全部（管理＋信件）|
| `visitor` | `mailbox`（以其**第一個 active 地址**）| 自己的信箱／別名 ✅ |

> ⚠️ 若 visitor 沒有 active 地址（理論上不會 ✅，OAuth 首登已配發 ✅）→ 簽 `app`-like 的「user scope」並只允許 `/api/auth/me`（避免 500 ✅）

## 5. 忘記密碼 / 重設

### 5.1 `POST /api/auth/forgot-password`
```jsonc
{ "email": "itag@gmail.com" }
```
- **一律回 `200 {sent:true}`**（不洩漏帳號是否存在 ✅）
- 以 `contact_email` 或 `username` 找 user；找到才處理 ✅
- 限流：同 email 每小時 3 次、同 IP 每小時 10 次（`auth_attempts` ✅）
- 產生 `token`（32 bytes hex ✅）→ DB 存 `SHA-256(token + JWT_SECRET)` ✅、30 分鐘 ✅
- 寄信（`noreply@atwho.org` → 該 user 的 contact_email ✅）：
  - 主旨：`AtWhoMail 密碼重設`
  - 內容：`https://app.atwho.org/?reset=<token>` ＋ 30 分鐘有效說明 ＋ 「若非本人請忽略」
- 稽核：`password_reset_requested`（user id、ip；不記 token ✅）

### 5.2 `POST /api/auth/reset-password`
```jsonc
{ "token": "...", "new_password": "..." }
```
- 驗 token（未過期／未使用 ✅）→ 驗密碼政策（沿用 `validatePasswordPolicy` ✅）
- 更新 `users.password_hash` ✅ ＋ **更新 `pca`（撤銷所有舊 JWT ✅）** ＋ `provider` 保持不變 ✅
- 一次性消費（`UPDATE ... WHERE consumed_at IS NULL` ✅）
- 寄「密碼已變更」通知（若成功 ✅）
- 錯誤碼：`INVALID_TOKEN`(400)、`TOKEN_EXPIRED`(400)、`WEAK_PASSWORD`(422)
- 稽核：`password_reset_done`（user id ✅）

## 6. 前端

1. 登入頁加「**使用 Google 登入**」按鈕 → `location.href = "/api/auth/oauth/google/start?redirect_after=<目前路徑>"`（透過 `auth.atwho.org` ✅）
2. 登入頁加「**忘記密碼？**」→ 輸入 email → 呼叫 `forgot-password` → 顯示「若帳號存在，已寄出重設信」✅
3. `?reset=<token>` → 顯示「設定新密碼」表單 → 呼叫 `reset-password` → 成功後導回登入並提示 ✅
4. 顯示 `NO_PASSWORD_SET` 時，提供「用 Google 登入」與「忘記密碼」兩個引導 ✅

## 7. 測試 T161–T172

- T161 `start`：302 到 Google，含正確 client_id／redirect_uri／state（並設 cookie）
- T162 `callback` state 不符 → 400 `INVALID_STATE`
- T163 `callback` `email_verified=false` → 403 `EMAIL_NOT_VERIFIED`
- T164 `callback` 新使用者 → 建 user（visitor、無密碼）＋ 地址（配額 50；D33 統一）＋ 稽核
- T165 `callback` 既有 contact_email → 連結（不重複建）＋ `oauth_linked`
- T166 `callback` 第二次登入 → 同一 user；contact_email 變更時更新
- T167 `user-login` 以 username → 200；以 contact_email → 200
- T168 `user-login` 對無密碼帳號 → 400 `NO_PASSWORD_SET`
- T169 `forgot-password` 不存在的 email → **200**（不洩漏 ✅）
- T170 `reset-password` 正常 → 200；舊 JWT 失效（`pca` 變更 ✅）
- T171 `reset-password` 重複使用 token → 400 `INVALID_TOKEN`
- T172 既有 T1–T160 零回歸

## 8. 不做

- refresh token、多 provider（GitHub／Microsoft）、OAuth 撤銷清單、手機原生 SDK
