# 11 — 上線檢查清單（Launch Checklist）

> 對應 Phase 16（10 文件 §3）。狀態：2026-09-15（**2026-10-05 收發信現況稽核**）。**本文件是「上線前最後一哩」的操作清單**，每項都附驗證指令與預期輸出。

## 1. 系統現況（已完成 ✅）

| 元件 | 狀態 | 位置／識別 |
|---|---|---|
| 收信 Worker | ✅ 上線 | `atwhomail-email-handler`（catch-all `*@atwho.org`；R2 + D1 + HTML 消毒 + 附件抽取） |
| API Worker | ✅ 上線 | `atwhomail-api`（REST；Model C 雙 session；安全標頭；健康檢查含 D1 探測） |
| MTA-STS Worker | ✅ 上線 | `atwhomail-mta-sts`（`mta-sts.atwho.org`；mode=testing）｜訊號 CNAME 於 2026-10-05 補回（見 §1.1） |
| D1 | ✅ | `mail-d1` `1d02352f-9f40-4e06-a95f-95a781a84998`（3 migrations） |
| R2 | ✅ | `mail-r2`（`mail/`、`attachments/`） |
| 本機備份 | ✅ | PostgreSQL 17.11 `atwhomail_backup`；磁碟 `D:\Mail\mail-backup\`（13 物件 / 41,088 B） |
| 還原能力 | ✅ 已演練 | 2026-09-23 對測試 D1 `332b8869…` + bucket `mail-r2-restore-test` 演練（位元組級 sha256 等價）；**演練後測試標的已於 2026-10-05 刪除**（見 §5 #9） |
| 測試 | ✅ 87 個 / 7 檔 | `pnpm test`（workerd 測試池，含 32 個 API 整合測試 + 8 收信 + 5 MTA-STS） |
| 安全標頭 | ✅ | nosniff / DENY / no-referrer / HSTS / CSP（HTML 端點保留專屬 CSP） |
| 健康檢查 | ✅ | `GET /api/health` 含 D1 探測（DB 異常 → 503） |

### 1.1 2026-10-05 收發信現況稽核（公開 DNS + CF API 實測）

> 稽核方式：公開 DNS（權威 NS + 多個公共解析器）、CF API（Workers/D1/R2/secrets）、D1 遠端查詢。
> 因 token 缺 DNS / Email Routing / Email Sending read 權限（403），該三者以公開 DNS 驗證。

| 檢查項 | 結果 |
|---|---|
| 收信 MX（`atwho.org`） | ✅ `route1/2/3.mx.cloudflare.net` |
| 收信 SPF | ✅ `v=spf1 include:_spf.mx.cloudflare.net ~all` |
| Routing DKIM | ✅ `cf2024-1._domainkey.atwho.org` 存在且 `p=` 完整 |
| 寄信 bounce MX | ✅ `cf-bounce.atwho.org` → route1/2/3 |
| 寄信 SPF / DKIM | ✅ `cf-bounce.atwho.org` / `cf-bounce._domainkey.atwho.org` |
| DMARC | ✅ `_dmarc` `p=none` + `rua=…@dmarc-reports.cloudflare.net` |
| **MTA-STS 訊號** | ⚠️→✅ 稽核時 `_mta-sts` CNAME **已消失**（NXDOMAIN）＝MTA-STS 實質未生效；**當日補回並驗收** |
| Worker bindings | ✅ api：`DB`/`MAIL`/`EMAIL(send_email)` + secrets `ADMIN_TOKEN`/`JWT_SECRET`；handler：`DB`/`MAIL`；mta-sts：`MODE_OVERRIDE=testing` |
| Observability | ✅ 三個 Worker 皆開啟（`head_sampling_rate=1`） |
| D1 migrations | ✅ 3 筆（`0001_init` / `0002_auth` / `0003_password_changed`） |
| 健康檢查 | ✅ `{"ok":true,"db":"ok"}` |
| **TLS-RPT（`_smtp._tls`）** | ❌ 不存在 → 收不到 TLS 失敗報告（`enforce` 前應補，見 §2-4） |
| 殘留演練資源 | ✅ 已清理（2026-10-05）：D1 `mail-d1-restore-test`、R2 `mail-r2-restore-test` 皆已刪除；僅保留 production `mail-d1` / `mail-r2`（刪除後已列舉驗證） |
| CF API token | ⚠️ 缺 DNS read / Email Routing read / Email Sending read（403 code 10000/10001）→ 稽核須靠公開 DNS |
| 官方文件重驗 | ✅ `email-service/llms-full.txt`（2026-10-05 抓取）：寄信所需 `cf-bounce` 系列記錄**無新增要求** |

## 2. 上線前必做（逐步核對）

- [x] **1. 設定備份排程**（本機 PowerShell，無需管理員）✅ 2026-10-05 完成
      ```powershell
      powershell -ExecutionPolicy Bypass -File D:\Mail\Atwhomail\scripts\register-backup-tasks.ps1
      Get-ScheduledTask -TaskName "AtWhoMail Backup *" | Format-Table TaskName, State
      ```
      已驗證結果：
      | 工作 | 觸發 | 狀態 | 實測 |
      |---|---|---|---|
      | `AtWhoMail Backup Agent` | 登入時（＋每 5 分鐘重複觸發） | **Running** | `tick #N` 每 5 分鐘一筆、watermarks 正常 |
      | `AtWhoMail Backup Verify` | 每日 09:00 | Ready | 2026-10-06 實測 → `total:15 ok:15 missing:0 corrupt:0`、exit 0 |

      🔴 **2026-10-06 維運事件（已修；務必了解，否則會誤判「備份正常」）**
      Agent 於 01:30 因 PostgreSQL 連線瞬斷而結束，之後**停擺約 8 小時無人察覺**（無資料遺失）。根因與修法：

      | 問題 | 說明 | 修法 |
      |---|---|---|
      | wrapper 吞掉結束碼 | 舊版 `backup-agent.cmd` 以 `endlocal` 結尾 → 一律回 0 → 排程記成「成功」 | 改為 `set "RC=%ERRORLEVEL%"` ＋ `endlocal & exit /b %RC%`；結束行時間戳改印**真正的結束時間**（舊版印的是啟動時間，會誤導） |
      | Task Scheduler 不會自動重啟 | 實測：修正後 `LastResult=1` 已正確呈現失敗，但 `RestartOnFailure`（999 × 1 分鐘）與 repetition **實測都不會觸發**（`AtLogOn` 觸發器無 `StartBoundary`，週期無法排定） | **不依賴排程機制**：wrapper 改為**監督迴圈**（agent 一結束就記錄、`ping` 等 60 秒、再拉起）。實測：殺掉 agent → 60 秒內自動恢復 ✅ |
      | 無監控 | 停擺 8 小時是人工偶然發現 | 見 §2-5（尚未設定，仍為缺口） |

      ⚠️ **副作用（重要）**：監督迴圈讓工作永不回結束碼 → **排程 `LastResult` 不再能反映 agent 崩潰**。
      要看的訊號是 `agent.log` 的 `agent exited code=... ; supervisor restarting in 60s`。

      ⚠️ **編碼陷阱（已修）**：`register-backup-tasks.ps1` 必須存成 **UTF-8 with BOM**（Windows PowerShell 5.1 把無 BOM 的 UTF-8 當 ANSI 讀，中文字串會吃掉引號/括號 → ParserError）；`backup-*.cmd` 必須**純 ASCII**（cmd.exe 以 CP950 讀 .cmd，UTF-8 中文註解會變成亂碼並被當成指令執行，例如 `'ha256' 不是內部或外部命令`），時間戳改用 PowerShell ISO-8601。

- [ ] **2. 確認備份真的有跑**
      ```powershell
      Get-Content D:\Mail\mail-backup\logs\agent.log -Tail 5
      ```
      預期：`"msg":"tick #N"` 每 5 分鐘一筆，`"sync":{"created":0,...}`（無變更時）。

      ⚠️ 同時檢查是否出現**崩潰重啟**訊號（2026-10-06 起 wrapper 為監督迴圈）：
      `[<時間>] agent exited code=<非0> ; supervisor restarting in 60s`
      → 出現一次代表 agent 曾崩潰並已自動恢復（1 分鐘內）；**同一小時內密集出現＝有反覆性問題，需處理**。

- [ ] **3. 寄信配額與聲譽**
      - Workers Paid 含 **3,000 封/月**（超量 $0.35/千封）；Dashboard → Workers → Email Sending 可看用量
      - 新網域仍在**聲譽養成期**：先小量、真實內容寄送；觀察退信率
      - ⚠️ 目前 `test1@atwho.org` 等測試地址仍在 D1 → 上線前清理測試資料（見 §5）

- [ ] **4. MTA-STS 由 testing → enforce（觀察 2–4 週後）**

      **前置條件（缺一不可，2026-10-05 稽核新增）**

      - (a) **訊號記錄必須存在**：`_mta-sts.atwho.org` CNAME → `_mta-sts.mx.cloudflare.net`（Proxy OFF）。
            此記錄曾無聲消失過 → 切 enforce 前先重驗：
            ```powershell
            nslookup -type=TXT _mta-sts.atwho.org chelsea.ns.cloudflare.com
            # 預期：canonical name = _mta-sts.mx.cloudflare.net，下一段 "v=STSv1; id=20230615T153000;"
            ```
      - (b) **要有 TLS-RPT 報告可看**：目前 `_smtp._tls.atwho.org` **不存在** → 收不到 TLS 失敗報告，
            等於「觀察幾週」沒有資料依據。需自行發佈（RFC 8460）：
            ```
            Type: TXT   Name: _smtp._tls   Value: v=TLSRPTv1; rua=mailto:<收報告的信箱>
            ```
            （TLS-RPT 只有「有記錄」時寄件端才會回報；沒記錄＝零回報，不代表沒有 TLS 問題）

      **切換步驟**
      ```powershell
      # 1) 確認政策與訊號都正確
      curl.exe -s https://mta-sts.atwho.org/.well-known/mta-sts.txt
      # 2) 改 packages/mta-sts/wrangler.jsonc 的 MODE_OVERRIDE=enforce 後重新部署
      #    pnpm --filter @atwhomail/mta-sts run deploy
      ```
      預期：政策檔為 `mode: testing`（切換後變 `enforce`）。
      ⚠️ enforce 設定錯誤會**拒收正常來信** → 變更後 24 小時內密切觀察（觀察管道見 (b)）。

- [x] **5. 監控** ✅ 2026-10-06 完成
      - **本機 watchdog**（`scripts/backup_watchdog.py`，由 Windows 排程 `AtWhoMail Backup Watchdog` 每 10 分鐘執行，**不依賴 Hermes**）：檢查 ① 心跳回報（見下）② `agent.log` 新鮮度（>12 分鐘無日誌即告警）③ 崩潰重啟密度（60 分鐘內 ≥3 次）④ 每日 verify 的 exit code 與新鮮度 ⑤ API `/api/health`（200 且 `db=ok`）⑥ agent 實例數（必須恰為 1）⑦ **MTA-STS 訊號與政策**（DoH 查 `_mta-sts` CNAME ＋ HTTPS 政策 `mode:`）
      - **雲端 liveness 心跳（補上「整台機器關機」的盲區）**：`atwhomail-heartbeat` Worker ＋ D1 `system_heartbeat`；本機每次 watchdog 執行即 POST 心跳，**Cron 每 15 分鐘**檢查，超過 45 分鐘未回報 → 由雲端寄告警信（12 小時去重）。每次 cron 都在 D1 留下 `last_cron_at`，可自我驗證
      - **告警通道＝電子郵件**（`alerts@atwho.org` → `ulhome@gmail.com`，經自家 `/api/mail/send` 或 Worker 的 `EMAIL` binding）：因為本機未接任何 Hermes 推播通道（無 Telegram/Discord），郵件是唯一保證看得到的通道
      - **健康時完全靜默**（不寄信）；同類告警 **6 小時內不重複寄送**（狀態檔 `mail-backup/logs/watchdog-alert.state`；恢復後即清除狀態，讓新事件能立即告警）
      - Workers **Observability 已開啟**（api / email-handler / mta-sts / heartbeat）→ Dashboard 可看 logs/traces

- [x] **6. 密碼與 secrets 盤點**（輪替計畫）— PG 部分 ✅ 2026-10-06 完成
      | Secret | 存放 | 用途 | 狀態 / 輪替建議 |
      |---|---|---|---|
      | `ADMIN_TOKEN` | `packages/api/.dev.vars` + Worker secret | rescue 通道（owner 等效） | 6–12 個月 |
      | `JWT_SECRET` | 同上 | session 簽章（輪替＝全體登出） | 12 個月 |
      | CF API Token | `~/.atwhomail-cf-token` | wrangler / restore | 已在 Dashboard 設 1 年 TTL |
      | **備份 agent 角色密碼** | `packages/backup-agent/.env`（`PG_USER=atwhomail_backup`） | 本機備份庫寫入 | ✅ 2026-10-06 建立**專用角色**（不再用 `postgres` 超級使用者），43 字元隨機密碼；後續每 12 個月 |
      | **`postgres` 超級使用者密碼** | `~/.atwhomail-pg-pass` | 人力維運 / pgAdmin | ✅ 2026-10-06 已由預設 `postgres` 輪替為 43 字元隨機密碼 |
      | owner 密碼 | 僅雜湊存 D1 | 登入 | 建議改用強密碼（目前為測試期弱密碼） |

      ⚠️ **影響範圍（2026-10-06 實作紀錄）**：`pg_hba.conf` 全為 `scram-sha-256` → 密碼一改**立即生效**，但**既有連線不受影響**（所以必須重啟 agent 才會套用新憑證）。
      **已存連線需更新**：pgAdmin／DBeaver 等 GUI 的 `postgres` 連線請改用 `~/.atwhomail-pg-pass` 的新密碼。
      **驗收指令**（`PSQL` 指 `C:\Program Files\PostgreSQL\17\bin\psql.exe`）：
      ```powershell
      # 舊預設密碼必須失敗
      $env:PGPASSWORD='postgres'; & $PSQL -h localhost -U postgres -d atwhomail_backup -c "select 1"
      # 新 agent 角色可讀寫（.env 內為 43 字元密碼）
      & $PSQL -h localhost -U atwhomail_backup -d atwhomail_backup -c "select current_user, count(*) from messages"
      ```

- [ ] **7. 每季演練還原**（09 文件 §5.1 Runbook）
      **前置**：舊測試標的（`mail-d1-restore-test` / `mail-r2-restore-test`）已於 2026-10-05 刪除 → 先建立**全新的**測試 D1 與 bucket，並填入 `.env` 的 `D1_TEST_ID` / `R2_TEST_BUCKET`（詳見 09 §5.1 步驟 0b）
      ```powershell
      cd D:\Mail\Atwhomail
      pnpm --filter @atwhomail/backup-agent run verify
      pnpm --filter @atwhomail/backup-agent run restore-d1 -- --target=test --yes
      pnpm --filter @atwhomail/backup-agent run restore-r2 -- --bucket=test --yes
      ```

## 3. 認證與端點矩陣

| 端點 | 認證 | 用途 |
|---|---|---|
| `GET /api/health`、`GET /` | 公開 | 健康檢查 |
| `POST /api/auth/login`、`/api/auth/mailbox-login` | 公開（5 次失敗鎖 15 分） | 取得 session |
| `/api/email-addresses*`（含密碼） | owner 或 rescue | 地址管理 |
| `/api/mail/*`、`/api/attachments/*` | owner 或 mailbox（scope 隔離） | 收發信與附件 |
| `/api/backup/changes`、`/api/backup/r2/*` | owner 或 rescue | 備份拉取（**含 password_hash → 僅維運**） |
| restore | **僅本機腳本 + CF token** | 手動還原（production 無寫入端點） |

## 4. 成本（2026-09 查證）

| 項目 | 方案 | 費用 |
|---|---|---|
| Workers Paid（含 Email Sending 3,000 封/月） | Paid | $5/月 |
| D1 / R2 | Free tier（目前用量遠低於額度） | $0 |
| 超出寄信 | — | $0.35 / 千封 |
| **合計** | | **約 $5/月** |

## 5. 已知缺口（上線前評估，非阻塞）

| # | 缺口 | 影響 | 建議 |
|---|---|---|---|
| 1 | ~~測試資料仍在 production D1~~ → **✅ 2026-10-06 已清理**：退役測試地址 `bob`／`phase13`（`test1` **保留為沙盒**）、軟刪 11 封測試信；現況 **4 個地址**（`test1` 沙盒＋`tlsrpt`／`alerts`／`app` 功能地址）、**2 封信**（僅 watchdog 告警紀錄）；R2 物件未動以維持備份鏡像完整性 | — | 日後測試請用 `test1@atwho.org`（沙盒）並測試後刪除 |
| 2 | `mail/` 物件無 `sha256` custom metadata | 收信端無法用 R2 metadata 做完整性比對（改由 `r2_manifest` 記錄） | Phase 14+ 於 handler 寫入 metadata |
| 3 | 不支援 Range 請求（下載大附件無法續傳） | ≤25MiB 附件需一次下載 | 之後補 206 支援 |
| 4 | inline 附件（`cid:` 內嵌圖）不顯示 | HTML 信的內嵌圖片看不到 | 之後做 cid → R2 對應 |
| 5 | 遠端圖片被剝離（MVP 刻意） | HTML 信中的外部圖片不顯示 | 之後做圖片代理（08 §16） |
| 6 | 無**內建**前端 App（Inbox UI） | 本 repo 只提供 API，不含 UI | ✅ 2026-10-06：**外部自建 PWA 已可經 API 收發信**（CORS 白名單已開、`mailbox-login` 逐信箱隔離）；本 repo 維持只出 API |
| 7 | `email_aliases` 表已建但無 API | 別名功能未實作 | 依需求排程 |
| 8 | ~~TLS-RPT（`_smtp._tls`）未發佈~~ → **✅ 2026-10-06 已發佈**：TXT `v=TLSRPTv1; rua=mailto:tlsrpt@atwho.org,mailto:ulhome@gmail.com`（權威 NS 實測一致） | — | 觀察 2–4 週後再評估切 `enforce`（§2-4） |
| 9 | ~~演練殘留資源未清~~ → **✅ 2026-10-05 已解決**：測試 D1 `mail-d1-restore-test`、R2 `mail-r2-restore-test` 已刪除（僅保留 production） | — | 下次季度還原演練前需先建立新的測試標的（見 §2-7；`docs/09` §5.1 步驟 0b） |
| 10 | **CF API token 缺 read 權限**：DNS / Email Routing / Email Sending 皆 403 | 稽核無法全自動，只能靠公開 DNS | Dashboard → API Tokens → Edit 加**唯讀** scope（token 值不變，無需換檔） |
| 11 | ~~`_mta-sts` 訊號記錄曾無聲消失~~ → **✅ 2026-10-06 已納入自動監控**：watchdog 每 10 分鐘以 DoH 檢查訊號 CNAME 與政策端點，異常即寄告警信 | — | 仍建議每次動 mail DNS 後人工重驗（`07` Step 6、skill `dns-mta-sts-verification.md` Rule 1b） |
| 12 | ~~備份失敗完全不會告警~~ → **✅ 2026-10-06 已解決**：新增每 10 分鐘的本機 watchdog（`scripts/backup_watchdog.py`＋Windows 排程）與郵件告警（`alerts@atwho.org` → `ulhome@gmail.com`），涵蓋 agent 停滯／崩潰重啟密度／verify 失敗／API 異常／實例數異常 | — | 健康時靜默；同類告警 6 小時節流（詳見 §2-5） |
| 13 | ~~整台機器關機時不會有任何告警~~ → **✅ 2026-10-06 已實作**：新增 `atwhomail-heartbeat` Worker（D1 `system_heartbeat`；Cron 每 15 分鐘）。本機 watchdog 每次執行即 POST 心跳；**超過 45 分鐘未回報 → 由雲端寄告警信**（12 小時去重）。已驗證：cron 執行痕跡 `last_cron_at`（實測 16:00:19）、本機回報、無／錯 token 401、103 測試通過 | — | 端到端「停擺→收到信」建議用**關機驗收**：關機 >45 分鐘應收到主旨「本機停擺（心跳停止）」 |

## 6. 相關文件

- 架構：`01-architecture.md`｜流程：`02-email-flows.md`｜Schema：`03`、`04`
- API：`05-api-spec.md`｜結構：`06`｜CF 資源：`07`｜安全：`08-security-checklist.md`
- 備份／還原：`09-backup-dr.md`（§5.1 Runbook）｜實作計畫：`10-implementation-plan.md`
- **外部 App／PWA 整合：`12-pwa-integration.md`**（端點契約、CORS、上線檢查）
