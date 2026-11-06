/**
 * account-settings.spec.ts — D29：個人設定（docs/29 §4 T177–T178）
 *
 * 全程在 workerd 內以真實 D1 執行；不連外、不觸及遠端資源。
 *
 * 涵蓋：
 * - T177：`GET /api/account/settings` 只回自己的資料（owner／mailbox 範圍不同）、
 *         `has_password` 0／1、OAuth 帳號的 `contact_email`、不含 `password_hash`、
 *         app scope → 403 `SCOPE_NOT_ALLOWED`
 * - T178：`POST /api/account/password` 無密碼者可設定（免 current）、有密碼者錯 current → 401、
 *         成功後舊 JWT 立即失效、visitor 的「信箱＋密碼」同步可用、稽核 `password_changed`
 * - T180：既有 T1–T172 零回歸由 `pnpm test` 全量輸出驗證
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { hashPassword, signAppToken, signMailboxToken, type Env } from "../src/auth";

const E = env as unknown as Env;
const OWNER_PW = "owner-account-pw";
const OWNER_ADDRESS_PW = "owner-address-pw";
const VISITOR_PW = "visitor-account-pw";
const OTHER_PW = "other-account-pw";
const OAUTH_EMAIL = "ulhome@gmail.com";

const hashCache = new Map<string, Promise<string>>();
function cachedHash(pw: string): Promise<string> {
  let p = hashCache.get(pw);
  if (!p) {
    p = hashPassword(pw);
    hashCache.set(pw, p);
  }
  return p;
}

async function req(path: string, init: RequestInit = {}, token?: string): Promise<Response> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = { ...((init.headers as Record<string, string>) ?? {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const res = await app.request(path, { ...init, headers }, E, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function errorCode(body: unknown): string {
  return (body as { error?: { code?: string } })?.error?.code ?? "";
}

async function ownerToken(): Promise<string> {
  const res = await req("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "owner", password: OWNER_PW }),
  });
  expect(res.status).toBe(200);
  return (await json<{ token: string }>(res)).token;
}

async function mailboxLogin(email: string, password: string): Promise<Response> {
  return req("/api/auth/mailbox-login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

function postPassword(token: string, body: Record<string, unknown>): Promise<Response> {
  return req("/api/account/password", { method: "POST", body: JSON.stringify(body) }, token);
}

const TS = Date.UTC(2026, 10, 6, 12, 0, 0);

/** 種子：owner（2 個地址）、本機 visitor（2 個地址）、其他 visitor、OAuth visitor（無密碼） */
async function seed(): Promise<void> {
  const ts = TS;
  await E.DB.batch([
    E.DB.prepare(
      `INSERT INTO users (id, username, display_name, password_hash, status, role, provider,
                          contact_email, email_verified, password_changed_at, created_at, updated_at)
       VALUES (1, 'owner', 'Owner', ?1, 'active', 'owner', 'local', NULL, 0, 0, ?2, ?2)`
    ).bind(await cachedHash(OWNER_PW), ts),
    E.DB.prepare(
      `INSERT INTO users (id, username, display_name, password_hash, status, role, provider,
                          contact_email, email_verified, password_changed_at, created_at, updated_at)
       VALUES (2, 'itag', 'Itag', ?1, 'active', 'visitor', 'local', 'itag@gmail.com', 1, 0, ?2, ?2)`
    ).bind(await cachedHash(VISITOR_PW), ts),
    E.DB.prepare(
      `INSERT INTO users (id, username, display_name, password_hash, status, role, provider,
                          contact_email, email_verified, password_changed_at, created_at, updated_at)
       VALUES (3, 'other', 'Other', ?1, 'active', 'visitor', 'local', NULL, 0, 0, ?2, ?2)`
    ).bind(await cachedHash(OTHER_PW), ts),
    E.DB.prepare(
      `INSERT INTO users (id, username, display_name, password_hash, status, role, provider,
                          contact_email, email_verified, password_changed_at, created_at, updated_at)
       VALUES (4, 'gmailuser', 'Gmail User', '', 'active', 'visitor', 'google', ?1, 1, 0, ?2, ?2)`
    ).bind(OAUTH_EMAIL, ts),
    // owner 名下兩個地址（地址密碼與 owner 帳號密碼刻意不同）
    E.DB.prepare(
      `INSERT INTO email_addresses (id, user_id, local_part, domain, email, password_hash,
                                    password_changed_at, status, can_send, daily_send_quota, sent_today,
                                    created_at, updated_at)
       VALUES (1, 1, 'owner1', 'atwho.org', 'owner1@atwho.org', ?1, 0, 'active', 1, 100, 3, ?2, ?2)`
    ).bind(await cachedHash(OWNER_ADDRESS_PW), ts),
    E.DB.prepare(
      `INSERT INTO email_addresses (id, user_id, local_part, domain, email, password_hash,
                                    password_changed_at, status, can_send, daily_send_quota, sent_today,
                                    created_at, updated_at)
       VALUES (2, 1, 'owner2', 'atwho.org', 'owner2@atwho.org', NULL, 0, 'disabled', 1, 100, 0, ?1, ?1)`
    ).bind(ts),
    // 本機 visitor：兩個地址（mailbox session 只應看到自己那一個）
    E.DB.prepare(
      `INSERT INTO email_addresses (id, user_id, local_part, domain, email, password_hash,
                                    password_changed_at, status, can_send, daily_send_quota, sent_today,
                                    created_at, updated_at)
       VALUES (10, 2, 'itag', 'atwho.org', 'itag@atwho.org', ?1, 0, 'active', 1, 5, 2, ?2, ?2)`
    ).bind(await cachedHash(VISITOR_PW), ts),
    E.DB.prepare(
      `INSERT INTO email_addresses (id, user_id, local_part, domain, email, password_hash,
                                    password_changed_at, status, can_send, daily_send_quota, sent_today,
                                    created_at, updated_at)
       VALUES (11, 2, 'itag-alt', 'atwho.org', 'itag-alt@atwho.org', ?1, 0, 'active', 1, 5, 0, ?2, ?2)`
    ).bind(await cachedHash(VISITOR_PW), ts),
    E.DB.prepare(
      `INSERT INTO email_addresses (id, user_id, local_part, domain, email, password_hash,
                                    password_changed_at, status, can_send, daily_send_quota, sent_today,
                                    created_at, updated_at)
       VALUES (20, 3, 'other', 'atwho.org', 'other@atwho.org', ?1, 0, 'active', 1, 20, 0, ?2, ?2)`
    ).bind(await cachedHash(OTHER_PW), ts),
    // OAuth visitor：users 與地址皆無密碼
    E.DB.prepare(
      `INSERT INTO email_addresses (id, user_id, local_part, domain, email, password_hash,
                                    password_changed_at, status, can_send, daily_send_quota, sent_today,
                                    created_at, updated_at)
       VALUES (30, 4, 'gmailuser', 'atwho.org', 'gmailuser@atwho.org', NULL, 0, 'active', 1, 5, 0, ?1, ?1)`
    ).bind(ts),
  ]);
}

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
  await seed();
});

describe("T177：GET /api/account/settings 只回自己的資料", () => {
  it("owner：回本人＋名下全部地址，has_password=1；不含他人資料與 password_hash", async () => {
    const token = await ownerToken();
    const res = await req("/api/account/settings", {}, token);
    expect(res.status).toBe(200);
    const body = await json<{
      user_id: number;
      username: string;
      role: string;
      provider: string;
      contact_email: string | null;
      has_password: number;
      addresses: Array<{ id: number; email: string; status: string; daily_send_quota: number; sent_today: number }>;
    }>(res);

    expect(body).toMatchObject({
      user_id: 1,
      username: "owner",
      role: "owner",
      provider: "local",
      contact_email: null,
      has_password: 1,
    });
    expect(body.addresses.map((a) => a.email)).toEqual(["owner1@atwho.org", "owner2@atwho.org"]);
    expect(body.addresses[0]).toMatchObject({
      id: 1,
      status: "active",
      daily_send_quota: 100,
      sent_today: 3,
    });

    // 不得含他人（含訪客）的地址，也不得含密碼雜湊
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("itag@atwho.org");
    expect(raw).not.toContain("other@atwho.org");
    expect(raw).not.toContain("password_hash");
    expect(raw).not.toContain("$argon2");
  });

  it("OAuth 帳號（無密碼）：has_password=0、回 provider=google 與 contact_email", async () => {
    // OAuth 帳號沒有可用密碼 → 無法用 user-login／mailbox-login 取得 token；
    // 以與 OAuth callback 相同的簽發函式建立 session（pca=0）。
    const token = await signMailboxToken(E, 30, "gmailuser@atwho.org", 0);
    const res = await req("/api/account/settings", {}, token);
    expect(res.status).toBe(200);
    const body = await json<{
      username: string;
      provider: string;
      contact_email: string | null;
      has_password: number;
      addresses: Array<{ id: number; email: string }>;
    }>(res);
    expect(body).toMatchObject({
      username: "gmailuser",
      provider: "google",
      contact_email: OAUTH_EMAIL,
      has_password: 0,
    });
    expect(body.addresses.map((a) => a.id)).toEqual([30]);
  });

  it("mailbox session：即使同帳號有多個地址，也只回 session 自己的那一個地址", async () => {
    const login = await mailboxLogin("itag@atwho.org", VISITOR_PW);
    expect(login.status).toBe(200);
    const token = (await json<{ token: string }>(login)).token;

    const res = await req("/api/account/settings", {}, token);
    expect(res.status).toBe(200);
    const body = await json<{ role: string; addresses: Array<{ id: number; email: string; sent_today: number }> }>(res);
    expect(body.role).toBe("visitor");
    expect(body.addresses).toEqual([
      expect.objectContaining({ id: 10, email: "itag@atwho.org", sent_today: 2 }),
    ]);
    expect(JSON.stringify(body)).not.toContain("itag-alt@atwho.org");
  });

  it("app scope → 403 SCOPE_NOT_ALLOWED（GET／POST 皆是）", async () => {
    const token = await signAppToken(E, {
      userId: 2,
      appId: "test-app",
      username: "itag",
      role: "visitor",
      pca: 0,
    });
    const getRes = await req("/api/account/settings", {}, token);
    expect(getRes.status).toBe(403);
    expect(errorCode(await json(getRes))).toBe("SCOPE_NOT_ALLOWED");

    const postRes = await postPassword(token, { new_password: "new-password-123" });
    expect(postRes.status).toBe(403);
    expect(errorCode(await json(postRes))).toBe("SCOPE_NOT_ALLOWED");
  });

  it("無 session → 401 UNAUTHORIZED", async () => {
    const res = await req("/api/account/settings");
    expect(res.status).toBe(401);
    expect(errorCode(await json(res))).toBe("UNAUTHORIZED");
  });
});

describe("T178：POST /api/account/password", () => {
  it("無密碼（OAuth）可設定成功（免 current）；舊 JWT 失效、信箱＋密碼與 user-login 立即可用", async () => {
    const oldToken = await signMailboxToken(E, 30, "gmailuser@atwho.org", 0);
    const newPw = "oauth-new-password-1";

    const res = await postPassword(oldToken, { new_password: newPw });
    expect(res.status).toBe(200);
    expect(await json<{ ok: boolean }>(res)).toMatchObject({ ok: true });

    // 舊 JWT 立即失效（users 與地址的 pca 皆已更新）
    const stale = await req("/api/account/settings", {}, oldToken);
    expect(stale.status).toBe(401);
    expect(errorCode(await json(stale))).toBe("TOKEN_STALE");

    // 「信箱＋密碼」登入立即可用（地址 password_hash 已同步）
    const byMailbox = await mailboxLogin("gmailuser@atwho.org", newPw);
    expect(byMailbox.status).toBe(200);

    // 本機帳密登入（identifier = username）也可用
    const byUserLogin = await req("/api/auth/user-login", {
      method: "POST",
      body: JSON.stringify({ identifier: "gmailuser", password: newPw }),
    });
    expect(byUserLogin.status).toBe(200);

    // 新 session 的設定頁回報「已設定」
    const newToken = (await json<{ token: string }>(byMailbox)).token;
    const settings = await req("/api/account/settings", {}, newToken);
    expect((await json<{ has_password: number }>(settings)).has_password).toBe(1);

    // 稽核（不得含密碼）
    const audit = await E.DB.prepare(
      "SELECT detail FROM registration_audit WHERE event = 'password_changed' AND user_id = 4"
    ).first<{ detail: string }>();
    expect(audit).toBeTruthy();
    expect(audit!.detail).not.toContain(newPw);
  });

  it("有密碼者：current 錯誤 → 401 INVALID_CURRENT_PASSWORD；缺 current → 400；成功後舊 JWT 失效", async () => {
    const token = await ownerToken();
    const newPw = "owner-new-password-2";

    const wrong = await postPassword(token, { current_password: "wrong-password", new_password: newPw });
    expect(wrong.status).toBe(401);
    expect(errorCode(await json(wrong))).toBe("INVALID_CURRENT_PASSWORD");

    const missing = await postPassword(token, { new_password: newPw });
    expect(missing.status).toBe(400);
    expect(errorCode(await json(missing))).toBe("INVALID_BODY");

    const weak = await postPassword(token, { current_password: OWNER_PW, new_password: "short" });
    expect(weak.status).toBe(422);
    expect(errorCode(await json(weak))).toBe("WEAK_PASSWORD");

    const ok = await postPassword(token, { current_password: OWNER_PW, new_password: newPw });
    expect(ok.status).toBe(200);

    // 舊 owner JWT 立即失效
    const stale = await req("/api/account/settings", {}, token);
    expect(stale.status).toBe(401);
    expect(errorCode(await json(stale))).toBe("TOKEN_STALE");

    // 舊密碼不能登入、新密碼可以
    expect(
      (
        await req("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ username: "owner", password: OWNER_PW }),
        })
      ).status
    ).toBe(401);
    expect(
      (
        await req("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ username: "owner", password: newPw }),
        })
      ).status
    ).toBe(200);

    // owner 的「地址密碼」由地址管理獨立維護 → 不因帳號密碼變更而改變
    expect((await mailboxLogin("owner1@atwho.org", OWNER_ADDRESS_PW)).status).toBe(200);

    const audit = await E.DB.prepare(
      "SELECT COUNT(*) AS n FROM registration_audit WHERE event = 'password_changed' AND user_id = 1"
    ).first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it("visitor 變更既有密碼：信箱密碼同步更新、舊 mailbox JWT 失效", async () => {
    const login = await mailboxLogin("itag@atwho.org", VISITOR_PW);
    const token = (await json<{ token: string }>(login)).token;
    const newPw = "visitor-new-password-3";

    const ok = await postPassword(token, { current_password: VISITOR_PW, new_password: newPw });
    expect(ok.status).toBe(200);

    expect((await req("/api/account/settings", {}, token)).status).toBe(401);
    expect((await mailboxLogin("itag@atwho.org", VISITOR_PW)).status).toBe(401);
    expect((await mailboxLogin("itag@atwho.org", newPw)).status).toBe(200);
    // 同帳號的另一個地址也同步更新（同一組帳號密碼）
    expect((await mailboxLogin("itag-alt@atwho.org", newPw)).status).toBe(200);
  });

  it("current 連續錯誤 5 次 → 429 LOCKED（沿用既有鎖定機制）", async () => {
    const token = await ownerToken();
    for (let i = 0; i < 5; i++) {
      expect((await postPassword(token, { current_password: "wrong-x", new_password: "whatever-123" })).status).toBe(401);
    }
    const locked = await postPassword(token, { current_password: "wrong-x", new_password: "whatever-123" });
    expect(locked.status).toBe(429);
    expect(errorCode(await json(locked))).toBe("LOCKED");
  });
});
