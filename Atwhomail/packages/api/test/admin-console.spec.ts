/**
 * admin-console.spec.ts — docs/16 D4（邀請碼管理頁）＋ D5（訪客清單／停權／配額／暖機豁免）
 *
 * 對應 docs/16 §6：**T12–T16**（外加 N9 權限邊界、migration 相容、值域與狀態機等邊界案例）。
 * 在 workerd 內以真實 D1 + R2 執行；EMAIL binding 以 mock 注入（測試環境未綁 send_email）。
 *
 * ⚠️ 測試環境未設定 `ACCESS_MAIL_AUD` → `/api/auth/login` 走 D2 的過渡放行（與既有測試一致）；
 *    本檔測的是 D4／D5，登入閘門由 admin-hardening.spec.ts 覆蓋（T1–T3）。
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { hashPassword, type Env } from "../src/auth";

const E = env as unknown as Env;
const OWNER_USER = "owner";
const OWNER_PW = "owner-password-d5";
const VISITOR_PW = "visitor-password-d5";
const ADMIN = "test-admin-token"; // vitest.config.ts 注入的測試 binding（公開的測試常數）

/** 記下實際送出的信件（斷言用），並回傳穩定的 Message-ID */
const sentMails: Array<{ from: string; to: string[]; subject: string }> = [];

function installEmailMock(): void {
  const mock = {
    send: async (msg: { from: string; to: string[]; subject: string }) => {
      sentMails.push({ from: msg.from, to: msg.to, subject: msg.subject });
      return { messageId: `mock-${sentMails.length}@atwho.org` };
    },
  };
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

const ownerToken = () =>
  login("/api/auth/login", { username: OWNER_USER, password: OWNER_PW });

async function login(path: string, body: Record<string, string>): Promise<string> {
  const res = await req(path, { method: "POST", body: JSON.stringify(body) });
  return ((await json<{ token?: string }>(res)).token ?? "") as string;
}

/** 種一個訪客（跳過 argon2 註冊流程以維持測試速度） */
async function seedVisitor(opts: {
  email: string;
  status?: string;
  canSend?: number;
  quota?: number;
  sentToday?: number;
  warmupExempt?: number;
  createdAt?: number;
}): Promise<{ userId: number; addressId: number }> {
  const ts = opts.createdAt ?? Date.now();
  const userRes = await E.DB.prepare(
    `INSERT INTO users (username, display_name, password_hash, status, role, created_at, updated_at)
     VALUES (?1, NULL, ?2, ?3, 'visitor', ?4, ?4)`
  )
    .bind(`u-${opts.email}`, await cachedHash(VISITOR_PW), opts.status ?? "active", ts)
    .run();
  const userId = Number(userRes.meta.last_row_id);
  const addrRes = await E.DB.prepare(
    `INSERT INTO email_addresses
       (user_id, local_part, domain, email, password_hash, password_changed_at, status,
        can_send, daily_send_quota, sent_today, quota_reset_at, warmup_exempt, created_at, updated_at)
     VALUES (?1, ?2, 'atwho.org', ?3, ?4, ?5, 'active', ?6, ?7, ?8, ?9, ?10, ?5, ?5)`
  )
    .bind(
      userId,
      opts.email.split("@")[0]!,
      opts.email,
      await cachedHash(VISITOR_PW),
      ts,
      opts.canSend ?? 1,
      opts.quota ?? 20,
      opts.sentToday ?? 0,
      Date.now() + 3600_000,
      opts.warmupExempt ?? 0
    )
    .run();
  return { userId, addressId: Number(addrRes.meta.last_row_id) };
}

/** 種一封信（N9 測試用；只需要「存在」與時間戳） */
async function seedMail(opts: {
  id?: number;
  ownerUserId: number;
  addressId: number;
  folder?: string;
  subject: string;
  preview: string;
  receivedAt: number;
}): Promise<number> {
  const res = await E.DB.prepare(
    `INSERT INTO messages (owner_user_id, address_id, folder, message_id, from_address, to_address, cc,
                           subject, text_preview, received_at, raw_r2_key, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'sender@example.com', '[]', '[]', ?5, ?6, ?7, ?8, ?7, ?7)`
  )
    .bind(
      opts.ownerUserId,
      opts.addressId,
      opts.folder ?? "inbox",
      `<m-${opts.subject}@example.com>`,
      opts.subject,
      opts.preview,
      opts.receivedAt,
      `mail/2026/10/${opts.subject}.eml`
    )
    .run();
  return Number(res.meta.last_row_id);
}

async function auditCount(event: string): Promise<number> {
  const row = await E.DB.prepare("SELECT COUNT(*) AS n FROM registration_audit WHERE event = ?1")
    .bind(event)
    .first<{ n: number }>();
  return row?.n ?? 0;
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
     VALUES (1, ?1, 'Owner', ?2, 'active', 'owner', ?3, ?3)`
  )
    .bind(OWNER_USER, await cachedHash(OWNER_PW), ts)
    .run();
  // owner 自己的地址（用來驗證 owner 的 address_id 過濾仍正常、以及不屬於 owner 的地址會被擋）
  await E.DB.prepare(
    `INSERT INTO email_addresses (id, user_id, local_part, domain, email, password_hash, password_changed_at, status, created_at, updated_at)
     VALUES (1, 1, 'ownerbox', 'atwho.org', 'ownerbox@atwho.org', ?1, ?2, 'active', ?2, ?2)`
  )
    .bind(await cachedHash(OWNER_PW), ts)
    .run();
});

// ══════════════════════ T12：訪客清單（owner 專用）══════════════════════
describe("T12：GET /api/users?role=visitor", () => {
  it("owner 取得訪客清單（含信件數與最近活動時間）；不含任何信件內容（N9）", async () => {
    const { userId, addressId } = await seedVisitor({ email: "v1@atwho.org", createdAt: 1_700_000_000_000 });
    const t1 = 1_700_000_100_000;
    const t2 = 1_700_000_500_000;
    await seedMail({ ownerUserId: userId, addressId, subject: "secret-subject-A", preview: "機密內文片段", receivedAt: t1 });
    const mailId = await seedMail({ ownerUserId: userId, addressId, subject: "secret-subject-B", preview: "另一段內文", receivedAt: t2 });

    const token = await ownerToken();
    const res = await req("/api/users?role=visitor", {}, token);
    expect(res.status).toBe(200);
    const body = await json<{
      users: Array<{
        id: number;
        username: string;
        status: string;
        created_at: number;
        address: { id: number; email: string; status: string; can_send: number; daily_send_quota: number; sent_today: number };
        mail_count: number;
        last_activity_at: number;
      }>;
    }>(res);

    expect(body.users).toHaveLength(1);
    const v = body.users[0]!;
    expect(v.id).toBe(userId);
    expect(v.username).toBe("u-v1@atwho.org");
    expect(v.status).toBe("active");
    expect(v.created_at).toBe(1_700_000_000_000);
    expect(v.address).toMatchObject({
      id: addressId,
      email: "v1@atwho.org",
      status: "active",
      can_send: 1,
      daily_send_quota: 20,
      sent_today: 0,
    });
    expect(v.mail_count).toBe(2);
    expect(v.last_activity_at).toBe(t2);

    // N9：一律不得出現主旨／寄件者／內文（連欄位名都不該有）
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("secret-subject");
    expect(raw).not.toContain("機密內文");
    expect(raw).not.toContain("sender@example.com");
    for (const key of ["subject", "text_preview", "from", "from_address", "html", "messages"]) {
      expect(Object.keys(v)).not.toContain(key);
    }
    expect(mailId).toBeGreaterThan(0);
  });

  it("owner 不會看到自己的帳號（只列 role=visitor）；停權者以 API 詞彙 suspended 呈現", async () => {
    await seedVisitor({ email: "v-ok@atwho.org" });
    await seedVisitor({ email: "v-susp@atwho.org", status: "disabled" });

    const token = await ownerToken();
    const body = await json<{ users: Array<{ username: string; status: string }> }>(
      await req("/api/users?role=visitor", {}, token)
    );
    expect(body.users.map((u) => u.username)).toEqual(["u-v-ok@atwho.org", "u-v-susp@atwho.org"]);
    expect(body.users.map((u) => u.status)).toEqual(["active", "suspended"]);
    expect(body.users.some((u) => u.username === OWNER_USER)).toBe(false);
  });

  it("權限：訪客 JWT → 403；無 session → 401；rescue token → 200；role 參數不合法 → 400", async () => {
    await seedVisitor({ email: "v2@atwho.org" });
    const visitor = await login("/api/auth/mailbox-login", { email: "v2@atwho.org", password: VISITOR_PW });
    expect(visitor).not.toBe("");

    expect((await req("/api/users?role=visitor", {}, visitor)).status).toBe(403);
    expect((await req("/api/users?role=visitor")).status).toBe(401);
    const rescue = await req("/api/users?role=visitor", {}, undefined, { "x-admin-token": ADMIN });
    expect(rescue.status).toBe(200);

    const token = await ownerToken();
    expect((await req("/api/users", {}, token)).status).toBe(400);
    expect((await req("/api/users?role=owner", {}, token)).status).toBe(400);
  });

  it("沒有地址的訪客仍會列出（address: null），不會從清單消失", async () => {
    const res = await E.DB.prepare(
      `INSERT INTO users (username, display_name, password_hash, status, role, created_at, updated_at)
       VALUES ('no-addr', NULL, 'x', 'active', 'visitor', ?1, ?1)`
    )
      .bind(Date.now())
      .run();
    const token = await ownerToken();
    const body = await json<{ users: Array<{ id: number; address: unknown; mail_count: number }> }>(
      await req("/api/users?role=visitor", {}, token)
    );
    expect(body.users).toHaveLength(1);
    expect(body.users[0]!.id).toBe(Number(res.meta.last_row_id));
    expect(body.users[0]!.address).toBeNull();
    expect(body.users[0]!.mail_count).toBe(0);
  });
});

// ══════════════════════ T13：owner 不得讀取訪客信件（N9）══════════════════════
describe("T13：owner 以訪客的地址／信件 id 呼叫 /api/mail/* → 403／404", () => {
  it("所有 /api/mail/* 與附件端點皆不得觸及訪客信件；訪客本人仍可讀自己的信", async () => {
    const { userId, addressId } = await seedVisitor({ email: "v3@atwho.org" });
    const mailId = await seedMail({ ownerUserId: userId, addressId, subject: "v3-mail", preview: "v3 body", receivedAt: Date.now() });
    const att = await E.DB.prepare(
      `INSERT INTO attachments (message_id, filename, stored_filename, content_type, size_bytes, r2_key, created_at, updated_at)
       VALUES (?1, 'a.txt', 'a.txt', 'text/plain', 3, 'attachments/2026/10/a.txt', ?2, ?2)`
    )
      .bind(mailId, Date.now())
      .run();

    const token = await ownerToken();
    const denied: Array<[string, RequestInit]> = [
      [`/api/mail/${mailId}`, {}],
      [`/api/mail/${mailId}/text`, {}],
      [`/api/mail/${mailId}/html`, {}],
      [`/api/mail/${mailId}/attachments`, {}],
      [`/api/mail/${mailId}/read`, { method: "PATCH", body: JSON.stringify({ read: true }) }],
      [`/api/mail/${mailId}/archive`, { method: "PATCH" }],
      [`/api/mail/${mailId}/folder`, { method: "PATCH", body: JSON.stringify({ folder: "trash" }) }],
      [`/api/mail/${mailId}`, { method: "DELETE" }],
      [`/api/attachments/${Number(att.meta.last_row_id)}`, {}],
    ];
    for (const [path, init] of denied) {
      const res = await req(path, init, token);
      expect([403, 404], `${path} 應被擋（實際 ${res.status}）`).toContain(res.status);
    }

    // 過濾訪客地址 → 404（不是回空清單）；owner 自己的地址仍可過濾
    const filtered = await req(`/api/mail/inbox?folder=all&address_id=${addressId}`, {}, token);
    expect(filtered.status).toBe(404);
    expect((await req("/api/mail/inbox?folder=all&address_id=1", {}, token)).status).toBe(200);

    // 反向確認：訪客自己的 session 讀得到（證明沒有為了管理而放寬／也沒弄壞訪客路徑，N2）
    const visitor = await login("/api/auth/mailbox-login", { email: "v3@atwho.org", password: VISITOR_PW });
    const own = await req(`/api/mail/${mailId}`, {}, visitor);
    expect(own.status).toBe(200);
    expect((await json<{ subject: string }>(own)).subject).toBe("v3-mail");
  });
});

// ══════════════════════ T14：配額調整（值域／稽核／安全閥）══════════════════════
describe("T14：PATCH /api/users/:id/quota", () => {
  it("值域 1–200：超出（0／201／-1／非整數）→ 422；邊界 1 與 200 → 200", async () => {
    const { userId } = await seedVisitor({ email: "v4@atwho.org" });
    const token = await ownerToken();
    const patch = (body: unknown) =>
      req(`/api/users/${userId}/quota`, { method: "PATCH", body: JSON.stringify(body) }, token);

    for (const bad of [0, 201, -1, 1.5, "abc", null]) {
      const res = await patch({ daily_send_quota: bad });
      expect(res.status, `daily_send_quota=${String(bad)} 應為 422`).toBe(422);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe("INVALID_QUOTA");
    }

    for (const ok of [1, 200]) {
      const res = await patch({ daily_send_quota: ok });
      expect(res.status).toBe(200);
      expect(await json<{ daily_send_quota: number }>(res)).toMatchObject({ daily_send_quota: ok });
      const row = await E.DB.prepare("SELECT daily_send_quota FROM email_addresses WHERE user_id = ?1")
        .bind(userId)
        .first<{ daily_send_quota: number }>();
      expect(row?.daily_send_quota).toBe(ok);
    }
  });

  it("成功寫入稽核 quota_changed（含 owner id 與新值）；空 body → 400；未知 user → 404", async () => {
    const { userId } = await seedVisitor({ email: "v5@atwho.org" });
    const token = await ownerToken();
    expect((await req(`/api/users/${userId}/quota`, { method: "PATCH", body: JSON.stringify({}) }, token)).status).toBe(400);
    expect((await req("/api/users/99999/quota", { method: "PATCH", body: JSON.stringify({ daily_send_quota: 5 }) }, token)).status).toBe(404);

    const res = await req(
      `/api/users/${userId}/quota`,
      { method: "PATCH", body: JSON.stringify({ daily_send_quota: 30, can_send: true }) },
      token
    );
    expect(res.status).toBe(200);
    expect(await auditCount("quota_changed")).toBe(1);
    const audit = await E.DB.prepare(
      "SELECT user_id, detail FROM registration_audit WHERE event = 'quota_changed'"
    ).first<{ user_id: number; detail: string }>();
    expect(audit?.user_id).toBe(userId);
    expect(JSON.parse(audit!.detail)).toMatchObject({ by: 1, daily_send_quota: 30, can_send: 1 });
  });

  it("can_send=false 立即停用寄信（SEND_NOT_ALLOWED）；權限：訪客 JWT → 403", async () => {
    const { userId } = await seedVisitor({ email: "v6@atwho.org" });
    const visitor = await login("/api/auth/mailbox-login", { email: "v6@atwho.org", password: VISITOR_PW });
    expect(
      (await req(`/api/users/${userId}/quota`, { method: "PATCH", body: JSON.stringify({ can_send: false }) }, visitor)).status
    ).toBe(403);

    const token = await ownerToken();
    const off = await req(`/api/users/${userId}/quota`, { method: "PATCH", body: JSON.stringify({ can_send: false }) }, token);
    expect(off.status).toBe(200);
    expect(await json<{ can_send: number }>(off)).toMatchObject({ can_send: 0 });

    const send = await req(
      "/api/mail/send",
      { method: "POST", body: JSON.stringify({ from: "v6@atwho.org", to: ["x@example.com"], subject: "s", text: "t" }) },
      visitor
    );
    expect(send.status).toBe(403);
    expect((await json<{ error: { code: string } }>(send)).error.code).toBe("SEND_NOT_ALLOWED");
    expect(sentMails).toHaveLength(0);

    // 復原安全閥 → 立即恢復可寄
    await req(`/api/users/${userId}/quota`, { method: "PATCH", body: JSON.stringify({ can_send: 1 }) }, token);
    const ok = await req(
      "/api/mail/send",
      { method: "POST", body: JSON.stringify({ from: "v6@atwho.org", to: ["x@example.com"], subject: "s", text: "t" }) },
      visitor
    );
    expect(ok.status).toBe(200);
  });
});

// ══════════════════════ T15：暖機豁免 ══════════════════════
// 2026-10-21：全套件 + 機器高負載時，argon2id 會慢到 30 秒上限（單獨跑 100% 通過）。
// 本組一次要跑 7 封寄信 + 2 次登入，故比照檔內其他 describe 明確放寬（僅放寬逾時，行為不變）。
describe("T15：warmup_exempt（migration 0007）", { timeout: 120_000 }, () => {
  /** 連續寄 n 封，回傳每次的狀態碼 */
  async function sendTimes(token: string, from: string, n: number): Promise<number[]> {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const res = await req(
        "/api/mail/send",
        { method: "POST", body: JSON.stringify({ from, to: ["x@example.com"], subject: `s${i}`, text: "t" }) },
        token
      );
      out.push(res.status);
    }
    return out;
  }

  it("未豁免：註冊後 24 小時內上限 5 封（第 6 封 429 QUOTA_EXCEEDED）", async () => {
    await seedVisitor({ email: "warm@atwho.org", quota: 20, createdAt: Date.now() });
    const token = await login("/api/auth/mailbox-login", { email: "warm@atwho.org", password: VISITOR_PW });

    const codes = await sendTimes(token, "warm@atwho.org", 6);
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes[5]).toBe(429);
  });

  it("豁免後不受 5 封暖機上限，但**仍受 daily_send_quota** 限制", async () => {
    const { userId } = await seedVisitor({ email: "exempt@atwho.org", quota: 20, warmupExempt: 1, createdAt: Date.now() });
    const token = await login("/api/auth/mailbox-login", { email: "exempt@atwho.org", password: VISITOR_PW });

    // 第 6 封（暖機上限 5）仍可寄出 → 證明豁免生效
    const six = await sendTimes(token, "exempt@atwho.org", 6);
    expect(six).toEqual([200, 200, 200, 200, 200, 200]);

    // owner 把每日配額降到 6（此時已寄 6 封）→ 第 7 封應被每日上限擋下（豁免不等於無上限）
    const owner = await ownerToken();
    expect(
      (await req(`/api/users/${userId}/quota`, { method: "PATCH", body: JSON.stringify({ daily_send_quota: 6 }) }, owner)).status
    ).toBe(200);
    const seventh = await req(
      "/api/mail/send",
      { method: "POST", body: JSON.stringify({ from: "exempt@atwho.org", to: ["x@example.com"], subject: "s7", text: "t" }) },
      token
    );
    expect(seventh.status).toBe(429);
    const body = await json<{ error: { code: string; message: string } }>(seventh);
    expect(body.error.code).toBe("QUOTA_EXCEEDED");
    expect(body.error.message).toContain("每日"); // 不是暖機期訊息
  });

  it("PATCH /api/users/:id/warmup：設定並寫稽核 warmup_changed；值域／權限邊界", async () => {
    const { userId } = await seedVisitor({ email: "w1@atwho.org" });
    const visitor = await login("/api/auth/mailbox-login", { email: "w1@atwho.org", password: VISITOR_PW });
    expect((await req(`/api/users/${userId}/warmup`, { method: "PATCH", body: JSON.stringify({ warmup_exempt: true }) }, visitor)).status).toBe(403);

    const token = await ownerToken();
    expect((await req(`/api/users/${userId}/warmup`, { method: "PATCH", body: JSON.stringify({ warmup_exempt: "yes" }) }, token)).status).toBe(400);
    expect((await req("/api/users/99999/warmup", { method: "PATCH", body: JSON.stringify({ warmup_exempt: true }) }, token)).status).toBe(404);

    const on = await req(`/api/users/${userId}/warmup`, { method: "PATCH", body: JSON.stringify({ warmup_exempt: true }) }, token);
    expect(on.status).toBe(200);
    expect(await json<{ warmup_exempt: number }>(on)).toMatchObject({ warmup_exempt: 1 });
    const row = await E.DB.prepare("SELECT warmup_exempt FROM email_addresses WHERE user_id = ?1")
      .bind(userId)
      .first<{ warmup_exempt: number }>();
    expect(row?.warmup_exempt).toBe(1);
    expect(await auditCount("warmup_changed")).toBe(1);

    const off = await req(`/api/users/${userId}/warmup`, { method: "PATCH", body: JSON.stringify({ warmup_exempt: 0 }) }, token);
    expect(off.status).toBe(200);
    expect(
      (await E.DB.prepare("SELECT warmup_exempt FROM email_addresses WHERE user_id = ?1").bind(userId).first<{ warmup_exempt: number }>())
        ?.warmup_exempt
    ).toBe(0);
  });

  it("既有地址的 warmup_exempt 預設為 0（migration 0007 不改動既有資料的行為）", async () => {
    const row = await E.DB.prepare("SELECT warmup_exempt FROM email_addresses WHERE id = 1").first<{ warmup_exempt: number }>();
    expect(row?.warmup_exempt).toBe(0);
  });
});

// ══════════════════════ T16：邀請碼 reveal ＋ 管理頁後端 ══════════════════════
describe("T16：GET /api/invites?reveal=1", () => {
  async function createInvite(token: string, note = "給小明"): Promise<{ id: number; code: string }> {
    const res = await req(
      "/api/invites",
      { method: "POST", body: JSON.stringify({ max_uses: 3, expires_in_hours: 72, note }) },
      token
    );
    expect(res.status).toBe(201);
    return json<{ id: number; code: string }>(res);
  }

  it("預設只回遮罩碼（無 code 欄位）；reveal=1 才回全碼並寫稽核 invite_revealed", async () => {
    const token = await ownerToken();
    const { code } = await createInvite(token);

    const masked = await req("/api/invites", {}, token);
    expect(masked.status).toBe(200);
    const maskedBody = await json<{ invites: Array<Record<string, unknown>> }>(masked);
    expect(maskedBody.invites).toHaveLength(1);
    expect(maskedBody.invites[0]!.masked_code).toBe(`${code.slice(0, 4)}…`);
    expect(maskedBody.invites[0]).not.toHaveProperty("code");
    expect(await auditCount("invite_revealed")).toBe(0); // 沒 reveal 就不留痕

    const revealed = await req("/api/invites?reveal=1", {}, token);
    expect(revealed.status).toBe(200);
    const revealedBody = await json<{ invites: Array<Record<string, unknown>> }>(revealed);
    expect(revealedBody.invites[0]!.code).toBe(code);
    // 既有欄位結構不變（只「新增」code）
    expect(Object.keys(revealedBody.invites[0]!).sort()).toEqual(
      ["code", "created_at", "expires_at", "id", "masked_code", "max_uses", "note", "status", "used_count"].sort()
    );
    expect(revealedBody.invites[0]).toMatchObject({ max_uses: 3, used_count: 0, status: "active", note: "給小明" });

    expect(await auditCount("invite_revealed")).toBe(1);
    const audit = await E.DB.prepare(
      "SELECT user_id, created_at, detail FROM registration_audit WHERE event = 'invite_revealed'"
    ).first<{ user_id: number; created_at: number; detail: string | null }>();
    expect(audit?.user_id).toBe(1); // owner id
    expect(audit?.created_at).toBeGreaterThan(0); // 時間
    expect(audit?.detail ?? "").not.toContain(code); // N7：稽核不得留全碼
  });

  it("權限：訪客 JWT → 403；無 session → 401；rescue token → 200 可 reveal", async () => {
    const token = await ownerToken();
    const { code } = await createInvite(token);
    await seedVisitor({ email: "v7@atwho.org" });
    const visitor = await login("/api/auth/mailbox-login", { email: "v7@atwho.org", password: VISITOR_PW });

    expect((await req("/api/invites?reveal=1", {}, visitor)).status).toBe(403);
    expect((await req("/api/invites?reveal=1")).status).toBe(401);

    const rescue = await req("/api/invites?reveal=1", {}, undefined, { "x-admin-token": ADMIN });
    expect(rescue.status).toBe(200);
    expect((await json<{ invites: Array<{ code: string }> }>(rescue)).invites[0]!.code).toBe(code);
  });

  it("撤銷後仍在清單中（status=revoked，供 UI 顯示狀態）", async () => {
    const token = await ownerToken();
    const { id } = await createInvite(token);
    expect((await req(`/api/invites/${id}`, { method: "DELETE" }, token)).status).toBe(200);
    const body = await json<{ invites: Array<{ id: number; status: string; used_count: number; max_uses: number }> }>(
      await req("/api/invites", {}, token)
    );
    expect(body.invites[0]).toMatchObject({ id, status: "revoked", used_count: 0, max_uses: 3 });
  });
});

// ══════════════════════ D5：地址停用／啟用（解 404 缺口）══════════════════════
describe("D5：PATCH /api/email-addresses/:id/status（owner 專用）", () => {
  it("owner 可停用訪客地址（不再 404）；停用後該訪客無法登入、也無法寄信", async () => {
    const { addressId } = await seedVisitor({ email: "v8@atwho.org" });
    const visitor = await login("/api/auth/mailbox-login", { email: "v8@atwho.org", password: VISITOR_PW });
    expect(visitor).not.toBe("");

    // 既有端點對訪客地址仍是 404（缺口成因；語意不變）
    const token = await ownerToken();
    expect((await req(`/api/email-addresses/${addressId}`, { method: "PATCH", body: JSON.stringify({ status: "disabled" }) }, token)).status).toBe(404);

    const off = await req(`/api/email-addresses/${addressId}/status`, { method: "PATCH", body: JSON.stringify({ status: "disabled" }) }, token);
    expect(off.status).toBe(200);
    expect(await json<{ status: string; email: string }>(off)).toMatchObject({ status: "disabled", email: "v8@atwho.org" });
    expect(await auditCount("address_status_changed")).toBe(1);

    // 停用立即生效：登入被拒、既有 session 的寄信被拒
    // ⚠️ D8（docs/16 §3）改變了這裡的**錯誤碼**（行為更精確，非放寬）：
    //    登入由 401 INVALID_CREDENTIALS → 403 ADDRESS_DISABLED（D8-1）
    //    既有 session 由 FROM_NOT_ALLOWED → 403 ADDRESS_DISABLED（D8-4：requireSession 就擋）
    //    `can_send` 語意本身未變（地址 active＋can_send=0 → SEND_NOT_ALLOWED，見 registration.spec.ts）
    const relogin = await req("/api/auth/mailbox-login", { method: "POST", body: JSON.stringify({ email: "v8@atwho.org", password: VISITOR_PW }) });
    expect(relogin.status).toBe(403);
    expect((await json<{ error: { code: string } }>(relogin)).error.code).toBe("ADDRESS_DISABLED");
    const send = await req(
      "/api/mail/send",
      { method: "POST", body: JSON.stringify({ from: "v8@atwho.org", to: ["x@example.com"], subject: "s", text: "t" }) },
      visitor
    );
    expect(send.status).toBe(403);
    expect((await json<{ error: { code: string } }>(send)).error.code).toBe("ADDRESS_DISABLED");

    // 復權 → 可再次登入
    expect(
      (await req(`/api/email-addresses/${addressId}/status`, { method: "PATCH", body: JSON.stringify({ status: "active" }) }, token)).status
    ).toBe(200);
    expect(
      (await req("/api/auth/mailbox-login", { method: "POST", body: JSON.stringify({ email: "v8@atwho.org", password: VISITOR_PW }) })).status
    ).toBe(200);
  });

  it("權限與值域：mailbox session → 403；status 不合法 → 400；不存在的 id → 404", async () => {
    const { addressId, userId } = await seedVisitor({ email: "v9@atwho.org" });
    const visitor = await login("/api/auth/mailbox-login", { email: "v9@atwho.org", password: VISITOR_PW });
    expect((await req(`/api/email-addresses/${addressId}/status`, { method: "PATCH", body: JSON.stringify({ status: "disabled" }) }, visitor)).status).toBe(403);

    const token = await ownerToken();
    expect((await req(`/api/email-addresses/${addressId}/status`, { method: "PATCH", body: JSON.stringify({ status: "deleted" }) }, token)).status).toBe(400);
    expect((await req(`/api/email-addresses/${addressId}/status`, { method: "PATCH", body: JSON.stringify({}) }, token)).status).toBe(400);
    expect((await req("/api/email-addresses/99999/status", { method: "PATCH", body: JSON.stringify({ status: "disabled" }) }, token)).status).toBe(404);

    // 停用地址不影響使用者帳號本身（停權是 PATCH /api/users/:id/status 的職責）
    const userRow = await E.DB.prepare("SELECT status FROM users WHERE id = ?1").bind(userId).first<{ status: string }>();
    expect(userRow?.status).toBe("active");
  });

  it("訪客清單會反映地址停用與配額變更（管理頁資料來源）", async () => {
    const { userId, addressId } = await seedVisitor({ email: "v10@atwho.org" });
    const token = await ownerToken();
    await req(`/api/email-addresses/${addressId}/status`, { method: "PATCH", body: JSON.stringify({ status: "disabled" }) }, token);
    await req(`/api/users/${userId}/quota`, { method: "PATCH", body: JSON.stringify({ daily_send_quota: 7, can_send: false }) }, token);

    const body = await json<{
      users: Array<{ id: number; address: { status: string; daily_send_quota: number; can_send: number } | null }>;
    }>(await req("/api/users?role=visitor", {}, token));
    expect(body.users[0]!.address).toMatchObject({ status: "disabled", daily_send_quota: 7, can_send: 0 });
  });
});
