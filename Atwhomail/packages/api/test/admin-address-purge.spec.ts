/**
 * admin-address-purge.spec.ts — docs/16 **D11-5**（允許對「已軟刪除」的地址執行永久清除）
 *
 * 對應 docs/16 §6：**T30–T32**，外加邊界案例：
 * 「已刪除的地址」清單（`GET /api/email-addresses?deleted=1`）的內容與權限、
 * 精準清除（不誤傷自己的其他地址／他人的地址）、重複 hard、參數邊界。
 *
 * 背景（D11 完成後的已知限制）：`DELETE /api/email-addresses/:id` 的查詢條件只認
 * `deleted_at IS NULL`，所以做過 soft delete 的地址**再也無法**升級為 hard →
 * 它的信件、附件與 R2 物件會永遠殘留，名稱也永遠不放。D11-5 讓 hard 涵蓋這類列。
 *
 * 全程在 workerd 內以真實 D1／R2 執行，且一律走**真實端點**，確保測到的是實際上線路徑。
 *
 * ⚠️ 測試環境未設定 `ACCESS_MAIL_AUD` → `/api/auth/login` 走 D2 的過渡放行（與其他測試檔一致）。
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { hashPassword, type Env } from "../src/auth";

const E = env as unknown as Env;
const OWNER_PW = "owner-password-d11-5";
const VISITOR_PW = "visitor-password-d11-5";
const ADMIN = "test-admin-token"; // vitest.config.ts 注入的測試 binding（公開的測試常數）

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

type ErrBody = { error: { code: string; message: string } };
const codeOf = async (res: Response): Promise<string> => (await json<ErrBody>(res)).error.code;

async function ownerToken(): Promise<string> {
  const res = await req("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "owner", password: OWNER_PW }),
  });
  return ((await json<{ token?: string }>(res)).token ?? "") as string;
}

async function mailboxLogin(email: string, password = VISITOR_PW): Promise<string> {
  const res = await req("/api/auth/mailbox-login", { method: "POST", body: JSON.stringify({ email, password }) });
  if (res.status !== 200) return "";
  return ((await json<{ token?: string }>(res)).token ?? "") as string;
}

/** 在 owner（users.id = 1）名下種一個地址（跳過 argon2 以維持測試速度） */
async function seedOwnerAddress(localPart: string, userId = 1): Promise<number> {
  const res = await E.DB.prepare(
    `INSERT INTO email_addresses
       (user_id, local_part, domain, email, password_hash, password_changed_at, status,
        can_send, daily_send_quota, sent_today, quota_reset_at, created_at, updated_at)
     VALUES (?1, ?2, 'atwho.org', ?3, NULL, 0, 'active', 1, 50, 0, ?4, ?4, ?4)`
  )
    .bind(userId, localPart, `${localPart}@atwho.org`, Date.now())
    .run();
  return Number(res.meta.last_row_id);
}

/** 另一個 owner 帳號（他人地址的權限邊界用） */
async function seedOtherOwner(): Promise<number> {
  const ts = Date.now();
  const res = await E.DB.prepare(
    `INSERT INTO users (username, display_name, password_hash, status, role, created_at, updated_at)
     VALUES ('owner2', NULL, ?1, 'active', 'owner', ?2, ?2)`
  )
    .bind(await cachedHash(OWNER_PW), ts)
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

/**
 * 直接把列標成「已軟刪除」。
 *
 * 用於**別人的**地址（他人 owner／訪客）：我們沒有對方的 session，無法走 soft 端點；
 * 這裡要測的是 hard 的權限邊界，列的來源不影響結論。自己名下的地址則一律走真實 soft 端點。
 */
async function softDeleteInDb(id: number): Promise<number> {
  const ts = Date.now();
  await E.DB.prepare(
    "UPDATE email_addresses SET status = 'deleted', deleted_at = ?1, updated_at = ?1 WHERE id = ?2"
  )
    .bind(ts, id)
    .run();
  return ts;
}

/** 種一封信（同時在 R2 放好 raw／html 物件，供刪除後驗證物件是否清除） */
async function seedMessage(opts: {
  addressId: number;
  ownerUserId?: number;
  folder?: string;
  rawKey: string;
  htmlKey?: string;
}): Promise<number> {
  const ts = Date.now();
  await E.MAIL.put(opts.rawKey, new TextEncoder().encode("raw-message"));
  if (opts.htmlKey) await E.MAIL.put(opts.htmlKey, new TextEncoder().encode("<p>hi</p>"));
  const res = await E.DB.prepare(
    `INSERT INTO messages
       (owner_user_id, address_id, folder, message_id, from_address, to_address, subject, text_preview,
        received_at, raw_r2_key, html_r2_key, created_at, updated_at, deleted_at)
     VALUES (?1, ?2, ?3, NULL, 'sender@example.com', '[]', 's', 'p', ?4, ?5, ?6, ?4, ?4, NULL)`
  )
    .bind(opts.ownerUserId ?? 1, opts.addressId, opts.folder ?? "inbox", ts, opts.rawKey, opts.htmlKey ?? null)
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

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await E.DB.prepare(sql)
    .bind(...binds)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
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

async function addressRow(id: number): Promise<{ status: string; deleted_at: number | null } | null> {
  return E.DB.prepare("SELECT status, deleted_at FROM email_addresses WHERE id = ?1")
    .bind(id)
    .first<{ status: string; deleted_at: number | null }>();
}

/** `GET /api/email-addresses?deleted=1`（D11-5 前端「已刪除的地址」區塊的來源） */
interface DeletedRow {
  id: number;
  email: string;
  status: string;
  created_at: number;
  updated_at: number;
  deleted_at: number;
  messages: number;
}
const deletedList = async (token: string): Promise<DeletedRow[]> =>
  (await json<{ addresses: DeletedRow[] }>(await req("/api/email-addresses?deleted=1", {}, token))).addresses;

const createBody = (localPart: string) => ({ method: "POST", body: JSON.stringify({ local_part: localPart }) });

beforeEach(async () => {
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
});

// ══════════════════════ T30：對已軟刪除的地址執行 mode=hard ══════════════════════
describe("T30：對已軟刪除的地址執行 mode=hard → 信件／附件／R2 清除、名稱可重用、稽核正確", () => {
  it("soft 過的地址（含垃圾桶的信）可升級清除，該列被移除、名稱釋放、稽核 address_deleted(mode=hard)", async () => {
    const addr = await seedOwnerAddress("purge30");
    const other = await seedOwnerAddress("keep30");

    // 目標地址：inbox（有 html）＋ trash ＋ sent 各 1 封，外加 1 個附件、1 個別名、1 筆登入失敗計數
    const m1 = await seedMessage({
      addressId: addr,
      folder: "inbox",
      rawKey: "mail/2026/10/purge30-inbox.eml",
      htmlKey: "mail/2026/10/purge30-inbox.html",
    });
    await seedMessage({ addressId: addr, folder: "trash", rawKey: "mail/2026/10/purge30-trash.eml" });
    await seedMessage({ addressId: addr, folder: "sent", rawKey: "mail/2026/10/purge30-sent.eml" });
    await seedAttachment(m1, "attachments/purge30/0-a.pdf");
    await seedAlias("alias30@atwho.org", addr);
    await seedAttempts("mailbox:purge30@atwho.org");

    // 另一個地址（同一位 owner）：不得被誤刪
    const otherMsg = await seedMessage({
      addressId: other,
      rawKey: "mail/2026/10/keep30.eml",
      htmlKey: "mail/2026/10/keep30.html",
    });
    await seedAttachment(otherMsg, "attachments/keep30/0-a.pdf");

    const token = await ownerToken();

    // 1) 先走既有的 soft（D11-5 的起點：soft 之後就再也清不掉）
    const softAt = Date.now();
    expect((await req(`/api/email-addresses/${addr}`, { method: "DELETE" }, token)).status).toBe(204);

    // 2) 「已刪除的地址」清單找得到它（含刪除時間與信件數＝hard 實際會清除的數量）
    const deletedRows = await deletedList(token);
    const listed = deletedRows.find((r) => r.id === addr);
    expect(listed).toBeDefined();
    expect(listed!.email).toBe("purge30@atwho.org");
    expect(listed!.status).toBe("deleted");
    expect(listed!.deleted_at).toBeGreaterThanOrEqual(softAt);
    expect(listed!.messages).toBe(3); // 含垃圾桶
    expect(deletedRows.map((r) => r.id)).not.toContain(other); // 未刪除的地址不在這份清單

    // 3) 預設清單（未帶參數）仍不含已刪除的列（既有行為不變，D11-3）
    const live = await json<{ addresses: Array<{ id: number }> }>(await req("/api/email-addresses", {}, token));
    expect(live.addresses.map((a) => a.id)).not.toContain(addr);

    // 4) 升級：mode=hard
    const startedAt = Date.now();
    const res = await req(`/api/email-addresses/${addr}?mode=hard`, { method: "DELETE" }, token);
    expect(res.status).toBe(200);
    const body = await json<{
      ok: boolean;
      id: number;
      email: string;
      mode: string;
      previously_deleted: boolean;
      deleted: { messages: number; attachments: number; aliases: number; r2_objects: number };
    }>(res);
    expect(body.ok).toBe(true);
    expect(body.id).toBe(addr);
    expect(body.email).toBe("purge30@atwho.org");
    expect(body.mode).toBe("hard");
    expect(body.previously_deleted).toBe(true); // 這是一次「從垃圾桶升級」的清除
    expect(body.deleted.messages).toBe(3);
    expect(body.deleted.attachments).toBe(1);
    expect(body.deleted.aliases).toBe(1);
    expect(body.deleted.r2_objects).toBe(5); // 3 raw + 1 html + 1 附件

    // 5) D1：該列真的被移除（名稱釋放的前提）＋ 子表全清
    expect(await count("SELECT COUNT(*) AS n FROM email_addresses WHERE id = ?1", addr)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE address_id = ?1", addr)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM attachments WHERE r2_key = ?1", "attachments/purge30/0-a.pdf")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM email_aliases WHERE alias_address = ?1", "alias30@atwho.org")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM auth_attempts WHERE key = ?1", "mailbox:purge30@atwho.org")).toBe(0);

    // 6) R2：含垃圾桶那封的物件也一起清除
    expect(await E.MAIL.get("mail/2026/10/purge30-inbox.eml")).toBeNull();
    expect(await E.MAIL.get("mail/2026/10/purge30-inbox.html")).toBeNull();
    expect(await E.MAIL.get("mail/2026/10/purge30-trash.eml")).toBeNull();
    expect(await E.MAIL.get("mail/2026/10/purge30-sent.eml")).toBeNull();
    expect(await E.MAIL.get("attachments/purge30/0-a.pdf")).toBeNull();

    // 7) 另一個地址毫髮無傷（精準清除，不是清空整張表）
    expect(await count("SELECT COUNT(*) AS n FROM email_addresses WHERE id = ?1", other)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE address_id = ?1", other)).toBe(1);
    expect(await E.MAIL.get("mail/2026/10/keep30.eml")).not.toBeNull();
    expect(await E.MAIL.get("attachments/keep30/0-a.pdf")).not.toBeNull();

    // 8) 名稱已釋放 → 同名可重建（201，且是全新乾淨的列；D11-5 讓「soft 過的名稱」終於解得開）
    const again = await req("/api/email-addresses", createBody("purge30"), token);
    expect(again.status).toBe(201);
    const created = await json<{ id: number; email: string; status: string }>(again);
    expect(created.email).toBe("purge30@atwho.org");
    expect(created.status).toBe("active");
    expect(created.id).not.toBe(addr);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE address_id = ?1", created.id)).toBe(0);

    // 9) 該地址已不在「已刪除的地址」清單（清乾淨了）
    expect((await deletedList(token)).map((r) => r.id)).not.toContain(addr);

    // 10) 稽核 address_deleted(mode=hard)：操作 owner id、address id／email、被刪信件數、時間
    const audit = await lastAudit("address_deleted");
    expect(audit).not.toBeNull();
    expect(audit!.user_id).toBe(1);
    expect(audit!.address_id).toBe(addr);
    expect(audit!.created_at).toBeGreaterThanOrEqual(startedAt);
    expect(JSON.parse(audit!.detail!)).toEqual({
      by: 1,
      address: "purge30@atwho.org",
      mode: "hard",
      messages: 3,
      attachments: 1,
      aliases: 1,
      r2_objects: 5,
      messages_retained: 0, // 該地址已不存在（名稱已釋放）
    });

    // soft 與 hard 各寫一筆（升級路徑＝兩次都是明確的刪除動作，稽核不得漏記）
    expect(await count("SELECT COUNT(*) AS n FROM registration_audit WHERE event = 'address_deleted'")).toBe(2);
  });

  it("已經 soft 過、且一封信用都沒有的地址也能升級清除（回 0，不是錯誤）", async () => {
    const addr = await seedOwnerAddress("purge30b");
    const token = await ownerToken();
    expect((await req(`/api/email-addresses/${addr}`, { method: "DELETE" }, token)).status).toBe(204);

    const res = await req(`/api/email-addresses/${addr}?mode=hard`, { method: "DELETE" }, token);
    expect(res.status).toBe(200);
    const body = await json<{ previously_deleted: boolean; deleted: { messages: number } }>(res);
    expect(body.previously_deleted).toBe(true);
    expect(body.deleted.messages).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM email_addresses WHERE id = ?1", addr)).toBe(0);
  });

  it("N5：rescue（x-admin-token）同樣可對已軟刪除的地址執行 hard", async () => {
    const addr = await seedOwnerAddress("purge30c");
    await seedMessage({ addressId: addr, folder: "trash", rawKey: "mail/2026/10/purge30c.eml" });
    const token = await ownerToken();
    expect((await req(`/api/email-addresses/${addr}`, { method: "DELETE" }, token)).status).toBe(204);

    const res = await req(`/api/email-addresses/${addr}?mode=hard`, { method: "DELETE" }, undefined, {
      "x-admin-token": ADMIN,
    });
    expect(res.status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM email_addresses WHERE id = ?1", addr)).toBe(0);
    expect(await E.MAIL.get("mail/2026/10/purge30c.eml")).toBeNull();
  });

  it("?deleted=1 只回自己名下的已刪除地址，且欄位足夠前端顯示（地址／刪除時間／信件數）", async () => {
    const mine = await seedOwnerAddress("purge30d");
    const otherOwnerId = await seedOtherOwner();
    const foreign = await seedOwnerAddress("foreign30d", otherOwnerId);
    await softDeleteInDb(foreign);

    const token = await ownerToken();
    expect((await req(`/api/email-addresses/${mine}`, { method: "DELETE" }, token)).status).toBe(204);

    const rows = await deletedList(token);
    expect(rows.map((r) => r.id)).toEqual([mine]); // 不含他人名下的 foreign30d
    // 前端區塊需要的欄位：地址／刪除時間／信件數（另含既有清單就有的欄位）
    expect(Object.keys(rows[0]!).sort()).toEqual(
      ["created_at", "deleted_at", "email", "has_password", "id", "messages", "status", "updated_at"].sort()
    );
  });
});

// ══════════════════════ T31：權限（不得誤刪）══════════════════════
describe("T31：對已軟刪除的地址，非 owner 或他人地址 → 404／403（不得誤刪）", () => {
  it("他人（另一個 owner 帳號）名下的已軟刪除地址 → 404，且列與信件原封不動", async () => {
    const otherOwnerId = await seedOtherOwner();
    const foreign = await seedOwnerAddress("foreign31", otherOwnerId);
    await seedMessage({ addressId: foreign, ownerUserId: otherOwnerId, rawKey: "mail/2026/10/foreign31.eml" });
    const softAt = await softDeleteInDb(foreign);

    const token = await ownerToken();
    for (const path of [`/api/email-addresses/${foreign}?mode=hard`, `/api/email-addresses/${foreign}`]) {
      const res = await req(path, { method: "DELETE" }, token);
      expect(res.status, path).toBe(404);
      expect(await codeOf(res)).toBe("NOT_FOUND");
    }

    // 沒有被誤刪、也沒有被改成別的狀態（deleted_at 一字不動）
    const row = await addressRow(foreign);
    expect(row?.status).toBe("deleted");
    expect(row?.deleted_at).toBe(softAt);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE address_id = ?1", foreign)).toBe(1);
    expect(await E.MAIL.get("mail/2026/10/foreign31.eml")).not.toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM registration_audit WHERE event = 'address_deleted'")).toBe(0);
  });

  it("訪客名下的已軟刪除地址 → 404（那是訪客管理 D9 的職責），資料完好", async () => {
    const visitor = await seedVisitor("guest31@atwho.org");
    await seedMessage({
      addressId: visitor.addressId,
      ownerUserId: visitor.userId,
      rawKey: "mail/2026/10/guest31.eml",
    });
    await softDeleteInDb(visitor.addressId);

    const token = await ownerToken();
    for (const mode of ["", "?mode=hard"]) {
      const res = await req(`/api/email-addresses/${visitor.addressId}${mode}`, { method: "DELETE" }, token);
      expect(res.status, mode).toBe(404);
      expect(await codeOf(res)).toBe("NOT_FOUND");
    }

    expect((await addressRow(visitor.addressId))?.status).toBe("deleted");
    expect(await count("SELECT COUNT(*) AS n FROM email_addresses WHERE id = ?1", visitor.addressId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE address_id = ?1", visitor.addressId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM users WHERE id = ?1", visitor.userId)).toBe(1);
  });

  it("訪客 JWT → 403；無 session → 401；兩種情況都不得誤刪", async () => {
    const addr = await seedOwnerAddress("auth31");
    await seedMessage({ addressId: addr, rawKey: "mail/2026/10/auth31.eml" });
    await softDeleteInDb(addr);

    const visitor = await seedVisitor("guest31b@atwho.org");
    const visitorToken = await mailboxLogin("guest31b@atwho.org");
    expect(visitorToken).not.toBe("");

    // 訪客連自己的地址都不能用這個端點（端點為 owner 專用）
    for (const id of [addr, visitor.addressId]) {
      const res = await req(`/api/email-addresses/${id}?mode=hard`, { method: "DELETE" }, visitorToken);
      expect(res.status, String(id)).toBe(403);
      expect(await codeOf(res)).toBe("FORBIDDEN");
    }
    expect((await req(`/api/email-addresses/${addr}?mode=hard`, { method: "DELETE" })).status).toBe(401);

    expect(await count("SELECT COUNT(*) AS n FROM email_addresses WHERE id = ?1", addr)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE address_id = ?1", addr)).toBe(1);
    expect(await E.MAIL.get("mail/2026/10/auth31.eml")).not.toBeNull();
  });

  it("「已刪除的地址」清單（?deleted=1）同樣只有 owner 能用（訪客 → 403、無 session → 401）", async () => {
    await seedVisitor("guest31c@atwho.org");
    const visitorToken = await mailboxLogin("guest31c@atwho.org");

    const asVisitor = await req("/api/email-addresses?deleted=1", {}, visitorToken);
    expect(asVisitor.status).toBe(403);
    expect(await codeOf(asVisitor)).toBe("FORBIDDEN");
    expect((await req("/api/email-addresses?deleted=1")).status).toBe(401);
  });

  it("參數邊界不受 D11-5 影響：id 不存在／非法 → 404／400；mode 非法 → 400", async () => {
    const token = await ownerToken();
    expect((await req("/api/email-addresses/999999?mode=hard", { method: "DELETE" }, token)).status).toBe(404);
    expect((await req("/api/email-addresses/abc?mode=hard", { method: "DELETE" }, token)).status).toBe(400);
    expect((await req("/api/email-addresses/0?mode=hard", { method: "DELETE" }, token)).status).toBe(400);
    const bad = await req("/api/email-addresses/999999?mode=purge", { method: "DELETE" }, token);
    expect(bad.status).toBe(400);
    expect(await codeOf(bad)).toBe("INVALID_MODE");
  });
});

// ══════════════════════ T32：soft 對已軟刪除地址的行為明確且無 500 ══════════════════════
describe("T32：對已軟刪除的地址執行 mode=soft → 行為明確且無 500", () => {
  it("已軟刪除的地址再 soft（未帶 mode 與明帶 mode=soft）→ 404 NOT_FOUND，資料完全不變", async () => {
    const addr = await seedOwnerAddress("soft32");
    const msg = await seedMessage({
      addressId: addr,
      rawKey: "mail/2026/10/soft32.eml",
      htmlKey: "mail/2026/10/soft32.html",
    });
    await seedAttachment(msg, "attachments/soft32/0-a.pdf");

    const token = await ownerToken();
    expect((await req(`/api/email-addresses/${addr}`, { method: "DELETE" }, token)).status).toBe(204);
    const softAt = (await addressRow(addr))!.deleted_at;

    // 明確的 404（＝「這裡已經沒有可 soft 刪除的列」）：不是 500、也不是再一次 204
    for (const path of [`/api/email-addresses/${addr}`, `/api/email-addresses/${addr}?mode=soft`]) {
      const res = await req(path, { method: "DELETE" }, token);
      expect(res.status, path).toBe(404);
      expect(await codeOf(res)).toBe("NOT_FOUND");
    }

    // 資料完全不變：deleted_at 不被改寫（沒有「重新刪除一次」的副作用）、信件／附件／R2 全在
    const row = await addressRow(addr);
    expect(row?.status).toBe("deleted");
    expect(row?.deleted_at).toBe(softAt);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE address_id = ?1", addr)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM attachments WHERE r2_key = ?1", "attachments/soft32/0-a.pdf")).toBe(1);
    expect(await E.MAIL.get("mail/2026/10/soft32.eml")).not.toBeNull();
    expect(await E.MAIL.get("mail/2026/10/soft32.html")).not.toBeNull();
    expect(await E.MAIL.get("attachments/soft32/0-a.pdf")).not.toBeNull();

    // 被拒的 soft 不是刪除動作 → 不得多寫稽核（只有第一次 soft 的那一筆）
    expect(await count("SELECT COUNT(*) AS n FROM registration_audit WHERE event = 'address_deleted'")).toBe(1);
  });

  it("404 不是死路：同一列改用 mode=hard 就能清除（D11-5 的升級路徑）", async () => {
    const addr = await seedOwnerAddress("soft32b");
    await seedMessage({ addressId: addr, folder: "trash", rawKey: "mail/2026/10/soft32b.eml" });
    const token = await ownerToken();
    expect((await req(`/api/email-addresses/${addr}?mode=soft`, { method: "DELETE" }, token)).status).toBe(204);
    expect((await req(`/api/email-addresses/${addr}?mode=soft`, { method: "DELETE" }, token)).status).toBe(404);

    const res = await req(`/api/email-addresses/${addr}?mode=hard`, { method: "DELETE" }, token);
    expect(res.status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM email_addresses WHERE id = ?1", addr)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE address_id = ?1", addr)).toBe(0);
  });

  it("重複 hard：第一次 200，第二次 404（列已不存在，不洩漏也不 500）", async () => {
    const addr = await seedOwnerAddress("soft32c");
    const token = await ownerToken();
    expect((await req(`/api/email-addresses/${addr}`, { method: "DELETE" }, token)).status).toBe(204);

    expect((await req(`/api/email-addresses/${addr}?mode=hard`, { method: "DELETE" }, token)).status).toBe(200);
    const second = await req(`/api/email-addresses/${addr}?mode=hard`, { method: "DELETE" }, token);
    expect(second.status).toBe(404);
    expect(await codeOf(second)).toBe("NOT_FOUND");
  });

  it("未刪除的地址 soft 仍回 204（既有行為不變；D11-5 只影響已刪除的列）", async () => {
    const addr = await seedOwnerAddress("soft32d");
    await seedMessage({ addressId: addr, rawKey: "mail/2026/10/soft32d.eml" });
    const token = await ownerToken();

    const res = await req(`/api/email-addresses/${addr}?mode=soft`, { method: "DELETE" }, token);
    expect(res.status).toBe(204);
    expect((await addressRow(addr))?.status).toBe("deleted");
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE address_id = ?1", addr)).toBe(1); // soft 保留信件
    expect(await E.MAIL.get("mail/2026/10/soft32d.eml")).not.toBeNull();
  });
});
