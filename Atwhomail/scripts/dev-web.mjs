#!/usr/bin/env node
/**
 * AtWhoMail — 一鍵本機開發鏈：清埠 → 起 Vite(5173) →（可選）起 Cloudflare Tunnel → 收尾清乾淨
 *
 * 用法（在 D:\Mail\Atwhomail 下）：
 *   node scripts/dev-web.mjs                 # 只起 Vite，跑在 127.0.0.1:5173
 *   node scripts/dev-web.mjs --tunnel        # 同時把 mail.atwho.org 指向本機 5173
 *
 * 為什麼要有這支（解決三個實際痛點）：
 *   1. 上一次的 Vite dev server 若被中斷/關窗，程序會留在 5173 → 下次啟動就「port 被佔用」。
 *      這支啟動前會偵測佔用者，只結束【確定是 Vite/dev server】的程序（絕不動 backup-agent、
 *      也不會動來源不明的程序，遇到會中止並告訴你）。
 *   2. 結束時（Ctrl+C／關窗／任何子程序死亡）會把【整棵程序樹】收掉，並實際確認埠已釋放。
 *   3. --tunnel 會一併啟動 cloudflared 並在結束時一起收掉（避免第二個殘留程序）。
 *
 * 環境變數（可選）：
 *   DEV_WEB_PORT=5173          本機埠
 *   DEV_TUNNEL_NAME=atwhomail-dev      tunnel 名稱（需先用 cloudflared tunnel create 建好）
 *   DEV_TUNNEL_HOSTNAME=mail.atwho.org 對外網域（需先用 cloudflared tunnel route dns 指好）
 *   CLOUDFLARED=<path>         cloudflared 執行檔位置
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const PORT = Number(process.env.DEV_WEB_PORT || 5173);
const HOST = "127.0.0.1";
const TUNNEL_NAME = process.env.DEV_TUNNEL_NAME || "atwhomail-dev";
const TUNNEL_HOSTNAME = process.env.DEV_TUNNEL_HOSTNAME || "mail.atwho.org";
const ROOT = path.resolve(import.meta.dirname, "..");
const WITH_TUNNEL = process.argv.includes("--tunnel");
const IS_WIN = process.platform === "win32";

const log = (m) => console.log(`[dev-web] ${m}`);
const warn = (m) => console.warn(`[dev-web] ${m}`);

/** 佔用某埠的 PID 清單（只取 LISTENING） */
function listeningPids(port) {
  const out = spawnSync(IS_WIN ? "netstat" : "lsof", IS_WIN ? ["-ano"] : ["-ti", `:${port}`], {
    encoding: "utf8",
  }).stdout || "";
  if (!IS_WIN) return out.split(/\s+/).filter(Boolean);
  const re = new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, "g");
  return [...new Set([...out.matchAll(re)].map((m) => m[1]))];
}

function cmdlineOf(pid) {
  if (!IS_WIN) return spawnSync("ps", ["-o", "args=", "-p", pid], { encoding: "utf8" }).stdout || "";
  const ps = `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`;
  return spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8" }).stdout || "";
}

/** 結束整棵程序樹 */
function killTree(pid, why) {
  log(`結束 PID ${pid}（${why}）`);
  if (IS_WIN) spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  else process.kill(Number(pid), "SIGKILL");
}

/** 啟動前清埠：只清「看起來是 Vite/dev server」的佔用者 */
function freePort() {
  const pids = listeningPids(PORT);
  if (pids.length === 0) {
    log(`port ${PORT} 目前是空的 ✅`);
    return;
  }
  for (const pid of pids) {
    const cl = cmdlineOf(pid).trim();
    if (/backup-agent|backup_watchdog|watchdog\.py/i.test(cl)) {
      throw new Error(`port ${PORT} 被【備份 agent】佔用（PID ${pid}）—— 這不該發生，請人工確認：\n  ${cl}`);
    }
    if (/vite|dev:web|\bweb[\\/]/i.test(cl)) {
      killTree(pid, `殘留的 Vite dev server：${cl.slice(0, 120)}`);
    } else {
      throw new Error(
        `port ${PORT} 被【非 Vite 程序】佔用（PID ${pid}），我不會主動殺它。\n  命令列：${cl}\n` +
        `  若確定可結束： taskkill /PID ${pid} /T /F   （或設 DEV_WEB_PORT 換埠）`,
      );
    }
  }
  // 等它真的放掉
  for (let i = 0; i < 20; i++) {
    if (listeningPids(PORT).length === 0) {
      log(`port ${PORT} 已釋放 ✅`);
      return;
    }
    spawnSync(IS_WIN ? "ping" : "sleep", IS_WIN ? ["-n", "1", "127.0.0.1"] : ["0.25"], { stdio: "ignore" });
  }
  throw new Error(`port ${PORT} 仍被佔用（等不到釋放）`);
}

function findCloudflared() {
  const cands = [
    process.env.CLOUDFLARED,
    IS_WIN ? path.join(process.env.LOCALAPPDATA || "", "cloudflared", "cloudflared.exe") : null,
    // winget 的 MSI 安裝位置：呼叫端的 PATH 可能還是舊的（安裝前就開的 shell），
    // 所以這裡直接寫死候選路徑，避免「明明裝了卻找不到」。
    IS_WIN ? "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe" : null,
    IS_WIN ? "C:\\Program Files\\cloudflared\\cloudflared.exe" : null,
    IS_WIN ? path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links", "cloudflared.exe") : null,
    "cloudflared",
  ].filter(Boolean);
  for (const c of cands) {
    if (c === "cloudflared") {
      const r = spawnSync("cloudflared", ["--version"], { encoding: "utf8" });
      if (r.status === 0) return "cloudflared";
      continue;
    }
    if (existsSync(c)) return c;
  }
  return null;
}

async function waitForHttp(url, timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url, { redirect: "manual" });
      if (r.status < 500) return true;
    } catch {
      /* 還沒起來 */
    }
    await new Promise((s) => setTimeout(s, 700));
  }
  return false;
}

const children = [];
let shuttingDown = false;

function teardown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`收尾中（${reason}）…`);
  for (const c of children.reverse()) {
    if (c.pid && c.exitCode === null) killTree(c.pid, "子程序");
  }
  // 保險：再掃一次埠，把任何殘留的持有者清掉（只限 Vite 類）
  for (const pid of listeningPids(PORT)) {
    const cl = cmdlineOf(pid);
    if (/vite|dev:web|\bweb[\\/]/i.test(cl) && !/backup-agent/i.test(cl)) killTree(pid, "埠殘留");
  }
  const left = listeningPids(PORT);
  if (TUNNEL_PROC && TUNNEL_PROC.pid && TUNNEL_PROC.exitCode === null) {
    killTree(TUNNEL_PROC.pid, "cloudflared");
  }
  log(left.length === 0 ? `port ${PORT} 已完全釋放 ✅（下次可直接再跑）` : `⚠️ port ${PORT} 仍有佔用者：${left.join(", ")}`);
  process.exit(code);
}

let TUNNEL_PROC = null;

/** 同步小睡（不阻塞太久；Node 主執行緒可用 Atomics.wait） */
const sleepSync = (ms) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const t = Date.now();
    while (Date.now() - t < ms) { /* spin */ }
  }
};

async function main() {
  console.log("─".repeat(64));
  log(`AtWhoMail dev stack ├ 目錄 ${ROOT}`);
  console.log("─".repeat(64));

  freePort();

  // 直接用 Node 執行 Vite 的進入點（不經 pnpm／cmd，避免 shell 引號與 PATH 問題）
  const webDir = path.join(ROOT, "web");
  const viteBin = path.join(webDir, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(viteBin)) {
    throw new Error(`找不到 Vite（${viteBin}）→ 請先在 ${ROOT} 執行： pnpm install`);
  }
  log(`啟動 Vite → http://${HOST}:${PORT}（strictPort，不會偷偷換埠）`);
  const viteArgs = [viteBin, "--port", String(PORT), "--strictPort", "--host", HOST];
  if (WITH_TUNNEL) {
    // 疊加 allowedHosts，讓 Vite 接受來自 tunnel 對外網域的 Host
    // （否則 Vite 的 DNS-rebinding 保護會回 403 Blocked request）
    const overlay = path.join(ROOT, "scripts", "vite.tunnel.config.ts");
    if (existsSync(overlay)) viteArgs.push("--config", overlay);
    else warn(`找不到 ${overlay} → 對外網域可能被 Vite 的 Host 檢查擋掉（403）`);
  }
  const vite = spawn(process.execPath, viteArgs, { cwd: webDir, stdio: "inherit" });
  children.push(vite);
  vite.on("exit", (code) => teardown(`Vite 結束（exit ${code}）`, code ?? 0));

  const up = await waitForHttp(`http://${HOST}:${PORT}/`);
  if (!up) {
    warn("Vite 在 90 秒內沒有回應 HTTP，請看上面的輸出。");
  } else {
    log(`Vite 就緒 ✅  → 本機： http://localhost:${PORT}`);
  }

  if (WITH_TUNNEL) {
    const cf = findCloudflared();
    if (!cf) {
      warn("找不到 cloudflared → 跳過 tunnel。安裝方式：");
      warn('  powershell -Command "winget install --id Cloudflare.cloudflared"');
      warn(`  或下載到 %LOCALAPPDATA%\\cloudflared\\cloudflared.exe（本腳本會自動找）`);
    } else {
      log(`啟動 cloudflared tunnel "${TUNNEL_NAME}" → https://${TUNNEL_HOSTNAME}`);
      warn("注意：tunnel 會把這個【開發用】伺服器公開到網際網路（含 React Refresh 等開發痕跡）。");
      warn("只在你需要時開；要保護請在 Cloudflare Zero Trust 對 mail.atwho.org 加 Access 政策。");
      TUNNEL_PROC = spawn(cf, ["tunnel", "run", "--url", `http://${HOST}:${PORT}`, TUNNEL_NAME], {
        cwd: ROOT,
        stdio: "inherit",
      });
      children.push(TUNNEL_PROC);
      TUNNEL_PROC.on("exit", (code) => teardown(`cloudflared 結束（exit ${code}）`, code ?? 0));
    }
  }

  console.log("─".repeat(64));
  log("按 Ctrl+C 結束（會自動清掉 Vite/tunnel 並釋放埠）");
  console.log("─".repeat(64));
}

for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]) {
  process.on(sig, () => teardown(`收到 ${sig}`));
}
process.on("exit", () => teardown("process exit"));

main().catch((err) => {
  console.error(`[dev-web] 失敗：${err.message}`);
  teardown("啟動失敗", 1);
});
