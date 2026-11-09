/**
 * quota-view.spec.ts — D34：有效每日配額（暖機期折算）
 *
 * 背景（owner 2026-11-08）：
 *   D33 把訪客配額統一為 50，但暖機期（建立後 24h）的實際上限是
 *   `min(每日配額, 暖機配額)`（暖機配額預設 20，D35 起每地址可調）。
 *   前端原本直接顯示 `daily_send_quota`（50），與寄信時真正會被擋的值不一致 →
 *   `GET /api/me` 與 `GET /api/account/settings` 改為回**有效**上限：
 *     - `effective_daily_quota`：暖機中 = min(配額, 暖機配額)，否則 = 配額
 *     - `warmup_until`：暖機結束時間（ms）；`null` = 不受暖機限制
 *
 * 涵蓋：
 *   - 暖機中（建立 1 小時前）→ 20／有 `warmup_until`
 *   - 暖機結束（建立 48 小時前）→ 配額原值／`null`
 *   - `warmup_exempt=1` → 立即為配額原值／`null`
 *   - owner（/api/me 的 owner 分支）與 mailbox 分支、以及 /api/account/settings 三者一致
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { signMailboxToken, signOwnerToken, type Env } from "../src/auth";

const E = env as unknown as Env;
const HOUR = 3600_000;
const QUOTA = 50;
const WARMUP_QUOTA = 20;

async function req(path: string, token: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.request(path, { headers: { Authorization: `Bearer ${token}` } }, E, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

interface MeAddressView {
  id: number;
  daily_send_quota: number;
  warmup_quota: number;
  effective_daily_quota: number;
  warmup_until: number | null;
}

async function meAddresses(token: string): Promise<MeAddressView[]> {
  const res = await req("/api/me", token);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { addresses: MeAddressView[] };
  return body.addresses;
}

async function settingsAddresses(token: string): Promise<MeAddressView[]> {
  const res = await req("/api/account/settings", token);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { addresses: MeAddressView[] };
  return body.addresses;
}

describe("D34：有效每日配額（暖機期折算）", () => {
  let warmupStart: number;
  let oldStart: number;

  beforeEach(async () => {
    for (const t of [
      "registration_audit",
      "invites",
      "attachments",
      "messages",
      "email_aliases",
      "email_addresses",
      "users",
      "auth_attempts",
    ]) {
      await E.DB.prepare(`DELETE FROM ${t}`).run();
    }

    const ts = Date.now();
    warmupStart = ts - 1 * HOUR; // 暖機中
    oldStart = ts - 48 * HOUR; // 暖機已結束

    await E.DB.batch([
      E.DB.prepare(
        `INSERT INTO users (id, username, display_name, password_hash, status, role, provider,
                            contact_email, email_verified, password_changed_at, created_at, updated_at)
         VALUES (1, 'owner', 'Owner', '', 'active', 'owner', 'local', NULL, 0, 0, ?1, ?1)`
      ).bind(oldStart),
      E.DB.prepare(
        `INSERT INTO users (id, username, display_name, password_hash, status, role, provider,
                            contact_email, email_verified, password_changed_at, created_at, updated_at)
         VALUES (2, 'warm', 'Warm', '', 'active', 'visitor', 'local', NULL, 0, 0, ?1, ?1)`
      ).bind(warmupStart),
      // owner 名下的地址（建立 1 小時前 → 也應折算成暖機配額 20）
      E.DB.prepare(
        `INSERT INTO email_addresses (id, user_id, local_part, domain, email, password_hash,
                                      password_changed_at, status, can_send, daily_send_quota, sent_today,
                                      warmup_quota, created_at, updated_at)
         VALUES (1, 1, 'owner', 'atwho.org', 'owner@atwho.org', NULL, 0, 'active', 1, 50, 0, 20, ?1, ?1)`
      ).bind(warmupStart),
      // 暖機中：每日配額 50 → 有效 20
      E.DB.prepare(
        `INSERT INTO email_addresses (id, user_id, local_part, domain, email, password_hash,
                                      password_changed_at, status, can_send, daily_send_quota, sent_today,
                                      warmup_quota, created_at, updated_at)
         VALUES (10, 2, 'warm', 'atwho.org', 'warm@atwho.org', NULL, 0, 'active', 1, ?1, 0, 20, ?2, ?2)`
      ).bind(QUOTA, warmupStart),
      // 暖機已結束 → 有效 50
      E.DB.prepare(
        `INSERT INTO email_addresses (id, user_id, local_part, domain, email, password_hash,
                                      password_changed_at, status, can_send, daily_send_quota, sent_today,
                                      warmup_quota, created_at, updated_at)
         VALUES (11, 2, 'old', 'atwho.org', 'old@atwho.org', NULL, 0, 'active', 1, ?1, 0, 20, ?2, ?2)`
      ).bind(QUOTA, oldStart),
      // 暖機期但 owner 已豁免 → 有效 50
      E.DB.prepare(
        `INSERT INTO email_addresses (id, user_id, local_part, domain, email, password_hash,
                                      password_changed_at, status, can_send, daily_send_quota, sent_today,
                                      warmup_quota, created_at, updated_at)
         VALUES (12, 2, 'exempt', 'atwho.org', 'exempt@atwho.org', NULL, 0, 'active', 1, ?1, 0, 20, ?2, ?2)`
      ).bind(QUOTA, warmupStart),
      E.DB.prepare("UPDATE email_addresses SET warmup_exempt = 1 WHERE id = 12"),
      // D35：暖機期上限改為 10 → 有效 10
      E.DB.prepare(
        `INSERT INTO email_addresses (id, user_id, local_part, domain, email, password_hash,
                                      password_changed_at, status, can_send, daily_send_quota, sent_today,
                                      warmup_quota, created_at, updated_at)
         VALUES (13, 2, 'custom', 'atwho.org', 'custom@atwho.org', NULL, 0, 'active', 1, ?1, 0, 10, ?2, ?2)`
      ).bind(QUOTA, warmupStart),
    ]);
  });

  it("mailbox：暖機中 → effective=20，且 warmup_until = 建立時間 + 24h", async () => {
    const token = await signMailboxToken(E, 10, "warm@atwho.org", 0);
    const [a] = await meAddresses(token);
    expect(a).toMatchObject({
      id: 10,
      daily_send_quota: QUOTA,
      effective_daily_quota: WARMUP_QUOTA,
      warmup_until: warmupStart + 24 * HOUR,
    });
  });

  it("mailbox：暖機結束 → effective=配額、warmup_until=null", async () => {
    const token = await signMailboxToken(E, 11, "old@atwho.org", 0);
    const [a] = await meAddresses(token);
    expect(a).toMatchObject({
      daily_send_quota: QUOTA,
      effective_daily_quota: QUOTA,
      warmup_until: null,
    });
  });

  it("mailbox：warmup_exempt=1 → 立即不折算", async () => {
    const token = await signMailboxToken(E, 12, "exempt@atwho.org", 0);
    const [a] = await meAddresses(token);
    expect(a).toMatchObject({
      effective_daily_quota: QUOTA,
      warmup_until: null,
    });
  });

  it("D35：每地址暖機上限可調（10 → effective=10）", async () => {
    const token = await signMailboxToken(E, 13, "custom@atwho.org", 0);
    const [a] = await meAddresses(token);
    expect(a).toMatchObject({
      id: 13,
      daily_send_quota: QUOTA,
      warmup_quota: 10,
      effective_daily_quota: 10,
      warmup_until: warmupStart + 24 * HOUR,
    });
  });

  it("owner：/api/me 的 owner 分支同樣折算（配額 50 → 20）", async () => {
    const token = await signOwnerToken(E, 1, 0);
    const [a] = await meAddresses(token);
    expect(a).toMatchObject({
      id: 1,
      daily_send_quota: 50,
      effective_daily_quota: WARMUP_QUOTA,
    });
    expect(a!.warmup_until).toBe(warmupStart + 24 * HOUR);
  });

  it("/api/account/settings 與 /api/me 回同一組值（個人設置頁顯示用）", async () => {
    const token = await signMailboxToken(E, 10, "warm@atwho.org", 0);
    const [me] = await meAddresses(token);
    const [settings] = await settingsAddresses(token);
    expect(settings!.effective_daily_quota).toBe(me!.effective_daily_quota);
    expect(settings!.warmup_until).toBe(me!.warmup_until);
    expect(settings).toMatchObject({ effective_daily_quota: WARMUP_QUOTA });
  });
});
