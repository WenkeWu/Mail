# 11 — 上線檢查清單（Launch Checklist）

> 對應 Phase 16（10 文件 §3）。狀態：2026-09-15。**本文件是「上線前最後一哩」的操作清單**，每項都附驗證指令與預期輸出。

## 1. 系統現況（已完成 ✅）

| 元件 | 狀態 | 位置／識別 |
|---|---|---|
| 收信 Worker | ✅ 上線 | `atwhomail-email-handler`（catch-all `*@atwho.org`；R2 + D1 + HTML 消毒 + 附件抽取） |
| API Worker | ✅ 上線 | `atwhomail-api`（REST；Model C 雙 session；安全標頭；健康檢查含 D1 探測） |
| MTA-STS Worker | ✅ 上線 | `atwhomail-mta-sts`（`mta-sts.atwho.org`；mode=testing） |
| D1 | ✅ | `mail-d1` `1d02352f-9f40-4e06-a95f-95a781a84998`（3 migrations） |
| R2 | ✅ | `mail-r2`（`mail/`、`attachments/`） |
| 本機備份 | ✅ | PostgreSQL 17.11 `atwhomail_backup`；磁碟 `D:\Mail\mail-backup\`（13 物件 / 41,088 B） |
| 還原能力 | ✅ 已演練 | 測試 D1 `332b8869…` + bucket `mail-r2-restore-test`（位元組級 sha256 等價） |
| 測試 | ✅ 87 個 / 7 檔 | `pnpm test`（workerd 測試池，含 32 個 API 整合測試 + 8 收信 + 5 MTA-STS） |
| 安全標頭 | ✅ | nosniff / DENY / no-referrer / HSTS / CSP（HTML 端點保留專屬 CSP） |
| 健康檢查 | ✅ | `GET /api/health` 含 D1 探測（DB 異常 → 503） |

## 2. 上線前必做（逐步核對）

- [x] **1. 設定備份排程**（本機 PowerShell，無需管理員）✅ 2026-10-05 完成
      ```powershell
      powershell -ExecutionPolicy Bypass -File D:\Mail\Atwhomail\scripts\register-backup-tasks.ps1
      Get-ScheduledTask -TaskName "AtWhoMail Backup *" | Format-Table TaskName, State
      ```
      已驗證結果：
      | 工作 | 觸發 | 狀態 | 實測 |
      |---|---|---|---|
      | `AtWhoMail Backup Agent` | 登入時 | **Running** | `tick #1`：D1 0 變更、R2 12 跳過、watermarks 正常 |
      | `AtWhoMail Backup Verify` | 每日 09:00 | Ready | 手動觸發 → `total:13 ok:13 missing:0 corrupt:0`、exit 0 |

      ⚠️ **編碼陷阱（已修）**：`register-backup-tasks.ps1` 必須存成 **UTF-8 with BOM**（Windows PowerShell 5.1 把無 BOM 的 UTF-8 當 ANSI 讀，中文字串會吃掉引號/括號 → ParserError）；`backup-*.cmd` 必須**純 ASCII**（cmd.exe 以 CP950 讀 .cmd，UTF-8 中文註解會變成亂碼並被當成指令執行，例如 `'ha256' 不是內部或外部命令`），時間戳改用 PowerShell ISO-8601。

- [ ] **2. 確認備份真的有跑**
      ```powershell
      Get-Content D:\Mail\mail-backup\logs\agent.log -Tail 5
      ```
      預期：`"msg":"tick #N"` 每 5 分鐘一筆，`"sync":{"created":0,...}`（無變更時）。

- [ ] **3. 寄信配額與聲譽**
      - Workers Paid 含 **3,000 封/月**（超量 $0.35/千封）；Dashboard → Workers → Email Sending 可看用量
      - 新網域仍在**聲譽養成期**：先小量、真實內容寄送；觀察退信率
      - ⚠️ 目前 `test1@atwho.org` 等測試地址仍在 D1 → 上線前清理測試資料（見 §5）

- [ ] **4. MTA-STS 由 testing → enforce（觀察 2–4 週後）**
      ```powershell
      # 先確認政策正確
      curl.exe -s https://mta-sts.atwho.org/.well-known/mta-sts.txt
      ```
      預期：`mode: testing`（無誤後改 `packages/mta-sts/wrangler.jsonc` 的 `MODE_OVERRIDE=enforce` 並 `pnpm --filter @atwhomail/mta-sts run deploy`）
      ⚠️ enforce 設定錯誤會**拒收正常來信** → 變更後 24 小時內密切觀察

- [ ] **5. 監控**
      - Uptime 監控（Cloudflare Health Check 或 cron）：`GET https://atwhomail-api.ulhome.workers.dev/api/health` → 期待 `{"ok":true,"db":"ok",...}`（DB 異常時 **503**）
      - Workers **Observability 已開啟**（api / email-handler / mta-sts）→ Dashboard 可看 logs/traces
      - 每日 verify 排程失敗（exit 1）＝ 備份有問題 → 立即處理

- [ ] **6. 密碼與 secrets 盤點**（輪替計畫）
      | Secret | 存放 | 用途 | 輪替建議 |
      |---|---|---|---|
      | `ADMIN_TOKEN` | `packages/api/.dev.vars` + Worker secret | rescue 通道（owner 等效） | 6–12 個月 |
      | `JWT_SECRET` | 同上 | session 簽章（輪替＝全體登出） | 12 個月 |
      | CF API Token | `~/.atwhomail-cf-token` | wrangler / restore | 已在 Dashboard 設 1 年 TTL |
      | PG 密碼 | `~/.atwhomail-pg-pass` + `.env` | 本機備份庫 | 12 個月 |
      | owner 密碼 | 僅雜湊存 D1 | 登入 | 建議改用強密碼（目前為測試期弱密碼） |

- [ ] **7. 每季演練還原**（09 文件 §6）
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
| 1 | 測試資料仍在 production D1（`test1`/`bob`/`phase13` 等 9 個地址、8 封信） | 髒資料、被動收到外部垃圾信 | 上線前清空或保留為 sandbox 地址 |
| 2 | `mail/` 物件無 `sha256` custom metadata | 收信端無法用 R2 metadata 做完整性比對（改由 `r2_manifest` 記錄） | Phase 14+ 於 handler 寫入 metadata |
| 3 | 不支援 Range 請求（下載大附件無法續傳） | ≤25MiB 附件需一次下載 | 之後補 206 支援 |
| 4 | inline 附件（`cid:` 內嵌圖）不顯示 | HTML 信的內嵌圖片看不到 | 之後做 cid → R2 對應 |
| 5 | 遠端圖片被剝離（MVP 刻意） | HTML 信中的外部圖片不顯示 | 之後做圖片代理（08 §16） |
| 6 | 無前端 App（Inbox UI） | 目前只能透過 API 使用 | 下一階段（React） |
| 7 | `email_aliases` 表已建但無 API | 別名功能未實作 | 依需求排程 |

## 6. 相關文件

- 架構：`01-architecture.md`｜流程：`02-email-flows.md`｜Schema：`03`、`04`
- API：`05-api-spec.md`｜結構：`06`｜CF 資源：`07`｜安全：`08`
- 備份／還原：`09-backup-dr.md`（§5.1 Runbook）｜實作計畫：`10-implementation-plan.md`
