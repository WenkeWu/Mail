/**
 * visitor-dashboard.spec.ts — D38：訪客 Dashboard／篩選式搜尋／注意事項／AllChat 等級投影。
 *
 * 重點：
 * - 預設不再提供完整訪客清單；搜尋沒有條件 → `filter_required: true`
 * - 聚合只回數量與時間（N9），並以索引欄位過濾
 * - AllChat 是等級唯一 source of truth；Mail 只保存投影，同步採 pull（不用 webhook）
 * - 同步簽章：HMAC_SHA256(secret, `${timestamp}.${method}.${path}.${rawBody}`)
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { hashPassword, type Env } from "../src/auth";
import { syncAllChatLevels } from "../src/visitors";

const E = env as unknown as Env;
const OWNER = "owner";
const OWNER_PW = "owner-password-d38";
const VISITOR_PW = "visitor-password-d38";

const hashCache = new Map<string, Promise<string>>();
function cachedHash(pw: string): Promise<string> {
  let h = hashCache.get(pw);
  if (!h) {
    h = hashPassword(pw);
    hashCache.set(pw, h);
  }
  return h;
}

async function req(path: string, init: RequestInit = {}, token?: string): Promise<Response> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const res = await app.request(path, { ...init, headers }, E, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function login(path: string, body: Record<string, string>): Promise<string> {
  const res = await req(path, { method: "POST", body: JSON.stringify(body) });
  return ((await json<{ token?: string }>(res)).token ?? "") as string;
}

const ownerToken = () => login("/api/auth/login", { username: OWNER, password: OWNER_PW });

interface Seed {
  username: string;
  email: string;
  status?: string;
  createdAt?: number;
  lastSeenAt?: number | null;
  country?: string | null;
  language?: string | null;
  quota?: number;
  sentToday?: number;
  level?: string | null;
  levelStatus?: string | null;
}

async function seedVisitor(opts: Seed): Promise<{ userId: number; addressId: number }> {
  const ts = opts.createdAt ?? Date.now();
  const userRes = await E.DB.prepare(
    `INSERT INTO users (username, display_name, password_hash, status, role,
                        country_code, language, last_seen_at, created_at, updated_at)
     VALUES (?1, NULL, ?2, ?3, 'visitor', ?4, ?5, ?6, ?7, ?7)`
  )
    .bind(
      opts.username,
      await cachedHash(VISITOR_PW),
      opts.status ?? "active",
      opts.country ?? null,
      opts.language ?? null,
      opts.lastSeenAt ?? null,
      ts
    )
    .run();
  const userId = Number(userRes.meta.last_row_id);
  const addrRes = await E.DB.prepare(
    `INSERT INTO email_addresses
       (user_id, local_part, domain, email, password_hash, password_changed_at, status,
        can_send, daily_send_quota, sent_today, warmup_exempt, warmup_quota, created_at, updated_at)
     VALUES (?1, ?2, 'atwho.org', ?3, ?4, ?5, 'active', 1, ?6, ?7, 0, 20, ?5, ?5)`
  )
    .bind(
      userId,
      opts.email.split("@")[0]!,
      opts.email,
      await cachedHash(VISITOR_PW),
      ts,
      opts.quota ?? 50,
      opts.sentToday ?? 0
    )
    .run();
  const addressId = Number(addrRes.meta.last_row_id);
  if (opts.level) {
    await E.DB.prepare(
      `INSERT INTO allchat_level_projection
         (user_id, level, scope, status, source_version, source_updated_at, synced_at)
       VALUES (?1, ?2, 'global', ?3, 1, ?4, ?4)`
    )
      .bind(userId, opts.level, opts.levelStatus ?? "normal", ts)
      .run();
  }
  return { userId, addressId };
}

async function seedSent(opts: { userId: number; addressId: number; receivedAt: number }): Promise<void> {
  await E.DB.prepare(
    `INSERT INTO messages
       (owner_user_id, address_id, folder, message_id, from_address, to_address, cc,
        subject, text_preview, received_at, raw_r2_key, created_at, updated_at)
     VALUES (?1, ?2, 'sent', ?3, 'x@atwho.org', '[]', '[]', 's', 'p', ?4, ?5, ?4, ?4)`
  )
    .bind(opts.userId, opts.addressId, `<sent-${opts.userId}@atwho.org>`, opts.receivedAt, `sent/${opts.userId}.eml`)
    .run();
}

beforeEach(async () => {
  for (const table of [
    "allchat_level_projection",
    "integration_sync_state",
    "registration_audit",
    "attachments",
    "messages",
    "email_aliases",
    "email_addresses",
    "users",
    "auth_attempts",
  ]) {
    await E.DB.prepare(`DELETE FROM ${table}`).run();
  }
  const ts = Date.now();
  await E.DB.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, status, role, created_at, updated_at)
     VALUES (1, ?1, 'Owner', ?2, 'active', 'owner', ?3, ?3)`
  )
    .bind(OWNER, await cachedHash(OWNER_PW), ts)
    .run();
  delete E.ALLCHAT_INTERNAL_BASE_URL;
  delete E.ALLCHAT_INTERNAL_SECRET;
});

afterEach(() => {
  delete E.ALLCHAT_INTERNAL_BASE_URL;
  delete E.ALLCHAT_INTERNAL_SECRET;
});

describe("D38：GET /api/admin/visitors/overview", () => {
  it("KPI／國家／語系／等級／趨勢只回數量與時間（N9）", async () => {
    const now = Date.now();
    const v1 = await seedVisitor({
      username: "alice",
      email: "alice@atwho.org",
      country: "TW",
      language: "zh-TW",
      createdAt: now - 60_000,
      lastSeenAt: now - 30_000,
      sentToday: 45,
      level: "T1",
    });
    await seedVisitor({
      username: "bob",
      email: "bob@atwho.org",
      country: "US",
      language: "en",
      status: "disabled",
      createdAt: now - 2 * 86400_000,
      lastSeenAt: now - 2 * 86400_000,
      level: "T0",
    });
    await seedVisitor({
      username: "carol",
      email: "carol@atwho.org",
      createdAt: now - 10 * 86400_000,
      lastSeenAt: null,
    });
    await seedSent({ ...v1, receivedAt: now - 60_000 });
    await E.DB.prepare(
      "INSERT INTO registration_audit (event, user_id, address_id, created_at) VALUES ('send_rejected_quota', ?1, ?2, ?3)"
    )
      .bind(v1.userId, v1.addressId, now - 60_000)
      .run();

    const token = await ownerToken();
    const res = await req("/api/admin/visitors/overview", {}, token);
    expect(res.status).toBe(200);
    const body = await json<{
      totals: Record<string, number>;
      by_country: Array<{ key: string; count: number }>;
      by_language: Array<{ key: string; count: number }>;
      by_level: Array<{ key: string; count: number }>;
      trends: { registrations: unknown[]; sent: unknown[] };
      sync: { configured: boolean };
      filter_required: boolean;
    }>(res);

    expect(body.totals).toMatchObject({
      total: 3,
      new_today: 1,
      new_7d: 2,
      active_7d: 2,
      suspended: 1,
      warming: 1,
      near_quota: 1,
      rejected_24h: 1,
    });
    expect(body.by_country).toEqual(
      expect.arrayContaining([
        { key: "TW", count: 1 },
        { key: "US", count: 1 },
        { key: "UNKNOWN", count: 1 },
      ])
    );
    expect(body.by_language).toEqual(
      expect.arrayContaining([
        { key: "zh-TW", count: 1 },
        { key: "en", count: 1 },
        { key: "UNKNOWN", count: 1 },
      ])
    );
    expect(body.by_level).toEqual(
      expect.arrayContaining([
        { key: "T1", count: 1 },
        { key: "T0", count: 1 },
        { key: "UNKNOWN", count: 1 },
      ])
    );
    expect(body.trends.sent.length).toBeGreaterThan(0);
    expect(body.sync.configured).toBe(false);
    expect(body.filter_required).toBe(false);
    expect(Object.keys(body.totals).sort()).toEqual(
      ["active_7d", "near_quota", "new_7d", "new_today", "rejected_24h", "suspended", "total", "warming"].sort()
    );
    for (const key of ["subject", "from", "text_preview", "html", "messages"]) {
      expect(Object.keys(body)).not.toContain(key);
    }
  });

  it("國家篩選套用到所有聚合", async () => {
    await seedVisitor({ username: "alice", email: "alice@atwho.org", country: "TW", language: "zh-TW" });
    await seedVisitor({ username: "bob", email: "bob@atwho.org", country: "US", language: "en" });
    const token = await ownerToken();
    const body = await json<{ totals: { total: number }; by_country: unknown[] }>(
      await req("/api/admin/visitors/overview?country=TW", {}, token)
    );
    expect(body.totals.total).toBe(1);
    expect(body.by_country).toEqual([{ key: "TW", count: 1 }]);
  });

  it("權限：無 session 401、訪客 JWT 403", async () => {
    await seedVisitor({ username: "alice", email: "alice@atwho.org" });
    expect((await req("/api/admin/visitors/overview")).status).toBe(401);
    const visitor = await login("/api/auth/mailbox-login", { email: "alice@atwho.org", password: VISITOR_PW });
    expect((await req("/api/admin/visitors/overview", {}, visitor)).status).toBe(403);
  });
});

describe("D38：GET /api/admin/visitors/search", () => {
  it("沒有任何條件 → filter_required，不回傳任何訪客", async () => {
    await seedVisitor({ username: "alice", email: "alice@atwho.org" });
    const token = await ownerToken();
    const body = await json<{ users: unknown[]; filter_required: boolean }>(
      await req("/api/admin/visitors/search", {}, token)
    );
    expect(body.filter_required).toBe(true);
    expect(body.users).toEqual([]);
  });

  it("q／國家／語系／狀態／等級／風險皆可搜尋，且回傳唯讀等級", async () => {
    const now = Date.now();
    const alice = await seedVisitor({
      username: "alice",
      email: "alice@atwho.org",
      country: "TW",
      language: "zh-TW",
      createdAt: now - 3600_000,
      lastSeenAt: now - 60_000,
      sentToday: 45,
      level: "T1",
    });
    const bob = await seedVisitor({
      username: "bob",
      email: "bob@atwho.org",
      country: "US",
      language: "en",
      status: "disabled",
      level: "T0",
    });
    await E.DB.prepare(
      "INSERT INTO registration_audit (event, user_id, address_id, created_at) VALUES ('login_failed', ?1, ?2, ?3)"
    )
      .bind(bob.userId, bob.addressId, now - 60_000)
      .run();

    const token = await ownerToken();
    const search = async (query: string) => {
      const res = await req(`/api/admin/visitors/search?${query}`, {}, token);
      expect(res.status).toBe(200);
      return json<{
        users: Array<{
          username: string;
          country_code: string | null;
          language: string | null;
          level: string | null;
          level_status: string | null;
          address: { email: string } | null;
          mail_count: number;
        }>;
        has_more: boolean;
        filter_required: boolean;
      }>(res);
    };

    expect((await search("q=alice")).users.map((u) => u.username)).toEqual(["alice"]);
    expect((await search("q=alice%40atwho.org")).users.map((u) => u.username)).toEqual(["alice"]);
    expect((await search("country=US")).users.map((u) => u.username)).toEqual(["bob"]);
    expect((await search("language=zh-TW")).users.map((u) => u.username)).toEqual(["alice"]);
    expect((await search("status=suspended")).users.map((u) => u.username)).toEqual(["bob"]);
    expect((await search("level=T0")).users.map((u) => u.username)).toEqual(["bob"]);
    expect((await search("risk=near_quota")).users.map((u) => u.username)).toEqual(["alice"]);
    expect((await search("risk=login")).users.map((u) => u.username)).toEqual(["bob"]);

    const one = (await search("q=alice")).users[0]!;
    expect(one).toMatchObject({
      username: "alice",
      country_code: "TW",
      language: "zh-TW",
      level: "T1",
      level_status: "normal",
      address: { email: "alice@atwho.org" },
    });
    expect(one.mail_count).toBe(0);
    expect(alice.userId).toBeGreaterThan(0);
  });

  it("limit 上限 50；權限：訪客 403、無 session 401", async () => {
    await seedVisitor({ username: "alice", email: "alice@atwho.org" });
    const token = await ownerToken();
    const res = await req("/api/admin/visitors/search?status=active&limit=999", {}, token);
    expect(res.status).toBe(200);
    const body = await json<{ users: unknown[] }>(res);
    expect(body.users.length).toBeLessThanOrEqual(50);

    expect((await req("/api/admin/visitors/search?status=active")).status).toBe(401);
    const visitor = await login("/api/auth/mailbox-login", { email: "alice@atwho.org", password: VISITOR_PW });
    expect((await req("/api/admin/visitors/search?status=active", {}, visitor)).status).toBe(403);
  });
});

describe("D38：GET /api/admin/visitors/attention", () => {
  it("近配額／被擋／登入失敗／受限等級／停權都會進注意清單", async () => {
    const now = Date.now();
    const near = await seedVisitor({
      username: "near",
      email: "near@atwho.org",
      sentToday: 48,
      level: "T1",
    });
    const blocked = await seedVisitor({ username: "blocked", email: "blocked@atwho.org" });
    const restricted = await seedVisitor({
      username: "restricted",
      email: "restricted@atwho.org",
      level: "T0",
      levelStatus: "restricted",
    });
    await seedVisitor({ username: "suspended", email: "suspended@atwho.org", status: "disabled" });
    await E.DB.prepare(
      "INSERT INTO registration_audit (event, user_id, address_id, created_at) VALUES ('send_rejected_quota', ?1, ?2, ?3)"
    )
      .bind(blocked.userId, blocked.addressId, now - 60_000)
      .run();

    const token = await ownerToken();
    const body = await json<{
      items: Array<{ username: string; reasons: string[]; severity: string }>;
      sync: { configured: boolean };
    }>(await req("/api/admin/visitors/attention?limit=20", {}, token));

    const byName = new Map(body.items.map((item) => [item.username, item]));
    expect(byName.get("near")?.reasons).toContain("near_quota");
    expect(byName.get("blocked")?.reasons).toContain("quota_rejected");
    expect(byName.get("restricted")?.reasons).toContain("allchat_restricted");
    expect(byName.get("suspended")?.reasons).toContain("suspended");
    expect(byName.get("restricted")?.severity).toBe("high");
    expect(near.userId).toBeGreaterThan(0);
    expect(restricted.userId).toBeGreaterThan(0);
  });
});

describe("D38：AllChat 等級投影同步（pull）", () => {
  it("未設定環境 → 手動同步回 503 ALLCHAT_NOT_CONFIGURED", async () => {
    const token = await ownerToken();
    const res = await req("/api/admin/integrations/allchat/sync", { method: "POST" }, token);
    expect(res.status).toBe(503);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("ALLCHAT_NOT_CONFIGURED");
  });

  it("以 HMAC 標頭拉取 changes，更新投影／cursor，removed 會刪除投影", async () => {
    const alice = await seedVisitor({ username: "alice", email: "alice@atwho.org" });
    const bob = await seedVisitor({
      username: "bob",
      email: "bob@atwho.org",
      level: "T1",
    });
    E.ALLCHAT_INTERNAL_BASE_URL = "https://chat.atwho.org/";
    E.ALLCHAT_INTERNAL_SECRET = "test-internal-secret";

    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      if (url.includes("/snapshot")) {
        // 第一次同步會先抓 snapshot；本案例假設 snapshot 為空，資料由 changes 補齊
        return new Response(JSON.stringify({ levels: [], hasMore: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          levels: [
            {
              mailUserId: alice.userId,
              level: "T2",
              scope: "global",
              status: "normal",
              version: 3,
              updatedAt: Date.now(),
            },
            { mailUserId: bob.userId, removed: true },
            // Mail 沒有的使用者 → 忽略，不建立孤兒列
            { mailUserId: 99999, level: "T4", version: 1 },
          ],
          nextCursor: "100",
          hasMore: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const result = await syncAllChatLevels(E, fetcher);
    expect(result).toMatchObject({ ok: true, synced: 3, cursor: "100" });
    const changesCall = calls.find((call) => call.url.includes("/changes"));
    expect(changesCall?.url).toBe(
      "https://chat.atwho.org/api/internal/identity-levels/changes?since=0&limit=500"
    );
    expect(calls.some((call) => call.url.includes("/snapshot?afterMailUserId=0"))).toBe(true);
    const headers = changesCall!.headers;
    expect(headers["X-AtWho-Service"]).toBe("mail");
    const timestamp = headers["X-AtWho-Timestamp"]!;
    const path = "/api/internal/identity-levels/changes?since=0&limit=500";
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("test-internal-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${timestamp}.GET.${path}.`)
    );
    const expected = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(headers["X-AtWho-Signature"]).toBe(expected);

    const aliceLevel = await E.DB.prepare(
      "SELECT level, source_version FROM allchat_level_projection WHERE user_id = ?1"
    )
      .bind(alice.userId)
      .first<{ level: string; source_version: number }>();
    expect(aliceLevel).toMatchObject({ level: "T2", source_version: 3 });
    const bobLevel = await E.DB.prepare("SELECT 1 AS n FROM allchat_level_projection WHERE user_id = ?1")
      .bind(bob.userId)
      .first();
    expect(bobLevel).toBeNull();
    const orphan = await E.DB.prepare("SELECT 1 AS n FROM allchat_level_projection WHERE user_id = 99999").first();
    expect(orphan).toBeNull();

    const state = await E.DB.prepare(
      "SELECT cursor, last_synced_at, last_error FROM integration_sync_state WHERE integration = 'allchat_identity_levels'"
    ).first<{ cursor: string; last_synced_at: number; last_error: string | null }>();
    expect(state?.cursor).toBe("100");
    expect(state?.last_synced_at).toBeGreaterThan(0);
    expect(state?.last_error).toBeNull();

    const token = await ownerToken();
    const status = await json<{ sync: { configured: boolean; cursor: string; stale: boolean } }>(
      await req("/api/admin/integrations/allchat/status", {}, token)
    );
    expect(status.sync.configured).toBe(true);
    expect(status.sync.cursor).toBe("100");
    expect(status.sync.stale).toBe(false);
  });
});

describe("D38：登入時補齊訪客地區／語系／最近活動", () => {
  it("mailbox-login 會寫入 country_code／language／last_seen_at", async () => {
    const { userId } = await seedVisitor({ username: "alice", email: "alice@atwho.org" });
    const res = await req("/api/auth/mailbox-login", {
      method: "POST",
      body: JSON.stringify({
        email: "alice@atwho.org",
        password: VISITOR_PW,
        country: "TW",
        language: "zh-TW",
      }),
    });
    expect(res.status).toBe(200);
    const row = await E.DB.prepare(
      "SELECT country_code, language, last_country_code, last_seen_at FROM users WHERE id = ?1"
    )
      .bind(userId)
      .first<{
        country_code: string | null;
        language: string | null;
        last_country_code: string | null;
        last_seen_at: number | null;
      }>();
    expect(row?.country_code).toBe("TW");
    expect(row?.language).toBe("zh-TW");
    expect(row?.last_country_code).toBe("TW");
    expect(row?.last_seen_at).toBeGreaterThan(0);
  });
});
