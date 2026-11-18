---
title: 登入通知信（D40）
status: 現況
updated: 2026-11-18
read-when: 要調整登入通知、contact_email、登入告警或未來單一裝置政策時
---

# 40 — 登入通知信（D40）

> 建立：2026-11-18｜狀態：**已上線（API `ef2711d7`）**
> 政策：owner 選擇 **A：只發 alert，不限制裝置**。同一帳號仍可在多個裝置登入。

## 1. 行為

以下三種**成功登入**會寄一封通知到 `users.contact_email`：

| 登入方式 | 端點 | 通知中的「方式」 |
|---|---|---|
| 信箱地址＋密碼 | `POST /api/auth/mailbox-login` | 信箱地址＋密碼 |
| AtWho ID／備用 Email＋密碼 | `POST /api/auth/user-login` | AtWho ID／備用 Email＋密碼 |
| Google OAuth | `/api/auth/oauth/google/callback` | Google 登入 |

- **登入失敗不寄。**
- 沒有 `contact_email` 的帳號不寄。
- `mail.atwho.org` 的 owner 管理員登入（`POST /api/auth/login`）**不寄**，避免管理操作被通知信淹沒。
- 通知信不阻擋登入；寄送失敗只寫 server log。

## 2. 通知內容

只含帳號安全資訊，不含密碼、驗證碼、信件內容：

```text
您的 AtWho 帳號剛剛完成一次登入：

帳號：alice
信箱：alice@atwho.org
時間：2026-11-18 07:30:00 UTC
IP：203.0.113.9
國別：TW
裝置：Mozilla/5.0 ...
方式：信箱地址＋密碼

如果這是你本人，不需要做任何事。
如果這不是你，請立即變更密碼；若無法登入，請使用「忘記密碼」。
```

- 寄件者：`noreply@atwho.org`
- 收件者：`users.contact_email`（註冊驗證 Email／Google Email）
- 國別取自 Cloudflare `CF-IPCountry`；沒有則顯示「未知」
- 裝置取 `User-Agent`，最多 300 字
- 純文字，不含 HTML（避免使用者輸入的 User-Agent 造成 HTML injection）

## 3. 關閉方式

`LOGIN_ALERTS_DISABLED=true`（Worker vars）可暫時關閉。預設未設定＝啟用。

測試環境（`vitest.config.ts`）預設設為 `true`，避免既有測試的 `sentMails` 計數被影響；
`login-alert.spec.ts` 會自行打開。

## 4. 實作

| 項目 | 位置 |
|---|---|
| 通知信 helper | `packages/api/src/index.ts` 的 `sendLoginAlert` |
| 呼叫點 | `mailbox-login`／`user-login`／Google OAuth callback |
| 背景執行 | `runInBackground`（`executionCtx.waitUntil`） |
| 測試 | `packages/api/test/login-alert.spec.ts` |

## 5. 明確不包含

- **不限制裝置數量**：目前多個裝置仍可同時登入，只是每次登入都會寄信。
- **不是「新裝置才通知」**：沒有 device registry；同一個裝置每次登入也會收到通知。
- **不會即時通知已登入的裝置**：沒有 websocket／站內即時訊息。
- **不會撤銷其他裝置的 session**：JWT 仍是 24 小時 stateless。
- 尚未涵蓋 `mail.atwho.org` 的 owner 管理登入。

## 6. 未來若要升級

1. 新增 `login_devices`／`auth_sessions`，只在首次看到 device_id 時通知。
2. 加入「活躍裝置」列表與「登出其他裝置」。
3. 若要跨五系統即時撤銷，app token 需加 `sid` 並定期 introspect，或縮短 TTL。

## 7. 部署

- 不需要 migration。
- 只需要部署 API。
- 前端不需要重新部署。

### 2026-11-18 部署紀錄

| 項目 | 結果 |
|---|---|
| API Worker | ✅ `ef2711d7-e983-4507-a761-420760cb6cd9` |
| Migration | 不需要 |
| `LOGIN_ALERTS_DISABLED` | 未設定 → 通知預設啟用 |
| 前端 | 不需要重新部署 |
| 自動測試 | ✅ workerd 497／web DOM 136 |

> Production 未用真實帳號刻意觸發通知，避免寄出測試信；登入通知由 `login-alert.spec.ts` 覆蓋。

## 8. 測試

```bash
cd D:\Mail\Atwhomail
pnpm exec vitest run packages/api/test/login-alert.spec.ts
```

覆蓋：mailbox-login、user-login、無 contact_email、登入失敗、`LOGIN_ALERTS_DISABLED=true`。
