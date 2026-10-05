/**
 * mta-sts.spec.ts — MTA-STS 政策代理測試（Phase 16）
 *
 * 測試環境無外網 → 上游 fetch 失敗時應回 fallback（仍是合法政策，且 mode 可控）。
 */
import { describe, expect, it } from "vitest";
import worker, { type Env } from "../src/index";

const ENV: Env = {};

function call(path: string, env: Env = ENV): Promise<Response> {
  return worker.fetch(new Request(`https://mta-sts.atwho.org${path}`), env);
}

describe("MTA-STS 政策端點", () => {
  it("GET /.well-known/mta-sts.txt → 200 text/plain，含 version/mode/mx/max_age", async () => {
    const res = await call("/.well-known/mta-sts.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toMatch(/^version:\s*STSv1/m);
    expect(body).toMatch(/mode:\s*(testing|enforce|none)/);
    expect(body).toMatch(/mx:\s*\*\.mx\.cloudflare\.net/);
    expect(body).toMatch(/max_age:\s*\d+/);
  });

  it("預設 mode = testing（安全起步，不影響投遞）", async () => {
    const body = await (await call("/.well-known/mta-sts.txt")).text();
    expect(body).toMatch(/mode:\s*testing/);
  });

  it("MODE_OVERRIDE=enforce → 政策改為 enforce", async () => {
    const body = await (await call("/.well-known/mta-sts.txt", { MODE_OVERRIDE: "enforce" })).text();
    expect(body).toMatch(/mode:\s*enforce/);
  });

  it("其他路徑 → 404", async () => {
    expect((await call("/")).status).toBe(404);
    expect((await call("/.well-known/other.txt")).status).toBe(404);
    expect((await call("/.well-known/mta-sts.txt/extra")).status).toBe(404);
  });

  it("回應帶 Cache-Control（可被 MTA 快取）", async () => {
    const res = await call("/.well-known/mta-sts.txt");
    expect(res.headers.get("cache-control")).toContain("max-age=");
  });
});
