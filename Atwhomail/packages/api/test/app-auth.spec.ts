/**
 * D26（docs/27 §7）：App Clients ＋ App code 交換（T151–T158；T159 在 packages/auth）。
 *
 * 全程在 workerd 內以真實 D1 執行；EMAIL 不需要（本檔不寄信）。
 * 測試直接以 signOwnerToken／signMailboxToken 建立 session，避免 argon2 登入拖慢。
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { verify } from "hono/jwt";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { signMailboxToken, signOwnerToken, type Env } from "../src/auth";

const E = env as unknown as Env;
const JWT_SECRET = "test-jwt-secret";
const OWNER_ID = 1;
const OWNER_USERNAME = "owner";
const OWNER_EMAIL = "ownerbox@atwho.org";
const OWNER_PW_HASH = "not-used-in-these-tests";
const REDIRECT = "https://crm.example.com/cb";

async function req(path: string, init: RequestInit = {}, token?: string): Promise<Response> {
  const ctx = createExecutionContext();
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const res = await app.request(path, { ...init, headers }, E, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const ownerToken = () => signOwnerToken(E, OWNER_ID, 0);
const mailboxToken = () => signMailboxToken(E, 1, OWNER_EMAIL, 0);

async function createApp(overrides: Partial<{ app_id: string; name: string; redirect_uris: string[] }> = {}) {
  const res = await req(
    "/api/apps",
    {
      method: "POST",
      body: JSON.stringify({
        app_id: overrides.app_id ?? "mycrm",
        name: overrides.name ?? "My CRM",
        redirect_uris: overrides.redirect_uris ?? [REDIRECT],
      }),
    },
    await ownerToken()
  );
  const body = await json<{ app_id: string; app_secret: string; redirect_uris: string[] }>(res);
  return { res, body };
}

/** app-login → 回傳 redirect 與其中的 code */
async function appLogin(token: string, appId = "mycrm", redirectUri = REDIRECT) {
  const res = await req(
    "/api/auth/app-login",
    { method: "POST", body: JSON.stringify({ app: appId, redirect_uri: redirectUri }) },
    token
  );
  const body = await json<{ redirect?: string; error?: { code: string } }>(res);
  const code = body.redirect ? new URL(body.redirect).searchParams.get("code") : null;
  return { res, body, code };
}

async function exchange(payload: Record<string, unknown>): Promise<Response> {
  return req("/api/auth/exchange", { method: "POST", body: JSON.stringify(payload) });
}

beforeEach(async () => {
  for (const t of [
    "auth_codes",
    "app_clients",
    "registration_audit",
    "auth_attempts",
    "email_aliases",
    "email_addresses",
    "users",
  ]) {
    await E.DB.prepare(`DELETE FROM ${t}`).run();
  }
  const ts = Date.now();
  await E.DB.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, status, role, created_at, updated_at)
     VALUES (?1, ?2, 'Owner', ?3, 'active', 'owner', ?4, ?4)`
  )
    .bind(OWNER_ID, OWNER_USERNAME, OWNER_PW_HASH, ts)
    .run();
  await E.DB.prepare(
    `INSERT INTO email_addresses (id, user_id, local_part, domain, email, status, created_at, updated_at)
     VALUES (1, ?1, 'ownerbox', 'atwho.org', ?2, 'active', ?3, ?3)`
  )
    .bind(OWNER_ID, OWNER_EMAIL, ts)
    .run();
});

// ══════════════════════ T151 ══════════════════════
describe("T151：POST /api/apps 建立 → 只回一次 secret；DB 只存 hash", () => {
  it("回傳 32-byte secret（hex）、redirect_uris；DB 存 SHA-256(secret + JWT_SECRET)", async () => {
    const { res, body } = await createApp();
    expect(res.status).toBe(201);
    expect(body.app_id).toBe("mycrm");
    expect(body.redirect_uris).toEqual([REDIRECT]);
    expect(body.app_secret).toMatch(/^[0-9a-f]{64}$/);

    const row = await E.DB.prepare("SELECT secret_hash, redirect_uris, status FROM app_clients WHERE app_id = 'mycrm'")
      .first<{ secret_hash: string; redirect_uris: string; status: string }>();
    expect(row).not.toBeNull();
    expect(row!.status).toBe("active");
    expect(row!.redirect_uris).toBe(JSON.stringify([REDIRECT]));
    expect(await sha256Hex(body.app_secret + JWT_SECRET)).toBe(row!.secret_hash);
    expect(row!.secret_hash).not.toBe(body.app_secret);

    // 清單端點不得回 secret／secret_hash
    const listRes = await req("/api/apps", {}, await ownerToken());
    expect(listRes.status).toBe(200);
    const listRaw = JSON.stringify(await json(listRes));
    expect(listRaw).not.toContain(body.app_secret);
    expect(listRaw).not.toContain(row!.secret_hash);
    expect(listRaw).not.toContain("secret_hash");

    // 稽核只記 app_id／名稱／狀態，不得含 secret
    const audit = await E.DB.prepare(
      "SELECT detail FROM registration_audit WHERE event = 'app_created'"
    ).first<{ detail: string | null }>();
    expect(audit?.detail).toBeTruthy();
    expect(audit!.detail).not.toContain(body.app_secret);
    expect(JSON.parse(audit!.detail!)).toEqual({ app_id: "mycrm", name: "My CRM", status: "active" });
  });

  it("app_id 格式錯誤 → 400 INVALID_APP_ID；重複 app_id → 409 APP_EXISTS；非 owner → 403", async () => {
    expect((await req("/api/apps", { method: "POST", body: JSON.stringify({ app_id: "Bad_ID", name: "x", redirect_uris: [REDIRECT] }) }, await ownerToken())).status).toBe(400);
    await createApp();
    const dup = await createApp();
    expect(dup.res.status).toBe(409);
    expect(dup.body).toMatchObject({ error: { code: "APP_EXISTS" } });

    // mailbox token 不是 owner → requireOwner 403
    const res = await req(
      "/api/apps",
      { method: "POST", body: JSON.stringify({ app_id: "other", name: "x", redirect_uris: [REDIRECT] }) },
      await mailboxToken()
    );
    expect(res.status).toBe(403);
  });
});

// ══════════════════════ T152 ══════════════════════
describe("T152：app-login", () => {
  it("owner JWT → 200 {redirect} 含 60 秒一次性 code；DB 只存 code hash", async () => {
    await createApp();
    const { res, body, code } = await appLogin(await ownerToken());
    expect(res.status).toBe(200);
    expect(body.redirect).toBe(`${REDIRECT}?code=${code}`);
    expect(code).toMatch(/^[0-9a-f]{64}$/);

    const row = await E.DB.prepare("SELECT code_hash, user_id, app_id, redirect_uri, expires_at, consumed_at FROM auth_codes")
      .first<{ code_hash: string; user_id: number; app_id: string; redirect_uri: string; expires_at: number; consumed_at: number | null }>();
    expect(row).not.toBeNull();
    expect(row!.code_hash).toBe(await sha256Hex(code! + JWT_SECRET));
    expect(row!.code_hash).not.toBe(code);
    expect(row!.user_id).toBe(OWNER_ID);
    expect(row!.app_id).toBe("mycrm");
    expect(row!.redirect_uri).toBe(REDIRECT);
    expect(row!.consumed_at).toBeNull();
    const ttl = Number(row!.expires_at) - Date.now();
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });

  it("mailbox JWT → 以該地址所屬 user 發 code", async () => {
    await createApp();
    const { res, code } = await appLogin(await mailboxToken());
    expect(res.status).toBe(200);
    expect(code).toMatch(/^[0-9a-f]{64}$/);
    const row = await E.DB.prepare("SELECT user_id FROM auth_codes").first<{ user_id: number }>();
    expect(row?.user_id).toBe(OWNER_ID);
  });

  it("redirect_uri 不在白名單 → 400 INVALID_REDIRECT_URI（不完全相符也不行）", async () => {
    await createApp();
    const token = await ownerToken();
    for (const uri of [
      "https://crm.example.com/cb/",
      "https://crm.example.com/cb?x=1",
      "https://evil.example.com/cb",
      "https://crm.example.com",
    ]) {
      const { res, body } = await appLogin(token, "mycrm", uri);
      expect(res.status).toBe(400);
      expect(body.error?.code).toBe("INVALID_REDIRECT_URI");
    }
  });

  it("未知／已停用的 App → 400 UNKNOWN_APP；未登入 → 401", async () => {
    const unknown = await appLogin(await ownerToken(), "nope", REDIRECT);
    expect(unknown.res.status).toBe(400);
    expect(unknown.body.error?.code).toBe("UNKNOWN_APP");

    const noSession = await req(
      "/api/auth/app-login",
      { method: "POST", body: JSON.stringify({ app: "mycrm", redirect_uri: REDIRECT }) }
    );
    expect(noSession.status).toBe(401);
  });
});

// ══════════════════════ T153 ══════════════════════
describe("T153：exchange 正確 secret/code → App JWT", () => {
  it("200 + JWT（aud=app_id、scope=app、sub=user_id）；回傳 user 不含敏感欄位", async () => {
    const { body: created } = await createApp();
    const { code } = await appLogin(await ownerToken());
    const res = await exchange({
      app_id: "mycrm",
      app_secret: created.app_secret,
      code,
      redirect_uri: REDIRECT,
    });
    expect(res.status).toBe(200);
    const body = await json<{
      token: string;
      user: { id: number; username: string; display_name: string | null; role: string };
    }>(res);
    expect(body.user).toEqual({
      id: OWNER_ID,
      username: OWNER_USERNAME,
      display_name: "Owner",
      role: "owner",
    });
    expect(JSON.stringify(body)).not.toContain("password_hash");

    const claims = (await verify(body.token, JWT_SECRET, "HS256")) as {
      scope: string;
      aud: string;
      sub: number;
      username: string;
      role: string;
      iat: number;
      exp: number;
    };
    expect(claims.scope).toBe("app");
    expect(claims.aud).toBe("mycrm");
    expect(claims.sub).toBe(OWNER_ID);
    expect(claims.username).toBe(OWNER_USERNAME);
    expect(claims.role).toBe("owner");
    expect(claims.exp).toBeGreaterThan(claims.iat);

    // code 已原子消費
    const row = await E.DB.prepare("SELECT consumed_at FROM auth_codes").first<{ consumed_at: number | null }>();
    expect(row?.consumed_at).not.toBeNull();

    // 稽核 app_exchanged（不記 token／secret／code）
    const audit = await E.DB.prepare("SELECT detail FROM registration_audit WHERE event = 'app_exchanged'")
      .first<{ detail: string }>();
    expect(audit?.detail).toBeTruthy();
    expect(audit!.detail).not.toContain(body.token);
    expect(audit!.detail).not.toContain(created.app_secret);
    expect(JSON.parse(audit!.detail!)).toEqual({ app_id: "mycrm" });
  });
});

// ══════════════════════ T154 ══════════════════════
describe("T154：code 重複使用", () => {
  it("第二次 exchange → 409 CODE_ALREADY_USED", async () => {
    const { body: created } = await createApp();
    const { code } = await appLogin(await ownerToken());
    const payload = { app_id: "mycrm", app_secret: created.app_secret, code, redirect_uri: REDIRECT };

    expect((await exchange(payload)).status).toBe(200);
    const second = await exchange(payload);
    expect(second.status).toBe(409);
    expect(await json(second)).toMatchObject({ error: { code: "CODE_ALREADY_USED" } });
  });
});

// ══════════════════════ T155 ══════════════════════
describe("T155：code 過期（60 秒）", () => {
  it("expires_at 已過 → 400 INVALID_CODE（且不簽 token）", async () => {
    const { body: created } = await createApp();
    const { code } = await appLogin(await ownerToken());
    await E.DB.prepare("UPDATE auth_codes SET expires_at = ?1").bind(Date.now() - 1).run();

    const res = await exchange({
      app_id: "mycrm",
      app_secret: created.app_secret,
      code,
      redirect_uri: REDIRECT,
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toMatchObject({ error: { code: "INVALID_CODE" } });
  });
});

// ══════════════════════ T156 ══════════════════════
describe("T156：錯 secret", () => {
  it("→ 401 INVALID_CLIENT，且 code 不被消費（正確 secret 仍可交換）", async () => {
    const { body: created } = await createApp();
    const { code } = await appLogin(await ownerToken());

    const wrong = await exchange({
      app_id: "mycrm",
      app_secret: "wrong-secret",
      code,
      redirect_uri: REDIRECT,
    });
    expect(wrong.status).toBe(401);
    expect(await json(wrong)).toMatchObject({ error: { code: "INVALID_CLIENT" } });

    const ok = await exchange({
      app_id: "mycrm",
      app_secret: created.app_secret,
      code,
      redirect_uri: REDIRECT,
    });
    expect(ok.status).toBe(200);
  });

  it("已停用 App → 401 INVALID_CLIENT（即使 secret 正確）", async () => {
    const { body: created } = await createApp();
    const { code } = await appLogin(await ownerToken());
    const idRow = await E.DB.prepare("SELECT id FROM app_clients WHERE app_id = 'mycrm'").first<{ id: number }>();
    const disable = await req(`/api/apps/${idRow!.id}`, { method: "DELETE" }, await ownerToken());
    expect(disable.status).toBe(200);

    const res = await exchange({
      app_id: "mycrm",
      app_secret: created.app_secret,
      code,
      redirect_uri: REDIRECT,
    });
    expect(res.status).toBe(401);
    expect(await json(res)).toMatchObject({ error: { code: "INVALID_CLIENT" } });
  });
});

// ══════════════════════ T157 ══════════════════════
describe("T157：GET /api/auth/me", () => {
  it("app token → 回傳 user；mailbox token → 回傳該 user；皆不含 password_hash", async () => {
    const { body: created } = await createApp();
    const { code } = await appLogin(await ownerToken());
    const tokenRes = await exchange({
      app_id: "mycrm",
      app_secret: created.app_secret,
      code,
      redirect_uri: REDIRECT,
    });
    const { token: appToken } = await json<{ token: string }>(tokenRes);

    const viaApp = await req("/api/auth/me", {}, appToken);
    expect(viaApp.status).toBe(200);
    const appUser = await json(viaApp);
    expect(appUser).toMatchObject({
      id: OWNER_ID,
      username: OWNER_USERNAME,
      display_name: "Owner",
      role: "owner",
    });
    expect(typeof (appUser as { created_at?: unknown }).created_at).toBe("number");
    expect(appUser).not.toHaveProperty("password_hash");
    expect(appUser).not.toHaveProperty("contact_email");

    const viaMailbox = await req("/api/auth/me", {}, await mailboxToken());
    expect(viaMailbox.status).toBe(200);
    expect(await json(viaMailbox)).toEqual(appUser);

    const viaOwner = await req("/api/auth/me", {}, await ownerToken());
    expect(viaOwner.status).toBe(200);
    expect(await json(viaOwner)).toEqual(appUser);
  });
});

// ══════════════════════ T158 ══════════════════════
describe("T158：app token 不得使用信件端點", () => {
  it("GET /api/mail/inbox → 403 SCOPE_NOT_ALLOWED；mailbox token 仍正常", async () => {
    const { body: created } = await createApp();
    const { code } = await appLogin(await ownerToken());
    const { token: appToken } = await json<{ token: string }>(
      await exchange({ app_id: "mycrm", app_secret: created.app_secret, code, redirect_uri: REDIRECT })
    );

    const res = await req("/api/mail/inbox", {}, appToken);
    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ error: { code: "SCOPE_NOT_ALLOWED" } });

    const mailbox = await req("/api/mail/inbox", {}, await mailboxToken());
    expect(mailbox.status).toBe(200);
  });
});

// ══════════════════════ 額外：App 管理／限流 ══════════════════════
describe("App client 管理（PATCH／DELETE／清單）", () => {
  it("PATCH 更新名稱／redirect_uris／狀態並寫稽核；GET 反映更新", async () => {
    await createApp();
    const row = await E.DB.prepare("SELECT id FROM app_clients WHERE app_id = 'mycrm'").first<{ id: number }>();
    const newRedirect = "https://crm.example.com/auth/callback";
    const res = await req(
      `/api/apps/${row!.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ name: "CRM Prod", status: "disabled", redirect_uris: [newRedirect] }),
      },
      await ownerToken()
    );
    expect(res.status).toBe(200);
    const body = await json<{ app: { name: string; status: string; redirect_uris: string[] } }>(res);
    expect(body.app).toMatchObject({ name: "CRM Prod", status: "disabled", redirect_uris: [newRedirect] });

    const list = await json<{ apps: Array<{ app_id: string; name: string; status: string; redirect_uris: string[] }> }>(
      await req("/api/apps", {}, await ownerToken())
    );
    expect(list.apps).toHaveLength(1);
    expect(list.apps[0]).toMatchObject({ name: "CRM Prod", status: "disabled", redirect_uris: [newRedirect] });

    const audit = await E.DB.prepare("SELECT detail FROM registration_audit WHERE event = 'app_updated'")
      .first<{ detail: string }>();
    expect(JSON.parse(audit!.detail!)).toEqual({ app_id: "mycrm", name: "CRM Prod", status: "disabled" });
  });

  it("exchange 每分鐘 30 次（已達 30 次 → 429 RATE_LIMITED）", async () => {
    const { body: created } = await createApp();
    // 固定視窗計數器沿用 auth_attempts；直接種「本分鐘已 30 次」避免測試跨分鐘邊界而 flaky。
    // updated_at 刻意放在未來 2 分鐘 → 即使測試剛好跨分鐘，也不會被視為新視窗。
    const ts = Date.now() + 120_000;
    await E.DB.prepare(
      `INSERT INTO auth_attempts (key, fail_count, locked_until, updated_at)
       VALUES ('exchange:mycrm', 30, 0, ?1)
       ON CONFLICT(key) DO UPDATE SET fail_count = 30, updated_at = ?1`
    )
      .bind(ts)
      .run();

    const blocked = await exchange({
      app_id: "mycrm",
      app_secret: created.app_secret,
      code: "0".repeat(64),
      redirect_uri: REDIRECT,
    });
    expect(blocked.status).toBe(429);
    expect(await json(blocked)).toMatchObject({ error: { code: "RATE_LIMITED" } });
  });
});
