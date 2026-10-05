import { describe, it, expect } from "vitest";
import { buildInsertStatement, buildUpsertStatement, chunk, sqlLiteral } from "../src/sql-build";

describe("sqlLiteral（SQLite 轉義）", () => {
  it("單引號轉義為兩個單引號", () => {
    expect(sqlLiteral("O'Brien")).toBe("'O''Brien'");
    expect(sqlLiteral("a'b'c")).toBe("'a''b''c'");
  });
  it("常見危險字串被安全包裹", () => {
    expect(sqlLiteral("'; DROP TABLE users; --")).toBe("'''; DROP TABLE users; --'");
  });
  it("數字原樣輸出；非有限數 → NULL", () => {
    expect(sqlLiteral(1789266334643)).toBe("1789266334643");
    expect(sqlLiteral(0)).toBe("0");
    expect(sqlLiteral(Number.NaN)).toBe("NULL");
    expect(sqlLiteral(Number.POSITIVE_INFINITY)).toBe("NULL");
  });
  it("null / undefined → NULL", () => {
    expect(sqlLiteral(null)).toBe("NULL");
    expect(sqlLiteral(undefined)).toBe("NULL");
  });
  it("布林 → 1/0", () => {
    expect(sqlLiteral(true)).toBe("1");
    expect(sqlLiteral(false)).toBe("0");
  });
});

describe("chunk", () => {
  it("分批切分（餘數不滿一批）", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
  it("空陣列 → 空", () => expect(chunk([], 10)).toEqual([]));
});

describe("buildUpsertStatement", () => {
  const cols = ["id", "subject", "read_at"];

  it("多列 VALUES + ON CONFLICT(id) DO UPDATE（不含 id 自身）", () => {
    const sql = buildUpsertStatement("messages", cols, [
      { id: 1, subject: "hi", read_at: null },
      { id: 2, subject: "O'x", read_at: 123 },
    ]);
    expect(sql).toBe(
      "INSERT INTO messages (id, subject, read_at) VALUES (1, 'hi', NULL), (2, 'O''x', 123) " +
        "ON CONFLICT(id) DO UPDATE SET subject = excluded.subject, read_at = excluded.read_at"
    );
    expect(sql).not.toContain("id = excluded.id");
  });

  it("單列也能運作", () => {
    const sql = buildUpsertStatement("users", ["id", "username"], [{ id: 7, username: "owner" }]);
    expect(sql).toContain("VALUES (7, 'owner')");
    expect(sql).toContain("username = excluded.username");
  });

  it("空輸入丟錯", () => {
    expect(() => buildUpsertStatement("users", cols, [])).toThrow();
  });
});

describe("buildInsertStatement（事前快照用）", () => {
  it("INSERT OR REPLACE 保留原始 id", () => {
    const sql = buildInsertStatement("messages", ["id", "subject"], [{ id: 5, subject: "s" }]);
    expect(sql).toBe("INSERT OR REPLACE INTO messages (id, subject) VALUES (5, 's')");
  });
});
