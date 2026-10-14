# 14. Phase 1 實作指令包（給實作 agent 的規格書）

| 項目 | 內容 |
|---|---|
| **對象** | 實作 agent（Claude Code，於 VS Code 內） |
| **依據** | `docs/13-open-registration-design.md` **v0.2**（設計已定案：D1–D7 見該文件 §10.3） |
| **狀態** | 🟡 待 owner final review → 交實作 |
| **範圍** | **Phase 1 後端 ＋ 前端（註冊／配額）**；**不含**部署、不含 Access 設定變更 |
| **預設配額** | C1 = **20 封/日**、C2 = **前 24 小時 5 封**、C3 = **10 封/小時**（見 §4.3；皆須**可調**，不得寫死於多處） |

> ⚠️ **改名提醒**：本專案有兩個「mail」概念 —— **郵件收發**（MX/DKIM/DMARC，不經 Access）與 **網頁 UI**（`mail.atwho.org`，經 Access）。本文件只涉及**應用層（API ＋ web）**，**不得**更動任何郵件路由或 DNS。

---

## 1. 前置閱讀（實作前必讀）

| # | 讀什麼 | 為什麼 |
|---|---|---|
| 1 | `docs/13-open-registration-design.md` v0.2（全文） | 目標、風險、決策、補償控制 C1–C8 |
| 2 | 你**目前正在編輯**的 `packages/api/src/index.ts`（含你自己的未提交變更） | 新端點要接在同一套 Hono 路由與 `requireSession`／`err()` 慣例上 |
| 3 | `migrations/0001`–`0005` | 既有 schema 與 migration 風格 |
| 4 | `packages/api/test/api.integration.spec.ts` | 測試慣例（整合測試、真實 D1 binding） |

---

## 2. 🚧 併行保護規則（**最高優先，違反即視為失敗**）

> 目前**有兩個 agent 在同一個 repo 工作**（你 ＋ 另一位助手）。以下是硬性規則：

| # | 規則 | 原因 |
|---|---|---|
| P1 | **禁止 `git add -A` / `git add .` / `git commit -a`** | 會把另一位助手的檔案（`docs/13`、`docs/14`、`scripts/dev-web.mjs`、`scripts/vite.tunnel.config.ts`）掃進你的 commit。**只 add 你自己改的明確路徑** |
| P2 | **禁止修改**：`packages/api/wrangler.jsonc` 的 `ALLOWED_ORIGINS`、任何 Access 應用、任何 DNS 記錄 | 這些已由 owner 定案並上線（CORS 白名單已收斂為 4 個來源） |
| P3 | **禁止部署**（`wrangler deploy`、Dashboard 部署） | 本機 wrangler 未登入；部署時機由 owner 決定 |
| P4 | **禁止執行遠端 migration**（`--remote`） | 會動 production D1；遠端套用由 owner 執行 |
| P5 | **禁止讀寫** `.dev.vars`、任何 secret、`~/.atwhomail-*` | 機密 |
| P6 | **不得改動 owner 既有行為**（owner 登入／既有端點語意／既有測試預期） | 這是迴歸底線 |
| P7 | 動工前先 `git status` 確認；**只碰 §3 列出的檔案** | 避免互相覆蓋 |
| P8 | 完成後**必須**跑 canonical 三指令並全綠 | `pnpm test` / `pnpm lint` / `pnpm build`（於 `D:\Mail\Atwhomail`） |

---

## 3. 交付物清單（Definition of Deliverables）

> 目前狀態註記（2026-10-08）：owner 帳號名稱仍為 `owner`（未改名）；owner 密碼已由 owner 設定完成 ✅；**改名須待新程式部署後執行**（見 §4.7 與 N11）。

| # | 交付物 | 檔案 | 型態 |
|---|---|---|---|
| D1 | Migration | `migrations/0006_visitor_registration.sql` | 新檔 |
| D2 | API：邀請碼 3 端點 | `packages/api/src/index.ts` | 修改（append） |
| D3 | API：註冊 1 端點 | 同上 | 修改 |
| D4 | API：`/api/me` | 同上 | 修改 |
| D5 | API：停權端點 | 同上 | 修改 |
| D6 | API：寄信路徑加配額／限流 | 同上（`/api/mail/send`） | 修改 |
| D7 | 測試 | `packages/api/test/api.integration.spec.ts`（或新增 `registration.spec.ts`） | 修改／新檔 |
| D8 | 前端：註冊畫面＋配額顯示 | `web/`（你現有結構） | 修改 |
| D9 | 文件同步 | `docs/04`、`docs/05`、`docs/11` | 修改（**以你現有版本為基礎 append，不要覆蓋**） |
| D10 | 備份鏡像設定 | `packages/backup-agent`（設定） | 修改：納入 `invites` 表 |
| D11 | **owner 帳號名稱可設定**（移除硬編碼 `'owner'`） | `packages/api/src/auth.ts`、`packages/api/src/index.ts` | 修改（見 §4.7） |

---

## 4. 規格

### 4.1 D1：Migration `0006_visitor_registration.sql`

```sql
-- 0006_visitor_registration.sql — Phase 1 訪客註冊（docs/13 v0.2）
-- 設計：訪客以邀請碼註冊 → 建立 users(role=visitor) + 1 個 email_addresses(can_send=1, 配額)
-- 注意：本檔不得包含 DROP TABLE / DELETE 等破壞性語句

-- 1) 使用者角色與邊緣身分
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'owner'
  CHECK (role IN ('owner','visitor'));
ALTER TABLE users ADD COLUMN access_email TEXT;                  -- Cloudflare Access 帶來的 email（稽核；R5）

-- 2) 寄信權限與配額（Phase 1 必要）
ALTER TABLE email_addresses ADD COLUMN can_send INTEGER NOT NULL DEFAULT 1;
ALTER TABLE email_addresses ADD COLUMN daily_send_quota INTEGER NOT NULL DEFAULT 20;
ALTER TABLE email_addresses ADD COLUMN sent_today INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_addresses ADD COLUMN quota_reset_at INTEGER;   -- epoch ms；NULL = 尚未初始化
ALTER TABLE email_addresses ADD COLUMN first_send_at INTEGER;    -- 暖機期起算（C2）

-- 3) 邀請碼
CREATE TABLE invites (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,             -- 隨機 ≥24 字元（base64url 或 hex）
  created_by  INTEGER NOT NULL REFERENCES users(id),
  max_uses    INTEGER NOT NULL DEFAULT 1,
  used_count  INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER,                          -- epoch ms；NULL = 不過期
  note        TEXT,                             -- 例：「給小明 2026-10」
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_invites_status ON invites(status, expires_at);

-- 4) 稽核
CREATE TABLE registration_audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event        TEXT NOT NULL,   -- register_ok / register_rejected / login_failed /
                                -- send_rejected_quota / send_rejected_rate / send_rejected_notallowed / auto_suspended
  user_id      INTEGER,
  address_id   INTEGER,
  access_email TEXT,
  ip           TEXT,
  user_agent   TEXT,
  detail       TEXT,            -- JSON 字串（例如 {"code":"INVITE_INVALID","invite":"abc…"}）
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_reg_audit_time  ON registration_audit(created_at DESC);
CREATE INDEX idx_reg_audit_event ON registration_audit(event, created_at DESC);
```

**Migration 要求**

| 要求 | 說明 |
|---|---|
| 本地執行 | 必須先在本地 D1 套用並跑通測試（指令見 §6） |
| 遠端 | **不得**自行執行（P4）；在回報中註明「本地已套用、遠端待 owner」 |
| 冪等性 | 以既有 migration 風格為準（`0004` 用 `IF NOT EXISTS`）|
| 不得修改既有欄位 | 只新增 |

### 4.2 D2–D6：API 契約（全部掛在既有 Hono app 與 `requireSession` 慣例上）

**共通規則**：錯誤一律用既有 `err(c, CODE, message, status)`；成功回應格式與既有端點一致；稽核寫入用 `c.executionCtx.waitUntil(...)`（不阻塞回應）；時間一律 `Date.now()`（epoch ms）。

| 方法 | 路徑 | 權限 | Request | Response | 備註 |
|---|---|---|---|---|---|
| `POST` | `/api/invites` | owner（`requireSession` 且 scope=owner）或 `x-admin-token` | `{max_uses?:number=1, expires_in_hours?:number, note?:string}` | `201 {code, max_uses, expires_at}` | `code` 用 `crypto.getRandomValues` 產 ≥24 字元（base64url）；**不得**用可預測值 |
| `GET` | `/api/invites` | owner | — | `200 {invites:[{id,code,masked_code,max_uses,used_count,expires_at,status,note,created_at}]}` | `masked_code` 只露前 4 碼＋…（其餘列表情境避免全碼外洩） |
| `DELETE` | `/api/invites/:id` | owner | — | `200 {ok:true}` | 軟停用：`status='revoked'`（**不 DELETE 資料列**） |
| `POST` | `/api/auth/register` | **公開**（需邀請碼） | `{invite_code:string, username:string, password:string, local_part?:string}` | `201 {token, session:"mailbox", address:{id,email}}` | 見下方流程 |
| `GET` | `/api/me` | 任何有效 session | — | `200 {role, session:"owner"\|"mailbox", addresses:[{id,email,can_send,daily_send_quota,sent_today,quota_reset_at}], username}` | 供前端顯示配額與權限 |
| `PATCH` | `/api/users/:id/status` | owner | `{status:"active"\|"suspended"}` | `200 {ok:true}` | 停權需**立即**使登入與寄信失效 |

**`POST /api/auth/register` 流程（嚴格順序）**

| 步 | 動作 | 失敗時 |
|---|---|---|
| 1 | 限流檢查（沿用 `auth_attempts`，key：`ip:<ip>`） | `429 RATE_LIMITED` |
| 2 | `REGISTRATION_DISABLED` 開關檢查（可用 var，預設 `"false"`） | `403 REGISTRATION_DISABLED` |
| 3 | 驗邀請碼：存在、`status='active'`、未過期、`used_count < max_uses` | `400 INVITE_INVALID` / `400 INVITE_EXHAUSTED` |
| 4 | 驗 `username` 與 `local_part`（預設＝`username`）：格式用既有 `LOCAL_PART_RE`、且不重複 | `400 ADDRESS_TAKEN` / `400 INVALID_LOCAL_PART` |
| 5 | 驗密碼強度（建議：≥10 字元，非純數字；**與既有註冊／改密碼規則一致**） | `400 WEAK_PASSWORD` |
| 6 | **原子**：`UPDATE invites SET used_count = used_count + 1, updated_at = ? WHERE id = ? AND status='active' AND used_count < max_uses` → 依 `meta.changes === 1` 判定成功 | 失敗 → `400 INVITE_EXHAUSTED` |
| 7 | 建 `users`（`role='visitor'`, `access_email` = 請求標頭帶入或空）→ 建 1 個 `email_addresses`（`can_send=1`, `daily_send_quota`=預設 20）→ 以**既有**密碼雜湊實作寫 `password_hash` | 任何失敗 → 回 500 並記錄 |
| 8 | 簽發 **mailbox scope** JWT（沿用既有 JWT 簽發路徑與 24h 效期） | — |
| 9 | 稽核 `register_ok`（含 invite id／address id／ip／ua） | — |

**`POST /api/mail/send` 新增檢查（順序即為判定順序，避免 TOCTOU）**

| 步 | 檢查 | 失敗回傳 |
|---|---|---|
| 1 | 帳號狀態：`users.status='active'` | `403 ACCOUNT_SUSPENDED` |
| 2 | 地址 `status='active'` 且 `can_send=1` | `403 SEND_NOT_ALLOWED` |
| 3 | 配額重置：若 `quota_reset_at IS NULL OR quota_reset_at <= now` → `sent_today=0, quota_reset_at=次日 00:00 UTC` | — |
| 4 | **暖機期**（C2）：註冊 24h 內 → 有效上限 = `min(daily_send_quota, 5)` | — |
| 5 | **原子扣配額**：`UPDATE email_addresses SET sent_today = sent_today + 1, first_send_at = COALESCE(first_send_at, ?) WHERE id = ? AND status='active' AND can_send = 1 AND sent_today < <有效上限>` → `meta.changes === 1` 才放行 | `429 QUOTA_EXCEEDED` |
| 6 | **每小時限流**（C3）：近 60 分鐘該地址已寄件數 ≥ 10 | `429 RATE_LIMITED` |
| 7 | 實際寄送（既有邏輯不變） | 既有錯誤 |
| 8 | 稽核（被拒事件寫 `send_rejected_*`） | — |

> ⚠️ 第 5 步的 **原子 UPDATE 是硬性要求**：不得寫成「先 SELECT 再 UPDATE」。
> ⚠️ 若寄送失敗，需**回補** `sent_today`（否則配額會被誤扣）。

**新增錯誤碼（沿用既有錯誤格式）**

| 碼 | HTTP | 情境 |
|---|---|---|
| `INVITE_INVALID` | 400 | 邀請碼不存在／已撤銷／已過期 |
| `INVITE_EXHAUSTED` | 400 | 使用次數用盡 |
| `ADDRESS_TAKEN` | 400 | `username` 或 `local_part` 重複 |
| `INVALID_LOCAL_PART` | 400 | 格式不符 `LOCAL_PART_RE` |
| `WEAK_PASSWORD` | 400 | 密碼不符規則 |
| `REGISTRATION_DISABLED` | 403 | 全站關閉註冊 |
| `QUOTA_EXCEEDED` | 429 | 超過每日配額／暖機上限 |
| `RATE_LIMITED` | 429 | 超過每小時限流或註冊嘗試過多 |
| `ACCOUNT_SUSPENDED` | 403 | 帳號被停權 |
| `SEND_NOT_ALLOWED` | 403 | `can_send=0` |

### 4.3 配額常數（必須可調、單一來源）

| 常數 | 預設 | 放哪裡 |
|---|---|---|
| `DEFAULT_VISITOR_DAILY_QUOTA` | `20` | 程式內單一 const（或用 Worker var `DEFAULT_VISITOR_DAILY_QUOTA`，字串轉數字） |
| `WARMUP_QUOTA` | `5` | 同上 |
| `WARMUP_HOURS` | `24` | 同上 |
| `HOURLY_SEND_LIMIT` | `10` | 同上 |

> ⚠️ **不得**把 20／5／10 散落在多處；登記於 `docs/13` §6.5 與本文件 §4.3，改一處即可。

### 4.4 D7：測試（必備案例）

| # | 案例 | 預期 |
|---|---|---|
| T1 | 有效邀請碼註冊 | 201，回 mailbox token；該 token 可 `GET /api/mail/inbox` |
| T2 | 無效邀請碼／已撤銷／已過期 | `400 INVITE_INVALID` |
| T3 | 同一邀請碼 `max_uses=1` 用兩次 | 第二次 `400 INVITE_EXHAUSTED` |
| T4 | `local_part` 重複 | `400 ADDRESS_TAKEN` |
| T5 | 弱密碼 | `400 WEAK_PASSWORD` |
| T6 | 配額內寄信 | 200；`GET /api/me` 的 `sent_today` +1 |
| T7 | **暖機期**第 6 封 | `429 QUOTA_EXCEEDED`（且 `registration_audit` 有 `send_rejected_quota`） |
| T8 | 超過每日配額（模擬 `sent_today=quota`） | `429 QUOTA_EXCEEDED` |
| T9 | 每小時超過 10 封 | `429 RATE_LIMITED` |
| T10 | `can_send=0` | `403 SEND_NOT_ALLOWED` |
| T11 | 停權後登入與寄信 | 皆 `403 ACCOUNT_SUSPENDED` |
| T12 | 訪客看不到他人信件 | 既有 scope 迴歸（0 筆／404） |
| T13 | `/api/me` 回 `role` 與配額欄位 | 正確 |
| T14 | **owner 既有端點迴歸** | 既有 113 個測試不得退化 |
| T15 | 併發扣配額（同時送 2 封、上限 1） | **只有 1 封成功**（驗證原子性） |
| T16 | **owner 查找不依賴名稱**：測試資料的 owner 改名為 `itag` 後，rescue token、owner 端點、`/api/auth/owner-password` 仍全部正常 | 全數通過 |

### 4.5 D8：前端（`web/`）

| 要求 | 內容 |
|---|---|
| 註冊畫面 | 欄位：`邀請碼`、`使用者名稱`、`密碼`、`確認密碼`；錯誤以既有 UI 風格顯示（對應 §4.2 錯誤碼給人話） |
| 登入後 | 顯示 `sent_today / daily_send_quota`（visitor 才顯示）；`can_send=0` 或配額用盡 → **停用**寄信按鈕並說明原因 |
| 不得改動 | 既有登入流程、既有收信流程、`.env.local`、`vite.config.ts` 的 port/proxy |
| 提醒 | 你的 dev 用 `/api` proxy；`ALLOWED_ORIGINS` 已收斂，**本機開發請用 `http://localhost:5173` 開啟**（白名單已含此來源） |

### 4.6 D9–D10：文件與備份

| 交付物 | 要求 |
|---|---|
| `docs/04`（schema） | 新增 `invites`、`registration_audit` 與新欄位說明 |
| `docs/05`（API） | 新增 §註冊與邀請碼；補上新錯誤碼表 |
| `docs/11`（上線清單） | 新增檢查項：配額值、暖機期、停權流程、稽核可查 |
| `packages/backup-agent` | 鏡像表加入 `invites`；`registration_audit` **不納入**鏡像（量大、非信件資料）→ 於設定中明列 |

### 4.7 D11：owner 帳號名稱可設定（移除硬編碼）

**問題**：`packages/api/src/auth.ts`（`rescueScope`）與 `packages/api/src/index.ts`（`getOwnerId`）以
`SELECT id FROM users WHERE username = 'owner'` 查找 owner → 導致**帳號名稱無法更改**（一改名就斷救援通道與
所有 owner 範圍端點）。

**要求**

| # | 內容 |
|---|---|
| 1 | 上述兩處查詢改為**以角色查找**：`SELECT id FROM users WHERE role = 'owner' LIMIT 1` |
| 2 | 相容過渡（舊資料 `role` 可能未填）：先以 `role='owner'` 查；查不到時**回退** `username='owner'`，並在同一函式內註解說明 |
| 3 | ⚠️ **不得**自行修改 production D1 的使用者名稱（見 N11）；改名由 owner 在**部署之後**執行：<br>`UPDATE users SET username = '<新名稱>', updated_at = <epoch_ms> WHERE role = 'owner';` |
| 4 | 登入端點（`/api/auth/login`）維持以 `username` 查找，**不需**改動 |
| 5 | 新增測試 T16 |

**為何要這樣設計**：把「誰是 owner」的判定從**名稱**改為**角色**，日後改帳號名稱就不必再動程式 ✅

---

---

## 5. 🚫 不可做清單（Hard NO）

| # | 不可做 |
|---|---|
| N1 | 不可改 `ALLOWED_ORIGINS`、Access 應用、DNS、tunnel 設定 |
| N2 | 不可部署、不可跑遠端 migration |
| N3 | 不可把 `can_send` 預設為 0 以外的值而不實作配額（**配額與寄信權限必須同時交付**） |
| N4 | 不可用「先 SELECT 再 UPDATE」實作配額 |
| N5 | 不可新增任何對外公開、且不需要邀請碼的註冊路徑 |
| N6 | 不可改動 owner 既有端點語意與既有測試預期 |
| N7 | 不可把密碼、邀請碼、token 寫進程式碼或 log（log 只記 id／遮罩碼） |
| N8 | 不可 `git add -A`（見 P1） |
| N9 | 不可動 `scripts/dev-web.mjs`、`scripts/vite.tunnel.config.ts`、`docs/13`、`docs/14`（另一位助手的檔案） |
| N10 | 不可引入新的線上相依套件（除已在 `pnpm-lock.yaml` 者），若必要先回報徵求同意 |
| N11 | **不可**對 production D1 執行 `UPDATE users SET username=…`（改名由 owner 在部署後執行） |

---

## 6. 驗收（由 owner 的助手執行；實作 agent 需先自行驗證本地）

### 6.1 實作 agent 自行驗證（完成前必跑）

```bash
cd D:\Mail\Atwhomail
pnpm --filter @atwhomail/api exec wrangler d1 migrations apply mail-d1 --local   # 本地套用 0006
pnpm test      # 預期：全部通過（既有 113 + 新增 T1–T15）
pnpm lint      # 預期：exit 0
pnpm build     # 預期：exit 0（dry-run 不部署）
```

### 6.2 助手端驗收（owner 交付後）

```bash
# A) 產生邀請碼（需要 ADMIN_TOKEN）
curl -sS -X POST https://atwhomail-api.ulhome.workers.dev/api/invites \
  -H "x-admin-token: $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"max_uses":1,"expires_in_hours":72,"note":"驗收用"}'
# 預期：{"code":"…"}

# B) 用邀請碼註冊
curl -sS -X POST https://atwhomail-api.ulhome.workers.dev/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"invite_code":"<A>","username":"verify01","password":"<強密碼>","local_part":"verify01"}'
# 預期：201 {"token":"…","session":"mailbox","address":{"email":"verify01@atwho.org"}}

# C) 同一邀請碼再用一次 → 應被拒
# 預期：400 {"error":{"code":"INVITE_EXHAUSTED"}}

# D) 訪客寄信（配額內）
curl -sS -X POST https://atwhomail-api.ulhome.workers.dev/api/mail/send \
  -H "Authorization: Bearer <B 的 token>" -H 'Content-Type: application/json' \
  -d '{"from":"verify01@atwho.org","to":["test1@atwho.org"],"subject":"t","text":"t"}'
# 預期：200；GET /api/me 的 sent_today 由 0 → 1

# E) 暖機期第 6 封 → 429 QUOTA_EXCEEDED
# F) 停權後寄信／登入 → 403 ACCOUNT_SUSPENDED
# G) 訪客讀他人信件 → 0 筆／404
# I) 【D11 驗收，需 owner 先部署】改名後 owner 登入與救援通道
#    wrangler d1 execute mail-d1 --remote --command "UPDATE users SET username='itag', updated_at=<epoch_ms> WHERE role='owner';"
#    → 預期：以 itag + 目前密碼 POST /api/auth/login = 200；x-admin-token 呼叫 /api/backup/changes = 200
# H) registration_audit 應有 register_ok / send_rejected_quota 事件（可用 D1 查詢或 /api/backup/changes）
```

### 6.3 清理（驗收後）

```
# 軟刪除驗收用地址 verify01@atwho.org（沿用既有 DELETE /api/email-addresses/:id 流程）
# 撤銷驗收用邀請碼（DELETE /api/invites/:id）
```

---

## 7. 回報格式（實作 agent 完成後必附）

| # | 回報項 |
|---|---|
| 1 | 你**實際修改/新增**的檔案清單（明確路徑） |
| 2 | `pnpm test` / `pnpm lint` / `pnpm build` 的**實際輸出結尾與 exit code** |
| 3 | 新增測試的**案例數與名稱** |
| 4 | migration 是否已在**本地**套用（是／否）＋ 遠端尚未（依 P4） |
| 5 | 任何你認為 owner 需要知道的取捨、未完成項、風險 |
| 6 | 明確聲明：**未執行部署、未改 CORS/Access/DNS、未 `git add -A`** |

---

## 8. Definition of Done（全部滿足才算完成）

| # | 條件 |
|---|---|
| 1 | D1–**D11** 全部交付 |
| 2 | `pnpm test`（含 T1–T15）全綠，**既有 113 測試零退化** |
| 3 | `pnpm lint`、`pnpm build` exit 0 |
| 4 | 配額相關常數只有**單一來源**（§4.3） |
| 5 | §5 的 N1–N10 全部遵守 |
| 6 | §7 回報完成 |

---

## 附錄 B：Phase 1 部署紀錄（2026-10-13）

> 本節由助手於上線當日記錄，供日後回溯「實際部署了什麼」。

### B.1 交付物狀態（D1–D11）

| # | 交付物 | 狀態 | 備註 |
|---|---|---|---|
| D1 | `migrations/0006_visitor_registration.sql` | ✅ 已交付並**已套用 production D1** | `wrangler d1 migrations apply mail-d1 --remote`（13 指令、status ✅）|
| D2 | 邀請碼 3 端點（POST/GET/DELETE） | ✅ 已部署 | 線上實測 201／200／200 ✅ |
| D3 | 註冊端點 `POST /api/auth/register` | ✅ 已部署 | 線上實測 201 ＋ mailbox token ✅ |
| D4 | `GET /api/me` | ✅ 已部署 | 回 role／配額欄位 ✅ |
| D5 | 停權端點 `PATCH /api/users/:id/status` | ✅ 已部署 | 線上實測 200 ✅ |
| D6 | `/api/mail/send` 配額＋限流 | ✅ 已部署 | 本地端到端：暖機第 6 封 429 ✅、`can_send=0` 403 ✅ |
| D7 | 測試 | ✅ 129 tests 全綠 | `registration.spec.ts` 16 案例（T1–T13＋併發＋T16＋回退） |
| D8 | 前端 | ✅ **已部署 Cloudflare Pages** | 專案 `atwhomail-web`；`VITE_API_BASE=https://atwhomail-api.ulhome.workers.dev` |
| D9 | 文件同步 | ✅ | `docs/05`、`docs/11` 已含註冊／邀請碼／配額／停權 |
| D10 | 備份鏡像納入 invites | ✅ 已生效 | `/api/backup/changes` 回報含 `invites`；本機 PG 已有 `invites` 表；`registration_audit` 依設計排除 |
| D11 | owner 帳號名稱可設定 | ✅ **已交付並已執行** | `auth.ts` 以 `role='owner'` 查找（含 fallback）；production owner 已改名 **`itag`**（舊名 `owner` 已失效、救援通道正常） |

### B.2 上線後的位址與政策

| 位址 | 承載 | Access 政策 |
|---|---|---|
| `mail.atwho.org` | Cloudflare Tunnel → 本機 Vite（開發／owner 入口） | `AtWhoMail - mail.atwho.org`：Allow 僅 `ulhome@gmail.com`、168h |
| **`app.atwho.org`** | **Cloudflare Pages `atwhomail-web`**（永久在線） | `AtWhoMail Visitors`：**Bypass / Everyone**（公開，靠 App 自家帳密＋邀請碼閘門） |

> ⚠️ 修正先前的說法：Cloudflare Access 的 `Allow → Everyone` **仍會要求 One-time PIN**；訪客入口改用
> **`Bypass → Everyone`**（等效公開、零摩擦），實際防護由 App 的邀請碼註冊＋配額＋停權承擔。

### B.3 前端更新流程

```bash
cd D:\Mail\Atwhomail

# 1) 以 production API 為基底建置
VITE_API_BASE=https://atwhomail-api.ulhome.workers.dev pnpm --filter web build

# 2) 部署到 Pages（專案名固定）
pnpm exec wrangler pages deploy web/dist --project-name atwhomail-web --branch main
```

- API 更新：`pnpm deploy:api`（需 wrangler 登入 ✅ 已具備 OAuth）
- DB migration：`cd packages/api && pnpm exec wrangler d1 migrations apply mail-d1 --remote`

### B.4 驗收證據（摘要）

| 驗收項 | 結果 |
|---|---|
| 線上 `GET /api/health` | 200 `{"ok":true,"db":"ok"}` ✅ |
| 線上 `POST /api/invites` / `POST /api/auth/register` | 201／201 ✅ |
| 重複使用邀請碼 | 400 `INVITE_EXHAUSTED` ✅ |
| 訪客 `/api/me` | `role=visitor`、`daily_send_quota=20`、`can_send=1` ✅ |
| CORS（來源 `https://app.atwho.org`） | preflight 204 ＋ ACAO 回顯 ✅ |
| 本地 migration／測試 | 已套用；129 tests 全綠 ✅ |
| `app.atwho.org` | 200 ＋ App HTML（非 Access 登入頁）✅ |

### B.5 待辦（Phase 1.1／之後）

| # | 項目 |
|---|---|
| 1 | owner/rescue **無法**透過 API 停用或刪除**訪客**地址（`DELETE /api/email-addresses/:id` → 404，owner scope 只含自己）→ 需加 owner 專用端點 |
| 2 | `backup-agent` 的 `MIRROR_TABLES`（`db.ts`）未含 `invites` → `health()` 計數不會顯示 invites（不影響鏡像本體） |
| 3 | DMARC 由 `p=none` 升 `quarantine`；`default._domainkey` 來歷待確認 |
| 4 | 每季還原演練前置：建測試 D1／R2 並填 `.env` 的 `D1_TEST_ID`／`R2_TEST_BUCKET` |
