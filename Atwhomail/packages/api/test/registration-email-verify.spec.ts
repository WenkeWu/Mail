/**
 * registration-email-verify.spec.ts — D21：Email 驗證碼註冊（docs/21 §7 T92–T99）
 *
 * 測試在 workerd 內以真實 D1 執行；`EMAIL` binding 以 mock 注入（測試環境未綁 send_email）。
 * 驗證碼只存在 Email 內容與 DB 的雜湊中 → 測試從 mock 信件解析 6 位數。
 *
 * 覆蓋：
 * - T92 正常寄碼（6 位數、15 分鐘、不含個資、DB 只存雜湊）
 * - T93 ID 重複 → 409 ID_TAKEN，不寄碼
 * - T94 錯誤 5 次 → CODE_LOCKED（正確碼也失效）
 * - T95 過期 → CODE_EXPIRED
 * - T96 60 秒內重寄 → 429 CODE_COOLDOWN
 * - T97 驗證成功 → user＋address（warmup）＋ token＋稽核
 * - T98 同一碼只能用一次 → 第二次 CODE_INVALID
 * - T99 closed → 403 REGISTRATION_CLOSED；invite → 舊流程可用
 * 追加：保留字、Email 每日 5 封、IP 每小時 5 次、registration-mode 端點。
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import type { Env } from "../src/auth";

const E = env as unknown as Env;

/** docs/14 §4.2 的訪客密碼規則：≥10 且非純數字 */
const VISITOR_PW = "visitor-password-01";

interface SentMail {
  from: string;
  to: string[];
  subject: string;
  text?: string;
  html?: string;
}

const sentMails: SentMail[] = [];

function installEmailMock(): void {
  const mock = {
    send: async (msg: SentMail) => {
      sentMails.push({ from: msg.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
      return { messageId: `mock-${sentMails.length}@atwho.org` };
    },
  };
  (E as unknown as { EMAIL: typeof mock }).EMAIL = mock;
}

async function req(path: string, body: unknown, ip: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.request(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify(body),
    },
    E,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function get(path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.request(path, {}, E, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function errorCode(body: unknown): string {
  return (body as { error?: { code?: string } })?.error?.code ?? "";
}

function lastMail(): SentMail {
  const mail = sentMails[sentMails.length - 1];
  if (!mail) throw new Error("沒有任何寄出的信件");
  return mail;
}

/** 從信件文字取出 6 位數驗證碼（正式程式只存雜湊；測試必須從信裡拿） */
function codeFrom(mail: SentMail): string {
  const match = (mail.text ?? "").match(/\b(\d{6})\b/);
  if (!match) throw new Error(`信件找不到 6 位數驗證碼：${mail.text ?? ""}`);
  return match[1]!;
}

function requestCode(email: string, localPart: string, ip: string): Promise<Response> {
  return req("/api/auth/register-request", { email, local_part: localPart }, ip);
}

function verifyCode(email: string, localPart: string, code: string, ip: string, password = VISITOR_PW): Promise<Response> {
  return req("/api/auth/register-verify", { email, local_part: localPart, code, password }, ip);
}

/** 讓同一 Email 的 60 秒冷卻立即到期（模擬時間流逝，測試不真的等） */
async function clearResendCooldown(email: string): Promise<void> {
  await E.DB.prepare("UPDATE auth_attempts SET locked_until = 0 WHERE key = ?1").bind(`register:${email}`).run();
}

beforeEach(async () => {
  installEmailMock();
  sentMails.length = 0;
  E.REGISTRATION_MODE = "email_verify";
  E.REGISTRATION_DISABLED = "false";
  for (const t of [
    "email_verifications",
    "registration_audit",
    "auth_attempts",
    "invites",
    "attachments",
    "messages",
    "email_aliases",
    "email_addresses",
    "users",
  ]) {
    await E.DB.prepare(`DELETE FROM ${t}`).run();
  }
  const ts = Date.now();
  // owner 僅作為 invites.created_by 的 FK 目標（本檔不測 owner 登入）
  await E.DB.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, status, role, created_at, updated_at)
     VALUES (1, 'owner', 'Owner', 'x', 'active', 'owner', ?1, ?1)`
  )
    .bind(ts)
    .run();
});

describe("T92–T96：寄碼與驗碼限制", { timeout: 30_000 }, () => {
  it("T92 register-request 正常寄碼（6 位數、15 分鐘、不含個資、DB 只存雜湊）", async () => {
    const res = await requestCode("User@Example.COM", "Alice", "203.0.113.92");
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ sent: true, expiresIn: 900 });

    expect(sentMails).toHaveLength(1);
    const mail = lastMail();
    expect(mail.from).toBe("noreply@atwho.org");
    expect(mail.to).toEqual(["user@example.com"]);
    expect(mail.subject).not.toMatch(/\d{6}/);

    const code = codeFrom(mail);
    expect(code).toMatch(/^\d{6}$/);
    // 內容只有一組 6 位數；不含 local_part／Email 等個資
    expect((mail.text ?? "").match(/\b\d{6}\b/g)).toHaveLength(1);
    expect((mail.text ?? "").toLowerCase()).not.toContain("alice");
    expect((mail.text ?? "").toLowerCase()).not.toContain("user@example.com");

    const row = await E.DB.prepare(
      `SELECT email, code_hash, purpose, attempts, created_at, expires_at, consumed_at, ip
       FROM email_verifications ORDER BY id DESC LIMIT 1`
    ).first<{
      email: string;
      code_hash: string;
      purpose: string;
      attempts: number;
      created_at: number;
      expires_at: number;
      consumed_at: number | null;
      ip: string;
    }>();
    expect(row).toBeTruthy();
    expect(row!.email).toBe("user@example.com");
    expect(row!.purpose).toBe("register");
    expect(row!.attempts).toBe(0);
    expect(row!.consumed_at).toBeNull();
    expect(row!.ip).toBe("203.0.113.92");
    expect(row!.expires_at - row!.created_at).toBe(15 * 60 * 1000);
    // DB 不存明碼：64 字元 SHA-256、且不含驗證碼本身
    expect(row!.code_hash).toHaveLength(64);
    expect(row!.code_hash).not.toContain(code);

    const audit = await E.DB.prepare(
      "SELECT event, detail FROM registration_audit ORDER BY id DESC LIMIT 1"
    ).first<{ event: string; detail: string }>();
    expect(audit?.event).toBe("register_requested");
    expect(JSON.parse(audit!.detail)).toEqual({ local_part: "alice" });
    expect(audit!.detail).not.toContain(code);
    expect(audit!.detail).not.toContain("user@example.com");
  });

  it("T93 ID 重複 → 409 ID_TAKEN，且不寄碼、不建立驗證碼列", async () => {
    const ts = Date.now();
    await E.DB.prepare(
      `INSERT INTO users (id, username, display_name, password_hash, status, role, created_at, updated_at)
       VALUES (2, 'takenid', NULL, 'x', 'active', 'visitor', ?1, ?1)`
    )
      .bind(ts)
      .run();
    await E.DB.prepare(
      `INSERT INTO email_addresses
         (user_id, local_part, domain, email, password_hash, status, created_at, updated_at)
       VALUES (2, 'takenid', 'atwho.org', 'takenid@atwho.org', NULL, 'active', ?1, ?1)`
    )
      .bind(ts)
      .run();

    const res = await requestCode("someone@example.com", "takenid", "203.0.113.93");
    expect(res.status).toBe(409);
    expect(errorCode(await json(res))).toBe("ID_TAKEN");
    expect(sentMails).toHaveLength(0);
    const n = await E.DB.prepare("SELECT COUNT(*) AS n FROM email_verifications").first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it("T94 驗證碼錯誤 5 次 → CODE_LOCKED；之後正確碼也不能用", async () => {
    const email = "lock@example.com";
    expect((await requestCode(email, "lockuser", "203.0.113.94")).status).toBe(200);
    const code = codeFrom(lastMail());
    const wrong = code === "000000" ? "111111" : "000000";

    for (let i = 1; i <= 5; i += 1) {
      const res = await verifyCode(email, "lockuser", wrong, "203.0.113.94");
      const body = await json(res);
      if (i < 5) {
        expect(res.status, `第 ${i} 次錯誤`).toBe(400);
        expect(errorCode(body)).toBe("CODE_INVALID");
        expect((body as { error: { message: string } }).error.message).toContain(`還可再試 ${5 - i} 次`);
      } else {
        expect(res.status, "第 5 次錯誤應鎖定").toBe(429);
        expect(errorCode(body)).toBe("CODE_LOCKED");
      }
    }

    // 已鎖定 → 即使輸入正確碼也回 CODE_LOCKED（attempts 先於雜湊比對）
    const locked = await verifyCode(email, "lockuser", code, "203.0.113.94");
    expect(locked.status).toBe(429);
    expect(errorCode(await json(locked))).toBe("CODE_LOCKED");

    const row = await E.DB.prepare(
      "SELECT attempts, consumed_at FROM email_verifications WHERE email = ?1 ORDER BY id DESC LIMIT 1"
    )
      .bind(email)
      .first<{ attempts: number; consumed_at: number | null }>();
    expect(row?.attempts).toBe(5);
    expect(row?.consumed_at).toBeNull();
  });

  it("T95 驗證碼過期（15 分鐘）→ CODE_EXPIRED，且不建立帳號", async () => {
    const email = "expired@example.com";
    expect((await requestCode(email, "expireduser", "203.0.113.95")).status).toBe(200);
    const code = codeFrom(lastMail());

    await E.DB.prepare("UPDATE email_verifications SET expires_at = ?1 WHERE email = ?2")
      .bind(Date.now() - 1000, email)
      .run();

    const res = await verifyCode(email, "expireduser", code, "203.0.113.95");
    expect(res.status).toBe(400);
    expect(errorCode(await json(res))).toBe("CODE_EXPIRED");

    const users = await E.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'expireduser'").first<{ n: number }>();
    expect(users?.n).toBe(0);
  });

  it("T96 重寄 60 秒內 → 429 CODE_COOLDOWN，且只寄出第一封", async () => {
    const email = "cooldown@example.com";
    expect((await requestCode(email, "cooldown1", "203.0.113.96")).status).toBe(200);
    const second = await requestCode(email, "cooldown1", "203.0.113.96");
    expect(second.status).toBe(429);
    expect(errorCode(await json(second))).toBe("CODE_COOLDOWN");
    expect(sentMails).toHaveLength(1);

    // 冷卻到期後可再寄（舊碼同時作廢）
    await clearResendCooldown(email);
    expect((await requestCode(email, "cooldown1", "203.0.113.96")).status).toBe(200);
    expect(sentMails).toHaveLength(2);
  });
});

describe("T97–T98：驗證成功與一次性", { timeout: 30_000 }, () => {
  it("T97 驗證成功 → 建立 user＋address（暖機生效）＋ mailbox token", async () => {
    const email = "verify@example.com";
    expect((await requestCode(email, "newuser", "203.0.113.97")).status).toBe(200);
    const code = codeFrom(lastMail());

    const res = await verifyCode(email, "newuser", code, "203.0.113.97");
    expect(res.status).toBe(200);
    const body = await json<{ token: string; session: string; address: { id: number; email: string } }>(res);
    expect(body.session).toBe("mailbox");
    expect(body.address.email).toBe("newuser@atwho.org");
    expect(body.token).toBeTruthy();

    // token 可直接使用（與 mailbox-login 相同 scope）
    const me = await get("/api/me");
    expect(me.status).toBe(401); // 無 token 的對照
    const ctx = createExecutionContext();
    const meRes = await app.request("/api/me", { headers: { Authorization: `Bearer ${body.token}` } }, E, ctx);
    await waitOnExecutionContext(ctx);
    expect(meRes.status).toBe(200);

    const user = await E.DB.prepare(
      "SELECT role, status, access_email FROM users WHERE username = 'newuser'"
    ).first<{ role: string; status: string; access_email: string | null }>();
    expect(user).toMatchObject({ role: "visitor", status: "active", access_email: null });

    const addr = await E.DB.prepare(
      `SELECT status, can_send, daily_send_quota, created_at FROM email_addresses WHERE email = 'newuser@atwho.org'`
    ).first<{ status: string; can_send: number; daily_send_quota: number; created_at: number }>();
    expect(addr?.status).toBe("active");
    expect(addr?.can_send).toBe(1);
    expect(addr?.daily_send_quota).toBe(20);
    // 暖機期：created_at 起 24 小時內（寄信上限 min(20, 5)）
    expect(Number(addr!.created_at)).toBeGreaterThan(Date.now() - 60_000);
    expect(Number(addr!.created_at) + 24 * 3600_000).toBeGreaterThan(Date.now());

    const verified = await E.DB.prepare(
      "SELECT detail FROM registration_audit WHERE event = 'register_verified' ORDER BY id DESC LIMIT 1"
    ).first<{ detail: string }>();
    expect(JSON.parse(verified!.detail)).toEqual({ local_part: "newuser" });
    expect(verified!.detail).not.toContain(email);
    expect(verified!.detail).not.toContain(code);

    // 驗證碼已標記為一次性
    const row = await E.DB.prepare(
      "SELECT consumed_at FROM email_verifications WHERE email = ?1 ORDER BY id DESC LIMIT 1"
    )
      .bind(email)
      .first<{ consumed_at: number | null }>();
    expect(row?.consumed_at).not.toBeNull();
  });

  it("T98 同一碼只能用一次 → 第二次 CODE_INVALID", async () => {
    const email = "once@example.com";
    expect((await requestCode(email, "onceuser", "203.0.113.98")).status).toBe(200);
    const code = codeFrom(lastMail());

    expect((await verifyCode(email, "onceuser", code, "203.0.113.98")).status).toBe(200);
    const second = await verifyCode(email, "onceuser", code, "203.0.113.98");
    expect(second.status).toBe(400);
    expect(errorCode(await json(second))).toBe("CODE_INVALID");

    const users = await E.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'onceuser'").first<{ n: number }>();
    expect(users?.n).toBe(1);
  });
});

describe("T99：REGISTRATION_MODE 分流", { timeout: 30_000 }, () => {
  it("closed → 新舊流程皆 403 REGISTRATION_CLOSED；invite → 舊流程可用、新端點關閉", async () => {
    E.REGISTRATION_MODE = "closed";
    expect((await requestCode("x@example.com", "closed1", "203.0.113.99")).status).toBe(403);
    expect(errorCode(await json(await requestCode("x@example.com", "closed1", "203.0.113.99")))).toBe(
      "REGISTRATION_CLOSED"
    );
    expect((await verifyCode("x@example.com", "closed1", "123456", "203.0.113.99")).status).toBe(403);

    const closedLegacy = await req(
      "/api/auth/register",
      { invite_code: "anything", username: "legacyclosed", password: VISITOR_PW },
      "203.0.113.99"
    );
    expect(closedLegacy.status).toBe(403);
    expect(errorCode(await json(closedLegacy))).toBe("REGISTRATION_CLOSED");

    // invite 模式：新端點關閉，舊邀請碼流程照舊
    E.REGISTRATION_MODE = "invite";
    const newInInvite = await requestCode("x@example.com", "invite1", "203.0.113.99");
    expect(newInInvite.status).toBe(403);
    expect(errorCode(await json(newInInvite))).toBe("REGISTRATION_INVITE_ONLY");

    const ts = Date.now();
    await E.DB.prepare(
      `INSERT INTO invites (code, created_by, max_uses, used_count, expires_at, status, created_at, updated_at)
       VALUES ('legacy-invite-code-000001', 1, 1, 0, NULL, 'active', ?1, ?1)`
    )
      .bind(ts)
      .run();
    const legacy = await req(
      "/api/auth/register",
      { invite_code: "legacy-invite-code-000001", username: "legacy01", password: VISITOR_PW },
      "203.0.113.100"
    );
    expect(legacy.status).toBe(201);
    const legacyBody = await json<{ session: string; address: { email: string } }>(legacy);
    expect(legacyBody.session).toBe("mailbox");
    expect(legacyBody.address.email).toBe("legacy01@atwho.org");
  });

  it("email_verify 模式下舊 register → 403 REGISTRATION_EMAIL_VERIFY_REQUIRED", async () => {
    const res = await req(
      "/api/auth/register",
      { invite_code: "anything", username: "oldflow", password: VISITOR_PW },
      "203.0.113.101"
    );
    expect(res.status).toBe(403);
    expect(errorCode(await json(res))).toBe("REGISTRATION_EMAIL_VERIFY_REQUIRED");
  });

  it("GET /api/auth/registration-mode 反映 REGISTRATION_MODE（含舊 REGISTRATION_DISABLED）", async () => {
    // D23：回應固定包含 turnstileSiteKey（未設定 → null，見 turnstile.spec.ts T150）
    E.REGISTRATION_MODE = "email_verify";
    expect(await json(await get("/api/auth/registration-mode"))).toEqual({
      mode: "email_verify",
      turnstileSiteKey: null,
    });

    E.REGISTRATION_MODE = "closed";
    expect(await json(await get("/api/auth/registration-mode"))).toEqual({
      mode: "closed",
      turnstileSiteKey: null,
    });

    E.REGISTRATION_MODE = "invite";
    expect(await json(await get("/api/auth/registration-mode"))).toEqual({
      mode: "invite",
      turnstileSiteKey: null,
    });

    E.REGISTRATION_DISABLED = "true";
    expect(await json(await get("/api/auth/registration-mode"))).toEqual({
      mode: "closed",
      turnstileSiteKey: null,
    });
  });
});

describe("追加：保留字與速率限制（docs/21 §2／§5）", { timeout: 30_000 }, () => {
  it("保留字 → 422 ID_RESERVED，不寄碼（D20 起改為 422）", async () => {
    const res = await requestCode("reserved@example.com", "admin", "203.0.113.110");
    expect(res.status).toBe(422);
    expect(errorCode(await json(res))).toBe("ID_RESERVED");
    expect(sentMails).toHaveLength(0);
  });

  it("同一 Email 每日 5 封 → 第 6 封 CODE_DAILY_LIMIT", async () => {
    const email = "daily@example.com";
    for (let i = 0; i < 5; i += 1) {
      await clearResendCooldown(email);
      const res = await requestCode(email, "dailyuser", `203.0.113.${111 + i}`);
      expect(res.status, `第 ${i + 1} 封`).toBe(200);
    }
    await clearResendCooldown(email);
    const sixth = await requestCode(email, "dailyuser", "203.0.113.116");
    expect(sixth.status).toBe(429);
    expect(errorCode(await json(sixth))).toBe("CODE_DAILY_LIMIT");
    expect(sentMails).toHaveLength(5);
  });

  it("同一 IP 每小時 5 次 → 第 6 次 RATE_LIMITED", async () => {
    const ip = "203.0.113.120";
    for (let i = 1; i <= 5; i += 1) {
      const res = await requestCode(`ip${i}@example.com`, `ipuser${i}`, ip);
      expect(res.status, `第 ${i} 次`).toBe(200);
    }
    const sixth = await requestCode("ip6@example.com", "ipuser6", ip);
    expect(sixth.status).toBe(429);
    expect(errorCode(await json(sixth))).toBe("RATE_LIMITED");
    expect(sentMails).toHaveLength(5);
  });
});
