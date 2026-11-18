/**
 * login-alert.spec.ts — D40：成功登入通知信。
 *
 * 只驗證：
 * - 成功登入後寄一封到 users.contact_email
 * - 內容有時戳／IP／國別／裝置／登入方式，不含密碼或驗證碼
 * - 沒有 contact_email 或 LOGIN_ALERTS_DISABLED=true → 不寄
 * - 登入失敗不寄
 *
 * 其他既有測試在 vitest.config.ts 將 LOGIN_ALERTS_DISABLED 設為 true，
 * 避免登入通知影響原本的 sentMails 計數；本檔會自行打開。
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { hashPassword, type Env } from "../src/auth";

const E = env as unknown as Env;
const PASSWORD = "login-alert-password-01"; // secret-scan:ignore — test fixture

interface CapturedMail {
  from: string;
  to: string[];
  subject: string;
  text?: string;
  html?: string;
}

const sentMails: CapturedMail[] = [];
const hashCache = new Map<string, Promise<string>>();

function cachedHash(pw: string): Promise<string> {
  let h = hashCache.get(pw);
  if (!h) {
    h = hashPassword(pw);
    hashCache.set(pw, h);
  }
  return h;
}

function installEmailMock(): void {
  const mock = {
    send: async (msg: CapturedMail) => {
      sentMails.push({ ...msg });
      return { messageId: `alert-${sentMails.length}@atwho.org` };
    },
  };
  (E as unknown as { EMAIL: typeof mock }).EMAIL = mock;
}

async function req(path: string, init: RequestInit = {}, headers: Record<string, string> = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const finalHeaders: Record<string, string> = { ...headers };
  if (init.body && !finalHeaders["Content-Type"]) finalHeaders["Content-Type"] = "application/json";
  const res = await app.request(path, { ...init, headers: finalHeaders }, E, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function seedVisitor(opts: { contactEmail: string | null }): Promise<{ userId: number; addressId: number }> {
  const ts = Date.now();
  const userRes = await E.DB.prepare(
    `INSERT INTO users
       (username, display_name, password_hash, status, role, contact_email, email_verified, created_at, updated_at)
     VALUES ('alice', NULL, ?1, 'active', 'visitor', ?2, ?3, ?4, ?4)`
  )
    .bind(await cachedHash(PASSWORD), opts.contactEmail, opts.contactEmail ? 1 : 0, ts)
    .run();
  const userId = Number(userRes.meta.last_row_id);
  const addrRes = await E.DB.prepare(
    `INSERT INTO email_addresses
       (user_id, local_part, domain, email, password_hash, password_changed_at, status,
        can_send, daily_send_quota, sent_today, warmup_exempt, warmup_quota, created_at, updated_at)
     VALUES (?1, 'alice', 'atwho.org', 'alice@atwho.org', ?2, ?3, 'active',
             1, 50, 0, 1, 20, ?3, ?3)`
  )
    .bind(userId, await cachedHash(PASSWORD), ts)
    .run();
  return { userId, addressId: Number(addrRes.meta.last_row_id) };
}

beforeEach(async () => {
  installEmailMock();
  sentMails.length = 0;
  E.LOGIN_ALERTS_DISABLED = "false";
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
});

afterEach(() => {
  E.LOGIN_ALERTS_DISABLED = "true";
});

describe("D40：登入通知信", () => {
  it("信箱登入成功 → 寄到 contact_email，含 IP／國別／裝置，不含密碼", async () => {
    await seedVisitor({ contactEmail: "alice@example.net" });
    const res = await req(
      "/api/auth/mailbox-login",
      {
        method: "POST",
        body: JSON.stringify({ email: "alice@atwho.org", password: PASSWORD }),
      },
      {
        "cf-connecting-ip": "203.0.113.9",
        "cf-ipcountry": "TW",
        "user-agent": "TestBrowser/1.0",
      }
    );
    expect(res.status).toBe(200);
    expect(sentMails).toHaveLength(1);
    const mail = sentMails[0]!;
    expect(mail.from).toBe("noreply@atwho.org");
    expect(mail.to).toEqual(["alice@example.net"]);
    expect(mail.subject).toBe("AtWho 登入通知");
    expect(mail.text).toContain("alice");
    expect(mail.text).toContain("alice@atwho.org");
    expect(mail.text).toContain("203.0.113.9");
    expect(mail.text).toContain("TW");
    expect(mail.text).toContain("TestBrowser/1.0");
    expect(mail.text).toContain("信箱地址＋密碼");
    expect(mail.text).not.toContain(PASSWORD);
    expect(mail.html).toBeUndefined();
  });

  it("user-login 成功也會寄通知", async () => {
    await seedVisitor({ contactEmail: "alice@example.net" });
    const res = await req("/api/auth/user-login", {
      method: "POST",
      body: JSON.stringify({ identifier: "alice", password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    expect(sentMails).toHaveLength(1);
    expect(sentMails[0]!.text).toContain("AtWho ID／備用 Email＋密碼");
  });

  it("沒有 contact_email → 不寄", async () => {
    await seedVisitor({ contactEmail: null });
    const res = await req("/api/auth/mailbox-login", {
      method: "POST",
      body: JSON.stringify({ email: "alice@atwho.org", password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    expect(sentMails).toHaveLength(0);
  });

  it("登入失敗不寄", async () => {
    await seedVisitor({ contactEmail: "alice@example.net" });
    const res = await req("/api/auth/mailbox-login", {
      method: "POST",
      body: JSON.stringify({ email: "alice@atwho.org", password: "wrong-password" }),
    });
    expect(res.status).toBe(401);
    expect(sentMails).toHaveLength(0);
  });

  it("LOGIN_ALERTS_DISABLED=true → 不寄", async () => {
    await seedVisitor({ contactEmail: "alice@example.net" });
    E.LOGIN_ALERTS_DISABLED = "true";
    const res = await req("/api/auth/mailbox-login", {
      method: "POST",
      body: JSON.stringify({ email: "alice@atwho.org", password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    expect(sentMails).toHaveLength(0);
  });
});
