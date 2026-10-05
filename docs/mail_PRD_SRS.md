下面這份可以直接丟給 Claude Agent，目標是讓它依照我們前面定案的架構去規劃與實作。

我要開發一套「大量虛擬 Email Address + 自有 App 收發信」系統，請依照以下架構規劃並實作 MVP。

> **2026-09 查證更新**：Cloudflare 已於 2026 年推出整合的 **Email Service**（收信 = Email Routing，寄信 = Email Sending）。本文架構不變，但寄信（§九）、成本（§十六）、規模（§十七）已按官方現況修正。實作寄信時以 Workers `send_email` binding 為主路徑。

## 一、核心目標

我已經有自己的 Domain Name，DNS 由 Cloudflare 管理。

我不需要 Outlook、IMAP、POP3，也不需要傳統 Mail Server。

我要讓使用者可以在我自己的 App 裡：

* 建立 Virtual Email Address
* 修改 Virtual Email Address
* Disable / Enable Virtual Email Address
* Delete Virtual Email Address
* 收 Internet 寄來的 Email
* 查看 Inbox
* 查看 Email Body
* 查看 / 下載 Attachment
* 寄 Email 到 Internet
* 一個 User 可以擁有多個 Email Address
* 未來需要支援大量 Virtual Email Address

例如：

[alice@mydomain.com](mailto:alice@mydomain.com)
[bob@mydomain.com](mailto:bob@mydomain.com)
[sales@mydomain.com](mailto:sales@mydomain.com)
[customer001@mydomain.com](mailto:customer001@mydomain.com)

不要為每個 Email Address 建立一條 Cloudflare Routing Rule。

Cloudflare 只建立一條 Catch-all：

*@mydomain.com
→ Cloudflare Email Worker

Virtual Email Address 的 Create / Delete / Modify / Disable 全部由 Database 管理。

---

## 二、正式 Production 架構

使用 Cloudflare Native 架構：

Cloudflare Email Routing
→ Catch-all
→ Email Worker
→ D1 + R2

（註：官方現況為 Cloudflare Email Service 產品，收信功能仍稱為 Email Routing。）

其中：

### D1

D1 是 Production 的主要 SQL Database / Source of Truth。

主要儲存：

* users
* virtual email addresses
* aliases
* messages metadata
* attachment metadata
* mailbox ownership
* read/unread
* status
* timestamps
* sync / backup metadata

### R2

R2 儲存大型 Object：

* 原始 .eml
* Email raw MIME
* HTML body（必要時）
* PDF
* JPG
* PNG
* ZIP
* Excel
* 其他附件

原則：

D1 = metadata / index

R2 = mail content / large object / attachment

---

## 三、Email Receiving Flow

Incoming Email：

Internet
→ Cloudflare MX
→ Email Routing
→ Catch-all
→ Email Worker

例如收到：

To: [alice@mydomain.com](mailto:alice@mydomain.com)

Worker 必須：

1. normalize recipient
2. 查詢 D1 email_addresses
3. 確認 address 是否存在
4. 確認 status == active
5. 不存在則 reject
6. 將 raw email 以 streaming 方式直接寫入 R2（Email Worker 有 CPU / 記憶體限制，勿把整封信讀入記憶體；Workers Free plan 上複雜 handler 可能 EXCEEDED_CPU，上量建議 Workers Paid）
7. Parse MIME（使用 streaming：將 message.raw 直接寫入 R2 後，只 parse headers / metadata）
8. 將 message metadata 存 D1
9. 將 attachment 存 R2
10. attachment metadata 存 D1
11. message 關聯到正確 user_id

請使用適合 Cloudflare Workers 的 MIME parser，例如 postal-mime，或提出更合適的方案。

---

## 四、Virtual Email Address 管理

不要呼叫 Cloudflare API 來建立每一個 email routing rule。

Cloudflare 永遠只有：

*@mydomain.com
→ Email Worker

Virtual Email Address 建議 schema：

email_addresses

* id
* user_id
* local_part
* domain
* email
* status
* created_at
* updated_at
* deleted_at

email 應有 UNIQUE constraint。

例如：

user_id = 101

可以擁有：

[john@mydomain.com](mailto:john@mydomain.com)
[johnny@mydomain.com](mailto:johnny@mydomain.com)
[sales01@mydomain.com](mailto:sales01@mydomain.com)

Create：

POST /api/email-addresses

Modify：

PATCH /api/email-addresses/:id

Disable：

PATCH status=disabled

Enable：

PATCH status=active

Delete：

優先使用 soft delete，而不是直接 physical delete。

status 建議至少：

active
disabled
deleted

---

## 五、Alias

需要設計 email_aliases。

例如：

[john@mydomain.com](mailto:john@mydomain.com)
→ [johnny@mydomain.com](mailto:johnny@mydomain.com)

Schema 建議：

email_aliases

* id
* alias_address
* target_email_address_id
* status
* created_at
* updated_at

Worker 收到 email 時：

recipient
→ 查 email_addresses
→ 若不存在則查 alias
→ resolve target
→ 找到 owner user_id
→ deliver

要避免 alias loop。

---

## 六、Users

Email Address 不要直接當 User Account。

Users 與 Email Addresses 分開。

users

* id
* username
* display_name
* password_hash 或其他 auth identity
* status
* created_at
* updated_at

關係：

User 1
→ N Email Addresses

### Model C 補充決策（2026-09-02）

採用 Model C：**每個 email_address 本身可以是獨立登入的「信箱帳號」**。

* `email_addresses` 增加 `password_hash`：有密碼的地址可獨立登入（`alice@atwho.org` + 密碼）
* 信箱帳號登入後，只能管理「該地址的信箱」：inbox / sent / trash / 附件 / 寄信 From 限定該地址
* `users` 保留為「擁有者 / 管理者」：可建立地址、停用、重設地址密碼、以 owner 視角聚合查看名下信件
* 信件歸屬以 `address_id` 為主（寄到哪個地址 = 屬於哪個信箱）；`owner_user_id` 保留供 owner 聚合與備份
* 密碼為 NULL 的地址 = 不可直接登入，只能由 owner 管理

---

## 七、Messages

messages table 建議：

* id
* owner_user_id
* message_id
* from_address
* to_address
* cc
* subject
* text_preview
* received_at
* read_at
* status
* raw_r2_key
* html_r2_key
* created_at

需要考慮：

Inbox
Read / Unread
Archive
Deleted / Trash
Spam
Sent（寄出追蹤建議加 send_status：queued / sent / bounced / failed，收到退信時自動更新）

不要把大型郵件內容全部塞 D1。

---

## 八、Attachments

attachments table：

* id
* message_id
* filename
* content_type
* size
* r2_key
* created_at

Binary file 放 R2。

---

## 九、寄信

我的 App 要能寄 Email 到 Internet。

流程：

App
→ Backend / Worker API
→ 驗證 User
→ 驗證 From Address ownership
→ Cloudflare Email Sending
→ Internet

（註：官方寄信產品 = Email Service 的 Email Sending，Workers 內用 `send_email` binding 呼叫）

例如：

User 101 想寄：

From:
[john@mydomain.com](mailto:john@mydomain.com)

Worker 必須先確認：

[john@mydomain.com](mailto:john@mydomain.com)
真的屬於 user_id = 101

如果不是：

403 Forbidden

避免使用者偽造：

[admin@mydomain.com](mailto:admin@mydomain.com)
[ceo@mydomain.com](mailto:ceo@mydomain.com)

需要設計：

POST /api/mail/send

並使用 Workers `send_email` binding（或 REST API / SMTP）。

### 寄信前置條件（官方限制，務必納入設計）

* **Workers Paid plan**：寄信給任意 Internet 收件人僅限 Workers Paid；Workers Free 只能寄給帳號內 verified destination addresses（可作為開發期免費測試管道）
* **Sending domain onboarding**：寄出前 domain 必須完成寄送設定（Cloudflare 自動建立 SPF / DKIM / MTA-STS / bounce MX DNS records）；只能從已設定的 routing domains 寄出
* **單封上限 5 MiB**（含附件），超過會收到 `552 5.3.4 Message too big`
* **單封最多 50 個收件人**（to + cc + bcc 合計）
* **每日寄信配額**：新帳號從保守值開始，隨送達率與信譽自動調升；需要大量寄送時向 Cloudflare 申請調升

### 退信 / Bounce 處理

寄出的信 hard bounce 時，Cloudflare 會經由其 bounce MX 接收退信；由於本系統是 catch-all，退信（NDR）會以一般信件形式回到寄件者的虛擬地址 inbox。需要設計：

* 辨識 NDR（Content-Type: multipart/report、信封 Return-Path 特徵）→ 自動將對應的 sent message 標記為 bounced
* 善用 Cloudflare suppression list 機制，避免重複寄送給已 hard bounce 的地址
* 應用層避免把退信再轉寄（防止 NDR loop）

---

## 十、App API

至少需要：

### Email Address

POST /api/email-addresses

GET /api/email-addresses

GET /api/email-addresses/:id

PATCH /api/email-addresses/:id

DELETE /api/email-addresses/:id

### Inbox

GET /api/mail/inbox

GET /api/mail/:id

PATCH /api/mail/:id/read

PATCH /api/mail/:id/archive

DELETE /api/mail/:id

### Attachment

GET /api/mail/:messageId/attachments

GET /api/attachments/:id

### Send

POST /api/mail/send

### Alias

POST /api/email-aliases

PATCH /api/email-aliases/:id

DELETE /api/email-aliases/:id

---

## 十一、Security

請特別設計：

* Authentication
* Authorization
* User ownership checking
* From address spoof protection
* SQL injection protection
* MIME attack protection
* malicious attachment handling
* path traversal protection
* attachment filename sanitization
* XSS protection
* HTML email sanitization
* rate limiting
* sending abuse prevention
* spam prevention
* logging
* audit log

HTML Email 不可以直接把外部 HTML 無條件 render。

需要 sanitization。

---

## 十二、Backup Architecture

Production：

Cloudflare D1
+
Cloudflare R2

是 Source of Truth。

我自己的電腦會跑：

PostgreSQL
+
Local Mail Archive

但它只做 Backup / Disaster Recovery。

不要設計成：

D1 ↔ PostgreSQL

雙向 Master。

要設計成：

D1
→ PostgreSQL

R2
→ Local File Storage

單向備份。

本地 PostgreSQL 不可以影響 Production 收信。

即使我的本地電腦：

* 關機
* 斷網
* PostgreSQL 掛掉

Cloudflare Production 仍然必須正常：

* 收信
* 寄信
* Create address
* Delete address
* Inbox

---

## 十三、Backup Flow

建議：

Cloudflare
D1 + R2
↓
Backup API / Backup Job
↓
Home PC
↓
PostgreSQL + Local Disk

例如：

Local:

/mail-backup/
2026/
09/
10/

PostgreSQL 儲存：

* message metadata
* user
* email address
* aliases
* attachment metadata
* R2 key
* local file path
* backup timestamp

需要 Incremental Backup。

不要每次重新下載所有資料。

建議利用：

updated_at
sequence
cursor
backup_status

設計：

GET /api/backup/changes?cursor=xxxxx

回傳：

{
"nextCursor": "...",
"created": [],
"updated": [],
"deleted": []
}

---

## 十四、R2 Backup

R2 object 需要同步到本地磁碟：

raw email：

mail/YYYY/MM/message-id.eml

attachments：

attachments/message-id/filename

本地需記錄：

R2 key
ETag / checksum
size
backup time

只有變更或尚未備份的 object 才下載。

需要 checksum 驗證避免 backup corruption。

---

## 十五、Disaster Recovery

請另外設計 Restore 流程。

情況：

D1 被誤刪
R2 被誤刪
Cloudflare account 發生問題
程式 Bug 刪除資料

需要能從：

PostgreSQL
+
Local Mail Archive

恢復。

但 Restore 不要自動執行。

必須是 Administrator 主動操作。

---

## 十六、成本原則

目標：

極省錢。

優先使用：

Cloudflare Email Routing
Cloudflare Workers
Cloudflare D1
Cloudflare R2
Cloudflare Email Sending

不要使用：

Postfix
Dovecot
OpenDKIM
VPS
ngrok mail tunnel
IMAP
POP3

除非有明確技術理由。

### 計價現況（2026-09 查證 Cloudflare 官方）

| 項目 | 方案 | 計價 |
|---|---|---|
| 收信 Email Routing | Workers Free / Paid | 免費、無限 |
| 寄信 Email Sending | **僅 Workers Paid** | Workers Paid $5/月，內含 3,000 封/月；超出 $0.35 / 1,000 封 |
| D1 | Free | 5 GB 儲存、100k writes/day（信件量大會先撞牆） |
| D1 | Paid | 依用量計費（$5/月 起） |
| R2 | Free | 10 GB 儲存 + 每月免費操作額度 |
| Email Worker | Free | CPU / 記憶體限制嚴格（複雜 MIME handler 可能 EXCEEDED_CPU） |

結論：個人 / 中小規模最低成本 ≈ Workers Paid $5/月（解鎖寄信）＋ D1/R2 免費額度內。符合「極省錢」，但不是全免費——開發期可先留 Workers Free，用 verified destination addresses 免費測試寄信流程，正式開放寄信前再升 Paid。

---

## 十七、Scale

架構要預留：

100 users

1,000 users

10,000 users

甚至：

100,000 Virtual Email Addresses

但第一版不要過度工程化。

尤其不要：

# 100,000 Email Addresses

100,000 Cloudflare Routing Rules

應該始終使用：

*@mydomain.com
→ Catch-all Worker
→ D1 lookup

規模注意事項：

* 10 萬筆 email_addresses + messages metadata 在 D1 都只是小型 row，儲存沒有問題
* 但 D1 Free 的寫入額度（100k writes/day）會在信件量大時先撞牆（一封含多個附件的信 = 多筆 D1 寫入）→ 上量前切換 D1 Paid
* Inbox 全文搜尋：D1（SQLite）無全文檢索，MVP 用 LIKE 即可；進階搜尋之後再評估外部索引

---

## 十八、技術偏好

Backend：

Cloudflare Workers
TypeScript

Database：

Cloudflare D1

Storage：

Cloudflare R2

Incoming mail：

Cloudflare Email Routing + Email Worker

Outgoing mail：

Cloudflare Email Service — Email Sending（Workers `send_email` binding 為主，REST API 為輔）

Local Backup：

PostgreSQL
+
Local filesystem

Frontend 之後會使用 React / PWA。

請讓 Backend API 適合 React 使用。

---

## 十九、請分階段實作

不要一次產生大量無法驗證的程式。

請按照以下階段：

Phase 1
Architecture + Folder Structure

Phase 2
Cloudflare Wrangler project setup

Phase 3
D1 schema + migrations

Phase 4
R2 configuration

Phase 5
Email Routing Catch-all Worker

Phase 6
MIME parsing + storage

Phase 7
Virtual Email Address CRUD API

Phase 8
Inbox API

Phase 9
Mail detail + attachment API

Phase 10
Outgoing Email API（前置：升級 Workers Paid + sending domain onboarding；開發期可先用 verified destination addresses 驗證寄信）

Phase 11
Authentication / Authorization

Phase 12
Local PostgreSQL Backup Agent

Phase 13
Incremental D1 backup

Phase 14
Incremental R2 backup

Phase 15
Restore procedure

Phase 16
Testing

每完成一個 Phase：

1. 說明建立了哪些檔案
2. 說明每個檔案用途
3. 提供完整可執行程式
4. 提供 command
5. 提供測試方式
6. 確認前一階段可運作後，再進下一階段

---

## 二十、第一步請先輸出

目前先不要一次完成全部程式。

先給我：

1. 最終 Architecture Diagram
2. Production Data Flow
3. Incoming Email Flow
4. Outgoing Email Flow
5. Backup Flow
6. Disaster Recovery Flow
7. Database ER Diagram
8. D1 Tables
9. R2 Object Key Design
10. REST API List
11. Project Folder Structure
12. Cloudflare Resources 清單
13. Security Checklist
14. MVP Implementation Order
15. 哪些部分可以免費，哪些部分可能產生 Cloudflare 費用

架構確認後，再開始 Phase 2 寫程式。

設計原則：

Cloudflare = Production
D1 = Production Metadata Source of Truth
R2 = Production Mail/Object Storage
PostgreSQL = Backup Database
Local Disk = Backup Mail/Object Storage

不要做 D1 與 PostgreSQL 雙向同步。

這份 prompt 已經把「大量虛擬地址、Cloudflare Catch-all、D1/R2、寄信、Backend 備份、PostgreSQL 災難復原」都固定下來，可以避免 Claude Agent 又把架構帶回 Postfix/Dovecot。

如果要真的開始寫程式，我建議第一輪就用上面最後的「**先只做 Architecture，不直接 Coding**」，確認架構後再讓 Agent 逐 Phase 建專案，會比較不容易失控。
