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

/**
 * 寄件者驗證結果（docs/18 §5.3、P1）。
 *
 * ⚠️ **僅供顯示，永不授權**：這些值不影響 origin／kind／delivery_scope，也不參與表單授權。
 * 值域固定為 pass／fail／none／unknown（null 表示沒有可用來源，本檔只在外部信寫入非 NULL 值）。
 */
type AuthResult = "pass" | "fail" | "none" | "unknown";

function normalizeAuthResult(raw: string): AuthResult {
  const v = raw.trim().toLowerCase();
  if (v === "pass") return "pass";
  if (v === "fail") return "fail";
  if (v === "none") return "none";
  // Cloudflare／其他 MTA 可能回 neutral／softfail／temperror／permerror 等 → 一律視為 unknown
  return "unknown";
}

/** 同一方法可能出現多次（多個 DKIM 簽章）→ 任一 pass 即 pass，否則任一 fail 即 fail */
function combineAuthResults(values: AuthResult[]): AuthResult {
  if (values.includes("pass")) return "pass";
  if (values.includes("fail")) return "fail";
  if (values.includes("none")) return "none";
  return "unknown";
}

/**
 * 解析 `Authentication-Results`（優先）與 `Received-SPF`（SPF 備援）。
 *
 * 收信端（Cloudflare）會在原始標頭加入這兩個欄位；寄件者自己偽造的副本通常排在後面，
 * 因此只取**第一個** `Authentication-Results`（接收端加在最前面）以避免被內容牽著走。
 * 再次強調：解析結果只寫入顯示欄位，**不影響分類與表單授權**。
 */
function parseSenderAuth(headers: Array<{ key: string; value: string }>): {
  spf: AuthResult;
  dkim: AuthResult;
  dmarc: AuthResult;
} {
  const authHeader = headers.find((h) => h.key === "authentication-results")?.value ?? null;
  const receivedSpf = headers.find((h) => h.key === "received-spf")?.value ?? null;

  if (authHeader === null && receivedSpf === null) {
    return { spf: "unknown", dkim: "unknown", dmarc: "unknown" };
  }

  const found: Record<"spf" | "dkim" | "dmarc", AuthResult[]> = { spf: [], dkim: [], dmarc: [] };
  if (authHeader !== null) {
    const re = /(?:^|[;\s])(spf|dkim|dmarc)\s*=\s*([A-Za-z0-9_-]+)/gi;
    for (const m of authHeader.matchAll(re)) {
      const method = m[1]!.toLowerCase() as "spf" | "dkim" | "dmarc";
      found[method].push(normalizeAuthResult(m[2]!));
    }
  }

  // Received-SPF 只在 Authentication-Results 沒有 spf 時作為備援
  if (found.spf.length === 0 && receivedSpf !== null) {
    const token = /^\s*([A-Za-z0-9_-]+)/.exec(receivedSpf)?.[1];
    if (token) found.spf.push(normalizeAuthResult(token));
  }

  // 有 Authentication-Results 但沒有該方法 → none（「沒有這個方法的結果」）；
  // 完全沒有可用標頭 → unknown（無法判定）。
  const pick = (values: AuthResult[]): AuthResult =>
    values.length > 0 ? combineAuthResults(values) : authHeader !== null ? "none" : "unknown";
  return { spf: pick(found.spf), dkim: pick(found.dkim), dmarc: pick(found.dmarc) };
}

/**
 * 表單標記偵測（docs/18 §5.1（甲））。
 *
 * 外部信若帶 `X-AtWho-Form` 等標頭、或 `.atwhoform`／`.atwho-form.json` 附件，一律
 * **丟棄標記、不得啟用任何表單**；僅記 `suspicious_form_claim=1` 供顯示／稽核。
 * 這裡只回傳「標記種類」（不含檔名或值），避免稽核寫入任何郵件內容（N9）。
 */
const FORM_HEADER_RE = /^x-atwho(?:mail)?-form(?:$|[-_.])/i;
const FORM_ATTACHMENT_NAME_RE = /\.(?:atwho-?form|atwhoform)(?:\.json)?$/i;
const FORM_ATTACHMENT_MIME_RE = /^application\/(?:vnd\.)?atwho(?:mail)?[-.]form\+json$/i;

function detectFormClaims(
  headers: Array<{ key: string }>,
  attachments: Array<{ filename: string | null; mimeType: string }>
): string[] {
  const markers: string[] = [];
  for (const h of headers) {
    if (FORM_HEADER_RE.test(h.key)) markers.push(`header:${h.key}`);
  }
  attachments.forEach((att, i) => {
    const name = att.filename ?? "";
    if (FORM_ATTACHMENT_NAME_RE.test(name) || FORM_ATTACHMENT_MIME_RE.test(att.mimeType)) {
      markers.push(`attachment#${i}`);
    }
  });
  return [...new Set(markers)];
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

      // ── 3b. 寄件者驗證結果（僅供顯示）＋ 外部表單標記（一律無效）──
      // ⚠️ 分類（origin／kind／delivery_scope）只由「進入路徑」決定：這裡是 MX → 一律 external／normal。
      //    `X-AtWho-Form` 等標記會被丟棄（不寫入 DB、不啟用表單）；raw .eml 仍照原流程存 R2（不得改動）。
      const senderAuth = parseSenderAuth(parsed.headers);
      const formClaims = detectFormClaims(parsed.headers, parsed.attachments);

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
      // P1（docs/18 §2）：MX 進入的信**永遠**是外部一般郵件；即使內容帶表單標記也一樣。
      const ts = now();
      const res = await env.DB.prepare(
        `INSERT INTO messages
           (owner_user_id, address_id, folder, message_id, from_address, to_address, cc,
            subject, text_preview, received_at, raw_r2_key, html_r2_key, created_at, updated_at,
            origin, kind, delivery_scope, sender_spf, sender_dkim, sender_dmarc, suspicious_form_claim)
         VALUES (?1, ?2, 'inbox', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12,
                 'external', 'normal', 'external', ?13, ?14, ?15, ?16)`
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
          ts,
          senderAuth.spf,
          senderAuth.dkim,
          senderAuth.dmarc,
          formClaims.length > 0 ? 1 : 0
        )
        .run();
      const messageRowId = res.meta.last_row_id;

      // 表單標記一律丟棄；只留「發生過」的稽核（不含檔名／標頭值／信件內容，N9）
      if (formClaims.length > 0) {
        try {
          await env.DB.prepare(
            `INSERT INTO registration_audit (event, user_id, address_id, detail, created_at)
             VALUES ('claim_blocked', ?1, ?2, ?3, ?4)`
          )
            .bind(addr.user_id, addr.id, JSON.stringify({ origin: "external", markers: formClaims }), now())
            .run();
        } catch (auditErr) {
          console.error("[atwhomail-email-handler] claim audit failed", { error: String(auditErr) });
        }
      }

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
