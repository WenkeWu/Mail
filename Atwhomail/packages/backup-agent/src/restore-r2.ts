/**
 * restore-r2.ts — 管理員手動 Restore：本機磁碟 → 目標 R2 bucket（09 文件 §5）
 *
 * 用法：
 *   pnpm --filter @atwhomail/backup-agent run restore-r2 -- --bucket=test --yes
 *   pnpm --filter @atwhomail/backup-agent run restore-r2 -- --verify-only   # 只驗證，不上傳
 *
 * 安全機制：
 *   1. 未加 `--yes` → dry-run（列出計畫）
 *   2. 目標 = production bucket 需 `--allow-prod`
 *   3. 上傳後以 md5 對比 R2 回傳 etag（單段上傳時 etag = md5），不符即計為失敗
 *   4. `--verify-only` 只比對 manifest ↔ 遠端（數量/大小），不寫入
 *
 * 註：R2 物件為 key-based 覆寫，且本機鏡像即是還原來源，故不做「事前快照」。
 *     若需保留當前 R2 狀態，請先跑一次 `pnpm verify` 確認鏡像完整（本地已有副本）。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { loadConfig, type Config } from "./config.ts";
import { createPool, type Pool } from "./db.ts";
import { r2List, r2Put } from "./cf-api.ts";

const args = process.argv.slice(2);
const hasFlag = (f: string) => args.includes(`--${f}`);
const optVal = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? null;

function log(msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg, ...extra }));
}

function contentTypeFor(key: string): string {
  if (key.endsWith(".eml")) return "message/rfc822";
  if (key.endsWith(".html")) return "text/html; charset=utf-8";
  if (key.endsWith(".txt")) return "text/plain";
  if (key.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}

function md5Hex(buf: Uint8Array): string {
  return createHash("md5").update(buf).digest("hex");
}

interface ManifestRow {
  r2_key: string;
  sha256: string | null;
  size: string;
  local_path: string | null;
}

async function loadManifest(pool: Pool): Promise<ManifestRow[]> {
  const { rows } = await pool.query<ManifestRow>(
    "SELECT r2_key, sha256, size, local_path FROM r2_manifest ORDER BY r2_key"
  );
  return rows;
}

function resolveBucket(cfg: Config): { name: string; isProd: boolean; label: string } {
  const b = optVal("bucket") ?? "test";
  if (b === "test") return { name: cfg.r2TestBucket, isProd: false, label: `test(${cfg.r2TestBucket})` };
  if (b === "prod") return { name: cfg.r2ProdBucket, isProd: true, label: `prod(${cfg.r2ProdBucket})` };
  return { name: b, isProd: b === cfg.r2ProdBucket, label: b };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.cfAccountId || !cfg.cfApiToken) throw new Error("CF_ACCOUNT_ID / CF_API_TOKEN（或 ~/.atwhomail-cf-token）未設定");
  const target = resolveBucket(cfg);
  const verifyOnly = hasFlag("verify-only");
  const dryRun = !hasFlag("yes") && !verifyOnly;

  const pool = createPool(cfg);
  try {
    const manifest = await loadManifest(pool);
    const totalBytes = manifest.reduce((s, r) => s + Number(r.size), 0);
    log("restore-r2 計畫", {
      target: target.label,
      objects: manifest.length,
      bytes: totalBytes,
      verifyOnly,
      dryRun,
      allowProd: hasFlag("allow-prod"),
    });

    if (target.isProd && !hasFlag("allow-prod")) {
      console.error("拒絕執行：目標是 production bucket。若確定要還原，請加 --allow-prod。");
      await pool.end();
      process.exit(1);
    }

    const remote = await r2List(cfg, target.name);
    const remoteBytes = remote.reduce((s, o) => s + Number(o.size), 0);
    log("目標 bucket 現況", { objects: remote.length, bytes: remoteBytes });

    if (dryRun) {
      console.log("（dry-run：未加 --yes，未上傳任何物件）");
      await pool.end();
      process.exit(0);
    }

    let uploaded = 0;
    let skipped = 0;
    let failed = 0;
    const errors: string[] = [];

    if (!verifyOnly) {
      const remoteMap = new Map(remote.map((o) => [o.key, o.size]));
      for (const row of manifest) {
        const localPath = row.local_path;
        const size = Number(row.size);
        if (!localPath || !existsSync(localPath)) {
          failed += 1;
          errors.push(`MISSING_LOCAL ${row.r2_key}`);
          continue;
        }
        // 遠端已存在且大小相同 → 跳過（增量）
        if (remoteMap.get(row.r2_key) === size) {
          skipped += 1;
          continue;
        }
        const bytes = new Uint8Array(readFileSync(localPath));
        if (bytes.length !== size) {
          failed += 1;
          errors.push(`SIZE_MISMATCH_LOCAL ${row.r2_key}`);
          continue;
        }
        const put = await r2Put(cfg, target.name, row.r2_key, bytes, contentTypeFor(row.r2_key));
        const etag = put.etag ? put.etag.replace(/"/g, "") : null;
        const localMd5 = md5Hex(bytes);
        if (etag && /^[0-9a-f]{32}$/i.test(etag) && etag.toLowerCase() !== localMd5) {
          failed += 1;
          errors.push(`ETAG_MISMATCH ${row.r2_key}（r2=${etag} local=${localMd5}）`);
          continue;
        }
        uploaded += 1;
      }
    }

    const after = await r2List(cfg, target.name);
    const afterBytes = after.reduce((s, o) => s + Number(o.size), 0);
    const countsMatch = after.length >= manifest.length;
    const bytesMatch = afterBytes === totalBytes;

    log("restore-r2 完成", {
      uploaded,
      skipped,
      failed,
      verifyOnly,
      remoteObjects: after.length,
      remoteBytes: afterBytes,
      manifestObjects: manifest.length,
      manifestBytes: totalBytes,
      countsMatch,
      bytesMatch,
      errors: errors.slice(0, 10),
    });

    await pool.end();
    process.exit(failed === 0 && countsMatch && bytesMatch ? 0 : 3);
  } catch (e) {
    await pool.end().catch(() => {});
    throw e;
  }
}

main().catch((e: unknown) => {
  console.error(JSON.stringify({ level: "error", msg: "restore-r2 失敗", error: (e as Error).message }));
  process.exit(2);
});
