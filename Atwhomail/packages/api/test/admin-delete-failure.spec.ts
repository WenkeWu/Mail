/**
 * admin-delete-failure.spec.ts — docs/16 **D13**（補強未測錯誤路徑：R2 失敗／D1 回滾）
 *
 * 對應 docs/16 §6：**T34**（R2 刪除失敗 → 仍回 200 best-effort ＋ 記 log，D1 照常刪除）與
 * **T35**（D1 `batch` 失敗 → 500 `DELETE_FAILED`「已回滾，資料未變更」，且資料確實未變）。
 *
 * ── 為什麼需要這支測試 ──
 * D9（`DELETE /api/users/:id`）與 D11（`DELETE /api/email-addresses/:id?mode=hard`）的
 * `try/catch` 語意**當時只有實作、沒有測試證明**：程式碼寫了「batch 失敗即回滾」與
 * 「R2 失敗只記 log」，但沒有人真的把失敗灌進去過。這兩種失敗都不會在日常操作中出現，
 * 一旦寫錯（例如 catch 放錯位置、順序顛倒、回錯狀態碼），線上第一次遇到就是資料半刪。
 *
 * ── 注入手法：在 **binding 邊界**抽換，不動 production 一行 ──
 * 測試是以 `app.request(path, init, E, ctx)` 直接餵環境進 Hono（見既有各 spec），
 * 所以「換掉 `env.DB`／`env.MAIL`」就等於換掉被測程式看到的依賴（dependency injection），
 * 不需要為了好測而在 production 加旗標、加 hook 或改語意（D13 明文禁止後者）：
 *
 * - **R2 失敗**：`Proxy` 包住真的 bucket，只讓 `delete()` 丟例外 → 其餘方法（`get`／`put`）照常，
 *   因此可以斷言「D1 刪了、R2 物件還在、回應仍是 200」。
 * - **D1 batch 失敗**：`Proxy` 包住真的 `DB`，在 `batch()` 的**尾端**插入一句必定失敗的 SQL。
 *   關鍵在於**前幾句真的執行了**（soft 的 UPDATE、DELETE…）→ 若 D1 的交易沒有回滾，
 *   `deleted_at` 就會被寫進去、列就會少掉 → 測試會紅。也就是說這裡驗的是**真的回滾**，
 *   而不是「根本沒執行所以看起來沒事」。
 *
 * ⚠️ production 行為語意未因本檔改動任何一行（`packages/api/src/*` 無 diff）。
 * ⚠️ 測試環境未設定 `ACCESS_MAIL_AUD` → `/api/auth/login` 走 D2 的過渡放行（與其他測試檔一致）。
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { hashPassword, type Env } from "../src/auth";

const E = env as unknown as Env;
const OWNER_PW = "owner-password-d13";
const VISITOR_PW = "visitor-password-d13";

const hashCache = new Map<string, Promise<string>>();
function cachedHash(pw: string): Promise<string> {
  let h = hashCache.get(pw);
  if (!h) {
    h = hashPassword(pw);
    hashCache.set(pw, h);
  }
  return h;
}

/**
 * 對 `app.request` 發請求。`overrideEnv` 就是 D13 的注入點：
 * 以 `Object.create(E)` 為底（其餘 binding 全部沿用真環境），只覆寫指定的那一個。
 */
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

// ───────────────────────── 注入用的假 binding ─────────────────────────

interface FailingBucket {
  bucket: R2Bucket;
  /** 每一次被呼叫的 key 清單（證明真的有試著刪） */
  attempts: string[][];
}

/** 真的 bucket ＋ 只讓 `delete()` 丟例外（模擬 R2 故障／權限問題／網路中斷） */
function bucketFailingOnDelete(real: R2Bucket): FailingBucket {
  const attempts: string[][] = [];
  const bucket = new Proxy(real, {
    get(target, prop) {
      if (prop === "delete") {
        return async (keys: string | string[]) => {
          attempts.push(Array.isArray(keys) ? keys : [keys]);
          throw new Error("injected: R2 delete unavailable");
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as R2Bucket;
  return { bucket, attempts };
}

type BatchFailureMode = "rollback" | "throw" | "ok";

/**
 * 真的 DB ＋ 攔截 `batch()`：
 * - `"rollback"`：尾端追加一句必定失敗的 SQL —— 前面的語句**真的執行**，由 D1 交易負責回滾。
 * - `"throw"`：`batch()` 直接丟例外（例如 D1 連不上），任何語句都沒執行。
 * - `"ok"`：完全照原樣（對照組）。
 */
function dbWithBatchFailure(real: D1Database, mode: BatchFailureMode): D1Database {
  if (mode === "ok") return real;
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "batch") {
        return async (stmts: D1PreparedStatement[]) => {
          if (mode === "throw") throw new Error("injected: D1 batch unavailable");
          return target.batch([...stmts, target.prepare("SELECT * FROM __d13_missing_table__")]);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

// ───────────────────────── 種資料 ─────────────────────────

async function seedActor(): Promise<void> {
  const ts = Date.now();
  await E.DB.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, status, role, created_at, updated_at)
     VALUES (1, 'owner', 'Owner', ?1, 'active', 'owner', ?2, ?2)`
  )
    .bind(await cachedHash(OWNER_PW), ts)
    .run();
}

/** 在 owner（users.id = 1）名下種一個地址（跳過 argon2 以維持測試速度） */
async function seedOwnerAddress(localPart: string, userId = 1): Promise<number> {
  const ts = Date.now();
  const res = await E.DB.prepare(
    `INSERT INTO email_addresses
       (user_id, local_part, domain, email, password_hash, password_changed_at, status,
        can_send, daily_send_quota, sent_today, quota_reset_at, created_at, updated_at)
     VALUES (?1, ?2, 'atwho.org', ?3, NULL, 0, 'active', 1, 50, 0, ?4, ?4, ?4)`
  )
    .bind(userId, localPart, `${localPart}@atwho.org`, ts)
    .run();
  return Number(res.meta.last_row_id);
}

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

/** 種一封信（同時在 R2 放好 raw／html 物件，供刪除後驗證物件狀態） */
async function seedMessage(opts: {
  addressId: number;
  ownerUserId?: number;
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
     VALUES (?1, ?2, 'inbox', NULL, 'sender@example.com', '[]', 's', 'p', ?3, ?4, ?5, ?3, ?3, NULL)`
  )
    .bind(opts.ownerUserId ?? 1, opts.addressId, ts, opts.rawKey, opts.htmlKey ?? null)
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

async function auditCount(event: string): Promise<number> {
  return count("SELECT COUNT(*) AS n FROM registration_audit WHERE event = ?1", event);
}

async function ownerToken(): Promise<string> {
  const res = await req("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username: "owner", password: OWNER_PW }),
  });
  return (await json<{ token?: string }>(res)).token ?? "";
}

/** 攔截 `console.error`（D13 要求「失敗要記 log」）；回傳蒐集到的訊息 */
function captureConsoleError(): { messages: () => string[] } {
  const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  return {
    messages: () => spy.mock.calls.map((args) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")),
  };
}

/** 把「D9 的一位訪客」整套資料種好：地址／信件／附件／別名／登入計數／R2 物件 */
async function seedVisitorWithMail(opts: { email: string; prefix: string }) {
  const { userId, addressId } = await seedVisitor(opts.email);
  const rawKey = `mail/2026/10/${opts.prefix}.eml`;
  const htmlKey = `mail/2026/10/${opts.prefix}.html`;
  const attKey = `att/2026/10/${opts.prefix}.pdf`;
  const messageId = await seedMessage({ addressId, ownerUserId: userId, rawKey, htmlKey });
  await seedAttachment(messageId, attKey);
  await seedAlias(`alias-${opts.prefix}@atwho.org`, addressId);
  await seedAttempts(`mailbox:${opts.email}`);
  return { userId, addressId, messageId, rawKey, htmlKey, attKey };
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
  await seedActor();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ══════════════════════ T34：R2 刪除失敗 → best-effort（仍 200） ══════════════════════
describe("T34：R2 刪除失敗（bucket.delete 丟例外）→ 仍回 200（best-effort）＋ 記 log，D1 照常刪除", () => {
  it("D9 刪除訪客：R2 掛掉仍 200；D1 的帳號／地址／信件／附件全數刪除；物件留在 R2；有記 log", async () => {
    const v = await seedVisitorWithMail({ email: "r2fail34@atwho.org", prefix: "r2fail34" });
    const token = await ownerToken();
    const { bucket, attempts } = bucketFailingOnDelete(E.MAIL);
    const logs = captureConsoleError();

    const res = await req(`/api/users/${v.userId}`, { method: "DELETE" }, token, { MAIL: bucket });

    // ① best-effort：R2 壞掉不影響回應碼 —— owner 不該因為雲端物件刪不掉就以為「訪客沒刪掉」
    expect(res.status).toBe(200);
    expect((await json<{ ok: boolean }>(res)).ok).toBe(true);

    // ② D1 資料照常刪除（R2 的失敗不進交易、不影響 D1）
    expect(await count("SELECT COUNT(*) AS n FROM users WHERE id = ?1", v.userId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM email_addresses WHERE id = ?1", v.addressId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE address_id = ?1", v.addressId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM attachments WHERE r2_key = ?1", v.attKey)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM email_aliases WHERE target_email_address_id = ?1", v.addressId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM auth_attempts WHERE key = ?1", "mailbox:r2fail34@atwho.org")).toBe(0);

    // ③ 稽核照寫（且記下 r2_objects: 0，誠實反映「一個都沒刪掉」）
    expect(await auditCount("user_deleted")).toBe(1);

    // ④ 物件確實還在 R2（＝delete 真的失敗了，不是我們誤判）＋ 真的有試著刪
    expect(await E.MAIL.get(v.rawKey)).not.toBeNull();
    expect(await E.MAIL.get(v.attKey)).not.toBeNull();
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.flat().sort()).toEqual([v.attKey, v.htmlKey, v.rawKey].sort());

    // ⑤ 有記 log（owner／助手日後才知道有孤兒物件要清）
    expect(logs.messages().some((m) => m.includes("R2 delete failed"))).toBe(true);
  });

  it("D11 hard 刪除地址：R2 掛掉仍 200；回報 r2_objects=0 但 messages 等數量正確；D1 該列已移除", async () => {
    const addr = await seedOwnerAddress("r2fail34b");
    const rawKey = "mail/2026/10/r2fail34b.eml";
    const messageId = await seedMessage({ addressId: addr, rawKey });
    await seedAttachment(messageId, "att/2026/10/r2fail34b.pdf");
    const token = await ownerToken();
    const { bucket, attempts } = bucketFailingOnDelete(E.MAIL);
    const logs = captureConsoleError();

    const res = await req(`/api/email-addresses/${addr}?mode=hard`, { method: "DELETE" }, token, { MAIL: bucket });

    expect(res.status).toBe(200);
    const body = await json<{ deleted: { messages: number; attachments: number; r2_objects: number } }>(res);
    expect(body.deleted.messages).toBe(1);
    expect(body.deleted.attachments).toBe(1);
    expect(body.deleted.r2_objects).toBe(0); // R2 全失敗 → 誠實回 0（不是假裝成功）

    expect(await count("SELECT COUNT(*) AS n FROM email_addresses WHERE id = ?1", addr)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE address_id = ?1", addr)).toBe(0);
    expect(await E.MAIL.get(rawKey)).not.toBeNull(); // 物件仍在
    expect(attempts.flat()).toContain(rawKey);

    // 名稱仍必須被釋放（D11-2）：hard 的「移除該列」在 D1，與 R2 是否成功無關
    const recreate = await req(
      "/api/email-addresses",
      { method: "POST", body: JSON.stringify({ local_part: "r2fail34b" }) },
      token
    );
    expect(recreate.status).toBe(201);

    expect(await auditCount("address_deleted")).toBe(1);
    expect(logs.messages().some((m) => m.includes("R2 delete failed"))).toBe(true);
  });

  it("對照組：R2 正常時刪除成功且回報 r2_objects 等於實際清除數（證明上面 0 是失敗造成）", async () => {
    const addr = await seedOwnerAddress("r2ok34c");
    const rawKey = "mail/2026/10/r2ok34c.eml";
    await seedMessage({ addressId: addr, rawKey });
    const token = await ownerToken();

    const res = await req(`/api/email-addresses/${addr}?mode=hard`, { method: "DELETE" }, token);
    expect(res.status).toBe(200);
    expect((await json<{ deleted: { r2_objects: number } }>(res)).deleted.r2_objects).toBe(1);
    expect(await E.MAIL.get(rawKey)).toBeNull();
  });
});

// ══════════════════════ T35：D1 batch 失敗 → 500 ＋ 回滾 ══════════════════════
describe("T35：D1 batch 失敗 → 500 DELETE_FAILED（已回滾，資料未變更）且資料確實未變", () => {
  it("D9 刪除訪客：batch 失敗 → 500＋訊息明講已回滾；帳號／地址／信件／附件／別名／計數全部原封不動", async () => {
    const v = await seedVisitorWithMail({ email: "d1fail35@atwho.org", prefix: "d1fail35" });
    const token = await ownerToken();
    const db = dbWithBatchFailure(E.DB, "rollback");
    const logs = captureConsoleError();

    const res = await req(`/api/users/${v.userId}`, { method: "DELETE" }, token, { DB: db });

    expect(res.status).toBe(500);
    const body = await json<ErrBody>(res);
    expect(body.error.code).toBe("DELETE_FAILED");
    expect(body.error.message).toBe("刪除失敗（已回滾，資料未變更）");
    // 不洩漏 SQL 細節
    expect(body.error.message).not.toContain("__d13_missing_table__");

    // 資料確實未變更（前幾句 DELETE 真的執行過，全靠交易回滾）
    expect(await count("SELECT COUNT(*) AS n FROM users WHERE id = ?1", v.userId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM email_addresses WHERE id = ?1", v.addressId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE id = ?1", v.messageId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM attachments WHERE r2_key = ?1", v.attKey)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM email_aliases WHERE target_email_address_id = ?1", v.addressId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM auth_attempts WHERE key = ?1", "mailbox:d1fail35@atwho.org")).toBe(1);

    // 失敗不得寫「已刪除」的稽核、也不得動到 R2 物件
    expect(await auditCount("user_deleted")).toBe(0);
    expect(await E.MAIL.get(v.rawKey)).not.toBeNull();
    expect(logs.messages().some((m) => m.includes("user delete failed"))).toBe(true);
  });

  it("D11 hard：batch 失敗 → 500＋訊息明講已回滾；連批次內的 soft 標記都被回滾（deleted_at 仍為 NULL）", async () => {
    const addr = await seedOwnerAddress("d1fail35b");
    const rawKey = "mail/2026/10/d1fail35b.eml";
    const messageId = await seedMessage({ addressId: addr, rawKey });
    await seedAttachment(messageId, "att/2026/10/d1fail35b.pdf");
    const token = await ownerToken();
    const db = dbWithBatchFailure(E.DB, "rollback");
    const logs = captureConsoleError();

    const res = await req(`/api/email-addresses/${addr}?mode=hard`, { method: "DELETE" }, token, { DB: db });

    expect(res.status).toBe(500);
    const body = await json<ErrBody>(res);
    expect(body.error.code).toBe("DELETE_FAILED");
    expect(body.error.message).toBe("永久刪除失敗（已回滾，資料未變更）");

    const row = await E.DB.prepare("SELECT status, deleted_at FROM email_addresses WHERE id = ?1")
      .bind(addr)
      .first<{ status: string; deleted_at: number | null }>();
    expect(row?.status).toBe("active"); // 批次內第一步的 soft 更新也被回滾
    expect(row?.deleted_at).toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE address_id = ?1", addr)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM attachments WHERE message_id = ?1", messageId)).toBe(1);
    expect(await auditCount("address_deleted")).toBe(0);
    expect(await E.MAIL.get(rawKey)).not.toBeNull();
    expect(logs.messages().some((m) => m.includes("address hard delete failed"))).toBe(true);
  });

  it("batch 直接丟例外（D1 連不上；任何語句都沒執行）→ 同樣 500 且資料未變更", async () => {
    const v = await seedVisitorWithMail({ email: "d1throw35c@atwho.org", prefix: "d1throw35c" });
    const token = await ownerToken();
    const db = dbWithBatchFailure(E.DB, "throw");
    captureConsoleError();

    const res = await req(`/api/users/${v.userId}`, { method: "DELETE" }, token, { DB: db });

    expect(res.status).toBe(500);
    expect((await json<ErrBody>(res)).error.message).toBe("刪除失敗（已回滾，資料未變更）");
    expect(await count("SELECT COUNT(*) AS n FROM users WHERE id = ?1", v.userId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE id = ?1", v.messageId)).toBe(1);
    expect(await auditCount("user_deleted")).toBe(0);
  });

  it("對照組：同一個端點在 DB 正常時回 200（證明上面的 500 是注入的失敗造成，不是端點本來就壞）", async () => {
    const v = await seedVisitorWithMail({ email: "d1ok35d@atwho.org", prefix: "d1ok35d" });
    const token = await ownerToken();

    const res = await req(`/api/users/${v.userId}`, { method: "DELETE" }, token, { DB: dbWithBatchFailure(E.DB, "ok") });

    expect(res.status).toBe(200);
    expect(await count("SELECT COUNT(*) AS n FROM users WHERE id = ?1", v.userId)).toBe(0);
    expect(await auditCount("user_deleted")).toBe(1);
    expect(await E.MAIL.get(v.rawKey)).toBeNull(); // R2 正常 → 物件一併清除
  });
});
