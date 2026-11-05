/**
 * domain-check.spec.ts — D20：註冊 ID 與二級網域同名偵測（docs/20）
 *
 * 測試在 workerd 內以真實 D1 執行；DoH 一律以 `setDomainCheckTestHooks()` mock
 * （全域預設在 test/apply-migrations.ts：全部 NXDOMAIN）。
 *
 * 覆蓋：
 * - T139 命中網域（NOERROR）→ 422 ID_MATCHES_DOMAIN ＋建議清單
 * - T140 未命中（NXDOMAIN）→ 可註冊
 * - T141 DoH 失敗 → fail-open（可註冊）＋ warning
 * - T142 快取命中：第二次不再發 DoH 請求
 * - T143 保留字 → ID_RESERVED；assignAvailableLocalPart('admin') → user base
 * - T144 assignAvailableLocalPart('hp')（hp.com 命中）→ hp001
 * - T145 check-id 速率限制（每分鐘 20 次）→ 429
 *
 * T146（既有 T1–T138 零回歸）＝完整 `pnpm test`，不是本檔的單一案例。
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import {
  assignAvailableLocalPart,
  CHECK_TLDS,
  checkLabelAgainstDomains,
  setDomainCheckTestHooks,
} from "../src/domains";
import type { Env } from "../src/auth";

const E = env as unknown as Env;

interface SentMail {
  from: string;
  to: string[];
  subject: string;
  text?: string;
  html?: string;
}

const sentMails: SentMail[] = [];

function installEmailMock(): void {
  const mock = {
    send: async (msg: SentMail) => {
      sentMails.push({ from: msg.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
      return { messageId: `mock-${sentMails.length}@atwho.org` };
    },
  };
  (E as unknown as { EMAIL: typeof mock }).EMAIL = mock;
}

async function req(path: string, body: unknown, ip: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.request(
    path,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "cf-connecting-ip": ip },
      body: JSON.stringify(body),
    },
    E,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return res;
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function errorBody(body: unknown): { code?: string; message?: string; suggestions?: string[] } {
  return (body as { error?: { code?: string; message?: string; suggestions?: string[] } })?.error ?? {};
}

/** DoH 假回應：status 0 = NOERROR（帶 Answer）；3 = NXDOMAIN */
function dohResponse(status: number): Response {
  const body =
    status === 0
      ? { Status: 0, Answer: [{ name: "example.test", type: 2, TTL: 300, data: "ns1.example.test." }] }
      : { Status: status };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/dns-json" },
  });
}

/**
 * 安裝 DoH mock：`hitNames` 內的完整網域回 NOERROR，其餘 NXDOMAIN。
 * 回傳 `calls`（每次 fetch 的 URL）供 T142 計數。
 */
function mockDoh(hitNames: ReadonlySet<string>): { calls: string[] } {
  const calls: string[] = [];
  setDomainCheckTestHooks({
    fetch: async (input) => {
      const url = new URL(String(input));
      calls.push(url.href);
      const name = url.searchParams.get("name") ?? "";
      return dohResponse(hitNames.has(name) ? 0 : 3);
    },
  });
  return { calls };
}

beforeEach(async () => {
  installEmailMock();
  sentMails.length = 0;
  E.REGISTRATION_MODE = "email_verify";
  E.REGISTRATION_DISABLED = "false";
  setDomainCheckTestHooks({ fetch: null, now: null });

  for (const table of [
    "domain_checks",
    "id_blocklist",
    "email_verifications",
    "registration_audit",
    "auth_attempts",
    "invites",
    "attachments",
    "messages",
    "email_aliases",
    "email_addresses",
    "users",
  ]) {
    await E.DB.prepare(`DELETE FROM ${table}`).run();
  }

  const ts = Date.now();
  // owner 僅作為既有使用者（避免 FK／username 衝突）；本檔不測 owner 登入
  await E.DB.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, status, role, created_at, updated_at)
     VALUES (1, 'owner', 'Owner', 'x', 'active', 'owner', ?1, ?1)`
  )
    .bind(ts)
    .run();
});

describe("D20 T139–T142：DoH 判定與快取", { timeout: 90_000 }, () => {
  it("T139 命中網域（NOERROR）→ check-id／register-request 422 ID_MATCHES_DOMAIN ＋建議清單", async () => {
    mockDoh(new Set(["hp.com"]));

    const check = await req("/api/auth/check-id", { label: "hp" }, "198.51.100.139");
    expect(check.status).toBe(200);
    const checkBody = await json<{
      available: boolean;
      reason: string;
      tldHit?: string;
      suggestions?: string[];
    }>(check);
    expect(checkBody.available).toBe(false);
    expect(checkBody.reason).toBe("MATCHES_DOMAIN");
    expect(checkBody.tldHit).toBe("com");
    expect(checkBody.suggestions?.length).toBe(4);
    expect(checkBody.suggestions).not.toContain("hp");
    expect(checkBody.suggestions?.every((s) => typeof s === "string" && s.length > 0)).toBe(true);

    const res = await req(
      "/api/auth/register-request",
      { email: "t139@example.com", local_part: "hp" },
      "198.51.100.139"
    );
    expect(res.status).toBe(422);
    const body = errorBody(await json(res));
    expect(body.code).toBe("ID_MATCHES_DOMAIN");
    expect(body.suggestions?.length).toBe(6);
    // 未寄出驗證碼
    expect(sentMails).toHaveLength(0);
  });

  it("T140 未命中（NXDOMAIN）→ 可註冊並寄出驗證碼", async () => {
    mockDoh(new Set());

    const res = await req(
      "/api/auth/register-request",
      { email: "t140@example.com", local_part: "zzqqxxyy123" },
      "198.51.100.140"
    );
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ sent: true, expiresIn: 900 });
    expect(sentMails).toHaveLength(1);
  });

  it("T141 DoH 失敗 → fail-open（可註冊）＋ warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setDomainCheckTestHooks({
      fetch: async () => {
        throw new Error("DoH unavailable");
      },
    });

    try {
      const direct = await checkLabelAgainstDomains(E, "t141probe");
      expect(direct.hit).toBe(false);
      expect(direct.degraded).toBe(true);

      const res = await req(
        "/api/auth/register-request",
        { email: "t141@example.com", local_part: "failopenuser" },
        "198.51.100.141"
      );
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ sent: true, expiresIn: 900 });
      expect(sentMails).toHaveLength(1);

      // 必須留下 warning（fail-open 不是靜默放行）
      const warned = warn.mock.calls.some((args) => String(args[0]).includes("fail-open"));
      expect(warned).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("T142 快取命中：第二次不再發 DoH 請求", async () => {
    const { calls } = mockDoh(new Set());

    const first = await checkLabelAgainstDomains(E, "cacheprobe");
    expect(first.hit).toBe(false);
    expect(first.degraded).toBeUndefined();
    expect(calls).toHaveLength(CHECK_TLDS.length); // 每個 TLD 一次

    const second = await checkLabelAgainstDomains(E, "cacheprobe");
    expect(second.hit).toBe(false);
    expect(calls).toHaveLength(CHECK_TLDS.length); // 沒有新增 DoH 請求

    const row = await E.DB.prepare("SELECT hit, tld_hit, checked_at FROM domain_checks WHERE label = ?1")
      .bind("cacheprobe")
      .first<{ hit: number; tld_hit: string | null; checked_at: number }>();
    expect(row?.hit).toBe(0);
    expect(row?.tld_hit).toBeNull();
    expect(row?.checked_at).toBeGreaterThan(0);
  });
});

describe("D20 T143–T145：保留字、流水號與限流", { timeout: 90_000 }, () => {
  it("T143 保留字 → 422 ID_RESERVED；assignAvailableLocalPart('admin') 以 user 為 base", async () => {
    mockDoh(new Set());

    const res = await req(
      "/api/auth/register-request",
      { email: "t143@example.com", local_part: "admin" },
      "198.51.100.143"
    );
    expect(res.status).toBe(422);
    expect(errorBody(await json(res)).code).toBe("ID_RESERVED");
    expect(sentMails).toHaveLength(0);

    const assigned = await assignAvailableLocalPart(E, "admin");
    expect(assigned).toBe("user");
  });

  it("T144 assignAvailableLocalPart('hp')（hp.com 命中）→ hp001", async () => {
    mockDoh(new Set(["hp.com"]));

    const assigned = await assignAvailableLocalPart(E, "hp");
    expect(assigned).toBe("hp001");
  });

  it("T145 check-id 速率限制（每分鐘 20 次）→ 第 21 次 429", async () => {
    mockDoh(new Set());
    const ip = "198.51.100.145";

    // 正常查詢會累加同一分鐘的計數
    for (let i = 1; i <= 2; i += 1) {
      const res = await req("/api/auth/check-id", { label: "speedtest" }, ip);
      expect(res.status, `第 ${i} 次`).toBe(200);
    }
    const counter = await E.DB.prepare("SELECT fail_count FROM auth_attempts WHERE key = ?1")
      .bind(`check-id:${ip}`)
      .first<{ fail_count: number }>();
    expect(counter?.fail_count).toBe(2);

    // 直接播種「本分鐘已達 20 次」→ 下一次必定 429。
    // updated_at 設在未來，避免測試剛好跨分鐘邊界造成 flake。
    const key = `check-id:${ip}`;
    await E.DB.prepare(
      `INSERT INTO auth_attempts (key, fail_count, locked_until, updated_at)
       VALUES (?1, 20, 0, ?2)
       ON CONFLICT(key) DO UPDATE SET fail_count = 20, updated_at = ?2`
    )
      .bind(key, Date.now() + 60_000)
      .run();

    const blocked = await req("/api/auth/check-id", { label: "speedtest" }, ip);
    expect(blocked.status).toBe(429);
    expect(errorBody(await json(blocked)).code).toBe("RATE_LIMITED");
  });
});
