# 16. 管理權限強化 ＋ 管理主控台（實作規格）

> 目的：讓「管理權限」的保護**名實相符** —— 管理者的鑰匙只在 `mail.atwho.org`（Cloudflare Access 之後）拿得到，
> 並且讓 owner 能在網頁上管理邀請碼與訪客（目前只能打 API ⚠️）。
>
> 建立：2026-10-14　｜　對象：實作 agent（Claude Code）＋ owner（Cloudflare 設定）
> 前置閱讀：`docs/13` §6.4／§6.5、`docs/14` 附錄 B、`docs/15`（API 認證速查表）

---

## 0. 背景（實測證據）

| 事實 | 證據 |
|---|---|
| 管理權限的門在 **公開端點** | `POST /api/auth/login` 無需認證即可呼叫（`curl` 直打可行 ✅） |
| owner 憑證**只有一個發放點** | `signOwnerToken()` 全後端只被呼叫一次：`packages/api/src/index.ts:294`（即 `/api/auth/login`）|
| 另一個 owner 等效來源 | rescue 路徑：`auth.ts:208`（`x-admin-token`，靜態密鑰，owner 保管）|
| 權限判定**與網址無關** | 後端 `requireOwner`：`scope.kind !== "owner"` → 403；前端 0 處依 hostname 分支 |
| 前端已有角色開關雛型 | `LoginPage({ showRegister = true })`；`FolderSidebar.tsx:96` 以 `session.kind === "owner"` 顯示管理功能 |
| 現有防護 | Argon2id；`auth_attempts` 連續 5 次失敗鎖 15 分鐘（帳號層＋IP 層）；稽核 `login_failed` |

**問題**：`mail.atwho.org` 的 Cloudflare Access 只保護**頁面**；管理**權限**的門在公開的 API 登入端點上 →
只要知道帳密，任何人都能（在任何網址、甚至不用網頁）取得 owner 憑證 ⚠️

---

## 1. 設計原則（不可違背）

1. **保護「發放憑證的路徑」**，而不是保護頁面 ✅
2. **權限一律由後端角色判定**（禁止以 hostname 判定權限 ⚠️ 前端可偽造）
3. **訪客路徑必須維持公開**（訪客沒有 Cloudflare Access 身分；且免費版使用者數上限 50 ⚠️）
4. **不破壞既有緊急救援**（`x-admin-token` 語意不變 ✅）

### ❌ 已評估並排除的做法

| 做法 | 為何不做 |
|---|---|
| 在 **API hostname** 掛 Access 應用（即使只鎖 `/api/auth/login`） | 實測可行，但 App 內登入是 XHR → 會拿到 302（無 CORS 標頭）→ **登入直接壞掉** ⚠️；且與 L3 重複 |
| 把整個 API 放上 Access | 訪客沒有 Access 身分 → 全數被擋 ❌ |
| 以 hostname 判定權限 | 前端可偽造；且兩個網域共用同一份建置 ❌ |
| 只隱藏前端分頁（L1）就當作安全 | 攔不住 `curl` 直打 API ⚠️（L1 只是外觀收斂） |

---

## 2. 交付物

| # | 交付物 | 檔案 | 型態 |
|---|---|---|---|
| **D1** | 前端角色分頁（`mail.` 只顯示管理員登入；`app.` 隱藏管理員登入） | `web/src/components/LoginPage.tsx`、`web/src/App.tsx` | 修改 |
| **D2** | 後端強制：`/api/auth/login` 必須帶有效 **Cloudflare Access JWT**（`aud` = mail 應用） | `packages/api/src/auth.ts`、`packages/api/src/index.ts` | 修改 |
| **D3** | `mail.atwho.org` 的 **Pages Function 同源 `/api/*` 代理**（轉發 `Cf-Access-Jwt-Assertion`） | `web/functions/api/[[path]].ts`（新增） | 新檔 |
| **D4** | 邀請碼管理頁（僅 `mail.` 可見） | `web/src/components/InviteManager.tsx`（新增）等 | 新檔／修改 |
| **D5** | 訪客清單／停權頁（僅 `mail.`）＋ owner 專用端點（含停用訪客地址） | `packages/api/src/index.ts`、`web/src/components/VisitorManager.tsx` | 修改／新檔 |
| **D6**（選配，建議） | owner 登入 TOTP 第二因素 | `packages/api/src/totp.ts`（新增）＋相關 | 新檔 |
| **D7** | **owner 於網頁自行變更自己的密碼**（帳號設定頁；僅 `mail.` 顯示） | `packages/api/src/index.ts`、`web/src/components/AccountSettings.tsx` | 修改／新檔 |

---

## 3. 詳細規格

### D1 — 前端角色分頁

- 依 `window.location.hostname` 決定模式（**僅影響顯示，不影響權限判定** ✅）：
  | hostname | 顯示分頁 | 預設分頁 |
  |---|---|---|
  | `mail.atwho.org` | **只有「管理員登入」** | 管理員登入 |
  | `app.atwho.org` | 「信箱登入」＋「註冊」 | 信箱登入 |
  | 其他（`localhost`、`*.pages.dev`） | 全部三分頁（開發方便）| 信箱登入 |
- `showRegister` 既有 prop 保留；新增 `mode: "admin" | "public" | "all"`（或等價設計，實作自由）
- 標題文案：`mail.` 顯示「管理員入口」

### D2 — 後端強制 Access JWT（核心）

- 於 `/api/auth/login` **最前面**檢查 `Cf-Access-Jwt-Assertion` 標頭：
  1. 標頭不存在 → `403` `{ error: { code: "ADMIN_LOGIN_REQUIRES_ACCESS" } }`
  2. 標頭存在 → 以 Cloudflare Access 團隊公鑰驗簽（`https://steep-queen-06be.cloudflareaccess.com/cdn-cgi/access/certs`，快取公鑰 ✅）
  3. 驗簽失敗／過期 → `403` 同上
  4. `aud` 不等於 **mail 應用** 的 Audience（`b17726b0-7463-4484-911c-5ac9e6c24db2` 對應的 AUD，實作時請以 Cloudflare API `GET /accounts/{acc}/access/apps/{id}` 取得並放入 **Worker 環境變數/secret**，勿硬編碼在程式內 ⚠️）→ `403`
  5. 全部通過 → 才進入既有帳密驗證流程
- ✅ **訪客完全不受影響**：`/api/auth/mailbox-login`、`/api/auth/register`、`/api/me`、`/api/mail/*` 之行為不變
- ✅ 環境變數新增：`ACCESS_TEAM_DOMAIN=steep-queen-06be.cloudflareaccess.com`、`ACCESS_MAIL_AUD=<mail 應用 AUD>`
  （**不可**放進 `wrangler.jsonc` 明文以外的地方；AUD 非機密，可放 `vars` ✅）
- 錯誤訊息（給使用者）：`管理員登入僅能從 mail.atwho.org 進行`

### D3 — Pages Function 同源代理（讓 `mail.` 的請求「經過 Access」）

- 新增 `web/functions/api/[[path]].ts`：把 `https://mail.atwho.org/api/**` 代理到 `https://atwhomail-api.ulhome.workers.dev/api/**`，並**轉發** `Cf-Access-Jwt-Assertion`、`Authorization`、`Content-Type`
- `mail.atwho.org` 改指同一 Pages 專案（owner 於 Dashboard 設定 ✅ 見 §5）
- 前端：`mail.` 模式下 `VITE_API_BASE` 留空（同源 ✅）→ 若同一建置需服務兩網域，改用執行期判斷：
  `const API_BASE = location.hostname === "mail.atwho.org" ? "" : "https://atwhomail-api.ulhome.workers.dev"`
- ⚠️ `app.atwho.org` 保持一致（直連 API ＋ CORS ✅，訪客路徑不受 Access 影響 ✅）

### D4 — 邀請碼管理頁（僅 `mail.`）

- 使用既有 API：`POST /api/invites`、`GET /api/invites`、`DELETE /api/invites/:id`（皆 `requireOwner` ✅）
- UI：列表（備註／已用次數／到期／狀態）、**建立**（次數、時數、備註）、**撤銷**、複製邀請碼
- ⚠️ 注意：`GET /api/invites` 目前**遮罩邀請碼**；若要在 UI 直接複製，需 owner 端點回傳完整碼（**新增 flag**：`GET /api/invites?reveal=1`，僅 owner 可用 ✅），並在稽核留痕 ✅

### D5 — 訪客清單／停權頁（僅 `mail.`）＋ 缺口修補

- 新增 owner 端點：
  - `GET /api/users?role=visitor` → 列訪客（username、address、狀態、`sent_today`、配額、建立時間）
  - `PATCH /api/users/:id/status`（既有 ✅）→ 停權／復權
  - **`PATCH /api/email-addresses/:id/status`（新；owner 專用）** ← 解掉「owner 無法停用訪客地址」的 404 缺口（`docs/14` 附錄 B.5 待辦 1）
- UI：訪客表格 ＋ 一鍵停權／復權 ＋（選）「寄信安全閥 `can_send=0`」開關

**D5 補充規格（2026-10-14 增補）**

| 端點 | 內容 |
|---|---|
| `GET /api/users?role=visitor`（新） | 回傳每位訪客：`id`、`username`、`status`、`created_at`、地址（`id`／`email`／`status`／`can_send`／`daily_send_quota`／`sent_today`）、**信件數量**、**最近活動時間** |
| `PATCH /api/users/:id/status`（既有） | 停權／復權（`active`／`suspended`／`disabled`）|
| `PATCH /api/email-addresses/:id/status`（新，owner 專用） | 停用／啟用**訪客**地址（解 404 缺口）|
| `PATCH /api/users/:id/quota`（新） | 調整 `daily_send_quota`（值域 1–200，超出 → 422）＋ `can_send` 安全閥；寫稽核 `quota_changed` |
| `PATCH /api/users/:id/warmup`（新，可選） | 設定 `warmup_exempt`（跳過註冊後 24 小時的 5 封暖機上限）；需 migration `0007` 新增欄位 `email_addresses.warmup_exempt INTEGER NOT NULL DEFAULT 0` |

**UI（僅 `mail.`／localhost 顯示）**：訪客表格（帳號／地址／狀態／配額／今日已寄／信件數／最近活動）＋ 一鍵**停權／復權**＋**地址停用／啟用**＋**配額調整**＋（可選）**暖機豁免**勾選（附警示文字）

**⚠️ N9（權限邊界，必須遵守）**：owner **不得**讀取訪客的信件內容（`/api/mail/*` 一律依 session 的 `address_id` / `owner_user_id` 授權）。
訪客管理頁只能顯示**數量與時間**（信件數、最近活動），**不得**顯示主旨／寄件者／內文。

**⚠️ 現有 UI 文案修正**：側欄「全部信箱」語意為「**你名下**全部地址」（`owner_user_id`），不是全站所有使用者 → 文案改為「我的全部信箱」或加註說明，避免誤解 ✅

### D6 —（選配，建議）owner 登入 TOTP

- `ALTER TABLE users ADD COLUMN totp_secret TEXT`（migration `0007`）
- `POST /api/auth/totp/setup`（回 otpauth URI ＋ 二維碼字串）、`POST /api/auth/totp/enable`、`POST /api/auth/totp/disable`
- `/api/auth/login` 流程：若 owner 已啟用 TOTP → 需 `totp_code`；缺少回 `401 TOTP_REQUIRED`；錯誤回 `401 TOTP_INVALID`
- 依賴：需新增 TOTP 函式庫（Workers 相容；⚠️ 不可用 `hash-wasm`，本專案先例為 `@noble/hashes` ✅）

---

### D7 — owner 於網頁自行變更密碼（帳號設定）

**現況問題**：`POST /api/auth/owner-password` 只接受 **rescue token**（`scope.via !== "rescue"` → 401），
一般 owner 登入的 JWT 無法使用 → 網頁上**沒有**任何「改自己密碼」的入口（前端 `Header` 的「修改密碼」其實是
跳到地址管理，改的是**地址**密碼）⚠️

- 新增端點：`PATCH /api/auth/owner-password/self`（`requireSession`，且 `scope.kind === "owner"`）
  - 請求：`{ "old_password": string, "new_password": string }`
  - 驗舊密碼失敗 → `401` `INVALID_OLD_PASSWORD`
  - 政策不符 → `422` `WEAK_PASSWORD`
  - 成功 → 寫入新雜湊並更新 `password_changed_at`（＝既有 JWT 立即失效 ✅，屬預期安全行為）
  - 稽核：`owner_password_changed`
  - 沿用既有鎖定機制（`auth_attempts`，連續失敗 5 次鎖 15 分鐘）
- 前端：`mail.` 模式的管理主控台新增「帳號設定」頁（舊密碼／新密碼／確認新密碼；成功後提示需重新登入）
- ⚠️ 不可改動 rescue 路徑（`POST /api/auth/owner-password` 行為不變，N5）
- ⚠️ 不改用 Cookie → 維持 Bearer，故無 CSRF 風險 ✅

---

## 4. 不可做（N 系列）

| # | 禁止 |
|---|---|
| N1 | 不可把 Cloudflare Access 應用掛在 API hostname（會弄壞 App 內登入 ⚠️） |
| N2 | 不可改動訪客公開路徑（`register`／`mailbox-login`／`me`／`mail/*`）的認證要求 |
| N3 | 不可以 hostname 判定**權限**（只能影響 UI 顯示） |
| N4 | 不可改 `ALLOWED_ORIGINS` 的既有四項（若 D3 之後需要調整，先回報） |
| N5 | 不可修改 rescue（`x-admin-token`）語意與 `/api/backup/*` 行為 |
| N6 | 不可部署、不可執行遠端 migration |
| N7 | 不可把任何 secret 寫入 repo（JWT_SECRET／ADMIN_TOKEN／AUD 以外的機密） |
| N8 | 不可動 `docs/13`、`docs/14`、`docs/15`、`scripts/`（屬 owner／助手檔案） |
| N9 | **owner 不得讀取訪客信件內容**（只能看數量／時間）；不得為了管理方便而放寬 `/api/mail/*` 的授權 |
| N10 | 不可對 production D1 執行任何寫入（含 UPDATE／DELETE／INSERT）；migration 只**新增檔案**，由 owner／助手套用 |

---

## 5. 上線順序與驗收（分階段，每階段獨立可回退 ✅）

| 階段 | 內容 | 驗收 |
|---|---|---|
| **1** | D1（前端角色分頁）＋ `mail.` 改指 Pages ＋ D3（同源代理，先不驗 JWT） | `mail.` 只看得到管理員登入；`app.` 看不到管理員登入；兩邊登入皆正常 ✅ |
| **2** | D2（後端驗 Access JWT）＋ 設 `ACCESS_TEAM_DOMAIN`／`ACCESS_MAIL_AUD` | ① 從 `mail.`（通過 Access）可登入 ✅<br>② `curl` 直接打 `/api/auth/login` → **403** ✅<br>③ 從 `app.atwho.org` 用 `itag` → **403** ✅<br>④ 訪客 `register`／`mailbox-login` 不受影響 ✅ |
| **3** | D5（訪客清單／停權 ＋ owner 地址停用端點） | owner 可停用訪客地址（不再 404）✅；被停用者立即無法登入 ✅ |
| **4** | D4（邀請碼管理頁）＋ **D7（帳號設定／自行改密碼）** | owner 可在網頁建立／撤銷／複製邀請碼 ✅；可在網頁改自己的密碼（舊密碼錯誤 → 401、成功後其他 session 失效）✅ |
| **5** | D6（TOTP，選配） | 啟用後登入需動態碼；錯誤碼正確 ✅ |

**回退**：階段 2 若出問題 → 移除 `ACCESS_MAIL_AUD` 環境變數即恢復（程式需設計成「未設定時僅警告並放行」，**僅在過渡期** ✅）

---

## 6. 測試（T 系列）

| # | 測試 |
|---|---|
| T1 | 無 Access JWT 標頭 → `/api/auth/login` 回 403 `ADMIN_LOGIN_REQUIRES_ACCESS` |
| T2 | 有效 JWT 但 `aud` 不符 → 403 |
| T3 | 有效 JWT 且 `aud` 相符 → 進入帳密驗證（正確帳密 → 200；錯誤帳密 → 401）|
| T4 | 訪客流程迴歸：`register` / `mailbox-login` / `/api/me` / `/api/mail/*` 全部不受影響 |
| T5 | rescue（`x-admin-token`）仍可呼叫 `/api/backup/*` 與 `/api/auth/owner-password` |
| T6 | `PATCH /api/email-addresses/:id/status`（owner）可停用訪客地址；訪客端點（mailbox session）呼叫 → 403 |
| T7 | 前端 `mail.` 模式只渲染管理員分頁；`app.` 模式不渲染管理員分頁 |
| T8 | 邀請碼 `reveal=1` 僅 owner 可用；非 owner → 403；且寫入稽核 |
| T9 | `PATCH /api/auth/owner-password/self` 舊密碼錯誤 → 401 `INVALID_OLD_PASSWORD` |
| T10 | 新密碼不符政策 → 422 `WEAK_PASSWORD`；成功 → 200 且寫入稽核 `owner_password_changed` |
| T11 | 成功改密碼後，**舊的 owner JWT 立即失效**（`password_changed_at` 檢查）→ 401 `TOKEN_STALE` |
| T12 | `GET /api/users?role=visitor` 僅 owner 可用（訪客 JWT → 403）；回傳含信件數與最近活動時間 |
| T13 | owner 以訪客的地址 id 呼叫 `/api/mail/*` → **403／404**（不得讀取訪客信件內容，N9）|
| T14 | `PATCH /api/users/:id/quota` 值域 1–200；超出 → 422；成功 → 稽核 `quota_changed` |
| T15 | `warmup_exempt=1` 的地址不受註冊後 24 小時 5 封上限限制（仍受 `daily_send_quota` 限制）|
| T16 | `GET /api/invites?reveal=1` 僅 owner 可用；使用時寫入稽核（記錄 owner id 與時間）|

---

## 7. 回報格式（交回給 owner／助手）

1. 改了哪些檔（清單）
2. canonical 三指令輸出（`pnpm test`／`pnpm lint`／`pnpm build`）
3. 測試案例數與結果
4. 新增的環境變數名稱（**不要**貼值）
5. 明確宣告：未部署、未跑遠端 migration
6. 未完成項與原因

## 8. Definition of Done

- [ ] D1–D5 與 **D7** 全部交付（D6 為選配）
- [ ] canonical 三指令全綠；T1–T11 通過
- [ ] `docs/05`（API 規格）與 `docs/11`（上線檢查清單）同步更新
- [ ] 若新增 migration（`0007`）：只新增檔案，**不套用** ✅
- [ ] 未部署、未跑遠端 migration、未動 N6–N8 列出的檔案
- [ ] 依 §7 回報

---

## 9. 實作進度紀錄

### 階段 1 — ✅ 完成並上線（2026-10-14）

| 項目 | 結果 |
|---|---|
| 實作 | commit `695ff37`（D1：`web/src/lib/hostMode.ts`＋`LoginPage` mode ＋ `App.tsx`；D3：`web/functions/api/[[path]].ts`；測試 `web/test/hostMode.spec.ts`）|
| canonical 三指令 | ✅ `lint` 0／`build` 0／`test` **10 files / 135 tests** 全綠 |
| N1–N8 合規 | ✅ 後端未加入 Access JWT 驗證（N1）、`ALLOWED_ORIGINS` 未變（N4）、docs 未動（N8）|
| Pages 部署 | ✅ `atwhomail-web`（**含 Functions bundle**）；新版 JS `index-DS0eyND7.js` 已上線 |
| 自訂網域 | ✅ `mail.atwho.org`、`app.atwho.org` 皆 → `atwhomail-web.pages.dev` |
| `mail.atwho.org` Access | ✅ 仍 302 至 Cloudflare Access（僅 owner 可通過）|
| D3 代理實測 | ✅ `/api/health` → 200（真實 API 回應）；`/api/backup/changes?limit=1` → 401 UNAUTHORIZED（證明路徑與 query 皆正確轉發）|
| D2（後端驗 JWT） | ⬜ 尚未實作（依規格留待階段 2 ✅）|

> 部署指令（**必須在 `web/` 目錄執行**，否則 Pages 不會打包 `functions/`）：
> ```bash
> cd web
> VITE_API_BASE=https://atwhomail-api.ulhome.workers.dev pnpm build
> pnpm exec wrangler pages deploy dist --project-name atwhomail-web --branch main
> ```

### 階段 3–4 — ✅ 程式完成（2026-10-14；**未部署、migration 0007 未套用**）

| 項目 | 結果 |
|---|---|
| 實作 | commit `9e37aec`（D4：`GET /api/invites?reveal=1`＋稽核 `invite_revealed`、`web/src/components/InviteManager.tsx`；D5：`GET /api/users?role=visitor`、`PATCH /api/users/:id/quota`、`PATCH /api/users/:id/warmup`、`PATCH /api/email-addresses/:id/status`、`web/src/components/VisitorManager.tsx`）|
| canonical 三指令 | ✅ `lint` 0／`build` 0／`test` **13 files / 171 tests** 全綠 |
| 測試（T12–T16） | ✅ `packages/api/test/admin-console.spec.ts`（18 案例：T12–T16 ＋ 值域／狀態／N9 邊界）、`web/test/adminConsole.spec.ts`（4 案例：顯示開關、邀請碼狀態推導）|
| N 系列合規 | ✅ 訪客公開路徑未變（N2）、未以 hostname 判定權限（N3）、`ALLOWED_ORIGINS` 未變（N4）、rescue 與 `/api/backup/*` 未變（N5）、未部署亦未跑遠端 migration（N6／N10）、未寫入任何 secret（N7）、docs/13–15 與 `scripts/` 未動（N8）|
| N9 權限邊界 | ✅ 訪客清單只回**數量與時間**（信件數／最近活動），不含主旨／寄件者／內文；`/api/mail/*` 授權未放寬，且 `?address_id=` 收緊為「僅限 owner 名下地址」（他人地址 → 404，不再回空清單）|
| migration | ⬜ `migrations/0007_warmup_exempt.sql`（`email_addresses.warmup_exempt INTEGER NOT NULL DEFAULT 0`）**只新增檔案、未套用到任何環境**；套用命令見 `docs/11` §2-10 |
| 部署 | ⬜ 未部署（前端新版需在 `web/` 目錄 build 後 deploy，指令見上方階段 1；後端部署前**先套用 migration 0007**）|
| 文件 | ✅ `docs/05` §2.9（端點／錯誤碼／稽核事件／N9 收緊）、`docs/11` §2-10（上線檢查）與 §3 端點矩陣 |

### 階段 2 需要的值（已查得）

| 名稱 | 值 | 用途 |
|---|---|---|
| `ACCESS_TEAM_DOMAIN` | `steep-queen-06be.cloudflareaccess.com` | 取 Access 公鑰驗簽 |
| `ACCESS_MAIL_AUD` | `48c19f72b4892912c5176b3f88ce1fdae27ff6461eb85ef52b928e688567d077` | 驗證 JWT 的 `aud` 必須等於 `mail.atwho.org` 應用 |

> 這兩個值建議設為 Worker 環境變數（`vars`；非機密 ✅），**不要硬編碼在程式內**。
