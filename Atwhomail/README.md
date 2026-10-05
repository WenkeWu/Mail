# AtWhoMail

## 版本控制（git root = `D:\Mail`）

- Remote：`git@github.com:WenkeWu/Mail.git`（`main`）
- 首次推送：`3f9ebdc`（71 檔 / 0.32 MB）
- **已被 `.gitignore` 排除（絕勿 commit）**：`.env`、`.dev.vars`、`cloudflare_api_token.txt`、
  `mail-backup/`、`mail-backup-snapshots/`、`downloads/`、`node_modules/`、`.wrangler/`、`dist/`

日常流程：
```bash
cd /d/Mail
git add -A && git commit -m "..." && git push
```
提交前機密自檢（應為 0 命中）：
```bash
git grep --cached -l -F "$(cat ~/.atwhomail-cf-token)" ; git diff --cached --name-only | grep -iE "\.env$|token|snapshot"
```

大量虛擬 Email Address + 自有 App 收發信系統（MVP）。

- Domain：`atwho.org`（Cloudflare 代管，Email Routing 已啟用）
- Production：Cloudflare Email Service + D1 + R2（Workers / TypeScript）
- Backup/DR：本機 PostgreSQL + 磁碟（單向增量）
- 設計文件：`D:\Mail\docs\`（01–10）

## 套件

| 套件 | 角色 |
|---|---|
| `packages/api` | REST API（Hono）+ Auth（Owner / Mailbox 雙 session） |
| `packages/email-handler` | 收信 Catch-all Worker（routing → R2 → D1） |
| `packages/shared` | 共用型別 / 驗證 / sanitize |

套件管理：**pnpm**（workspace 定義在 `pnpm-workspace.yaml`，lockfile = `pnpm-lock.yaml`）

## 常用指令（在根目錄執行）

```bash
pnpm install             # 安裝全部 workspace 依賴
pnpm dev:api             # 本機啟動 API worker（預設 http://127.0.0.1:8787）
pnpm dev:email           # 本機啟動收信 worker（email 事件模擬）
pnpm typecheck           # 全部套件型別檢查
pnpm lint                # = typecheck（CI 用；canonical 指令）
pnpm build               # worker 打包 dry-run（不部署；canonical 指令）
pnpm test                # Vitest（workers 測試池，87 tests；canonical 指令）
pnpm backup              # 本機備份 Agent（D1/R2 → PostgreSQL + 磁碟）
pnpm --filter @atwhomail/backup-agent run verify   # 備份完整性檢查（sha256）
# Restore（僅手動；預設 dry-run，prod 需 --allow-prod）
pnpm --filter @atwhomail/backup-agent run restore-d1 -- --target=test --yes
pnpm --filter @atwhomail/backup-agent run restore-r2 -- --bucket=test --yes

## 排程備份（Windows，已上線）
powershell -ExecutionPolicy Bypass -File scripts\register-backup-tasks.ps1   # 註冊排程
powershell -ExecutionPolicy Bypass -File scripts\register-backup-tasks.ps1 -Remove   # 移除
# 兩個工作：AtWhoMail Backup Agent（登入時啟動、常駐、異常自動重啟）
#           AtWhoMail Backup Verify（每日 09:00 完整性檢查，失敗 exit 1）
# 日誌：D:\Mail\mail-backup\logs\{agent,verify}.log
# 注意：.ps1 必須存成 UTF-8 with BOM；.cmd 必須純 ASCII（cmd.exe 以 CP950 讀取）
pnpm deploy:api          # 部署 API worker
pnpm deploy:email        # 部署收信 worker
```
