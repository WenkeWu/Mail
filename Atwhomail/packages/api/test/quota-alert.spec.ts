/**
 * quota-alert.spec.ts — D33：訪客每日配額 50 與超額提醒信（owner 2026-11-07）
 *
 * 規則：
 * - 所有訪客（Email 驗證碼／邀請碼／OAuth）每日配額 50；管理頁可調 1–50。
 * - 訪客嘗試超過每日配額被 429 擋下時，寄提醒信到其「備用電子郵件」
 *   （users.contact_email）；同一訪客每天最多一封。
 * - 暖機期 5 封上限、owner 帳號、沒有備用 email 者都不寄。
 *
 * 測試在 workerd 內以真實 D1 執行；EMAIL binding 以 mock 注入。
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { hashPassword, type Env } from "../src/auth";

const E = env as unknown as Env;
const VISITOR_PW = "visitor-password-01";

interface SentMail {
  from: string;
  to: string[];
  subject: string;
  text?: string;
  html?: string;
}

const sentMails: SentMail[] = [];
let pwHash: Promise<string> | null = null;

function hash(): Promise<string> {
  pwHash ??= hashPassword(VISITOR_PW);
  return pwHash;
}

function installEmailMock(): void {
  const mock = {
    send: async (msg: SentMail) => {
      sentMails.push({ from: msg.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
      return { messageId: `mock-${sentMails.length}@atwho.org` };
    },
  };
  (E as unknown as { EMAIL: typeof mock }).EMAIL = mock;
}

beforeEach(async () => {
  for (const t of [
    "form_responses",
    "form_instances",
    "form_templates",
    "attachments",
    "messages",
    "registration_audit",
    "email_aliases",
    "email_addresses",
    "auth_attempts",
    "users",
  ]) {
    await E.DB.prepare(`DELETE FROM ${t}`).run();
  }
  sentMails.length = 0;
  installEmailMock();
});

async function req(path: string, init: RequestInit = {}, token?: string): Promise<Response> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const res = await app.request(path, { ...init, headers }, E, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function login(email: string): Promise<string> {
  const res = await req("/api/auth/mailbox-login", {
    method: "POST",
    body: JSON.stringify({ email, password: VISITOR_PW }),
  });
  return ((await json<{ token?: string }>(res)).token ?? "") as string;
}

async function seedAddress(opts: {
  email: string;
  role?: "visitor" | "owner";
  contactEmail?: string | null;
  quota?: number;
  sentToday?: number;
  warmupQuota?: number;
  createdAt?: number;
}): Promise<{ userId: number; addressId: number }> {
  const ts = opts.createdAt ?? Date.now() - 2 * 24 * 3600_000; // 預設已過暖機期
  // null 代表「明確沒有備用 email」；未提供才用預設值（?? 會把 null 也當成未提供）
  const contactEmail = opts.contactEmail === undefined ? "backup@example.com" : opts.contactEmail;
  const userRes = await E.DB.prepare(
    `INSERT INTO users (username, display_name, password_hash, status, role, contact_email, created_at, updated_at)
     VALUES (?1, NULL, ?2, 'active', ?3, ?4, ?5, ?5)`
  )
    .bind(`u-${opts.email}`, await hash(), opts.role ?? "visitor", contactEmail, ts)
    .run();
  const userId = Number(userRes.meta.last_row_id);
  const localPart = opts.email.split("@")[0]!;
  const quota = opts.quota ?? 2;
  const warmupQuota = opts.warmupQuota ?? 5;
  const addrRes = await E.DB.prepare(
    `INSERT INTO email_addresses
       (user_id, local_part, domain, email, password_hash, password_changed_at, status,
        can_send, daily_send_quota, sent_today, warmup_quota, quota_reset_at, created_at, updated_at)
     VALUES (?1, ?2, 'atwho.org', ?3, ?4, ?4, 'active', 1, ?5, ?6, ?7, ?8, ?9, ?9)`
  )
    .bind(
      userId,
      localPart,
      opts.email,
      await hash(),
      quota,
      opts.sentToday ?? quota,
      warmupQuota,
      Date.now() + 86_400_000,
      ts
    )
    .run();
  return { userId, addressId: Number(addrRes.meta.last_row_id) };
}

function sendMail(token: string, from: string): Promise<Response> {
  return req(
    "/api/mail/send",
    {
      method: "POST",
      body: JSON.stringify({ from, to: ["outside@example.com"], subject: "quota-test", text: "hello" }),
    },
    token
  );
}

function errorCode(body: unknown): string {
  return (body as { error?: { code?: string } }).error?.code ?? "";
}

describe("D33：訪客超額提醒信", () => {
  it("超過每日配額 → 429，寄一封提醒信到訪客的備用電子郵件", async () => {
    await seedAddress({ email: "v1@atwho.org", quota: 2, sentToday: 2, contactEmail: "backup@example.com" });
    const token = await login("v1@atwho.org");

    const res = await sendMail(token, "v1@atwho.org");
    expect(res.status).toBe(429);
    expect(errorCode(await json(res))).toBe("QUOTA_EXCEEDED");

    expect(sentMails).toHaveLength(1);
    const mail = sentMails[0]!;
    expect(mail.from).toBe("noreply@atwho.org");
    expect(mail.to).toEqual(["backup@example.com"]);
    expect(mail.subject).toContain("寄信額度已用完");
    expect(mail.subject).toContain("2");
    expect(mail.text).toContain("每日上限 2 封");
    expect(mail.text).toContain("v1@atwho.org");

    // 稽核只記上限，不含信件內容（N9）
    const audit = await E.DB.prepare(
      "SELECT detail FROM registration_audit WHERE event = 'quota_alert_sent'"
    ).first<{ detail: string }>();
    expect(JSON.parse(audit!.detail)).toEqual({ limit: 2, warmup: false });
  });

  it("同一訪客同一天重複超額 → 只寄一封", async () => {
    await seedAddress({ email: "v2@atwho.org", quota: 1, sentToday: 1 });
    const token = await login("v2@atwho.org");

    expect((await sendMail(token, "v2@atwho.org")).status).toBe(429);
    expect((await sendMail(token, "v2@atwho.org")).status).toBe(429);

    expect(sentMails).toHaveLength(1);
    const alerts = await E.DB.prepare(
      "SELECT COUNT(*) AS n FROM registration_audit WHERE event = 'quota_alert_sent'"
    ).first<{ n: number }>();
    expect(alerts!.n).toBe(1);
  });

  it("沒有備用電子郵件 → 不寄提醒信", async () => {
    await seedAddress({ email: "v3@atwho.org", quota: 1, sentToday: 1, contactEmail: null });
    const token = await login("v3@atwho.org");

    expect((await sendMail(token, "v3@atwho.org")).status).toBe(429);
    expect(sentMails).toHaveLength(0);
  });

  it("owner 帳號 → 不寄提醒信（只針對訪客）", async () => {
    await seedAddress({ email: "owner1@atwho.org", role: "owner", quota: 1, sentToday: 1 });
    const token = await login("owner1@atwho.org");

    expect((await sendMail(token, "owner1@atwho.org")).status).toBe(429);
    expect(sentMails).toHaveLength(0);
  });

  it("暖機期 5 封上限被擋 → 也寄提醒信（內容標明暖機期與結束時間）", async () => {
    await seedAddress({
      email: "warm@atwho.org",
      quota: 50,
      sentToday: 5,
      createdAt: Date.now(), // 仍在註冊後 24 小時內
    });
    const token = await login("warm@atwho.org");

    const res = await sendMail(token, "warm@atwho.org");
    expect(res.status).toBe(429);
    expect((await json<{ error: { message: string } }>(res)).error.message).toContain("暖機");

    expect(sentMails).toHaveLength(1);
    const mail = sentMails[0]!;
    expect(mail.subject).toContain("暖機期");
    expect(mail.text).toContain("暖機期上限 5 封");
    expect(mail.text).toContain("結束後每日上限為 50 封");
    expect(mail.text).toContain(" UTC");

    const audit = await E.DB.prepare(
      "SELECT detail FROM registration_audit WHERE event = 'quota_alert_sent'"
    ).first<{ detail: string }>();
    expect(JSON.parse(audit!.detail)).toEqual({ limit: 5, warmup: true });
  });

  it("D35：暖機上限改為 10 → 第 11 封被擋，提醒信標明 10 封", async () => {
    await seedAddress({
      email: "warm10@atwho.org",
      quota: 50,
      sentToday: 10,
      warmupQuota: 10,
      createdAt: Date.now(),
    });
    const token = await login("warm10@atwho.org");

    const res = await sendMail(token, "warm10@atwho.org");
    expect(res.status).toBe(429);
    expect((await json<{ error: { message: string } }>(res)).error.message).toContain("10");

    expect(sentMails).toHaveLength(1);
    expect(sentMails[0]!.subject).toContain("10");
    expect(sentMails[0]!.text).toContain("暖機期上限 10 封");
    expect(sentMails[0]!.text).toContain("結束後每日上限為 50 封");
  });

  it("互動式表單寄送超過配額 → 同樣寄提醒信", async () => {
    await seedAddress({ email: "form1@atwho.org", quota: 1, sentToday: 1 });
    await seedAddress({ email: "form2@atwho.org", quota: 14, contactEmail: null });
    const token = await login("form1@atwho.org");

    const res = await req(
      "/api/forms/send",
      {
        method: "POST",
        body: JSON.stringify({
          from: "form1@atwho.org",
          to: ["form2@atwho.org"],
          subject: "form quota",
          schema: { type: "object", properties: { answer: { type: "string" } } },
        }),
      },
      token
    );
    expect(res.status).toBe(429);
    expect(errorCode(await json(res))).toBe("QUOTA_EXCEEDED");
    expect(sentMails).toHaveLength(1);
    expect(sentMails[0]!.to).toEqual(["backup@example.com"]);
  });
});
