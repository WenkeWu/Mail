/**
 * geo.spec.ts — D32：`GET /api/geo`（Cloudflare CF-IPCountry）
 *
 * 只作為前端國家／語言的預設；不得用於權限判定。
 * 回應必須 `Cache-Control: no-store`（國別依訪客而異）。
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../src/index";
import type { Env } from "../src/auth";

const E = env as unknown as Env;

async function get(headers: Record<string, string> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.request("/api/geo", { headers }, E, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe("D32：GET /api/geo", () => {
  it("回傳 CF-IPCountry 並禁止快取", async () => {
    const res = await get({ "cf-ipcountry": "TW" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ country: "TW" });
  });

  it("缺少／XX／T1／格式錯誤 → null", async () => {
    for (const headers of [
      {},
      { "cf-ipcountry": "XX" },
      { "cf-ipcountry": "T1" },
      { "cf-ipcountry": "TWN" },
      { "cf-ipcountry": "1A" },
    ]) {
      const res = await get(headers);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ country: null });
    }
  });

  it("小寫 header 會正規化為大寫", async () => {
    const res = await get({ "cf-ipcountry": "us" });
    expect(await res.json()).toEqual({ country: "US" });
  });
});
