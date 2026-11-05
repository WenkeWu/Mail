/**
 * auth.ts — Model C 認證核心（Phase 11）
 *
 * - 密碼：argon2id（hash-wasm，WASM 於 Workers 內執行）
 * - Session：JWT HS256（hono/jwt），payload：
 *     owner   → { scope: "owner",   sub: <users.id>,        exp }
 *     mailbox → { scope: "mailbox", sub: <email_addresses.id>, email, exp }
 * - 登入鎖定：D1 auth_attempts（連續 5 次失敗 → 鎖 15 分鐘）
 * - 救援通道：ADMIN_TOKEN（保留，僅 owner 權限；Phase 11 後不再用於日常操作）
 */
import { sign, verify } from "hono/jwt";
import type { Context, MiddlewareHandler } from "hono";
import { argon2idAsync } from "@noble/hashes/argon2.js";

/** PHC 風格編碼：$argon2id$v=19$m=19456,t=3,p=1$<saltB64>$<hashB64> */
const ARGON2 = { t: 3, m: 19456, p: 1, dkLen: 32 } as const;

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface Env {
  DB: D1Database;
  MAIL: R2Bucket;
  EMAIL: SendEmail;
  ADMIN_TOKEN?: string;
  JWT_SECRET?: string;
  /** CORS 白名單（逗號分隔來源；`*` = 允許任何來源）。2026-10-06 加入，供外部 App 呼叫。 */
  ALLOWED_ORIGINS?: string;
  /** Cloudflare Access 團隊網域（D2）。例：`steep-queen-06be.cloudflareaccess.com`（非機密，放 vars） */
  ACCESS_TEAM_DOMAIN?: string;
  /**
   * `mail.atwho.org` Access 應用的 Audience（D2；非機密，放 vars）。
   * ⚠️ 未設定／空字串 → 進入**過渡放行**模式（僅警告），見 verifyAccessJwt 與 docs/16 §5（回退閥門）。
   */
  ACCESS_MAIL_AUD?: string;
  /**
   * 註冊模式（D21，docs/21 §4）：`invite`（預設，既有邀請碼流程）｜`email_verify`｜`closed`。
   * 未設定／非法值 → 一律視為 `invite`（部署後由 owner 切換；回退只需改回此行）。
   */
  REGISTRATION_MODE?: string;
  /**
   * 舊版全站註冊開關（docs/05 §2.7）：`true` = 關閉註冊。
   * D21 起保留相容（既有 invite 流程行為不變）；新流程／前端設定端點一併視為 `closed`。
   */
  REGISTRATION_DISABLED?: string;
  /**
   * D23（docs/23）：Cloudflare Turnstile **site key**（公開、非機密；放 `vars`）。
   * 未設定／空字串 → 前端不載入腳本、不顯示 widget（行為同 D21）。
   */
  TURNSTILE_SITE_KEY?: string;
  /**
   * D23：Cloudflare Turnstile **secret key**（機密；`wrangler secret put TURNSTILE_SECRET_KEY`）。
   * 未設定／空字串 → `register-request` 跳過 siteverify（只記一次 warning；回退用）。
   */
  TURNSTILE_SECRET_KEY?: string;
  /** D27（docs/28）：Google OAuth client_id（非機密；放 vars） */
  GOOGLE_CLIENT_ID?: string;
  /** D27：Google OAuth client_secret（機密；`wrangler secret put GOOGLE_CLIENT_SECRET`） */
  GOOGLE_CLIENT_SECRET?: string;
  /** D27：固定 redirect URI（非機密；放 vars；不得接受請求傳入的值） */
  OAUTH_REDIRECT_URI?: string;
}

export type Scope =
  | { kind: "owner"; userId: number; via: "jwt" | "rescue" }
  | { kind: "mailbox"; addressId: number; email: string }
  /**
   * D26（docs/27 §4.5）：第三方 App 的使用者層級 token。
   * `userId` 來自 `sub`；`appId` 來自 `aud`（簽發時為 app_clients.app_id）。
   * ⚠️ 此 scope **不得**用於 `/api/mail/*` → `requireMailSession` 一律 403 `SCOPE_NOT_ALLOWED`
   *    （`requireSession` 僅用於 `/api/auth/me` 等身分查詢端點）。
   */
  | { kind: "app"; userId: number; appId: string };

export type AuthEnv = { Bindings: Env; Variables: { scope: Scope } };

/** session = scope + 簽發時間（iat，秒）+ 簽發時的密碼版本（pca，毫秒）。rescue 不檢查。 */
type SessionInfo = { scope: Scope; iat: number; pca: number };

const JWT_TTL_SEC = 24 * 60 * 60; // 24h
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;

// ───────────────────────── 密碼 ─────────────────────────
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await argon2idAsync(password, salt, { ...ARGON2, maxmem: 64 * 1024 * 1024 });
  return `$argon2id$v=19$m=${ARGON2.m},t=${ARGON2.t},p=${ARGON2.p}$${toB64(salt)}$${toB64(hash)}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  try {
    const parts = encoded.split("$");
    // ["", "argon2id", "v=19", "m=...,t=...,p=...", saltB64, hashB64]
    if (parts.length !== 6 || parts[1] !== "argon2id") return false;
    const params = Object.fromEntries(parts[3]!.split(",").map((kv) => kv.split("=") as [string, string]));
    const salt = fromB64(parts[4]!);
    const expected = fromB64(parts[5]!);
    const actual = await argon2idAsync(password, salt, {
      t: Number(params.t ?? ARGON2.t),
      m: Number(params.m ?? ARGON2.m),
      p: Number(params.p ?? ARGON2.p),
      dkLen: expected.length,
      maxmem: 64 * 1024 * 1024,
    });
    // 常數時間比較
    if (actual.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < actual.length; i++) diff |= actual[i]! ^ expected[i]!;
    return diff === 0;
  } catch {
    return false;
  }
}

export function validatePasswordPolicy(pw: string): string | null {
  if (typeof pw !== "string") return "密碼格式錯誤";
  if (pw.length < 8) return "密碼至少 8 個字元";
  if (pw.length > 128) return "密碼過長（≤128）";
  return null;
}

/**
 * D27（docs/28）：此帳號是否**有可用密碼**。
 *
 * `users.password_hash` 在 0001 是 `TEXT NOT NULL`（SQLite 無法以 ALTER 放寬），
 * 所以純 OAuth 帳號以空字串儲存；這裡把 `NULL`／空字串一律視為「未設定密碼」。
 * 呼叫端（user-login／owner-password 等）不得直接以 truthy 判斷。
 */
export function hasPassword(hash: string | null | undefined): hash is string {
  return typeof hash === "string" && hash.length > 0;
}

// ───────────────────────── JWT ─────────────────────────
/**
 * JWT 附帶 `pca`（簽發當下的 password_changed_at，毫秒）= **token 版本**。
 * 驗證時比對 DB 現值：`pca >= current` 才有效。
 * 為何不用 iat？iat 為秒精度，同一秒內改密碼再登入會被誤判為過期（曾為真實 bug）。
 */
export async function signOwnerToken(env: Env, userId: number, pca: number): Promise<string> {
  if (!env.JWT_SECRET) throw new Error("JWT_SECRET not configured");
  const iat = Math.floor(Date.now() / 1000);
  return sign({ scope: "owner", sub: userId, pca, iat, exp: iat + JWT_TTL_SEC }, env.JWT_SECRET, "HS256");
}

export async function signMailboxToken(env: Env, addressId: number, email: string, pca: number): Promise<string> {
  if (!env.JWT_SECRET) throw new Error("JWT_SECRET not configured");
  const iat = Math.floor(Date.now() / 1000);
  return sign({ scope: "mailbox", sub: addressId, email, pca, iat, exp: iat + JWT_TTL_SEC }, env.JWT_SECRET, "HS256");
}

/**
 * D26（docs/27 §4.3）：App token — `{ scope:'app', aud:app_id, sub:user_id, username, role, pca, iat, exp }`。
 *
 * - `aud` 固定為 `app_clients.app_id`（其他 App 可用來確認 token 是發給自己的）
 * - `sub` 是 **users.id**（不是 email_addresses.id）→ `/api/auth/me` 直接查 users
 * - TTL 與既有 owner／mailbox token 相同（`JWT_TTL_SEC`）
 * - 仍附帶 `pca`（密碼版本）：密碼變更後舊 App token 立即失效（與既有 session 語意一致）
 */
export async function signAppToken(
  env: Env,
  input: { userId: number; appId: string; username: string; role: string; pca: number }
): Promise<string> {
  if (!env.JWT_SECRET) throw new Error("JWT_SECRET not configured");
  const iat = Math.floor(Date.now() / 1000);
  return sign(
    {
      scope: "app",
      aud: input.appId,
      sub: input.userId,
      username: input.username,
      role: input.role,
      pca: input.pca,
      iat,
      exp: iat + JWT_TTL_SEC,
    },
    env.JWT_SECRET,
    "HS256"
  );
}

async function parseBearer(env: Env, token: string): Promise<SessionInfo | null> {
  if (!env.JWT_SECRET) return null;
  try {
    const p = (await verify(token, env.JWT_SECRET, "HS256")) as {
      scope?: string;
      sub?: number;
      email?: string;
      aud?: unknown;
      iat?: number;
      pca?: number;
    };
    const iat = typeof p.iat === "number" ? p.iat : 0;
    // 舊版 owner／mailbox token 一定帶 pca；缺漏視為 -1（立即失效）。
    // ⚠️ App token 的文件範例（docs/27 §4.3）未列 pca；缺漏時視為 0（= 從未改密碼），
    //    若使用者之後改過密碼（DB pca > 0）仍會因版本落後而失效。
    const pca = typeof p.pca === "number" ? p.pca : p.scope === "app" ? 0 : -1;
    if (p.scope === "owner" && typeof p.sub === "number") {
      return { scope: { kind: "owner", userId: p.sub, via: "jwt" }, iat, pca };
    }
    if (p.scope === "mailbox" && typeof p.sub === "number" && typeof p.email === "string") {
      return { scope: { kind: "mailbox", addressId: p.sub, email: p.email }, iat, pca };
    }
    if (p.scope === "app" && typeof p.sub === "number" && typeof p.aud === "string") {
      return { scope: { kind: "app", userId: p.sub, appId: p.aud }, iat, pca };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * session 目標的現況：token 版本（`pca`）＋ 帳號／地址狀態（D8-4）。
 *
 * 為什麼合成**一次**查詢：`requireSession` 同時需要「token 是否新鮮」與「帳號／地址是否仍為
 * active」。分成兩次查詢＝每個請求多打一次 D1（且是熱路徑上的每一個請求）。合併後仍是
 * **單一主鍵查詢**（`users.id` / `email_addresses.id`），符合 docs/16 §3 D8-4 的限制。
 *
 * 查無資料列 → `null`（目標已不存在）→ 呼叫端**一律視為 session 失效**（D10，見 `loadLiveState`）。
 */
type SessionState = { pca: number; userStatus: string | null; addressStatus: string | null };

/** 401 TOKEN_STALE 的兩種原因（D10：查不到列與密碼已變更語意不同，訊息必須能分辨） */
const STALE_NOT_FOUND = "session 已失效，請重新登入";
const STALE_PASSWORD_CHANGED = "session 已失效（密碼已變更），請重新登入";

async function loadSessionState(env: Env, scope: Scope): Promise<SessionState | null> {
  // owner 與 app 都是「使用者層級」（sub = users.id）；app 沒有 address_id
  if (scope.kind === "owner" || scope.kind === "app") {
    const row = await env.DB.prepare("SELECT password_changed_at AS pca, status AS user_status FROM users WHERE id = ?1")
      .bind(scope.userId)
      .first<{ pca: number | null; user_status: string | null }>();
    return row ? { pca: Number(row.pca ?? 0), userStatus: row.user_status, addressStatus: null } : null;
  }
  // mailbox：一次 JOIN 同時取得地址狀態與**所屬使用者**狀態（停權是帳號層、停用是地址層）
  const row = await env.DB.prepare(
    `SELECT a.password_changed_at AS pca, a.status AS address_status, u.status AS user_status
     FROM email_addresses a JOIN users u ON u.id = a.user_id
     WHERE a.id = ?1`
  )
    .bind(scope.addressId)
    .first<{ pca: number | null; address_status: string | null; user_status: string | null }>();
  return row ? { pca: Number(row.pca ?? 0), userStatus: row.user_status, addressStatus: row.address_status } : null;
}

/**
 * 載入 session 目標現況，並在同處判定「token 是否仍有效」。
 *
 * 回傳 `SessionState` = 有效（呼叫端可續用狀態欄位）；回傳 `Response` = 直接回 401 `TOKEN_STALE`。
 * 兩種失效原因：
 *   1. **查不到列**（`loadSessionState` 回 `null`）——目標已不存在（例：owner 刪除訪客後，D9）
 *   2. token 版本落後（`pca` < DB 現值）——密碼已變更（08 #44）
 *
 * ⚠️ **D10（docs/16 §3）**：舊版以 `state?.pca ?? 0` 判定，查不到列時等同「版本 0」而**放行**；
 *    地址已被刪除的舊 JWT 因此可繼續通行。現在查不到列即失效，且必須是**明確的 401**
 *    （不得因為查不到列而拋錯變成 500）。
 * ⚠️ rescue（`x-admin-token`）不走這裡（N5）：呼叫端自行豁免，緊急救援通道語意不變。
 */
async function loadLiveState(c: Context<AuthEnv>, s: SessionInfo): Promise<SessionState | Response> {
  const state = await loadSessionState(c.env, s.scope);
  if (!state) return c.json({ error: { code: "TOKEN_STALE", message: STALE_NOT_FOUND } }, 401);
  if (s.pca < state.pca) {
    return c.json({ error: { code: "TOKEN_STALE", message: STALE_PASSWORD_CHANGED } }, 401);
  }
  return state;
}

// ───────────────────────── Cloudflare Access JWT（D2，docs/16 §3）─────────────────────────
/**
 * `/api/auth/login`（管理員登入）必須帶有效的 Cloudflare Access JWT。
 *
 * 為什麼：Access 只保護 `mail.atwho.org` 這個**頁面**網域，而管理憑證的發放點在公開的 API 上。
 * 由 Pages Function（`web/functions/api/[[path]].ts`）把 Access 加在請求上的
 * `Cf-Access-Jwt-Assertion` 沿路轉發到 Worker，這裡驗簽 → 只有真的從 `mail.*`（通過 Access）
 * 進來的請求能登入；`curl` 直打 API 或從 `app.atwho.org` 都會被擋（docs/16 §5 階段 2）。
 *
 * ⚠️ **過渡／回退**：`ACCESS_MAIL_AUD` 未設定或為空字串時 → 只記 warning 並**放行**。
 *    這是刻意保留的回退閥門（移除環境變數即恢復舊行為），**不是**長期設計；設定後即生效驗證。
 */

const ACCESS_JWKS_TTL_MS = 10 * 60 * 1000; // 公鑰快取 10 分鐘（Access 金鑰輪替頻率低）
const ACCESS_JWKS_TIMEOUT_MS = 5000;

/** 預設 JWKS 取得：帶逾時；失敗丟錯（呼叫端轉為 403，fail-closed） */
const defaultFetchJwks = async (url: string): Promise<unknown> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(ACCESS_JWKS_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`JWKS HTTP ${res.status}`);
  return (await res.json()) as unknown;
};
const defaultNowMs = () => Date.now();

/** 可注入（測試會覆寫）：JWKS 取得與時間來源 */
let fetchJwks: (url: string) => Promise<unknown> = defaultFetchJwks;
let nowMs: () => number = defaultNowMs;

/** JWKS 快取（模組層記憶體；僅在成功取得後寫入） */
let jwksCache: { url: string; keys: Map<string, JsonWebKey>; fetchedAt: number } | null = null;

/**
 * ⚠️ 僅供測試：覆寫 JWKS 取得與時間來源（傳 `null` 還原預設），並清掉 JWKS 快取避免跨案例污染。
 * 例：`setAccessJwtTestHooks({ fetchJwks: async () => ({ keys: [publicJwk] }), nowMs: () => 0 })`
 */
export function setAccessJwtTestHooks(hooks: {
  fetchJwks?: ((url: string) => Promise<unknown>) | null;
  nowMs?: (() => number) | null;
}): void {
  if (hooks.fetchJwks !== undefined) fetchJwks = hooks.fetchJwks ?? defaultFetchJwks;
  if (hooks.nowMs !== undefined) nowMs = hooks.nowMs ?? defaultNowMs;
  jwksCache = null;
}

/** base64url → bytes（JWT 各段都是 base64url，無 padding） */
function b64urlToBytes(input: string): Uint8Array {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 取 JWKS 公鑰（`kid` → JWK）；快取有效期內不重抓 */
async function getAccessKeys(domain: string): Promise<Map<string, JsonWebKey>> {
  const url = `https://${domain}/cdn-cgi/access/certs`;
  if (jwksCache && jwksCache.url === url && nowMs() - jwksCache.fetchedAt < ACCESS_JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const body = (await fetchJwks(url)) as { keys?: Array<JsonWebKey & { kid?: string }> } | null;
  const keys = new Map<string, JsonWebKey>();
  for (const k of body?.keys ?? []) {
    if (typeof k?.kid === "string" && k.kid) keys.set(k.kid, k);
  }
  if (keys.size === 0) throw new Error("JWKS 沒有可用的金鑰");
  jwksCache = { url, keys, fetchedAt: nowMs() };
  return keys;
}

export type AccessJwtResult = { ok: true } | { ok: false; reason: string };

/**
 * 驗證 Cloudflare Access JWT（RS256）。
 * - 成功 → `{ ok: true }`
 * - 失敗 → `{ ok: false, reason }`（reason 只寫進伺服器 log，**不回給客戶端**，避免洩漏細節）
 * 註：`aud` 在 Access 的 token 可能是字串或陣列，兩種都支援。
 */
export async function verifyAccessJwt(env: Env, token: string): Promise<AccessJwtResult> {
  const domain = (env.ACCESS_TEAM_DOMAIN ?? "").trim();
  const aud = (env.ACCESS_MAIL_AUD ?? "").trim();
  // 呼叫端應先處理「aud 未設定＝過渡放行」；這裡仍以防禦性回錯處理（fail-closed）
  if (!domain) return { ok: false, reason: "ACCESS_TEAM_DOMAIN 未設定" };
  if (!aud) return { ok: false, reason: "ACCESS_MAIL_AUD 未設定（呼叫端應走過渡放行）" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "JWT 格式錯誤" };
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  let header: { alg?: string; kid?: string };
  let payload: { iss?: string; aud?: string | string[]; exp?: number };
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(headerB64))) as typeof header;
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(payloadB64))) as typeof payload;
  } catch {
    return { ok: false, reason: "JWT 解析失敗" };
  }
  if (header.alg !== "RS256") return { ok: false, reason: `不支援的 alg: ${String(header.alg)}` };
  if (!header.kid) return { ok: false, reason: "JWT 缺少 kid" };

  let jwk: JsonWebKey | undefined;
  try {
    jwk = (await getAccessKeys(domain)).get(header.kid);
  } catch (e) {
    return { ok: false, reason: `JWKS 取得失敗：${String(e)}` };
  }
  if (!jwk) return { ok: false, reason: "JWKS 找不到對應的 kid（金鑰可能已輪替）" };

  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlToBytes(sigB64),
      new TextEncoder().encode(`${headerB64}.${payloadB64}`)
    );
    if (!ok) return { ok: false, reason: "簽章驗證失敗" };
  } catch (e) {
    return { ok: false, reason: `簽章驗證錯誤：${String(e)}` };
  }

  // claims
  const nowSec = Math.floor(nowMs() / 1000);
  if (typeof payload.exp !== "number" || payload.exp <= nowSec) return { ok: false, reason: "JWT 已過期" };
  if (payload.iss !== `https://${domain}`) return { ok: false, reason: "iss 不符" };
  const audOk = Array.isArray(payload.aud) ? payload.aud.includes(aud) : payload.aud === aud;
  if (!audOk) return { ok: false, reason: "aud 不符" };

  return { ok: true };
}

// ───────────────────────── 登入鎖定 ─────────────────────────
export async function checkLocked(db: D1Database, key: string): Promise<number> {
  const row = await db
    .prepare("SELECT locked_until FROM auth_attempts WHERE key = ?1")
    .bind(key)
    .first<{ locked_until: number }>();
  const until = row?.locked_until ?? 0;
  return until > Date.now() ? until : 0;
}

export async function recordFailure(db: D1Database, key: string): Promise<void> {
  const ts = Date.now();
  const row = await db
    .prepare("SELECT fail_count FROM auth_attempts WHERE key = ?1")
    .bind(key)
    .first<{ fail_count: number }>();
  const fails = (row?.fail_count ?? 0) + 1;
  const lockedUntil = fails >= MAX_FAILS ? ts + LOCK_MS : 0;
  await db
    .prepare(
      `INSERT INTO auth_attempts (key, fail_count, locked_until, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(key) DO UPDATE SET fail_count = ?2, locked_until = ?3, updated_at = ?4`
    )
    .bind(key, fails, lockedUntil, ts)
    .run();
}

export async function clearFailures(db: D1Database, key: string): Promise<void> {
  await db.prepare("DELETE FROM auth_attempts WHERE key = ?1").bind(key).run();
}

// ───────────────────────── 中介層 ─────────────────────────
/**
 * 找出 owner 的 user id —— **以角色查找，不依賴帳號名稱**（D11，docs/14 §4.7）。
 *
 * 為何不能寫死 `username = 'owner'`：owner 一改名，救援通道（x-admin-token）與所有
 * owner 範圍端點會同時失效。改為：
 *   1. 先查 `role = 'owner'`（0006 起有 role 欄位）
 *   2. 查不到（或舊 schema 還沒有 role 欄位）→ **回退** `username = 'owner'`（相容過渡）
 * 注意：`/api/auth/login` 不受影響——它仍以使用者輸入的 username 查找。
 */
export async function findOwnerId(db: D1Database): Promise<number | null> {
  try {
    const byRole = await db.prepare("SELECT id FROM users WHERE role = 'owner' LIMIT 1").first<{ id: number }>();
    if (byRole) return byRole.id;
  } catch {
    // role 欄位不存在（migration 0006 尚未套用）→ 走下方回退
  }
  const byName = await db.prepare("SELECT id FROM users WHERE username = 'owner' LIMIT 1").first<{ id: number }>();
  return byName ? byName.id : null;
}

async function rescueScope(env: Env, provided: string): Promise<SessionInfo | null> {
  const token = env.ADMIN_TOKEN;
  if (!token) return null;
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(token);
  if (a.length !== b.length) return null;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  if (diff !== 0) return null;
  const ownerId = await findOwnerId(env.DB);
  return ownerId !== null
    ? { scope: { kind: "owner", userId: ownerId, via: "rescue" }, iat: Math.floor(Date.now() / 1000), pca: Number.MAX_SAFE_INTEGER }
    : null;
}

/** 解析 session：Bearer JWT（owner/mailbox）或 x-admin-token rescue。無 session → null */
export async function resolveSession(c: {
  req: { header: (n: string) => string | undefined };
  env: Env;
}): Promise<SessionInfo | null> {
  const rescue = c.req.header("x-admin-token");
  if (rescue) {
    const s = await rescueScope(c.env, rescue);
    if (s) return s;
  }
  const auth = c.req.header("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    return parseBearer(c.env, auth.slice(7).trim());
  }
  return null;
}

/** 舊介面（僅回 scope） */
export async function resolveScope(c: { req: { header: (n: string) => string | undefined }; env: Env }): Promise<Scope | null> {
  const s = await resolveSession(c);
  return s ? s.scope : null;
}

/** owner 權限（JWT owner 或 rescue）；含 token 新鮮度與存在性檢查（D10） */
export const requireOwner: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const s = await resolveSession(c);
  if (!s) return c.json({ error: { code: "UNAUTHORIZED", message: "needs owner session or rescue token" } }, 401);
  if (s.scope.kind !== "owner") return c.json({ error: { code: "FORBIDDEN", message: "owner scope required" } }, 403);
  // ⚠️ rescue（x-admin-token）豁免（N5）：緊急救援通道不因查不到列或密碼版本而失效
  if (s.scope.via !== "rescue") {
    const state = await loadLiveState(c, s);
    if (state instanceof Response) return state; // 401 TOKEN_STALE（查不到列／密碼已變更）
  }
  c.set("scope", s.scope);
  await next();
};

/**
 * session 後段檢查（`requireSession`／`requireMailSession` 共用）。
 *
 * **D8-4（docs/16 §3）：停權／停用必須立即生效。**
 *   - 使用者（`users.status`）必須為 `active` → 否則 `403 ACCOUNT_SUSPENDED`
 *   - mailbox session 的地址（`email_addresses.status`）亦必須為 `active` → 否則 `403 ADDRESS_DISABLED`
 * **D10（docs/16 §3）：查不到列即失效。** → `401 TOKEN_STALE`（不是 500，也不是放行）。
 * ⚠️ rescue（`x-admin-token`）不受影響（N5）：救援通道語意不變。
 */
async function enforceSessionState(c: Context<AuthEnv>, s: SessionInfo): Promise<Response | null> {
  if (s.scope.kind === "owner" && s.scope.via === "rescue") return null;
  const state = await loadLiveState(c, s);
  if (state instanceof Response) return state; // 401 TOKEN_STALE（查不到列／密碼已變更）
  if (state.userStatus !== "active") {
    return c.json({ error: { code: "ACCOUNT_SUSPENDED", message: "此帳號已停權，請聯絡管理者" } }, 403);
  }
  // 地址狀態只對 mailbox session 有意義（owner／app session 沒有 addressId）
  if (s.scope.kind === "mailbox" && state.addressStatus !== "active") {
    return c.json({ error: { code: "ADDRESS_DISABLED", message: "此地址已停用，請聯絡管理者" } }, 403);
  }
  return null;
}

/**
 * 需登入（owner、mailbox 或 app）─ 身分類端點用（例如 `GET /api/auth/me`）。
 *
 * D26（docs/27 §4.5）：接受 `scope='app'`，驗簽後視為使用者層級。
 * ⚠️ 信件類端點請用 `requireMailSession`（app token 一律 403 `SCOPE_NOT_ALLOWED`）。
 */
export const requireSession: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const s = await resolveSession(c);
  if (!s) return c.json({ error: { code: "UNAUTHORIZED", message: "needs session" } }, 401);
  const denied = await enforceSessionState(c, s);
  if (denied) return denied;
  c.set("scope", s.scope);
  await next();
};

/**
 * 需登入（owner 或 mailbox）─ **信件／地址／別名／表單類**端點用，於 handler 內依 scope 過濾。
 *
 * D26（docs/27 §4.5）：`scope='app'` **不得**用於 `/api/mail/*`（也不能用於其他信件相關端點）
 * → 在查 DB 前直接 `403 SCOPE_NOT_ALLOWED`（不驗證 token 新鮮度，避免多一次查詢）。
 * 其餘行為與 `requireSession` 完全相同（D8-4／D10／rescue 語意不變）。
 */
export const requireMailSession: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const s = await resolveSession(c);
  if (!s) return c.json({ error: { code: "UNAUTHORIZED", message: "needs session" } }, 401);
  if (s.scope.kind === "app") {
    return c.json({ error: { code: "SCOPE_NOT_ALLOWED", message: "app token 不可使用此端點" } }, 403);
  }
  const denied = await enforceSessionState(c, s);
  if (denied) return denied;
  c.set("scope", s.scope);
  await next();
};
