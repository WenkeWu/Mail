/**
 * config.ts — Backup Agent 設定載入與驗證
 *
 * 來源優先序：環境變數 > `.env`（本套件目錄）> 預設值
 * PostgreSQL 密碼：PG_PASSWORD，或讀 `~/.atwhomail-pg-pass`（單行）
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PASS_FILE = join(homedir(), ".atwhomail-pg-pass");
const CF_TOKEN_FILE = join(homedir(), ".atwhomail-cf-token");

/** CF API token：環境變數優先，否則讀 ~/.atwhomail-cf-token（restore 專用） */
function cfToken(): string | null {
  const fromEnv = process.env.CF_API_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  if (existsSync(CF_TOKEN_FILE)) return readFileSync(CF_TOKEN_FILE, "utf8").trim();
  return null;
}

export interface Config {
  apiUrl: string;
  adminToken: string | null;
  pg: { host: string; port: number; user: string; password: string; database: string };
  backupRoot: string;
  migrationsDir: string;
  syncIntervalMs: number;
  r2SyncIntervalMs: number;
  maxTicks: number | null;
  // Phase 15（restore 用；未設定時一般同步流程不受影響）
  cfAccountId: string | null;
  cfApiToken: string | null;
  d1ProdId: string | null;
  d1TestId: string | null;
  r2ProdBucket: string;
  r2TestBucket: string;
  snapshotDir: string;
}

function required(name: string, value: string | undefined): string {
  if (!value || value.trim() === "") {
    throw new Error(`缺少必填設定 ${name}（請在 packages/backup-agent/.env 設定，或見 .env.example）`);
  }
  return value.trim();
}

export function loadConfig(): Config {
  dotenv.config({ path: join(PKG_DIR, ".env"), quiet: true });

  let pgPassword = process.env.PG_PASSWORD?.trim() ?? "";
  if (!pgPassword && existsSync(PASS_FILE)) {
    pgPassword = readFileSync(PASS_FILE, "utf8").trim();
  }

  const intervalRaw = Number(process.env.SYNC_INTERVAL_MS ?? 300_000);
  const r2Raw = Number(process.env.R2_SYNC_INTERVAL_MS ?? 3_600_000);
  const ticksRaw = Number(process.env.BACKUP_MAX_TICKS ?? 0);

  const cfg: Config = {
    apiUrl: (process.env.ATWHOMAIL_API_URL ?? "https://atwhomail-api.ulhome.workers.dev").replace(/\/$/, ""),
    adminToken: process.env.ADMIN_TOKEN?.trim() || null,
    pg: {
      host: process.env.PG_HOST?.trim() || "localhost",
      port: Number(process.env.PG_PORT ?? 5432),
      user: process.env.PG_USER?.trim() || "postgres",
      password: required("PG_PASSWORD（或 ~/.atwhomail-pg-pass）", pgPassword),
      database: required("PG_DATABASE", process.env.PG_DATABASE ?? "atwhomail_backup"),
    },
    backupRoot: resolve(process.env.BACKUP_ROOT?.trim() || join("D:", "Mail", "mail-backup")),
    migrationsDir: join(PKG_DIR, "migrations"),
    syncIntervalMs: Number.isFinite(intervalRaw) && intervalRaw >= 1000 ? intervalRaw : 300_000,
    r2SyncIntervalMs: Number.isFinite(r2Raw) && r2Raw >= 0 ? r2Raw : 3_600_000,
    maxTicks: Number.isFinite(ticksRaw) && ticksRaw > 0 ? ticksRaw : null,
    cfAccountId: process.env.CF_ACCOUNT_ID?.trim() || null,
    cfApiToken: cfToken(),
    d1ProdId: process.env.D1_PROD_ID?.trim() || null,
    d1TestId: process.env.D1_TEST_ID?.trim() || null,
    r2ProdBucket: process.env.R2_PROD_BUCKET?.trim() || "mail-r2",
    r2TestBucket: process.env.R2_TEST_BUCKET?.trim() || "mail-r2-test",
    snapshotDir: resolve(process.env.SNAPSHOT_DIR?.trim() || join("D:", "Mail", "mail-backup-snapshots")),
  };

  if (!/^https?:\/\//.test(cfg.apiUrl)) throw new Error(`ATWHOMAIL_API_URL 格式錯誤：${cfg.apiUrl}`);
  return cfg;
}
