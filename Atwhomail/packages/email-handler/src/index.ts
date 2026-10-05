/**
 * atwhomail-email-handler — 收信 Catch-all Worker（Phase 9：附件抽取）
 *
 * 收信流程（依 02-email-flows.md §1.1）：
 *   1. 查收件地址（D1 email_addresses）— 不存在或非 active → 靜默丟棄
 *   2. 存在且 active → raw 讀進記憶體 → 存 R2（mail/YYYY/MM/<uuid>.eml）
 *   3. postal-mime parse metadata
 *   4. 寫 D1 messages（歸屬 address_id / owner_user_id）
 *   5. 寫 D1 messages（歸屬 address_id / owner_user_id）
 *   6. HTML body：sanitize（08 文件 #16）→ R2 html_r2_key
 *   7. 附件：blob 存 R2（attachments/<uuid>/<i>-<sanitized>）+ 寫 D1 attachments
 *
 * TODO(之後 Phase)：store 後 D1/R2 失敗修復機制；遠端圖片代理（MVP 剝離）。
 */
import PostalMime from "postal-mime";
import { sanitizeHtml } from "./sanitize";

export interface Env {
  DB: D1Database;
  MAIL: R2Bucket;
}

interface RawEmailMessage {
  from: string;
  to: string;
  headers: Headers | null;
  raw: ReadableStream<Uint8Array> | null;
  rawSize: number;
}

interface AddressRow {
  id: number;
  user_id: number;
  email: string;
  status: string;
}

const now = () => Date.now();

/** 04 文件：mail/YYYY/MM/<uuid>.eml（YYYY/MM = UTC） */
function buildMailKey(d: Date): string {
  return `mail/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}.eml`;
}

function formatMailbox(mailbox: { name?: string; address?: string } | undefined, fallback: string): string {
  if (!mailbox?.address) return fallback;
  return mailbox.name ? `${mailbox.name} <${mailbox.address}>` : mailbox.address;
}

function preview(text: string | undefined): string | null {
  if (!text) return null;
  return text.length > 200 ? text.slice(0, 200) : text;
}

/** 檔名 sanitize：去路徑/控制字元，保留安全字元集，空檔名給 fallback */
function sanitizeFilename(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
  return cleaned.length > 0 && cleaned !== "." && cleaned !== ".." ? cleaned : fallback;
}

/** 附件 content 正規化為 bytes；回傳 { bytes, length } */
function contentToBytes(content: ArrayBuffer | Uint8Array | string): { bytes: ArrayBuffer | Uint8Array; length: number } {
  if (typeof content === "string") {
    const enc = new TextEncoder().encode(content);
    return { bytes: enc, length: enc.byteLength };
  }
  if (content instanceof Uint8Array) return { bytes: content, length: content.byteLength };
  return { bytes: content, length: content.byteLength };
}

async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  /** HTTP（email-only worker；200 防瀏覽器 probe 噪音） */
  async fetch(): Promise<Response> {
    return Response.json(
      { service: "atwhomail-email-handler", ok: true, note: "email-only worker" },
      { status: 200 }
    );
  },

  async email(message: RawEmailMessage, env: Env): Promise<void> {
    const rcpt = message.to.trim().toLowerCase();
    const key = buildMailKey(new Date());

    try {
      // ── 1. 地址存在性檢查 ──
      const addr = await env.DB.prepare(
        "SELECT id, user_id, email, status FROM email_addresses WHERE email = ?1"
      )
        .bind(rcpt)
        .first<AddressRow>();
      if (!addr || addr.status !== "active") {
        console.log("[atwhomail-email-handler] dropped (address not found/not active)", {
          to: rcpt,
          status: addr?.status ?? "not-found",
        });
        return;
      }

      // ── 2. raw → R2 ──
      if (!message.raw) {
        console.error("[atwhomail-email-handler] raw stream missing", { to: rcpt });
        return;
      }
      const buf = await new Response(message.raw).arrayBuffer();
      await env.MAIL.put(key, buf, {
        httpMetadata: { contentType: "message/rfc822" },
        customMetadata: { "d1-address-id": String(addr.id) },
      });

      // ── 3. parse metadata ──
      const parsed = await PostalMime.parse(buf);
      const fromDisplay = formatMailbox(parsed.from, message.from);
      const toList = (parsed.to?.length ? parsed.to : [{ name: "", address: rcpt }]).map((m) => ({
        address: m.address ?? rcpt,
        name: m.name ?? "",
      }));
      const ccList = (parsed.cc ?? []).map((m) => ({ address: m.address ?? "", name: m.name ?? "" }));

      // ── 4. HTML body 消毒（08 文件 #16）→ 存 R2 ──
      let htmlKey: string | null = null;
      if (parsed.html) {
        const sanitized = await sanitizeHtml(parsed.html);
        if (sanitized.trim().length > 0) {
          const k = key.replace(/\.eml$/, ".html");
          try {
            await env.MAIL.put(k, new TextEncoder().encode(sanitized), {
              httpMetadata: { contentType: "text/html; charset=utf-8" },
              customMetadata: { "d1-address-id": String(addr.id) },
            });
            htmlKey = k;
          } catch (e) {
            console.error("[atwhomail-email-handler] html store failed", { key: k, error: String(e) });
          }
        }
      }

      // ── 5. 寫 D1 messages ──
      const ts = now();
      const res = await env.DB.prepare(
        `INSERT INTO messages
           (owner_user_id, address_id, folder, message_id, from_address, to_address, cc,
            subject, text_preview, received_at, raw_r2_key, html_r2_key, created_at, updated_at)
         VALUES (?1, ?2, 'inbox', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)`
      )
        .bind(
          addr.user_id,
          addr.id,
          parsed.messageId ?? null,
          fromDisplay,
          JSON.stringify(toList),
          JSON.stringify(ccList),
          parsed.subject ?? null,
          preview(parsed.text),
          ts,
          key,
          htmlKey,
          ts
        )
        .run();
      const messageRowId = res.meta.last_row_id;

      // ── 6. 附件抽取：attachments/<uuid>/<i>-<sanitized> + D1 attachments ──
      const uuid = key.split("/")[3]!.replace(/\.eml$/, "");
      let storedCount = 0;
      if (parsed.attachments.length > 0) {
        for (let i = 0; i < parsed.attachments.length; i++) {
          const att = parsed.attachments[i]!;
          const original = att.filename || "";
          const fallback = `attachment-${i + 1}`;
          const stored = `${i}-${sanitizeFilename(original, fallback)}`;
          const r2Key = `attachments/${uuid}/${stored}`;
          try {
            const { bytes, length } = contentToBytes(att.content);
            const sha = await sha256Hex(bytes);
            await env.MAIL.put(r2Key, bytes, {
              httpMetadata: { contentType: att.mimeType || "application/octet-stream" },
              customMetadata: { "d1-message-id": String(messageRowId) },
            });
            await env.DB.prepare(
              `INSERT INTO attachments
                 (message_id, filename, stored_filename, content_type, size_bytes, r2_key, sha256, disposition, created_at, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`
            )
              .bind(
                messageRowId,
                original || fallback,
                stored,
                att.mimeType || "application/octet-stream",
                length,
                r2Key,
                sha,
                att.disposition === "inline" ? "inline" : "attachment",
                now()
              )
              .run();
            storedCount++;
          } catch (attErr) {
            console.error("[atwhomail-email-handler] attachment store failed", {
              messageRowId,
              r2Key,
              error: String(attErr),
            });
          }
        }
      }

      console.log("[atwhomail-email-handler] stored", {
        key,
        rawSize: message.rawSize,
        to: rcpt,
        addressId: addr.id,
        messageRowId,
        subject: parsed.subject ?? null,
        attachmentCount: parsed.attachments.length,
        storedAttachments: storedCount,
      });
    } catch (err) {
      console.error("[atwhomail-email-handler] process failed", {
        to: rcpt,
        key,
        error: String(err),
      });
    }
  },
};
