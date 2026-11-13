---
title: 可分享的註冊／邀請連結（D22）
status: 現況
updated: 2026-11-04
read-when: 改可分享註冊連結時（D22）
---

# 22 — 可分享的註冊／邀請連結（D22）

> 建立：2026-11-04｜狀態：待派工（D21 完成後）
> 需求（owner）：「我想看註冊時，是否能產生連給進入頁面」

## 1. 目標

owner 不需要叫對方「自己打網址」，而是**複製一個連結傳出去**，對方點開就**直接停在註冊頁**（需要時自動填入邀請碼）。

## 2. 連結格式

| 連結 | 行為 |
|---|---|
| `https://app.atwho.org/?register=1` | 開啟後**自動切到「註冊」分頁**（焦點在 Email 欄）|
| `https://app.atwho.org/?invite=<code>` | 自動切到註冊分頁，並**預填邀請碼**（`invite` 模式下有效）|
| `https://app.atwho.org/?invite=<code>&register=1` | 同上（兩個參數可並存）|
| `https://app.atwho.org/`（不帶參數）| 行為不變（預設登入頁）|

規則：
- 參數只影響**前端顯示與預填**，**不影響任何權限判定**（N3：權限一律由後端 session 決定）
- 無效／已撤銷的邀請碼 → 仍顯示註冊頁，但送出時由後端回 `INVITE_INVALID`（前端顯示原因）
- 參數處理完後以 `history.replaceState` 清掉 query（避免使用者複製到含碼網址亂傳）

## 3. 管理端（mail.atwho.org）

1. **邀請碼列表**：每個碼右側加「**複製邀請連結**」按鈕 → 複製 `https://app.atwho.org/?invite=<code>`
2. **產生新邀請碼**後：對話框直接顯示「邀請連結」＋一鍵複製 ✅
3. `email_verify` 模式下：顯示「**一般註冊連結**」卡片 → `https://app.atwho.org/?register=1` ＋一鍵複製 ✅
4. 複製成功 → toast「已複製連結」✅

## 4. 前端（app.atwho.org）

- 讀取 `location.search`：
  - `register=1` → `setTab('register')`；`autofocus` Email 欄
  - `invite=<code>` → `setTab('register')` ＋ 填入邀請碼欄位（`invite` 模式才顯示該欄）
- 清理 URL（`replaceState`）
- 若 `REGISTRATION_MODE=closed` → 顯示「目前暫停註冊」提示 ✅（不進表單 ✅）

## 5. 測試 T100–T104

- T100 `?register=1` → 進註冊分頁、Email 欄取得焦點
- T101 `?invite=ABC` → 進註冊分頁且邀請碼欄值為 `ABC`
- T102 處理後 URL 已清除 query
- T103 `REGISTRATION_MODE=closed` ＋ `?register=1` → 顯示暫停提示
- T104 管理端「複製邀請連結」→ 剪貼簿內容為正確 URL（mock clipboard）

## 6. 不在本次範圍

- QR code（可選，之後再說）
- 短網址服務
