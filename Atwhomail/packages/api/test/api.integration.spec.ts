/**
 * api.integration.spec.ts — API Worker 整合測試（Phase 16）
 *
 * 在 workerd 內以真實 D1 + R2 bindings 執行（見 test/wrangler.jsonc 與 test/apply-migrations.ts）。
 * 對應 08-security-checklist.md §11 的驗證對應表：認證、越權、隔離、注入、備份端點面。
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { hashPassword, type Env } from "../src/auth";

const E = env as unknown as Env;
const OWNER_PW = "owner-password";
const ALICE_PW = "alice-password";
const BOB_PW = "bob-password";

/** 密碼雜湊很貴（argon2id ~700ms）→ 同一個密碼只算一次，測試速度差數倍 */
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
  const headers: Record<string, string> = { ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (init.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  return app.request(path, { ...init, headers }, E);
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function login(username: string, password: string): Promise<string> {
  const res = await req("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
  return ((await json<{ token?: string }>(res)).token ?? "") as string;
}

async function mailboxLogin(email: string, password: string): Promise<string> {
  const res = await req("/api/auth/mailbox-login", { method: "POST", body: JSON.stringify({ email, password }) });
  return ((await json<{ token?: string }>(res)).token ?? "") as string;
}

/** 每個測試都從乾淨資料開始（順序：子表 → 父表） */
beforeEach(async () => {
  for (const t of ["attachments", "messages", "email_aliases", "email_addresses", "users", "auth_attempts"]) {
    await E.DB.prepare(`DELETE FROM ${t}`).run();
  }
  const ts = Date.now();
  await E.DB.prepare(
    "INSERT INTO users (id, username, display_name, password_hash, status, created_at, updated_at) VALUES (1,'owner','Owner',?, 'active', ?, ?)"
  )
    .bind(await cachedHash(OWNER_PW), ts, ts)
    .run();
  await E.DB.prepare(
    `INSERT INTO email_addresses (id, user_id, local_part, domain, email, password_hash, status, password_changed_at, created_at, updated_at)
     VALUES (1, 1, 'alice', 'atwho.org', 'alice@atwho.org', ?, 'active', ?, ?, ?),
            (2, 1, 'bob',   'atwho.org', 'bob@atwho.org',   ?, 'active', ?, ?, ?)`
  )
    .bind(await cachedHash(ALICE_PW), ts, ts, ts, await cachedHash(BOB_PW), ts, ts, ts)
    .run();
  await E.DB.prepare(
    `INSERT INTO messages (id, owner_user_id, address_id, folder, message_id, from_address, to_address, cc, subject, text_preview, received_at, raw_r2_key, created_at, updated_at)
     VALUES (1, 1, 1, 'inbox', '<m1@x>', 'ext@example.com', '[{"address":"alice@atwho.org","name":""}]', '[]', 'To alice', 'p1', ?, 'mail/2026/09/m1.eml', ?, ?),
            (2, 1, 2, 'inbox', '<m2@x>', 'ext@example.com', '[{"address":"bob@atwho.org","name":""}]',   '[]', 'To bob',   'p2', ?, 'mail/2026/09/m2.eml', ?, ?)`
  )
    .bind(ts, ts, ts, ts + 1, ts + 1, ts + 1)
    .run();
});

describe("公開端點", () => {
  it("GET / 回報服務資訊", async () => {
    const res = await req("/");
    expect(res.status).toBe(200);
    expect((await json<{ service: string }>(res)).service).toBe("atwhomail-api");
  });

  it("GET /api/health 可用", async () => {
    const res = await req("/api/health");
    expect(res.status).toBe(200);
    expect((await json<{ ok: boolean }>(res)).ok).toBe(true);
  });
});

describe("認證：owner 登入與鎖定（08 §8）", () => {
  it("正確密碼 → 200 + owner session", async () => {
    const res = await req("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: OWNER_PW }) });
    const body = await json<{ session: string; user: { id: number } }>(res);
    expect(res.status).toBe(200);
    expect(body.session).toBe("owner");
    expect(body.user.id).toBe(1);
  });

  it("錯誤密碼 → 401 INVALID_CREDENTIALS", async () => {
    const res = await req("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: "nope" }) });
    expect(res.status).toBe(401);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("INVALID_CREDENTIALS");
  });

  it("缺少欄位 → 400", async () => {
    const res = await req("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner" }) });
    expect(res.status).toBe(400);
  });

  it("連續 5 次失敗 → 第 6 次 429 LOCKED（就算密碼正確）", async () => {
    for (let i = 0; i < 5; i += 1) {
      await req("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: "bad" }) });
    }
    const res = await req("/api/auth/login", { method: "POST", body: JSON.stringify({ username: "owner", password: OWNER_PW }) });
    expect(res.status).toBe(429);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("LOCKED");
  });
});

describe("認證：信箱帳號（Model C）", () => {
  it("正確信箱帳密 → mailbox session", async () => {
    const res = await req("/api/auth/mailbox-login", { method: "POST", body: JSON.stringify({ email: "alice@atwho.org", password: ALICE_PW }) });
    const body = await json<{ session: string; address: { id: number } }>(res);
    expect(res.status).toBe(200);
    expect(body.session).toBe("mailbox");
    expect(body.address.id).toBe(1);
  });

  it("未設密碼的地址無法登入（password_hash NULL）", async () => {
    await E.DB.prepare("UPDATE email_addresses SET password_hash = NULL WHERE id = 1").run();
    const res = await req("/api/auth/mailbox-login", { method: "POST", body: JSON.stringify({ email: "alice@atwho.org", password: ALICE_PW }) });
    expect(res.status).toBe(401);
  });

  it("whoami 回報 mailbox scope", async () => {
    const token = await mailboxLogin("alice@atwho.org", ALICE_PW);
    const res = await req("/api/auth/whoami", {}, token);
    expect((await json<{ session: string }>(res)).session).toBe("mailbox");
  });
});

describe("授權邊界（08 §1–2）", () => {
  it("無 token 存取 owner 端點 → 401", async () => {
    expect((await req("/api/email-addresses")).status).toBe(401);
  });

  it("mailbox session 存取 owner 端點 → 403", async () => {
    const token = await mailboxLogin("alice@atwho.org", ALICE_PW);
    expect((await req("/api/email-addresses", {}, token)).status).toBe(403);
  });

  it("mailbox session 建地址 → 403", async () => {
    const token = await mailboxLogin("alice@atwho.org", ALICE_PW);
    const res = await req("/api/email-addresses", { method: "POST", body: JSON.stringify({ local_part: "hack" }) }, token);
    expect(res.status).toBe(403);
  });

  it("mailbox 讀他人地址 → 404（不洩漏存在性）", async () => {
    const token = await mailboxLogin("alice@atwho.org", ALICE_PW);
    const res = await req("/api/email-addresses/2", {}, token);
    expect(res.status).toBe(404);
  });

  it("rescue token（x-admin-token）可執行 owner 操作", async () => {
    const res = await req("/api/email-addresses", {}, undefined, { "x-admin-token": "test-admin-token" });
    expect(res.status).toBe(200);
  });

  it("錯誤的 rescue token → 401", async () => {
    const res = await req("/api/email-addresses", {}, undefined, { "x-admin-token": "wrong" });
    expect(res.status).toBe(401);
  });
});

describe("地址 CRUD", () => {
  it("owner 建地址 → 201；重複 → 409；非法 local_part → 400；弱密碼 → 422", async () => {
    const token = await login("owner", OWNER_PW);
    const ok = await req("/api/email-addresses", { method: "POST", body: JSON.stringify({ local_part: "carol" }) }, token);
    expect(ok.status).toBe(201);

    const dup = await req("/api/email-addresses", { method: "POST", body: JSON.stringify({ local_part: "carol" }) }, token);
    expect(dup.status).toBe(409);

    const bad = await req("/api/email-addresses", { method: "POST", body: JSON.stringify({ local_part: "-bad-" }) }, token);
    expect(bad.status).toBe(400);

    const weak = await req("/api/email-addresses", { method: "POST", body: JSON.stringify({ local_part: "dave", password: "short" }) }, token);
    expect(weak.status).toBe(422);
  });

  it("軟刪除後不出現在列表（soft delete 留痕）", async () => {
    const token = await login("owner", OWNER_PW);
    const del = await req("/api/email-addresses/2", { method: "DELETE" }, token);
    expect(del.status).toBe(204);
    const list = await json<{ addresses: Array<{ id: number }> }>(await req("/api/email-addresses", {}, token));
    expect(list.addresses.map((a) => a.id)).toEqual([1]);
    const row = await E.DB.prepare("SELECT status, deleted_at FROM email_addresses WHERE id = 2").first<{ status: string; deleted_at: number }>();
    expect(row?.status).toBe("deleted");
    expect(row?.deleted_at).toBeGreaterThan(0);
  });

  it("status 只能是 active/disabled → 其他值 400", async () => {
    const token = await login("owner", OWNER_PW);
    const res = await req("/api/email-addresses/1", { method: "PATCH", body: JSON.stringify({ status: "deleted" }) }, token);
    expect(res.status).toBe(400);
  });
});

describe("信件隔離與操作（08 §11 #37–44）", () => {
  it("owner 看到全部信件；mailbox 只看到自己的", async () => {
    const ownerToken = await login("owner", OWNER_PW);
    const aliceToken = await mailboxLogin("alice@atwho.org", ALICE_PW);

    const all = await json<{ items: Array<{ id: number }> }>(await req("/api/mail/inbox", {}, ownerToken));
    expect(all.items.map((i) => i.id).sort()).toEqual([1, 2]);

    const mine = await json<{ items: Array<{ id: number; subject: string }> }>(await req("/api/mail/inbox", {}, aliceToken));
    expect(mine.items.map((i) => i.id)).toEqual([1]);
    expect(mine.items[0]!.subject).toBe("To alice");
  });

  it("mailbox 直接存取他人信件 → 404", async () => {
    const aliceToken = await mailboxLogin("alice@atwho.org", ALICE_PW);
    expect((await req("/api/mail/2", {}, aliceToken)).status).toBe(404);
    expect((await req("/api/mail/2/attachments", {}, aliceToken)).status).toBe(404);
  });

  it("已讀切換 / 封存 / 資料夾 / 軟刪除", async () => {
    const token = await mailboxLogin("alice@atwho.org", ALICE_PW);
    expect((await req("/api/mail/1/read", { method: "PATCH", body: JSON.stringify({ read: true }) }, token)).status).toBe(200);
    expect((await req("/api/mail/1/archive", { method: "PATCH" }, token)).status).toBe(200);
    expect((await req("/api/mail/1/folder", { method: "PATCH", body: JSON.stringify({ folder: "spam" }) }, token)).status).toBe(200);
    const badFolder = await req("/api/mail/1/folder", { method: "PATCH", body: JSON.stringify({ folder: "sent" }) }, token);
    expect(badFolder.status).toBe(400);
    expect((await req("/api/mail/1", { method: "DELETE" }, token)).status).toBe(204);
    expect((await req("/api/mail/1", {}, token)).status).toBe(404);
  });

  it("inbox 游標分頁（limit=1 → nextCursor）", async () => {
    const token = await login("owner", OWNER_PW);
    const page1 = await json<{ items: unknown[]; nextCursor: string | null }>(await req("/api/mail/inbox?limit=1", {}, token));
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toMatch(/^\d+_\d+$/);
    const page2 = await json<{ items: unknown[] }>(await req(`/api/mail/inbox?limit=1&cursor=${page1.nextCursor}`, {}, token));
    expect(page2.items).toHaveLength(1);
  });

  it("非法 folder → 400", async () => {
    const token = await login("owner", OWNER_PW);
    expect((await req("/api/mail/inbox?folder=bogus", {}, token)).status).toBe(400);
  });
});

describe("附件（08 §16/#22）", () => {
  it("下載附件：正確 headers 與內容；他人 mailbox → 404", async () => {
    const ts = Date.now();
    await E.DB.prepare(
      `INSERT INTO attachments (id, message_id, filename, stored_filename, content_type, size_bytes, r2_key, sha256, disposition, created_at, updated_at)
       VALUES (1, 1, 'hello.txt', '0-hello.txt', 'text/plain', 11, 'attachments/m1/0-hello.txt', NULL, 'attachment', ?, ?)`
    )
      .bind(ts, ts)
      .run();
    await E.MAIL.put("attachments/m1/0-hello.txt", new TextEncoder().encode("hello world"), {
      httpMetadata: { contentType: "text/plain" },
    });

    const aliceToken = await mailboxLogin("alice@atwho.org", ALICE_PW);
    const res = await req("/api/attachments/1", {}, aliceToken);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("content-disposition")).toContain("filename*=UTF-8''hello.txt");
    expect(await res.text()).toBe("hello world");

    const bobToken = await mailboxLogin("bob@atwho.org", BOB_PW);
    expect((await req("/api/attachments/1", {}, bobToken)).status).toBe(404);
  });

  it("備份端點金鑰白名單：path traversal → 400", async () => {
    const token = await login("owner", OWNER_PW);
    expect((await req("/api/backup/r2/object?key=../../secret", {}, token)).status).toBe(400);
    expect((await req("/api/backup/r2/objects?prefix=etc/", {}, token)).status).toBe(400);
  });
});

describe("寄信驗證（Phase 10 的防護）", () => {
  it("偽造 from（mailbox 用他人地址）→ 403", async () => {
    const aliceToken = await mailboxLogin("alice@atwho.org", ALICE_PW);
    const res = await req(
      "/api/mail/send",
      { method: "POST", body: JSON.stringify({ from: "bob@atwho.org", to: "x@example.com", subject: "s", text: "t" }) },
      aliceToken
    );
    expect(res.status).toBe(403);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("FROM_NOT_ALLOWED");
  });

  it("缺 subject → 400、缺內文 → 400、收件人過多 → 422、超大 → 413", async () => {
    const token = await mailboxLogin("alice@atwho.org", ALICE_PW);
    const base = { from: "alice@atwho.org", to: "x@example.com", text: "t" };
    expect((await req("/api/mail/send", { method: "POST", body: JSON.stringify(base) }, token)).status).toBe(400);
    expect(
      (await req("/api/mail/send", { method: "POST", body: JSON.stringify({ from: base.from, to: base.to, subject: "s" }) }, token)).status
    ).toBe(400);
    const many = { from: base.from, subject: "s", text: "t", to: Array.from({ length: 51 }, (_, i) => `u${i}@example.com`) };
    expect((await req("/api/mail/send", { method: "POST", body: JSON.stringify(many) }, token)).status).toBe(422);
    const huge = { from: base.from, to: base.to, subject: "s", text: "x".repeat(5 * 1024 * 1024 + 10) };
    expect((await req("/api/mail/send", { method: "POST", body: JSON.stringify(huge) }, token)).status).toBe(413);
  });
});

describe("密碼變更使舊 token 失效（08 #44）", () => {
  it("owner 重設後，舊 mailbox token → 401 TOKEN_STALE", async () => {
    const stale = await mailboxLogin("alice@atwho.org", ALICE_PW);
    expect((await req("/api/mail/inbox", {}, stale)).status).toBe(200);

    const ownerToken = await login("owner", OWNER_PW);
    const change = await req(
      "/api/email-addresses/1/password",
      { method: "PATCH", body: JSON.stringify({ new_password: "alice-new-password" }) },
      ownerToken
    );
    expect(change.status).toBe(200);

    const after = await req("/api/mail/inbox", {}, stale);
    expect(after.status).toBe(401);
    expect((await json<{ error: { code: string } }>(after)).error.code).toBe("TOKEN_STALE");

    expect(await mailboxLogin("alice@atwho.org", "alice-new-password")).not.toBe("");
  });

  it("剛改完密碼立即登入 → 新 token 立即可用（回歸：秒精度 iat 會誤判過期）", async () => {
    const ownerToken = await login("owner", OWNER_PW);
    const change = await req(
      "/api/email-addresses/2/password",
      { method: "PATCH", body: JSON.stringify({ new_password: "bob-brand-new-pw" }) },
      ownerToken
    );
    expect(change.status).toBe(200);
    const fresh = await mailboxLogin("bob@atwho.org", "bob-brand-new-pw");
    expect(fresh).not.toBe("");
    const res = await req("/api/mail/inbox", {}, fresh);
    expect(res.status).toBe(200); // 同一秒內簽發也不應被判為 stale
  });

  it("mailbox 本人改密碼需舊密碼", async () => {
    const token = await mailboxLogin("alice@atwho.org", ALICE_PW);
    const wrong = await req(
      "/api/email-addresses/1/password",
      { method: "PATCH", body: JSON.stringify({ new_password: "whatever-123", old_password: "bad" }) },
      token
    );
    expect(wrong.status).toBe(403);
  });
});

describe("安全標頭與健康檢查（08 §23）", () => {
  it("所有回應帶安全標頭（nosniff / DENY / no-referrer / HSTS / CSP）", async () => {
    const res = await req("/api/health");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("health 探測 D1：回 200 + db ok + 延遲", async () => {
    const res = await req("/api/health");
    const body = await json<{ ok: boolean; db: string; dbLatencyMs: number; phase: number }>(res);
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.db).toBe("ok");
    expect(typeof body.dbLatencyMs).toBe("number");
    expect(body.phase).toBe(16);
  });

  it("HTML 端點的專屬 CSP 不被中介層覆蓋", async () => {
    const ts = Date.now();
    await E.DB.prepare("UPDATE messages SET html_r2_key = 'mail/2026/09/m1.html' WHERE id = 1").run();
    await E.MAIL.put("mail/2026/09/m1.html", new TextEncoder().encode("<p>hi</p>"), {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
    });
    void ts;
    const token = await mailboxLogin("alice@atwho.org", ALICE_PW);
    const res = await req("/api/mail/1/html", {}, token);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("img-src data:");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("備份端點（Phase 13/14）", () => {
  it("/api/backup/changes 無 token → 401；有 token → 回傳 tables 與游標", async () => {
    expect((await req("/api/backup/changes")).status).toBe(401);
    const token = await login("owner", OWNER_PW);
    const body = await json<{ tables: Record<string, { cursor: string }>; created: unknown[] }>(await req("/api/backup/changes", {}, token));
    expect(Object.keys(body.tables)).toEqual(["users", "email_addresses", "email_aliases", "messages", "attachments"]);
    expect(body.tables.messages!.cursor).toMatch(/^\d+_\d+$/);
    expect(body.created.length).toBeGreaterThan(0);
  });

  it("keyset 游標可續拉（limit=1 → hasMore，游標前進）", async () => {
    const token = await login("owner", OWNER_PW);
    const first = await json<{ tables: Record<string, { cursor: string }>; hasMore: boolean }>(await req("/api/backup/changes?limit=1", {}, token));
    expect(first.hasMore).toBe(true);
    const second = await json<{ tables: Record<string, { cursor: string }> }>(
      await req(`/api/backup/changes?limit=1&c_messages=${first.tables.messages!.cursor}`, {}, token)
    );
    expect(second.tables.messages!.cursor).not.toBe(first.tables.messages!.cursor);
  });

  it("/api/backup/r2/objects 回傳 truncated 欄位", async () => {
    const token = await login("owner", OWNER_PW);
    const res = await req("/api/backup/r2/objects?prefix=mail/", {}, token);
    const body = await json<{ objects: unknown[]; truncated: boolean }>(res);
    expect(res.status).toBe(200);
    expect(Array.isArray(body.objects)).toBe(true);
    expect(typeof body.truncated).toBe("boolean");
  });
});
