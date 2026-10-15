#!/usr/bin/env node
/**
 * secret-scan.mjs — **推送前機密稽核**（docs/16 D14）
 *
 * 為什麼需要它：至今每次 push 前的機密檢查都是**人工 grep**（2026-10-14 做了好幾輪）。
 * 人工掃描的問題不是不準，而是**不會每次都做**：疲勞、趕時間、只掃自己記得的那幾個字串。
 * 這支腳本把「該掃什麼」固定下來，讓 push 前有一個可重複、可自動化的關卡。
 *
 * ── 設計原則 ──
 * 1. **純 Node、零依賴**（只用 `node:` 內建模組）——稽核工具本身不該再引入供應鏈風險。
 * 2. **絕不印出機密值**：發現時只輸出 `檔案:行號:規則名`（規格明文）。
 *    ⚠️ 這一條是刻意的：如果把值印到終端機／CI log，等於把機密**又多複製了一份**到
 *       另一個會被保存、被貼進 issue 的地方。
 * 3. 掃「**即將被推送的內容**」：working tree 的變更（staged ＋ unstaged）與 commit 範圍，
 *    且只看**新增的行**（`+`）——正在刪除的舊機密不是這次要擋的東西。
 * 4. 退出碼：`0` 乾淨、`1` 發現問題、`2` 用法／環境錯誤（讓 CI 能分辨「有機密」與「腳本壞了」）。
 *
 * ── 用法 ──
 *   node scripts/secret-scan.mjs                     # working tree diff ＋ origin/main..HEAD
 *   node scripts/secret-scan.mjs --range HEAD~3..HEAD
 *   node scripts/secret-scan.mjs --tracked           # 額外掃描所有已追蹤檔案的內容（完整稽核）
 *   node scripts/secret-scan.mjs --staged-only       # 只看已 stage 的變更
 *   node scripts/secret-scan.mjs --no-range          # 不掃 commit 範圍
 *   node scripts/secret-scan.mjs --ignore-file path  # 指定忽略清單（見下方 Allowlist）
 *
 * ── Allowlist（兩種，都不需要改腳本）──
 *   a) 行內：該行任一處出現 `secret-scan:ignore` → 整行跳過（適合測試假資料）。
 *   b) 檔案：repo 根目錄放 `.secret-scanignore`，一行一個 glob（`#` 開頭為註解），
 *      例如 `**\/*.pem`、`Atwhomail/packages/api/test/**`。
 *
 * ⚠️ 這支腳本是**輔助**，不是保證：它只掃文字特徵，抓不到「把 token 拆成兩半再組起來」
 *    或「用 base64 包一層」這類刻意規避的寫法。真正的防線是 `.gitignore` ＋ 不要把值寫進檔案。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

// ─────────────────────────── CLI ───────────────────────────

const USAGE = `用法：node scripts/secret-scan.mjs [選項]

  --range <rev-range>   要掃描的 commit 範圍（預設 origin/main..HEAD；該 ref 不存在則略過）
  --no-range            不掃描任何 commit 範圍
  --staged-only         只掃描已 stage 的變更（git diff --cached；不含未追蹤檔案）
  --no-diff             不掃描 working tree 的變更
  --no-untracked        不掃描未追蹤（但未被 .gitignore 排除）的檔案
  --tracked             額外掃描**所有已追蹤檔案**的內容（完整稽核，較慢）
  --ignore-file <path>  指定忽略清單（預設 <repo 根>/.secret-scanignore）
  --json                以 JSON 輸出（僅供工具鏈使用；同樣不含機密值）
  -h, --help            顯示本說明

退出碼：0 = 乾淨、1 = 發現機密、2 = 用法或環境錯誤`;

function parseArgs(argv) {
  const opts = {
    range: "origin/main..HEAD",
    rangeExplicit: false,
    useRange: true,
    diff: true,
    stagedOnly: false,
    untracked: true,
    tracked: false,
    ignoreFile: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--range":
        opts.range = argv[++i] ?? "";
        opts.rangeExplicit = true;
        if (!opts.range) fail("--range 需要一個值，例如 --range HEAD~3..HEAD");
        break;
      case "--no-range":
        opts.useRange = false;
        break;
      case "--staged-only":
        opts.stagedOnly = true;
        break;
      case "--no-diff":
        opts.diff = false;
        break;
      case "--no-untracked":
        opts.untracked = false;
        break;
      case "--tracked":
        opts.tracked = true;
        break;
      case "--ignore-file":
        opts.ignoreFile = argv[++i] ?? "";
        if (!opts.ignoreFile) fail("--ignore-file 需要一個路徑");
        break;
      case "--json":
        opts.json = true;
        break;
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        fail(`未知的參數：${arg}`);
    }
  }
  return opts;
}

function fail(message) {
  process.stderr.write(`[secret-scan] 錯誤：${message}\n\n${USAGE}\n`);
  process.exit(2);
}

// ─────────────────────────── git ───────────────────────────

/**
 * 執行 git。`core.quotePath=false` 讓非 ASCII 檔名原樣輸出（否則 git 會輸出 `\346\226\207`
 * 這類跳脫序列，回報的檔名就不能直接貼進編輯器了）。
 *
 * ⚠️ 一律以 **repo 根目錄**為工作目錄（`-C`）：`git diff` 給的是 repo 相對路徑，但
 *    `git ls-files` 給的是**相對於當時 cwd** 的路徑 —— 從 `Atwhomail/` 這種子目錄執行時，
 *    兩者會對不起來（實測踩到：未追蹤檔案全部找不到、`--tracked` 靜默掃 0 個檔案）。
 *    固定 cwd 之後，所有路徑都是同一套座標系。
 */
let gitCwd = null;

function git(args) {
  return execFileSync("git", [...(gitCwd ? ["-C", gitCwd] : []), "-c", "core.quotePath=false", ...args], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitOrNull(args) {
  try {
    return git(args);
  } catch {
    return null;
  }
}

// ─────────────────────────── 規則 ───────────────────────────

/** 檔名本身就不該進版控的（規格 D14 的「追蹤檔名檢查」；`.example` 一律放行） */
function filenameRuleFor(file) {
  const base = path.basename(file);
  if (/\.example$/i.test(base)) return null; // .env.example／.dev.vars.example 是範本，不是機密
  if (base === ".dev.vars" || base.startsWith(".dev.vars.")) return "tracked-dev-vars";
  if (base === ".env" || base.startsWith(".env.")) return "tracked-env-file";
  if (/\.(pem|key|p12|pfx|p8|jks)$/i.test(base)) return "tracked-key-file";
  if (/credential/i.test(base)) return "tracked-credential-file";
  return null;
}

/** 變數名稱結尾是這些字（大小寫依檔案型態決定）＝ 內容極可能是機密 */
const SECRET_NAME_TAIL = /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS|DSN)$/;
const NAME_BOUNDARY = String.raw`(?:^|[^A-Za-z0-9_])`;

/**
 * 「識別名 ＋ 賦值 ＋ 值」的樣式。值刻意分成四種寫法（雙引號／單引號／反引號／裸值），
 * 這樣：① 帶空白的引號值也能完整取出；② 用 `g` 逐個檢查同一行上的**多個**賦值
 * （`a=1 JWT_SECRET=xxx` 這種寫法不會因為只看第一個而漏掉）。
 */
const ASSIGN_VALUE_SRC = String.raw`(?:"([^"\n]*)"|'([^'\n]*)'|\x60([^\x60\n]*)\x60|([^\s,;]+))`;
const assignRegExp = (nameSrc) => new RegExp(`${NAME_BOUNDARY}(${nameSrc})\\s*[:=]\\s*${ASSIGN_VALUE_SRC}`, "g");
const RE_ASSIGN_UPPER = assignRegExp("[A-Z][A-Z0-9_]*");
const RE_ASSIGN_ANY = assignRegExp("[A-Za-z][A-Za-z0-9_]*");

/** 看起來就是「填假資料」的值：不該干擾真正的稽核（否則測試檔永遠是紅的） */
const PLACEHOLDER_VALUES = new Set([
  "x", "xx", "xxx", "xxxx", "todo", "tbd", "fixme", "changeme", "change_me", "change-me",
  "placeholder", "example", "sample", "dummy", "fake", "redacted", "removed", "none", "null",
  "undefined", "true", "false", "test", "testing", "dev", "development", "local", "localhost",
  "password", "passwd", "secret", "token", "apikey", "api_key", "your-secret", "your-token",
]);
const PLACEHOLDER_PREFIX = /^(?:test|dummy|fake|sample|example|your|my|placeholder|changeme|redacted|xxx+)[-_.]/i;

/** 值是「指向別處」而不是字面值（環境變數／程式碼取值）→ 不是機密 */
const INDIRECT_VALUE = /^(?:\.\.\.|\$\{|\$[A-Za-z_]|process\.env|import\.meta\.env|c\.env|env\.|Deno\.env|os\.environ|<.*>|%[A-Za-z_]+%)/;

/** 值是否「像一個真的機密」：引號內 ≥8 字元，或未加引號的 ≥16 字元 token */
function looksLikeLiteralSecret(value, quoted) {
  const inner = value.trim();
  if (!inner) return false;
  if (INDIRECT_VALUE.test(inner)) return false;
  if (PLACEHOLDER_VALUES.has(inner.toLowerCase())) return false;
  if (PLACEHOLDER_PREFIX.test(inner)) return false;
  if (/^(?:x{3,}|\*{3,}|-{3,}|\.{3,}|_{3,})$/i.test(inner)) return false;
  return quoted ? inner.length >= 8 : /^[A-Za-z0-9+/=_.:@-]{16,}$/.test(inner);
}

const isConfigFile = (file) =>
  /(?:^|\/)(?:\.env[\w.-]*|\.dev\.vars[\w.-]*)$/i.test(file) ||
  /\.(?:env|vars|ini|toml|ya?ml|cfg|conf|properties|tfvars)$/i.test(file);

/**
 * 逐行規則。每個規則＝(行內容, 檔名) → 是否命中。
 * ⚠️ 這裡的函式只回傳 true／false，**不回傳比對到的字串** —— 從型別上就杜绝值外流。
 */
const LINE_RULES = [
  {
    name: "secret-assignment",
    test(line, file) {
      // 大寫識別名（環境變數風格）一律檢查；小寫只在 .env／*.toml／*.yaml 這類設定檔才檢查
      // （否則 `token: "owner-token"` 這種前端物件字面值會滿滿誤報）
      const re = isConfigFile(file) ? RE_ASSIGN_ANY : RE_ASSIGN_UPPER;
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        if (m[0].length === 0) re.lastIndex += 1; // 保險：零長度匹配不至於無限迴圈
        if (!SECRET_NAME_TAIL.test(m[1])) continue;
        const quotedValue = m[2] ?? m[3] ?? m[4];
        if (quotedValue !== undefined) {
          if (looksLikeLiteralSecret(quotedValue, true)) return true;
        } else if (looksLikeLiteralSecret(m[5] ?? "", false)) {
          return true;
        }
      }
      return false;
    },
  },
  {
    // Cloudflare API token＝40 字元十六進位。前後都要有邊界，否則 64 字元的 AUD／sha256 會被誤切
    name: "cloudflare-api-token",
    test: (line) => /\b[0-9a-f]{40}\b/i.test(line),
  },
  {
    name: "jwt",
    test: (line) => /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/.test(line),
  },
  {
    name: "private-key",
    test: (line) => /-----BEGIN (?:[A-Z0-9 ]*PRIVATE KEY|RSA|OPENSSH|DSA|EC|PGP)/.test(line),
  },
  {
    // AWS（AKIA＋16 碼）／Google API key（AIza＋35 碼）／OpenAI（sk- ＋長字串）
    name: "provider-key-prefix",
    test: (line) =>
      /\bAKIA[0-9A-Z]{16}\b/.test(line) ||
      /\bAIza[0-9A-Za-z_-]{35}\b/.test(line) ||
      /\bsk-[A-Za-z0-9_-]{20,}\b/.test(line),
  },
];

/** 行內 allowlist：整行跳過（給「測試用的假 token」這類情況） */
const INLINE_IGNORE = /secret-scan:ignore/;

// ─────────────────────── .secret-scanignore ───────────────────────

/** gitignore 風格的極簡 glob → RegExp（支援 `*`、`**`、`?`；不做 `!` 反向） */
function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

function loadIgnorePatterns(opts, repoRoot) {
  const candidates = opts.ignoreFile
    ? [path.resolve(opts.ignoreFile)]
    : [path.join(repoRoot, ".secret-scanignore"), path.resolve(".secret-scanignore")];
  const file = candidates.find((p) => existsSync(p));
  if (!file) return { file: null, patterns: [] };
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    fail(`無法讀取忽略清單 ${file}：${e.message}`);
  }
  const patterns = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((glob) => ({ glob, re: globToRegExp(glob) }));
  return { file, patterns };
}

/** 路徑是否被忽略：整條路徑或**檔名**符合任一 pattern 就算（`*.pem` 這種寫法才直覺） */
function isIgnored(file, patterns) {
  if (!patterns.length) return false;
  const base = path.basename(file);
  return patterns.some((p) => p.re.test(file) || p.re.test(base));
}

// ─────────────────────── diff 解析與掃描 ───────────────────────

/** `+++ b/xxx` → `xxx`；`/dev/null` → null */
function diffPath(raw) {
  const p = raw.trim();
  if (p === "/dev/null") return null;
  return p.replace(/^[ab]\//, "");
}

/**
 * 解析 `git diff` 輸出，只掃**新增的行**。
 * 行號取自 hunk 標頭 `@@ -a,b +c,d @@` 的 `c`，之後每遇一個 `+` 行就 +1
 * （以 `--unified=0` 執行，不會有 context 行干擾）。
 */
function scanDiff(diffText, sink, ignore) {
  let file = null;
  let lineNo = 0;
  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("+++ ")) {
      file = diffPath(raw.slice(4));
      lineNo = 0;
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("diff --git ") || raw.startsWith("index ")) continue;
    if (raw.startsWith("@@")) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
      lineNo = m ? Number(m[1]) : 0;
      continue;
    }
    if (raw.startsWith("+")) {
      if (file && !isIgnored(file, ignore.patterns)) sink(file, lineNo, raw.slice(1));
      lineNo += 1;
      continue;
    }
    if (raw.startsWith(" ")) lineNo += 1; // 保險：即使有人改成帶 context 的 diff
  }
}

/** 掃一份檔案的內容（`--tracked`／未追蹤檔案用） */
function scanFileContents(file, text, sink) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) sink(file, i + 1, lines[i]);
}

const MAX_TRACKED_BYTES = 2 * 1024 * 1024;

/**
 * 掃一批「工作區裡的檔案」：先做**檔名**檢查，再讀內容逐行掃。
 * 讀不到（權限／掃描途中被刪）或過大／二進位 → 跳過，不讓整支稽核因此壞掉。
 */
function scanRepoFiles(repoRoot, files, sink, ignore, findings) {
  let scannedFiles = 0;
  for (const file of files) {
    if (isIgnored(file, ignore.patterns)) continue;
    const rule = filenameRuleFor(file);
    if (rule) findings.push({ file, line: null, rule });
    try {
      const abs = path.join(repoRoot, file);
      const st = statSync(abs);
      if (!st.isFile() || st.size > MAX_TRACKED_BYTES) continue;
      const text = readFileSync(abs, "utf8");
      if (text.includes("\0")) continue; // 二進位檔（圖片、字型…）
      scanFileContents(file, text, sink);
      scannedFiles += 1;
    } catch {
      /* 讀不到 → 跳過 */
    }
  }
  return scannedFiles;
}

// ─────────────────────────── 主流程 ───────────────────────────

function main() {
  const opts = parseArgs(process.argv.slice(2));

  const repoRoot = (gitOrNull(["rev-parse", "--show-toplevel"]) ?? "").trim();
  if (!repoRoot) fail("這裡不是 git 工作區（找不到 repo 根目錄）");
  gitCwd = repoRoot; // 之後的 git 指令都在 repo 根目錄執行（路徑座標系一致）

  const ignore = loadIgnorePatterns(opts, repoRoot);
  const findings = [];
  const scanned = { files: new Set(), lines: 0, ignoredLines: 0 };
  const scopes = [];

  const sink = (file, line, content) => {
    scanned.files.add(file);
    scanned.lines += 1;
    if (INLINE_IGNORE.test(content)) {
      scanned.ignoredLines += 1;
      return;
    }
    for (const rule of LINE_RULES) {
      if (rule.test(content, file)) findings.push({ file, line, rule: rule.name });
    }
  };

  // ① working tree（staged ＋ unstaged）
  if (opts.diff) {
    const args = opts.stagedOnly
      ? ["diff", "--cached", "--unified=0", "--no-color", "--no-ext-diff", "--diff-filter=d"]
      : ["diff", "HEAD", "--unified=0", "--no-color", "--no-ext-diff", "--diff-filter=d"];
    const out = gitOrNull(args);
    if (out === null) fail("git diff 失敗（repo 可能沒有任何 commit）");
    scopes.push(opts.stagedOnly ? "已 stage 的變更" : "working tree 變更（staged ＋ unstaged）");
    scanDiff(out, sink, ignore);
  }

  // ② commit 範圍（預設 origin/main..HEAD；該 ref 不存在就明講略過，不靜默）
  if (opts.useRange && opts.range) {
    const [left] = opts.range.split("..");
    const leftOk = left ? gitOrNull(["rev-parse", "--verify", "--quiet", `${left}^{commit}`]) !== null : false;
    if (!leftOk) {
      scopes.push(
        opts.rangeExplicit
          ? `commit 範圍 ${opts.range}（⚠️ 左端 ref 不存在，略過）`
          : `commit 範圍 ${opts.range}（origin/main 不存在，略過）`
      );
    } else {
      const out = gitOrNull([
        "diff",
        opts.range,
        "--unified=0",
        "--no-color",
        "--no-ext-diff",
        "--diff-filter=d",
      ]);
      if (out === null) fail(`git diff ${opts.range} 失敗`);
      scopes.push(`commit 範圍 ${opts.range}`);
      scanDiff(out, sink, ignore);
    }
  }

  // ③ 追蹤檔名檢查（＝ 會被推送的檔案清單；`.gitignore` 已擋掉的不在其中）
  const indexFiles = (gitOrNull(["ls-files", "-z"]) ?? "").split("\0").filter(Boolean);
  for (const file of indexFiles) {
    const rule = filenameRuleFor(file);
    if (!rule || isIgnored(file, ignore.patterns)) continue;
    findings.push({ file, line: null, rule });
  }

  // ④ 未追蹤、但**沒有被 `.gitignore` 排除**的檔案。
  //    為什麼要掃：`git diff` 看不到未追蹤的檔案，而它們只差一個 `git add -A` 就會被推上去
  //    —— 推送前的稽核漏掉這一批，等於只檢查了一半。（本機開發用的 `.dev.vars`／`.env`
  //    已被 .gitignore 排除，不會出現在這裡。）
  if (opts.untracked && !opts.stagedOnly) {
    const untracked = (gitOrNull(["ls-files", "--others", "--exclude-standard", "-z"]) ?? "")
      .split("\0")
      .filter(Boolean);
    if (untracked.length) {
      const n = scanRepoFiles(repoRoot, untracked, sink, ignore, findings);
      scopes.push(`未追蹤檔案（${n} 個未被 .gitignore 排除者）`);
    }
  }

  // ⑤ 選配：所有已追蹤檔案的內容（完整稽核）
  if (opts.tracked) {
    const n = scanRepoFiles(repoRoot, indexFiles, sink, ignore, findings);
    scopes.push(`所有已追蹤檔案內容（${n} 個）`);
  }

  report({ opts, findings, scanned, scopes, ignore });
}

function report({ opts, findings, scanned, scopes, ignore }) {
  const clean = findings.length === 0;
  const nameHits = findings.filter((f) => f.line === null).length;
  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          clean,
          scanned_scopes: scopes,
          scanned_files: scanned.files.size,
          scanned_lines: scanned.lines,
          inline_ignored_lines: scanned.ignoredLines,
          ignore_file: ignore.file,
          findings, // ⚠️ 只有檔名／行號／規則名，沒有值
        },
        null,
        2
      )}\n`
    );
    process.exit(clean ? 0 : 1);
  }

  const out = process.stdout;
  out.write(`[secret-scan] 掃描範圍：${scopes.join("、")}\n`);
  if (ignore.file) out.write(`[secret-scan] 忽略清單：${path.relative(process.cwd(), ignore.file) || ignore.file}\n`);
  out.write(
    `[secret-scan] 已檢查 ${scanned.files.size} 個檔案、${scanned.lines} 行` +
      (scanned.ignoredLines > 0 ? `（其中 ${scanned.ignoredLines} 行以 secret-scan:ignore 跳過）` : "") +
      `；追蹤檔名檢查 ${nameHits} 項\n`
  );

  if (clean) {
    out.write("[secret-scan] ✅ 乾淨：沒有發現機密\n");
    process.exit(0);
  }

  out.write("\n發現以下項目（⚠️ 只列位置與規則，不列值）：\n");
  for (const f of findings) {
    out.write(`${f.file}:${f.line ?? "-"}:${f.rule}\n`);
  }
  out.write(
    `\n[secret-scan] ❌ 共 ${findings.length} 項 —— 請勿推送。\n` +
      "  處理方式：把值換成環境變數／secret（並輪替已外流的憑證）；若是刻意的測試假資料，\n" +
      "  在該行加上 `secret-scan:ignore`，或將路徑寫進 .secret-scanignore。\n"
  );
  process.exit(1);
}

main();
