# 21 — 註冊改為 Email 驗證碼（取消邀請碼）

> 建立：2026-11-04｜狀態：**實作中**（D21）
> 需求（owner）：「先取消邀請碼，填 mail address，作認證碼」

## 1. 動機

- 邀請碼需要 owner 先產生再轉交，對家庭／小群組使用摩擦太大
- 改為「填真實 Email → 收 6 位數驗證碼 → 完成註冊」，使用者自助完成

## 2. ⚠️ 風險與配套（必讀）

邀請碼目前是**唯一**阻止陌生人使用 `atwho.org` 寄信的機制。取消後必須以其他手段補上：

| 風險 | 配套 |
|---|---|
| 大量機器人註冊 | **速率限制**：同 IP 每小時 5 次、每日 20 次註冊嘗試；同 Email 每 60 秒只能寄一次驗證碼 |
| 用假 Email 註冊 | **必須輸入驗證碼**才能建立帳號（未驗證 → 帳號不存在）|
| 註冊後立刻大量寄信 | 新地址 **24 小時暖機期（預設上限 5，D35 可調）** + 每日 50（D33，2026-11-07 由 20 調整）、每小時 10 |
| 網域信譽受損 | 上述限制 + `REGISTRATION_MODE=closed` 可**立即關閉註冊** |
| 垃圾碼轟炸他人信箱 | 同 Email 60 秒 1 封、每 Email 每日 5 封上限 |
| 之後想回到邀請制 | `REGISTRATION_MODE=invite` 一行切回，邀請碼機制**完全保留**（程式不刪）|

## 3. 資料模型（migration 0009）

```sql
CREATE TABLE email_verifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT NOT NULL,              -- 正規化（小寫）
  code_hash     TEXT NOT NULL,              -- SHA-256(code + pepper)
  purpose       TEXT NOT NULL DEFAULT 'register',
  attempts      INTEGER NOT NULL DEFAULT 0, -- 上限 5
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,           -- 15 分鐘
  consumed_at   INTEGER,
  ip            TEXT
);
CREATE INDEX idx_email_verifications_email ON email_verifications(email, created_at);
```

## 4. API

| 端點 | 說明 |
|---|---|
| `POST /api/auth/register-request` | body `{email, local_part}` → 檢查 ID（格式／保留字／既有地址／D20 網域撞名）→ 寄 6 位數驗證碼到 `email`（寄件者 `noreply@atwho.org`）→ `200 {sent:true, expiresIn:900}`；失敗：`EMAIL_INVALID`(400)、`ID_TAKEN`(409)、`RATE_LIMITED`(429)、`REGISTRATION_CLOSED`(403) |
| `POST /api/auth/register-verify` | body `{email, local_part, code, password}` → 驗碼（過期 15 分／錯誤 5 次上限／一次性）→ 建立 user + address（`status='active'`、`warmup` 24h）→ 回既有登入 token（與 `mailbox-login` 相同格式）|
| `POST /api/auth/register`（既有）| 保留，行為依 `REGISTRATION_MODE`：`invite`（預設相容）／`email_verify`／`closed` |

環境變數 `REGISTRATION_MODE`：`invite` | `email_verify` | `closed`（預設 `invite`，部署後由 owner 切 `email_verify`）

ID 格式：1–64 字元 `[a-z0-9._-]`，不可為純數字（例：`123456` 不可、`123abc` 可）；
不符 → `400 INVALID_LOCAL_PART`。

## 5. 安全細節

- 驗證碼：`crypto.getRandomValues` 取 6 位數；DB 只存 `SHA-256(code + JWT_SECRET)`；**一次性**（`consumed_at`）
- 有效期 15 分鐘；錯誤 5 次即作廢（`attempts >= 5` → `CODE_LOCKED`）
- 重寄：同 Email 60 秒內 → `429 CODE_COOLDOWN`；同 Email 每日 5 封 → `429 CODE_DAILY_LIMIT`
- 速率限制沿用既有 `auth_attempts` 表（`key = 'register:<ip>'`、`'register:<email>'`）
- 驗證碼信中**不含任何個資**，只含 6 位數字與 15 分鐘有效說明
- 稽核：`register_requested`、`register_verified`、`register_rejected`（只記 reason 與 local_part，不含密碼／碼值）

## 6. 前端（app.atwho.org 註冊分頁）

1. 表單欄位改為：**Email（收驗證碼）** ＋ **想要的 ID**（`@atwho.org` 後綴顯示在右側）＋ 密碼 ＋ 確認密碼
2. 按「寄送驗證碼」→ 顯示 6 格驗證碼輸入（或單一 6 位數字欄）＋ 倒數 60 秒可重寄
3. 驗證成功 → 自動登入（用回傳的 token）
4. 錯誤訊息：`ID_TAKEN`「這個 ID 已被使用」、`ID_RESERVED`「此 ID 為系統保留」、`CODE_INVALID`「驗證碼錯誤，還可再試 N 次」、`CODE_EXPIRED`
5. 移除「邀請碼」欄位；但若 `REGISTRATION_MODE=invite` 仍顯示（向後相容）

## 7. 測試 T92–T99

- T92 `register-request` 正常寄碼（R2/EMAIL mock 檢驗 6 位數、不含其他內容）
- T93 ID 重複 → 409 `ID_TAKEN`，不寄碼
- T94 驗證碼錯誤 5 次 → `CODE_LOCKED`
- T95 過期（15 分鐘）→ `CODE_EXPIRED`
- T96 重寄 60 秒內 → 429 `CODE_COOLDOWN`
- T97 驗證成功 → 建立 user＋address（warmup 生效）＋回 token
- T98 同一碼只能用一次（第二次 → `CODE_INVALID`）
- T99 `REGISTRATION_MODE=closed` → 403 `REGISTRATION_CLOSED`；`invite` → 舊流程可用
- 既有 T1–T91 零回歸

## 8. 不在本次範圍

- Cloudflare Turnstile（機器人驗證）→ 建議下一階段（需 owner 在 Dashboard 建 site key）
- 管理端「待審核」佇列
