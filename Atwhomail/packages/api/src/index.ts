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
import type { ContentfulStatusCode } from "hono/utils/http-status";
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
import { localPartAvailability, suggestAvailableLabels } from "./domains";
import {
  buildFormStaticText,
  sanitizeDisplayText,
  validateFormPayload,
  validateFormSchema,
  type JsonObject,
} from "./forms";
import { sanitizeHtml } from "./sanitize";

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

// ── D25（docs/25）：別名 Phase 1 ──
/**
 * 使用者輸入的別名「名字」：3–12 個英文字母（不接受數字／符號），儲存一律小寫。
 * 流水號（3 位，001–999）由系統附加，所以使用者輸入**不得**含數字。
 */
const ALIAS_NAME_RE = /^[a-z]{3,12}$/;
/** 保留字（小寫比對）：不可作為別名名稱（docs/25 §1） */
const ALIAS_RESERVED_NAMES = new Set([
  "admin",
  "postmaster",
  "abuse",
  "root",
  "noreply",
  "mailerdaemon",
  "hostmaster",
  "webmaster",
  "support",
]);
/** 每個帳號的別名數量上限（docs/25 §3.1） */
const ALIAS_MAX_PER_ACCOUNT = 50;
/** 每個名字的流水號上限（001–999；docs/25 §1） */
const ALIAS_SERIAL_MAX = 999;

/**
 * 由名字與流水號組出別名「地址」：`luke` ＋ 1 → `luke001`（local part），
 * 完整地址為 `luke001@atwho.org`（docs/24 §3.1、docs/25 §6 的範例皆含網域）。
 * ⚠️ 規格 §3.1 的公式寫成 `name + '0' + zeroPad3(serial)`，但同節與 T109／T110 的
 *    範例皆是 `luke001`／`luke002`；「固定 0」即 3 位流水號的前導零。此處以範例為準。
 */
function aliasAddressFor(name: string, serial: number): string {
  return `${name}${String(serial).padStart(3, "0")}@${DOMAIN}`;
}

/** 驗證使用者輸入的名字；合法 → 小寫名字，否則 null（錯誤碼由呼叫端統一為 INVALID_ALIAS_NAME） */
function normalizeAliasName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().toLowerCase();
  if (!ALIAS_NAME_RE.test(name)) return null;
  if (ALIAS_RESERVED_NAMES.has(name)) return null;
  return name;
}

/** 取得 session 所屬「帳號」的 user id（別名數量上限以帳號計，不是以單一地址計） */
async function accountUserIdForScope(db: D1Database, scope: Scope): Promise<number | null> {
  if (scope.kind === "owner") return scope.userId;
  const row = await db
    .prepare("SELECT user_id FROM email_addresses WHERE id = ?1")
    .bind(scope.addressId)
    .first<{ user_id: number }>();
  return row ? Number(row.user_id) : null;
}
/** D19-2：批次動作與上限（docs/19 §3） */
const BATCH_ACTIONS = ["trash", "restore", "read", "purge"] as const;
type BatchAction = (typeof BATCH_ACTIONS)[number];
const BATCH_MAX_IDS = 200;
/**
 * D19-5：D1 每條查詢最多 **100 個綁定參數**（超過 → `too many SQL variables`）。
 * 所有 `id IN (?,?,…)` 一律以此為塊大小，保留 10 個參數的安全餘裕。
 */
const SQL_CHUNK = 90;
/** D19-1：清空垃圾桶單次上限（超過 → 400，要求分批） */
const TRASH_EMPTY_MAX = 500;
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

// ══════════════════════ 本地直送（docs/18 P1）══════════════════════

interface LocalRecipient {
  id: number;
  user_id: number;
  email: string;
}

/** 04 文件：mail/YYYY/MM/<uuid>.eml（YYYY/MM = UTC） */
function buildMailKey(d: Date): string {
  return `mail/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}.eml`;
}

/** 檔名 sanitize：去路徑／控制字元，保留安全字元集；空檔名給 fallback */
function sanitizeFilename(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 && cleaned !== "." && cleaned !== ".." ? cleaned : fallback;
}

function decodeBase64(input: string): Uint8Array {
  const bin = atob(input);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 純文字 .eml（寄件備份與本地直送共用；供 /api/mail/:id/text 解析） */
function buildPlainEml(input: {
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  date: Date;
  messageId: string;
  text: string;
  /** 額外標頭（例如互動式表單的**非權威**提示標記） */
  extraHeaders?: string[];
}): string {
  return (
    `From: ${input.from}\r\n` +
    `To: ${input.to.join(", ")}\r\n` +
    (input.cc.length ? `Cc: ${input.cc.join(", ")}\r\n` : "") +
    `Subject: ${input.subject}\r\n` +
    `Date: ${input.date.toUTCString()}\r\n` +
    `Message-ID: <${input.messageId}>\r\n` +
    (input.extraHeaders?.length ? `${input.extraHeaders.join("\r\n")}\r\n` : "") +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
    input.text
  );
}

/**
 * 收件人是否全部為「本網域 ＋ 存在 ＋ active」。
 *
 * 回傳 Map = 可本地直送；回傳 null = 不適用（含任何外部地址，或本網域但不存在／停用／刪除）。
 * 後者維持既有 `EMAIL.send()` 行為（零回歸）；本地直送只發生在**全部**收件人都可驗證時。
 */
async function resolveLocalRecipients(
  db: D1Database,
  emails: string[]
): Promise<Map<string, LocalRecipient> | null> {
  if (emails.length === 0) return null;
  if (!emails.every((e) => e.toLowerCase().endsWith(`@${DOMAIN}`))) return null;
  const placeholders = emails.map((_, i) => `?${i + 1}`).join(",");
  const { results } = await db
    .prepare(
      `SELECT id, user_id, email FROM email_addresses
       WHERE email IN (${placeholders}) AND status = 'active' AND deleted_at IS NULL`
    )
    .bind(...emails)
    .all<LocalRecipient>();
  if (results.length !== emails.length) return null;
  return new Map(results.map((r) => [r.email.toLowerCase(), r]));
}

/**
 * 本地直送（docs/18 §3.1 模式 a）：不呼叫 `EMAIL.send()`，直接寫入每位收件人的 messages。
 *
 * 每位收件人都有**自己的** raw .eml／HTML／附件 R2 物件 —— 刻意不共用 key，
 * 否則日後任一收件人永久刪除地址時會把其他人的內容一起刪掉。
 * 附件 R2／D1 失敗只記 log（與收信端一致，不讓整封信失敗）；messages 本體以單一 batch 建立。
 */
async function deliverLocalMail(
  env: Env,
  input: {
    from: string;
    recipients: LocalRecipient[];
    to: string[];
    cc: string[];
    subject: string;
    html?: string;
    text: string;
    attachments: SendAttachment[];
    messageId: string;
    ts: number;
  }
): Promise<void> {
  const d = new Date(input.ts);
  const toJson = JSON.stringify(input.to.map((address) => ({ address, name: "" })));
  const ccJson = JSON.stringify(input.cc.map((address) => ({ address, name: "" })));

  // 附件先解碼一次（base64 → bytes）；R2 物件仍為每位收件人各存一份。
  const decodedAtts = input.attachments.map((a, i) => {
    const bytes = decodeBase64(a.content_base64);
    return {
      filename: a.filename || `attachment-${i + 1}`,
      storedName: sanitizeFilename(a.filename || "", `attachment-${i + 1}`),
      type: a.type || "application/octet-stream",
      bytes,
      index: i,
    };
  });

  const sanitizedHtml = input.html ? await sanitizeHtml(input.html) : "";
  const inserts: D1PreparedStatement[] = [];
  const prepared: Array<{ recipient: LocalRecipient; key: string; htmlKey: string | null }> = [];

  for (const recipient of input.recipients) {
    const key = buildMailKey(d);
    const uuid = key.split("/")[3]!.replace(/\.eml$/, "");
    const eml = buildPlainEml({
      from: input.from,
      to: input.to,
      cc: input.cc,
      subject: input.subject,
      date: d,
      messageId: input.messageId,
      text: input.text,
    });
    try {
      await env.MAIL.put(key, new TextEncoder().encode(eml), {
        httpMetadata: { contentType: "message/rfc822" },
        customMetadata: { "d1-address-id": String(recipient.id), "d1-flag": "local-delivery" },
      });
    } catch (e) {
      // raw .eml 缺失時仍可讀 preview；不讓單一 R2 失敗阻斷本地投遞
      console.error("[atwhomail-api] local raw store failed", { key, error: String(e) });
    }

    let htmlKey: string | null = null;
    if (sanitizedHtml.trim().length > 0) {
      const k = key.replace(/\.eml$/, ".html");
      try {
        await env.MAIL.put(k, new TextEncoder().encode(sanitizedHtml), {
          httpMetadata: { contentType: "text/html; charset=utf-8" },
          customMetadata: { "d1-address-id": String(recipient.id), "d1-flag": "local-delivery" },
        });
        htmlKey = k;
      } catch (e) {
        console.error("[atwhomail-api] local html store failed", { key: k, error: String(e) });
      }
    }

    inserts.push(
      env.DB.prepare(
        `INSERT INTO messages
           (owner_user_id, address_id, folder, message_id, from_address, to_address, cc,
            subject, text_preview, received_at, raw_r2_key, html_r2_key, created_at, updated_at,
            origin, kind, delivery_scope)
         VALUES (?1, ?2, 'inbox', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?9, ?9,
                 'internal', 'normal', 'internal')`
      ).bind(
        recipient.user_id,
        recipient.id,
        input.messageId,
        input.from,
        toJson,
        ccJson,
        input.subject,
        input.text.slice(0, 200),
        input.ts,
        key,
        htmlKey
      )
    );
    prepared.push({ recipient, key, htmlKey });
  }

  const results = await env.DB.batch(inserts);

  // 附件：每位收件人各自的 message id 與 R2 key（失敗只記 log，與收信端一致）
  const attInserts: D1PreparedStatement[] = [];
  for (let r = 0; r < results.length; r += 1) {
    const messageRowId = Number(results[r]!.meta.last_row_id);
    const { key } = prepared[r]!;
    const uuid = key.split("/")[3]!.replace(/\.eml$/, "");
    for (const att of decodedAtts) {
      const stored = `${att.index}-${att.storedName}`;
      const r2Key = `attachments/${uuid}/${stored}`;
      try {
        const sha = await sha256Hex(att.bytes);
        await env.MAIL.put(r2Key, att.bytes, {
          httpMetadata: { contentType: att.type },
          customMetadata: { "d1-message-id": String(messageRowId) },
        });
        attInserts.push(
          env.DB.prepare(
            `INSERT INTO attachments
               (message_id, filename, stored_filename, content_type, size_bytes, r2_key, sha256, disposition, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'attachment', ?8, ?8)`
          ).bind(messageRowId, att.filename, stored, att.type, att.bytes.byteLength, r2Key, sha, input.ts)
        );
      } catch (e) {
        console.error("[atwhomail-api] local attachment store failed", { messageRowId, r2Key, error: String(e) });
      }
    }
  }
  if (attInserts.length > 0) {
    try {
      await env.DB.batch(attInserts);
    } catch (e) {
      console.error("[atwhomail-api] local attachment rows failed", { error: String(e) });
    }
  }
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

// ══════════════════════ D21：Email 驗證碼註冊（docs/21）══════════════════════

const REGISTRATION_MODE_VALUES = ["invite", "email_verify", "closed"] as const;
type RegistrationMode = (typeof REGISTRATION_MODE_VALUES)[number];

/** `REGISTRATION_MODE`（Worker var；預設 invite＝既有邀請碼流程）。非法值視為 invite（向後相容）。 */
function registrationMode(env: Env): RegistrationMode {
  const raw = (env.REGISTRATION_MODE ?? "").trim().toLowerCase();
  return (REGISTRATION_MODE_VALUES as readonly string[]).includes(raw) ? (raw as RegistrationMode) : "invite";
}

/** 舊版全站註冊開關（保留相容；設 true 時新舊流程一併關閉） */
function legacyRegistrationDisabled(env: Env): boolean {
  return (env.REGISTRATION_DISABLED ?? "").trim().toLowerCase() === "true";
}

/** 驗證碼有效期 15 分鐘（docs/21 §5） */
const EMAIL_CODE_TTL_MS = 15 * 60 * 1000;
/** 同一驗證碼最多錯誤 5 次（第 5 次即作廢，docs/21 §5） */
const EMAIL_CODE_MAX_ATTEMPTS = 5;
/** 同一 Email 60 秒內只能寄一次（docs/21 §5） */
const EMAIL_CODE_RESEND_COOLDOWN_MS = 60 * 1000;
/** 同一 IP 每小時／每日的「註冊嘗試」上限（docs/21 §2） */
const REGISTER_IP_HOURLY_LIMIT = 5;
const REGISTER_IP_DAILY_LIMIT = 20;
/** 同一 Email 每日驗證碼寄送上限（docs/21 §2） */
const REGISTER_EMAIL_DAILY_LIMIT = 5;
/** D20：`POST /api/auth/check-id` 同一 IP 每分鐘上限（docs/20 §3.3） */
const CHECK_ID_IP_MINUTE_LIMIT = 20;

/**
 * 保留字與 ID 判定已集中到 `domains.ts`（D20）：
 * - 保留字／`id_blocklist`／既有地址／二級網域 → `localPartAvailability()`
 * - 建議名稱 → `suggestAvailableLabels()`
 * - 流水號配發 → `assignAvailableLocalPart()`
 */

/** 基本 Email 格式（僅供收件；不做 DNS／寄達驗證） */
const EMAIL_ADDRESS_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Email 正規化：trim ＋ 小寫（docs/21 §3）；格式不符 → null */
function normalizeEmailAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  return EMAIL_ADDRESS_RE.test(email) ? email : null;
}

/** 6 位數驗證碼：crypto.getRandomValues ＋ 拒絕取樣（避免 modulo bias） */
function generateEmailCode(): string {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  let value = limit;
  while (value >= limit) {
    crypto.getRandomValues(buf);
    value = buf[0]!;
  }
  return String(value % 1_000_000).padStart(6, "0");
}

/** DB 只存 SHA-256(code + JWT_SECRET)（docs/21 §5；不存明碼） */
async function hashEmailCode(code: string, jwtSecret: string | undefined): Promise<string> {
  return sha256Hex(new TextEncoder().encode(`${code}${jwtSecret ?? ""}`));
}

/** 常數時間比較（避免以回應時間猜碼） */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 固定視窗 key（UTC）：IP 每小時用主 key（隨小時重置），每日加上日期後綴 */
function registrationDayKey(ip: string | null, ts: number): string {
  return `register:${ip ?? "unknown"}:d:${Math.floor(ts / 86_400_000)}`;
}

/**
 * IP 每小時限流：**key 就是 `register:<ip>`**（docs/21 §5）。
 * `updated_at` 落在不同小時 → 視為新視窗，`fail_count` 從 1 重新起算；
 * 同一小時內 `fail_count` 已達上限 → 不更新（changes=0）。
 */
async function claimIpHourlyCounter(db: D1Database, ip: string | null, ts: number): Promise<boolean> {
  const hourStart = Math.floor(ts / 3_600_000) * 3_600_000;
  const res = await db
    .prepare(
      `INSERT INTO auth_attempts (key, fail_count, locked_until, updated_at)
       VALUES (?1, 1, 0, ?2)
       ON CONFLICT(key) DO UPDATE SET
         fail_count = CASE WHEN auth_attempts.updated_at < ?3 THEN 1 ELSE auth_attempts.fail_count + 1 END,
         updated_at = ?2
       WHERE auth_attempts.updated_at < ?3 OR auth_attempts.fail_count < ?4`
    )
    .bind(`register:${ip ?? "unknown"}`, ts, hourStart, REGISTER_IP_HOURLY_LIMIT)
    .run();
  return res.meta.changes === 1;
}

/**
 * 原子計數：只有 `fail_count < limit` 才 +1（併發下不會超額）。
 * 以 `ON CONFLICT … DO UPDATE … WHERE` 實作「檢查＋扣次」單一步驟。
 */
async function claimRegistrationCounter(db: D1Database, key: string, limit: number, ts: number): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO auth_attempts (key, fail_count, locked_until, updated_at)
       VALUES (?1, 1, 0, ?2)
       ON CONFLICT(key) DO UPDATE SET fail_count = fail_count + 1, updated_at = ?2
       WHERE auth_attempts.fail_count < ?3`
    )
    .bind(key, ts, limit)
    .run();
  return res.meta.changes === 1;
}

/**
 * D20：`check-id` 的 IP 每分鐘限流（固定視窗 UTC；沿用 `auth_attempts`）。
 * `updated_at` 落在不同分鐘 → 視為新視窗，`fail_count` 從 1 重新起算。
 */
async function claimCheckIdMinuteCounter(db: D1Database, ip: string | null, ts: number): Promise<boolean> {
  const minuteStart = Math.floor(ts / 60_000) * 60_000;
  const res = await db
    .prepare(
      `INSERT INTO auth_attempts (key, fail_count, locked_until, updated_at)
       VALUES (?1, 1, 0, ?2)
       ON CONFLICT(key) DO UPDATE SET
         fail_count = CASE WHEN auth_attempts.updated_at < ?3 THEN 1 ELSE auth_attempts.fail_count + 1 END,
         updated_at = ?2
       WHERE auth_attempts.updated_at < ?3 OR auth_attempts.fail_count < ?4`
    )
    .bind(`check-id:${ip ?? "unknown"}`, ts, minuteStart, CHECK_ID_IP_MINUTE_LIMIT)
    .run();
  return res.meta.changes === 1;
}

/**
 * Email 冷卻（60 秒）：原子搶佔，成功＝現在可以寄。
 * `locked_until` 在此列代表「下次可寄時間」（不是登入鎖定）。
 */
async function claimEmailResendSlot(
  db: D1Database,
  email: string,
  ts: number
): Promise<{ ok: true } | { ok: false; retryAfterMs: number }> {
  const key = `register:${email}`;
  const res = await db
    .prepare(
      `INSERT INTO auth_attempts (key, fail_count, locked_until, updated_at)
       VALUES (?1, 1, ?2, ?3)
       ON CONFLICT(key) DO UPDATE SET fail_count = fail_count + 1, locked_until = ?2, updated_at = ?3
       WHERE auth_attempts.locked_until <= ?3`
    )
    .bind(key, ts + EMAIL_CODE_RESEND_COOLDOWN_MS, ts)
    .run();
  if (res.meta.changes === 1) return { ok: true };
  const row = await db
    .prepare("SELECT locked_until FROM auth_attempts WHERE key = ?1")
    .bind(key)
    .first<{ locked_until: number }>();
  return { ok: false, retryAfterMs: Math.max(0, Number(row?.locked_until ?? 0) - ts) };
}

/** 寄送失敗／未寄出 → 釋放 60 秒冷卻（避免使用者沒收到信卻要空等） */
async function releaseEmailResendSlot(db: D1Database, email: string): Promise<void> {
  await db
    .prepare("UPDATE auth_attempts SET locked_until = 0, updated_at = ?1 WHERE key = ?2")
    .bind(now(), `register:${email}`)
    .run()
    .catch(() => undefined);
}

/** 同一 Email 每日 5 封（原子計數） */
async function claimEmailDailySlot(db: D1Database, email: string, ts: number): Promise<boolean> {
  return claimRegistrationCounter(
    db,
    `register:${email}:d:${Math.floor(ts / 86_400_000)}`,
    REGISTER_EMAIL_DAILY_LIMIT,
    ts
  );
}

/** 退還 Email 每日計數（寄送失敗時） */
async function releaseEmailDailySlot(db: D1Database, email: string, ts: number): Promise<void> {
  await db
    .prepare(
      `UPDATE auth_attempts
       SET fail_count = CASE WHEN fail_count > 0 THEN fail_count - 1 ELSE 0 END, updated_at = ?1
       WHERE key = ?2`
    )
    .bind(now(), `register:${email}:d:${Math.floor(ts / 86_400_000)}`)
    .run()
    .catch(() => undefined);
}

/** 驗證碼信：寄件者 noreply@atwho.org；內容只有 6 位數＋15 分鐘說明（不含任何個資） */
async function sendRegistrationEmail(env: Env, to: string, code: string): Promise<void> {
  const text =
    `您的 AtWhoMail 註冊驗證碼是：\n\n${code}\n\n` +
    `此驗證碼 15 分鐘內有效，請勿轉交給他人。若您沒有申請註冊，請忽略本信。`;
  const html =
    `<p>您的 AtWhoMail 註冊驗證碼是：</p>` +
    `<p style="font-size:24px;letter-spacing:4px"><strong>${code}</strong></p>` +
    `<p>此驗證碼 15 分鐘內有效，請勿轉交給他人。若您沒有申請註冊，請忽略本信。</p>`;
  await env.EMAIL.send({
    from: "noreply@atwho.org",
    to: [to],
    subject: "AtWhoMail 註冊驗證碼",
    text,
    html,
  });
}

/**
 * 寫 `register_rejected` 稽核並回錯誤。
 * ⚠️ detail **只放 reason 與 local_part**（不含 Email、密碼、驗證碼；docs/21 §5）。
 */
function auditRegistrationRejected(
  c: Context<AuthEnv>,
  opts: {
    code: string;
    status: ContentfulStatusCode;
    reason: string;
    localPart: string | null;
    message: string;
    /** 額外的錯誤欄位（例：`ID_MATCHES_DOMAIN` 的 `suggestions`） */
    extra?: Record<string, unknown>;
  }
): Response {
  auditAsync(c, {
    event: "register_rejected",
    ip: clientIp(c),
    userAgent: c.req.header("user-agent") ?? null,
    detail: { reason: opts.reason, local_part: opts.localPart },
  });
  if (opts.extra) {
    return c.json({ error: { code: opts.code, message: opts.message, ...opts.extra } }, opts.status);
  }
  return err(c, opts.code, opts.message, opts.status);
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
  const env = c.env;

  // D21（docs/21 §4）：REGISTRATION_MODE 分流。預設 invite → 以下既有邀請碼流程**完全不變**。
  const mode = registrationMode(env);
  if (mode === "closed") {
    return err(c, "REGISTRATION_CLOSED", "目前未開放註冊", 403);
  }
  if (mode === "email_verify") {
    return err(c, "REGISTRATION_EMAIL_VERIFY_REQUIRED", "請改用 Email 驗證碼完成註冊", 403);
  }

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

// ══════════════════════ D21：Email 驗證碼註冊（公開，docs/21）══════════════════════

/**
 * GET /api/auth/registration-mode — 公開（docs/21 §6）。
 *
 * 前端用它決定註冊表單要顯示「邀請碼」還是「Email 驗證碼」。
 * ⚠️ 只影響 UI；真正的模式判定仍在各註冊端點由後端強制（前端不可信）。
 * 舊版 `REGISTRATION_DISABLED=true` 一律回 `closed`（與既有 kill switch 相容）。
 */
app.get("/api/auth/registration-mode", (c) => {
  const mode = registrationMode(c.env);
  const effective: RegistrationMode =
    mode === "closed" || legacyRegistrationDisabled(c.env) ? "closed" : mode;
  return c.json({ mode: effective });
});

/**
 * POST /api/auth/check-id — 公開（D20，docs/20 §3.3）。
 *
 * 前端註冊表的 ID 欄位 debounce 500ms 後呼叫；**只影響顯示**，
 * 送出時 `register-request`／`register-verify` 仍會由後端複驗（N3）。
 *
 * 限流：同 IP 每分鐘 20 次（沿用 `auth_attempts`）→ 429 `RATE_LIMITED`。
 * 回應：`{ available, reason, tldHit?, suggestions? }`
 */
app.post("/api/auth/check-id", async (c) => {
  const ts = now();
  const ip = clientIp(c);

  // 先計數再解析 body：格式錯誤的請求同樣受限
  if (!(await claimCheckIdMinuteCounter(c.env.DB, ip, ts))) {
    return err(c, "RATE_LIMITED", `查詢次數過多（每分鐘上限 ${CHECK_ID_IP_MINUTE_LIMIT} 次），請稍後再試`, 429);
  }

  const body = await c.req.json<{ label?: unknown }>().catch(() => null);
  const label = typeof body?.label === "string" ? body.label.trim().toLowerCase() : "";
  if (!validLocalPart(label)) {
    return err(c, "INVALID_LOCAL_PART", "ID 需為 1–64 字元（a-z0-9._-），不能以 . 或 - 開頭或結尾", 400);
  }

  // ⚡ 互動式檢查走 fast 模式（前 5 個 TLD）；送出時（register-request／register-verify）仍用完整清單複驗
  const availability = await localPartAvailability(c.env, label, { fast: true });
  if (availability.available) {
    return c.json({ available: true, reason: "OK" as const });
  }

  const suggestions = await suggestAvailableLabels(c.env, label, 4);
  return c.json({
    available: false,
    reason: availability.reason,
    ...(availability.tldHit ? { tldHit: availability.tldHit } : {}),
    suggestions,
  });
});

/**
 * POST /api/auth/register-request — 寄送 6 位數 Email 驗證碼（docs/21 §4／§5）。
 *
 * 流程：模式檢查 → IP 限流（5/小時、20/日）→ Email／ID 驗證（格式／保留字／既有地址）
 *      → Email 寄送限制（60 秒冷卻、每日 5 封）→ 產生並儲存雜湊 → 寄信 → 稽核。
 *
 * 回應 `200 { sent: true, expiresIn: 900 }`。
 * ⚠️ Email **只收到 6 位數＋15 分鐘說明**，不含任何個資（docs/21 §5）。
 */
app.post("/api/auth/register-request", async (c) => {
  const db = c.env.DB;
  const ip = clientIp(c);
  const userAgent = c.req.header("user-agent") ?? null;
  const ts = now();

  // 1) 模式：closed 立即關閉；invite 模式不得走此端點（否則等於繞過邀請碼）
  const mode = registrationMode(c.env);
  if (mode === "closed" || legacyRegistrationDisabled(c.env)) {
    return err(c, "REGISTRATION_CLOSED", "目前未開放 Email 驗證碼註冊", 403);
  }
  if (mode !== "email_verify") {
    return err(c, "REGISTRATION_INVITE_ONLY", "目前為邀請碼註冊模式，請使用邀請碼", 403);
  }

  // 2) IP 限流（先計數再處理內容：惡意／格式錯誤的請求同樣受限）
  if (!(await claimIpHourlyCounter(db, ip, ts))) {
    return auditRegistrationRejected(c, {
      code: "RATE_LIMITED",
      status: 429,
      reason: "RATE_LIMITED",
      localPart: null,
      message: `註冊嘗試次數過多（每小時上限 ${REGISTER_IP_HOURLY_LIMIT} 次），請稍後再試`,
    });
  }
  if (!(await claimRegistrationCounter(db, registrationDayKey(ip, ts), REGISTER_IP_DAILY_LIMIT, ts))) {
    return auditRegistrationRejected(c, {
      code: "RATE_LIMITED",
      status: 429,
      reason: "RATE_LIMITED",
      localPart: null,
      message: `註冊嘗試次數過多（每日上限 ${REGISTER_IP_DAILY_LIMIT} 次），請明天再試`,
    });
  }

  const body = await c.req.json<{ email?: unknown; local_part?: unknown }>().catch(() => null);
  const email = normalizeEmailAddress(body?.email);
  const localPart = typeof body?.local_part === "string" ? body.local_part.trim().toLowerCase() : "";

  if (!email) {
    return auditRegistrationRejected(c, {
      code: "EMAIL_INVALID",
      status: 400,
      reason: "EMAIL_INVALID",
      localPart: localPart || null,
      message: "Email 格式不正確",
    });
  }
  if (!validLocalPart(localPart)) {
    return auditRegistrationRejected(c, {
      code: "INVALID_LOCAL_PART",
      status: 400,
      reason: "INVALID_LOCAL_PART",
      localPart: localPart || null,
      message: "ID 需為 1–64 字元（a-z0-9._-），不能以 . 或 - 開頭或結尾",
    });
  }

  // D20：保留字／人工封鎖／既有地址 → 二級網域撞名（fail-open；DNS 故障不擋註冊）
  const availability = await localPartAvailability(c.env, localPart);
  if (!availability.available) {
    if (availability.reason === "MATCHES_DOMAIN") {
      const suggestions = await suggestAvailableLabels(c.env, localPart);
      return auditRegistrationRejected(c, {
        code: "ID_MATCHES_DOMAIN",
        status: 422,
        reason: "ID_MATCHES_DOMAIN",
        localPart,
        message: availability.tldHit
          ? `此 ID 與 ${localPart}.${availability.tldHit} 網域同名，請改用其他名稱`
          : "此 ID 與現有網域同名，請改用其他名稱",
        extra: { suggestions },
      });
    }
    if (availability.reason === "RESERVED") {
      return auditRegistrationRejected(c, {
        code: "ID_RESERVED",
        status: 422,
        reason: "ID_RESERVED",
        localPart,
        message: "此 ID 為系統保留",
      });
    }
    return auditRegistrationRejected(c, {
      code: "ID_TAKEN",
      status: 409,
      reason: "ID_TAKEN",
      localPart,
      message: "這個 ID 已被使用",
    });
  }

  // 3) Email 寄送限制：每日 5 封（先扣；冷卻失敗時退還）＋ 60 秒冷卻
  if (!(await claimEmailDailySlot(db, email, ts))) {
    return auditRegistrationRejected(c, {
      code: "CODE_DAILY_LIMIT",
      status: 429,
      reason: "CODE_DAILY_LIMIT",
      localPart,
      message: `此 Email 今日驗證碼寄送次數已達上限（${REGISTER_EMAIL_DAILY_LIMIT} 封），請明天再試`,
    });
  }
  const slot = await claimEmailResendSlot(db, email, ts);
  if (!slot.ok) {
    await releaseEmailDailySlot(db, email, ts);
    const seconds = Math.max(1, Math.ceil(slot.retryAfterMs / 1000));
    return auditRegistrationRejected(c, {
      code: "CODE_COOLDOWN",
      status: 429,
      reason: "CODE_COOLDOWN",
      localPart,
      message: `請 ${seconds} 秒後再重新寄送驗證碼`,
    });
  }

  if (!c.env.JWT_SECRET) {
    await releaseEmailResendSlot(db, email);
    await releaseEmailDailySlot(db, email, ts);
    return err(c, "SERVER_MISCONFIGURED", "伺服器設定錯誤", 500);
  }

  // 4) 產生驗證碼 → 舊碼作廢（重寄後舊碼不可用）→ 存入雜湊
  const code = generateEmailCode();
  const codeHash = await hashEmailCode(code, c.env.JWT_SECRET);
  const expiresAt = ts + EMAIL_CODE_TTL_MS;
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE email_verifications SET consumed_at = ?1
           WHERE email = ?2 AND purpose = 'register' AND consumed_at IS NULL`
        )
        .bind(ts, email),
      db
        .prepare(
          `INSERT INTO email_verifications (email, code_hash, purpose, attempts, created_at, expires_at, consumed_at, ip)
           VALUES (?1, ?2, 'register', 0, ?3, ?4, NULL, ?5)`
        )
        .bind(email, codeHash, ts, expiresAt, ip),
    ]);
  } catch (e) {
    console.error("[atwhomail-api] register-request store failed", { error: String(e) });
    await releaseEmailResendSlot(db, email);
    await releaseEmailDailySlot(db, email, ts);
    return err(c, "REGISTER_FAILED", "註冊暫存失敗，請稍後再試", 500);
  }

  // 5) 寄送（失敗 → 釋放冷卻與每日計數，讓使用者可立即重試）
  try {
    await sendRegistrationEmail(c.env, email, code);
  } catch (e) {
    console.error("[atwhomail-api] verification email send failed", { error: String(e) });
    await releaseEmailResendSlot(db, email);
    await releaseEmailDailySlot(db, email, ts);
    return err(c, "EMAIL_SEND_FAILED", "驗證碼寄送失敗，請稍後再試", 502);
  }

  auditAsync(c, {
    event: "register_requested",
    ip,
    userAgent,
    detail: { local_part: localPart },
  });
  return c.json({ sent: true, expiresIn: EMAIL_CODE_TTL_MS / 1000 });
});

/**
 * POST /api/auth/register-verify — 驗證碼通過後建立帳號並回 mailbox token（docs/21 §4／§5）。
 *
 * 安全順序（刻意如此）：
 *   1. 先驗碼（過期／已用／5 次上限）→ 錯誤碼不洩漏 ID 是否存在
 *   2. 再檢查 ID 是否仍可用（request 後可能被搶走；此時**不消耗**驗證碼）
 *   3. 原子標記 `consumed_at`（一次性；併發也只會成功一次）
 *   4. `users` ＋ `email_addresses` 以單一 `batch`（交易）建立；失敗即回滾並恢復驗證碼
 */
app.post("/api/auth/register-verify", async (c) => {
  const db = c.env.DB;
  const ip = clientIp(c);
  const userAgent = c.req.header("user-agent") ?? null;
  const ts = now();

  const mode = registrationMode(c.env);
  if (mode === "closed" || legacyRegistrationDisabled(c.env)) {
    return err(c, "REGISTRATION_CLOSED", "目前未開放 Email 驗證碼註冊", 403);
  }
  if (mode !== "email_verify") {
    return err(c, "REGISTRATION_INVITE_ONLY", "目前為邀請碼註冊模式，請使用邀請碼", 403);
  }

  const body = await c.req
    .json<{ email?: unknown; local_part?: unknown; code?: unknown; password?: unknown }>()
    .catch(() => null);
  const email = normalizeEmailAddress(body?.email);
  const localPart = typeof body?.local_part === "string" ? body.local_part.trim().toLowerCase() : "";
  const rejection = (
    code: string,
    message: string,
    status: ContentfulStatusCode,
    reason: string,
    extra?: Record<string, unknown>
  ): Response =>
    auditRegistrationRejected(c, { code, message, status, reason, localPart: localPart || null, extra });

  if (!email) return rejection("EMAIL_INVALID", "Email 格式不正確", 400, "EMAIL_INVALID");
  if (!validLocalPart(localPart)) {
    return rejection(
      "INVALID_LOCAL_PART",
      "ID 需為 1–64 字元（a-z0-9._-），不能以 . 或 - 開頭或結尾",
      400,
      "INVALID_LOCAL_PART"
    );
  }
  if (typeof body?.code !== "string" || !/^\d{6}$/.test(body.code.trim())) {
    return rejection("CODE_INVALID", "驗證碼錯誤或已失效，請重新取得", 400, "CODE_INVALID");
  }
  const code = body.code.trim();
  if (typeof body?.password !== "string") {
    return rejection("WEAK_PASSWORD", "密碼格式錯誤", 422, "WEAK_PASSWORD");
  }
  const pwErr = validateRegistrationPassword(body.password);
  if (pwErr) return rejection("WEAK_PASSWORD", pwErr, 422, "WEAK_PASSWORD");

  // 1) 驗碼：同一 Email 只認最新一筆（重寄會讓舊碼 consumed_at 非空）
  const row = await db
    .prepare(
      `SELECT id, code_hash, attempts, expires_at, consumed_at
       FROM email_verifications
       WHERE email = ?1 AND purpose = 'register'
       ORDER BY id DESC LIMIT 1`
    )
    .bind(email)
    .first<{ id: number; code_hash: string; attempts: number; expires_at: number; consumed_at: number | null }>();

  if (!row) return rejection("CODE_INVALID", "驗證碼錯誤或已失效，請重新取得", 400, "CODE_INVALID");
  if (row.consumed_at !== null) {
    return rejection("CODE_INVALID", "驗證碼已使用，請重新取得", 400, "CODE_INVALID");
  }
  if (Number(row.expires_at) <= ts) {
    return rejection("CODE_EXPIRED", "驗證碼已過期（15 分鐘），請重新取得", 400, "CODE_EXPIRED");
  }
  if (Number(row.attempts) >= EMAIL_CODE_MAX_ATTEMPTS) {
    return rejection("CODE_LOCKED", "驗證碼錯誤次數過多，請重新取得驗證碼", 429, "CODE_LOCKED");
  }

  if (!c.env.JWT_SECRET) return err(c, "SERVER_MISCONFIGURED", "伺服器設定錯誤", 500);
  const submittedHash = await hashEmailCode(code, c.env.JWT_SECRET);
  if (!constantTimeEqual(submittedHash, row.code_hash)) {
    await db
      .prepare("UPDATE email_verifications SET attempts = attempts + 1 WHERE id = ?1 AND consumed_at IS NULL")
      .bind(row.id)
      .run();
    const after = await db
      .prepare("SELECT attempts FROM email_verifications WHERE id = ?1")
      .bind(row.id)
      .first<{ attempts: number }>();
    const attempts = Number(after?.attempts ?? Number(row.attempts) + 1);
    if (attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
      return rejection("CODE_LOCKED", "驗證碼錯誤次數過多，請重新取得驗證碼", 429, "CODE_LOCKED");
    }
    return rejection("CODE_INVALID", `驗證碼錯誤，還可再試 ${EMAIL_CODE_MAX_ATTEMPTS - attempts} 次`, 400, "CODE_INVALID");
  }

  // 2) 驗碼通過後才檢查 ID（錯誤碼不洩漏 ID 狀態；ID 被搶走時不消耗驗證碼）
  //    D20：此處同樣包含二級網域撞名（request 後才被註冊的網域也要擋）。
  const availability = await localPartAvailability(c.env, localPart);
  if (availability.reason === "MATCHES_DOMAIN") {
    const suggestions = await suggestAvailableLabels(c.env, localPart);
    return rejection(
      "ID_MATCHES_DOMAIN",
      availability.tldHit
        ? `此 ID 與 ${localPart}.${availability.tldHit} 網域同名，請改用其他名稱`
        : "此 ID 與現有網域同名，請改用其他名稱",
      422,
      "ID_MATCHES_DOMAIN",
      { suggestions }
    );
  }
  if (availability.reason === "RESERVED") {
    return rejection("ID_RESERVED", "此 ID 為系統保留", 422, "ID_RESERVED");
  }
  if (availability.reason === "TAKEN") {
    return rejection("ID_TAKEN", "這個 ID 已被使用", 409, "ID_TAKEN");
  }

  // 3) 一次性：原子標記（併發請求只有一個能成功）
  const consume = await db
    .prepare(
      `UPDATE email_verifications SET consumed_at = ?1
       WHERE id = ?2 AND consumed_at IS NULL AND attempts < ?3 AND expires_at > ?1`
    )
    .bind(ts, row.id, EMAIL_CODE_MAX_ATTEMPTS)
    .run();
  if (consume.meta.changes !== 1) {
    return rejection("CODE_INVALID", "驗證碼已失效，請重新取得", 400, "CODE_INVALID");
  }

  // 4) 建立 users(role=visitor) ＋ email_addresses（status='active'；created_at=now → 暖機 24h 自動生效）
  const mailboxEmail = `${localPart}@${DOMAIN}`;
  const pwHash = await hashPassword(body.password);
  try {
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO users (username, display_name, password_hash, status, role, access_email, created_at, updated_at)
           VALUES (?1, NULL, ?2, 'active', 'visitor', NULL, ?3, ?3)`
        )
        .bind(localPart, pwHash, ts),
      db
        .prepare(
          `INSERT INTO email_addresses
             (user_id, local_part, domain, email, password_hash, password_changed_at, status,
              can_send, daily_send_quota, sent_today, created_at, updated_at)
           SELECT id, ?2, ?3, ?4, ?5, ?6, 'active', 1, ?7, 0, ?6, ?6
           FROM users WHERE username = ?1`
        )
        .bind(localPart, localPart, DOMAIN, mailboxEmail, pwHash, ts, QUOTA.DEFAULT_VISITOR_DAILY_QUOTA),
    ]);
    const userId = Number(results[0]?.meta.last_row_id ?? 0);
    const addressId = Number(results[1]?.meta.last_row_id ?? 0);
    const token = await signMailboxToken(c.env, addressId, mailboxEmail, ts);

    auditAsync(c, {
      event: "register_verified",
      userId: userId || null,
      addressId: addressId || null,
      ip,
      userAgent,
      detail: { local_part: localPart },
    });
    // 與 mailbox-login 相同格式；成功後前端直接進入信箱
    return c.json({ token, session: "mailbox", address: { id: addressId, email: mailboxEmail } }, 200);
  } catch (e) {
    // batch 已回滾；恢復驗證碼可用（若是 ID 競態可換 ID 重試）
    await db
      .prepare("UPDATE email_verifications SET consumed_at = NULL WHERE id = ?1")
      .bind(row.id)
      .run()
      .catch(() => undefined);
    const message = String(e);
    if (/UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(message)) {
      return rejection("ID_TAKEN", "這個 ID 已被使用", 409, "ID_TAKEN");
    }
    console.error("[atwhomail-api] register-verify failed", { error: message });
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
 * D19-1：**嚴格**的 R2 批次刪除（信件永久刪除專用）。
 *
 * 與 `deleteR2Objects` 的 best-effort 不同：任何一筆失敗都往外拋，讓呼叫端在
 * **動 D1 之前**中止 → 「R2 失敗 → 500 且資料庫不變」（docs/19 §2）。
 * 單封信最多 2＋附件數個 key，一次 `bucket.delete` 即可（>1000 才分批）。
 */
async function purgeR2Objects(bucket: R2Bucket, keys: string[]): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    if (chunk.length === 0) continue;
    await bucket.delete(chunk);
    deleted += chunk.length;
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
 *   `form_responses`（本次將刪實例的回覆）→ `form_instances`（`message_id` 屬於該用戶的訊息，
 *   或 `recipient_address_id`／`sender_address_id` 屬於該用戶的地址；D16）
 *   → `attachments`（透過 messages）→ `messages`（該地址與該 owner_user_id 的）
 *   → `email_aliases`（指向該地址）→ `email_addresses`（該 user 名下，含已軟刪除者）
 *   → `users` → `auth_attempts`（該地址的 mailbox 計數 key，逐一字串精準比對）
 * 註：`attachments` 參照 `messages`，故必須**先於** messages 刪除（規格的「透過 messages」是範圍描述）。
 * 註：`form_responses.instance_id` 參照 `form_instances`、`responder_user_id` 參照 `users`，
 *     故必須**先於**兩者刪除；`form_templates` 可重用，**絕不刪除**（D16）。
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
  /** 本次刪除涵蓋的表單實例：訊息屬本帳號，或寄／收地址屬本帳號的地址（D16） */
  const INSTANCE_SCOPE = `message_id IN (SELECT id FROM messages WHERE ${MSG_SCOPE})
       OR recipient_address_id IN (SELECT id FROM email_addresses WHERE user_id = ?1)
       OR sender_address_id IN (SELECT id FROM email_addresses WHERE user_id = ?1)`;

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
      // ①／② 表單（D16）：回覆先於實例（`form_responses.instance_id` → `form_instances`）。
      //     `responder_user_id` 亦參照 `users`：正常情況下此使用者的回覆必然落在上面的實例範圍內
      //     （四道鎖要求回覆者＝收件地址的擁有者），多帶這個條件是 FK 的縱深防禦。
      c.env.DB.prepare(
        `DELETE FROM form_responses
          WHERE responder_user_id = ?1
             OR instance_id IN (SELECT id FROM form_instances WHERE ${INSTANCE_SCOPE})`
      ).bind(id),
      c.env.DB.prepare(`DELETE FROM form_instances WHERE ${INSTANCE_SCOPE}`).bind(id),
      // ③ 既有順序：附件 → 信件 → 別名 → 地址 → 使用者 → 登入計數
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
  // 前兩句是 D16 的表單清除（form_responses／form_instances），回應與稽核格式維持既有欄位不變。
  const attachments = counts[2] ?? 0;
  const messages = counts[3] ?? 0;
  const aliases = counts[4] ?? 0;
  const addressesDeleted = counts[5] ?? 0;

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
 *   **保留**信件與 R2 物件；同一 batch 內把**該地址為收件人**的 `open` 表單實例標為 `revoked`
 *   （`updated_at` 同步；寄件人可見），其餘資料不動（D16）。回應維持 `204`。
 * - `hard`：同一交易內先清除表單（`form_responses` → `form_instances`，D16），再做 soft，
 *   接續刪除該地址**所有** `messages`（含所有資料夾與垃圾桶）
 *   → `attachments` → 指向該地址的 `email_aliases` → **真正移除 `email_addresses` 該列**
 *   → 該地址的 `auth_attempts` 計數 key；之後 best-effort 刪除 R2 物件。回應 `200` 附數量。
 *   表單實例範圍涵蓋「該地址的信件所屬實例」與 `recipient_address_id`／`sender_address_id`
 *   為該地址的實例；`form_templates` 可重用，**絕不刪除**（D16）。
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

  // ── soft：只標記，保留信件與 R2（既有行為不變）＋ 該地址的 open 表單實例轉 revoked（D16） ──
  if (mode === "soft") {
    const retained = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE address_id = ?1")
      .bind(id)
      .first<{ n: number }>();
    // D16：soft 不得刪除任何表單資料；只把「該地址為收件人」且仍在 open 的實例標為 revoked
    // （寄件人可見）。submitted 等其餘狀態與回覆一律不動。
    const revokeStep = c.env.DB.prepare(
      "UPDATE form_instances SET status = 'revoked', updated_at = ?1 WHERE recipient_address_id = ?2 AND status = 'open'"
    ).bind(ts, id);
    try {
      // 兩句在同一個 batch（＝單一交易）：任一失敗即全部回滾。
      await c.env.DB.batch([revokeStep, softStep]);
    } catch (e) {
      console.error("[atwhomail-api] address soft delete failed (rolled back)", { id, error: String(e) });
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

  // D16：hard 必須先清除表單（回覆 → 實例），否則 `form_instances` 的 FK 會擋住 messages／地址刪除。
  // 範圍：該地址的信件所屬實例，或 recipient／sender_address_id 為該地址的實例。
  // `form_templates` 可重用 → **絕不刪除**。
  const INSTANCE_SCOPE = `message_id IN (SELECT id FROM messages WHERE address_id = ?1)
       OR recipient_address_id = ?1
       OR sender_address_id = ?1`;

  // 步驟以**名稱**索引（而非固定位置）：已軟刪除的列會少一個 soft 步驟（D11-5），
  // 用位置取值會在兩種路徑間錯位。
  const steps: Record<string, D1PreparedStatement> = {};
  steps.form_responses = c.env.DB.prepare(
    `DELETE FROM form_responses WHERE instance_id IN (SELECT id FROM form_instances WHERE ${INSTANCE_SCOPE})`
  ).bind(id); // 1) 回覆先於實例（FK）
  steps.form_instances = c.env.DB.prepare(`DELETE FROM form_instances WHERE ${INSTANCE_SCOPE}`).bind(id); // 2) 再刪實例
  if (!alreadyDeleted) steps.soft = softStep; // 3) 先 soft（與 soft 模式同一語意；已刪除的列跳過）
  steps.attachments = c.env.DB.prepare(
    "DELETE FROM attachments WHERE message_id IN (SELECT id FROM messages WHERE address_id = ?1)"
  ).bind(id); // 4) 附件先於信件（FK）
  steps.messages = c.env.DB.prepare("DELETE FROM messages WHERE address_id = ?1").bind(id); // 5) 含所有資料夾與垃圾桶
  steps.aliases = c.env.DB.prepare("DELETE FROM email_aliases WHERE target_email_address_id = ?1").bind(id); // 6) 指向此地址的別名
  steps.address = c.env.DB.prepare("DELETE FROM email_addresses WHERE id = ?1").bind(id); // 7) 真正移除該列 → 釋放名稱
  steps.attempts = c.env.DB.prepare("DELETE FROM auth_attempts WHERE key = ?1").bind(`mailbox:${row.email}`); // 8) 登入失敗計數

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

// ══════════════════════ D25：別名管理（owner 或 mailbox scope）══════════════════════

/**
 * POST /api/email-aliases — 建立別名（docs/25 §3.1）。
 *
 * 使用者只提供 `name`（3–12 字母）與 `target_address_id`；流水號由系統分配：
 *   1. 驗證名字（保留字／數字／符號一律 400 INVALID_ALIAS_NAME）
 *   2. 目標地址必須在 session scope 內且 active（否則 403 TARGET_NOT_ALLOWED）
 *   3. 每帳號 ≤ 50 個別名（否則 409 ALIAS_LIMIT_REACHED）
 *   4. `alias_names` 原子遞增取得流水號 → `luke` + 001 = `luke001`
 *   5. 寫 `email_aliases`；稽核 `alias_created`（只記別名與目標，N9）
 *
 * ⚠️ 目標只能是 `email_addresses`（API 限制），**禁止 alias → alias**（docs/25 §4）。
 */
app.post("/api/email-aliases", requireSession, async (c) => {
  const scope = c.get("scope");
  const body = await c.req.json<{ name?: unknown; target_address_id?: unknown }>().catch(() => null);
  const name = normalizeAliasName(body?.name);
  if (!name) {
    return err(c, "INVALID_ALIAS_NAME", "別名需為 3–12 個英文字母，且不得使用保留字", 400);
  }

  const targetId = Number(body?.target_address_id);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return err(c, "TARGET_NOT_ALLOWED", "target_address_id 必須是 scope 內的 active 地址", 403);
  }
  const target = await c.env.DB.prepare(
    "SELECT id, email, user_id FROM email_addresses WHERE id = ?1 AND status = 'active' AND deleted_at IS NULL"
  )
    .bind(targetId)
    .first<{ id: number; email: string; user_id: number }>();
  // owner：目標必須是自己名下；mailbox：只能是自己的地址（越權一律相同錯誤，不洩漏存在性）
  const targetAllowed =
    target !== null && (scope.kind === "owner" ? target.user_id === scope.userId : target.id === scope.addressId);
  if (!target || !targetAllowed) {
    return err(c, "TARGET_NOT_ALLOWED", "target_address_id 必須是 scope 內的 active 地址", 403);
  }

  const accountUserId = await accountUserIdForScope(c.env.DB, scope);
  if (accountUserId === null) return err(c, "TARGET_NOT_ALLOWED", "session 的帳號不存在", 403);
  const countRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM email_aliases a
       JOIN email_addresses e ON e.id = a.target_email_address_id
      WHERE e.user_id = ?1`
  )
    .bind(accountUserId)
    .first<{ n: number }>();
  if (Number(countRow?.n ?? 0) >= ALIAS_MAX_PER_ACCOUNT) {
    return err(c, "ALIAS_LIMIT_REACHED", `每個帳號最多 ${ALIAS_MAX_PER_ACCOUNT} 個別名`, 409);
  }

  const ts = now();
  /**
   * 原子取流水號（併發下不會拿到同一個號碼）。
   *
   * `next_serial` 的語意是「下一個可用的流水號」：首次插入存 2、回傳 2 → 本次用 1；
   * 之後每次 ON CONFLICT 遞增（回傳 3 → 本次用 2），因此發完第一號後計數器是 2
   * （符合 docs/25 T109 的 `alias_names.next_serial=2`）。
   * ⚠️ docs/25 §3.1 的 SQL 寫 `VALUES(?, 1, ?)` 並直接使用回傳值，會讓計數器停在 1
   *    與 T109 矛盾；這裡以 T109 與「next_serial = 下一個號碼」的欄位語意為準。
   */
  const serialRow = await c.env.DB.prepare(
    `INSERT INTO alias_names (name, next_serial, created_at) VALUES (?1, 2, ?2)
       ON CONFLICT(name) DO UPDATE SET next_serial = next_serial + 1
       RETURNING next_serial`
  )
    .bind(name, ts)
    .first<{ next_serial: number }>();
  const serial = Number(serialRow?.next_serial ?? 0) - 1;
  if (!Number.isInteger(serial) || serial <= 0) {
    console.error("[atwhomail-api] alias serial allocation failed", { name });
    return err(c, "ALIAS_CREATE_FAILED", "別名建立失敗，請稍後再試", 500);
  }
  if (serial > ALIAS_SERIAL_MAX) {
    return err(c, "ALIAS_LIMIT_REACHED", `名稱「${name}」的流水號已用完（${ALIAS_SERIAL_MAX}）`, 409);
  }

  const aliasAddress = aliasAddressFor(name, serial);
  let aliasId: number;
  try {
    const res = await c.env.DB.prepare(
      `INSERT INTO email_aliases (alias_address, target_email_address_id, status, created_at, updated_at)
       VALUES (?1, ?2, 'active', ?3, ?3)`
    )
      .bind(aliasAddress, target.id, ts)
      .run();
    aliasId = Number(res.meta.last_row_id);
  } catch (e) {
    console.error("[atwhomail-api] alias insert failed", { name, error: String(e) });
    return err(c, "ALIAS_CREATE_FAILED", "別名建立失敗，請稍後再試", 500);
  }

  // N9：只記別名與目標；不含任何信件內容
  auditAsync(c, {
    event: "alias_created",
    userId: accountUserId,
    addressId: target.id,
    ip: clientIp(c),
    userAgent: c.req.header("user-agent") ?? null,
    detail: { alias_address: aliasAddress, target: target.email },
  });

  return c.json({ id: aliasId, alias_address: aliasAddress, target_address_id: target.id, status: "active" }, 201);
});

/**
 * GET /api/email-aliases — 別名清單（owner 看名下全部；mailbox 只看自己地址的）。
 * `received_count` / `last_received_at` 以 `messages.envelope_to` 統計（索引 idx_messages_envelope_to）。
 */
app.get("/api/email-aliases", requireSession, async (c) => {
  const scope = c.get("scope");
  const where = scope.kind === "owner" ? "e.user_id = ?1" : "a.target_email_address_id = ?1";
  const bindValue = scope.kind === "owner" ? scope.userId : scope.addressId;

  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.alias_address, a.target_email_address_id AS target_address_id,
            e.email AS target_email, a.status, a.created_at, a.updated_at,
            (SELECT COUNT(*) FROM messages m WHERE m.envelope_to = a.alias_address) AS received_count,
            (SELECT MAX(m.received_at) FROM messages m WHERE m.envelope_to = a.alias_address) AS last_received_at
       FROM email_aliases a
       JOIN email_addresses e ON e.id = a.target_email_address_id
      WHERE ${where}
      ORDER BY a.id`
  )
    .bind(bindValue)
    .all<{
      id: number;
      alias_address: string;
      target_address_id: number;
      target_email: string;
      status: string;
      created_at: number;
      updated_at: number;
      received_count: number;
      last_received_at: number | null;
    }>();

  return c.json({
    aliases: results.map((r) => ({
      id: Number(r.id),
      alias_address: r.alias_address,
      target_address_id: Number(r.target_address_id),
      target_email: r.target_email,
      status: r.status,
      created_at: Number(r.created_at),
      updated_at: Number(r.updated_at),
      received_count: Number(r.received_count ?? 0),
      last_received_at: r.last_received_at === null ? null : Number(r.last_received_at),
    })),
  });
});

/** 取 session scope 內可見的單一別名（不存在／越權 → null；回應一律 404，不洩漏存在性） */
async function scopedAlias(db: D1Database, scope: Scope, id: number) {
  const where = scope.kind === "owner" ? "e.user_id = ?2" : "a.target_email_address_id = ?2";
  const bindValue = scope.kind === "owner" ? scope.userId : scope.addressId;
  return db
    .prepare(
      `SELECT a.id, a.alias_address, a.status, a.target_email_address_id, e.email AS target_email
         FROM email_aliases a
         JOIN email_addresses e ON e.id = a.target_email_address_id
        WHERE a.id = ?1 AND ${where}`
    )
    .bind(id, bindValue)
    .first<{
      id: number;
      alias_address: string;
      status: string;
      target_email_address_id: number;
      target_email: string;
    }>();
}

/**
 * PATCH /api/email-aliases/:id — 啟用／停用（docs/25 §3.2）。
 * 停用後寄到該別名的來信在 email-handler 端回 550 5.1.1（不建立 messages）。
 */
app.patch("/api/email-aliases/:id", requireSession, async (c) => {
  const scope = c.get("scope");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return err(c, "INVALID_ID", "id 需為正整數", 400);

  const body = await c.req.json<{ status?: unknown }>().catch(() => null);
  if (body?.status !== "active" && body?.status !== "disabled") {
    return err(c, "INVALID_STATUS", 'status 只能是 "active" 或 "disabled"', 400);
  }

  const row = await scopedAlias(c.env.DB, scope, id);
  if (!row) return err(c, "ALIAS_NOT_FOUND", "alias not found", 404);

  await c.env.DB.prepare("UPDATE email_aliases SET status = ?1, updated_at = ?2 WHERE id = ?3")
    .bind(body.status, now(), id)
    .run();

  auditAsync(c, {
    event: "alias_updated",
    userId: scope.kind === "owner" ? scope.userId : null,
    addressId: row.target_email_address_id,
    ip: clientIp(c),
    userAgent: c.req.header("user-agent") ?? null,
    detail: { alias_address: row.alias_address, target: row.target_email, status: body.status },
  });

  return c.json({ ok: true, id, alias_address: row.alias_address, status: body.status });
});

/**
 * DELETE /api/email-aliases/:id — **軟停用**（`status='disabled'`；不刪資料列，docs/25 §3.2）。
 * 與 PATCH disabled 相同語意；保留資料列以維持稽核與歷史 `envelope_to` 對應。
 */
app.delete("/api/email-aliases/:id", requireSession, async (c) => {
  const scope = c.get("scope");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return err(c, "INVALID_ID", "id 需為正整數", 400);

  const row = await scopedAlias(c.env.DB, scope, id);
  if (!row) return err(c, "ALIAS_NOT_FOUND", "alias not found", 404);

  await c.env.DB.prepare("UPDATE email_aliases SET status = 'disabled', updated_at = ?1 WHERE id = ?2")
    .bind(now(), id)
    .run();

  auditAsync(c, {
    event: "alias_updated",
    userId: scope.kind === "owner" ? scope.userId : null,
    addressId: row.target_email_address_id,
    ip: clientIp(c),
    userAgent: c.req.header("user-agent") ?? null,
    detail: { alias_address: row.alias_address, target: row.target_email, status: "disabled" },
  });

  return c.json({ ok: true, id, alias_address: row.alias_address, status: "disabled" });
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
                    m.folder, m.read_at, m.received_at, m.origin, m.kind, m.delivery_scope,
                    m.envelope_to,
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
    // docs/18 P1：三類郵件徽章（外部／內部／互動式）
    origin: r.origin ?? "external",
    kind: r.kind ?? "normal",
    delivery_scope: r.delivery_scope ?? "external",
    // D25：這封信原本寄給哪個別名（null = 寄給真實地址）
    envelope_to: r.envelope_to ?? null,
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
            m.folder, m.read_at, m.received_at, m.html_r2_key, m.message_id,
            m.origin, m.kind, m.delivery_scope, m.form_instance_id, m.suspicious_form_claim,
            m.sender_spf, m.sender_dkim, m.sender_dmarc, m.envelope_to
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
    // docs/18 P1：分類與寄件者驗證（**僅供顯示**；SPF／DKIM／DMARC 永不授權）
    origin: row.origin ?? "external",
    kind: row.kind ?? "normal",
    delivery_scope: row.delivery_scope ?? "external",
    form_instance_id: row.form_instance_id ?? null,
    suspicious_form_claim: row.suspicious_form_claim === 1,
    sender_spf: row.sender_spf ?? null,
    sender_dkim: row.sender_dkim ?? null,
    sender_dmarc: row.sender_dmarc ?? null,
    // D25：寄給別名時記錄別名地址；寄給真實地址時為 null
    envelope_to: row.envelope_to ?? null,
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

/** D19-5：把 id 陣列切成每塊 ≤ `size` 個（預設 `SQL_CHUNK`），避免 D1 綁定參數超限。 */
function chunkIds(ids: number[], size = SQL_CHUNK): number[][] {
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}

/**
 * D19-2：`scopedMessage` 的批次版（同一組 scope 條件）。
 * 回傳**可見**的 id 集合；呼叫端比對 `size === ids.length`，任一不合格即整批 404。
 * D19-5：id 分塊查詢（≤ `SQL_CHUNK`），200 個 id 也不會超過 D1 的 100 參數上限。
 */
async function scopedMessageIds(env: AuthEnv["Bindings"], scope: Scope, ids: number[]): Promise<Set<number>> {
  const visible = new Set<number>();
  if (ids.length === 0) return visible;
  const sw = scopeWhere(scope);
  for (const chunk of chunkIds(ids)) {
    const placeholders = chunk.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT m.id FROM messages m WHERE m.id IN (${placeholders}) AND m.deleted_at IS NULL AND ${sw.sql}`
    )
      .bind(...chunk, ...sw.binds)
      .all<{ id: number }>();
    for (const r of results) visible.add(Number(r.id));
  }
  return visible;
}

/** D19-1：hard delete 要清的 R2 key（raw／html／附件；空值略過、去重） */
function purgeKeys(
  messages: Array<{ raw_r2_key: string | null; html_r2_key: string | null }>,
  attachments: Array<{ r2_key: string | null }>
): string[] {
  const keys = new Set<string>();
  for (const m of messages) {
    if (m.raw_r2_key) keys.add(m.raw_r2_key);
    if (m.html_r2_key) keys.add(m.html_r2_key);
  }
  for (const a of attachments) {
    if (a.r2_key) keys.add(a.r2_key);
  }
  return [...keys];
}

type HardDeleteResult = { messages: number; attachments: number; form_instances: number; r2_objects: number };

/**
 * D19-5：`hardDeleteMessages` 中途失敗。
 * `deleted` 是**失敗前已完成塊**的加總（已完成的塊不回滾）→ 呼叫端據此回報「部分完成」。
 */
class HardDeletePartialError extends Error {
  readonly deleted: HardDeleteResult;
  constructor(cause: unknown, deleted: HardDeleteResult) {
    super(`hard delete failed: ${String(cause)}`);
    this.name = "HardDeletePartialError";
    this.deleted = deleted;
  }
}

const EMPTY_DELETE_RESULT: HardDeleteResult = { messages: 0, attachments: 0, form_instances: 0, r2_objects: 0 };

/** 失敗的 hard delete 已刪除多少（非 `HardDeletePartialError` → 皆為 0）。 */
function partialHardDelete(e: unknown): HardDeleteResult {
  return e instanceof HardDeletePartialError ? e.deleted : { ...EMPTY_DELETE_RESULT };
}

/** 部分完成時的錯誤訊息（N9：只有數量，不含信件內容）。 */
function hardDeleteFailureMessage(prefix: string, deleted: HardDeleteResult): string {
  return deleted.messages > 0
    ? `${prefix}（部分完成：已刪除 ${deleted.messages} 封，其餘未變更；可重試）`
    : `${prefix}（資料庫未變更）`;
}

/**
 * D19-1：永久刪除一批信件（呼叫端**必須先**完成 scope 檢查）。
 *
 * 順序固定（**每塊各自交易**，D19-5）：① 取 key ② 刪 R2（嚴格；失敗即 throw，該塊 D1 完全不動）
 * ③ 同一個 D1 batch 依 FK 由子到父刪 `form_responses` → `form_instances` → `attachments` → `messages`
 *    （D19-6：`form_instances.message_id` 參照 `messages(id)`、`form_responses.instance_id` 參照
 *    `form_instances(id)`；漏刪子表會讓整塊 batch 以 `FOREIGN KEY constraint failed` 回滾）。
 * id 以 `SQL_CHUNK` 分塊處理：每條 SQL 的綁定參數 ≤ 90（D1 上限 100）。
 * 回傳**所有塊的加總**；若中途失敗，已完成的塊不回滾，並以 `HardDeletePartialError` 拋出。
 * 稽核由呼叫端寫入（只記數量，N9）。
 */
async function hardDeleteMessages(env: AuthEnv["Bindings"], ids: number[]): Promise<HardDeleteResult> {
  const deleted: HardDeleteResult = { ...EMPTY_DELETE_RESULT };
  if (ids.length === 0) return deleted;

  const chunks = chunkIds(ids);
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex]!;
    try {
      const placeholders = chunk.map(() => "?").join(",");
      const { results: msgRows } = await env.DB.prepare(
        `SELECT id, raw_r2_key, html_r2_key FROM messages WHERE id IN (${placeholders})`
      )
        .bind(...chunk)
        .all<{ id: number; raw_r2_key: string | null; html_r2_key: string | null }>();
      const { results: attRows } = await env.DB.prepare(
        `SELECT message_id, r2_key FROM attachments WHERE message_id IN (${placeholders})`
      )
        .bind(...chunk)
        .all<{ message_id: number; r2_key: string | null }>();

      // R2 嚴格刪除：失敗即中止這一塊（D1 尚未動），已完成的塊維持已刪除。
      const r2_objects = await purgeR2Objects(env.MAIL, purgeKeys(msgRows, attRows));
      // D19-6：同一個 batch（＝單一交易）內先刪 form 子表（回覆 → 實例），再 attachments／messages。
      const results = await env.DB.batch([
        env.DB.prepare(
          `DELETE FROM form_responses
            WHERE instance_id IN (SELECT id FROM form_instances WHERE message_id IN (${placeholders}))`
        ).bind(...chunk),
        env.DB.prepare(`DELETE FROM form_instances WHERE message_id IN (${placeholders})`).bind(...chunk),
        env.DB.prepare(`DELETE FROM attachments WHERE message_id IN (${placeholders})`).bind(...chunk),
        env.DB.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).bind(...chunk),
      ]);
      // results 依 batch 順序：0=form_responses（不計數）、1=form_instances、2=attachments、3=messages
      deleted.form_instances += Number(results[1]?.meta.changes ?? 0);
      deleted.attachments += Number(results[2]?.meta.changes ?? 0);
      deleted.messages += Number(results[3]?.meta.changes ?? 0);
      deleted.r2_objects += r2_objects;
    } catch (e) {
      console.error("[atwhomail-api] hard delete chunk failed", {
        chunkIndex,
        count: chunk.length,
        deleted: { ...deleted },
        error: String(e),
      });
      throw new HardDeletePartialError(e, { ...deleted });
    }
  }
  return deleted;
}

/** 稽核主體（owner → userId；mailbox → addressId；不含任何信件內容，N9） */
function auditScope(scope: Scope): Pick<AuditEntry, "userId" | "addressId"> {
  return scope.kind === "owner" ? { userId: scope.userId } : { addressId: scope.addressId };
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

/**
 * DELETE /api/mail/:id — 刪除信件（docs/19 §2）。
 *
 * - 預設（`mode=soft`）：**軟刪除** → 只設 `folder='trash'`、`updated_at=now`；
 *   ⚠️ **不得設定 `deleted_at`**（全站查詢都帶 `deleted_at IS NULL`，設了會讓信件從所有資料夾消失）。
 * - `mode=hard`：**永久刪除** → R2（raw／html／附件）→ 同一 batch：`form_responses` → `form_instances`
 *   → `attachments` → `messages`；稽核 `mail_purged`（D19-6）。
 */
app.delete("/api/mail/:id", requireSession, async (c) => {
  const scope = c.get("scope");
  const id = Number(c.req.param("id"));
  const mode = c.req.query("mode") ?? "soft";
  if (mode !== "soft" && mode !== "hard") return err(c, "INVALID_MODE", "mode 必須是 soft 或 hard", 400);
  if (!(await scopedMessage(c.env, scope, id))) return err(c, "MAIL_NOT_FOUND", "mail not found", 404);

  if (mode === "soft") {
    // D19-1：只改 folder；deleted_at 保持 NULL → 垃圾桶（folder=trash）仍可列出／還原。
    await c.env.DB.prepare("UPDATE messages SET folder = 'trash', updated_at = ?1 WHERE id = ?2")
      .bind(now(), id)
      .run();
    return new Response(null, { status: 204 });
  }

  let deleted: HardDeleteResult;
  try {
    deleted = await hardDeleteMessages(c.env, [id]);
  } catch (e) {
    console.error("[atwhomail-api] mail hard delete failed", { id, error: String(e) });
    return err(c, "DELETE_FAILED", "永久刪除失敗（資料庫未變更）", 500);
  }
  // N9：只記 id、R2 物件數與表單實例數，不含主旨／寄件者／內文
  auditAsync(c, {
    ...auditScope(scope),
    event: "mail_purged",
    detail: { id, r2_objects: deleted.r2_objects, form_instances: deleted.form_instances },
  });
  return c.json({ ok: true, id, ...deleted });
});

/**
 * POST /api/mail/trash/empty — 清空垃圾桶（docs/19 §2）。
 * 對 session scope 內 `folder='trash' AND deleted_at IS NULL` 全部永久刪除；
 * 一次上限 500 封（超過 → 400，要求分批），回傳 `{count, r2_objects}`。
 * D19-6：每塊硬刪前先清 form 子表（`form_responses` → `form_instances`），否則 FK 會讓整塊 500。
 *
 * D19-5：id 以 **id 游標＋分塊**撈取（每塊 ≤ `SQL_CHUNK`），迴圈直到撈不到；
 * 撈滿 500 後若還有下一封 → `TRASH_TOO_LARGE`，且**一封都不刪**（與原本 LIMIT 501 語意相同）。
 * ⚠️ 必須註冊在 `/api/mail/:id/*` 之前（literal 優先）。
 */
app.post("/api/mail/trash/empty", requireSession, async (c) => {
  const scope = c.get("scope");
  const sw = scopeWhere(scope);

  const ids: number[] = [];
  let cursor = 0;
  // 最多收到 500 封；再多收一塊（90）即可判斷「超過上限」，查詢本身參數僅 2 個。
  while (ids.length <= TRASH_EMPTY_MAX) {
    const { results } = await c.env.DB.prepare(
      `SELECT m.id FROM messages m
       WHERE ${sw.sql} AND m.deleted_at IS NULL AND m.folder = 'trash' AND m.id > ?
       ORDER BY m.id LIMIT ${SQL_CHUNK}`
    )
      .bind(...sw.binds, cursor)
      .all<{ id: number }>();
    if (results.length === 0) break;
    for (const r of results) ids.push(Number(r.id));
    cursor = Number(results[results.length - 1]!.id);
    if (results.length < SQL_CHUNK) break;
  }
  if (ids.length > TRASH_EMPTY_MAX) {
    return err(c, "TRASH_TOO_LARGE", `垃圾桶超過 ${TRASH_EMPTY_MAX} 封，請分批永久刪除`, 400);
  }
  if (ids.length === 0) return c.json({ count: 0, r2_objects: 0 });

  let deleted: HardDeleteResult;
  try {
    deleted = await hardDeleteMessages(c.env, ids);
  } catch (e) {
    const partial = partialHardDelete(e);
    console.error("[atwhomail-api] empty trash failed", {
      count: ids.length,
      deleted: partial,
      error: String(e),
    });
    // D19-5：已完成的塊不回滾 → 明確回報部分完成（N9：只有數量）
    return c.json(
      {
        error: { code: "DELETE_FAILED", message: hardDeleteFailureMessage("清空垃圾桶失敗", partial) },
        deleted: partial,
      },
      500
    );
  }
  // N9：只記數量
  auditAsync(c, {
    ...auditScope(scope),
    event: "trash_emptied",
    detail: { count: deleted.messages, r2_objects: deleted.r2_objects, form_instances: deleted.form_instances },
  });
  return c.json({ count: deleted.messages, r2_objects: deleted.r2_objects });
});

/**
 * POST /api/mail/batch — 批次動作（docs/19 §3）。
 * body `{ action: trash|restore|read|purge, ids: number[] }`，1–200 個 id。
 * ⚠️ **每個 id 都必須通過 scopedMessage 權限檢查；任一不合格 → 404，整批不執行**。
 * 稽核 `mail_batch` 只記 action 與 count（N9）。
 */
app.post("/api/mail/batch", requireSession, async (c) => {
  const scope = c.get("scope");
  const body = await c.req.json<{ action?: unknown; ids?: unknown }>().catch(() => null);
  if (!body || typeof body.action !== "string") return err(c, "INVALID_BODY", "body 需 { action, ids }", 400);
  if (!(BATCH_ACTIONS as readonly string[]).includes(body.action)) {
    return err(c, "INVALID_ACTION", "action 必須是 trash/restore/read/purge", 400);
  }
  const action = body.action as BatchAction;
  if (!Array.isArray(body.ids)) return err(c, "INVALID_IDS", "ids 需為陣列", 400);
  if (body.ids.length === 0 || body.ids.length > BATCH_MAX_IDS) {
    return err(c, "INVALID_IDS", `ids 需 1–${BATCH_MAX_IDS} 個`, 400);
  }
  if (body.ids.some((id) => typeof id !== "number" || !Number.isInteger(id) || id <= 0)) {
    return err(c, "INVALID_IDS", "ids 需為正整數", 400);
  }
  const ids = [...new Set(body.ids as number[])];

  // 先驗證全部 id（等價於逐一呼叫 scopedMessage）→ 任一不合格整批 404、不執行任何動作
  const visible = await scopedMessageIds(c.env, scope, ids);
  if (visible.size !== ids.length) return err(c, "MAIL_NOT_FOUND", "mail not found", 404);

  const ts = now();
  try {
    if (action === "purge") {
      // purge：走 D19-1 的 hard delete 邏輯（R2 嚴格刪除 → form_responses → form_instances
      // → attachments → messages；內部分塊；D19-6）
      await hardDeleteMessages(c.env, ids);
    } else {
      // D19-5：UPDATE 也必須分塊（≤ SQL_CHUNK），否則 101–200 個 id 會踩 D1 的 100 參數上限。
      for (const chunk of chunkIds(ids)) {
        const placeholders = chunk.map((_, i) => `?${i + 2}`).join(",");
        if (action === "trash") {
          await c.env.DB.prepare(
            `UPDATE messages SET folder = 'trash', updated_at = ?1 WHERE id IN (${placeholders}) AND deleted_at IS NULL`
          )
            .bind(ts, ...chunk)
            .run();
        } else if (action === "restore") {
          await c.env.DB.prepare(
            `UPDATE messages SET folder = 'inbox', updated_at = ?1
             WHERE id IN (${placeholders}) AND folder = 'trash' AND deleted_at IS NULL`
          )
            .bind(ts, ...chunk)
            .run();
        } else {
          await c.env.DB.prepare(
            `UPDATE messages SET read_at = COALESCE(read_at, ?1), updated_at = ?1 WHERE id IN (${placeholders})`
          )
            .bind(ts, ...chunk)
            .run();
        }
      }
    }
  } catch (e) {
    const partial = action === "purge" ? partialHardDelete(e) : null;
    console.error("[atwhomail-api] mail batch failed", {
      action,
      count: ids.length,
      ...(partial ? { deleted: partial } : {}),
      error: String(e),
    });
    if (partial) {
      return c.json(
        {
          error: { code: "DELETE_FAILED", message: hardDeleteFailureMessage("批次永久刪除失敗", partial) },
          deleted: partial,
        },
        500
      );
    }
    return err(c, "DELETE_FAILED", "批次動作失敗（未執行）", 500);
  }

  auditAsync(c, { ...auditScope(scope), event: "mail_batch", detail: { action, count: ids.length } });
  return c.json({ ok: true, action, count: ids.length });
});

/** POST /api/mail/:id/restore — 從垃圾桶還原到收件匣（僅 `folder='trash'`；docs/19 §2） */
app.post("/api/mail/:id/restore", requireSession, async (c) => {
  const scope = c.get("scope");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return err(c, "MAIL_NOT_FOUND", "mail not found", 404);
  const row = await scopedMessage(c.env, scope, id, "m.id, m.folder");
  if (!row) return err(c, "MAIL_NOT_FOUND", "mail not found", 404);
  if ((row as { folder: string }).folder !== "trash") {
    return err(c, "NOT_IN_TRASH", "只能在垃圾桶還原信件", 400);
  }
  await c.env.DB.prepare("UPDATE messages SET folder = 'inbox', updated_at = ?1 WHERE id = ?2")
    .bind(now(), id)
    .run();
  auditAsync(c, { ...auditScope(scope), event: "mail_restored", detail: { id } });
  return c.json({ ok: true, id, folder: "inbox" });
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
  let fromAddr: FromRow | null =
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

  /**
   * D25（docs/25 §5）：`from` 也可以是**自己名下的別名**（回覆外部寄件者時自動帶入）。
   * - 別名必須 active，目標地址必須 active 且屬於 session scope（owner：自己名下／mailbox：同地址）
   * - 找到後以**目標地址**當配額與寄件備份的 `address_id`（配額一律計入 target）
   * - 實際寄出的 `From` 標頭用別名（`senderEmail`）；稽核只記 `via_alias` 布林（N9）
   */
  let viaAlias = false;
  let senderEmail = fromEmail;
  if (!fromAddr) {
    const aliasRow = await c.env.DB.prepare(
      `SELECT a.alias_address, e.id, e.email, e.user_id, e.can_send, e.daily_send_quota,
              e.sent_today, e.quota_reset_at, e.created_at
         FROM email_aliases a
         JOIN email_addresses e ON e.id = a.target_email_address_id
        WHERE a.alias_address = ?1 AND a.status = 'active'
          AND e.status = 'active' AND e.deleted_at IS NULL`
    )
      .bind(fromEmail)
      .first<FromRow & { alias_address: string }>();
    const aliasAllowed =
      aliasRow !== null &&
      (scope.kind === "owner" ? aliasRow.user_id === scope.userId : aliasRow.id === scope.addressId);
    if (aliasRow && aliasAllowed) {
      const { alias_address, ...target } = aliasRow;
      fromAddr = target;
      senderEmail = alias_address;
      viaAlias = true;
    }
  }
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

  // ── 本地直送判定（docs/18 P1）：to+cc+bcc 全部為本網域＋存在＋active → 不繞 SMTP ──
  const uniqueRecipients = [...new Set([...toList, ...ccList, ...bccList])];
  const localRecipients = await resolveLocalRecipients(c.env.DB, uniqueRecipients);
  const deliveryScope: "internal" | "external" = localRecipients ? "internal" : "external";

  let result: { messageId: string };
  if (localRecipients) {
    // ⚠️ 本地直送：**絕不呼叫 EMAIL.send()**（連內部一般郵件也不繞外網）。
    const messageId = `${crypto.randomUUID()}@${DOMAIN}`;
    try {
      await deliverLocalMail(c.env, {
        from: senderEmail,
        recipients: [...localRecipients.values()],
        to: toList,
        cc: ccList,
        subject: body.subject,
        html: body.html,
        text: body.text ?? (body.html ?? "").replace(/<[^>]+>/g, " "),
        attachments: atts,
        messageId,
        ts: ts0,
      });
    } catch (e) {
      console.error("[atwhomail-api] local delivery failed", { from: senderEmail, error: String(e) });
      await refundQuota(c.env.DB, fromAddr.id);
      return err(c, "SEND_FAILED", "本地投遞失敗，請稍後再試", 500);
    }
    result = { messageId };
  } else {
    try {
      result = await c.env.EMAIL.send({
        from: senderEmail,
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
      console.error("[atwhomail-api] send failed", { from: senderEmail, code, error: String(e) });
      await refundQuota(c.env.DB, fromAddr.id); // 未寄出 → 回補配額（避免誤扣）
      return err(c, "SEND_FAILED", `${code}: ${String(e)}`, 502);
    }
  }

  // 寄件備份
  const ts = now();
  const d = new Date(ts);
  const key = buildMailKey(d);
  const eml = buildPlainEml({
    from: senderEmail,
    to: toList,
    cc: ccList,
    subject: body.subject,
    date: d,
    messageId: result.messageId,
    text: body.text ?? (body.html ?? "").replace(/<[^>]+>/g, " "),
  });
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
        subject, text_preview, received_at, send_status, raw_r2_key, created_at, updated_at,
        origin, kind, delivery_scope)
     VALUES (?, ?, 'sent', ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?, 'internal', 'normal', ?)`
  )
    .bind(
      ownerId,
      fromAddr.id,
      result.messageId ?? null,
      senderEmail,
      JSON.stringify(toList.map((a) => ({ address: a, name: "" }))),
      JSON.stringify(ccList.map((a) => ({ address: a, name: "" }))),
      body.subject,
      preview,
      ts,
      key,
      ts,
      ts,
      deliveryScope
    )
    .run();

  // D25：成功寄出的稽核（只記 via_alias 布林；不含主旨／內文／收件人，N9）
  auditAsync(c, {
    event: "mail_sent",
    userId: fromAddr.user_id,
    ...auditCtx,
    detail: { via_alias: viaAlias },
  });

  return c.json({
    messageId: result.messageId,
    send_status: "sent",
    from: senderEmail,
    to: toList,
    delivery_scope: deliveryScope,
  });
});

// ══════════════════════ docs/18 P2：互動式表單 ══════════════════════

interface FormInstanceRow {
  id: number;
  template_id: number;
  message_id: number;
  sender_address_id: number;
  recipient_address_id: number;
  status: string;
  due_at: number | null;
  created_at: number;
  updated_at: number;
  kind: string;
  origin: string;
  delivery_scope: string;
  subject: string | null;
  schema_json: string;
  message_deleted_at: number | null;
}

/** 取表單實例＋關聯信件與 schema（四道鎖所需的全部欄位一次查完） */
function loadFormInstance(db: D1Database, id: number): Promise<FormInstanceRow | null> {
  return db
    .prepare(
      `SELECT i.id, i.template_id, i.message_id, i.sender_address_id, i.recipient_address_id,
              i.status, i.due_at, i.created_at, i.updated_at,
              m.kind, m.origin, m.delivery_scope, m.subject, m.deleted_at AS message_deleted_at,
              t.schema_json
       FROM form_instances i
       JOIN messages m ON m.id = i.message_id
       JOIN form_templates t ON t.id = i.template_id
       WHERE i.id = ?1`
    )
    .bind(id)
    .first<FormInstanceRow>();
}

/** 逾期判定（due_at 為 epoch ms；NULL = 不過期） */
function formExpired(row: FormInstanceRow, ts = now()): boolean {
  return row.due_at !== null && row.due_at <= ts;
}

function parseStoredSchema(row: FormInstanceRow): JsonObject | null {
  try {
    const parsed = JSON.parse(row.schema_json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as JsonObject) : null;
  } catch {
    return null;
  }
}

/** 寄件人是否為此實例的寄件者（owner 需名下有該寄件地址；mailbox 需同一地址） */
async function isFormSender(db: D1Database, row: FormInstanceRow, scope: Scope): Promise<boolean> {
  if (scope.kind === "mailbox") return row.sender_address_id === scope.addressId;
  const owned = await db
    .prepare("SELECT id FROM email_addresses WHERE id = ?1 AND user_id = ?2")
    .bind(row.sender_address_id, scope.userId)
    .first();
  return owned !== null;
}

type FormRecipientVia = "mailbox" | "owner";

/**
 * 鎖③（D18-1）：兩種合格身分之一
 *   1. mailbox session 且 `addressId == recipient_address_id`（原本行為）
 *   2. owner **JWT** session 且該收件地址屬於此 owner（`email_addresses.user_id == scope.userId`）
 *
 * ⚠️ rescue（`via='rescue'`）一律不合格：機器憑證不得填表單。
 * ⚠️ owner 對訪客地址的表單仍不合格（不得跨使用者）。
 * 回傳 `via` 供稽核；不合格回 `null`（呼叫端一律轉 404，不洩漏原因）。
 */
async function formRecipientVia(
  db: D1Database,
  row: FormInstanceRow,
  scope: Scope
): Promise<FormRecipientVia | null> {
  if (scope.kind === "mailbox") {
    return row.recipient_address_id === scope.addressId ? "mailbox" : null;
  }
  if (scope.via !== "jwt") return null; // rescue token：fail closed
  const owned = await db
    .prepare("SELECT id FROM email_addresses WHERE id = ?1 AND user_id = ?2")
    .bind(row.recipient_address_id, scope.userId)
    .first();
  return owned ? "owner" : null;
}

/**
 * 鎖①③④＋信件未刪除（不含狀態）。
 * POST responses 需要先辨識身分，才能對「已送出／已撤回／逾期」回精確 409。
 */
async function formRecipientClassifiedVia(
  db: D1Database,
  row: FormInstanceRow | null,
  scope: Scope
): Promise<FormRecipientVia | null> {
  if (!row) return null;
  if (row.kind !== "interactive_form") return null; // 鎖①
  const via = await formRecipientVia(db, row, scope); // 鎖③
  if (!via) return null;
  if (row.origin !== "internal" || row.delivery_scope !== "internal") return null; // 鎖④
  if (row.message_deleted_at !== null) return null;
  return via;
}

/** 收件人四道鎖（不回傳原因；任何一項失敗一律 404，避免洩漏存在性） */
async function recipientLockOk(
  db: D1Database,
  row: FormInstanceRow | null,
  scope: Scope
): Promise<FormRecipientVia | null> {
  if (!row) return null;
  const via = await formRecipientClassifiedVia(db, row, scope);
  if (!via) return null;
  if (row.status !== "open" || formExpired(row)) return null; // 鎖②（存在、open、未過期）
  return via;
}

const FORM_NOT_FOUND_MESSAGE = "form not found";

/**
 * POST /api/forms/send — 建立並**本地投遞**互動式表單（docs/18 §3.2）
 *
 * 安全門檻：
 *  - 所有 to／cc／bcc 必須為本網域＋存在＋active，否則 `422 FORM_RECIPIENT_NOT_INTERNAL`（fail closed）
 *  - 每位收件人建立一筆 form_instances 與一筆 messages（origin=internal、kind=interactive_form、
 *    delivery_scope=internal、form_instance_id 關聯）
 *  - ⚠️ **此路徑絕不呼叫 `EMAIL.send()`**（物理上不可能外流）
 *  - schema 先過白名單驗證，才寫入 form_templates
 *  - 稽核 `form_sent`：只記 id／數量／欄位數，不含主旨、地址、內文或 schema（N9）
 */
app.post("/api/forms/send", requireSession, async (c) => {
  const scope = c.get("scope");
  const body = await c.req
    .json<{
      from?: string;
      to?: unknown;
      cc?: unknown;
      bcc?: unknown;
      subject?: string;
      title?: string;
      description?: string;
      schema?: unknown;
      due_at?: unknown;
      attachments?: unknown;
    }>()
    .catch(() => null);
  if (!body) return err(c, "INVALID_BODY", "invalid JSON body", 400);
  if (body.attachments !== undefined && (!Array.isArray(body.attachments) || body.attachments.length > 0)) {
    return err(c, "FORM_ATTACHMENTS_NOT_SUPPORTED", "互動式表單不支援附件", 400);
  }

  // from 必須在 session scope 內且 active（與一般寄信相同）
  if (typeof body.from !== "string" || !body.from.includes("@")) {
    return err(c, "INVALID_FROM", "from 必填且需為完整地址", 400);
  }
  const fromEmail = body.from.trim().toLowerCase();
  const fromAddr =
    scope.kind === "owner"
      ? await c.env.DB.prepare(
          `SELECT id, email, user_id, can_send, daily_send_quota, sent_today, quota_reset_at, created_at
           FROM email_addresses WHERE email = ?1 AND user_id = ?2 AND status = 'active' AND deleted_at IS NULL`
        )
          .bind(fromEmail, scope.userId)
          .first<{ id: number; email: string; user_id: number; can_send: number; daily_send_quota: number; sent_today: number; quota_reset_at: number | null; created_at: number }>()
      : await c.env.DB.prepare(
          `SELECT id, email, user_id, can_send, daily_send_quota, sent_today, quota_reset_at, created_at
           FROM email_addresses WHERE email = ?1 AND id = ?2 AND status = 'active' AND deleted_at IS NULL`
        )
          .bind(fromEmail, scope.addressId)
          .first<{ id: number; email: string; user_id: number; can_send: number; daily_send_quota: number; sent_today: number; quota_reset_at: number | null; created_at: number }>();
  if (!fromAddr) return err(c, "FROM_NOT_ALLOWED", "from 不屬於此 session 的 active 地址", 403);

  const toList = normalizeRecipients(body.to);
  if (toList.length === 0) return err(c, "INVALID_TO", "to 至少需要一個收件人", 400);
  const ccList = normalizeRecipients(body.cc);
  const bccList = normalizeRecipients(body.bcc);
  if (toList.length + ccList.length + bccList.length > 50) {
    return err(c, "TOO_MANY_RECIPIENTS", "to+cc+bcc 合計不得超過 50", 422);
  }
  if (!body.subject || typeof body.subject !== "string") {
    return err(c, "INVALID_SUBJECT", "subject 必填", 400);
  }

  // 收件人 fail closed：全部本網域＋存在＋active，否則 422（不得改成 EMAIL.send）
  const uniqueRecipients = [...new Set([...toList, ...ccList, ...bccList])];
  const recipientMap = await resolveLocalRecipients(c.env.DB, uniqueRecipients);
  if (!recipientMap) {
    return err(c, "FORM_RECIPIENT_NOT_INTERNAL", "互動式表單只能寄給 atwho.org 內部的 active 地址", 422);
  }

  // schema 白名單驗證（禁止 $ref／anyOf／oneOf／allOf／patternProperties／dependencies…）
  const schemaResult = validateFormSchema(body.schema);
  if (!schemaResult.ok) return err(c, "FORM_SCHEMA_INVALID", schemaResult.message, 422);
  const schema = schemaResult.schema;

  if (body.title !== undefined && typeof body.title !== "string") {
    return err(c, "INVALID_BODY", "title 必須是字串", 400);
  }
  if (body.description !== undefined && typeof body.description !== "string") {
    return err(c, "INVALID_BODY", "description 必須是字串", 400);
  }
  const subject = body.subject.trim();
  const titleCandidate = body.title ?? (typeof schema.title === "string" ? schema.title : "");
  schema.title = sanitizeDisplayText(titleCandidate || subject || "互動式表單");
  if (body.description !== undefined) schema.description = sanitizeDisplayText(body.description);

  let dueAt: number | null = null;
  if (body.due_at !== undefined && body.due_at !== null) {
    const n = Number(body.due_at);
    if (!Number.isInteger(n) || n <= 0) return err(c, "INVALID_DUE_AT", "due_at 需為 epoch ms 正整數", 400);
    dueAt = n;
  }

  // 配額／安全閥（與一般寄信相同的判定順序；失敗即回補）
  const auditCtx = { addressId: fromAddr.id, ip: clientIp(c), userAgent: c.req.header("user-agent") ?? null };
  const ts0 = now();
  const acct = await c.env.DB.prepare("SELECT status FROM users WHERE id = ?1")
    .bind(fromAddr.user_id)
    .first<{ status: string }>();
  if (!acct || acct.status !== "active") {
    auditAsync(c, { ...auditCtx, event: "send_rejected_notallowed", detail: { reason: "ACCOUNT_SUSPENDED" } });
    return err(c, "ACCOUNT_SUSPENDED", "此帳號已停權，無法寄信", 403);
  }
  if (fromAddr.can_send !== 1) {
    auditAsync(c, { ...auditCtx, event: "send_rejected_notallowed", detail: { reason: "SEND_NOT_ALLOWED" } });
    return err(c, "SEND_NOT_ALLOWED", "此地址目前不可寄信", 403);
  }
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
  const inWarmup = ts0 < Number(fromAddr.created_at) + QUOTA.WARMUP_HOURS * 3600_000;
  const warmupApplies = inWarmup && !(await isWarmupExempt(c.env.DB, fromAddr.id));
  const effectiveLimit = warmupApplies
    ? Math.min(Number(fromAddr.daily_send_quota), QUOTA.WARMUP_QUOTA)
    : Number(fromAddr.daily_send_quota);
  const deduct = await c.env.DB.prepare(
    `UPDATE email_addresses
     SET sent_today = sent_today + 1, first_send_at = COALESCE(first_send_at, ?1), updated_at = ?1
     WHERE id = ?2 AND status = 'active' AND can_send = 1 AND sent_today < ?3`
  )
    .bind(ts0, fromAddr.id, effectiveLimit)
    .run();
  if (deduct.meta.changes !== 1) {
    auditAsync(c, { ...auditCtx, event: "send_rejected_quota", detail: { limit: effectiveLimit, warmup: warmupApplies } });
    return err(c, "QUOTA_EXCEEDED", `已達寄信上限（${effectiveLimit} 封）`, 429);
  }
  const recent = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM messages WHERE address_id = ?1 AND folder = 'sent' AND received_at >= ?2`
  )
    .bind(fromAddr.id, ts0 - 3600_000)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= QUOTA.HOURLY_SEND_LIMIT) {
    await refundQuota(c.env.DB, fromAddr.id);
    auditAsync(c, { ...auditCtx, event: "send_rejected_rate", detail: { hourly_limit: QUOTA.HOURLY_SEND_LIMIT } });
    return err(c, "RATE_LIMITED", `每小時最多寄 ${QUOTA.HOURLY_SEND_LIMIT} 封，請稍後再試`, 429);
  }

  const ts = now();
  const staticText = buildFormStaticText(schema);
  const templateKey = crypto.randomUUID();
  const messageId = `${crypto.randomUUID()}@${DOMAIN}`;
  const recipients = [...recipientMap.values()];
  const instances: Array<{ id: number; recipient: string }> = [];
  let created = 0;

  try {
    const templateRes = await c.env.DB.prepare(
      `INSERT INTO form_templates (key, version, schema_json, created_at) VALUES (?1, 1, ?2, ?3)`
    )
      .bind(templateKey, JSON.stringify(schema), ts)
      .run();
    const templateId = Number(templateRes.meta.last_row_id);

    for (const recipient of recipients) {
      const key = buildMailKey(new Date(ts));
      const eml = buildPlainEml({
        from: fromAddr.email,
        to: toList,
        cc: ccList,
        subject,
        date: new Date(ts),
        messageId,
        text: staticText,
        // 非權威提示標記：即使轉寄／回流，收信端也一律視為一般外部郵件
        extraHeaders: [`X-AtWho-Form: ${templateKey}`],
      });
      try {
        await c.env.MAIL.put(key, new TextEncoder().encode(eml), {
          httpMetadata: { contentType: "message/rfc822" },
          customMetadata: { "d1-address-id": String(recipient.id), "d1-flag": "form" },
        });
      } catch (e) {
        console.error("[atwhomail-api] form raw store failed", { key, error: String(e) });
      }

      const msgRes = await c.env.DB.prepare(
        `INSERT INTO messages
           (owner_user_id, address_id, folder, message_id, from_address, to_address, cc,
            subject, text_preview, received_at, raw_r2_key, html_r2_key, created_at, updated_at,
            origin, kind, delivery_scope)
         VALUES (?1, ?2, 'inbox', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?9, ?9,
                 'internal', 'interactive_form', 'internal')`
      )
        .bind(
          recipient.user_id,
          recipient.id,
          messageId,
          fromAddr.email,
          JSON.stringify(toList.map((address) => ({ address, name: "" }))),
          JSON.stringify(ccList.map((address) => ({ address, name: "" }))),
          subject,
          staticText.slice(0, 200),
          ts,
          key
        )
        .run();
      const messageRowId = Number(msgRes.meta.last_row_id);

      const instRes = await c.env.DB.prepare(
        `INSERT INTO form_instances
           (template_id, message_id, sender_address_id, recipient_address_id, status, due_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'open', ?5, ?6, ?6)`
      )
        .bind(templateId, messageRowId, fromAddr.id, recipient.id, dueAt, ts)
        .run();
      const instanceId = Number(instRes.meta.last_row_id);
      await c.env.DB.prepare("UPDATE messages SET form_instance_id = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(instanceId, ts, messageRowId)
        .run();
      instances.push({ id: instanceId, recipient: recipient.email });
      created += 1;
    }

    // 寄件備份：form_instance_id 指向該次寄送的**代表實例**，供寄件人管理 UI 找到整批實例
    const sentKey = buildMailKey(new Date(ts));
    const sentEml = buildPlainEml({
      from: fromAddr.email,
      to: toList,
      cc: ccList,
      subject,
      date: new Date(ts),
      messageId,
      text: staticText,
      extraHeaders: [`X-AtWho-Form: ${templateKey}`],
    });
    try {
      await c.env.MAIL.put(sentKey, new TextEncoder().encode(sentEml), {
        httpMetadata: { contentType: "message/rfc822" },
        customMetadata: { "d1-flag": "sent-copy-form" },
      });
    } catch (e) {
      console.error("[atwhomail-api] form sent-copy R2 store failed", { sentKey, error: String(e) });
    }
    let sentMessageId: number | null = null;
    try {
      const sentRes = await c.env.DB.prepare(
        `INSERT INTO messages
           (owner_user_id, address_id, folder, message_id, from_address, to_address, cc,
            subject, text_preview, received_at, send_status, raw_r2_key, created_at, updated_at,
            origin, kind, delivery_scope, form_instance_id)
         VALUES (?1, ?2, 'sent', ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'sent', ?10, ?9, ?9,
                 'internal', 'interactive_form', 'internal', ?11)`
      )
        .bind(
          fromAddr.user_id,
          fromAddr.id,
          messageId,
          fromAddr.email,
          JSON.stringify(toList.map((address) => ({ address, name: "" }))),
          JSON.stringify(ccList.map((address) => ({ address, name: "" }))),
          subject,
          staticText.slice(0, 200),
          ts,
          sentKey,
          instances[0]?.id ?? null
        )
        .run();
      sentMessageId = Number(sentRes.meta.last_row_id);
    } catch (e) {
      // 收件人已成功收到；寄件備份失敗不應回 500（否則寄件人會誤以為整批失敗而重送）
      console.error("[atwhomail-api] form sent-copy insert failed", { from: fromAddr.email, error: String(e) });
    }

    auditAsync(c, {
      event: "form_sent",
      userId: fromAddr.user_id,
      addressId: fromAddr.id,
      ip: clientIp(c),
      userAgent: c.req.header("user-agent") ?? null,
      detail: {
        by: fromAddr.id,
        template_id: templateId,
        template_key: templateKey,
        instances: recipients.length,
        fields: schemaResult.fields,
        due_at: dueAt,
      },
    });

    return c.json(
      {
        ok: true,
        template_id: templateId,
        template_key: templateKey,
        message_id: messageId,
        sent_message_id: sentMessageId,
        instances,
      },
      201
    );
  } catch (e) {
    console.error("[atwhomail-api] form send failed", { from: fromAddr.email, created, error: String(e) });
    if (created === 0) await refundQuota(c.env.DB, fromAddr.id);
    return err(c, "FORM_SEND_FAILED", "互動式表單寄送失敗，請稍後再試", 500);
  }
});

/**
 * GET /api/forms/:id — 收件人取 schema（四道鎖）
 *
 * ① messages.kind = interactive_form｜② 實例存在＋open＋未過期｜
 * ③ 收件人本人（mailbox 同地址，或 owner JWT 對自己名下地址；D18-1）｜
 * ④ origin 與 delivery_scope 皆 internal。
 * ⚠️ 任何一項失敗（含 rescue token）一律 **404**（不洩漏表單是否存在；docs/18 §4）。
 */
app.get("/api/forms/:id", requireSession, async (c) => {
  const scope = c.get("scope");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return err(c, "FORM_NOT_FOUND", FORM_NOT_FOUND_MESSAGE, 404);

  const row = await loadFormInstance(c.env.DB, id);
  const via = await recipientLockOk(c.env.DB, row, scope);
  if (!row || !via) {
    return err(c, "FORM_NOT_FOUND", FORM_NOT_FOUND_MESSAGE, 404);
  }

  const schema = parseStoredSchema(row);
  if (!schema) return err(c, "FORM_NOT_FOUND", FORM_NOT_FOUND_MESSAGE, 404);

  auditAsync(c, {
    event: "form_viewed",
    userId: scope.kind === "owner" ? scope.userId : null,
    addressId: scope.kind === "mailbox" ? scope.addressId : row.recipient_address_id,
    ip: clientIp(c),
    userAgent: c.req.header("user-agent") ?? null,
    detail: { instance_id: row.id, template_id: row.template_id, message_id: row.message_id, via },
  });

  return c.json({
    form: {
      id: row.id,
      message_id: row.message_id,
      subject: row.subject,
      status: row.status,
      due_at: row.due_at,
      title: typeof schema.title === "string" ? schema.title : (row.subject ?? "互動式表單"),
      description: typeof schema.description === "string" ? schema.description : null,
      schema,
    },
  });
});

/**
 * POST /api/forms/:id/responses — 送出回覆（收件人本人；不得重複）
 *
 * 驗證順序：收件人四道鎖（失敗 404）→ 狀態（已送出／撤回／逾期）→ payload 依 schema 驗證。
 * ⚠️ 稽核 `form_submitted` 只記 id，**絕不**記錄 payload（N9）。
 */
app.post("/api/forms/:id/responses", requireSession, async (c) => {
  const scope = c.get("scope");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return err(c, "FORM_NOT_FOUND", FORM_NOT_FOUND_MESSAGE, 404);

  const row = await loadFormInstance(c.env.DB, id);
  // 先做與 GET 相同的存在性／身分／分類檢查（狀態另判，才能回精確錯誤碼）
  const via = await formRecipientClassifiedVia(c.env.DB, row, scope);
  if (!row || !via) {
    return err(c, "FORM_NOT_FOUND", FORM_NOT_FOUND_MESSAGE, 404);
  }
  if (row.status === "submitted") return err(c, "FORM_ALREADY_SUBMITTED", "此表單已送出", 409);
  if (row.status === "revoked") return err(c, "FORM_CLOSED", "此表單已撤回", 409);
  if (row.status === "expired" || formExpired(row)) {
    if (row.status === "open") {
      await c.env.DB.prepare("UPDATE form_instances SET status = 'expired', updated_at = ?1 WHERE id = ?2 AND status = 'open'")
        .bind(now(), row.id)
        .run();
    }
    return err(c, "FORM_EXPIRED", "此表單已逾期", 409);
  }
  if (row.status !== "open") return err(c, "FORM_NOT_FOUND", FORM_NOT_FOUND_MESSAGE, 404);

  const schema = parseStoredSchema(row);
  if (!schema) return err(c, "FORM_NOT_FOUND", FORM_NOT_FOUND_MESSAGE, 404);

  const body = await c.req.json<{ payload?: unknown }>().catch(() => null);
  if (!body || !("payload" in body)) return err(c, "FORM_INVALID_PAYLOAD", "需提供 payload", 422);
  const payloadResult = validateFormPayload(schema, body.payload);
  if (!payloadResult.ok) return err(c, "FORM_INVALID_PAYLOAD", payloadResult.message, 422);

  // 回覆者一律是收件地址的擁有者；owner 路徑已在鎖③驗證 `user_id == scope.userId`
  const responder = await c.env.DB.prepare("SELECT user_id FROM email_addresses WHERE id = ?1")
    .bind(row.recipient_address_id)
    .first<{ user_id: number }>();
  if (!responder) return err(c, "FORM_NOT_FOUND", FORM_NOT_FOUND_MESSAGE, 404);

  const ts = now();
  let inserted = 0;
  try {
    const results = await c.env.DB.batch([
      // 只有 status='open' 才插入（避免重複送出）
      c.env.DB.prepare(
        `INSERT INTO form_responses (instance_id, responder_user_id, payload_json, submitted_at)
         SELECT ?1, ?2, ?3, ?4
         WHERE EXISTS (SELECT 1 FROM form_instances WHERE id = ?1 AND status = 'open')`
      ).bind(row.id, responder.user_id, JSON.stringify(payloadResult.payload), ts),
      c.env.DB.prepare(
        "UPDATE form_instances SET status = 'submitted', updated_at = ?1 WHERE id = ?2 AND status = 'open'"
      ).bind(ts, row.id),
    ]);
    inserted = Number(results[0]!.meta.changes ?? 0);
  } catch (e) {
    console.error("[atwhomail-api] form response insert failed", { instanceId: row.id, error: String(e) });
    return err(c, "FORM_SUBMIT_FAILED", "回覆儲存失敗，請稍後再試", 500);
  }
  if (inserted !== 1) {
    // 競態：另一個請求先送出了
    const current = await c.env.DB.prepare("SELECT status FROM form_instances WHERE id = ?1")
      .bind(row.id)
      .first<{ status: string }>();
    if (current?.status === "submitted") return err(c, "FORM_ALREADY_SUBMITTED", "此表單已送出", 409);
    if (current?.status === "revoked") return err(c, "FORM_CLOSED", "此表單已撤回", 409);
    return err(c, "FORM_NOT_FOUND", FORM_NOT_FOUND_MESSAGE, 404);
  }

  auditAsync(c, {
    event: "form_submitted",
    addressId: scope.kind === "mailbox" ? scope.addressId : row.recipient_address_id,
    userId: responder.user_id,
    ip: clientIp(c),
    userAgent: c.req.header("user-agent") ?? null,
    detail: { instance_id: row.id, template_id: row.template_id, message_id: row.message_id, via },
  });

  return c.json({ ok: true, instance_id: row.id, status: "submitted" });
});

/**
 * GET /api/forms/:id/responses — 寄件人查看回覆（僅寄件人；他人 403）
 *
 * 回傳同一 `template_id` 的所有實例（一次寄送＝一批），讓寄件人看到所有收件人的狀態與回覆。
 */
app.get("/api/forms/:id/responses", requireSession, async (c) => {
  const scope = c.get("scope");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return err(c, "FORM_NOT_FOUND", FORM_NOT_FOUND_MESSAGE, 404);

  const row = await loadFormInstance(c.env.DB, id);
  if (!row) return err(c, "FORM_NOT_FOUND", FORM_NOT_FOUND_MESSAGE, 404);
  if (!(await isFormSender(c.env.DB, row, scope))) {
    return err(c, "FORM_NOT_AUTHORIZED", "僅寄件人可查看回覆", 403);
  }

  const { results } = await c.env.DB.prepare(
    `SELECT i.id, i.recipient_address_id, a.email AS recipient, i.status, i.due_at, i.created_at,
            r.payload_json, r.submitted_at
     FROM form_instances i
     JOIN email_addresses a ON a.id = i.recipient_address_id
     LEFT JOIN form_responses r ON r.instance_id = i.id
     WHERE i.template_id = ?1 ORDER BY i.id`
  )
    .bind(row.template_id)
    .all<{
      id: number;
      recipient_address_id: number;
      recipient: string;
      status: string;
      due_at: number | null;
      created_at: number;
      payload_json: string | null;
      submitted_at: number | null;
    }>();

  const instances = results.map((r) => {
    let payload: unknown = null;
    if (r.payload_json !== null) {
      try {
        payload = JSON.parse(r.payload_json);
      } catch {
        payload = null;
      }
    }
    return {
      id: r.id,
      recipient: r.recipient,
      status: r.status,
      due_at: r.due_at,
      created_at: r.created_at,
      submitted_at: r.submitted_at,
      payload,
    };
  });

  const schema = parseStoredSchema(row);
  return c.json({
    form: {
      id: row.id,
      template_id: row.template_id,
      message_id: row.message_id,
      subject: row.subject,
      status: row.status,
      due_at: row.due_at,
      schema,
    },
    instances,
    responses: instances
      .filter((r) => r.submitted_at !== null)
      .map((r) => ({ instance_id: r.id, recipient: r.recipient, payload: r.payload, submitted_at: r.submitted_at })),
  });
});

/**
 * POST /api/forms/:id/revoke — 寄件人撤回（同一批 template 的所有未完成實例）
 *
 * 撤回後收件人的 GET 立即失敗（404）→ 前端自動降為靜態文字；POST 回覆則回 FORM_CLOSED。
 */
app.post("/api/forms/:id/revoke", requireSession, async (c) => {
  const scope = c.get("scope");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return err(c, "FORM_NOT_FOUND", FORM_NOT_FOUND_MESSAGE, 404);

  const row = await loadFormInstance(c.env.DB, id);
  if (!row) return err(c, "FORM_NOT_FOUND", FORM_NOT_FOUND_MESSAGE, 404);
  if (!(await isFormSender(c.env.DB, row, scope))) {
    return err(c, "FORM_NOT_AUTHORIZED", "僅寄件人可撤回表單", 403);
  }

  const ts = now();
  const res = await c.env.DB.prepare(
    `UPDATE form_instances SET status = 'revoked', updated_at = ?1
     WHERE template_id = ?2 AND status IN ('open','expired')`
  )
    .bind(ts, row.template_id)
    .run();
  const revoked = Number(res.meta.changes ?? 0);

  auditAsync(c, {
    event: "form_revoked",
    addressId: row.sender_address_id,
    ip: clientIp(c),
    userAgent: c.req.header("user-agent") ?? null,
    detail: { instance_id: row.id, template_id: row.template_id, revoked },
  });

  return c.json({ ok: true, instance_id: row.id, template_id: row.template_id, revoked });
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
