/**
 * atwhomail-auth — D26 薄代理（docs/27 §2）
 *
 * 唯一職責：把 `https://auth.atwho.org/api/auth/*` 原樣轉給
 * `https://atwhomail-api.ulhome.workers.dev`，其他路徑一律 404。
 *
 * ⚠️ 本 Worker **不做任何認證／授權判定**（沒有 D1／secret／KV）：
 *    授權一律由 API Worker 依 session 決定。`X-Forwarded-Host` 僅供 API 記錄來源，
 *    不作為權限依據（docs/16 N3）。
 */
export const UPSTREAM_ORIGIN = "https://atwhomail-api.ulhome.workers.dev";
export const AUTH_PROXY_HOST = "auth.atwho.org";
const AUTH_PATH_PREFIX = "/api/auth/";

export interface Env {
  // 純代理：刻意沒有任何 binding／secret／var
  [key: string]: never;
}

type ProxyFetch = typeof fetch;

/** 上游 fetch（測試可覆寫；正式環境為全域 fetch） */
const defaultFetch: ProxyFetch = (input, init) => fetch(input, init);
let upstreamFetch: ProxyFetch = defaultFetch;

/** ⚠️ 僅供測試：覆寫上游 fetch（傳 `null` 還原預設） */
export function setAuthProxyTestHooks(hooks: { fetch?: ProxyFetch | null }): void {
  if (hooks.fetch !== undefined) upstreamFetch = hooks.fetch ?? defaultFetch;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // 只代理 /api/auth/*（含 query）；其餘路徑直接 404，不接觸上游
    if (!url.pathname.startsWith(AUTH_PATH_PREFIX)) {
      return json({ error: { code: "NOT_FOUND" } }, 404);
    }

    const target = new URL(url.pathname + url.search, UPSTREAM_ORIGIN);
    const headers = new Headers(request.headers);
    headers.delete("host");
    // 由本代理重新標記來源（僅記錄用，不是授權依據）
    headers.set("X-Forwarded-Host", AUTH_PROXY_HOST);
    // 讓上游回未壓縮內容，避免 response body 與 content-encoding 不一致
    headers.delete("accept-encoding");

    let upstream: Response;
    try {
      upstream = await upstreamFetch(target.toString(), {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
      });
    } catch (e) {
      console.error("[atwhomail-auth] upstream fetch failed", { path: url.pathname, error: String(e) });
      return json({ error: { code: "UPSTREAM_UNAVAILABLE", message: "上游服務暫時無法連線" } }, 502);
    }

    // 保留上游 status／headers／body；移除 hop-by-hop 與長度／編碼標頭（由 runtime 重算）
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
    responseHeaders.delete("transfer-encoding");

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  },
};
