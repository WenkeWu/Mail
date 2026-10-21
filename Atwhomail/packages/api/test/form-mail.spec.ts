/**
 * form-mail.spec.ts — API 端 P1／P2（docs/18 §11 T36、T39–T52）
 *
 * 以真實 D1 + R2 執行；EMAIL binding 以 mock 注入並記錄呼叫次數（T40：互動式表單絕不呼叫）。
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { hashPassword, type Env } from "../src/auth";

const E = env as unknown as Env;
const OWNER_PW = "owner-password-forms";
const ALICE_PW = "alice-password-forms";
const BOB_PW = "bob-password-forms";

const hashCache = new Map<string, Promise<string>>();
function cachedHash(pw: string): Promise<string> {
  let h = hashCache.get(pw);
  if (!h) {
    h = hashPassword(pw);
    hashCache.set(pw, h);
  }
  return h;
}

/** EMAIL mock：記錄每次呼叫（本地直送路徑必須為 0） */
const sentMails: Array<{ from: string; to: string[]; subject: string }> = [];
const emailMock = {
  send: async (msg: { from: string; to: string[]; subject: string }) => {
    sentMails.push({ from: msg.from, to: msg.to, subject: msg.subject });
    return { messageId: `mock-${sentMails.length}@atwho.org` };
  },
};

async function req(
  path: string,
  init: RequestInit = {},
  token?: string,
  extraHeaders: Record<string, string> = {}
): Promise<Response> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = { ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const res = await app.request(path, { ...init, headers }, E, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function ownerToken(): Promise<string> {
  const res = await req("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "owner", password: OWNER_PW }),
  });
  return ((await json<{ token?: string }>(res)).token ?? "") as string;
}

async function mailboxToken(email: string, password: string): Promise<string> {
  const res = await req("/api/auth/mailbox-login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
  return ((await json<{ token?: string }>(res)).token ?? "") as string;
}

const SEND = (to: string, extra: Record<string, unknown> = {}) => ({
  method: "POST",
  body: JSON.stringify({
    from: "alice@atwho.org",
    to: [to],
    subject: "Local mail",
    text: "Hello internal",
    ...extra,
  }),
});

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
  const existing = await E.MAIL.list();
  for (const obj of existing.objects) await E.MAIL.delete(obj.key);
  sentMails.length = 0;
  (E as unknown as { EMAIL: typeof emailMock }).EMAIL = emailMock;

  const ts = Date.now();
  const aliceHash = await cachedHash(ALICE_PW);
  const bobHash = await cachedHash(BOB_PW);
  await E.DB.prepare(
    "INSERT INTO users (id, username, display_name, password_hash, status, created_at, updated_at) VALUES (1,'owner','Owner',?, 'active', ?, ?)"
  )
    .bind(await cachedHash(OWNER_PW), ts, ts)
    .run();
  await E.DB.prepare(
    `INSERT INTO email_addresses (id, user_id, local_part, domain, email, password_hash, status, password_changed_at, created_at, updated_at)
     VALUES (1, 1, 'alice', 'atwho.org', 'alice@atwho.org', ?, 'active', ?, ?, ?),
            (2, 1, 'bob',   'atwho.org', 'bob@atwho.org',   ?, 'active', ?, ?, ?)`
  )
    .bind(aliceHash, ts, ts, ts, bobHash, ts, ts, ts)
    .run();
});

describe("P1：一般郵件本地直送（T36）", () => {
  it("T36：全內部收件人 → 本地直送、origin=internal、kind=normal、delivery_scope=internal，且不呼叫 EMAIL.send", async () => {
    const token = await ownerToken();
    const res = await req("/api/mail/send", SEND("bob@atwho.org"), token);
    expect(res.status).toBe(200);
    const body = await json<{ delivery_scope?: string }>(res);
    expect(body.delivery_scope).toBe("internal");
    expect(sentMails.length).toBe(0); // 絕不繞 SMTP

    const bob = await E.DB.prepare(
      "SELECT * FROM messages WHERE address_id = 2 AND folder = 'inbox'"
    ).first<Record<string, unknown>>();
    expect(bob).not.toBeNull();
    expect(bob!.origin).toBe("internal");
    expect(bob!.kind).toBe("normal");
    expect(bob!.delivery_scope).toBe("internal");
    expect(bob!.from_address).toBe("alice@atwho.org");
    expect(bob!.subject).toBe("Local mail");

    const sent = await E.DB.prepare(
      "SELECT * FROM messages WHERE address_id = 1 AND folder = 'sent'"
    ).first<Record<string, unknown>>();
    expect(sent).not.toBeNull();
    expect(sent!.origin).toBe("internal");
    expect(sent!.delivery_scope).toBe("internal");

    // 每位收件人都有自己的 raw .eml（不得共用 key）
    expect(String(bob!.raw_r2_key)).not.toBe(String(sent!.raw_r2_key));
    expect(await E.MAIL.get(String(bob!.raw_r2_key))).not.toBeNull();
  });

  it("本地直送仍消毒 HTML，並保存收件人的 HTML 內文", async () => {
    const token = await ownerToken();
    const res = await req(
      "/api/mail/send",
      SEND("bob@atwho.org", {
        text: "Hi",
        html: '<p>Hi <b>there</b></p><script>alert(1)</script><a href="javascript:x()">bad</a>',
      }),
      token
    );
    expect(res.status).toBe(200);
    const bob = await E.DB.prepare("SELECT html_r2_key FROM messages WHERE address_id = 2").first<{ html_r2_key: string }>();
    expect(bob?.html_r2_key).toBeTruthy();
    const html = await (await E.MAIL.get(bob!.html_r2_key))!.text();
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("<b>there</b>");
  });

  it("含外部收件人 → 維持 EMAIL.send()（行為不變）", async () => {
    const token = await ownerToken();
    const res = await req("/api/mail/send", SEND("outside@example.com"), token);
    expect(res.status).toBe(200);
    const body = await json<{ delivery_scope?: string }>(res);
    expect(body.delivery_scope).toBe("external");
    expect(sentMails.length).toBe(1);
    const sent = await E.DB.prepare("SELECT * FROM messages WHERE folder = 'sent'").first<Record<string, unknown>>();
    expect(sent!.delivery_scope).toBe("external");
  });

  it("本網域但地址不存在／停用 → 不本地直送（沿用既有 EMAIL.send 行為）", async () => {
    const token = await ownerToken();
    await E.DB.prepare("UPDATE email_addresses SET status = 'disabled' WHERE id = 2").run();
    const res = await req("/api/mail/send", SEND("bob@atwho.org"), token);
    expect(res.status).toBe(200);
    expect(sentMails.length).toBe(1);
    const inbox = await E.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE address_id = 2 AND folder = 'inbox'").first<{ n: number }>();
    expect(inbox?.n).toBe(0);
  });
});

describe("P1：信件詳情回傳分類欄位（T37 的 API 面）", () => {
  it("外部 fake-From 的信件仍顯示 origin=external（不因 From 取得內部身分）", async () => {
    const ts = Date.now();
    await E.DB.prepare(
      `INSERT INTO messages
         (id, owner_user_id, address_id, folder, from_address, to_address, cc, subject, text_preview,
          received_at, raw_r2_key, created_at, updated_at, origin, kind, delivery_scope,
          sender_spf, sender_dkim, sender_dmarc)
       VALUES (1, 1, 1, 'inbox', 'alice@atwho.org', '[]', '[]', 'spoof', 'p', ?, 'mail/x.eml', ?, ?, 'external', 'normal', 'external',
               'fail', 'fail', 'fail')`
    )
      .bind(ts, ts, ts)
      .run();
    const token = await mailboxToken("alice@atwho.org", ALICE_PW);
    const res = await req("/api/mail/1", {}, token);
    const body = await json<Record<string, unknown>>(res);
    expect(body.origin).toBe("external");
    expect(body.kind).toBe("normal");
    expect(body.sender_spf).toBe("fail");
    expect(body.sender_dkim).toBe("fail");
    expect(body.sender_dmarc).toBe("fail");
  });
});
