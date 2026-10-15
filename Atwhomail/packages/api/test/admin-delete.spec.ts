/**
 * admin-delete.spec.ts — docs/16 D9（刪除訪客）＋ D10（查不到列的 session 失效）
 *
 * 對應 docs/16 §6：**T20–T24**，外加邊界案例：
 * 精準刪除不誤傷他人（不得 LIKE）、owner 帳號保護（含 role 被誤設的縱深防禦）、
 * rescue 不受影響（N5）、刪除後不能再登入、軟刪除地址一併清除、R2 物件一併清除。
 *
 * 在 workerd 內以真實 D1／R2 執行，刪除一律走**真實端點**（`DELETE /api/users/:id`），
 * 確保測到的是實際上線路徑而非直接改 DB。
 *
 * ⚠️ 測試環境未設定 `ACCESS_MAIL_AUD` → `/api/auth/login` 走 D2 的過渡放行（與其他測試檔一致）。
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { hashPassword, signOwnerToken, type Env } from "../src/auth";

const E = env as unknown as Env;
const OWNER_USER = "owner";
const OWNER_PW = "owner-password-d9";
const VISITOR_PW = "visitor-password-d9";
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
    body: JSON.stringify({ username: OWNER_USER, password: OWNER_PW }),
  });
  return ((await json<{ token?: string }>(res)).token ?? "") as string;
}

async function mailboxLogin(email: string, password = VISITOR_PW): Promise<string> {
  const res = await req("/api/auth/mailbox-login", { method: "POST", body: JSON.stringify({ email, password }) });
  if (res.status !== 200) return "";
  return ((await json<{ token?: string }>(res)).token ?? "") as string;
}

/** 種一個訪客（跳過 argon2 註冊流程以維持測試速度） */
async function seedVisitor(opts: {
  email: string;
  userStatus?: string;
  addressStatus?: string;
}): Promise<{ userId: number; addressId: number }> {
  const ts = Date.now();
  const userRes = await E.DB.prepare(
    `INSERT INTO users (username, display_name, password_hash, status, role, created_at, updated_at)
     VALUES (?1, NULL, ?2, ?3, 'visitor', ?4, ?4)`
  )
    .bind(`u-${opts.email}`, await cachedHash(VISITOR_PW), opts.userStatus ?? "active", ts)
    .run();
  const userId = Number(userRes.meta.last_row_id);
  const addrRes = await E.DB.prepare(
    `INSERT INTO email_addresses
       (user_id, local_part, domain, email, password_hash, password_changed_at, status,
        can_send, daily_send_quota, sent_today, quota_reset_at, created_at, updated_at)
     VALUES (?1, ?2, 'atwho.org', ?3, ?4, ?5, ?6, 1, 20, 0, ?7, ?5, ?5)`
  )
    .bind(
      userId,
      opts.email.split("@")[0]!,
      opts.email,
      await cachedHash(VISITOR_PW),
      ts,
      opts.addressStatus ?? "active",
      Date.now() + 3600_000
    )
    .run();
  return { userId, addressId: Number(addrRes.meta.last_row_id) };
}

/** 種一封信（同時在 R2 放好 raw／html 物件，供刪除後驗證物件已清除） */
async function seedMessage(opts: {
  ownerUserId: number;
  addressId: number;
  rawKey: string;
  htmlKey?: string;
}): Promise<number> {
  const ts = Date.now();
  await E.MAIL.put(opts.rawKey, new TextEncoder().encode("raw-message"));
  if (opts.htmlKey) await E.MAIL.put(opts.htmlKey, new TextEncoder().encode("<p>hi</p>"));
  const res = await E.DB.prepare(
    `INSERT INTO messages
       (owner_user_id, address_id, folder, message_id, from_address, to_address, subject, text_preview,
        received_at, raw_r2_key, html_r2_key, created_at, updated_at)
     VALUES (?1, ?2, 'inbox', NULL, 'sender@example.com', '[]', 's', 'p', ?3, ?4, ?5, ?3, ?3)`
  )
    .bind(opts.ownerUserId, opts.addressId, ts, opts.rawKey, opts.htmlKey ?? null)
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

/** 登入失敗計數（auth_attempts；key = `mailbox:<email>`） */
async function seedAttempts(key: string, fails: number): Promise<void> {
  await E.DB.prepare(
    `INSERT INTO auth_attempts (key, fail_count, locked_until, updated_at) VALUES (?1, ?2, 0, ?3)
     ON CONFLICT(key) DO UPDATE SET fail_count = ?2, updated_at = ?3`
  )
    .bind(key, fails, Date.now())
    .run();
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await E.DB.prepare(sql)
    .bind(...binds)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function lastAudit(event: string): Promise<{ detail: string | null; user_id: number | null; created_at: number } | null> {
  return E.DB.prepare(
    "SELECT detail, user_id, created_at FROM registration_audit WHERE event = ?1 ORDER BY id DESC LIMIT 1"
  )
    .bind(event)
    .first<{ detail: string | null; user_id: number | null; created_at: number }>();
}

const SEND = (from: string) => ({
  method: "POST",
  body: JSON.stringify({ from, to: ["dest@example.com"], subject: "s", text: "t" }),
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
     VALUES (1, ?1, 'Owner', ?2, 'active', 'owner', ?3, ?3)`
  )
    .bind(OWNER_USER, await cachedHash(OWNER_PW), ts)
    .run();
});

// ══════════════════════ T20：刪除訪客 → 完整清除，稽核保留 ══════════════════════
describe("T20：DELETE /api/users/:id 對訪客 → 完整清除並保留稽核", () => {
  it("user／address／messages／attachments／aliases／auth_attempts 全清除，registration_audit 保留並新增 user_deleted", async () => {
    const victim = await seedVisitor({ email: "gone20@atwho.org" });
    const other = await seedVisitor({ email: "keep20@atwho.org" });

    // 目標訪客的資料：2 封信（1 封含 HTML）、1 個附件、1 個別名、3 次登入失敗
    const m1 = await seedMessage({
      ownerUserId: victim.userId,
      addressId: victim.addressId,
      rawKey: "mail/2026/10/gone20-a.eml",
      htmlKey: "mail/2026/10/gone20-a.html",
    });
    await seedMessage({ ownerUserId: victim.userId, addressId: victim.addressId, rawKey: "mail/2026/10/gone20-b.eml" });
    await seedAttachment(m1, "attachments/gone20/0-a.pdf");
    await seedAlias("alias20@atwho.org", victim.addressId);
    await seedAttempts("mailbox:gone20@atwho.org", 3);

    // 另一位訪客的資料（精準刪除不得誤傷）
    const otherMsg = await seedMessage({
      ownerUserId: other.userId,
      addressId: other.addressId,
      rawKey: "mail/2026/10/keep20-a.eml",
    });
    await seedAttachment(otherMsg, "attachments/keep20/0-a.pdf");
    await seedAlias("alias20b@atwho.org", other.addressId);
    await seedAttempts("mailbox:keep20@atwho.org", 2);

    // 既有稽核（不可竄改；刪除後必須一字不動）
    await E.DB.prepare(
      `INSERT INTO registration_audit (event, user_id, address_id, detail, created_at)
       VALUES ('register_ok', ?1, ?2, '{"invite":"masked"}', ?3)`
    )
      .bind(victim.userId, victim.addressId, Date.now() - 1000)
      .run();

    const startedAt = Date.now();
    const owner = await ownerToken();
    const res = await req(`/api/users/${victim.userId}`, { method: "DELETE" }, owner);
    expect(res.status).toBe(200);
    const body = await json<{
      ok: boolean;
      id: number;
      username: string;
      deleted: { addresses: number; messages: number; attachments: number; aliases: number };
    }>(res);
    expect(body.ok).toBe(true);
    expect(body.id).toBe(victim.userId);
    expect(body.username).toBe("u-gone20@atwho.org");
    expect(body.deleted).toEqual({ addresses: 1, messages: 2, attachments: 1, aliases: 1 });

    // 全部清除（以精準 id 查；不是看 LIKE）
    expect(await count("SELECT COUNT(*) AS n FROM users WHERE id = ?1", victim.userId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM email_addresses WHERE user_id = ?1", victim.userId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE owner_user_id = ?1", victim.userId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE address_id = ?1", victim.addressId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM attachments WHERE r2_key = ?1", "attachments/gone20/0-a.pdf")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM email_aliases WHERE alias_address = ?1", "alias20@atwho.org")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM auth_attempts WHERE key = ?1", "mailbox:gone20@atwho.org")).toBe(0);

    // 他人資料完好（精準刪除；沒有 LIKE 誤傷）
    expect(await count("SELECT COUNT(*) AS n FROM users WHERE id = ?1", other.userId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM email_addresses WHERE id = ?1", other.addressId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE owner_user_id = ?1", other.userId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM attachments WHERE r2_key = ?1", "attachments/keep20/0-a.pdf")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM email_aliases WHERE alias_address = ?1", "alias20b@atwho.org")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM auth_attempts WHERE key = ?1", "mailbox:keep20@atwho.org")).toBe(1);

    // R2：目標訪客的信件與附件物件已刪除；他人的仍存在
    expect(await E.MAIL.get("mail/2026/10/gone20-a.eml")).toBeNull();
    expect(await E.MAIL.get("mail/2026/10/gone20-a.html")).toBeNull();
    expect(await E.MAIL.get("mail/2026/10/gone20-b.eml")).toBeNull();
    expect(await E.MAIL.get("attachments/gone20/0-a.pdf")).toBeNull();
    expect(await E.MAIL.get("mail/2026/10/keep20-a.eml")).not.toBeNull();
    expect(await E.MAIL.get("attachments/keep20/0-a.pdf")).not.toBeNull();

    // registration_audit：既有列原封不動（不可竄改）
    expect(await count("SELECT COUNT(*) AS n FROM registration_audit WHERE event = 'register_ok' AND user_id = ?1", victim.userId)).toBe(1);

    // 新增管理稽核 user_deleted（owner id／username／address／信件數／時間）
    const audit = await lastAudit("user_deleted");
    expect(audit).not.toBeNull();
    expect(audit!.user_id).toBe(victim.userId);
    expect(audit!.created_at).toBeGreaterThanOrEqual(startedAt);
    expect(JSON.parse(audit!.detail!)).toMatchObject({
      by: 1, // 操作者＝owner（users.id = 1）
      username: "u-gone20@atwho.org",
      address: "gone20@atwho.org",
      addresses: 1,
      messages: 2,
      attachments: 1,
      aliases: 1,
    });

    // 刪除後不能再登入（地址已不存在 → 與帳密錯誤不可區分）
    const relogin = await req("/api/auth/mailbox-login", {
      method: "POST",
      body: JSON.stringify({ email: "gone20@atwho.org", password: VISITOR_PW }),
    });
    expect(relogin.status).toBe(401);
    expect(await codeOf(relogin)).toBe("INVALID_CREDENTIALS");
  });

  it("沒有地址的訪客也能刪除；軟刪除的地址一併硬刪除（不留 FK 孤兒）", async () => {
    const noAddr = await E.DB.prepare(
      `INSERT INTO users (username, display_name, password_hash, status, role, created_at, updated_at)
       VALUES ('u-noaddr20@atwho.org', NULL, ?1, 'active', 'visitor', ?2, ?2)`
    )
      .bind(await cachedHash(VISITOR_PW), Date.now())
      .run();
    const noAddrId = Number(noAddr.meta.last_row_id);

    const soft = await seedVisitor({ email: "soft20@atwho.org" });
    await E.DB.prepare("UPDATE email_addresses SET status = 'deleted', deleted_at = ?1 WHERE id = ?2")
      .bind(Date.now(), soft.addressId)
      .run();

    const owner = await ownerToken();
    const first = await req(`/api/users/${noAddrId}`, { method: "DELETE" }, owner);
    expect(first.status).toBe(200);
    expect((await json<{ deleted: { addresses: number } }>(first)).deleted.addresses).toBe(0);

    const second = await req(`/api/users/${soft.userId}`, { method: "DELETE" }, owner);
    expect(second.status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM email_addresses WHERE user_id = ?1", soft.userId)).toBe(0);
    // 重複刪除 → 404（冪等語意：第二次找不到目標）
    expect((await req(`/api/users/${soft.userId}`, { method: "DELETE" }, owner)).status).toBe(404);
  });

  it("rescue（x-admin-token）等同 owner，可刪除訪客（N5）", async () => {
    const victim = await seedVisitor({ email: "gone20c@atwho.org" });
    const res = await req(`/api/users/${victim.userId}`, { method: "DELETE" }, undefined, {
      "x-admin-token": ADMIN,
    });
    expect(res.status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM users WHERE id = ?1", victim.userId)).toBe(0);
  });
});

// ══════════════════════ T21：不得刪除 owner 帳號 ══════════════════════
describe("T21：DELETE /api/users/:id 對 owner → 403 FORBIDDEN（保護管理帳號）", () => {
  it("owner 帳號（role='owner'）不可刪除，資料原封不動", async () => {
    const owner = await ownerToken();
    const res = await req("/api/users/1", { method: "DELETE" }, owner);
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe("FORBIDDEN");
    expect(await count("SELECT COUNT(*) AS n FROM users WHERE id = 1")).toBe(1);
  });

  it("rescue token 也不能刪除 owner 帳號（N5 語意不變）", async () => {
    const res = await req("/api/users/1", { method: "DELETE" }, undefined, { "x-admin-token": ADMIN });
    expect(res.status).toBe(403);
    expect(await count("SELECT COUNT(*) AS n FROM users WHERE id = 1")).toBe(1);
  });

  it("縱深防禦：role 被誤設為 visitor 的 owner 帳號仍不可刪（以 findOwnerId 判定）", async () => {
    const owner = await ownerToken(); // 先取 token（login 需 role='owner'）
    await E.DB.prepare("UPDATE users SET role = 'visitor' WHERE id = 1").run();
    const res = await req("/api/users/1", { method: "DELETE" }, owner);
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe("FORBIDDEN");
    expect(await count("SELECT COUNT(*) AS n FROM users WHERE id = 1")).toBe(1);
  });
});

// ══════════════════════ T22：非 owner 一律不得刪除 ══════════════════════
describe("T22：訪客 JWT 呼叫 DELETE /api/users/:id → 403", () => {
  it("訪客（連自己的帳號）都不能刪；無 session → 401；目標資料完好", async () => {
    const victim = await seedVisitor({ email: "gone22@atwho.org" });
    const attacker = await seedVisitor({ email: "attacker22@atwho.org" });
    const token = await mailboxLogin("attacker22@atwho.org");
    expect(token).not.toBe("");

    const onVictim = await req(`/api/users/${victim.userId}`, { method: "DELETE" }, token);
    expect(onVictim.status).toBe(403);
    expect(await codeOf(onVictim)).toBe("FORBIDDEN");

    // 自己的帳號也不行（端點為 owner 專用，不是「本人可刪」）
    expect((await req(`/api/users/${attacker.userId}`, { method: "DELETE" }, token)).status).toBe(403);

    // 無 session → 401
    expect((await req(`/api/users/${victim.userId}`, { method: "DELETE" })).status).toBe(401);

    expect(await count("SELECT COUNT(*) AS n FROM users WHERE id = ?1", victim.userId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM users WHERE id = ?1", attacker.userId)).toBe(1);
  });

  it("id 格式錯誤 → 400 INVALID_ID；不存在 → 404（不進入刪除）", async () => {
    const owner = await ownerToken();
    expect((await req("/api/users/abc", { method: "DELETE" }, owner)).status).toBe(400);
    expect((await req("/api/users/0", { method: "DELETE" }, owner)).status).toBe(400);
    expect((await req("/api/users/999999", { method: "DELETE" }, owner)).status).toBe(404);
  });
});

// ══════════════════════ T23：D10 —— 刪除後舊 JWT 立即失效 ══════════════════════
describe("T23：地址被刪除後，該地址的舊 mailbox JWT → 401 TOKEN_STALE（D10）", () => {
  it("刪除訪客後，同一支 token 的下一個請求即 401「session 已失效，請重新登入」", async () => {
    const victim = await seedVisitor({ email: "gone23@atwho.org" });
    const token = await mailboxLogin("gone23@atwho.org");
    expect(token).not.toBe("");
    // 刪除前正常（證明後面的 401 是刪除造成）
    expect((await req("/api/mail/inbox", {}, token)).status).toBe(200);

    const owner = await ownerToken();
    expect((await req(`/api/users/${victim.userId}`, { method: "DELETE" }, owner)).status).toBe(200);

    for (const path of ["/api/me", "/api/mail/inbox", "/api/mail/counts", "/api/auth/whoami"]) {
      const res = await req(path, {}, token);
      expect(res.status, `${path} 應立即 401`).toBe(401);
      const body = await json<ErrBody>(res);
      expect(body.error.code).toBe("TOKEN_STALE");
      expect(body.error.message).toBe("session 已失效，請重新登入");
    }
    // 寄信亦擋（不是只有讀信）
    const send = await req("/api/mail/send", SEND("gone23@atwho.org"), token);
    expect(send.status).toBe(401);
    expect(await codeOf(send)).toBe("TOKEN_STALE");
  });

  it("D10 亦涵蓋「地址被軟刪除」與「使用者被刪除」以外的查無列情境", async () => {
    // 直接把地址列刪掉（模擬資料被清除）→ 舊 token 必須失效
    const victim = await seedVisitor({ email: "gone23b@atwho.org" });
    const token = await mailboxLogin("gone23b@atwho.org");
    await E.DB.prepare("DELETE FROM email_addresses WHERE id = ?1").bind(victim.addressId).run();
    const res = await req("/api/me", {}, token);
    expect(res.status).toBe(401);
    expect(await codeOf(res)).toBe("TOKEN_STALE");
  });
});

// ══════════════════════ T24：D10 不得造成 500；rescue 仍可通過 ══════════════════════
describe("T24：查不到列的 owner session → 明確 401（不得 500）；rescue 不受影響", () => {
  it("owner JWT 指向不存在的使用者 → 401 TOKEN_STALE（不是 500、也不是放行）", async () => {
    const ghost = await signOwnerToken(E, 4242, 0); // 合法簽章、但 users 沒有這一列
    for (const path of ["/api/me", "/api/auth/whoami", "/api/users?role=visitor", "/api/invites"]) {
      const res = await req(path, {}, ghost);
      expect(res.status, `${path} 應為 401 而非 500`).toBe(401);
      const body = await json<ErrBody>(res);
      expect(body.error.code).toBe("TOKEN_STALE");
      expect(body.error.message).toBe("session 已失效，請重新登入");
    }
    // 真正的 owner JWT 不受影響
    expect((await req("/api/users?role=visitor", {}, await ownerToken())).status).toBe(200);
  });

  it("N5：rescue（x-admin-token）仍可通過（含 owner 端點）", async () => {
    const res = await req("/api/users?role=visitor", {}, undefined, { "x-admin-token": ADMIN });
    expect(res.status).toBe(200);
    expect((await req("/api/me", {}, undefined, { "x-admin-token": ADMIN })).status).toBe(200);
    expect((await req("/api/invites", {}, undefined, { "x-admin-token": ADMIN })).status).toBe(200);
  });

  it("D10 保留密碼版本檢查（TOKEN_STALE 的兩種原因可分辨）", async () => {
    const owner = await ownerToken();
    // 改密碼 → password_changed_at 前進 → 舊 token 版本落後
    expect(
      (
        await req(
          "/api/auth/owner-password/self",
          { method: "PATCH", body: JSON.stringify({ old_password: OWNER_PW, new_password: "owner-password-d9b" }) },
          owner
        )
      ).status
    ).toBe(200);

    const stale = await req("/api/users?role=visitor", {}, owner);
    expect(stale.status).toBe(401);
    const body = await json<ErrBody>(stale);
    expect(body.error.code).toBe("TOKEN_STALE");
    expect(body.error.message).toBe("session 已失效（密碼已變更），請重新登入");
  });
});
