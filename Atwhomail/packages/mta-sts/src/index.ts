/**
 * atwhomail-mta-sts — MTA-STS 政策檔代理（mta-sts.atwho.org）
 *
 * 依 Cloudflare 官方做法（docs: email-service/configuration/mta-sts）：
 *   代理 https://mta-sts.mx.cloudflare.net/.well-known/mta-sts.txt 到自家網域。
 *
 * 安全預設：MODE_OVERRIDE=testing 起步（官方警告 enforce 模式下政策設錯會拒收正常來信），
 *   觀察 TLS-RPT 報告數週後再把 wrangler.jsonc 的 vars 改成 enforce。
 */
export interface Env {
  MODE_OVERRIDE?: string; // "testing" | "enforce" | "none"
}

const UPSTREAM = "https://mta-sts.mx.cloudflare.net/.well-known/mta-sts.txt";
const FALLBACK = "version: STSv1\nmode: testing\nmx: *.mx.cloudflare.net\nmax_age: 86400\n";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/.well-known/mta-sts.txt") {
      return new Response("Not Found", { status: 404 });
    }

    let policy = FALLBACK;
    try {
      const res = await fetch(UPSTREAM);
      if (res.ok) policy = await res.text();
    } catch {
      // 上游失敗 → 用 fallback（testing 模式，不影響投遞）
    }

    const mode = env.MODE_OVERRIDE ?? "testing";
    policy = policy.replace(/mode:\s*\w+/i, `mode: ${mode}`);
    if (!/^version:/m.test(policy)) policy = FALLBACK; // 保險：內容不合法就回 fallback

    return new Response(policy, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      },
    });
  },
};
