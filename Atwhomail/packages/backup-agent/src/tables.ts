/**
 * tables.ts — 備份鏡像的欄位定義
 *
 * 必須與 D1 migrations（0001_init／0003／0006／0008）逐欄一致，
 * 順序不影響 upsert 正確性（以欄名對應），但保持一致可讀性較好。
 *
 * 鏡像範圍（D17，docs/17 §7.1）：
 *  - `invites`（邀請碼；不備份的話 D1 遺失後所有未用邀請碼消失）
 *  - `form_templates`／`form_instances`／`form_responses`（互動式表單定義與回覆；0008）
 *  - `registration_audit`（D17 起納入；稽核歷史只增不改，見下方 DIRECT_TABLE_CURSORS）
 *
 * 兩條取得資料的路徑：
 *  1. `API_BACKUP_TABLES`：由 `/api/backup/changes` 回傳（API 的 BACKUP_TABLES 明確列舉；
 *     **後端尚未把表單表列入該端點**，且本次不改 API 程式）。
 *  2. `DIRECT_TABLE_CURSORS`：agent 以 Cloudflare D1 REST API 唯讀直查（`cf-api.ts`），
 *     補上端點未涵蓋的表。D1 只讀、不寫 production，仍符合單向備份鐵則。
 *
 * 新增表一律以「普通欄位」處理 FK（不在本機 PG 建 FK 約束）：
 * 鏡像資料可能分批／亂序到達，本地不強制順序。
 */

/** 由備份 API（`/api/backup/changes`）回傳的表；順序 = restore 時的外鍵安全順序 */
export const API_BACKUP_TABLES = [
  "users",
  "email_addresses",
  "email_aliases",
  "messages",
  "attachments",
  "invites",
] as const;

/** 由 agent 直讀 D1 的表，以及各自的「增量游標／時間欄位」 */
export const DIRECT_TABLE_CURSORS: Record<string, string> = {
  // 不可變（建立後不再更新；D16 明定 form_templates 永不刪除）
  form_templates: "created_at",
  // 狀態會更新（open → submitted／revoked／expired）
  form_instances: "updated_at",
  // 不可變（每實例最多一筆；送出後不改）
  form_responses: "submitted_at",
  // 不可變稽核列（只新增，不更新、不刪除）
  registration_audit: "created_at",
};

export const DIRECT_TABLES = Object.keys(DIRECT_TABLE_CURSORS);

/** 全部鏡像表（API 表在前，直讀表在後 → restore 寫回 D1 時外鍵先後正確） */
export const BACKUP_TABLES: string[] = [...API_BACKUP_TABLES, ...DIRECT_TABLES];

/** 該表的增量游標時間欄位（未特別指定者為 updated_at） */
export function cursorColumnFor(table: string): string {
  return DIRECT_TABLE_CURSORS[table] ?? "updated_at";
}

export const TABLE_COLUMNS: Record<string, string[]> = {
  users: [
    "id",
    "username",
    "display_name",
    "password_hash",
    "status",
    "role", // 0006：owner / visitor
    "access_email", // 0006：Access 邊緣身分（稽核）
    "password_changed_at",
    "created_at",
    "updated_at",
  ],
  email_addresses: [
    "id",
    "user_id",
    "local_part",
    "domain",
    "email",
    "password_hash",
    "status",
    "can_send", // 0006：寄信權限（安全閥）
    "daily_send_quota", // 0006：每日配額
    "sent_today", // 0006：當日已寄
    "quota_reset_at", // 0006：配額重置時間
    "first_send_at", // 0006：首次寄信時間
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
    // 0008（D17 補備份）：分類與表單／寄件者驗證欄位
    "origin", // external / internal
    "kind", // normal / interactive_form
    "delivery_scope", // internal / external
    "form_instance_id",
    "suspicious_form_claim",
    "sender_spf",
    "sender_dkim",
    "sender_dmarc",
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
  // 0006：邀請碼（Phase 1）
  invites: [
    "id",
    "code",
    "created_by",
    "max_uses",
    "used_count",
    "expires_at",
    "note",
    "status",
    "created_at",
    "updated_at",
  ],
  // 0008：表單範本（schema 已於 API 端白名單驗證；本機只鏡像）
  form_templates: ["id", "key", "version", "schema_json", "created_at"],
  // 0008：表單實例（每個收件人一筆；FK 僅作一般欄位）
  form_instances: [
    "id",
    "template_id",
    "message_id",
    "sender_address_id",
    "recipient_address_id",
    "status",
    "due_at",
    "created_at",
    "updated_at",
  ],
  // 0008：表單回覆（每實例最多一筆）
  form_responses: ["id", "instance_id", "responder_user_id", "payload_json", "submitted_at"],
  // 0006：註冊／登入稽核（D17 納入備份；不可變、只增）
  registration_audit: [
    "id",
    "event",
    "user_id",
    "address_id",
    "access_email",
    "ip",
    "user_agent",
    "detail",
    "created_at",
  ],
};

/** 整數欄位（PG bigint 以字串回傳 → 還原時需轉回 number，避免 SQL 出現引號） */
export const INTEGER_COLUMNS: Record<string, string[]> = {
  users: ["id", "password_changed_at", "created_at", "updated_at"],
  email_addresses: [
    "id",
    "user_id",
    "can_send",
    "daily_send_quota",
    "sent_today",
    "quota_reset_at",
    "first_send_at",
    "password_changed_at",
    "created_at",
    "updated_at",
    "deleted_at",
  ],
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
    "form_instance_id",
    "suspicious_form_claim",
  ],
  attachments: ["id", "message_id", "size_bytes", "created_at", "updated_at"],
  invites: ["id", "created_by", "max_uses", "used_count", "expires_at", "created_at", "updated_at"],
  form_templates: ["id", "version", "created_at"],
  form_instances: [
    "id",
    "template_id",
    "message_id",
    "sender_address_id",
    "recipient_address_id",
    "due_at",
    "created_at",
    "updated_at",
  ],
  form_responses: ["id", "instance_id", "responder_user_id", "submitted_at"],
  registration_audit: ["id", "user_id", "address_id", "created_at"],
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
