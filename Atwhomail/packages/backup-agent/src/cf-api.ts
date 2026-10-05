/**
 * cf-api.ts — Cloudflare REST API 精簡客戶端（僅 restore 路徑使用）
 *
 * 為什麼用 REST 而非 Workers 端點：Phase 15 決策（選項 B）——
 *   restore 走「離線腳本 + 既有 token」，**不新增任何可寫入 production 的端點**（攻擊面 0）。
 */
import type { Config } from "./config.ts";

const API = "https://api.cloudflare.com/client/v4";

interface CfEnvelope<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
}

async function cfCall<T>(cfg: Config, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${cfg.cfApiToken}`,
      ...(init.body && !(init.body instanceof Uint8Array) ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: CfEnvelope<T>;
  try {
    body = JSON.parse(text) as CfEnvelope<T>;
  } catch {
    throw new Error(`CF API 回應非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
  if (!res.ok || !body.success) {
    const msg = body.errors?.map((e) => `${e.code}:${e.message}`).join("; ") || `HTTP ${res.status}`;
    throw new Error(`CF API 失敗 ${path} → ${msg}`);
  }
  return body.result;
}

/** D1 執行 SQL（單一語句；多列 VALUES 由 sql-build 合併） */
export async function d1Query(cfg: Config, databaseId: string, sql: string): Promise<unknown> {
  const result = await cfCall<Array<{ results: unknown[]; success: boolean; meta: Record<string, unknown> }>>(
    cfg,
    `/accounts/${cfg.cfAccountId}/d1/database/${databaseId}/query`,
    { method: "POST", body: JSON.stringify({ sql }) }
  );
  const first = result?.[0];
  if (!first?.success) throw new Error(`D1 語句失敗：${sql.slice(0, 160)}`);
  return first.results;
}

export async function d1Count(cfg: Config, databaseId: string, table: string): Promise<number | null> {
  const rows = (await d1Query(cfg, databaseId, `SELECT COUNT(*) AS n FROM ${table}`)) as Array<{ n: number }> | undefined;
  return rows && rows[0] ? Number(rows[0].n) : null;
}

/** R2 上傳單一物件（原始位元組；已知長度 → 符合 R2 的 PUT 要求） */
export async function r2Put(
  cfg: Config,
  bucket: string,
  key: string,
  bytes: Uint8Array,
  contentType: string
): Promise<{ etag: string | null; size: number | null }> {
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const result = await cfCall<{ etag?: string; size?: number }>(
    cfg,
    `/accounts/${cfg.cfAccountId}/r2/buckets/${bucket}/objects/${encodedKey}`,
    {
      method: "PUT",
      body: bytes,
      headers: { "Content-Type": contentType || "application/octet-stream" },
    }
  );
  return { etag: result?.etag ?? null, size: result?.size ?? null };
}

/** R2 物件列舉（用於還原後的數量/大小驗證） */
export async function r2List(
  cfg: Config,
  bucket: string,
  prefix = ""
): Promise<Array<{ key: string; size: number; etag?: string }>> {
  const out: Array<{ key: string; size: number; etag?: string }> = [];
  let cursor: string | undefined;
  do {
    const qs = new URLSearchParams({ per_page: "1000" });
    if (prefix) qs.set("prefix", prefix);
    if (cursor) qs.set("cursor", cursor);
    const res = await fetch(`${API}/accounts/${cfg.cfAccountId}/r2/buckets/${bucket}/objects?${qs}`, {
      headers: { Authorization: `Bearer ${cfg.cfApiToken}` },
    });
    const body = (await res.json()) as {
      success: boolean;
      result?: Array<{ key: string; size: number; etag?: string }>;
      result_info?: { cursor?: string; is_truncated?: boolean };
    };
    if (!res.ok || !body.success) throw new Error(`R2 列舉失敗（HTTP ${res.status}）`);
    out.push(...(body.result ?? []));
    cursor = body.result_info?.is_truncated ? body.result_info.cursor : undefined;
  } while (cursor);
  return out;
}
