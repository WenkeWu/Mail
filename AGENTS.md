# AGENTS.md — AtWhoMail（D:\Mail）

> 任何 AI agent（Claude Code／Codex／Cursor／Hermes）**開場先讀這一頁**，再依規則決定要不要讀其他文件。
> 目的：**不要整批讀 docs/**（35 份、約 577 KB）。先導航，再精準讀 1–2 份。

## 1. 這是什麼（30 秒）

- **AtWhoMail**：Cloudflare 原生虛擬地址信箱（Email Routing／Email Service／Workers／D1／R2），另有本機 PostgreSQL 單向備份。
- **Mail 同時是帳號中心（IdP）**：Mail／Form／Now／Chat／Flow 五個系統共用一組身分（D26／D37 一次性 code 交換）。
- 入口：`app.atwho.org`（公開訪客）／`mail.atwho.org`（owner，Cloudflare Access 後）／`auth.atwho.org`（SSO 薄代理）。

| 層 | 位置 |
|---|---|
| git root（本 repo，**PUBLIC**） | `D:\Mail` |
| 程式（pnpm workspace，8 個 package） | `D:\Mail\Atwhomail`（`web/`＝前端、`packages/api`＝Worker） |
| 文件 | `D:\Mail\docs` → **先看 `docs/INDEX.md`** |
| migrations | `D:\Mail\Atwhomail\migrations`（0001–0018 已套用 production） |

## 2. 導航規則（照做，省 token）

1. 讀 `docs/INDEX.md`（自動產生）：用「什麼時候讀」欄挑選，**一次最多讀 2 份**。
2. **判斷「現在實際長怎樣」只能引用 `status: 現況`** 的文件，首選 `docs/31-handoff.md`。
   標 `設計`／`評估`／`歷史` 的是「當初的計畫」，可能已偏離。
3. 大檔（`05-api-spec` 111 KB、`11-launch-checklist` 84 KB）→ **只 `grep` 端點名或關鍵字，不要整檔讀**。
4. 需求該不該做、是否偏離原始設計 → 只看 `docs/mail_PRD_SRS.md`（§一–§二十 是需求原文；§0.2 是「原文 vs 現況」對照）。
5. 找不到就問，不要用猜的寫進程式或文件。

## 3. 常用指令（在 `D:\Mail\Atwhomail`）

```bash
pnpm test              # 全部測試（workerd + web DOM），目前 601 項
pnpm lint              # 8 個 workspace 的 typecheck
pnpm build             # 8 個 workspace
pnpm secret:scan       # push 前必跑（PUBLIC repo）
pnpm deploy:api        # 部署 API Worker（atwhomail-api）
# 前端（Pages）
cd web && VITE_API_BASE=https://atwhomail-api.ulhome.workers.dev pnpm build \
  && pnpm exec wrangler pages deploy dist --project-name atwhomail-web --branch main
# migration（遠端；會要 TTY 確認）
cd packages/api && node ../../node_modules/wrangler/bin/wrangler.js d1 migrations apply mail-d1 --remote
# 文件索引（改完 front-matter 必跑）
cd D:/Mail && node scripts/docs-index.mjs
```

## 4. 硬規則（違反就算失敗）

- **N9**：稽核與管理端**不得**記錄信件內文／主旨／寄件者或使用者個資。
- **N10**：不自行對 production D1 做 UPDATE／DELETE／INSERT；migration 只新增檔案，**由 owner 或 owner 授權的助手**套用。
- **機密**：任何 token／secret／密碼**不得**進 repo、commit、文件、log、截圖。金鑰只在本機檔案（見 §5）。
- **權限一律看 session**（`role`／`scope`），**不得**用 hostname 或前端狀態判定權限。
- 不改別人未提交的變更；不用 `git add -A`；不 force push；不 commit／push 除非被要求。

## 5. 金鑰在哪（只記路徑，不要讀值）

| 內容 | 路徑 |
|---|---|
| 金鑰總索引（先看這份） | `C:\Users\johnny\.atwhomail-keys.txt` |
| Cloudflare API Token（DNS read／Workers／D1／Pages） | `C:\Users\johnny\.atwhomail-cf-token` |
| 管理員帳密（`itag`／owner） | `C:\Users\johnny\.atwhomail-admin-credentials.txt` |
| App secrets（本機開發） | `D:\Mail\Atwhomail\packages\api\.dev.vars` |
| wrangler OAuth | `%APPDATA%\xdg.config\.wrangler\config\default.toml` |

## 6. 常見任務 → 讀哪一份

| 我要做的事 | 讀這個 |
|---|---|
| 接手／搞不清現況 | `docs/31-handoff.md`（＋ `docs/INDEX.md`） |
| 改 API 端點／錯誤碼 | `grep` `docs/05-api-spec.md` 的端點名 |
| 改資料表／寫 migration | `docs/03-database-schema.md` |
| 改註冊／配額／防濫用 | `docs/13-open-registration-design.md`（C1–C8）、`docs/31-handoff.md` §2 |
| 改別名／寄信身分 | `docs/25-alias-phase1.md`、`docs/31-handoff.md` §2 |
| 改登入／SSO／接新系統 | `docs/37-unified-sso.md`、`docs/27-d26-auth-proxy.md` |
| 改管理權限／管理台 | `docs/16-admin-hardening-and-console.md` |
| 改備份／還原 | `docs/17-backup-and-restore.md` |
| 改信箱 UX（刪除／批次） | `docs/19-mail-ux-fixes.md` |
| 部署／上線檢查 | 本檔 §3、`docs/11-launch-checklist.md`（grep） |

## 7. 文件維護（人與 agent 都適用）

- 每份 `docs/*.md` 檔頭有 front-matter：`title`／`status`（需求｜現況｜設計｜評估｜歷史）／`updated`／`read-when`。
- 改內容 → 更新 `updated`；文件被取代 → `status: 歷史` 並在開頭寫「已被 `docs/xx` 取代」。
- 新增／修改 front-matter 後執行 `node scripts/docs-index.mjs`；`--check` 可驗證 INDEX 是否落後。
- **不要手改 `docs/INDEX.md`**（下次產生會被覆蓋）。

## 8. 已知地雷

- 編號 **30／33／34／35 不存在**（`D33`／`D35` 是功能代號，不是檔名）。
- MSYS 陷阱：`git`／`node`／`rg` 對 `/d/...` 會失敗 → 用 `D:/...`；`search_files` 讀 D 槽可能失敗 → 用 `grep`。
- `wrangler d1 ... --remote` 偶發 `7403`（暫時性）→ 直接重試。
- Pages 部署後 CDN 需 10–30 秒才切換新 bundle；驗證讀到舊檔請稍候重試。
- `ACCESS_MAIL_AUD` 空字串＝略過 Access 驗證（本機開發用）；production 必須有值。
