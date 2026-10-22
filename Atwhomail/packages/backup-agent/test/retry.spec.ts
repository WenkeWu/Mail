import { describe, it, expect } from "vitest";
import { isConnectionError, summarizeError, withConnectionRetry } from "../src/retry";

describe("isConnectionError（D17-2：只重試連線類錯誤）", () => {
  it("辨識 docs/17 §7.2 列出的四種訊息", () => {
    expect(isConnectionError(new Error("Connection terminated due to connection timeout"))).toBe(true);
    expect(isConnectionError(new Error("read ECONNRESET"))).toBe(true);
    expect(isConnectionError(new Error("connect ETIMEDOUT 127.0.0.1:5432"))).toBe(true);
    expect(isConnectionError(new Error("Query read timeout"))).toBe(true);
  });

  it("Node fetch 的 cause 也納入判斷", () => {
    const cause = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    expect(isConnectionError(new Error("fetch failed", { cause }))).toBe(true);
  });

  it("非連線錯誤不重試（例如 SQL 語法錯誤）", () => {
    expect(isConnectionError(new Error('syntax error at or near "SELEC"'))).toBe(false);
    expect(isConnectionError(new Error("後端回傳 HTTP 500"))).toBe(false);
    expect(isConnectionError("未知錯誤")).toBe(false);
  });
});

describe("withConnectionRetry（D17-2）", () => {
  it("連線錯誤重試 3 次，退避 1s／2s／4s，第 4 次成功", async () => {
    const calls: number[] = [];
    const sleeps: number[] = [];
    const logs: Array<{ msg: string; extra: Record<string, unknown> }> = [];

    const result = await withConnectionRetry(
      async (attempt) => {
        calls.push(attempt);
        if (attempt < 4) throw new Error("Connection terminated due to connection timeout");
        return "ok";
      },
      {
        sleep: async (ms) => { sleeps.push(ms); },
        log: (msg, extra) => logs.push({ msg, extra: extra ?? {} }),
      }
    );

    expect(result).toBe("ok");
    expect(calls).toEqual([1, 2, 3, 4]);
    expect(sleeps).toEqual([1000, 2000, 4000]);
    expect(logs).toHaveLength(3);
    expect(logs.map((l) => l.extra.attempt)).toEqual([1, 2, 3]);
    expect(logs.map((l) => l.extra.delayMs)).toEqual([1000, 2000, 4000]);
    expect(logs[0]!.msg).toContain("retrying");
    expect(String(logs[0]!.extra.error)).toContain("Connection terminated");
  });

  it("全數失敗才拋出（最多 4 次，不無限重試）", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    await expect(
      withConnectionRetry(
        async () => {
          calls += 1;
          throw new Error("ECONNRESET");
        },
        { sleep: async (ms) => { sleeps.push(ms); } }
      )
    ).rejects.toThrow("ECONNRESET");

    expect(calls).toBe(4);
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  it("非連線錯誤立即拋出：不等待、不重試", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const logs: unknown[] = [];
    await expect(
      withConnectionRetry(
        async () => {
          calls += 1;
          throw new Error('SQLITE_ERROR: near "SELEC": syntax error');
        },
        { sleep: async (ms) => { sleeps.push(ms); }, log: (msg, extra) => logs.push([msg, extra]) }
      )
    ).rejects.toThrow("syntax error");

    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("可自訂重試次數（0 = 只嘗試一次）", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    await expect(
      withConnectionRetry(
        async () => {
          calls += 1;
          throw new Error("timeout");
        },
        { retries: 0, sleep: async (ms) => { sleeps.push(ms); } }
      )
    ).rejects.toThrow("timeout");
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("summarizeError 壓縮空白並截斷，避免日誌爆量", () => {
    const text = summarizeError(new Error(`a\n\n  b ${"x".repeat(400)}`), 40);
    expect(text.length).toBeLessThanOrEqual(41);
    expect(text).not.toContain("\n");
    expect(text.startsWith("a b ")).toBe(true);
  });
});
