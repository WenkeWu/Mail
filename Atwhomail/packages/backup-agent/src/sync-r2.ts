/**
 * sync-r2.ts — R2 → 本機磁碟（增量、sha256 驗證；09 文件 §3）
 *
 * 流程：
 *   1. 向 API 列舉 R2 物件（prefix=mail/ 與 attachments/，分頁）
 *   2. 與本機 r2_manifest + 磁碟現況比對
 *   3. 只下載：manifest 沒有／檔案不在磁碟／size 不符／R2 有 sha256 metadata 且與 manifest 不同
 *   4. 下載後驗證 size 與 sha256（R2 metadata 有值時）→ 不符重抓一次，仍不符則記為失敗
 *   5. upsert r2_manifest
 *
 * 本地目錄結構（依 09 §3）：`mail/` 前綴在本地省略 → `<BACKUP_ROOT>/2026/09/<uuid>.eml`
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "./config.ts";
import type { Pool } from "./db.ts";
import { localPathFor } from "./paths.ts";

interface ListedObject {
  key: string;
  size: number;
  etag: string;
  uploaded: number | string;
  sha256: string | null;
}

interface ListResponse {
  objects: ListedObject[];
  truncated: boolean;
  after: string | null;
}

export interface R2SyncResult {
  listed: number;
  downloaded: number;
  skipped: number;
  failed: number;
  bytes: number;
  errors: string[];
}

const PREFIXES = ["mail/", "attachments/"];

export function sha256Hex(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function downloadObject(cfg: Config, key: string): Promise<Uint8Array> {
  const url = new URL(`${cfg.apiUrl}/api/backup/r2/object`);
  url.searchParams.set("key", key);
  const res = await fetch(url, { headers: { "x-admin-token": cfg.adminToken! } });
  if (!res.ok) throw new Error(`下載 HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function loadManifest(pool: Pool): Promise<Map<string, { sha256: string | null; size: number }>> {
  const { rows } = await pool.query<{ r2_key: string; sha256: string | null; size: string }>(
    "SELECT r2_key, sha256, size FROM r2_manifest"
  );
  return new Map(rows.map((r) => [r.r2_key, { sha256: r.sha256, size: Number(r.size) }]));
}

export async function syncR2(
  pool: Pool,
  cfg: Config,
  log: (msg: string, extra?: Record<string, unknown>) => void
): Promise<R2SyncResult> {
  if (!cfg.adminToken) throw new Error("ADMIN_TOKEN 未設定：Phase 14 需要 rescue token");

  const manifest = await loadManifest(pool);
  const res: R2SyncResult = { listed: 0, downloaded: 0, skipped: 0, failed: 0, bytes: 0, errors: [] };

  for (const prefix of PREFIXES) {
    let after: string | null = null;
    do {
      const url = new URL(`${cfg.apiUrl}/api/backup/r2/objects`);
      url.searchParams.set("prefix", prefix);
      url.searchParams.set("limit", "1000");
      if (after) url.searchParams.set("after", after);

      const r = await fetch(url, { headers: { "x-admin-token": cfg.adminToken } });
      if (!r.ok) throw new Error(`R2 列舉失敗 HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
      const body = (await r.json()) as ListResponse;

      for (const obj of body.objects) {
        res.listed += 1;
        const localPath = localPathFor(cfg.backupRoot, obj.key);
        const row = manifest.get(obj.key);
        const diskExists = existsSync(localPath);
        const diskSize = diskExists ? statSync(localPath).size : -1;

        const upToDate =
          row !== undefined &&
          diskExists &&
          diskSize === obj.size &&
          row.size === obj.size &&
          (obj.sha256 === null || row.sha256 === obj.sha256);

        if (upToDate) {
          res.skipped += 1;
          continue;
        }

        // 需要（重新）下載
        let lastErr = "";
        let done = false;
        for (let attempt = 1; attempt <= 2 && !done; attempt += 1) {
          try {
            const bytes = await downloadObject(cfg, obj.key);
            const sha = sha256Hex(bytes);
            if (bytes.length !== obj.size) {
              lastErr = `size 不符（R2 列舉 ${obj.size}，實得 ${bytes.length}）`;
              continue;
            }
            if (obj.sha256 && obj.sha256 !== sha) {
              lastErr = `sha256 不符（R2 metadata ${obj.sha256}，實得 ${sha}）`;
              continue;
            }
            mkdirSync(dirname(localPath), { recursive: true });
            writeFileSync(localPath, bytes);
            await pool.query(
              `INSERT INTO r2_manifest (r2_key, sha256, size, local_path, backup_time)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (r2_key) DO UPDATE SET
                 sha256 = EXCLUDED.sha256, size = EXCLUDED.size,
                 local_path = EXCLUDED.local_path, backup_time = EXCLUDED.backup_time`,
              [obj.key, sha, obj.size, localPath, Date.now()]
            );
            manifest.set(obj.key, { sha256: sha, size: obj.size });
            res.downloaded += 1;
            res.bytes += bytes.length;
            done = true;
          } catch (e) {
            lastErr = (e as Error).message;
          }
        }
        if (!done) {
          res.failed += 1;
          res.errors.push(`${obj.key}: ${lastErr}`);
          log("R2 object 備份失敗", { key: obj.key, error: lastErr });
        }
      }

      after = body.truncated ? body.after : null;
    } while (after);
  }

  return res;
}

/** 完整性檢查（09 文件 §6）：manifest ↔ 磁碟 sha256 重新計算比對 */
export async function verifyManifest(
  pool: Pool
): Promise<{ total: number; ok: number; missing: number; corrupt: number; details: string[] }> {
  const { rows } = await pool.query<{ r2_key: string; sha256: string | null; size: string; local_path: string | null }>(
    "SELECT r2_key, sha256, size, local_path FROM r2_manifest ORDER BY r2_key"
  );
  const out = { total: rows.length, ok: 0, missing: 0, corrupt: 0, details: [] as string[] };
  for (const r of rows) {
    const p = r.local_path;
    if (!p || !existsSync(p)) {
      out.missing += 1;
      out.details.push(`MISSING ${r.r2_key}`);
      continue;
    }
    const actual = sha256Hex(new Uint8Array(readFileSync(p)));
    if (r.sha256 && actual !== r.sha256) {
      out.corrupt += 1;
      out.details.push(`CORRUPT ${r.r2_key}（manifest ${r.sha256} vs 磁碟 ${actual}）`);
    } else {
      out.ok += 1;
    }
  }
  return out;
}
