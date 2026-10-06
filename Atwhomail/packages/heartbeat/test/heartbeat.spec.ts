/**
 * heartbeat.spec.ts — atwhomail-heartbeat 測試（2026-10-06）
 *
 * 策略：純函式（isStale / shouldAlert）與 HTTP 端點在 workerd 內以真實 D1 驗證。
 *       寄信路徑**不在此測**（測試池沒有 send_email binding）→ 留待 production 真實 cron 驗證。
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { isStale, shouldAlert, type Env } from "../src/index";

const E = env as unknown as Env;
const NAME = "local-backup-host";
const now = Date.now();

async function post(token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers["x-admin-token"] = token;
  return worker.fetch(
    new Request("https://heartbeat.test/heartbeat", { method: "POST", headers }),
    E
  );
}

async function row(): Promise<{ last_seen_at: number; last_alert_at: number | null } | null> {
  return E.DB.prepare("SELECT last_seen_at, last_alert_at FROM system_heartbeat WHERE name = ?1")
    .bind(NAME)
    .first<{ last_seen_at: number; last_alert_at: number | null }>();
}

beforeEach(async () => {
  await E.DB.prepare("DELETE FROM system_heartbeat").run();
});

describe("isStale（純函式）", () => {
  it("從未回報 → 視為過期", () => {
    expect(isStale(null, now, 45)).toBe(true);
  });
  it("10 分鐘前回報、門檻 45 → 未過期", () => {
    expect(isStale(now - 10 * 60_000, now, 45)).toBe(false);
  });
  it("50 分鐘前回報、門檻 45 → 過期", () => {
    expect(isStale(now - 50 * 60_000, now, 45)).toBe(true);
  });
  it("邊界：剛好等於門檻 → 未過期（> 才判過期）", () => {
    expect(isStale(now - 45 * 60_000, now, 45)).toBe(false);
  });
});

describe("shouldAlert（去重）", () => {
  it("未曾告警 → 該告警", () => {
    expect(shouldAlert(null, now, 12)).toBe(true);
  });
  it("1 小時前告警過、去重 12 小時 → 不再告警", () => {
    expect(shouldAlert(now - 3_600_000, now, 12)).toBe(false);
  });
  it("13 小時前告警過、去重 12 小時 → 可再告警", () => {
    expect(shouldAlert(now - 13 * 3_600_000, now, 12)).toBe(true);
  });
});

describe("POST /heartbeat", () => {
  it("無 token → 401 且不寫入", async () => {
    const res = await post();
    expect(res.status).toBe(401);
    expect(await row()).toBeNull();
  });

  it("token 錯誤 → 401", async () => {
    const res = await post("wrong-token");
    expect(res.status).toBe(401);
    expect(await row()).toBeNull();
  });

  it("token 正確 → 200、寫入 last_seen_at", async () => {
    const res = await post("test-admin-token");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; name: string; last_seen_at: number };
    expect(body.ok).toBe(true);
    expect(body.name).toBe(NAME);
    const r = await row();
    expect(r).not.toBeNull();
    expect(r!.last_seen_at).toBeGreaterThan(0);
    expect(r!.last_alert_at).toBeNull();
  });

  it("重複回報 → 更新 last_seen_at 且保留 last_alert_at", async () => {
    await post("test-admin-token");
    await E.DB.prepare("UPDATE system_heartbeat SET last_alert_at = ?2 WHERE name = ?1")
      .bind(NAME, 123)
      .run();
    const res = await post("test-admin-token");
    expect(res.status).toBe(200);
    const r = await row();
    expect(r!.last_alert_at).toBe(123); // 不可被 NULL 覆蓋
  });
});

describe("GET / 狀態", () => {
  it("無心跳 → stale = true", async () => {
    const res = await worker.fetch(new Request("https://heartbeat.test/"), E);
    const body = (await res.json()) as { stale: boolean; last_seen_at: number | null };
    expect(res.status).toBe(200);
    expect(body.stale).toBe(true);
    expect(body.last_seen_at).toBeNull();
  });

  it("剛回報 → stale = false", async () => {
    await post("test-admin-token");
    const res = await worker.fetch(new Request("https://heartbeat.test/"), E);
    const body = (await res.json()) as { stale: boolean };
    expect(body.stale).toBe(false);
  });
});

describe("scheduled（Cron）", () => {
  const fakeEvent = { cron: "*/15 * * * *", type: "scheduled", scheduledTime: now } as unknown as ScheduledController;
  const fakeCtx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

  it("心跳新鮮 → 不告警、不寫 last_alert_at", async () => {
    await post("test-admin-token");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await worker.scheduled(fakeEvent, E, fakeCtx);
    expect(spy).not.toHaveBeenCalled(); // 沒走到寄信
    expect((await row())!.last_alert_at).toBeNull();
    spy.mockRestore();
  });

  it("心跳過期 → 會嘗試寄告警（測試池無 EMAIL binding → 記錯誤、不寫 last_alert_at）", async () => {
    await E.DB.prepare(
      "INSERT INTO system_heartbeat (name, last_seen_at, last_alert_at) VALUES (?1, ?2, NULL)"
    )
      .bind(NAME, now - 3 * 3_600_000)
      .run();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await worker.scheduled(fakeEvent, E, fakeCtx);
    expect(spy).toHaveBeenCalled(); // 證明真的走到寄信步驟
    expect((await row())!.last_alert_at).toBeNull(); // 寄失敗 → 不記去重時間，下次會重試
    spy.mockRestore();
  });

  it("過期但 12 小時內已告警過 → 不再嘗試寄信（去重）", async () => {
    await E.DB.prepare(
      "INSERT INTO system_heartbeat (name, last_seen_at, last_alert_at) VALUES (?1, ?2, ?3)"
    )
      .bind(NAME, now - 3 * 3_600_000, now - 3_600_000)
      .run();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await worker.scheduled(fakeEvent, E, fakeCtx);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
