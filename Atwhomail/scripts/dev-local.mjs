#!/usr/bin/env node
/**
 * AtWhoMail — 一鍵本機開發鏈：本機 D1（migrations）→ API（wrangler dev）→ 前端（Vite）
 *
 * 用法（在 D:\Mail\Atwhomail 下）：
 *   pnpm dev                      # 前端 http://localhost:5173 ＋ API http://127.0.0.1:8787（本機 D1/R2）
 *   pnpm dev -- --tunnel          # 同上，並把 tunnel 指向本機（雲端網域 → 本機前端 → 本機 API）
 *   pnpm dev -- --no-seed         # 不在空的 D1 補 owner 列
 *
 * 為什麼要有這支：
 *   `scripts/dev-web.mjs`（另一位助手的腳本）只起 Vite，而 Vite 的 /api proxy 預設打【production】。
 *   本腳本把整條鏈接起來，且**只使用本機資源**（local D1/R2）——不碰 production、不需要登入 wrangler：
 *     1. 套用 migrations 到本機 D1（idempotent；資料落在 packages/api/.wrangler/state）
 *     2. 若本機 D1 是空的（沒有 owner 列）→ 補一列 placeholder，讓 x-admin-token 救援通道可用
 *     3. 起 API：wrangler dev（本機 D1 + R2；預設 127.0.0.1:8787）
 *     4. 等 /api/health 通過後，再起前端，並用 VITE_API_PROXY_TARGET 把 /api 指到本機 API
 *     5. Ctrl+C／任一子程序死亡 → 整棵程序樹收乾淨（含 workerd）
 *
 * 環境變數（可選）：
 *   DEV_API_PORT=8787 / DEV_WEB_PORT=5173
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");
const API_DIR = path.join(ROOT, "packages", "api");
const WEB_DIR = path.join(ROOT, "web");
const DB = "mail-d1";
const API_PORT = Number(process.env.DEV_API_PORT || 8787);
const WEB_PORT = Number(process.env.DEV_WEB_PORT || 5173);
const IS_WIN = process.platform === "win32";
const NO_SEED = process.argv.includes("--no-seed");
const PASSTHRU = process.argv.slice(2).filter((a) => a !== "--no-seed"); // 例如 --tunnel

const log = (m) => console.log(`[dev-local] ${m}`);
const warn = (m) => console.warn(`[dev-local] ${m}`);

const WRANGLER_BIN = path.join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const VITE_BIN = path.join(WEB_DIR, "node_modules", "vite", "bin", "vite.js");
const DEV_WEB = path.join(ROOT, "scripts", "dev-web.mjs");

// ───────────────────────── 小工具 ─────────────────────────
const sleep = (ms) => new Promise((s) => setTimeout(s, ms));

/** 佔用某埠的 PID（只取 LISTENING） */
function listeningPids(port) {
  const out = spawnSync(IS_WIN ? "netstat" : "lsof", IS_WIN ? ["-ano"] : ["-ti", `:${port}`], { encoding: "utf8" }).stdout || "";
  if (!IS_WIN) return out.split(/\s+/).filter(Boolean);
  const re = new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, "g");
  return [...new Set([...out.matchAll(re)].map((m) => m[1]))];
}

function cmdlineOf(pid) {
  if (!IS_WIN) return spawnSync("ps", ["-o", "args=", "-p", pid], { encoding: "utf8" }).stdout || "";
  const ps = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`;
  return spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).stdout || "";
}

function killTree(pid, why) {
  log(`結束 PID ${pid}（${why}）`);
  if (IS_WIN) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  else process.kill(Number(pid), "SIGKILL");
}

/** API 埠的啟動前清理：只清 wrangler/workerd 殘留，其餘一律不動並中止 */
function freeApiPort() {
  const pids = listeningPids(API_PORT);
  if (pids.length === 0) return;
  for (const pid of pids) {
    const cl = cmdlineOf(pid).trim();
    if (/workerd|wrangler/i.test(cl)) {
      killTree(pid, `殘留的 wrangler/workerd：${cl.slice(0, 100)}`);
      continue;
    }
    throw new Error(
      `port ${API_PORT} 被【非 wrangler 程序】佔用（PID ${pid}），我不會主動殺它。\n` +
        `  命令列：${cl}\n  若確定可結束： taskkill /PID ${pid} /T /F   （或設 DEV_API_PORT 換埠）`
    );
  }
}

/**
 * 選前端埠：優先 DEV_WEB_PORT（預設 5173）。
 * - 被 Vite 殘留佔用 → 照用（`dev-web.mjs` 有自己的清埠邏輯）
 * - 被「讀不到命令列、也無法安全終止」的程序佔用（例如別的工作階段留下的卡死 dev server，
 *   taskkill 會回「存取被拒」）→ **自動往後找可用埠**，不讓一鍵啟動被卡死
 */
function resolveWebPort(preferred) {
  const pids = listeningPids(preferred);
  if (pids.length === 0) return preferred;
  const cls = pids.map((pid) => cmdlineOf(pid).trim()).join(" ");
  if (/vite|dev:web|\bweb[\\/]/i.test(cls)) return preferred;
  warn(`port ${preferred} 被非 Vite 程序佔用（PID ${pids.join(",")}；命令列讀不到、可能也殺不掉）`);
  warn("→ 自動改用下一個可用埠（要拿回 5173：請用【系統管理員】權限 taskkill /PID <pid> /T /F）");
  for (let p = preferred + 1; p <= preferred + 20; p++) {
    if (listeningPids(p).length === 0) return p;
  }
  throw new Error(`找不到可用的前端埠（${preferred}–${preferred + 20} 都被佔用）`);
}

/** 以 Node 直接執行 wrangler CLI（不經 shell → 避免 Windows 引號問題） */
function wranglerSync(args) {
  const r = spawnSync(process.execPath, [WRANGLER_BIN, ...args], {
    cwd: API_DIR,
    encoding: "utf8",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

async function waitForHealth(timeoutMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${API_PORT}/api/health`);
      if (r.ok && (await r.json()).db === "ok") return true;
    } catch {
      /* 還沒起來 */
    }
    await sleep(600);
  }
  return false;
}

// ───────────────────────── 主流程 ─────────────────────────
const children = [];
let shuttingDown = false;

function teardown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("");
  log(`收尾中（${reason}）…`);
  for (const c of [...children].reverse()) {
    if (c.pid && c.exitCode === null) killTree(c.pid, "子程序");
  }
  for (const pid of listeningPids(API_PORT)) {
    const cl = cmdlineOf(pid);
    if (/workerd|wrangler/i.test(cl)) killTree(pid, "API 埠殘留");
  }
  log(`本機開發鏈已停止（API ${listeningPids(API_PORT).length === 0 ? "已釋放" : "仍有佔用"}）`);
  process.exit(code);
}

for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) {
  process.on(sig, () => teardown(`收到 ${sig}`));
}
process.on("exit", () => teardown("process exit"));

async function main() {
  console.log("─".repeat(70));
  log("AtWhoMail 本機開發鏈（前端 + API + D1/R2，全部在本機）");
  console.log("─".repeat(70));

  if (!existsSync(WRANGLER_BIN) || !existsSync(VITE_BIN)) {
    throw new Error(`找不到 wrangler 或 vite → 請先在 ${ROOT} 執行： pnpm install`);
  }

  // 1) 本機資料庫：套用 migrations（idempotent）
  log(`套用 migrations → 本機 D1「${DB}」…`);
  const mig = wranglerSync(["d1", "migrations", "apply", DB, "--local"]);
  const tail = mig.out.trim().split(/\r?\n/).slice(-3).join("\n  ");
  if (mig.status !== 0) throw new Error(`migrations 失敗：\n  ${mig.out.trim()}`);
  log(`migrations 完成 ✅\n  ${tail}`);

  // 2) 空的本機 D1 補一列 owner（x-admin-token 救援通道需要 users 有 owner 列）
  if (!NO_SEED) {
    const probe = wranglerSync([
      "d1",
      "execute",
      DB,
      "--local",
      "--command",
      "SELECT COALESCE((SELECT id FROM users WHERE username = 'owner'), 0) AS owner_id",
    ]);
    const id = Number(/"owner_id":\s*(\d+)/.exec(probe.out)?.[1] ?? 0);
    if (probe.status !== 0) warn(`無法查詢 users 表（略過 seed）：${probe.out.trim().split(/\r?\n/).slice(-2).join(" ")}`);
    else if (id > 0) log(`本機 D1 已有 owner（id=${id}）✅`);
    else {
      const ts = Date.now();
      const ins = wranglerSync([
        "d1",
        "execute",
        DB,
        "--local",
        "--command",
        `INSERT INTO users (username, display_name, password_hash, status, role, created_at, updated_at)
         VALUES ('owner', 'Local owner', '!local-dev-placeholder', 'active', 'owner', ${ts}, ${ts})`,
      ]);
      if (ins.status !== 0) warn(`補 owner 失敗：${ins.out.trim().split(/\r?\n/).slice(-2).join(" ")}`);
      else log("本機 D1 原本沒有 owner → 已補一列 placeholder ✅（密碼不可用；用 x-admin-token 即可）");
    }
  }

  // 3) API（wrangler dev；本機 D1 + R2）
  freeApiPort();
  log(`啟動 API（wrangler dev）→ http://127.0.0.1:${API_PORT}`);
  const api = spawn(
    process.execPath,
    [WRANGLER_BIN, "dev", "--port", String(API_PORT), "--ip", "127.0.0.1"],
    { cwd: API_DIR, stdio: "inherit", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } }
  );
  children.push(api);
  api.on("exit", (code) => teardown(`API 結束（exit ${code}）`, code ?? 0));

  if (!(await waitForHealth())) throw new Error(`API 在 90 秒內沒有通過 /api/health（埠 ${API_PORT}）`);
  log(`API 就緒 ✅  http://127.0.0.1:${API_PORT}/api/health → {"ok":true,"db":"ok"}`);

  // 4) 前端（Vite；/api proxy 指到本機 API）
  //    沿用 scripts/dev-web.mjs（它會處理埠殘留與收尾）；找不到時直接起 Vite。
  const webPort = resolveWebPort(WEB_PORT);
  const webEnv = {
    ...process.env,
    VITE_API_PROXY_TARGET: `http://127.0.0.1:${API_PORT}`,
    DEV_WEB_PORT: String(webPort),
  };
  log(`啟動前端（Vite）→ http://localhost:${webPort}（/api → 本機 API）`);
  const web = existsSync(DEV_WEB)
    ? spawn(process.execPath, [DEV_WEB, ...PASSTHRU], { cwd: ROOT, stdio: "inherit", env: webEnv })
    : spawn(
        process.execPath,
        [VITE_BIN, "--port", String(webPort), "--strictPort", "--host", "127.0.0.1", ...PASSTHRU],
        { cwd: WEB_DIR, stdio: "inherit", env: webEnv }
      );
  children.push(web);
  web.on("exit", (code) => teardown(`前端結束（exit ${code}）`, code ?? 0));

  // 5) 等前端起來再印總結
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${webPort}/`, { redirect: "manual" });
      if (r.status < 500) break;
    } catch {
      /* 還沒起來 */
    }
    await sleep(600);
  }

  console.log("");
  console.log("═".repeat(70));
  log("本機開發鏈就緒 ✅");
  log(`  前端（開這個）  http://localhost:${webPort}`);
  log(`  API（本機）     http://127.0.0.1:${API_PORT}      （D1/R2 都在 .wrangler/state）`);
  log(`  健康檢查        http://127.0.0.1:${API_PORT}/api/health`);
  log("");
  log("  產生邀請碼（ADMIN_TOKEN 在 packages/api/.dev.vars）：");
  log(`    curl -s -X POST http://127.0.0.1:${API_PORT}/api/invites \\`);
  log(`      -H "x-admin-token: <ADMIN_TOKEN>" -H "Content-Type: application/json" \\`);
  log(`      -d "{\\"max_uses\\":1,\\"expires_in_hours\\":24}"`);
  log("  查稽核：pnpm --filter @atwhomail/api exec wrangler d1 execute mail-d1 --local \\");
  log('            --command "SELECT event, COUNT(*) FROM registration_audit GROUP BY event"');
  log("");
  log("  ⚠️ 本機沒有 Cloudflare 郵件服務：");
  log("     · 收不到外部來信（本機沒有 MX / Email Routing）");
  log("     · 寄信是【模擬】的：wrangler 不投遞，只把信寫到 packages/api/.wrangler/tmp/email/");
  log("       但 API 回應、配額計數、寄件備份都與正式一致 → 註冊/配額/限流可完整驗證");
  log("     真實收發信請用 production（pnpm dev:web，proxy 預設打 production API）");
  log("  按 Ctrl+C 結束（會一併收掉 workerd 與 Vite）");
  console.log("═".repeat(70));
}

main().catch((err) => {
  console.error(`[dev-local] 啟動失敗：${err.message}`);
  teardown("啟動失敗", 1);
});
