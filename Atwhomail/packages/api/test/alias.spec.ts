/**
 * alias.spec.ts — D25 別名 Phase 1（docs/25 §7：T109–T113、T116–T118）
 *
 * 在 workerd 內以真實 D1 + R2 執行；`EMAIL` binding 以 mock 注入（測試環境未綁 send_email）。
 * T114／T115（收信端）在 `packages/email-handler/test/email-handler.spec.ts`。
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { hashPassword, type Env } from "../src/auth";

const E = env as unknown as Env;
const OWNER_PW = "owner-password-alias";
const ALICE_PW = "alice-password-alias";
const BOB_PW = "bob-password-alias";
const VISITOR_PW = "visitor-password-alias";

const hashCache = new Map<string, Promise<string>>();
function cachedHash(pw: string): Promise<string> {
  let h = hashCache.get(pw);
  if (!h) {
    h = hashPassword(pw);
    hashCache.set(pw, h);
  }
  return h;
}

/** EMAIL mock：記錄實際寄出的 From（別名寄信必須用別名，不是目標地址） */
const sentMails: Array<{ from: string; to: string[]; subject: string }> = [];
const emailMock = {
  send: async (msg: { from: string; to: string[]; subject: string }) => {
    sentMails.push({ from: msg.from, to: msg.to, subject: msg.subject });
    return { messageId: `mock-alias-${sentMails.length}@atwho.org` };
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
  await waitOnExecutionContext(ctx); // 等 auditAsync（waitUntil）完成
  return res;
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function errorCode(body: unknown): string | undefined {
  return (body as { error?: { code?: string } })?.error?.code;
}

async function login(username: string, password: string): Promise<string> {
  const res = await req("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
  return ((await json<{ token?: string }>(res)).token ?? "") as string;
}

async function mailboxLogin(email: string, password: string): Promise<string> {
  const res = await req("/api/auth/mailbox-login", { method: "POST", body: JSON.stringify({ email, password }) });
  return ((await json<{ token?: string }>(res)).token ?? "") as string;
}

function createAlias(token: string, name: unknown, targetAddressId: unknown): Promise<Response> {
  return req(
    "/api/email-aliases",
    { method: "POST", body: JSON.stringify({ name, target_address_id: targetAddressId }) },
    token
  );
}

async function latestAudit(event: string): Promise<{ detail: unknown; address_id: number | null; user_id: number | null } | null> {
  return E.DB.prepare(
    "SELECT detail, address_id, user_id FROM registration_audit WHERE event = ?1 ORDER BY id DESC LIMIT 1"
  )
    .bind(event)
    .first<{ detail: string | null; address_id: number | null; user_id: number | null }>()
    .then((row) =>
      row ? { detail: row.detail ? JSON.parse(row.detail) : null, address_id: row.address_id, user_id: row.user_id } : null
    );
}

beforeEach(async () => {
  for (const t of [
    "form_responses",
    "form_instances",
    "form_templates",
    "attachments",
    "messages",
    "registration_audit",
    "alias_names",
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
  const [ownerHash, aliceHash, bobHash, visitorHash] = await Promise.all([
    cachedHash(OWNER_PW),
    cachedHash(ALICE_PW),
    cachedHash(BOB_PW),
    cachedHash(VISITOR_PW),
  ]);

  // owner(1)：名下 alice(1)、bob(2)；visitor(2)：名下 visitor(3)
  await E.DB.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, status, role, created_at, updated_at)
     VALUES (1,'owner','Owner',?, 'active','owner',?,?),
            (2,'visitor','Visitor',?, 'active','visitor',?,?)`
  )
    .bind(ownerHash, ts, ts, visitorHash, ts, ts)
    .run();
  await E.DB.prepare(
    `INSERT INTO email_addresses (id, user_id, local_part, domain, email, password_hash, status, password_changed_at, created_at, updated_at)
     VALUES (1, 1, 'alice', 'atwho.org', 'alice@atwho.org', ?, 'active', ?, ?, ?),
            (2, 1, 'bob',   'atwho.org', 'bob@atwho.org',   ?, 'active', ?, ?, ?),
            (3, 2, 'visitor','atwho.org','visitor@atwho.org', ?, 'active', ?, ?, ?)`
  )
    .bind(aliceHash, ts, ts, ts, bobHash, ts, ts, ts, visitorHash, ts, ts, ts)
    .run();
});

describe("T109：建立別名（luke → luke001）", () => {
  it("DB 寫入正確、流水號計數器遞增、稽核只記別名與目標", async () => {
    const token = await login("owner", OWNER_PW);
    const res = await createAlias(token, "Luke", 1); // 大寫輸入 → 儲存小寫
    expect(res.status).toBe(201);
    const body = await json<{ id: number; alias_address: string; target_address_id: number; status: string }>(res);
    expect(body.alias_address).toBe("luke001@atwho.org");
    expect(body.target_address_id).toBe(1);
    expect(body.status).toBe("active");

    const row = await E.DB.prepare(
      "SELECT alias_address, target_email_address_id, status FROM email_aliases WHERE id = ?1"
    )
      .bind(body.id)
      .first<{ alias_address: string; target_email_address_id: number; status: string }>();
    expect(row).toEqual({ alias_address: "luke001@atwho.org", target_email_address_id: 1, status: "active" });

    const counter = await E.DB.prepare("SELECT next_serial FROM alias_names WHERE name = 'luke'").first<{
      next_serial: number;
    }>();
    expect(Number(counter!.next_serial)).toBe(2);

    const audit = await latestAudit("alias_created");
    expect(audit?.detail).toEqual({ alias_address: "luke001@atwho.org", target: "alice@atwho.org" });
    expect(audit?.address_id).toBe(1);
    // N9：不得記錄任何信件內容（主旨／寄件者／內文）
    expect(JSON.stringify(audit)).not.toContain("Subject");
  });
});

describe("T110：同名第二個使用者 → luke002", () => {
  it("不同使用者可共用名字；流水號全域遞增", async () => {
    const owner = await login("owner", OWNER_PW);
    expect((await createAlias(owner, "luke", 1)).status).toBe(201);

    const visitor = await mailboxLogin("visitor@atwho.org", VISITOR_PW);
    const second = await createAlias(visitor, "luke", 3);
    expect(second.status).toBe(201);
    expect((await json<{ alias_address: string }>(second)).alias_address).toBe("luke002@atwho.org");

    const all = await E.DB.prepare("SELECT alias_address, target_email_address_id FROM email_aliases ORDER BY id").all<{
      alias_address: string;
      target_email_address_id: number;
    }>();
    expect(all.results).toEqual([
      { alias_address: "luke001@atwho.org", target_email_address_id: 1 },
      { alias_address: "luke002@atwho.org", target_email_address_id: 3 },
    ]);
  });
});

describe("T111：名字驗證（全部 400 INVALID_ALIAS_NAME）", () => {
  it("長度 <3／>12、含數字、含符號、保留字都被拒絕", async () => {
    const token = await login("owner", OWNER_PW);
    const invalid = ["ab", "abcdefghijklm", "luke1", "luke-1", "luke_1", "admin", "POSTMASTER", "abuse", ""];
    for (const name of invalid) {
      const res = await createAlias(token, name, 1);
      expect(res.status, `name=${JSON.stringify(name)}`).toBe(400);
      expect(errorCode(await json(res))).toBe("INVALID_ALIAS_NAME");
    }
    const count = await E.DB.prepare("SELECT COUNT(*) AS n FROM email_aliases").first<{ n: number }>();
    expect(Number(count!.n)).toBe(0);
  });
});

describe("T112：目標地址不屬於自己 → 403 TARGET_NOT_ALLOWED", () => {
  it("owner 指定訪客地址、mailbox 指定他人地址、目標停用 → 403", async () => {
    const owner = await login("owner", OWNER_PW);
    const visitorAddress = await createAlias(owner, "luke", 3);
    expect(visitorAddress.status).toBe(403);
    expect(errorCode(await json(visitorAddress))).toBe("TARGET_NOT_ALLOWED");

    const alice = await mailboxLogin("alice@atwho.org", ALICE_PW);
    const otherAddress = await createAlias(alice, "luke", 2);
    expect(otherAddress.status).toBe(403);
    expect(errorCode(await json(otherAddress))).toBe("TARGET_NOT_ALLOWED");

    await E.DB.prepare("UPDATE email_addresses SET status = 'disabled' WHERE id = 1").run();
    const disabled = await createAlias(owner, "luke", 1);
    expect(disabled.status).toBe(403);
    expect(errorCode(await json(disabled))).toBe("TARGET_NOT_ALLOWED");

    const count = await E.DB.prepare("SELECT COUNT(*) AS n FROM email_aliases").first<{ n: number }>();
    expect(Number(count!.n)).toBe(0);
  });
});

describe("T113：每帳號別名上限 50 → 409 ALIAS_LIMIT_REACHED", () => {
  it("既有 50 個別名後，第 51 個被拒絕", async () => {
    const ts = Date.now();
    const stmts = Array.from({ length: 50 }, (_, i) =>
      E.DB.prepare(
        `INSERT INTO email_aliases (alias_address, target_email_address_id, status, created_at, updated_at)
         VALUES (?1, 1, 'active', ?2, ?2)`
      ).bind(`seed${String(i + 1).padStart(3, "0")}@atwho.org`, ts)
    );
    await E.DB.batch(stmts);

    const token = await login("owner", OWNER_PW);
    const res = await createAlias(token, "luke", 1);
    expect(res.status).toBe(409);
    expect(errorCode(await json(res))).toBe("ALIAS_LIMIT_REACHED");

    const count = await E.DB.prepare("SELECT COUNT(*) AS n FROM email_aliases").first<{ n: number }>();
    expect(Number(count!.n)).toBe(50);
  });

  it("上限以帳號計：訪客自己的 50 個不影響 owner", async () => {
    const ts = Date.now();
    const stmts = Array.from({ length: 50 }, (_, i) =>
      E.DB.prepare(
        `INSERT INTO email_aliases (alias_address, target_email_address_id, status, created_at, updated_at)
         VALUES (?1, 3, 'active', ?2, ?2)`
      ).bind(`visitor${String(i + 1).padStart(3, "0")}@atwho.org`, ts)
    );
    await E.DB.batch(stmts);

    const owner = await login("owner", OWNER_PW);
    expect((await createAlias(owner, "luke", 1)).status).toBe(201);

    const visitor = await mailboxLogin("visitor@atwho.org", VISITOR_PW);
    expect((await createAlias(visitor, "luke", 3)).status).toBe(409);
  });
});

describe("T116：GET /api/email-aliases（received_count 與 scope）", () => {
  it("owner 看全部、mailbox 只看自己地址的別名；統計與最後收到時間正確", async () => {
    const owner = await login("owner", OWNER_PW);
    expect((await createAlias(owner, "luke", 1)).status).toBe(201);
    expect((await createAlias(owner, "robert", 2)).status).toBe(201);

    const ts = Date.UTC(2026, 10, 1, 12, 0, 0);
    await E.DB.prepare(
      `INSERT INTO messages (owner_user_id, address_id, folder, message_id, from_address, to_address, cc,
                             subject, text_preview, received_at, raw_r2_key, created_at, updated_at, envelope_to)
       VALUES (1, 1, 'inbox', '<a@x>', 'ext@example.com', '[]', '[]', 's1', 'p1', ?, 'mail/2026/11/a.eml', ?, ?, 'luke001@atwho.org'),
              (1, 1, 'inbox', '<b@x>', 'ext@example.com', '[]', '[]', 's2', 'p2', ?, 'mail/2026/11/b.eml', ?, ?, 'luke001@atwho.org'),
              (1, 2, 'inbox', '<c@x>', 'ext@example.com', '[]', '[]', 's3', 'p3', ?, 'mail/2026/11/c.eml', ?, ?, 'robert001@atwho.org'),
              (1, 1, 'inbox', '<d@x>', 'ext@example.com', '[]', '[]', 's4', 'p4', ?, 'mail/2026/11/d.eml', ?, ?, NULL)`
    )
      .bind(ts, ts, ts, ts + 1000, ts + 1000, ts + 1000, ts + 2000, ts + 2000, ts + 2000, ts + 3000, ts + 3000, ts + 3000)
      .run();

    const ownerRes = await json<{ aliases: Array<Record<string, unknown>> }>(
      await req("/api/email-aliases", {}, owner)
    );
    expect(ownerRes.aliases).toHaveLength(2);
    const luke = ownerRes.aliases.find((a) => a.alias_address === "luke001@atwho.org");
    expect(luke).toMatchObject({
      target_address_id: 1,
      target_email: "alice@atwho.org",
      status: "active",
      received_count: 2,
      last_received_at: ts + 1000,
    });
    const robert = ownerRes.aliases.find((a) => a.alias_address === "robert001@atwho.org");
    expect(robert).toMatchObject({ target_address_id: 2, received_count: 1, last_received_at: ts + 2000 });
    expect(ownerRes.aliases.some((a) => a.alias_address === "nobody")).toBe(false);

    const alice = await mailboxLogin("alice@atwho.org", ALICE_PW);
    const aliceRes = await json<{ aliases: Array<{ alias_address: string }> }>(
      await req("/api/email-aliases", {}, alice)
    );
    expect(aliceRes.aliases.map((a) => a.alias_address)).toEqual(["luke001@atwho.org"]);

    const bob = await mailboxLogin("bob@atwho.org", BOB_PW);
    const bobRes = await json<{ aliases: Array<{ alias_address: string }> }>(
      await req("/api/email-aliases", {}, bob)
    );
    expect(bobRes.aliases.map((a) => a.alias_address)).toEqual(["robert001@atwho.org"]);

    // 停用／刪除為軟停用：資料列保留，新狀態需反映在清單
    const aliasId = Number(luke!.id);
    const patch = await req("/api/email-aliases/" + aliasId, { method: "PATCH", body: JSON.stringify({ status: "disabled" }) }, alice);
    expect(patch.status).toBe(200);
    const afterPatch = await json<{ aliases: Array<{ alias_address: string; status: string }> }>(
      await req("/api/email-aliases", {}, alice)
    );
    expect(afterPatch.aliases[0]).toMatchObject({ alias_address: "luke001@atwho.org", status: "disabled" });

    const del = await req(`/api/email-aliases/${aliasId}`, { method: "DELETE" }, alice);
    expect(del.status).toBe(200);
    expect((await json<{ status: string }>(del)).status).toBe("disabled");
    const row = await E.DB.prepare("SELECT status FROM email_aliases WHERE id = ?1").bind(aliasId).first<{
      status: string;
    }>();
    expect(row!.status).toBe("disabled"); // 資料列未被刪除

    // mailbox 不能操作他人地址的別名 → 404（不洩漏存在性）
    const robertId = Number(robert!.id);
    expect((await req(`/api/email-aliases/${robertId}`, { method: "PATCH", body: JSON.stringify({ status: "disabled" }) }, alice)).status).toBe(404);
  });
});

describe("T117：以別名寄信（外部收件人）＋配額計入 target", () => {
  it("From 用別名、EMAIL.send 收到別名、寄件備份與配額記在目標地址、稽核 via_alias=true", async () => {
    const owner = await login("owner", OWNER_PW);
    const created = await createAlias(owner, "luke", 1);
    const createdBody = await json<{ id: number; alias_address: string }>(created);
    expect(created.status).toBe(201);
    const alias = createdBody.alias_address;

    const before = await E.DB.prepare("SELECT sent_today FROM email_addresses WHERE id = 1").first<{ sent_today: number }>();
    const res = await req(
      "/api/mail/send",
      {
        method: "POST",
        body: JSON.stringify({
          from: alias,
          to: ["outside@example.com"],
          subject: "Reply via alias",
          text: "hello",
        }),
      },
      owner
    );
    expect(res.status).toBe(200);
    const body = await json<{ from: string; delivery_scope: string }>(res);
    expect(body.from).toBe(alias);
    expect(body.delivery_scope).toBe("external");
    expect(sentMails).toHaveLength(1);
    expect(sentMails[0]!.from).toBe(alias);

    const after = await E.DB.prepare("SELECT sent_today FROM email_addresses WHERE id = 1").first<{ sent_today: number }>();
    expect(Number(after!.sent_today)).toBe(Number(before!.sent_today) + 1);

    const sentCopy = await E.DB.prepare(
      "SELECT address_id, from_address FROM messages WHERE folder = 'sent'"
    ).first<{ address_id: number; from_address: string }>();
    expect(sentCopy).toEqual({ address_id: 1, from_address: alias });

    const audit = await latestAudit("mail_sent");
    expect(audit?.detail).toEqual({ via_alias: true });

    // mailbox session 也能用「目標是自己地址」的別名寄信
    const alice = await mailboxLogin("alice@atwho.org", ALICE_PW);
    const asMailbox = await req(
      "/api/mail/send",
      { method: "POST", body: JSON.stringify({ from: alias, to: ["outside2@example.com"], subject: "s", text: "t" }) },
      alice
    );
    expect(asMailbox.status).toBe(200);
    expect(sentMails[1]!.from).toBe(alias);

    // 別人的別名（target 屬於 owner）→ 訪客不可用
    const visitor = await mailboxLogin("visitor@atwho.org", VISITOR_PW);
    const denied = await req(
      "/api/mail/send",
      { method: "POST", body: JSON.stringify({ from: alias, to: ["outside3@example.com"], subject: "s", text: "t" }) },
      visitor
    );
    expect(denied.status).toBe(403);
    expect(errorCode(await json(denied))).toBe("FROM_NOT_ALLOWED");

    // 停用的別名不可作為 From
    const aliasId = createdBody.id;
    await req(`/api/email-aliases/${aliasId}`, { method: "PATCH", body: JSON.stringify({ status: "disabled" }) }, owner);
    const disabled = await req(
      "/api/mail/send",
      { method: "POST", body: JSON.stringify({ from: alias, to: ["outside4@example.com"], subject: "s", text: "t" }) },
      owner
    );
    expect(disabled.status).toBe(403);
    expect(errorCode(await json(disabled))).toBe("FROM_NOT_ALLOWED");
  });
});

describe("T118：內部寄件者 → 用真實地址（範圍 A）", () => {
  it("以真實地址寄內部信：via_alias=false，寄件備份的 From 是目標真實地址", async () => {
    const owner = await login("owner", OWNER_PW);
    await createAlias(owner, "luke", 1);

    const res = await req(
      "/api/mail/send",
      {
        method: "POST",
        body: JSON.stringify({
          from: "alice@atwho.org", // 內部寄件者 → 回覆時前端用真實地址
          to: ["bob@atwho.org"],
          subject: "Internal reply",
          text: "hi bob",
        }),
      },
      owner
    );
    expect(res.status).toBe(200);
    const body = await json<{ from: string; delivery_scope: string }>(res);
    expect(body.from).toBe("alice@atwho.org");
    expect(body.delivery_scope).toBe("internal");

    const inbox = await E.DB.prepare(
      "SELECT from_address, address_id, envelope_to FROM messages WHERE folder = 'inbox' AND address_id = 2"
    ).first<{ from_address: string; address_id: number; envelope_to: string | null }>();
    expect(inbox).toEqual({ from_address: "alice@atwho.org", address_id: 2, envelope_to: null });

    const audit = await latestAudit("mail_sent");
    expect(audit?.detail).toEqual({ via_alias: false });
  });
});
