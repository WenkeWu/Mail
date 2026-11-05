/**
 * T159（docs/27 §7）：`auth.atwho.org` 薄代理。
 *
 * 這裡直接呼叫 Worker 的 `fetch` handler，並以 `setAuthProxyTestHooks` 換掉上游 fetch
 * （不發出任何真實網路請求）。驗證：
 *  - 只轉 `/api/auth/*`；其他路徑（例如 `/api/mail/inbox`）回 404 且**不接觸上游**
 *  - method／headers（authorization、cookie、cf-connecting-ip、content-type）／body 保留
 *  - 加上 `X-Forwarded-Host: auth.atwho.org`
 *  - 上游 status／body 原樣回傳
 */
import { afterEach, describe, expect, it } from "vitest";
import worker, {
  AUTH_PROXY_HOST,
  UPSTREAM_ORIGIN,
  setAuthProxyTestHooks,
} from "../src/index";

interface UpstreamCall {
  url: string;
  method: string;
  headers: Headers;
  body: string | null;
}

/** 安裝上游 mock；回傳呼叫紀錄 */
function installUpstream(reply: () => Response): UpstreamCall[] {
  const calls: UpstreamCall[] = [];
  setAuthProxyTestHooks({
    fetch: async (input, init) => {
      const body = init?.body ? await new Response(init.body as BodyInit).text() : null;
      calls.push({
        url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        method: init?.method ?? "GET",
        headers: new Headers(init?.headers),
        body,
      });
      return reply();
    },
  });
  return calls;
}

afterEach(() => {
  setAuthProxyTestHooks({ fetch: null });
});

describe("T159：薄代理", () => {
  it("/api/auth/registration-mode 可通過；保留 method／headers／status／body，並加上 X-Forwarded-Host", async () => {
    const calls = installUpstream(
      () =>
        new Response(JSON.stringify({ mode: "email_verify" }), {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Upstream": "yes" },
        })
    );

    const res = await worker.fetch(
      new Request("https://auth.atwho.org/api/auth/registration-mode?x=1", {
        method: "GET",
        headers: {
          Authorization: "Bearer test-token",
          Cookie: "a=b",
          "cf-connecting-ip": "203.0.113.9",
          "user-agent": "vitest",
        },
      })
    );

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`${UPSTREAM_ORIGIN}/api/auth/registration-mode?x=1`);
    expect(call.method).toBe("GET");
    expect(call.headers.get("authorization")).toBe("Bearer test-token");
    expect(call.headers.get("cookie")).toBe("a=b");
    expect(call.headers.get("cf-connecting-ip")).toBe("203.0.113.9");
    expect(call.headers.get("user-agent")).toBe("vitest");
    expect(call.headers.get("x-forwarded-host")).toBe(AUTH_PROXY_HOST);
    expect(call.headers.get("host")).toBeNull();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("x-upstream")).toBe("yes");
    expect(await res.json()).toEqual({ mode: "email_verify" });
  });

  it("POST body 與 content-type 原樣轉發；上游 status（例如 400）原樣回傳", async () => {
    const calls = installUpstream(
      () =>
        new Response(JSON.stringify({ error: { code: "INVALID_CODE", message: "bad" } }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        })
    );

    const payload = JSON.stringify({ app_id: "mycrm", code: "abc" });
    const res = await worker.fetch(
      new Request("https://auth.atwho.org/api/auth/exchange", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer x" },
        body: payload,
      })
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers.get("content-type")).toContain("application/json");
    expect(calls[0]!.body).toBe(payload);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("INVALID_CODE");
  });

  it("/api/mail/inbox 被擋（404 NOT_FOUND），完全不呼叫上游", async () => {
    const calls = installUpstream(() => new Response("should not be called", { status: 200 }));

    const res = await worker.fetch(new Request("https://auth.atwho.org/api/mail/inbox"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: "NOT_FOUND" } });
    expect(calls).toHaveLength(0);
  });

  it("只有 /api/auth/ 前綴才轉發（/api/auth 本身與其他路徑皆 404）", async () => {
    const calls = installUpstream(() => new Response("nope", { status: 200 }));
    for (const path of ["/", "/api/auth", "/api/authx", "/api/mail/inbox"]) {
      const res = await worker.fetch(new Request(`https://auth.atwho.org${path}`));
      expect(res.status).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });

  it("上游連線失敗 → 502 UPSTREAM_UNAVAILABLE（不洩漏內部錯誤）", async () => {
    setAuthProxyTestHooks({
      fetch: async () => {
        throw new Error("network down");
      },
    });
    const res = await worker.fetch(new Request("https://auth.atwho.org/api/auth/me"));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: "UPSTREAM_UNAVAILABLE", message: "上游服務暫時無法連線" },
    });
  });
});
