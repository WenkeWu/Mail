/**
 * restore-d1.ts — 管理員手動 Restore：本機 PG 鏡像 → 目標 D1（09 文件 §5）
 *
 * 用法（一律手動執行，永不自動）：
 *   pnpm --filter @atwhomail/backup-agent run restore-d1 -- --target=test --yes
 *   pnpm --filter @atwhomail/backup-agent run restore-d1 -- --target=prod --allow-prod --yes
 *
 * 安全機制：
 *   1. 未加 `--yes` → 只做 dry-run（印出計畫，不寫入任何資料）
 *   2. 目標 = production 時必須額外帶 `--allow-prod`（避免手誤打錯）
 *   3. 預設先做「事前快照」：把**當前 production D1** dump 成本地 SQL（`SNAPSHOT_DIR/`），
 *      restore 出錯時可用該檔回滾
 *   4. 保留原始 `id` / `created_at`（不破壞 FK 與 cursor 語意）
 *   5. 完成後重建本機 watermark，避免舊游標跳過剛寫入的資料
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config } from "./config.ts";
import { createPool, type Pool } from "./db.ts";
import { BACKUP_TABLES, TABLE_COLUMNS, toD1Row } from "./tables.ts";
import { buildInsertStatement, buildUpsertStatement, chunk, type SqlValue } from "./sql-build.ts";
import { d1Count, d1Query } from "./cf-api.ts";

const args = process.argv.slice(2);
const hasFlag = (f: string) => args.includes(`--${f}`);
const optVal = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;

function log(msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg, ...extra }));
}

function resolveTarget(cfg: Config): { id: string; isProd: boolean; label: string } {
  const t = optVal("target") ?? "test";
  if (t === "test") {
    if (!cfg.d1TestId) throw new Error("D1_TEST_ID 未設定（.env）");
    return { id: cfg.d1TestId, isProd: false, label: "test" };
  }
  if (t === "prod") {
    if (!cfg.d1ProdId) throw new Error("D1_PROD_ID 未設定（.env）");
    return { id: cfg.d1ProdId, isProd: true, label: "prod" };
  }
  return { id: t, isProd: cfg.d1ProdId === t, label: t === cfg.d1ProdId ? "prod" : "custom" };
}

/** 事前快照：把當前 production D1 全量 dump 成 SQL（可回滾） */
async function snapshotProduction(cfg: Config): Promise<string> {
  if (!cfg.adminToken) throw new Error("ADMIN_TOKEN 未設定：快照需要備份 API");
  mkdirSync(cfg.snapshotDir, { recursive: true });
  const file = join(cfg.snapshotDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-d1-snapshot.sql`);
  const lines: string[] = [
    `-- AtWhoMail D1 production snapshot（restore 前防呆用）`,
    `-- 產生時間：${new Date().toISOString()}`,
    `-- 還原方式：wrangler d1 execute <db> --remote --file=<本檔>`,
    "",
  ];
  let totalRows = 0;
  for (const table of BACKUP_TABLES) {
    const cols = TABLE_COLUMNS[table]!;
    let cursor = "0_0";
    let more = true;
    const all: Array<Record<string, SqlValue>> = [];
    while (more) {
      const url = new URL(`${cfg.apiUrl}/api/backup/changes`);
      url.searchParams.set("limit", "500");
      for (const t of BACKUP_TABLES) url.searchParams.set(`c_${t}`, t === table ? cursor : "0_0");
      const res = await fetch(url, { headers: { "x-admin-token": cfg.adminToken } });
      if (!res.ok) throw new Error(`快照拉取失敗 HTTP ${res.status}`);
      const body = (await res.json()) as {
        tables: Record<string, { cursor: string; more: boolean }>;
        created: Array<{ table: string; row: Record<string, SqlValue> }>;
        updated: Array<{ table: string; row: Record<string, SqlValue> }>;
        deleted: Array<{ table: string; row: Record<string, SqlValue> }>;
        hasMore: boolean;
      };
      for (const e of [...body.created, ...body.updated, ...body.deleted]) {
        if (e.table === table) all.push(Object.fromEntries(cols.map((c) => [c, e.row[c] ?? null])) as Record<string, SqlValue>);
      }
      cursor = body.tables[table]!.cursor;
      more = body.tables[table]!.more;
      if (!body.hasMore) more = false;
    }
    for (const part of chunk(all, 100)) lines.push(buildInsertStatement(table, cols, part) + ";");
    totalRows += all.length;
    log("snapshot table", { table, rows: all.length });
  }
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  log("snapshot written", { file, rows: totalRows });
  return file;
}

async function readMirror(pool: Pool, table: string): Promise<Array<Record<string, SqlValue>>> {
  const cols = TABLE_COLUMNS[table]!;
  const { rows } = await pool.query<Record<string, unknown>>(`SELECT ${cols.join(", ")} FROM ${table} ORDER BY id`);
  return rows.map((r) => toD1Row(table, r) as Record<string, SqlValue>);
}

async function resetWatermarks(pool: Pool): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of BACKUP_TABLES) {
    const { rows } = await pool.query<{ ts: string | null; id: string | null }>(
      `SELECT MAX(updated_at) AS ts, MAX(id) AS id FROM ${table}`
    );
    const ts = rows[0]?.ts ? Number(rows[0].ts) : 0;
    const id = rows[0]?.id ? Number(rows[0].id) : 0;
    await pool.query(
      `INSERT INTO backup_watermark (table_name, cursor, cursor_id, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (table_name) DO UPDATE SET cursor = EXCLUDED.cursor, cursor_id = EXCLUDED.cursor_id, updated_at = EXCLUDED.updated_at`,
      [table, ts, id, Date.now()]
    );
    out[table] = `${ts}_${id}`;
  }
  return out;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.cfAccountId || !cfg.cfApiToken) throw new Error("CF_ACCOUNT_ID / CF_API_TOKEN（或 ~/.atwhomail-cf-token）未設定");
  const target = resolveTarget(cfg);
  const dryRun = !hasFlag("yes");
  const batch = Number(optVal("batch") ?? 100);

  log("restore-d1 計畫", {
    target: target.label,
    databaseId: target.id,
    dryRun,
    snapshot: !hasFlag("no-snapshot"),
    batch,
    allowProd: hasFlag("allow-prod"),
  });

  if (target.isProd && !hasFlag("allow-prod")) {
    console.error("拒絕執行：目標是 production D1。若確定要還原，請加 --allow-prod（並先確認已備份當前狀態）。");
    process.exit(1);
  }
  if (dryRun) {
    console.log("（dry-run：未加 --yes，未寫入任何資料。加上 --yes 才會實際執行）");
    process.exit(0);
  }

  const pool = createPool(cfg);
  try {
    if (!hasFlag("no-snapshot")) {
      const file = await snapshotProduction(cfg);
      log("事前快照完成（restore 失敗可回滾）", { file });
    }

    let written = 0;
    for (const table of BACKUP_TABLES) {
      const rows = await readMirror(pool, table);
      const cols = TABLE_COLUMNS[table]!;
      for (const part of chunk(rows, batch)) {
        await d1Query(cfg, target.id, buildUpsertStatement(table, cols, part));
      }
      written += rows.length;
      log("還原表", { table, rows: rows.length, batches: Math.ceil(rows.length / batch) });
    }

    // 驗證：目標 D1 列數 vs 本機鏡像列數
    const verify: Record<string, { mirror: number; target: number | null; ok: boolean }> = {};
    let mismatches = 0;
    for (const table of BACKUP_TABLES) {
      const mirror = (await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${table}`)).rows[0]!.n;
      const t = await d1Count(cfg, target.id, table);
      const ok = String(t) === mirror;
      if (!ok) mismatches += 1;
      verify[table] = { mirror: Number(mirror), target: t, ok };
    }

    const watermarks = await resetWatermarks(pool);
    log("還原完成", { written, mismatches, verify, watermarksReset: watermarks });
    await pool.end();
    process.exit(mismatches === 0 ? 0 : 3);
  } catch (e) {
    await pool.end().catch(() => {});
    throw e;
  }
}

main().catch((e: unknown) => {
  console.error(JSON.stringify({ level: "error", msg: "restore-d1 失敗", error: (e as Error).message }));
  process.exit(2);
});
