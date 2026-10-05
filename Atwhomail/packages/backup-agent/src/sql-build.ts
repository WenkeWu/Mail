/**
 * sql-build.ts — SQL 語句建構（純函式，無 node 依賴 → 可在 workerd 測試池單元測試）
 *
 * 用於把本機 PG 鏡像還原回 D1（SQLite 方言）。
 */

export type SqlValue = string | number | boolean | null | undefined;

/** 轉為 SQL 字面值：字串以單引號包裹並將 `'` 轉義為 `''`（SQLite 標準） */
export function sqlLiteral(v: SqlValue): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "NULL";
    return String(v);
  }
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${v.replace(/'/g, "''")}'`;
}

export function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * 多列 upsert（SQLite）：
 * INSERT INTO t (cols) VALUES (..),(..) ON CONFLICT(id) DO UPDATE SET col = excluded.col ...
 */
export function buildUpsertStatement(table: string, cols: string[], rows: Record<string, SqlValue>[]): string {
  if (rows.length === 0) throw new Error("rows 不可為空");
  const values = rows
    .map((r) => `(${cols.map((c) => sqlLiteral(r[c])).join(", ")})`)
    .join(", ");
  const updates = cols
    .filter((c) => c !== "id")
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");
  return `INSERT INTO ${table} (${cols.join(", ")}) VALUES ${values} ON CONFLICT(id) DO UPDATE SET ${updates}`;
}

/** 完整快照用的 INSERT（保留原始 id；供事前備份 dump） */
export function buildInsertStatement(table: string, cols: string[], rows: Record<string, SqlValue>[]): string {
  const values = rows.map((r) => `(${cols.map((c) => sqlLiteral(r[c])).join(", ")})`).join(", ");
  return `INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES ${values}`;
}
