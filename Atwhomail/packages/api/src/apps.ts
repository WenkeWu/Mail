/**
 * apps.ts — D26 App Clients／一次性授權碼的純函式（docs/27 §3–§4）
 *
 * 這裡只放**不碰 D1／Hono**的驗證與雜湊工具，讓端點 handler 保持可讀、也方便單獨測試。
 *
 * 安全邊界：
 *  - `app_secret` 與 `code` 都**只存雜湊**：SHA-256(value + JWT_SECRET)
 *  - `redirect_uris` 為 JSON 陣列，授權時以**完全相符**比對（不做前綴／正規化比對）
 *  - 不把 secret／code 寫進任何稽核或 log（docs/16 N7／N9）
 */

/** App ID 格式（docs/27 §3）：小寫英文字母開頭，之後可為小寫字母／數字／連字號，長度 2–32 */
export const APP_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

/** 一次性 code 有效期（docs/27 §4.2：60 秒） */
export const AUTH_CODE_TTL_MS = 60_000;

/** `POST /api/auth/exchange` 每分鐘上限（docs/27 §4.3） */
export const EXCHANGE_LIMIT_PER_MIN = 30;

/** 單一 App 的 redirect_uri 數量上限（防誤填／濫用；遠大於正常需求） */
export const MAX_REDIRECT_URIS = 10;

/** cryptographically secure 隨機 bytes → 小寫 hex */
export function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 → 小寫 hex（DB 只存這個值） */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * secret／code 的儲存雜湊：`SHA-256(value + JWT_SECRET)`（docs/27 §3–§4）。
 * JWT_SECRET 未設定時以空字串代替（正式環境一定會設定；與既有 `hashEmailCode` 一致）。
 */
export function hashAppSecret(value: string, jwtSecret: string | undefined): Promise<string> {
  return sha256Hex(new TextEncoder().encode(`${value}${jwtSecret ?? ""}`));
}

export type RedirectUrisResult = { ok: true; uris: string[] } | { ok: false; message: string };

/**
 * 驗證並正規化 `redirect_uris`（建立／更新 App 時使用）。
 *
 * 規則：
 *  - 必須是 1–10 個非空字串（trim 後儲存；之後所有比對都用 trim 值）
 *  - 必須是絕對網址，且為 `https:`；僅允許本機開發使用 `http://localhost`／`http://127.0.0.1`
 *  - 拒絕含帳密的網址（`https://user:pass@host/...`）——避免把憑證寫進白名單
 *
 * ⚠️ 這裡只做格式檢查；真正的安全性來自**完全相符**比對，不做網域後綴／前綴判斷。
 */
export function normalizeRedirectUris(raw: unknown): RedirectUrisResult {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, message: "redirect_uris 需為至少 1 個網址的陣列" };
  }
  if (raw.length > MAX_REDIRECT_URIS) {
    return { ok: false, message: `redirect_uris 最多 ${MAX_REDIRECT_URIS} 個` };
  }
  const uris: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return { ok: false, message: "redirect_uris 的每一項都必須是字串" };
    const value = item.trim();
    if (value.length === 0 || value.length > 2048) {
      return { ok: false, message: "redirect_uri 長度需為 1–2048" };
    }
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return { ok: false, message: `redirect_uri 不是有效網址：${value}` };
    }
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      return { ok: false, message: `redirect_uri 必須使用 https（本機開發可用 http://localhost）：${value}` };
    }
    if (url.username || url.password) {
      return { ok: false, message: "redirect_uri 不得包含帳號或密碼" };
    }
    if (!uris.includes(value)) uris.push(value);
  }
  return { ok: true, uris };
}

/** 讀取 DB 內的 redirect_uris JSON；壞資料一律視為空清單（fail closed） */
export function parseStoredRedirectUris(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/**
 * 把 code 接到 redirect_uri 上（保留既有 query 與 fragment）。
 * 例：`https://crm.example.com/cb?x=1#top` → `https://crm.example.com/cb?x=1&code=…#top`
 *     （fragment 留在最後，符合 URL 結構）
 */
export function redirectWithCode(redirectUri: string, code: string): string {
  const hashAt = redirectUri.indexOf("#");
  const base = hashAt >= 0 ? redirectUri.slice(0, hashAt) : redirectUri;
  const hash = hashAt >= 0 ? redirectUri.slice(hashAt) : "";
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}code=${encodeURIComponent(code)}${hash}`;
}
