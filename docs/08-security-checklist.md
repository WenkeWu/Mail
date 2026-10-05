# 08 — Security Checklist

> 對應 PRD §十一 全部項目。每個威脅 → 具體設計對策 → 實作位置。
> 標記：🔴 = 上線前必做；🟡 = MVP 可簡化但要有計畫。

## 1. Authentication / Authorization

| # | 項目 | 對策 | 位置 | 等級 |
|---|---|---|---|---|
| 1 | 使用者註冊/登入 | username + password（argon2id hash）；session = 短期 JWT（Worker 簽署，secret 存 `.dev.vars`/Secrets） | api/src/auth.ts | 🔴 |
| 2 | 密碼規則 | 最少 8 字元、有雜湊鹽；登入 rate limit（見 §8） | auth.ts | 🔴 |
| 3 | JWT 生命週期 | access token 15 分鐘 + refresh token（D1 記錄、可撤銷）；MVP 可簡化為長效 token + 可 revoke 清單 | auth.ts | 🟡 |
| 4 | Backup endpoint 認證 | 獨立 `BACKUP_TOKEN`（與使用者 JWT 完全分開、高權限唯讀 backup） | routes/backup.ts | 🔴 |

## 2. Ownership checking（資源隔離）

| # | 項目 | 對策 | 等級 |
|---|---|---|---|
| 5 | 地址/信件/附件只能被 owner 存取 | 所有查詢帶 `owner_user_id = ?`（WHERE 層級強制，不是撈出來再比對） | 🔴 |
| 6 | 非 owner 存取 | 一律回 404（不洩漏資源存在性） | 🔴 |
| 7 | IDOR 防護 | `GET /api/mail/:id` 等全部帶 owner 條件；測試覆蓋「A 的 id 給 B 取」→ 404 | 🔴 |

## 3. From address spoof protection（寄信）

| # | 項目 | 對策 | 等級 |
|---|---|---|---|
| 8 | From 必須屬於自己 | `POST /api/mail/send` 時查 `email_addresses`：`email = from AND user_id = 呼叫者 AND status = 'active'`，否則 **403** | 🔴 |
| 9 | 不能寄到自己的 catch-all 造成自我迴圈 | 寄件目標若是自家 domain，仍允許（測試用），但要計入 rate limit 並可停用 | 🟡 |
| 10 | 退信偽造 | NDR 處理只信任 Cloudflare bounce MX 特徵；不因「信件說自己是退信」就改 send_status（需對應 sent message + envelope 特徵） | 🔴 |

## 4. SQL injection

| # | 項目 | 對策 | 等級 |
|---|---|---|---|
| 11 | 全部 SQL | 一律 **prepared statements / 參數化查詢**（D1 `stmt.bind()`）；禁止字串拼接 SQL | 🔴 |
| 12 | 排序/方向參數 | 白名單映射（`sort=received_at`），不直接拼進 SQL | 🔴 |

## 5. MIME / Email 攻擊

| # | 項目 | 對策 | 等級 |
|---|---|---|---|
| 13 | MIME parse 攻擊 | postal-mime 只 parse headers；不信任 Content-Type、不展開畸形結構；parse 包 try/catch，失敗的信仍保留 raw 於 R2 但標 flag | 🔴 |
| 14 | header injection（寄信） | subject/from 等一律經 zod 驗證：禁止 `\r\n`、控制字元 | 🔴 |
| 15 | 大量巢狀 MIME / zip bomb | 附件大小、數量上限（單封附件總量 ≤ 收信 25 MiB / 寄信 5 MiB）；不做解壓縮掃描（🟡 見 §7） | 🔴 |
| 16 | HTML email 攻擊 | 外部 HTML **永不直接 render**：一律 sanitize（DOMPurify 等價規則）後存 R2 `html_r2_key`；剝離 script/iframe/事件屬性/遠端資源（MVP 直接剝離遠端圖片，只留 CID 內嵌） | 🔴 |
| 17 | 信件內的連結 | 前端 render 時一律 `rel="noopener noreferrer"` + 可選跳轉確認頁 | 🟡 |

## 6. Attachment 安全

| # | 項目 | 對策 | 等級 |
|---|---|---|---|
| 18 | path traversal | R2 key 一律由 D1 查得（`r2_key`），**不接受使用者輸入的 key/路徑**；stored_filename 依 04 文件 sanitize | 🔴 |
| 19 | 檔名 sanitize | 見 04 文件 §2（basename、控制字元、長度、保留字元） | 🔴 |
| 20 | 下載 | Content-Type 由 D1 記錄提供 + 強制 `Content-Disposition: attachment`（inline 除外）；不執行內容嗅探 | 🔴 |
| 21 | 惡意檔案掃描 | MVP：**不提供** AV 掃描（Worker CPU 限制），改為：檔名/型別白名單警示 + 前端提示「不可信附件」；之後可接 VirusTotal API（Worker 外） | 🟡 |
| 22 | SVG/HTML 附件 | 視為潛在 XSS：強制下載、禁止 inline 預覽 | 🔴 |

## 7. XSS（App 端）

| # | 項目 | 對策 | 等級 |
|---|---|---|---|
| 23 | React render | 預設轉義；`dangerouslySetInnerHTML` 只用 sanitized HTML；CSP header（`default-src 'self'`…） | 🔴 |
| 24 | subject/preview 顯示 | 一律純文字 render（React 自動轉義） | 🔴 |

## 8. Rate limiting / Abuse

| # | 項目 | 對策 | 等級 |
|---|---|---|---|
| 25 | 寄信 rate limit | 每 user：例如 10 封/分鐘、200 封/天（數值 Phase 10 依配額校準）；用 D1 計數或 Workers Rate Limiting binding | 🔴 |
| 26 | 地址建立 rate limit | 每 user 每小時建立上限（防拿來當 spam 跳板大量開地址） | 🔴 |
| 27 | 登入 rate limit | 失敗 5 次鎖 15 分鐘 | 🔴 |
| 28 | 公開 API 全局限流 | Workers Rate Limiting / Turnstile（前端） | 🟡 |
| 29 | 濫發防護（sending abuse） | 上述限流 + Cloudflare 每日配額 + suppression list；**大規模開放註冊前**須重新評估（帳號風險） | 🔴 |

## 9. 日誌 / Audit

| # | 項目 | 對策 | 等級 |
|---|---|---|---|
| 30 | audit log | D1 `audit_log` 表：誰（user_id）在何時對哪個資源做了什麼（create/delete/send/status change）；地址刪除與寄信必記 | 🔴 |
| 31 | 收信失敗記錄 | email-handler 失敗 → Workers Logs + D1 `processing_errors`（raw 已存 R2 者可補處理） | 🟡 |
| 32 | 敏感資料 | 密碼 hash 不進 log；log 不印 token / raw email 內容 | 🔴 |

## 10. 其他平台層

| # | 項目 | 對策 | 等級 |
|---|---|---|---|
| 33 | Secrets | API keys / JWT secret 一律 Workers Secrets（`wrangler secret put`），**不進 wrangler.jsonc / git** | 🔴 |
| 34 | CORS | 只允許自家 origin；`OPTIONS` 預檢正確處理 | 🔴 |
| 35 | Compliance | 寄信符合 CAN-SPAM/GDPR/CASL：信件含寄件者身份與退訂（自家 domain 使用者的 transactional mail 也要有退訂管道）；Cloudflare 有權依 abuse 停用帳號 | 🔴 |
| 36 | 密碼重設 | MVP 可先「管理者重設」；完整流程（寄驗證信到自家信箱）Phase 11 後補 | 🟡 |

## 11. Model C 補充（2026-09-02：地址即信箱帳號）

| # | 項目 | 對策 | 等級 |
|---|---|---|---|
| 37 | 地址密碼存放 | 與 user 密碼相同標準：argon2id + 個別 salt；永不明文儲存/記錄 | 🔴 |
| 38 | Mailbox 登入限制 | disabled / deleted 的地址不可登入（401）；登入嘗試 per-address rate limit（5 次失敗鎖 15 分鐘） | 🔴 |
| 39 | Scope 強制（信件） | Mailbox session 的所有信件查詢 WHERE 帶 `address_id = session.address_id`（SQL 層強制，非先撈再濾）；測試「alice 登入看不到 bob 的信」 | 🔴 |
| 40 | Scope 強制（寄信） | Mailbox session 的 From 只能等於自己的 address；Owner session 的 From 必須是名下地址 | 🔴 |
| 41 | 密碼重設 | Owner 可重設名下地址；mailbox 本人可改自己密碼（需舊密碼）；重設/修改後舊 JWT 失效（token_version 欄位或縮短效期） | 🔴 |
| 42 | 初始密碼 | Owner 建立地址時設定，或系統產生一次性密碼 → 首次登入強制更換（可選 MVP 簡化：直接設定，無一次性流程） | 🟡 |
| 43 | Audit | mailbox 登入成功/失敗、密碼重設都要記 audit_log（哪個 address、誰觸發） | 🔴 |
| 44 | 密碼重複使用 | 同一地址不得與其他地址同密碼無法強制（hash 無法比對）——用密碼規則（最少 10 字元）＋洩漏密碼檢查（可選） | 🟡 |

## 12. 測試對應

| 威脅 | 測試 |
|---|---|
| IDOR / ownership | 用 user A token 存取 B 的 mail/address/attachment → 404 |
| From spoof | 用不屬於自己的 from 寄信 → 403 |
| Path traversal | 附件檔名含 `../../`、`\`、`%2e%2e` → 儲存 key 不受影響、下載 404 |
| HTML XSS | 信件含 `<script>` / `<img onerror>` → 顯示為純文字或 sanitized |
| Header injection | subject 含 `\r\nBcc: x@y` → 422 |
| Rate limit | 短時間連發寄信 → 429 |
| Mailbox scope | alice 登入：看不到 bob 的信 / 不能以 bob@ 寄信（403/404） |
| Mailbox 登入 | disabled 地址登入 → 401；密碼錯 5 次 → 鎖定 |
| 密碼重設 | owner 重設後，alice 舊 token 失效 |
