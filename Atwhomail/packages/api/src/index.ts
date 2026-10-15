/**
 * atwhomail-api — REST API Worker（Phase 7–11）
 *
 * 認證（Phase 11 Model C，05 §2.0）：
 * - POST /api/auth/login           owner 登入（username + password）→ JWT scope=owner
 * - POST /api/auth/mailbox-login   信箱帳號登入（email + password）→ JWT scope=mailbox
 * - GET  /api/auth/whoami          目前 session 資訊
 * - POST /api/auth/owner-password  以 rescue token 設定/重設 owner 密碼（bootstrap）
 * - 救援通道：x-admin-token（ADMIN_TOKEN secret）＝ owner 等效，僅保留給維運/救援
 *
 * Scope 規則（SQL 層強制）：
 * - owner   → messages.owner_user_id = sub（聚合名下全部地址）
 * - mailbox → messages.address_id    = sub（僅自己的信箱，跨信箱完全隔離）
 * - 越權一律 404（不洩漏資源存在性）
 */
import { Hono, type Context } from "hono";
import PostalMime from "postal-mime";
import {
  hashPassword,
  verifyPassword,
  validatePasswordPolicy,
  signOwnerToken,
  signMailboxToken,
  checkLocked,
  recordFailure,
  clearFailures,
  findOwnerId,
  requireOwner,
  requireSession,
  resolveScope,
  verifyAccessJwt,
  type AuthEnv,
  type Env,
  type Scope,
} from "./auth";
import { BACKUP_TABLES, clampLimit, formatCursor, parseCursor, type Cursor } from "./backup";

const app = new Hono<AuthEnv>();

/**
 * CORS 白名單判定（2026-10-06 加入，供外部 App／PWA 直接呼叫）。
 * `ALLOWED_ORIGINS`：逗號分隔的來源清單；`*` 表示允許任何來源。
 * 回傳要回給瀏覽器的 `Access-Control-Allow-Origin` 值（`*` 模式回顯來源，以相容未來 credentials 情境）。
 */
function allowedOrigin(env: Env, origin: string | undefined): string | null {
  if (!origin) return null;
  const list = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.includes("*")) return origin;
  return list.includes(origin) ? origin : null;
}

// ── CORS（08 §23 補充）：認證一律 Bearer token、不用 cookie，故只需 Allow-Origin/Headers 與 preflight ──
app.use("*", async (c, next) => {
  const origin = allowedOrigin(c.env, c.req.header("origin"));
  if (origin) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
    c.header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    c.header("Access-Control-Allow-Headers", "Authorization, Content-Type, x-admin-token");
    c.header("Access-Control-Max-Age", "86400");
  }
  if (c.req.method === "OPTIONS") return c.body(null, 204); // preflight 直接回應
  await next();
});

// ── 安全標頭（08 §23）：API 只回 JSON／二進位，禁快取、禁 iframe、禁 MIME 猜測 ──
app.use("*", async (c, next) => {
  const crossOrigin = allowedOrigin(c.env, c.req.header("origin")) !== null;
  await next();
  const h = c.res.headers;
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  h.set("X-Frame-Options", "DENY");
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  // 白名單來源放行跨網域讀取；其餘維持 same-origin（CORP 仍防 no-cors 嵌入）
  h.set("Cross-Origin-Resource-Policy", crossOrigin ? "cross-origin" : "same-origin");
  if (!h.has("Content-Security-Policy")) h.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
});

const DOMAIN = "atwho.org";
const LOCAL_PART_RE = /^[a-z0-9][a-z0-9._-]*[a-z0-9]$|^[a-z0-9]$/i;
const FOLDERS = ["inbox", "sent", "archive", "trash", "spam"];
const now = () => Date.now();

function err(c: { json: (x: unknown, s?: number) => Response }, code: string, message: string, status = 400): Response {
  return c.json({ error: { code, message } }, status);
}

/** owner 的 user id（D11：改以「角色」查找，實作集中在 auth.ts 的 findOwnerId） */
async function getOwnerId(db: D1Database): Promise<number | null> {
  return findOwnerId(db);
}

function validLocalPart(lp: string): boolean {
  return lp.length >= 1 && lp.length <= 64 && LOCAL_PART_RE.test(lp);
}

/** scope → SQL 條件（含 binds） */
function scopeWhere(scope: Scope, alias = "m"): { sql: string; binds: unknown[] } {
  return scope.kind === "owner"
    ? { sql: `${alias}.owner_user_id = ?`, binds: [scope.userId] }
    : { sql: `${alias}.address_id = ?`, binds: [scope.addressId] };
}

/** scope 是否可見此訊息列（附件下載用） */
function scopeAllows(scope: Scope, row: { owner_user_id?: number; address_id?: number }): boolean {
  return scope.kind === "owner" ? row.owner_user_id === scope.userId : row.address_id === scope.addressId;
}

/** LIKE 搜尋字串：escape \ % _ 後前後加 %（SQL 端需搭配 ESCAPE '\'） */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

function normalizeRecipients(input: unknown): string[] {
  if (input === undefined || input === null) return [];
  const arr = Array.isArray(input) ? input : [input];
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item === "string" && item.includes("@")) out.push(item.trim().toLowerCase());
    else if (item && typeof item === "object" && typeof (item as { email?: string }).email === "string") {
      out.push((item as { email: string }).email.trim().toLowerCase());
    }
  }
  return out;
}

interface SendAttachment {
  filename: string;
  type: string;
  content_base64: string;
  disposition?: "attachment" | "inline";
}

// ══════════════════════ Phase 1：訪客註冊（docs/13 v0.2、docs/14 §4）══════════════════════

/**
 * 配額常數 —— **單一來源**（docs/13 §6.5 C1–C3、docs/14 §4.3）。
 * 調整配額只需改這裡；不得把 20/5/10 散落在多處。
 */
const QUOTA = {
  /** C1 訪客每日寄信上限（新地址的 daily_send_quota 預設值） */
  DEFAULT_VISITOR_DAILY_QUOTA: 20,
  /** C2 暖機期上限（註冊後 WARMUP_HOURS 內適用） */
  WARMUP_QUOTA: 5,
  /** C2 暖機期長度（小時） */
  WARMUP_HOURS: 24,
  /** C3 每小時寄信上限 */
  HOURLY_SEND_LIMIT: 10,
} as const;

/** Cloudflare Access 帶來的邊緣身分標頭（僅供稽核，非授權依據） */
const ACCESS_EMAIL_HEADER = "cf-access-authenticated-user-email";

/**
 * 註冊密碼規則：既有政策（≥8、≤128）＋訪客加嚴（≥10 且非純數字）。
 * 既有端點仍用 `validatePasswordPolicy`（本次不得改動既有語意）。
 */
function validateRegistrationPassword(pw: string): string | null {
  const base = validatePasswordPolicy(pw);
  if (base) return base;
  if (pw.length < 10) return "密碼至少 10 個字元";
  if (/^\d+$/.test(pw)) return "密碼不能是純數字";
  return null;
}

/** 邀請碼：crypto 隨機 18 bytes → base64url 24 字元（不可預測；不得寫入 log） */
function randomInviteCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 列表用遮罩：只露前 4 碼（避免全碼外洩） */
function maskCode(code: string): string {
  return `${code.slice(0, 4)}…`;
}

/** 來源 IP（Cloudflare 優先；測試可帶 cf-connecting-ip） */
function clientIp(c: Context<AuthEnv>): string | null {
  const cf = c.req.header("cf-connecting-ip");
  if (cf?.trim()) return cf.trim();
  const xff = c.req.header("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  return first ? first : null;
}

interface AuditEntry {
  event: string;
  userId?: number | null;
  addressId?: number | null;
  accessEmail?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  detail?: unknown;
}

/** 稽核寫入（N7：detail 不得含邀請碼全碼／密碼／token；失敗只記 console，不影響主流程） */
function writeAudit(db: D1Database, e: AuditEntry): Promise<void> {
  const detail = e.detail === undefined ? null : JSON.stringify(e.detail);
  return db
    .prepare(
      `INSERT INTO registration_audit (event, user_id, address_id, access_email, ip, user_agent, detail, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    )
    .bind(
      e.event,
      e.userId ?? null,
      e.addressId ?? null,
      e.accessEmail ?? null,
      e.ip ?? null,
      e.userAgent ?? null,
      detail,
      now()
    )
    .run()
    .then(() => undefined)
    .catch((err) => {
      console.error("[atwhomail-api] audit write failed", { event: e.event, error: String(err) });
    });
}

/** 不阻塞回應地寫稽核（正式環境用 executionCtx；測試環境沒有 → 直接執行） */
function auditAsync(c: Context<AuthEnv>, entry: AuditEntry): void {
  const p = writeAudit(c.env.DB, entry);
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    void p;
  }
}

/** 寄信配額回補（寄送失敗或後續檢查被拒時，避免誤扣） */
function refundQuota(db: D1Database, addressId: number): Promise<void> {
  return db
    .prepare(
      `UPDATE email_addresses
       SET sent_today = CASE WHEN sent_today > 0 THEN sent_today - 1 ELSE 0 END, updated_at = ?1
       WHERE id = ?2`
    )
    .bind(now(), addressId)
    .run()
    .then(() => undefined)
    .catch((err) => {
      console.error("[atwhomail-api] quota refund failed", { addressId, error: String(err) });
    });
}

// ══════════════════════ 公開 ══════════════════════
app.get("/", (c) => c.json({ service: "atwhomail-api", phase: 16, ok: true, docs: "D:\\Mail\\docs" }));

/** 健康檢查：含 D1 探測（供 uptime 監控與上線檢查） */
app.get("/api/health", async (c) => {
  const started = Date.now();
  let db: "ok" | "error" = "ok";
  let dbError: string | null = null;
  try {
    await c.env.DB.prepare("SELECT 1 AS ok").first();
  } catch (e) {
    db = "error";
    dbError = (e as Error).message;
  }
  return c.json(
    { ok: db === "ok", db, dbLatencyMs: Date.now() - started, phase: 16, ts: Date.now(), dbError },
    db === "ok" ? 200 : 503
  );
});

// ══════════════════════ Phase 11：認證 ══════════════════════

/** D2：管理員登入的 Access 閘門（對外的統一訊息，不區分失敗原因以免洩漏細節） */
const ACCESS_LOGIN_DENIED = "管理員登入僅能從 mail.atwho.org 進行";

/**
 * D2（docs/16 §3）—— `/api/auth/login` **最前面**的 Cloudflare Access JWT 檢查。
 * 回傳 Response = 直接擋掉；null = 通過，繼續既有帳密流程（既有邏輯不變）。
 *
 * ⚠️ 過渡／回退設計：`ACCESS_MAIL_AUD` 未設定或空字串 → 只記 warning 並**放行**
 *    （移除該環境變數即恢復舊行為；docs/16 §5 的回退閥門，**僅為過渡期**）。
 */
async function requireAccessForOwnerLogin(c: Context<AuthEnv>): Promise<Response | null> {
  const aud = (c.env.ACCESS_MAIL_AUD ?? "").trim();
  if (!aud) {
    console.warn("[atwhomail-api] ACCESS_MAIL_AUD 未設定 → 略過 Access JWT 驗證（過渡行為；設定後即生效）");
    return null;
  }
  const token = c.req.header("cf-access-jwt-assertion");
  if (!token) return err(c, "ADMIN_LOGIN_REQUIRES_ACCESS", ACCESS_LOGIN_DENIED, 403);
  const result = await verifyAccessJwt(c.env, token);
  if (!result.ok) {
    console.warn("[atwhomail-api] access jwt rejected", { reason: result.reason }); // 只記原因，不記 token（N7）
    return err(c, "ADMIN_LOGIN_REQUIRES_ACCESS", ACCESS_LOGIN_DENIED, 403);
  }
  return null;
}

app.post("/api/auth/login", async (c) => {
  // D2：必須來自 mail.atwho.org（經 Cloudflare Access）——置於最前面，未通過就不進入帳密流程
  const accessDenied = await requireAccessForOwnerLogin(c);
  if (accessDenied) return accessDenied;

  const body = await c.req.json<{ username?: string; password?: string }>().catch(() => null);
  if (!body?.username || !body?.password) return err(c, "INVALID_BODY", "username 與 password 必填", 400);
  const username = body.username.trim().toLowerCase();
  const key = `owner:${username}`;

  const lockedUntil = await checkLocked(c.env.DB, key);
  if (lockedUntil) return err(c, "LOCKED", `嘗試次數過多，請於 ${new Date(lockedUntil).toISOString()} 後再試`, 429);

  // role='owner' 限定（Phase 1）：訪客帳號若取得 owner scope token，即可觸及 owner 專屬端點
  // （／api/email-addresses、／api/invites、／api/backup/*）→ 一律不得簽發
  const user = await c.env.DB.prepare(
    "SELECT id, username, password_hash, status, password_changed_at FROM users WHERE username = ?1 AND role = 'owner'"
  )
    .bind(username)
    .first<{ id: number; username: string; password_hash: string; status: string; password_changed_at: number }>();

  const okPw = user && user.status === "active" ? await verifyPassword(body.password, user.password_hash) : false;
  if (!user || !okPw) {
    await recordFailure(c.env.DB, key);
    return err(c, "INVALID_CREDENTIALS", "帳號或密碼錯誤", 401);
  }
  await clearFailures(c.env.DB, key);
  const token = await signOwnerToken(c.env, user.id, Number(user.password_changed_at ?? 0));
  return c.json({ token, session: "owner", user: { id: user.id, username: user.username } });
});

app.post("/api/auth/mailbox-login", async (c) => {
  const body = await c.req.json<{ email?: string; password?: string }>().catch(() => null);
  if (!body?.email || !body?.password) return err(c, "INVALID_BODY", "email 與 password 必填", 400);
  const email = body.email.trim().toLowerCase();
  const key = `mailbox:${email}`;

  const lockedUntil = await checkLocked(c.env.DB, key);
  if (lockedUntil) return err(c, "LOCKED", `嘗試次數過多，請於 ${new Date(lockedUntil).toISOString()} 後再試`, 429);

  const addr = await c.env.DB.prepare(
    `SELECT a.id, a.email, a.password_hash, a.status, a.password_changed_at, u.status AS user_status
     FROM email_addresses a JOIN users u ON u.id = a.user_id
     WHERE a.email = ?1 AND a.deleted_at IS NULL`
  )
    .bind(email)
    .first<{
      id: number;
      email: string;
      password_hash: string | null;
      status: string;
      password_changed_at: number;
      user_status: string;
    }>();

  // ⚠️ **先驗密碼，再判狀態**（D8-1，docs/16 §3）。
  // 舊寫法把 `status === "active"` 綁進密碼驗證條件 → 被停用的地址一律回 401 INVALID_CREDENTIALS，
  // 使用者（與管理者）無從得知真正原因。改為密碼正確才揭露狀態，帳號狀態仍不外洩給未持密碼者。
  const okPw = addr && addr.password_hash ? await verifyPassword(body.password, addr.password_hash) : false;
  if (!addr || !okPw) {
    await recordFailure(c.env.DB, key);
    auditAsync(c, {
      event: "login_failed",
      addressId: addr?.id ?? null,
      ip: clientIp(c),
      userAgent: c.req.header("user-agent") ?? null,
      detail: { reason: "INVALID_CREDENTIALS" },
    });
    return err(c, "INVALID_CREDENTIALS", "地址或密碼錯誤", 401);
  }
  // 地址停用（D8-4 語意：僅此一個地址，且連收信都停止）
  if (addr.status !== "active") {
    auditAsync(c, {
      event: "login_failed",
      addressId: addr.id,
      ip: clientIp(c),
      userAgent: c.req.header("user-agent") ?? null,
      detail: { reason: "ADDRESS_DISABLED" },
    });
    return err(c, "ADDRESS_DISABLED", "此地址已停用，請聯絡管理者", 403);
  }
  // 帳號停權（C7）：密碼驗證通過後才判——避免對未持密碼者洩漏帳號狀態
  if (addr.user_status !== "active") {
    auditAsync(c, {
      event: "login_failed",
      addressId: addr.id,
      ip: clientIp(c),
      userAgent: c.req.header("user-agent") ?? null,
      detail: { reason: "ACCOUNT_SUSPENDED" },
    });
    return err(c, "ACCOUNT_SUSPENDED", "此帳號已停權，請聯絡管理者", 403);
  }
  await clearFailures(c.env.DB, key);
  const token = await signMailboxToken(c.env, addr.id, addr.email, Number(addr.password_changed_at ?? 0));
  return c.json({ token, session: "mailbox", address: { id: addr.id, email: addr.email } });
});

app.get("/api/auth/whoami", requireSession, (c) => {
  const scope = c.get("scope");
  return c.json({ session: scope.kind, scope });
});

/** owner 密碼 bootstrap／重設（僅 rescue token；供初始化與救援） */
app.post("/api/auth/owner-password", async (c) => {
  const scope = await resolveScope(c);
  if (!scope || scope.kind !== "owner" || scope.via !== "rescue") {
    return err(c, "UNAUTHORIZED", "需要 rescue token（x-admin-token）", 401);
  }
  const body = await c.req.json<{ new_password?: string }>().catch(() => null);
  const pwErr = validatePasswordPolicy(body?.new_password ?? "");
  if (pwErr) return err(c, "WEAK_PASSWORD", pwErr, 422);
  const ownerId = await getOwnerId(c.env.DB);
  if (!ownerId) return err(c, "OWNER_NOT_FOUND", "owner 不存在", 500);
  const hash = await hashPassword(body!.new_password!);
  const ts = now();
  await c.env.DB.prepare(
    "UPDATE users SET password_hash = ?1, password_changed_at = ?2, updated_at = ?2 WHERE id = ?3"
  )
    .bind(hash, ts, ownerId)
    .run();
  return c.json({ ok: true, user_id: ownerId });
});

/**
 * PATCH /api/auth/owner-password/self — owner 本人變更自己的密碼（D7，docs/16 §3）
 *
 * 為什麼需要：`POST /api/auth/owner-password` 只接受 rescue token（`x-admin-token`），
 * 一般 owner 登入的 JWT 用不了 → 網頁上沒有「改自己密碼」的入口。
 * 這裡用 owner session（Bearer JWT）＋ 舊密碼驗證。
 *
 * ⚠️ rescue 路徑（`POST /api/auth/owner-password`）行為完全不變（N5）。
 * ⚠️ 成功後會更新 `password_changed_at` → 既有 JWT 立即失效（TOKEN_STALE）＝預期的安全行為。
 */
app.patch("/api/auth/owner-password/self", requireSession, async (c) => {
  const scope = c.get("scope");
  if (scope.kind !== "owner") return err(c, "FORBIDDEN", "owner scope required", 403);

  const body = await c.req
    .json<{ old_password?: string; new_password?: string }>()
    .catch(() => null);
  if (typeof body?.old_password !== "string" || typeof body?.new_password !== "string") {
    return err(c, "INVALID_BODY", "old_password 與 new_password 必填", 400);
  }

  const user = await c.env.DB.prepare("SELECT id, username, password_hash FROM users WHERE id = ?1")
    .bind(scope.userId)
    .first<{ id: number; username: string; password_hash: string }>();
  if (!user) return err(c, "NOT_FOUND", "user not found", 404);

  // 沿用既有鎖定機制（auth_attempts）：與 /api/auth/login 共用同一組 key → 猜舊密碼同樣會被鎖
  const key = `owner:${user.username}`;
  const lockedUntil = await checkLocked(c.env.DB, key);
  if (lockedUntil) {
    return err(c, "LOCKED", `嘗試次數過多，請於 ${new Date(lockedUntil).toISOString()} 後再試`, 429);
  }

  const oldOk = await verifyPassword(body.old_password, user.password_hash);
  if (!oldOk) {
    await recordFailure(c.env.DB, key);
    return err(c, "INVALID_OLD_PASSWORD", "舊密碼錯誤", 401);
  }

  const pwErr = validatePasswordPolicy(body.new_password);
  if (pwErr) return err(c, "WEAK_PASSWORD", pwErr, 422);

  await clearFailures(c.env.DB, key);
  const hash = await hashPassword(body.new_password);
  const ts = now();
  await c.env.DB.prepare(
    "UPDATE users SET password_hash = ?1, password_changed_at = ?2, updated_at = ?2 WHERE id = ?3"
  )
    .bind(hash, ts, user.id)
    .run();

  auditAsync(c, {
    event: "owner_password_changed",
    userId: user.id,
    ip: clientIp(c),
    userAgent: c.req.header("user-agent") ?? null,
  });
  return c.json({ ok: true });
});

// ══════════════════════ Phase 1：邀請碼（owner）══════════════════════
/** POST /api/invites — 產生邀請碼（owner 或 x-admin-token）；碼為 crypto 隨機、不可預測 */
app.post("/api/invites", requireOwner, async (c) => {
  const scope = c.get("scope");
  const body = await c.req
    .json<{ max_uses?: unknown; expires_in_hours?: unknown; note?: unknown }>()
    .catch(() => ({}) as { max_uses?: unknown; expires_in_hours?: unknown; note?: unknown });

  let maxUses = 1;
  if (body?.max_uses !== undefined) {
    const n = Number(body.max_uses);
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      return err(c, "INVALID_BODY", "max_uses 需為 1–100 的整數", 400);
    }
    maxUses = n;
  }
  let expiresAt: number | null = null;
  if (body?.expires_in_hours !== undefined && body.expires_in_hours !== null) {
    const h = Number(body.expires_in_hours);
    if (!Number.isFinite(h) || h < 1 || h > 24 * 365) {
      return err(c, "INVALID_BODY", "expires_in_hours 需為 1–8760", 400);
    }
    expiresAt = now() + Math.trunc(h * 3600_000);
  }
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 200) : null;

  const ts = now();
  const code = randomInviteCode();
  const res = await c.env.DB.prepare(
    `INSERT INTO invites (code, created_by, max_uses, used_count, expires_at, note, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, 0, ?4, ?5, 'active', ?6, ?6)`
  )
    .bind(code, scope.kind === "owner" ? scope.userId : 0, maxUses, expiresAt, note, ts)
    .run();
  return c.json({ id: res.meta.last_row_id, code, max_uses: maxUses, expires_at: expiresAt }, 201);
});

/** 邀請碼列表上限（避免一次拉爆；owner 端點，資料量極小） */
const INVITE_LIST_LIMIT = 200;

/**
 * GET /api/invites — 列表。
 *
 * - 預設：**只回遮罩碼**（`masked_code`，前 4 碼）——既有行為與回應結構完全不變。
 * - `?reveal=1`（D4，docs/16 §3）：**額外**回傳 `code` 全碼，供管理頁「複製邀請碼」使用。
 *   為什麼要 flag 而不是直接回全碼：全碼即註冊憑證，只有需要複製的那一刻才揭露 → 並寫入稽核留痕
 *   （`invite_revealed`，含 owner id 與時間；`detail` 只放筆數，**不含全碼**，N7）。
 *   ⚠️ 非 owner 一律 403（`requireOwner`），訪客 JWT 拿不到（T16）。
 */
app.get("/api/invites", requireOwner, async (c) => {
  const scope = c.get("scope");
  const reveal = c.req.query("reveal") === "1";
  const { results } = await c.env.DB.prepare(
    `SELECT id, code, max_uses, used_count, expires_at, status, note, created_at
     FROM invites ORDER BY id DESC LIMIT ?1`
  )
    .bind(INVITE_LIST_LIMIT)
    .all<{ id: number; code: string; max_uses: number; used_count: number; expires_at: number | null; status: string; note: string | null; created_at: number }>();

  if (reveal) {
    auditAsync(c, {
      event: "invite_revealed",
      userId: scope.kind === "owner" ? scope.userId : null,
      ip: clientIp(c),
      userAgent: c.req.header("user-agent") ?? null,
      detail: { count: results.length, via: scope.kind === "owner" ? scope.via : "unknown" },
    });
  }

  return c.json({
    invites: results.map((r) => ({
      id: r.id,
      masked_code: maskCode(r.code),
      // 僅在 reveal=1 時新增此欄位；其餘情況回應與既有完全相同
      ...(reveal ? { code: r.code } : {}),
      max_uses: r.max_uses,
      used_count: r.used_count,
      expires_at: r.expires_at,
      status: r.status,
      note: r.note,
      created_at: r.created_at,
    })),
  });
});

/** DELETE /api/invites/:id — 撤銷（軟停用：status='revoked'，永不 DELETE 資料列） */
app.delete("/api/invites/:id", requireOwner, async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return err(c, "INVALID_ID", "id 需為正整數", 400);
  const res = await c.env.DB.prepare("UPDATE invites SET status = 'revoked', updated_at = ?1 WHERE id = ?2 AND status = 'active'")
    .bind(now(), id)
    .run();
  if (res.meta.changes !== 1) {
    const exists = await c.env.DB.prepare("SELECT id FROM invites WHERE id = ?1").bind(id).first();
    if (!exists) return err(c, "INVITE_NOT_FOUND", "invite not found", 404);
  }
  return c.json({ ok: true, id }); // 重複撤銷視為冪等成功
});

// ══════════════════════ Phase 1：訪客註冊（公開，需邀請碼）══════════════════════
/**
 * POST /api/auth/register — 憑邀請碼註冊訪客帳號（docs/14 §4.2 的 9 步嚴格順序）
 * 注意：API Worker 直連不受 Cloudflare Access 保護 → 防護全靠邀請碼＋限流＋配額＋稽核。
 */
app.post("/api/auth/register", async (c) => {
  const db = c.env.DB;
  const ip = clientIp(c);
  const ipKey = `ip:${ip ?? "unknown"}`;
  const userAgent = c.req.header("user-agent") ?? null;
  const accessEmail = c.req.header(ACCESS_EMAIL_HEADER)?.trim().toLowerCase() ?? null;
  // REGISTRATION_DISABLED 為選配 var（預設未設 = 開放）；本檔不新增 wrangler var（P2/P7）
  const env = c.env as Env & { REGISTRATION_DISABLED?: string };

  // 步驟 1：限流（沿用 auth_attempts，key = ip:<ip>）
  const lockedUntil = await checkLocked(db, ipKey);
  if (lockedUntil) {
    return err(c, "RATE_LIMITED", `嘗試次數過多，請於 ${new Date(lockedUntil).toISOString()} 後再試`, 429);
  }

  // 步驟 2：全站開關
  if ((env.REGISTRATION_DISABLED ?? "false").toLowerCase() === "true") {
    return err(c, "REGISTRATION_DISABLED", "目前未開放註冊", 403);
  }

  const body = await c.req
    .json<{ invite_code?: string; username?: string; password?: string; local_part?: string }>()
    .catch(() => null);
  if (!body?.invite_code || !body?.username || !body?.password) {
    return err(c, "INVALID_BODY", "invite_code、username、password 必填", 400);
  }

  // 步驟 3：驗邀請碼（存在 / active / 未過期 / 尚有次數）
  const invite = await db
    .prepare("SELECT id, max_uses, used_count, expires_at, status FROM invites WHERE code = ?1")
    .bind(body.invite_code.trim())
    .first<{ id: number; max_uses: number; used_count: number; expires_at: number | null; status: string }>();
  const ts = now();
  const inviteInvalid =
    !invite || invite.status !== "active" || (invite.expires_at !== null && invite.expires_at <= ts);
  const rejected = async (code: string, message: string, detail: Record<string, unknown>) => {
    await recordFailure(db, ipKey);
    auditAsync(c, { event: "register_rejected", ip, userAgent, accessEmail, detail });
    return err(c, code, message, 400);
  };
  if (inviteInvalid) {
    // detail 只放 id（N7：不得放全碼）
    return rejected("INVITE_INVALID", "邀請碼無效、已撤銷或已過期", {
      reason: "INVITE_INVALID",
      invite: invite ? `#${invite.id}` : null,
    });
  }
  if (invite.used_count >= invite.max_uses) {
    return rejected("INVITE_EXHAUSTED", "邀請碼已使用完畢", { reason: "INVITE_EXHAUSTED", invite: `#${invite.id}` });
  }

  // 步驟 4：username / local_part 格式與唯一性
  const username = body.username.trim().toLowerCase();
  const localPart = (body.local_part ?? body.username).trim().toLowerCase();
  if (!validLocalPart(username) || !validLocalPart(localPart)) {
    return rejected("INVALID_LOCAL_PART", "1-64 chars, [a-z0-9._-]，不能以 ./- 開頭或結尾", {
      reason: "INVALID_LOCAL_PART",
      invite: `#${invite.id}`,
    });
  }
  const email = `${localPart}@${DOMAIN}`;
  // 唯一性：email_addresses.email 為 UNIQUE（含軟刪除列）→ 一律不得重複
  const dupAddr = await db.prepare("SELECT id FROM email_addresses WHERE email = ?1").bind(email).first();
  const dupUser = await db.prepare("SELECT id FROM users WHERE username = ?1").bind(username).first();
  if (dupAddr || dupUser) {
    return rejected("ADDRESS_TAKEN", "此地址或使用者名稱已被使用", {
      reason: "ADDRESS_TAKEN",
      invite: `#${invite.id}`,
    });
  }

  // 步驟 5：密碼強度
  const pwErr = validateRegistrationPassword(body.password);
  if (pwErr) {
    return rejected("WEAK_PASSWORD", pwErr, { reason: "WEAK_PASSWORD", invite: `#${invite.id}` });
  }

  // 步驟 6：原子扣次數（不得先 SELECT 再 UPDATE）
  const claim = await db
    .prepare(
      `UPDATE invites SET used_count = used_count + 1, updated_at = ?1
       WHERE id = ?2 AND status = 'active' AND used_count < max_uses`
    )
    .bind(ts, invite.id)
    .run();
  if (claim.meta.changes !== 1) {
    return rejected("INVITE_EXHAUSTED", "邀請碼已使用完畢", { reason: "INVITE_EXHAUSTED", invite: `#${invite.id}` });
  }

  // 步驟 7：建 users(role=visitor) ＋ 1 個 email_addresses（可寄信，配額見 QUOTA）
  const pwHash = await hashPassword(body.password);
  try {
    const userRes = await db
      .prepare(
        `INSERT INTO users (username, display_name, password_hash, status, role, access_email, created_at, updated_at)
         VALUES (?1, NULL, ?2, 'active', 'visitor', ?3, ?4, ?4)`
      )
      .bind(username, pwHash, accessEmail, ts)
      .run();
    const userId = Number(userRes.meta.last_row_id);

    const addrRes = await db
      .prepare(
        `INSERT INTO email_addresses
           (user_id, local_part, domain, email, password_hash, password_changed_at, status,
            can_send, daily_send_quota, sent_today, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', 1, ?7, 0, ?6, ?6)`
      )
      .bind(userId, localPart, DOMAIN, email, pwHash, ts, QUOTA.DEFAULT_VISITOR_DAILY_QUOTA)
      .run();
    const addressId = Number(addrRes.meta.last_row_id);

    // 步驟 8：簽發 mailbox scope JWT（沿用既有簽發路徑與 24h 效期）
    const token = await signMailboxToken(c.env, addressId, email, ts);

    // 步驟 9：稽核
    auditAsync(c, {
      event: "register_ok",
      userId,
      addressId,
      accessEmail,
      ip,
      userAgent,
      detail: { invite: `#${invite.id}` },
    });
    await clearFailures(db, ipKey);
    return c.json({ token, session: "mailbox", address: { id: addressId, email } }, 201);
  } catch (e) {
    // 建帳號失敗 → 回補邀請碼次數（避免白白消耗）
    await db
      .prepare(
        `UPDATE invites SET used_count = CASE WHEN used_count > 0 THEN used_count - 1 ELSE 0 END, updated_at = ?1 WHERE id = ?2`
      )
      .bind(now(), invite.id)
      .run();
    console.error("[atwhomail-api] register failed", { invite: invite.id, error: String(e) });
    return err(c, "REGISTER_FAILED", "註冊失敗，請稍後再試", 500);
  }
});

// ══════════════════════ Phase 1：身分與配額（／api/me）══════════════════════
app.get("/api/me", requireSession, async (c) => {
  const scope = c.get("scope");
  if (scope.kind === "owner") {
    const user = await c.env.DB.prepare("SELECT username, role FROM users WHERE id = ?1")
      .bind(scope.userId)
      .first<{ username: string; role: string }>();
    const { results } = await c.env.DB.prepare(
      `SELECT id, email, can_send, daily_send_quota, sent_today, quota_reset_at
       FROM email_addresses WHERE user_id = ?1 AND deleted_at IS NULL ORDER BY id`
    )
      .bind(scope.userId)
      .all();
    return c.json({
      role: user?.role ?? "owner",
      session: "owner",
      username: user?.username ?? null,
      addresses: results,
    });
  }

  const row = await c.env.DB.prepare(
    `SELECT a.id, a.email, a.can_send, a.daily_send_quota, a.sent_today, a.quota_reset_at,
            u.username, u.role
     FROM email_addresses a JOIN users u ON u.id = a.user_id
     WHERE a.id = ?1 AND a.deleted_at IS NULL`
  )
    .bind(scope.addressId)
    .first<{
      id: number;
      email: string;
      can_send: number;
      daily_send_quota: number;
      sent_today: number;
      quota_reset_at: number | null;
      username: string;
      role: string;
    }>();
  if (!row) return err(c, "NOT_FOUND", "address not found", 404);
  return c.json({
    role: row.role,
    session: "mailbox",
    username: row.username,
    addresses: [
      {
        id: row.id,
        email: row.email,
        can_send: row.can_send,
        daily_send_quota: row.daily_send_quota,
        sent_today: row.sent_today,
        quota_reset_at: row.quota_reset_at,
      },
    ],
  });
});

// ══════════════════════ Phase 1：停權（owner；C7 一鍵止血）══════════════════════
app.patch("/api/users/:id/status", requireOwner, async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return err(c, "INVALID_ID", "id 需為正整數", 400);
  const body = await c.req.json<{ status?: string }>().catch(() => null);
  // API 詞彙 active/suspended；DB 詞彙 active/disabled（0001 的 CHECK 僅允許後者）
  if (body?.status !== "active" && body?.status !== "suspended") {
    return err(c, "INVALID_STATUS", 'status 只能是 "active" 或 "suspended"', 400);
  }
  const dbStatus = body.status === "active" ? "active" : "disabled";
  const res = await c.env.DB.prepare("UPDATE users SET status = ?1, updated_at = ?2 WHERE id = ?3")
    .bind(dbStatus, now(), id)
    .run();
  if (res.meta.changes !== 1) return err(c, "NOT_FOUND", "user not found", 404);
  return c.json({ ok: true, id, status: body.status });
});

// ══════════════════════ Phase 16（D5）：訪客清單／停權／配額（owner）══════════════════════

/** 每日寄信配額值域（D5；超出 → 422） */
const QUOTA_MIN = 1;
const QUOTA_MAX = 200;

/**
 * migration `0007_warmup_exempt` 是否已套用（`email_addresses.warmup_exempt` 是否存在）。
 *
 * ⚠️ 部署順序可能是「先部署程式、後套 migration」→ 沒有這個欄位時端點仍須可用，
 *    只是暖機豁免一律視為關閉（與本次變更前的行為完全相同）。
 */
async function hasWarmupExemptColumn(db: D1Database): Promise<boolean> {
  try {
    await db.prepare("SELECT warmup_exempt FROM email_addresses LIMIT 1").first();
    return true;
  } catch {
    return false;
  }
}

/** 單一地址是否暖機豁免（欄位不存在／查詢失敗 → false，回退為一般暖機限制） */
async function isWarmupExempt(db: D1Database, addressId: number): Promise<boolean> {
  try {
    const row = await db
      .prepare("SELECT warmup_exempt FROM email_addresses WHERE id = ?1")
      .bind(addressId)
      .first<{ warmup_exempt: number }>();
    return row?.warmup_exempt === 1;
  } catch {
    return false;
  }
}

/**
 * GET /api/users?role=visitor — 訪客清單（owner 專用；docs/16 §3 D5 補充規格）
 *
 * 每位訪客回傳：`id`／`username`／`status`／`created_at`／`address`（主要地址）／
 * `mail_count`（該地址信件數）／`last_activity_at`（最近活動時間）。
 *
 * ⚠️ **N9（權限邊界）**：這裡只回**數量與時間**，**絕不**回主旨／寄件者／內文；
 *    owner 不得透過管理介面讀取訪客信件內容（信件一律走 `/api/mail/*` 的 session 授權）。
 * ⚠️ `status` 以 API 詞彙回傳（`active`／`suspended`），與 `PATCH /api/users/:id/status` 對稱；
 *    DB 端停權仍存為 `disabled`（0001 的 CHECK 只允許 active/disabled）。
 */
app.get("/api/users", requireOwner, async (c) => {
  const role = c.req.query("role");
  if (role !== "visitor") return err(c, "INVALID_ROLE", 'role 只能是 "visitor"', 400);

  const warmupCol = (await hasWarmupExemptColumn(c.env.DB)) ? "a.warmup_exempt" : "0";
  const { results } = await c.env.DB.prepare(
    `SELECT u.id AS id, u.username AS username, u.status AS status,
            u.created_at AS created_at, u.updated_at AS updated_at,
            a.id AS address_id, a.email AS email, a.status AS address_status,
            a.can_send AS can_send, a.daily_send_quota AS daily_send_quota,
            a.sent_today AS sent_today, ${warmupCol} AS warmup_exempt,
            (SELECT COUNT(*) FROM messages m
              WHERE m.address_id = a.id AND m.deleted_at IS NULL) AS mail_count,
            (SELECT MAX(m.received_at) FROM messages m
              WHERE m.address_id = a.id AND m.deleted_at IS NULL) AS last_mail_at
     FROM users u
     LEFT JOIN email_addresses a ON a.user_id = u.id AND a.deleted_at IS NULL
     WHERE u.role = 'visitor'
     ORDER BY u.id, a.id`
  ).all<{
    id: number;
    username: string;
    status: string;
    created_at: number;
    updated_at: number;
    address_id: number | null;
    email: string | null;
    address_status: string | null;
    can_send: number | null;
    daily_send_quota: number | null;
    sent_today: number | null;
    warmup_exempt: number;
    mail_count: number;
    last_mail_at: number | null;
  }>();

  // 一位訪客一列（LEFT JOIN 可能因多地址產生多列 → 取第一個地址，與 UI 的「地址」欄一致）
  const seen = new Set<number>();
  const users: unknown[] = [];
  for (const r of results) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    users.push({
      id: r.id,
      username: r.username,
      status: r.status === "active" ? "active" : "suspended",
      created_at: r.created_at,
      address:
        r.address_id === null
          ? null
          : {
              id: r.address_id,
              email: r.email,
              status: r.address_status,
              can_send: r.can_send,
              daily_send_quota: r.daily_send_quota,
              sent_today: r.sent_today,
              warmup_exempt: r.warmup_exempt,
            },
      mail_count: Number(r.mail_count ?? 0),
      last_activity_at: r.last_mail_at ?? r.updated_at ?? null,
    });
  }
  return c.json({ users });
});

/**
 * PATCH /api/users/:id/quota — 調整每日寄信配額與寄信安全閥（owner；D5）
 *
 * - `daily_send_quota`：整數 **1–200**，超出 → `422 INVALID_QUOTA`
 * - `can_send`：boolean（或 0／1）＝安全閥 C8，`false` 立即停止該使用者的寄信
 * - 套用到該使用者名下**所有未刪除**的地址（訪客通常只有一個）
 * - 稽核：`quota_changed`（含 owner id、目標 user id 與新值）
 */
app.patch("/api/users/:id/quota", requireOwner, async (c) => {
  const scope = c.get("scope");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return err(c, "INVALID_ID", "id 需為正整數", 400);

  const body = await c.req
    .json<{ daily_send_quota?: unknown; can_send?: unknown }>()
    .catch(() => null);
  if (!body || (body.daily_send_quota === undefined && body.can_send === undefined)) {
    return err(c, "NO_UPDATE_FIELD", "需提供 daily_send_quota 或 can_send", 400);
  }

  let quota: number | null = null;
  if (body.daily_send_quota !== undefined) {
    const n = Number(body.daily_send_quota);
    if (!Number.isInteger(n) || n < QUOTA_MIN || n > QUOTA_MAX) {
      return err(c, "INVALID_QUOTA", `daily_send_quota 需為 ${QUOTA_MIN}–${QUOTA_MAX} 的整數`, 422);
    }
    quota = n;
  }
  let canSend: number | null = null;
  if (body.can_send !== undefined) {
    if (typeof body.can_send !== "boolean" && body.can_send !== 0 && body.can_send !== 1) {
      return err(c, "INVALID_BODY", "can_send 需為 boolean（或 0／1）", 400);
    }
    canSend = body.can_send === true || body.can_send === 1 ? 1 : 0;
  }

  const user = await c.env.DB.prepare("SELECT id FROM users WHERE id = ?1").bind(id).first<{ id: number }>();
  if (!user) return err(c, "NOT_FOUND", "user not found", 404);

  const res = await c.env.DB.prepare(
    `UPDATE email_addresses
     SET daily_send_quota = COALESCE(?1, daily_send_quota),
         can_send         = COALESCE(?2, can_send),
         updated_at       = ?3
     WHERE user_id = ?4 AND deleted_at IS NULL`
  )
    .bind(quota, canSend, now(), id)
    .run();
  if (res.meta.changes < 1) return err(c, "NO_ADDRESS", "此使用者沒有可設定的地址", 404);

  auditAsync(c, {
    event: "quota_changed",
    userId: id,
    ip: clientIp(c),
    userAgent: c.req.header("user-agent") ?? null,
    detail: {
      by: scope.kind === "owner" ? scope.userId : null,
      addresses: res.meta.changes,
      daily_send_quota: quota,
      can_send: canSend,
    },
  });
  return c.json({
    ok: true,
    user_id: id,
    addresses: res.meta.changes,
    daily_send_quota: quota,
    can_send: canSend,
  });
});

/**
 * PATCH /api/users/:id/warmup — 暖機豁免（owner；D5，可選）
 *
 * `warmup_exempt = 1` → 該使用者的地址**不受**「註冊後 24 小時 5 封」上限（C2），
 * 但**仍受 `daily_send_quota`** 與每小時限流約束（不是無上限）。
 * ⚠️ 需要 migration `0007`；未套用時回 `409 MIGRATION_REQUIRED`（不假裝成功）。
 */
app.patch("/api/users/:id/warmup", requireOwner, async (c) => {
  const scope = c.get("scope");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return err(c, "INVALID_ID", "id 需為正整數", 400);

  const body = await c.req.json<{ warmup_exempt?: unknown }>().catch(() => null);
  const raw = body?.warmup_exempt;
  if (typeof raw !== "boolean" && raw !== 0 && raw !== 1) {
    return err(c, "INVALID_BODY", "warmup_exempt 需為 boolean（或 0／1）", 400);
  }
  const value = raw === true || raw === 1 ? 1 : 0;

  if (!(await hasWarmupExemptColumn(c.env.DB))) {
    return err(c, "MIGRATION_REQUIRED", "此功能需要先套用 migration 0007（warmup_exempt）", 409);
  }

  const user = await c.env.DB.prepare("SELECT id FROM users WHERE id = ?1").bind(id).first<{ id: number }>();
  if (!user) return err(c, "NOT_FOUND", "user not found", 404);

  const res = await c.env.DB.prepare(
    `UPDATE email_addresses SET warmup_exempt = ?1, updated_at = ?2
     WHERE user_id = ?3 AND deleted_at IS NULL`
  )
    .bind(value, now(), id)
    .run();
  if (res.meta.changes < 1) return err(c, "NO_ADDRESS", "此使用者沒有可設定的地址", 404);

  auditAsync(c, {
    event: "warmup_changed",
    userId: id,
    ip: clientIp(c),
    userAgent: c.req.header("user-agent") ?? null,
    detail: { by: scope.kind === "owner" ? scope.userId : null, warmup_exempt: value, addresses: res.meta.changes },
  });
  return c.json({ ok: true, user_id: id, warmup_exempt: value, addresses: res.meta.changes });
});

/**
 * R2 物件批次刪除（D9；R2 單次上限 1000 key）。
 *
 * ⚠️ **best-effort**：失敗只記 log，不讓整個刪除動作回報錯誤——D1 的列已刪除後，
 *    這些物件已無法透過任何端點存取（沒有 DB 列就沒有 key），且 owner 若看到失敗訊息
 *    會誤以為沒刪成功而重試（第二次只會拿到 404）。
 */
async function deleteR2Objects(bucket: R2Bucket, keys: string[]): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    try {
      await bucket.delete(chunk);
      deleted += chunk.length;
    } catch (e) {
      console.error("[atwhomail-api] R2 delete failed (D1 rows already removed)", {
        count: chunk.length,
        error: String(e),
      });
    }
  }
  return deleted;
}

/**
 * DELETE /api/users/:id — 永久刪除**訪客**帳號與其全部資料（owner 專用；D9，docs/16 §3）
 *
 * ⚠️ **僅允許 `role='visitor'`**：對 owner 帳號（或任何非 visitor 角色）呼叫 → `403 FORBIDDEN`；
 *    另以 `findOwnerId` 做縱深防禦（即使 role 欄位被誤設，也刪不到管理帳號）。
 * ⚠️ **精準 id 操作**（`= ?` 與「取 id 的子查詢」），**禁止** LIKE 模糊比對；
 *    先 `SELECT` 確認存在且角色正確才進入刪除。
 * ⚠️ **不刪稽核**：`registration_audit` 是不可竄改的歷史（含本帳號的 register_ok／login_failed…），
 *    一個字都不動；另外寫入管理稽核 `user_deleted`（操作 owner id、被刪 username／address／
 *    信件數／附件數、時間）。
 * ⚠️ 刪除後該地址的既有 mailbox JWT 立即失效 → `401 TOKEN_STALE`（D10，docs/16 §3 T23）。
 *
 * 刪除範圍與順序（依 FK，由子到父；整批 `batch`＝單一交易，任一句失敗即全部回滾，不留半刪狀態）：
 *   `attachments`（透過 messages）→ `messages`（該地址與該 owner_user_id 的）
 *   → `email_aliases`（指向該地址）→ `email_addresses`（該 user 名下，含已軟刪除者）
 *   → `users` → `auth_attempts`（該地址的 mailbox 計數 key，逐一字串精準比對）
 * 註：`attachments` 參照 `messages`，故必須**先於** messages 刪除（規格的「透過 messages」是範圍描述）。
 */
app.delete("/api/users/:id", requireOwner, async (c) => {
  const scope = c.get("scope");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return err(c, "INVALID_ID", "id 需為正整數", 400);

  // 1) 先 SELECT：存在且 role 正確才刪（保護管理帳號）
  const user = await c.env.DB.prepare("SELECT id, username, role FROM users WHERE id = ?1")
    .bind(id)
    .first<{ id: number; username: string; role: string }>();
  if (!user) return err(c, "NOT_FOUND", "user not found", 404);
  if (user.role !== "visitor") return err(c, "FORBIDDEN", "只能刪除訪客帳號（owner 帳號受保護）", 403);
  const ownerId = await getOwnerId(c.env.DB);
  if (ownerId !== null && ownerId === id) {
    return err(c, "FORBIDDEN", "只能刪除訪客帳號（owner 帳號受保護）", 403);
  }

  // 2) 先收集刪除後就查不到的東西：地址清單與 R2 物件 key
  const { results: addresses } = await c.env.DB.prepare(
    "SELECT id, email FROM email_addresses WHERE user_id = ?1 ORDER BY id"
  )
    .bind(id)
    .all<{ id: number; email: string }>();

  /** 本帳號的信：掛在自己名下（owner_user_id）或收在名下任一地址（address_id） */
  const MSG_SCOPE = "owner_user_id = ?1 OR address_id IN (SELECT id FROM email_addresses WHERE user_id = ?1)";

  const { results: msgRows } = await c.env.DB.prepare(
    `SELECT raw_r2_key, html_r2_key FROM messages WHERE ${MSG_SCOPE}`
  )
    .bind(id)
    .all<{ raw_r2_key: string | null; html_r2_key: string | null }>();
  const { results: attRows } = await c.env.DB.prepare(
    `SELECT r2_key FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE ${MSG_SCOPE})`
  )
    .bind(id)
    .all<{ r2_key: string | null }>();

  // 3) D1 刪除（單一交易；順序＝FK 由子到父，見上方說明）
  let counts: number[];
  try {
    const results = await c.env.DB.batch([
      c.env.DB.prepare(
        `DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE ${MSG_SCOPE})`
      ).bind(id),
      c.env.DB.prepare(`DELETE FROM messages WHERE ${MSG_SCOPE}`).bind(id),
      c.env.DB.prepare(
        `DELETE FROM email_aliases
          WHERE target_email_address_id IN (SELECT id FROM email_addresses WHERE user_id = ?1)`
      ).bind(id),
      c.env.DB.prepare("DELETE FROM email_addresses WHERE user_id = ?1").bind(id),
      c.env.DB.prepare("DELETE FROM users WHERE id = ?1").bind(id),
      // auth_attempts：該地址的 mailbox 計數 key（逐一字串比對，不用 LIKE）
      ...addresses.map((a) => c.env.DB.prepare("DELETE FROM auth_attempts WHERE key = ?1").bind(`mailbox:${a.email}`)),
    ]);
    counts = results.map((r) => Number(r.meta.changes ?? 0));
  } catch (e) {
    // batch 為單一交易 → 失敗即全部回滾（不留半刪狀態）；不洩漏 SQL 細節給客戶端
    console.error("[atwhomail-api] user delete failed (rolled back)", { id, error: String(e) });
    return err(c, "DELETE_FAILED", "刪除失敗（已回滾，資料未變更）", 500);
  }
  const attachments = counts[0] ?? 0;
  const messages = counts[1] ?? 0;
  const aliases = counts[2] ?? 0;
  const addressesDeleted = counts[3] ?? 0;

  // 4) R2 物件（best-effort；D1 列已刪 → 物件不再可達）
  const r2Keys = [
    ...msgRows.flatMap((m) => [m.raw_r2_key, m.html_r2_key]),
    ...attRows.map((a) => a.r2_key),
  ].filter((k): k is string => typeof k === "string" && k.length > 0);
  const r2Deleted = await deleteR2Objects(c.env.MAIL, r2Keys);

  // 5) 管理稽核（registration_audit 既有列一律保留，只新增這一筆）
  const primary = addresses[0] ?? null;
  auditAsync(c, {
    event: "user_deleted",
    userId: id, // 已刪除的目標；registration_audit 的 user_id/address_id 只是整數欄（無 FK）
    addressId: primary?.id ?? null,
    ip: clientIp(c),
    userAgent: c.req.header("user-agent") ?? null,
    detail: {
      by: scope.kind === "owner" ? scope.userId : null,
      username: user.username,
      address: primary?.email ?? null,
      addresses: addressesDeleted,
      messages,
      attachments,
      aliases,
      r2_objects: r2Deleted,
    },
  });
  return c.json({
    ok: true,
    id,
    username: user.username,
    deleted: { addresses: addressesDeleted, messages, attachments, aliases },
  });
});

/**
 * PATCH /api/email-addresses/:id/status — 停用／啟用**訪客**地址（owner 專用；D5）
 *
 * 為什麼要另開端點：既有的 `PATCH /api/email-addresses/:id` 只認 `user_id = 自己`，
 * owner 拿訪客的地址 id 去打**一律 404** → 無法停用訪客地址（`docs/14` 附錄 B.5 待辦 1 的缺口）。
 * 本端點不做 `user_id` 限制（端點本身已 `requireOwner`），但仍排除軟刪除的地址
 * （停用 ≠ 刪除；刪除請用 `DELETE /api/email-addresses/:id`）。
 *
 * 立即生效：地址 `status='disabled'` → 該地址無法用 `mailbox-login` 登入（403 `ADDRESS_DISABLED`，D8-1）、
 * 既有的 mailbox session 下一次請求即被 `requireSession` 擋下（403 `ADDRESS_DISABLED`，D8-4）、
 * 也不在寄信允許範圍。⚠️ 被停用地址的**來信會被丟棄**（不可逆），與停權帳號（來信照收）不同。
 */
app.patch("/api/email-addresses/:id/status", requireOwner, async (c) => {
  const scope = c.get("scope");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return err(c, "INVALID_ID", "id 需為正整數", 400);

  const body = await c.req.json<{ status?: string }>().catch(() => null);
  if (body?.status !== "active" && body?.status !== "disabled") {
    return err(c, "INVALID_STATUS", 'status 只能是 "active" 或 "disabled"（刪除用 DELETE）', 400);
  }

  const row = await c.env.DB.prepare(
    `SELECT a.id, a.email, a.user_id, u.role AS user_role
     FROM email_addresses a JOIN users u ON u.id = a.user_id
     WHERE a.id = ?1 AND a.deleted_at IS NULL`
  )
    .bind(id)
    .first<{ id: number; email: string; user_id: number; user_role: string }>();
  if (!row) return err(c, "NOT_FOUND", "address not found", 404);

  await c.env.DB.prepare("UPDATE email_addresses SET status = ?1, updated_at = ?2 WHERE id = ?3")
    .bind(body.status, now(), id)
    .run();

  auditAsync(c, {
    event: "address_status_changed",
    userId: row.user_id,
    addressId: row.id,
    ip: clientIp(c),
    userAgent: c.req.header("user-agent") ?? null,
    detail: { by: scope.kind === "owner" ? scope.userId : null, status: body.status, target_role: row.user_role },
  });
  return c.json({ ok: true, id: row.id, email: row.email, status: body.status });
});

// ══════════════════════ Phase 7：地址 CRUD（owner）══════════════════════
app.post("/api/email-addresses", requireOwner, async (c) => {
  const scope = c.get("scope");
  if (scope.kind !== "owner") return err(c, "FORBIDDEN", "owner only", 403);
  const body = await c.req.json<{ local_part?: string; password?: string }>().catch(() => null);
  if (!body || typeof body.local_part !== "string") return err(c, "INVALID_BODY", "local_part is required (string)", 400);
  const localPart = body.local_part.trim().toLowerCase();
  if (!validLocalPart(localPart)) return err(c, "INVALID_LOCAL_PART", "1-64 chars, [a-z0-9._-]，不能以 ./- 開頭或結尾", 400);

  let pwHash: string | null = null;
  if (body.password !== undefined) {
    const pwErr = validatePasswordPolicy(body.password);
    if (pwErr) return err(c, "WEAK_PASSWORD", pwErr, 422);
    pwHash = await hashPassword(body.password);
  }

  const email = `${localPart}@${DOMAIN}`;
  // ⚠️ D11-2 **名稱釋放**：這裡**刻意不看 `deleted_at`** —— `email` 與 `(local_part, domain)` 都是 UNIQUE
  //    且不含 `deleted_at`，所以軟刪除的列仍在、名稱**尚未釋放**。舊版只檢查 `deleted_at IS NULL`
  //    → 軟刪除後重建同名會通過這道檢查、接著在 INSERT 撞 UNIQUE 而回 500；現在一律回 409。
  //    要真正釋放名稱，請用 `DELETE /api/email-addresses/:id?mode=hard`（會移除該列）。
  const exists = await c.env.DB.prepare("SELECT id, deleted_at FROM email_addresses WHERE email = ?1")
    .bind(email)
    .first<{ id: number; deleted_at: number | null }>();
  if (exists) {
    return err(
      c,
      "ADDRESS_EXISTS",
      exists.deleted_at === null
        ? "address already exists"
        : "此名稱曾被刪除（soft delete），名稱尚未釋放；需先永久刪除（mode=hard）才能重新建立",
      409
    );
  }

  const ts = now();
  const res = await c.env.DB.prepare(
    `INSERT INTO email_addresses (user_id, local_part, domain, email, password_hash, password_changed_at, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
  )
    .bind(scope.userId, localPart, DOMAIN, email, pwHash, pwHash ? ts : 0, ts, ts)
    .run();
  return c.json({ id: res.meta.last_row_id, email, status: "active", created_at: ts, has_password: pwHash !== null }, 201);
});

app.get("/api/email-addresses", requireOwner, async (c) => {
  const scope = c.get("scope");
  if (scope.kind !== "owner") return err(c, "FORBIDDEN", "owner only", 403);

  // `?deleted=1`（D11-5）：改列**已軟刪除**（垃圾桶狀態）的地址 —— 供地址管理的「已刪除的地址」
  // 區塊顯示（地址／刪除時間／信件數）並提供「永久刪除」升級路徑。未帶參數＝既有行為，
  // SQL 與回應欄位完全未變（軟刪除的列仍不出現在預設清單，T25 的既有斷言不變）。
  if (c.req.query("deleted") === "1") {
    const { results } = await c.env.DB.prepare(
      `SELECT a.id, a.email, a.status, (a.password_hash IS NOT NULL) AS has_password,
              a.created_at, a.updated_at, a.deleted_at,
              (SELECT COUNT(*) FROM messages m WHERE m.address_id = a.id) AS messages
       FROM email_addresses a WHERE a.user_id = ? AND a.deleted_at IS NOT NULL ORDER BY a.id`
    )
      .bind(scope.userId)
      .all();
    return c.json({ addresses: results });
  }

  // `messages`（D11-3）：該地址的**信件總數**（含垃圾桶／所有資料夾），供前端在刪除對話框顯示
  // 「此地址有 N 封信，永久刪除將一併刪除」；與 `?mode=hard` 實際會刪除的範圍一致。
  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.email, a.status, (a.password_hash IS NOT NULL) AS has_password, a.created_at, a.updated_at,
            (SELECT COUNT(*) FROM messages m WHERE m.address_id = a.id) AS messages
     FROM email_addresses a WHERE a.user_id = ? AND a.deleted_at IS NULL ORDER BY a.id`
  )
    .bind(scope.userId)
    .all();
  return c.json({ addresses: results });
});

app.get("/api/email-addresses/:id", requireSession, async (c) => {
  const scope = c.get("scope");
  const id = Number(c.req.param("id"));
  // mailbox 只能看自己
  if (scope.kind === "mailbox" && scope.addressId !== id) return err(c, "NOT_FOUND", "address not found", 404);
  const row = await c.env.DB.prepare(
    `SELECT id, email, status, (password_hash IS NOT NULL) AS has_password, created_at, updated_at
     FROM email_addresses WHERE id = ?1 AND deleted_at IS NULL
       AND (?2 IS NULL OR user_id = ?2)`
  )
    .bind(id, scope.kind === "owner" ? scope.userId : null)
    .first();
  if (!row) return err(c, "NOT_FOUND", "address not found", 404);
  return c.json({ address: row });
});

app.patch("/api/email-addresses/:id", requireOwner, async (c) => {
  const scope = c.get("scope");
  if (scope.kind !== "owner") return err(c, "FORBIDDEN", "owner only", 403);
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ status?: string }>().catch(() => null);
  if (!body) return err(c, "INVALID_BODY", "invalid body", 400);
  const row = await c.env.DB.prepare(
    "SELECT id FROM email_addresses WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL"
  )
    .bind(id, scope.userId)
    .first();
  if (!row) return err(c, "NOT_FOUND", "address not found", 404);
  if (body.status !== undefined) {
    if (!["active", "disabled"].includes(body.status)) {
      return err(c, "INVALID_STATUS", "status 只能是 active 或 disabled（刪除用 DELETE）", 400);
    }
    await c.env.DB.prepare("UPDATE email_addresses SET status = ?1, updated_at = ?2 WHERE id = ?3")
      .bind(body.status, now(), id)
      .run();
    return c.json({ id, status: body.status });
  }
  return err(c, "NO_UPDATE_FIELD", "沒有可更新的欄位（目前支援 status）", 400);
});

/**
 * DELETE /api/email-addresses/:id?mode=soft|hard — 刪除地址（D11，docs/16 §3）
 *
 * 兩種語意（規格 D11-2）：
 * - `soft`（**預設**，維持既有行為相容）：只標記 `status='deleted'`／`deleted_at`，
 *   **保留**信件與 R2 物件；回應維持 `204`（舊版行為，前端既有呼叫不受影響）。
 * - `hard`：同一交易內先做 soft，接續刪除該地址**所有** `messages`（含所有資料夾與垃圾桶）
 *   → `attachments` → 指向該地址的 `email_aliases` → **真正移除 `email_addresses` 該列**
 *   → 該地址的 `auth_attempts` 計數 key；之後 best-effort 刪除 R2 物件。回應 `200` 附數量。
 *
 * ⚠️ **名稱釋放（D11-2）**：`email` 與 `(local_part, domain)` 皆為 UNIQUE 且**不含 `deleted_at`**
 *    → 只做 soft 的列會永遠佔住名稱（重建同名地址會在 INSERT 撞 UNIQUE）；因此 hard **必須**
 *    真的移除該列。這是 hard 與 soft 在「能否重建同名」上的唯一差別。
 * ⚠️ **權限**：`requireOwner` ＋ **只能操作自己名下**的地址；他人或訪客的地址一律 `404`
 *    （不洩漏存在性）。訪客地址的刪除是**訪客管理**（`DELETE /api/users/:id`，D9）的職責，不走這裡。
 * ⚠️ **交易性**：D1 部分一律以**單一 `batch`**（＝單一交易）執行，任一句失敗即全部回滾
 *    → `500 DELETE_FAILED`（訊息明講「已回滾，資料未變更」）。
 * ⚠️ **R2 best-effort**：失敗只記 log，不讓已完成的 D1 刪除回報失敗（沒有 DB 列就沒有 key，
 *    物件已不可達）；與 D9 同一策略。
 * ⚠️ **稽核（D11-1）**：兩種模式**一律**寫 `address_deleted`（操作 owner id、address id／email、
 *    mode、被刪信件數、時間）；**不得**記錄任何信件內容（主旨／寄件者／內文，N9）。
 *
 * ── D11-5：對「已軟刪除」的地址執行永久清除 ──
 * 查詢條件**涵蓋 `deleted_at` 非空的列**（但仍嚴格限制 `user_id = 自己` 且 `role='owner'`：
 * 他人／訪客地址一律 `404`），因此剛才被 soft 掉的地址可以再升級為 hard：
 * - `soft` ＋ 已軟刪除 → **維持既有 `404`**（不重複標記、不改寫原 `deleted_at`，也**不得** 500）。
 * - `hard` ＋ 已軟刪除 → 與「對未刪除地址 hard」走同一段清除路徑（該列本來就即將被移除，
 *   故跳過多餘的 soft 更新步驟）；回應另帶 `previously_deleted: true` 供 caller 分辨。
 */
app.delete("/api/email-addresses/:id", requireOwner, async (c) => {
  const scope = c.get("scope");
  if (scope.kind !== "owner") return err(c, "FORBIDDEN", "owner only", 403);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return err(c, "INVALID_ID", "id 需為正整數", 400);

  const rawMode = c.req.query("mode");
  const mode = rawMode === undefined || rawMode === "" ? "soft" : rawMode;
  if (mode !== "soft" && mode !== "hard") {
    return err(c, "INVALID_MODE", 'mode 只能是 "soft" 或 "hard"（未帶＝soft）', 400);
  }

  // 1) 先 SELECT：只能操作自己名下的地址（他人／訪客的地址 → 404，不洩漏存在性）。
  //    `u.role = 'owner'` 為縱深防禦（同 D9）：訪客名下的地址走訪客管理，不從這裡刪。
  //    ⚠️ D11-5：**刻意不篩 `deleted_at`** —— 已軟刪除（垃圾桶）的列也要找得到，否則 soft 過的
  //    地址永遠無法升級為 hard，其信件與 R2 物件會一直殘留（D11 完成後的已知限制）。
  //    「未刪除」的篩選改由下方的 mode 判斷負責：soft 對已刪除的列維持既有 404，只有 hard 放行。
  const row = await c.env.DB.prepare(
    `SELECT a.id, a.email, a.user_id, a.deleted_at
       FROM email_addresses a JOIN users u ON u.id = a.user_id
      WHERE a.id = ?1 AND a.user_id = ?2 AND u.role = 'owner'`
  )
    .bind(id, scope.userId)
    .first<{ id: number; email: string; user_id: number; deleted_at: number | null }>();
  if (!row) return err(c, "NOT_FOUND", "address not found", 404);

  // D11-5：對已軟刪除的列做 soft → **明確且與既有相容的 404**（不重複標記、不改寫原 `deleted_at`，
  // 也絕不 500）；要清掉這類殘留列與其 R2 物件，唯一的升級路徑是下面的 `mode=hard`。
  const alreadyDeleted = row.deleted_at !== null;
  if (alreadyDeleted && mode === "soft") return err(c, "NOT_FOUND", "address not found", 404);

  const ts = now();
  /** soft 步驟：hard 也在同一交易內先做這一步（規格 D11-2 明文「在 soft 之後接續」；
   *  但對**已軟刪除**的列會跳過 —— 那個 UPDATE 只會改寫原本的 `deleted_at`，見 D11-5） */
  const softStep = c.env.DB.prepare(
    "UPDATE email_addresses SET status = 'deleted', deleted_at = ?1, updated_at = ?1 WHERE id = ?2"
  ).bind(ts, id);

  const auditBase = {
    event: "address_deleted",
    userId: row.user_id,
    addressId: row.id,
    ip: clientIp(c),
    userAgent: c.req.header("user-agent") ?? null,
  };
  const by = scope.userId; // 操作者＝目前的 owner session（rescue 亦為 owner id）

  // ── soft：只標記，保留信件與 R2（既有行為不變） ──
  if (mode === "soft") {
    const retained = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE address_id = ?1")
      .bind(id)
      .first<{ n: number }>();
    try {
      await softStep.run();
    } catch (e) {
      console.error("[atwhomail-api] address soft delete failed", { id, error: String(e) });
      return err(c, "DELETE_FAILED", "刪除失敗（已回滾，資料未變更）", 500);
    }
    auditAsync(c, {
      ...auditBase,
      detail: {
        by,
        address: row.email,
        mode: "soft",
        messages: 0, // soft 不刪任何信件
        messages_retained: Number(retained?.n ?? 0), // 仍保留在此地址下的信件數（供日後 hard 評估）
      },
    });
    return new Response(null, { status: 204 });
  }

  // ── hard：先收集「刪除後就查不到」的 R2 key，再以單一 batch 刪 D1 ──
  const { results: msgRows } = await c.env.DB.prepare(
    "SELECT raw_r2_key, html_r2_key FROM messages WHERE address_id = ?1"
  )
    .bind(id)
    .all<{ raw_r2_key: string | null; html_r2_key: string | null }>();
  const { results: attRows } = await c.env.DB.prepare(
    "SELECT r2_key FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE address_id = ?1)"
  )
    .bind(id)
    .all<{ r2_key: string | null }>();

  // 步驟以**名稱**索引（而非固定位置）：已軟刪除的列會少一個 soft 步驟（D11-5），
  // 用位置取值會在兩種路徑間錯位。
  const steps: Record<string, D1PreparedStatement> = {};
  if (!alreadyDeleted) steps.soft = softStep; // 1) 先 soft（與 soft 模式同一語意；已刪除的列跳過）
  steps.attachments = c.env.DB.prepare(
    "DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE address_id = ?1)"
  ).bind(id); // 2) 附件先於信件（FK）
  steps.messages = c.env.DB.prepare("DELETE FROM messages WHERE address_id = ?1").bind(id); // 3) 含所有資料夾與垃圾桶
  steps.aliases = c.env.DB.prepare("DELETE FROM email_aliases WHERE target_email_address_id = ?1").bind(id); // 4) 指向此地址的別名
  steps.address = c.env.DB.prepare("DELETE FROM email_addresses WHERE id = ?1").bind(id); // 5) 真正移除該列 → 釋放名稱
  steps.attempts = c.env.DB.prepare("DELETE FROM auth_attempts WHERE key = ?1").bind(`mailbox:${row.email}`); // 6) 登入失敗計數

  const stepNames = Object.keys(steps);
  let counts: Record<string, number>;
  try {
    const results = await c.env.DB.batch(stepNames.map((name) => steps[name]!));
    counts = Object.fromEntries(stepNames.map((name, i) => [name, Number(results[i]!.meta.changes ?? 0)]));
  } catch (e) {
    console.error("[atwhomail-api] address hard delete failed (rolled back)", { id, error: String(e) });
    return err(c, "DELETE_FAILED", "永久刪除失敗（已回滾，資料未變更）", 500);
  }
  const attachments = counts.attachments ?? 0;
  const messages = counts.messages ?? 0;
  const aliases = counts.aliases ?? 0;

  // R2 物件（best-effort；D1 列已刪 → 沒有 key 就沒有物件可達）
  const r2Keys = [
    ...msgRows.flatMap((m) => [m.raw_r2_key, m.html_r2_key]),
    ...attRows.map((a) => a.r2_key),
  ].filter((k): k is string => typeof k === "string" && k.length > 0);
  const r2Deleted = await deleteR2Objects(c.env.MAIL, r2Keys);

  auditAsync(c, {
    ...auditBase,
    detail: {
      by,
      address: row.email,
      mode: "hard",
      messages,
      attachments,
      aliases,
      r2_objects: r2Deleted,
      messages_retained: 0, // 該地址已不存在（名稱已釋放）
    },
  });
  return c.json({
    ok: true,
    id: row.id,
    email: row.email,
    mode: "hard",
    // D11-5：true ＝ 這是一次「從垃圾桶升級為永久刪除」（soft 過的列）；false ＝ 直接永久刪除。
    // 僅為新增欄位，既有呼叫端（D11-2）不受影響。
    previously_deleted: alreadyDeleted,
    deleted: { messages, attachments, aliases, r2_objects: r2Deleted },
  });
});

/** 密碼設定／重設：owner 免舊密碼；mailbox 本人需舊密碼（05 §2.2） */
app.patch("/api/email-addresses/:id/password", requireSession, async (c) => {
  const scope = c.get("scope");
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ new_password?: string; old_password?: string }>().catch(() => null);
  const pwErr = validatePasswordPolicy(body?.new_password ?? "");
  if (pwErr) return err(c, "WEAK_PASSWORD", pwErr, 422);

  const addr = await c.env.DB.prepare(
    "SELECT id, user_id, password_hash FROM email_addresses WHERE id = ?1 AND deleted_at IS NULL"
  )
    .bind(id)
    .first<{ id: number; user_id: number; password_hash: string | null }>();
  if (!addr) return err(c, "NOT_FOUND", "address not found", 404);

  if (scope.kind === "owner") {
    if (addr.user_id !== scope.userId) return err(c, "NOT_FOUND", "address not found", 404);
  } else {
    if (addr.id !== scope.addressId) return err(c, "NOT_FOUND", "address not found", 404);
    // 本人重設需舊密碼
    if (!addr.password_hash) return err(c, "NO_PASSWORD_SET", "此地址尚未設定密碼，請由 owner 設定", 403);
    const oldOk = typeof body?.old_password === "string" && (await verifyPassword(body.old_password, addr.password_hash));
    if (!oldOk) return err(c, "INVALID_OLD_PASSWORD", "舊密碼錯誤", 403);
  }

  const hash = await hashPassword(body!.new_password!);
  const ts = now();
  await c.env.DB.prepare(
    "UPDATE email_addresses SET password_hash = ?1, password_changed_at = ?2, updated_at = ?2 WHERE id = ?3"
  )
    .bind(hash, ts, id)
    .run();
  return c.json({ ok: true, id, has_password: true });
});

// ══════════════════════ Phase 8：Inbox / Mail（owner 或 mailbox scope）══════════════════════
app.get("/api/mail/inbox", requireSession, async (c) => {
  const scope = c.get("scope");
  const folder = c.req.query("folder") ?? "inbox";
  const allFolders = folder === "all"; // 跨資料夾（搜尋用）
  if (!allFolders && !FOLDERS.includes(folder)) {
    return err(c, "INVALID_FOLDER", "folder 必須是 inbox/sent/archive/trash/spam/all", 400);
  }
  const limitRaw = Number(c.req.query("limit") ?? 50);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 50, 1), 100);
  const cursor = c.req.query("cursor");
  const sw = scopeWhere(scope);

  let sql = `SELECT m.id, m.from_address AS "from", m.to_address, m.cc, m.subject, m.text_preview,
                    m.folder, m.read_at, m.received_at,
                    (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) AS att_count
             FROM messages m
             WHERE ${sw.sql} AND m.deleted_at IS NULL`;
  const binds: unknown[] = [...sw.binds];
  if (!allFolders) {
    sql += ` AND m.folder = ?`;
    binds.push(folder);
  }

  // 全文搜尋（MVP：LIKE；SQLite 對 ASCII 不分大小寫，CJK 無大小寫問題）
  const q = (c.req.query("q") ?? "").trim().slice(0, 200);
  if (q) {
    const pat = likePattern(q);
    sql += ` AND (m.subject LIKE ? ESCAPE '\\' OR m.from_address LIKE ? ESCAPE '\\' OR m.text_preview LIKE ? ESCAPE '\\')`;
    binds.push(pat, pat, pat);
  }

  // owner 專用：依地址過濾（mailbox 一律忽略 —— scope 已強制隔離）
  const addressIdRaw = c.req.query("address_id");
  if (addressIdRaw !== undefined && addressIdRaw !== "" && scope.kind === "owner") {
    const addressId = Number(addressIdRaw);
    if (!Number.isInteger(addressId) || addressId <= 0) {
      return err(c, "INVALID_ADDRESS_ID", "address_id 需為正整數", 400);
    }
    // N9：owner 只能過濾**自己名下**的地址；他人地址（例如訪客的）一律 404（不確認資源存在性）。
    //     這道檢查必須在下方的 SQL 之外獨立做——否則只會回空清單，掩蓋越權嘗試。
    const owned = await c.env.DB.prepare(
      "SELECT id FROM email_addresses WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL"
    )
      .bind(addressId, scope.userId)
      .first();
    if (!owned) return err(c, "MAIL_NOT_FOUND", "mail not found", 404);
    sql += ` AND m.address_id = ?`;
    binds.push(addressId);
  }

  if (cursor) {
    const m = /^(\d+)_(\d+)$/.exec(cursor);
    if (!m) return err(c, "BAD_CURSOR", "cursor 格式錯誤", 400);
    sql += ` AND (m.received_at < ? OR (m.received_at = ? AND m.id < ?))`;
    binds.push(Number(m[1]), Number(m[1]), Number(m[2]));
  }
  sql += ` ORDER BY m.received_at DESC, m.id DESC LIMIT ?`;
  binds.push(limit + 1);

  const { results } = await c.env.DB.prepare(sql).bind(...binds).all<any>();
  const hasMore = results.length > limit;
  const page = hasMore ? results.slice(0, limit) : results;
  const items = page.map((r) => ({
    id: r.id,
    from: r.from,
    subject: r.subject,
    text_preview: r.text_preview,
    received_at: r.received_at,
    read: r.read_at !== null,
    has_attachments: r.att_count > 0,
    folder: r.folder,
  }));
  const last = page[page.length - 1];
  return c.json({ items, nextCursor: hasMore && last ? `${last.received_at}_${last.id}` : null });
});

/**
 * GET /api/mail/counts — 側欄 badge：各 folder 總數與未讀；owner 另附各地址（僅 inbox）統計。
 * ⚠️ 必須註冊在 `/api/mail/:id` 之前，否則會被 :id 攔截。
 * sent 為寄件備份（read_at 恆為 NULL）→ 不計未讀。
 */
app.get("/api/mail/counts", requireSession, async (c) => {
  const scope = c.get("scope");
  const sw = scopeWhere(scope);
  const { results } = await c.env.DB.prepare(
    `SELECT m.folder AS folder,
            COUNT(*) AS total,
            SUM(CASE WHEN m.read_at IS NULL AND m.folder <> 'sent' THEN 1 ELSE 0 END) AS unread
     FROM messages m
     WHERE ${sw.sql} AND m.deleted_at IS NULL
     GROUP BY m.folder`
  )
    .bind(...sw.binds)
    .all<{ folder: string; total: number; unread: number }>();

  const folders: Record<string, { total: number; unread: number }> = {};
  for (const f of FOLDERS) folders[f] = { total: 0, unread: 0 };
  for (const r of results) folders[r.folder] = { total: Number(r.total), unread: Number(r.unread) };

  let addresses: Array<{ id: number; email: string; total: number; unread: number }> | null = null;
  if (scope.kind === "owner") {
    const { results: rows } = await c.env.DB.prepare(
      `SELECT a.id AS id, a.email AS email,
              COUNT(m.id) AS total,
              SUM(CASE WHEN m.id IS NOT NULL AND m.read_at IS NULL THEN 1 ELSE 0 END) AS unread
       FROM email_addresses a
       LEFT JOIN messages m ON m.address_id = a.id AND m.deleted_at IS NULL AND m.folder = 'inbox'
       WHERE a.user_id = ?1 AND a.deleted_at IS NULL
       GROUP BY a.id, a.email ORDER BY a.id`
    )
      .bind(scope.userId)
      .all<{ id: number; email: string; total: number; unread: number }>();
    addresses = rows.map((r) => ({ id: Number(r.id), email: r.email, total: Number(r.total), unread: Number(r.unread) }));
  }

  return c.json({ folders, addresses });
});

app.get("/api/mail/:id", requireSession, async (c) => {
  const scope = c.get("scope");
  const id = Number(c.req.param("id"));
  const sw = scopeWhere(scope);
  const row = await c.env.DB.prepare(
    `SELECT m.id, m.from_address AS "from", m.to_address, m.cc, m.subject, m.text_preview,
            m.folder, m.read_at, m.received_at, m.html_r2_key, m.message_id
     FROM messages m WHERE m.id = ? AND m.deleted_at IS NULL AND ${sw.sql}`
  )
    .bind(id, ...sw.binds)
    .first<any>();
  if (!row) return err(c, "MAIL_NOT_FOUND", "mail not found", 404);

  const atts = await c.env.DB.prepare(
    "SELECT id, filename, content_type, size_bytes FROM attachments WHERE message_id = ?1 ORDER BY id"
  )
    .bind(id)
    .all();

  return c.json({
    id: row.id,
    from: row.from,
    to: JSON.parse(row.to_address ?? "[]"),
    cc: JSON.parse(row.cc ?? "[]"),
    subject: row.subject,
    text_preview: row.text_preview,
    message_id: row.message_id,
    received_at: row.received_at,
    read_at: row.read_at,
    folder: row.folder,
    html_url: row.html_r2_key ? `/api/mail/${row.id}/html` : null,
    attachments: atts.results,
  });
});

/** 共用：取 scope 可見的訊息（不存在或越權 → null） */
async function scopedMessage(env: AuthEnv["Bindings"], scope: Scope, id: number, cols = "m.id") {
  const sw = scopeWhere(scope);
  return await env.DB.prepare(
    `SELECT ${cols} FROM messages m WHERE m.id = ? AND m.deleted_at IS NULL AND ${sw.sql}`
  )
    .bind(id, ...sw.binds)
    .first();
}

app.patch("/api/mail/:id/read", requireSession, async (c) => {
  const scope = c.get("scope");
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ read?: boolean }>().catch(() => null);
  if (!body || typeof body.read !== "boolean") return err(c, "INVALID_BODY", "body 需 { read: boolean }", 400);
  if (!(await scopedMessage(c.env, scope, id))) return err(c, "MAIL_NOT_FOUND", "mail not found", 404);
  await c.env.DB.prepare("UPDATE messages SET read_at = ?1, updated_at = ?2 WHERE id = ?3")
    .bind(body.read ? now() : null, now(), id)
    .run();
  return c.json({ id, read: body.read });
});

app.patch("/api/mail/:id/archive", requireSession, async (c) => {
  const scope = c.get("scope");
  const id = Number(c.req.param("id"));
  if (!(await scopedMessage(c.env, scope, id))) return err(c, "MAIL_NOT_FOUND", "mail not found", 404);
  await c.env.DB.prepare("UPDATE messages SET folder = 'archive', updated_at = ?1 WHERE id = ?2")
    .bind(now(), id)
    .run();
  return c.json({ id, folder: "archive" });
});

app.patch("/api/mail/:id/folder", requireSession, async (c) => {
  const scope = c.get("scope");
  const id = Number(c.req.param("id"));
  const body = await c.req.json<{ folder?: string }>().catch(() => null);
  if (!body || typeof body.folder !== "string") return err(c, "INVALID_BODY", "body 需 { folder }", 400);
  if (!FOLDERS.includes(body.folder) || body.folder === "sent") {
    return err(c, "INVALID_FOLDER", "folder 必須是 inbox/archive/trash/spam（sent 為系統用）", 400);
  }
  if (!(await scopedMessage(c.env, scope, id))) return err(c, "MAIL_NOT_FOUND", "mail not found", 404);
  await c.env.DB.prepare("UPDATE messages SET folder = ?1, updated_at = ?2 WHERE id = ?3")
    .bind(body.folder, now(), id)
    .run();
  return c.json({ id, folder: body.folder });
});

app.delete("/api/mail/:id", requireSession, async (c) => {
  const scope = c.get("scope");
  const id = Number(c.req.param("id"));
  if (!(await scopedMessage(c.env, scope, id))) return err(c, "MAIL_NOT_FOUND", "mail not found", 404);
  const ts = now();
  await c.env.DB.prepare("UPDATE messages SET folder = 'trash', deleted_at = ?1, updated_at = ?1 WHERE id = ?2")
    .bind(ts, id)
    .run();
  return new Response(null, { status: 204 });
});

// ══════════════════════ Phase 9b：HTML body ══════════════════════
app.get("/api/mail/:id/html", requireSession, async (c) => {
  const scope = c.get("scope");
  const id = Number(c.req.param("id"));
  const sw = scopeWhere(scope);
  const row = await c.env.DB.prepare(
    `SELECT m.id, m.html_r2_key FROM messages m WHERE m.id = ? AND m.deleted_at IS NULL AND ${sw.sql}`
  )
    .bind(id, ...sw.binds)
    .first<{ id: number; html_r2_key: string | null }>();
  if (!row) return err(c, "MAIL_NOT_FOUND", "mail not found", 404);
  if (!row.html_r2_key) return err(c, "HTML_NOT_AVAILABLE", "此信沒有 HTML 內文", 404);

  const obj = await c.env.MAIL.get(row.html_r2_key);
  if (!obj) return err(c, "NOT_FOUND", "html blob missing in R2", 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
});

/**
 * GET /api/mail/:id/text — 完整純文字內文（UI 讀信／回覆引言用）。
 * D1 只存 200 字 preview（email-handler preview()）：長度 < 200 可直接回；
 * 否則由 R2 的 raw .eml 以 postal-mime 解析（HTML-only 信件亦會自動轉出 text）。
 * R2 遺失／解析失敗 → 退回 preview，不回 500。scope 同其他信件端點（越權 404）。
 */
app.get("/api/mail/:id/text", requireSession, async (c) => {
  const scope = c.get("scope");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return err(c, "MAIL_NOT_FOUND", "mail not found", 404);
  const sw = scopeWhere(scope);
  const row = await c.env.DB.prepare(
    `SELECT m.id, m.text_preview, m.raw_r2_key FROM messages m
     WHERE m.id = ? AND m.deleted_at IS NULL AND ${sw.sql}`
  )
    .bind(id, ...sw.binds)
    .first<{ id: number; text_preview: string | null; raw_r2_key: string }>();
  if (!row) return err(c, "MAIL_NOT_FOUND", "mail not found", 404);

  // preview 只在 body > 200 字時才被截斷 → < 200 即為全文（含 null）
  if (row.text_preview === null || row.text_preview.length < 200) {
    return c.json({ id: row.id, text: row.text_preview });
  }

  const obj = await c.env.MAIL.get(row.raw_r2_key);
  if (!obj) return c.json({ id: row.id, text: row.text_preview });
  try {
    const parsed = await PostalMime.parse(await obj.arrayBuffer());
    return c.json({ id: row.id, text: parsed.text ?? row.text_preview });
  } catch (e) {
    console.error("[atwhomail-api] text parse failed", { id: row.id, error: String(e) });
    return c.json({ id: row.id, text: row.text_preview });
  }
});

// ══════════════════════ Phase 9：Attachment ══════════════════════
app.get("/api/mail/:id/attachments", requireSession, async (c) => {
  const scope = c.get("scope");
  const id = Number(c.req.param("id"));
  if (!(await scopedMessage(c.env, scope, id))) return err(c, "MAIL_NOT_FOUND", "mail not found", 404);
  const atts = await c.env.DB.prepare(
    "SELECT id, filename, content_type, size_bytes, disposition FROM attachments WHERE message_id = ?1 ORDER BY id"
  )
    .bind(id)
    .all();
  return c.json({ message_id: id, attachments: atts.results });
});

app.get("/api/attachments/:id", requireSession, async (c) => {
  const scope = c.get("scope");
  const id = Number(c.req.param("id"));
  const row = await c.env.DB.prepare(
    `SELECT a.id, a.filename, a.content_type, a.size_bytes, a.r2_key,
            m.owner_user_id, m.address_id, m.deleted_at AS m_deleted
     FROM attachments a JOIN messages m ON m.id = a.message_id WHERE a.id = ?1`
  )
    .bind(id)
    .first<any>();
  if (!row || row.m_deleted !== null || !scopeAllows(scope, row)) {
    return err(c, "NOT_FOUND", "attachment not found", 404);
  }

  const obj = await c.env.MAIL.get(row.r2_key);
  if (!obj) return err(c, "NOT_FOUND", "attachment blob missing in R2", 404);

  const filename = row.filename ?? "attachment";
  const filenameEnc = encodeURIComponent(filename).replace(/'/g, "%27");
  return new Response(obj.body, {
    headers: {
      "Content-Type": row.content_type ?? "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${filenameEnc}`,
      "Content-Length": String(row.size_bytes ?? 0),
      "Cache-Control": "private, no-store",
    },
  });
});

// ══════════════════════ Phase 10：寄信 ══════════════════════
app.post("/api/mail/send", requireSession, async (c) => {
  const scope = c.get("scope");
  const body = await c.req
    .json<{
      from?: string;
      to?: unknown;
      cc?: unknown;
      bcc?: unknown;
      subject?: string;
      html?: string;
      text?: string;
      attachments?: SendAttachment[];
    }>()
    .catch(() => null);
  if (!body) return err(c, "INVALID_BODY", "invalid JSON body", 400);

  // from 必須在 scope 內且 active（mailbox 只能用自己的地址）
  if (typeof body.from !== "string" || !body.from.includes("@")) {
    return err(c, "INVALID_FROM", "from 必填且需為完整地址", 400);
  }
  const fromEmail = body.from.trim().toLowerCase();
  type FromRow = {
    id: number;
    email: string;
    user_id: number;
    can_send: number;
    daily_send_quota: number;
    sent_today: number;
    quota_reset_at: number | null;
    created_at: number;
  };
  const fromCols = "id, email, user_id, can_send, daily_send_quota, sent_today, quota_reset_at, created_at";
  const fromAddr =
    scope.kind === "owner"
      ? await c.env.DB.prepare(
          `SELECT ${fromCols} FROM email_addresses
           WHERE email = ?1 AND user_id = ?2 AND status = 'active' AND deleted_at IS NULL`
        )
          .bind(fromEmail, scope.userId)
          .first<FromRow>()
      : await c.env.DB.prepare(
          `SELECT ${fromCols} FROM email_addresses
           WHERE email = ?1 AND id = ?2 AND status = 'active' AND deleted_at IS NULL`
        )
          .bind(fromEmail, scope.addressId)
          .first<FromRow>();
  if (!fromAddr) return err(c, "FROM_NOT_ALLOWED", "from 不屬於此 session 的 active 地址", 403);

  const toList = normalizeRecipients(body.to);
  if (toList.length === 0) return err(c, "INVALID_TO", "to 至少需要一個收件人", 400);
  const ccList = normalizeRecipients(body.cc);
  const bccList = normalizeRecipients(body.bcc);
  if (toList.length + ccList.length + bccList.length > 50) {
    return err(c, "TOO_MANY_RECIPIENTS", "to+cc+bcc 合計不得超過 50", 422);
  }
  if (!body.subject || typeof body.subject !== "string") return err(c, "INVALID_SUBJECT", "subject 必填", 400);
  if (!body.html && !body.text) return err(c, "INVALID_BODY", "html 與 text 至少要有一個", 400);

  const atts = Array.isArray(body.attachments) ? body.attachments : [];
  let estBytes = (body.html?.length ?? 0) + (body.text?.length ?? 0);
  for (const a of atts) {
    if (!a?.filename || !a?.content_base64) return err(c, "INVALID_ATTACHMENT", "附件需有 filename 與 content_base64", 400);
    estBytes += Math.floor((a.content_base64.length * 3) / 4);
  }
  if (estBytes > 5 * 1024 * 1024) {
    return err(c, "PAYLOAD_TOO_LARGE", `訊息總大小約 ${estBytes} bytes 超過 5 MiB 上限`, 413);
  }

  // ── Phase 1：帳號狀態與寄信配額（docs/13 §6.5、docs/14 §4.2；以下即判定順序）──
  // 置於既有輸入驗證之後、實際寄送之前：無效請求不消耗配額，且扣額與寄送相鄰（避免 TOCTOU）
  const auditCtx = {
    addressId: fromAddr.id,
    ip: clientIp(c),
    userAgent: c.req.header("user-agent") ?? null,
  };
  const ts0 = now();

  // 1) 帳號狀態（停權 → 立即擋）
  const acct = await c.env.DB.prepare("SELECT status FROM users WHERE id = ?1")
    .bind(fromAddr.user_id)
    .first<{ status: string }>();
  if (!acct || acct.status !== "active") {
    auditAsync(c, { ...auditCtx, event: "send_rejected_notallowed", detail: { reason: "ACCOUNT_SUSPENDED" } });
    return err(c, "ACCOUNT_SUSPENDED", "此帳號已停權，無法寄信", 403);
  }

  // 2) 寄信權限（安全閥 C8：can_send=0 → 秒級生效）
  if (fromAddr.can_send !== 1) {
    auditAsync(c, { ...auditCtx, event: "send_rejected_notallowed", detail: { reason: "SEND_NOT_ALLOWED" } });
    return err(c, "SEND_NOT_ALLOWED", "此地址目前不可寄信", 403);
  }

  // 3) 配額重置（每日 00:00 UTC）
  if (fromAddr.quota_reset_at === null || fromAddr.quota_reset_at <= ts0) {
    const d = new Date(ts0);
    const nextReset = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
    await c.env.DB.prepare(
      `UPDATE email_addresses SET sent_today = 0, quota_reset_at = ?1, updated_at = ?2
       WHERE id = ?3 AND (quota_reset_at IS NULL OR quota_reset_at <= ?2)`
    )
      .bind(nextReset, ts0, fromAddr.id)
      .run();
  }

  // 4) 暖機期（C2）：註冊後 WARMUP_HOURS 內 → 有效上限 = min(daily_send_quota, WARMUP_QUOTA)
  //    D5：地址若被 owner 設為 `warmup_exempt=1`（migration 0007）→ **跳過**暖機上限，
  //    但仍受 daily_send_quota（每日上限）約束；migration 未套用時此查詢回 false（行為不變）。
  const inWarmup = ts0 < Number(fromAddr.created_at) + QUOTA.WARMUP_HOURS * 3600_000;
  const warmupApplies = inWarmup && !(await isWarmupExempt(c.env.DB, fromAddr.id));
  const effectiveLimit = warmupApplies
    ? Math.min(Number(fromAddr.daily_send_quota), QUOTA.WARMUP_QUOTA)
    : Number(fromAddr.daily_send_quota);

  // 5) 原子扣配額（硬性要求：不得寫成「先 SELECT 再 UPDATE」→ 併發下才不會超額）
  const deduct = await c.env.DB.prepare(
    `UPDATE email_addresses
     SET sent_today = sent_today + 1, first_send_at = COALESCE(first_send_at, ?1), updated_at = ?1
     WHERE id = ?2 AND status = 'active' AND can_send = 1 AND sent_today < ?3`
  )
    .bind(ts0, fromAddr.id, effectiveLimit)
    .run();
  if (deduct.meta.changes !== 1) {
    auditAsync(c, {
      ...auditCtx,
      event: "send_rejected_quota",
      detail: { limit: effectiveLimit, warmup: warmupApplies },
    });
    return err(
      c,
      "QUOTA_EXCEEDED",
      `已達寄信上限（${effectiveLimit} 封／${warmupApplies ? "註冊後 24 小時暖機期" : "每日"}）`,
      429
    );
  }

  // 6) 每小時限流（C3）：以近 60 分鐘的寄件備份為計數來源
  const recent = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM messages WHERE address_id = ?1 AND folder = 'sent' AND received_at >= ?2`
  )
    .bind(fromAddr.id, ts0 - 3600_000)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= QUOTA.HOURLY_SEND_LIMIT) {
    await refundQuota(c.env.DB, fromAddr.id); // 步驟 5 已扣 → 此處未寄出，回補
    auditAsync(c, {
      ...auditCtx,
      event: "send_rejected_rate",
      detail: { hourly_limit: QUOTA.HOURLY_SEND_LIMIT, recent: recent?.n ?? 0 },
    });
    return err(c, "RATE_LIMITED", `每小時最多寄 ${QUOTA.HOURLY_SEND_LIMIT} 封，請稍後再試`, 429);
  }

  let result: { messageId: string };
  try {
    result = await c.env.EMAIL.send({
      from: fromAddr.email,
      to: toList,
      cc: ccList.length ? ccList : undefined,
      bcc: bccList.length ? bccList : undefined,
      subject: body.subject,
      html: body.html,
      text: body.text,
      attachments: atts.length
        ? atts.map((a) => ({
            content: a.content_base64,
            filename: a.filename,
            type: a.type || "application/octet-stream",
            disposition: "attachment" as const,
          }))
        : undefined,
    });
  } catch (e) {
    const code = (e as { code?: string })?.code ?? "SEND_FAILED";
    console.error("[atwhomail-api] send failed", { from: fromAddr.email, code, error: String(e) });
    await refundQuota(c.env.DB, fromAddr.id); // 未寄出 → 回補配額（避免誤扣）
    return err(c, "SEND_FAILED", `${code}: ${String(e)}`, 502);
  }

  // 寄件備份
  const ts = now();
  const d = new Date(ts);
  const key = `mail/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}.eml`;
  const eml =
    `From: ${fromAddr.email}\r\n` +
    `To: ${toList.join(", ")}\r\n` +
    (ccList.length ? `Cc: ${ccList.join(", ")}\r\n` : "") +
    `Subject: ${body.subject}\r\n` +
    `Date: ${d.toUTCString()}\r\n` +
    `Message-ID: <${result.messageId}>\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
    (body.text ?? (body.html ?? "").replace(/<[^>]+>/g, " "));
  try {
    await c.env.MAIL.put(key, new TextEncoder().encode(eml), {
      httpMetadata: { contentType: "message/rfc822" },
      customMetadata: { "d1-flag": "sent-copy" },
    });
  } catch (e) {
    console.error("[atwhomail-api] sent-copy R2 store failed", { key, error: String(e) });
  }

  const ownerId =
    scope.kind === "owner"
      ? scope.userId
      : (await c.env.DB.prepare("SELECT user_id FROM email_addresses WHERE id = ?1")
          .bind(scope.addressId)
          .first<{ user_id: number }>())?.user_id ?? 0;

  const preview = (body.text ?? (body.html ?? "").replace(/<[^>]+>/g, " ")).slice(0, 200);
  await c.env.DB.prepare(
    `INSERT INTO messages
       (owner_user_id, address_id, folder, message_id, from_address, to_address, cc,
        subject, text_preview, received_at, send_status, raw_r2_key, created_at, updated_at)
     VALUES (?, ?, 'sent', ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?)`
  )
    .bind(
      ownerId,
      fromAddr.id,
      result.messageId ?? null,
      fromAddr.email,
      JSON.stringify(toList.map((a) => ({ address: a, name: "" }))),
      JSON.stringify(ccList.map((a) => ({ address: a, name: "" }))),
      body.subject,
      preview,
      ts,
      key,
      ts,
      ts
    )
    .run();

  return c.json({ messageId: result.messageId, send_status: "sent", from: fromAddr.email, to: toList });
});

// ══════════════════════ Phase 13：增量備份（09 文件 §2）══════════════════════
/**
 * GET /api/backup/changes
 *   ?limit=500            每表最多回傳列數（1–1000）
 *   &c_messages=1789_42   各表游標（`updated_at_id`；省略 = 從頭）
 *
 * 認證：owner 身份（rescue token 或 owner JWT）。回傳含 password_hash，僅供維運/備份使用。
 * 分類：deleted（deleted_at 非 NULL）／created（created_at 晚於游標）／updated（其餘）
 */
app.get("/api/backup/changes", requireOwner, async (c) => {
  const limit = clampLimit(c.req.query("limit"));
  const created: Array<{ table: string; row: Record<string, unknown> }> = [];
  const updated: Array<{ table: string; row: Record<string, unknown> }> = [];
  const deleted: Array<{ table: string; row: Record<string, unknown> }> = [];
  const tables: Record<string, { cursor: string; more: boolean; rows: number }> = {};
  let hasMore = false;

  for (const t of BACKUP_TABLES) {
    const cur = parseCursor(c.req.query(`c_${t}`));
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM ${t}
       WHERE updated_at > ?1 OR (updated_at = ?1 AND id > ?2)
       ORDER BY updated_at ASC, id ASC
       LIMIT ?3`
    )
      .bind(cur.ts, cur.id, limit + 1)
      .all<Record<string, unknown>>();

    const more = results.length > limit;
    const rows = more ? results.slice(0, limit) : results;
    let next: Cursor = cur;
    for (const row of rows) {
      const ts = Number(row.updated_at);
      const id = Number(row.id);
      next = { ts, id };
      const entry = { table: t, row };
      const del = row.deleted_at !== null && row.deleted_at !== undefined;
      if (del) deleted.push(entry);
      else if (Number(row.created_at) > cur.ts) created.push(entry);
      else updated.push(entry);
    }
    tables[t] = { cursor: formatCursor(next), more, rows: rows.length };
    if (more) hasMore = true;
  }

  return c.json({ limit, tables, created, updated, deleted, hasMore });
});

// ══════════════════════ Phase 14：R2 → 本機磁碟（09 文件 §3）══════════════════════
const R2_KEY_RE = /^(mail|attachments)\/[A-Za-z0-9._/-]+$/;

/** GET /api/backup/r2/objects?prefix=mail/&limit=1000&after=<key>（列舉，供 Agent 比對） */
app.get("/api/backup/r2/objects", requireOwner, async (c) => {
  const prefix = c.req.query("prefix") ?? "";
  if (prefix !== "" && !prefix.startsWith("mail/") && !prefix.startsWith("attachments/")) {
    return err(c, "INVALID_PREFIX", "prefix 只能是 mail/ 或 attachments/ 開頭", 400);
  }
  const after = c.req.query("after");
  const limitRaw = Number(c.req.query("limit") ?? 1000);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : 1000, 1), 1000);

  const listed = await c.env.MAIL.list({ prefix, limit, ...(after ? { startAfter: after } : {}) });
  const objects = listed.objects.map((o) => ({
    key: o.key,
    size: o.size,
    etag: o.etag,
    uploaded: o.uploaded instanceof Date ? o.uploaded.getTime() : o.uploaded,
    sha256: (o.customMetadata?.sha256 as string | undefined) ?? null,
  }));
  return c.json({ objects, truncated: listed.truncated, after: objects.length > 0 ? objects[objects.length - 1]!.key : null });
});

/** GET /api/backup/r2/object?key=mail/2026/09/x.eml（下載原始位元組） */
app.get("/api/backup/r2/object", requireOwner, async (c) => {
  const key = c.req.query("key");
  if (!key || !R2_KEY_RE.test(key)) return err(c, "INVALID_KEY", "key 格式不合法（僅 mail/ 或 attachments/）", 400);
  const obj = await c.env.MAIL.get(key);
  if (!obj) return err(c, "NOT_FOUND", "object not found in R2", 404);
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "Content-Length": String(obj.size),
      "x-backup-etag": obj.etag ?? "",
      "x-backup-sha256": (obj.customMetadata?.sha256 as string | undefined) ?? "",
    },
  });
});

export default app;
