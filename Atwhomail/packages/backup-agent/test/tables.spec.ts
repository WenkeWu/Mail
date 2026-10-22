import { describe, it, expect } from "vitest";
import {
  API_BACKUP_TABLES,
  BACKUP_TABLES,
  DIRECT_TABLES,
  INTEGER_COLUMNS,
  TABLE_COLUMNS,
  cursorColumnFor,
} from "../src/tables";

const NEW_MESSAGE_COLUMNS = [
  "origin",
  "kind",
  "delivery_scope",
  "form_instance_id",
  "suspicious_form_claim",
  "sender_spf",
  "sender_dkim",
  "sender_dmarc",
];

describe("D17-1 備份涵蓋", () => {
  it("messages 納入 8 個新欄位（migration 0008）", () => {
    for (const col of NEW_MESSAGE_COLUMNS) {
      expect(TABLE_COLUMNS.messages, `messages.${col}`).toContain(col);
    }
  });

  it("三張表單表＋稽核表都有欄位定義", () => {
    for (const table of ["form_templates", "form_instances", "form_responses", "registration_audit"]) {
      expect(TABLE_COLUMNS[table], table).toBeDefined();
      expect(TABLE_COLUMNS[table]!.length, table).toBeGreaterThan(0);
    }
    expect(TABLE_COLUMNS.form_instances).toEqual([
      "id",
      "template_id",
      "message_id",
      "sender_address_id",
      "recipient_address_id",
      "status",
      "due_at",
      "created_at",
      "updated_at",
    ]);
  });

  it("BACKUP_TABLES = API 表（6）＋直讀表（4），且每張表都有欄位定義", () => {
    expect([...API_BACKUP_TABLES]).toEqual([
      "users",
      "email_addresses",
      "email_aliases",
      "messages",
      "attachments",
      "invites",
    ]);
    expect(DIRECT_TABLES).toEqual([
      "form_templates",
      "form_instances",
      "form_responses",
      "registration_audit",
    ]);
    expect(BACKUP_TABLES).toEqual([...API_BACKUP_TABLES, ...DIRECT_TABLES]);
    for (const table of BACKUP_TABLES) {
      expect(TABLE_COLUMNS[table], table).toBeDefined();
    }
  });

  it("沒有 updated_at 的表使用自己的游標欄位；其餘預設 updated_at", () => {
    expect(cursorColumnFor("form_templates")).toBe("created_at");
    expect(cursorColumnFor("registration_audit")).toBe("created_at");
    expect(cursorColumnFor("form_responses")).toBe("submitted_at");
    expect(cursorColumnFor("form_instances")).toBe("updated_at");
    expect(cursorColumnFor("messages")).toBe("updated_at");
    expect(cursorColumnFor("invites")).toBe("updated_at");
  });

  it("INTEGER_COLUMNS 涵蓋新表單／稽核的所有時間與整數欄位", () => {
    expect(INTEGER_COLUMNS.form_templates).toEqual(["id", "version", "created_at"]);
    expect(INTEGER_COLUMNS.form_responses).toEqual(["id", "instance_id", "responder_user_id", "submitted_at"]);
    expect(INTEGER_COLUMNS.registration_audit).toEqual(["id", "user_id", "address_id", "created_at"]);
    expect(INTEGER_COLUMNS.messages).toContain("form_instance_id");
    expect(INTEGER_COLUMNS.messages).toContain("suspicious_form_claim");
  });

  it("INTEGER_COLUMNS 的每個欄位都存在於 TABLE_COLUMNS", () => {
    for (const [table, cols] of Object.entries(INTEGER_COLUMNS)) {
      for (const col of cols) {
        expect(TABLE_COLUMNS[table], `${table}.${col}`).toContain(col);
      }
    }
  });
});
