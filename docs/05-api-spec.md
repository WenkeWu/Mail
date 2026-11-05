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
| Auth | POST | `/api/auth/register` | **訪客註冊（公開）** → mailbox session；行為依 `REGISTRATION_MODE`（`invite` 預設＝邀請碼／`email_verify`＝改走下方兩端點／`closed`＝關閉，docs/21 D21） |
| Auth | GET | `/api/auth/registration-mode` | **目前註冊模式**（公開；`{mode}`，僅影響前端表單顯示，docs/21 D21） |
| Auth | POST | `/api/auth/register-request` | **寄送 6 位數 Email 驗證碼**（公開；僅 `email_verify` 模式，docs/21 D21） |
| Auth | POST | `/api/auth/register-verify` | **驗碼＋建立訪客帳號＋回 mailbox session**（公開；僅 `email_verify` 模式，docs/21 D21） |
| Auth | PATCH | `/api/auth/owner-password/self` | **owner 本人變更自己的密碼**（session ＋ 舊密碼；docs/16 D7） |
| Auth | PATCH | `/api/email-addresses/:id/password` | 重設地址密碼（owner 或本人） |
| Invite | POST | `/api/invites` | 產生邀請碼（owner / x-admin-token） |
| Invite | GET | `/api/invites` | 列出邀請碼（只回遮罩碼；`?reveal=1` 回全碼並寫稽核，docs/16 D4） |
| Invite | DELETE | `/api/invites/:id` | 撤銷邀請碼（soft：`status='revoked'`） |
| Me | GET | `/api/me` | 目前 session 的 role／username／各地址寄信配額 |
| 使用者 | GET | `/api/users?role=visitor` | **訪客清單（owner；只回數量與時間）**（docs/16 D5） |
| 使用者 | PATCH | `/api/users/:id/status` | 停權／復權（owner；C7 立即生效） |
| 使用者 | PATCH | `/api/users/:id/quota` | **調整每日配額（1–200）＋寄信安全閥**（docs/16 D5） |
| 使用者 | PATCH | `/api/users/:id/warmup` | **暖機豁免**（需 migration 0007；docs/16 D5） |
| 使用者 | DELETE | `/api/users/:id` | **永久刪除訪客**（owner；僅 `role='visitor'`，不可復原、稽核保留，docs/16 D9） |
| 地址 | PATCH | `/api/email-addresses/:id/status` | **停用／啟用訪客地址**（owner 專用；解 404 缺口，docs/16 D5） |
| 地址 | POST | `/api/email-addresses` | 建立虛擬地址 |
| 地址 | GET | `/api/email-addresses` | 列出我的地址（含 disabled） |
| 地址 | GET | `/api/email-addresses/:id` | 單一地址 |
| 地址 | PATCH | `/api/email-addresses/:id` | 改名/改狀態（active↔disabled） |
| 地址 | DELETE | `/api/email-addresses/:id` | Soft delete |
| Alias | POST | `/api/email-aliases` | **建立別名（D25；流水號由系統分配）** |
| Alias | GET | `/api/email-aliases` | **別名清單（D25；含 received_count／last_received_at）** |
| Alias | PATCH | `/api/email-aliases/:id` | **啟用／停用（D25）** |
| Alias | DELETE | `/api/email-aliases/:id` | **軟停用（D25；不刪資料列）** |
| Inbox | GET | `/api/mail/inbox` | 收件匣（分頁＋搜尋，scope 見 §2.0） |
| Inbox | GET | `/api/mail/counts` | 各資料夾未讀/總數（側欄 badge；owner 另附各地址） |
| Mail | GET | `/api/mail/:id` | 信件詳情（含附件清單） |
| Mail | GET | `/api/mail/:id/text` | 完整純文字內文（UI 讀信／回覆引言用） |
| Mail | PATCH | `/api/mail/:id/read` | 標記已讀/未讀 |
| Mail | PATCH | `/api/mail/:id/archive` | 封存 |
| Mail | PATCH | `/api/mail/:id/folder` | 移動 folder（trash/spam…） |
| Mail | DELETE | `/api/mail/:id` | **軟刪除**→ trash（可還原；`?mode=hard` 永久刪除，docs/19 D19-1） |
| Mail | POST | `/api/mail/:id/restore` | **從垃圾桶還原**→ inbox（docs/19 D19-1） |
| Mail | POST | `/api/mail/trash/empty` | **清空自己的垃圾桶**（永久刪除；上限 500 封，docs/19 D19-1） |
| Mail | POST | `/api/mail/batch` | **批次動作** trash／restore／read／purge（上限 200 id，docs/19 D19-2） |
| Mail | POST | `/api/mail/send` | 寄信（全內部收件人→本地直送，docs/18 P1） |
| Form | POST | `/api/forms/send` | **建立並本地投遞互動式表單**（docs/18 P2；絕不呼叫 EMAIL.send） |
| Form | GET | `/api/forms/:id` | **收件人取表單 schema**（四道鎖；失敗一律 404） |
| Form | POST | `/api/forms/:id/responses` | **送出表單回覆**（依 schema 驗證） |
| Form | GET | `/api/forms/:id/responses` | **寄件人查看回覆**（僅寄件人） |
| Form | POST | `/api/forms/:id/revoke` | **寄件人撤回整批表單** |
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
GET    /api/email-addresses            → 200 [{...}]      // Owner 名下（僅未刪除的列）；含 messages 計數
GET    /api/email-addresses?deleted=1   → 200 [{...}]      // 僅**已軟刪除**的列（垃圾桶；D11-5，§2.16）
GET    /api/email-addresses/:id        → 200 {...} | 404
PATCH  /api/email-addresses/:id        body: { "status": "disabled" } 等
PATCH  /api/email-addresses/:id/password
                                       body: { "new_password": "..." }
                                       // Owner 可直接重設；Mailbox 本人需帶 old_password
DELETE /api/email-addresses/:id?mode=soft|hard
                                       → soft（預設）204；hard 200 {...}
                                       // soft＝標記 deleted（信件與 R2 保留）；hard＝連信件／附件／R2 一併清除
                                       // ⚠️ hard 也可用在**已軟刪除**的地址（唯一能清掉殘留的路徑，D11-5）
                                       // 詳見 §2.14（階段 7／D11）與 §2.16（D11-5）
```

權限：Owner 只能操作 `user_id = 自己` 的地址；Mailbox 只能操作自己的地址；越權一律 `404`。
**訪客地址**的刪除不走這裡（owner 對訪客地址一律 `404`）→ 走訪客管理 `DELETE /api/users/:id`（§2.12）。

### 2.3 寄信

```http
POST /api/mail/send
Authorization: Bearer <JWT>

{
  "from": "alice@atwho.org",            // Mailbox session：必須等於自己的 address
                                        // Owner session：必須是名下 active 地址
                                        // D25：也可以是「自己名下的 active 別名」
                                        //       （別名 target 須屬於 session scope；配額計入 target）
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

錯誤：`403`（from 不屬於 session scope，含停用／他人的別名 → `FROM_NOT_ALLOWED`）、`413`（總大小 > 5 MiB）、`422`（收件人 > 50）。

> **D25（別名 From）**：成功寄出後寫稽核 `mail_sent`，`detail` 只有 `{ via_alias: boolean }`
> （不記別名地址、主旨或收件人，N9）。寄件備份的 `address_id` 與配額（每日／每小時／暖機）
> **一律計入別名的 target 地址**；實際寄出的 From 標頭是別名。

> 5 MiB 上限與 base64 膨脹（×4/3）考量：大附件建議改「先上傳到暫存 → 拿 `uploadId` → 寄信時引用」，MVP 直接內嵌亦可，但要在前端先擋 > 3.5 MiB 的 base64 請求。

### 2.4 Inbox / 信件

```http
GET /api/mail/inbox?folder=inbox&cursor=...&limit=50
                  // 2026-10-07 新增：&q=<搜尋字串>&address_id=<owner 專用>&folder=all（跨資料夾）
→ 200 {
    "items": [
      { "id": 9001, "from": "x@y.com", "subject": "...",
        "text_preview": "...", "received_at": 1788000000000,
        "read": false, "has_attachments": true, "folder": "inbox",
        "envelope_to": "luke001@atwho.org" }   // D25：寄給別名時為別名；否則 null
    ],
    "nextCursor": "..."   // keyset 分頁（received_at, id），null = 到底
  }
  // scope：Mailbox session 自動限定 address_id = 自己；Owner session 預設聚合名下全部

GET /api/mail/:id
→ 200 {
    "id": 9001, "from": "...", "to": [...], "cc": [...],
    "subject": "...", "text_preview": "...", "received_at": ...,
    "read_at": ..., "html_url": null,          // 見下
    "envelope_to": "luke001@atwho.org",        // D25：寄給別名時為別名；否則 null
    "attachments": [{ "id": 5, "filename": "x.pdf",
                      "size_bytes": 1234, "content_type": "application/pdf" }]
  }

PATCH /api/mail/:id/read      body: { "read": true }   → 200
PATCH /api/mail/:id/archive                         → 200（folder: inbox→archive）
PATCH /api/mail/:id/folder    body: { "folder": "trash" } → 200
DELETE /api/mail/:id                                 → 204（**軟刪除**：只設 folder='trash'；deleted_at 保持 NULL）
  // ⚠️ D19-1 語意：folder='trash' ＝ 可還原；deleted_at IS NOT NULL ＝ 永久刪除（全站隱藏）。
  //    永久刪除／還原／清空垃圾桶見 §2.19。

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
  // ⚠️ 列表只回遮罩碼（前 4 碼）；全碼取得方式見下方 ?reveal=1

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
| 4 | 暖機期（`created_at` 起 24 小時內上限 `min(quota, 5)`，C2）；`warmup_exempt=1` 者**跳過**此上限（仍受每日配額） | — |
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

### 2.8 階段 2：管理登入的 Access 閘門 ＋ owner 自助改密碼（2026-10-14，docs/16 D2／D7）

```http
POST /api/auth/login                    // ⚠️ 新增前置條件（D2）
Headers: Cf-Access-Jwt-Assertion: <Cloudflare Access JWT>
→ 403 { "error": { "code": "ADMIN_LOGIN_REQUIRES_ACCESS",
                   "message": "管理員登入僅能從 mail.atwho.org 進行" } }
  // 標頭缺失／驗簽失敗／過期／iss 不符／aud 不符 → 一律 403（不區分原因，避免洩漏細節）
  // 通過後才進入既有帳密驗證（既有 401 INVALID_CREDENTIALS／429 LOCKED 行為不變）

PATCH /api/auth/owner-password/self     Authorization: owner session（Bearer JWT）
{ "old_password": "…", "new_password": "…" }
→ 200 { "ok": true }
  // 401 INVALID_OLD_PASSWORD（舊密碼錯，連續 5 次鎖 15 分鐘，與登入共用 auth_attempts）
  // 422 WEAK_PASSWORD（政策：≥8 字元、≤128）
  // 成功後更新 password_changed_at → **所有既有 JWT 立即失效**（下次請求 401 TOKEN_STALE）
  // 稽核：owner_password_changed
  // ⚠️ rescue 路徑 `POST /api/auth/owner-password`（x-admin-token）行為完全不變
```

**環境變數（非機密，放 `vars`）**

| 名稱 | 用途 | 未設定時的行為 |
|---|---|---|
| `ACCESS_TEAM_DOMAIN` | Access 團隊網域（`https://<team>/cdn-cgi/access/certs` 取公鑰，JWKS 快取 10 分鐘） | 驗證失敗 → 403（fail-closed） |
| `ACCESS_MAIL_AUD` | `mail.atwho.org` 應用的 Audience（`aud` 比對；支援字串或陣列） | ⚠️ **過渡放行**：只記 warning 並允許登入（**回退閥門**，移除即恢復舊行為；僅為過渡期設計） |

**新增錯誤碼**

| 碼 | HTTP | 情境 |
|---|---|---|
| `ADMIN_LOGIN_REQUIRES_ACCESS` | 403 | 管理登入未帶有效 Access JWT（或 aud／iss／簽章／期限不符） |
| `INVALID_OLD_PASSWORD` | 401 | owner 自助改密碼時舊密碼錯誤 |

**訪客路徑完全不受影響（N2）**：`/api/auth/register`、`/api/auth/mailbox-login`、`/api/me`、`/api/mail/*` 的認證要求與行為不變。

### 2.9 階段 3／4：管理主控台後端（D4 邀請碼全碼、D5 訪客清單／停權／配額，2026-10-14）

> 前端頁面：`web/src/components/InviteManager.tsx`、`VisitorManager.tsx`（**僅 `mail.` 與 localhost 顯示**；
> `app.` 不顯示 —— 僅 UI 收斂，權限一律由後端判定，docs/16 N3）。

```http
GET /api/invites?reveal=1                 Authorization: owner（訪客 JWT → 403）
→ 200 { "invites": [ { "id", "masked_code", "code": "Xk3…", "max_uses", "used_count",
                       "expires_at", "status", "note", "created_at" } ] }
  // 未帶 reveal → 回應與 §2.7 完全相同（**只新增欄位，不改變既有結構**）
  // 帶 reveal → 額外回傳 code 全碼（供管理頁「複製邀請碼」）
  // 稽核：invite_revealed（owner id ＋ 時間；detail 只記筆數，**不含全碼**，N7）

GET /api/users?role=visitor               Authorization: owner（訪客 JWT → 403；無 session → 401）
→ 200 { "users": [ {
        "id": 2, "username": "friend01", "status": "active"|"suspended", "created_at": 1789…,
        "address": { "id": 12, "email": "friend01@atwho.org", "status": "active"|"disabled"|"deleted",
                     "can_send": 1, "daily_send_quota": 20, "sent_today": 3, "warmup_exempt": 0 },
        "mail_count": 17,                 // 該地址信件數（僅數量）
        "last_activity_at": 1789…         // 最近活動時間（最近一封信；無信 → 帳號 updated_at）
      } ] }
  // ⚠️ N9：**只回數量與時間**，不含主旨／寄件者／內文；owner 不得藉此讀取訪客信件
  // status 為 API 詞彙（DB 端停權存 'disabled'）；一位訪客一列（多地址取第一筆）

PATCH /api/users/:id/quota                Authorization: owner
{ "daily_send_quota": 30, "can_send": true }     // 兩者可單獨提供，至少一個
→ 200 { "ok": true, "user_id": 2, "addresses": 1, "daily_send_quota": 30, "can_send": 1 }
  // daily_send_quota 值域 **1–200**，超出／非整數 → 422 INVALID_QUOTA
  // can_send＝安全閥（C8）：false → 該使用者立即無法寄信（403 SEND_NOT_ALLOWED）
  // 套用到該使用者名下所有未刪除地址；稽核：quota_changed

PATCH /api/users/:id/warmup               Authorization: owner
{ "warmup_exempt": true }                 → 200 { "ok": true, "user_id": 2, "warmup_exempt": 1, "addresses": 1 }
  // 1 = 不受「註冊後 24 小時 5 封」暖機上限（C2），但**仍受 daily_send_quota** 與每小時限流
  // ⚠️ 需 migration 0007；未套用 → 409 MIGRATION_REQUIRED（不假裝成功）
  // 稽核：warmup_changed

PATCH /api/email-addresses/:id/status     Authorization: owner（mailbox → 403）
{ "status": "disabled" | "active" }       → 200 { "ok": true, "id": 12, "email": "friend01@atwho.org", "status": "disabled" }
  // **新增端點**：既有的 PATCH /api/email-addresses/:id 只認「自己名下」地址 → 對訪客地址一律 404
  //   （docs/14 附錄 B.5 待辦 1 的缺口）。本端點不受 user_id 限制（端點本身 requireOwner）
  // 立即生效：disabled → 該地址無法 mailbox-login（403 ADDRESS_DISABLED，§2.10）、
  //   既有 mailbox session 下一次請求即被擋（403 ADDRESS_DISABLED，§2.10 D8-4）
  // 停用 ≠ 刪除（刪除走 DELETE /api/email-addresses/:id）；稽核：address_status_changed
  // ⚠️ 被停用地址的**來信會被丟棄**（不可逆）；帳號停權則來信照收（見 §2.10 對照表）
```

**N9 權限邊界（同步收緊）**：`GET /api/mail/inbox?address_id=<id>` 現在會檢查該地址屬於 owner 本人
（`user_id = scope.userId`），**他人地址（例如訪客的）→ 404**（先前只會回空清單，掩蓋越權嘗試）。
`/api/mail/*` 其餘端點與附件一律維持 session scope（`address_id`／`owner_user_id`）授權，**未放寬**。

**新增錯誤碼**

| 碼 | HTTP | 情境 |
|---|---|---|
| `INVALID_ROLE` | 400 | `GET /api/users` 的 `role` 不是 `visitor` |
| `INVALID_QUOTA` | 422 | `daily_send_quota` 不在 1–200（或非整數） |
| `MIGRATION_REQUIRED` | 409 | 暖機豁免需要 migration 0007（`warmup_exempt` 欄位不存在） |
| `NO_ADDRESS` | 404 | 目標使用者沒有任何未刪除的地址（配額／暖機無處可套用） |

**稽核新增事件**（皆寫入 `registration_audit`，`waitUntil` 非阻塞）：`quota_changed`、`warmup_changed`、
`address_status_changed`、`invite_revealed`（`detail` 一律不含邀請碼全碼／密碼／token，N7）。

**前端文案修正**：側欄「全部信箱」語意為「**你名下**全部地址」（`owner_user_id`），已改為「我的全部信箱」
（docs/16 §3 D5）。

### 2.10 階段 5：停權／停用的語意釐清與立即生效（D8，2026-10-15）

**兩層狀態的語意（實作證據；登入與寄信皆擋，差別在「收信」）**

| | 停權帳號（`users.status != 'active'`） | 停用地址（`email_addresses.status != 'active'`） |
|---|---|---|
| 影響範圍 | 該使用者**全部地址** | **僅該一個地址** |
| 登入 | `403 ACCOUNT_SUSPENDED` | `403 ADDRESS_DISABLED` |
| 寄信 | `403 ACCOUNT_SUSPENDED` | `403 ADDRESS_DISABLED` |
| **收信** | ✅ **照收**（email-handler 只看地址狀態） | ❌ **靜默丟棄該信**（不可逆） |
| 既有 session | 下一個請求即 `403 ACCOUNT_SUSPENDED` | 下一個請求即 `403 ADDRESS_DISABLED` |

```http
POST /api/auth/mailbox-login            // D8-1：**先驗密碼，再判狀態**（順序即判定順序）
{ "email": "friend01@atwho.org", "password": "…" }
→ 401 INVALID_CREDENTIALS  // ① 地址不存在或密碼不符（訊息仍為「地址或密碼錯誤」，不洩漏狀態）
→ 403 ADDRESS_DISABLED     // ② 密碼正確但地址 status='disabled'（「此地址已停用，請聯絡管理者」）
→ 403 ACCOUNT_SUSPENDED    // ③ 密碼正確、地址 active 但使用者 status!='active'（「此帳號已停權，請聯絡管理者」）
→ 200 { "token": "<JWT scope=mailbox>", "session": "mailbox", "address": { … } }
  // ⚠️ 狀態只在**密碼正確**後才揭露 → 未持密碼者無法探測帳號是否存在／被停權
  // ⚠️ 舊版把 status 綁進密碼驗證條件 → 被停用的地址一律誤回 401 INVALID_CREDENTIALS（已修正）
  // 稽核：三種失敗皆寫 `login_failed`，detail.reason 分別為 INVALID_CREDENTIALS／ADDRESS_DISABLED／
  //       ACCOUNT_SUSPENDED；只有**帳密不符**累計 `auth_attempts`（狀態拒絕不計，避免誤鎖合法使用者）
```

**`requireSession` 新增狀態檢查（D8-4）**：驗 session 後，`users.status` 必須為 `active`（否則
`403 ACCOUNT_SUSPENDED`）；mailbox session 另需其地址 `status='active'`（否則 `403 ADDRESS_DISABLED`）。
→ 停權／停用**立刻**踢掉既有 JWT，不必等 24 小時過期。

- 實作：與 `TOKEN_STALE` 的密碼版本檢查**共用同一次索引查詢**（`users.id`／`email_addresses.id` 主鍵；
  mailbox 以一次 JOIN 同時取地址與所屬使用者狀態）→ 每個請求最多一次 SELECT。
- 優先序：`401 TOKEN_STALE`（密碼已變更）先於狀態判定，既有行為不變。
- **不受影響**：`can_send` 語意（寄信權限仍由 `POST /api/mail/send` 判定）、`/api/mail/*` 授權（N9）、
  rescue（`x-admin-token`）通道（N5，不因 owner 停權而失效）。

**新增錯誤碼**

| 碼 | HTTP | 情境 |
|---|---|---|
| `ADDRESS_DISABLED` | 403 | 地址被停用：mailbox-login 密碼正確時，或既有 session 的下一請求 |

### 2.11 前端：停權／停用的文案與二次確認（D8-2／D8-3）

- 按鈕文案（`web/src/lib/statusSemantics.ts` 為單一來源）：
  **「停權帳號（所有地址；仍可收信）」**／**「停用地址（連收信都停止）」**，兩者皆有 `title` tooltip 說明差異。
- 停用地址前顯示二次確認，明寫：「**此地址將立即停止收信，停用期間的來信不會保留**」。

### 2.12 階段 6：刪除訪客（D9）與查不到列的 session 失效（D10，2026-10-15）

```http
DELETE /api/users/:id                      Authorization: owner（訪客 JWT → 403；無 session → 401）
→ 200 { "ok": true, "id": 7, "username": "friend01",
        "deleted": { "addresses": 1, "messages": 17, "attachments": 3, "aliases": 1 } }
  // ⚠️ **僅允許 role='visitor'**：對 owner 帳號（或任何非 visitor 角色）→ 403 FORBIDDEN
  //    另以 findOwnerId 做縱深防禦（即使 role 欄位被誤設，也刪不到管理帳號）
  // 一律以**精準 id** 操作（`= ?` 與「取 id 的子查詢」）；**禁止** LIKE 模糊比對
  // 先 SELECT 確認存在且 role 正確才刪；id 非正整數 → 400 INVALID_ID；不存在 → 404
  // 刪除順序（依 FK，由子到父；單一 `batch` ＝單一交易，任一句失敗即全部回滾 → 500 DELETE_FAILED）
  //   form_responses（本次將刪實例的回覆）→ form_instances（message_id 屬該用戶的訊息，
  //   或 recipient_address_id／sender_address_id 屬該用戶的地址；D16，2026-10-22）
  //   → attachments（透過 messages）→ messages（該地址與該 owner_user_id 的）
  //   → email_aliases（指向該地址）→ email_addresses（該 user 名下，含已軟刪除者）
  //   → users → auth_attempts（該地址的 mailbox 計數 key，逐一字串精準比對）
  // ⚠️ form_templates 可重用 → **絕不刪除**（D16；刪除只清 form_responses／form_instances）
  // R2：上述信件與附件的物件（raw_r2_key／html_r2_key／attachments.r2_key）一併刪除（best-effort；
  //     R2 失敗只記 log，不影響 D1 已完成的刪除——沒有 DB 列就沒有 key，物件已不可達）
  // ⚠️ **不可復原**；只是要暫停請改用 PATCH /api/users/:id/status（停權：可逆、來信照收）
  // ⚠️ **不刪稽核**（不可竄改原則）：registration_audit 既有列一字不動，另寫入 user_deleted
  // 稽核：user_deleted（detail：by＝操作 owner id、username、address、addresses／messages／
  //       attachments／aliases／r2_objects 數量；時間為 created_at；不含任何信件內容，N9）
  // 前端：VisitorManager 每列的「刪除」按鈕（danger 樣式；僅 owner 的管理頁可見）＋二次確認（§2.13）
```

**D10 —— 查不到列的 session 一律失效（`auth.ts`）**

`requireSession`／`requireOwner` 載入 session 目標現況（`loadSessionState`；單一主鍵查詢）後：

| 情況 | 舊行為 | 現行為 |
|---|---|---|
| 查不到列（帳號／地址已被刪除） | `state && …` 短路 → **放行**（`/api/me` 等回 404／空清單）⚠️ | `401 TOKEN_STALE`「session 已失效，請重新登入」✅ |
| `pca` 落後（密碼已變更） | `401 TOKEN_STALE`（訊息含「密碼已變更」） | 不變（**訊息可分辨**兩種原因） |
| rescue（`x-admin-token`） | 豁免 | **不變**（N5；緊急救援不受影響） |

→ 刪除訪客（D9）後，該地址的既有 JWT **下一個請求即失效**；查不到列**不得**變成 500。

**新增錯誤碼**

| 碼 | HTTP | 情境 |
|---|---|---|
| `DELETE_FAILED` | 500 | 刪除交易失敗（已回滾，資料未變更；例如非預期的 FK 參照如 `invites.created_by`）|
| `FORBIDDEN` | 403 | `DELETE /api/users/:id` 的目標不是 `role='visitor'`（保護管理帳號）|
| `TOKEN_STALE` | 401 | 目標列已不存在（D10 新增情境；原本僅密碼變更）|

**失敗路徑已有測試證明（D13，2026-10-15）**

上面兩條「宣稱」原本只有實作、**沒有測試證明**（作者當時的誠實聲明），現由
`packages/api/test/admin-delete-failure.spec.ts` 以**在 binding 邊界注入失敗**的方式釘住
（`docs/16` §6 **T34／T35**；手法見 `docs/11` §2 第 14 項，**production 未改一行**）：

| 注入的失敗 | 期望（＝本節的宣稱） |
|---|---|
| `env.MAIL.delete()` 丟例外 | 仍回 **`200`**（best-effort）：D1 的 user／address／messages／attachments／aliases／auth_attempts **全部照常刪除**，`deleted.r2_objects` **誠實回 `0`**（不假裝成功），`console.error` 留下 `R2 delete failed` |
| `env.DB.batch()` 尾端追加必定失敗的語句（前面的語句真的執行過） | 回 **`500 DELETE_FAILED`**「刪除失敗（已回滾，資料未變更）」，且**資料確實未變更**、**不寫 `user_deleted` 稽核**、不動 R2 物件 |

### 2.13 前端：刪除訪客的按鈕與二次確認（D9）

- `VisitorManager.tsx` 每列新增 **「刪除」**（danger 樣式，`title` tooltip 說明與停權的差別）。
- 二次確認（`Modal`）**逐字**明寫：
  **「將永久刪除該訪客的帳號、地址、所有信件與附件，且無法復原；若只是要暫停，請改用『停權』」**
  （文案單一來源：`web/src/lib/statusSemantics.ts` 的 `USER_DELETE_WARNING`）。
- 成功後重整清單並顯示 toast；失敗顯示後端訊息（例如對 owner 帳號的 `403 FORBIDDEN`）。
- ⚠️ 「僅 owner 可見」由兩層保證：UI（`AppShell` 只在 owner session ＋ `mail.`／localhost 顯示管理主控台）
  ＋後端（端點 `requireOwner`，N3）。

### 2.14 階段 7：地址刪除語意補平（D11，2026-10-15）

**背景**：`DELETE /api/email-addresses/:id` 舊版只做**軟刪除**（`status='deleted'`＋`deleted_at`），
保留信件與 R2、**且不留稽核**；而訪客刪除（D9）是硬刪除＋清 R2＋寫稽核 → 兩者語意不一致。

```http
DELETE /api/email-addresses/:id?mode=soft|hard      Authorization: owner（或 rescue）
```

| mode | 行為 | 回應 |
|---|---|---|
| `soft`（**預設**；未帶＝soft） | 只標記 `status='deleted'`、`deleted_at`；**保留**信件、附件與 R2 物件。同一個 batch 內把**該地址為收件人**的 `open` 表單實例改為 `revoked`（`updated_at` 同步；寄件人可見），submitted 實例／回覆等其餘資料**不動**（D16，2026-10-22） | `204`（無 body，與舊版一致） |
| `hard` | 單一交易內：先清除表單（`form_responses` → `form_instances`；範圍涵蓋該地址的信件所屬實例與 `recipient_address_id`／`sender_address_id` 為該地址的實例；D16）→ 再 soft → 刪除該地址**所有** `messages`（含所有資料夾與垃圾桶）→ `attachments` → 指向該地址的 `email_aliases` → **真正移除 `email_addresses` 該列** → 該地址的 `auth_attempts` 計數 key；之後 best-effort 刪除 R2 物件 | `200 { ok, id, email, mode, previously_deleted, deleted: { messages, attachments, aliases, r2_objects } }`（格式不變；表單清除數量不另回傳） |

**`mode` × 列的狀態（D11-5，2026-10-15）**

| 列的狀態 | `soft`（預設） | `hard` |
|---|---|---|
| 未刪除（`deleted_at IS NULL`） | `204`（標記刪除，信件保留） | `200`（完整清除） |
| **已軟刪除**（垃圾桶，`deleted_at` 非空） | **`404 NOT_FOUND`**（不重複標記、**不改寫原 `deleted_at`**、不寫稽核；絕不 `500`） | **`200`**（升級為永久清除；`previously_deleted: true`） |

- 查詢條件涵蓋 `deleted_at` 非空的列，但**仍嚴格限制 `user_id = 自己` 且該 user `role='owner'`**
  → 他人／訪客的地址（含已軟刪除的）一律 `404`，不因 D11-5 而放寬。
- `hard` 對已軟刪除的列**跳過 soft 更新步驟**（該列本來就會被移除；免得改寫原本的刪除時間）。
- `previously_deleted`：`true` ＝ 這是「從垃圾桶升級」的清除；`false` ＝ 直接永久刪除（新增欄位，既有呼叫端不受影響）。

- **R2 清除範圍**：`messages.raw_r2_key`／`messages.html_r2_key`／`attachments.r2_key`（best-effort；
  失敗只記 log，**不讓已完成的 D1 刪除回報失敗** —— 沒有 DB 列就沒有 key，物件已不可達）。
- **交易性**：D1 部分一律**單一 `batch`**（＝單一交易），任一句失敗即全部回滾 →
  `500 DELETE_FAILED`「刪除失敗／永久刪除失敗（已回滾，資料未變更）」。
  `soft` 的「撤銷 open 實例＋標記地址」、`hard` 的「清除 form 表＋既有清除」都在**同一個 batch**（D16）。
- **表單（D16）**：`form_responses`（`instance_id`／`responder_user_id` 的 FK）必須先於
  `form_instances` 刪除；`form_instances` 又參照 `messages`／`email_addresses`，故必須在兩者之前清除。
  `form_templates` 可重用 → **絕不刪除**（soft 亦同）。修正前此 FK 未涵蓋 → 有表單的地址 `hard` 會
  `500 DELETE_FAILED`（已回滾）。
- ⚠️ **名稱釋放（soft 與 hard 的關鍵差別）**：`email` 與 `(local_part, domain)` 皆為 UNIQUE
  且**不含 `deleted_at`** → 只做 soft 的列**永遠佔住名稱**，重建同名地址會在 `INSERT` 撞 UNIQUE。
  因此 **hard 會真的移除該列**；soft 的行為不變（名稱未釋放）。
  配合此語意，`POST /api/email-addresses` 的重複檢查**不再只看 `deleted_at IS NULL`**：
  同名（含曾被 soft 刪除）一律 `409 ADDRESS_EXISTS`（舊版這種情況會通過檢查、接著撞 UNIQUE 回 **500**）。
- **權限**：`requireOwner`；且**只能操作自己名下**（`user_id = 自己` 且該 user `role='owner'`）的地址，
  他人或**訪客**地址一律 `404`（不洩漏存在性）—— 訪客地址的刪除是訪客管理的職責（§2.12／D9）。
- **稽核（D11-1）**：兩種模式**一律**寫 `address_deleted`（**不得**記錄任何信件內容，N9）：

| 欄位 | 內容 |
|---|---|
| `user_id` / `address_id` | 該地址的 owner 與地址 id |
| `detail.by` | 操作者 owner id（rescue 亦為 owner id） |
| `detail.address` | 被刪地址的 email |
| `detail.mode` | `"soft"` 或 `"hard"` |
| `detail.messages` | **實際刪除**的信件數（soft 一律 `0`） |
| `detail.messages_retained` | 操作後仍留在該地址下的信件數（soft＝N、hard＝`0`） |
| `detail.attachments` / `aliases` / `r2_objects` | 僅 hard 才有（實際刪除數量） |
| `created_at` | 時間 |

**新增／調整錯誤碼**

| 碼 | HTTP | 情境 |
|---|---|---|
| `INVALID_MODE` | 400 | `mode` 不是 `soft`／`hard`（參數被拒時不動任何資料）|
| `INVALID_ID` | 400 | `id` 不是正整數 |
| `DELETE_FAILED` | 500 | D1 刪除交易失敗（已回滾，資料未變更）|
| `ADDRESS_EXISTS` | 409 | 名稱已存在（**含曾被 soft 刪除、名稱尚未釋放**；訊息會提示需先 `mode=hard`）|

**失敗路徑已有測試證明（D13，2026-10-15）**

- **R2 best-effort**：`env.MAIL.delete()` 丟例外時，`?mode=hard` 仍回 **`200`**（`deleted.r2_objects=0`）、
  該列照常移除、**名稱照常釋放**（同名可重建 201）、稽核照寫、log 留下 `R2 delete failed`。
- **交易回滾**：`env.DB.batch()` 失敗時回 **`500 DELETE_FAILED`**「永久刪除失敗（已回滾，資料未變更）」；
  由於 hard 的**第一步 soft 更新就在同一個 batch 內**，測試直接斷言失敗後該列仍為
  `status='active'`、`deleted_at IS NULL` —— 這是「真的回滾」而不是「根本沒執行」的證據。

測試檔：`packages/api/test/admin-delete-failure.spec.ts`（`docs/16` §6 **T34／T35**）；
**production 行為未因此變更一行**（手法見 `docs/11` §2 第 14 項）。

**前端（§AddressManager）**：`GET /api/email-addresses` 每列新增 `messages`（該地址信件總數，
含所有資料夾與垃圾桶；與 hard 實際刪除數量一致），供刪除對話框顯示
「此地址有 N 封信，永久刪除將一併刪除」。

### 2.15 前端：地址刪除的兩個選項與頁面定位說明（D11-3／D11-4）

- `AddressManager.tsx` 的「刪除」→ 二次確認對話框提供**兩個明確選項**（文案單一來源：
  `web/src/lib/statusSemantics.ts`）：

  | 選項 | 文案 | 模式 |
  |---|---|---|
  | ① | **「停用並保留信件」（預設）** | `soft` |
  | ② | **「永久刪除」**（明寫不可復原） | `hard` |

- 對話框同時顯示該地址的信件數：**「此地址有 N 封信，永久刪除將一併刪除」**（`messages`）；
  hard 選項另附警語：**「永久刪除將連同該地址的所有信件與附件、雲端原始檔（R2）一併清除，
  並釋放名稱供重新建立；無法復原。」**
- **D11-4 頁面定位說明**（兩頁各一行，避免「地址管理」與「訪客管理」被誤解為同一件事）：
  - 地址管理：**「地址管理＝你自己的信箱…」**（`ADDRESS_MANAGER_HINT`）
  - 訪客管理：**「訪客管理＝別人用邀請碼註冊的帳號…」**（`VISITOR_MANAGER_HINT`）

### 2.16 階段 7 補完：清除「已軟刪除」的地址（D11-5，2026-10-15）

**背景（D11 完成後的已知限制）**：`DELETE /api/email-addresses/:id` 的查詢條件是 `deleted_at IS NULL`，
所以做過 soft delete 的地址**再也無法**升級為 hard（一律 404、也不在 `GET /api/email-addresses` 清單）
→ 它的信件、附件與 R2 物件，以及被它佔住的**名稱**（同名不可重建）會永遠殘留。

```http
GET    /api/email-addresses?deleted=1         Authorization: owner（或 rescue）
DELETE /api/email-addresses/:id?mode=hard     Authorization: owner（或 rescue；僅自身名下）
```

- **`?deleted=1`**（**新增查詢參數**；未帶參數＝既有行為完全不變、SQL 與回應欄位皆未動）：
  只回**已軟刪除**（`deleted_at` 非空）的列，欄位為
  `id`／`email`／`status`／`has_password`／`created_at`／`updated_at`／**`deleted_at`**／**`messages`**
  （`messages` ＝ 該地址仍保留的信件數，含所有資料夾與垃圾桶，與 `hard` 實際清除數量一致）。
- **`mode=hard` 用在已軟刪除的列**：清除範圍與稽核欄位與「對未刪除的列 hard」**完全相同**
  （含 D16 的 `form_responses` → `form_instances` 清除），
  且會**移除該列以釋放名稱** → 同名可重建（201）。`mode` × 列狀態的完整對照表見 §2.14。
  回應另帶 `previously_deleted: true`（新增欄位，既有呼叫端不受影響）。
- **權限不因 D11-5 放寬**：仍為 `requireOwner` ＋ `user_id = 自己` 且 `role='owner'`
  → 他人／訪客的地址（含已軟刪除的）一律 `404`；訪客 JWT → `403`；無 session → `401`；
  訪客用自己的 JWT 呼叫 → `403`（訪客地址的刪除是 `DELETE /api/users/:id` 的職責，§2.12）。
- **前端（`AddressManager`，僅 owner 可見）**：地址清單下方新增**「已刪除的地址」收合區塊**（預設收合），
  列出 地址／刪除時間／信件數（同一份文案單一來源：`web/src/lib/statusSemantics.ts`）：
  - 區塊說明：`DELETED_ADDRESS_SECTION_HINT`（已停用、來信丟棄、信件與名稱仍在、只能「永久刪除」）
  - 每列「**永久刪除**」→ 二次確認逐字明寫清除範圍與不可復原（`deletedAddressPurgeWarning()`）：
    **「將清除 … 的所有信件與附件（含垃圾桶）與雲端原始檔（R2），並釋放地址名稱；不可復原。」**
    （比 D11-3 的 `addressHardDeleteWarning()` 多強調「**含垃圾桶**」—— 這批地址已經在垃圾桶狀態，
    使用者容易誤以為「已經刪過，不會再刪掉什麼」）
  - ⚠️ 清單載入失敗**只影響這一個區塊**：錯誤顯示在區塊內並提供「重試」，地址清單／建立／密碼
    等既有功能照常運作（**不得讓整頁壞掉**）。

### 2.17 階段 P1：郵件種類、內部直送與寄件者驗證（docs/18，2026-10-21）

> 對象：`POST /api/mail/send`、`GET /api/mail/inbox`、`GET /api/mail/:id`。
> 分類**只由進入路徑決定**，絕不看 `From` 標頭；SPF／DKIM／DMARC **僅供顯示、永不授權**。

**messages 新增欄位（migration 0008）**

| 欄位 | 值域 | 說明 |
|---|---|---|
| `origin` | `external`／`internal` | MX 進信＝external；本地寄送／本地直送＝internal |
| `kind` | `normal`／`interactive_form` | 只有 `POST /api/forms/send` 能產生 `interactive_form` |
| `delivery_scope` | `internal`／`external` | 本地直送＝internal；寄往外網＝external |
| `form_instance_id` | INTEGER／NULL | 互動式表單實例；寄件備份指向該批的**代表實例** |
| `suspicious_form_claim` | 0／1 | 外部信帶表單標記（已丟棄、未啟用） |
| `sender_spf`／`sender_dkim`／`sender_dmarc` | `pass`／`fail`／`none`／`unknown`／NULL | **僅供顯示** |

**`POST /api/mail/send` 的本地直送（P1 行為變更）**

- `to + cc + bcc` **全部**為 `atwho.org`、且每個地址都存在、`status='active'`、未刪除
  → **本地直送**：直接寫入每位收件人的 `messages`（`folder='inbox'`、`origin='internal'`、
  `kind='normal'`、`delivery_scope='internal'`），不呼叫 `EMAIL.send()`。
- 只要含**任一個外部收件人** → 維持既有 `EMAIL.send()` 行為不變。
- 本網域但地址不存在／停用 → 也維持既有 `EMAIL.send()` 行為（零回歸；收信端會靜默丟棄）。
- 配額、`can_send`、暖機、每小時限流、寄件備份、稽核行為全部不變。
- 回應新增 `delivery_scope`：`"internal"`／`"external"`（既有欄位不變）。
- 本地直送會消毒 HTML（與收信端相同的白名單）並為**每位收件人**建立獨立的 raw `.eml`／HTML／附件 R2 物件
  （避免任一人 hard delete 時波及他人）。

**`GET /api/mail/inbox` 每列新增**：`origin`、`kind`、`delivery_scope`。
**`GET /api/mail/:id` 新增**：上述三欄＋`form_instance_id`、`suspicious_form_claim`、
`sender_spf`、`sender_dkim`、`sender_dmarc`。
前端據此顯示三類徽章（外部／內部／互動式）與寄件者驗證（失敗時顯示「⚠️ 驗證失敗」但仍可正常閱讀）。

**收信端（email-handler）**

- MX 進入的信**一律** `origin='external'`、`kind='normal'`、`delivery_scope='external'`。
- 解析 `Authentication-Results`（優先）／`Received-SPF`（SPF 備援）→ 寫入三個顯示欄位。
- 出現 `X-AtWho-Form*` 標頭或 `.atwhoform`／`.atwho-form.json` 附件 → **丟棄標記**、
  `suspicious_form_claim=1`、寫稽核 `claim_blocked`（只記標記種類，不含信件內容），**不啟用任何表單**。

### 2.18 階段 P2：互動式表單（docs/18，2026-10-21）

> ⚠️ **安全門檻**：互動式表單路徑**絕不呼叫 `EMAIL.send()`**；授權只查 DB（`form_instances`）；
> 稽核不含主旨／內文／schema／回覆內容（N9）；表單回覆**不支援附件**。

```http
POST /api/forms/send                       Authorization: owner 或 mailbox
{
  "from": "alice@atwho.org",
  "to": ["bob@atwho.org"],                 // 必填；to+cc+bcc 全部必須是 atwho.org 內部 active 地址
  "cc": [], "bcc": [],
  "subject": "填寫表單",
  "title": "員工調查",                      // 選填；預設=subject
  "description": "請於本週五前填寫",         // 選填；純文字（後端消毒）
  "schema": { "type": "object", "properties": { ... }, "required": [...] },
  "due_at": 1790000000000                  // 選填（epoch ms；NULL=不過期）
}
→ 201 {
  "ok": true, "template_id": 3, "template_key": "<uuid>",
  "message_id": "<uuid@atwho.org>", "sent_message_id": 42,
  "instances": [ { "id": 7, "recipient": "bob@atwho.org" } ]
}
  // 每位收件人：一筆 form_instances ＋ 一筆 messages（origin=internal、kind=interactive_form、
  //   delivery_scope=internal、form_instance_id 關聯）；另建立寄件備份（kind=interactive_form，
  //   form_instance_id 指向代表實例，供寄件人管理 UI 使用）
  // 失敗：422 FORM_RECIPIENT_NOT_INTERNAL／422 FORM_SCHEMA_INVALID／403 FROM_NOT_ALLOWED／
  //       403 ACCOUNT_SUSPENDED／403 SEND_NOT_ALLOWED／429 QUOTA_EXCEEDED／429 RATE_LIMITED
  // 稽核：form_sent（detail 只含 id／數量／欄位數／due_at，不含主旨／地址／schema）

GET /api/forms/:id                         Authorization: 收件人本人
→ 200 { "form": { "id": 7, "message_id": 11, "subject": "...", "status": "open",
                  "due_at": null, "title": "...", "description": "...", "schema": { ... } } }
  // 四道鎖：① messages.kind=interactive_form ② 實例存在＋status='open'＋未過期
  //          ③ 收件人本人：mailbox session 且 address_id == recipient_address_id，
  //             **或** owner JWT session 且該地址的 user_id == scope.userId（D18-1）
  //          ④ origin 與 delivery_scope 皆 internal
  // ⚠️ 任一失敗一律 **404 FORM_NOT_FOUND**（不洩漏存在性）
  // ⚠️ rescue token（x-admin-token，via='rescue'）一律 404；owner 對訪客地址亦 404（不得跨使用者）
  // 稽核：form_viewed（detail.via = mailbox／owner；不含信件內容，N9）

POST /api/forms/:id/responses               Authorization: 收件人本人（同上：mailbox／owner JWT）
{ "payload": { "answer": "..." } }
→ 200 { "ok": true, "instance_id": 7, "status": "submitted" }
  // payload 依 schema 驗證（未知欄位、型別、長度、required、format: date）
  // 409 FORM_ALREADY_SUBMITTED／409 FORM_CLOSED（已撤回）／409 FORM_EXPIRED
  // 422 FORM_INVALID_PAYLOAD；404 FORM_NOT_FOUND（非收件人／不存在／非互動式／rescue）
  // 每實例最多一筆（DB UNIQUE）；稽核：form_submitted（detail.via = mailbox／owner；不含 payload，N9）

GET /api/forms/:id/responses                Authorization: 僅寄件人
→ 200 { "form": { ... }, "instances": [ { "id", "recipient", "status", "due_at",
          "submitted_at", "payload" } ], "responses": [ { "instance_id", "recipient",
          "payload", "submitted_at" } ] }
  // 回傳同一 template_id（同一次寄送）的所有實例；非寄件人 → 403 FORM_NOT_AUTHORIZED
  // 不存在 → 404 FORM_NOT_FOUND

POST /api/forms/:id/revoke                  Authorization: 僅寄件人
→ 200 { "ok": true, "instance_id": 7, "template_id": 3, "revoked": 2 }
  // 撤回同一批所有 open／expired 實例；撤回後收件人 GET 立即 404（前端降為靜態文字）、
  // POST responses → 409 FORM_CLOSED。稽核：form_revoked（只含 id／數量）
```

**Schema 白名單（後端強制；違反 → `FORM_SCHEMA_INVALID`）**

| 允許 | 禁止 |
|---|---|
| `type: object` ＋ `properties` ＋ `required` | `$ref`、`anyOf`、`oneOf`、`allOf`、`not`、`if/then/else` |
| `string`／`number`／`integer`／`boolean`／`array`（僅基本型別 items）| `patternProperties`、`dependencies`、`dependentSchemas`、`propertyNames` |
| `enum`、`title`、`description`（後端＋前端皆消毒）| 巢狀 > 2 層、欄位數 > 40、字串 > 2000 字 |
| `format: date`（僅此 format）| 其他 `format`（含 `data-url`）、`pattern`、未知關鍵字 |

**前端**：`ReadingPane` 在 `kind=interactive_form` 且 `GET /api/forms/:id` 成功時以
**RJSF**（`@rjsf/core` ＋ `@rjsf/validator-ajv8`，自訂 widgets）渲染；任何失敗 → 顯示靜態文字
（不報錯、不洩漏）。**D18-2**：RJSF 經 `FormRendererLazy`（`React.lazy` ＋ `Suspense`）動態載入，
fallback 為「表單載入中…」；首屏 bundle 不含 RJSF（index 682→305 kB／gzip 216→93 kB）。
`ComposeWindow` 提供「互動式表單」模式（收件人只允許 `@atwho.org`，
送出打 `/api/forms/send`）。寄件備份的 ReadingPane 顯示「表單管理」：查看回覆、撤回整批。

**轉寄降級**：對 `kind=interactive_form` 的信按「轉寄」時，只帶 `GET /api/mail/:id/text` 的
**靜態文字版**；不複製 `form_instance_id`、不建立新實例（既有 `DraftMode="forward"` 流程）。

### 2.19 D19：刪除語意修正與複選批次（2026-11-03）

> 起因（docs/19 §1）：`DELETE /api/mail/:id` 曾同時設定 `folder='trash'` 與 `deleted_at=now`；
> 但全站 28 處查詢都帶 `deleted_at IS NULL` → 被「刪除」的信**同時是 trash 又同時被隱藏**，
> 任何資料夾都看不到。現已把 33 筆歷史資料的 `deleted_at` 設回 NULL，且**修正程式**。

**刪除語意（單一定義，全站適用）**

| 狀態 | 條件 | 行為 |
|---|---|---|
| **軟刪除（可還原）** | `folder='trash'` 且 `deleted_at IS NULL` | 垃圾桶可見、可讀信、可 restore；所有列表／詳情查詢照常 |
| **永久刪除（全站隱藏）** | `deleted_at IS NOT NULL` | 所有 `/api/mail/*` 查詢一律看不到（`deleted_at IS NULL`）；只有地址硬刪除流程會用到，不再由信件刪除端點設定 |

> ⚠️ `DELETE /api/mail/:id`（軟刪除）**不得**設定 `deleted_at`。`deleted_at` 一旦寫入，
> 該封信就從垃圾桶、搜尋、計數與詳情全部消失（且無還原端點）。

```http
DELETE /api/mail/:id                       → 204
  // 軟刪除：只設 folder='trash'、updated_at=now；deleted_at 保持 NULL。

DELETE /api/mail/:id?mode=hard             → 200 { "ok": true, "id": 1,
                                                    "messages": 1, "attachments": 2,
                                                    "form_instances": 1, "r2_objects": 4 }
  // 永久刪除（不可復原）。順序固定：
  //   ① 刪 R2：raw_r2_key、html_r2_key、attachments.r2_key（空值略過）
  //   ② 同一個 D1 batch（＝單一交易）依 FK 由子到父：
  //      form_responses（該批訊息的 form_instances 的回覆）→ form_instances
  //      → attachments → messages
  //      （D19-6：`form_instances.message_id` / `form_responses.instance_id` 的 FK；
  //       漏刪子表會讓整塊 batch 以 FOREIGN KEY constraint failed 回滾）
  // ⚠️ R2 刪除失敗 → 500 DELETE_FAILED，且 **D1 完全不變**（與地址刪除的 best-effort 不同）
  // 權限同其他信件端點：不存在／越權 → 404 MAIL_NOT_FOUND
  // 稽核：mail_purged（detail 只有 { id, r2_objects, form_instances }，
  //       不含主旨／寄件者／內文，N9）

POST /api/mail/:id/restore                 → 200 { "ok": true, "id": 1, "folder": "inbox" }
  // 僅 folder='trash' 可還原；其他資料夾 → 400 NOT_IN_TRASH
  // 越權／不存在 → 404 MAIL_NOT_FOUND；稽核：mail_restored（detail 只有 { id }）

POST /api/mail/trash/empty                 → 200 { "count": 12, "r2_objects": 15 }
  // 對 session scope 內所有 folder='trash' AND deleted_at IS NULL 執行 hard delete（同上順序：
  // R2 → form_responses → form_instances → attachments → messages）
  // 一次上限 500 封；超過 → 400 TRASH_TOO_LARGE（請分批處理）。空垃圾桶 → { count: 0, r2_objects: 0 }（不寫稽核）
  // 稽核：trash_emptied（detail 只有 { count, r2_objects, form_instances }，N9）
```

**批次動作（D19-2）**

```http
POST /api/mail/batch                       Authorization: owner 或 mailbox
{ "action": "trash" | "restore" | "read" | "purge", "ids": [1, 2, 3] }
→ 200 { "ok": true, "action": "trash", "count": 3 }

  // action：
  //   trash   → folder='trash'（軟刪除，不動 deleted_at）
  //   restore → folder='inbox'（只對原本在 trash 的列生效）
  //   read    → read_at=now（已讀者保留原 read_at）
  //   purge   → 走 D19-1 的 hard delete 邏輯（R2 → form_responses → form_instances → attachments → messages）
  // ids：1–200 個正整數（重複會去重，count 以唯一 id 計）
  // ⚠️ 每個 id 都必須通過 scopedMessage() 權限檢查；**任一不合格 → 404 MAIL_NOT_FOUND，整批不執行**
  //    （先全部驗證，再執行；不會出現「前面幾封已改、後面才 404」的半套結果）
  // 參數錯誤 → 400 INVALID_BODY／INVALID_ACTION／INVALID_IDS
  // R2／D1 失敗 → 500 DELETE_FAILED（purge）
  // 稽核：mail_batch（detail 只有 { action, count }，N9）
```

**D19-5：D1 綁定參數上限與 id 分塊（2026-11-04）**

> 現象：垃圾桶 131 封時「清空垃圾桶」→ 500 `DELETE_FAILED`；`wrangler tail` 顯示
> `D1_ERROR: too many SQL variables`。根因：**D1 每條查詢最多 100 個綁定參數**，
> `id IN (?,?,…)` 一次綁 131 個即超限（docs/19 §7）。

- **`SQL_CHUNK = 90`**：所有 `id IN (…)` 查詢（SELECT keys／DELETE／UPDATE／scope 驗證）
  一律以 **90 個 id 為一塊**（保留 10 個參數的安全餘裕）。
- **`hardDeleteMessages(env, ids)`**：逐塊 ① SELECT raw／html keys ② SELECT 附件 keys
  ③ `bucket.delete(keys)`（嚴格；失敗即中止該塊）④ 同一個 D1 batch 依 FK 由子到父刪
  `form_responses` → `form_instances` → `attachments` → `messages`（D19-6）。
  - 回傳值為**所有塊的加總** `{messages, attachments, form_instances, r2_objects}`；稽核由呼叫端寫入（N9）。
  - R2 失敗 → **該塊 D1 不動**；已完成的塊**不回滾**（塊與塊之間各自交易）。
  - 失敗時記錄 `chunkIndex`／`count`／已刪數量的錯誤 log。
- **`POST /api/mail/trash/empty`**：以 **id 游標＋分塊**（每塊 ≤90）撈取，迴圈直到撈不到；
  最多收 500 封，出現第 501 封 → 400 `TRASH_TOO_LARGE`（檢查在刪除前，**一封都不刪**）。
  回應 `{count, r2_objects}` 為全部塊的加總。
- **`POST /api/mail/batch`**：`purge` 走同一分塊硬刪；`trash`／`restore`／`read` 的
  `UPDATE … WHERE id IN (…)` 與 `scopedMessageIds` 權限查詢也分塊（≤90）。
  `ids` 的對外上限維持 **200**。
- **部分完成回報**：分塊硬刪中途失敗 → **500 `DELETE_FAILED`**，訊息含
  「部分完成：已刪除 N 封，其餘未變更；可重試」，回應另帶
  `deleted: { messages, attachments, r2_objects }`（失敗前已完成塊的加總；未刪任何信時為 0）。
  完整成功才寫稽核（`trash_emptied`／`mail_batch`，仍只有數量，N9）。
- 錯誤碼不變：`DELETE_FAILED`（500）、`TRASH_TOO_LARGE`（400）；
  `deleted` 為新增的**選填**回應欄位（僅失敗時出現，既有呼叫端不受影響）。

**D19-6：永久刪除先清 form 子表（2026-11-04）**

> 現象：D19-5 修正後清空垃圾桶仍 500；`wrangler tail` 顯示
> `FOREIGN KEY constraint failed`。根因：`form_instances.message_id → messages(id)`、
> `form_responses.instance_id → form_instances(id)`，硬刪只刪 attachments／messages
> → 只要垃圾桶有 1 封互動式表單的信，該塊 batch 就整批 FK 失敗（docs/19 §8）。

- `hardDeleteMessages()` 每個 chunk 的**同一個 D1 batch** 內，順序改為（子 → 父）：
  `form_responses` → `form_instances` → `attachments` → `messages`。
- R2 先刪（嚴格，失敗 → 該塊 DB 不動）與 `SQL_CHUNK = 90` 分塊語意**不變**。
- 回傳值追加 `form_instances`（刪除數量）；`DELETE /api/mail/:id?mode=hard` 回應因此附帶此欄位
  （既有欄位不變）；`trash/empty` 回應維持 `{count, r2_objects}`。
- 稽核 `mail_purged`／`trash_emptied` 的 detail 追加 `form_instances`（只記數量，N9）。
  `mail_batch`（含 purge）格式不變。
- `form_templates` 可重用 → **絕不刪除**（D16）。
- ⚠️ 只影響刪信路徑；D16 的「刪使用者／刪地址」流程未改動。

**前端（`web/src`）**

- 選取狀態以 `Set<number>` 管理；點擊：`shiftKey` → 範圍連選、`ctrlKey`／`metaKey` → 切換單封、
  一般點擊 → 單選並開信；清單聚焦時 `Ctrl/Cmd+A` → 全選。
- 工具列顯示「已選 N 封」：垃圾桶內為「還原／永久刪除」，其他資料夾（含跨資料夾搜尋）為
  「移至垃圾桶／標為已讀」；永久刪除需二次確認。
- 切換資料夾／地址（或搜尋）→ 清空選取；列表為 `role="listbox"`、每列 `role="option"` 並帶
  `aria-selected`，可鍵盤操作。

### 2.20 D19-3：前端補做「清空垃圾桶」與單封操作（2026-11-03）

> 後端端點已於 D19-1 完成；本節只補前端入口與行為（`web/src`），**無 API 變更**。

**清空垃圾桶（`folder='trash'`）**

- 垃圾桶檢視時，批次工具列**即使未選取**也顯示「清空垃圾桶」；其他資料夾／跨資料夾搜尋不顯示。
- 點擊 → 二次確認，文案為「將永久刪除 N 封（含附件與原始檔），無法復原」。
  `N` 取自 `GET /api/mail/counts` 的 `folders.trash.total`（session scope，與端點刪除範圍一致）；
  counts 尚未載入時退回目前清單長度。垃圾桶為空時按鈕停用。
- 確認 → `POST /api/mail/trash/empty`；成功後以 toast 顯示 `{count, r2_objects}` 摘要，
  並重新載入目前清單與資料夾計數（若 ReadingPane 開著垃圾桶內的信件則一併關閉、選取清空）。
- 取消 → **不得呼叫 API**。失敗 → 顯示錯誤訊息，**不清空**目前清單與畫面。

**ReadingPane 單封操作**

- 非垃圾桶：「刪除」（垃圾桶圖示，`aria-label="刪除"`）→ `DELETE /api/mail/:id`（軟刪除）→
  關閉 ReadingPane、從清單移除、更新左側資料夾計數。
- 垃圾桶：顯示「還原」與「永久刪除」文字按鈕。
  - 還原 → `POST /api/mail/:id/restore` → 關閉 ReadingPane、更新清單與計數（信件回 inbox）。
  - 永久刪除 → 二次確認（「將永久刪除『主旨』（含附件與原始檔），無法復原」）→
    `DELETE /api/mail/:id?mode=hard` → 關閉 ReadingPane、更新清單與計數。
- 任一動作失敗 → 顯示錯誤訊息且**不清空畫面**（ReadingPane 與清單保留）。
- 測試：`web/test/mailTrash.dom.spec.tsx`（T75–T78）。

### 2.21 D19-4：每封信列 checkbox（2026-11-03）

> 純前端（`web/src`），**無 API 變更**。目的：讓一般使用者不必知道 Ctrl／Shift 也能複選。

**每列 checkbox（`MessageListItem`）**

- 每一列左側新增 `<input type="checkbox">`，`aria-label="選取信件：<主旨>"`（無主旨時為 `(無主旨)`）。
- 點擊 checkbox **只切換該封的選取**（`stopPropagation()`）→ **不得開啟信件**（不會呼叫 `GET /api/mail/:id`）。
- **一般點擊即切換**（不需要 Ctrl／Cmd）；勾選／取消即時反映「已選 N 封」與批次工具列。
- **Shift＋點 checkbox**：以最近一次點擊（列或 checkbox）為錨點做範圍連選；沿用
  `useMailSelection` 的 `rangeSelection`，不另寫一套。
- 鍵盤：checkbox 為原生控制項，可 Tab 聚焦、Space 切換。
- 已選列視覺：背景 `--purple-soft` ＋ 左側 3px `--purple` 色條（加在整列 `<li>`，checkbox 一併涵蓋）。
- 窄螢幕（≤960px）checkbox 仍顯示（`flex: none`，不得隱藏）。

**表頭全選 checkbox**

- 位於清單表頭 `.list-head`，`aria-label="全選信件"`。
- 全部已選 → `checked`；部分已選 → `indeterminate`（以 ref 設定 DOM 屬性）；未選 → unchecked。
- 點擊：全部已選時**取消全選**，否則**全選**；只作用於目前資料夾／目前已載入的清單（`items`）。
- 清單為空或載入中（`items.length === 0`）→ 停用。

**既有行為保持**

- 切換資料夾／地址／搜尋 → 清空選取（`useMailSelection` 的 `scopeKey`，D19-2 既有邏輯）。
- Ctrl／Cmd+A 全選、一般列點擊開信、Ctrl／Shift 列點擊等 D19-2 行為不變。

- 測試：`web/test/mailCheckbox.dom.spec.tsx`（T79–T83）。

### 2.22 D21：Email 驗證碼註冊（取消邀請碼，2026-11-04）

> 設計：`docs/21`。目標：使用者自助「填真實 Email → 收 6 位數驗證碼 → 註冊」，不再需要 owner 先產生邀請碼。
> 邀請碼機制**完全保留**：`REGISTRATION_MODE=invite`（預設）時行為與本節之前完全相同。

**環境變數（Worker vars；非機密）**

| 名稱 | 值 | 說明 |
|---|---|---|
| `REGISTRATION_MODE` | `invite`（預設，未設定亦同）／`email_verify`／`closed` | 新舊註冊端點的行為開關。非法值一律視為 `invite` |
| `REGISTRATION_DISABLED`（既有） | `true`／其他 | 舊版 kill switch 保留相容；`true` 時新舊流程與 `registration-mode` 一律視為 `closed` |

**`POST /api/auth/register`（既有，公開）— 依模式分流**

| `REGISTRATION_MODE` | 行為 |
|---|---|
| `invite`（預設） | **既有邀請碼流程完全不變**（限流 → `REGISTRATION_DISABLED` → 驗邀請碼 → …） |
| `email_verify` | `403 REGISTRATION_EMAIL_VERIFY_REQUIRED`（請改用驗證碼端點） |
| `closed` | `403 REGISTRATION_CLOSED` |

**`GET /api/auth/registration-mode`（公開）**

```http
→ 200 { "mode": "invite" | "email_verify" | "closed" }
```
只用於前端表單顯示（未取到／舊後端 → 回退 `invite`）；權限與行為仍由後端強制。

**`POST /api/auth/register-request`（公開；僅 `email_verify` 模式）**

```http
{ "email": "me@example.com", "local_part": "friend01" }
→ 200 { "sent": true, "expiresIn": 900 }
```
- 檢查順序：模式 → **IP 限流** → Email 格式 → ID 格式／保留字／既有地址／既有 username → **Email 寄送限制** → 存雜湊 → 寄信。
- 寄件者固定 `noreply@atwho.org`；信件內容**只有 6 位數與 15 分鐘有效說明**，不含 Email、ID 或任何個資。
- 驗證碼：6 位數（`crypto.getRandomValues`）；DB 只存 `SHA-256(code + JWT_SECRET)`；15 分鐘有效；一次性。
- 重寄會讓同一 Email 的**舊碼立即作廢**（舊碼 `consumed_at` 寫入）。
- 錯誤：`EMAIL_INVALID`(400)、`INVALID_LOCAL_PART`(400)、`ID_RESERVED`(409)、`ID_TAKEN`(409)、`CODE_COOLDOWN`(429)、`CODE_DAILY_LIMIT`(429)、`RATE_LIMITED`(429)、`REGISTRATION_CLOSED`(403)、`REGISTRATION_INVITE_ONLY`(403)、`EMAIL_SEND_FAILED`(502)。

**`POST /api/auth/register-verify`（公開；僅 `email_verify` 模式）**

```http
{ "email": "me@example.com", "local_part": "friend01", "code": "123456", "password": "…" }
→ 200 { "token": "<JWT scope=mailbox>", "session": "mailbox",
        "address": { "id": 12, "email": "friend01@atwho.org" } }   // 與 mailbox-login 相同格式
```
- 驗碼順序：過期（15 分）→ 已使用（一次性）→ 錯誤次數（5 次上限）→ 雜湊比對。
- **錯誤 5 次即作廢**：第 5 次起回 `CODE_LOCKED`（429），之後即使輸入正確碼也無效。
- 驗碼通過**才**檢查 ID 是否仍可用；ID 在 request 後被搶走 → 409 且**不消耗**驗證碼。
- 成功後以單一 D1 `batch`（交易）建立 `users(role='visitor')` ＋ `email_addresses(status='active')`；
  `created_at=now` → 既有 **24 小時暖機期／5 封** 自動生效；`daily_send_quota=20`。
- 錯誤：`EMAIL_INVALID`(400)、`INVALID_LOCAL_PART`(400)、`CODE_INVALID`(400)、`CODE_EXPIRED`(400)、`CODE_LOCKED`(429)、`ID_RESERVED`(409)、`ID_TAKEN`(409)、`WEAK_PASSWORD`(422)、`REGISTRATION_CLOSED`(403)、`REGISTRATION_INVITE_ONLY`(403)、`REGISTER_FAILED`(500)。

**速率限制（沿用 `auth_attempts`，固定視窗 UTC）**

| 對象 | 限制 | key |
|---|---|---|
| IP（僅 `register-request`） | **5 次／小時、20 次／日** → `429 RATE_LIMITED` | `register:<ip>`（`updated_at` 跨小時即重置）、`register:<ip>:d:<day>` |
| Email | **60 秒內只能寄 1 封** → `429 CODE_COOLDOWN`；**每日 5 封** → `429 CODE_DAILY_LIMIT` | `register:<email>`（`locked_until`＝下次可寄時間）、`register:<email>:d:<day>` |
| 驗證碼 | 錯誤 5 次 → `429 CODE_LOCKED` | `email_verifications.attempts` |

**稽核（`registration_audit`）**

| event | detail |
|---|---|
| `register_requested` | `{ local_part }` |
| `register_verified` | `{ local_part }`（另含 `user_id`／`address_id`／`ip`／`user_agent`） |
| `register_rejected` | `{ reason, local_part }` |

⚠️ detail **不得**含 Email、驗證碼、密碼或 token（docs/21 §5）。

**Migration**：`migrations/0009_email_verifications.sql`（只新增 `email_verifications` 表與索引；**部署前須先套用**，見 docs/11 §2-17）。

**未包含（依 docs/20）**：DNS 二級網域撞名檢查（`ID_MATCHES_DOMAIN`／建議名稱）——`docs/20` 仍為「設計待審」，
需另建 `domain_checks`／`id_blocklist`；本次僅實作格式／保留字／既有地址／既有 username。

**前端**：`LoginPage` 於 `email_verify` 模式顯示 Email＋想要的 ID（`@atwho.org` 後綴）＋密碼＋確認密碼；
「寄送驗證碼」後顯示 6 位數欄位與 60 秒重寄倒數；成功後以回傳 token 自動登入。
`invite` 模式仍顯示既有邀請碼欄位（向後相容）；`closed` 顯示「目前未開放註冊。」

### 2.23 D22：可分享的註冊／邀請連結（純前端，2026-11-04）

> 設計：`docs/22`。**無 API 變更、無 migration**；只改 `web/`（登入頁與邀請碼管理頁）。

**對外連結格式（`app.atwho.org`）**

| 連結 | 行為 |
|---|---|
| `https://app.atwho.org/?register=1` | 自動切到「註冊」分頁；`email_verify` 模式聚焦 Email 欄 |
| `https://app.atwho.org/?invite=<code>` | 自動切到「註冊」分頁；`invite` 模式預填邀請碼（`email_verify` 模式忽略此值） |
| `https://app.atwho.org/?invite=<code>&register=1` | 兩者並存，同上 |
| `https://app.atwho.org/`（不帶參數） | 行為不變（預設登入頁） |

- 參數**只影響前端顯示與預填**：註冊模式仍由 `GET /api/auth/registration-mode` 決定、邀請碼有效性仍由
  `POST /api/auth/register` 驗證（無效 → `INVITE_INVALID`）——**不得**以 URL 參數判定任何權限（N3）。
- 前端處理後以 `history.replaceState` 移除 `register`／`invite` 參數（保留其他 query、path、hash），
  避免含邀請碼的網址被複製轉傳。
- `REGISTRATION_MODE=closed` 時即使帶 `?register=1`，也只顯示「目前未開放註冊。」提示，不渲染註冊表單。
- 管理端（`mail.atwho.org` 邀請碼管理頁）：
  - 每個邀請碼列提供「複製邀請連結」→ `https://app.atwho.org/?invite=<code>`（需先 `?reveal=1` 取全碼，
    因此同樣寫入稽核 `invite_revealed`）。
  - 建立新邀請碼後以對話框顯示邀請連結＋一鍵複製（不再自動複製全碼）。
  - `email_verify` 模式顯示「一般註冊連結」卡片（`https://app.atwho.org/?register=1`）＋一鍵複製。
  - 複製成功 toast 一律為「已複製連結」。
- 部署：僅需重新 build／deploy 前端（`atwhomail-web`）；API Worker 不需重新部署。

### 2.24 D25：別名 Phase 1（2026-11-05）

> 設計：`docs/25`（owner 已定案範圍 A）。新增 migration `0010_alias_phase1.sql`；
> 後端 API／`email-handler`／前端皆需部署（見 docs/11 §2-18）。
> ⚠️ Phase 2 的**反向別名**（`messages.reply_to`、`reverse_aliases`）**尚未啟用**——
> 欄位已預留但 Phase 1 不寫入。

**命名規則（owner 2026-11-04 定案）**

| 規則 | 值 |
|---|---|
| 使用者輸入 | 3–12 個英文字母（`a–z`／`A–Z`，儲存小寫；不可數字／符號） |
| 保留字 | `admin postmaster abuse root noreply mailerdaemon hostmaster webmaster support` |
| 系統附加 | 3 位流水號（`001`–`999`，不可自選）→ `luke` → `luke001@atwho.org` |
| 別名上限 | 每個帳號 ≤ 50 個；每個名字流水號 ≤ 999 |

**端點**

```http
POST /api/email-aliases        Authorization: Bearer <JWT>
{ "name": "luke", "target_address_id": 12 }

201 { "id": 3, "alias_address": "luke001@atwho.org",
      "target_address_id": 12, "status": "active" }
→ 400 INVALID_ALIAS_NAME（長度／數字／符號／保留字）
→ 403 TARGET_NOT_ALLOWED（目標不在 session scope、非 active 或已刪除）
→ 409 ALIAS_LIMIT_REACHED（帳號已 50 個／該名字流水號已滿）
```

- 流水號以 `alias_names` **原子取得**（`INSERT … ON CONFLICT DO UPDATE … RETURNING`）；
  併發建立同名別名不會拿到重複號碼。`next_serial` 的語意是「下一個可用號碼」，
  建立第一號後為 2（T109）。
- 目標只能是 `email_addresses`（**禁止 alias → alias**）。

```http
GET /api/email-aliases        Authorization: Bearer <JWT>
200 {
  "aliases": [{
    "id": 3, "alias_address": "luke001@atwho.org",
    "target_address_id": 12, "target_email": "alice@atwho.org",
    "status": "active",
    "received_count": 5,            // messages.envelope_to = 此別名 的封數
    "last_received_at": 1788000000000, // 從未收到 → null
    "created_at": ..., "updated_at": ...
  }]
}
```

- owner：名下**全部**地址的別名；mailbox：**只看自己地址**的別名（SQL scope 強制）。
- `received_count`／`last_received_at` 由 `messages.envelope_to` 統計（`idx_messages_envelope_to`）。

```http
PATCH  /api/email-aliases/:id   body: { "status": "active" | "disabled" }
DELETE /api/email-aliases/:id
→ 200 { "ok": true, "id": 3, "alias_address": "...", "status": "disabled" }
→ 404 ALIAS_NOT_FOUND（不存在或不在 scope；不洩漏存在性）
```

- **DELETE 是軟停用**：只設 `status='disabled'`，**不刪資料列**（保留既有信件的
  `envelope_to` 對應與稽核）。
- PATCH／DELETE 皆寫稽核 `alias_updated`；建立寫 `alias_created`。detail 只含
  `{ alias_address, target, status? }`，不含任何信件內容（N9）。

**收信端（`email-handler`）**

```
recipient 查 email_addresses（active）→ 命中：既有流程，envelope_to = NULL
  未命中 → 查 email_aliases（alias_address = recipient）
    active   → messages.address_id = target、envelope_to = 別名
               （origin=external、kind=normal、delivery_scope=external）
    disabled → 550 5.1.1（不建立 messages、不存 R2）
    查無     → 550 5.1.1
```

- 別名信一律 `kind='normal'`，**不可**帶 `form_instance_id`（互動式表單只走內部路徑）。
- 別名 active 但 target 已停用／刪除 → 視為不可投遞，回 550（不寫入不可讀的信箱）。

**回信 From（範圍 A：對外匿名、對內不匿名）**

| 情境 | From |
|---|---|
| 回覆 `envelope_to` 有值的信，且寄件者**非** `@atwho.org` | **別名**（例 `luke001@atwho.org`） |
| 回覆 `@atwho.org` 內部寄件者 | 別名的 target **真實地址** |
| 手動改 From | 限自己名下（地址或別名） |

- `/api/mail/send` 的 From 驗證已擴充：接受 active 別名（target 屬於 session scope）。
- 配額一律計入 target 地址；稽核 `mail_sent.detail.via_alias`（布林）。
- Phase 1 **不支援**以別名主動寄新信（只允許回覆流程自動帶入）；一次性別名／轉寄外部亦不做。

**Migration 與部署**

- `migrations/0010_alias_phase1.sql`：只新增 `alias_names`、`messages.envelope_to`、
  `messages.reply_to`（Phase 2 預留）、`idx_messages_envelope_to`。
- 部署順序：**先套 migration → 再部署 API／email-handler／前端**（未套 migration 時
  別名端點與別名收信會因缺欄位失敗）。

**測試**：T109–T118（`packages/api/test/alias.spec.ts`、`packages/email-handler/test/email-handler.spec.ts`、
`web/test/alias.spec.ts`、`web/test/aliasManager.dom.spec.tsx`）。
⚠️ 規格矛盾已回報：docs/25 §3.1 的 SQL 會讓 `alias_names.next_serial` 停在 1，與 T109
（應為 2）衝突；實作以 T109 與欄位語意（下一個可用號碼）為準，且別名地址含 `@atwho.org`
（規格範例僅寫 local part）。

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
