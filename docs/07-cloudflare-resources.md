# 07 — Cloudflare Resources 清單（手動 vs 自動）

> 對應 PRD §二十 item 12。列出專案需要的全部 Cloudflare 資源，
> 區分「🖐️ 需要你手動在 dashboard 操作」與「🤖 wrangler / 程式自動建立」。
> **手動項目完成一個，本文就更新一個（✅ 標記 + 驗證結果）。**

## 1. 資源總表

| 資源 | 用途 | 建立方式 | 狀態 |
|---|---|---|---|
| Domain zone（**atwho.org**） | DNS 基礎 | 已有 | ✅ 2026-09-02：NS = decker/chelsea.ns.cloudflare.com |
| Email Routing（收信功能） | Catch-all 收信 | 🖐️ dashboard 啟用（2026-09-01） | ✅ MX = route1/2/3.mx.cloudflare.net；SPF = include:_spf.mx.cloudflare.net（2026-10-05 複驗） |
| Destination address（ulhome@gmail.com） | Email Routing 啟用必要條件 | 🖐️ dashboard + 收驗證信點連結 | ✅ 2026-09-02 你確認顯示 Verified |
| Catch-all routing rule → email-handler Worker | 收信入口 | 🖐️ dashboard（1 條 rule） | ✅ 2026-09-05 測試信觸發並存 R2 成功 |
| Workers（email-handler / api） | 程式本體 | 🤖 `wrangler deploy` | ✅ 2026-09-13（handler）／2026-09-24（api） |
| D1 database（mail-d1） | metadata | 🤖 `wrangler d1 create` | ✅ 2026-09-05；3 migrations 全數套用（2026-10-05 複驗） |
| R2 bucket（mail-r2） | 內容儲存 | 🤖 `wrangler r2 bucket create` | ✅ 2026-09-05 |
| send_email binding | 寄信 | 🤖 wrangler.jsonc（需 Paid） | ✅ Phase 10 完成（api worker binding 名 `EMAIL`） |
| Email Sending onboarding（寄信功能） | 寄信 domain 設定 | 🖐️ dashboard 啟動（自動建 SPF/DKIM/bounce MX 於 `cf-bounce` 子網域；**MTA-STS 需手動，見 Step 6**） | ✅ 2026-09-13 寄信實測成功 |
| Workers Paid plan | 寄信資格 | 🖐️ dashboard 升級 + 付款 | ✅ 2026-09-13 |
| Secrets（JWT secret 等） | 安全 | 🤖 `wrangler secret put` | ✅ `ADMIN_TOKEN`／`JWT_SECRET` 皆已設定 |
| MTA-STS 三件套 | 傳輸安全 | 🖐️ `_mta-sts` CNAME + 🤖 policy Worker | ✅ 2026-10-05 補回 CNAME 並重新驗收（見 Step 6） |
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
2. Email Service → Sending → 啟動 domain onboarding（Cloudflare 自動建 SPF/DKIM/bounce MX records 於 `cf-bounce` 子網域；**MTA-STS 訊號不在此步，需手動建立**，見 Step 6）
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

## 4. DNS records 最終狀態

> ⚠️ 除 **MTA-STS 的 `_mta-sts` CNAME 需手動建立（Step 6）** 外，其餘皆由 Cloudflare 自動管理。

| Record | 用途 | 由誰建立 |
|---|---|---|
| MX → Cloudflare Email Routing | 收信 | Step 2 自動 |
| SPF（收信） | 驗證寄件者 | Step 2 自動 |
| SPF / DKIM（寄信） | 驗證寄件者 | Step 5 自動（建在 `cf-bounce` 子網域） |
| DMARC | 政策 | Step 5 自動（若無則建議手動加一條 `_dmarc`） |
| **MTA-STS 訊號（`_mta-sts` CNAME）** | 讓寄件端發現政策 | **Step 6 手動**（CNAME → `_mta-sts.mx.cloudflare.net`，**Proxy OFF**） |
| MTA-STS 政策主機（`mta-sts`） | 提供政策檔 | Step 6（`atwhomail-mta-sts` Worker + custom domain） |
| bounce MX | 退信接收 | Step 5 自動（`cf-bounce` 子網域） |

## 5. 手動進度追蹤（每完成一項由我驗證後 ✅）

- [x] Step 1：確認 zone（atwho.org）— 2026-09-02 DNS 驗證通過
- [x] Step 2：啟用 Email Routing — 2026-09-02 MX/SPF 驗證通過
- [x] Step 3：Destination address（ulhome@gmail.com）已驗證 — 2026-09-02 確認
- [x] Step 4：Catch-all rule → Worker — 2026-09-05 ✅ 測試信 test1@atwho.org 觸發並存 R2 成功
- [x] Step 5：Workers Paid 升級 + Email Sending 啟用 — 2026-09-13 ✅ 寄信實測成功（`test1@atwho.org → ulhome@gmail.com`）
- [x] Step 6（額外）：MTA-STS 三件套 — 2026-09-13 初設；**2026-10-05 補回 CNAME 並重新驗收**
      - ⚠️ **2026-10-05 稽核發現**：`_mta-sts.atwho.org` 的 CNAME **已不存在**（權威 NS 與公開解析器皆查無此名）。
        政策主機 `mta-sts.atwho.org` 仍回 200，但**沒有訊號記錄 → 沒有任何寄件端會去查政策檔**，
        等於 MTA-STS **實質完全未生效**（非壞掉，是白做）。
      - ✅ **當日已重新加入並驗收**：權威 NS `chelsea.ns.cloudflare.com` 回 `canonical name = _mta-sts.mx.cloudflare.net`；
        TXT 穿過 CNAME 回 `v=STSv1; id=20230615T153000;`；政策檔仍 200 `mode: testing`。
      - 🔁 **此記錄會無聲消失** → 每次動 mail DNS 都要重驗（檢查法見 skill `dns-mta-sts-verification.md` Rule 1b）。
      - ⚠️ **尚未發佈 `_smtp._tls.atwho.org`（TLS-RPT）** → 收不到 TLS 失敗報告，`testing → enforce` 前應先補。
