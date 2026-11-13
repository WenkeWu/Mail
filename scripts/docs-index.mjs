#!/usr/bin/env node
/**
 * docs-index.mjs — 由 `docs/*.md` 的 front-matter 產生 `docs/INDEX.md`
 *
 * 用法（在 D:\Mail）：
 *   node scripts/docs-index.mjs           # 重新產生 docs/INDEX.md
 *   node scripts/docs-index.mjs --check   # 只檢查是否落後（CI／pre-commit 用，落後則 exit 1）
 *
 * front-matter 契約（每個 docs/*.md 檔頭，見 docs/INDEX.md §維護規則）：
 *   ---
 *   title: 短標題
 *   status: 需求 | 現況 | 設計 | 評估 | 歷史
 *   updated: YYYY-MM-DD
 *   read-when: 什麼時候該讀這一份（一句話，會直接列進 INDEX）
 *   ---
 *
 * 設計原則：
 * 1. **單一來源在檔案本身**（front-matter），INDEX 只是投影 → 不會出現「INDEX 說 A、檔案說 B」。
 * 2. 產生器零依賴（只用 node:fs），任何機器都能跑。
 * 3. `--check` 讓「忘了更新 INDEX」變成可偵測的失敗，而不是靠人記得。
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = join(HERE, "..", "docs");
const OUT = join(DOCS, "INDEX.md");
const CHECK = process.argv.includes("--check");

const STATUS_ORDER = ["需求", "現況", "設計", "評估", "歷史"];

/** 解析 front-matter（只支援本專案用到的 `key: value` 單行格式） */
function parseFrontMatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return { data: {}, body: text };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    data[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { data, body: text.slice(m[0].length) };
}

const files = readdirSync(DOCS)
  .filter((f) => f.endsWith(".md") && f !== "INDEX.md")
  .sort((a, b) => {
    // PRD 放最前面（它是需求原文），其餘依數字前綴
    const num = (f) => {
      const m = f.match(/^(\d+)/);
      return m ? Number(m[1]) : 9999;
    };
    return num(a) - num(b) || a.localeCompare(b);
  });

const rows = [];
const problems = [];
for (const f of files) {
  const raw = readFileSync(join(DOCS, f), "utf8");
  const { data, body } = parseFrontMatter(raw);
  const missing = ["title", "status", "updated", "read-when"].filter((k) => !data[k]);
  if (missing.length) problems.push(`${f}: 缺 front-matter 欄位 ${missing.join("／")}`);
  const kb = Math.max(1, Math.round(Buffer.byteLength(raw, "utf8") / 1024));
  const lines = body.split(/\r?\n/).length;
  rows.push({
    file: f,
    title: data.title ?? "(未設定 title)",
    status: data.status ?? "(未設定)",
    updated: data.updated ?? "(未設定)",
    readWhen: data["read-when"] ?? "(未設定)",
    kb,
    lines,
  });
}

const big = rows.filter((r) => r.kb >= 50).sort((a, b) => b.kb - a.kb);
const missingNums = [30, 33, 34, 35].filter((n) => !rows.some((r) => r.file.startsWith(String(n).padStart(2, "0"))));

const countBy = Object.fromEntries(STATUS_ORDER.map((s) => [s, rows.filter((r) => r.status === s).length]));
const totalKb = rows.reduce((a, r) => a + r.kb, 0);

const table = [
  "| 檔案 | 主題 | 狀態 | 更新 | 大小 | 什麼時候讀 |",
  "|---|---|---|---|---|---|",
  ...rows.map(
    (r) => `| \`${r.file}\` | ${r.title} | ${r.status} | ${r.updated} | ${r.kb} KB | ${r.readWhen} |`
  ),
].join("\n");

const out = `# docs/INDEX — 文件導航（給 AI agent 與人看的第一站）

> **這是自動產生的檔案，不要手改。** 改各檔的 front-matter 後執行 \`node scripts/docs-index.mjs\`。
> 檢查是否落後：\`node scripts/docs-index.mjs --check\`（落後會 exit 1）。
> 產生時間：${new Date().toISOString().slice(0, 10)}｜共 **${rows.length}** 份、**${totalKb} KB**、狀態分布：${STATUS_ORDER.map((s) => `${s} ${countBy[s]}`).join("／")}

## 給 AI agent 的使用規則（依序照做，不要整批讀）

1. **先讀根目錄 \`AGENTS.md\`**（自動載入）→ 再讀本檔。
2. 用「什麼時候讀」欄位挑選，**最多同時讀 2 份**；其餘用 \`grep\`／\`rg\` 定位段落，不要整檔載入。
3. **判斷「現在實際長怎樣」只能用 \`status: 現況\`** 的檔案（首選 \`31-handoff.md\`）。
   標成 \`設計\`／\`評估\`／\`歷史\` 的檔案是「當初的計畫」，可能與現況不同。
4. 需求要不要做、是否偏離原始設計 → 只看 \`mail_PRD_SRS.md\`（需求原文）。
5. 需要「決策為什麼改變」→ \`mail_PRD_SRS.md\` §0.2 的「原文 vs 現況」對照表。

## 狀態定義

| status | 意思 | 能不能當現況引用 |
|---|---|---|
| 需求 | 原始 PRD／SRS（驗收基準） | 只作「該不該做」的依據 |
| 現況 | 已上線／已實作的實況 | ✅ 可以 |
| 設計 | 設計或方案文件（可能尚未實作、或已偏離） | ❌ 不行 |
| 評估 | 選項比較與結論（例如「反向別名不實作」） | ❌ 不行 |
| 歷史 | 已完成或已作廢的階段性文件 | ❌ 不行 |

## 檔案清單

${table}

## 地雷與缺號（避免浪費工具呼叫）

- **編號 30、33、34、35 不存在**${missingNums.length ? `（目前缺：${missingNums.join("、")}）` : ""} —— 不要去找；\`D33\`／\`D35\` 是功能代號，不是檔名。
- 大檔（≥50 KB，**只 grep、勿整檔讀**）：${big.map((r) => `\`${r.file}\`（${r.kb} KB）`).join("、") || "無"}
- 同一主題出現多份時，以 \`updated\` 較新且 \`status: 現況\` 者為準；衝突未解請在 PR 中標記。

## 維護規則（人）

1. 新增文件：加 front-matter 四個欄位 → 跑 \`node scripts/docs-index.mjs\`。
2. 文件內容改變：更新 front-matter 的 \`updated\`。
3. 文件被取代：把 \`status\` 改成 \`歷史\`，並在開頭加一行「已被 \`docs/xx\` 取代」。
4. 不要在 INDEX 手動補資料（下次產生會被覆蓋）。
${problems.length ? `\n## ⚠️ front-matter 問題\n\n${problems.map((p) => `- ${p}`).join("\n")}\n` : ""}`;

if (CHECK) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    /* 不存在 → 視為落後 */
  }
  const strip = (s) => s.replace(/> 產生時間：.*\n/, "");
  if (strip(current) !== strip(out)) {
    console.error("[docs-index] INDEX.md 已落後，請執行：node scripts/docs-index.mjs");
    process.exit(1);
  }
  console.log("[docs-index] ✅ INDEX.md 是最新的");
} else {
  writeFileSync(OUT, out, "utf8");
  console.log(`[docs-index] ✅ 已寫入 docs/INDEX.md（${rows.length} 份文件、${totalKb} KB）`);
  if (problems.length) {
    console.warn(`[docs-index] ⚠️ ${problems.length} 個檔案 front-matter 不完整：`);
    for (const p of problems) console.warn("  -", p);
  }
}
