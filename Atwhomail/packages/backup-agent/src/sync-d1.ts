/**
 * sync-d1.ts — D1 metadata → 本機 PostgreSQL（增量、冪等）
 *
 * 流程（09 文件 §2）：
 *   1. 讀本機 backup_watermark（每表一個 keyset 游標 = `updated_at_id`）
 *   2. GET /api/backup/changes?limit=500&c_<table>=<cursor>
 *   3. 交易內 upsert（ON CONFLICT (id) DO UPDATE，且僅當 EXCLUDED.updated_at 較新）
 *   4. 更新 watermark；若 hasMore 立即再拉下一頁（上限保護）
 *
 * 鐵則：只讀 Production，只寫本機 PG。
 */
import type { Config } from "./config.ts";
import type { Pool } from "./db.ts";
import { BACKUP_TABLES, TABLE_COLUMNS } from "./tables.ts";

interface Row {
  [key: string]: unknown;
}

interface ChangesResponse {
  limit: number;
  tables: Record<string, { cursor: string; more: boolean; rows: number }>;
  created: Array<{ table: string; row: Row }>;
  updated: Array<{ table: string; row: Row }>;
  deleted: Array<{ table: string; row: Row }>;
  hasMore: boolean;
}

export interface SyncResult {
  pages: number;
  created: number;
  updated: number;
  deleted: number;
  perTable: Record<string, { rows: number; cursor: string; more: boolean }>;
  cursors: Record<string, string>;
}

const MAX_PAGES = 100; // 保護：避免 API 端異常導致無限迴圈

export async function loadCursors(pool: Pool): Promise<Record<string, string>> {
  const cursors: Record<string, string> = {};
  for (const t of BACKUP_TABLES) cursors[t] = "0_0";
  const { rows } = await pool.query<{ table_name: string; cursor: string; cursor_id: string }>(
    "SELECT table_name, cursor, cursor_id FROM backup_watermark"
  );
  for (const r of rows) {
    if (r.table_name in cursors) cursors[r.table_name] = `${r.cursor}_${r.cursor_id}`;
  }
  return cursors;
}

/** 單列表 upsert：以 (id) 衝突，僅在新資料 updated_at >= 既有值時覆蓋 */
async function upsertRow(
  client: { query: (sql: string, values: unknown[]) => Promise<unknown> },
  table: string,
  row: Row,
  markDeleted: boolean
): Promise<void> {
  const cols = TABLE_COLUMNS[table];
  if (!cols) throw new Error(`未知的備份表：${table}`);

  const values: unknown[] = cols.map((c) => {
    const v = row[c];
    return v === undefined ? null : v;
  });
  const placeholders = cols.map((_, i) => `$${i + 1}`);
  const updates = cols
    .filter((c) => c !== "id")
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(", ");

  const extra = [Date.now(), markDeleted];
  const sql = `
    INSERT INTO ${table} (${cols.join(", ")}, backup_synced_at, is_deleted)
    VALUES (${placeholders.join(", ")}, $${cols.length + 1}, $${cols.length + 2})
    ON CONFLICT (id) DO UPDATE SET ${updates}, backup_synced_at = EXCLUDED.backup_synced_at, is_deleted = EXCLUDED.is_deleted
    WHERE ${table}.updated_at <= EXCLUDED.updated_at
  `;
  await client.query(sql, [...values, ...extra]);
}

export async function syncD1(pool: Pool, cfg: Config, log: (msg: string, extra?: Record<string, unknown>) => void): Promise<SyncResult> {
  if (!cfg.adminToken) throw new Error("ADMIN_TOKEN 未設定：Phase 13 需要 rescue token 才能拉 /api/backup/changes");

  const cursors = await loadCursors(pool);
  const perTable: SyncResult["perTable"] = {};
  let pages = 0;
  let created = 0;
  let updated = 0;
  let deleted = 0;
  let more = true;

  while (more) {
    if (pages >= MAX_PAGES) {
      log("warn", { reason: "max pages reached", pages });
      break;
    }
    pages += 1;

    const url = new URL(`${cfg.apiUrl}/api/backup/changes`);
    url.searchParams.set("limit", "500");
    for (const [t, c] of Object.entries(cursors)) url.searchParams.set(`c_${t}`, c);

    const res = await fetch(url, { headers: { "x-admin-token": cfg.adminToken } });
    if (!res.ok) throw new Error(`備份 API 失敗：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as ChangesResponse;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const entry of body.created) {
        await upsertRow(client, entry.table, entry.row, false);
        created += 1;
      }
      for (const entry of body.updated) {
        await upsertRow(client, entry.table, entry.row, false);
        updated += 1;
      }
      for (const entry of body.deleted) {
        await upsertRow(client, entry.table, entry.row, true);
        deleted += 1;
      }
      for (const [t, info] of Object.entries(body.tables)) {
        const [ts, id] = info.cursor.split("_");
        await client.query(
          `INSERT INTO backup_watermark (table_name, cursor, cursor_id, updated_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (table_name) DO UPDATE SET cursor = EXCLUDED.cursor, cursor_id = EXCLUDED.cursor_id, updated_at = EXCLUDED.updated_at`,
          [t, Number(ts ?? 0), Number(id ?? 0), Date.now()]
        );
        perTable[t] = { rows: info.rows, cursor: info.cursor, more: info.more };
        cursors[t] = info.cursor;
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    more = body.hasMore;
    if (more) log("page applied", { page: pages });
  }

  return { pages, created, updated, deleted, perTable, cursors };
}
