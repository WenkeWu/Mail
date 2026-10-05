/**
 * email-handler.spec.ts — 收信 Worker 整合測試（Phase 16）
 *
 * 以真實 D1 + R2 bindings 走完整流程：查地址 → 存 R2 → parse → 消毒 HTML → 附件抽取。
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import handler, { type Env } from "../src/index";

const E = env as unknown as Env;

const RCPT = "alice@atwho.org";

function buildRaw(withHtml = true, withAttachment = true): string {
  const boundary = "BOUND";
  const parts: string[] = [
    `From: "Sender Name" <ext@example.com>`,
    `To: ${RCPT}`,
    `Subject: Integration test mail`,
    `Message-ID: <it-1@example.com>`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary=${boundary}`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `Hello from integration test`,
  ];
  if (withHtml) {
    parts.push(
      `--${boundary}`,
      `Content-Type: text/html; charset=utf-8`,
      ``,
      `<p>Hi <b>there</b> <script>alert(1)</script> <a href="javascript:x()">bad</a></p>`
    );
  }
  if (withAttachment) {
    parts.push(
      `--${boundary}`,
      `Content-Type: text/plain; name="note.txt"`,
      `Content-Disposition: attachment; filename="note.txt"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      `aGVsbG8gd29ybGQK`
    );
  }
  parts.push(`--${boundary}--`, ``);
  return parts.join("\r\n");
}

function makeMessage(raw: string, to = RCPT): { to: string; from: string; headers: Headers; raw: ReadableStream<Uint8Array>; rawSize: number } {
  const bytes = new TextEncoder().encode(raw);
  return {
    to,
    from: "ext@example.com",
    headers: new Headers(),
    raw: new Response(bytes).body as ReadableStream<Uint8Array>,
    rawSize: bytes.byteLength,
  };
}

async function seedAddress(status = "active"): Promise<void> {
  const ts = Date.now();
  await E.DB.prepare(
    "INSERT INTO users (id, username, display_name, password_hash, status, created_at, updated_at) VALUES (1,'owner','Owner','x','active',?,?)"
  )
    .bind(ts, ts)
    .run();
  await E.DB.prepare(
    `INSERT INTO email_addresses (id, user_id, local_part, domain, email, status, password_changed_at, created_at, updated_at)
     VALUES (1, 1, 'alice', 'atwho.org', ?, ?, 0, ?, ?)`
  )
    .bind(RCPT, status, ts, ts)
    .run();
}

async function countObjects(prefix: string): Promise<number> {
  const listed = await E.MAIL.list({ prefix });
  return listed.objects.length;
}

beforeEach(async () => {
  for (const t of ["attachments", "messages", "email_aliases", "email_addresses", "users"]) {
    await E.DB.prepare(`DELETE FROM ${t}`).run();
  }
  const existing = await E.MAIL.list();
  for (const obj of existing.objects) await E.MAIL.delete(obj.key);
});

describe("收信流程（存在且 active 的地址）", () => {
  it("存 R2 .eml + HTML + 附件，並寫入 D1 messages/attachments", async () => {
    await seedAddress();
    await handler.email(makeMessage(buildRaw()), E);

    const msg = await E.DB.prepare("SELECT * FROM messages WHERE address_id = 1").first<Record<string, unknown>>();
    expect(msg).not.toBeNull();
    expect(msg!.subject).toBe("Integration test mail");
    expect(msg!.folder).toBe("inbox");
    expect(String(msg!.raw_r2_key)).toMatch(/^mail\/\d{4}\/\d{2}\/[0-9a-f-]+\.eml$/);
    expect(msg!.html_r2_key).not.toBeNull();

    // R2：.eml、.html、附件
    expect(await countObjects("mail/")).toBe(2);
    expect(await countObjects("attachments/")).toBe(1);
    const eml = await E.MAIL.get(String(msg!.raw_r2_key));
    expect(eml).not.toBeNull();
    expect(await eml!.text()).toContain("Integration test mail");
  });

  it("HTML 內文已消毒（script / javascript: 連結不外洩）", async () => {
    await seedAddress();
    await handler.email(makeMessage(buildRaw()), E);
    const msg = await E.DB.prepare("SELECT html_r2_key FROM messages WHERE address_id = 1").first<{ html_r2_key: string }>();
    const html = await (await E.MAIL.get(msg!.html_r2_key))!.text();
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("<b>there</b>");
  });

  it("附件寫入 D1 並存 R2（檔名與大小正確）", async () => {
    await seedAddress();
    await handler.email(makeMessage(buildRaw()), E);
    const att = await E.DB.prepare("SELECT * FROM attachments").first<Record<string, unknown>>();
    expect(att).not.toBeNull();
    expect(att!.filename).toBe("note.txt");
    expect(Number(att!.size_bytes)).toBe(12); // "hello world\n"
    expect(String(att!.r2_key)).toMatch(/^attachments\/[0-9a-f-]+\/0-note\.txt$/);
    const obj = await E.MAIL.get(String(att!.r2_key));
    expect(await obj!.text()).toBe("hello world\n");
  });

  it("純文字信（無 HTML/附件）也能處理", async () => {
    await seedAddress();
    await handler.email(makeMessage(buildRaw(false, false)), E);
    const msg = await E.DB.prepare("SELECT html_r2_key, text_preview FROM messages").first<{ html_r2_key: string | null; text_preview: string }>();
    expect(msg!.html_r2_key).toBeNull();
    expect(msg!.text_preview).toContain("Hello from integration test");
    expect(await countObjects("attachments/")).toBe(0);
  });
});

describe("靜默丟棄（不存在的地址／非 active）", () => {
  it("地址不存在 → 不寫任何資料、不存 R2", async () => {
    await seedAddress();
    await handler.email(makeMessage(buildRaw(), "nobody@atwho.org"), E);
    expect(await E.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>()).toEqual({ n: 0 });
    expect(await countObjects("mail/")).toBe(0);
    expect(await countObjects("attachments/")).toBe(0);
  });

  it("地址為 disabled → 同樣丟棄", async () => {
    await seedAddress("disabled");
    await handler.email(makeMessage(buildRaw()), E);
    expect(await E.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>()).toEqual({ n: 0 });
    expect(await countObjects("mail/")).toBe(0);
  });

  it("大小寫混合的收件地址仍能命中（case-insensitive）", async () => {
    await seedAddress();
    await handler.email(makeMessage(buildRaw(), "ALICE@AtWho.Org"), E);
    expect(await E.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>()).toEqual({ n: 1 });
  });
});
