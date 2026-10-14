# 15. AtWhoMail API 認證速查表（端點／標頭／範例）

> 本文件**不含任何憑證值**。值一律留在本機檔案／Cloudflare Secret，不進版控。
> 建立：2026-10-13（Phase 1 上線當日）

---

## 0. 先分清兩個世界

| 你想做什麼 | 正確憑證 | 打哪個網址 | 標頭 |
|---|---|---|---|
| 管理 **Cloudflare 帳號**（DNS／Workers／D1／Pages／tunnel） | `wrangler login` 的 OAuth **或** Cloudflare API Token | `https://api.cloudflare.com/...` | `Authorization: Bearer <CF token>` |
| 呼叫**本站 API**（收發信／邀請碼／備份） | **App 救援 token** 或登入取得的 **JWT** | `https://atwhomail-api.ulhome.workers.dev` | `x-admin-token: <救援 token>` 或 `Authorization: Bearer <JWT>` |

---

## 1. 兩種認證方式

| 方式 | 標頭 | 效力 | 取得位置 |
|---|---|---|---|
| **救援 token** | `x-admin-token` | **等同 owner**：讀備份（含所有信件）、管理邀請碼、改任何地址密碼、停權、改 owner 密碼 | 本機 `packages/api/.dev.vars` 的 `ADMIN_TOKEN`；production 為 Cloudflare Secret（同名） |
| **登入 JWT** | `Authorization: Bearer <token>` | `owner` scope＝全部地址；`mailbox` scope＝僅該地址 | 由 §2 的登入端點取得 |

- 兩者**不可混用**：救援 token 不放在 `Authorization`，JWT 不放在 `x-admin-token`。
- JSON 請求一律加 `Content-Type: application/json`。
- **CORS** 只影響瀏覽器跨域呼叫；用 curl／PowerShell 從任何主機打都不受影響。

---

## 2. 認證端點

| 端點 | 請求 | 回應 | 說明 |
|---|---|---|---|
| `POST /api/auth/login` | `{"username":"<owner 帳號>","password":"..."}` | `{"token":"...","session":"owner","user":{...}}` | 僅 `role='owner'`；username 會被轉小寫 |
| `POST /api/auth/mailbox-login` | `{"email":"<地址>","password":"..."}` | `{"token":"...","session":"mailbox","address":{...}}` | 單一信箱登入 |
| `GET /api/auth/whoami` | — | session 資訊 | 驗證目前 token |
| `POST /api/auth/owner-password` | `{"new_password":"..."}`（需 `x-admin-token`） | `{"ok":true,"user_id":N}` | 重設 owner 密碼（≥8 字元）；密碼只存雜湊，無法還原 |
| `POST /api/auth/register` | `{"invite_code":"...","username":"...","password":"..."}` | `{"token":"...","session":"mailbox","address":{...}}` | 訪客註冊（需有效邀請碼） |

---

## 3. 端點 × 認證對照

| 認證 | 端點 |
|---|---|
| **公開** | `GET /api/health`、`POST /api/auth/login`、`POST /api/auth/mailbox-login`、`POST /api/auth/register` |
| **`x-admin-token`（或 owner JWT）** | `POST /api/auth/owner-password`、`POST /api/invites`、`GET /api/invites`、`DELETE /api/invites/:id`、`PATCH /api/users/:id/status`、`POST /api/email-addresses`、`GET /api/email-addresses`、`PATCH /api/email-addresses/:id`、`DELETE /api/email-addresses/:id`、`GET /api/backup/changes`、`GET /api/backup/r2/objects`、`GET /api/backup/r2/object` |
| **JWT（owner 或 mailbox）** | `GET /api/auth/whoami`、`GET /api/me`、`GET /api/mail/inbox`、`GET /api/mail/counts`、`GET /api/mail/:id`、`GET /api/mail/:id/html`、`GET /api/mail/:id/text`、`GET /api/mail/:id/attachments`、`GET /api/attachments/:id`、`PATCH /api/mail/:id/read|archive|folder`、`DELETE /api/mail/:id`、`POST /api/mail/send`、`GET /api/email-addresses/:id`、`PATCH /api/email-addresses/:id/password` |

> ⚠️ owner 的 scope 只含**自己名下**的地址：owner／救援 token 對**訪客**地址執行
> `DELETE /api/email-addresses/:id` 會回 **404**（見 `docs/14` 附錄 B.5 待辦 1）。

---

## 4. 常用範例（bash / git-bash）

```bash
BASE=https://atwhomail-api.ulhome.workers.dev
ADMIN=$(cat ~/.atwhomail-admin-token)          # 救援 token（檔案 600，勿進版控）

# 健康檢查
curl -sS "$BASE/api/health"

# 用救援 token 讀備份變更
curl -sS "$BASE/api/backup/changes?limit=1" -H "x-admin-token: $ADMIN"

# 建立邀請碼
curl -sS -X POST "$BASE/api/invites" \
  -H "x-admin-token: $ADMIN" -H "Content-Type: application/json" \
  -d '{"max_uses":1,"expires_in_hours":72,"note":"給某人"}'

# owner 登入 → 取 JWT
JWT=$(curl -sS -X POST "$BASE/api/auth/login" -H "Content-Type: application/json" \
      -d '{"username":"<owner 帳號>","password":"<owner 密碼>"}' | python -c "import sys,json;print(json.load(sys.stdin)['token'])")

# 用 JWT 讀收件匣
curl -sS "$BASE/api/mail/inbox" -H "Authorization: Bearer $JWT"
```

## 5. 常用範例（PowerShell）

```powershell
$BASE = 'https://atwhomail-api.ulhome.workers.dev'
$ADMIN = (Get-Content $HOME\.atwhomail-admin-token -Raw).Trim()
$H = @{ 'x-admin-token' = $ADMIN }

Invoke-RestMethod -Method Get  -Uri "$BASE/api/backup/changes?limit=1" -Headers $H
Invoke-RestMethod -Method Post -Uri "$BASE/api/invites" -Headers $H -ContentType 'application/json' -Body '{"max_uses":1,"expires_in_hours":72}'

$r = Invoke-RestMethod -Method Post -Uri "$BASE/api/auth/login" -ContentType 'application/json' -Body '{"username":"<owner 帳號>","password":"<owner 密碼>"}'
Invoke-RestMethod -Method Get -Uri "$BASE/api/mail/inbox" -Headers @{ Authorization = "Bearer $($r.token)" }
```

> 註：不要在指令片段中使用 `*` 萬用字元（部分聊天／文件系統會把它轉成 `***` 而破壞指令）。

---

## 6. 相關文件

| 文件 | 內容 |
|---|---|
| `docs/05-api-spec.md` | API 完整規格（請求／回應／錯誤碼） |
| `docs/11-launch-checklist.md` | 上線檢查清單 |
| `docs/13-open-registration-design.md` | 訪客註冊設計（C1–C8 補償控制、D1–D7 決策） |
| `docs/14-phase1-implementation-brief.md` | Phase 1 實作規格 ＋ **附錄 B 部署紀錄／待辦** |
| `docs/07-cloudflare-resources.md` | Cloudflare 資源與權限 |
