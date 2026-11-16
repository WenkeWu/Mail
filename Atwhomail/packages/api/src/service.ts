/**
 * service.ts — 外部系統「只寄信」憑證（D39）。
 *
 * 設計原則：
 * - 不把 owner rescue token（x-admin-token）交給外部系統
 * - token 只綁定一個 email_addresses 寄件地址，只能呼叫 /api/service/mail/send
 * - DB 只存 SHA-256(token)，明碼只在建立時回傳一次
 */
import type { Env } from "./auth";

const TOKEN_PREFIX = "atw_svc_";
const TOKEN_RE = /^atw_svc_[0-9a-f]{64}$/;

export interface ServiceTokenRow {
  id: number;
  name: string;
  address_id: number;
  hourly_limit: number;
  daily_limit: number;
}

const enc = new TextEncoder();

export function generateServiceToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `${TOKEN_PREFIX}${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function hashServiceToken(token: string): Promise<string> {
  return sha256Hex(token);
}

/**
 * 驗證 service token。
 * 格式不符 → null（不查 DB）；查無 active token → null。
 * `last_used_at` 每分鐘最多更新一次，避免每個請求多一次寫入。
 */
export async function authenticateServiceToken(env: Env, token: string): Promise<ServiceTokenRow | null> {
  if (!TOKEN_RE.test(token)) return null;
  const hash = await hashServiceToken(token);
  const row = await env.DB.prepare(
    `SELECT id, name, address_id, hourly_limit, daily_limit
     FROM service_tokens
     WHERE token_hash = ?1 AND status = 'active'`
  )
    .bind(hash)
    .first<ServiceTokenRow>();
  if (!row) return null;

  const ts = Date.now();
  await env.DB.prepare(
    `UPDATE service_tokens SET last_used_at = ?1
     WHERE id = ?2 AND (last_used_at IS NULL OR last_used_at < ?3)`
  )
    .bind(ts, row.id, ts - 60_000)
    .run()
    .catch(() => undefined);

  return {
    id: Number(row.id),
    name: row.name,
    address_id: Number(row.address_id),
    hourly_limit: Number(row.hourly_limit),
    daily_limit: Number(row.daily_limit),
  };
}
