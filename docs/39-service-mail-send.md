---
title: 外部系統只寄信 service token（D39）
status: 現況
updated: 2026-11-16
read-when: Trace-Flow／外部系統要串 Atwhomail 發信、建立 service token、reply_to 或 Idempotency-Key 時
---

# 39 — 外部系統「只寄信」service token（D39）

> 建立：2026-11-16｜狀態：**已上線（migration `0020`、API `32411b6b`）**
> 適用：Trace-Flow 等只需要**單向發信**、不需要讀信箱／回信／管理權限的系統。

## 1. 為什麼不用 admin token／mailbox JWT

| 方案 | 憑證 | 能做的事 | 問題 |
|---|---|---|---|
| A（採用） | service token | 只能從綁定地址寄信 | 需新增 Mail 程式（本文件） |
| B | `flow@` 的 mailbox JWT | 寄信＋讀 `flow@` 信箱 | 需保存地址密碼、24 小時刷新；外部系統可讀信箱 |
| C | `x-admin-token` | **owner 全部權限** | token 外洩＝全部 owner 信件／訪客／備份失守；不採用 |

D39 採 A：**service token 只綁定一個寄件地址，只能呼叫 `POST /api/service/mail/send`**。

## 2. 一次性設定

### 2.1 建立寄件地址（不需要信箱密碼）

在 `mail.atwho.org` → 地址管理建立 `flow@atwho.org`，或使用 owner API：

```http
POST /api/email-addresses
x-admin-token: <owner rescue token>   # 或 owner JWT
Content-Type: application/json

{ "local_part": "flow" }
```

- 不帶 `password` → 此地址**不能登入信箱**，但仍可寄信。
- 之後可用一般地址管理調整 `can_send`／配額；service token 的每小時／每日上限是獨立的。

### 2.2 建立 service token

```http
POST /api/admin/service-tokens
x-admin-token: <owner rescue token>   # 或 owner JWT
Content-Type: application/json

{
  "name": "trace-flow",
  "address_id": 123,
  "hourly_limit": 60,
  "daily_limit": 500
}
```

回應（**明碼 token 只出現這一次**）：

```json
{
  "id": 1,
  "name": "trace-flow",
  "token": "atw_svc_<64 hex>",
  "address_id": 123,
  "email": "flow@atwho.org",
  "hourly_limit": 60,
  "daily_limit": 500
}
```

- DB 只存 `SHA-256(token)`；遺失只能撤銷重建。
- `hourly_limit`／`daily_limit` 可依實際流量調整；預設 60／500。
- token 只在後端環境變數保存；**不得**進前端、URL、log、git。

### 2.3 撤銷

```http
DELETE /api/admin/service-tokens/:id
```

撤銷後下一個請求立即 401。

## 3. 寄信 API

```http
POST /api/service/mail/send
Authorization: Bearer atw_svc_...
Content-Type: application/json
Idempotency-Key: <可選；同一 key 24 小時內只寄一次>
```

```json
{
  "to": ["user@example.com"],
  "subject": "驗證碼",
  "text": "您的驗證碼是 123456，5 分鐘內有效。",
  "reply_to": "support@atwho.org"
}
```

| 欄位 | 必填 | 說明 |
|---|---|---|
| `from` | — | 可省略；預設 token 綁定地址。若提供必須完全相同，否則 403。**只能是地址**，不支援 `Name <addr>` |
| `to` | ✅ | 陣列（或單一字串）；總收件人 ≤50 |
| `cc` / `bcc` | — | 陣列，計入 50 人 |
| `subject` | ✅ | 字串 |
| `text` / `html` | 至少一個 | 驗證碼只需 `text` |
| `reply_to` | — | 標準 `Reply-To`；也接受 camelCase `replyTo` |
| `attachments` | — | 總大小約 5 MiB |
| `Idempotency-Key` | — | header；1–128 個可見 ASCII 字元 |

### 回應

```json
{
  "messageId": "<...>",
  "send_status": "sent",
  "from": "flow@atwho.org",
  "to": ["user@example.com"],
  "delivery_scope": "external"
}
```

### 錯誤

格式：`{ "error": { "code": "...", "message": "..." } }`

| HTTP | code | 說明 |
|---|---|---|
| 401 | `UNAUTHORIZED` | token 無效／已撤銷 |
| 403 | `FROM_NOT_ALLOWED` | `from` 不是 token 綁定地址 |
| 403 | `SERVICE_SENDER_UNAVAILABLE` | 綁定地址停用／刪除 |
| 403 | `ACCOUNT_SUSPENDED` / `SEND_NOT_ALLOWED` | 上層帳號或地址被停用 |
| 400 | `INVALID_REPLY_TO` | `reply_to` 格式錯誤 |
| 400 | `INVALID_IDEMPOTENCY_KEY` | key 格式錯誤 |
| 409 | `IDEMPOTENCY_CONFLICT` | 同 key 但請求內容不同 |
| 409 | `IDEMPOTENCY_IN_PROGRESS` | 同 key 正在處理中（可稍後重試） |
| 429 | `QUOTA_EXCEEDED` | 超過 service 每日上限 |
| 429 | `RATE_LIMITED` | 超過 service 每小時上限 |
| 413 | `PAYLOAD_TOO_LARGE` | 超過 5 MiB |
| 502 | `SEND_FAILED` | Cloudflare 寄送失敗 |

## 4. Idempotency-Key

- 建議每次「邏輯寄送」帶一個 UUID；重試時帶**相同** key。
- 同 key＋同內容：
  - 第一次正常寄出；
  - 第二次直接回傳第一次的 `messageId`，**不重寄、不扣配額**。
- 同 key＋不同內容 → `409 IDEMPOTENCY_CONFLICT`。
- 保留 24 小時。
- 處理中（例如前一個請求還在寄）→ `409 IDEMPOTENCY_IN_PROGRESS`；請稍後用同一 key 重試。
- 資料表只存請求 hash 與回應 metadata，**不存信件內文**。

## 5. reply_to

- 只影響收件者按「回覆」時的地址，不影響寄件授權、SPF／DKIM／DMARC。
- 外部寄送會傳給 Cloudflare Email Service；本地直送與寄件備份的 `.eml` 也會寫入 `Reply-To`。
- 若不需要回信，可省略；回覆會回到 `From`（`flow@atwho.org`）。

## 6. 與一般寄信的差異

| 項目 | `/api/mail/send` | `/api/service/mail/send` |
|---|---|---|
| 認證 | owner／mailbox JWT、rescue token | service token |
| 寄件地址 | session 權限內 | token 綁定，不可更換 |
| 讀信箱 | 可以 | **不可以** |
| 配額 | 地址 `daily_send_quota`＋每小時 10 | token 的 `daily_limit`／`hourly_limit` |
| 暖機期 | 有 | 跳過 |
| 配額提醒信 | 會寄 | 不寄，呼叫方處理 429 |
| reply_to | ✅ | ✅ |
| Idempotency-Key | ✅ | ✅ |

`scope='app'`（D37 SSO app token）仍然**不可**用於寄信。

## 7. 測試

```bash
cd D:\Mail\Atwhomail
pnpm exec vitest run packages/api/test/service-send.spec.ts
pnpm typecheck
```

覆蓋：token 建立／列表／撤銷、固定寄件地址、reply_to（外部＋本地 .eml）、
idempotency 重播／衝突、service 每小時／每日上限。

## 8. 部署順序（owner）

1. 套 migration `0020_service_mail_send.sql`（remote）
2. 部署 API
3. 建立 `flow@atwho.org`（可無密碼）
4. 建立 service token，將明碼交給 Trace-Flow（私下交付）
5. Trace-Flow 設定 `ATWHOMAIL_BASE_URL` 與 service token
6. 先寄到 `@atwho.org` 內部地址確認 `delivery_scope:"internal"`，再寄到可控外部信箱

### 2026-11-16 部署紀錄

| 項目 | 結果 |
|---|---|
| migration `0020` | ✅ 已套用 remote `mail-d1` |
| API Worker | ✅ `32411b6b-f5d4-44bc-b9a3-fff831928a50` |
| `flow@atwho.org` | ✅ address id `32`、active、`has_password=0` |
| service token | ✅ id `1`、`60/hour`、`500/day`；明碼只存本機金鑰檔，未進 repo |
| 煙霧測試 | ✅ 內部寄送 200（`delivery_scope:"internal"`）；同 `Idempotency-Key` 重播回相同 `messageId` |

## 9. 尚未支援

- 非同步退信（bounce）通知／查詢：呼叫方只會拿到同步的 `send_status:"sent"`。
- 讀取 `flow@` 信箱（service token 刻意不允許）。
- Webhook。
