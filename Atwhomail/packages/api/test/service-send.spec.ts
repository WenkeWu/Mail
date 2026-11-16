/**
 * service-send.spec.ts — D39：外部系統「只寄信」service token、Reply-To、Idempotency-Key。
 *
 * 覆蓋：
 * - service token 建立／列表／撤銷；DB 只存 hash
 * - `/api/service/mail/send` 固定寄件地址、不能冒用 from
 * - `reply_to` 會傳給 Cloudflare，也會寫進本地直送與寄件備份的 RFC822 標頭
 * - `Idempotency-Key` 同 key＋同內容只寄一次；不同內容 → 409
 * - service 自己的每小時／每日上限
 * - 一般 `/api/mail/send` 也能使用 reply_to／Idempotency-Key
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import type { Env } from "../src/auth";

const E = env as unknown as Env;
const ADMIN = "test-admin-token";

interface CapturedMail {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: string;
}

const sentMails: CapturedMail[] = [];

function installEmailMock(): void {
  const mock = {
    send: async (msg: CapturedMail) => {
      sentMails.push({ ...msg });
      return { messageId: `mock-${sentMails.length}@atwho.org` };
    },
  };
  (E as unknown as { EMAIL: typeof mock }).EMAIL = mock;
}

async function req(
  path: string,
  init: RequestInit = {},
  headers: Record<string, string> = {}
): Promise<Response> {
  const ctx = createExecutionContext();
  const finalHeaders: Record<string, string> = {
    ...((init.headers ?? {}) as Record<string, string>),
    ...headers,
  };
  if (init.body && !finalHeaders["Content-Type"]) finalHeaders["Content-Type"] = "application/json";
  const res = await app.request(path, { ...init, headers: finalHeaders }, E, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const asJson = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

async function seedBase(): Promise<{ ownerId: number; senderId: number }> {
  const ts = Date.now();
  const owner = await E.DB.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, status, role, created_at, updated_at)
     VALUES (1, 'owner', 'Owner', 'x', 'active', 'owner', ?1, ?1)`
  )
    .bind(ts)
    .run();
  const sender = await E.DB.prepare(
    `INSERT INTO email_addresses
       (id, user_id, local_part, domain, email, password_hash, password_changed_at, status,
        can_send, daily_send_quota, sent_today, warmup_exempt, warmup_quota, created_at, updated_at)
     VALUES (1, 1, 'flow', 'atwho.org', 'flow@atwho.org', NULL, 0, 'active',
             1, 50, 0, 1, 20, ?1, ?1)`
  )
    .bind(ts)
    .run();
  return { ownerId: Number(owner.meta.last_row_id), senderId: Number(sender.meta.last_row_id) };
}

async function seedInternalRecipient(): Promise<void> {
  const ts = Date.now();
  await E.DB.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, status, role, created_at, updated_at)
     VALUES (2, 'dest', 'Dest', 'x', 'active', 'visitor', ?1, ?1)`
  )
    .bind(ts)
    .run();
  await E.DB.prepare(
    `INSERT INTO email_addresses
       (id, user_id, local_part, domain, email, password_hash, password_changed_at, status,
        can_send, daily_send_quota, sent_today, warmup_exempt, warmup_quota, created_at, updated_at)
     VALUES (2, 2, 'dest', 'atwho.org', 'dest@atwho.org', 'x', ?1, 'active',
             1, 50, 0, 0, 20, ?1, ?1)`
  )
    .bind(ts)
    .run();
}

async function createToken(opts: {
  address_id: number;
  hourly_limit?: number;
  daily_limit?: number;
  name?: string;
}): Promise<{ id: number; token: string }> {
  const res = await req(
    "/api/admin/service-tokens",
    asJson({
      name: opts.name ?? "trace-flow",
      address_id: opts.address_id,
      hourly_limit: opts.hourly_limit,
      daily_limit: opts.daily_limit,
    }),
    { "x-admin-token": ADMIN }
  );
  expect(res.status).toBe(201);
  return json<{ id: number; token: string }>(res);
}

beforeEach(async () => {
  installEmailMock();
  sentMails.length = 0;
  for (const table of [
    "send_idempotency",
    "service_tokens",
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
  await seedBase();
});

describe("D39：service token 管理", () => {
  it("建立 token 只回一次明碼；DB 只存 hash；列表不外洩明碼", async () => {
    const address = await E.DB.prepare("SELECT id FROM email_addresses WHERE email = 'flow@atwho.org'").first<{
      id: number;
    }>();
    const created = await createToken({ address_id: address!.id, hourly_limit: 30, daily_limit: 200 });
    expect(created.token).toMatch(/^atw_svc_[0-9a-f]{64}$/);
    expect(created.id).toBeGreaterThan(0);

    const row = await E.DB.prepare("SELECT token_hash, hourly_limit, daily_limit FROM service_tokens WHERE id = ?1")
      .bind(created.id)
      .first<{ token_hash: string; hourly_limit: number; daily_limit: number }>();
    expect(row?.token_hash).toHaveLength(64);
    expect(row?.token_hash).not.toBe(created.token);
    expect(row).toMatchObject({ hourly_limit: 30, daily_limit: 200 });

    const list = await req("/api/admin/service-tokens", {}, { "x-admin-token": ADMIN });
    const body = await json<{ tokens: Array<Record<string, unknown>> }>(list);
    expect(body.tokens).toHaveLength(1);
    expect(body.tokens[0]).toMatchObject({
      id: created.id,
      name: "trace-flow",
      address_id: address!.id,
      email: "flow@atwho.org",
      status: "active",
    });
    expect(body.tokens[0]).not.toHaveProperty("token");
    expect(body.tokens[0]).not.toHaveProperty("token_hash");
  });

  it("撤銷後 service token 立即失效（401）", async () => {
    const address = await E.DB.prepare("SELECT id FROM email_addresses WHERE email = 'flow@atwho.org'").first<{ id: number }>();
    const created = await createToken({ address_id: address!.id });
    const revoked = await req(`/api/admin/service-tokens/${created.id}`, { method: "DELETE" }, { "x-admin-token": ADMIN });
    expect(revoked.status).toBe(200);

    const res = await req(
      "/api/service/mail/send",
      asJson({ to: ["x@example.com"], subject: "s", text: "t" }),
      { Authorization: `Bearer ${created.token}` }
    );
    expect(res.status).toBe(401);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("UNAUTHORIZED");
  });
});

describe("D39：service send", () => {
  it("固定使用綁定地址；reply_to 會傳給 Cloudflare；不能冒用其他 from", async () => {
    const address = await E.DB.prepare("SELECT id FROM email_addresses WHERE email = 'flow@atwho.org'").first<{ id: number }>();
    const { token } = await createToken({ address_id: address!.id });

    const res = await req(
      "/api/service/mail/send",
      asJson({
        to: ["user@example.com"],
        subject: "驗證碼",
        text: "您的驗證碼是 123456",
        reply_to: "support@atwho.org",
      }),
      { Authorization: `Bearer ${token}` }
    );
    expect(res.status).toBe(200);
    const body = await json<{ from: string; delivery_scope: string; messageId: string }>(res);
    expect(body.from).toBe("flow@atwho.org");
    expect(body.delivery_scope).toBe("external");
    expect(body.messageId).toMatch(/^mock-/);
    expect(sentMails).toHaveLength(1);
    expect(sentMails[0]).toMatchObject({
      from: "flow@atwho.org",
      to: ["user@example.com"],
      replyTo: "support@atwho.org",
    });

    const bad = await req(
      "/api/service/mail/send",
      asJson({ from: "other@atwho.org", to: ["user@example.com"], subject: "s", text: "t" }),
      { Authorization: `Bearer ${token}` }
    );
    expect(bad.status).toBe(403);
    expect((await json<{ error: { code: string } }>(bad)).error.code).toBe("FROM_NOT_ALLOWED");
  });

  it("一般 /api/mail/send 也支援 reply_to 與 Idempotency-Key", async () => {
    const res = await req(
      "/api/mail/send",
      {
        method: "POST",
        body: JSON.stringify({
          from: "flow@atwho.org",
          to: ["user@example.com"],
          subject: "s",
          text: "t",
          reply_to: "support@atwho.org",
        }),
        headers: { "Idempotency-Key": "human-key-1" },
      },
      { "x-admin-token": ADMIN }
    );
    expect(res.status).toBe(200);
    expect(sentMails[0]?.replyTo).toBe("support@atwho.org");

    const replay = await req(
      "/api/mail/send",
      {
        method: "POST",
        body: JSON.stringify({
          from: "flow@atwho.org",
          to: ["user@example.com"],
          subject: "s",
          text: "t",
          reply_to: "support@atwho.org",
        }),
        headers: { "Idempotency-Key": "human-key-1" },
      },
      { "x-admin-token": ADMIN }
    );
    expect(replay.status).toBe(200);
    expect(await json<{ messageId: string }>(replay)).toEqual(await json<{ messageId: string }>(res));
    expect(sentMails).toHaveLength(1);
  });

  it("本地直送與寄件備份的 .eml 都含 Reply-To", async () => {
    await seedInternalRecipient();
    const address = await E.DB.prepare("SELECT id FROM email_addresses WHERE email = 'flow@atwho.org'").first<{ id: number }>();
    const { token } = await createToken({ address_id: address!.id });

    const res = await req(
      "/api/service/mail/send",
      asJson({
        to: ["dest@atwho.org"],
        subject: "內部測試",
        text: "hello",
        reply_to: "support@atwho.org",
      }),
      { Authorization: `Bearer ${token}` }
    );
    expect(res.status).toBe(200);
    expect((await json<{ delivery_scope: string }>(res)).delivery_scope).toBe("internal");

    const sent = await E.DB.prepare(
      "SELECT raw_r2_key FROM messages WHERE address_id = 1 AND folder = 'sent' ORDER BY id DESC LIMIT 1"
    ).first<{ raw_r2_key: string }>();
    const inbox = await E.DB.prepare(
      "SELECT raw_r2_key FROM messages WHERE address_id = 2 AND folder = 'inbox' ORDER BY id DESC LIMIT 1"
    ).first<{ raw_r2_key: string }>();
    for (const key of [sent?.raw_r2_key, inbox?.raw_r2_key]) {
      const object = await E.MAIL.get(key!);
      const eml = await object!.text();
      expect(eml).toContain("Reply-To: support@atwho.org");
    }
  });
});

describe("D39：Idempotency-Key", () => {
  it("同 key＋同內容只寄一次，重播回相同 messageId；不同內容 → 409", async () => {
    const address = await E.DB.prepare("SELECT id FROM email_addresses WHERE email = 'flow@atwho.org'").first<{ id: number }>();
    const { token } = await createToken({ address_id: address!.id });
    const headers = { Authorization: `Bearer ${token}`, "Idempotency-Key": "code-abc" };
    const payload = { to: ["user@example.com"], subject: "驗證碼", text: "123456" };

    const first = await req("/api/service/mail/send", asJson(payload), headers);
    const second = await req("/api/service/mail/send", asJson(payload), headers);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = await json<{ messageId: string }>(first);
    expect(await json<{ messageId: string }>(second)).toEqual(firstBody);
    expect(sentMails).toHaveLength(1);

    const row = await E.DB.prepare("SELECT sent_today FROM email_addresses WHERE id = 1").first<{ sent_today: number }>();
    expect(row?.sent_today).toBe(1);

    const conflict = await req(
      "/api/service/mail/send",
      asJson({ ...payload, subject: "不同主旨" }),
      headers
    );
    expect(conflict.status).toBe(409);
    expect((await json<{ error: { code: string } }>(conflict)).error.code).toBe("IDEMPOTENCY_CONFLICT");

    const next = await req(
      "/api/service/mail/send",
      asJson(payload),
      { ...headers, "Idempotency-Key": "code-def" }
    );
    expect(next.status).toBe(200);
    expect(sentMails).toHaveLength(2);
  });
});

describe("D39：service 自己的速率上限", () => {
  it("hourly_limit 生效（第 2 封 → 429 RATE_LIMITED）", async () => {
    const address = await E.DB.prepare("SELECT id FROM email_addresses WHERE email = 'flow@atwho.org'").first<{ id: number }>();
    const { token } = await createToken({ address_id: address!.id, hourly_limit: 1, daily_limit: 50 });
    const send = () =>
      req(
        "/api/service/mail/send",
        asJson({ to: ["user@example.com"], subject: "s", text: "t" }),
        { Authorization: `Bearer ${token}` }
      );

    expect((await send()).status).toBe(200);
    const second = await send();
    expect(second.status).toBe(429);
    expect((await json<{ error: { code: string } }>(second)).error.code).toBe("RATE_LIMITED");
  });

  it("daily_limit 生效（第 2 封 → 429 QUOTA_EXCEEDED）", async () => {
    const address = await E.DB.prepare("SELECT id FROM email_addresses WHERE email = 'flow@atwho.org'").first<{ id: number }>();
    const { token } = await createToken({ address_id: address!.id, hourly_limit: 50, daily_limit: 1 });
    const send = () =>
      req(
        "/api/service/mail/send",
        asJson({ to: ["user@example.com"], subject: "s", text: "t" }),
        { Authorization: `Bearer ${token}` }
      );

    expect((await send()).status).toBe(200);
    const second = await send();
    expect(second.status).toBe(429);
    expect((await json<{ error: { code: string } }>(second)).error.code).toBe("QUOTA_EXCEEDED");
    // service 被擋不寄配額提醒信
    expect(sentMails).toHaveLength(1);
  });
});
