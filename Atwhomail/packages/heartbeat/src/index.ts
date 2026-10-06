/**
 * atwhomail-heartbeat — 本機 liveness 監看（2026-10-06 新增，對應 11 §5 #13）
 *
 * 問題：備份 agent、watchdog、Windows 排程**全在本機** → 整台機器關機/離線時，
 *       雲端收發信照常運作，但沒有任何機制會發現「本機停擺了」。
 *
 * 作法：
 *   1. 本機 `scripts/backup_watchdog.py` 每次執行後 POST /heartbeat 更新 last_seen_at
 *   2. 本 Worker 的 Cron（每 15 分鐘）檢查心跳是否超過 STALE_MIN 未更新
 *   3. 過期 → 直接以 Email Sending 寄告警信（last_alert_at 做 12 小時去重）
 *
 * 認證：POST /heartbeat 需 `x-admin-token`（ADMIN_TOKEN secret，與 api worker 同值），
 *       無 token 一律 401 —— 否則任何人都能偽造「本機還活著」。
 */
const ALERT_FROM = "alerts@atwho.org";
const DEDUPE_HOURS = 12;

export interface Env {
  DB: D1Database;
  EMAIL: SendEmail;
  ADMIN_TOKEN?: string;
  HEARTBEAT_NAME?: string;
  ALERT_TO?: string;
  STALE_MIN?: string;
}

/** 心跳是否過期（純函式，便於單元測試）。lastSeenAt 為 null = 從未回報 = 視為過期。 */
export function isStale(lastSeenAt: number | null, nowMs: number, staleMin: number): boolean {
  if (!lastSeenAt) return true;
  return nowMs - lastSeenAt > staleMin * 60_000;
}

/** 是否該寄告警（去重：停擺期間每 15 分鐘檢查一次，但最多每 DEDUPE_HOURS 寄一封）。 */
export function shouldAlert(lastAlertAt: number | null, nowMs: number, dedupeHours: number): boolean {
  if (!lastAlertAt) return true;
  return nowMs - lastAlertAt > dedupeHours * 3_600_000;
}

/** 常數時間比較（避免 token 長度/內容造成時序差異） */
function tokenMatches(provided: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function recordHeartbeat(env: Env, name: string, now: number): Promise<void> {
  // 只更新 last_seen_at，保留 last_alert_at（恢復後才由 scheduled 決定是否重新告警）
  await env.DB.prepare(
    `INSERT INTO system_heartbeat (name, last_seen_at, last_alert_at) VALUES (?1, ?2, NULL)
     ON CONFLICT(name) DO UPDATE SET last_seen_at = ?2`
  )
    .bind(name, now)
    .run();
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const name = env.HEARTBEAT_NAME ?? "local-backup-host";

    if (req.method === "POST" && (url.pathname === "/heartbeat" || url.pathname === "/api/heartbeat")) {
      if (!tokenMatches(req.headers.get("x-admin-token") ?? "", env.ADMIN_TOKEN)) {
        return json({ error: { code: "UNAUTHORIZED", message: "bad or missing x-admin-token" } }, 401);
      }
      const now = Date.now();
      await recordHeartbeat(env, name, now);
      return json({ ok: true, name, last_seen_at: now });
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      const row = await env.DB.prepare(
        "SELECT last_seen_at, last_alert_at FROM system_heartbeat WHERE name = ?1"
      )
        .bind(name)
        .first<{ last_seen_at: number; last_alert_at: number | null }>();
      const staleMin = Number(env.STALE_MIN ?? 45);
      return json({
        service: "atwhomail-heartbeat",
        ok: true,
        name,
        last_seen_at: row?.last_seen_at ?? null,
        last_alert_at: row?.last_alert_at ?? null,
        stale: isStale(row?.last_seen_at ?? null, Date.now(), staleMin),
        stale_min: staleMin,
      });
    }

    return json({ error: { code: "NOT_FOUND" } }, 404);
  },

  /** Cron：每 15 分鐘檢查本機心跳；過期且未在去重期內 → 寄告警信。 */
  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const name = env.HEARTBEAT_NAME ?? "local-backup-host";
    const staleMin = Number(env.STALE_MIN ?? "45");
    const now = Date.now();

    // 每次 cron 執行都留痕（last_cron_at）→ 可從 D1 驗證 cron 真的在跑，無需破壞性測試。
    // 注意：若心跳列不存在，這裡以 last_seen_at = 0 建列 → isStale(0) 為真 → 會直接告警「從未回報」。
    await env.DB.prepare(
      `INSERT INTO system_heartbeat (name, last_seen_at, last_cron_at) VALUES (?1, 0, ?2)
       ON CONFLICT(name) DO UPDATE SET last_cron_at = ?2`
    )
      .bind(name, now)
      .run();

    const row = await env.DB.prepare(
      "SELECT last_seen_at, last_alert_at FROM system_heartbeat WHERE name = ?1"
    )
      .bind(name)
      .first<{ last_seen_at: number; last_alert_at: number | null }>();

    if (!isStale(row?.last_seen_at ?? null, now, staleMin)) return;
    if (!shouldAlert(row?.last_alert_at ?? null, now, DEDUPE_HOURS)) return;

    const mins = row?.last_seen_at ? Math.round((now - row.last_seen_at) / 60_000) : null;
    const text = [
      "AtWhoMail 本機停擺告警",
      "",
      `本機心跳已停止：${mins === null ? "從未回報過" : `${mins} 分鐘未更新`}（門檻 ${staleMin} 分鐘）。`,
      "",
      "意義：備份 agent、watchdog、Windows 排程都沒有在運作 ——",
      "整台機器可能已關機、離線，或本機排程全部失效。",
      "雲端收發信仍正常，但**備份會持續落後**，請盡快檢查該台電腦。",
      "",
      `心跳來源：${name}`,
      `檢查時間：${new Date(now).toISOString()}`,
      `（同類告警 ${DEDUPE_HOURS} 小時內不重複寄送）`,
    ].join("\n");

    try {
      await env.EMAIL.send({
        from: ALERT_FROM,
        to: env.ALERT_TO ?? "ulhome@gmail.com",
        subject: "[AtWhoMail 告警] 本機停擺（心跳停止）",
        text,
      });
      await env.DB.prepare("UPDATE system_heartbeat SET last_alert_at = ?2 WHERE name = ?1")
        .bind(name, now)
        .run();
    } catch (e) {
      // 寄信失敗 → 不更新 last_alert_at，下次 cron 會再試
      console.error("[atwhomail-heartbeat] alert email failed", String(e));
    }
  },
} satisfies ExportedHandler<Env>;
