/// <reference types="@cloudflare/workers-types" />
/**
 * Pages Function — `mail.atwho.org` 的 `/api/*` 同源代理（docs/16 D3，階段 1）
 *
 * 為什麼需要它：
 *   Cloudflare Access 只保護 `mail.atwho.org` 這個**頁面**網域；Access 會在通過驗證的請求上
 *   加上 `Cf-Access-Jwt-Assertion` 標頭。前端若直連 API Worker（另一個 hostname），該標頭不會出現，
 *   階段 2 的後端驗證（D2）就永遠擋掉管理員登入。改成「前端只跟 mail.atwho.org 說話、由這裡代理到 API」
 *   → 請求帶著 Access JWT 一路到 Worker，且對瀏覽器而言是**同源**（不需要 CORS）。
 *
 * 設計約束：
 *   - 只轉發必要標頭（least privilege）：Access JWT 與認證／內容協商
 *   - 回應**原樣回傳**（狀態碼與標頭含 CORS 全部保留）
 *   - 這裡不做任何授權判斷：權限一律由 API Worker 依 session 決定（docs/16 N3）
 *   - ⚠️ 不可改為「把 Access 應用掛在 API hostname」（會弄壞 App 內 XHR 登入，docs/16 N1）
 *   - ⚠️ 訪客路徑不受影響：`app.atwho.org` 直連 API（`VITE_API_BASE`），不經過這裡（docs/16 N2）
 *
 * 部署：Pages 專案（`atwhomail-web`）會自動打包 `functions/` 目錄 → 請確認部署時 wrangler 的
 *       工作目錄是 `web/`（Pages Functions 讀取 cwd 下的 `functions/`），例如：
 *         cd web && wrangler pages deploy dist
 */

/** 上游 API Worker（與 `app.atwho.org` 直連的是同一個） */
const API_ORIGIN = "https://atwhomail-api.ulhome.workers.dev";

/** 允許轉發的請求標頭（其餘一律不轉，含 Cookie／Origin 等） */
const FORWARD_HEADERS = ["cf-access-jwt-assertion", "authorization", "content-type", "accept"] as const;

export const onRequest: PagesFunction = async ({ request }) => {
  const url = new URL(request.url);
  // 保留 `/api/` 之後的原始路徑（含既有編碼）與 query string
  const rest = url.pathname.replace(/^\/api\/?/, "");
  const target = `${API_ORIGIN}/api/${rest}${url.search}`;

  const headers = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }

  const init: RequestInit = { method: request.method, headers };
  // GET／HEAD 帶 body 會被 fetch 拒絕；其餘原樣轉送（含 POST 的 JSON、PATCH/DELETE 的空 body）
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  // 直接回傳上游回應 → 狀態碼／標頭（含 Set-Cookie、CORS、Content-Disposition）原樣保留
  return fetch(target, init);
};
