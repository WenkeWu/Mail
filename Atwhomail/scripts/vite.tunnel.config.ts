/**
 * Vite 設定「疊加層」——僅供 `node scripts/dev-web.mjs --tunnel` 使用。
 *
 * 為什麼需要這層：
 *   Vite dev server 內建 DNS-rebinding 保護，會拒絕 Host 標頭不是 localhost/IP 的請求，回應
 *   403 `Blocked request. This host ("mail.atwho.org") is not allowed.`
 *   經 Cloudflare Tunnel 存取時，Host 就是對外網域 → 必須把網域加進 server.allowedHosts。
 *
 * 為什麼用「疊加」而不是直接改 web/vite.config.ts：
 *   該檔目前由另一個工作流程（VS Code 的 Claude Code）負責，改它會互相踩腳。
 *   疊加層只影響 --tunnel 這條路徑，平常 `pnpm dev:web`／`node scripts/dev-web.mjs` 行為不變。
 */
import base from "../web/vite.config.ts";

const TUNNEL_HOSTS = ["mail.atwho.org", ".atwho.org"];

export default async function tunnelConfig(env: any) {
  const cfg: any = typeof base === "function" ? await base(env) : base;
  const server: any = { ...(cfg.server || {}) };
  const prev = server.allowedHosts;
  server.allowedHosts =
    prev === true
      ? true
      : [...new Set([...(Array.isArray(prev) ? prev : []), ...TUNNEL_HOSTS])];
  return { ...cfg, server };
}
