---
title: 上線檢查清單（Launch Checklist）
status: 現況
updated: 2026-11-11
read-when: 上線前檢查、端點矩陣 —— **大檔（84 KB），只 grep 關鍵字**
---

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
| 測試 | ✅ 113 個 / 8 檔 | `pnpm test`（workerd 測試池，含 43 個 API 整合測試 + 8 收信 + 5 MTA-STS） |
| 內建前端 | ✅ 2026-10-07 | `web/`（Vite + React 19）Yahoo Mail 風格 UI；`pnpm dev:web` → http://localhost:5173 |
| 安全標頭 | ✅ | nosniff / DENY / no-referrer / HSTS / CSP（HTML 端點保留專屬 CSP） |
| 健康檢查 | ✅ | `GET /api/health` 含 D1 探測（DB 異常 → 503） |
| 訪客註冊（Phase 1） | 🟡 程式完成、**未部署** | 邀請碼註冊＋配額／限流／停權＋稽核；migration 0006 本地已套用、**遠端待 owner**（見 §2-8） |
| 別名 Phase 1（D25） | 🟡 程式完成、**未部署** | 別名建立／列表／停用＋收信轉投＋回覆自動 From（範圍 A）；migration `0010` 本地測試已套用、**遠端待 owner**（見 §2-19） |
| ID 撞二級網域（D20） | 🟡 程式完成、**未部署** | `check-id` 端點＋`register-request`／`register-verify` 複驗；DoH 26 TLD、fail-open、90／7 天快取；migration `0011` 本地測試已套用、**遠端待 owner**（見 §2-20） |
| Turnstile 防機器人（D23） | 🟡 程式完成、**金鑰未提供／未部署** | `register-request` 選填 `turnstile_token`；secret 未設定自動跳過、site key 空字串不顯示 widget；無 migration（見 §2-21） |
| App 登入代理（D26） | 🟡 程式完成、**未部署** | `auth.atwho.org` 薄代理（`atwhomail-auth`）＋ App Clients／`app-login`／`exchange`／`auth/me`；migration `0012` 本地測試已套用、**遠端待 owner**（見 §2-22） |
| Google OAuth ＋ 忘記密碼（D27） | 🟡 程式完成、**未部署** | `GET /api/auth/oauth/google/start`／`callback`、`POST /api/auth/user-login`、`forgot-password`／`reset-password`；migration `0013` 本地測試已套用、**遠端待 owner**（見 §2-23） |
| 個人設定＋`app.` 收斂（D29） | 🟡 程式完成、**未部署** | `GET /api/account/settings`、`POST /api/account/password`；前端 `app.atwho.org` 隱藏所有管理功能（即使 owner）、新「個人設定」頁；**無 migration**（見 §2-24） |

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
| DMARC | ✅ `_dmarc` **`p=quarantine`**（2026-11-09 升級）＋ `rua=…@dmarc-reports.cloudflare.net` |
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
      - **不彈視窗（2026-10-07 修正）**：三個排程的動作都經過 `scripts/run-hidden.vbs`（`wscript.exe` 以視窗狀態 0 啟動並回傳子程序結束碼）。原因：`LogonType=Interactive` ＋ `cmd.exe /c …` 會在桌面**每 10 分鐘彈出 cmd 視窗**，而 Task Scheduler 的 `Settings.Hidden` 只隱藏「工作項目本身」、**不隱藏視窗**。實測（對照組）`MainWindowHandle`：經 VBS = 0（隱藏）、直接啟動 = 非 0（可見）
      - ⚠️ **教訓：Windows 上 Hermes cron 不能執行 `.sh`** → 回報 `bash not found on PATH` 並連續失敗 109 次（2026-10-06~07 完全沒在運作）。已改用 `.py` 啟動器（`~/AppData/Local/hermes/scripts/atwhomail-backup-watchdog.py`，呼叫同一支 `backup_watchdog.py`）
      - **DKIM 記錄完整性（2026-10-07 新增，第 8 項檢查）**：每輪以 DoH 讀回 `cf-bounce._domainkey`／`cf2024-1._domainkey` 公鑰並驗證 ① 記錄存在 ② 嚴格 base64 可解 ③ 能解出 ≥2048-bit RSA ④ **指紋與上次相同**（被默默換掉＝DNS 可能被動手的訊號）。這正是最真實的故障模式：其他檢查全綠、但寄出的信全部失去 DKIM 而進垃圾匣（2026-09-02 曾發生）。**端到端**驗證（真的寄一封信、取回已簽章正本、驗算簽章）由 `scripts/dkim_verify.py` 按需執行（建議每月或改動寄信／DNS 設定後）
      - **雲端 liveness 心跳（補上「整台機器關機」的盲區）**：`atwhomail-heartbeat` Worker ＋ D1 `system_heartbeat`；本機每次 watchdog 執行即 POST 心跳，**Cron 每 15 分鐘**檢查，超過 45 分鐘未回報 → 由雲端寄告警信（12 小時去重）。每次 cron 都在 D1 留下 `last_cron_at`，可自我驗證
      - **告警通道＝電子郵件**（`alerts@atwho.org` → `ulhome@gmail.com`，經自家 `/api/mail/send` 或 Worker 的 `EMAIL` binding）：因為本機未接任何 Hermes 推播通道（無 Telegram/Discord），郵件是唯一保證看得到的通道
      - **健康時完全靜默**（不寄信）；同類告警 **6 小時內不重複寄送**（狀態檔 `mail-backup/logs/watchdog-alert.state`；恢復後即清除狀態，讓新事件能立即告警）
      - Workers **Observability 已開啟**（api / email-handler / mta-sts / heartbeat）→ Dashboard 可看 logs/traces

- [x] **6. 密碼與 secrets 盤點**（輪替計畫）— PG 部分 ✅ 2026-10-06 完成
      | Secret | 存放 | 用途 | 狀態 / 輪替建議 |
      |---|---|---|---|
      | `ADMIN_TOKEN` | `packages/api/.dev.vars` + Worker secret | rescue 通道（owner 等效） | 6–12 個月 |
      | `JWT_SECRET` | 同上 | session 簽章（輪替＝全體登出） | 12 個月 |
      | CF API Token | `~/.atwhomail-cf-token` | wrangler / restore / DNS 稽核 | ⚠️ 文件原寫「已設 1 年 TTL」，但 **2026-10-07 實測 `/user/tokens/verify` 回報無到期日（`expires_on` 為空）** → 待 Dashboard 目視確認實際值後再定案；另 2026-10-07 已加 `Zone:DNS:Read`（仍缺 Email Routing／Sending read） |
      | **備份 agent 角色密碼** | `packages/backup-agent/.env`（`PG_USER=atwhomail_backup`） | 本機備份庫寫入 | ✅ 2026-10-06 建立**專用角色**（不再用 `postgres` 超級使用者），43 字元隨機密碼；後續每 12 個月 |
      | **`postgres` 超級使用者密碼** | `~/.atwhomail-pg-pass` | 人力維運 / pgAdmin | ✅ 2026-10-06 已由預設 `postgres` 輪替為 43 字元隨機密碼 |
      | owner 密碼 | 僅雜湊存 D1 | 登入 | 建議改用強密碼（目前為測試期弱密碼） |

      ⚠️ **影響範圍（2026-10-06 實作紀錄）**：`pg_hba.conf` 全為 `scram-sha-256` → 密碼一改**立即生效**，但**既有連線不受影響**（所以必須重啟 agent 才會套用新憑證）。
      **已存連線需更新**：pgAdmin／DBeaver 等 GUI 的 `postgres` 連線請改用 `~/.atwhomail-pg-pass` 的新密碼。
      **驗收指令**（`PSQL` 指 `C:\Program Files\PostgreSQL\17\bin\psql.exe`）：
      ```powershell
      # 舊預設密碼必須失敗
      $env:PGPASSWORD='postgres'; & $PSQL -h localhost -U postgres -d atwhomail_backup -c "select 1"  # secret-scan:ignore（已輪替的 PostgreSQL 預設密碼；此行是「舊密碼必須失敗」的驗證指令）
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

- [ ] **8. Phase 1 訪客註冊上線前檢查**（2026-10-12 實作完成；**migration 0006 遠端尚未套用、API 尚未部署**）
      - [ ] **migration 0006 遠端套用**（由 owner 執行；實作 agent 不得跑 `--remote`）
            ```powershell
            cd D:\Mail\Atwhomail
            pnpm --filter @atwhomail/api exec wrangler d1 migrations apply mail-d1 --remote
            ```
      - [ ] **配額值確認**（單一來源：`packages/api/src/index.ts` 的 `QUOTA`）：
            每日 **50**／暖機期前 24 小時 **5**／每小時 **10**。要調整就改這一處（`docs/13` §6.5 C1–C3；D33 於 2026-11-07 改為 50）
      - [ ] **既有 owner 地址也受配額約束**（migration 預設 `daily_send_quota=20`）→
            若某地址要不受限，調高該地址的 `daily_send_quota`（或 `can_send=0` 立即關閉寄信）
      - [ ] **暖機期行為驗收**：新註冊帳號前 24 小時只能寄暖機上限（預設 20，可調 1–50）封（超過 → `429 QUOTA_EXCEEDED`）
      - [ ] **D35 暖機上限調整**：訪客管理「寄信設定」可改暖機上限（1–50，預設 20）；
            實際有效上限為 `min(每日配額, 暖機上限)`；`warmup_exempt` 仍可整個跳過
      - [ ] **停權流程演練**（C7 一鍵止血）：
            ```powershell
            # 停權（suspended）→ 該帳號登入與寄信應立即 403 ACCOUNT_SUSPENDED
            curl.exe -sS -X PATCH https://atwhomail-api.ulhome.workers.dev/api/users/<id>/status `
              -H "x-admin-token: $env:ADMIN_TOKEN" -H "Content-Type: application/json" -d '{\"status\":\"suspended\"}'
            ```
      - [ ] **稽核可查**：`registration_audit` 應有 `register_ok`／`register_rejected`／`send_rejected_*`
            ```powershell
            pnpm --filter @atwhomail/api exec wrangler d1 execute mail-d1 --remote --command "SELECT event, COUNT(*) FROM registration_audit GROUP BY event"
            ```
      - [ ] **備份鏡像**：本機 agent 啟動後套用 `0003_local_invites`，`invites` 納入鏡像；
            `registration_audit` 刻意不納入（`docs/03` §5.3）
      - [ ] **CORS**：`ALLOWED_ORIGINS` 已含 `https://app.atwho.org`（訪客入口）——開放前確認 Access 政策已切 `Everyone`
      - ⚠️ **尚未交付**（`docs/13` §6.5 的 C5／C6）：寄信量告警（達 80% 或全帳號 >200 封/日）與
            「連續 3 日觸頂自動停權」不在本次 `docs/14` §4 規格內 → 需 owner 決定是否納入下一階段

- [ ] **9. 階段 2：管理登入 Access 閘門（D2）＋ owner 自助改密碼（D7）**（2026-10-14 程式完成；**未部署**）
      - [ ] **部署前先設定兩個環境變數**（非機密，放 `vars`；實際值見 `docs/16` §9）：
            `ACCESS_TEAM_DOMAIN`（Access 團隊網域）、`ACCESS_MAIL_AUD`（`mail.atwho.org` 應用的 Audience）
      - [ ] ⚠️ **未設定 `ACCESS_MAIL_AUD` ＝ 過渡放行**（管理登入不驗 Access JWT，只記 warning）→
            設定後才真正生效；這是刻意的**回退閥門**（出事就移除該變數）
      - [ ] 部署後驗收（`docs/16` §5 階段 2）：
            ① 從 `mail.atwho.org`（通過 Access）可登入 ✅
            ② `curl` 直打 `https://atwhomail-api.ulhome.workers.dev/api/auth/login` → **403 `ADMIN_LOGIN_REQUIRES_ACCESS`** ✅
            ③ 從 `app.atwho.org` 用 owner 帳號 → **403** ✅
            ④ 訪客 `register`／`mailbox-login`／`/api/me`／`/api/mail/*` 不受影響 ✅
      - [ ] owner 自助改密碼：網頁右上帳號選單 →「帳號設定」（舊密碼錯誤 401、成功後所有裝置的 session 立即失效）
      - [ ] 監控：`registration_audit` 應出現 `owner_password_changed`；`ACCESS_MAIL_AUD` 未設定時 Worker log 會有過渡 warning

- [ ] **10. 階段 3／4：管理主控台（D5 訪客管理、D4 邀請碼管理）**（2026-10-14 程式完成；**未部署、migration 0007 未套用**）
      - [ ] ⚠️ **部署前先套用 migration 0007**（由 owner 執行；實作 agent 不得跑 `--remote`）：
            ```powershell
            cd D:\Mail\Atwhomail
            pnpm --filter @atwhomail/api exec wrangler d1 migrations apply mail-d1 --remote
            ```
            內容：`email_addresses` 新增 `warmup_exempt INTEGER NOT NULL DEFAULT 0`（純新增，**不改既有資料行為**）。
            未套用時程式仍可運作：寄信走原本的暖機限制，`PATCH /api/users/:id/warmup` 回
            `409 MIGRATION_REQUIRED`（不假裝成功）。
      - [ ] 部署後驗收（對應 `docs/16` §6 T12–T16）：
            ① `GET /api/users?role=visitor`（owner）回訪客清單，含 `mail_count`／`last_activity_at`；
               訪客 JWT → 403 ✅
            ② owner 以訪客地址 id 呼叫 `/api/mail/*` → **403／404**（N9：不得讀取訪客信件內容）✅
            ③ `PATCH /api/users/:id/quota`：值域 1–50（超出 422）、成功寫稽核 `quota_changed` ✅
            ④ `PATCH /api/email-addresses/:id/status`：owner 可停用訪客地址（**不再 404**）；
               停用後該訪客無法登入、無法寄信（皆 403 `ADDRESS_DISABLED`，D8-1／D8-4）✅
            ⑤ `GET /api/invites?reveal=1`（owner）回全碼並寫稽核 `invite_revealed`；未帶 reveal 仍只回遮罩碼 ✅
      - [ ] 網頁驗收：`mail.atwho.org` 側欄出現「邀請碼管理」「訪客管理」（`app.atwho.org` **不**出現）；
            邀請碼可建立／複製／撤銷（撤銷需二次確認）；訪客可停權／復權、地址停用／啟用、調整配額；
            側欄文案為「我的全部信箱」
      - [ ] 暖機豁免（可選）：勾選後該帳號不受註冊後 24 小時暖機上限（預設 20）限制，**仍受每日配額**；
            ⚠️ 新網域聲譽期不建議大量開啟

- [ ] **11. 階段 5：停權／停用的語意釐清與立即生效（D8）**（2026-10-15 程式完成；**未部署**）
      - [ ] ⚠️ **部署前告知 owner 一行為變更**：停權／停用現在會**立即**踢掉該使用者已登入的 session
            （先前要等 JWT 24 小時過期）。訪客若反映「突然被登出」，先確認是否為停權／停用造成。
      - [ ] 部署後驗收（對應 `docs/16` §6 T17–T19）：
            ① **停權立即生效**：訪客已登入 → owner 停權 → **同一個** token 下一個請求即
               `403 ACCOUNT_SUSPENDED`（`/api/me`、`/api/mail/inbox` 皆同）✅
            ② **停用立即生效**：停用地址 → 既有 token 立即 `403 ADDRESS_DISABLED` ✅
            ③ `mailbox-login` 錯誤碼矩陣：密碼錯 → 401 `INVALID_CREDENTIALS`；密碼正確但地址停用 →
               403 `ADDRESS_DISABLED`（**舊版誤回 401**）；帳號停權 → 403 `ACCOUNT_SUSPENDED` ✅
            ④ 復權／重新啟用後，**同一個未過期的 token** 立即恢復可用（狀態為即時判定）✅
            ⑤ 迴歸：`can_send=0` 仍是 `403 SEND_NOT_ALLOWED`；owner 仍讀不到訪客信件（N9）；
               rescue（`x-admin-token`）與 `/api/backup/*` 行為不變（N5）✅
      - [ ] 網頁文案驗收：訪客管理的按鈕為「停權帳號（所有地址；仍可收信）」／「停用地址（連收信都停止）」，
            兩者 hover 有差異說明；**停用地址前**的二次確認明寫「此地址將立即停止收信，停用期間的來信不會保留」
      - [ ] 稽核：`registration_audit` 的 `login_failed` 應出現 `reason` = `ADDRESS_DISABLED`／`ACCOUNT_SUSPENDED`
            （只有帳密不符累計 `auth_attempts`，狀態拒絕不計）
      - [ ] ⚠️ 提醒（語意，非程式問題）：**停用地址會丟棄停用期間的來信且不可逆**；
            只想擋登入與寄信、但要保留來信 → 用**停權帳號**（`PATCH /api/users/:id/status`）

- [ ] **12. 階段 6：刪除訪客（D9）＋查不到列的 session 失效（D10）**（2026-10-15 程式完成；**未部署**）
      - [ ] ⚠️ **部署前告知 owner 一行為變更**：帳號／地址被刪除後，其**舊 JWT 立即失效** →
            `401 TOKEN_STALE`「session 已失效，請重新登入」（先前是放行，會回 404／空清單）。
            訪客若反映「突然被登出」，先確認帳號是否已被刪除。
      - [ ] 部署後驗收（對應 `docs/16` §6 T20–T24；**請用測試訪客帳號**，刪除不可復原）：
            ① `DELETE /api/users/:id`（owner）對訪客 → 200，且 user／address／messages／attachments／
               aliases／auth_attempts 皆清除；`registration_audit` 保留並新增 `user_deleted` ✅
            ② 對 **owner** 帳號 → 403 `FORBIDDEN`（管理帳號受保護）✅
            ③ 訪客 JWT 呼叫 → 403；無 session → 401 ✅
            ④ 刪除後，該地址的舊 mailbox JWT → 401 `TOKEN_STALE`（D10）✅
            ⑤ D10 不得造成 500：查不到列的 owner session → 401，且 rescue（`x-admin-token`）仍可通過（N5）✅
      - [ ] 網頁驗收：訪客管理每列出現 **danger 樣式「刪除」** 按鈕；二次確認明寫
            「將永久刪除該訪客的帳號、地址、所有信件與附件，且無法復原；若只是要暫停，請改用『停權』」；
            成功後清單重整並顯示 toast
      - [ ] 稽核：`registration_audit` 出現 `user_deleted`（`detail.by`＝操作 owner id、被刪 username／
            address／信件數／附件數，時間為 `created_at`），且該帳號原有的註冊／登入稽核列**仍在**
      - [ ] ⚠️ 提醒：刪除**不可復原**（含 R2 的信件與附件物件）；只是要暫停 → 用**停權**
            （`PATCH /api/users/:id/status`：可逆、來信照收）

- [ ] **13. 階段 7：地址刪除語意補平（D11）**（2026-10-15 程式完成；**未部署**）
      - [ ] ⚠️ **部署前告知 owner 一行為變更**：`POST /api/email-addresses` 的重複檢查改為
            **不看 `deleted_at`** —— 對「曾被 soft 刪除的名稱」重建同名地址，舊版會撞 UNIQUE 回
            **500**，新版回 **409 `ADDRESS_EXISTS`**（名稱尚未釋放，需先 `?mode=hard` 永久刪除）。
            語意不變（soft 過的名稱仍不可重建），只是錯誤碼變乾淨。
      - [ ] 部署後驗收（對應 `docs/16` §6 T25–T29；**請用測試地址**，hard 不可復原）：
            ① `mode=soft`（預設）：地址標記 deleted、**信件與 R2 保留**、回 `204`、
               稽核 `address_deleted(mode=soft)` ✅
            ② `mode=hard`：該地址所有 messages（含垃圾桶）／attachments／R2 物件清除、回 `200`
               附數量、稽核 `address_deleted(mode=hard)` ✅
            ③ hard 之後**同名可重建**（201）；soft 之後同名仍不可重建（409）✅
            ④ 他人地址／訪客地址 → `404`；訪客 JWT → `403`；無 session → `401`；
               `mode` 非法 → `400 INVALID_MODE` ✅
            ⑤ 稽核 `address_deleted` 不含任何主旨／寄件者／內文（N9）✅
      - [ ] 網頁驗收：地址管理的「刪除」跳出兩個選項 ——
            **「停用並保留信件」（預設）**／**「永久刪除」**（附「無法復原」警語），
            對話框顯示「此地址有 N 封信，永久刪除將一併刪除」
      - [ ] 網頁驗收：地址管理與訪客管理各出現一行定位說明
            （「地址管理＝你自己的信箱」／「訪客管理＝別人用邀請碼註冊的帳號」）
      - [ ] 稽核：`registration_audit` 出現 `address_deleted`（`detail.mode`＝`soft`／`hard`、
            `detail.messages`＝實際刪除信件數、`detail.by`＝操作 owner id）
      - [ ] ⚠️ 提醒：hard 刪除**不可復原**（含 R2 上的原始信件／HTML／附件）；
            只是要停收信 → 用**停用**（可再啟用），只是要停止登入／寄信 → 用**停用地址**或**停權帳號**

- [ ] **13b. 階段 7 補完：清除「已軟刪除」的地址（D11-5）**（2026-10-15 程式完成；**未部署**；
      對應 `docs/16` §6 **T30–T32**、`docs/05` §2.16）
      - [ ] 部署後驗收（**請用測試地址**，hard 不可復原）：
            ① soft 刪除一個地址 → 它**不出現**在地址清單，但 `GET /api/email-addresses?deleted=1`
               找得到（含 `deleted_at` 與 `messages`）✅
            ② 對該地址 `DELETE /api/email-addresses/:id?mode=hard` → `200` 且
               `previously_deleted: true`；messages／attachments／R2 物件清除、**同名可重建**（201）✅
            ③ 對已軟刪除的地址再送 `mode=soft`（或未帶 mode）→ **`404 NOT_FOUND`**（明確、**非 500**），
               且 `deleted_at` 未被改寫、信件與 R2 全數保留 ✅
            ④ 他人地址／訪客地址（含已軟刪除的）→ `404`；訪客 JWT → `403`；無 session → `401` ✅
            ⑤ `GET /api/email-addresses?deleted=1` 僅 owner 可用；只回**自己名下**的已刪除地址 ✅
      - [ ] 網頁驗收：地址管理頁下方出現**「已刪除的地址」收合區塊**，列出 地址／刪除時間／信件數；
            每列「永久刪除」→ 二次確認明寫「將清除 … 的所有信件與附件（含垃圾桶）…；不可復原」✅
      - [ ] 網頁驗收：把該區塊的請求弄失敗（例如暫時斷網／改錯 API base）→ **只有區塊內顯示錯誤與
            「重試」**，地址清單、建立地址、密碼等功能照常（**整頁不得壞掉**）✅
      - [x] ~~已知限制：已 soft 刪除的地址無法再由 API 升級為 hard~~ → **已於 D11-5 解除**：
            該類列現在可由 `?mode=hard` 永久清除（連同其 R2 物件與佔用的名稱）
      - [ ] ⚠️ 行為變更告知：**已軟刪除的地址**送 `mode=hard` 由 `404` 改為 `200`（升級路徑）；
            `mode=soft`（含未帶 mode）對這類列**維持 `404`**（既有行為不變，只是明文確立）

- [ ] **14. 階段 8：前端 jsdom 測試環境（D12）＋ 錯誤路徑測試（D13）＋ 推送前機密稽核（D14）**
      （2026-10-15 程式完成；**未部署、無 production 行為變更、無 migration**；
      對應 `docs/16` §6 **T33–T35**）
      **⚠️ 部署前告知：本階段沒有任何 API／UI 行為變更 → 不必排進部署順序，也沒有回退需求。**
      它的價值在「往後每一次改動都更難悄悄壞掉」，而不是新功能。

      **D12 —— 前端測試環境（測試環境說明）**
      - [ ] 新增 `web/vitest.config.ts`：**獨立一份 jsdom 設定**（`@vitejs/plugin-react` ＋
            `environment: "jsdom"`），只收 `web/test/**/*.dom.spec.tsx`。
            根目錄 `vitest.config.ts`（`@cloudflare/vitest-plugin` 的 **workerd** pool）**未變動**；
            既有純函式測試（`statusSemantics.spec.ts`／`hostMode.spec.ts`／`adminConsole.spec.ts`）
            **留在原 pool、一行未改**（D12 明文要求）。
            為什麼要分開：workerd pool 沒有 DOM，`.tsx` 元件在裡面無法渲染（這是 D11-3／D11-5
            當時只測得到「文案純函式」的原因）。
      - [ ] 測試工具：**`@testing-library/react` 16**（＋ `@testing-library/dom`）＋ **`jsdom` 30**。
            選它而不選「原生 `react-dom` ＋ `act`」：`findBy*`／`waitFor` 已內建 act 包裝
            （不必自己處理「更新不在 act 內」的警告），查詢 API 也讓斷言直接寫成使用者看到的文字。
            新增的 devDependency 只有這三個（＋ `vitest` 宣告在 `web`），全部只在 `web` 套件。
      - [ ] 執行方式：根目錄 **`pnpm test`** ＝ `pnpm test:workers`（workerd）→ `pnpm test:web`（jsdom）
            依序執行；也可分開單跑。
      - [ ] ⚠️ **jsdom 下一律 mock `fetch`**：`web/test/dom-setup.ts` 先鋪一個「一被呼叫就丟例外」的
            `fetch`，忘記 mock 的測試會**立刻失敗**，不可能真的連外網；各測試再用
            `web/test/dom-fetch.ts` 的 `installFetch()` 依 URL 回假資料（並記錄呼叫，可斷言送出的請求）。
      - [ ] 涵蓋（T33，共 14 個渲染案例）：① 已刪除地址區塊（地址／刪除時間／信件數）② 刪除對話框
            兩選項與「無法復原」③④ 停權／停用的文案與 tooltip ⑤ 刪除訪客二次確認 ⑥ 清單載入失敗
            → 只壞該區塊、整頁照常（＋重試只重打失敗的端點）

      **D13 —— 錯誤路徑（R2 失敗／D1 回滾）＋注入手法**
      - [ ] 測試檔 `packages/api/test/admin-delete-failure.spec.ts`（7 案例）。手法是
            **dependency injection，不改 production 一行**：測試本來就是
            `app.request(path, init, env, ctx)` 直接餵環境，所以用 `Object.create(env)` 只覆寫
            單一 binding 就等於換掉被測程式看到的依賴 ——
            · R2：`Proxy` 包住真 bucket，只讓 `delete()` 丟例外（`get`／`put` 照常 → 可斷言物件還在）
            · D1：`Proxy` 包住真 `DB`，在 `batch()` **尾端追加一句必定失敗的 SQL**。關鍵是前面的
              語句**真的執行過**，全靠 D1 交易回滾 → 失敗後斷言 `deleted_at` 仍為 `NULL`，
              證明的是「真的回滾」而不是「根本沒執行」。
      - [ ] 驗收：R2 失敗 → 仍 `200`、D1 照常刪、`r2_objects: 0`、log 有 `R2 delete failed`；
            batch 失敗 → `500 DELETE_FAILED`「已回滾，資料未變更」、六張表原封不動、不寫稽核。
            （`docs/05` §2.12／§2.14 已同步此說明）

      **D14 —— 推送前機密稽核腳本**
      - [ ] `Atwhomail/scripts/secret-scan.mjs`（**純 Node、零依賴**）＋ `pnpm secret:scan`。
            ⚠️ 本次**只新增**這一支腳本，既有 `scripts/*` 一字未動（N8）。
      - [ ] 建議：**每次 push 前跑一次**（要自動化的話掛個人 pre-push hook，本 repo 不代為設定）。
            退出碼：`0` 乾淨／`1` 發現／`2` 用法或環境錯誤。
      - [ ] 掃描範圍：working tree 變更（staged ＋ unstaged，只看**新增的行**）＋ commit 範圍
            （預設 `origin/main..HEAD`，該 ref 不存在會明講略過）＋ **未追蹤但未被 `.gitignore`
            排除**的檔案（只差一個 `git add -A` 就會被推上去，漏掉等於只檢查一半）。
            `--tracked` 可加掃所有已追蹤檔案的內容（完整稽核，較慢）。
      - [ ] 規則：① `ADMIN_TOKEN=`／`JWT_SECRET=`／`ACCESS_*_SECRET=` 這類賦值（含佔位值過濾，
            所以測試裡的 `test-jwt-secret` 不會誤報）② Cloudflare API token（40 字元十六進位，
            前後加邊界 → 64 字元的 `ACCESS_MAIL_AUD` 不會被誤切）③ JWT（`eyJ…` 三段式）
            ④ `BEGIN … PRIVATE KEY`／`RSA`／`OPENSSH` ⑤ `AKIA`／`AIza`／`sk-` 前綴；
            外加**追蹤檔名**檢查：`.dev.vars`、`.env`（**排除 `.example`**）、`*.pem`、`*.key`、
            `credentials*`。允許清單：行內 `secret-scan:ignore` 或 `.secret-scanignore`。
      - [ ] ⚠️ **只輸出 `檔案:行號:規則名`，絕不輸出機密值**（把值印到終端機／CI log 等於又複製一份）。
      - [x] 已完成驗證：假樣本 5 類規則全數命中且**輸出不含任何值**；乾淨樣本 → `0`；
            含假 token → `1`；`.secret-scanignore` 與行內 ignore 皆生效；**本 repo 實跑 → `0`**（乾淨）

- [ ] **15. 互動式表單與內部直送（docs/18 P1／P2；2026-10-21 程式完成，未部署）**
      - [ ] **先套用 migration `0008_form_mail.sql`**（只新增欄位／表，既有列安全預設
            `origin='external'`／`kind='normal'`／`delivery_scope='external'`）：
            ```powershell
            cd D:\Mail\Atwhomail
            pnpm --filter @atwhomail/api exec wrangler d1 migrations apply mail-d1 --remote
            ```
            ⚠️ 部署順序：**migration 先於 API**（`/api/forms/*` 需要新表；`/api/mail/send` 會寫新欄位）。
      - [ ] 部署 API 與前端（前端需在 `web/` 目錄 build；**D18-2** 後首屏 `index-*.js`
            約 305 kB／gzip 93 kB，RJSF 另為 lazy chunk `FormRenderer-*.js` 約 378 kB／gzip 122 kB，
            僅開啟互動式表單時載入）。
      - [ ] **本地直送驗收**：以內部地址互寄 → 收件人 `origin=internal`、`kind=normal`、
            `delivery_scope=internal`，且 **Workers Email Sending 用量不增加**（未繞 SMTP）。
      - [ ] **外部信仍走 EMAIL.send**：寄到外部地址 → `delivery_scope=external`，用量正常增加。
      - [ ] **互動式表單驗收**：`/api/forms/send` 寄給內部地址 → 收件人可渲染並送出；
            `GET /api/forms/:id` 對非收件人／已撤回／逾期一律 404；寄件人可查看回覆與撤回。
            ⚠️ 互動式表單路徑**不得**出現 EMAIL Sending 用量（設計上物理不可能）。
      - [ ] **D18 驗收（owner 填自己地址＋RJSF lazy-load）**（2026-10-22 程式完成；docs/18 §15）：
            ① owner 以管理員 JWT 開啟寄到**自己名下地址**的表單 → 可渲染並送出（200）；
               對**訪客地址**的表單 → 404；rescue token（`x-admin-token`）→ GET／POST 皆 404。
            ② 稽核 `form_viewed`／`form_submitted` 的 `detail.via` 為 `mailbox`／`owner`，
               且不含主旨／schema／payload（N9）。
            ③ 前端重新部署後，首屏 `index-*.js` 不含 RJSF；開啟互動式郵件時才載入
               `FormRenderer-*.js`（載入期間顯示「表單載入中…」）。
      - [ ] **D16 驗收（刪除含表單的訪客／地址）**（2026-10-22 程式完成；對應 `docs/18` §14.1 **T56–T58**；
            **請用測試帳號／地址**，刪除不可復原）：
            ① `DELETE /api/users/:id` 對有（open ＋ submitted）表單實例的訪客 → `200`；
               `form_responses`／`form_instances`／messages／attachments／aliases／address／user／
               `auth_attempts` 全清，`registration_audit` 保留 ✅
            ② `DELETE /api/email-addresses/:id?mode=hard` 對有表單實例的地址 → `200`（同上清除、
               名稱可重建；已軟刪除的地址升級清除亦同）✅
            ③ `?mode=soft` 刪除地址 → 該地址的 `open` 實例轉 `revoked`（`updated_at` 同步），
               submitted 實例／回覆／messages／attachments／R2 **全部保留** ✅
            ④ ⚠️ `form_templates` **不得刪除**（可重用）；修正前上述①②會因 FK 阻擋回
               `500 DELETE_FAILED`（已回滾）
      - [ ] **寄件者驗證顯示**：外部信詳情應顯示 SPF／DKIM／DMARC（pass／fail／none／unknown）；
            fail 僅顯示警告，**不得**影響閱讀或授權。
      - [ ] **回退**：前端重新部署上一版即可讓表單自動降為靜態（後端端點保留、不再被呼叫）；
            migration 0008 為純新增，可保留不用。⚠️ 本版**未實作** docs/18 §10 的 feature flag（見 §5-15）。
      - [ ] **未執行**：本階段未部署、未跑遠端 migration、未對 production D1／R2 寫入。

- [ ] **16. 信箱刪除語意修正＋複選批次（docs/19 D19；2026-11-03 程式完成，未部署）**
      - [ ] **資料前提（已完成，部署前確認）**：2026-11-03 已把 33 筆
            `folder='trash' AND deleted_at IS NOT NULL` 的歷史資料 `deleted_at` 設回 NULL
            （production 已一次性修復；本次**程式**修正後不會再產生這種列）。
            部署前可抽驗：`SELECT COUNT(*) FROM messages WHERE folder='trash' AND deleted_at IS NOT NULL;` 應為 **0**。
      - [ ] **部署 API 與前端**（無 migration）。⚠️ **前端必須重新部署**：
            `MailList`／`AppShell` 新增複選與批次工具列，D19-3 另新增「清空垃圾桶」與 ReadingPane
            單封「還原／永久刪除」，D19-4 再新增每列 checkbox 與表頭全選；只部署 API 會看不到新功能。
      - [ ] **D19-1 驗收（刪除語意）**：
            ① 在收件匣刪一封信 → 垃圾桶**看得到**、可讀取；DB 斷言 `folder='trash' AND deleted_at IS NULL`。
            ② 「還原」→ 回收件匣；非垃圾桶的信呼叫 restore → `400 NOT_IN_TRASH`。
            ③ 「永久刪除」→ 信件列、附件列與 R2 物件消失；稽核 `mail_purged` 只有 `{id, r2_objects}`（N9）。
            ④ 清空垃圾桶 → `{count, r2_objects}`；只清自己 scope；>500 封 → `400 TRASH_TOO_LARGE`。
      - [ ] **D19-2 驗收（複選批次）**：
            ① Ctrl／Cmd 點擊切換、Shift 點擊範圍連選、清單聚焦時 Ctrl/Cmd+A 全選。
            ② 工具列「已選 N 封」依資料夾顯示：垃圾桶＝還原／永久刪除；其他＝移至垃圾桶／標為已讀。
            ③ 切換資料夾／地址後選取歸零；列有 `aria-selected` 且可鍵盤操作。
            ④ 批次含他人／不存在 id → **404 且整批未執行**（抽查未被搬移的信）；稽核 `mail_batch` 只有 `{action, count}`。
      - [ ] **D19-3 驗收（前端補做，2026-11-03）**：
            ① 垃圾桶檢視顯示「清空垃圾桶」；非垃圾桶（含跨資料夾搜尋）不顯示。點擊需二次確認
               「將永久刪除 N 封（含附件與原始檔），無法復原」；**取消不呼叫 API**。
            ② 確認後呼叫 `POST /api/mail/trash/empty`，顯示 `{count, r2_objects}` 摘要，
               並重新載入清單與資料夾計數。
            ③ ReadingPane：非垃圾桶「刪除」→ 軟刪除並關閉；垃圾桶「還原」→ 回 inbox；
               「永久刪除」→ 二次確認後 `?mode=hard` 並關閉。
            ④ 所有動作完成後左側資料夾計數同步更新；失敗顯示錯誤且**不清空畫面**。
            ⑤ T75–T78 通過（`web/test/mailTrash.dom.spec.tsx`）。
      - [ ] **D19-4 驗收（每列 checkbox，2026-11-03）**：
            ① 每列左側有 checkbox（`aria-label="選取信件：<主旨>"`）；點擊只切換選取、
               **不開信**（不得呼叫 `GET /api/mail/:id`），不需按 Ctrl。
            ② Shift＋點 checkbox → 範圍連選（錨點＝最近一次點擊）。
            ③ 表頭「全選信件」：全部勾選 → 再點全部取消；部分選取 → **indeterminate**；
               只作用於目前資料夾目前已載入的清單。
            ④ 已選列有背景高亮＋左側色條；checkbox 可 Tab 聚焦、Space 切換；窄螢幕仍可見。
            ⑤ 切換資料夾／地址後選取清空、checkbox 全部未勾。
            ⑥ T79–T83 通過（`web/test/mailCheckbox.dom.spec.tsx`）。
      - [ ] **N9 抽查**：`registration_audit` 的 `mail_purged`／`mail_restored`／`trash_emptied`／
            `mail_batch` detail **不得**含主旨、寄件者、收件者或內文。
      - [ ] **回退**：API 刪除語意回到舊行為並不好（舊行為是 bug）；若需回退前端，重新部署上一版即可，
            後端新端點（restore／hard／batch／empty）保留不影響舊前端。
      - [ ] **未執行**：本階段未部署、未跑遠端 migration、未對 production D1／R2 寫入。

- [ ] **17. Email 驗證碼註冊（docs/21 D21；2026-11-04 程式完成，未部署）**
      - [ ] **先套用 migration `0009_email_verifications.sql`**（只新增 `email_verifications` 表與索引；
            無 ALTER，既有資料不受影響）：
            ```powershell
            cd D:\Mail\Atwhomail
            pnpm --filter @atwhomail/api exec wrangler d1 migrations apply mail-d1 --remote
            ```
            ⚠️ 部署順序：**migration 先於 API**（`/api/auth/register-request|verify` 需要新表）。
            套用後抽驗：`SELECT name FROM sqlite_master WHERE type='table' AND name='email_verifications';` → 1 列。
      - [ ] **部署 API 與前端**。API 需含新端點；前端需重新 build／deploy 才有新註冊表單
            （舊前端仍可用：`REGISTRATION_MODE=invite` 時行為不變）。
      - [ ] **切換 `REGISTRATION_MODE`（Worker var，非機密）**：
            1. 預設值為 `invite`（`packages/api/wrangler.jsonc` 的 `vars`）→ 與 D21 之前完全相同：
               前端顯示邀請碼欄位、舊 `POST /api/auth/register` 可用、新端點一律 403。
            2. 切到 Email 驗證碼：把 `REGISTRATION_MODE` 改為 **`email_verify`** → `pnpm --filter @atwhomail/api run deploy`。
               前端**不需要重新 build**：登入頁會呼叫 `GET /api/auth/registration-mode` 自動切換表單
               （若該請求失敗／舊後端 → 回退 invite，不會壞頁）。
            3. 緊急關閉：改為 **`closed`** 並部署（或沿用舊 kill switch `REGISTRATION_DISABLED=true`）→
               `register`／`register-request`／`register-verify` 皆 `403 REGISTRATION_CLOSED`。
            4. **回退到邀請制**：改回 **`invite`**（或移除該 var）並部署；邀請碼資料與程式完全保留，
               既有未使用邀請碼立即恢復可用。
      - [ ] **驗收（Email 驗證碼模式）**：
            ① `curl GET /api/auth/registration-mode` → `{"mode":"email_verify"}`。
            ② 前端註冊分頁：Email＋想要的 ID（`@atwho.org`）＋密碼＋確認密碼 →「寄送驗證碼」→
               出現 6 位數欄位與 60 秒重寄倒數；成功後自動登入。
            ③ 收到信：寄件者 `noreply@atwho.org`、內容只有 6 位數與 15 分鐘說明、不含 ID／Email。
            ④ DB：`email_verifications.code_hash` 為 64 字元 SHA-256（**無明碼**）、`expires_at-created_at=900000`。
            ⑤ 錯碼 5 次 → `CODE_LOCKED`；過期 → `CODE_EXPIRED`；60 秒內重寄 → `CODE_COOLDOWN`；
               同一碼第二次 → `CODE_INVALID`；ID 重複 → `409 ID_TAKEN`；保留字 → `422 ID_RESERVED`
               （D20 起；另見 §2-20 的 `422 ID_MATCHES_DOMAIN`）。
            ⑥ 成功後：`users.role='visitor'`、`email_addresses.status='active'`、`daily_send_quota=50`、
               `created_at` 為當下（**24 小時暖機上限預設 20，可調**自動生效）；回傳 token 可讀 `/api/me`／`/api/mail/*`。
               （D33）超過每日 50 封被擋時，寄提醒信到 `users.contact_email`，每訪客每日最多一封。
            ⑦ 限流：同 IP `register-request` 第 6 次／小時 → `429 RATE_LIMITED`；同 Email 第 6 封／日 →
               `429 CODE_DAILY_LIMIT`。
            ⑧ 稽核：`register_requested`／`register_verified`／`register_rejected` 的 detail **只含**
               `local_part`（必要時加 `reason`），**不得**含 Email／驗證碼／密碼／token。
      - [ ] **已知限制**：DNS 二級網域撞名檢查已於 D20 接上（§2-20）。機器人防護目前只有速率限制
            （Turnstile 為 docs/21 §8 的下一階段）。
      - [ ] **未執行**：本階段未部署、未跑遠端 migration、未對 production D1／R2 寫入。

- [ ] **18. 可分享的註冊／邀請連結（docs/22 D22；2026-11-04 程式完成，未部署）**
      - **純前端**：只改 `web/`（`LoginPage`、`InviteManager`），**無 API 變更、無 migration**。
      - [ ] **部署**：只需重新 build／deploy 前端 `atwhomail-web`（必須在 `web/` 目錄執行）；
            API Worker 不需重新部署。
      - [ ] **驗收（app.atwho.org）**：
            ① 開 `https://app.atwho.org/?register=1` → 自動停在「註冊」分頁；`email_verify` 模式 Email 欄取得焦點。
            ② 開 `https://app.atwho.org/?invite=<code>` → 自動停在「註冊」分頁且邀請碼已預填（`invite` 模式）。
            ③ 上述兩種網址在載入後 **query 已消失**（`history.replaceState`；重新整理不會再帶參數）。
            ④ `REGISTRATION_MODE=closed` 時帶 `?register=1` → 只顯示「目前未開放註冊。」，沒有註冊表單。
            ⑤ 無效／已撤銷邀請碼仍顯示註冊頁；送出時由後端回 `INVITE_INVALID`（前端顯示原因）。
      - [ ] **驗收（mail.atwho.org 邀請碼管理頁）**：
            ① 每個邀請碼列有「複製邀請連結」→ 剪貼簿為 `https://app.atwho.org/?invite=<code>`，
               toast「已複製連結」（取全碼會寫稽核 `invite_revealed`）。
            ② 建立新邀請碼後，對話框顯示邀請連結＋一鍵複製。
            ③ `email_verify` 模式顯示「一般註冊連結」卡片（`https://app.atwho.org/?register=1`）＋一鍵複製；
               `invite` 模式不顯示此卡片。
      - ⚠️ **安全**：連結參數只影響顯示與預填，不得影響任何權限判定（N3）；註冊模式與邀請碼有效性
            仍由後端判定。
      - [ ] **未執行**：本階段未部署、未跑遠端 migration、未對 production D1／R2 寫入。

- [ ] **19. 別名 Phase 1（docs/25 D25；2026-11-05 程式完成，未部署）**

      **部署順序（缺一不可）**：
      1. 先套 migration（**由 owner 執行**；實作 agent 不得執行遠端 migration，N10）：
         ```powershell
         pnpm --filter @atwhomail/api exec wrangler d1 migrations apply mail-d1 --remote
         ```
         預期新增：`alias_names` 表、`messages.envelope_to`、`messages.reply_to`、
         `idx_messages_envelope_to`。
      2. 部署 **API Worker**（`atwhomail-api`）：新增 `/api/email-aliases*` 與別名 From 寄信。
      3. 部署 **email-handler**（`atwhomail-email-handler`）：別名收信轉投／停用回 550。
      4. 重新 build／deploy **前端**（別名管理頁、`envelope_to` 徽章、回覆 From 規則）。

      **驗收**：
      - [ ] `POST /api/email-aliases {name:"luke",target_address_id:<自己地址>}` → 201
            `alias_address = luke001@atwho.org`；第二個同名（不同帳號）→ `luke002@atwho.org`。
      - [ ] 外部寄到 `luke001@atwho.org` → 目標地址收件匣可見，列表／閱讀窗顯示「寄給 luke001@atwho.org」。
      - [ ] 回覆該信 → ComposeWindow 的 From 顯示別名（外部寄件者）；回覆 `@atwho.org` 寄件者 → 真實地址。
      - [ ] 別名停用後再寄 → SMTP 550 5.1.1，訊息不寫入 D1／R2。
      - [ ] `GET /api/email-aliases` 的 `received_count`／`last_received_at` 與實際封數一致；
            mailbox session 只看得到自己地址的別名。
      - [ ] 以別名寄信後：目標地址 `sent_today` +1、寄件備份 `from_address` 為別名、
            稽核 `mail_sent.detail.via_alias=true`（不含信件內容，N9）。
      - [ ] migration 未套用前**不得**部署 API／handler（別名端點與收信會因缺欄位失敗）。

      **回退**：前端可先回上一版（別名 UI 消失）；API／handler 回上一版後，`alias_names` 與
      `messages.envelope_to` 欄位保留不影響既有流程（新增欄位皆可為 NULL／未使用）。

      - [ ] **未執行**：本階段未部署、未跑遠端 migration、未對 production D1／R2 寫入。

- [ ] **20. ID 撞二級網域偵測（docs/20 D20；2026-11-05 程式完成，未部署）**

      **部署順序（缺一不可）**：
      1. 先套 migration（**由 owner 執行**；實作 agent 不得執行遠端 migration，N10）：
         ```powershell
         cd D:\Mail\Atwhomail
         pnpm --filter @atwhomail/api exec wrangler d1 migrations apply mail-d1 --remote
         ```
         預期新增：`domain_checks`（DoH 快取）、`id_blocklist`（人工封鎖 ID）。
         套用後抽驗：
         `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('domain_checks','id_blocklist');` → 2 列。
      2. 部署 **API Worker**（`atwhomail-api`）：新增 `POST /api/auth/check-id`；
         `register-request`／`register-verify` 加入二級網域檢查（fail-open）。
      3. 重新 build／deploy **前端**（`atwhomail-web`）：註冊表單 ID 欄位即時檢查＋建議 chip。
      4. **無新增環境變數／binding**（DoH 用一般 `fetch`；不需要新 secret／KV）。

      **驗收**：
      - [ ] `POST /api/auth/check-id {label:"hp"}` → `200 {available:false, reason:"MATCHES_DOMAIN",
            tldHit:"com", suggestions:[…]}`（建議每個都可用）。
      - [ ] `POST /api/auth/register-request {email:…, local_part:"hp"}` → **422 `ID_MATCHES_DOMAIN`**
            ＋`error.suggestions`；**不寄驗證碼**。
      - [ ] `zzqqxxyy123` → 可註冊；`admin` → **422 `ID_RESERVED`**；既有地址 → 409 `ID_TAKEN`。
      - [ ] 純數字 `123456` → **400 `INVALID_LOCAL_PART`**（`check-id`／`register-request`／
            `register-verify`／邀請碼註冊皆同）；`123abc` 仍可註冊。
      - [ ] 前端 ID 欄停止輸入 500ms 後顯示「✅ 可用／❌ 已被 hp.com 網域使用／❌ 純數字／⚠️ 保留字／
            ⚠️ 已有人使用」；建議 chip 可點選填入。
      - [ ] `domain_checks` 有快取列（命中 90 天、未命中 7 天）；同一 ID 第二次查詢不再打 DoH。
      - [ ] 同 IP `check-id` 第 21 次／分 → `429 RATE_LIMITED`。
      - [ ] DNS 故障（可暫時封鎖 `cloudflare-dns.com` 或觀察 log）→ 註冊仍可完成（fail-open）
            且 log 有 `domain check degraded` warning。
      - [ ] **不回溯**：既有地址不受影響（上線後抽查任一舊地址仍可登入／收信）。
      - [ ] 既有 T1–T138 零回歸（`pnpm test` 全綠）。

      **回退**：前端可先回上一版（少了即時提示）；API 回上一版即可恢復 D20 前的行為。
      `domain_checks`／`id_blocklist` 為純新增表，保留不影響既有流程。

      - [ ] **未執行**：本階段未部署、未跑遠端 migration、未對 production D1／R2 寫入。

- [ ] **21. Cloudflare Turnstile 防機器人（docs/23 D23；2026-11-05 程式完成，金鑰未提供、未部署）**

      **前置（owner 於 Cloudflare Dashboard）**：
      1. **Turnstile → Add widget**
         - Widget name：`atwhomail-register`
         - Hostnames：`app.atwho.org`、`mail.atwho.org`
         - Widget Mode：**Managed**（建議）
      2. 建立後複製 **Site Key**（公開）與 **Secret Key**（機密）。
      3. Secret Key 寫入 Worker secret（**不要**寫進 repo／`wrangler.jsonc`／任何文件）：
         ```powershell
         cd D:\Mail\Atwhomail
         pnpm --filter @atwhomail/api exec wrangler secret put TURNSTILE_SECRET_KEY
         ```
      4. Site Key 填入 `packages/api/wrangler.jsonc` 的 `vars.TURNSTILE_SITE_KEY`
         （目前預設 `""`＝未啟用；此值**非機密**）。

      **部署／啟用順序（設定金鑰後即生效）**：
      1. 部署 **API Worker**（`pnpm --filter @atwhomail/api run deploy`）：
         含 `turnstile_token` 驗證與 `registration-mode.turnstileSiteKey`。
      2. 重新 build／deploy **前端**（`cd web; pnpm run build` → Pages）：
         含 widget 載入與顯示邏輯。**這一步只需做一次**；之後改 site key 不需再 build 前端。
      3. **設定金鑰後即生效**：
         - 設定 `TURNSTILE_SECRET_KEY` secret（不必改 vars／不必重新部署）→ 後端**下一個請求**
           即開始驗證。
         - 填入 `TURNSTILE_SITE_KEY` 並部署 API 後 → `GET /api/auth/registration-mode` 立即回傳
           該 key；已部署的前端重新載入即顯示 widget。
      4. 只想先顯示前端 widget、暫不啟用後端驗證也可以：secret 未設定時後端仍跳過驗證
         （不會因缺 token 而擋下）。

      **驗收**：
      - [ ] **secret 未設定**：`POST /api/auth/register-request`（不帶 token）→ 200 並寄碼；
            log 只有**一次** `TURNSTILE_SECRET_KEY 未設定` warning（不隨每個請求洗版）。
      - [ ] **secret 已設定＋token 無效** → **400 `TURNSTILE_FAILED`**「機器人驗證未通過，請重試」；
            `email_verifications` **無新列**、**沒有寄出**驗證碼信；
            `registration_audit` 有 `register_rejected`，detail 只有 `reason=turnstile_failed`。
      - [ ] **secret 已設定＋token 有效** → 200 並寄碼。
      - [ ] `GET /api/auth/registration-mode`：site key 已設 → `turnstileSiteKey` 為字串；
            未設／空字串 → `null`。
      - [ ] 前端：site key 已設 → 註冊表單出現 widget（theme auto），完成驗證前
            「寄送驗證碼」停用；token 過期顯示提示；site key 未設 → 完全沒有 widget／腳本。
      - [ ] 暫時封鎖 `challenges.cloudflare.com`（或 Turnstile 故障）→ 註冊仍可完成
            （**fail-open**）＋ log 有 `Turnstile siteverify unavailable` warning。
      - [ ] 既有 T1–T146 零回歸（`pnpm test` 全綠）。

      **回退**：
      ```powershell
      pnpm --filter @atwhomail/api exec wrangler secret delete TURNSTILE_SECRET_KEY
      # 再把 wrangler.jsonc 的 TURNSTILE_SITE_KEY 改回 "" 並重新部署 API
      ```
      → 後端跳過驗證、前端不顯示 widget（回到 D21 行為；前端不需重新 build）。

      - [ ] **未執行**：本階段未部署、未對 production D1／R2 寫入、**未新增任何 secret 值**
            （`TURNSTILE_SECRET_KEY` 由 owner 之後以 `wrangler secret put` 設定）。

- [ ] **22. `auth.atwho.org` 薄代理 ＋ App code 交換（docs/27 D26；2026-11-05 程式完成，未部署）**

      **前置（owner）**：
      1. 確認 `atwho.org` zone 內沒有既有的 `auth` 記錄衝突（`custom_domain` 由 Wrangler 建立／綁定）。
      2. **不需要**新增 secret／KV／D1 binding：`atwhomail-auth` 是純代理；App secret 由 API 執行時產生，
         DB 只存 `SHA-256(secret + JWT_SECRET)`。`JWT_SECRET` 沿用 API Worker 既有 secret。

      **部署順序（缺一不可）**：
      1. 先套 migration（**由 owner 執行**；實作 agent 不得執行遠端 migration，N10）：
         ```powershell
         cd D:\Mail\Atwhomail
         pnpm --filter @atwhomail/api exec wrangler d1 migrations apply mail-d1 --remote
         ```
         預期新增：`app_clients`、`auth_codes`（＋`idx_auth_codes_exp`）。
         套用後抽驗：
         `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('app_clients','auth_codes');` → 2 列。
      2. 部署 **API Worker**（`pnpm --filter @atwhomail/api run deploy`）：
         新增 `/api/apps*`、`/api/auth/app-login`、`/api/auth/exchange`、`/api/auth/me`；
         `requireMailSession` 對 app token 回 403 `SCOPE_NOT_ALLOWED`。
      3. 部署 **新 Worker**（`pnpm --filter @atwhomail/auth run deploy`，name `atwhomail-auth`）；
         自訂網域 `auth.atwho.org` 由 `wrangler.jsonc` 的 `routes[].custom_domain` 綁定。
      4. 重新 build／deploy **前端**（`cd web; pnpm run build` → Pages）：
         `app.` 的 App 登入轉交＋`mail.` 的「應用程式（App Clients）」管理頁。
         ⚠️ **前端必須重新部署**：只部署 API 看不到新 UI／轉交流程。

      **驗收**：
      - [ ] `curl https://auth.atwho.org/api/auth/registration-mode` → 200（與 API 回應相同）。
      - [ ] `curl https://auth.atwho.org/api/mail/inbox` → **404 `NOT_FOUND`**（代理只轉 `/api/auth/*`）。
      - [ ] 管理頁建立 App：secret 只顯示一次；`SELECT secret_hash FROM app_clients` 與 secret 不同，
            且資料表沒有明碼 secret 欄位。
      - [ ] 以 owner／mailbox session 呼叫 `app-login` → `{redirect}` 含 64-hex code；
            `redirect_uri` 不在白名單 → 400 `INVALID_REDIRECT_URI`。
      - [ ] `exchange`（正確 secret＋code）→ 200；JWT `scope='app'`、`aud=<app_id>`、`sub=<users.id>`。
      - [ ] 同一 code 第二次 exchange → **409 `CODE_ALREADY_USED`**；過期（>60 秒）→ **400 `INVALID_CODE`**；
            錯 secret → **401 `INVALID_CLIENT`**。
      - [ ] App token 呼叫 `GET /api/auth/me` → 200（不含 `password_hash`）；
            呼叫 `GET /api/mail/inbox` → **403 `SCOPE_NOT_ALLOWED`**。
      - [ ] 同一 App 每分鐘第 31 次 exchange → **429 `RATE_LIMITED`**（`auth_attempts` key `exchange:<app_id>`）。
      - [ ] `registration_audit` 有 `app_created`／`app_updated`／`app_login`／`app_exchanged`，
            detail **不含** secret／token／code。
      - [ ] 既有 T1–T150 零回歸；新增 T151–T160 全綠（`pnpm test`）。

      **回退**：
      前端可先回上一版（轉交／管理 UI 消失）；API 回上一版即停止簽發 App token；
      `atwhomail-auth` 可先移除 route 或部署上一版（本階段為新 Worker，無舊版則直接刪除即可）。
      migration 0012 為純新增表，保留不影響既有流程。

      - [ ] **未執行**：本階段未部署、未跑遠端 migration、未對 production D1／R2 寫入、
            **未新增任何 secret 值**。

- [ ] **23. Google OAuth ＋ 忘記密碼（docs/28 D27；2026-11-05 程式完成，未部署）**

      **前置（owner／已完成項目，勿重做）**：
      1. Google OAuth Client 已建立；redirect URI
         `https://auth.atwho.org/api/auth/oauth/google/callback` 已登記。
      2. Worker secret `GOOGLE_CLIENT_SECRET` 已設定（**不得**寫入 repo／vars）。
      3. `wrangler.jsonc` vars 已有 `GOOGLE_CLIENT_ID`、`OAUTH_REDIRECT_URI`。
      4. `assignAvailableLocalPart()`（D20）已存在，OAuth 首登直接使用。

      **部署順序（缺一不可）**：
      1. 先套 migration（**由 owner 執行**；實作 agent 不得執行遠端 migration，N10）：
         ```powershell
         cd D:\Mail\Atwhomail
         pnpm --filter @atwhomail/api exec wrangler d1 migrations apply mail-d1 --remote
         ```
         預期新增：`users.provider`／`provider_sub`／`contact_email`／`email_verified`、
         `idx_users_provider`／`idx_users_contact_email`、`password_resets`（＋`idx_password_resets_user`）。
         套用後抽驗：
         `SELECT name FROM sqlite_master WHERE type='table' AND name='password_resets';` → 1 列；
         `SELECT name FROM pragma_table_info('users') WHERE name IN ('provider','provider_sub','contact_email','email_verified');` → 4 列。
      2. 部署 **API Worker**（`pnpm --filter @atwhomail/api run deploy`）：
         新增 OAuth start／callback、`user-login`、`forgot-password`、`reset-password`。
         ⚠️ 確認 `GOOGLE_CLIENT_SECRET` 已存在於該 Worker（`wrangler secret list`）。
      3. 重新 build／deploy **前端**（`cd web; pnpm run build` → Pages）：
         登入頁 Google 按鈕、忘記密碼流程、`?reset=` 設定新密碼頁、`NO_PASSWORD_SET` 引導。
         ⚠️ **前端必須重新部署**：只部署 API 看不到新 UI。
      4. `atwhomail-auth`（`auth.atwho.org`）**不需重新部署**：既有代理已轉發 `/api/auth/*`
         與 `Set-Cookie`／`Cookie`。

      **驗收**：
      - [ ] `GET https://auth.atwho.org/api/auth/oauth/google/start?redirect_after=/` →
            **302** 到 `accounts.google.com`；`redirect_uri` 固定為
            `https://auth.atwho.org/api/auth/oauth/google/callback`；回應有
            `awo_state`（HttpOnly／Secure／SameSite=Lax／Max-Age=600）。
      - [ ] 用 Google 帳號完成登入：新帳號 → 自動建立 visitor（無密碼）＋
            `<id>@atwho.org`（`daily_send_quota=5`）→ 導回前端並登入。
      - [ ] 既有 `contact_email` 相同的帳號 → 連結（`provider='google'`＋`provider_sub`），
            不重複建帳號；稽核 `oauth_linked`。
      - [ ] 第二次登入 → 同一 user；`contact_email` 變更時同步更新；稽核 `oauth_login`
            （detail 只有 `sub` 前 8 碼，**不含 Email 全文／token**）。
      - [ ] `POST /api/auth/user-login`：以 username 或 contact_email 皆可登入；
            純 OAuth 帳號 → **400 `NO_PASSWORD_SET`**。
      - [ ] `POST /api/auth/forgot-password`：不存在的 Email → **200**（不洩漏）、不寄信；
            有帳號 → 收到 `noreply@atwho.org` 的「AtWhoMail 密碼重設」（30 分鐘、一次性）。
      - [ ] `POST /api/auth/reset-password`：成功後舊 JWT 立即 **401 `TOKEN_STALE`**；
            同一 token 第二次 → 400 `INVALID_TOKEN`；過期 → 400 `TOKEN_EXPIRED`；
            弱密碼 → 422 `WEAK_PASSWORD`；成功後寄「密碼已變更」通知。
      - [ ] 限流：同 Email 第 4 次 forgot → 仍 200 但不寄信；同 IP 第 11 次 → 仍 200 但不寄信。
      - [ ] T161–T172 全綠；既有 T1–T160 零回歸（`pnpm test`）。

      **回退**：
      前端可先回上一版（Google／忘記密碼 UI 消失）；API 回上一版即停止新端點；
      migration 0013 為純新增欄位／表，保留不影響既有流程
      （`users.password_hash` 仍為 NOT NULL；OAuth 帳號以空字串表示未設密碼）。

      - [ ] **未執行**：本階段未部署、未跑遠端 migration、未對 production D1／R2 寫入、
            **未新增任何 secret 值**（`GOOGLE_CLIENT_SECRET` 為既有 secret，本次未變更）。

- [ ] **24. `app.` 管理功能收斂 ＋ 個人設定（docs/29 D29；2026-11-06 程式完成，未部署）**

      **本次沒有 migration**；需部署 **API Worker** 與 **前端**（先 API 再前端較安全）。
      ⚠️ **前置**：D29 的新端點會讀 `users.provider`／`contact_email` → 必須先完成
      §2-23（migration `0013`）並確認已套用；若 0013 尚未上線，請先依 §2-23 部署。

      **部署順序**：
      1. 部署 **API Worker**（`pnpm --filter @atwhomail/api run deploy`）：
         新增 `GET /api/account/settings`、`POST /api/account/password`。
         ⚠️ 既有 API 授權規則**未改變**；owner token 仍可呼叫管理端點（本次只收斂 UI）。
      2. 重新 build／deploy **前端**（`cd web; pnpm run build` → Pages）：
         `app.atwho.org` 隱藏地址管理／「我的全部信箱」／邀請碼／訪客管理／App Clients／
         「管理員」標籤（即使 owner）；頭像選單第一項改為「個人設定」；
         舊「帳號設定（變更密碼）」與「別名管理」獨立入口移除（併入個人設定）。
      3. `mail.atwho.org`／Access 設定**不需調整**；`auth.atwho.org` 代理不需重新部署。

      **驗收**：
      - [ ] `app.atwho.org` 以 **owner** 登入：側欄只有收件匣／寄件備份／垃圾桶／撰寫／個人設定；
            看不到地址管理、「我的全部信箱」、邀請碼、訪客管理、App Clients；頭像標籤為「個人帳號」。
      - [ ] `mail.atwho.org` 以 owner 登入：上述管理功能與「管理員」標籤**照常顯示**（行為不變）。
      - [ ] `app.atwho.org` 以 visitor 登入：只看得到自己的信箱；無任何管理功能。
      - [ ] 頭像選單**第一項**為「個人設定」（所有 host／角色）；選單內「登出」可用。
      - [ ] 個人設定頁顯示 AtWhoMail ID、信箱地址（可複製）、Google Email
            （未綁定顯示「尚未綁定 Google」）、登入方式、變更／設定密碼、別名入口與
            「別名需自行建立，系統不會自動分配」說明；visitor 顯示今日已寄／上限。
      - [ ] `GET /api/account/settings`：owner 回本人＋名下地址、`has_password=1`；
            OAuth 帳號回 `has_password=0`＋`contact_email`；**不含** `password_hash`／他人資料。
      - [ ] `POST /api/account/password`：無密碼者可設定成功（免 current）；
            有密碼者錯 current → **401 `INVALID_CURRENT_PASSWORD`**；成功後舊 JWT →
            **401 `TOKEN_STALE`**；`app` token 呼叫兩個端點 → **403 `SCOPE_NOT_ALLOWED`**。
      - [ ] T173–T179 全綠；既有 T1–T172 零回歸（`pnpm test`）。

      **回退**：前端回上一版即恢復舊選單（API 新端點保留不影響既有流程）；
      API 回上一版即移除 `/api/account/*`（不影響既有端點）。**無 migration 需回退**。

      - [ ] **未執行**：本階段未部署、未對 production D1／R2 寫入、未新增任何 secret／環境變數。

## 3. 認證與端點矩陣

| 端點 | 認證 | 用途 |
|---|---|---|
| `GET /api/health`、`GET /` | 公開 | 健康檢查 |
| `POST /api/auth/login` | 公開 **＋需 Cloudflare Access JWT**（`ACCESS_MAIL_AUD` 設定後生效；5 次失敗鎖 15 分） | 管理員 session（階段 2／D2） |
| `POST /api/auth/mailbox-login` | 公開（5 次失敗鎖 15 分） | 信箱 session（**不受 Access 影響**）；錯誤碼：401 `INVALID_CREDENTIALS`／403 `ADDRESS_DISABLED`／403 `ACCOUNT_SUSPENDED`（**先驗密碼再判狀態**，階段 5／D8） |
| `PATCH /api/auth/owner-password/self` | owner session ＋ 舊密碼 | owner 自助改密碼（階段 2／D7） |
| `POST /api/auth/app-login` | owner／mailbox session（rescue 亦可） | **D26**：替指定 App 產生 60 秒一次性 code → `{redirect}`；app 必須 active、`redirect_uri` **完全相符**白名單。app token → 403 `SCOPE_NOT_ALLOWED` |
| `POST /api/auth/exchange` | 公開，但需 `app_secret` | **D26**：App 後端以 secret＋code 換 JWT（`scope='app'`、`aud=app_id`、`sub=users.id`）；一次性、60 秒；限流 30/分/app。錯誤：401 `INVALID_CLIENT`／400 `INVALID_CODE`／409 `CODE_ALREADY_USED`／400 `INVALID_REDIRECT_URI` |
| `GET /api/auth/me` | owner／mailbox／**app** session | **D26**：目前使用者身分（id／username／display_name／role／created_at；**不含** `password_hash`） |
| `GET /api/auth/oauth/google/start` | 公開 | **D27**：302 到 Google OAuth；`redirect_uri` **固定** `OAUTH_REDIRECT_URI`；`state` 存 cookie（HttpOnly／Secure／SameSite=Lax／600 秒）；`redirect_after` 只接受站內相對路徑 |
| `GET /api/auth/oauth/google/callback` | 公開 | **D27**：驗 state＋`email_verified=true` → 以 provider_sub／contact_email（連結）／自動建立 visitor＋地址（配額 50）比對 → 簽 session 後以 `#oauth_token=…` fragment 導回前端。稽核 `oauth_registered`／`oauth_linked`／`oauth_login`（不記 Email 全文／token） |
| `POST /api/auth/user-login` | 公開（5 次失敗鎖 15 分） | **D27**：username 或 contact_email ＋ 密碼 → owner／mailbox／user session；停權 403 `ACCOUNT_SUSPENDED`、未設密碼 400 `NO_PASSWORD_SET` |
| `POST /api/auth/forgot-password` | 公開 | **D27**：**一律 200**（不洩漏帳號存在）；限流 3/時/identifier、10/時/IP；寄 `noreply@atwho.org` 的 30 分鐘一次性重設連結（DB 只存 SHA-256）|
| `POST /api/auth/reset-password` | 公開（一次性 token） | **D27**：更新密碼＋`pca`（撤銷所有舊 JWT）＋寄「密碼已變更」；400 `INVALID_TOKEN`／`TOKEN_EXPIRED`、422 `WEAK_PASSWORD` |
| `GET /api/account/settings` | owner／mailbox session | **D29**：只回自己的 `{user_id, username, role, provider, contact_email, has_password, addresses[]}`；owner＝名下全部地址、mailbox＝session 的那一個地址；**不含** `password_hash`／他人資料；app token → 403 `SCOPE_NOT_ALLOWED` |
| `POST /api/account/password` | owner／mailbox session | **D29**：`{current_password?, new_password}`；有密碼必驗 current（錯 → 401 `INVALID_CURRENT_PASSWORD`）、無密碼（OAuth）免 current；成功更新 `pca` → 所有舊 JWT 失效；visitor 同步地址密碼；稽核 `password_changed`；app token → 403 `SCOPE_NOT_ALLOWED` |
| `/api/apps*` | owner 或 rescue | **D26**：App Client 管理。`POST` 回一次性 `app_secret`；`GET` 不含 secret；`PATCH` 更新名稱／狀態／redirect_uris；`DELETE` 軟停用。稽核 `app_created`／`app_updated`（不記 secret） |
| `POST /api/auth/register` | **公開**（行為依 `REGISTRATION_MODE`；預設 `invite` 需邀請碼） | 訪客註冊（Phase 1）→ mailbox session。**D21**：`email_verify` → 403 `REGISTRATION_EMAIL_VERIFY_REQUIRED`（改走下方兩端點）；`closed` → 403 `REGISTRATION_CLOSED` |
| `GET /api/auth/registration-mode` | 公開 | **D21**：目前註冊模式 `{mode}`（僅供前端表單顯示；權限仍由後端強制）。**D22**：管理端於 `email_verify` 時據此顯示「一般註冊連結」卡片。**D23**：另回 `turnstileSiteKey`（未設／空字串 → `null`；僅供前端顯示 widget） |
| `POST /api/auth/register-request` | 公開（**僅 `REGISTRATION_MODE=email_verify`**） | **D21**：寄 6 位數驗證碼到指定 Email（寄件者 `noreply@atwho.org`；DB 只存 SHA-256；15 分鐘）。限流：IP 5/時、20/日；Email 60 秒/封、5/日。**D20**：ID 撞二級網域 → 422 `ID_MATCHES_DOMAIN`（含建議）、保留字 → 422 `ID_RESERVED`、重複 → 409 `ID_TAKEN`。**D23**：secret 已設定時需有效 `turnstile_token`（400 `TURNSTILE_FAILED`；siteverify 網路失敗 → fail-open） |
| `POST /api/auth/register-verify` | 公開（**僅 `REGISTRATION_MODE=email_verify`**） | **D21**：驗碼（一次性／5 次上限）→ 建立 visitor＋address（暖機 24h）→ 回 mailbox token。**D20**：ID 撞二級網域 → 422 `ID_MATCHES_DOMAIN`、保留字 → 422 `ID_RESERVED`、重複 → 409 `ID_TAKEN` |
| `POST /api/auth/check-id` | 公開（**D20**） | ID 即時可用性：`{label}` → `{available, reason, tldHit?, suggestions?}`；保留字／封鎖清單／既有地址／二級網域（26 TLD，fail-open）。限流：同 IP 20 次/分 → 429 `RATE_LIMITED` |
| `/api/invites*` | owner 或 rescue | 邀請碼產生／列表（**預設只回遮罩碼**；`?reveal=1` 額外回全碼並寫稽核）／撤銷 |
| `GET /api/me` | owner 或 mailbox | 身分與寄信配額（供前端顯示） |
| **（session 檢查）** | owner 或 mailbox | `401 TOKEN_STALE`：**查不到列**（帳號／地址已被刪除，階段 6／D10）或密碼已變更；rescue 不受影響（N5） |
| **（app scope 邊界）** | — | **D26／D29**：`scope='app'` 可用於 `GET /api/auth/me`；但 `/api/mail/*`、`/api/attachments/*`、`/api/email-aliases*`、`/api/forms/*`、`/api/me`、`/api/account/*` 一律 **403 `SCOPE_NOT_ALLOWED`** |
| `DELETE /api/users/:id` | owner 或 rescue（**僅 `role='visitor'`**） | **永久刪除訪客**（帳號／地址／所有信件與附件／別名／登入計數；稽核保留，階段 6／D9）；對 owner → 403 `FORBIDDEN`。**D16**：一併清除該用戶相關的 `form_responses`／`form_instances`（`form_templates` 保留）|
| `PATCH /api/users/:id/status` | owner 或 rescue | 停權／復權（立即生效：**含既有 session 立即 403**，階段 5／D8-4；來信仍照收） |
| `GET /api/users?role=visitor` | owner 或 rescue | 訪客清單（**只回數量與時間**：信件數／最近活動，N9） |
| `PATCH /api/users/:id/quota` | owner 或 rescue | 調整每日配額（1–50）＋寄信安全閥（階段 3／D5；D33） |
| `PATCH /api/users/:id/warmup` | owner 或 rescue | 暖機豁免（需 migration 0007；階段 3／D5） |
| `/api/email-addresses*`（含密碼） | owner 或 rescue | 地址管理（**自身名下**，越權／訪客地址一律 404） |
| `GET /api/email-addresses?deleted=1` | owner 或 rescue | **已軟刪除**（垃圾桶）的地址清單（階段 7／D11-5）：`deleted_at`／`messages`，供網頁「已刪除的地址」區塊；未帶參數＝既有清單（僅未刪除的列） |
| `DELETE /api/email-addresses/:id?mode=soft\|hard` | owner 或 rescue（**自身名下**） | address 刪除（階段 7／D11）：`soft`（預設，信件與 R2 保留）／`hard`（信件／附件／R2 一併清除＋**釋放名稱**）；一律寫稽核 `address_deleted`。**D11-5**：對**已軟刪除**的列 `hard` → `200`（`previously_deleted: true`）、`soft` → `404`（不重複標記、非 500）。**D16**：`hard` 先清 `form_responses`／`form_instances`（`form_templates` 保留）；`soft` 把該地址的 `open` 實例轉 `revoked`（其餘資料不動）|
| `PATCH /api/email-addresses/:id/status` | owner 或 rescue | 停用／啟用**訪客**地址（階段 3／D5；解 404 缺口）；**立即生效**且**連收信都停止**（階段 5／D8-4） |
| `/api/email-aliases*` | owner 或 mailbox（scope 隔離） | **D25 別名 Phase 1**：`POST` 建立（名字 3–12 字母＋系統流水號）、`GET` 清單（owner 全部／mailbox 只看自己地址；含 `received_count`／`last_received_at`）、`PATCH` 啟用停用、`DELETE` **軟停用**（不刪列）。每帳號 ≤ 50；稽核 `alias_created`／`alias_updated`（不含信件內容，N9）|
| `GET /api/mail/inbox`、`GET /api/mail/:id` | owner 或 mailbox（scope 隔離） | **D25**：回應新增 `envelope_to`（寄給別名時的別名地址；否則 `null`），供列表／閱讀窗顯示「寄給 …」徽章 |
| `/api/mail/*`、`/api/attachments/*` | owner 或 mailbox（scope 隔離） | 收發信與附件（**寄信另有配額／限流**）；owner **不得**讀訪客信件（N9）。`/api/mail/send`：全內部 active 收件人→**本地直送**（不呼叫 EMAIL.send）。**D25**：`from` 可為自己名下的 active 別名（target 屬於 session scope）；配額一律計入 target 地址、寄件備份 `from_address` 為別名、稽核 `mail_sent.detail.via_alias`。**D19**：`DELETE /api/mail/:id` 為軟刪除（只設 `folder='trash'`，`deleted_at` 保持 NULL）；`?mode=hard`／`POST /api/mail/trash/empty` 永久刪除（R2→attachments→messages，R2 失敗→500 且 DB 不變）；`POST /api/mail/:id/restore` 還原；`POST /api/mail/batch` 批次 trash／restore／read／purge（任一 id 越權→404 整批不執行；上限 200） |
| `POST /api/forms/send` | owner 或 mailbox（from 需在 scope 內） | **互動式表單**：收件人全內部 active（否則 422 `FORM_RECIPIENT_NOT_INTERNAL`）、schema 白名單、每人一筆實例、**絕不呼叫 EMAIL.send** |
| `GET /api/forms/:id` | 收件人本人（mailbox 同地址 **或 owner JWT 且地址屬於自己**；D18-1；rescue／訪客地址→404） | 表單 schema；四道鎖任一失敗→**404**（不洩漏存在性）；稽核 `form_viewed` 含 `via` |
| `POST /api/forms/:id/responses` | 收件人本人（同上；D18-1） | 送出回覆（payload 依 schema 驗證；重複→409 `FORM_ALREADY_SUBMITTED`）；稽核 `form_submitted` 含 `via`、不含 payload |
| `GET /api/forms/:id/responses` | **僅寄件人** | 查看同批所有實例與回覆；他人→403 |
| `POST /api/forms/:id/revoke` | **僅寄件人** | 撤回整批；撤回後收件人 GET 立即 404（前端降靜態） |
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
| 6 | ~~無**內建**前端 App（Inbox UI）~~ → **✅ 2026-10-07 已補**：`web/`（Vite + React 19 + TS）Yahoo Mail 風格三欄式 UI —— 雙身分登入、資料夾未讀 badge、跨資料夾搜尋、sanitized HTML 內文（sandbox iframe）、附件下載、回覆／轉寄、含附件寄信、owner 地址管理。啟動：`pnpm dev:web`（`docs/06` §2.1）。外部 App 走 API 的方式不變（`docs/12`） | — | 後續可選：部署成與 API 同源（Workers Static Assets）以便手機使用 |
| 7 | ~~`email_aliases` 表已建但無 API~~ → **✅ D25 Phase 1 上線**：別名 CRUD／收信轉投／停用 550／回覆自動 From（範圍 A）。**✅ D31（2026-11-06）**：三種寄信身分（真實 ID／暱稱 1 個／Token 自動產生）、撰寫視窗隱私模式。**仍未實作**：反向別名（`messages.reply_to` 已預留但未啟用）、一次性別名、轉寄外部信箱 | 需 migration 0010／0015 與 API／前端部署（見 §2-19） | 依 §2-19 上線 |
| 8 | ~~TLS-RPT（`_smtp._tls`）未發佈~~ → **✅ 2026-10-06 已發佈**：TXT `v=TLSRPTv1; rua=mailto:tlsrpt@atwho.org,mailto:ulhome@gmail.com`（權威 NS 實測一致） | — | 觀察 2–4 週後再評估切 `enforce`（§2-4） |
| 9 | ~~演練殘留資源未清~~ → **✅ 2026-10-05 已解決**：測試 D1 `mail-d1-restore-test`、R2 `mail-r2-restore-test` 已刪除（僅保留 production） | — | 下次季度還原演練前需先建立新的測試標的（見 §2-7；`docs/09` §5.1 步驟 0b） |
| 10 | **CF API token 缺 read 權限**：DNS / Email Routing / Email Sending 皆 403 | 稽核無法全自動，只能靠公開 DNS | Dashboard → API Tokens → Edit 加**唯讀** scope（token 值不變，無需換檔） |
| 11 | ~~`_mta-sts` 訊號記錄曾無聲消失~~ → **✅ 2026-10-06 已納入自動監控**：watchdog 每 10 分鐘以 DoH 檢查訊號 CNAME 與政策端點，異常即寄告警信 | — | 仍建議每次動 mail DNS 後人工重驗（`07` Step 6、skill `dns-mta-sts-verification.md` Rule 1b） |
| 12 | ~~備份失敗完全不會告警~~ → **✅ 2026-10-06 已解決**：新增每 10 分鐘的本機 watchdog（`scripts/backup_watchdog.py`＋Windows 排程）與郵件告警（`alerts@atwho.org` → `ulhome@gmail.com`），涵蓋 agent 停滯／崩潰重啟密度／verify 失敗／API 異常／實例數異常 | — | 健康時靜默；同類告警 6 小時節流（詳見 §2-5） |
| 13 | ~~整台機器關機時不會有任何告警~~ → **✅ 2026-10-06 已實作**：新增 `atwhomail-heartbeat` Worker（D1 `system_heartbeat`；Cron 每 15 分鐘）。本機 watchdog 每次執行即 POST 心跳；**超過 45 分鐘未回報 → 由雲端寄告警信**（12 小時去重）。已驗證：cron 執行痕跡 `last_cron_at`（實測 16:00:19）、本機回報、無／錯 token 401、103 測試通過 | — | 端到端「停擺→收到信」建議用**關機驗收**：關機 >45 分鐘應收到主旨「本機停擺（心跳停止）」 |

| 14 | ~~DKIM 失效沒有任何自動監控~~ → **✅ 2026-10-07 已解決**：watchdog 新增第 8 項檢查（每輪以 DoH 驗證 `cf-bounce`／`cf2024-1` 公鑰：存在／合法 base64／≥2048-bit／**指紋未變**）＋端到端腳本 `scripts/dkim_verify.py`（**實測通過**：`d=atwho.org; s=cf-bounce` 與 `d=cloudflare-smtp.org; s=cf2024-1` 兩個簽章的 body hash 與 RSA 簽章全部驗證通過） | — | 端到端會真的寄一封信（收件者須為自家 active 信箱）；建議每月或改動寄信／DNS 設定後跑一次（`python scripts/dkim_verify.py`） |
| 15 | **docs/18 P2 未實作 feature flag**（§10 的回退設計）；回退目前依賴「重新部署上一版前端」。另 P2 未做：表單回覆附件、期限 UI、已讀狀態、統計／稽核頁（P3 範圍） | 若要「不動前端就關閉表單渲染」，目前只能靠後端端點回 404（例如暫時移除路由） | P3 再補 `FORMS_ENABLED` 開關（後端回 404 或前端不請求），並把撤回／期限／統計納入治理頁 |

## 6. 相關文件

- 架構：`01-architecture.md`｜流程：`02-email-flows.md`｜Schema：`03`、`04`
- API：`05-api-spec.md`｜結構：`06`｜CF 資源：`07`｜安全：`08-security-checklist.md`
- 備份／還原：`09-backup-dr.md`（§5.1 Runbook）｜實作計畫：`10-implementation-plan.md`
- **外部 App／PWA 整合：`12-pwa-integration.md`**（端點契約、CORS、上線檢查）
