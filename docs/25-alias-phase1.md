# 25 — 別名 Phase 1 實作規格（D25）

> 建立：2026-11-04｜狀態：**待派工**
> owner 已確認：**範圍 A**（內部看得到真實地址、只對外匿名）＋ 命名規則 ＋ 流水號規則
> 前置文件：`docs/24`（評估）、PRD §五（設計）

## 1. 命名規則（owner 2026-11-04 定案）

| 規則 | 值 |
|---|---|
| 使用者輸入的「名字」 | **3–12 個英文字母**（`a–z`／`A–Z`，儲存一律小寫）|
| 數字 | ❌ **不可**（保留給流水號）|
| 特殊字元 | ❌ 不可（`- _ . +` 空白皆禁用）|
| 保留字 | `admin postmaster abuse root noreply mailerdaemon hostmaster webmaster support` ❌ |
| 系統附加 | **固定 `0` ＋ 3 位流水號**（`001`–`999`）|
| 別名總長 | **≤ 16 字元**（12 ＋ 1 ＋ 3）|
| 範例 | `luke` → `luke001`；第二個人 → `luke002`；`samantha` → `samantha001` |

流水號由系統分配（**不可自選**）；每個名字上限 **999** 個。

## 2. Migration `0010_alias_phase1.sql`

```sql
-- 每個名字一個計數器（原子遞增，避免競態）
CREATE TABLE IF NOT EXISTS alias_names (
  name        TEXT PRIMARY KEY,          -- 小寫 a-z，3–12
  next_serial INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);

-- messages 記錄「這封信原本寄給哪個別名」
ALTER TABLE messages ADD COLUMN envelope_to TEXT;
-- 預留 Phase 2（反向別名）；Phase 1 不使用
ALTER TABLE messages ADD COLUMN reply_to TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_envelope_to ON messages(envelope_to);
```

⚠️ 只新增（`CREATE TABLE`／`CREATE INDEX`／`ADD COLUMN`），無 DROP／DELETE。

## 3. API

### 3.1 建立別名
`POST /api/email-aliases`（`requireSession`）

```jsonc
{ "name": "luke", "target_address_id": 12 }
```

流程：
1. 驗證 `name`：長度 3–12、`/^[a-z]+$/i`、非保留字 → 否則 `400 INVALID_ALIAS_NAME`
2. 驗證 `target_address_id` 屬於 session scope 且 `status='active'` → 否則 `403 TARGET_NOT_ALLOWED`
3. **D31 起每帳號最多 1 個「啟用中」的暱稱別名**（`kind='named' AND status='active'`）→ 已有時 `409 ALIAS_LIMIT_REACHED`；
   變更請帶 `replace_existing: true`，後端會在同一 batch 先停用舊的、再建立新的（舊的立即回 550）
   > Token 別名（`kind='token'`）由系統在帳號建立時自動產生，不透過此端點建立，也不受此上限影響
4. 取流水號（原子；`next_serial` 語意 = **下一個可用號碼**）：
   ```sql
   INSERT INTO alias_names(name, next_serial, created_at) VALUES(?, 2, ?)
     ON CONFLICT(name) DO UPDATE SET next_serial = next_serial + 1
     RETURNING next_serial;
   ```
   本次使用的序號 = 回傳值 − 1（首次回 2 → 用 1；第二次回 3 → 用 2）
5. `alias_address = name + zeroPad3(serial)` → 例 serial=1 → `luke001`（**不再額外加 0**；補零的 `00` 就是 owner 說的「0」）
6. `INSERT INTO email_aliases(alias_address, target_email_address_id, status, created_at, updated_at)`
7. 回應 `201 { id, alias_address, target_address_id, status }`
8. 稽核 `alias_created`（只記 alias_address 與 target ✅ N9）

### 3.2 列表 / 停用 / 刪除
| 端點 | 說明 |
|---|---|
| `GET /api/email-aliases` | 回傳別名清單（`id, alias_address, target_address_id, target_email, status, received_count, last_received_at, created_at`）；owner 看全部、mailbox 只看自己地址的 |
| `PATCH /api/email-aliases/:id` | `{ status: "active" \| "disabled" }`；稽核 `alias_updated` |
| `DELETE /api/email-aliases/:id` | **軟刪除**（`status='disabled'` ＋ 既有 DELETE 走停用；不刪資料列 ✅ 保留稽核）|

`received_count` = `SELECT COUNT(*) FROM messages WHERE envelope_to = alias_address`（用索引 ✅）

## 4. email-handler：別名收信

在既有投遞流程中，`recipient` 解析順序：

```
1. email_addresses（status='active'）→ 命中 → 既有流程（不動 ✅）
2. email_aliases（alias_address = recipient）
     status='active'   → 投遞到 target_email_address_id
                          messages.envelope_to = recipient（別名）
                          origin/kind/delivery_scope 依既有規則判定
     status='disabled' → 回 550 5.1.1（信箱不存在；避免 backscatter）
3. 都沒有 → 550 5.1.1
```

- ⚠️ **禁止 alias → alias**：`target_email_address_id` 只能指向 `email_addresses`（API 已限制 ✅）
- ⚠️ 別名信**不可**帶 `form_instance`（`kind` 一律 `normal` ✅）
- 別名信與一般信同一套 SPF/DKIM/DMARC 記錄方式 ✅

## 5. 回信 From 自動用別名（**Phase 1 核心 ✅**）

| 情境 | 行為 |
|---|---|
| 回覆一封 `envelope_to` 有值的信，且**寄件者非 `@atwho.org`** | ✅ `From` 自動帶入**該別名** |
| 回覆內部（`@atwho.org`）寄件者的信 | ✅ `From` 用**真實地址**（範圍 A ✅）|
| 使用者仍可手動改 From（限自己名下 ✅）| ✅ |

後端 `/api/mail/send` 的 From 驗證擴充：
- 目前只接受 `email_addresses` ✅
- 新增：若 `from` 是 `email_aliases.alias_address` 且該別名的 target 屬於 session scope ✅ → **允許**
- **配額一律計入 target 地址**（`sent_today`／hourly／warmup ✅）
- 稽核 `mail_sent` 的 `detail.via_alias = true`（只記布林 ✅）

前端：
- `ReadingPane` 回覆時依上述規則決定 `From` ✅（使用者可在 ComposeWindow 看到「From: luke001@atwho.org」✅）
- 信件列表／閱讀窗顯示「**寄給 luke001@atwho.org**」徽章 ✅（來自 `envelope_to` ✅）

## 6. 前端管理頁

- 側邊欄「別名」區塊
- 建立表單：輸入名字 → 即時驗證（3–12 字母 ✅ 非保留字 ✅）→ 選目標地址 → 「建立」
- 成功 → 卡片顯示 `luke001@atwho.org` ＋ **複製** 按鈕 ✅
- 列表：別名 ✅／目標地址 ✅／狀態開關 ✅／收到幾封 ✅／最後收到時間 ✅／刪除（停用 ✅）
- 空狀態提示：「建立別名後，把別名給對方，對方就看不到你的真實地址 ✅」

## 7. 測試 T109–T118

- **T109** 建立別名：`luke` → `luke001`，DB 寫入正確、`alias_names.next_serial=2`（= 下一個可用）
- **T110** 同名第二個 → `luke002`（不同使用者 ✅）
- **T111** 名字驗證：長度 <3／>12、含數字、含符號、保留字 → 全部 `400 INVALID_ALIAS_NAME`
- **T112** 目標地址不屬於自己 → `403 TARGET_NOT_ALLOWED`
- **T113**（D31 改寫）已有 active 暱稱 → 第二個 `409 ALIAS_LIMIT_REACHED`；`replace_existing: true` → 舊的停用、新的建立；停用後可再建立
- **T114** email-handler：寄到 active 別名 → 投遞到 target，`envelope_to` 正確、`kind='normal'`
- **T115** 停用別名來信 → 550，不建立 messages
- **T116** `GET /api/email-aliases` 的 `received_count` 正確；owner/mailbox 範圍正確
- **T117** 回信外部寄件者 → `From` 自動為別名；`/api/mail/send` 接受別名 From；配額計入 target
- **T118** 回信內部寄件者 → `From` 為真實地址（範圍 A ✅）
- 既有 T1–T108 零回歸

## 8. 明確不做（Phase 2）

- 反向別名（`reverse_aliases`、`Reply-To` 改寫）✅ 預留欄位但**不啟用**
- ~~別名主動寄新信給外部~~ → ✅ **D31（2026-11-06）開放**：撰寫新信可選「真實 ID／暱稱／Token」三種隱私模式；後端原本即接受 active 別名 From
- 一次性別名、別名轉寄到外部信箱 ✅（仍不做）
