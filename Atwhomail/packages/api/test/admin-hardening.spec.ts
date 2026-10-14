/**
 * admin-hardening.spec.ts — docs/16 階段 2：D2（管理登入強制 Access JWT）＋ D7（owner 自行改密碼）
 *
 * 對應 docs/16 §6：T1–T3、T9–T11（外加過期／偽簽／iss 不符／未知 kid／JWKS 失敗／過渡放行等邊界）。
 * Access JWT 由測試**自簽**（RSA-2048），並以 `setAccessJwtTestHooks` 注入 JWKS 與時間來源
 * → 不需要真的連 Cloudflare Access。
 *
 * ⚠️ 重要：測試環境預設**沒有** `ACCESS_MAIL_AUD` → 走過渡放行，因此既有測試（113+）不受影響；
 *    本檔的每個案例都自行設定／清除環境變數與 hook，避免污染其他檔案（pool 每個檔案各自隔離）。
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { hashPassword, setAccessJwtTestHooks, type Env } from "../src/auth";

const E = env as unknown as Env;
const OWNER_USER = "owner";
const OWNER_PW = "owner-password-d2";
const ALICE_PW = "alice-password-d2";
const TEAM_DOMAIN = "team-test.cloudflareaccess.com";
const AUD = "aud-test-0123456789";
/** 固定「現在」（epoch ms）→ 自簽 JWT 的 exp/iat 可預期 */
const NOW_MS = 1_800_000_000_000;
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

// ───────── 自簽 Access JWT ─────────
let keyPair: CryptoKeyPair;
let publicJwk: JsonWebKey & { kid: string };
let jwksFetchCount = 0;

async function rotateKeys(kid = "test-kid-1"): Promise<void> {
  keyPair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  publicJwk = { ...(await crypto.subtle.exportKey("jwk", keyPair.publicKey)), kid, alg: "RS256", use: "sig" };
}

function b64url(data: string | Uint8Array): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

interface JwtOverrides {
  kid?: string;
  alg?: string;
  iss?: string;
  aud?: string | string[];
  exp?: number;
  signWith?: CryptoKey; // 用別把金鑰簽 → 測偽簽
}

async function signAccessJwt(o: JwtOverrides = {}): Promise<string> {
  const header = { alg: o.alg ?? "RS256", kid: o.kid ?? publicJwk.kid, typ: "JWT" };
  const payload = {
    iss: o.iss ?? `https://${TEAM_DOMAIN}`,
    aud: o.aud ?? AUD,
    exp: o.exp ?? Math.floor(NOW_MS / 1000) + 3600,
    iat: Math.floor(NOW_MS / 1000),
    email: "owner@example.com",
    type: "app",
  };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    o.signWith ?? keyPair.privateKey,
    new TextEncoder().encode(`${h}.${p}`)
  );
  return `${h}.${p}.${b64url(new Uint8Array(sig))}`;
}

/** 登入（可帶 Access JWT；帶了就走 D2 閘門） */
function login(username: string, password: string, accessJwt?: string): Promise<Response> {
  return req(
    "/api/auth/login",
    { method: "POST", body: JSON.stringify({ username, password }) },
    undefined,
    accessJwt ? { "cf-access-jwt-assertion": accessJwt } : {}
  );
}

beforeEach(async () => {
  jwksFetchCount = 0;
  await rotateKeys();
  setAccessJwtTestHooks({
    fetchJwks: async () => {
      jwksFetchCount++;
      return { keys: [publicJwk] };
    },
    nowMs: () => NOW_MS,
  });
  E.ACCESS_TEAM_DOMAIN = TEAM_DOMAIN;
  E.ACCESS_MAIL_AUD = AUD;

  for (const t of ["registration_audit", "invites", "attachments", "messages", "email_aliases", "email_addresses", "users", "auth_attempts"]) {
    await E.DB.prepare(`DELETE FROM ${t}`).run();
  }
  const ts = Date.now();
  await E.DB.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, status, role, created_at, updated_at)
     VALUES (1, ?1, 'Owner', ?2, 'active', 'owner', ?3, ?3)`
  )
    .bind(OWNER_USER, await cachedHash(OWNER_PW), ts)
    .run();
  await E.DB.prepare(
    `INSERT INTO email_addresses (id, user_id, local_part, domain, email, password_hash, password_changed_at, status, created_at, updated_at)
     VALUES (1, 1, 'alice', 'atwho.org', 'alice@atwho.org', ?1, ?2, 'active', ?2, ?2)`
  )
    .bind(await cachedHash(ALICE_PW), ts)
    .run();
});

afterEach(() => {
  setAccessJwtTestHooks({ fetchJwks: null, nowMs: null });
  delete E.ACCESS_MAIL_AUD;
  delete E.ACCESS_TEAM_DOMAIN;
});

describe("D2：/api/auth/login 的 Access 閘門（T1–T3）", () => {
  it("T1 沒有 Cf-Access-Jwt-Assertion → 403 ADMIN_LOGIN_REQUIRES_ACCESS", async () => {
    const res = await login(OWNER_USER, OWNER_PW);
    expect(res.status).toBe(403);
    const body = await json<{ error: { code: string; message: string } }>(res);
    expect(body.error.code).toBe("ADMIN_LOGIN_REQUIRES_ACCESS");
    expect(body.error.message).toBe("管理員登入僅能從 mail.atwho.org 進行");
  });

  it("T2 簽章有效但 aud 不符 → 403（含 aud 為陣列的情形）", async () => {
    const wrongAud = await login(OWNER_USER, OWNER_PW, await signAccessJwt({ aud: "someone-else" }));
    expect(wrongAud.status).toBe(403);
    expect((await json<{ error: { code: string } }>(wrongAud)).error.code).toBe("ADMIN_LOGIN_REQUIRES_ACCESS");

    const wrongArr = await login(OWNER_USER, OWNER_PW, await signAccessJwt({ aud: ["other", "another"] }));
    expect(wrongArr.status).toBe(403);

    const okArr = await login(OWNER_USER, OWNER_PW, await signAccessJwt({ aud: [AUD, "other"] }));
    expect(okArr.status).toBe(200); // aud 是陣列且包含本應用 → 放行
  });

  it("T3 JWT 有效且 aud 相符 → 進入既有帳密驗證（正確 200／錯誤 401）", async () => {
    const jwt = await signAccessJwt();
    const ok = await login(OWNER_USER, OWNER_PW, jwt);
    expect(ok.status).toBe(200);
    expect(await json<{ session: string }>(ok)).toMatchObject({ session: "owner" });

    const bad = await login(OWNER_USER, "wrong-password", jwt);
    expect(bad.status).toBe(401);
    expect((await json<{ error: { code: string } }>(bad)).error.code).toBe("INVALID_CREDENTIALS");
  });

  it("邊界：過期／偽簽／iss 不符／未知 kid／alg 不支援 → 一律 403", async () => {
    const expired = await login(OWNER_USER, OWNER_PW, await signAccessJwt({ exp: Math.floor(NOW_MS / 1000) - 10 }));
    expect(expired.status).toBe(403);

    const otherKeys = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"]
    )) as CryptoKeyPair;
    const forged = await login(OWNER_USER, OWNER_PW, await signAccessJwt({ signWith: otherKeys.privateKey }));
    expect(forged.status).toBe(403);

    const badIss = await login(OWNER_USER, OWNER_PW, await signAccessJwt({ iss: "https://evil.example.com" }));
    expect(badIss.status).toBe(403);

    const unknownKid = await login(OWNER_USER, OWNER_PW, await signAccessJwt({ kid: "no-such-kid" }));
    expect(unknownKid.status).toBe(403);

    const badAlg = await login(OWNER_USER, OWNER_PW, await signAccessJwt({ alg: "none" }));
    expect(badAlg.status).toBe(403);
  });

  it("邊界：JWKS 取得失敗 → fail-closed（403），且不影響後續（不快取失敗結果）", async () => {
    setAccessJwtTestHooks({ fetchJwks: async () => { throw new Error("network down"); } });
    const res = await login(OWNER_USER, OWNER_PW, await signAccessJwt());
    expect(res.status).toBe(403);

    // 恢復 JWKS → 同一支 JWT 這次要能通過（證明失敗沒有被快取）
    setAccessJwtTestHooks({ fetchJwks: async () => ({ keys: [publicJwk] }) });
    expect((await login(OWNER_USER, OWNER_PW, await signAccessJwt())).status).toBe(200);
  });

  it("邊界：JWKS 有快取（多次登入只抓一次公鑰）", async () => {
    const jwt = await signAccessJwt();
    await login(OWNER_USER, OWNER_PW, jwt);
    await login(OWNER_USER, OWNER_PW, jwt);
    await login(OWNER_USER, OWNER_PW, jwt);
    expect(jwksFetchCount).toBe(1);
  });

  it("過渡放行（回退閥門）：ACCESS_MAIL_AUD 未設定 → 無標頭仍可登入", async () => {
    delete E.ACCESS_MAIL_AUD;
    const res = await login(OWNER_USER, OWNER_PW);
    expect(res.status).toBe(200); // 移除環境變數即恢復舊行為（docs/16 §5）
  });

  it("T4 迴歸：訪客路徑不受 Access 閘門影響（設定 ACCESS_MAIL_AUD 時）", async () => {
    const mbox = await req("/api/auth/mailbox-login", {
      method: "POST",
      body: JSON.stringify({ email: "alice@atwho.org", password: ALICE_PW }),
    });
    expect(mbox.status).toBe(200);
    const token = (await json<{ token: string }>(mbox)).token;
    expect((await req("/api/me", {}, token)).status).toBe(200);
    expect((await req("/api/mail/inbox", {}, token)).status).toBe(200);
  });

  it("T5 rescue（x-admin-token）不受影響：仍可呼叫備份端點", async () => {
    const res = await req("/api/backup/changes?limit=1", {}, undefined, { "x-admin-token": ADMIN });
    expect(res.status).toBe(200);
  });
});

describe("D7：owner 自行變更密碼（T9–T11）", () => {
  const NEW_PW = "new-owner-password-9x";

  async function ownerToken(): Promise<string> {
    const res = await login(OWNER_USER, OWNER_PW, await signAccessJwt());
    return (await json<{ token: string }>(res)).token;
  }

  function changePw(token: string, oldPw: string, newPw: string): Promise<Response> {
    return req(
      "/api/auth/owner-password/self",
      { method: "PATCH", body: JSON.stringify({ old_password: oldPw, new_password: newPw }) },
      token
    );
  }

  it("T9 舊密碼錯誤 → 401 INVALID_OLD_PASSWORD", async () => {
    const token = await ownerToken();
    const res = await changePw(token, "wrong-old-password", NEW_PW);
    expect(res.status).toBe(401);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("INVALID_OLD_PASSWORD");
  });

  it("T10 新密碼不符政策 → 422 WEAK_PASSWORD；成功 → 200 且寫入稽核 owner_password_changed", async () => {
    const token = await ownerToken();
    const weak = await changePw(token, OWNER_PW, "short");
    expect(weak.status).toBe(422);
    expect((await json<{ error: { code: string } }>(weak)).error.code).toBe("WEAK_PASSWORD");

    const ok = await changePw(token, OWNER_PW, NEW_PW);
    expect(ok.status).toBe(200);
    expect(await json<{ ok: boolean }>(ok)).toMatchObject({ ok: true });

    const audit = await E.DB.prepare(
      "SELECT COUNT(*) AS n FROM registration_audit WHERE event = 'owner_password_changed' AND user_id = 1"
    ).first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it("T11 成功後舊 owner JWT 立即失效（TOKEN_STALE）；新密碼可登入、舊密碼不行", async () => {
    const token = await ownerToken();
    expect((await req("/api/me", {}, token)).status).toBe(200);

    expect((await changePw(token, OWNER_PW, NEW_PW)).status).toBe(200);

    const stale = await req("/api/me", {}, token);
    expect(stale.status).toBe(401);
    expect((await json<{ error: { code: string } }>(stale)).error.code).toBe("TOKEN_STALE");

    expect((await login(OWNER_USER, NEW_PW, await signAccessJwt())).status).toBe(200);
    expect((await login(OWNER_USER, OWNER_PW, await signAccessJwt())).status).toBe(401);
  });

  it("邊界：mailbox session 呼叫 → 403；缺欄位 → 400；猜錯 5 次 → 429 LOCKED", async () => {
    const mbox = await req("/api/auth/mailbox-login", {
      method: "POST",
      body: JSON.stringify({ email: "alice@atwho.org", password: ALICE_PW }),
    });
    const mboxToken = (await json<{ token: string }>(mbox)).token;
    expect((await changePw(mboxToken, "x", NEW_PW)).status).toBe(403);

    const token = await ownerToken();
    expect(
      (
        await req("/api/auth/owner-password/self", { method: "PATCH", body: JSON.stringify({ old_password: "x" }) }, token)
      ).status
    ).toBe(400);

    for (let i = 0; i < 5; i++) await changePw(token, "wrong-old-password", NEW_PW);
    const locked = await changePw(token, "wrong-old-password", NEW_PW);
    expect(locked.status).toBe(429);
    expect((await json<{ error: { code: string } }>(locked)).error.code).toBe("LOCKED");
  });

  it("邊界：rescue 路徑（POST /api/auth/owner-password）行為不變（N5）", async () => {
    const res = await req(
      "/api/auth/owner-password",
      { method: "POST", body: JSON.stringify({ new_password: "rescue-set-password-1" }) },
      undefined,
      { "x-admin-token": ADMIN }
    );
    expect(res.status).toBe(200);
    expect((await login(OWNER_USER, "rescue-set-password-1", await signAccessJwt())).status).toBe(200);
  });
});
