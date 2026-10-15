# 17 — 備份與還原手冊（AtWhoMail）

> 建立於 2026-10-15，源自「備份還原演練」（`docs/16` §2 項目 2）的實測結果。
> 目的：**出事時有人能照著做**，且每一步都可用指令驗證。

---

## 1. 架構（單向鏡像）

| 來源（雲端）| 目的（本機）| 頻率 | 內容 |
|---|---|---|---|
| D1 `mail-d1` | PostgreSQL **`atwhomail_backup`** | 每 **5 分鐘**（`SYNC_INTERVAL_MS`）| 全表鏡像：`users`、`email_addresses`、`email_aliases`、`messages`、`attachments`、`invites`、`local_migrations`、`backup_watermark`、`r2_manifest` |
| R2 `mail-r2` | 檔案系統 **`D:\Mail\mail-backup`** | 同上 | 物件**內容**（`mail/2026/…eml`、`attachments/…`）＋ `sha256` 清單存於 `r2_manifest` |
| （快照）| `D:\Mail\mail-backup-snapshots` | 同上 | 快照／狀態檔 |

**監控**

| 監控者 | 排程 | 行為 |
|---|---|---|
| Windows 排程 `AtWhoMail Backup Agent` | 常駐（每 5 分鐘觸發，`IgnoreNew`）| 執行同步迴圈 |
| Windows 排程 `AtWhoMail Backup Verify` | 每日 09:00 | 驗證 |
| Windows 排程 `AtWhoMail Backup Watchdog` | 每 10 分鐘 | 異常告警 |
| Hermes cron（`atwhomail-backup-watchdog.py`）| 每 10 分鐘 | 異常寄信 **`alerts@atwho.org` → `ulhome@gmail.com`** |

⚠️ 備份為**單向**（雲端 → 本機），且**包含已軟刪除的列**（歷史保留 ✅）；因此備份筆數 **≥ production** 是正常現象 ✅

---

## 2. 健康檢查（複製即用）

```bash
# ① 排程狀態（PowerShell）
powershell -NoProfile -Command "Get-ScheduledTask | Where-Object { $_.TaskName -match 'AtWhoMail' } | ForEach-Object { $i = $_ | Get-ScheduledTaskInfo; '{0,-30} {1,-9} last={2} result={3}' -f $_.TaskName, $_.State, $i.LastRunTime, $i.LastTaskResult }"
```
```sql
-- ② 新鮮度（應落後 < 10 分鐘）
SELECT table_name, to_timestamp(MAX(updated_at)/1000) AS 最後同步 FROM backup_watermark GROUP BY table_name ORDER BY table_name;

-- ③ 備份庫筆數
SELECT 'users' AS 表, COUNT(*) FROM users
UNION ALL SELECT 'email_addresses', COUNT(*) FROM email_addresses
UNION ALL SELECT 'messages', COUNT(*) FROM messages
UNION ALL SELECT 'attachments', COUNT(*) FROM attachments
UNION ALL SELECT 'invites', COUNT(*) FROM invites
UNION ALL SELECT 'r2_manifest', COUNT(*) FROM r2_manifest;
```
```bash
# ④ R2 備份完整性（抽驗 sha256）
#    對 r2_manifest 每列：sha256(檔案 local_path) 應等於 manifest.sha256
#    本機備份目錄：D:\Mail\mail-backup（115 檔案／約 8 MB，2026-10-15 實測 ✅）
```
```bash
# ⑤ D1 現況筆數（比對用）
cd /d/Mail/Atwhomail/packages/api
node ../../node_modules/wrangler/bin/wrangler.js d1 execute mail-d1 --remote --json --command "SELECT COUNT(*) AS n FROM messages"
```

---

## 3. 還原演練紀錄（2026-10-15 實測 ✅）

| 步驟 | 結果 |
|---|---|
| 新鮮度 | ✅ watermark `2026-10-15 16:13:15`（落後 159 秒）|
| `pg_dump` | ✅ 81.5 KB、3.0 秒 |
| 還原（schema 層）| ✅ **9 張表筆數與備份完全一致**（messages 87／email_addresses 18／users 4／r2_manifest 111／invites 3／attachments 14／email_aliases 0／local_migrations 3／backup_watermark 6）|
| 還原後可讀性 | ✅ owner `2|itag|owner`、最新信件、訪客地址皆可查 |
| R2 物件 | ✅ 抽驗 3 檔 sha256 **完全相符**；manifest 111 筆 vs 實體 115 檔（差額為快照／狀態檔 ✅）|
| 限制 | ⚠️ 備份角色 `atwhomail_backup` **無 `CREATEDB`** → 無法建立新資料庫；⚠️ dump 含 `ALTER DEFAULT PRIVILEGES` 需更高權限（無害）|

**演練指令（可重複執行，會自動清理）**

```bash
# 只用 schema，不需 CREATEDB
PGPASSWORD=<備份密碼> psql -U atwhomail_backup -h localhost -d atwhomail_backup \
  -c "DROP SCHEMA IF EXISTS drill CASCADE; CREATE SCHEMA drill;"
PGPASSWORD=<備份密碼> pg_dump -U atwhomail_backup -h localhost -d atwhomail_backup -f drill.sql
# 將 public. 改寫為 drill. 後匯入（見 docs/16 階段紀錄的做法）
# 比對筆數 → 清理：DROP SCHEMA drill CASCADE;
```

---

## 4. 真正的還原程序

### 4.1 資料庫（D1 損毀時）

1. **先保住現場**：匯出目前 D1（`wrangler d1 export mail-d1 --remote --output now.sql`）✅
2. **建立目標資料庫**（⚠️ 需 `postgres` 超級使用者；備份角色無權限 ✅）
   `createdb -U postgres -h localhost atwhomail_restore`
3. **匯入**：`psql -U postgres -d atwhomail_restore -f <dump.sql>`（建議加 `--no-owner` 重新 dump 以避開權限錯誤 ✅）
4. **驗證**：比對 §2-③ 的筆數；抽查 owner 與最近信件 ✅
5. **回填 D1**（⚠️ 僅在 D1 損毀時；逐表、先 SELECT 精準 id、回報筆數）：
   `wrangler d1 execute mail-d1 --remote --file=restore.sql`
6. **驗證線上**：`/api/health`、`/api/users?role=visitor`、前端登入 ✅

### 4.2 R2（物件遺失時）

⚠️ **先決條件**：目前 Cloudflare API Token **無 R2 寫入權限** → 需改用有權限的憑證或在 Dashboard 操作 ✅

1. 從 `D:\Mail\mail-backup\<r2_key>` 取檔 ✅
2. 逐檔回填：`wrangler r2 object put mail-r2/<r2_key> --file "<local_path>"` ✅
3. 驗證：重新計算 `sha256` 與 `r2_manifest.sha256` 比對 ✅
4. 使用者可見驗證：開該封信 → 附件／原始檔可下載 ✅

---

## 5. 已知限制與建議

| # | 限制 | 建議 |
|---|---|---|
| 1 | 備份角色無 `CREATEDB` | 授予 `CREATEDB`，或一律以 `postgres` 執行還原（本手冊採後者 ✅）|
| 2 | dump 的 `ALTER DEFAULT PRIVILEGES` 需更高權限 | 還原時用 `pg_dump --no-owner --no-acl` 重新產生 ✅ |
| 3 | R2 無寫入權限 | 需要時於 Dashboard 上傳，或發一組僅含 `R2:Edit` 的 token ✅ |
| 4 | 排程 `LastTaskResult` 非 0 無告警 | 可擴充 watchdog：每日檢查排程結果非 0 時寄信 ✅ |
| 5 | 只做過**演練**（schema 層），未做過**真實災難還原** | 建議每季做一次 §3 演練 ✅ |

---

## 6. 定期檢查清單（建議每月）

- [ ] §2-① 三個排程皆 `Ready/Running` 且 `result=0`（或 0x41301＝已在執行 ✅）
- [ ] §2-② 新鮮度落後 < 10 分鐘
- [ ] §2-③ 備份筆數 ≥ production
- [ ] §2-④ R2 抽驗 sha256 相符
- [ ] §3 還原演練（schema 層）通過
- [ ] `docs/16` §10 的相關決策是否有變更
