# 29 — D29：`app.atwho.org` 收斂管理功能 ＋ 新增「個人設定」頁

> 建立：2026-11-05｜狀態：**待派工**
> owner 回饋（2026-11-05）：
> 1. 用 `app.atwho.org` 進入後，**即使是 owner，也不該看到／操作管理功能**（目前看到「地址管理」「我的全部信箱」⚠️）
> 2. 點頭像要有 **「個人設定」**，裡面顯示：Google 註冊的 email ✅、AtWhoMail 自動分配的 ID ✅
> 3. **匿名（別名）設定**也放到個人設定裡 ✅

## 1. 現況（程式實查）

| 位置 | 現況 | 問題 |
|---|---|---|
| `AppShell.tsx`：`canUseAdminConsole = session.kind === 'owner' && showsAdminConsole(hostMode)` | ✅ 管理主控台（帳號設定／邀請碼／訪客管理）**已**依 host 收斂 | ✅ 正確 |
| `Header.tsx`：地址管理 `{session.kind === "owner" && …}` | ❌ **只看 role，沒看 host** | 🔴 `app.` 也出現「地址管理」|
| `AppShell.tsx`：地址篩選「我的全部信箱」 | ❌ 只看 owner | 🔴 `app.` 也出現 |
| 別名管理 | ❌ 只看 role/host 未收斂 | 🔴 `app.` 也出現 |

## 2. 需求

### 2.1 host 收斂（public vs admin）

| 功能 | `mail.atwho.org`（admin）| **`app.atwho.org`（public）** |
|---|---|---|
| 自己的信箱（收件／寄件／垃圾桶）| ✅ | ✅ |
| 撰寫／回覆 | ✅ | ✅ |
| **個人設定** | ✅ | ✅ **（新增）** |
| 別名（匿名）| ✅ | ✅ **（移到個人設定內）** |
| 地址管理（多地址 CRUD）| ✅ | ❌ **完全隱藏** |
| 「我的全部信箱」地址篩選 | ✅ | ❌ **完全隱藏**（只顯示自己那一個地址）|
| 邀請碼／訪客管理／App Clients | ✅ | ❌ 隱藏 |
| 頭像標籤「管理員」 | ✅ | ⚠️ 改為「**個人帳號**」（不顯示管理員字樣）|

> ⚠️ 這是 **UI 收斂**（依 host 判斷，與既有 `showsAdminConsole()` 一致）。後端授權仍以 session scope 判定（N3），owner token 本身仍有權限——本階段**不改變 API 授權**。

### 2.2 新頁面「個人設定」（`AccountSettings.tsx`）

點頭像 → 選單第一項 **「個人設定」** ✅（任何 host、任何角色都有）。

內容（依角色顯示可用項）：

| 區塊 | 內容 |
|---|---|
| **身分** | AtWhoMail ID：`itag` ✅（唯讀）<br>信箱地址：`itag@atwho.org` ✅（可複製）<br>角色：管理員／一般使用者 ✅ |
| **備用電子郵件**（原「登入方式」） | `contact_email`：Google OAuth 的已驗證 Email，或 **Email 驗證碼註冊時填入的 Email**（migration 0014 回填既有帳號）✅；無值顯示「（未提供）」<br>用途：忘記密碼 ✅ |
| **密碼** | ✅「變更密碼」（有密碼者）<br>✅「**設定密碼**」（無密碼者 → 設定後即可用信箱＋密碼登入）|
| **匿名（別名）** | ✅ 內嵌 `AliasManager`<br>✅ **暱稱別名**：每帳號最多 1 個啟用中；可變更，舊的立即停用 ✅<br>✅ **隱身代號（Token）**：帳號建立時系統自動產生（16 hex），對方只看到隱身代號；系統管理、不可停用／刪除 ✅<br>✅ 說明：「暱稱別名需自行建立（每帳號最多 1 個）；隱身代號由系統自動產生」|
| **配額** | ✅ 今日已寄／每日上限（visitor 顯示 ✅、owner 顯示不適用 ✅）|

### 2.3 後端需要的新端點

| 端點 | 說明 |
|---|---|
| `GET /api/account/settings` | 回 `{ user_id, username, role, contact_email, has_password, addresses: [{id,email,status,daily_send_quota,sent_today}], provider }`（**只回自己的** ✅；不含他人資料 ✅；不含 password_hash ✅）|
| `POST /api/account/password` | `{ current_password?, new_password }`：<br>有密碼 → 必須驗 current ✅<br>無密碼（`hasPassword()===false`）→ 免 current ✅（等於「設定密碼」✅）<br>成功後更新 `pca`（撤銷其他 session ✅）＋稽核 `password_changed` |
| （沿用）`GET /api/email-aliases`、`POST /api/email-aliases` 等 | 別名管理 ✅ |

- 授權：`requireSession`；scope `owner`／`mailbox` 皆可 ✅；`app` scope → 403 `SCOPE_NOT_ALLOWED`

## 3. 前端

- `Header.tsx`：頭像選單改為
  - ✅ **個人設定**（所有角色、所有 host）
  - 帳號設定（變更密碼）→ **移除**（併入個人設定 ✅）
  - 地址管理／管理主控台 → **只在 `mail.` 且 owner** ✅
  - 別名管理 → **移除**（併入個人設定 ✅）
  - 登出 ✅
  - ✅ **頂部列不再提供「撰寫」按鈕**（owner 2026-11-06）；撰寫只在側欄
  - ✅ 手機版側欄鈕：信箱頁＝切換側欄；子頁面（沒有側欄）＝**回到信箱**
- `AppShell.tsx`：`publicMode = hostMode === 'public'`（沿用既有 `showsAdminConsole` 的反向判斷 ✅）
  - `publicMode` → 不渲染地址管理頁、地址篩選、「我的全部信箱」、邀請碼、訪客管理、App Clients ✅
  - 側邊欄只留：收件匣／寄件備份／垃圾桶／撰寫／個人設定 ✅
- 新 `AccountSettings.tsx`（依 §2.2）
- `App.tsx`：新增 page `"settings"` ✅

## 4. 測試 T173–T180

- T173 `app.` host ＋ owner session → **看不到**「地址管理」「我的全部信箱」✅
- T174 `mail.` host ＋ owner session → **看得到** ✅
- T175 `app.` ＋ visitor session → 只看得到自己的信箱 ✅
- T176 頭像選單含「個人設定」，且所有 host／角色都有 ✅
- T177 `GET /api/account/settings`：owner 回自己資料＋`has_password=1`；OAuth 帳號回 `has_password=0` ＋ `contact_email`
- T178 `POST /api/account/password`：無密碼者可設定成功（免 current）✅；有密碼者錯 current → 401；成功後舊 JWT 失效 ✅
- T179 個人設定頁顯示：ID／地址／Google email（有綁定時）／別名入口 ✅
- T180 既有 T1–T172 零回歸

## 5. 不做

- 不改變既有 API 授權（owner token 仍可呼叫管理端點 ✅）
- 不搬移／刪除既有資料
