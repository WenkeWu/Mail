/**
 * registration.spec.ts — Phase 1 訪客註冊／配額／停權整合測試（docs/14 §4.4 T1–T15）
 *
 * 獨立檔案（既有 api.integration.spec.ts 的預期不動 → P6/T14 零退化）。
 * 在 workerd 內以真實 D1 + R2 執行；EMAIL binding 以 mock 注入（測試環境未綁 send_email）。
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { hashPassword, type Env } from "../src/auth";

const E = env as unknown as Env;
const OWNER_PW = "owner-password-phase1";
const VISITOR_PW = "visitor-password-01"; // 需 ≥10 且非純數字（見 docs/14 §4.2 步驟 5）
const OWNER_ADDR = "owner-box@atwho.org";

/** 記下實際送出的信件（斷言用），並回傳穩定的 Message-ID */
const sentMails: Array<{ from: string; to: string[]; subject: string }> = [];

function installEmailMock(): void {
  const mock = {
    send: async (msg: { from: string; to: string[]; subject: string }) => {
      sentMails.push({ from: msg.from, to: msg.to, subject: msg.subject });
      return { messageId: `mock-${sentMails.length}@atwho.org` };
    },
  };
  // 測試環境未宣告 send_email binding → 直接補上（@cloudflare/vitest-pool-workers 的 env 可寫）
  (E as unknown as { EMAIL: typeof mock }).EMAIL = mock;
}

const hashCache = new Map<string, Promise<string>>();
function cachedHash(pw: string): Promise<string> {
  let h = hashCache.get(pw);
  if (!h) {
    h = hashPassword(pw);
    hashCache.set(pw, h);
  }
  return h;
}

/** 帶 executionCtx 的請求 → waitUntil（稽核寫入）完成後才回傳，測試可直接斷言稽核表 */
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

/** 產生邀請碼（走真實端點，owner 權限） */
async function createInvite(maxUses = 1, expiresInHours?: number): Promise<{ id: number; code: string }> {
  const token = await ownerToken();
  const res = await req(
    "/api/invites",
    { method: "POST", body: JSON.stringify({ max_uses: maxUses, ...(expiresInHours ? { expires_in_hours: expiresInHours } : {}) }) },
    token
  );
  const body = await json<{ id: number; code: string }>(res);
  return { id: body.id, code: body.code };
}

async function register(
  payload: Record<string, unknown>,
  ip = "203.0.113.10"
): Promise<Response> {
  return req(
    "/api/auth/register",
    { method: "POST", body: JSON.stringify(payload) },
    undefined,
    { "cf-connecting-ip": ip }
  );
}

/** 直接種訪客資料（測寄信路徑用；跳過 argon2 以維持測試速度） */
async function seedVisitor(opts: {
  email: string;
  canSend?: number;
  quota?: number;
  sentToday?: number;
  createdAt?: number;
  quotaResetAt?: number | null;
}): Promise<{ userId: number; addressId: number }> {
  const ts = opts.createdAt ?? Date.now();
  const userRes = await E.DB.prepare(
    `INSERT INTO users (username, display_name, password_hash, status, role, created_at, updated_at)
     VALUES (?1, NULL, ?2, 'active', 'visitor', ?3, ?3)`
  )
    .bind(`u-${opts.email}`, await cachedHash(VISITOR_PW), ts)
    .run();
  const userId = Number(userRes.meta.last_row_id);
  const localPart = opts.email.split("@")[0]!;
  const addrRes = await E.DB.prepare(
    `INSERT INTO email_addresses
       (user_id, local_part, domain, email, password_hash, password_changed_at, status,
        can_send, daily_send_quota, sent_today, quota_reset_at, created_at, updated_at)
     VALUES (?1, ?2, 'atwho.org', ?3, ?4, ?5, 'active', ?6, ?7, ?8, ?9, ?5, ?5)`
  )
    .bind(
      userId,
      localPart,
      opts.email,
      await cachedHash(VISITOR_PW),
      ts,
      opts.canSend ?? 1,
      opts.quota ?? 20,
      opts.sentToday ?? 0,
      opts.quotaResetAt === undefined ? Date.now() + 3600_000 : opts.quotaResetAt
    )
    .run();
  return { userId, addressId: Number(addrRes.meta.last_row_id) };
}

beforeEach(async () => {
  installEmailMock();
  sentMails.length = 0;
  for (const t of [
    "registration_audit",
    "invites",
    "attachments",
    "messages",
    "email_aliases",
    "email_addresses",
    "users",
    "auth_attempts",
  ]) {
    await E.DB.prepare(`DELETE FROM ${t}`).run();
  }
  const ts = Date.now();
  await E.DB.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, status, role, created_at, updated_at)
     VALUES (1, 'owner', 'Owner', ?1, 'active', 'owner', ?2, ?2)`
  )
    .bind(await cachedHash(OWNER_PW), ts)
    .run();
  await E.DB.prepare(
    `INSERT INTO email_addresses (id, user_id, local_part, domain, email, password_hash, password_changed_at, status, created_at, updated_at)
     VALUES (1, 1, 'owner-box', 'atwho.org', ?1, NULL, 0, 'active', ?2, ?2)`
  )
    .bind(OWNER_ADDR, ts)
    .run();
  // owner 的一封信（T12：訪客不得看見）
  await E.DB.prepare(
    `INSERT INTO messages (id, owner_user_id, address_id, folder, message_id, from_address, to_address, cc,
                           subject, text_preview, received_at, raw_r2_key, created_at, updated_at)
     VALUES (1, 1, 1, 'inbox', '<owner-msg@x>', 'ext@example.com', ?, '[]', 'Owner only', 'secret', ?, 'mail/2026/10/m1.eml', ?, ?)`
  )
    .bind(JSON.stringify([{ address: OWNER_ADDR, name: "" }]), ts, ts, ts)
    .run();
});

describe("T1–T5：邀請碼與註冊", () => {
  it("T1 有效邀請碼註冊 → 201 + mailbox token，且該 token 可讀 inbox", async () => {
    const invite = await createInvite(1, 72);
    const res = await register({ invite_code: invite.code, username: "friend01", password: VISITOR_PW });
    expect(res.status).toBe(201);
    const body = await json<{ token: string; session: string; address: { id: number; email: string } }>(res);
    expect(body.session).toBe("mailbox");
    expect(body.address.email).toBe("friend01@atwho.org");
    expect(body.token).toBeTruthy();

    const inbox = await req("/api/mail/inbox", {}, body.token);
    expect(inbox.status).toBe(200);
    const list = await json<{ items: unknown[] }>(inbox);
    expect(list.items).toHaveLength(0); // 新信箱是空的（且看不到 owner 的信）

    const row = await E.DB.prepare("SELECT role, access_email FROM users WHERE username = 'friend01'").first<{
      role: string;
      access_email: string | null;
    }>();
    expect(row?.role).toBe("visitor");
  });

  it("T2 邀請碼不存在／已撤銷／已過期 → 400 INVITE_INVALID", async () => {
    // 不存在
    const r1 = await register({ invite_code: "nonexistent-code-000", username: "a1", password: VISITOR_PW }, "198.51.100.1");
    expect(r1.status).toBe(400);
    expect((await json<{ error: { code: string } }>(r1)).error.code).toBe("INVITE_INVALID");

    // 已撤銷
    const revoked = await createInvite(1);
    const owner = await ownerToken();
    expect((await req(`/api/invites/${revoked.id}`, { method: "DELETE" }, owner)).status).toBe(200);
    const r2 = await register({ invite_code: revoked.code, username: "a2", password: VISITOR_PW }, "198.51.100.2");
    expect(r2.status).toBe(400);
    expect((await json<{ error: { code: string } }>(r2)).error.code).toBe("INVITE_INVALID");

    // 已過期
    const ts = Date.now();
    await E.DB.prepare(
      `INSERT INTO invites (code, created_by, max_uses, used_count, expires_at, status, created_at, updated_at)
       VALUES ('expired-code-0000000000', 1, 1, 0, ?1, 'active', ?2, ?2)`
    )
      .bind(ts - 1000, ts)
      .run();
    const r3 = await register(
      { invite_code: "expired-code-0000000000", username: "a3", password: VISITOR_PW },
      "198.51.100.3"
    );
    expect(r3.status).toBe(400);
    expect((await json<{ error: { code: string } }>(r3)).error.code).toBe("INVITE_INVALID");

    // 被拒事件有寫入稽核（register_rejected）
    const audit = await E.DB.prepare(
      "SELECT COUNT(*) AS n FROM registration_audit WHERE event = 'register_rejected'"
    ).first<{ n: number }>();
    expect(audit?.n).toBe(3);
  });

  it("T3 同一邀請碼 max_uses=1 用兩次 → 第二次 400 INVITE_EXHAUSTED", async () => {
    const invite = await createInvite(1);
    const first = await register({ invite_code: invite.code, username: "b1", password: VISITOR_PW }, "198.51.100.11");
    expect(first.status).toBe(201);
    const second = await register({ invite_code: invite.code, username: "b2", password: VISITOR_PW }, "198.51.100.12");
    expect(second.status).toBe(400);
    expect((await json<{ error: { code: string } }>(second)).error.code).toBe("INVITE_EXHAUSTED");

    const row = await E.DB.prepare("SELECT used_count FROM invites WHERE id = ?1").bind(invite.id).first<{
      used_count: number;
    }>();
    expect(row?.used_count).toBe(1); // 未超扣
  });

  it("T4 地址／使用者名稱重複 → 400 ADDRESS_TAKEN", async () => {
    // 既有地址 owner-box@atwho.org（id=1）
    const i1 = await createInvite(1);
    const r1 = await register(
      { invite_code: i1.code, username: "dupname", password: VISITOR_PW, local_part: "owner-box" },
      "198.51.100.21"
    );
    expect(r1.status).toBe(400);
    expect((await json<{ error: { code: string } }>(r1)).error.code).toBe("ADDRESS_TAKEN");

    // 既有 username = owner
    const i2 = await createInvite(1);
    const r2 = await register(
      { invite_code: i2.code, username: "owner", password: VISITOR_PW },
      "198.51.100.22"
    );
    expect(r2.status).toBe(400);
    expect((await json<{ error: { code: string } }>(r2)).error.code).toBe("ADDRESS_TAKEN");

    // 非法格式
    const i3 = await createInvite(1);
    const r3 = await register(
      { invite_code: i3.code, username: "-bad-", password: VISITOR_PW },
      "198.51.100.23"
    );
    expect(r3.status).toBe(400);
    expect((await json<{ error: { code: string } }>(r3)).error.code).toBe("INVALID_LOCAL_PART");
  });

  it("T5 弱密碼 → 400 WEAK_PASSWORD（含既有政策與加嚴規則）", async () => {
    const i1 = await createInvite(1);
    const short = await register({ invite_code: i1.code, username: "c1", password: "short" }, "198.51.100.31");
    expect(short.status).toBe(400);
    expect((await json<{ error: { code: string } }>(short)).error.code).toBe("WEAK_PASSWORD");

    const i2 = await createInvite(1);
    const digits = await register({ invite_code: i2.code, username: "c2", password: "1234567890" }, "198.51.100.32");
    expect(digits.status).toBe(400);
    expect((await json<{ error: { code: string } }>(digits)).error.code).toBe("WEAK_PASSWORD");

    const i3 = await createInvite(1);
    const eight = await register({ invite_code: i3.code, username: "c3", password: "abcd1234" }, "198.51.100.33");
    expect(eight.status).toBe(400);
    expect((await json<{ error: { code: string } }>(eight)).error.code).toBe("WEAK_PASSWORD");
  });
});

describe("T6–T10：寄信配額與限流", () => {
  it("T6 配額內寄信 → 200，且 /api/me 的 sent_today +1", async () => {
    const invite = await createInvite(1);
    const reg = await register({ invite_code: invite.code, username: "sender01", password: VISITOR_PW }, "203.0.113.61");
    const token = (await json<{ token: string }>(reg)).token;

    const send = await req(
      "/api/mail/send",
      { method: "POST", body: JSON.stringify({ from: "sender01@atwho.org", to: ["test1@atwho.org"], subject: "hi", text: "hello" }) },
      token
    );
    expect(send.status).toBe(200);
    expect(await json<{ send_status: string }>(send)).toMatchObject({ send_status: "sent" });

    const me = await json<{ addresses: Array<{ sent_today: number; daily_send_quota: number }> }>(
      await req("/api/me", {}, token)
    );
    expect(me.addresses[0]!.sent_today).toBe(1);
    expect(me.addresses[0]!.daily_send_quota).toBe(20);
  });

  it("T7 暖機期第 6 封 → 429 QUOTA_EXCEEDED，且稽核留下 send_rejected_quota", async () => {
    const { addressId } = await seedVisitor({ email: "warmup01@atwho.org", createdAt: Date.now() });
    const token = (await json<{ token: string }>(
      await req("/api/auth/mailbox-login", {
        method: "POST",
        body: JSON.stringify({ email: "warmup01@atwho.org", password: VISITOR_PW }),
      })
    )).token;

    const send = (n: number) =>
      req(
        "/api/mail/send",
        { method: "POST", body: JSON.stringify({ from: "warmup01@atwho.org", to: ["test1@atwho.org"], subject: `w${n}`, text: "x" }) },
        token
      );

    for (let i = 1; i <= 5; i++) {
      expect((await send(i)).status, `第 ${i} 封應成功（暖機上限 5）`).toBe(200);
    }
    const sixth = await send(6);
    expect(sixth.status).toBe(429);
    expect((await json<{ error: { code: string } }>(sixth)).error.code).toBe("QUOTA_EXCEEDED");

    const audit = await E.DB.prepare(
      "SELECT COUNT(*) AS n FROM registration_audit WHERE event = 'send_rejected_quota' AND address_id = ?1"
    )
      .bind(addressId)
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it("T8 超過每日配額 → 429 QUOTA_EXCEEDED", async () => {
    await seedVisitor({ email: "quota01@atwho.org", quota: 1, sentToday: 1, createdAt: Date.now() - 3 * 86400_000 });
    const token = (await json<{ token: string }>(
      await req("/api/auth/mailbox-login", {
        method: "POST",
        body: JSON.stringify({ email: "quota01@atwho.org", password: VISITOR_PW }),
      })
    )).token;
    const res = await req(
      "/api/mail/send",
      { method: "POST", body: JSON.stringify({ from: "quota01@atwho.org", to: ["test1@atwho.org"], subject: "over", text: "x" }) },
      token
    );
    expect(res.status).toBe(429);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("QUOTA_EXCEEDED");
  });

  it("T9 每小時超過 10 封 → 429 RATE_LIMITED（且配額回補）", async () => {
    const { addressId } = await seedVisitor({ email: "rate01@atwho.org", createdAt: Date.now() - 3 * 86400_000 });
    const token = (await json<{ token: string }>(
      await req("/api/auth/mailbox-login", {
        method: "POST",
        body: JSON.stringify({ email: "rate01@atwho.org", password: VISITOR_PW }),
      })
    )).token;

    // 種 10 封近 60 分鐘的寄件備份（模擬已寄 10 封）
    const ts = Date.now();
    for (let i = 0; i < 10; i++) {
      await E.DB.prepare(
        `INSERT INTO messages (owner_user_id, address_id, folder, message_id, from_address, to_address, cc,
                               subject, text_preview, received_at, send_status, raw_r2_key, created_at, updated_at)
         SELECT user_id, id, 'sent', ?1, email, '[]', '[]', 'p', 'p', ?2, 'sent', ?3, ?2, ?2
         FROM email_addresses WHERE id = ?4`
      )
        .bind(`<pre-${i}@x>`, ts - i * 1000, `mail/2026/10/pre-${i}.eml`, addressId)
        .run();
    }

    const res = await req(
      "/api/mail/send",
      { method: "POST", body: JSON.stringify({ from: "rate01@atwho.org", to: ["test1@atwho.org"], subject: "rate", text: "x" }) },
      token
    );
    expect(res.status).toBe(429);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("RATE_LIMITED");

    // 步驟 5 已扣、步驟 6 被拒 → 應回補為 0
    const row = await E.DB.prepare("SELECT sent_today FROM email_addresses WHERE id = ?1")
      .bind(addressId)
      .first<{ sent_today: number }>();
    expect(row?.sent_today).toBe(0);

    const audit = await E.DB.prepare("SELECT COUNT(*) AS n FROM registration_audit WHERE event = 'send_rejected_rate'")
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it("T10 can_send=0 → 403 SEND_NOT_ALLOWED", async () => {
    await seedVisitor({ email: "nosend01@atwho.org", canSend: 0, createdAt: Date.now() - 3 * 86400_000 });
    const token = (await json<{ token: string }>(
      await req("/api/auth/mailbox-login", {
        method: "POST",
        body: JSON.stringify({ email: "nosend01@atwho.org", password: VISITOR_PW }),
      })
    )).token;
    const res = await req(
      "/api/mail/send",
      { method: "POST", body: JSON.stringify({ from: "nosend01@atwho.org", to: ["test1@atwho.org"], subject: "no", text: "x" }) },
      token
    );
    expect(res.status).toBe(403);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("SEND_NOT_ALLOWED");
  });
});

describe("T11–T13：停權、隔離、/api/me", () => {
  it("T11 停權後登入與寄信皆 403 ACCOUNT_SUSPENDED；復權後可再登入", async () => {
    const invite = await createInvite(1);
    const reg = await register({ invite_code: invite.code, username: "suspend01", password: VISITOR_PW }, "203.0.113.111");
    const token = (await json<{ token: string }>(reg)).token;
    const userId = (await E.DB.prepare("SELECT id FROM users WHERE username = 'suspend01'").first<{ id: number }>())!.id;

    const owner = await ownerToken();
    const patch = await req(
      `/api/users/${userId}/status`,
      { method: "PATCH", body: JSON.stringify({ status: "suspended" }) },
      owner
    );
    expect(patch.status).toBe(200);
    expect(await json<{ status: string }>(patch)).toMatchObject({ status: "suspended" });

    // 登入 → 403
    const login = await req("/api/auth/mailbox-login", {
      method: "POST",
      body: JSON.stringify({ email: "suspend01@atwho.org", password: VISITOR_PW }),
    });
    expect(login.status).toBe(403);
    expect((await json<{ error: { code: string } }>(login)).error.code).toBe("ACCOUNT_SUSPENDED");

    // 既有 token 寄信 → 403
    const send = await req(
      "/api/mail/send",
      { method: "POST", body: JSON.stringify({ from: "suspend01@atwho.org", to: ["test1@atwho.org"], subject: "s", text: "x" }) },
      token
    );
    expect(send.status).toBe(403);
    expect((await json<{ error: { code: string } }>(send)).error.code).toBe("ACCOUNT_SUSPENDED");

    // 復權 → 可登入
    expect(
      (await req(`/api/users/${userId}/status`, { method: "PATCH", body: JSON.stringify({ status: "active" }) }, owner)).status
    ).toBe(200);
    const relogin = await req("/api/auth/mailbox-login", {
      method: "POST",
      body: JSON.stringify({ email: "suspend01@atwho.org", password: VISITOR_PW }),
    });
    expect(relogin.status).toBe(200);
  });

  it("T12 訪客看不到他人信件（scope 迴歸）", async () => {
    const invite = await createInvite(1);
    const reg = await register({ invite_code: invite.code, username: "peek01", password: VISITOR_PW }, "203.0.113.121");
    const token = (await json<{ token: string }>(reg)).token;

    const inbox = await json<{ items: unknown[] }>(await req("/api/mail/inbox?folder=all", {}, token));
    expect(inbox.items).toHaveLength(0); // owner 有 1 封，訪客看不到
    expect((await req("/api/mail/1", {}, token)).status).toBe(404);
    expect((await req("/api/mail/1/text", {}, token)).status).toBe(404);
    // 也不能呼叫 owner 端點
    expect((await req("/api/email-addresses", {}, token)).status).toBe(403);
    expect((await req("/api/invites", {}, token)).status).toBe(403);
    expect((await req("/api/backup/changes", {}, token)).status).toBe(403); // mailbox scope 不得觸及備份端點

    // 訪客不得用 owner 登入端點取得 owner scope token（否則可觸及備份／邀請碼等 owner 端點）
    const ownerLogin = await req("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "peek01", password: VISITOR_PW }),
    });
    expect(ownerLogin.status).toBe(401);
    expect((await json<{ error: { code: string } }>(ownerLogin)).error.code).toBe("INVALID_CREDENTIALS");
  });

  it("T13 /api/me 回 role 與配額欄位（訪客與 owner）", async () => {
    const invite = await createInvite(1);
    const reg = await register({ invite_code: invite.code, username: "me01", password: VISITOR_PW }, "203.0.113.131");
    const token = (await json<{ token: string }>(reg)).token;

    const me = await json<{
      role: string;
      session: string;
      username: string;
      addresses: Array<{ email: string; can_send: number; daily_send_quota: number; sent_today: number; quota_reset_at: number | null }>;
    }>(await req("/api/me", {}, token));
    expect(me.role).toBe("visitor");
    expect(me.session).toBe("mailbox");
    expect(me.username).toBe("me01");
    expect(me.addresses).toHaveLength(1);
    expect(me.addresses[0]).toMatchObject({ email: "me01@atwho.org", can_send: 1, daily_send_quota: 20, sent_today: 0 });

    const owner = await json<{ role: string; session: string; addresses: unknown[] }>(
      await req("/api/me", {}, await ownerToken())
    );
    expect(owner.role).toBe("owner");
    expect(owner.session).toBe("owner");
    expect(owner.addresses).toHaveLength(1);
  });
});

describe("T15：併發扣配額（原子性）", () => {
  it("同時送 2 封、上限 1 → 只有 1 封成功", async () => {
    const { addressId } = await seedVisitor({
      email: "race01@atwho.org",
      quota: 1,
      sentToday: 0,
      createdAt: Date.now() - 3 * 86400_000,
      quotaResetAt: Date.now() + 3600_000, // 不觸發重置
    });
    const token = (await json<{ token: string }>(
      await req("/api/auth/mailbox-login", {
        method: "POST",
        body: JSON.stringify({ email: "race01@atwho.org", password: VISITOR_PW }),
      })
    )).token;

    const send = (n: number) =>
      req(
        "/api/mail/send",
        { method: "POST", body: JSON.stringify({ from: "race01@atwho.org", to: ["test1@atwho.org"], subject: `race${n}`, text: "x" }) },
        token
      );

    const [a, b] = await Promise.all([send(1), send(2)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 429]);

    const row = await E.DB.prepare("SELECT sent_today FROM email_addresses WHERE id = ?1")
      .bind(addressId)
      .first<{ sent_today: number }>();
    expect(row?.sent_today).toBe(1); // 恰好扣 1，未超額
  });
});

describe("T16：owner 查找不依賴名稱（D11，docs/14 §4.7）", () => {
  /** vitest.config.ts 注入的測試 binding（公開的測試常數，非機密） */
  const ADMIN = "test-admin-token";

  it("owner 改名為 itag 後：rescue token／owner 端點／/api/auth/owner-password 仍全部正常", async () => {
    // 模擬 owner 部署後自行改名（N11：production 的改名由 owner 執行，此處只動測試資料）
    await E.DB.prepare("UPDATE users SET username = 'itag', updated_at = ?1 WHERE role = 'owner'")
      .bind(Date.now())
      .run();

    // 1) rescue token（x-admin-token）＝ owner 等效 → owner 範圍端點可用
    const addrRes = await req("/api/email-addresses", {}, undefined, { "x-admin-token": ADMIN });
    expect(addrRes.status).toBe(200);
    expect(Array.isArray((await json<{ addresses: unknown[] }>(addrRes)).addresses)).toBe(true);

    // 2) 其他 owner 端點：產生邀請碼、備份 feed（最敏感的 owner 端點）
    const invite = await req(
      "/api/invites",
      { method: "POST", body: JSON.stringify({ max_uses: 1 }) },
      undefined,
      { "x-admin-token": ADMIN }
    );
    expect(invite.status).toBe(201);
    const backup = await req("/api/backup/changes", {}, undefined, { "x-admin-token": ADMIN });
    expect(backup.status).toBe(200);

    // 3) /api/auth/owner-password（僅 rescue）→ 重設後可用「新名稱」登入
    const newPw = "itag-owner-password-01";
    const setPw = await req(
      "/api/auth/owner-password",
      { method: "POST", body: JSON.stringify({ new_password: newPw }) },
      undefined,
      { "x-admin-token": ADMIN }
    );
    expect(setPw.status).toBe(200);
    const login = await req("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "itag", password: newPw }),
    });
    expect(login.status).toBe(200);
    expect(await json<{ session: string }>(login)).toMatchObject({ session: "owner" });
  });

  it("回退路徑：查不到 role='owner'（舊資料／舊 schema）→ 仍能以 username='owner' 找到", async () => {
    // 模擬「role 尚未標記」的舊資料：名稱仍是 owner，但角色不是 owner
    await E.DB.prepare("UPDATE users SET role = 'visitor' WHERE id = 1").run();
    const res = await req("/api/email-addresses", {}, undefined, { "x-admin-token": ADMIN });
    expect(res.status).toBe(200);
  });
});
