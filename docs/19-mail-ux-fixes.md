# 19 — 信箱 UX 修正：刪除語意 ＋ 複選批次（D19）

> 建立：2026-11-03｜狀態：已派工
> 起因：owner 回報「收件匣刪信後垃圾桶看不到」＋「無法用 Ctrl／Shift 複選」

## 1. 已確認的 Bug（程式碼實證）

`packages/api/src/index.ts:2018-2027`：

```js
app.delete("/api/mail/:id", requireSession, async (c) => {
  ...
  await c.env.DB.prepare("UPDATE messages SET folder = 'trash', deleted_at = ?1, updated_at = ?1 WHERE id = ?2")
```

同一次 UPDATE 同時設定 `folder='trash'` **與** `deleted_at=now`。
但全程式 **28 處**查詢都帶 `deleted_at IS NULL`（列表、讀信、HTML、raw、附件…），
→ 結果：被「刪除」的信**同時是 trash 又同時被隱藏** → **任何資料夾都看不到**。

**實測（2026-11-03）**：`folder='trash' AND deleted_at IS NOT NULL` = **33 筆**；`folder='trash' AND deleted_at IS NULL` = **0 筆**（垃圾桶永遠空的）。
**已於同日一次性修復**：把該 33 筆（精準 id 清單）的 `deleted_at` 設回 NULL → 垃圾桶可見 33 筆、`itag@` 4 筆。

## 2. D19-1 刪除語意修正（Bug）

| 端點 | 行為 |
|---|---|
| `DELETE /api/mail/:id` | 只設 `folder='trash'`、`updated_at=now`；**不得設定 `deleted_at`** |
| `DELETE /api/mail/:id?mode=hard` | **永久刪除**：清 R2（`raw_r2_key`、`html_r2_key`、附件 `r2_key`）→ 刪 `attachments` → 刪 `messages`；R2 失敗 → 500 且不動 DB；稽核 `mail_purged`（不含內容，N9）|
| `POST /api/mail/:id/restore` | 只允許 `folder='trash'` → 改回 `inbox`；稽核 `mail_restored` |
| `POST /api/mail/trash/empty` | 對 session scope 內所有 `folder='trash' AND deleted_at IS NULL` 執行 hard delete；回傳 `{count, r2_objects}`；上限 500 封；稽核 `trash_emptied` |

**語意定義（寫進 docs/05）**
- `folder='trash'` ＝ **軟刪除（可還原）**
- `deleted_at IS NOT NULL` ＝ **永久刪除（全站隱藏；僅地址硬刪除流程會用到）**

**測試 T63–T68**
- T63 刪除後 `GET /api/mail?folder=trash` 可見該封
- T64 刪除後 DB 斷言 `deleted_at IS NULL`
- T65 restore → 回到 inbox
- T66 hard delete → R2 物件消失（mock）＋ 列消失 ＋ 稽核
- T67 trash/empty → 只清自己 scope（他人信件不動）
- T68 越權 hard delete → 404

## 3. D19-2 複選 ＋ 批次動作（新功能）

**後端**：`POST /api/mail/batch`

```jsonc
{ "action": "trash" | "restore" | "read" | "purge", "ids": [1,2,3] }
```

- 每個 id 都必須通過既有 `scopedMessage()` 權限檢查；**任一不合格 → 404 `MAIL_NOT_FOUND`，整批不執行**
- 上限 200 個 id
- `purge` 走 D19-1 的 hard delete 邏輯
- 稽核 `mail_batch`（`{action, count}`，不含內容，N9）

**前端**
- `MailList` 以 `Set<number>` 保存選取
- 點擊：`event.shiftKey` → 範圍連選；`event.ctrlKey || event.metaKey` → 切換單封；一般點擊 → 單選並開信
- `Ctrl/Cmd + A`（清單聚焦時）→ 全選
- 工具列：`已選 N 封` ＋ 移至垃圾桶／還原／永久刪除／標為已讀（依目前資料夾顯示可用項）
- 切換資料夾／地址 → 清空選取
- `aria-selected`／鍵盤可操作

**測試 T69–T74**
- T69 Ctrl 切換選取
- T70 Shift 範圍選取
- T71 批次移至垃圾桶
- T72 批次永久刪除
- T73 批次含越權 id → 404 且整批未執行
- T74 切換資料夾清空選取

## 4. 不在本次範圍

- 拖放移動、標籤／規則、無限捲動
- 垃圾桶「自動清理 N 天」機制

---

## 5. D19-3（補做）：UI 缺少「清空垃圾桶」與單封操作按鈕

**問題**：API 已有 `POST /api/mail/trash/empty`、`POST /api/mail/:id/restore`、`DELETE /api/mail/:id?mode=hard`，
但前端只有「複選工具列」的批次動作，**沒有**
1. 垃圾桶的「**清空垃圾桶**」按鈕
2. ReadingPane 內單封的「還原」「永久刪除」按鈕

**規格**
1. 垃圾桶檢視（`folder='trash'`）工具列新增「清空垃圾桶」：二次確認（顯示「將永久刪除 N 封，含附件與原始檔，無法復原」）→ 呼叫 `POST /api/mail/trash/empty` → 顯示 `{count, r2_objects}` → 重新載入清單與計數
2. ReadingPane：
   - 非垃圾桶資料夾 → 「刪除」（軟刪除 → 垃圾桶）
   - 垃圾桶內 → 「還原」＋「永久刪除」（二次確認）
3. 所有動作完成後同步更新左側資料夾計數

**測試 T75–T78**
- T75 垃圾桶顯示「清空垃圾桶」按鈕；非垃圾桶不顯示
- T76 清空需二次確認；取消則不呼叫 API
- T77 ReadingPane 單封「還原」→ 回 inbox
- T78 ReadingPane 單封「永久刪除」→ 需確認；成功後關閉 ReadingPane 並更新清單

---

## 6. D19-4：每封信列加入 checkbox（方便選取）

**動機**：目前只能用 Ctrl／Shift 點選 ✅，對一般使用者不夠直覺；owner 要求「每封信前面加 checkbox」✅。

**規格**
1. 每一列信件左側加 `<input type="checkbox">`
   - `aria-label` 例：「選取信件：<主旨>」
   - 點 checkbox **只切換選取**，`stopPropagation()` → **不得開啟信件**
   - 勾選／取消勾選即時反映在「已選 N 封」與批次工具列（不需 Ctrl ✅）
2. **Shift + 點 checkbox** → 範圍連選（以最近一次點擊為錨點 ✅）
3. **清單表頭**加全選 checkbox
   - 全部選取 → 勾選 ✅
   - 部分選取 → **indeterminate（半選）** ✅
   - 點擊 → 全選／取消全選（只作用於目前資料夾／目前載入的清單 ✅）
4. 已選列的視覺樣式（背景高亮 ＋ 左側色條）需與未選列明顯區隔 ✅
5. 鍵盤：列的 checkbox 可 Tab 聚焦、Space 切換 ✅
6. 切換資料夾／地址 → 清空選取（既有行為 ✅，需保持）
7. 手機／窄螢幕：checkbox 仍可見（不可因空間被隱藏 ✅）

**測試 T79–T83**
- T79 每列都有 checkbox；點擊切換選取且**不開啟信件**
- T80 Shift＋點 checkbox → 範圍連選
- T81 表頭全選 → 全部勾選；再點 → 全部取消
- T82 部分選取時表頭為 indeterminate
- T83 切換資料夾後選取清空、checkbox 全部未勾

---

## 7. D19-5（Bug 修正）：大量 id 觸發 D1 `too many SQL variables`

**現象**：垃圾桶 131 封時按「清空垃圾桶」→ `HTTP 500 DELETE_FAILED`（1.03 秒）

**實據**（`wrangler tail` 即時日誌）
```
[atwhomail-api] empty trash failed { count: 131,
  error: 'Error: D1_ERROR: too many SQL variables at offset 262: SQLITE_ERROR' }
```

**根因**
- Cloudflare D1 限制：**每條查詢最多 100 個綁定參數**（docs 實查）
- `hardDeleteMessages()` 以 `ids.map(() => "?")` 產生 `id IN (?,?,…)`，131 個 id → 131 個參數
  → `attachments`／`messages` 的 DELETE（2×131）與 SELECT 全部超限 → throw → 500
- ⚠️ 同一問題也影響 `POST /api/mail/batch` 的 `purge`（上限 200 id）與任何 >100 id 的操作

**修正**
1. `hardDeleteMessages()`：把 id **分塊（chunk ≤ 90）**處理
   - 每塊：SELECT keys → `bucket.delete(keys)`（單次呼叫，≤1000 keys）→ D1 batch 刪 attachments/messages
   - 回傳值改為所有塊的加總；塊與塊之間**各自交易**（部分失敗時回報已刪數量並拋錯，前端顯示「部分完成」）
   - R2 刪除失敗 → 該塊不動 DB（維持現有嚴格語意）
2. `POST /api/mail/trash/empty`：**先分塊查 id**（每塊 ≤ 90 撈取＋刪除，迴圈直到撈不到），避免 500 上限與 `LIMIT 501` 一次爆量
   - 回應 `{count, r2_objects}` 為全部加總
3. `POST /api/mail/batch`：`purge` 走同樣的分塊；`BATCH_MAX_IDS` 維持 200，但 UPDATE 類動作也要分塊（≤90）避免同類錯誤
4. 稽核維持只記數量（N9）

**測試 T84–T87**
- T84：`trash/empty` 在 **131 封**（>100）時成功，回傳 count=131，DB 與 R2 皆清空
- T85：`batch purge` 在 **150 個 id** 時成功
- T86：分塊過程中某一塊的 R2 失敗 → 該塊 DB 不動、回傳錯誤
- T87：`trash/empty` 在 500 封上限邊界（500 可清、501 回 `TRASH_TOO_LARGE`）

---

## 8. D19-6（Bug 修正）：永久刪除撞到 form FK → 整批失敗

**現象**：D19-5 分塊修正後，清空垃圾桶仍 500（1.89s）

**實據**（`wrangler tail`）
```
hard delete chunk failed { chunkIndex: 0, count: 41,
  error: 'Error: D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT_FOREIGNKEY' }
```

**根因**
- `form_instances.message_id → messages(id)`（FK，migration 0008）
- `form_responses.instance_id → form_instances(id)`
- `hardDeleteMessages()` 只刪 `attachments` → `messages`，**沒有先刪 form 子表**
- 垃圾桶裡只要有 **1 封互動式表單的信**（本例 open 狀態），該塊就整批 FK 失敗
- D16 已在「刪使用者／刪地址」補過這個順序，但**永久刪信的路徑沒補**（同類缺陷，需一併修）

**修正**（每個 chunk 的同一個 D1 batch 內，順序由子到父）
1. `DELETE FROM form_responses WHERE instance_id IN (SELECT id FROM form_instances WHERE message_id IN (:ids))`
2. `DELETE FROM form_instances WHERE message_id IN (:ids)`
3. `DELETE FROM attachments WHERE message_id IN (:ids)`
4. `DELETE FROM messages WHERE id IN (:ids)`
- 維持「R2 先刪、失敗即不動 DB」的既有語意（R2 的 key 收集不變）
- 稽核：完整成功時 `trash_emptied`／`mail_purged` 追加 `form_instances` 數量（只記數量，N9）

**測試 T88–T91**
- T88：永久刪除「有 open form_instance」的信 → 成功，`form_instances`／`form_responses` 一併消失，無 FK 錯誤
- T89：永久刪除「有 form_response（已提交）」的信 → 成功
- T90：`trash/empty` 在混合 100+ 封（含表單信）時成功
- T91：FK 子表刪除失敗 → 該塊整批回滾（batch 原子性），回 500 且 DB 未變
