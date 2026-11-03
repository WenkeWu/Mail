/**
 * mail-delete-semantics.spec.ts — docs/19 **D19-1／D19-2**
 *
 * 對應 docs/19 §2／§3：
 * - **T63** 軟刪除後 `folder=trash` 可見
 * - **T64** 軟刪除後 DB `deleted_at IS NULL`（bug 的根因）
 * - **T65** restore → 回到 inbox
 * - **T66** hard delete → R2 物件消失 ＋ 列消失 ＋ 稽核 `mail_purged`
 * - **T67** `trash/empty` 只清自己 scope（他人信件不動）
 * - **T68** 越權 hard delete → 404
 * - **T71** 批次移至垃圾桶
 * - **T72** 批次永久刪除
 * - **T73** 批次含越權 id → 404 且整批未執行
 *
 * 另補邊界：R2 刪除失敗 → 500 且 DB 不變、清空垃圾桶 500 封上限、
 * 批次參數驗證、批次 restore／read、稽核 N9（不得含主旨／內文）。
 *
 * 全程在 workerd 內以真實 D1／R2 執行，一律走**真實端點**。
 * ⚠️ 測試環境未設定 `ACCESS_MAIL_AUD` → `/api/auth/login` 走 D2 的過渡放行（與其他測試檔一致）。
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { hashPassword, type Env } from "../src/auth";

const E = env as unknown as Env;
const OWNER_PW = "owner-password-d19";
const ALICE_PW = "alice-password-d19";
const BOB_PW = "bob-password-d19";

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
 * 發請求；`overrideEnv` 用於注入失敗的 binding（例如 R2 delete 故障）。
 * 以 `Object.create(E)` 為底，其餘 binding 全部沿用真環境。
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
const codeOf = async (res: Response): Promise<string> => (await json<ErrBody>(res)).error.code;

async function mailboxLogin(email: string, password: string): Promise<string> {
  const res = await req("/api/auth/mailbox-login", { method: "POST", body: JSON.stringify({ email, password }) });
  return ((await json<{ token?: string }>(res)).token ?? "") as string;
}

// ───────────────────────── 種資料 ─────────────────────────

async function seedMessage(opts: {
  id: number;
  addressId: number;
  folder?: string;
  rawKey: string;
  htmlKey?: string;
  subject?: string;
}): Promise<void> {
  const ts = Date.now();
  await E.DB.prepare(
    `INSERT INTO messages
       (id, owner_user_id, address_id, folder, message_id, from_address, to_address, cc, subject,
        text_preview, received_at, raw_r2_key, html_r2_key, created_at, updated_at, deleted_at)
     VALUES (?1, 1, ?2, ?3, NULL, 'sender@example.com', '[]', '[]', ?4, 'preview', ?5, ?6, ?7, ?5, ?5, NULL)`
  )
    .bind(opts.id, opts.addressId, opts.folder ?? "inbox", opts.subject ?? "secret subject", ts, opts.rawKey, opts.htmlKey ?? null)
    .run();
}

async function seedAttachment(messageId: number, r2Key: string): Promise<void> {
  const ts = Date.now();
  await E.DB.prepare(
    `INSERT INTO attachments
       (message_id, filename, stored_filename, content_type, size_bytes, r2_key, created_at, updated_at)
     VALUES (?1, 'a.pdf', 'a.pdf', 'application/pdf', 10, ?2, ?3, ?3)`
  )
    .bind(messageId, r2Key, ts)
    .run();
}

const put = (key: string, body = "blob") => E.MAIL.put(key, new TextEncoder().encode(body));
const exists = async (key: string): Promise<boolean> => (await E.MAIL.get(key)) !== null;

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const row = await E.DB.prepare(sql)
    .bind(...binds)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

interface MsgDbRow {
  folder: string;
  deleted_at: number | null;
  raw_r2_key: string;
  html_r2_key: string | null;
}

const msgRow = (id: number) =>
  E.DB.prepare("SELECT folder, deleted_at, raw_r2_key, html_r2_key FROM messages WHERE id = ?1")
    .bind(id)
    .first<MsgDbRow>();

interface AuditRow {
  detail: string | null;
  user_id: number | null;
  address_id: number | null;
}

const lastAudit = (event: string) =>
  E.DB.prepare(
    "SELECT detail, user_id, address_id FROM registration_audit WHERE event = ?1 ORDER BY id DESC LIMIT 1"
  )
    .bind(event)
    .first<AuditRow>();

const auditDetail = (row: AuditRow | null): Record<string, unknown> =>
  row?.detail ? (JSON.parse(row.detail) as Record<string, unknown>) : {};

let alice = "";
let bob = "";

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
  // R2 也從乾淨狀態開始（列表 → 一次刪除）
  const listed = await E.MAIL.list();
  if (listed.objects.length > 0) await E.MAIL.delete(listed.objects.map((o) => o.key));

  const ts = Date.now();
  await E.DB.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, status, role, created_at, updated_at)
     VALUES (1, 'owner', 'Owner', ?1, 'active', 'owner', ?2, ?2)`
  )
    .bind(await cachedHash(OWNER_PW), ts)
    .run();
  await E.DB.prepare(
    `INSERT INTO email_addresses
       (id, user_id, local_part, domain, email, password_hash, password_changed_at, status,
        can_send, daily_send_quota, sent_today, quota_reset_at, created_at, updated_at)
     VALUES (1, 1, 'alice', 'atwho.org', 'alice@atwho.org', ?1, ?2, 'active', 1, 20, 0, ?2, ?2, ?2),
            (2, 1, 'bob',   'atwho.org', 'bob@atwho.org',   ?3, ?2, 'active', 1, 20, 0, ?2, ?2, ?2)`
  )
    .bind(await cachedHash(ALICE_PW), ts, await cachedHash(BOB_PW))
    .run();
  await seedMessage({ id: 1, addressId: 1, rawKey: "mail/2026/11/m1.eml", htmlKey: "mail/2026/11/m1.html" });
  await seedMessage({ id: 2, addressId: 2, rawKey: "mail/2026/11/m2.eml" });
  await seedMessage({ id: 3, addressId: 1, rawKey: "mail/2026/11/m3.eml" });

  alice = await mailboxLogin("alice@atwho.org", ALICE_PW);
  bob = await mailboxLogin("bob@atwho.org", BOB_PW);
});

// ══════════════════════ T63／T64：軟刪除語意 ══════════════════════

describe("T63／T64：DELETE 是軟刪除（folder=trash、deleted_at 保持 NULL）", () => {
  it("T63：刪除後垃圾桶列表與詳情都看得到該封", async () => {
    expect((await req("/api/mail/1", { method: "DELETE" }, alice)).status).toBe(204);

    const list = await json<{ items: Array<{ id: number; folder: string }> }>(
      await req("/api/mail/inbox?folder=trash", {}, alice)
    );
    expect(list.items.map((i) => i.id)).toContain(1);
    expect(list.items.find((i) => i.id === 1)?.folder).toBe("trash");

    const detail = await req("/api/mail/1", {}, alice);
    expect(detail.status).toBe(200);
    expect((await json<{ folder: string }>(detail)).folder).toBe("trash");
  });

  it("T64：DB 斷言 deleted_at IS NULL（bug 的根因）", async () => {
    expect((await req("/api/mail/1", { method: "DELETE" }, alice)).status).toBe(204);
    const row = await msgRow(1);
    expect(row?.folder).toBe("trash");
    expect(row?.deleted_at).toBeNull();
  });

  it("軟刪除後不在 inbox 列表（只出現在 trash）", async () => {
    await req("/api/mail/1", { method: "DELETE" }, alice);
    const inbox = await json<{ items: Array<{ id: number }> }>(await req("/api/mail/inbox?folder=inbox", {}, alice));
    expect(inbox.items.map((i) => i.id)).not.toContain(1);
  });
});

// ══════════════════════ T65：restore ══════════════════════

describe("T65：restore 只允許垃圾桶 → inbox", () => {
  it("垃圾桶內的信可還原；稽核 mail_restored", async () => {
    await req("/api/mail/1", { method: "DELETE" }, alice);
    const res = await req("/api/mail/1/restore", { method: "POST" }, alice);
    expect(res.status).toBe(200);
    expect(await json<{ id: number; folder: string }>(res)).toEqual({ ok: true, id: 1, folder: "inbox" });

    const row = await msgRow(1);
    expect(row?.folder).toBe("inbox");
    expect(row?.deleted_at).toBeNull();
    const inbox = await json<{ items: Array<{ id: number }> }>(await req("/api/mail/inbox?folder=inbox", {}, alice));
    expect(inbox.items.map((i) => i.id)).toContain(1);

    const audit = await lastAudit("mail_restored");
    expect(auditDetail(audit)).toEqual({ id: 1 });
    expect(audit?.address_id).toBe(1);
  });

  it("非垃圾桶的信 → 400 NOT_IN_TRASH，狀態不變", async () => {
    const res = await req("/api/mail/3/restore", { method: "POST" }, alice);
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe("NOT_IN_TRASH");
    expect((await msgRow(3))?.folder).toBe("inbox");
  });

  it("越權 restore → 404（不洩漏存在性）", async () => {
    await req("/api/mail/2", { method: "DELETE" }, bob);
    const res = await req("/api/mail/2/restore", { method: "POST" }, alice);
    expect(res.status).toBe(404);
    expect(await codeOf(res)).toBe("MAIL_NOT_FOUND");
    expect((await msgRow(2))?.folder).toBe("trash");
  });
});

// ══════════════════════ T66／T68：hard delete ══════════════════════

describe("T66：hard delete → R2 物件＋列消失、稽核 mail_purged（N9）", () => {
  it("依序清 R2（raw/html/附件）→ attachments → messages", async () => {
    await put("mail/2026/11/m1.eml");
    await put("mail/2026/11/m1.html", "<p>hi</p>");
    await put("attachments/2026/11/a1.pdf");
    await seedAttachment(1, "attachments/2026/11/a1.pdf");

    const res = await req("/api/mail/1?mode=hard", { method: "DELETE" }, alice);
    expect(res.status).toBe(200);
    const body = await json<{ ok: boolean; id: number; r2_objects: number }>(res);
    expect(body.ok).toBe(true);
    expect(body.id).toBe(1);
    expect(body.r2_objects).toBe(3);

    expect(await exists("mail/2026/11/m1.eml")).toBe(false);
    expect(await exists("mail/2026/11/m1.html")).toBe(false);
    expect(await exists("attachments/2026/11/a1.pdf")).toBe(false);
    expect(await msgRow(1)).toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM attachments WHERE message_id = 1")).toBe(0);

    const audit = await lastAudit("mail_purged");
    expect(auditDetail(audit)).toEqual({ id: 1, r2_objects: 3 });
    expect(audit?.address_id).toBe(1);
    // N9：稽核不得含主旨／寄件者／內文
    expect(audit?.detail ?? "").not.toContain("secret subject");
    expect(audit?.detail ?? "").not.toContain("sender@example.com");
    expect(audit?.detail ?? "").not.toContain("preview");
  });

  it("R2 刪除失敗 → 500 且 DB 完全不動（無稽核）", async () => {
    await put("mail/2026/11/m1.eml");
    const failingBucket = new Proxy(E.MAIL, {
      get(target, prop) {
        if (prop === "delete") {
          return async () => {
            throw new Error("injected: R2 delete unavailable");
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as R2Bucket;

    const res = await req("/api/mail/1?mode=hard", { method: "DELETE" }, alice, { MAIL: failingBucket });
    expect(res.status).toBe(500);
    expect(await codeOf(res)).toBe("DELETE_FAILED");

    const row = await msgRow(1);
    expect(row).not.toBeNull();
    expect(row?.deleted_at).toBeNull();
    expect(await exists("mail/2026/11/m1.eml")).toBe(true);
    expect(await lastAudit("mail_purged")).toBeNull();
  });
});

describe("T68：越權 hard delete → 404", () => {
  it("Alice 無法 hard delete Bob 的信；R2 與列都保留", async () => {
    await put("mail/2026/11/m2.eml");
    const res = await req("/api/mail/2?mode=hard", { method: "DELETE" }, alice);
    expect(res.status).toBe(404);
    expect(await codeOf(res)).toBe("MAIL_NOT_FOUND");
    expect(await msgRow(2)).not.toBeNull();
    expect(await exists("mail/2026/11/m2.eml")).toBe(true);
  });

  it("不存在的 id → 404", async () => {
    expect((await req("/api/mail/999999?mode=hard", { method: "DELETE" }, alice)).status).toBe(404);
  });

  it("非法 mode → 400", async () => {
    expect((await req("/api/mail/1?mode=bogus", { method: "DELETE" }, alice)).status).toBe(400);
  });
});

// ══════════════════════ T67：trash/empty 只清自己 scope ══════════════════════

describe("T67：trash/empty 只清 session scope", () => {
  it("Alice 清空垃圾桶只刪自己的信；Bob 的信與 R2 保留", async () => {
    await put("mail/2026/11/m1.eml");
    await put("mail/2026/11/m1.html");
    await put("mail/2026/11/m2.eml");
    await req("/api/mail/1", { method: "DELETE" }, alice);
    await req("/api/mail/2", { method: "DELETE" }, bob);

    const res = await req("/api/mail/trash/empty", { method: "POST" }, alice);
    expect(res.status).toBe(200);
    const body = await json<{ count: number; r2_objects: number }>(res);
    expect(body).toEqual({ count: 1, r2_objects: 2 }); // m1 raw + html

    expect(await msgRow(1)).toBeNull();
    expect(await exists("mail/2026/11/m1.eml")).toBe(false);
    expect(await exists("mail/2026/11/m1.html")).toBe(false);

    const bobRow = await msgRow(2);
    expect(bobRow?.folder).toBe("trash");
    expect(bobRow?.deleted_at).toBeNull();
    expect(await exists("mail/2026/11/m2.eml")).toBe(true);

    const audit = await lastAudit("trash_emptied");
    expect(auditDetail(audit)).toEqual({ count: 1, r2_objects: 2 });
    expect(audit?.address_id).toBe(1);
  });

  it("垃圾桶為空 → count 0、不寫稽核", async () => {
    const res = await req("/api/mail/trash/empty", { method: "POST" }, alice);
    expect(res.status).toBe(200);
    expect(await json<{ count: number; r2_objects: number }>(res)).toEqual({ count: 0, r2_objects: 0 });
    expect(await lastAudit("trash_emptied")).toBeNull();
  });

  it("超過 500 封 → 400 TRASH_TOO_LARGE，一封都不刪", async () => {
    const ts = Date.now();
    await E.DB.prepare(
      `INSERT INTO messages
         (owner_user_id, address_id, folder, from_address, to_address, cc, subject, text_preview,
          received_at, raw_r2_key, created_at, updated_at, deleted_at)
       SELECT 1, 1, 'trash', 'x@example.com', '[]', '[]', 's', 'p', ?1,
              'mail/bulk/' || x || '.eml', ?1, ?1, NULL
       FROM (WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < 501)
             SELECT x FROM cnt)`
    )
      .bind(ts)
      .run();
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE folder = 'trash'")).toBe(501);

    const res = await req("/api/mail/trash/empty", { method: "POST" }, alice);
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe("TRASH_TOO_LARGE");
    expect(await count("SELECT COUNT(*) AS n FROM messages WHERE folder = 'trash'")).toBe(501);
  });
});

// ══════════════════════ T71／T72／T73：批次 ══════════════════════

describe("T71：批次移至垃圾桶", () => {
  it("action=trash 對多封生效，deleted_at 仍為 NULL，稽核 mail_batch", async () => {
    const res = await req("/api/mail/batch", {
      method: "POST",
      body: JSON.stringify({ action: "trash", ids: [1, 3] }),
    }, alice);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true, action: "trash", count: 2 });

    for (const id of [1, 3]) {
      const row = await msgRow(id);
      expect(row?.folder).toBe("trash");
      expect(row?.deleted_at).toBeNull();
    }
    expect((await msgRow(2))?.folder).toBe("inbox");

    const audit = await lastAudit("mail_batch");
    expect(auditDetail(audit)).toEqual({ action: "trash", count: 2 });
    expect(audit?.address_id).toBe(1);
  });

  it("重複 id 會去重（count 以唯一 id 計）", async () => {
    const res = await req("/api/mail/batch", {
      method: "POST",
      body: JSON.stringify({ action: "read", ids: [1, 1, 1] }),
    }, alice);
    expect(res.status).toBe(200);
    expect((await json<{ count: number }>(res)).count).toBe(1);
  });
});

describe("T72：批次永久刪除（purge 走 D19-1 邏輯）", () => {
  it("列、附件與 R2 全部清除；只寫 mail_batch（不另寫 mail_purged）", async () => {
    await put("mail/2026/11/m1.eml");
    await put("mail/2026/11/m1.html");
    await put("attachments/2026/11/a1.pdf");
    await seedAttachment(1, "attachments/2026/11/a1.pdf");
    await put("mail/2026/11/m3.eml");

    const res = await req("/api/mail/batch", {
      method: "POST",
      body: JSON.stringify({ action: "purge", ids: [1, 3] }),
    }, alice);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true, action: "purge", count: 2 });

    expect(await msgRow(1)).toBeNull();
    expect(await msgRow(3)).toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM attachments WHERE message_id = 1")).toBe(0);
    expect(await exists("mail/2026/11/m1.eml")).toBe(false);
    expect(await exists("mail/2026/11/m1.html")).toBe(false);
    expect(await exists("attachments/2026/11/a1.pdf")).toBe(false);
    expect(await exists("mail/2026/11/m3.eml")).toBe(false);
    // 別人的信不動
    expect(await msgRow(2)).not.toBeNull();

    const audit = await lastAudit("mail_batch");
    expect(auditDetail(audit)).toEqual({ action: "purge", count: 2 });
    expect(await lastAudit("mail_purged")).toBeNull();
  });
});

describe("T73：批次含越權 id → 404 且整批未執行", () => {
  it("ids 中含 Bob 的信 → 404，Alice 自己的信也未被搬移", async () => {
    const res = await req("/api/mail/batch", {
      method: "POST",
      body: JSON.stringify({ action: "trash", ids: [1, 2] }),
    }, alice);
    expect(res.status).toBe(404);
    expect(await codeOf(res)).toBe("MAIL_NOT_FOUND");

    expect((await msgRow(1))?.folder).toBe("inbox");
    expect((await msgRow(2))?.folder).toBe("inbox");
    expect(await lastAudit("mail_batch")).toBeNull();
  });

  it("purge 含越權 id → 404，任何 R2 物件都不刪", async () => {
    await put("mail/2026/11/m1.eml");
    await put("mail/2026/11/m2.eml");
    const res = await req("/api/mail/batch", {
      method: "POST",
      body: JSON.stringify({ action: "purge", ids: [1, 2] }),
    }, alice);
    expect(res.status).toBe(404);
    expect(await msgRow(1)).not.toBeNull();
    expect(await msgRow(2)).not.toBeNull();
    expect(await exists("mail/2026/11/m1.eml")).toBe(true);
    expect(await exists("mail/2026/11/m2.eml")).toBe(true);
  });

  it("包含已永久刪除（deleted_at 非 NULL）的 id → 404（全站隱藏）", async () => {
    const ts = Date.now();
    await E.DB.prepare("UPDATE messages SET deleted_at = ?1 WHERE id = 1").bind(ts).run();
    const res = await req("/api/mail/batch", {
      method: "POST",
      body: JSON.stringify({ action: "read", ids: [1] }),
    }, alice);
    expect(res.status).toBe(404);
  });
});

describe("批次參數驗證與 restore／read", () => {
  it("非法 action → 400 INVALID_ACTION", async () => {
    const res = await req("/api/mail/batch", {
      method: "POST",
      body: JSON.stringify({ action: "delete", ids: [1] }),
    }, alice);
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe("INVALID_ACTION");
  });

  it("空 ids／非陣列／非正整數／超過 200 → 400 INVALID_IDS", async () => {
    const cases: unknown[] = [[], "1", [0], [-1], [1.5], Array.from({ length: 201 }, (_, i) => i + 1)];
    for (const ids of cases) {
      const res = await req("/api/mail/batch", {
        method: "POST",
        body: JSON.stringify({ action: "read", ids }),
      }, alice);
      expect(res.status).toBe(400);
      expect(await codeOf(res)).toBe("INVALID_IDS");
    }
  });

  it("action=restore 只把垃圾桶的信改回 inbox", async () => {
    await req("/api/mail/1", { method: "DELETE" }, alice);
    const res = await req("/api/mail/batch", {
      method: "POST",
      body: JSON.stringify({ action: "restore", ids: [1, 3] }),
    }, alice);
    expect(res.status).toBe(200);
    expect((await msgRow(1))?.folder).toBe("inbox");
    expect((await msgRow(3))?.folder).toBe("inbox");
  });

  it("action=read 設定 read_at（不覆蓋既有已讀時間）", async () => {
    const first = Date.now();
    await E.DB.prepare("UPDATE messages SET read_at = ?1 WHERE id = 3").bind(first).run();
    const res = await req("/api/mail/batch", {
      method: "POST",
      body: JSON.stringify({ action: "read", ids: [1, 3] }),
    }, alice);
    expect(res.status).toBe(200);
    const rows = await E.DB.prepare("SELECT id, read_at FROM messages WHERE id IN (1,3) ORDER BY id").all<{
      id: number;
      read_at: number | null;
    }>();
    expect(rows.results[0]?.read_at).toBeGreaterThan(0);
    expect(rows.results[1]?.read_at).toBe(first);
  });
});
