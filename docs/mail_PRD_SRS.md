---
title: 100,000 Email Addresses
status: 需求
updated: 2026-11-10
read-when: 要判斷「這功能該不該做／是否偏離原始設計」時；§零 只有指標，現況看 docs/31-handoff.md
---

下面這份可以直接丟給 Claude Agent，目標是讓它依照我們前面定案的架構去規劃與實作。

我要開發一套「大量虛擬 Email Address + 自有 App 收發信」系統，請依照以下架構規劃並實作 MVP。

> **2026-09 查證更新**：Cloudflare 已於 2026 年推出整合的 **Email Service**（收信 = Email Routing，寄信 = Email Sending）。本文架構不變，但寄信（§九）、成本（§十六）、規模（§十七）已按官方現況修正。實作寄信時以 Workers `send_email` binding 為主路徑。

---

## 零、需求原文摘要與決策對照（2026-11-04 補寫；**2026-11-13 重整：現況與文件清單已移出**）

> 原 PRD/SRS 撰寫於 2026-09。實作過程中的**決策變更與新增功能**集中記錄在本節，避免與 §一–§二十 原文衝突（原文保留作歷史依據）。

### 0.1 現況摘要（完整現況不在本檔）

- 原 MVP（Phase 1–16）＋ **D1–D38** 幾乎全數上線；逐項狀態、部署版本、待辦一律以 **`docs/31-handoff.md`** 為準。
- 本檔**只保留需求原文（§一–§二十）＋ §0.2 決策對照**；功能清單、端點、版本號不再在此重複。
- 需要「現在實際長怎樣」→ `docs/31-handoff.md`；需要「有哪些文件、該讀哪份」→ `docs/INDEX.md`。

### 0.2 與原文不同的決策（原文照留，以本節為準）

| 項目 | 原文寫法 | 目前實況 |
|---|---|---|
| 註冊方式 | 邀請碼制 | **Email 驗證碼**（D21）；`REGISTRATION_MODE` 可一行切回 `invite` |
| 入口 | 單一入口 | **mail.atwho.org**（Cloudflare Access，owner-only）＋ **app.atwho.org**（公開訪客）|
| 管理員登入 | 帳號密碼 | 需 **Cloudflare Access JWT**（`/api/auth/login` 強制驗證）|
| 帳號模型 | Model C | ✅ 已實作（地址可獨立登入）；另加 `users.role = owner / visitor` |
| 寄信配額 | 未訂 | 每日 **50**（D33）／每小時 **10**／暖機 24h 預設 **20 封**（D35 可調 1–50）；`warmup_exempt` 可豁免 |
| 信件刪除 | 未訂 | `folder='trash'`＝**軟刪除（可還原）**；`deleted_at`＝**永久刪除（全站隱藏）** |
| 郵件分類 | 未訂 | `origin`(external/internal)＋`kind`(normal/interactive_form)＋`delivery_scope`＋`suspicious_form_claim` |
| MTA-STS | 未提 | **enforce**（自建 worker）；TLS-RPT 收件人 `tlsrpt@atwho.org` |
| DMARC | 未提 | ✅ **`p=quarantine`（2026-11-09 由 `p=none` 升級）**＋`rua=…@dmarc-reports.cloudflare.net`；回退＝改回 `p=none` |
| 備份 | 5 表 | **13 表**（D17）＋ watchdog 去抖 ＋ 重試退避 |
| 別名 | 僅 schema 建議 | ✅ **D25 已上線**：使用者自訂 3–12 字母＋系統 3 碼流水號；收信投遞、回外信自動用別名、停用回 550（**僅對外匿名**）|
| 登入方式 | 僅帳密 | ✅ **四種並存**（Google OAuth／Email 驗證碼註冊／信箱＋密碼／管理員 Access）——見 §二十一 |
| **備用電子郵件** | 未提 | ✅ `users.contact_email`，用途＝**找回密碼**；個人設置頁顯示（原「登入方式」已改名）|
| OAuth 首登 | 未提 | ✅ **免驗證碼**（Google 已驗）；**自動建 visitor 帳號＋配發地址**（撞二級網域→加 3 碼）；配額 **50 封/日**（D33 統一） |
| 跨 App 共用登入 | 未提 | ✅ **D26**：`https://auth.atwho.org` 薄代理 ＋ `app_clients`／一次性 code 交換（`scope='app'` 不能碰信件 API）|
| 網域收斂 | 未提 | ✅ **D29**：`app.`（公開）隱藏地址管理／我的全部信箱／管理主控台；`mail.`（管理）全開 |
| 個人設置 | 未提 | ✅ **D29**：ID／角色／信箱地址／**備用電子郵件**／密碼／**內嵌別名管理**／配額 |
| 防機器人 | 未提 | ✅ **D23 Turnstile**（widget `atwho-entry`；未設金鑰自動跳過）|

### 0.3 文件導航

文件清單與「什麼時候該讀哪一份」已由各檔 front-matter **自動產生**在 **`docs/INDEX.md`**（勿手改）。
本節不再維護清單，避免與 INDEX 不同步；重新產生：`node scripts/docs-index.mjs`。

---

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

## 五、Alias（別名）與反向別名（Reverse Alias）

> **2026-11-04 更新**：實作設計與風險評估見 `docs/24-alias-reverse-alias-eval.md`。
> **核心規則（owner 決定 2026-11-04）**：**只有寄往 `atwho.org` 以外才需要匿名**；**同域（`@atwho.org` ↔ `@atwho.org`）不需要匿名**。
> 現況：`email_aliases` 表**已存在（0001 migration）但無任何功能**（`email-handler` 未實作、無 CRUD API／UI、無反向別名）。

### 5.1 收信：別名 → 目標地址

```
外部寄件者 → xyz123@atwho.org（別名）
  → Cloudflare MX → email-handler
  → recipient 查 email_addresses？
       是 → 一般投遞（既有流程）
       否 → 查 email_aliases（alias_address = recipient AND status='active'）
              有 → resolve target_email_address_id → 本地直送（不轉寄外部 SMTP）
              無 → 550 5.1.1（信箱不存在）
```

* 別名**停用**時來信回 `550 5.1.1`（避免 backscatter，與 SimpleLogin 一致）
* **禁止 alias → alias**（`target_email_address_id` 只能指向 `email_addresses`），避免 loop
* 新增 `messages.envelope_to`：記錄「原本寄給哪個別名」，UI 顯示徽章（可判斷來源別名）
* 原始 `From` 保留；SPF/DKIM/DMARC 僅**顯示**不授權（同 §十一）

### 5.2 回信：反向別名（**僅外部寄件者**）

| 情境 | 回信 From | 需要反向別名？ |
|---|---|---|
| **外部**寄件者 → 別名 → 你 | 別名 | ✅ 需要 |
| **內部** `@atwho.org` 寄件者 → 你的地址／別名 | 你的真實地址 | ❌ **不需要**（同域，無匿名需求） |

```
① 外部信投遞到別名時：
   reverse_aliases(alias_id, sender_email) → token = 32 bytes random → ra-<token>@atwho.org
   寫入 messages.reply_to = ra-<token>@atwho.org
② 使用者按「回覆」→ 客戶端寄到 ra-<token>@atwho.org
③ POST /api/mail/send 偵測收件人為反向別名：
     From      = 別名（xyz123@atwho.org）
     To        = 原始寄件者
     Reply-To  = ra-<token>@atwho.org（對方再回仍走別名）
④ EMAIL.send()（Cloudflare 對 atwho.org 簽 DKIM ✅）
```

**內部信件**：直接以真實地址回覆，**不產生反向別名**（省一個查詢、也避免不必要的改寫）

### 5.3 Schema

```sql
-- 已存在（0001）
email_aliases(id, alias_address UNIQUE, target_email_address_id, status, created_at, updated_at)

-- 新增（待實作）
CREATE TABLE reverse_aliases (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  alias_id     INTEGER NOT NULL REFERENCES email_aliases(id),
  sender_email TEXT NOT NULL,
  token        TEXT NOT NULL UNIQUE,      -- 32 bytes hex
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  UNIQUE(alias_id, sender_email)
);

-- messages 新增欄位
ALTER TABLE messages ADD COLUMN envelope_to TEXT;  -- 別名
ALTER TABLE messages ADD COLUMN reply_to    TEXT;  -- 反向別名（僅外部）
```

### 5.4 別名命名規則（owner 2026-11-04 定案）

| 規則 | 值 |
|---|---|
| 使用者輸入的名字 | **3–12 個英文字母**（`a–z`，儲存一律小寫）|
| 數字 | ❌ 不可（保留給流水號，避免 `luke2` vs `luke002` 混淆）|
| 特殊字元 | ❌ 不可（`- _ . +`、空白）|
| 保留字 | `admin`／`postmaster`／`abuse`／`root`／`noreply`／`mailerdaemon`／`hostmaster`／`webmaster`／`support` |
| 系統附加 | **固定 `0` ＋ 3 位流水號**（`001`–`999`），由系統分配、不可自選 |
| 別名總長 | ≤ **16** 字元 |
| 範例 | `luke` → `luke001@atwho.org`；同名的第二人 → `luke002@atwho.org` |

實作規格：`docs/25-alias-phase1.md`（D25）。

### 5.5 限制與配套（D31 更新）

* **每帳號最多 1 個「啟用中」的暱稱別名**；變更時舊的立即停用（來信回 550），同一交易完成
* **每個真實地址 1 個隱身代號（Token）**（一般帳號只有 1 個地址 → 1 個）：建立帳號／地址時自動產生（16 hex），不隨暱稱變更，由系統管理（不可停用／刪除）
* 以別名寄信**計入目標地址**的每日（50）／每小時（10）／暖機（24h，預設 20 封、D35 可調）配額
* 反向別名 token **不可枚舉**（256-bit）；每個 (別名, 寄件者) 只有一個 token
* 別名被騷擾 → **單獨停用該別名**，不影響真實地址

### 5.6 三種寄信身分（D31，owner 2026-11-06 定案）

| 模式 | 地址 | 對方看到 | 規則 |
|---|---|---|---|
| **真實 ID** | `itag@atwho.org` | 真實地址 | 固定，不在撰寫視窗切換 |
| **暱稱** | `luke001@atwho.org` | 暱稱別名 | 每帳號 1 個，可變更（舊的立即停用） |
| **Token（UI：隱身代號）** | `0123456789abcdef@atwho.org` | 隨機 Token | 帳號建立時自動產生，不隨暱稱變更；對方仍可回信 |

- 撰寫視窗以「真實 ID／暱稱／隱身代號」三種模式選擇；互動式表單僅限真實 ID ✅
- 回信給外部寄件者時仍自動使用原信收到的別名（暱稱或 Token）✅

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
* **Sending domain onboarding**：寄出前 domain 必須完成寄送設定（Cloudflare 自動建立 SPF / DKIM / bounce MX records 於 `cf-bounce` 子網域；DMARC 亦由 CF 提供）。**MTA-STS 的訊號記錄需自行建立**（`_mta-sts` CNAME → `_mta-sts.mx.cloudflare.net`，Proxy OFF）並自行提供政策檔，官方不代為設定，見 `07-cloudflare-resources.md` Step 6。只能從已設定的 routing domains 寄出
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

**現況（2026-11-04）**：以下端點**尚未實作**（`email_aliases` 表已存在，但無任何 API）。實作規格見 §五 與 `docs/24`。

規劃端點（D24 Phase 1／2）：

```
GET    /api/email-aliases                 # 列出（owner：全部；mailbox：自己地址的別名）
POST   /api/email-aliases                 # {alias_local_part?, target_address_id, note?} → 建立
PATCH  /api/email-aliases/:id             # {status: active|disabled, note?}
DELETE /api/email-aliases/:id             # 軟刪除（保留稽核）
GET    /api/email-aliases/:id/senders     # 反向別名清單（哪些寄件者來過）
```

**寄信改寫**（Phase 2，僅外部寄件者）：

```
POST /api/mail/send  to=ra-<token>@atwho.org
  → 查 reverse_aliases → From 改寫為別名、To 改為原始寄件者、Reply-To 保持 ra-<token>
  → 配額計入別名的 target 地址
```

> ⚠️ 內部（`@atwho.org` ↔ `@atwho.org`）**不需要**匿名，直接以真實地址回覆即可（§五 5.2）。

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

### 十九之二、MVP 之後的擴充階段（2026-10 ~ 至今，**已完成／進行中**）

Phase 17
管理主控台與權限（D1–D15）：owner/visitor 角色、L1/L2/L3 分層、Cloudflare Access 閘門、訪客配額與停權、地址軟／硬刪除

Phase 18
互動式表單（P1/P2、D16、D18）：僅內部傳送、四道鎖（DB 為信任錨點）、RJSF lazy-load、轉寄降級為靜態

Phase 19
備份強化（D17）：鏡像擴充至 13 張表、watchdog 去抖、重試退避

Phase 20
信箱 UX（D19-1~6）：刪除語意修正（軟刪除 vs 永久刪除）、複選與批次、清空垃圾桶、每列 checkbox、D1 參數分塊

Phase 21
註冊機制（D21／D22）：邀請碼 → Email 驗證碼、可分享註冊連結

Phase 22（待做）
D23 Turnstile 防機器人（需 owner 於 Dashboard 建 widget）

Phase 23（待做）
D24 別名／反向別名（**僅對外匿名**；內部不匿名）

Phase 24（待審）
D20 註冊 ID 撞二級網域偵測 ＋ 可用名稱建議

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

---

## 二十一、帳號與身分（摘要；細節已移出）

> 本節原為 80 行實作細節，2026-11-13 移出以免與實作文件重複。**以下只留「去哪裡查」與不變的核心決策。**

| 主題 | 看哪裡 |
|---|---|
| 四種登入方式（Google OAuth／Email 驗證碼／信箱密碼／管理員 Access）| `docs/28-d27-google-oauth.md`、`docs/21-registration-email-verification.md` |
| 備用電子郵件（`contact_email`，用途＝找回密碼）| `docs/29-d29-account-settings.md` |
| 忘記／重設密碼、`pca` 撤銷舊 token | `docs/28-d27-google-oauth.md` |
| 個人設置頁、`app.` vs `mail.` 網域收斂 | `docs/29-d29-account-settings.md` |
| 跨 App 共用登入（`auth.atwho.org`、一次性 code 交換）| `docs/26-cross-app-sso.md`、`docs/27-d26-auth-proxy.md` |
| 五系統入口、`lastSystem`、遠端系統接入 | `docs/37-unified-sso.md` |
| 別名命名規則、三種寄信身分（D25／D31）| `docs/25-alias-phase1.md`、`docs/31-handoff.md` §2 |

**不變的核心決策**

- **Mail 是唯一帳號來源（IdP）**：註冊、密碼、停權、刪除都只在 Mail 進行；其他系統只存 `mail_user_id`。
- 各系統**不共用密碼、不共用 `JWT_SECRET`**；身分只透過一次性 `code` 交換傳遞（60 秒、用一次即失效）。
- **對外匿名、對內實名**：只有寄到 `@atwho.org` 內部才顯示真實地址。
- 一組身分走五個系統（Mail／Form／Now／Chat／Flow），登入後前往「上次使用的系統」。
