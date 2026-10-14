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

### D6 —（選配，建議）owner 登入 TOTP

- `ALTER TABLE users ADD COLUMN totp_secret TEXT`（migration `0007`）
- `POST /api/auth/totp/setup`（回 otpauth URI ＋ 二維碼字串）、`POST /api/auth/totp/enable`、`POST /api/auth/totp/disable`
- `/api/auth/login` 流程：若 owner 已啟用 TOTP → 需 `totp_code`；缺少回 `401 TOTP_REQUIRED`；錯誤回 `401 TOTP_INVALID`
- 依賴：需新增 TOTP 函式庫（Workers 相容；⚠️ 不可用 `hash-wasm`，本專案先例為 `@noble/hashes` ✅）

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

---

## 5. 上線順序與驗收（分階段，每階段獨立可回退 ✅）

| 階段 | 內容 | 驗收 |
|---|---|---|
| **1** | D1（前端角色分頁）＋ `mail.` 改指 Pages ＋ D3（同源代理，先不驗 JWT） | `mail.` 只看得到管理員登入；`app.` 看不到管理員登入；兩邊登入皆正常 ✅ |
| **2** | D2（後端驗 Access JWT）＋ 設 `ACCESS_TEAM_DOMAIN`／`ACCESS_MAIL_AUD` | ① 從 `mail.`（通過 Access）可登入 ✅<br>② `curl` 直接打 `/api/auth/login` → **403** ✅<br>③ 從 `app.atwho.org` 用 `itag` → **403** ✅<br>④ 訪客 `register`／`mailbox-login` 不受影響 ✅ |
| **3** | D5（訪客清單／停權 ＋ owner 地址停用端點） | owner 可停用訪客地址（不再 404）✅；被停用者立即無法登入 ✅ |
| **4** | D4（邀請碼管理頁） | owner 可在網頁建立／撤銷／複製邀請碼 ✅ |
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

---

## 7. 回報格式（交回給 owner／助手）

1. 改了哪些檔（清單）
2. canonical 三指令輸出（`pnpm test`／`pnpm lint`／`pnpm build`）
3. 測試案例數與結果
4. 新增的環境變數名稱（**不要**貼值）
5. 明確宣告：未部署、未跑遠端 migration
6. 未完成項與原因

## 8. Definition of Done

- [ ] D1–D5 全部交付（D6 為選配）
- [ ] canonical 三指令全綠；T1–T8 通過
- [ ] `docs/05`（API 規格）與 `docs/11`（上線檢查清單）同步更新
- [ ] 未部署、未跑遠端 migration、未動 N6–N8 列出的檔案
- [ ] 依 §7 回報
