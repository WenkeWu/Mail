# 07 — Cloudflare Resources 清單（手動 vs 自動）

> 對應 PRD §二十 item 12。列出專案需要的全部 Cloudflare 資源，
> 區分「🖐️ 需要你手動在 dashboard 操作」與「🤖 wrangler / 程式自動建立」。
> **手動項目完成一個，本文就更新一個（✅ 標記 + 驗證結果）。**

## 1. 資源總表

| 資源 | 用途 | 建立方式 | 狀態 |
|---|---|---|---|
| Domain zone（**atwho.org**） | DNS 基礎 | 已有 | ✅ 驗證：NS = decker/chelsea.ns.cloudflare.com |
| Email Routing（收信功能） | Catch-all 收信 | 🖐️ dashboard 啟用（2026-09-01） | ✅ 驗證：MX = route1/2/3.mx.cloudflare.net；SPF = include:_spf.mx.cloudflare.net |
| Destination address（ulhome@gmail.com） | Email Routing 啟用必要條件 | 🖐️ dashboard + 收驗證信點連結 | ✅ 2026-09-02 你確認顯示 Verified |
| Catch-all routing rule → email-handler Worker | 收信入口 | 🖐️ dashboard（1 條 rule） | ⬜ Phase 5 |
| Workers（email-handler / api） | 程式本體 | 🤖 `wrangler deploy` | ⬜ Phase 2+ |
| D1 database（mail-d1） | metadata | 🤖 `wrangler d1 create` | ⬜ Phase 3 |
| R2 bucket（mail-r2） | 內容儲存 | 🤖 `wrangler r2 bucket create` | ⬜ Phase 4 |
| send_email binding | 寄信 | 🤖 wrangler.jsonc（需 Paid） | ⬜ Phase 10 |
| Email Sending onboarding（寄信功能） | 寄信 domain 設定 | 🖐️ dashboard 啟動（自動建 SPF/DKIM/MTA-STS/bounce MX） | ⬜ Phase 10 |
| Workers Paid plan | 寄信資格 | 🖐️ dashboard 升級 + 付款 | ⬜ Phase 10 |
| Secrets（JWT secret 等） | 安全 | 🤖 `wrangler secret put` | ⬜ Phase 11 |
| （後期）大量寄信額度 | 擴充配額 | 🖐️ 官方表單申請 | ⬜ 視需求 |

## 2. 🖐️ 手動操作步驟（含 dashboard 路徑）

### Step 1 — 確認 zone 已在 Cloudflare
1. 登入 [dash.cloudflare.com](https://dash.cloudflare.com)
2. 左側確認 `atwho.org` zone 存在且 DNS 由 Cloudflare 代管（✅ 已驗證）

### Step 2 — 啟用 Email Routing（免費）
1. 進入 **Compute → Email Service → Email Routing**
2. 點 **Enable**（Cloudflare 會自動在 DNS 加入 MX records + SPF record）
3. ⚠️ 這個動作會變更你 domain 的 MX——**若 domain 目前正在收信（例如有在用其他信箱服務），請先確認不會影響**

> ✅ **2026-09-02 驗證結果**：MX = route1/2/3.mx.cloudflare.net、SPF 已含 `include:_spf.mx.cloudflare.net`、DMARC 存在（p=none）。Email Routing 確認啟用（2026-09-01）。

### Step 3 — 新增並驗證 Destination Address（必要，無法自動化）
1. Email Routing → **Destination Addresses** → 輸入 `ulhome@gmail.com`
2. Cloudflare 寄驗證信 → 到該信箱點 **Verify email address**
3. 狀態變 **Verified** 後，routing rules 才能啟用

> ✅ **2026-09-02 已確認**：`ulhome@gmail.com` 顯示 Verified。

### Step 4 — 建立 Catch-all Rule → Worker（Phase 5 才做）
1. Email Routing → **Routing Rules** → Create routing rule
2. Pattern：`*`（Catch-all）→ Action：**Send to a Worker** → 選 email-handler Worker
3. 此步需要 Worker 已部署（Phase 5 產出後再回來做）

### Step 5 — 啟用 Email Sending（Phase 10 才做，需要 Workers Paid）
1. 先升級 Workers Paid（Workers & Pages → Plans → $5/mo）
2. Email Service → Sending → 啟動 domain onboarding（Cloudflare 自動建 SPF/DKIM/MTA-STS/bounce MX records）
3. 之後 api Worker 才能用 `send_email` binding 寄給任意收件人

## 3. 🤖 自動化對照（wrangler 指令，寫進 Phase 2–4）

```bash
wrangler login                                  # 一次性 OAuth
wrangler d1 create mail-d1                      # Phase 3
wrangler r2 bucket create mail-r2               # Phase 4
wrangler deploy -c packages/email-handler       # Phase 5
wrangler deploy -c packages/api                 # Phase 7
wrangler secret put JWT_SECRET                  # Phase 11
wrangler d1 migrations apply mail-d1            # 每次 schema 變更
```

## 4. DNS records 最終狀態（全部 Cloudflare 自動管理，不需手動編輯）

| Record | 用途 | 由誰建立 |
|---|---|---|
| MX → Cloudflare Email Routing | 收信 | Step 2 自動 |
| SPF（收信 + 寄信） | 驗證寄件者 | Step 2 / Step 5 自動 |
| DKIM | 寄信簽章 | Step 5 自動 |
| DMARC | 政策 | Step 5 自動（若無則建議手動加一條 `_dmarc`） |
| MTA-STS | 傳輸安全 | Step 5 自動 |
| bounce MX | 退信接收 | Step 5 自動 |

## 5. 手動進度追蹤（每完成一項由我驗證後 ✅）

- [x] Step 1：確認 zone（atwho.org）— 2026-09-02 DNS 驗證通過
- [x] Step 2：啟用 Email Routing — 2026-09-02 MX/SPF 驗證通過
- [x] Step 3：Destination address（ulhome@gmail.com）已驗證 — 2026-09-02 確認
- [x] Step 4：Catch-all rule → Worker — 2026-09-05 ✅ 測試信 test1@atwho.org 觸發並存 R2 成功
- [x] Step 5：Workers Paid 升級 + Email Sending 啟用 — 2026-09-13 ✅ 寄信實測成功（`test1@atwho.org → ulhome@gmail.com`）
- [x] Step 6（額外）：MTA-STS 三件套 — 2026-09-13 ✅（`_mta-sts` CNAME → `_mta-sts.mx.cloudflare.net`；`atwhomail-mta-sts` Worker + Route；政策檔 `mode: testing` 上線）
