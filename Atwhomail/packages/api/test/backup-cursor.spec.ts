import { describe, it, expect } from "vitest";
import { clampLimit, formatCursor, parseCursor } from "../src/backup";

describe("備份游標（keyset updated_at_id）", () => {
  it("解析完整游標", () => {
    expect(parseCursor("1789266334643_42")).toEqual({ ts: 1789266334643, id: 42 });
  });

  it("只有時間戳時 id 預設 0", () => {
    expect(parseCursor("1789266334643")).toEqual({ ts: 1789266334643, id: 0 });
  });

  it("未提供／畸形 → 從頭開始（0,0）", () => {
    expect(parseCursor(undefined)).toEqual({ ts: 0, id: 0 });
    expect(parseCursor("")).toEqual({ ts: 0, id: 0 });
    expect(parseCursor("abc")).toEqual({ ts: 0, id: 0 });
    expect(parseCursor("1_2_3")).toEqual({ ts: 0, id: 0 });
    expect(parseCursor("-5_1")).toEqual({ ts: 0, id: 0 });
  });

  it("格式化與往返一致", () => {
    const c = { ts: 1789266334643, id: 7 };
    expect(formatCursor(c)).toBe("1789266334643_7");
    expect(parseCursor(formatCursor(c))).toEqual(c);
  });
});

describe("limit 邊界", () => {
  it("預設 500", () => expect(clampLimit(undefined)).toBe(500));
  it("非數字 → 預設", () => expect(clampLimit("abc")).toBe(500));
  it("下限 1", () => {
    expect(clampLimit("0")).toBe(1);
    expect(clampLimit("-9")).toBe(1);
  });
  it("上限 1000", () => {
    expect(clampLimit("99999")).toBe(1000);
  });
  it("區間內原樣回傳（含小數截斷）", () => {
    expect(clampLimit("250")).toBe(250);
    expect(clampLimit("12.9")).toBe(12);
  });
});
