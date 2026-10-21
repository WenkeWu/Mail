/**
 * form-mail.spec.ts — 收信端 P1（docs/18 §11 T37／T38／T49／T53／T54）
 *
 * 驗證：MX 進來的信**永遠**是 external／normal；表單標記一律丟棄；
 * Authentication-Results 只寫入顯示欄位，不影響分類與表單授權。
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import handler, { type Env } from "../src/index";

const E = env as unknown as Env;
const RCPT = "alice@atwho.org";

function makeMessage(raw: string, to = RCPT) {
  const bytes = new TextEncoder().encode(raw);
  return {
    to,
    from: "ext@example.com",
    headers: new Headers(),
    raw: new Response(bytes).body as ReadableStream<Uint8Array>,
    rawSize: bytes.byteLength,
  };
}

interface ExtraParts {
  headers?: string[];
  attachments?: Array<{ filename: string; mime: string; content?: string }>;
}

function buildRaw(opts: ExtraParts = {}): string {
  const boundary = "BOUND-FORM";
  const parts: string[] = [
    `From: "Sender Name" <ext@example.com>`,
    `To: ${RCPT}`,
    `Subject: Form claim test`,
    `Message-ID: <form-1@example.com>`,
    `MIME-Version: 1.0`,
    ...(opts.headers ?? []),
    `Content-Type: multipart/mixed; boundary=${boundary}`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    `Please fill the form`,
  ];
  for (const att of opts.attachments ?? []) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${att.mime}; name="${att.filename}"`,
      `Content-Disposition: attachment; filename="${att.filename}"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      att.content ?? "Zm9ybSBwYXlsb2Fk" // "form payload"
    );
  }
  parts.push(`--${boundary}--`, ``);
  return parts.join("\r\n");
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

async function onlyMessage(): Promise<Record<string, unknown>> {
  return (await E.DB.prepare("SELECT * FROM messages ORDER BY id DESC LIMIT 1").first<Record<string, unknown>>())!;
}

beforeEach(async () => {
  for (const t of ["form_responses", "form_instances", "form_templates", "attachments", "messages", "registration_audit", "email_aliases", "email_addresses", "users"]) {
    await E.DB.prepare(`DELETE FROM ${t}`).run();
  }
  const existing = await E.MAIL.list();
  for (const obj of existing.objects) await E.MAIL.delete(obj.key);
});

describe("外部來信的分類（路徑決定，內容不影響）", () => {
  it("T37：帶 X-AtWho-Form 標頭仍為 external／normal，標記被丟棄並記 suspicious_form_claim", async () => {
    await seedAddress();
    await handler.email(
      makeMessage(buildRaw({ headers: ["X-AtWho-Form: 123", "X-AtWho-Form-Id: abc"] })),
      E
    );

    const msg = await onlyMessage();
    expect(msg.origin).toBe("external");
    expect(msg.kind).toBe("normal");
    expect(msg.delivery_scope).toBe("external");
    expect(Number(msg.suspicious_form_claim)).toBe(1);
    expect(msg.form_instance_id).toBeNull();

    // 標記不啟用任何表單
    const instances = await E.DB.prepare("SELECT COUNT(*) AS n FROM form_instances").first<{ n: number }>();
    expect(instances?.n).toBe(0);

    // 稽核只有標記種類，不含信件內容
    const audit = await E.DB.prepare("SELECT * FROM registration_audit WHERE event = 'claim_blocked'").first<Record<string, unknown>>();
    expect(audit).not.toBeNull();
    expect(String(audit!.detail)).not.toContain("Please fill the form");
    expect(String(audit!.detail)).toContain("header:x-atwho-form");
  });

  it("T38：表單附件（.atwhoform／vnd.atwho.form+json）→ suspicious_form_claim=1 且不啟用", async () => {
    await seedAddress();
    await handler.email(
      makeMessage(
        buildRaw({
          attachments: [
            { filename: "request.atwhoform", mime: "application/octet-stream" },
            { filename: "payload.json", mime: "application/vnd.atwho.form+json" },
          ],
        })
      ),
      E
    );

    const msg = await onlyMessage();
    expect(Number(msg.suspicious_form_claim)).toBe(1);
    expect(msg.kind).toBe("normal");
    const instances = await E.DB.prepare("SELECT COUNT(*) AS n FROM form_instances").first<{ n: number }>();
    expect(instances?.n).toBe(0);
  });

  it("T53：外部偽造 From: alice@atwho.org → 仍是 external／normal（不取得內部身分）", async () => {
    await seedAddress();
    const raw = buildRaw().replace(
      `From: "Sender Name" <ext@example.com>`,
      `From: "Alice" <alice@atwho.org>`
    );
    await handler.email(makeMessage(raw), E);

    const msg = await onlyMessage();
    expect(msg.origin).toBe("external");
    expect(msg.kind).toBe("normal");
    expect(msg.delivery_scope).toBe("external");
    expect(msg.sender_spf).not.toBeNull(); // 未提供標頭 → unknown（仍有值，供顯示）
  });

  it("T49：轉寄回流（外部寄入含表單靜態文字與標記）→ kind=normal、無表單", async () => {
    await seedAddress();
    const raw = buildRaw({
      headers: ["X-AtWho-Form: forwarded", "Authentication-Results: mx.cloudflare.net; spf=pass; dmarc=pass"],
    });
    await handler.email(makeMessage(raw), E);
    const msg = await onlyMessage();
    expect(msg.origin).toBe("external");
    expect(msg.kind).toBe("normal");
    expect(msg.form_instance_id).toBeNull();
  });
});

describe("寄件者驗證結果（僅供顯示）", () => {
  it("T54：解析 Authentication-Results，寫入 spf/dkim/dmarc 且不影響 origin／kind", async () => {
    await seedAddress();
    await handler.email(
      makeMessage(
        buildRaw({
          headers: [
            "Authentication-Results: mx.cloudflare.net; spf=pass smtp.mailfrom=ext@example.com; dkim=fail header.d=example.com; dmarc=pass",
          ],
        })
      ),
      E
    );

    const msg = await onlyMessage();
    expect(msg.sender_spf).toBe("pass");
    expect(msg.sender_dkim).toBe("fail");
    expect(msg.sender_dmarc).toBe("pass");
    // 驗證結果不改變分類
    expect(msg.origin).toBe("external");
    expect(msg.kind).toBe("normal");
  });

  it("Received-SPF 可作為 SPF 備援；未知方法記為 none", async () => {
    await seedAddress();
    await handler.email(
      makeMessage(buildRaw({ headers: ["Received-SPF: softfail (mx.cloudflare.net: domain of ext@example.com)"] })),
      E
    );

    const msg = await onlyMessage();
    // softfail 不在 pass/fail/none 值域 → unknown
    expect(msg.sender_spf).toBe("unknown");
    expect(msg.sender_dkim).toBe("unknown");
    expect(msg.sender_dmarc).toBe("unknown");
  });
});
