/**
 * sync-d1.ts — D1 metadata → 本機 PostgreSQL（增量、冪等）
 *
 * 流程（09 文件 §2；D17 擴充）：
 *   1. 讀本機 backup_watermark（每表一個 keyset 游標 = `<時間欄位>_id`）
 *   2. 逐表取得增量列：
 *      a. `/api/backup/changes`（`API_BACKUP_TABLES`）——既有路徑
 *      b. Cloudflare D1 REST API 唯讀直查（`DIRECT_TABLES`）——表單表／稽核表
 *         （後端備份端點尚未涵蓋這些表，且本次不改 API 程式；D1 只讀不寫）
 *   3. 交易內 upsert（ON CONFLICT (id) DO UPDATE，且僅當游標欄位不比既有值舊）
 *   4. 更新 watermark；若該表還有下一頁立即再拉（上限保護）
 *
 * 鐵則：只讀 Production，只寫本機 PG。
 */
import { d1Query } from "./cf-api.ts";
import type { Config } from "./config.ts";
import type { Pool } from "./db.ts";
import { sqlLiteral } from "./sql-build.ts";
import {
  API_BACKUP_TABLES,
  BACKUP_TABLES,
  DIRECT_TABLES,
  TABLE_COLUMNS,
  cursorColumnFor,
} from "./tables.ts";

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

interface Cursor {
  ts: number;
  id: number;
}

export interface SyncResult {
  pages: number;
  created: number;
  updated: number;
  deleted: number;
  directRows: number;
  perTable: Record<string, { rows: number; cursor: string; more: boolean }>;
  cursors: Record<string, string>;
}

const MAX_PAGES = 100; // 保護：避免 API 端異常導致無限迴圈
const DIRECT_PAGE_SIZE = 500; // D1 REST 直查每頁列數
const PAGE_SIZE = 500; // /api/backup/changes 每表列數

export function parseCursor(raw: string | undefined | null): Cursor {
  const [tsRaw, idRaw] = (raw ?? "0_0").split("_");
  const ts = Number(tsRaw ?? 0);
  const id = Number(idRaw ?? 0);
  return { ts: Number.isFinite(ts) ? ts : 0, id: Number.isFinite(id) ? id : 0 };
}

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

/**
 * 單列表 upsert：以 (id) 衝突，僅在新的游標欄位 >= 既有值時覆蓋。
 * `cursorColumn` 對表單／稽核等沒有 updated_at 的表改用其時間欄位（見 tables.ts）。
 */
async function upsertRow(
  client: { query: (sql: string, values: unknown[]) => Promise<unknown> },
  table: string,
  row: Row,
  markDeleted: boolean,
  cursorColumn = "updated_at"
): Promise<void> {
  const cols = TABLE_COLUMNS[table];
  if (!cols) throw new Error(`未知的備份表：${table}`);
  if (!cols.includes(cursorColumn)) throw new Error(`表 ${table} 沒有游標欄位 ${cursorColumn}`);

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
    WHERE ${table}.${cursorColumn} <= EXCLUDED.${cursorColumn}
  `;
  await client.query(sql, [...values, ...extra]);
}

async function saveWatermark(
  client: { query: (sql: string, values: unknown[]) => Promise<unknown> },
  table: string,
  cursor: Cursor
): Promise<void> {
  await client.query(
    `INSERT INTO backup_watermark (table_name, cursor, cursor_id, updated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (table_name) DO UPDATE SET cursor = EXCLUDED.cursor, cursor_id = EXCLUDED.cursor_id, updated_at = EXCLUDED.updated_at`,
    [table, cursor.ts, cursor.id, Date.now()]
  );
}

/** 直讀 D1 的分頁 SQL（keyset；table／欄位名皆來自 tables.ts 常數） */
export function buildDirectPageSql(table: string, cursorColumn: string, cursor: Cursor, limit: number): string {
  return (
    `SELECT * FROM ${table} ` +
    `WHERE ${cursorColumn} > ${sqlLiteral(cursor.ts)} ` +
    `OR (${cursorColumn} = ${sqlLiteral(cursor.ts)} AND id > ${sqlLiteral(cursor.id)}) ` +
    `ORDER BY ${cursorColumn} ASC, id ASC LIMIT ${limit + 1}`
  );
}

/** 檢查直讀 D1 所需的設定（缺少時「失敗」而不是靜默漏備份） */
function assertDirectConfig(cfg: Config): string {
  const missing: string[] = [];
  if (!cfg.cfAccountId) missing.push("CF_ACCOUNT_ID");
  if (!cfg.cfApiToken) missing.push("CF_API_TOKEN（或 ~/.atwhomail-cf-token）");
  if (!cfg.d1ProdId) missing.push("D1_PROD_ID");
  if (missing.length > 0) {
    throw new Error(
      `直讀 D1 需要 ${missing.join(" / ")}（用於 ${DIRECT_TABLES.join("、")} 的備份）`
    );
  }
  return cfg.d1ProdId!;
}

export async function syncD1(pool: Pool, cfg: Config, log: (msg: string, extra?: Record<string, unknown>) => void): Promise<SyncResult> {
  if (!cfg.adminToken) throw new Error("ADMIN_TOKEN 未設定：Phase 13 需要 rescue token 才能拉 /api/backup/changes");

  const cursors = await loadCursors(pool);
  const perTable: SyncResult["perTable"] = {};
  let pages = 0;
  let created = 0;
  let updated = 0;
  let deleted = 0;
  let directRows = 0;

  // ── 1) 備份 API（既有 6 張表）──────────────────────────────────────────────
  let more = true;
  while (more) {
    if (pages >= MAX_PAGES) {
      log("warn", { reason: "max pages reached", pages });
      break;
    }
    pages += 1;

    const url = new URL(`${cfg.apiUrl}/api/backup/changes`);
    url.searchParams.set("limit", String(PAGE_SIZE));
    for (const t of API_BACKUP_TABLES) url.searchParams.set(`c_${t}`, cursors[t] ?? "0_0");

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
        const cur = parseCursor(info.cursor);
        await saveWatermark(client, t, cur);
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

  // ── 2) D1 REST 直查（表單表／稽核表；後端備份端點未涵蓋）─────────────────────
  if (DIRECT_TABLES.length > 0) {
    const databaseId = assertDirectConfig(cfg);

    for (const table of DIRECT_TABLES) {
      const tsColumn = cursorColumnFor(table);
      let cursor = parseCursor(cursors[table]);

      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const sql = buildDirectPageSql(table, tsColumn, cursor, DIRECT_PAGE_SIZE);
        const fetched = (await d1Query(cfg, databaseId, sql)) as Row[] | undefined;
        const rows = fetched ?? [];
        const hasMore = rows.length > DIRECT_PAGE_SIZE;
        const pageRows = hasMore ? rows.slice(0, DIRECT_PAGE_SIZE) : rows;
        if (pageRows.length === 0) break;

        let next = cursor;
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          for (const row of pageRows) {
            const ts = Number(row[tsColumn]);
            const id = Number(row.id);
            if (!Number.isFinite(ts) || !Number.isFinite(id)) {
              throw new Error(`D1 ${table} 回傳無效的 ${tsColumn}／id（${String(row[tsColumn])}／${String(row.id)}）`);
            }
            await upsertRow(client, table, row, false, tsColumn);
            if (Number(row.created_at ?? row[tsColumn]) > cursor.ts) created += 1;
            else updated += 1;
            directRows += 1;
            next = { ts, id };
          }
          await saveWatermark(client, table, next);
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK").catch(() => {});
          throw e;
        } finally {
          client.release();
        }

        cursor = next;
        cursors[table] = `${next.ts}_${next.id}`;
        perTable[table] = { rows: pageRows.length, cursor: cursors[table], more: hasMore };
        if (!hasMore) break;
      }
    }
  }

  return { pages, created, updated, deleted, directRows, perTable, cursors };
}
