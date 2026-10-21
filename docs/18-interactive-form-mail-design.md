# 18 — 郵件種類與互動式表單運作模式（設計文件 v0.1）

> 狀態：**P1／P2 已實作（2026-10-21；未部署、migration 0008 未套用）**；P3 尚未實作。
> 實作狀態、測試與已知限制見 §14。
> 建立於 2026-10-15｜前置：`docs/16`（管理強化 D1–D15）、`docs/17`（備份還原）
> 本文件只定義「要什麼、怎麼判定、怎麼防」；**不含實作**。

---

## 1. 三種郵件種類（定義）

| 面向 | **A. 外部一般郵件** | **B. atwho.org 內部一般郵件** | **C. atwho.org 互動式郵件** |
|---|---|---|---|
| **郵件格式** | 標準 MIME | 標準 MIME | 標準 MIME ＋ **靜態表單文字版**（＋非權威提示標記）|
| **來源** | 外部郵件系統（經 MX 進入）| 已登入使用者的內部寄信功能 | 內部「表單寄信」功能 |
| **資料庫紀錄** | 一般郵件紀錄 | 內部郵件紀錄（`origin=internal`）| 郵件紀錄 ＋ **表單實例關聯**（`form_instance_id`）|
| **顯示方式** | 一般郵件 | 一般郵件 | 一般郵件內容 ＋ **互動式表單元件**（僅授權者 ✅）|
| **表單權限** | 無 | 無 | **必須通過後端授權**（四道鎖）|
| **外部偽造** | 表單標記 → **當一般郵件** ✅<br>身分偽造 → `origin=external` ＋ 顯示驗證結果 ✅ | **表單偽造：不適用（本類無表單）**<br>**身分偽造 → 判為外部** ✅（理由見 §5.2）| 表單標記 → **一律無效** ✅<br>身分偽造 → 判為外部 ✅ |
| **可否寄到外部** | ✅ 可 | ✅ 可 | ❌ **不可**（僅在 atwho.org 內部流動）|
| **轉寄** | 一般轉寄 ✅ | 一般轉寄 ✅ | **降級為靜態文字** ✅ |
| **轉寄後回流** | — | — | **視為一般郵件，表單不生效** ✅ |

---

## 2. 分類與信任模型（核心原則）

> **分類由「進入路徑」決定，絕不由郵件內容決定。**

| 進入點 | `origin` | `kind` | 說明 |
|---|---|---|---|
| MX → `email-handler` | `external` | `normal`（**永遠**）| 即使內容含表單標頭／表單附件也一樣 ✅ |
| `POST /api/mail/send`（本地投遞）| `internal` | `normal` | 一般內部郵件 |
| `POST /api/forms/send` | `internal` | `interactive_form` | 唯一能產生表單的路徑 |

**授權來源**

| 機制 | 證明什麼 | 可否授權表單 |
|---|---|---|
| SPF | 寄件 IP 被網域授權 ✅ | ❌ |
| DKIM | 內容未被竄改、由持鑰者簽署 ✅ | ❌ |
| DMARC | 對齊與政策 ✅ | ❌ |
| **DB：`form_instances` ＋ 郵件關聯 ＋ 收件人比對** | **應用層授權** ✅ | ✅ **唯一依據** |

> 三者只是「郵件來源驗證」，**不等同應用程式授權** ✅

---

## 3. 運作流程

### 3.1 模式 a：一般郵件（`POST /api/mail/send`）

1. 驗證寄件地址屬於自己 ✅、收件人格式 ✅、配額 ✅
2. 收件人含**外部** → `EMAIL.send()`（Cloudflare Email Service → SMTP ✅）
3. 收件人**全為內部** → **本地直送**（不繞 SMTP ✅）→ 收件人 `origin=internal`
4. 寄件備份：`folder='sent'` ✅

### 3.2 模式 b：互動式表單（`POST /api/forms/send`）

| 步 | 動作 | 失敗行為 |
|---|---|---|
| 1 | 驗證**所有** to／cc／bcc 收件人為本網域 ＋ 存在 ＋ active | `422 FORM_RECIPIENT_NOT_INTERNAL`（fail closed ✅）|
| 2 | 建立 `form_instances`（**每個收件人一筆**）| — |
| 3 | 產生**靜態文字版**（欄位清單／說明，供轉寄與外部閱讀）| — |
| 4 | **本地投遞**：寫入各收件人 `messages`（`origin=internal`、`kind=interactive_form`、`delivery_scope=internal`、`form_instance_id`）| — |
| 5 | raw `.eml` 存 R2（只含靜態版 ＋ **非權威**提示標記）| — |
| 6 | 稽核 `form_sent` | — |
| 7 | **完全不呼叫 `EMAIL.send()`** → 物理上不可能外流 ✅ | — |

### 3.3 收件人側（讀信）

```
開啟信件
  └─ kind != interactive_form ─→ 一般渲染（現況）
  └─ kind == interactive_form ─→ GET /api/forms/:id
        └─ 四道鎖通過 → 取 schema → RJSF 渲染表單
        └─ 任一失敗   → 顯示靜態文字（不報錯、不洩漏）
填寫後 → POST /api/forms/:id/responses → status: open → submitted → 稽核
```

### 3.4 寄件人側

| 動作 | 端點 | 限制 |
|---|---|---|
| 查看回覆 | `GET /api/forms/:id/responses` | 僅寄件人 ✅ |
| 撤回 | `POST /api/forms/:id/revoke` | 收回後收件人端**立即變靜態** ✅ |

---

## 4. 授權四道鎖

| 鎖 | 檢查內容 | 成本 | 必要性 |
|---|---|---|---|
| ① | `messages.kind = 'interactive_form'` | 免費（欄位）| 🟡 輔助標記 |
| ② | `form_instances` 存在 ＋ `status='open'` ＋ 未過期 | 一次 SELECT | 🔴 **絕對必要**（授權本體）|
| ③ | 登入者 `address_id == instance.recipient_address_id` | 免費（session 已有）| 🔴 **絕對必要**（防 IDOR）|
| ④ | `origin='internal'` 且 `delivery_scope='internal'` | 免費（欄位）| 🟢 縱深防禦 |

> **任一失敗 → 靜態文字**（不顯示錯誤原因，避免洩漏表單是否存在 ✅）

---

## 5. 偽造防護矩陣

> ⚠️ 先釐清一個容易混淆的點：**「外部偽造」其實有兩種，威脅與處理完全不同。**

| 種類 | 攻擊者想達成 | 影響哪一類郵件 | 我們的處理 |
|---|---|---|---|
| **(甲) 表單標記偽造** | 讓一封外部信「變成」可互動表單 | 只對 **C** 有意義（A/B 沒有表單）| 一律無效（DB 無實例 ✅）|
| **(乙) 寄件者身分偽造** | 讓外部信看起來像**內部同事**寄的（釣魚 ✅） | **A／B／C 全部** | `origin` 由**路徑**判定 → 一律 `external` ✅ ＋ 顯示驗證結果 ✅ |

### 5.1 為什麼 B 類（內部一般郵件）的「外部偽造」寫「不適用」

| 問題 | 回答 |
|---|---|
| 「B 類的表單被偽造？」| **不存在這個問題** ✅ —— B 類**沒有表單**（`kind=normal`、`form_instance_id=NULL`）→ 沒有東西可被啟用 ✅ |
| 那 B 類就沒有偽造風險嗎？| **有，但是另一種** ⚠️ —— 攻擊者可以從外部寄一封 `From: 同事@atwho.org` 的信 ✅（**寄件者身分偽造** ✅）→ 這與「表單」無關，屬**釣魚**風險 ✅ |
| 系統怎麼防？| ✅ **`origin` 不看 `From` 標頭，只看進入路徑**：這封偽造信從 MX 進來 → `origin=external` ✅ → **不會拿到「內部」身分／徽章／任何內部特權** ✅<br>✅ 並可**顯示寄件者驗證結果**（見 §5.3）→ 使用者看得到「⚠️ 這封信的寄件者驗證失敗」✅ |

### 5.2 判定規則（避免「靠標頭信任」）

| 攻擊 | 若系統用 `From` 判定（❌ 錯誤做法）| 本設計（✅ 正確做法）|
|---|---|---|
| 外部寄 `From: itag@atwho.org` | 被當成**內部郵件** ⚠️ → 徽章錯、身分誤導 | 從 MX 進來 → **`origin=external`** ✅ |
| 外部信帶 `X-AtWho-Form: 123` | 被當成**互動式** ⚠️ → 可能啟用表單 | `kind=normal` ✅ ＋ `suspicious_form_claim=1` ✅ → 不啟用 ✅ |
| 轉寄內部互動式郵件到外部再寄回 | 可能被當成**互動式** ⚠️ | 回流走 MX → `kind=normal` ✅ → 靜態 ✅ |

### 5.3 寄件者驗證結果（**顯示用，非授權** ✅）

**實據（2026-10-15 實查一封真實外部來信 `foxconn.com`）**：Cloudflare 收信時已在原始標頭加入 ✅

```
Received-SPF: pass (mx.cloudflare.net: domain of johnny.wk.wu@foxconn.com …)
Authentication-Results: … spf=pass … dkim=pass header.d=foxconn.com … dmarc=pass …
ARC-Authentication-Results / ARC-Seal (cv=pass) …
```

| 用途 | 說明 |
|---|---|
| ✅ **可以**：在信件上顯示「寄件者驗證：SPF ✅／DKIM ✅／DMARC ✅」或「⚠️ 驗證失敗」 | 防釣魚、幫助使用者判斷 ✅ |
| ❌ **不可以**：用這些結果去**授權表單**或改變 `origin`/`kind` | 你的規則：SPF／DKIM／DMARC ≠ 應用授權 ✅ |

> 📌 現況：收信端**尚未解析** `Authentication-Results`（只有 postal-mime 的 metadata ✅）→ 建議列入 **P1** 一併實作（成本低：解析標頭 ＋ 存 2 個欄位 ＋ UI 徽章 ✅）


| # | 情境 | 期望結果 | 靠什麼機制 |
|---|---|---|---|
| 1 | 外部郵件帶自訂表單標頭／附件 | **一般郵件** ✅ | `email-handler` 永不設 `kind=interactive_form`；標記丟棄並記 `suspicious_form_claim` ✅ |
| 2 | 外部郵件聲稱自己是互動式 | **一般／可疑** ✅ | DB 查無實例 → 不啟用 ✅ |
| 3 | 內部使用者**轉寄**出去 | **靜態文字** ✅ | 轉寄不複製 `form_instance_id`、**不建立新實例** ✅ |
| 4 | 轉寄件**回流** | **一般郵件** ✅ | 走 MX → `external` ✅ |
| 5 | 非收件人開啟 | **靜態** ✅ | 鎖 ③ |
| 6 | 寄件人撤回後 | **靜態** ✅ | 鎖 ② |
| 7 | 表單逾期 | **靜態** ✅ | 鎖 ② |
| 8 | 直接呼叫 API 猜 id | **404／403** ✅ | 鎖 ②③ ＋ 稽核 |

---

## 6. 資料模型（migration `0008`，草案）

```sql
-- ① messages 分類欄位
ALTER TABLE messages ADD COLUMN origin TEXT NOT NULL DEFAULT 'external'
  CHECK (origin IN ('external','internal'));
ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal'
  CHECK (kind IN ('normal','interactive_form'));
ALTER TABLE messages ADD COLUMN delivery_scope TEXT NOT NULL DEFAULT 'external'
  CHECK (delivery_scope IN ('internal','external'));
ALTER TABLE messages ADD COLUMN form_instance_id INTEGER;      -- 僅 kind=interactive_form
ALTER TABLE messages ADD COLUMN suspicious_form_claim INTEGER NOT NULL DEFAULT 0;

-- ② 表單範本（schema 白名單驗證後才寫入）
CREATE TABLE form_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  version INTEGER NOT NULL,
  schema_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (key, version)
);

-- ③ 表單實例（每個收件人一筆）
CREATE TABLE form_instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES form_templates(id),
  message_id INTEGER NOT NULL REFERENCES messages(id),
  sender_address_id INTEGER NOT NULL REFERENCES email_addresses(id),
  recipient_address_id INTEGER NOT NULL REFERENCES email_addresses(id),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','submitted','revoked','expired')),
  due_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_form_instances_recipient ON form_instances(recipient_address_id, status);
CREATE INDEX idx_form_instances_message   ON form_instances(message_id);

-- ④ 回覆
CREATE TABLE form_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id INTEGER NOT NULL UNIQUE REFERENCES form_instances(id),
  responder_user_id INTEGER NOT NULL REFERENCES users(id),
  payload_json TEXT NOT NULL,
  submitted_at INTEGER NOT NULL
);
```

---

## 7. API 契約（草案）

| 方法 | 路徑 | 用途 | 權限 | 主要錯誤碼 |
|---|---|---|---|---|
| POST | `/api/forms/send` | 建立並投遞互動式郵件 | 已登入 ✅ | `FORM_RECIPIENT_NOT_INTERNAL`、`FORM_SCHEMA_INVALID` |
| GET | `/api/forms/:id` | 取表單 schema（渲染用）| 收件人本人 ✅ | `FORM_NOT_FOUND`、`FORM_NOT_AUTHORIZED`、`FORM_CLOSED`、`FORM_EXPIRED` |
| POST | `/api/forms/:id/responses` | 送出回覆 | 收件人本人 ✅ | `FORM_ALREADY_SUBMITTED`、`FORM_CLOSED`、`FORM_INVALID_PAYLOAD` |
| GET | `/api/forms/:id/responses` | 查看回覆 | 寄件人本人 ✅ | `FORM_NOT_AUTHORIZED` |
| POST | `/api/forms/:id/revoke` | 撤回 | 寄件人本人 ✅ | `FORM_NOT_AUTHORIZED` |

**稽核事件**：`form_sent`／`form_viewed`／`form_submitted`／`form_revoked`／`claim_blocked`（均不含信件內容 ✅）

---

## 8. 前端與 RJSF

| 項目 | 決定 |
|---|---|
| 渲染器 | **RJSF**（`@rjsf/core` ＋ `@rjsf/validator-ajv8`）✅ |
| Cloudflare 設定影響 | **無** ✅（純前端依賴，僅 Pages 重新部署 ✅）|
| 樣式 | 目前無 UI 框架（手寫 CSS）→ 需自訂 theme／widgets ✅ |
| 位置 | `ReadingPane` 內、**sandbox iframe 之外**（表單是我們自己的元件 ✅）|

**Schema 子集白名單（必須在後端驗證 ✅）**

| 允許 | 禁止 |
|---|---|
| `type: object` ＋ `properties` ＋ `required` | `$ref`、`anyOf`、`oneOf`、`allOf` |
| `string`／`number`／`integer`／`boolean`／`array`（基本 ✅）| `patternProperties`、`dependencies` |
| `enum`、`title`、`description`（**需消毒**）| 巢狀 > 2 層、欄位數 > 40、字串 > 2000 字 |
| `format: date`（限 ✅）| `format: data-url`（避免 data URI ✅）|

---

## 9. 安全規則（不可違反）

1. 表單 schema **只存 DB** ✅ —— 外部不可自帶 schema ✅
2. 回覆內容**永遠當資料**（不渲染 HTML ✅）；長度上限 ✅
3. 表單只能打自家 API（不得外連 ✅）
4. RJSF 渲染的 `title`／`description` 需消毒（防 XSS ✅）
5. 稽核**不含信件內容**（與 N9 一致 ✅）
6. 互動式郵件**永不呼叫 `EMAIL.send()`** ✅
7. **SPF／DKIM／DMARC 通過 ≠ 有權使用表單** ✅

---

## 10. 分階段實作與回退

| 階段 | 內容 | 可獨立上線 | 回退 |
|---|---|---|---|
| **P1** | migration 0008 ＋ **內部信本地直送** ＋ 三類徽章 | ✅ | 欄位有預設值，可保留不用 ✅ |
| **P2** | `POST /api/forms/send` ＋ RJSF 渲染 ＋ 回覆 API | ✅ | feature flag 關閉表單渲染（自動降為靜態 ✅）|
| **P3** | 撤回／期限／統計／稽核頁 | ✅ | 同上 |

---

## 11. 測試清單（T36–T52）

| 編號 | 測試 |
|---|---|
| T36 | 內部一般郵件：本地直送、`origin=internal`、`kind=normal` |
| T37 | 外部郵件：`origin=external`、`kind=normal`（即使帶 `X-AtWho-Form` 標頭）|
| T38 | 外部郵件帶表單附件 → `suspicious_form_claim=1` 且不啟用 |
| T39 | `POST /api/forms/send` 收件人含外部 → `422 FORM_RECIPIENT_NOT_INTERNAL` |
| T40 | 成功建立：每收件人一筆實例、`delivery_scope=internal`、**未呼叫 `EMAIL.send`** |
| T41 | 收件人 `GET /api/forms/:id` → 200 且 schema 正確 |
| T42 | **非收件人** → 404／403（不洩漏存在性）|
| T43 | 撤回後 → `FORM_CLOSED`，前端降為靜態 |
| T44 | 逾期 → `FORM_EXPIRED` |
| T45 | 重複送出 → `FORM_ALREADY_SUBMITTED` |
| T46 | 非法 payload（超長／型別錯）→ `FORM_INVALID_PAYLOAD` |
| T47 | schema 白名單：`$ref`／`anyOf` → `FORM_SCHEMA_INVALID` |
| T48 | **轉寄**互動式郵件 → 新信 `kind=normal`、無 `form_instance_id` |
| T49 | 轉寄件回流（模擬外部寄入）→ `kind=normal`、無表單 |
| T50 | 寄件人查看回覆 → 200；他人 → 403 |
| T51 | 稽核事件齊全且**不含信件內容** |
| T52 | 一般郵件行為零回歸（T1–T35 全綠）|
| T53 | 外部寄件者偽造 `From: x@atwho.org` → `origin=external`、`kind=normal`、**不取得內部徽章** |
| T54 | 解析 `Authentication-Results` 存入驗證結果欄位；**不影響** `origin`／`kind`／表單授權 |
| T55 | 驗證結果為 fail 的外部信 → 顯示「⚠️ 驗證失敗」但仍可正常閱讀 ✅ |

---

## 12. 決策（已定案，2026-10-15）

| # | 問題 | 決定 |
|---|---|---|
| 1 | 前端渲染器 | ✅ **採用 RJSF**（`@rjsf/core` ＋ `@rjsf/validator-ajv8`；自訂 theme/widgets，不引入 UI 框架）|
| 2 | 一般郵件「全內部收件人」| ✅ **改本地直送**（不繞 SMTP；可可靠標記 `origin=internal`）|
| 3 | 表單回覆附件 | ✅ **P1／P2 不做**（P3 再評估）|
| 4 | 轉寄互動式郵件 | ✅ **允許，但降級為靜態文字**（不複製 `form_instance_id`、不建新實例）|
| 5 | 寄件人可見「已讀」 | 🟡 留到 P3 |
| 6 | 寄件者驗證結果（SPF/DKIM/DMARC）顯示 | ✅ **納入 P1**（僅顯示，永不授權）|

---

## 13. 實作範圍與順序（本次派工）

| 階段 | 內容 | 交付 |
|---|---|---|
| **P1** | migration **`Atwhomail/migrations/0008_form_mail.sql`**（本專案 migrations 在 repo 子目錄 `Atwhomail/migrations/`，wrangler `migrations_dir=../../migrations`，現有最大為 `0007`）＋ **本地直送** ＋ 三類徽章 ＋ 寄件者驗證顯示 | 可辨識三類郵件、內部信不再繞外網 |
| **P2** | `POST /api/forms/send` ＋ 四道鎖查詢 ＋ RJSF 渲染 ＋ 回覆／撤回 API | 可實際寄出並填寫互動式表單 |
| **P3** | 撤回 UI 完善、期限、統計、稽核頁、已讀狀態 | 治理完整 |

**驗收門檻**：canonical 三指令全綠（含 web DOM suite）；**T36–T55** 全過；**T1–T35 零回歸**。
**安全門檻**：互動式郵件路徑**不得呼叫 `EMAIL.send()`**；表單授權只查 DB；稽核不含信件內容（N9）。

---

## 14. 實作狀態（2026-10-21）

> 本次只做 **P1／P2**，未做 P3；**未部署、未跑遠端 migration、未對 production D1／R2 寫入**。

### 14.1 P1（已實作，commit `0b54e41`）

| 項目 | 結果 |
|---|---|
| migration | `Atwhomail/migrations/0008_form_mail.sql`：messages 新增 `origin`／`kind`／`delivery_scope`／`form_instance_id`／`suspicious_form_claim`／`sender_spf`／`sender_dkim`／`sender_dmarc`；新增 `form_templates`／`form_instances`／`form_responses`（含索引與 FK）。既有列安全預設（`external`／`normal`／`external`），不會變成互動式表單 |
| email-handler | MX 進信一律 `external`／`normal`／`external`；解析 `Authentication-Results`（優先）與 `Received-SPF`（SPF 備援）；`X-AtWho-Form*` 標頭／`.atwhoform` 附件 → 丟棄標記、`suspicious_form_claim=1`、稽核 `claim_blocked`（不含信件內容） |
| `/api/mail/send` | to+cc+bcc 全部本網域＋存在＋active → **本地直送**（不呼叫 `EMAIL.send()`），每位收件人獨立 messages／R2，保留寄件備份；含任一個外部收件人 → 維持既有 `EMAIL.send()`。配額／can_send／暖機／每小時限流／稽核不變 |
| 前端 | 列表與讀信顯示三類徽章（外部／內部／互動式）；外部信顯示 SPF／DKIM／DMARC（pass／fail／none／unknown，**僅顯示**；fail 顯示警告但仍可閱讀） |
| 測試 | T36／T37／T38／T49／T53／T54／T55 全過；既有 T1–T35 零回歸 |

### 14.2 P2（已實作，commit `0f357d3`）

| 項目 | 結果 |
|---|---|
| 依賴 | `@rjsf/core`／`@rjsf/validator-ajv8`／`@rjsf/utils`（僅 `web`；無 UI 框架） |
| 後端 | `packages/api/src/forms.ts`：schema 白名單＋payload 驗證＋靜態文字版。`POST /api/forms/send`（fail closed、每人一實例、本地直送、**絕不呼叫 EMAIL.send**、稽核 `form_sent`）；`GET /api/forms/:id`（四道鎖，任一失敗一律 404，稽核 `form_viewed`）；`POST /api/forms/:id/responses`（重複／撤回／逾期錯誤碼，稽核 `form_submitted`）；`GET /api/forms/:id/responses`（僅寄件人）；`POST /api/forms/:id/revoke`（撤回整批，稽核 `form_revoked`） |
| 前端 | `FormRenderer`（RJSF＋自訂 Text／Date／Select／Checkbox／Textarea widgets）；`ReadingPane` 成功渲染、任何失敗降靜態；`FormManagePanel`（寄件人查看回覆／撤回）；`ComposeWindow` 互動式表單模式（僅內部地址、schema JSON 編輯） |
| 轉寄降級 | Forward 仍走既有 `DraftMode="forward"`，只帶 `GET /api/mail/:id/text` 的靜態文字；不複製 `form_instance_id`、不建立新實例（T48） |
| 測試 | T39–T51（含 T48 轉寄降級、T51 稽核不含內容）全過；canonical 三指令全綠（workerd 22 files／283 tests＋web DOM 5 files／28 tests） |

### 14.3 已知限制／未完成（P3 或後續）

| # | 項目 | 說明 |
|---|---|---|
| 1 | **未做 feature flag** | §10 的回退設計尚未實作；目前回退＝重新部署上一版前端（後端端點保留）。建議 P3 加 `FORMS_ENABLED` |
| 2 | 表單回覆附件 | 依 §12 決策 P1／P2 不做（P3 再評估） |
| 3 | 期限 UI／已讀狀態／統計／稽核頁 | P3 範圍 |
| 4 | 寄件備份的「代表實例」 | `messages.form_instance_id` 指向該批第一筆實例，僅供寄件人管理 UI 找到同批 template；收件人四道鎖仍以 `form_instances` 為準 |
| 5 | owner session 不能填表單 | 四道鎖③要求「登入者 address_id == recipient_address_id」；owner session 沒有單一 address_id → 一律 404（fail closed）。owner 需以該地址的 mailbox session 登入填寫 |
| 6 | 前端 bundle 變大 | RJSF 讓 web bundle 約 682 kB（gzip 216 kB），Vite 有 chunk size 警告；不影響功能 |
| 7 | 表單寄送非全批次交易 | 若在建立多個實例的中途發生 D1 錯誤，已建立的實例會保留（安全：無 instance 的 message 只會降為靜態）；寄件備份失敗不影響已投遞的收件人 |
