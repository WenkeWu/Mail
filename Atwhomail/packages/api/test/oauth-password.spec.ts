/**
 * oauth-password.spec.ts — D27：Google OAuth ＋ user-login ＋ 忘記／重設密碼
 * （docs/28 §7 T161–T172）
 *
 * 全程在 workerd 內以真實 D1 執行：
 *  - Google API（token／userinfo）一律以 `setOAuthTestHooks()` mock，**不得**真的連外
 *  - EMAIL binding 以 mock 注入（測試環境未綁 send_email）；重設 token 只存在信件內容與
 *    DB 的雜湊中 → 測試從 mock 信件解析
 *  - T172（既有 T1–T160 零回歸）由 `pnpm test` 全量輸出驗證
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { hashPassword, signOwnerToken, verifyPassword, type Env } from "../src/auth";
import {
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_USERINFO_ENDPOINT,
  OAUTH_REDIRECT_COOKIE,
  OAUTH_STATE_COOKIE,
  safeRedirectAfter,
  setOAuthTestHooks,
} from "../src/oauth";

const E = env as unknown as Env;
const JWT_SECRET = "test-jwt-secret";
const CLIENT_ID = "test-google-client";
const CLIENT_SECRET = "test-google-secret";
const REDIRECT_URI = "https://auth.atwho.org/api/auth/oauth/google/callback";
const APP_ORIGIN = "https://app.atwho.org";
const VISITOR_PW = "visitor-password-01";

interface SentMail {
  from: string;
  to: string[];
  subject: string;
  text?: string;
  html?: string;
}

let sentMails: SentMail[] = [];
const googleCalls: string[] = [];
let userInfo: { sub: string; email: string; email_verified?: boolean; name?: string };
let tokenStatus = 200;
let userinfoStatus = 200;

const hashCache = new Map<string, Promise<string>>();
function cachedHash(pw: string): Promise<string> {
  let p = hashCache.get(pw);
  if (!p) {
    p = hashPassword(pw);
    hashCache.set(pw, p);
  }
  return p;
}

function installEmailMock(): void {
  const mock = {
    send: async (msg: SentMail) => {
      sentMails.push({ from: msg.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
      return { messageId: `mock-${sentMails.length}@atwho.org` };
    },
  };
  (E as unknown as { EMAIL: typeof mock }).EMAIL = mock;
}

function installGoogleMock(): void {
  setOAuthTestHooks({
    fetch: async (url, init) => {
      googleCalls.push(url);
      if (url === GOOGLE_TOKEN_ENDPOINT) {
        return new Response(
          JSON.stringify(tokenStatus === 200 ? { access_token: "google-access-token" } : { error: "invalid_grant" }),
          { status: tokenStatus, headers: { "content-type": "application/json" } }
        );
      }
      if (url === GOOGLE_USERINFO_ENDPOINT) {
        // token 必須是上一步換到的 access_token（Bearer）
        const auth = new Headers(init?.headers).get("authorization");
        expect(auth).toBe("Bearer google-access-token");
        return new Response(JSON.stringify(userInfo), {
          status: userinfoStatus,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`測試不得呼叫未預期的 Google 端點：${url}`);
    },
  });
}

async function req(path: string, init: RequestInit = {}): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.request(path, init, E, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function errorCode(body: unknown): string {
  return (body as { error?: { code?: string } })?.error?.code ?? "";
}

/** 回傳 Set-Cookie 的 name=value（可直接放進 Cookie 標頭）與完整屬性 */
function cookies(res: Response): { pairs: Map<string, string>; raw: string[]; cookieHeader: string } {
  const raw = res.headers.getSetCookie();
  const pairs = new Map<string, string>();
  for (const cookie of raw) {
    const pair = cookie.split(";")[0] ?? "";
    const at = pair.indexOf("=");
    if (at > 0) pairs.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return { pairs, raw, cookieHeader: raw.map((c) => c.split(";")[0]).join("; ") };
}

interface Started {
  state: string;
  cookieHeader: string;
  res: Response;
}

async function start(redirectAfter = "/inbox", referer = `${APP_ORIGIN}/`): Promise<Started> {
  const query = new URLSearchParams({ redirect_after: redirectAfter });
  const res = await req(`/api/auth/oauth/google/start?${query.toString()}`, { headers: { referer } });
  const { pairs, cookieHeader } = cookies(res);
  const location = res.headers.get("location") ?? "";
  const state = new URL(location).searchParams.get("state") ?? "";
  return { state, cookieHeader, res };
}

async function callback(state: string, cookieHeader: string, code = "test-code"): Promise<Response> {
  const query = new URLSearchParams({ code, state });
  return req(`/api/auth/oauth/google/callback?${query.toString()}`, { headers: { cookie: cookieHeader } });
}

/** 完成一次完整 OAuth 登入（start → callback） */
async function oauthLogin(startedPromise: Promise<Started> = start()): Promise<Response> {
  const { state, cookieHeader } = await startedPromise;
  return callback(state, cookieHeader);
}

function fragment(location: string): URLSearchParams {
  const url = new URL(location);
  return new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
}

async function seedUser(opts: {
  username: string;
  passwordHash?: string;
  role?: "owner" | "visitor";
  status?: "active" | "disabled";
  provider?: "local" | "google";
  providerSub?: string | null;
  contactEmail?: string | null;
  emailVerified?: number;
}): Promise<number> {
  const ts = Date.now();
  const res = await E.DB.prepare(
    `INSERT INTO users
       (username, display_name, password_hash, status, role, provider, provider_sub,
        contact_email, email_verified, password_changed_at, created_at, updated_at)
     VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?9)`
  )
    .bind(
      opts.username,
      opts.passwordHash ?? "",
      opts.status ?? "active",
      opts.role ?? "visitor",
      opts.provider ?? "local",
      opts.providerSub ?? null,
      opts.contactEmail ?? null,
      opts.emailVerified ?? 0,
      ts
    )
    .run();
  return Number(res.meta.last_row_id);
}

async function seedAddress(
  userId: number,
  localPart: string,
  opts: { quota?: number; passwordHash?: string | null; status?: "active" | "disabled" } = {}
): Promise<number> {
  const ts = Date.now();
  const res = await E.DB.prepare(
    `INSERT INTO email_addresses
       (user_id, local_part, domain, email, password_hash, password_changed_at, status,
        can_send, daily_send_quota, sent_today, created_at, updated_at)
     VALUES (?1, ?2, 'atwho.org', ?3, ?4, 0, ?5, 1, ?6, 0, ?7, ?7)`
  )
    .bind(
      userId,
      localPart,
      `${localPart}@atwho.org`,
      opts.passwordHash ?? null,
      opts.status ?? "active",
      opts.quota ?? 20,
      ts
    )
    .run();
  return Number(res.meta.last_row_id);
}

function resetTokenFrom(mail: SentMail): string {
  const match = (mail.text ?? "").match(/[?&]reset=([0-9a-f]{64})/);
  if (!match) throw new Error(`重設信找不到 token：${mail.text ?? ""}`);
  return match[1]!;
}

beforeEach(async () => {
  for (const table of [
    "password_resets",
    "email_verifications",
    "auth_codes",
    "app_clients",
    "registration_audit",
    "auth_attempts",
    "email_aliases",
    "email_addresses",
    "users",
  ]) {
    await E.DB.prepare(`DELETE FROM ${table}`).run();
  }
  sentMails = [];
  googleCalls.length = 0;
  tokenStatus = 200;
  userinfoStatus = 200;
  userInfo = { sub: "google-sub-123456789", email: "luke@gmail.com", email_verified: true, name: "Luke" };
  installEmailMock();
  installGoogleMock();
  (E as unknown as { GOOGLE_CLIENT_ID: string }).GOOGLE_CLIENT_ID = CLIENT_ID;
  (E as unknown as { GOOGLE_CLIENT_SECRET: string }).GOOGLE_CLIENT_SECRET = CLIENT_SECRET;
  (E as unknown as { OAUTH_REDIRECT_URI: string }).OAUTH_REDIRECT_URI = REDIRECT_URI;
});

// ══════════════════════ T161 ══════════════════════
describe("T161：GET /start", () => {
  it("302 到 Google；含固定 client_id／redirect_uri／state；state cookie 屬性正確", async () => {
    const { state, res } = await start("/inbox?tab=all");
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(location.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(location.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("scope")).toBe("openid email profile");
    expect(location.searchParams.get("prompt")).toBe("select_account");
    expect(state).toMatch(/^[0-9a-f]{64}$/);

    const { pairs, raw } = cookies(res);
    expect(pairs.get(OAUTH_STATE_COOKIE)).toBe(state);
    const stateCookie = raw.find((c) => c.startsWith(`${OAUTH_STATE_COOKIE}=`))!;
    expect(stateCookie).toMatch(/HttpOnly/i);
    expect(stateCookie).toMatch(/Secure/i);
    expect(stateCookie).toMatch(/SameSite=Lax/i);
    expect(stateCookie).toMatch(/Path=\//);
    expect(stateCookie).toMatch(/Max-Age=600/);
    expect(pairs.has(OAUTH_REDIRECT_COOKIE)).toBe(true);
  });

  it("不接受請求傳入的 redirect_uri（固定用 OAUTH_REDIRECT_URI）", async () => {
    const res = await req(
      "/api/auth/oauth/google/start?redirect_uri=https%3A%2F%2Fevil.example%2Fcb",
      { headers: { referer: `${APP_ORIGIN}/` } }
    );
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
  });

  it("未設定 Google 金鑰 → 503 OAUTH_NOT_CONFIGURED", async () => {
    const old = E.GOOGLE_CLIENT_ID;
    (E as unknown as { GOOGLE_CLIENT_ID: string }).GOOGLE_CLIENT_ID = "";
    try {
      const res = await req("/api/auth/oauth/google/start");
      expect(res.status).toBe(503);
      expect(errorCode(await json(res))).toBe("OAUTH_NOT_CONFIGURED");
    } finally {
      (E as unknown as { GOOGLE_CLIENT_ID: string }).GOOGLE_CLIENT_ID = old ?? CLIENT_ID;
    }
  });
});

// ══════════════════════ T162 ══════════════════════
describe("T162：callback state 不符", () => {
  it("→ 400 INVALID_STATE；不呼叫 Google；清除 state cookie", async () => {
    const { state, cookieHeader, res: startRes } = await start();
    expect(state).not.toBe("");
    const res = await callback("deadbeef", cookieHeader);
    expect(res.status).toBe(400);
    expect(errorCode(await json(res))).toBe("INVALID_STATE");
    expect(googleCalls).toHaveLength(0);

    const cleared = res.headers.getSetCookie().find((c) => c.startsWith(`${OAUTH_STATE_COOKIE}=`));
    expect(cleared).toBeTruthy();
    expect(cleared).toMatch(/Max-Age=0/);
    // start 回應確實有設 cookie（避免本案例誤判）
    expect(cookies(startRes).pairs.has(OAUTH_STATE_COOKIE)).toBe(true);
  });
});

// ══════════════════════ T163 ══════════════════════
describe("T163：callback email_verified=false", () => {
  it("→ 403 EMAIL_NOT_VERIFIED；不建立帳號", async () => {
    userInfo = { sub: "google-sub-unverified", email: "nobody@gmail.com", email_verified: false };
    const res = await oauthLogin();
    expect(res.status).toBe(403);
    expect(errorCode(await json(res))).toBe("EMAIL_NOT_VERIFIED");
    const count = await E.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
    expect(Number(count?.n)).toBe(0);
  });
});

// ══════════════════════ T164 ══════════════════════
describe("T164：callback 新使用者", () => {
  it("建立 visitor（無密碼）＋地址（配額 50）＋稽核；回 mailbox session", async () => {
    const res = await oauthLogin();
    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    expect(new URL(location).origin).toBe(APP_ORIGIN);
    const frag = fragment(location);
    expect(frag.get("oauth_session")).toBe("mailbox");
    expect(frag.get("oauth_email")).toBe("luke@atwho.org");
    const token = frag.get("oauth_token")!;
    expect(token.split(".")).toHaveLength(3);

    const user = await E.DB.prepare(
      `SELECT id, username, password_hash, role, status, provider, provider_sub, contact_email, email_verified
       FROM users`
    ).first<{
      id: number;
      username: string;
      password_hash: string;
      role: string;
      status: string;
      provider: string;
      provider_sub: string;
      contact_email: string;
      email_verified: number;
    }>();
    expect(user).not.toBeNull();
    expect(user!.username).toBe("luke");
    expect(user!.role).toBe("visitor");
    expect(user!.status).toBe("active");
    expect(user!.provider).toBe("google");
    expect(user!.provider_sub).toBe("google-sub-123456789");
    expect(user!.contact_email).toBe("luke@gmail.com");
    expect(Number(user!.email_verified)).toBe(1);
    // users.password_hash 為 NOT NULL（0001）→ 純 OAuth 帳號以空字串表示「未設定」
    expect(user!.password_hash).toBe("");

    const address = await E.DB.prepare(
      "SELECT id, email, password_hash, daily_send_quota, warmup_exempt, status FROM email_addresses"
    ).first<{
      id: number;
      email: string;
      password_hash: string | null;
      daily_send_quota: number;
      warmup_exempt: number;
      status: string;
    }>();
    expect(address).not.toBeNull();
    expect(address!.email).toBe("luke@atwho.org");
    expect(address!.password_hash).toBeNull();
    expect(Number(address!.daily_send_quota)).toBe(50);
    expect(Number(address!.warmup_exempt)).toBe(0);
    expect(address!.status).toBe("active");
    expect(frag.get("oauth_address_id")).toBe(String(address!.id));

    // D31：帳號建立時自動產生 Token 別名（16 hex，目標為這個地址）
    const tokenAlias = await E.DB.prepare(
      "SELECT alias_address, status, kind FROM email_aliases WHERE target_email_address_id = ?1"
    )
      .bind(address!.id)
      .first<{ alias_address: string; status: string; kind: string }>();
    expect(tokenAlias).toBeTruthy();
    expect(tokenAlias).toMatchObject({ status: "active", kind: "token" });
    expect(tokenAlias!.alias_address).toMatch(/^[0-9a-f]{16}@atwho\.org$/);

    // 稽核：oauth_registered ＋ oauth_login；不得包含 Google Email 全文
    const audits = await E.DB.prepare(
      "SELECT event, user_id, detail FROM registration_audit ORDER BY id"
    ).all<{ event: string; user_id: number | null; detail: string | null }>();
    const events = audits.results.map((r) => r.event);
    expect(events).toContain("oauth_registered");
    expect(events).toContain("oauth_login");
    const registered = audits.results.find((r) => r.event === "oauth_registered")!;
    expect(JSON.parse(registered.detail!)).toMatchObject({
      username: "luke",
      provider: "google",
      address: "luke@atwho.org",
    });
    const loggedIn = audits.results.find((r) => r.event === "oauth_login")!;
    expect(loggedIn.detail).toContain("google-sub-123456789".slice(0, 8));
    for (const audit of audits.results) expect(audit.detail ?? "").not.toContain("luke@gmail.com");

    // token 是 mailbox scope → /api/auth/whoami 可用、/api/mail/inbox 可用
    const who = await req("/api/auth/whoami", { headers: { authorization: `Bearer ${token}` } });
    expect(who.status).toBe(200);
    expect(await json(who)).toMatchObject({ session: "mailbox" });
  });

  it("ID 撞名 → assignAvailableLocalPart 配發 luke001", async () => {
    const userId = await seedUser({ username: "luke" });
    await seedAddress(userId, "luke");
    const res = await oauthLogin();
    expect(res.status).toBe(302);
    const row = await E.DB.prepare(
      `SELECT username FROM users WHERE provider = 'google' AND provider_sub = 'google-sub-123456789'`
    ).first<{ username: string }>();
    expect(row?.username).toBe("luke001");
    expect(fragment(res.headers.get("location")!).get("oauth_email")).toBe("luke001@atwho.org");
  });

  it("local part 少於 3 個字母 → user", async () => {
    userInfo = { sub: "google-sub-short", email: "hp@gmail.com", email_verified: true };
    const res = await oauthLogin();
    expect(res.status).toBe(302);
    expect(fragment(res.headers.get("location")!).get("oauth_email")).toBe("user@atwho.org");
  });
});

// ══════════════════════ T165 ══════════════════════
describe("T165：callback 既有 contact_email → 連結", () => {
  it("不重複建帳號；更新 provider／provider_sub；稽核 oauth_linked", async () => {
    userInfo = { sub: "google-sub-link", email: "itag@gmail.com", email_verified: true };
    const userId = await seedUser({
      username: "itag",
      passwordHash: await cachedHash(VISITOR_PW),
      contactEmail: "itag@gmail.com",
    });
    const addressId = await seedAddress(userId, "itag");

    const res = await oauthLogin();
    expect(res.status).toBe(302);
    expect(fragment(res.headers.get("location")!).get("oauth_session")).toBe("mailbox");
    expect(fragment(res.headers.get("location")!).get("oauth_address_id")).toBe(String(addressId));

    const count = await E.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
    expect(Number(count?.n)).toBe(1);
    const user = await E.DB.prepare(
      "SELECT provider, provider_sub, contact_email, email_verified FROM users WHERE id = ?1"
    )
      .bind(userId)
      .first<{ provider: string; provider_sub: string; contact_email: string; email_verified: number }>();
    expect(user).toMatchObject({
      provider: "google",
      provider_sub: "google-sub-link",
      contact_email: "itag@gmail.com",
    });
    expect(Number(user!.email_verified)).toBe(1);

    const audit = await E.DB.prepare(
      "SELECT detail FROM registration_audit WHERE event = 'oauth_linked'"
    ).first<{ detail: string | null }>();
    expect(audit).not.toBeNull();
    expect(audit!.detail ?? "").not.toContain("itag@gmail.com");
  });
});

// ══════════════════════ T166 ══════════════════════
describe("T166：callback 第二次登入", () => {
  it("同一 user；contact_email 變更時更新；不重複建立", async () => {
    await oauthLogin();
    const first = await E.DB.prepare("SELECT id, contact_email FROM users").first<{ id: number; contact_email: string }>();
    expect(first?.contact_email).toBe("luke@gmail.com");

    userInfo = { sub: "google-sub-123456789", email: "luke.new@gmail.com", email_verified: true };
    const second = await oauthLogin();
    expect(second.status).toBe(302);

    const count = await E.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
    expect(Number(count?.n)).toBe(1);
    const after = await E.DB.prepare("SELECT id, contact_email FROM users").first<{ id: number; contact_email: string }>();
    expect(after?.id).toBe(first?.id);
    expect(after?.contact_email).toBe("luke.new@gmail.com");

    const logins = await E.DB.prepare(
      "SELECT COUNT(*) AS n FROM registration_audit WHERE event = 'oauth_login'"
    ).first<{ n: number }>();
    expect(Number(logins?.n)).toBe(2);
    const registrations = await E.DB.prepare(
      "SELECT COUNT(*) AS n FROM registration_audit WHERE event = 'oauth_registered'"
    ).first<{ n: number }>();
    expect(Number(registrations?.n)).toBe(1);
  });
});

// ══════════════════════ T167 ══════════════════════
describe("T167：POST /api/auth/user-login", () => {
  it("identifier 可為 username 或 contact_email（大小寫不敏感）", async () => {
    const password = "local-password-01";
    const userId = await seedUser({
      username: "itag",
      passwordHash: await cachedHash(password),
      contactEmail: "itag@gmail.com",
    });
    const addressId = await seedAddress(userId, "itag");

    const byName = await req("/api/auth/user-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: "itag", password }),
    });
    expect(byName.status).toBe(200);
    expect(await json(byName)).toMatchObject({
      session: "mailbox",
      address: { id: addressId, email: "itag@atwho.org" },
    });

    const byEmail = await req("/api/auth/user-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: "ITAG@GMAIL.COM", password }),
    });
    expect(byEmail.status).toBe(200);
    expect(await json(byEmail)).toMatchObject({ session: "mailbox" });
  });

  it("owner → scope=owner；密碼錯誤 → 401 且計入鎖定", async () => {
    const password = "owner-password-01";
    const ownerId = await seedUser({
      username: "theowner",
      role: "owner",
      passwordHash: await cachedHash(password),
      contactEmail: "owner@gmail.com",
    });

    const ok = await req("/api/auth/user-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: "theowner", password }),
    });
    expect(ok.status).toBe(200);
    const body = await json<{ token: string; session: string; user: { id: number; username: string } }>(ok);
    expect(body.session).toBe("owner");
    expect(body.user).toMatchObject({ id: ownerId, username: "theowner" });
    const who = await req("/api/auth/whoami", { headers: { authorization: `Bearer ${body.token}` } });
    expect(await json(who)).toMatchObject({ session: "owner" });

    const bad = await req("/api/auth/user-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: "theowner", password: "wrong-password" }),
    });
    expect(bad.status).toBe(401);
    expect(errorCode(await json(bad))).toBe("INVALID_CREDENTIALS");
    const attempt = await E.DB.prepare("SELECT fail_count FROM auth_attempts WHERE key = 'login:theowner'").first<{
      fail_count: number;
    }>();
    expect(Number(attempt?.fail_count)).toBe(1);
  });
});

// ══════════════════════ T168 ══════════════════════
describe("T168：user-login 對無密碼帳號", () => {
  it("→ 400 NO_PASSWORD_SET（訊息引導 Google／忘記密碼）", async () => {
    await seedUser({ username: "oauthonly", contactEmail: "oauth@gmail.com", provider: "google", providerSub: "g-1" });
    const res = await req("/api/auth/user-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: "oauth@gmail.com", password: "whatever-01" }),
    });
    expect(res.status).toBe(400);
    const body = await json<{ error: { code: string; message: string } }>(res);
    expect(body.error.code).toBe("NO_PASSWORD_SET");
    expect(body.error.message).toContain("Google");
    expect(body.error.message).toContain("忘記密碼");
  });
});

// ══════════════════════ T169 ══════════════════════
describe("T169：POST /api/auth/forgot-password", () => {
  it("不存在的 Email → 仍 200（不洩漏）；不寄信", async () => {
    const res = await req("/api/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com" }),
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ sent: true });
    expect(sentMails).toHaveLength(0);
  });

  it("有帳號 → 寄出重設信（noreply@、只含連結與 30 分鐘說明）；DB 只存雜湊", async () => {
    const userId = await seedUser({
      username: "itag",
      passwordHash: await cachedHash(VISITOR_PW),
      contactEmail: "itag@gmail.com",
    });
    const res = await req("/api/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.50" },
      body: JSON.stringify({ email: "itag@gmail.com" }),
    });
    expect(res.status).toBe(200);
    expect(sentMails).toHaveLength(1);
    const mail = sentMails[0]!;
    expect(mail.from).toBe("noreply@atwho.org");
    expect(mail.to).toEqual(["itag@gmail.com"]);
    expect(mail.subject).toBe("AtWhoMail 密碼重設");
    expect(mail.text).toContain("https://app.atwho.org/?reset=");
    expect(mail.text).toContain("30 分鐘");
    const token = resetTokenFrom(mail);
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const row = await E.DB.prepare("SELECT token_hash, user_id FROM password_resets").first<{
      token_hash: string;
      user_id: number;
    }>();
    expect(Number(row?.user_id)).toBe(userId);
    expect(row?.token_hash).not.toBe(token);
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);

    const audit = await E.DB.prepare(
      "SELECT detail FROM registration_audit WHERE event = 'password_reset_requested'"
    ).first<{ detail: string | null }>();
    expect(audit).not.toBeNull();
    expect(audit!.detail ?? "").not.toContain(token);
  });

  it("同 Email 每小時 3 次（第 4 次仍 200 但不寄信）", async () => {
    await seedUser({
      username: "itag",
      passwordHash: await cachedHash(VISITOR_PW),
      contactEmail: "itag@gmail.com",
    });
    const send = () =>
      req("/api/auth/forgot-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "itag@gmail.com" }),
      });
    for (let i = 0; i < 4; i += 1) {
      const res = await send();
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ sent: true });
    }
    expect(sentMails).toHaveLength(3);
  });

  it("交替 username／contact_email 也不能繞過 3 次/小時（以實際收件 Email 計數）", async () => {
    await seedUser({
      username: "itag",
      passwordHash: await cachedHash(VISITOR_PW),
      contactEmail: "itag@gmail.com",
    });
    const send = (email: string) =>
      req("/api/auth/forgot-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
    await send("itag@gmail.com");
    await send("itag");
    await send("ITAG@gmail.com");
    const fourth = await send("itag");
    expect(fourth.status).toBe(200);
    expect(await json(fourth)).toEqual({ sent: true });
    expect(sentMails).toHaveLength(3);
  });
});

// ══════════════════════ T170 ══════════════════════
describe("T170：POST /api/auth/reset-password 正常流程", () => {
  it("200；舊 JWT 立即失效（pca 變更）；寄出變更通知", async () => {
    const oldPassword = "old-password-01";
    const newPassword = "new-password-02";
    const userId = await seedUser({
      username: "theowner",
      role: "owner",
      passwordHash: await cachedHash(oldPassword),
      contactEmail: "owner@gmail.com",
    });
    const oldToken = await signOwnerToken(E, userId, 0);
    // 先確認舊 token 可用
    expect((await req("/api/auth/me", { headers: { authorization: `Bearer ${oldToken}` } })).status).toBe(200);

    await req("/api/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@gmail.com" }),
    });
    const token = resetTokenFrom(sentMails[0]!);

    const res = await req("/api/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, new_password: newPassword }),
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true });

    const row = await E.DB.prepare(
      "SELECT password_hash, password_changed_at FROM users WHERE id = ?1"
    )
      .bind(userId)
      .first<{ password_hash: string; password_changed_at: number }>();
    expect(await verifyPassword(newPassword, row!.password_hash)).toBe(true);
    expect(Number(row!.password_changed_at)).toBeGreaterThan(0);

    // 舊 JWT → 401 TOKEN_STALE
    const stale = await req("/api/auth/me", { headers: { authorization: `Bearer ${oldToken}` } });
    expect(stale.status).toBe(401);
    expect(errorCode(await json(stale))).toBe("TOKEN_STALE");

    // 新密碼可透過 user-login 登入
    const login = await req("/api/auth/user-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: "owner@gmail.com", password: newPassword }),
    });
    expect(login.status).toBe(200);
    expect(await json(login)).toMatchObject({ session: "owner" });

    // 變更通知（第二封）
    expect(sentMails).toHaveLength(2);
    expect(sentMails[1]!.subject).toBe("AtWhoMail 密碼已變更");
    expect(sentMails[1]!.to).toEqual(["owner@gmail.com"]);
    expect(sentMails[1]!.text ?? "").not.toContain(token);

    const audit = await E.DB.prepare(
      "SELECT user_id FROM registration_audit WHERE event = 'password_reset_done'"
    ).first<{ user_id: number }>();
    expect(Number(audit?.user_id)).toBe(userId);
  });

  it("弱密碼 → 422 WEAK_PASSWORD（token 不被消耗）", async () => {
    await seedUser({
      username: "itag",
      passwordHash: await cachedHash(VISITOR_PW),
      contactEmail: "itag@gmail.com",
    });
    await req("/api/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "itag@gmail.com" }),
    });
    const token = resetTokenFrom(sentMails[0]!);
    const res = await req("/api/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, new_password: "short" }),
    });
    expect(res.status).toBe(422);
    expect(errorCode(await json(res))).toBe("WEAK_PASSWORD");
    const row = await E.DB.prepare("SELECT consumed_at FROM password_resets").first<{ consumed_at: number | null }>();
    expect(row?.consumed_at).toBeNull();
  });
});

// ══════════════════════ T171 ══════════════════════
describe("T171：reset-password token 一次性", () => {
  it("重複使用 → 400 INVALID_TOKEN", async () => {
    await seedUser({
      username: "itag",
      passwordHash: await cachedHash(VISITOR_PW),
      contactEmail: "itag@gmail.com",
    });
    await req("/api/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "itag@gmail.com" }),
    });
    const token = resetTokenFrom(sentMails[0]!);
    const payload = { token, new_password: "new-password-02" };

    const first = await req("/api/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(200);

    const second = await req("/api/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(second.status).toBe(400);
    expect(errorCode(await json(second))).toBe("INVALID_TOKEN");
  });

  it("過期 → 400 TOKEN_EXPIRED", async () => {
    await seedUser({
      username: "itag",
      passwordHash: await cachedHash(VISITOR_PW),
      contactEmail: "itag@gmail.com",
    });
    await req("/api/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "itag@gmail.com" }),
    });
    const token = resetTokenFrom(sentMails[0]!);
    // 直接把到期時間移到過去（模擬 30 分鐘後）
    await E.DB.prepare("UPDATE password_resets SET expires_at = ?1").bind(Date.now() - 1).run();
    const res = await req("/api/auth/reset-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, new_password: "new-password-02" }),
    });
    expect(res.status).toBe(400);
    expect(errorCode(await json(res))).toBe("TOKEN_EXPIRED");
  });
});

// ══════════════════════ 其他邊界 ══════════════════════
describe("D27 邊界：redirect_after 防開放轉址", () => {
  it("safeRedirectAfter：只允許站內相對路徑", () => {
    expect(safeRedirectAfter("/inbox")).toBe("/inbox");
    expect(safeRedirectAfter("/inbox?tab=all")).toBe("/inbox?tab=all");
    expect(safeRedirectAfter("https://evil.example/cb")).toBe("/");
    expect(safeRedirectAfter("//evil.example/cb")).toBe("/");
    expect(safeRedirectAfter("/\\evil.example")).toBe("/");
    expect(safeRedirectAfter("/\tevil")).toBe("/");
    expect(safeRedirectAfter(undefined)).toBe("/");
  });

  it("callback 導回時仍固定在前端來源（外部 redirect_after 被降級為 /）", async () => {
    const started = await start("//evil.example/phish");
    const res = await callback(started.state, started.cookieHeader);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).origin).toBe(APP_ORIGIN);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
  });
});

describe("D27 邊界：OAuth 錯誤不洩漏細節", () => {
  it("Google token 端點失敗 → 502 OAUTH_FAILED（不回傳 Google 原文）", async () => {
    tokenStatus = 400;
    const res = await oauthLogin();
    expect(res.status).toBe(502);
    const body = await json<{ error: { code: string; message: string } }>(res);
    expect(body.error.code).toBe("OAUTH_FAILED");
    expect(body.error.message).not.toContain("invalid_grant");
  });

  it("userinfo 失敗 → 502 OAUTH_FAILED", async () => {
    userinfoStatus = 401;
    const res = await oauthLogin();
    expect(res.status).toBe(502);
    expect(errorCode(await json(res))).toBe("OAUTH_FAILED");
  });
});
