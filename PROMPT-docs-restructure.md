# 通用 prompt：把一個 repo 的 markdown 文件改造成「AI agent 可導航」

> 用法：把本檔整份貼給該專案的 AI agent（Claude Code／Codex／Cursor），只改最上面「專案變數」區塊。
> 已在 AtWhoMail（`D:\Mail`）實作並驗證過，可直接照抄結構。

## 專案變數（貼之前先改這 6 行）

```
PROJECT_NAME   = <專案名，例：AtWhoMail>
REPO_ROOT      = <git root，例：D:\Mail>
CODE_ROOT      = <程式目錄，例：D:\Mail\Atwhomail>
DOCS_DIR       = <文件目錄，例：<REPO_ROOT>\docs>
TEST_CMD       = <例：pnpm test>
LINT_CMD       = <例：pnpm lint>
BUILD_CMD      = <例：pnpm build>
```

## 任務

把 `DOCS_DIR` 下的所有 `*.md` 改造成「**先導航、再精準讀**」的結構，讓 AI agent 不必整批讀文件。請依序完成 5 個步驟，每一步都要能獨立驗證。

### 步驟 1：建立根目錄 `AGENTS.md`（給 agent 自動載入，≤120 行）

必含章節（照順序）：

1. **這是什麼（30 秒）**：專案一句話、對外入口網址、與其他系統的關係。
2. **導航規則**：先讀 `DOCS_DIR/INDEX.md` → 依「什麼時候讀」挑 1–2 份 → 其餘只 `grep`；**判斷現況只能引用 `status: 現況`**。
3. **常用指令**：測試／lint／build／部署／文件索引產生。
4. **硬規則**：不得把 secret 寫進 repo／log／文件；不得用前端狀態或 hostname 判定權限；不改他人未提交變更；不用 `git add -A`；不 force push。
5. **金鑰在哪**：只寫**路徑**，不寫值。
6. **常見任務 → 讀哪一份**（表格，8–10 列）。
7. **文件維護規則**：front-matter 四欄位＋重跑產生器。
8. **已知地雷**：環境怪癖、暫時性錯誤的重試方式、編號缺號。

> 若專案同時支援 Cursor，`CLAUDE.md` 用一行 `@AGENTS.md` 引用，不要複製內容（避免兩份不同步）。

### 步驟 2：為每份文件加 front-matter（4 欄位，固定格式）

```yaml
---
title: 短標題（去掉檔名前綴數字）
status: 需求 | 現況 | 設計 | 評估 | 歷史
updated: YYYY-MM-DD      # 用 git log -1 --format=%ad --date=short -- <file>
read-when: 一句話說明「什麼時候該讀這一份」
---
```

分類原則（**寧可標錯再修，不要全部標現況**）：

| status | 判斷方式 |
|---|---|
| 需求 | 原始 PRD／SRS／驗收基準 |
| 現況 | 描述「目前已上線的實況」，內容會隨程式更新 |
| 設計 | 方案／規格，可能尚未實作或已被取代 |
| 評估 | 選項比較與結論（含「不做」的決策） |
| 歷史 | 已完成、已作廢的階段性文件 |

⚠️ 大量檔案的 `read-when` 不要寫成同一句「相關時閱讀」——那等於沒寫。要寫**觸發條件**（例：「改 API 端點時，只 grep 端點名，勿整檔讀」）。

### 步驟 3：寫 `scripts/docs-index.mjs`（零依賴 Node 產生器）

功能需求：

- 讀 `DOCS_DIR/*.md`（排除 `INDEX.md`），解析 front-matter 四欄位。
- 產生 `DOCS_DIR/INDEX.md`，含：
  1. 檔頭警語（自動產生、勿手改、重跑指令）
  2. **給 AI agent 的使用規則**（先讀 AGENTS.md → 挑 ≤2 份 → 現況只看 `status: 現況` → 大檔只 grep）
  3. 狀態定義表（含「能不能當現況引用」）
  4. 檔案清單表：`檔案｜主題｜狀態｜更新｜大小｜什麼時候讀`
  5. **地雷區**：檔案數／總 KB／≥50 KB 的大檔清單／編號缺號
  6. 維護規則（人）
- 支援 `--check`：INDEX 與目前 front-matter 不一致時 `exit 1`（CI／pre-commit 用）。
- front-matter 缺欄位時，在 INDEX 末尾列出「⚠️ front-matter 問題」而不是靜默跳過。

### 步驟 4：消除「現況重複」

找出同時存在於多份文件的**現況資訊**（上線清單、版本號、端點表、決策對照）：

- 選定**單一權威檔**（通常是 handoff／status 檔）。
- 其他文件（尤其是 PRD／SRS）只留 **5–10 行指標**：「完整現況請看 X；本文只保留需求原文與決策對照」。
- **不要刪除需求原文**（§需求／驗收章節）——那是唯一的需求依據。
- 保留下來但會過時的段落，在標題註明「（歷史）」。

### 步驟 5：驗收（把輸出貼回給我）

| 檢查 | 通過條件 |
|---|---|
| front-matter 覆蓋率 | 100%（`grep -L '^title:' DOCS_DIR/*.md` 應為空） |
| INDEX 產生 | `node scripts/docs-index.mjs` 成功，且列出所有檔案 |
| 落後檢查 | `node scripts/docs-index.mjs --check` exit 0 |
| 重複消除 | PRD／SRS 的現況章節 ≤ 15 行，且含指向權威檔的連結 |
| 原有內容 | 需求／設計原文**沒有被刪除**（用 `git diff --stat` 檢查刪除行數是否合理） |
| 專案關卡 | `TEST_CMD`、`LINT_CMD`、`BUILD_CMD` 全綠（文件改造不應動程式） |

最後回報：
1. `AGENTS.md` 行數與章節清單
2. 檔案數／新增 front-matter 數／INDEX 大小
3. 被瘦身的章節與保留原因
4. commit SHA（單一 commit，訊息例：`docs: 建立 AGENTS.md 與 docs/INDEX 導航（front-matter 全覆蓋）`）

### 步驟 6：強制機制（不靠 agent 自覺）

只寫「請記得更新 INDEX」一定會腐化。請加入以下兩層，並在 repo 內保留可版控的來源：

**(a) git pre-commit hook**（工具中立，所有 agent 都適用）

- 只在 **staged 變更包含 `DOCS_DIR/*.md`（INDEX 以外）** 時才檢查，避免拖慢無關 commit。
- 檢查兩件事：
  1. `node scripts/docs-index.mjs --check` 失敗 → 擋 commit
  2. INDEX 在工作區較新但沒 staged → 也擋（否則 commit 會帶舊版）
- 來源放 `scripts/git-hooks/pre-commit`＋`scripts/git-hooks/install.sh`（複製到 `.git/hooks/` 並 `chmod +x`），**不要**只手動放 `.git/hooks`（不進版控、換機器就消失）。

**(b) CI**（`.github/workflows/docs-index.yml`）

- 觸發：`push`／`pull_request` 且路徑含 `docs/**` 或 `scripts/docs-index.mjs`。
- 步驟：`actions/checkout` → `setup-node` → `node scripts/docs-index.mjs --check`
- 再加一步 front-matter 覆蓋率檢查：每個 `docs/*.md` 都要有 `title／status／updated／read-when`。

**(c) 驗收（必做，三個情境都要擋對）**

```bash
# 情境 1：改 front-matter 不重生成 → 應 exit 1
# 情境 2：重生成但沒 git add docs/INDEX.md → 應 exit 1
# 情境 3：兩者都 staged → 應 exit 0
bash .git/hooks/pre-commit; echo "exit=$?"
```

回報時附上三個情境的實際 exit code。

## 約束

- 不要為了「看起來整齊」而重寫文件內容；**只加 front-matter、只把重複的現況導向權威檔**。
- 不要更動程式碼；若發現文件與程式不一致，**記錄在回報中**，不要順手改程式。
- 不要刪檔（除明確重複且已標 `歷史` 者，且需在回報中列出）。
- 不要引入 npm 依賴（產生器必須只用 `node:fs`／`node:path`）。
