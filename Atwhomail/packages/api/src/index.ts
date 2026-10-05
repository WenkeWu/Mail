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
import { Hono } from "hono";
import {
  hashPassword,
  verifyPassword,
  validatePasswordPolicy,
  signOwnerToken,
  signMailboxToken,
  checkLocked,
  recordFailure,
  clearFailures,
  requireOwner,
  requireSession,
  resolveScope,
  type AuthEnv,
  type Scope,
} from "./auth";
import { BACKUP_TABLES, clampLimit, formatCursor, parseCursor, type Cursor } from "./backup";

const app = new Hono<AuthEnv>();

// ── 安全標頭（08 §23）：API 只回 JSON／二進位，禁快取、禁 iframe、禁 MIME 猜測 ──
app.use("*", async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  h.set("X-Frame-Options", "DENY");
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  h.set("Cross-Origin-Resource-Policy", "same-origin");
  if (!h.has("Content-Security-Policy")) h.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
});

const DOMAIN = "atwho.org";
const LOCAL_PART_RE = /^[a-z0-9][a-z0-9._-]*[a-z0-9]$|^[a-z0-9]$/i;
const FOLDERS = ["inbox", "sent", "archive", "trash", "spam"];
const now = () => Date.now();

function err(c: { json: (x: unknown, s?: number) => Response }, code: string, message: string, status = 400): Response {
  return c.json({ error: { code, message } }, status);
}

async function getOwnerId(db: D1Database): Promise<number | null> {
  const row = await db.prepare("SELECT id FROM users WHERE username = 'owner'").first<{ id: number }>();
  return row ? row.id : null;
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
app.post("/api/auth/login", async (c) => {
  const body = await c.req.json<{ username?: string; password?: string }>().catch(() => null);
  if (!body?.username || !body?.password) return err(c, "INVALID_BODY", "username 與 password 必填", 400);
  const username = body.username.trim().toLowerCase();
  const key = `owner:${username}`;

  const lockedUntil = await checkLocked(c.env.DB, key);
  if (lockedUntil) return err(c, "LOCKED", `嘗試次數過多，請於 ${new Date(lockedUntil).toISOString()} 後再試`, 429);

  const user = await c.env.DB.prepare(
    "SELECT id, username, password_hash, status, password_changed_at FROM users WHERE username = ?1"
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
    "SELECT id, email, password_hash, status, password_changed_at FROM email_addresses WHERE email = ?1 AND deleted_at IS NULL"
  )
    .bind(email)
    .first<{ id: number; email: string; password_hash: string | null; status: string; password_changed_at: number }>();

  const okPw =
    addr && addr.status === "active" && addr.password_hash
      ? await verifyPassword(body.password, addr.password_hash)
      : false;
  if (!addr || !okPw) {
    await recordFailure(c.env.DB, key);
    return err(c, "INVALID_CREDENTIALS", "地址或密碼錯誤", 401);
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
  const exists = await c.env.DB.prepare("SELECT id FROM email_addresses WHERE email = ?1 AND deleted_at IS NULL")
    .bind(email)
    .first();
  if (exists) return err(c, "ADDRESS_EXISTS", "address already exists", 409);

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
  const { results } = await c.env.DB.prepare(
    `SELECT id, email, status, (password_hash IS NOT NULL) AS has_password, created_at, updated_at
     FROM email_addresses WHERE user_id = ? AND deleted_at IS NULL ORDER BY id`
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

app.delete("/api/email-addresses/:id", requireOwner, async (c) => {
  const scope = c.get("scope");
  if (scope.kind !== "owner") return err(c, "FORBIDDEN", "owner only", 403);
  const id = Number(c.req.param("id"));
  const row = await c.env.DB.prepare(
    "SELECT id FROM email_addresses WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL"
  )
    .bind(id, scope.userId)
    .first();
  if (!row) return err(c, "NOT_FOUND", "address not found", 404);
  const ts = now();
  await c.env.DB.prepare(
    "UPDATE email_addresses SET status = 'deleted', deleted_at = ?1, updated_at = ?1 WHERE id = ?2"
  )
    .bind(ts, id)
    .run();
  return new Response(null, { status: 204 });
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
  if (!FOLDERS.includes(folder)) return err(c, "INVALID_FOLDER", "folder 必須是 inbox/sent/archive/trash/spam", 400);
  const limitRaw = Number(c.req.query("limit") ?? 50);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 50, 1), 100);
  const cursor = c.req.query("cursor");
  const sw = scopeWhere(scope);

  let sql = `SELECT m.id, m.from_address AS "from", m.to_address, m.cc, m.subject, m.text_preview,
                    m.folder, m.read_at, m.received_at,
                    (SELECT COUNT(*) FROM attachments a WHERE a.message_id = m.id) AS att_count
             FROM messages m
             WHERE ${sw.sql} AND m.folder = ? AND m.deleted_at IS NULL`;
  const binds: unknown[] = [...sw.binds, folder];
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
  const fromAddr =
    scope.kind === "owner"
      ? await c.env.DB.prepare(
          `SELECT id, email FROM email_addresses
           WHERE email = ?1 AND user_id = ?2 AND status = 'active' AND deleted_at IS NULL`
        )
          .bind(fromEmail, scope.userId)
          .first<{ id: number; email: string }>()
      : await c.env.DB.prepare(
          `SELECT id, email FROM email_addresses
           WHERE email = ?1 AND id = ?2 AND status = 'active' AND deleted_at IS NULL`
        )
          .bind(fromEmail, scope.addressId)
          .first<{ id: number; email: string }>();
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
