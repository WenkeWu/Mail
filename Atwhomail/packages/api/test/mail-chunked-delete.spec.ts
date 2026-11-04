/**
 * mail-chunked-delete.spec.ts — docs/19 **D19-5**（D1 `too many SQL variables`）
 *
 * 對應 docs/19 §7：
 * - **T84** `trash/empty` 131 封（> D1 的 100 參數上限）→ 200、`count=131`、DB 無殘留、
 *   R2 刪除筆數正確（分塊 90＋41，兩次 `bucket.delete`）
 * - **T85** `batch {action:'purge', ids}` 150 個 id → 成功（權限查詢與硬刪都分塊）
 * - **T86** 第二塊 R2 刪除失敗 → 第一塊已刪（不回滾）、第二塊 DB 不動、API 回 500，
 *   回應帶部分完成數量
 * - **T87** `trash/empty` 邊界：500 封成功；501 封 → 400 `TRASH_TOO_LARGE` 且一封都不刪
 *
 * ── 為什麼需要「假 D1 上限」──
 * 正式 D1 每條查詢最多綁定 100 個參數，但 miniflare 內部的 SQLite 預設允許遠多於此，
 * 所以「131 個 id 能跑完」在測試環境**不採用**分塊也會通過 —— 那樣的測試證明不了修正。
 * `dbWithBindLimit()` 在 binding 邊界模擬 production 的限制：任一 `.bind()` 超過 100 個值
 * 就丟出與 wrangler tail 相同的錯誤。T84／T85 若忘記分塊會直接失敗。
 *
 * ⚠️ production 行為未因測試改動任何一行；全程本機 workerd，不觸及遠端 D1／R2。
 * ⚠️ 測試環境未設定 `ACCESS_MAIL_AUD` → `/api/auth/login` 走 D2 的過渡放行（與其他測試檔一致）。
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { hashPassword, type Env } from "../src/auth";

const E = env as unknown as Env;
const ALICE_PW = "alice-password-d19-5";

const hashCache = new Map<string, Promise<string>>();
function cachedHash(pw: string): Promise<string> {
  let h = hashCache.get(pw);
  if (!h) {
    h = hashPassword(pw);
    hashCache.set(pw, h);
  }
  return h;
}

/** 發請求；`overrideEnv` 用於注入模擬 D1 上限／R2 故障的 binding。 */
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
const codeOf = async (res: Response): Promise<string> => (await json<ErrBody>(res)).error.code;

// ───────────────────────── 假 binding（在邊界注入，不改 production） ─────────────────────────

/**
 * 真的 DB ＋ production D1 的「每條查詢 100 個綁定參數」限制。
 * `.bind()` 超過上限即丟出與正式環境相同的錯誤（`too many SQL variables`）。
 * `batch()` 收到的 statement 會先還原成原生物件再交給 D1（Proxy 不會流進 workerd）。
 */
function dbWithBindLimit(real: D1Database, max = 100): D1Database {
  const originals = new WeakMap<object, D1PreparedStatement>();
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          const stmt = target.prepare(sql);
          const wrapped = new Proxy(stmt, {
            get(st, key) {
              if (key === "bind") {
                return (...values: unknown[]) => {
                  if (values.length > max) {
                    throw new Error("D1_ERROR: too many SQL variables at offset 0: SQLITE_ERROR");
                  }
                  return stmt.bind(...values);
                };
              }
              const value = Reflect.get(st, key);
              return typeof value === "function" ? value.bind(st) : value;
            },
          });
          originals.set(wrapped, stmt);
          return wrapped;
        };
      }
      if (prop === "batch") {
        return (stmts: D1PreparedStatement[]) => target.batch(stmts.map((s) => originals.get(s) ?? s));
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
}

interface RecordingBucket {
  bucket: R2Bucket;
  /** 每次 `delete()` 收到的 key 清單（用來斷言分塊大小） */
  calls: string[][];
}

/** 真的 bucket ＋ 記錄每次 `delete()`；`failOnCall` 指定第幾次呼叫時失敗。 */
function recordingBucket(real: R2Bucket, failOnCall?: number): RecordingBucket {
  const calls: string[][] = [];
  const bucket = new Proxy(real, {
    get(target, prop) {
      if (prop === "delete") {
        return async (keys: string | string[]) => {
          calls.push(Array.isArray(keys) ? [...keys] : [keys]);
          if (failOnCall !== undefined && calls.length === failOnCall) {
            throw new Error("injected: R2 delete failed");
          }
          await target.delete(keys);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as R2Bucket;
  return { bucket, calls };
}

// ───────────────────────── 種資料 ─────────────────────────

const put = (key: string, body = "blob") => E.MAIL.put(key, new TextEncoder().encode(body));
const exists = async (key: string): Promise<boolean> => (await E.MAIL.head(key)) !== null;

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await E.DB.prepare(sql)
    .bind(...binds)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

const lastAudit = (event: string) =>
  E.DB.prepare(
    "SELECT detail FROM registration_audit WHERE event = ?1 ORDER BY id DESC LIMIT 1"
  )
    .bind(event)
    .first<{ detail: string | null }>();

/**
 * 以一個 recursive CTE 種入 `count` 封信（id = startId + 0…count-1）。
 * 全部屬於 Alice（address_id = 1），`deleted_at IS NULL`。
 */
async function seedMessages(opts: {
  startId: number;
  count: number;
  folder: string;
  keyPrefix: string;
}): Promise<number[]> {
  const ts = Date.now();
  await E.DB.prepare(
    `INSERT INTO messages
       (id, owner_user_id, address_id, folder, message_id, from_address, to_address, cc, subject,
        text_preview, received_at, raw_r2_key, created_at, updated_at, deleted_at)
     SELECT CAST(?2 + x AS INTEGER), 1, 1, ?4, NULL, 'sender@example.com', '[]', '[]', 'subject', 'preview', ?1,
            ?3 || CAST(?2 + x AS INTEGER) || '.eml', ?1, ?1, NULL
     FROM (WITH RECURSIVE cnt(x) AS (SELECT 0 UNION ALL SELECT x + 1 FROM cnt WHERE x < ?5)
           SELECT x FROM cnt)`
  )
    .bind(ts, opts.startId, opts.keyPrefix, opts.folder, opts.count - 1)
    .run();
  return Array.from({ length: opts.count }, (_, i) => opts.startId + i);
}

let alice = "";

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
  const listed = await E.MAIL.list();
  if (listed.objects.length > 0) await E.MAIL.delete(listed.objects.map((o) => o.key));

  const ts = Date.now();
  await E.DB.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, status, role, created_at, updated_at)
     VALUES (1, 'owner', 'Owner', ?1, 'active', 'owner', ?2, ?2)`
  )
    .bind("unused-owner-password-hash", ts)
    .run();
  await E.DB.prepare(
    `INSERT INTO email_addresses
       (id, user_id, local_part, domain, email, password_hash, password_changed_at, status,
        can_send, daily_send_quota, sent_today, quota_reset_at, created_at, updated_at)
     VALUES (1, 1, 'alice', 'atwho.org', 'alice@atwho.org', ?1, ?2, 'active', 1, 20, 0, ?2, ?2, ?2)`
  )
    .bind(await cachedHash(ALICE_PW), ts)
    .run();

  const res = await req(
    "/api/auth/mailbox-login",
    { method: "POST", body: JSON.stringify({ email: "alice@atwho.org", password: ALICE_PW }) }
  );
  alice = ((await json<{ token?: string }>(res)).token ?? "") as string;
});

// ══════════════════════ T84：trash/empty 131 封 ══════════════════════

describe("T84：trash/empty 在 131 封（>100）時成功", () => {
  it("分塊 90＋41 刪除；回傳 count=131、DB 無殘留、R2 刪除筆數正確", async () => {
    const ids = await seedMessages({ startId: 1000, count: 131, folder: "trash", keyPrefix: "mail/t84/" });
    // 只需實際存在少數物件：刪除請求的 key 由 `r2.calls` 完整驗證（131 個），
    // 這 3 個代表「第一塊頭尾＋第二塊尾」，證明 R2 真的被清掉。
    const materialized = [1000, 1089, 1130];
    for (const id of materialized) await put(`mail/t84/${id}.eml`);

    const r2 = recordingBucket(E.MAIL);
    const res = await req("/api/mail/trash/empty", { method: "POST" }, alice, {
      DB: dbWithBindLimit(E.DB, 100), // 若未分塊 → 131 個參數 → 這裡直接丟錯
      MAIL: r2.bucket,
    });

    expect(res.status).toBe(200);
    expect(await json<{ count: number; r2_objects: number }>(res)).toEqual({ count: 131, r2_objects: 131 });

    // DB 無殘留
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE address_id = 1")).toBe(0);

    // R2：每塊一次 delete（90／41），總共 131 個物件且真的清空
    expect(r2.calls.map((c) => c.length)).toEqual([90, 41]);
    expect(r2.calls.flat()).toEqual(ids.map((id) => `mail/t84/${id}.eml`));
    for (const id of materialized) expect(await exists(`mail/t84/${id}.eml`)).toBe(false);
    expect((await E.MAIL.list()).objects).toEqual([]);
    expect((await lastAudit("trash_emptied"))?.detail).toBe(
      JSON.stringify({ count: 131, r2_objects: 131, form_instances: 0 })
    );
  });
});

// ══════════════════════ T85：batch purge 150 個 id ══════════════════════

describe("T85：batch purge 在 150 個 id（>100）時成功", () => {
  it("權限查詢、SELECT keys 與 DELETE 全部 ≤90 個綁定參數", async () => {
    const ids = await seedMessages({ startId: 2000, count: 150, folder: "inbox", keyPrefix: "mail/t85/" });

    const res = await req(
      "/api/mail/batch",
      { method: "POST", body: JSON.stringify({ action: "purge", ids }) },
      alice,
      { DB: dbWithBindLimit(E.DB, 100) }
    );

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true, action: "purge", count: 150 });
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE id BETWEEN 2000 AND 2149")).toBe(0);
    expect((await lastAudit("mail_batch"))?.detail).toBe(JSON.stringify({ action: "purge", count: 150 }));
  });
});

// ══════════════════════ T86：某一塊 R2 失敗 ══════════════════════

describe("T86：分塊過程中第二塊 R2 刪除失敗", () => {
  it("第一塊已刪（不回滾）、第二塊 DB 不動、回 500 並回報部分完成", async () => {
    await seedMessages({ startId: 3000, count: 131, folder: "trash", keyPrefix: "mail/t86/" });

    const r2 = recordingBucket(E.MAIL, 2); // 第二次 bucket.delete（第二塊）丟例外
    const res = await req("/api/mail/trash/empty", { method: "POST" }, alice, {
      DB: dbWithBindLimit(E.DB, 100),
      MAIL: r2.bucket,
    });

    expect(res.status).toBe(500);
    const body = await json<
      ErrBody & { deleted: { messages: number; attachments: number; form_instances: number; r2_objects: number } }
    >(res);
    expect(body.error.code).toBe("DELETE_FAILED");
    expect(body.error.message).toContain("部分完成：已刪除 90 封");
    // 第一塊的 90 個 R2 物件已刪；第二塊的 R2 刪除失敗 → 不計入
    expect(body.deleted).toEqual({ messages: 90, attachments: 0, form_instances: 0, r2_objects: 90 });

    // 第一塊（90 封）已刪除、第二塊（41 封）完全沒動 → 已完成的塊不回滾
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE id BETWEEN 3000 AND 3089")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE id BETWEEN 3090 AND 3130")).toBe(41);
    // 第二塊的 R2 嘗試確實發生（失敗在真正刪除之前）
    expect(r2.calls.map((c) => c.length)).toEqual([90, 41]);
    // 失敗不寫稽核（只有成功的完整操作才寫）
    expect(await lastAudit("trash_emptied")).toBeNull();
  });
});

// ══════════════════════ T87：500／501 邊界 ══════════════════════

describe("T87：trash/empty 的 500 封上限邊界", () => {
  it("剛好 500 封 → 200、count=500、全部清除", async () => {
    await seedMessages({ startId: 4000, count: 500, folder: "trash", keyPrefix: "mail/t87a/" });

    const res = await req("/api/mail/trash/empty", { method: "POST" }, alice);
    expect(res.status).toBe(200);
    expect((await json<{ count: number }>(res)).count).toBe(500);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE folder = 'trash'")).toBe(0);
  });

  it("501 封 → 400 TRASH_TOO_LARGE，一封都不刪、R2 也不呼叫", async () => {
    await seedMessages({ startId: 5000, count: 501, folder: "trash", keyPrefix: "mail/t87b/" });

    const r2 = recordingBucket(E.MAIL);
    const res = await req("/api/mail/trash/empty", { method: "POST" }, alice, { MAIL: r2.bucket });

    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe("TRASH_TOO_LARGE");
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE folder = 'trash'")).toBe(501);
    expect(r2.calls).toEqual([]);
  });
});
