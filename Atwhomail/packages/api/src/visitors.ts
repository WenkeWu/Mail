/**
 * visitors.ts — 訪客 Dashboard 的聚合／搜尋／注意事項，以及 AllChat 等級投影同步。
 *
 * N9：這裡只回數量、時間、狀態、地區／語系與公開等級；不回信件主旨／寄件者／內文。
 */
import type { Env } from "./auth";

const DAY_MS = 24 * 60 * 60 * 1000;
const SYNC_WINDOW_MS = 15 * 60 * 1000;
/** 與 index.ts 的 quotaView／寄信路徑一致：暖機 24 小時、預設上限 20。 */
const WARMUP_QUOTA = 20;

/**
 * 有效每日上限（暖機中 = min(每日配額, 暖機上限)）。
 * SQL 內含一個 `?`：暖機開始時間界線（now - 24h），呼叫端需依文字順序綁定。
 */
function effectiveQuotaExpr(prefix = "a."): string {
  return `(CASE
    WHEN COALESCE(${prefix}warmup_exempt, 0) = 0 AND ${prefix}created_at > ?
      THEN MIN(${prefix}daily_send_quota, COALESCE(${prefix}warmup_quota, ${WARMUP_QUOTA}))
    ELSE ${prefix}daily_send_quota
  END)`;
}
const SYNC_INTEGRATION = "allchat_identity_levels";

export function normalizeCountryCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || code === "XX" || code === "T1") return null;
  return code;
}

export function normalizeLanguageTag(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const tag = value.trim();
  if (!/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,8})*$/.test(tag)) return null;
  return tag;
}

export function languageFromAcceptLanguage(value: string | undefined): string | null {
  if (!value) return null;
  const first = value.split(",")[0]?.trim() ?? "";
  return normalizeLanguageTag(first.split(";")[0]?.trim() ?? "");
}

/**
 * 更新最後活動時間（每 15 分鐘最多一次寫入），並在欄位為空時補上地區／語系。
 * 刻意不更新 updated_at：避免 D17 增量備份因瀏覽活動而增加。
 */
export async function touchUserActivity(
  db: D1Database,
  userId: number,
  options: { country?: string | null; language?: string | null; throttleMs?: number } = {}
): Promise<void> {
  if (!Number.isInteger(userId) || userId <= 0) return;
  const ts = Date.now();
  const threshold = ts - (options.throttleMs ?? SYNC_WINDOW_MS);
  const country = normalizeCountryCode(options.country);
  const language = normalizeLanguageTag(options.language);
  try {
    await db
      .prepare(
        `UPDATE users SET
           last_seen_at = ?1,
           last_country_code = COALESCE(?2, last_country_code),
           country_code = COALESCE(country_code, ?2),
           language = COALESCE(language, ?3)
         WHERE id = ?4 AND (last_seen_at IS NULL OR last_seen_at < ?5)`
      )
      .bind(ts, country, language, userId, threshold)
      .run();
  } catch {
    // 舊資料庫尚未套用 0019 時不影響登入
  }
}

export interface VisitorFilters {
  q?: string;
  country?: string;
  language?: string;
  status?: string;
  level?: string;
  risk?: string;
}

function filterParts(filters: VisitorFilters, withAddress: boolean): {
  join: string;
  where: string;
  binds: unknown[];
} {
  const join = withAddress
    ? `LEFT JOIN email_addresses qa ON qa.id = (
         SELECT id FROM email_addresses
         WHERE user_id = u.id AND deleted_at IS NULL
         ORDER BY id LIMIT 1
       )`
    : "";
  const where: string[] = ["u.role = 'visitor'"];
  const binds: unknown[] = [];

  if (filters.country) {
    if (filters.country.toUpperCase() === "UNKNOWN") where.push("u.country_code IS NULL");
    else {
      where.push("u.country_code = ?");
      binds.push(filters.country.trim().toUpperCase());
    }
  }
  if (filters.language) {
    if (filters.language.toUpperCase() === "UNKNOWN") where.push("u.language IS NULL");
    else {
      where.push("u.language = ?");
      binds.push(filters.language.trim());
    }
  }
  if (filters.status === "active") where.push("u.status = 'active'");
  if (filters.status === "suspended") where.push("u.status <> 'active'");
  if (filters.level) {
    if (filters.level.toUpperCase() === "UNKNOWN") where.push("p.user_id IS NULL");
    else {
      where.push("p.level = ?");
      binds.push(filters.level.trim().toUpperCase());
    }
  }
  if (filters.q) {
    where.push("(u.username LIKE ? OR qa.email LIKE ?)");
    const like = `%${filters.q.trim()}%`;
    binds.push(like, like);
  }
  return { join, where: where.join(" AND "), binds };
}

function baseCte(filters: VisitorFilters, withAddress = false) {
  const parts = filterParts(filters, withAddress);
  return {
    cte: `WITH filtered AS (
      SELECT u.id, u.username, u.status, u.created_at, u.last_seen_at,
             u.country_code, u.language,
             p.level, p.status AS level_status
      FROM users u
      ${parts.join}
      LEFT JOIN allchat_level_projection p ON p.user_id = u.id
      WHERE ${parts.where}
    )`,
    binds: parts.binds,
  };
}

function startOfUtcDay(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS;
}

async function scalar(db: D1Database, sql: string, binds: unknown[]): Promise<number> {
  const row = await db.prepare(sql).bind(...binds).first<{ count: number | null }>();
  return Number(row?.count ?? 0);
}

export interface VisitorSyncStatus {
  configured: boolean;
  lastSyncedAt: number | null;
  lastError: string | null;
  cursor: string | null;
  stale: boolean;
}

export async function getSyncStatus(env: Env): Promise<VisitorSyncStatus> {
  const configured = Boolean(env.ALLCHAT_INTERNAL_BASE_URL && env.ALLCHAT_INTERNAL_SECRET);
  try {
    const row = await env.DB.prepare(
      "SELECT cursor, last_synced_at, last_error FROM integration_sync_state WHERE integration = ?1"
    )
      .bind(SYNC_INTEGRATION)
      .first<{ cursor: string | null; last_synced_at: number | null; last_error: string | null }>();
    const last = row?.last_synced_at ?? null;
    return {
      configured,
      lastSyncedAt: last,
      lastError: row?.last_error ?? null,
      cursor: row?.cursor ?? null,
      stale: !last || Date.now() - last > SYNC_WINDOW_MS,
    };
  } catch {
    return { configured, lastSyncedAt: null, lastError: null, cursor: null, stale: true };
  }
}

export async function getVisitorOverview(
  env: Env,
  filters: VisitorFilters,
  days = 30
): Promise<Record<string, unknown>> {
  const now = Date.now();
  const dayStart = startOfUtcDay(now);
  const since7d = now - 7 * DAY_MS;
  const rangeDays = Number.isFinite(days) ? Math.min(Math.max(Math.trunc(days), 1), 90) : 30;
  const since30d = now - rangeDays * DAY_MS;
  const base = baseCte(filters, true);
  const sync = await getSyncStatus(env);

  const totals = await env.DB.prepare(
    `${base.cte}
     SELECT COUNT(*) AS total,
       SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS new_today,
       SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS new_7d,
       SUM(CASE WHEN last_seen_at >= ? THEN 1 ELSE 0 END) AS active_7d,
       SUM(CASE WHEN status <> 'active' THEN 1 ELSE 0 END) AS suspended
     FROM filtered`
  )
    .bind(...base.binds, dayStart, since7d, since7d)
    .first<Record<string, number | null>>();

  const warming = await scalar(
    env.DB,
    `${base.cte}
     SELECT COUNT(DISTINCT f.id) AS count
     FROM filtered f
     JOIN email_addresses a ON a.user_id = f.id AND a.deleted_at IS NULL
     WHERE a.created_at > ? AND COALESCE(a.warmup_exempt, 0) = 0`,
    [...base.binds, now - DAY_MS]
  );
  const nearQuota = await scalar(
    env.DB,
    `${base.cte}
     SELECT COUNT(DISTINCT f.id) AS count
     FROM filtered f
     JOIN email_addresses a ON a.user_id = f.id AND a.deleted_at IS NULL
     WHERE a.daily_send_quota > 0
       AND a.sent_today >= 0.8 * ${effectiveQuotaExpr()}`,
    [...base.binds, now - DAY_MS]
  );
  const rejected = await scalar(
    env.DB,
    `${base.cte}
     SELECT COUNT(DISTINCT ra.user_id) AS count
     FROM registration_audit ra
     JOIN filtered f ON f.id = ra.user_id
     WHERE ra.created_at >= ?
       AND ra.event IN ('send_rejected_quota', 'send_rejected_rate', 'login_failed')`,
    [...base.binds, now - DAY_MS]
  );

  const byCountry = await env.DB.prepare(
    `${base.cte}
     SELECT COALESCE(country_code, 'UNKNOWN') AS key, COUNT(*) AS count
     FROM filtered GROUP BY 1 ORDER BY count DESC LIMIT 10`
  )
    .bind(...base.binds)
    .all<{ key: string; count: number }>();
  const byLanguage = await env.DB.prepare(
    `${base.cte}
     SELECT COALESCE(language, 'UNKNOWN') AS key, COUNT(*) AS count
     FROM filtered GROUP BY 1 ORDER BY count DESC LIMIT 10`
  )
    .bind(...base.binds)
    .all<{ key: string; count: number }>();
  const byLevel = await env.DB.prepare(
    `${base.cte}
     SELECT COALESCE(level, 'UNKNOWN') AS key, COUNT(*) AS count
     FROM filtered GROUP BY 1 ORDER BY count DESC`
  )
    .bind(...base.binds)
    .all<{ key: string; count: number }>();
  const newTrend = await env.DB.prepare(
    `${base.cte}
     SELECT date(created_at / 1000, 'unixepoch') AS day, COUNT(*) AS count
     FROM filtered WHERE created_at >= ? GROUP BY 1 ORDER BY 1`
  )
    .bind(...base.binds, since30d)
    .all<{ day: string; count: number }>();
  const sentTrend = await env.DB.prepare(
    `${base.cte}
     SELECT date(m.received_at / 1000, 'unixepoch') AS day, COUNT(*) AS count
     FROM messages m
     JOIN filtered f ON f.id = m.owner_user_id
     WHERE m.folder = 'sent' AND m.deleted_at IS NULL AND m.received_at >= ?
     GROUP BY 1 ORDER BY 1`
  )
    .bind(...base.binds, since30d)
    .all<{ day: string; count: number }>();

  return {
    totals: {
      total: Number(totals?.total ?? 0),
      new_today: Number(totals?.new_today ?? 0),
      new_7d: Number(totals?.new_7d ?? 0),
      active_7d: Number(totals?.active_7d ?? 0),
      suspended: Number(totals?.suspended ?? 0),
      warming,
      near_quota: nearQuota,
      rejected_24h: rejected,
    },
    by_country: byCountry.results,
    by_language: byLanguage.results,
    by_level: byLevel.results,
    trends: { registrations: newTrend.results, sent: sentTrend.results },
    sync,
    filter_required: false,
  };
}

export interface VisitorSearchResult {
  users: Array<Record<string, unknown>>;
  has_more: boolean;
  filter_required: boolean;
}

export async function searchVisitors(
  env: Env,
  filters: VisitorFilters,
  page = 1,
  limit = 25
): Promise<VisitorSearchResult> {
  const hasFilter = Boolean(
    filters.q || filters.country || filters.language || filters.status || filters.level || filters.risk
  );
  if (!hasFilter) return { users: [], has_more: false, filter_required: true };

  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 25, 1), 50);
  const safePage = Math.max(Math.trunc(page) || 1, 1);
  const offset = (safePage - 1) * safeLimit;
  const now = Date.now();
  const parts = filterParts(filters, true);
  const where = [parts.where];
  const binds: unknown[] = [];
  let riskJoin = "";
  let riskSelect = "0 AS quota_rejects, 0 AS rate_rejects, 0 AS login_fails";
  let riskBind: unknown[] = [];

  if (filters.risk) {
    riskJoin = `LEFT JOIN (
      SELECT user_id,
        SUM(CASE WHEN event = 'send_rejected_quota' THEN 1 ELSE 0 END) AS quota_rejects,
        SUM(CASE WHEN event = 'send_rejected_rate' THEN 1 ELSE 0 END) AS rate_rejects,
        SUM(CASE WHEN event = 'login_failed' THEN 1 ELSE 0 END) AS login_fails
      FROM registration_audit
      WHERE created_at >= ?
      GROUP BY user_id
    ) ra ON ra.user_id = u.id`;
    riskSelect = "COALESCE(ra.quota_rejects,0) AS quota_rejects, COALESCE(ra.rate_rejects,0) AS rate_rejects, COALESCE(ra.login_fails,0) AS login_fails";
    riskBind = [now - DAY_MS];
    if (filters.risk === "quota") where.push("ra.quota_rejects > 0");
    else if (filters.risk === "rate") where.push("ra.rate_rejects > 0");
    else if (filters.risk === "login") where.push("ra.login_fails > 0");
    else if (filters.risk === "near_quota") {
      where.push(`a.daily_send_quota > 0 AND a.sent_today >= 0.8 * ${effectiveQuotaExpr()}`);
    }
    else if (filters.risk === "restricted") where.push("p.status = 'restricted'");
  }

  const riskThresholdBind = filters.risk === "near_quota" ? [now - DAY_MS] : [];
  const rows = await env.DB.prepare(
    `SELECT u.id, u.username, u.status, u.created_at, u.last_seen_at,
            u.country_code, u.language,
            a.id AS address_id, a.email, a.status AS address_status,
            a.can_send, a.daily_send_quota, a.sent_today,
            a.warmup_exempt, a.warmup_quota,
            p.level, p.scope AS level_scope, p.status AS level_status,
            p.synced_at AS level_synced_at,
            ${riskSelect}
     FROM users u
     LEFT JOIN email_addresses a ON a.id = (
       SELECT id FROM email_addresses
       WHERE user_id = u.id AND deleted_at IS NULL
       ORDER BY id LIMIT 1
     )
     LEFT JOIN allchat_level_projection p ON p.user_id = u.id
     ${riskJoin}
     ${parts.join}
     WHERE ${where.join(" AND ")}
     ORDER BY COALESCE(u.last_seen_at, u.created_at) DESC, u.id DESC
     LIMIT ? OFFSET ?`
  )
    .bind(...riskBind, ...parts.binds, ...riskThresholdBind, safeLimit + 1, offset)
    .all<Record<string, unknown>>();

  const hasMore = rows.results.length > safeLimit;
  const pageRows = hasMore ? rows.results.slice(0, safeLimit) : rows.results;
  const ids = pageRows.map((row) => Number(row.id)).filter((id) => Number.isInteger(id));
  const counts = new Map<number, { mail_count: number; last_mail_at: number | null }>();
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    const countRows = await env.DB.prepare(
      `SELECT owner_user_id, COUNT(*) AS mail_count, MAX(received_at) AS last_mail_at
       FROM messages
       WHERE owner_user_id IN (${placeholders}) AND deleted_at IS NULL
       GROUP BY owner_user_id`
    )
      .bind(...ids)
      .all<{ owner_user_id: number; mail_count: number; last_mail_at: number | null }>();
    for (const row of countRows.results) {
      counts.set(Number(row.owner_user_id), {
        mail_count: Number(row.mail_count ?? 0),
        last_mail_at: row.last_mail_at ?? null,
      });
    }
  }

  return {
    users: pageRows.map((row) => {
      const id = Number(row.id);
      const count = counts.get(id);
      const lastSeen = row.last_seen_at === null || row.last_seen_at === undefined ? null : Number(row.last_seen_at);
      const lastMail = count?.last_mail_at ?? null;
      return {
        id,
        username: row.username,
        status: row.status === "active" ? "active" : "suspended",
        created_at: Number(row.created_at ?? 0),
        country_code: row.country_code ?? null,
        language: row.language ?? null,
        last_seen_at: lastSeen,
        level: row.level ?? null,
        level_scope: row.level_scope ?? null,
        level_status: row.level_status ?? null,
        level_synced_at: row.level_synced_at ?? null,
        quota_rejected_24h: Number(row.quota_rejects ?? 0),
        rate_rejected_24h: Number(row.rate_rejects ?? 0),
        login_failed_24h: Number(row.login_fails ?? 0),
        address:
          row.address_id === null || row.address_id === undefined
            ? null
            : {
                id: Number(row.address_id),
                email: row.email,
                status: row.address_status,
                can_send: row.can_send,
                daily_send_quota: row.daily_send_quota,
                sent_today: row.sent_today,
                warmup_exempt: row.warmup_exempt,
                warmup_quota: Number(row.warmup_quota ?? 20),
              },
        mail_count: count?.mail_count ?? 0,
        last_activity_at: Math.max(lastSeen ?? 0, lastMail ?? 0) || null,
      };
    }),
    has_more: hasMore,
    filter_required: false,
  };
}

export interface VisitorAttention {
  items: Array<Record<string, unknown>>;
  sync: VisitorSyncStatus;
}

export async function getVisitorAttention(env: Env, limit = 20): Promise<VisitorAttention> {
  const now = Date.now();
  const safeLimit = Math.min(Math.max(Math.trunc(limit) || 20, 1), 50);
  const items = new Map<number, Record<string, unknown>>();
  const merge = (row: Record<string, unknown>, reason: string, severity: "warn" | "high") => {
    const id = Number(row.id);
    const current = items.get(id);
    if (!current) {
      items.set(id, {
        ...row,
        id,
        reasons: [reason],
        severity,
      });
      return;
    }
    const reasons = new Set([...(current.reasons as string[]), reason]);
    current.reasons = [...reasons];
    current.severity = current.severity === "high" || severity === "high" ? "high" : "warn";
    current.quota_rejected_24h = Math.max(Number(current.quota_rejected_24h ?? 0), Number(row.quota_rejected_24h ?? 0));
    current.rate_rejected_24h = Math.max(Number(current.rate_rejected_24h ?? 0), Number(row.rate_rejected_24h ?? 0));
    current.login_failed_24h = Math.max(Number(current.login_failed_24h ?? 0), Number(row.login_failed_24h ?? 0));
  };

  const baseSelect = `
    SELECT u.id, u.username, u.status, u.created_at, u.last_seen_at,
           u.country_code, u.language,
           a.id AS address_id, a.email, a.status AS address_status,
           a.daily_send_quota, a.sent_today,
           a.created_at AS address_created_at, a.warmup_exempt, a.warmup_quota,
           p.level, p.status AS level_status,
           0 AS quota_rejected_24h, 0 AS rate_rejected_24h, 0 AS login_failed_24h
    FROM users u
    LEFT JOIN email_addresses a ON a.id = (
      SELECT id FROM email_addresses
      WHERE user_id = u.id AND deleted_at IS NULL
      ORDER BY id LIMIT 1
    )
    LEFT JOIN allchat_level_projection p ON p.user_id = u.id
    WHERE u.role = 'visitor'`;

  const near = await env.DB.prepare(
    `${baseSelect}
     AND u.status = 'active'
     AND a.daily_send_quota > 0
     AND a.sent_today >= 0.8 * ${effectiveQuotaExpr()}
     ORDER BY (a.sent_today * 1.0 / a.daily_send_quota) DESC, u.id
     LIMIT ?2`
  )
    .bind(now - DAY_MS, safeLimit)
    .all<Record<string, unknown>>();
  for (const row of near.results) {
    const daily = Number(row.daily_send_quota);
    const createdAt = Number(row.address_created_at ?? 0);
    const warming = row.warmup_exempt !== 1 && createdAt > now - DAY_MS;
    const effective = warming
      ? Math.min(daily, Number(row.warmup_quota ?? WARMUP_QUOTA))
      : daily;
    const ratio = Number(row.sent_today) / Math.max(effective, 1);
    merge(row, "near_quota", ratio >= 1 ? "high" : "warn");
  }

  const audit = await env.DB.prepare(
    `SELECT u.id, u.username, u.status, u.created_at, u.last_seen_at,
            u.country_code, u.language,
            a.id AS address_id, a.email, a.status AS address_status,
            a.daily_send_quota, a.sent_today,
            p.level, p.status AS level_status,
            ra.quota_rejects AS quota_rejected_24h,
            ra.rate_rejects AS rate_rejected_24h,
            ra.login_fails AS login_failed_24h
     FROM users u
     LEFT JOIN email_addresses a ON a.id = (
       SELECT id FROM email_addresses
       WHERE user_id = u.id AND deleted_at IS NULL
       ORDER BY id LIMIT 1
     )
     LEFT JOIN allchat_level_projection p ON p.user_id = u.id
     JOIN (
       SELECT user_id,
         SUM(CASE WHEN event = 'send_rejected_quota' THEN 1 ELSE 0 END) AS quota_rejects,
         SUM(CASE WHEN event = 'send_rejected_rate' THEN 1 ELSE 0 END) AS rate_rejects,
         SUM(CASE WHEN event = 'login_failed' THEN 1 ELSE 0 END) AS login_fails
       FROM registration_audit
       WHERE created_at >= ?1 AND event IN ('send_rejected_quota','send_rejected_rate','login_failed')
       GROUP BY user_id
     ) ra ON ra.user_id = u.id
     WHERE u.role = 'visitor' AND (ra.quota_rejects > 0 OR ra.rate_rejects > 0 OR ra.login_fails > 0)
     ORDER BY (ra.quota_rejects * 3 + ra.rate_rejects * 2 + ra.login_fails) DESC, u.id
     LIMIT ?2`
  )
    .bind(now - DAY_MS, safeLimit)
    .all<Record<string, unknown>>();
  for (const row of audit.results) {
    if (Number(row.quota_rejected_24h) > 0) merge(row, "quota_rejected", "high");
    if (Number(row.rate_rejected_24h) > 0) merge(row, "rate_rejected", "warn");
    if (Number(row.login_failed_24h) > 0) merge(row, "login_failed", "warn");
  }

  const restricted = await env.DB.prepare(
    `${baseSelect} AND p.status = 'restricted' ORDER BY u.last_seen_at DESC, u.id LIMIT ?1`
  )
    .bind(safeLimit)
    .all<Record<string, unknown>>();
  for (const row of restricted.results) merge(row, "allchat_restricted", "high");

  const suspended = await env.DB.prepare(
    `${baseSelect} AND u.status <> 'active' ORDER BY u.last_seen_at DESC, u.id LIMIT ?1`
  )
    .bind(safeLimit)
    .all<Record<string, unknown>>();
  for (const row of suspended.results) merge(row, "suspended", "warn");

  return {
    items: [...items.values()]
      .sort((a, b) => {
        const rank = (v: Record<string, unknown>) => (v.severity === "high" ? 2 : 1);
        return rank(b) - rank(a) || Number(b.last_seen_at ?? 0) - Number(a.last_seen_at ?? 0);
      })
      .slice(0, safeLimit),
    sync: await getSyncStatus(env),
  };
}

// ── AllChat 等級投影 ─────────────────────────────────────────

const enc = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function saveSyncState(
  env: Env,
  state: { cursor?: string | null; lastSyncedAt?: number | null; lastError?: string | null }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO integration_sync_state (integration, cursor, last_synced_at, last_error)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(integration) DO UPDATE SET
       cursor = COALESCE(excluded.cursor, integration_sync_state.cursor),
       last_synced_at = COALESCE(excluded.last_synced_at, integration_sync_state.last_synced_at),
       last_error = excluded.last_error`
  )
    .bind(SYNC_INTEGRATION, state.cursor ?? null, state.lastSyncedAt ?? null, state.lastError ?? null)
    .run();
}

function projectionStatements(env: Env, levels: Array<Record<string, unknown>>): D1PreparedStatement[] {
  return levels
    .map((level) => {
      const userId = Number(level.mailUserId);
      if (!Number.isInteger(userId) || userId <= 0) return null;
      if (level.removed === true || level.level === null || level.level === undefined) {
        return env.DB.prepare("DELETE FROM allchat_level_projection WHERE user_id = ?1").bind(userId);
      }
      return env.DB.prepare(
        `INSERT INTO allchat_level_projection
           (user_id, level, scope, status, source_version, source_updated_at, synced_at, sync_state)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'synced'
          WHERE EXISTS (SELECT 1 FROM users WHERE id = ?1)
         ON CONFLICT(user_id) DO UPDATE SET
           level = excluded.level,
           scope = excluded.scope,
           status = excluded.status,
           source_version = excluded.source_version,
           source_updated_at = excluded.source_updated_at,
           synced_at = excluded.synced_at,
           sync_state = 'synced'`
      ).bind(
        userId,
        String(level.level),
        level.scope ? String(level.scope) : null,
        level.status ? String(level.status) : "normal",
        Number(level.version ?? 0),
        level.updatedAt ? Number(level.updatedAt) : null,
        Date.now()
      );
    })
    .filter((statement): statement is D1PreparedStatement => statement !== null);
}

async function signedGet(
  base: string,
  path: string,
  secret: string,
  fetcher: typeof fetch
): Promise<Response> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = await hmacHex(secret, `${timestamp}.GET.${path}.`);
  return fetcher(`${base}${path}`, {
    headers: {
      "X-AtWho-Service": "mail",
      "X-AtWho-Timestamp": timestamp,
      "X-AtWho-Signature": signature,
      Accept: "application/json",
    },
  });
}

/**
 * 第一次同步（還沒有 cursor）先抓 snapshot，補齊 Mail 尚未看過的既有等級。
 * AllChat 尚未實作 snapshot（404／405）時直接略過，改用 changes since=0。
 */
async function bootstrapSnapshot(
  env: Env,
  base: string,
  secret: string,
  fetcher: typeof fetch
): Promise<number> {
  let after = "0";
  let applied = 0;
  for (let page = 0; page < 20; page += 1) {
    const path = `/api/internal/identity-levels/snapshot?afterMailUserId=${encodeURIComponent(after)}&limit=500`;
    const response = await signedGet(base, path, secret, fetcher);
    if (response.status === 404 || response.status === 405) return applied;
    if (!response.ok) throw new Error(`AllChat snapshot ${response.status}`);
    const payload = (await response.json()) as {
      levels?: Array<Record<string, unknown>>;
      nextMailUserId?: unknown;
      nextCursor?: unknown;
      hasMore?: unknown;
    };
    const statements = projectionStatements(env, Array.isArray(payload.levels) ? payload.levels : []);
    if (statements.length > 0) {
      await env.DB.batch(statements);
      applied += statements.length;
    }
    const next = payload.nextMailUserId ?? payload.nextCursor;
    if (payload.hasMore !== true || next === null || next === undefined) break;
    after = String(next);
  }
  return applied;
}

export async function syncAllChatLevels(
  env: Env,
  fetcher: typeof fetch = fetch
): Promise<{
  ok: boolean;
  synced: number;
  cursor: string | null;
  error?: string;
}> {
  const base = (env.ALLCHAT_INTERNAL_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const secret = (env.ALLCHAT_INTERNAL_SECRET ?? "").trim();
  if (!base || !secret) {
    return { ok: false, synced: 0, cursor: null, error: "not_configured" };
  }

  let cursor = "0";
  let needsBootstrap = true;
  try {
    const state = await env.DB.prepare(
      "SELECT cursor FROM integration_sync_state WHERE integration = ?1"
    )
      .bind(SYNC_INTEGRATION)
      .first<{ cursor: string | null }>();
    if (state?.cursor !== null && state?.cursor !== undefined) {
      cursor = state.cursor;
      needsBootstrap = false;
    }
  } catch {
    needsBootstrap = true;
  }

  let synced = 0;
  try {
    if (needsBootstrap) {
      try {
        synced += await bootstrapSnapshot(env, base, secret, fetcher);
      } catch (error) {
        // snapshot 不是必要端點；失敗時仍以 changes since=0 補資料
        console.warn("[atwhomail-api] allchat snapshot skipped", { error: String(error) });
      }
    }

    for (let page = 0; page < 10; page += 1) {
      const path = `/api/internal/identity-levels/changes?since=${encodeURIComponent(cursor)}&limit=500`;
      const response = await signedGet(base, path, secret, fetcher);
      if (!response.ok) {
        throw new Error(`AllChat ${response.status}`);
      }
      const payload = (await response.json()) as {
        levels?: Array<Record<string, unknown>>;
        changes?: Array<Record<string, unknown>>;
        nextCursor?: unknown;
        hasMore?: unknown;
      };
      const levels = Array.isArray(payload.levels)
        ? payload.levels
        : Array.isArray(payload.changes)
          ? payload.changes
          : [];
      const statements = projectionStatements(env, levels);
      if (statements.length > 0) {
        await env.DB.batch(statements);
        synced += statements.length;
      }
      const next = payload.nextCursor;
      if (next !== null && next !== undefined) cursor = String(next);
      if (payload.hasMore !== true) break;
    }
    await saveSyncState(env, { cursor, lastSyncedAt: Date.now(), lastError: null });
    return { ok: true, synced, cursor };
  } catch (error) {
    const message = error instanceof Error ? error.message : "sync_failed";
    await saveSyncState(env, { cursor, lastSyncedAt: null, lastError: message }).catch(() => undefined);
    return { ok: false, synced, cursor, error: message };
  }
}
