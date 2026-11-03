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
