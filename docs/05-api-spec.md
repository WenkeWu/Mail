# 05 — REST API 規格（適合 React App 使用）

> 對應 PRD §十。所有 endpoint 都是 JSON，prefix `/api`。
> Auth：`Authorization: Bearer <JWT>`（Phase 11 實作，見 08 文件）。
> **2026-09-02 更新：Model C（地址即信箱帳號）——雙 session 設計見 §2.0。**
> **2026-09-15 補充（Phase 16）：** session token 以 **`pca`（簽發當下的 `password_changed_at`）作為「token 版本」**判定失效——比 `iat` 精確（秒 vs 毫秒；同一秒內改密碼再登入不會被誤判過期）；舊格式 token（無 `pca`）一律視為失效，需重新登入。
> **2026-09-13 實作註記（Phase 11 完成）：** 密碼雜湊用 **argon2id**（`@noble/hashes`，純 JS；**hash-wasm 在 Workers 不可用**——執行期 WASM 編譯被禁止）；JWT HS256（`hono/jwt`，含 `iat`）；登入鎖定 5 次/15 分（D1 `auth_attempts`）；migration 0003 `password_changed_at` 使**密碼重設後舊 token 立即失效**（401 TOKEN_STALE）；**rescue 通道** `x-admin-token`（owner 等效，僅維運用）。
> 本文先定義**形狀與語意**，Phase 7–11 依此實作。

## 1. API 總覽

| 群組 | 方法 | Path | 用途 |
|---|---|---|---|
| Auth | POST | `/api/auth/login` | Owner（username + 密碼）登入 |
| Auth | POST | `/api/auth/mailbox-login` | 信箱帳號（email address + 密碼）登入 |
| Auth | POST | `/api/auth/register` | **訪客註冊（公開，需邀請碼）** → mailbox session |
| Auth | PATCH | `/api/email-addresses/:id/password` | 重設地址密碼（owner 或本人） |
| Invite | POST | `/api/invites` | 產生邀請碼（owner / x-admin-token） |
| Invite | GET | `/api/invites` | 列出邀請碼（只回遮罩碼） |
| Invite | DELETE | `/api/invites/:id` | 撤銷邀請碼（soft：`status='revoked'`） |
| Me | GET | `/api/me` | 目前 session 的 role／username／各地址寄信配額 |
| 使用者 | PATCH | `/api/users/:id/status` | 停權／復權（owner；C7 立即生效） |
| 地址 | POST | `/api/email-addresses` | 建立虛擬地址 |
| 地址 | GET | `/api/email-addresses` | 列出我的地址（含 disabled） |
| 地址 | GET | `/api/email-addresses/:id` | 單一地址 |
| 地址 | PATCH | `/api/email-addresses/:id` | 改名/改狀態（active↔disabled） |
| 地址 | DELETE | `/api/email-addresses/:id` | Soft delete |
| Alias | POST | `/api/email-aliases` | 建立 alias |
| Alias | PATCH | `/api/email-aliases/:id` | 啟用/停用 |
| Alias | DELETE | `/api/email-aliases/:id` | 刪除 alias |
| Inbox | GET | `/api/mail/inbox` | 收件匣（分頁＋搜尋，scope 見 §2.0） |
| Inbox | GET | `/api/mail/counts` | 各資料夾未讀/總數（側欄 badge；owner 另附各地址） |
| Mail | GET | `/api/mail/:id` | 信件詳情（含附件清單） |
| Mail | GET | `/api/mail/:id/text` | 完整純文字內文（UI 讀信／回覆引言用） |
| Mail | PATCH | `/api/mail/:id/read` | 標記已讀/未讀 |
| Mail | PATCH | `/api/mail/:id/archive` | 封存 |
| Mail | PATCH | `/api/mail/:id/folder` | 移動 folder（trash/spam…） |
| Mail | DELETE | `/api/mail/:id` | Soft delete → trash |
| Mail | POST | `/api/mail/send` | 寄信 |
| Attachment | GET | `/api/mail/:messageId/attachments` | 附件清單 |
| Attachment | GET | `/api/attachments/:id` | 下載附件（stream） |
| Backup | GET | `/api/backup/changes` | 增量備份 cursor（Backup Agent 專用） |

## 2. 詳細規格

### 2.0 登入與權限 Scope（Model C，2026-09-02）

兩種 session（JWT 內含 scope）：

| session | 登入方式 | 能做什麼 |
|---|---|---|
| **Owner** | `POST /api/auth/login` `{ username, password }` | 管理名下地址（建立 / 停用 / 重設密碼）；聚合查看名下所有地址的信 |
| **Mailbox** | `POST /api/auth/mailbox-login` `{ email, password }` | scope = 該地址：只看該地址的信箱（inbox/sent/trash…）、下載其附件、**只能以該地址為 From 寄信**、改自己的密碼 |

```http
POST /api/auth/mailbox-login
{ "email": "alice@atwho.org", "password": "..." }

→ 200 { "token": "<JWT scope=address>", "address": { "id": 7, "email": "alice@atwho.org" } }
→ 401 密碼錯 / 地址不存在 / disabled / deleted
```

**Scope 規則（SQL 層強制，08 文件 §39–40）：**

| session | 可讀信件的範圍 | 可管理 |
|---|---|---|
| Mailbox（alice@） | `WHERE address_id = alice.id` | 自己密碼 |
| Owner（user 101） | `WHERE owner_user_id = 101`（聚合） | 名下地址全部（含重設密碼） |

信箱帳號之間**完全隔離**：alice 登入看不到 bob 的信、不能以 bob@ 寄信。

### 2.1 建立虛擬地址

```http
POST /api/email-addresses
Authorization: Bearer <JWT>            // Owner session

{ "local_part": "alice", "domain": "atwho.org",
  "password": "可選；設定後 alice@atwho.org 即可用信箱帳號登入（Model C）" }
```

```json
201 Created
{ "id": 7, "email": "alice@atwho.org",
  "status": "active", "created_at": 1788000000000 }
```

錯誤：`409`（重複）、`422`（local_part 格式不合法 / 密碼不合規則）。

### 2.2 地址 CRUD 其餘

```http
GET    /api/email-addresses            → 200 [{...}]      // Owner：名下全部；Mailbox：只有自己
GET    /api/email-addresses/:id        → 200 {...} | 404
PATCH  /api/email-addresses/:id        body: { "status": "disabled" } 等
PATCH  /api/email-addresses/:id/password
                                       body: { "new_password": "..." }
                                       // Owner 可直接重設；Mailbox 本人需帶 old_password
DELETE /api/email-addresses/:id        → 204（soft delete，信箱改為 deleted）
```

權限：Owner 只能操作 `user_id = 自己` 的地址；Mailbox 只能操作自己的地址；越權一律 `404`。

### 2.3 寄信

```http
POST /api/mail/send
Authorization: Bearer <JWT>

{
  "from": "alice@atwho.org",            // Mailbox session：必須等於自己的 address
                                        // Owner session：必須是名下 active 地址
  "to": ["bob@example.com"],
  "cc": [],
  "subject": "Hello",
  "html": "<p>...</p>",                 // html 與 text 至少一個
  "text": "...",
  "attachments": [                      // 可省略；base64 或先傳後拿 upload id
    { "filename": "x.pdf", "content_type": "application/pdf",
      "content_base64": "..." }
  ]
}
```

```json
200 OK
{ "messageId": "01JQ...", "send_status": "sent" }
```

錯誤：`403`（from 不屬於 session scope）、`413`（總大小 > 5 MiB）、`422`（收件人 > 50）。

> 5 MiB 上限與 base64 膨脹（×4/3）考量：大附件建議改「先上傳到暫存 → 拿 `uploadId` → 寄信時引用」，MVP 直接內嵌亦可，但要在前端先擋 > 3.5 MiB 的 base64 請求。

### 2.4 Inbox / 信件

```http
GET /api/mail/inbox?folder=inbox&cursor=...&limit=50
                  // 2026-10-07 新增：&q=<搜尋字串>&address_id=<owner 專用>&folder=all（跨資料夾）
→ 200 {
    "items": [
      { "id": 9001, "from": "x@y.com", "subject": "...",
        "text_preview": "...", "received_at": 1788000000000,
        "read": false, "has_attachments": true, "folder": "inbox" }
    ],
    "nextCursor": "..."   // keyset 分頁（received_at, id），null = 到底
  }
  // scope：Mailbox session 自動限定 address_id = 自己；Owner session 預設聚合名下全部

GET /api/mail/:id
→ 200 {
    "id": 9001, "from": "...", "to": [...], "cc": [...],
    "subject": "...", "text_preview": "...", "received_at": ...,
    "read_at": ..., "html_url": null,          // 見下
    "attachments": [{ "id": 5, "filename": "x.pdf",
                      "size_bytes": 1234, "content_type": "application/pdf" }]
  }

PATCH /api/mail/:id/read      body: { "read": true }   → 200
PATCH /api/mail/:id/archive                         → 200（folder: inbox→archive）
PATCH /api/mail/:id/folder    body: { "folder": "trash" } → 200
DELETE /api/mail/:id                                 → 204（soft delete）

GET /api/mail/:id/text
→ 200 { "id": 9001, "text": "完整純文字內文" }        // 無純文字內文 → text: null
  // D1 只存 200 字 preview；超過時由 R2 的 raw .eml 以 postal-mime 解析（HTML-only 信件亦自動轉出 text）
  // R2 遺失／解析失敗 → 退回 preview，不回 500

GET /api/mail/counts
→ 200 { "folders": { "inbox": { "total": 2, "unread": 2 }, "sent": { "total": 4, "unread": 0 },
                     "archive": {...}, "trash": {...}, "spam": {...} },
        "addresses": [ { "id": 1, "email": "alice@atwho.org", "total": 1, "unread": 1 } ] }
  // 側欄 badge 用；addresses 僅 owner session（mailbox → null，且只計 inbox）
  // sent 為寄件備份（read_at 恆為 NULL）→ 一律不計未讀
```

**搜尋參數（供內建 UI）：** `q` 對 `subject` / `from_address` / `text_preview` 做 LIKE（`\ % _` escape 為字面值、上限 200 字）；`folder=all` 跨資料夾；`address_id` 僅 owner scope 有效（mailbox 一律忽略）。

**HTML body 顯示（安全，見 08 文件）：** Worker 回傳 sanitized HTML（存於 R2 `html_r2_key`，寄信與收信都會 sanitize）。**永不直接 render 原始外部 HTML**；圖片一律由 Worker 代理並消毒 URL（或 MVP 直接剝離遠端圖片，只留內嵌 CID）。

### 2.5 附件下載

```http
GET /api/attachments/:id
→ 200 stream
Headers: Content-Type: application/pdf
         Content-Disposition: attachment; filename*=UTF-8''%E5%A0%B1%E5%83%B9...
```

權限：僅該信所屬信箱 scope 可取（mailbox session 自己的 address 的信；owner session 名下）；其餘 404。**禁止路徑參數進入 R2 key**（key 由 D1 查得，非使用者輸入）。

### 2.6 Backup changes（Backup Agent 專用）

```http
GET /api/backup/changes?cursor=<last_watermark>&limit=1000
Authorization: Bearer <BACKUP_TOKEN>        // 獨立高權限 token，非使用者 JWT

→ 200 {
    "nextCursor": 1788123456789,
    "created":   [{ "table": "messages", "id": 9001, "updated_at": ... }],
    "updated":   [...],
    "deleted":   [{ "table": "messages", "id": 9002, "deleted_at": ... }]
}
```

語意（細節見 09 文件）：依各表 `updated_at > cursor` 掃描，`deleted_at` 有值者進 `deleted`。回應內含**完整列資料**（此處省略示意），Agent 直接 upsert 進 PostgreSQL。

### 2.7 Phase 1：邀請碼、訪客註冊、配額（2026-10-12 實作，設計見 `13`）

> 前提：**API Worker 直連不受 Cloudflare Access 保護**（`13` §8.3）→ 防護全靠邀請碼＋限流＋配額＋稽核。

```http
POST /api/invites                       Authorization: owner / x-admin-token
{ "max_uses": 1, "expires_in_hours": 72, "note": "給小明" }        // 後兩者選填
→ 201 { "id": 7, "code": "Xk3…", "max_uses": 1, "expires_at": 1789… }
  // code 為 crypto 隨機 ≥24 字元（base64url）；只在建立當下回傳一次

GET  /api/invites                       → 200 { "invites": [ { "id", "masked_code": "Xk3…",
                                             "max_uses", "used_count", "expires_at", "status", "note", "created_at" } ] }
  // ⚠️ 列表只回遮罩碼（前 4 碼）；不提供全碼查詢

DELETE /api/invites/:id                 → 200 { "ok": true, "id": 7 }   // soft：status='revoked'，不刪資料列

POST /api/auth/register                 // 公開；需邀請碼；5 次失敗鎖 15 分鐘（auth_attempts key=ip:<ip>）
{ "invite_code": "Xk3…", "username": "friend01", "password": "…", "local_part": "friend01" }  // local_part 選填（預設=username）
→ 201 { "token": "<JWT scope=mailbox>", "session": "mailbox", "address": { "id": 12, "email": "friend01@atwho.org" } }
  // 順序（失敗即止）：限流 → REGISTRATION_DISABLED 開關 → 驗邀請碼 → 格式/唯一性 → 密碼強度
  //   → 原子扣次數（UPDATE … WHERE used_count < max_uses）→ 建 users(role='visitor') + email_addresses
  //   → 簽 mailbox JWT → 稽核 register_ok

GET /api/me                             Authorization: owner 或 mailbox
→ 200 { "role": "owner"|"visitor", "session": "owner"|"mailbox", "username": "friend01",
        "addresses": [ { "id", "email", "can_send", "daily_send_quota", "sent_today", "quota_reset_at" } ] }
  // owner：名下全部地址；mailbox：只有自己那一個（供 UI 顯示配額、停用寄信）

PATCH /api/users/:id/status             Authorization: owner
{ "status": "suspended" | "active" }    → 200 { "ok": true, "id": 5, "status": "suspended" }
  // 立即生效：停權後該 user 的 mailbox 登入與寄信皆 403 ACCOUNT_SUSPENDED
  // （DB 端以 users.status='disabled' 表示——0001 的 CHECK 只允許 active/disabled）
```

**寄信配額（`POST /api/mail/send` 內，順序即判定順序）**

| # | 檢查 | 失敗 |
|---|---|---|
| 1 | 帳號 `users.status='active'` | `403 ACCOUNT_SUSPENDED` |
| 2 | 地址 `status='active'` 且 `can_send=1` | `403 SEND_NOT_ALLOWED` |
| 3 | 配額重置（`quota_reset_at` 過期 → `sent_today=0`，次日 00:00 UTC） | — |
| 4 | 暖機期（`created_at` 起 24 小時內上限 `min(quota, 5)`，C2） | — |
| 5 | **原子扣配額**（`sent_today < 有效上限`，看 `meta.changes`）→ 不通過 | `429 QUOTA_EXCEEDED` |
| 6 | 每小時限流（近 60 分鐘寄件備份 ≥ 10，C3）→ 不通過（**並回補步驟 5 的扣額**） | `429 RATE_LIMITED` |
| 7 | 實際寄送（既有邏輯）；寄送失敗 → 回補配額 | 既有錯誤（502 `SEND_FAILED`） |

配額常數單一來源：`packages/api/src/index.ts` 的 `QUOTA`（每日 20／暖機 5 封 24 小時／每小時 10；`13` §6.5 C1–C3）。

**新增錯誤碼**

| 碼 | HTTP | 情境 |
|---|---|---|
| `INVITE_INVALID` | 400 | 邀請碼不存在／已撤銷／已過期 |
| `INVITE_EXHAUSTED` | 400 | 邀請碼使用次數用盡 |
| `ADDRESS_TAKEN` | 400 | `username` 或 `local_part` 重複 |
| `INVALID_LOCAL_PART` | 400 | 格式不符（1–64 字元 `[a-z0-9._-]`） |
| `WEAK_PASSWORD` | 400 | 註冊密碼不符（≥10 字元、非純數字）※既有端點仍為 422 |
| `REGISTRATION_DISABLED` | 403 | 全站關閉註冊（Worker var `REGISTRATION_DISABLED="true"`，預設未設＝開放） |
| `QUOTA_EXCEEDED` | 429 | 超過每日配額／暖機上限 |
| `RATE_LIMITED` | 429 | 超過每小時限流，或註冊／登入嘗試過多 |
| `ACCOUNT_SUSPENDED` | 403 | 帳號被停權（登入與寄信皆擋） |
| `SEND_NOT_ALLOWED` | 403 | `can_send=0`（安全閥 C8） |

**稽核**：`registration_audit` 記錄 `register_ok`／`register_rejected`／`login_failed`／`send_rejected_quota`／`send_rejected_rate`／`send_rejected_notallowed`（以 `waitUntil` 非阻塞寫入；**不納入備份鏡像**）。

## 3. 通用原則

| 原則 | 說明 |
|---|---|
| Keyset pagination | inbox 用 `(received_at, id)` cursor，不用 `offset`（大表穩定） |
| JSON 欄位命名 | `snake_case`（與 DB 一致，減少 mapping） |
| 時間格式 | epoch ms INTEGER |
| 錯誤格式 | `{ "error": { "code": "MAIL_NOT_FOUND", "message": "..." } }` |
| 權限失敗 | 一律 `404`（不確認資源存在性），寄信偽造 From / 登入失敗才是 `401/403` |
| Scope 強制 | 信件與附件查詢一律以 session scope（address_id / owner_user_id）過濾，SQL 層強制 |
| CORS | 以 Worker 變數 `ALLOWED_ORIGINS`（逗號分隔的來源白名單）判定；命中才回 `Access-Control-Allow-*` 與 `Vary: Origin`，preflight `OPTIONS` 回 **204**。認證只用 Bearer token、**不用 cookie**。**目前為 `*`（開發期），上線前收斂為實際網域** → 詳見 `12-pwa-integration.md` §5 |
