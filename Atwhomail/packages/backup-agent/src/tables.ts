/**
 * tables.ts — 備份鏡像的欄位定義
 *
 * 必須與 D1 migrations（0001_init + 0003_password_changed）逐欄一致，
 * 順序不影響 upsert 正確性（以欄名對應），但保持一致可讀性較好。
 */
export const TABLE_COLUMNS: Record<string, string[]> = {
  users: ["id", "username", "display_name", "password_hash", "status", "password_changed_at", "created_at", "updated_at"],
  email_addresses: [
    "id",
    "user_id",
    "local_part",
    "domain",
    "email",
    "password_hash",
    "status",
    "password_changed_at",
    "created_at",
    "updated_at",
    "deleted_at",
  ],
  email_aliases: ["id", "alias_address", "target_email_address_id", "status", "created_at", "updated_at"],
  messages: [
    "id",
    "owner_user_id",
    "address_id",
    "folder",
    "message_id",
    "from_address",
    "to_address",
    "cc",
    "subject",
    "text_preview",
    "received_at",
    "read_at",
    "send_status",
    "raw_r2_key",
    "html_r2_key",
    "created_at",
    "updated_at",
    "deleted_at",
  ],
  attachments: [
    "id",
    "message_id",
    "filename",
    "stored_filename",
    "content_type",
    "size_bytes",
    "r2_key",
    "sha256",
    "disposition",
    "created_at",
    "updated_at",
  ],
};

export const BACKUP_TABLES = Object.keys(TABLE_COLUMNS);

/** 整數欄位（PG bigint 以字串回傳 → 還原時需轉回 number，避免 SQL 出現引號） */
export const INTEGER_COLUMNS: Record<string, string[]> = {
  users: ["id", "password_changed_at", "created_at", "updated_at"],
  email_addresses: ["id", "user_id", "password_changed_at", "created_at", "updated_at", "deleted_at"],
  email_aliases: ["id", "target_email_address_id", "created_at", "updated_at"],
  messages: [
    "id",
    "owner_user_id",
    "address_id",
    "received_at",
    "read_at",
    "created_at",
    "updated_at",
    "deleted_at",
  ],
  attachments: ["id", "message_id", "size_bytes", "created_at", "updated_at"],
};

/** PG 列 → D1 可用的值（bigint 字串轉 number、null 保持 null） */
export function toD1Row(table: string, row: Record<string, unknown>): Record<string, string | number | null> {
  const intCols = new Set(INTEGER_COLUMNS[table] ?? []);
  const out: Record<string, string | number | null> = {};
  for (const col of TABLE_COLUMNS[table] ?? []) {
    const v = row[col];
    if (v === null || v === undefined) out[col] = null;
    else if (intCols.has(col)) out[col] = Number(v);
    else out[col] = String(v);
  }
  return out;
}
