/**
 * admin-status.spec.ts — docs/16 D8（停權／停用語意釐清與**立即生效**）
 *
 * 對應 docs/16 §6：**T17–T19**（外加 docs/16 §3 D8-4 的邊界與 N 系列合規案例：
 * TOKEN_STALE 保留、rescue 不受影響（N5）、`can_send` 語意不變、兩層狀態的判定順序、
 * owner 仍不得讀取訪客信件（N9））。
 *
 * 在 workerd 內以真實 D1 執行；owner 動作一律走**真實端點**（PATCH /api/users/:id/status、
 * PATCH /api/email-addresses/:id/status），確保測到的是實際上線路徑而非直接改 DB。
 *
 * ⚠️ 測試環境未設定 `ACCESS_MAIL_AUD` → `/api/auth/login` 走 D2 的過渡放行（與其他測試檔一致）。
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { hashPassword, type Env } from "../src/auth";

const E = env as unknown as Env;
const OWNER_USER = "owner";
const OWNER_PW = "owner-password-d8";
const VISITOR_PW = "visitor-password-d8";
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
  const res = await req("/api/auth/login", { method: "POST", body: JSON.stringify({ username: OWNER_USER, password: OWNER_PW }) });
  return ((await json<{ token?: string }>(res)).token ?? "") as string;
}

/** 訪客登入（回 JWT；失敗回空字串） */
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
  canSend?: number;
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
     VALUES (?1, ?2, 'atwho.org', ?3, ?4, ?5, ?6, ?7, 20, 0, ?8, ?5, ?5)`
  )
    .bind(
      userId,
      opts.email.split("@")[0]!,
      opts.email,
      await cachedHash(VISITOR_PW),
      ts,
      opts.addressStatus ?? "active",
      opts.canSend ?? 1,
      Date.now() + 3600_000
    )
    .run();
  return { userId, addressId: Number(addrRes.meta.last_row_id) };
}

/** owner 端點：停權／復權（`active`｜`suspended`） */
function setUserStatus(userId: number, status: "active" | "suspended", token: string): Promise<Response> {
  return req(`/api/users/${userId}/status`, { method: "PATCH", body: JSON.stringify({ status }) }, token);
}

/** owner 端點：停用／啟用地址（`active`｜`disabled`） */
function setAddressStatus(addressId: number, status: "active" | "disabled", token: string): Promise<Response> {
  return req(`/api/email-addresses/${addressId}/status`, { method: "PATCH", body: JSON.stringify({ status }) }, token);
}

/** 登入失敗的稽核（login_failed）細節 */
async function loginFailedReasons(): Promise<Array<{ reason: string | null; address_id: number | null }>> {
  const { results } = await E.DB.prepare(
    "SELECT detail, address_id FROM registration_audit WHERE event = 'login_failed' ORDER BY id"
  ).all<{ detail: string | null; address_id: number | null }>();
  return results.map((r) => ({
    reason: r.detail ? (JSON.parse(r.detail) as { reason?: string }).reason ?? null : null,
    address_id: r.address_id,
  }));
}

/** 失敗計數（auth_attempts；key 不含密碼） */
async function failCount(key: string): Promise<number> {
  const row = await E.DB.prepare("SELECT fail_count FROM auth_attempts WHERE key = ?1").bind(key).first<{ fail_count: number }>();
  return row?.fail_count ?? 0;
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

// ══════════════════════ T17：停權 → 既有 session 立即失效 ══════════════════════
describe("T17：使用者被停權後，既有 mailbox JWT 立即失效（不必等 token 過期）", () => {
  it("既有 token 對所有 requireSession 端點皆 403 ACCOUNT_SUSPENDED；復權後即恢復", async () => {
    const { userId } = await seedVisitor({ email: "susp17@atwho.org" });
    const token = await mailboxLogin("susp17@atwho.org");
    expect(token).not.toBe("");

    // 停權前：token 正常（證明後面的 403 是停權造成，而非 token 本來就壞）
    expect((await req("/api/me", {}, token)).status).toBe(200);
    expect((await req("/api/mail/inbox", {}, token)).status).toBe(200);

    const owner = await ownerToken();
    expect((await setUserStatus(userId, "suspended", owner)).status).toBe(200);

    // 同一個 token（效期還有 24 小時）→ 立刻被擋
    for (const path of ["/api/me", "/api/mail/inbox", "/api/mail/counts", "/api/auth/whoami"]) {
      const res = await req(path, {}, token);
      expect(res.status, `${path} 應立即 403`).toBe(403);
      expect(await codeOf(res)).toBe("ACCOUNT_SUSPENDED");
    }

    // 既有 token 寄信亦擋（不是只有讀信）
    expect(await codeOf(await req("/api/mail/send", SEND("susp17@atwho.org"), token))).toBe("ACCOUNT_SUSPENDED");

    // 復權 → **同一個** token 立即恢復（狀態是即時判定，不是一次性註銷）
    expect((await setUserStatus(userId, "active", owner)).status).toBe(200);
    expect((await req("/api/me", {}, token)).status).toBe(200);
    expect((await req("/api/mail/inbox", {}, token)).status).toBe(200);
  });

  it("停權只影響該帳號：owner 自己的 session 與 owner 端點不受影響", async () => {
    const { userId } = await seedVisitor({ email: "susp17b@atwho.org" });
    const owner = await ownerToken();
    await setUserStatus(userId, "suspended", owner);

    // owner 的 requireOwner 端點（D4／D5）行為不變 → 仍是 200
    expect((await req("/api/users?role=visitor", {}, owner)).status).toBe(200);
    expect((await req("/api/me", {}, owner)).status).toBe(200);
  });

  it("N5：rescue（x-admin-token）語意不變 —— 即使 owner 被停權仍可通過狀態檢查", async () => {
    // 直接把 owner 停權（極端情境：救援通道必須永遠可用，N5）
    await E.DB.prepare("UPDATE users SET status = 'disabled' WHERE id = 1").run();
    const res = await req("/api/me", {}, undefined, { "x-admin-token": ADMIN });
    expect(res.status).toBe(200);
    expect((await json<{ session: string }>(res)).session).toBe("owner");
  });
});

// ══════════════════════ T18：地址停用 → 既有 session 立即失效 ══════════════════════
describe("T18：地址被停用後，既有 mailbox JWT 立即失效", () => {
  it("既有 token 立即 403 ADDRESS_DISABLED；重新啟用後即恢復", async () => {
    const { addressId, userId } = await seedVisitor({ email: "off18@atwho.org" });
    const token = await mailboxLogin("off18@atwho.org");
    expect(token).not.toBe("");
    expect((await req("/api/mail/inbox", {}, token)).status).toBe(200);

    const owner = await ownerToken();
    expect((await setAddressStatus(addressId, "disabled", owner)).status).toBe(200);

    for (const path of ["/api/me", "/api/mail/inbox", "/api/mail/counts", "/api/auth/whoami"]) {
      const res = await req(path, {}, token);
      expect(res.status, `${path} 應立即 403`).toBe(403);
      expect(await codeOf(res)).toBe("ADDRESS_DISABLED");
    }

    // 帳號本身仍為 active（兩層語意分離：停用地址 ≠ 停權帳號）
    const u = await E.DB.prepare("SELECT status FROM users WHERE id = ?1").bind(userId).first<{ status: string }>();
    expect(u?.status).toBe("active");

    expect((await setAddressStatus(addressId, "active", owner)).status).toBe(200);
    expect((await req("/api/mail/inbox", {}, token)).status).toBe(200);
  });

  it("同一使用者的**其他**地址不受影響（停用只影響一個地址）", async () => {
    const { userId, addressId } = await seedVisitor({ email: "multi18@atwho.org" });
    // 第二個地址（同一使用者）
    const ts = Date.now();
    const second = await E.DB.prepare(
      `INSERT INTO email_addresses
         (user_id, local_part, domain, email, password_hash, password_changed_at, status,
          can_send, daily_send_quota, sent_today, quota_reset_at, created_at, updated_at)
       VALUES (?1, 'multi18b', 'atwho.org', 'multi18b@atwho.org', ?2, ?3, 'active', 1, 20, 0, ?4, ?3, ?3)`
    )
      .bind(userId, await cachedHash(VISITOR_PW), ts, ts + 3600_000)
      .run();
    expect(Number(second.meta.last_row_id)).toBeGreaterThan(0);

    const other = await mailboxLogin("multi18b@atwho.org");
    const owner = await ownerToken();
    await setAddressStatus(addressId, "disabled", owner);

    // 被停用的那個地址無法再登入；另一個地址的既有 session 照常
    const disabledLogin = await req("/api/auth/mailbox-login", {
      method: "POST",
      body: JSON.stringify({ email: "multi18@atwho.org", password: VISITOR_PW }),
    });
    expect(disabledLogin.status).toBe(403);
    expect(await codeOf(disabledLogin)).toBe("ADDRESS_DISABLED");
    expect((await req("/api/mail/inbox", {}, other)).status).toBe(200);
  });
});

// ══════════════════════ T19：mailbox-login 的錯誤碼矩陣 ══════════════════════
describe("T19：mailbox-login 先驗密碼再判狀態", () => {
  it("密碼錯誤 → 401 INVALID_CREDENTIALS（不洩漏帳號狀態）", async () => {
    await seedVisitor({ email: "m19@atwho.org" });
    const res = await req("/api/auth/mailbox-login", {
      method: "POST",
      body: JSON.stringify({ email: "m19@atwho.org", password: "wrong-password" }),
    });
    const body = await json<ErrBody>(res);
    expect(res.status).toBe(401);
    expect(body.error.code).toBe("INVALID_CREDENTIALS");
    expect(body.error.message).toBe("地址或密碼錯誤");
    // 失敗嘗試仍寫入既有 auth_attempts（帳號層＋IP 層共用同一把 key 的鎖定機制）
    expect(await failCount("mailbox:m19@atwho.org")).toBe(1);
    expect((await loginFailedReasons()).map((r) => r.reason)).toEqual(["INVALID_CREDENTIALS"]);
  });

  it("地址不存在 → 401 INVALID_CREDENTIALS（與密碼錯誤不可區分）", async () => {
    const res = await req("/api/auth/mailbox-login", {
      method: "POST",
      body: JSON.stringify({ email: "nobody@atwho.org", password: VISITOR_PW }),
    });
    expect(res.status).toBe(401);
    expect(await codeOf(res)).toBe("INVALID_CREDENTIALS");
  });

  it("密碼正確但地址停用 → 403 ADDRESS_DISABLED（舊版誤回 401 INVALID_CREDENTIALS）", async () => {
    const { addressId } = await seedVisitor({ email: "off19@atwho.org" });
    const owner = await ownerToken();
    await setAddressStatus(addressId, "disabled", owner);

    const res = await req("/api/auth/mailbox-login", {
      method: "POST",
      body: JSON.stringify({ email: "off19@atwho.org", password: VISITOR_PW }),
    });
    const body = await json<ErrBody>(res);
    expect(res.status).toBe(403);
    expect(body.error.code).toBe("ADDRESS_DISABLED");
    expect(body.error.message).toBe("此地址已停用，請聯絡管理者");
    // 狀態揭露的前提是「密碼正確」；且這是狀態拒絕而非帳密失敗 → 不累計失敗次數
    expect(await failCount("mailbox:off19@atwho.org")).toBe(0);
    expect((await loginFailedReasons()).map((r) => r.reason)).toEqual(["ADDRESS_DISABLED"]);
  });

  it("密碼正確、地址 active 但帳號停權 → 403 ACCOUNT_SUSPENDED（沿用既有文案）", async () => {
    const { userId } = await seedVisitor({ email: "susp19@atwho.org" });
    const owner = await ownerToken();
    await setUserStatus(userId, "suspended", owner);

    const res = await req("/api/auth/mailbox-login", {
      method: "POST",
      body: JSON.stringify({ email: "susp19@atwho.org", password: VISITOR_PW }),
    });
    const body = await json<ErrBody>(res);
    expect(res.status).toBe(403);
    expect(body.error.code).toBe("ACCOUNT_SUSPENDED");
    expect(body.error.message).toBe("此帳號已停權，請聯絡管理者");
    expect((await loginFailedReasons()).map((r) => r.reason)).toEqual(["ACCOUNT_SUSPENDED"]);

    // 復權 → 可再登入
    await setUserStatus(userId, "active", owner);
    expect(await mailboxLogin("susp19@atwho.org")).not.toBe("");
  });

  it("兩層同時成立時以**地址**為先（順序：地址 disabled → 帳號 suspended）", async () => {
    const { userId, addressId } = await seedVisitor({ email: "both19@atwho.org" });
    const owner = await ownerToken();
    await setUserStatus(userId, "suspended", owner);
    await setAddressStatus(addressId, "disabled", owner);

    const res = await req("/api/auth/mailbox-login", {
      method: "POST",
      body: JSON.stringify({ email: "both19@atwho.org", password: VISITOR_PW }),
    });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe("ADDRESS_DISABLED");
  });

  it("登入成功會清除失敗計數（既有行為不變）", async () => {
    await seedVisitor({ email: "ok19@atwho.org" });
    await req("/api/auth/mailbox-login", {
      method: "POST",
      body: JSON.stringify({ email: "ok19@atwho.org", password: "wrong-password" }),
    });
    expect(await failCount("mailbox:ok19@atwho.org")).toBe(1);
    expect(await mailboxLogin("ok19@atwho.org")).not.toBe("");
    expect(await failCount("mailbox:ok19@atwho.org")).toBe(0);
  });
});

// ══════════════════════ D8-4 邊界：既有檢查與語意不得改變 ══════════════════════
describe("D8-4 邊界：保留 TOKEN_STALE、can_send 語意不變、N9 不放寬", () => {
  it("TOKEN_STALE 檢查保留：地址密碼變更後舊 token 仍回 401（且優先於狀態判定）", async () => {
    const { addressId } = await seedVisitor({ email: "stale@atwho.org" });
    const token = await mailboxLogin("stale@atwho.org");
    expect((await req("/api/me", {}, token)).status).toBe(200);

    // 改地址密碼 → password_changed_at 前進 → 舊 token 版本落後
    expect(
      (await req(`/api/email-addresses/${addressId}/password`, { method: "PATCH", body: JSON.stringify({ old_password: VISITOR_PW, new_password: "new-password-d8" }) }, token)).status
    ).toBe(200);

    const stale = await req("/api/me", {}, token);
    expect(stale.status).toBe(401);
    expect(await codeOf(stale)).toBe("TOKEN_STALE");

    // 同時停用地址 → 仍是 401 TOKEN_STALE（既有檢查的優先序不變）
    const owner = await ownerToken();
    await setAddressStatus(addressId, "disabled", owner);
    const both = await req("/api/me", {}, token);
    expect(both.status).toBe(401);
    expect(await codeOf(both)).toBe("TOKEN_STALE");
  });

  it("can_send 語意不變：地址 active、can_send=0 → 403 SEND_NOT_ALLOWED（不是新的狀態碼）", async () => {
    await seedVisitor({ email: "nosend@atwho.org", canSend: 0 });
    const token = await mailboxLogin("nosend@atwho.org");
    expect(token).not.toBe("");

    const res = await req("/api/mail/send", SEND("nosend@atwho.org"), token);
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe("SEND_NOT_ALLOWED");
    // 讀信不受 can_send 影響（can_send 只管寄信）
    expect((await req("/api/mail/inbox", {}, token)).status).toBe(200);
  });

  it("N9：狀態檢查未放寬 /api/mail/* —— owner 仍讀不到訪客信件", async () => {
    const { addressId } = await seedVisitor({ email: "n9d8@atwho.org" });
    const owner = await ownerToken();
    const res = await req(`/api/mail/inbox?address_id=${addressId}`, {}, owner);
    expect([403, 404]).toContain(res.status);
  });
});
