# 37 — D37：Mail 帳號中心與五系統入口（SSO）

> 建立：2026-11-10｜狀態：**Mail 入口／API／Pages 已上線（Pages `d59f2154`、API `2943668e`）；Chat `AllChat` `5c80f1a`、Form `94d802c`、Flow `a6e9684`、Now `6ccccda` 的 `feat/atwho-sso` 均已推 GitHub；四個遠端系統待部署驗收**
> Mail API 的 `POST /api/auth/app-login` 現在會把 `state` 原樣接到 callback；`POST /api/auth/exchange` 與 `GET /api/auth/me` 會回傳主要 `email`。
> 決策（owner 2026-11-10）：一次 Mail 登入 → 使用同一 ID 在 Mail／Form／Now／Chat／Flow 工作；
> 使用 **D26 一次性 code 交換**；登入後前往**上次使用的系統**（首次預設 Mail）；
> Form 既有本機帳號**全部改為 SSO**；五系統一起納入入口。

## 1. 系統清單

| 系統 | 網址 | app_id | callback（必須完全相符） |
|---|---|---|---|
| Mail | `https://app.atwho.org`（公開入口）<br>`https://mail.atwho.org`（owner 管理，Access） | —（IdP 本身） | — |
| Form | `https://form.atwho.org` | `form` | `https://form.atwho.org/api/auth/atwho/callback` |
| Now | `https://now.atwho.org` | `now` | `https://now.atwho.org/api/auth/atwho/callback` |
| Chat | `https://chat.atwho.org` | `chat` | `https://chat.atwho.org/api/auth/atwho/callback` |
| Flow | `https://flow.atwho.org` | `flow` | `https://flow.atwho.org/api/auth/atwho/callback` |

前端定義單一來源：`web/src/lib/systems.ts`。變更 callback 時，**同時**更新該檔與
`app_clients.redirect_uris`，否則 `app-login` 會拒絕。

## 2. 身分模型

- **Canonical ID**：Mail `users.id`。
- 對外身分：`username`（AtWho ID）、`display_name`、`role`（owner／visitor）。
- 各系統用自己的表保存 `mail_user_id`／`mail_username` 與該系統的角色；**不共用密碼**、**不共用 `JWT_SECRET`**。
- Mail 仍是唯一帳號來源：註冊、密碼、停權、刪除、個人設置都只在 Mail 進行。
- `POST /api/auth/exchange` 與 `GET /api/auth/me` 回傳 `email`（使用者的主要 active
  `email_addresses.email`；沒有 active 地址 → `null`），供各系統做既有帳號 email 綁定。
- `/api/auth/me` **不**回傳 `contact_email`（備用電子郵件）；那是 Mail 找回密碼專用。

## 3. 登入／切換流程

```text
① 使用者到 Mail（app.atwho.org）登入
② 登入成功後：
   - 若 localStorage 的「上次系統」是 form/now/chat/flow → 自動 app-login 並導轉
   - 否則留在 Mail
③ 使用者從頭像選單「切換系統」選 Form：
   - 記住 lastSystem=form
   - POST /api/auth/app-login { app:'form', redirect_uri }
   - location.assign(後端回傳的 redirect)
④ Form 後端 callback（帶 code）：
   - 驗 state
   - POST https://auth.atwho.org/api/auth/exchange
     { app_id:'form', app_secret, code, redirect_uri }
   - 取得 Mail 使用者 { id, username, display_name, role }
   - 建立／綁定 Form 使用者（mail_user_id）
   - 建立 Form 自己的 session
   - 導回原本的 deep link
⑤ 之後在 Form 內工作；要換系統時回到 Mail 入口或使用各系統的「切換系統」連結
```

### 「上次系統」規則

- 儲存：`localStorage["atwho.lastSystem"]`（每裝置；首次沒有 → Mail）。
- 更新時機：
  - 使用者從頭像選單切換系統。
  - 從 `?app=form` 等外部／其他系統登入完成時。
- 自動導轉只在 **`app.atwho.org`（公開入口）** 發生；`mail.atwho.org` 是管理入口，不會自動離開。
- 重新整理還原既有 session **不會**自動導轉（只有「這次真的登入」才觸發）。
- 自動導轉失敗 → 清除為 Mail 並顯示 toast，避免每次登入都被壞掉的系統卡住。

## 4. Mail 端實作

| 項目 | 檔案 |
|---|---|
| 系統清單／lastSystem／自動導轉判斷 | `web/src/lib/systems.ts` |
| 登入後自動導轉、切換系統、app handoff 記錄 lastSystem | `web/src/App.tsx` |
| 頭像選單「切換系統」 | `web/src/components/Header.tsx` |
| AppShell 一次性錯誤 toast | `web/src/components/AppShell.tsx` |
| 翻譯 key「切換系統」 | `web/src/i18n/*.ts` |

- Mail 本身不建立 app client；Form／Now／Chat／Flow 才需要。
- 遠端尚未接入時，切換到該系統會出現 `app-login` 錯誤（例如 app client 不存在或 callback 無法連線）；
  系統會留在 Mail 並顯示 toast。

## 5. App Client 建立（owner）

在 `mail.atwho.org` → 應用程式（App Clients）→ 新增 App，建立四個 client：

| App ID | 名稱 | Redirect URI |
|---|---|---|
| `form` | Form | `https://form.atwho.org/api/auth/atwho/callback` |
| `now` | Now | `https://now.atwho.org/api/auth/atwho/callback` |
| `chat` | Chat | `https://chat.atwho.org/api/auth/atwho/callback` |
| `flow` | Flow | `https://flow.atwho.org/api/auth/atwho/callback` |

- `app_secret` **只顯示一次**；分別存到四台遠端設備的後端環境變數，**不可放前端**。
- 每個系統使用獨立 secret；外洩時只停用該 client。
- 若之後改 callback，先用 PATCH 更新 `redirect_uris`，再部署遠端。

## 6. 遠端系統接入契約

### 環境變數（後端）

```env
ATWHO_APP_ID=form                 # now / chat
ATWHO_APP_SECRET=...              # 該系統專屬
ATWHO_API_BASE=https://auth.atwho.org
ATWHO_REDIRECT_URI=https://form.atwho.org/api/auth/atwho/callback
```

### 登入按鈕（前端）

```text
https://app.atwho.org/?app=form
  &redirect_uri=https%3A%2F%2Fform.atwho.org%2Fapi%2Fauth%2Fatwho%2Fcallback
  &state=<隨機、存在系統 session>
```

### Callback（後端）

```text
GET /api/auth/atwho/callback?code=...&state=...
0. Mail 會把 App 傳入的 state 原樣接在 redirect（code 之後）；App 必須自行產生並保存 state
1. 驗證 state（比對自己 session 內的值，一次性）
2. POST {ATWHO_API_BASE}/api/auth/exchange
   { app_id, app_secret, code, redirect_uri }
3. 回應：{ token, user: { id, username, display_name, role, email } }
4. 以 user.id 建立／綁定本地使用者（mail_user_id UNIQUE）
5. 建立本地 session（建議 HttpOnly Cookie；或既有 token 機制）
6. 導回 deep link（不要在 URL 放 app_secret）
```

### 既有帳號（Form）

- 新增 `mail_user_id`（UNIQUE）、`mail_username`。
- 既有 Form 使用者以 email 對應 Mail 使用者；對不到的使用者需人工對應或一次性認領。
- 停用 Form 本機註冊／密碼登入；密碼欄位保留但不再使用（或改 nullable）。
- 既有 session 可保留至到期；新登入一律走 SSO。

## 7. 安全要求

- `redirect_uri` 必須與 `app_clients.redirect_uris` **完全相符**。
- code：60 秒、一次性、只走 HTTPS；`state` 防 CSRF。
- `app_secret` 只存遠端後端；DB 只存雜湊。
- app token 有 `aud=<app_id>`，不可呼叫 `/api/mail/*`（`SCOPE_NOT_ALLOWED`）。
- 停權／刪除：Mail `users.status` 是權威；遠端可用 `/api/auth/me` 定期檢查，或縮短 session TTL。
- 登出：目前各系統各自登出；「登出所有系統」列為後續。

## 8. 驗收清單

- [ ] Mail 登入後，第一次預設留在 Mail。
- [ ] 切換到 Form／Now／Chat／Flow 後，`localStorage.atwho.lastSystem` 正確更新。
- [ ] 登出再登入（公開入口）→ 自動回到上次系統。
- [ ] `mail.atwho.org` 登入不會自動離開管理入口。
- [ ] 重新整理不會被自動導轉。
- [ ] 遠端 callback 的交換、state、redirect 白名單、code 重複使用測試。
- [ ] 停權使用者在各系統的下一次請求被擋。

自動測試：web DOM 131、workerd 472（全站 603）；`pnpm lint`／`pnpm build` 皆通過。

## 9. 尚未完成

- ~~**Mail API 部署**~~ ✅ 2026-11-10 完成（version `2943668e`；state passthrough＋exchange/me email）。
- ~~**Mail Web Pages 部署**~~ ✅ 2026-11-11 完成（Pages `d59f2154`；production bundle 已帶 state；Mail commit `dd2ed01`）。
- **Chat**：`AllChat` `feat/atwho-sso`（`5c80f1a`）已完成 gateway、SSO UI、本機登入停用與文件；待遠端 pull、設定 `ATWHO_APP_SECRET`、把 Tunnel ingress 改到 `:3000`、清除舊 `sessions` 後驗收。
- **Form**：`feat/atwho-sso`（`94d802c`）已推 GitHub；待遠端 pull、設定 `ATWHO_APP_SECRET` 並重啟後端，確認 `/api/auth/atwho/callback` 由 Express 處理。
- **Flow**：`trace-flow` `feat/atwho-sso`（`a6e9684`）已推 GitHub；使用既有 Vite→FastAPI proxy，不需 gateway。待遠端 `.env` 設 `ATWHO_APP_SECRET`、重啟後端（`init_db` 會自動補 users 欄位）。
- **Now**：`WenkeWu/Now` `feat/atwho-sso`（`6ccccda`）已推 GitHub；公開瀏覽免登入，刊登／詢價需 AtWho；待遠端 `.env` 設 `ATWHO_APP_SECRET`／`NOW_SESSION_SECRET` 並重啟。
- **遠端四系統部署與五系統端對端驗收**。
- 單一登出／全域撤銷。
