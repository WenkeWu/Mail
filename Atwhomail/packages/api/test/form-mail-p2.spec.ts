/**
 * form-mail-p2.spec.ts — docs/18 P2：互動式表單（T39–T51）
 *
 * 以真實 D1 + R2 執行；EMAIL binding 以 mock 注入並記錄呼叫次數
 * （T40：互動式表單路徑**絕不**呼叫 EMAIL.send）。
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { hashPassword, type Env } from "../src/auth";

const E = env as unknown as Env;
const OWNER_PW = "owner-password-forms-p2";
const ALICE_PW = "alice-password-forms-p2";
const BOB_PW = "bob-password-forms-p2";

const hashCache = new Map<string, Promise<string>>();
function cachedHash(pw: string): Promise<string> {
  let h = hashCache.get(pw);
  if (!h) {
    h = hashPassword(pw);
    hashCache.set(pw, h);
  }
  return h;
}

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

const FORM_SCHEMA = {
  type: "object",
  title: "Team survey",
  properties: {
    name: { type: "string", title: "Name", maxLength: 100 },
    age: { type: "integer", title: "Age", minimum: 0, maximum: 150 },
    answer: { type: "string", title: "Answer", maxLength: 20 },
    date: { type: "string", title: "Date", format: "date" },
    agree: { type: "boolean", title: "Agree" },
  },
  required: ["answer"],
};

interface FormSendBody {
  instances?: Array<{ id: number; recipient: string }>;
  template_id?: number;
  sent_message_id?: number;
}

async function createForm(
  token: string,
  overrides: Record<string, unknown> = {}
): Promise<{ res: Response; body: FormSendBody }> {
  const res = await req(
    "/api/forms/send",
    {
      method: "POST",
      body: JSON.stringify({
        from: "alice@atwho.org",
        to: ["bob@atwho.org"],
        subject: "Form subject",
        schema: FORM_SCHEMA,
        ...overrides,
      }),
    },
    token
  );
  return { res, body: await json<FormSendBody>(res) };
}

async function bobMessage(): Promise<Record<string, unknown>> {
  return (await E.DB.prepare(
    "SELECT * FROM messages WHERE address_id = 2 AND kind = 'interactive_form' ORDER BY id DESC LIMIT 1"
  ).first<Record<string, unknown>>())!;
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
            (2, 1, 'bob',   'atwho.org', 'bob@atwho.org',   ?, 'active', ?, ?, ?),
            (3, 1, 'carol', 'atwho.org', 'carol@atwho.org', ?, 'active', ?, ?, ?),
            (4, 1, 'dave',  'atwho.org', 'dave@atwho.org',  ?, 'active', ?, ?, ?)`
  )
    .bind(aliceHash, ts, ts, ts, bobHash, ts, ts, ts, aliceHash, ts, ts, ts, aliceHash, ts, ts, ts)
    .run();
});

describe("P2：送出互動式表單", () => {
  it("T39：收件人含外部地址 → 422 FORM_RECIPIENT_NOT_INTERNAL（fail closed）", async () => {
    const token = await ownerToken();
    const res = await req(
      "/api/forms/send",
      {
        method: "POST",
        body: JSON.stringify({
          from: "alice@atwho.org",
          to: ["bob@atwho.org", "outside@example.com"],
          subject: "s",
          schema: FORM_SCHEMA,
        }),
      },
      token
    );
    expect(res.status).toBe(422);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("FORM_RECIPIENT_NOT_INTERNAL");
    expect(await E.DB.prepare("SELECT COUNT(*) AS n FROM form_instances").first<{ n: number }>()).toEqual({ n: 0 });
    expect(sentMails.length).toBe(0);
  });

  it("T40：每收件人一筆實例、本地直送、kind=interactive_form，且未呼叫 EMAIL.send", async () => {
    const token = await ownerToken();
    const { res, body } = await createForm(token, { to: ["bob@atwho.org", "carol@atwho.org"] });
    expect(res.status).toBe(201);
    expect(body.instances).toHaveLength(2);
    expect(body.instances!.map((i) => i.recipient).sort()).toEqual(["bob@atwho.org", "carol@atwho.org"]);
    expect(sentMails.length).toBe(0); // 絕不呼叫 EMAIL.send

    const rows = await E.DB.prepare(
      "SELECT * FROM messages WHERE kind = 'interactive_form' AND folder = 'inbox' ORDER BY id"
    ).all<Record<string, unknown>>();
    expect(rows.results).toHaveLength(2);
    for (const row of rows.results) {
      expect(row.origin).toBe("internal");
      expect(row.delivery_scope).toBe("internal");
      expect(Number(row.form_instance_id)).toBeGreaterThan(0);
    }
    const instances = await E.DB.prepare("SELECT * FROM form_instances").all<Record<string, unknown>>();
    expect(instances.results).toHaveLength(2);
    expect(instances.results.every((i) => i.status === "open")).toBe(true);
    expect(instances.results.every((i) => i.sender_address_id === 1)).toBe(true);

    const sent = await E.DB.prepare("SELECT * FROM messages WHERE folder = 'sent'").first<Record<string, unknown>>();
    expect(sent?.kind).toBe("interactive_form");
    expect(Number(sent?.form_instance_id)).toBe(body.instances![0]!.id);
  });

  it("T41：收件人 GET → 200，回傳驗證過的 schema；稽核 form_viewed", async () => {
    const token = await ownerToken();
    const { body } = await createForm(token);
    const id = body.instances![0]!.id;
    const bob = await mailboxToken("bob@atwho.org", BOB_PW);

    const res = await req(`/api/forms/${id}`, {}, bob);
    expect(res.status).toBe(200);
    const view = await json<{ form: { schema: { properties: Record<string, unknown> }; title: string } }>(res);
    expect(view.form.title).toBe("Team survey");
    expect(view.form.schema.properties.answer).toBeTruthy();
    expect(view.form.schema.properties.answer).toMatchObject({ type: "string", maxLength: 20 });

    const audit = await E.DB.prepare(
      "SELECT COUNT(*) AS n FROM registration_audit WHERE event = 'form_viewed'"
    ).first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it("T42：非收件人／owner session／不存在 id → 一律 404（不洩漏存在性）", async () => {
    const token = await ownerToken();
    const { body } = await createForm(token);
    const id = body.instances![0]!.id;
    const dave = await mailboxToken("dave@atwho.org", ALICE_PW);

    const nonRecipient = await req(`/api/forms/${id}`, {}, dave);
    expect(nonRecipient.status).toBe(404);
    expect((await json<{ error: { code: string } }>(nonRecipient)).error.code).toBe("FORM_NOT_FOUND");

    const owner = await req(`/api/forms/${id}`, {}, token);
    expect(owner.status).toBe(404);

    const missing = await req("/api/forms/999999", {}, dave);
    expect(missing.status).toBe(404);
  });

  it("T43：寄件人撤回 → 收件人 GET 404、回覆 FORM_CLOSED；稽核 form_revoked", async () => {
    const sender = await mailboxToken("alice@atwho.org", ALICE_PW);
    const { body } = await createForm(sender);
    const id = body.instances![0]!.id;
    const bob = await mailboxToken("bob@atwho.org", BOB_PW);

    const revoke = await req(`/api/forms/${id}/revoke`, { method: "POST" }, sender);
    expect(revoke.status).toBe(200);
    expect(await json<{ revoked: number }>(revoke)).toMatchObject({ revoked: 1 });

    expect((await req(`/api/forms/${id}`, {}, bob)).status).toBe(404);
    const submit = await req(
      `/api/forms/${id}/responses`,
      { method: "POST", body: JSON.stringify({ payload: { answer: "late" } }) },
      bob
    );
    expect(submit.status).toBe(409);
    expect((await json<{ error: { code: string } }>(submit)).error.code).toBe("FORM_CLOSED");

    const audit = await E.DB.prepare("SELECT COUNT(*) AS n FROM registration_audit WHERE event = 'form_revoked'")
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it("T44：逾期 → GET 404、回覆 FORM_EXPIRED", async () => {
    const token = await ownerToken();
    const { body } = await createForm(token, { due_at: Date.now() - 1000 });
    const id = body.instances![0]!.id;
    const bob = await mailboxToken("bob@atwho.org", BOB_PW);

    expect((await req(`/api/forms/${id}`, {}, bob)).status).toBe(404);
    const submit = await req(
      `/api/forms/${id}/responses`,
      { method: "POST", body: JSON.stringify({ payload: { answer: "late" } }) },
      bob
    );
    expect(submit.status).toBe(409);
    expect((await json<{ error: { code: string } }>(submit)).error.code).toBe("FORM_EXPIRED");
  });

  it("T45：重複送出 → FORM_ALREADY_SUBMITTED（GET 亦失效）", async () => {
    const token = await ownerToken();
    const { body } = await createForm(token);
    const id = body.instances![0]!.id;
    const bob = await mailboxToken("bob@atwho.org", BOB_PW);

    const first = await req(
      `/api/forms/${id}/responses`,
      { method: "POST", body: JSON.stringify({ payload: { answer: "first" } }) },
      bob
    );
    expect(first.status).toBe(200);
    const second = await req(
      `/api/forms/${id}/responses`,
      { method: "POST", body: JSON.stringify({ payload: { answer: "second" } }) },
      bob
    );
    expect(second.status).toBe(409);
    expect((await json<{ error: { code: string } }>(second)).error.code).toBe("FORM_ALREADY_SUBMITTED");
    expect((await req(`/api/forms/${id}`, {}, bob)).status).toBe(404);
  });

  it("T46：非法 payload（型別錯／超長／未知欄位／缺必填／非法日期）→ FORM_INVALID_PAYLOAD", async () => {
    const token = await ownerToken();
    const { body } = await createForm(token);
    const id = body.instances![0]!.id;
    const bob = await mailboxToken("bob@atwho.org", BOB_PW);

    const badPayloads: unknown[] = [
      { answer: 123 },
      { answer: "x".repeat(21) },
      { answer: "ok", unknown: "x" },
      {},
      { answer: "ok", date: "2026-02-30" },
      { answer: "ok", age: 1.5 },
    ];
    for (const payload of badPayloads) {
      const res = await req(
        `/api/forms/${id}/responses`,
        { method: "POST", body: JSON.stringify({ payload }) },
        bob
      );
      expect(res.status, JSON.stringify(payload)).toBe(422);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe("FORM_INVALID_PAYLOAD");
    }
  });

  it("T47：schema 白名單（$ref／anyOf／oneOf／allOf／patternProperties／dependencies、深度、欄位數、長度、format）→ FORM_SCHEMA_INVALID", async () => {
    const token = await ownerToken();
    const badSchemas: unknown[] = [
      { type: "object", properties: { a: { $ref: "#/x" } } },
      { type: "object", properties: { a: { anyOf: [{ type: "string" }] } } },
      { type: "object", properties: { a: { oneOf: [{ type: "string" }] } } },
      { type: "object", properties: { a: { allOf: [{ type: "string" }] } } },
      { type: "object", patternProperties: { ".*": { type: "string" } }, properties: { a: { type: "string" } } },
      { type: "object", dependencies: { a: ["b"] }, properties: { a: { type: "string" } } },
      { type: "object", properties: { a: { type: "string", maxLength: 2001 } } },
      { type: "object", properties: { a: { type: "string", format: "data-url" } } },
      {
        type: "object",
        properties: {
          group: {
            type: "object",
            properties: { inner: { type: "object", properties: { x: { type: "string" } } } },
          },
        },
      },
      {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 41 }, (_, i) => [`f${i}`, { type: "string" }])
        ),
      },
    ];
    for (const schema of badSchemas) {
      const res = await req(
        "/api/forms/send",
        {
          method: "POST",
          body: JSON.stringify({ from: "alice@atwho.org", to: ["bob@atwho.org"], subject: "s", schema }),
        },
        token
      );
      expect(res.status, JSON.stringify(schema).slice(0, 120)).toBe(422);
      expect((await json<{ error: { code: string } }>(res)).error.code).toBe("FORM_SCHEMA_INVALID");
    }
  });

  it("合法的 2 層巢狀物件與 enum 可被接受", async () => {
    const token = await ownerToken();
    const schema = {
      type: "object",
      properties: {
        group: {
          type: "object",
          title: "群組",
          properties: {
            choice: { type: "string", title: "選項", enum: ["a", "b"] },
            note: { type: "string", title: "備註", maxLength: 20 },
          },
        },
      },
      required: ["group"],
    };
    const { res } = await createForm(token, { schema });
    expect(res.status).toBe(201);
  });
});

describe("P2：轉寄降級與寄件人管理", () => {
  it("T48：轉寄互動式郵件 → 新信 kind=normal、無 form_instance_id、不建立新實例", async () => {
    const sender = await mailboxToken("alice@atwho.org", ALICE_PW);
    const { body } = await createForm(sender);
    const bob = await mailboxToken("bob@atwho.org", BOB_PW);
    const original = await bobMessage();

    // 前端 Forward 只帶靜態文字（getMailText），不複製 form_instance_id
    const textRes = await req(`/api/mail/${original.id}/text`, {}, bob);
    const text = (await json<{ text: string }>(textRes)).text;
    expect(text).toContain("互動式表單");

    const fwd = await req(
      "/api/mail/send",
      {
        method: "POST",
        body: JSON.stringify({
          from: "bob@atwho.org",
          to: ["dave@atwho.org"],
          subject: "Fwd: Form subject",
          text: `---------- 轉寄郵件 ----------\n\n${text}`,
        }),
      },
      bob
    );
    expect(fwd.status).toBe(200);
    const forwarded = await E.DB.prepare(
      "SELECT * FROM messages WHERE address_id = 4 AND folder = 'inbox' ORDER BY id DESC LIMIT 1"
    ).first<Record<string, unknown>>();
    expect(forwarded?.kind).toBe("normal");
    expect(forwarded?.form_instance_id).toBeNull();
    expect(forwarded?.origin).toBe("internal");
    expect(forwarded?.delivery_scope).toBe("internal");
    expect(await E.DB.prepare("SELECT COUNT(*) AS n FROM form_instances").first<{ n: number }>()).toEqual({ n: 1 });
    expect(body.instances).toHaveLength(1);
  });

  it("T50：寄件人查看回覆 200；其他收件人／非寄件人 403", async () => {
    const sender = await mailboxToken("alice@atwho.org", ALICE_PW);
    const { body } = await createForm(sender);
    const id = body.instances![0]!.id;
    const bob = await mailboxToken("bob@atwho.org", BOB_PW);
    const carol = await mailboxToken("carol@atwho.org", ALICE_PW);

    await req(
      `/api/forms/${id}/responses`,
      { method: "POST", body: JSON.stringify({ payload: { answer: "my answer" } }) },
      bob
    );

    const asSender = await req(`/api/forms/${id}/responses`, {}, sender);
    expect(asSender.status).toBe(200);
    const data = await json<{
      instances: Array<{ recipient: string; status: string; payload: Record<string, unknown> }>;
      responses: Array<{ payload: Record<string, unknown> }>;
    }>(asSender);
    expect(data.instances).toHaveLength(1);
    expect(data.instances[0]).toMatchObject({ recipient: "bob@atwho.org", status: "submitted" });
    expect(data.responses[0]!.payload).toMatchObject({ answer: "my answer" });

    for (const token of [bob, carol]) {
      const denied = await req(`/api/forms/${id}/responses`, {}, token);
      expect(denied.status).toBe(403);
      expect((await json<{ error: { code: string } }>(denied)).error.code).toBe("FORM_NOT_AUTHORIZED");
    }
  });

  it("T51：稽核事件齊全，且 detail 不含主旨／schema／回覆內容（N9）", async () => {
    const sender = await mailboxToken("alice@atwho.org", ALICE_PW);
    const secretSchema = {
      type: "object",
      title: "Sensitive title",
      properties: { answer: { type: "string", title: "Sensitive question", maxLength: 200 } },
      required: ["answer"],
    };
    const { body } = await createForm(sender, { subject: "Sensitive subject", schema: secretSchema });
    const id = body.instances![0]!.id;
    const bob = await mailboxToken("bob@atwho.org", BOB_PW);

    await req(`/api/forms/${id}`, {}, bob);
    await req(
      `/api/forms/${id}/responses`,
      { method: "POST", body: JSON.stringify({ payload: { answer: "secret answer value" } }) },
      bob
    );
    await req(`/api/forms/${id}/revoke`, { method: "POST" }, sender);

    const { results } = await E.DB.prepare(
      "SELECT event, detail FROM registration_audit WHERE event LIKE 'form_%' ORDER BY id"
    ).all<{ event: string; detail: string | null }>();
    const events = new Set(results.map((r) => r.event));
    for (const expected of ["form_sent", "form_viewed", "form_submitted", "form_revoked"]) {
      expect(events.has(expected), `缺少 ${expected}`).toBe(true);
    }
    for (const row of results) {
      const detail = row.detail ?? "";
      expect(detail).not.toContain("Sensitive subject");
      expect(detail).not.toContain("Sensitive title");
      expect(detail).not.toContain("Sensitive question");
      expect(detail).not.toContain("secret answer value");
    }
  });
});
