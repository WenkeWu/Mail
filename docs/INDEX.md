# docs/INDEX — 文件導航（給 AI agent 與人看的第一站）

> **這是自動產生的檔案，不要手改。** 改各檔的 front-matter 後執行 `node scripts/docs-index.mjs`。
> 檢查是否落後：`node scripts/docs-index.mjs --check`（落後會 exit 1）。
> 產生時間：2026-11-13｜共 **35** 份、**568 KB**、狀態分布：需求 1／現況 24／設計 6／評估 1／歷史 3

## 給 AI agent 的使用規則（依序照做，不要整批讀）

1. **先讀根目錄 `AGENTS.md`**（自動載入）→ 再讀本檔。
2. 用「什麼時候讀」欄位挑選，**最多同時讀 2 份**；其餘用 `grep`／`rg` 定位段落，不要整檔載入。
3. **判斷「現在實際長怎樣」只能用 `status: 現況`** 的檔案（首選 `31-handoff.md`）。
   標成 `設計`／`評估`／`歷史` 的檔案是「當初的計畫」，可能與現況不同。
4. 需求要不要做、是否偏離原始設計 → 只看 `mail_PRD_SRS.md`（需求原文）。
5. 需要「決策為什麼改變」→ `mail_PRD_SRS.md` §0.2 的「原文 vs 現況」對照表。

## 狀態定義

| status | 意思 | 能不能當現況引用 |
|---|---|---|
| 需求 | 原始 PRD／SRS（驗收基準） | 只作「該不該做」的依據 |
| 現況 | 已上線／已實作的實況 | ✅ 可以 |
| 設計 | 設計或方案文件（可能尚未實作、或已偏離） | ❌ 不行 |
| 評估 | 選項比較與結論（例如「反向別名不實作」） | ❌ 不行 |
| 歷史 | 已完成或已作廢的階段性文件 | ❌ 不行 |

## 檔案清單

| 檔案 | 主題 | 狀態 | 更新 | 大小 | 什麼時候讀 |
|---|---|---|---|---|---|
| `01-architecture.md` | 最終架構與 Production Data Flow | 設計 | 2026-10-05 | 5 KB | 要理解整體架構與 production data flow 時（架構基準，非現況細節） |
| `02-email-flows.md` | Email Flows（收信 / 寄信 / 例外路徑） | 設計 | 2026-10-05 | 5 KB | 要追收信／寄信／例外路徑的設計意圖時 |
| `03-database-schema.md` | Database Schema（ER Diagram + D1 Tables） | 現況 | 2026-11-09 | 12 KB | 改資料表、加欄位、寫 migration 前（D1 全部表與關聯） |
| `04-r2-keys.md` | R2 Object Key 設計 | 設計 | 2026-10-13 | 4 KB | 動 R2 物件鍵、附件或備份路徑時 |
| `05-api-spec.md` | REST API 規格（適合 React App 使用） | 現況 | 2026-11-11 | 111 KB | 改任何 API 端點／錯誤碼／欄位時 —— **只 grep 端點名，勿整檔讀**（110 KB） |
| `06-project-structure.md` | Project Folder Structure（Wrangler / TypeScript） | 設計 | 2026-10-13 | 10 KB | 找程式放哪裡、wrangler 設定時（部分已過時，以實際目錄為準） |
| `07-cloudflare-resources.md` | Cloudflare Resources 清單（手動 vs 自動） | 現況 | 2026-11-09 | 10 KB | 要找 resource ID、DNS、Workers/Pages 設定時 |
| `08-security-checklist.md` | Security Checklist | 現況 | 2026-10-06 | 10 KB | 做安全審查或改權限前（N 系列規則在這裡） |
| `09-backup-dr.md` | Backup / Disaster Recovery 設計 | 現況 | 2026-10-05 | 10 KB | 改備份流程、DR 演練時 |
| `10-implementation-plan.md` | MVP Implementation Plan（實作順序 + 成本表） | 歷史 | 2026-10-06 | 12 KB | 想知道 MVP 當初怎麼排順序／成本（已完成，勿當現況） |
| `11-launch-checklist.md` | 上線檢查清單（Launch Checklist） | 現況 | 2026-11-11 | 84 KB | 上線前檢查、端點矩陣 —— **大檔（84 KB），只 grep 關鍵字** |
| `12-pwa-integration.md` | 外部 App／PWA 收發信整合指南 | 歷史 | 2026-10-13 | 10 KB | 要接外部 App／PWA 時；本專案已決議不走 PWA，僅作參考 |
| `13-open-registration-design.md` | 開放註冊設計（訪客註冊 ＋ Access 邊緣閘門） | 設計 | 2026-11-09 | 26 KB | 改註冊／配額／防濫用規則時的設計依據（C1–C8） |
| `14-phase1-implementation-brief.md` | Phase 1 實作指令包（給實作 agent 的規格書） | 歷史 | 2026-11-09 | 24 KB | 回溯 Phase 1 規格（已實作完成，勿當現況） |
| `15-api-auth-cheatsheet.md` | AtWhoMail API 認證速查表（端點／標頭／範例） | 現況 | 2026-10-14 | 6 KB | 需要快速查認證標頭／token 種類時（比 05 快） |
| `16-admin-hardening-and-console.md` | 管理權限強化 ＋ 管理主控台（實作規格） | 現況 | 2026-11-09 | 52 KB | 改管理權限（L1/L2/L3）、管理主控台、N10 規則時 |
| `17-backup-and-restore.md` | 備份與還原手冊（AtWhoMail） | 現況 | 2026-10-22 | 11 KB | 要實際備份／還原／驗證時的操作手冊 |
| `18-interactive-form-mail-design.md` | 郵件種類與互動式表單運作模式（設計文件 v0.1） | 現況 | 2026-10-22 | 27 KB | 改互動式表單（P1/P2、四道鎖、RJSF）時 |
| `19-mail-ux-fixes.md` | 信箱 UX 修正：刪除語意 ＋ 複選批次（D19） | 現況 | 2026-11-04 | 10 KB | 改信箱刪除語意、批次、垃圾桶時（D19） |
| `20-id-vs-domain-check.md` | 註冊 ID 與二級網域同名偵測（D20） | 現況 | 2026-11-11 | 5 KB | 改註冊 ID 檢查／撞網域偵測時（D20） |
| `21-registration-email-verification.md` | 註冊改為 Email 驗證碼（取消邀請碼） | 現況 | 2026-11-11 | 5 KB | 改註冊驗證碼流程時（D21） |
| `22-registration-links.md` | 可分享的註冊／邀請連結（D22） | 現況 | 2026-11-04 | 3 KB | 改可分享註冊連結時（D22） |
| `23-turnstile-bot-protection.md` | 註冊加上 Cloudflare Turnstile（防機器人） | 現況 | 2026-11-04 | 3 KB | 改防機器人／Turnstile widget 時（D23） |
| `24-alias-reverse-alias-eval.md` | 別名（Alias）＋ 反向別名（Reverse Alias）評估 | 評估 | 2026-11-05 | 7 KB | 要重啟「反向別名」討論時（結論：不實作） |
| `25-alias-phase1.md` | 別名 Phase 1 實作規格（D25） | 現況 | 2026-11-07 | 8 KB | 改別名規則／收信投遞／回外信帶別名時（D25、D31） |
| `26-cross-app-sso.md` | 跨 App 共用登入／註冊（單一帳號中心） | 設計 | 2026-11-09 | 9 KB | 要接新系統／改 SSO 架構時的方案依據（D26） |
| `27-d26-auth-proxy.md` | D26 實作規格：`auth.atwho.org` 薄代理 ＋ App code 交換 | 現況 | 2026-11-05 | 7 KB | 改 auth.atwho.org 代理、code 交換時（D26 已上線） |
| `28-d27-google-oauth.md` | D27 實作規格：Google OAuth 登入 ＋ 忘記密碼 | 現況 | 2026-11-08 | 8 KB | 改 Google 登入／忘記密碼時（D27） |
| `29-d29-account-settings.md` | D29：`app.atwho.org` 收斂管理功能 ＋ 新增「個人設定」頁 | 現況 | 2026-11-07 | 6 KB | 改個人設置頁／app 站收斂時（D29） |
| `31-handoff.md` | 交接文件（HANDOFF）｜2026-11-05 收尾 | 現況 | 2026-11-11 | 12 KB | **開新對話第一份**：現況、決策、金鑰路徑、指令、待辦 |
| `32-i18n-locale.md` | D32：全站語系與區域設定（i18n） | 現況 | 2026-11-08 | 6 KB | 改語系／國家選擇／日期格式時（D32） |
| `36-ui-style.md` | D36：AtWho UI Style（視覺樣式對齊） | 現況 | 2026-11-10 | 3 KB | 改視覺樣式、顏色、圓角、focus 樣式時（D36） |
| `37-unified-sso.md` | D37：Mail 帳號中心與五系統入口（SSO） | 現況 | 2026-11-11 | 9 KB | 改五系統入口／SSO 契約／接遠端系統時（D37） |
| `38-visitor-dashboard.md` | 訪客 Dashboard 與 AllChat 身分等級投影（Mail 端） | 現況 | 2026-11-11 | 11 KB | 改訪客 Dashboard／AllChat 身分投影時（D38，待部署） |
| `mail_PRD_SRS.md` | 100,000 Email Addresses | 需求 | 2026-11-10 | 27 KB | 要判斷「這功能該不該做／是否偏離原始設計」時；§零 只有指標，現況看 docs/31-handoff.md |

## 地雷與缺號（避免浪費工具呼叫）

- **編號 30、33、34、35 不存在**（目前缺：30、33、34、35） —— 不要去找；`D33`／`D35` 是功能代號，不是檔名。
- 大檔（≥50 KB，**只 grep、勿整檔讀**）：`05-api-spec.md`（111 KB）、`11-launch-checklist.md`（84 KB）、`16-admin-hardening-and-console.md`（52 KB）
- 同一主題出現多份時，以 `updated` 較新且 `status: 現況` 者為準；衝突未解請在 PR 中標記。

## 維護規則（人）

1. 新增文件：加 front-matter 四個欄位 → 跑 `node scripts/docs-index.mjs`。
2. 文件內容改變：更新 front-matter 的 `updated`。
3. 文件被取代：把 `status` 改成 `歷史`，並在開頭加一行「已被 `docs/xx` 取代」。
4. 不要在 INDEX 手動補資料（下次產生會被覆蓋）。
