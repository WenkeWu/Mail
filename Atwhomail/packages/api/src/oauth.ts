/**
 * oauth.ts — D27：Google OAuth 的網路呼叫與純函式（docs/28 §2）
 *
 * 這裡只放**不碰 D1／Hono**的邏輯，讓 index.ts 的 handler 保持可讀、測試可注入。
 *
 * 安全邊界：
 *  - Google token／userinfo 一律走固定端點（不得由使用者傳入）
 *  - `redirect_uri` 固定取 `OAUTH_REDIRECT_URI`（防開放轉址；docs/28 §2.1）
 *  - `email_verified` 必須為 `true` 才接受（docs/28 §2.2）
 *  - 測試以 `setOAuthTestHooks()` 覆寫 fetch —— 不得真的打 accounts.google.com／
 *    oauth2.googleapis.com／openidconnect.googleapis.com
 */
import type { Env } from "./auth";

/** Google OAuth 授權頁（start 的 302 目標） */
export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
/** code → access_token */
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
/** OpenID Connect userinfo */
export const GOOGLE_USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

/** OAuth state cookie（docs/28 §2.1：HttpOnly／Secure／SameSite=Lax／Path=/／600 秒） */
export const OAUTH_STATE_COOKIE = "awo_state";
/** 登入完成後要導回的站內位置（HttpOnly；內容為 `{origin,path}` 的 URL-encoded JSON） */
export const OAUTH_REDIRECT_COOKIE = "awo_redirect";
export const OAUTH_COOKIE_MAX_AGE = 600;

/** 沒有可用地址的 visitor：完成 OAuth 後導回的預設前端來源 */
export const OAUTH_DEFAULT_ORIGIN = "https://app.atwho.org";

const GOOGLE_TIMEOUT_MS = 10_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

/** 可注入的 fetch（僅供測試覆寫；傳 `null` 還原預設） */
let googleFetch: FetchLike = defaultFetch;

export function setOAuthTestHooks(hooks: { fetch?: FetchLike | null }): void {
  if (hooks.fetch !== undefined) googleFetch = hooks.fetch ?? defaultFetch;
}

export interface GoogleUserInfo {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

export type GoogleExchangeResult = { ok: true; accessToken: string } | { ok: false; reason: string };

/**
 * `POST https://oauth2.googleapis.com/token`（grant_type=authorization_code）。
 * 回傳 `{ok:false}` 時只把原因寫進伺服器 log，**不得**把 Google 回應原文回給客戶端。
 */
export async function exchangeGoogleCode(env: Env, code: string): Promise<GoogleExchangeResult> {
  const body = new URLSearchParams({
    code,
    client_id: (env.GOOGLE_CLIENT_ID ?? "").trim(),
    client_secret: env.GOOGLE_CLIENT_SECRET ?? "",
    redirect_uri: (env.OAUTH_REDIRECT_URI ?? "").trim(),
    grant_type: "authorization_code",
  });
  try {
    const res = await googleFetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: `token endpoint HTTP ${res.status}` };
    const json = (await res.json()) as { access_token?: unknown };
    if (typeof json.access_token !== "string" || json.access_token.length === 0) {
      return { ok: false, reason: "token endpoint 沒有 access_token" };
    }
    return { ok: true, accessToken: json.access_token };
  } catch (e) {
    return { ok: false, reason: `token endpoint 呼叫失敗：${String(e)}` };
  }
}

/** `GET https://openidconnect.googleapis.com/v1/userinfo`（Bearer access_token） */
export async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo | null> {
  try {
    const res = await googleFetch(GOOGLE_USERINFO_ENDPOINT, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as Record<string, unknown>;
    if (typeof json.sub !== "string" || json.sub.length === 0) return null;
    return {
      sub: json.sub,
      email: typeof json.email === "string" ? json.email : undefined,
      email_verified: json.email_verified === true,
      name: typeof json.name === "string" ? json.name : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * `redirect_after` 只允許**站內相對路徑**（docs/28 §2.2）：
 *  - 必須以單一 `/` 開頭（拒絕 `//evil.com`）
 *  - 拒絕反斜線與控制字元
 *  - 以固定 base 解析後必須仍同源（含 `%2F%2F…` 等編碼變體）
 *  - 丟棄 fragment（登入結果的 fragment 由 callback 自行附加）
 * 任何不合法值 → `/`。
 */
export function safeRedirectAfter(raw: unknown): string {
  if (typeof raw !== "string") return "/";
  const value = raw.trim();
  if (!value || value.length > 2048) return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  if (value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return "/";
  try {
    const url = new URL(value, OAUTH_DEFAULT_ORIGIN);
    if (url.origin !== OAUTH_DEFAULT_ORIGIN) return "/";
    const path = `${url.pathname}${url.search}`;
    return path.startsWith("/") && !path.startsWith("//") ? path : "/";
  } catch {
    return "/";
  }
}

/**
 * 由 Google Email 推導 OAuth 首登的 ID（docs/28 §2.3）：
 * local part → 只保留英文字母（小寫）→ 截 12 字 → 空或 <3 → `user`。
 * 之後再由 `assignAvailableLocalPart()` 處理撞名／撞網域。
 */
export function oauthLocalPartFromEmail(email: string): string {
  const localPart = email.split("@")[0] ?? "";
  const letters = localPart.toLowerCase().replace(/[^a-z]/g, "").slice(0, 12);
  return letters.length >= 3 ? letters : "user";
}
