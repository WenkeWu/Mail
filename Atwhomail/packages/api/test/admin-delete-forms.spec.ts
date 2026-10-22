/**
 * admin-delete-forms.spec.ts — docs/18 §14.1 **D16**：刪除含互動式表單的訪客／地址
 *
 * 對應 docs/18 §14.1 的 **T56–T58**：
 * - **T56**：`DELETE /api/users/:id`（D9）對有（open ＋ submitted）表單實例的訪客 → 200，
 *   `form_responses`／`form_instances`／messages／attachments／aliases／address／user／auth_attempts
 *   全清；`registration_audit` 保留；**`form_templates` 不得刪除**。
 * - **T57**：`DELETE /api/email-addresses/:id?mode=hard`（D11-5）對有表單實例的地址 → 200，
 *   同上清除範圍、名稱可重用、`form_templates` 保留且可重用。
 * - **T58**：`mode=soft` 刪除地址 → 該地址的 **open 實例轉 `revoked`**（`updated_at` 同步），
 *   submitted 實例／回覆／messages／attachments／R2 全部保留。
 *
 * 修正前的 Bug：`form_instances`（`message_id`／`recipient_address_id`／`sender_address_id`）與
 * `form_responses`（`instance_id`／`responder_user_id`）的 FK 未被刪除順序涵蓋 → 整批 batch
 * 被 FK 阻擋 → `500 DELETE_FAILED`（已回滾）。
 *
 * 全程在 workerd 內以真實 D1／R2 執行，且一律走**真實端點**。
 * 測試環境未設定 `ACCESS_MAIL_AUD` → `/api/auth/login` 走 D2 的過渡放行（與其他測試檔一致）。
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { hashPassword, type Env } from "../src/auth";

const E = env as unknown as Env;
const OWNER_PW = "owner-password-d16";
const VISITOR_PW = "visitor-password-d16";

const hashCache = new Map<string, Promise<string>>();
function cachedHash(pw: string): Promise<string> {
  let h = hashCache.get(pw);
  if (!h) {
    h = hashPassword(pw);
    hashCache.set(pw, h);
  }
  return h;
}

async function req(
  path: string,
  init: RequestInit = {},
  token?: string,
  overrideEnv?: Partial<Env>
): Promise<Response> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  let target: Env = E;
  if (overrideEnv) {
    target = Object.create(E) as Env;
    for (const [key, value] of Object.entries(overrideEnv)) {
      Object.defineProperty(target, key, { value, enumerable: true });
    }
  }
  const res = await app.request(path, { ...init, headers }, target, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

type ErrBody = { error: { code: string; message: string } };

async function ownerToken(): Promise<string> {
  const res = await req("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "owner", password: OWNER_PW }),
  });
  return ((await json<{ token?: string }>(res)).token ?? "") as string;
}

/** owner（users.id = 1）名下種一個地址（跳過 argon2 以維持測試速度） */
async function seedOwnerAddress(localPart: string): Promise<number> {
  const res = await E.DB.prepare(
    `INSERT INTO email_addresses
       (user_id, local_part, domain, email, password_hash, password_changed_at, status,
        can_send, daily_send_quota, sent_today, quota_reset_at, created_at, updated_at)
     VALUES (1, ?1, 'atwho.org', ?2, NULL, 0, 'active', 1, 50, 0, ?3, ?3, ?3)`
  )
    .bind(localPart, `${localPart}@atwho.org`, Date.now())
    .run();
  return Number(res.meta.last_row_id);
}

/** 種一個訪客（含地址） */
async function seedVisitor(email: string): Promise<{ userId: number; addressId: number }> {
  const ts = Date.now();
  const userRes = await E.DB.prepare(
    `INSERT INTO users (username, display_name, password_hash, status, role, created_at, updated_at)
     VALUES (?1, NULL, ?2, 'active', 'visitor', ?3, ?3)`
  )
    .bind(`u-${email}`, await cachedHash(VISITOR_PW), ts)
    .run();
  const userId = Number(userRes.meta.last_row_id);
  const addrRes = await E.DB.prepare(
    `INSERT INTO email_addresses
       (user_id, local_part, domain, email, password_hash, password_changed_at, status,
        can_send, daily_send_quota, sent_today, quota_reset_at, created_at, updated_at)
     VALUES (?1, ?2, 'atwho.org', ?3, ?4, ?5, 'active', 1, 20, 0, ?6, ?5, ?5)`
  )
    .bind(userId, email.split("@")[0]!, email, await cachedHash(VISITOR_PW), ts, Date.now() + 3600_000)
    .run();
  return { userId, addressId: Number(addrRes.meta.last_row_id) };
}

/** 種一封信（R2 放好 raw／html 物件，供刪除後驗證物件狀態） */
async function seedMessage(opts: {
  addressId: number;
  ownerUserId: number;
  rawKey: string;
  htmlKey?: string;
  kind?: string;
}): Promise<number> {
  const ts = Date.now();
  await E.MAIL.put(opts.rawKey, new TextEncoder().encode("raw-message"));
  if (opts.htmlKey) await E.MAIL.put(opts.htmlKey, new TextEncoder().encode("<p>hi</p>"));
  const res = await E.DB.prepare(
    `INSERT INTO messages
       (owner_user_id, address_id, folder, message_id, from_address, to_address, subject, text_preview,
        received_at, raw_r2_key, html_r2_key, created_at, updated_at, kind)
     VALUES (?1, ?2, 'inbox', NULL, 'sender@example.com', '[]', 's', 'p', ?3, ?4, ?5, ?3, ?3, ?6)`
  )
    .bind(
      opts.ownerUserId,
      opts.addressId,
      ts,
      opts.rawKey,
      opts.htmlKey ?? null,
      opts.kind ?? "normal"
    )
    .run();
  return Number(res.meta.last_row_id);
}

async function seedAttachment(messageId: number, r2Key: string): Promise<void> {
  await E.MAIL.put(r2Key, new TextEncoder().encode("attachment"));
  const ts = Date.now();
  await E.DB.prepare(
    `INSERT INTO attachments
       (message_id, filename, stored_filename, content_type, size_bytes, r2_key, created_at, updated_at)
     VALUES (?1, 'a.pdf', 'a.pdf', 'application/pdf', 10, ?2, ?3, ?3)`
  )
    .bind(messageId, r2Key, ts)
    .run();
}

async function seedAlias(aliasAddress: string, targetAddressId: number): Promise<void> {
  const ts = Date.now();
  await E.DB.prepare(
    `INSERT INTO email_aliases (alias_address, target_email_address_id, status, created_at, updated_at)
     VALUES (?1, ?2, 'active', ?3, ?3)`
  )
    .bind(aliasAddress, targetAddressId, ts)
    .run();
}

async function seedAttempts(key: string): Promise<void> {
  await E.DB.prepare(
    `INSERT INTO auth_attempts (key, fail_count, locked_until, updated_at) VALUES (?1, 3, 0, ?2)
     ON CONFLICT(key) DO UPDATE SET fail_count = 3, updated_at = ?2`
  )
    .bind(key, Date.now())
    .run();
}

async function seedTemplate(key: string): Promise<number> {
  const res = await E.DB.prepare(
    "INSERT INTO form_templates (key, version, schema_json, created_at) VALUES (?1, 1, '{}', ?2)"
  )
    .bind(key, Date.now())
    .run();
  return Number(res.meta.last_row_id);
}

/** 種一筆表單實例；時間刻意早於請求，方便斷言 `updated_at` 是否被 soft 撤銷更新 */
async function seedInstance(opts: {
  templateId: number;
  messageId: number;
  senderAddressId: number;
  recipientAddressId: number;
  status: "open" | "submitted" | "revoked" | "expired";
}): Promise<number> {
  const ts = Date.now() - 60_000;
  const res = await E.DB.prepare(
    `INSERT INTO form_instances
       (template_id, message_id, sender_address_id, recipient_address_id, status, due_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?6)`
  )
    .bind(opts.templateId, opts.messageId, opts.senderAddressId, opts.recipientAddressId, opts.status, ts)
    .run();
  return Number(res.meta.last_row_id);
}

async function seedResponse(instanceId: number, responderUserId: number, payload = '{"answer":"x"}'): Promise<void> {
  await E.DB.prepare(
    "INSERT INTO form_responses (instance_id, responder_user_id, payload_json, submitted_at) VALUES (?1, ?2, ?3, ?4)"
  )
    .bind(instanceId, responderUserId, payload, Date.now() - 30_000)
    .run();
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await E.DB.prepare(sql)
    .bind(...binds)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

interface InstanceRow {
  status: string;
  updated_at: number;
}

async function instanceRow(id: number): Promise<InstanceRow | null> {
  return E.DB.prepare("SELECT status, updated_at FROM form_instances WHERE id = ?1")
    .bind(id)
    .first<InstanceRow>();
}

interface AuditRow {
  detail: string | null;
  user_id: number | null;
  address_id: number | null;
  created_at: number;
}

async function lastAudit(event: string): Promise<AuditRow | null> {
  return E.DB.prepare(
    "SELECT detail, user_id, address_id, created_at FROM registration_audit WHERE event = ?1 ORDER BY id DESC LIMIT 1"
  )
    .bind(event)
    .first<AuditRow>();
}

/** 真的 DB ＋ 在 batch 尾端追加必定失敗的 SQL（前面的語句真的執行 → 驗證交易回滾） */
function dbWithBatchFailure(real: D1Database): D1Database {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "batch") {
        return async (stmts: D1PreparedStatement[]) =>
          target.batch([...stmts, target.prepare("SELECT * FROM __d16_missing_table__")]);
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

beforeEach(async () => {
  for (const t of [
    "form_responses",
    "form_instances",
    "form_templates",
    "attachments",
    "messages",
    "registration_audit",
    "invites",
    "email_aliases",
    "email_addresses",
    "users",
    "auth_attempts",
  ]) {
    await E.DB.prepare(`DELETE FROM ${t}`).run();
  }
  const existing = await E.MAIL.list();
  for (const obj of existing.objects) await E.MAIL.delete(obj.key);

  const ts = Date.now();
  await E.DB.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, status, role, created_at, updated_at)
     VALUES (1, 'owner', 'Owner', ?1, 'active', 'owner', ?2, ?2)`
  )
    .bind(await cachedHash(OWNER_PW), ts)
    .run();
});

// ══════════════════════ T56：刪除有表單實例的訪客 ══════════════════════
describe("T56：DELETE /api/users/:id 對有表單實例（open ＋ submitted）的訪客 → 200 且完整清除", () => {
  it("form_responses／form_instances／messages／attachments／aliases／address／user／auth_attempts 全清；稽核與 form_templates 保留", async () => {
    const victim = await seedVisitor("gone56@atwho.org");
    const other = await seedVisitor("keep56@atwho.org");
    const ownerAddr = await seedOwnerAddress("owner56");
    const templateId = await seedTemplate("d16-t56");

    // 受害訪客：2 封信（1 封含 HTML）、1 個附件、1 個別名、登入計數
    const m1 = await seedMessage({
      addressId: victim.addressId,
      ownerUserId: victim.userId,
      rawKey: "mail/2026/10/t56-v1.eml",
      htmlKey: "mail/2026/10/t56-v1.html",
      kind: "interactive_form",
    });
    const m2 = await seedMessage({
      addressId: victim.addressId,
      ownerUserId: victim.userId,
      rawKey: "mail/2026/10/t56-v2.eml",
      kind: "interactive_form",
    });
    await seedAttachment(m1, "attachments/t56/0-a.pdf");
    await seedAlias("alias56@atwho.org", victim.addressId);
    await seedAttempts("mailbox:gone56@atwho.org");

    // 受害訪客**寄出**的表單實例：message 屬於其他訪客（涵蓋 sender_address_id 分支）
    const m3 = await seedMessage({
      addressId: other.addressId,
      ownerUserId: other.userId,
      rawKey: "mail/2026/10/t56-other.eml",
      kind: "interactive_form",
    });

    // 無關的表單（owner → other）：不得被誤刪
    const m4 = await seedMessage({
      addressId: other.addressId,
      ownerUserId: other.userId,
      rawKey: "mail/2026/10/t56-keep.eml",
      kind: "interactive_form",
    });

    const i1 = await seedInstance({
      templateId,
      messageId: m1,
      senderAddressId: ownerAddr,
      recipientAddressId: victim.addressId,
      status: "open",
    });
    const i2 = await seedInstance({
      templateId,
      messageId: m2,
      senderAddressId: ownerAddr,
      recipientAddressId: victim.addressId,
      status: "submitted",
    });
    const i3 = await seedInstance({
      templateId,
      messageId: m3,
      senderAddressId: victim.addressId,
      recipientAddressId: other.addressId,
      status: "open",
    });
    const i4 = await seedInstance({
      templateId,
      messageId: m4,
      senderAddressId: ownerAddr,
      recipientAddressId: other.addressId,
      status: "submitted",
    });
    await seedResponse(i2, victim.userId);
    await seedResponse(i3, other.userId);
    await seedResponse(i4, other.userId);

    // 既有稽核（不可竄改）
    await E.DB.prepare(
      `INSERT INTO registration_audit (event, user_id, address_id, detail, created_at)
       VALUES ('register_ok', ?1, ?2, '{"invite":"masked"}', ?3)`
    )
      .bind(victim.userId, victim.addressId, Date.now() - 1000)
      .run();

    const token = await ownerToken();
    const res = await req(`/api/users/${victim.userId}`, { method: "DELETE" }, token);
    expect(res.status).toBe(200);
    const body = await json<{ ok: boolean; deleted: { addresses: number; messages: number; attachments: number; aliases: number } }>(res);
    expect(body.ok).toBe(true);
    // 回應格式維持既有四欄（不得因 D16 改變）
    expect(body.deleted).toEqual({ addresses: 1, messages: 2, attachments: 1, aliases: 1 });

    // 受害訪客的實例與回覆全清（recipient 或 sender 為其地址）
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM form_instances WHERE recipient_address_id = ?1 OR sender_address_id = ?1",
        victim.addressId
      )
    ).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM form_responses WHERE responder_user_id = ?1", victim.userId)).toBe(0);
    // i3 的回覆由 other 送出，但實例屬本次清除範圍 → 一併刪除（FK 要求先刪回覆）
    expect(await count("SELECT COUNT(*) AS n FROM form_responses")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM form_responses WHERE instance_id = ?1", i4)).toBe(1);

    // 其他使用者／無關表單不受影響
    expect(await count("SELECT COUNT(*) AS n FROM users WHERE id = ?1", other.userId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM email_addresses WHERE id = ?1", other.addressId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM form_instances WHERE id = ?1", i4)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE id = ?1", m3)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE id = ?1", m4)).toBe(1);

    // ⚠️ form_templates 可重用 → 絕不刪除
    expect(await count("SELECT COUNT(*) AS n FROM form_templates WHERE id = ?1", templateId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM form_templates")).toBe(1);

    // 既有清除範圍不變
    expect(await count("SELECT COUNT(*) AS n FROM users WHERE id = ?1", victim.userId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM email_addresses WHERE user_id = ?1", victim.userId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE owner_user_id = ?1", victim.userId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE address_id = ?1", victim.addressId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM attachments WHERE r2_key = ?1", "attachments/t56/0-a.pdf")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM email_aliases WHERE alias_address = ?1", "alias56@atwho.org")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM auth_attempts WHERE key = ?1", "mailbox:gone56@atwho.org")).toBe(0);

    // R2：受害訪客的物件清除；其他使用者的物件保留
    expect(await E.MAIL.get("mail/2026/10/t56-v1.eml")).toBeNull();
    expect(await E.MAIL.get("mail/2026/10/t56-v1.html")).toBeNull();
    expect(await E.MAIL.get("attachments/t56/0-a.pdf")).toBeNull();
    expect(await E.MAIL.get("mail/2026/10/t56-other.eml")).not.toBeNull();
    expect(await E.MAIL.get("mail/2026/10/t56-keep.eml")).not.toBeNull();

    // registration_audit：既有列保留，另寫 user_deleted（既有格式不變；不含任何信件內容 → N9）
    expect(
      await count("SELECT COUNT(*) AS n FROM registration_audit WHERE event = 'register_ok' AND user_id = ?1", victim.userId)
    ).toBe(1);
    const audit = await lastAudit("user_deleted");
    expect(audit).not.toBeNull();
    expect(audit!.user_id).toBe(victim.userId);
    expect(JSON.parse(audit!.detail!)).toMatchObject({
      by: 1,
      address: "gone56@atwho.org",
    });
  });
});

// ══════════════════════ T57：hard 刪除有表單實例的地址 ══════════════════════
describe("T57：DELETE /api/email-addresses/:id?mode=hard 對有表單實例的地址 → 200 且完整清除", () => {
  it("清除範圍含 recipient／sender 實例；form_templates 保留且可重用；名稱可重建", async () => {
    const addrA = await seedOwnerAddress("gone57"); // 將被 hard 刪除
    const addrB = await seedOwnerAddress("keep57b");
    const addrC = await seedOwnerAddress("keep57c");
    const visitor = await seedVisitor("keep57@atwho.org");
    const templateId = await seedTemplate("d16-t57");

    // A 的信件（含附件／別名／登入計數／R2）
    const m1 = await seedMessage({
      addressId: addrA,
      ownerUserId: 1,
      rawKey: "mail/2026/10/t57-a.eml",
      htmlKey: "mail/2026/10/t57-a.html",
      kind: "interactive_form",
    });
    await seedAttachment(m1, "attachments/t57/0-a.pdf");
    await seedAlias("alias57@atwho.org", addrA);
    await seedAttempts("mailbox:gone57@atwho.org");

    // 訪客的信（A 寄出的實例指向它）＋ C 的信（無關實例）
    const m2 = await seedMessage({
      addressId: visitor.addressId,
      ownerUserId: visitor.userId,
      rawKey: "mail/2026/10/t57-other.eml",
      kind: "interactive_form",
    });
    const m3 = await seedMessage({
      addressId: addrC,
      ownerUserId: 1,
      rawKey: "mail/2026/10/t57-keep.eml",
      kind: "interactive_form",
    });

    const i1 = await seedInstance({
      templateId,
      messageId: m1,
      senderAddressId: addrB,
      recipientAddressId: addrA,
      status: "open",
    });
    const i2 = await seedInstance({
      templateId,
      messageId: m2,
      senderAddressId: addrA,
      recipientAddressId: visitor.addressId,
      status: "submitted",
    });
    const i3 = await seedInstance({
      templateId,
      messageId: m3,
      senderAddressId: addrB,
      recipientAddressId: addrC,
      status: "open",
    });
    await seedResponse(i2, visitor.userId);

    const token = await ownerToken();
    const res = await req(`/api/email-addresses/${addrA}?mode=hard`, { method: "DELETE" }, token);
    expect(res.status).toBe(200);
    const body = await json<{
      ok: boolean;
      previously_deleted: boolean;
      deleted: { messages: number; attachments: number; aliases: number };
    }>(res);
    expect(body.ok).toBe(true);
    expect(body.previously_deleted).toBe(false);
    expect(body.deleted).toEqual({ messages: 1, attachments: 1, aliases: 1, r2_objects: 3 });

    // 表單：A 的 recipient／sender 實例與其回覆全清；無關實例保留
    expect(await count("SELECT COUNT(*) AS n FROM form_instances WHERE id = ?1", i1)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM form_instances WHERE id = ?1", i2)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM form_responses WHERE instance_id = ?1", i2)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM form_responses")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM form_instances WHERE id = ?1", i3)).toBe(1);

    // ⚠️ form_templates 可重用 → 保留；且可以再用它建立新實例
    expect(await count("SELECT COUNT(*) AS n FROM form_templates WHERE id = ?1", templateId)).toBe(1);
    const reused = await E.DB.prepare(
      `INSERT INTO form_instances
         (template_id, message_id, sender_address_id, recipient_address_id, status, due_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'open', NULL, ?5, ?5)`
    )
      .bind(templateId, m3, addrB, addrC, Date.now())
      .run();
    expect(Number(reused.meta.last_row_id)).toBeGreaterThan(0);

    // 既有清除範圍不變
    expect(await count("SELECT COUNT(*) AS n FROM email_addresses WHERE id = ?1", addrA)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE id = ?1", m1)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM attachments WHERE message_id = ?1", m1)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM email_aliases WHERE target_email_address_id = ?1", addrA)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM auth_attempts WHERE key = ?1", "mailbox:gone57@atwho.org")).toBe(0);
    // 他人的信件不因「實例被刪」而消失（D16 只清 form 表＋既有範圍）
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE id = ?1", m2)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE id = ?1", m3)).toBe(1);

    // R2：A 的物件清除；他人的保留
    expect(await E.MAIL.get("mail/2026/10/t57-a.eml")).toBeNull();
    expect(await E.MAIL.get("mail/2026/10/t57-a.html")).toBeNull();
    expect(await E.MAIL.get("attachments/t57/0-a.pdf")).toBeNull();
    expect(await E.MAIL.get("mail/2026/10/t57-other.eml")).not.toBeNull();

    // 名稱可重用（hard 的既有語意）
    const recreate = await req(
      "/api/email-addresses",
      { method: "POST", body: JSON.stringify({ local_part: "gone57" }) },
      token
    );
    expect(recreate.status).toBe(201);

    // 稽核：address_deleted(mode=hard)，既有格式不變（不含任何信件內容 → N9）
    const audit = await lastAudit("address_deleted");
    expect(audit).not.toBeNull();
    expect(audit!.address_id).toBe(addrA);
    expect(JSON.parse(audit!.detail!)).toMatchObject({
      by: 1,
      address: "gone57@atwho.org",
      mode: "hard",
    });
  });
});

// ══════════════════════ T58：soft 刪除地址 → open 實例轉 revoked ══════════════════════
describe("T58：DELETE /api/email-addresses/:id（soft）→ 該地址 open 實例轉 revoked，其餘資料不動", () => {
  it("open → revoked（updated_at 同步）；submitted 實例／回覆／messages／attachments／R2 全部保留", async () => {
    const addrA = await seedOwnerAddress("soft58");
    const addrB = await seedOwnerAddress("keep58");
    const templateId = await seedTemplate("d16-t58");

    const m1 = await seedMessage({
      addressId: addrA,
      ownerUserId: 1,
      rawKey: "mail/2026/10/t58-a.eml",
      htmlKey: "mail/2026/10/t58-a.html",
      kind: "interactive_form",
    });
    const m2 = await seedMessage({
      addressId: addrA,
      ownerUserId: 1,
      rawKey: "mail/2026/10/t58-b.eml",
      kind: "interactive_form",
    });
    const m3 = await seedMessage({
      addressId: addrB,
      ownerUserId: 1,
      rawKey: "mail/2026/10/t58-keep.eml",
      kind: "interactive_form",
    });
    await seedAttachment(m1, "attachments/t58/0-a.pdf");

    const i1 = await seedInstance({
      templateId,
      messageId: m1,
      senderAddressId: addrB,
      recipientAddressId: addrA,
      status: "open",
    });
    const i2 = await seedInstance({
      templateId,
      messageId: m2,
      senderAddressId: addrB,
      recipientAddressId: addrA,
      status: "submitted",
    });
    // A 當寄件人的 open 實例：soft 只撤銷「A 為收件人」的實例，寄件中的不受影響
    const i3 = await seedInstance({
      templateId,
      messageId: m3,
      senderAddressId: addrA,
      recipientAddressId: addrB,
      status: "open",
    });
    await seedResponse(i2, 1);

    const beforeI1 = await instanceRow(i1);
    const beforeI2 = await instanceRow(i2);
    const beforeI3 = await instanceRow(i3);
    const startedAt = Date.now();

    const token = await ownerToken();
    const res = await req(`/api/email-addresses/${addrA}?mode=soft`, { method: "DELETE" }, token);
    expect(res.status).toBe(204);

    // ① 該地址（收件人）的 open 實例 → revoked，updated_at 同步更新
    const afterI1 = await instanceRow(i1);
    expect(afterI1?.status).toBe("revoked");
    expect(afterI1!.updated_at).toBeGreaterThanOrEqual(startedAt);
    expect(afterI1!.updated_at).toBeGreaterThan(beforeI1!.updated_at);

    // ② submitted 實例與其回覆一字不動
    expect(await instanceRow(i2)).toEqual(beforeI2);
    expect(await count("SELECT COUNT(*) AS n FROM form_responses WHERE instance_id = ?1", i2)).toBe(1);

    // ③ A 當寄件人的 open 實例不因 soft 而撤銷
    expect(await instanceRow(i3)).toEqual(beforeI3);
    expect((await instanceRow(i3))?.status).toBe("open");

    // ④ 地址列標記 deleted；其餘資料（信件／附件／R2）全部保留
    const addr = await E.DB.prepare("SELECT status, deleted_at FROM email_addresses WHERE id = ?1")
      .bind(addrA)
      .first<{ status: string; deleted_at: number | null }>();
    expect(addr?.status).toBe("deleted");
    expect(addr?.deleted_at).toBeGreaterThanOrEqual(startedAt);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE address_id = ?1", addrA)).toBe(2);
    expect(await count("SELECT COUNT(*) AS n FROM attachments WHERE message_id = ?1", m1)).toBe(1);
    expect(await E.MAIL.get("mail/2026/10/t58-a.eml")).not.toBeNull();
    expect(await E.MAIL.get("mail/2026/10/t58-a.html")).not.toBeNull();
    expect(await E.MAIL.get("attachments/t58/0-a.pdf")).not.toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE id = ?1", m3)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM form_templates WHERE id = ?1", templateId)).toBe(1);

    // 其他地址的實例不受影響
    expect((await instanceRow(i3))?.status).toBe("open");
    expect(await count("SELECT COUNT(*) AS n FROM email_addresses WHERE id = ?1", addrB)).toBe(1);

    // 稽核：soft 模式，既有格式不變（不含任何信件內容 → N9）
    const audit = await lastAudit("address_deleted");
    expect(audit).not.toBeNull();
    expect(audit!.address_id).toBe(addrA);
    expect(JSON.parse(audit!.detail!)).toMatchObject({
      by: 1,
      address: "soft58@atwho.org",
      mode: "soft",
      messages: 0,
      messages_retained: 2,
    });
  });

  it("soft 的「撤銷實例＋標記地址」在同一個 batch：失敗 → 500 DELETE_FAILED（已回滾，兩者皆未變）", async () => {
    const addr = await seedOwnerAddress("fail58");
    const templateId = await seedTemplate("d16-t58-fail");
    const m1 = await seedMessage({
      addressId: addr,
      ownerUserId: 1,
      rawKey: "mail/2026/10/t58-fail.eml",
      kind: "interactive_form",
    });
    const i1 = await seedInstance({
      templateId,
      messageId: m1,
      senderAddressId: addr,
      recipientAddressId: addr,
      status: "open",
    });
    const before = await instanceRow(i1);

    const token = await ownerToken();
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await req(
        `/api/email-addresses/${addr}?mode=soft`,
        { method: "DELETE" },
        token,
        { DB: dbWithBatchFailure(E.DB) }
      );
      expect(res.status).toBe(500);
      const body = await json<ErrBody>(res);
      expect(body.error.code).toBe("DELETE_FAILED");
      expect(body.error.message).toBe("刪除失敗（已回滾，資料未變更）");
      expect(body.error.message).not.toContain("__d16_missing_table__");
    } finally {
      spy.mockRestore();
    }

    // 交易回滾：位址仍 active、實例仍 open（updated_at 未被改寫）
    const row = await E.DB.prepare("SELECT status, deleted_at FROM email_addresses WHERE id = ?1")
      .bind(addr)
      .first<{ status: string; deleted_at: number | null }>();
    expect(row?.status).toBe("active");
    expect(row?.deleted_at).toBeNull();
    expect(await instanceRow(i1)).toEqual(before);
    expect(await count("SELECT COUNT(*) AS n FROM registration_audit WHERE event = 'address_deleted'")).toBe(0);
  });
});
