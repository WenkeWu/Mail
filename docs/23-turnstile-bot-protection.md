---
title: 註冊加上 Cloudflare Turnstile（防機器人）
status: 現況
updated: 2026-11-04
read-when: 改防機器人／Turnstile widget 時（D23）
---

# 23 — 註冊加上 Cloudflare Turnstile（防機器人）

> 建立：2026-11-04｜狀態：**待 owner 提供金鑰 + 待派工**
> 背景：D21 取消邀請碼改 Email 驗證碼後，任何人都能註冊 → 需補上免費的機器人防護

## 1. 為什麼選 Turnstile

- ✅ **免費**、無使用量限制
- ✅ 對使用者**無感**（多數情況不需點選）
- ✅ 就是 Cloudflare 自家產品，與現有架構一致（不用新增第三方依賴）
- ✅ 失敗時可**優雅降級**（未設定金鑰 → 跳過驗證，不影響註冊）

## 2. 金鑰（需 owner 在 Dashboard 建立）

| 金鑰 | 用途 | 存放位置 |
|---|---|---|
| **Site Key**（公開）| 前端 widget | `wrangler.jsonc` → `vars.TURNSTILE_SITE_KEY`（非機密）|
| **Secret Key**（機密）| 後端 siteverify | `wrangler secret put TURNSTILE_SECRET_KEY`（**不可進 repo**）|

**owner 操作步驟**（Dashboard）：
1. Cloudflare Dashboard → **Turnstile** → **Add widget**
2. Widget name：`atwhomail-register`
3. Hostnames：`app.atwho.org`、`mail.atwho.org`
4. Widget Mode：**Managed**（建議）
5. 建立後複製 **Site Key** 與 **Secret Key**
6. 把兩把金鑰存到 `C:\Users\johnny\.atwhomail-turnstile.txt`（兩行：`SITE=...`、`SECRET=...`）→ 助手讀取後設定

## 3. 後端

1. `POST /api/auth/register-request`：body 增加 `turnstile_token`
   - 若 `TURNSTILE_SECRET_KEY` **未設定** → 跳過（記 warning，行為同 D21）
   - 已設定 → `POST https://challenges.cloudflare.com/turnstile/v0/siteverify`（`secret` + `response` + `remoteip`）
   - 失敗 → `400 TURNSTILE_FAILED`「機器人驗證未通過，請重試」
2. `GET /api/auth/registration-mode`：回應增加 `turnstileSiteKey`（未設定則 `null`），讓前端**不需重建**即可取得
3. 稽核：`register_rejected` 增加 reason `turnstile_failed`（只記 reason）

## 4. 前端

- 若 `registrationMode.turnstileSiteKey` 非空 → 動態載入 `https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit`
- 在註冊表單顯示 widget（theme: auto），取得 token 後才允許送出「寄送驗證碼」
- widget 過期／失敗 → 顯示提示並要求重試
- 未設定 site key → 不顯示 widget（行為同 D21）

## 5. 測試 T105–T108

- T105 有 secret + token 有效 → `register-request` 200 並寄碼
- T106 token 無效 → 400 `TURNSTILE_FAILED`，不寄碼、不建驗證紀錄
- T107 未設定 secret → 跳過驗證（200，向後相容）
- T108 `registration-mode` 回傳 `turnstileSiteKey`（有設／未設兩種）
- 既有 T1–T104 零回歸

## 6. 回退

`wrangler secret delete TURNSTILE_SECRET_KEY` ＋ 清空 `TURNSTILE_SITE_KEY` → 重新部署 → 回到「無 Turnstile」狀態 ✅
