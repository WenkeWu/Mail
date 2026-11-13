---
title: 訪客 Dashboard 與 AllChat 身分等級投影（Mail 端）
status: 現況
updated: 2026-11-13
read-when: 改訪客 Dashboard／AllChat 身分投影時（D38，已上線）
---

# 38 — 訪客 Dashboard 與 AllChat 身分等級投影（Mail 端）

> 建立：2026-11-13｜分支：`feat/visitor-dashboard`｜狀態：**Mail 已上線（migration 0019、API `fdf7e82c`、Pages `c9f20c41`，2026-11-13）**
> AllChat 同步環境變數尚未設定，等級目前顯示「未同步」。
> 範圍：**只做 Mail**。AllChat 的等級判定與管理由 AllChat 實作，Mail 不寫回、不管理等級。

## 1. 為什麼改

舊版 `mail.atwho.org` 訪客管理會一次列出**全部**訪客，並為每位訪客做信件數／最近信件時間的子查詢。
訪客變多後，管理頁與 D1 都會越來越慢，而且管理者真正需要的是：

- 訪客總量與成長趨勢
- 國家／語系／等級分類
- 需要立即處理的異常（接近配額、被擋、登入失敗、受限等級、停權）

因此改為 **Dashboard ＋ 條件式搜尋**：

- 預設**不列出**任何訪客，只載入聚合與注意事項。
- 必須至少輸入一個條件才會查詢訪客；每頁 25 筆、後端硬上限 50 筆。
- 既有停權／地址停用／配額／暖機／刪除功能與二次確認全部保留。

## 2. 畫面

| 區塊 | 內容 |
|---|---|
| KPI | 訪客總數、今日新增、近 7 天新增、近 7 天活躍、暖機中、接近配額、24h 異常訊號、已停權 |
| 分佈 | 國家（Top 10）、語系（Top 10）、AllChat 等級 |
| 趨勢 | 近 14 天註冊、近 14 天寄出（以 `messages.folder='sent'` 計數） |
| 同步 | AllChat 最後同步時間、落後警告、立即同步、前往 AllChat 管理 |
| 注意事項 | 近 24 小時訊號；可一鍵帶入該訪客 ID 搜尋 |
| 搜尋 | ID／Email、國家、語系、帳號狀態、AllChat 等級、風險訊號 |
| 結果 | 國家／語系、唯讀等級、狀態、配額、今日已寄、信件數、最近活動、既有操作 |

等級只是 AllChat 的投影：Mail 顯示 `T0`–`T4` 與 `受限`，**不提供修改**；管理入口連到 `https://chat.atwho.org`。

## 3. 資料模型（migration `0019_visitor_dashboard.sql`）

### `users` 新增欄位

| 欄位 | 用途 |
|---|---|
| `country_code` | 首次註冊／登入時的國家（ISO 3166-1 alpha-2；只補空值） |
| `language` | 首次註冊／登入時的語系（例：`zh-TW`；只補空值） |
| `last_seen_at` | 最近活動（登入／開啟信箱；最多每 15 分鐘寫一次） |
| `last_country_code` | 最近一次登入的國家（每次登入都可更新） |

既有訪客這四欄為 `NULL`，UI 顯示「未知」；下一次登入後補齊。**不回溯猜測**。

### `allchat_level_projection`

AllChat 是唯一 source of truth；這張表只是 Mail 的唯讀投影。

```sql
user_id           INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE
level             TEXT NOT NULL          -- T0–T4（由 AllChat 定義）
scope             TEXT
status            TEXT NOT NULL          -- normal／restricted（由 AllChat 定義）
source_version    INTEGER NOT NULL
source_updated_at INTEGER
synced_at         INTEGER NOT NULL
sync_state        TEXT NOT NULL
```

### `integration_sync_state`

```sql
integration    TEXT PRIMARY KEY          -- 'allchat_identity_levels'
cursor         TEXT                      -- AllChat changes 的 nextCursor
last_synced_at INTEGER
last_error     TEXT
```

### 索引

`users(role, status, created_at DESC)`、`users(role, created_at DESC)`、`users(country_code)`、`users(language)`、`users(last_seen_at DESC)`、
`registration_audit(user_id, created_at DESC)`、`registration_audit(event, created_at DESC)`、
`allchat_level_projection(level, status)`。

## 4. 地區／語系的寫入點

| 時機 | 行為 |
|---|---|
| Email 驗證碼註冊 | `register-verify` 接受選填 `country`／`language`，寫入新建 `users` |
| 邀請碼註冊 | 同上（前端既有表單一併帶入） |
| 信箱登入 | `mailbox-login` 接受選填 `country`／`language`；成功後 `touchUserActivity` |
| 本機帳密登入 | `user-login` 同上 |
| Google OAuth | callback 以 `CF-IPCountry`／`Accept-Language` 補齊；每次登入更新 `last_seen_at` |
| 開啟信箱 | `GET /api/me` 呼叫 `touchUserActivity`（15 分鐘節流） |

前端登入／註冊會把目前 `useI18n()` 的 `country`／`language` 一併送出；後端仍會用
`CF-IPCountry`／`Accept-Language` 補值。`normalizeCountryCode` 會拒絕 `XX` 與 `T1`（Tor）。

`touchUserActivity` **不更新 `users.updated_at`**，避免 D17 增量備份因瀏覽活動增加。

## 5. API（全部 owner-only）

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/admin/visitors/overview` | KPI／分佈／趨勢／同步狀態 |
| GET | `/api/admin/visitors/search` | 條件式搜尋；無條件 → `filter_required: true` |
| GET | `/api/admin/visitors/attention` | 注意事項清單 |
| GET | `/api/admin/integrations/allchat/status` | 同步狀態 |
| POST | `/api/admin/integrations/allchat/sync` | 手動同步；未設定 → `503 ALLCHAT_NOT_CONFIGURED` |

`overview` 支援 `q`、`country`、`language`、`status`、`level` 與 `days`（1–90）。
`search` 另支援 `risk=near_quota|quota|rate|login|restricted`、`page`、`limit`（硬上限 50）。
`level=UNKNOWN` 表示尚未同步；`country=UNKNOWN`／`language=UNKNOWN` 表示欄位為空。

舊端點 `GET /api/users?role=visitor` **保留**（緊急排查與既有測試），但新版 UI 不再呼叫。

### 注意事項訊號

| reason | 條件 |
|---|---|
| `near_quota` | `sent_today >= 有效每日上限 * 0.8`（暖機中取 `min(每日配額, 暖機上限)`） |
| `quota_rejected` | 近 24h `send_rejected_quota` |
| `rate_rejected` | 近 24h `send_rejected_rate` |
| `login_failed` | 近 24h `login_failed` |
| `allchat_restricted` | 投影 `status='restricted'` |
| `suspended` | `users.status <> 'active'` |

## 6. AllChat 內部 API 契約（Mail 消費端）

Mail 每 **5 分鐘**由 Worker cron 以 **pull** 方式同步；**不使用 webhook**。
所有請求帶：

```http
X-AtWho-Service: mail
X-AtWho-Timestamp: <Unix 秒>
X-AtWho-Signature: <hex HMAC-SHA256>
```

簽章字串（`rawBody` 對 GET 為空字串）：

```text
HMAC_SHA256(secret, `${timestamp}.${method}.${path}.${rawBody}`)
```

`path` **包含 query string**，例如：
`/api/internal/identity-levels/changes?since=0&limit=500`。

### 6.1 Changes（增量）

```http
GET /api/internal/identity-levels/changes?since=<cursor>&limit=500
```

```json
{
  "levels": [
    {
      "mailUserId": 123,
      "level": "T2",
      "scope": "global",
      "status": "normal",
      "version": 3,
      "updatedAt": 1763000000000
    }
  ],
  "nextCursor": "100",
  "hasMore": false
}
```

- `levels` 也接受別名 `changes`。
- `removed: true`（或 `level: null`）→ Mail 刪除該使用者的投影。
- `mailUserId` 不存在於 Mail → 靜默忽略，不建立孤兒列。
- `hasMore: true` → 以 `nextCursor` 繼續抓，单次同步最多 10 頁。
- 第一次同步（尚無 cursor）Mail 會先嘗試 snapshot；若 AllChat 回 `404`／`405`，改用 `changes?since=0`。

### 6.2 Snapshot（第一次補齊，可選）

```http
GET /api/internal/identity-levels/snapshot?afterMailUserId=0&limit=500
```

```json
{
  "levels": [ { "mailUserId": 1, "level": "T0", "status": "normal", "version": 1 } ],
  "nextMailUserId": 1,
  "hasMore": false
}
```

`nextCursor` 也可作為下一頁游標。snapshot 失敗不會阻擋 changes 同步。

### 6.3 建議 AllChat 端

- `changes` 的事件需保留至少 Mail 一次同步失敗後可重試的期間（建議 30 天）。
- 第一次 `since=0` 應回傳目前所有等級，或提供 snapshot。
- 回應只含等級資料；**不要**回傳 AllChat 的訊息、貼文或個資。
- HMAC secret 每個服務獨立；外洩時只輪替該服務。

## 7. 環境變數與 cron

`packages/api/wrangler.jsonc`：

```jsonc
"main": "src/worker.ts",
"triggers": { "crons": ["*/5 * * * *"] }
```

| 名稱 | 類型 | 說明 |
|---|---|---|
| `ALLCHAT_INTERNAL_BASE_URL` | vars（非機密） | 例：`https://chat.atwho.org`；未設定 → 不同步 |
| `ALLCHAT_INTERNAL_SECRET` | **Worker secret** | HMAC 金鑰；**不可**進前端／URL／log／git |

```bash
cd D:\Mail\Atwhomail\packages\api
node ../../node_modules/wrangler/bin/wrangler.js secret put ALLCHAT_INTERNAL_SECRET
```

`src/worker.ts` 保留 `src/index.ts` 的 Hono app 作為 `fetch`，並新增 `scheduled` 呼叫
`syncAllChatLevels`；測試仍直接 import `src/index.ts`，不受 cron 影響。

## 8. 隱私邊界（N9）

- Dashboard／搜尋只回數量、時間、狀態、國家、語系、等級。
- **不**回傳信件主旨、寄件者、收件者、內文、預覽或附件。
- 刪除訪客的二次確認只顯示「信件數」，不顯示任何信件內容。
- 所有新端點皆 `requireOwner`；訪客 JWT → 403、無 session → 401。

## 9. 部署順序（owner）

> N10：實作 agent 不執行遠端 D1 寫入／migration；以下由 owner 執行。

1. `cd D:\Mail\Atwhomail\packages\api`
2. 套 migration：
   ```bash
   node ../../node_modules/wrangler/bin/wrangler.js d1 migrations apply mail-d1 --remote
   ```
3. 設定 AllChat secret（若尚未設定）：
   ```bash
   node ../../node_modules/wrangler/bin/wrangler.js secret put ALLCHAT_INTERNAL_SECRET
   ```
4. 部署 API：
   ```bash
   pnpm deploy:api
   ```
5. 部署 Pages：
   ```bash
   cd web
   VITE_API_BASE=https://atwhomail-api.ulhome.workers.dev pnpm build
   pnpm exec wrangler pages deploy dist --project-name atwhomail-web --branch main
   ```
6. 在 `mail.atwho.org` 驗收（見下）。

⚠️ 順序不可顛倒：`register-verify`／OAuth／邀請碼註冊會寫入新欄位；若先部署程式、後套 migration，
註冊會失敗。若必須先部署程式，請先暫停註冊或先套 migration。

### 2026-11-13 部署紀錄

| 項目 | 結果 |
|---|---|
| migration `0019` | ✅ 已套用 `mail-d1`（remote） |
| API Worker | ✅ `fdf7e82c-5e1d-456a-8573-c3a0a03e2212`；cron `*/5 * * * *` |
| Pages | ✅ `c9f20c41.atwhomail-web.pages.dev`；正式資產 `index-DlvXUcfw.js` |
| 煙霧測試 | ✅ `GET /api/admin/visitors/overview` 未帶 session → 401；production bundle 含新端點 |
| AllChat 同步 | ⏸ 未設定 `ALLCHAT_INTERNAL_BASE_URL`／`ALLCHAT_INTERNAL_SECRET` |

## 10. 驗收清單

- [ ] `mail.atwho.org` 訪客管理載入後**沒有**自動列出全部訪客。
- [ ] KPI 數字與 D1 抽查一致（總數／今日新增／停權數）。
- [ ] 國家／語系／等級分佈有值；舊訪客顯示「未知／未同步」。
- [ ] 無條件按「搜尋」→ 顯示提示，不發出 search 請求。
- [ ] 以 ID／Email、國家、語系、狀態、等級、風險搜尋皆可取得結果。
- [ ] 搜尋結果的停權／停用／寄信設定／刪除功能與舊版一致。
- [ ] 新註冊帳號的 `country_code`／`language` 有值；登入後 `last_seen_at` 更新。
- [ ] AllChat 設定後，5 分鐘內投影出現；手動「立即同步」成功。
- [ ] 將 AllChat 等級改為 restricted → Mail 注意事項出現「AllChat 等級受限」。
- [ ] 訪客 JWT 呼叫五個新端點皆 403；無 session 皆 401。

## 11. 測試

```bash
cd D:\Mail\Atwhomail
pnpm test:workers       # 新增 visitor-dashboard.spec.ts（10 案例）
pnpm --filter @atwhomail/web test
pnpm typecheck
pnpm build
pnpm secret:scan
```

`visitor-dashboard.spec.ts` 覆蓋：overview 聚合與篩選、search 無條件／各條件／權限、
attention 五類訊號、HMAC 簽章與投影 upsert／removed／孤兒忽略、登入補齊地區語系。

## 12. 不在本次範圍

- AllChat 的等級判定、升降級規則與管理 UI（由 AllChat 實作）。
- Webhook／即時推送（owner 明確決定用 pull）。
- 既有訪客的國家／語系回溯推測。
- 「登出所有系統」與全域 session 撤銷（D37 後續）。
