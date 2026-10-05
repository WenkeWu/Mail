/**
 * backup.ts — 增量備份游標工具（Phase 13，09 文件 §2.1）
 *
 * 為何用「每表各自一個游標」而非單一全域 cursor？
 *  - 五張表資料量不同，單一游標會被最慢的表拖住（或需跨表取最小值，邏輯脆弱）
 *  - 本機 PG 的 `backup_watermark(table_name, cursor)` 本來就是每表一列（09 §4）
 *  - 游標格式 `updated_at_id`（keyset）→ 同毫秒多列也不會漏（09 §2.2）
 */
export const BACKUP_TABLES = ["users", "email_addresses", "email_aliases", "messages", "attachments"] as const;
export type BackupTable = (typeof BACKUP_TABLES)[number];

export interface Cursor {
  ts: number;
  id: number;
}

export function parseCursor(raw: string | undefined): Cursor {
  if (!raw) return { ts: 0, id: 0 };
  const m = /^(\d+)(?:_(\d+))?$/.exec(raw.trim());
  if (!m) return { ts: 0, id: 0 };
  return { ts: Number(m[1]), id: m[2] ? Number(m[2]) : 0 };
}

export function formatCursor(c: Cursor): string {
  return `${c.ts}_${c.id}`;
}

export function clampLimit(raw: string | undefined, def = 500): number {
  const n = Number(raw ?? def);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(Math.trunc(n), 1), 1000);
}
