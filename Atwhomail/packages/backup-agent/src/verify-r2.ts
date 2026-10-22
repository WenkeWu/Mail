/**
 * verify-r2.ts — 備份完整性檢查（09 文件 §6）：重新計算磁碟檔案 sha256 與 manifest 比對
 *
 * 用法：`pnpm --filter @atwhomail/backup-agent run verify`
 * 結束碼：0 = 全部一致；1 = 有缺檔或損毀（可供排程告警使用）
 */
import { loadConfig } from "./config.ts";
import { createPool } from "./db.ts";
import { withConnectionRetry } from "./retry.ts";
import { verifyManifest } from "./sync-r2.ts";

const cfg = loadConfig();
const pool = createPool(cfg);
try {
  // D17-2：PG 連線抖動重試 3 次（1s／2s／4s），全數失敗才讓這次 verify 失敗
  const r = await withConnectionRetry(() => verifyManifest(pool), {
    log: (msg, extra) =>
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: "warn", msg, ...extra })),
  });
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      msg: "manifest verify",
      backupRoot: cfg.backupRoot,
      total: r.total,
      ok: r.ok,
      missing: r.missing,
      corrupt: r.corrupt,
      details: r.details.slice(0, 20),
    })
  );
  await pool.end();
  process.exit(r.missing + r.corrupt > 0 ? 1 : 0);
} catch (e) {
  await pool.end().catch(() => {});
  console.error(JSON.stringify({ level: "error", msg: "verify failed", error: (e as Error).message }));
  process.exit(2);
}
