/**
 * index.ts — Backup Agent 主迴圈（Phase 12：骨架）
 *
 * 現階段（Phase 12）：
 *   啟動 → 套用本地 migration → 健康檢查 → 定時 tick（僅回報狀態，不呼叫 API）
 * 後續階段：
 *   Phase 13 → tick 內拉 `/api/backup/changes`（D1 metadata 增量 → PG upsert）
 *   Phase 14 → 列舉 R2 → 下載未備份 object → 磁碟 + sha256 驗證
 *
 * 鐵則（09 文件）：單向、增量、不影響 Production。
 * 停止方式：Ctrl+C（SIGINT）；測試用 BACKUP_MAX_TICKS=N 跑 N 次即結束。
 */
import { loadConfig } from "./config.ts";
import { createPool, ensureSchema, health } from "./db.ts";
import { syncD1 } from "./sync-d1.ts";
import { syncR2 } from "./sync-r2.ts";

type Level = "info" | "warn" | "error";

function log(level: Level, msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));
}

/** 可中斷的等待（每 250ms 檢查是否該收工） */
async function sleep(ms: number, keepGoing: () => boolean): Promise<void> {
  const step = 250;
  let waited = 0;
  while (waited < ms && keepGoing()) {
    await new Promise((r) => setTimeout(r, Math.min(step, ms - waited)));
    waited += step;
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  log("info", "agent starting", {
    apiUrl: cfg.apiUrl,
    pg: `${cfg.pg.user}@${cfg.pg.host}:${cfg.pg.port}/${cfg.pg.database}`,
    backupRoot: cfg.backupRoot,
    syncIntervalMs: cfg.syncIntervalMs,
    maxTicks: cfg.maxTicks,
    rescueTokenPresent: cfg.adminToken !== null,
  });

  const pool = createPool(cfg);
  try {
    const applied = await ensureSchema(pool, cfg.migrationsDir);
    if (applied.length > 0) log("info", "migrations applied", { applied });
    else log("info", "schema up to date");

    const h = await health(pool);
    log("info", "db ok", {
      serverVersion: h.serverVersion,
      mirrorTables: h.mirrorTables,
      counts: h.counts,
      watermarks: h.watermarks,
    });

    let running = true;
    let watermarks: Record<string, string | number> = h.watermarks;
    let lastR2At = 0; // 0 → 啟動後第一次 tick 就會跑 R2 備份
    const stop = (sig: string) => {
      if (!running) return;
      running = false;
      log("info", "shutdown requested", { signal: sig });
    };
    process.on("SIGINT", () => stop("SIGINT"));
    process.on("SIGTERM", () => stop("SIGTERM"));

    let tick = 0;
    while (running) {
      tick += 1;
      let syncLine: Record<string, unknown>;
      // Phase 13：D1 metadata 增量備份（單向：只讀 API、只寫本機 PG）
      try {
        const sync = await syncD1(pool, cfg, (msg, extra) => log("info", msg, extra ?? {}));
        syncLine = {
          pages: sync.pages,
          created: sync.created,
          updated: sync.updated,
          deleted: sync.deleted,
        };
        watermarks = sync.cursors;
      } catch (e) {
        log("error", "sync failed", { tick, message: (e as Error).message });
        syncLine = { error: (e as Error).message };
      }

      // Phase 14：R2 → 本機磁碟（預設每小時；R2_SYNC_INTERVAL_MS=0 → 每 tick）
      let r2Line: Record<string, unknown>;
      if (Date.now() - lastR2At >= cfg.r2SyncIntervalMs) {
        try {
          const r2 = await syncR2(pool, cfg, (msg, extra) => log("warn", msg, extra ?? {}));
          r2Line = {
            listed: r2.listed,
            downloaded: r2.downloaded,
            skipped: r2.skipped,
            failed: r2.failed,
            bytes: r2.bytes,
          };
          lastR2At = Date.now();
        } catch (e) {
          log("error", "r2 sync failed", { tick, message: (e as Error).message });
          r2Line = { error: (e as Error).message };
        }
      } else {
        r2Line = { dueAt: new Date(lastR2At + cfg.r2SyncIntervalMs).toISOString() };
      }

      const hh = await health(pool); // 同步後才統計 → 列數反映最新狀態
      log("info", `tick #${tick}`, {
        uptimeSec: Math.round(process.uptime()),
        mirrorTables: hh.mirrorTables,
        rows: hh.counts,
        sync: syncLine,
        r2: r2Line,
        watermarks,
        pending: "Inbox App（下一階段）",
      });

      if (cfg.maxTicks !== null && tick >= cfg.maxTicks) {
        log("info", "max ticks reached", { ticks: tick });
        break;
      }
      await sleep(cfg.syncIntervalMs, () => running);
    }

    await pool.end();
    log("info", "agent stopped", { ticks: tick });
  } catch (e) {
    await pool.end().catch(() => {});
    throw e;
  }
}

main().catch((e: unknown) => {
  const err = e as { message?: string; stack?: string };
  log("error", "agent failed", { message: err?.message ?? String(e), stack: err?.stack ?? null });
  process.exit(1);
});
