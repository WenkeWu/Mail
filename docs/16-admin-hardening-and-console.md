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
| **D8** | **停權／停用語意釐清 ＋ 立即生效**（訊息、文案、警告、session 即時失效） | `packages/api/src/index.ts`、`web/src/components/VisitorManager.tsx` | 修改 |
| **D9** | **訪客管理頁新增「刪除訪客」**（含二次確認、完整清除、保留稽核）| `packages/api/src/index.ts`、`web/src/components/VisitorManager.tsx` | 修改 |
| **D10** | **已刪除地址／查不到列的 session 直接失效**（小缺口加固）| `packages/api/src/auth.ts` | 修改 |
| **D11** | **地址刪除語意補平**：寫稽核 ＋ 提供「永久刪除（含信件／附件／釋放名稱）」模式 ＋ UI 語意說明 | `packages/api/src/index.ts`、`web/src/components/AddressManager.tsx`、`VisitorManager.tsx` | 修改 |
| **D11-5** | **允許對「已軟刪除」的地址執行永久清除** ＋ 地址管理頁新增「已刪除的地址」區塊 | `packages/api/src/index.ts`、`web/src/components/AddressManager.tsx` | 修改 |

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

### D8 — 停權（帳號）／停用（地址）語意釐清與立即生效

**背景（實查現況）**：UI 上兩個動作差異不明；且停權後**已登入的 session 仍可讀信**直到 JWT 過期（24h）⚠️

**兩者正確語意（實作證據）**

| | 停權帳號（`users.status`） | 停用地址（`email_addresses.status`） |
|---|---|---|
| 影響範圍 | 該使用者**全部地址** | **僅該一個地址** |
| 登入 | 擋（`403 ACCOUNT_SUSPENDED`）| 擋（目前誤回 `401 INVALID_CREDENTIALS` ⚠️）|
| 寄信 | 擋 | 擋 |
| **收信** | ✅ **照收**（email-handler 只看地址狀態）| ❌ **靜默丟棄該信**（不可逆）⚠️ |

- **D8-1 後端登入訊息**：`mailbox-login` 調整為「**先驗密碼，再判狀態**」（沿用既有避免洩漏帳號狀態的模式）：
  1. 密碼不符 → `401 INVALID_CREDENTIALS`
  2. 密碼正確但地址 `status='disabled'` → `403 ADDRESS_DISABLED`「此地址已停用，請聯絡管理者」
  3. 密碼正確、地址 active 但使用者 `status!='active'` → `403 ACCOUNT_SUSPENDED`（既有文案）
- **D8-2 前端文案**：
  - 停權按鈕 →「**停權帳號（所有地址；仍可收信）**」
  - 停用按鈕 →「**停用地址（連收信都停止）**」
  - 兩者皆附 tooltip 說明差異
- **D8-3 前端二次確認**：停用地址前顯示警告：「此地址將**立即停止收信**，停用期間的來信不會保留」✅
- **D8-4 立即生效（後端）**：`requireSession` 增加狀態檢查 —— 使用者必須 `active`；若為 mailbox session，其地址亦必須 `active`；
  否則回 `403 ACCOUNT_SUSPENDED` 或 `403 ADDRESS_DISABLED`（讓停權／停用**立刻**踢掉現有 session，不必等 24h ✅）
  - 以**單一索引查詢**為限（每次請求最多一次 `SELECT status`），保留既有 `TOKEN_STALE` 檢查
  - ⚠️ 不得改動 `can_send` 語意；不得讓 owner 讀取訪客信件（N9）

---

### D9 — 訪客管理頁新增「刪除訪客」

**動機**：目前刪除帳號只能由助手對 D1 手動執行（`docs/16` D5 未含刪除）⚠️

- 新增端點：`DELETE /api/users/:id`（`requireOwner`）
  - ⚠️ **僅允許 `role='visitor'`**；對 owner 呼叫 → `403 FORBIDDEN`（保護管理帳號 ✅）
  - 刪除範圍（依 FK 順序）：`messages`（該地址與該 owner_user_id 的）→ `attachments`（透過 messages）→ `email_aliases`（指向該地址）→ `email_addresses`（該 user 名下）→ `users` → `auth_attempts`（該地址的 mailbox 計數 key）
  - ⚠️ **不刪稽核**：`registration_audit` 保留（不可竄改原則），並新增管理稽核事件 `user_deleted`（記錄操作 owner id、被刪 username／address／信件數、時間）
  - 安全性：以**精準 id** 操作（禁止 LIKE 模糊比對）；`SELECT` 確認存在且 role 正確才刪
- 前端（`VisitorManager`）：
  - 每列新增「**刪除**」按鈕（danger 樣式），僅 owner 可見
  - **二次確認對話框**必須明寫：「將永久刪除該訪客的帳號、地址、**所有信件與附件**，且**無法復原**；若只是要暫停，請改用『停權』」
  - 成功後重整清單並顯示 toast

### D10 — 已刪除地址／查不到列的 session 直接失效（小缺口加固）

**現況**（2026-10-14 實測發現）：`loadSessionState` 查不到列（例如地址已被刪除）時 `state` 為 `null`，
`requireSession` 因 `state && …` 的短路判斷而**放行** ⚠️

- 修正：`loadSessionState` 回 `null` → **視為 session 失效** → `401 TOKEN_STALE`「session 已失效，請重新登入」
- ⚠️ 例外：**rescue（`x-admin-token`）不受影響**（既有豁免，N5）
- ⚠️ 不得因此讓 owner 查不到自己時回 500（需明確 401）

---

### D11 — 地址刪除語意補平（稽核 ＋ 永久刪除 ＋ UI 說明）

**背景（2026-10-14 實測發現）**：`DELETE /api/email-addresses/:id` 只做**軟刪除**
（`UPDATE email_addresses SET status='deleted', deleted_at=…`），**保留信件與 R2 物件、且不留稽核** ⚠️；
而「訪客刪除」（D9）是硬刪除 ＋ 清 R2 ＋ 寫稽核 ✅ → 兩者語意不一致，容易誤解。

**設計原則**：地址＝信箱（只列 owner 自己的）；訪客＝別人註冊的帳號。兩頁維持並存，但**刪除語意補平**。

- **D11-1 稽核**：`DELETE /api/email-addresses/:id` 一律寫稽核 `address_deleted`
  （欄位：操作 owner id、address id／email、`mode`＝soft／hard、被刪信件數、時間；⚠️ 不得記錄信件內容）
- **D11-2 兩種刪除模式**：`DELETE /api/email-addresses/:id?mode=soft|hard`（**預設 `soft`，維持既有行為相容**）
  - `soft`（現狀）：標記 `status='deleted'`、`deleted_at`；**保留**信件與 R2 ✅
  - `hard`：在 soft 之後，接續刪除該地址**所有** `messages`（含所有資料夾／垃圾桶）→ `attachments` → R2 物件
    （`raw_r2_key`／`html_r2_key`／`attachments.r2_key`，best-effort，失敗僅記錄 log ✅）
  - ⚠️ **名稱釋放**：請確認新增地址的唯一性檢查是否排除 `deleted` 列；若會阻擋重建同名地址，
    `hard` 模式需真正移除該列（或調整檢查），並以測試證明「hard 後可重建同名地址」✅；
    `soft` 模式行為不得改變 ✅
  - 權限：僅 owner 且**只能操作自己名下**的地址（他人地址 → 404 ✅）；不得刪除訪客地址（那是訪客管理／D9 的職責 ✅）
- **D11-3 前端（`AddressManager`）**：刪除按鈕 → 二次確認對話框提供兩個明確選項
  ① **停用並保留信件**（soft，預設 ✅）
  ② **永久刪除**（hard：連同該地址所有信件與附件、清除 R2、釋放名稱；標明**不可復原** ⚠️）
  並顯示該地址信件數（例：「此地址有 15 封信，永久刪除將一併刪除」✅）
- **D11-4 UI 語意說明**：`AddressManager` 與 `VisitorManager` 各加一行說明
  （地址管理＝**你自己的信箱**；訪客管理＝**別人用邀請碼註冊的帳號**）✅

---

### D11-5 — 允許對「已軟刪除」的地址執行永久清除

**背景**（D11 完成後的已知限制 ✅）：`DELETE /api/email-addresses/:id` 對 `deleted_at` 非空的列回 **404**，
且該列不出現在清單 → 已軟刪除的地址**無法再從 UI／API 升級為永久刪除** ⚠️（其信件與 R2 物件會殘留）。

- 後端：`DELETE /api/email-addresses/:id?mode=hard`
  - 查詢條件需**涵蓋已軟刪除的列**（`deleted_at` 不為 NULL 亦可），但**仍嚴格限制 owner 自己名下**（他人地址 → 404）
  - 行為：清除該地址所有 `messages`（含所有資料夾／垃圾桶）→ `attachments` → `email_aliases` → `auth_attempts`（`mailbox:<email>`）
    → R2 物件（best-effort，失敗只記 log）→ 釋放名稱（讓同名可重建）
  - 稽核：`address_deleted`（`mode='hard'`、address id／email、被刪信件數、操作 owner id、時間；不得含信件內容）
  - `soft` 模式對已軟刪除地址的行為必須明確且可測（維持不變或回明確錯誤碼，**不得 500**）
- 前端（`AddressManager`）：新增「**已刪除的地址**」收合區塊
  - 列出 `status='deleted'` 的地址（地址、刪除時間、信件數）
  - 每列「**永久刪除**」按鈕 → 二次確認明寫：將清除該地址所有信件與附件（含垃圾桶），**不可復原** ⚠️
  - 僅 owner 可見；清單載入失敗不得讓整頁壞掉
- 測試：**T30**（對已軟刪除地址執行 hard → 信件／附件／R2 清除、名稱可重用、稽核正確）；
  **T31**（非 owner／他人地址 → 404 或 403）；**T32**（soft 對已軟刪除地址的行為明確且無 500）

**D11-5 已完成（2026-10-15；未部署）**

| 項目 | 結果 |
|---|---|
| 實作 | commit `153b42a`（後端 `packages/api/src/index.ts`：查詢條件涵蓋已軟刪除的列 ＋ `GET /api/email-addresses?deleted=1`；前端 `AddressManager.tsx`／`endpoints.ts`／`types.ts`／`statusSemantics.ts`／`styles.css`）|
| canonical 三指令 | ✅ `lint` 0／`build` 0／`test` **18 files / 252 tests** 全綠（原 17 files / 233 tests）|
| 測試（T30–T32） | ✅ `packages/api/test/admin-address-purge.spec.ts`（**13 案例**：T30–T32 ＋ 清單內容與權限、精準清除不誤傷、重複 hard、參數邊界、rescue（N5））、`web/test/statusSemantics.spec.ts`（＋6 案例：D11-5 文案）|
| 既有測試調整 | ⚠️ **1 處**（`admin-address-delete.spec.ts` T28）：對已軟刪除的列 `?mode=hard` 由 `404` 改為 `200` —— 這正是 D11-5 要求的行為變更；`soft`（含未帶 mode）對該類列仍為 `404` |
| soft 對已軟刪除列的行為（規格要求「明確且可測」） | ✅ 採「**維持不變**」：`404 NOT_FOUND` —— 不重複標記、**不改寫原 `deleted_at`**、不寫稽核、**不得 500**（T32 逐項驗證）|
| 名稱釋放 | ✅ 升級 hard 後同名可重建（201）；解掉「soft 過的名稱永遠卡住」的殘留 |
| 前端 | ✅ 「已刪除的地址」收合區塊（僅 owner；地址／刪除時間／信件數）；每列「永久刪除」→ 二次確認逐字明寫「所有信件與附件（**含垃圾桶**）…**不可復原**」；清單載入失敗只影響該區塊（區塊內錯誤＋重試）|
| N 系列合規 | ✅ 訪客公開路徑未變（N2）、未以 hostname 判定權限（N3）、`ALLOWED_ORIGINS` 未變（N4）、rescue 與 `/api/backup/*` 未變（N5，且 rescue 同樣可升級清除）、未部署亦未跑遠端 migration（N6／N10）、未寫入 secret（N7）、`docs/13`–`15` 與 `scripts/` 未動（N8）、稽核與清單皆只有數量／時間不含信件內容（N9）|
| migration | ⬜ 本次**無新增** migration |
| 部署 | ⬜ 未部署（前端需在 `web/` 目錄 build 後 deploy，指令見階段 1）|
| 文件 | ✅ `docs/05` §2.2／§2.14（mode × 列狀態對照表）／§2.16（新章）、`docs/11` §2-13b 與 §3 端點矩陣 |

**D11 主體已完成的行為變更（部署時需知）**

| 項目 | 說明 |
|---|---|
| `POST /api/email-addresses` 重複檢查 | ⚠️ 修正既有 Bug：舊版對「曾被 soft 刪除的名稱」放行檢查 → `INSERT` 撞 UNIQUE → **HTTP 500**；新版回 **409 `ADDRESS_EXISTS`**（語意不變：soft 過的名稱仍不可重建，需先 `mode=hard`）✅ |
| 回應碼 | `soft` 維持 **204**（相容既有契約）；`hard` 回 **200** ＋ 刪除數量 ✅ |
| hard 附帶清除 | 另清 `email_aliases`（指向該地址者）與 `auth_attempts`（`mailbox:<email>`）——避免 FK 失敗與殘留鎖定 ✅ |

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
| T17 | 使用者被停權後，**既有** mailbox JWT 立即失效 → 403 `ACCOUNT_SUSPENDED`（不必等 token 過期）|
| T18 | 地址被停用後，**既有** mailbox JWT 立即失效 → 403 `ADDRESS_DISABLED` |
| T19 | `mailbox-login`：密碼錯誤 → 401 `INVALID_CREDENTIALS`；密碼正確但地址停用 → 403 `ADDRESS_DISABLED`；帳號停權 → 403 `ACCOUNT_SUSPENDED` |
| T20 | `DELETE /api/users/:id` 對訪客 → 200，且 user／address／messages／attachments／aliases／auth_attempts 皆清除，`registration_audit` 保留並新增 `user_deleted` 稽核 |
| T21 | `DELETE /api/users/:id` 對 **owner** → 403 `FORBIDDEN`（不得刪除管理帳號）|
| T22 | 訪客 JWT 呼叫 `DELETE /api/users/:id` → 403 |
| T23 | 地址被刪除後，該地址的舊 mailbox JWT → **401 `TOKEN_STALE`**（查不到列即失效，D10）|
| T24 | D10 不得造成 500：查不到列的 owner session → 401，且 rescue token 仍可通過 |
| T25 | `mode=soft`（預設）：地址標記 deleted，**信件與 R2 保留**，稽核 `address_deleted(mode=soft)` |
| T26 | `mode=hard`：該地址所有 messages／attachments 清除、R2 物件刪除，稽核 `address_deleted(mode=hard)` |
| T27 | `mode=hard` 之後，**同一個 email 可重新建立**（名稱已釋放）|
| T28 | 不可刪他人地址（他人 address id → 404）；訪客 JWT 呼叫 → 403 |
| T29 | 稽核事件**不含**任何信件內容（主旨／寄件者／內文）|
| T30 | 對**已軟刪除**的地址執行 `mode=hard` → 信件／附件／R2 清除、名稱可重用、稽核 `address_deleted(mode=hard)` |
| T31 | 對已軟刪除的地址，非 owner 或他人地址 → 404／403（不得誤刪）|
| T32 | 對已軟刪除的地址執行 `mode=soft` → 行為明確且無 500 |

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
- [ ] canonical 三指令全綠；T1–T32 通過
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

### 階段 5（D8）— ✅ 程式完成（2026-10-15；**未部署**）

| 項目 | 結果 |
|---|---|
| 實作 | commit `588f9db`（D8-1：`mailbox-login` 先驗密碼再判狀態；D8-4：`requireSession` 狀態檢查，與 `TOKEN_STALE` 共用同一次索引查詢；D8-2／D8-3：`web/src/lib/statusSemantics.ts` ＋ `VisitorManager.tsx` 文案與二次確認）|
| canonical 三指令 | ✅ `lint` 0／`build` 0／`test` **15 files / 191 tests** 全綠（原 171）|
| 測試（T17–T19） | ✅ `packages/api/test/admin-status.spec.ts`（14 案例：T17／T18／T19 ＋ TOKEN_STALE 保留、rescue 不受影響（N5）、`can_send` 不變、N9 不放寬、兩層判定順序）、`web/test/statusSemantics.spec.ts`（6 案例：按鈕文案／tooltip／二次確認警語）|
| 既有測試調整 | ⚠️ **2 處**（`admin-console.spec.ts` 的 D5 案例）：錯誤碼由 D8 取代 —— 停用地址登入 `401 INVALID_CREDENTIALS` → `403 ADDRESS_DISABLED`、既有 session 寄信 `FROM_NOT_ALLOWED` → `ADDRESS_DISABLED`。`can_send` 語意的 `SEND_NOT_ALLOWED` 覆蓋未變（`registration.spec.ts`、`admin-console.spec.ts` T14）|
| N 系列合規 | ✅ 訪客公開路徑認證要求未變（N2，僅錯誤碼更精確）、未以 hostname 判定權限（N3）、`ALLOWED_ORIGINS` 未變（N4）、rescue 與 `/api/backup/*` 未變（N5）、未部署亦未跑遠端 migration（N6／N10）、未寫入 secret（N7）、`docs/13`–`15` 與 `scripts/` 未動（N8）、owner 仍不得讀取訪客信件（N9）|
| 行為變更告知 | ⚠️ 停權／停用現在**立即**踢掉既有 session（先前需等 JWT 24h 過期）→ 已列入 `docs/11` §2-11 上線驗收 |
| migration | ⬜ 本次**無新增** migration |
| 部署 | ⬜ 未部署（前端需在 `web/` 目錄 build 後 deploy，指令見階段 1）|
| 文件 | ✅ `docs/05` §2.10（語意對照表／登入錯誤碼矩陣／`requireSession` 狀態檢查／新增 `ADDRESS_DISABLED`）、§2.11（前端文案）、`docs/11` §2-11 與 §3 端點矩陣 |

### 階段 2 需要的值（已查得）

| 名稱 | 值 | 用途 |
|---|---|---|
| `ACCESS_TEAM_DOMAIN` | `steep-queen-06be.cloudflareaccess.com` | 取 Access 公鑰驗簽 |
| `ACCESS_MAIL_AUD` | `48c19f72b4892912c5176b3f88ce1fdae27ff6461eb85ef52b928e688567d077` | 驗證 JWT 的 `aud` 必須等於 `mail.atwho.org` 應用 |

> 這兩個值建議設為 Worker 環境變數（`vars`；非機密 ✅），**不要硬編碼在程式內**。

### 階段 3–5（Access 閘門啟用、D8）— ✅ 完成並上線（2026-10-14）

| 項目 | 結果 |
|---|---|
| D8 實作 | commit `588f9db`（`auth.ts` 狀態檢查 ＋ `index.ts` 登入訊息順序 ＋ `VisitorManager` 文案／確認 ＋ 新測試 `admin-status.spec.ts` 393 行）；文件 `b81aa5e` |
| canonical 三指令 | ✅ `lint` 0／`build` 0／`test` **15 files / 191 tests** 全綠 |
| D8-4 設計 | 狀態檢查與 `TOKEN_STALE` **共用同一次查詢**（`loadSessionState`），不增加每請求查詢數；**rescue token 仍可繞過**以保留緊急救援 ✅ |
| migration 0007 | ✅ 已套用 production（純新增欄位）|
| API 部署 | ✅ Version `b1d82f32-b475-48b6-856f-1716c7680a5b`（含 `ACCESS_TEAM_DOMAIN`／`ACCESS_MAIL_AUD`）|
| 前端部署 | ✅ Pages（含 D8 文案）；commit `6be0839`（wrangler vars）已 push |

**階段 ③ 驗收（實測）**

| 檢查 | 結果 |
|---|---|
| `curl` 直打 `POST /api/auth/login`（正確帳密）| ✅ **403 `ADMIN_LOGIN_REQUIRES_ACCESS`** |
| 訪客 `POST /api/auth/mailbox-login` | ✅ 仍公開（錯密碼 401）|
| `mail.atwho.org`（經 Access ＋ Pages 代理）| ✅ **owner 實測登入成功**（Access JWT 轉發鏈路成立）|
| 停權後既有 JWT | ✅ 立即 `403 ACCOUNT_SUSPENDED`（可逆實測，測試資料已完全清除）|
| 地址停用後登入 | ✅ 正確密碼 → `403 ADDRESS_DISABLED`；錯誤密碼 → 401（不洩漏狀態）|

**Access 設定調整（2026-10-14）**：`mail.atwho.org` Access session 由 **168h 縮短為 24h**（縮小裝置被偷用／session 被竊的窗口；政策仍為 allow `ulhome@gmail.com`，訪客入口 `app.atwho.org` 不受影響）。

**回退方式**：移除／清空 `ACCESS_MAIL_AUD` → 重新部署（程式僅記錄 warning 並放行）。

**已知小缺口（未來加固，非安全問題）**：地址已被刪除時，`loadSessionState` 查不到列 → session 不判失效；
該地址已無資料且無法寄信，故無實質影響；可改為「查不到列即視為失效」。
→ **2026-10-15 已由 D10 修補**（查不到列 → `401 TOKEN_STALE`；見下方階段 6 ✅）。

### 階段 6（D9 刪除訪客 ＋ D10 查不到列的 session 失效）— ✅ 程式完成（2026-10-15；**未部署**）

| 項目 | 結果 |
|---|---|
| 實作 | commit `0c645ec`（D9：`DELETE /api/users/:id` ＋ `web/src/components/VisitorManager.tsx` 刪除按鈕／二次確認 ＋ `web/src/api/endpoints.ts`、`web/src/lib/statusSemantics.ts`；D10：`auth.ts` 新增 `loadLiveState`）|
| canonical 三指令 | ✅ `lint` 0／`build` 0／`test` **16 files / 208 tests** 全綠（原 15 files / 191 tests）|
| 測試（T20–T24） | ✅ `packages/api/test/admin-delete.spec.ts`（**13 案例**：T20–T24 ＋精準刪除不誤傷他人、owner 保護（含 role 被誤設的縱深防禦）、rescue（N5）、軟刪除地址一併清除、無地址訪客、R2 物件清除、錯誤碼邊界）、`web/test/statusSemantics.spec.ts`（＋4 案例：D9 文案逐字）|
| D9 設計 | 僅 `role='visitor'`（對 owner → `403 FORBIDDEN`）；精準 id、**無 LIKE**；單一 `batch` 交易依 FK 由子到父刪除（失敗即回滾 → `500 DELETE_FAILED`）；R2 物件 best-effort 清除；`registration_audit` 一字不動 ＋ 新稽核 `user_deleted` |
| D10 設計 | `loadSessionState` 查不到列 → **一律失效**：`401 TOKEN_STALE`「session 已失效，請重新登入」（不再因 `state && …` 短路而放行，也**不得**回 500）；與「密碼已變更」的訊息可分辨；**rescue 仍豁免**（N5）|
| 既有測試 | ✅ T1–T19 **無回歸**（不需調整任何既有案例）|
| N 系列合規 | ✅ 訪客公開路徑未變（N2）、未以 hostname 判定權限（N3）、`ALLOWED_ORIGINS` 未變（N4）、rescue 與 `/api/backup/*` 未變（N5）、未部署亦未跑遠端 migration（N6／N10）、未寫入 secret（N7）、`docs/13`–`15` 與 `scripts/` 未動（N8）、owner 仍讀不到訪客信件（N9）|
| 行為變更告知 | ⚠️ 帳號／地址被刪除後，其**舊 JWT 立即失效**（先前為放行，會回 404／空清單）→ 已列入 `docs/11` §2-12 部署前告知 |
| migration | ⬜ 本次**無新增** migration（0007 為階段 3 既有檔案）|
| 部署 | ⬜ 未部署（前端需在 `web/` 目錄 build 後 deploy，指令見階段 1）|
| 文件 | ✅ `docs/05` §2.12（端點／錯誤碼／稽核／D10 對照表）與 §2.13（前端二次確認）、`docs/11` §2-12（上線驗收）與 §3 端點矩陣 |

**R2 提醒（給 owner）**：刪除訪客會一併刪除其信件與附件的 **R2 物件**（best-effort；失敗只記 log，
不影響 D1 已完成的刪除——沒有 DB 列就沒有 key）。若該訪客的信要留檔，請先確認備份已完成（`docs/09`）。

---

## 10. owner 決策紀錄（2026-10-14）

| 項目 | 決定 | 理由／備註 |
|---|---|---|
| 階段 ③（Access JWT 閘門）| ✅ 已上線 | 管理登入只認 `mail.atwho.org` ＋ Access；`curl`／`app.` 一律 403 |
| `mail.` Access session 168h → 24h | ✅ 已套用 | 縮小裝置／cookie 被竊窗口 |
| D8（停權／停用語意 ＋ 立即生效）| ✅ 已上線 | |
| D9（刪除訪客按鈕）／D10（查不到列的 session 失效）| ✅ 實作完成，待部署 | |
| **選項 A**（Access 改用 Google IdP ＋ 只允許 Google）| ❌ **不做** | owner 判斷：現行 Access 已含 **Google 手機確認**，再升級無實質效益 |
| **選項 B**（開 Google 帳號兩步驟驗證）| ❌ **不做（視為已具備）** | 同上；實際上 owner 的 Google 帳號很可能**已開啟**兩步驟驗證（手機確認）→ 建議日後只做「狀態確認」即可 |
| **選項 4**（Cloudflare WAF 速率限制）| ❌ **不做** | 需先給 API 自訂網域（`api.atwho.org`）；owner 評估不需要 |
| **選項 5**（D6：App 內建 TOTP）| ❌ **不做** | 與 Access ＋ Google 認證重疊，且需額外開發與驗證器 App |

**現行有效防護層級（實際生效）**：Access 身分閘門（24h）→ 管理登入需 Access JWT（階段 ③）→ 帳號密碼（argon2id ＋ 5 次失敗鎖 15 分）→ 登入後狀態檢查（D8 立即生效）→ 訪客隔離（mailbox scope ＋ N9）。

### 階段 6（D9／D10）— ✅ 完成並上線（2026-10-14）

| 項目 | 結果 |
|---|---|
| 實作 | commit `0c645ec`（`auth.ts`、`index.ts`、`VisitorManager.tsx`、`endpoints.ts`、新測試 `admin-delete.spec.ts` 471 行）；文件 `6103ded` |
| canonical 三指令（助手獨立複跑）| ✅ `lint` 0／`build` 0／`test` **16 files / 208 tests**（T20–T24 全數涵蓋）|
| 超出規格但合理的實作（已覆核 ✅）| ① 刪除訪客時**一併刪除 R2 物件**（raw／html／附件，best-effort）② `attachments` 先於 `messages` 刪除且整批為**單一交易**（失敗回滾並回 `500 DELETE_FAILED`）③ 額外以防誤設的 owner 帳號守門 |
| API 部署 | ✅ Version `bbff0f9d-d321-4b97-b83c-c52e253911b6`（無新 migration；Access 變數保留）|
| 前端部署 | ✅ Pages（新版 `index-CKI_M_QZ.js`，含「刪除訪客」按鈕與「無法復原」警告）|

**線上驗收（實測，未刪任何真實訪客）**

| 檢查 | 結果 |
|---|---|
| `DELETE /api/users/2`（owner）| ✅ **403 FORBIDDEN**「只能刪除訪客帳號（owner 帳號受保護）」|
| `DELETE /api/users/999999`（不存在）| ✅ 404（非 500）|
| `GET /api/users?role=visitor` | ✅ 200，清單正常 |
| 救援通道（D10／N5）| ✅ `GET /api/backup/changes` 帶 `x-admin-token` → 200（查不到列不影響 rescue）|
| 階段 ③ 閘門 | ✅ 管理登入 curl → 仍 `403 ADMIN_LOGIN_REQUIRES_ACCESS` |

**⚠️ 行為變更（部署後生效）**：帳號或地址被刪除後，其**舊 JWT 立即失效**（401 `TOKEN_STALE`，訊息區分「查不到列」與「密碼已變更」）；先前為放行。
**⚠️ 刪除是破壞性的**：會連同 R2 上的原始信件／HTML／附件一併刪除，**不可復原**；若只是要暫停，請用「停權」。

### 階段 7（D11／D11-5）— ✅ 完成並上線（2026-10-14）

| 項目 | 結果 |
|---|---|
| 實作 | `2b8478e`（D11 主體）、`153b42a`（D11-5）、`1905fbf`（文件）；助手另補 `6859b32`（規格）|
| canonical 三指令（助手獨立複跑）| ✅ `lint` 0／`build` 0／`test` **18 files / 252 tests**（T25–T32 全數涵蓋）|
| API 部署 | ✅ Version `5fe03f0e-6fb1-4ebc-bf0b-ee0f49dec1ad` |
| 前端部署 | ✅ Pages（新版 `index-DCUIr_k_.js`，含「已刪除的地址」區塊與兩選項刪除對話框）|

**真實端到端驗收（助手實測，含單元測試無法覆蓋的 R2 路徑 ✅）**

| 步驟 | 結果 |
|---|---|
| 建立臨時地址 | ✅ `purgetest@atwho.org`（id=21）|
| **實際寄一封信進去** | ✅ 5 秒投遞；訊息 id=88、R2 原始檔 `mail/2026/10/…eml` |
| 刪除前檢查 R2 | ✅ HTTP 200（物件存在）|
| `?mode=hard` 永久刪除 | ✅ `{"messages":1,"r2_objects":1}` |
| 刪除後 | ✅ 訊息 0、地址列已移除、**R2 → 404（確實清除）**、稽核 `address_deleted`（`by`／`mode`／`messages`／`r2_objects`）✅ |
| 名稱釋放 | ✅ 同名前綴可重新建立（201）|
| 「已刪除的地址」清單 | ✅ `GET /api/email-addresses?deleted=1` 回 10 筆（含 `test1@atwho.org`）|
| 測試資料清理 | ✅ 測試地址與其訊息／R2 物件全部清除；測試寄件備份已刪除 |

**⚠️ 行為變更（部署後生效）**
1. 重建「曾被軟刪除」的同名地址：舊版 **500** → 新版 **409 `ADDRESS_EXISTS`**（附提示需 `mode=hard`）✅ **修好既有 Bug**
2. 對「已軟刪除」的地址執行 `?mode=hard`：由 `404` 改為 **`200` ＋ `previously_deleted:true`**（可清除垃圾桶列與其 R2 物件 ✅）
3. `soft` 對已軟刪除地址：**維持 `404`**（不重複標記、不改寫 `deleted_at`、不寫稽核 ✅）
