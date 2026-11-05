# 24 — 別名（Alias）＋ 反向別名（Reverse Alias）評估

> 建立：2026-11-04｜狀態：**評估（待 owner 決策）**
> 需求（owner）：想要 SimpleLogin 的機制 —— 對外只暴露別名，**對方能回信**，**真實信箱永不出現在標頭**
> **範圍限制（owner 2026-11-04 決定，方案 A）**：**只有寄往 `atwho.org` 以外才需要匿名**；**同域 `@atwho.org` 之間不需要匿名**（內部看得到真實地址）。
> **實作規格見 `docs/25-alias-phase1.md`（D25）**；反向別名在我們架構中**非必需**，列為 Phase 2 選配。

### 0. 命名規則（owner 2026-11-04 定案）

| 規則 | 值 |
|---|---|
| 使用者輸入的名字 | **3–12 個英文字母**（儲存小寫）|
| 數字／特殊字元 | ❌ 不可（數字保留給流水號）|
| 系統附加 | **固定 `0` ＋ 3 位流水號**（001–999）|
| 別名總長 | ≤ 16 字元 |
| 範例 | `luke` → `luke001`；另一人 → `luke002` |

## 1. 現況實查（不是猜測）

| 項目 | 現況 |
|---|---|
| `email_aliases` 表 | ✅ **存在**（`alias_address UNIQUE`、`target_email_address_id` FK、`status active/disabled`、時間欄位）|
| 別名 **收信轉送** | ❌ **未實作** —— `email-handler` 完全沒有 alias 邏輯（0 命中）|
| 別名 **管理 API／UI** | ❌ **不存在**（只有刪除地址時的清理語句）|
| **反向別名** | ❌ 不存在 |
| 結論 | 目前是「**有表、無功能**」✅ 需從頭實作 ✅ |

## 2. SimpleLogin vs AtWhoMail 架構差異（重要）

| 面向 | SimpleLogin | AtWhoMail（我們）|
|---|---|---|
| 轉送方式 | 別名 → **轉寄**到真實信箱 ✅ | 可**本地直送**（不經外部 SMTP ✅）→ 更安全 ✅ |
| 郵件儲存 | **不存**（只轉發 ✅）| ✅ **存在 D1／R2**（可搜尋、可回溯 ✅ 更好 ✅）|
| 反向別名做法 | 回覆寄到 `random@simplelogin.co` → 改寫寄件者 ✅ | 同樣概念，但**我們自己控管**（無第三方 ✅）|
| 網域 | simplelogin.co | **atwho.org（自己的 ✅）** |

## 3. 設計

### 3.1 Alias 收信（Phase 1）

```
外部寄件者 → xyz123@atwho.org（別名）
   → Cloudflare MX → email-handler
   → 查 email_aliases（alias_address = xyz123@atwho.org AND status='active'）
   → 投遞到 target_email_address_id 的信箱（本地直送，不轉寄外部）
```

- `messages.address_id` = **目標地址**（使用者在自己信箱看到 ✅）
- 新增 `messages.envelope_to` = 別名（UI 顯示「寄給 `xyz123@atwho.org`」徽章 ✅，可判斷是哪個別名來的 ✅）
- 新增 `messages.reply_to` = **反向別名**（見 3.2 ✅）
- 原始 `From` **保留**（對方是誰 ✅，仍顯示 SPF/DKIM/DMARC 徽章但不授權 —— N5 ✅）
- 別名停用 → 收信端回 `550 5.1.1`（避免 backscatter；與 SimpleLogin 一致 ✅）

### 3.2 反向別名（Phase 2）—— **僅外部寄件者**才需要

| 情境 | 回信 From | 需要反向別名？ |
|---|---|---|
| **外部**寄件者 → 別名 → 你 | 別名 | ✅ 需要 |
| **內部** `@atwho.org` 寄件者 → 你 | 你的真實地址 ✅ | ❌ **不需要**（同域無匿名需求 ✅）|

```
① 別名信投遞時（**僅當寄件者不是 @atwho.org**）→ 取得/建立 reverse_alias(alias_id, sender_email)
   → token = 32 bytes random → ra-<token>@atwho.org
② 使用者按「回覆」→ 客戶端寄到 ra-<token>@atwho.org
③ /api/mail/send 偵測收件人是反向別名：
   - 查 reverse_aliases → 得到 (別名, 原始寄件人)
   - From 改寫為 xyz123@atwho.org（不是 itag@atwho.org ✅）
   - To = 原始寄件人 ✅
   - Reply-To = ra-<token>@atwho.org（對方再回也仍走別名 ✅）
④ 以 EMAIL.send() 寄出（DKIM 由 Cloudflare 對 atwho.org 簽章 ✅）
```

**新表**
```sql
CREATE TABLE reverse_aliases (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  alias_id       INTEGER NOT NULL REFERENCES email_aliases(id),
  sender_email   TEXT NOT NULL,          -- 原始寄件人（正規化小寫）
  token          TEXT NOT NULL UNIQUE,   -- 32 bytes hex（不可猜 ✅）
  created_at     INTEGER NOT NULL,
  last_used_at   INTEGER,
  UNIQUE(alias_id, sender_email)
);
```

### 3.3 管理 UI

- 別名列表：別名、目標地址、狀態、**收到幾封**、最後使用時間
- 建立：選目標地址 ＋ 自訂前綴或自動產生（`xyz123` ✅）
- 停用／啟用／刪除（刪除＝軟刪除，保留稽核 ✅）
- 每個別名可看「來自哪些寄件人」（反向別名清單 ✅）

## 4. 風險與取捨

| # | 風險 | 緩解 |
|---|---|---|
| 1 | 反向別名 token 被猜到 → 垃圾信 | ✅ 32 bytes（256-bit）隨機，不可枚舉 |
| 2 | 別名被大量寄垃圾 | ✅ 可**單獨停用**該別名（不影響真實地址 ✅）|
| 3 | 寄件者偽造（釣魚）| ⚠️ 顯示 SPF/DKIM/DMARC 徽章，**僅顯示不授權**（N5 ✅）|
| 4 | 用別名寄信繞過配額 | ✅ 別名寄信**計入目標地址**的每日／每小時配額 ✅ |
| 5 | 以別名當 From 寄信被拒 | ⚠️ **需實測**：`EMAIL.send()` 是否接受非 `email_addresses` 的 From（Cloudflare 對整個 atwho.org 簽章，理論可行 ✅）|
| 6 | 附件／大小 | ✅ 沿用既有 R2 流程（已有 ✅）|
| 7 | 別名與「互動式表單」衝突 | ✅ 表單四道鎖以 `address_id` 判定；別名信為 `kind=normal`（不帶表單 ✅）|

## 5. 工作量

| 階段 | 內容 | 估時 |
|---|---|---|
| **Phase 1** | migration（`envelope_to`／`reply_to`／別名 CRUD API）＋ email-handler 別名投遞 ＋ 停用回 550 ＋ 管理 UI | **~8h** |
| **Phase 2** | `reverse_aliases` 表 ＋ 投遞時生成 ＋ `/api/mail/send` 改寫 ＋ UI 提示 ＋ 測試 | **~9h** |
| 測試 | T109–T120（別名收信、停用、反向別名回信、token 不可枚舉、配額計入、UI） | 含在內 |
| **合計** | | **~17h（2–3 個工作天）** |

## 6. 建議

✅ **值得做**，理由：
1. 我們的架構**天生比 SimpleLogin 好**：不經第三方 ✅、信件保存在自己的 D1／R2（可搜尋／可回溯 ✅）
2. `email_aliases` 表已存在 ✅ → 不是從零開始
3. 完全符合 owner 需求：對外只給別名 ✅、對方能回信 ✅、真實地址不出現在任何標頭 ✅

**建議順序**
1. ⚠️ **先做 30 分鐘 spike**：實測 `EMAIL.send()` 能否用「不存在於 email_addresses 的別名」當 From（決定 Phase 2 是否需要額外授權設定）
2. ✅ Phase 1 上線（別名收信 ＋ 管理 UI）→ 你就能開始用別名收信
3. ✅ Phase 2 上線（反向別名）→ 回信也不洩漏真實地址

## 7. 待 owner 決定

| # | 問題 | 建議 |
|---|---|---|
| 1 | 別名網域用 `@atwho.org` 還是子網域（如 `@alias.atwho.org`）？ | ✅ 用 `@atwho.org`（同一 MX，最簡單）；子網域需另加 MX／SPF ✅ |
| 2 | 別名停用時，來信要「拒絕（550）」還是「靜默丟棄」？ | ✅ **550**（避免 backscatter ✅，SimpleLogin 同做法 ✅）|
| 3 | 是否允許別名**對外寄新信**（不只是回覆 ✅）？ | 🟡 Phase 2 先只允許「回覆」，之後再開放主動寄 ✅ |
| 4 | 別名數量上限（每地址／每帳號）？ | ✅ 建議 50 個／帳號 |
