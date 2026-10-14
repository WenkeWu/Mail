/**
 * hostname → 前端顯示模式（docs/16 D1）
 *
 * ⚠️ 這裡**只影響 UI 顯示**，絕不作為權限判定（docs/16 N3）：
 *    前端可被任何人改寫；真正的權限一律由後端依 session 的 role／scope 決定。
 *    用 hostname 只是「同一份建置服務兩個入口」時的介面收斂（mail. 在 Access 之後、app. 公開）。
 */

export type LoginMode = "admin" | "public" | "all";

/** 管理員入口（Cloudflare Access 之後；D2 完成後登入需帶 Access JWT） */
export const MAIL_HOST = "mail.atwho.org";
/** 訪客入口（公開；信箱登入＋邀請碼註冊） */
export const APP_HOST = "app.atwho.org";

/**
 * mail.atwho.org → 只顯示「管理員登入」
 * app.atwho.org  → 「信箱登入」＋「註冊」（不顯示管理員登入）
 * 其他（localhost／127.0.0.1／*.pages.dev 預覽）→ 三分頁全顯示（開發方便）
 */
export function loginModeFor(hostname: string): LoginMode {
  const host = (hostname ?? "").toLowerCase();
  if (host === MAIL_HOST) return "admin";
  if (host === APP_HOST) return "public";
  return "all";
}

/**
 * mail.atwho.org 走**同源** `/api/*`：由 Pages Function（`functions/api/[[path]].ts`）代理到
 * API Worker，並沿路轉發 Cloudflare Access 的 JWT（docs/16 D3）。
 * 其餘 hostname 維持原行為（相對路徑 → 開發由 Vite proxy、正式由建置期注入的 VITE_API_BASE）。
 *
 * ⚠️ 這只決定「請求送往哪裡」，不是權限判定（後端一律依 session 授權）。
 */
export function usesSameOriginApi(hostname: string): boolean {
  return (hostname ?? "").toLowerCase() === MAIL_HOST;
}
