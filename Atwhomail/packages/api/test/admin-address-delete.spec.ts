/**
 * admin-address-delete.spec.ts — docs/16 D11（地址刪除語意補平：稽核 ＋ soft／hard ＋ 名稱釋放）
 *
 * 對應 docs/16 §6：**T25–T29**，外加邊界案例：
 * 兩種模式互不影響的範圍（精準刪除不誤傷其他地址）、hard 的附帶清除（別名／登入計數）、
 * 名稱釋放（soft 未釋放 vs hard 已釋放）、權限（他人／訪客地址 404、訪客 JWT 403、rescue）、
 * 交易性與參數邊界（`mode` 非法 → 400、`id` 非法 → 400、不存在 → 404）。
 *
 * 全程在 workerd 內以真實 D1／R2 執行，且一律走**真實端點**（`DELETE /api/email-addresses/:id`），
 * 確保測到的是實際上線路徑而非直接改 DB。
 *
 * ⚠️ 測試環境未設定 `ACCESS_MAIL_AUD` → `/api/auth/login` 走 D2 的過渡放行（與其他測試檔一致）。
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { hashPassword, type Env } from "../src/auth";

const E = env as unknown as Env;
const OWNER_PW = "owner-password-d11";
const VISITOR_PW = "visitor-password-d11";
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

/** 種一個訪客（含地址），供「不得刪訪客地址」的邊界測試使用 */
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

/** 種一封信（同時在 R2 放好 raw／html 物件，供刪除後驗證物件是否清除） */
async function seedMessage(opts: {
  addressId: number;
  ownerUserId?: number;
  folder?: string;
  rawKey: string;
  htmlKey?: string;
  subject?: string;
  from?: string;
  preview?: string;
  deletedAt?: number | null;
}): Promise<number> {
  const ts = Date.now();
  await E.MAIL.put(opts.rawKey, new TextEncoder().encode("raw-message"));
  if (opts.htmlKey) await E.MAIL.put(opts.htmlKey, new TextEncoder().encode("<p>hi</p>"));
  const res = await E.DB.prepare(
    `INSERT INTO messages
       (owner_user_id, address_id, folder, message_id, from_address, to_address, subject, text_preview,
        received_at, raw_r2_key, html_r2_key, created_at, updated_at, deleted_at)
     VALUES (?1, ?2, ?3, NULL, ?4, '[]', ?5, ?6, ?7, ?8, ?9, ?7, ?7, ?10)`
  )
    .bind(
      opts.ownerUserId ?? 1,
      opts.addressId,
      opts.folder ?? "inbox",
      opts.from ?? "sender@example.com",
      opts.subject ?? "s",
      opts.preview ?? "p",
      ts,
      opts.rawKey,
      opts.htmlKey ?? null,
      opts.deletedAt ?? null
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

const CREATE = (localPart: string) => ({
  method: "POST",
  body: JSON.stringify({ local_part: localPart }),
});

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

// ══════════════════════ T25：mode=soft（預設）保留信件與 R2 ＋ 寫稽核 ══════════════════════
describe("T25：mode=soft（預設）只標記 deleted，信件與 R2 保留，並寫稽核 address_deleted(mode=soft)", () => {
  it("未帶 mode ＝ soft：204、列仍在且標記 deleted、信件／附件／R2 全部保留、稽核欄位完整", async () => {
    const addr = await seedOwnerAddress("soft25");
    const m1 = await seedMessage({
      addressId: addr,
      rawKey: "mail/2026/10/soft25-a.eml",
      htmlKey: "mail/2026/10/soft25-a.html",
    });
    const m2 = await seedMessage({ addressId: addr, folder: "trash", rawKey: "mail/2026/10/soft25-b.eml" });
    await seedAttachment(m1, "attachments/soft25/0-a.pdf");

    const startedAt = Date.now();
    const token = await ownerToken();
    const res = await req(`/api/email-addresses/${addr}`, { method: "DELETE" }, token);

    // 既有行為相容：soft 仍回 204（無 body）
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");

    // 列仍在，只是標記為已刪除（soft 的本質：不釋放名稱、資料都留著）
    const row = await addressRow(addr);
    expect(row?.status).toBe("deleted");
    expect(row?.deleted_at).toBeGreaterThanOrEqual(startedAt);

    // 信件與 R2 一律保留（soft 與 hard 的關鍵差別）
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE address_id = ?1", addr)).toBe(2);
    expect(await count("SELECT COUNT(*) AS n FROM attachments WHERE r2_key = ?1", "attachments/soft25/0-a.pdf")).toBe(1);
    expect(await E.MAIL.get("mail/2026/10/soft25-a.eml")).not.toBeNull();
    expect(await E.MAIL.get("mail/2026/10/soft25-a.html")).not.toBeNull();
    expect(await E.MAIL.get("mail/2026/10/soft25-b.eml")).not.toBeNull();
    expect(await E.MAIL.get("attachments/soft25/0-a.pdf")).not.toBeNull();
    expect(m2).toBeGreaterThan(0);

    // 軟刪除後不再出現在地址清單
    const list = await json<{ addresses: Array<{ id: number }> }>(await req("/api/email-addresses", {}, token));
    expect(list.addresses.map((a) => a.id)).not.toContain(addr);

    // 稽核 address_deleted（D11-1：操作 owner id、address id／email、mode、被刪信件數、時間）
    const audit = await lastAudit("address_deleted");
    expect(audit).not.toBeNull();
    expect(audit!.user_id).toBe(1);
    expect(audit!.address_id).toBe(addr);
    expect(audit!.created_at).toBeGreaterThanOrEqual(startedAt);
    expect(JSON.parse(audit!.detail!)).toEqual({
      by: 1,
      address: "soft25@atwho.org",
      mode: "soft",
      messages: 0, // soft 不刪任何信件
      messages_retained: 2, // 仍留在此地址下的信件數
    });
  });

  it("明確帶 mode=soft 與未帶 mode 的行為完全相同（預設值相容）", async () => {
    const a1 = await seedOwnerAddress("soft25b");
    const a2 = await seedOwnerAddress("soft25c");
    await seedMessage({ addressId: a1, rawKey: "mail/2026/10/soft25b.eml" });
    await seedMessage({ addressId: a2, rawKey: "mail/2026/10/soft25c.eml" });

    const token = await ownerToken();
    expect((await req(`/api/email-addresses/${a1}`, { method: "DELETE" }, token)).status).toBe(204);
    expect((await req(`/api/email-addresses/${a2}?mode=soft`, { method: "DELETE" }, token)).status).toBe(204);

    for (const id of [a1, a2]) {
      expect((await addressRow(id))?.status).toBe("deleted");
      expect(await count("SELECT COUNT(*) AS n FROM messages WHERE address_id = ?1", id)).toBe(1);
    }
  });

  it("soft 之後名稱**未釋放**：重建同名 → 409 ADDRESS_EXISTS（不是 500）", async () => {
    const addr = await seedOwnerAddress("soft25d");
    const token = await ownerToken();
    expect((await req(`/api/email-addresses/${addr}`, { method: "DELETE" }, token)).status).toBe(204);

    // email 與 (local_part, domain) 都是 UNIQUE 且不含 deleted_at → 列還在就重建不了
    const again = await req("/api/email-addresses", CREATE("soft25d"), token);
    expect(again.status).toBe(409);
    expect(await codeOf(again)).toBe("ADDRESS_EXISTS");
  });

  it("（修正依據）舊版檢查確實會放行、再由 UNIQUE 丟例外 —— 這就是先前回 500 的原因", async () => {
    const addr = await seedOwnerAddress("soft25e");
    await E.DB.prepare("UPDATE email_addresses SET status = 'deleted', deleted_at = ?1 WHERE id = ?2")
      .bind(Date.now(), addr)
      .run();

    // 舊版檢查（只看 `deleted_at IS NULL`）→ 查不到 → 放行（名稱未釋放的盲點）
    const oldCheck = await E.DB.prepare("SELECT id FROM email_addresses WHERE email = ?1 AND deleted_at IS NULL")
      .bind("soft25e@atwho.org")
      .first();
    expect(oldCheck).toBeNull();

    // 放行後的 INSERT 會撞 UNIQUE(email) 丟例外；舊版沒有 try/catch → 500（現在改為先擋下回 409）
    await expect(seedOwnerAddress("soft25e")).rejects.toThrow();
  });
});

// ══════════════════════ T26：mode=hard 完整清除 ＋ 寫稽核 ══════════════════════
describe("T26：mode=hard 清除該地址所有信件／附件／R2 物件，並寫稽核 address_deleted(mode=hard)", () => {
  it("所有資料夾（含垃圾桶）的信件、附件、R2 物件全清除；其他地址毫髮無傷；稽核欄位完整", async () => {
    const target = await seedOwnerAddress("hard26");
    const other = await seedOwnerAddress("keep26");

    // 目標地址：5 個資料夾各 1 封（含垃圾桶）＋ 1 個附件
    const folders = ["inbox", "sent", "archive", "trash", "spam"];
    const targetIds: number[] = [];
    for (const f of folders) {
      targetIds.push(
        await seedMessage({
          addressId: target,
          folder: f,
          rawKey: `mail/2026/10/hard26-${f}.eml`,
          htmlKey: f === "inbox" ? "mail/2026/10/hard26-inbox.html" : undefined,
        })
      );
    }
    await seedAttachment(targetIds[0]!, "attachments/hard26/0-a.pdf");

    // 另一個地址（同一位 owner）：不得被誤刪
    const otherMsg = await seedMessage({
      addressId: other,
      rawKey: "mail/2026/10/keep26.eml",
      htmlKey: "mail/2026/10/keep26.html",
    });
    await seedAttachment(otherMsg, "attachments/keep26/0-a.pdf");

    const startedAt = Date.now();
    const token = await ownerToken();
    const res = await req(`/api/email-addresses/${target}?mode=hard`, { method: "DELETE" }, token);
    expect(res.status).toBe(200);
    const body = await json<{
      ok: boolean;
      id: number;
      email: string;
      mode: string;
      deleted: { messages: number; attachments: number; aliases: number; r2_objects: number };
    }>(res);
    expect(body.ok).toBe(true);
    expect(body.id).toBe(target);
    expect(body.email).toBe("hard26@atwho.org");
    expect(body.mode).toBe("hard");
    expect(body.deleted.messages).toBe(5); // 含垃圾桶
    expect(body.deleted.attachments).toBe(1);

    // 該列**真的被移除**（名稱釋放的前提）
    expect(await count("SELECT COUNT(*) AS n FROM email_addresses WHERE id = ?1", target)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE address_id = ?1", target)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM attachments WHERE r2_key = ?1", "attachments/hard26/0-a.pdf")).toBe(0);
    for (const f of folders) {
      expect(await E.MAIL.get(`mail/2026/10/hard26-${f}.eml`)).toBeNull();
    }
    expect(await E.MAIL.get("mail/2026/10/hard26-inbox.html")).toBeNull();
    expect(await E.MAIL.get("attachments/hard26/0-a.pdf")).toBeNull();

    // 其他人的資料完好（精準刪除，不是清空整張表）
    expect(await count("SELECT COUNT(*) AS n FROM email_addresses WHERE id = ?1", other)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE address_id = ?1", other)).toBe(1);
    expect(await E.MAIL.get("mail/2026/10/keep26.eml")).not.toBeNull();
    expect(await E.MAIL.get("mail/2026/10/keep26.html")).not.toBeNull();
    expect(await E.MAIL.get("attachments/keep26/0-a.pdf")).not.toBeNull();

    // 稽核 address_deleted（mode=hard）
    const audit = await lastAudit("address_deleted");
    expect(audit).not.toBeNull();
    expect(audit!.user_id).toBe(1);
    expect(audit!.address_id).toBe(target);
    expect(audit!.created_at).toBeGreaterThanOrEqual(startedAt);
    expect(JSON.parse(audit!.detail!)).toEqual({
      by: 1,
      address: "hard26@atwho.org",
      mode: "hard",
      messages: 5,
      attachments: 1,
      aliases: 0,
      r2_objects: 7, // 5 raw + 1 html（僅 inbox 有）+ 1 附件
      messages_retained: 0,
    });
  });

  it("附帶清除：指向該地址的別名與該地址的登入失敗計數（不留孤兒、名稱可安心重建）", async () => {
    const target = await seedOwnerAddress("hard26b");
    await seedAlias("alias26b@atwho.org", target);
    await seedAttempts("mailbox:hard26b@atwho.org");

    const token = await ownerToken();
    const res = await req(`/api/email-addresses/${target}?mode=hard`, { method: "DELETE" }, token);
    expect(res.status).toBe(200);
    expect((await json<{ deleted: { aliases: number } }>(res)).deleted.aliases).toBe(1);

    expect(await count("SELECT COUNT(*) AS n FROM email_aliases WHERE alias_address = ?1", "alias26b@atwho.org")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM auth_attempts WHERE key = ?1", "mailbox:hard26b@atwho.org")).toBe(0);
  });

  it("沒有信件的地址也能 hard 刪除（回 0，不是錯誤）", async () => {
    const empty = await seedOwnerAddress("hard26c");
    const token = await ownerToken();
    const res = await req(`/api/email-addresses/${empty}?mode=hard`, { method: "DELETE" }, token);
    expect(res.status).toBe(200);
    expect((await json<{ deleted: { messages: number } }>(res)).deleted.messages).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM email_addresses WHERE id = ?1", empty)).toBe(0);
  });
});

// ══════════════════════ T27：hard 之後可重建同名地址 ══════════════════════
describe("T27：mode=hard 之後，同一個 email 可以重新建立（名稱已釋放）", () => {
  it("hard → POST 同名 → 201，且新地址是全新可用的列（舊信件不復存在）", async () => {
    const first = await seedOwnerAddress("reuse27");
    await seedMessage({ addressId: first, rawKey: "mail/2026/10/reuse27.eml" });

    const token = await ownerToken();
    expect((await req(`/api/email-addresses/${first}?mode=hard`, { method: "DELETE" }, token)).status).toBe(200);

    const again = await req("/api/email-addresses", CREATE("reuse27"), token);
    expect(again.status).toBe(201);
    const created = await json<{ id: number; email: string; status: string }>(again);
    expect(created.email).toBe("reuse27@atwho.org");
    expect(created.status).toBe("active");
    expect(created.id).not.toBe(first);

    // 新地址是乾淨的：沒有舊信件、也不在 R2 留下舊物件
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE address_id = ?1", created.id)).toBe(0);
    expect(await E.MAIL.get("mail/2026/10/reuse27.eml")).toBeNull();

    // 新地址出現在清單且信件數為 0
    const list = await json<{ addresses: Array<{ id: number; messages: number }> }>(
      await req("/api/email-addresses", {}, token)
    );
    const row = list.addresses.find((a) => a.id === created.id);
    expect(row?.messages).toBe(0);
  });
});

// ══════════════════════ T28：權限（他人／訪客地址、訪客 JWT、參數邊界） ══════════════════════
describe("T28：不可刪他人地址（404）／訪客地址（404）／訪客 JWT（403）", () => {
  it("他人（另一個 owner 帳號）名下的地址 → 404，且資料原封不動", async () => {
    const ts = Date.now();
    const otherOwner = await E.DB.prepare(
      `INSERT INTO users (username, display_name, password_hash, status, role, created_at, updated_at)
       VALUES ('owner2', NULL, ?1, 'active', 'owner', ?2, ?2)`
    )
      .bind(await cachedHash(OWNER_PW), ts)
      .run();
    const otherOwnerId = Number(otherOwner.meta.last_row_id);
    const foreign = await seedOwnerAddress("foreign28", otherOwnerId);
    await seedMessage({ addressId: foreign, ownerUserId: otherOwnerId, rawKey: "mail/2026/10/foreign28.eml" });

    const token = await ownerToken();
    for (const path of [`/api/email-addresses/${foreign}`, `/api/email-addresses/${foreign}?mode=hard`]) {
      const res = await req(path, { method: "DELETE" }, token);
      expect(res.status, path).toBe(404);
      expect(await codeOf(res)).toBe("NOT_FOUND");
    }
    expect((await addressRow(foreign))?.status).toBe("active");
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE address_id = ?1", foreign)).toBe(1);
  });

  it("訪客地址 → 404（那是訪客管理 D9 的職責），且訪客資料完好", async () => {
    const visitor = await seedVisitor("guest28@atwho.org");
    await seedMessage({
      addressId: visitor.addressId,
      ownerUserId: visitor.userId,
      rawKey: "mail/2026/10/guest28.eml",
    });

    const token = await ownerToken();
    expect((await req(`/api/email-addresses/${visitor.addressId}`, { method: "DELETE" }, token)).status).toBe(404);
    expect((await req(`/api/email-addresses/${visitor.addressId}?mode=hard`, { method: "DELETE" }, token)).status).toBe(404);

    expect((await addressRow(visitor.addressId))?.status).toBe("active");
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE address_id = ?1", visitor.addressId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM users WHERE id = ?1", visitor.userId)).toBe(1);
  });

  it("訪客 JWT 呼叫 → 403；無 session → 401", async () => {
    const addr = await seedOwnerAddress("auth28");
    const visitor = await seedVisitor("guest28b@atwho.org");
    const visitorToken = await mailboxLogin("guest28b@atwho.org");
    expect(visitorToken).not.toBe("");

    // 訪客連自己的地址都不能用這個端點刪（端點為 owner 專用）
    for (const id of [addr, visitor.addressId]) {
      const res = await req(`/api/email-addresses/${id}`, { method: "DELETE" }, visitorToken);
      expect(res.status).toBe(403);
      expect(await codeOf(res)).toBe("FORBIDDEN");
    }
    expect((await req(`/api/email-addresses/${addr}`, { method: "DELETE" })).status).toBe(401);
    expect((await addressRow(addr))?.status).toBe("active");
    expect((await addressRow(visitor.addressId))?.status).toBe("active");
  });

  it("參數邊界：mode 非法 → 400 INVALID_MODE；id 非法 → 400 INVALID_ID；不存在 → 404", async () => {
    const addr = await seedOwnerAddress("param28");
    const token = await ownerToken();

    for (const mode of ["HARD", "hard2", "delete", "1"]) {
      const res = await req(`/api/email-addresses/${addr}?mode=${mode}`, { method: "DELETE" }, token);
      expect(res.status, mode).toBe(400);
      expect(await codeOf(res)).toBe("INVALID_MODE");
    }
    // 參數被拒時不得動到資料
    expect((await addressRow(addr))?.status).toBe("active");

    expect((await req("/api/email-addresses/abc", { method: "DELETE" }, token)).status).toBe(400);
    expect((await req("/api/email-addresses/0", { method: "DELETE" }, token)).status).toBe(400);
    expect((await req("/api/email-addresses/999999", { method: "DELETE" }, token)).status).toBe(404);
    expect((await req("/api/email-addresses/999999?mode=hard", { method: "DELETE" }, token)).status).toBe(404);

    // 對「已 soft 刪除的列」再 soft → 404（不重複標記，也不得 500；D11-5／T32 有完整案例）
    expect((await req(`/api/email-addresses/${addr}`, { method: "DELETE" }, token)).status).toBe(204);
    expect((await req(`/api/email-addresses/${addr}?mode=soft`, { method: "DELETE" }, token)).status).toBe(404);

    // ⚠️ D11-5 行為變更：已 soft 刪除的列現在可以**升級**為永久刪除（先前一律 404 → 殘留清不掉）
    const upgraded = await req(`/api/email-addresses/${addr}?mode=hard`, { method: "DELETE" }, token);
    expect(upgraded.status).toBe(200);
    expect((await json<{ previously_deleted: boolean }>(upgraded)).previously_deleted).toBe(true);
    expect(await count("SELECT COUNT(*) AS n FROM email_addresses WHERE id = ?1", addr)).toBe(0);
  });

  it("N5：rescue（x-admin-token）等同 owner，可刪除 owner 名下地址", async () => {
    const addr = await seedOwnerAddress("rescue28");
    const res = await req(`/api/email-addresses/${addr}?mode=hard`, { method: "DELETE" }, undefined, {
      "x-admin-token": ADMIN,
    });
    expect(res.status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM email_addresses WHERE id = ?1", addr)).toBe(0);
  });
});

// ══════════════════════ T29：稽核不含任何信件內容 ══════════════════════
describe("T29：稽核事件不得含任何信件內容（主旨／寄件者／內文）", () => {
  const SUBJECT_CANARY = "主旨機密CANARY-SUBJECT";
  const FROM_CANARY = "canary-sender@example.com";
  const BODY_CANARY = "內文機密CANARY-BODY";

  it("soft／hard 兩種模式的 address_deleted 都只有數量與識別欄位，不含主旨／寄件者／內文", async () => {
    // 地址名稱刻意不含 CANARY 字樣，讓最後的全表掃描能真正證明「稽核表沒有任何信件內容」
    const a1 = await seedOwnerAddress("t29soft");
    await seedMessage({
      addressId: a1,
      rawKey: "mail/2026/10/t29soft.eml",
      subject: SUBJECT_CANARY,
      from: FROM_CANARY,
      preview: BODY_CANARY,
    });
    const a2 = await seedOwnerAddress("t29hard");
    await seedMessage({
      addressId: a2,
      rawKey: "mail/2026/10/t29hard.eml",
      subject: SUBJECT_CANARY,
      from: FROM_CANARY,
      preview: BODY_CANARY,
    });

    const token = await ownerToken();
    expect((await req(`/api/email-addresses/${a1}`, { method: "DELETE" }, token)).status).toBe(204);
    expect((await req(`/api/email-addresses/${a2}?mode=hard`, { method: "DELETE" }, token)).status).toBe(200);

    const { results } = await E.DB.prepare(
      "SELECT event, detail FROM registration_audit WHERE event = 'address_deleted' ORDER BY id"
    ).all<{ event: string; detail: string | null }>();
    expect(results.length).toBe(2);
    for (const row of results) {
      const detail = row.detail ?? "";
      expect(detail).not.toContain(SUBJECT_CANARY);
      expect(detail).not.toContain(FROM_CANARY);
      expect(detail).not.toContain(BODY_CANARY);
      // 只允許這些欄位（出現其他欄位即代表有人把信件內容寫進稽核）
      const keys = Object.keys(JSON.parse(detail) as Record<string, unknown>);
      expect(keys).toEqual(expect.arrayContaining(["address", "by", "mode", "messages"]));
      for (const k of keys) {
        expect(["address", "aliases", "attachments", "by", "messages", "messages_retained", "mode", "r2_objects"]).toContain(k);
      }
    }
    // 稽核表其他列也不得被寫入信件內容（整體掃一次）
    expect(await count("SELECT COUNT(*) AS n FROM registration_audit WHERE detail LIKE '%CANARY%'")).toBe(0);
  });
});

// ══════════════════════ D11-3 後端支援：地址清單的 messages 計數 ══════════════════════
describe("D11-3：地址清單回傳該地址的信件數（供刪除對話框顯示）", () => {
  it("messages 為該地址全部信件數（含所有資料夾與垃圾桶）", async () => {
    const a1 = await seedOwnerAddress("count31a");
    const a2 = await seedOwnerAddress("count31b");
    await seedMessage({ addressId: a1, folder: "inbox", rawKey: "mail/2026/10/c31a1.eml" });
    await seedMessage({ addressId: a1, folder: "trash", rawKey: "mail/2026/10/c31a2.eml" });
    await seedMessage({ addressId: a1, folder: "spam", rawKey: "mail/2026/10/c31a3.eml" });
    await seedMessage({ addressId: a2, folder: "inbox", rawKey: "mail/2026/10/c31b1.eml" });
    // 已進垃圾桶又標記 deleted_at 的信也算（hard 會刪掉它）
    await seedMessage({ addressId: a1, folder: "trash", rawKey: "mail/2026/10/c31a4.eml", deletedAt: Date.now() });

    const token = await ownerToken();
    const list = await json<{ addresses: Array<{ id: number; email: string; messages: number }> }>(
      await req("/api/email-addresses", {}, token)
    );
    expect(list.addresses.find((a) => a.id === a1)?.messages).toBe(4);
    expect(list.addresses.find((a) => a.id === a2)?.messages).toBe(1);

    // 對話框顯示的數字 ＝ hard 實際刪除的數量（兩者必須一致，否則 UI 會說謊）
    const res = await req(`/api/email-addresses/${a1}?mode=hard`, { method: "DELETE" }, token);
    expect((await json<{ deleted: { messages: number } }>(res)).deleted.messages).toBe(4);
  });
});
