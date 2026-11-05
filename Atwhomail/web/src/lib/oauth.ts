/**
 * oauth.ts — D27 前端：Google OAuth 起始網址 ＋ callback fragment 解析（docs/28 §6）
 *
 * - 登入按鈕一律導向 **auth.atwho.org** 的 start 端點（薄代理 → API Worker）
 * - callback 由 API 以 `#oauth_token=…` 導回；token 只放在 fragment（不會送到伺服器／Referer）
 * - 讀取後立即以 history.replaceState 清除，避免 token 留在網址列
 */
import type { Session } from "../api/types";

/** 固定入口（docs/28 §6.1：透過 auth.atwho.org） */
export const GOOGLE_OAUTH_START_URL = "https://auth.atwho.org/api/auth/oauth/google/start";

/** 目前路徑（含 query）作為登入後導回位置；後端只接受站內相對路徑 */
export function buildGoogleStartUrl(redirectAfter: string): string {
  const params = new URLSearchParams({ redirect_after: redirectAfter || "/" });
  return `${GOOGLE_OAUTH_START_URL}?${params.toString()}`;
}

/**
 * 解析 `#oauth_token=…&oauth_session=…`。
 * 只接受 owner／mailbox 兩種（OAuth 首登一定配發地址；無地址的 user scope 不會出現在前端）。
 * 任何缺欄位／格式錯誤 → null（不儲存半殘 session）。
 */
export function parseOAuthFragment(hash: string): Session | null {
  if (!hash) return null;
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const token = params.get("oauth_token");
  const kind = params.get("oauth_session");
  if (!token || !kind) return null;

  if (kind === "owner") {
    const userId = Number(params.get("oauth_user_id"));
    const username = params.get("oauth_username");
    if (!Number.isInteger(userId) || userId <= 0 || !username) return null;
    return { kind: "owner", token, userId, username };
  }
  if (kind === "mailbox") {
    const addressId = Number(params.get("oauth_address_id"));
    const email = params.get("oauth_email");
    if (!Number.isInteger(addressId) || addressId <= 0 || !email) return null;
    return { kind: "mailbox", token, addressId, email };
  }
  return null;
}

/** 讀取 fragment 中的 session；成功時立即清除 fragment（token 不留在網址列） */
export function takeOAuthSession(win: {
  location: { hash: string; pathname: string; search: string };
  history: { replaceState: (data: unknown, unused: string, url?: string) => void };
}): Session | null {
  const session = parseOAuthFragment(win.location.hash);
  if (!session) return null;
  try {
    win.history.replaceState(null, "", `${win.location.pathname}${win.location.search}`);
  } catch {
    /* 清除失敗不阻擋登入（token 仍可用） */
  }
  return session;
}

/** `?reset=<token>`（忘記密碼連結）；空字串視為沒有 */
export function getResetToken(search: string): string | null {
  const token = new URLSearchParams(search).get("reset");
  return token && token.trim() !== "" ? token.trim() : null;
}
