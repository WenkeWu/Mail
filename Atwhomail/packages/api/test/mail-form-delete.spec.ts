/**
 * mail-form-delete.spec.ts — docs/19 **D19-6**（永久刪信撞到 form FK）
 *
 * 對應 docs/19 §8：
 * - **T88** 永久刪除「有 open `form_instance`」的信 → 200，`messages`／`form_instances`／
 *   `form_responses` 一併清空（無 `FOREIGN KEY constraint failed`）
 * - **T89** 永久刪除「有已提交 `form_response`」的信 → 200，三表皆清空
 * - **T90** `trash/empty` 混合 131 封（含表單信）＋ `dbWithBindLimit()` 模擬 D1 的 100 參數上限 → 200
 * - **T91** `form_responses` 刪除失敗（batch 內注入失敗語句）→ 該塊整批回滾（messages 仍在）、
 *   500 `DELETE_FAILED`、DB 未變、不寫稽核
 *
 * 根因：`form_instances.message_id REFERENCES messages(id)`、
 * `form_responses.instance_id REFERENCES form_instances(id)`；硬刪只刪 attachments → messages
 * 會讓整塊 D1 batch 因 FK 失敗而回滾（wrangler tail：`FOREIGN KEY constraint failed`）。
 * 修正：同一個 batch 內依子 → 父順序 `form_responses` → `form_instances` → `attachments` → `messages`。
 *
 * ⚠️ 全程本機 workerd（真實 D1／R2），不觸及遠端；測試環境未設定 `ACCESS_MAIL_AUD`
 *    → `/api/auth/mailbox-login` 走 D2 的過渡放行（與其他測試檔一致）。
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { hashPassword, type Env } from "../src/auth";

const E = env as unknown as Env;
const ALICE_PW = "alice-password-d19-6";

const hashCache = new Map<string, Promise<string>>();
function cachedHash(pw: string): Promise<string> {
  let h = hashCache.get(pw);
  if (!h) {
    h = hashPassword(pw);
    hashCache.set(pw, h);
  }
  return h;
}

/** 發請求；`overrideEnv` 用於注入模擬 D1 上限／batch 失敗的 binding。 */
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

/**
 * T91：讓 batch 的第一句（＝`DELETE FROM form_responses`）失敗。
 * 其餘語句仍會在同一交易內執行，然後由 D1 全部回滾 → 驗證「該塊 DB 不動」。
 */
function dbWithFormDeleteFailure(real: D1Database): D1Database {
  return new Proxy(real, {
    get(target, prop) {
      if (prop === "batch") {
        return async (stmts: D1PreparedStatement[]) =>
          target.batch([target.prepare("DELETE FROM __d19_6_missing_form_child__"), ...stmts.slice(1)]);
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as D1Database;
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
    "SELECT detail, user_id, address_id FROM registration_audit WHERE event = ?1 ORDER BY id DESC LIMIT 1"
  )
    .bind(event)
    .first<{ detail: string | null; user_id: number | null; address_id: number | null }>();

async function seedMessage(opts: { id: number; folder?: string; keyPrefix: string }): Promise<void> {
  const ts = Date.now();
  await E.DB.prepare(
    `INSERT INTO messages
       (id, owner_user_id, address_id, folder, message_id, from_address, to_address, cc, subject,
        text_preview, received_at, raw_r2_key, created_at, updated_at, deleted_at)
     VALUES (?1, 1, 1, ?2, NULL, 'sender@example.com', '[]', '[]', 'form mail', 'preview', ?3,
             ?4 || CAST(?1 AS INTEGER) || '.eml', ?3, ?3, NULL)`
  )
    .bind(opts.id, opts.folder ?? "inbox", ts, opts.keyPrefix)
    .run();
}

/** 以一個 recursive CTE 種入 `count` 封 Alice 的信（id = startId + 0…count-1）。 */
async function seedBulkMessages(opts: {
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

async function seedTemplate(key: string): Promise<number> {
  const res = await E.DB.prepare(
    "INSERT INTO form_templates (key, version, schema_json, created_at) VALUES (?1, 1, '{}', ?2)"
  )
    .bind(key, Date.now())
    .run();
  return Number(res.meta.last_row_id);
}

async function seedInstance(opts: {
  templateId: number;
  messageId: number;
  status: "open" | "submitted" | "revoked" | "expired";
}): Promise<number> {
  const ts = Date.now() - 60_000;
  const res = await E.DB.prepare(
    `INSERT INTO form_instances
       (template_id, message_id, sender_address_id, recipient_address_id, status, due_at, created_at, updated_at)
     VALUES (?1, ?2, 2, 1, ?3, NULL, ?4, ?4)`
  )
    .bind(opts.templateId, opts.messageId, opts.status, ts)
    .run();
  return Number(res.meta.last_row_id);
}

async function seedResponse(instanceId: number, responderUserId = 1): Promise<void> {
  await E.DB.prepare(
    "INSERT INTO form_responses (instance_id, responder_user_id, payload_json, submitted_at) VALUES (?1, ?2, ?3, ?4)"
  )
    .bind(instanceId, responderUserId, '{"answer":"x"}', Date.now() - 30_000)
    .run();
}

let alice = "";

beforeEach(async () => {
  // 依 FK 由子到父清表（form_responses → form_instances → form_templates → …）
  for (const t of [
    "form_responses",
    "form_instances",
    "form_templates",
    "attachments",
    "messages",
    "registration_audit",
    "invites",
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
  const hash = await cachedHash(ALICE_PW);
  await E.DB.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, status, role, created_at, updated_at)
     VALUES (1, 'owner', 'Owner', 'unused-owner-password-hash', 'active', 'owner', ?1, ?1)`
  )
    .bind(ts)
    .run();
  await E.DB.prepare(
    `INSERT INTO email_addresses
       (id, user_id, local_part, domain, email, password_hash, password_changed_at, status,
        can_send, daily_send_quota, sent_today, quota_reset_at, created_at, updated_at)
     VALUES (1, 1, 'alice', 'atwho.org', 'alice@atwho.org', ?1, ?2, 'active', 1, 20, 0, ?2, ?2, ?2),
            (2, 1, 'sender', 'atwho.org', 'sender@atwho.org', ?1, ?2, 'active', 1, 20, 0, ?2, ?2, ?2)`
  )
    .bind(hash, ts)
    .run();

  const res = await req(
    "/api/auth/mailbox-login",
    { method: "POST", body: JSON.stringify({ email: "alice@atwho.org", password: ALICE_PW }) }
  );
  alice = ((await json<{ token?: string }>(res)).token ?? "") as string;
});

// ══════════════════════ T88：open form_instance ══════════════════════

describe("T88：永久刪除有 open form_instance 的信", () => {
  it("200；messages／form_instances／form_responses 全清、form_templates 保留、稽核含 form_instances", async () => {
    await seedMessage({ id: 1, keyPrefix: "mail/t88/" });
    await put("mail/t88/1.eml");
    const templateId = await seedTemplate("t88");
    const instanceId = await seedInstance({ templateId, messageId: 1, status: "open" });

    const res = await req("/api/mail/1?mode=hard", { method: "DELETE" }, alice);

    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, id: 1, messages: 1, form_instances: 1, r2_objects: 1 });
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE id = 1")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM form_instances WHERE id = ?1", instanceId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM form_responses WHERE instance_id = ?1", instanceId)).toBe(0);
    // form_templates 可重用 → 絕不刪除（D16）
    expect(await count("SELECT COUNT(*) AS n FROM form_templates WHERE id = ?1", templateId)).toBe(1);

    const audit = await lastAudit("mail_purged");
    expect(audit?.detail ? JSON.parse(audit.detail) : null).toEqual({
      id: 1,
      r2_objects: 1,
      form_instances: 1,
    });
  });
});

// ══════════════════════ T89：已提交的 form_response ══════════════════════

describe("T89：永久刪除有已提交 form_response 的信", () => {
  it("200；messages／form_instances／form_responses 全清（回覆先於實例刪除）", async () => {
    await seedMessage({ id: 2, keyPrefix: "mail/t89/" });
    const templateId = await seedTemplate("t89");
    const instanceId = await seedInstance({ templateId, messageId: 2, status: "submitted" });
    await seedResponse(instanceId);

    const res = await req("/api/mail/2?mode=hard", { method: "DELETE" }, alice);

    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ ok: true, id: 2, messages: 1, form_instances: 1, r2_objects: 1 });
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE id = 2")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM form_instances WHERE id = ?1", instanceId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM form_responses WHERE instance_id = ?1", instanceId)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM form_responses")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM form_templates WHERE id = ?1", templateId)).toBe(1);

    const audit = await lastAudit("mail_purged");
    expect(audit?.detail ? JSON.parse(audit.detail) : null).toEqual({
      id: 2,
      r2_objects: 1,
      form_instances: 1,
    });
  });
});

// ══════════════════════ T90：trash/empty 混合 131 封 ══════════════════════

describe("T90：trash/empty 混合 131 封（含表單信）＋ D1 100 參數上限", () => {
  it("200、count=131；表單三表清空、稽核含 form_instances，且每條 SQL 綁定 ≤90", async () => {
    const ids = await seedBulkMessages({ startId: 1000, count: 131, folder: "trash", keyPrefix: "mail/t90/" });

    // 3 封表單信（id 1000–1002）：2 封有回覆；其餘 128 封為一般信。
    const templateId = await seedTemplate("t90");
    const formIds = ids.slice(0, 3);
    const instances: number[] = [];
    for (const id of formIds) {
      instances.push(await seedInstance({ templateId, messageId: id, status: "open" }));
    }
    await seedResponse(instances[0]!);
    await seedResponse(instances[1]!);

    const res = await req("/api/mail/trash/empty", { method: "POST" }, alice, {
      DB: dbWithBindLimit(E.DB, 100), // 4 句 DELETE 每句都綁 90 個 id；未分塊會直接丟錯
    });

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ count: 131, r2_objects: 131 });
    expect(await count("SELECT COUNT(*) AS n FROM messages")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM form_instances")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM form_responses")).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM form_templates WHERE id = ?1", templateId)).toBe(1);

    const audit = await lastAudit("trash_emptied");
    expect(audit?.detail ? JSON.parse(audit.detail) : null).toEqual({
      count: 131,
      r2_objects: 131,
      form_instances: 3,
    });
  });
});

// ══════════════════════ T91：form 子表刪除失敗 → 該塊回滾 ══════════════════════

describe("T91：form_responses 刪除失敗 → 該塊整批回滾", () => {
  it("500 DELETE_FAILED；messages／form_instances／form_responses 全保留、不寫稽核", async () => {
    await seedMessage({ id: 3, folder: "trash", keyPrefix: "mail/t91/" });
    await put("mail/t91/3.eml");
    const templateId = await seedTemplate("t91");
    const instanceId = await seedInstance({ templateId, messageId: 3, status: "submitted" });
    await seedResponse(instanceId);

    const res = await req("/api/mail/trash/empty", { method: "POST" }, alice, {
      DB: dbWithFormDeleteFailure(E.DB),
    });

    expect(res.status).toBe(500);
    const body = await json<ErrBody & { deleted: { messages: number; attachments: number; form_instances: number; r2_objects: number } }>(res);
    expect(body.error.code).toBe("DELETE_FAILED");
    // 該塊沒有任何刪除成功 → 回報 0（N9：只有數量）
    expect(body.deleted).toEqual({ messages: 0, attachments: 0, form_instances: 0, r2_objects: 0 });

    // batch 原子性：即使後面的 attachments／messages 已執行，整批仍回滾 → DB 完全不變
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE id = 3")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM form_instances WHERE id = ?1", instanceId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM form_responses WHERE instance_id = ?1", instanceId)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE folder = 'trash'")).toBe(1);
    expect(await lastAudit("trash_emptied")).toBeNull();

    // R2 仍維持既有嚴格語意：先刪 R2，DB batch 失敗不回滾 R2（物件已不可達）
    expect(await exists("mail/t91/3.eml")).toBe(false);
  });
});
