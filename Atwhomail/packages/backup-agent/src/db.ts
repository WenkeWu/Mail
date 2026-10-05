/**
 * db.ts — 本機 PostgreSQL 連線、schema 套用、健康檢查
 *
 * 設計：只需連線「本機」PG；不做任何 D1/R2 寫入（單向備份鐵則，09 文件 §3）
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import type { Config } from "./config.ts";

const { Pool } = pg;

export type Pool = pg.Pool;

export function createPool(cfg: Config): Pool {
  return new Pool({
    host: cfg.pg.host,
    port: cfg.pg.port,
    user: cfg.pg.user,
    password: cfg.pg.password,
    database: cfg.pg.database,
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
}

/** 套用 migrations/ 內未執行的 `.sql`（idempotent；記錄於 local_migrations） */
export async function ensureSchema(pool: Pool, migrationsDir: string): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS local_migrations (
      name       TEXT PRIMARY KEY,
      applied_at BIGINT NOT NULL
    )
  `);

  const applied = new Set(
    (await pool.query<{ name: string }>("SELECT name FROM local_migrations")).rows.map((r) => r.name)
  );
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  const ran: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO local_migrations (name, applied_at) VALUES ($1, $2)", [file, Date.now()]);
      await client.query("COMMIT");
      ran.push(file);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw new Error(`套用 migration ${file} 失敗：${String(e)}`);
    } finally {
      client.release();
    }
  }
  return ran;
}

export interface Health {
  serverVersion: string;
  mirrorTables: number;
  watermarks: Record<string, number>;
  counts: Record<string, number>;
}

const MIRROR_TABLES = ["users", "email_addresses", "email_aliases", "messages", "attachments"];

export async function health(pool: Pool): Promise<Health> {
  const version = await pool.query<{ version: string }>("SHOW server_version");
  const tbl = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [MIRROR_TABLES]
  );

  const watermarks: Record<string, number> = {};
  const wm = await pool.query<{ table_name: string; cursor: string }>(
    "SELECT table_name, cursor FROM backup_watermark ORDER BY table_name"
  );
  for (const row of wm.rows) watermarks[row.table_name] = Number(row.cursor);

  const counts: Record<string, number> = {};
  for (const t of MIRROR_TABLES) {
    const r = await pool.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM ${t}`);
    counts[t] = Number(r.rows[0]!.n);
  }

  return {
    serverVersion: version.rows[0]!.version,
    mirrorTables: Number(tbl.rows[0]!.n),
    watermarks,
    counts,
  };
}
