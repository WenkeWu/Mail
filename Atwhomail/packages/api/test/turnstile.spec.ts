/**
 * turnstile.spec.ts — D23：Cloudflare Turnstile 防機器人（docs/23 §5；T147–T150）
 *
 * 測試在 workerd 內以真實 D1 執行；`EMAIL` binding 以 mock 注入。
 * Turnstile siteverify 一律以 `setTurnstileTestHooks()` mock（全域預設在
 * test/apply-migrations.ts：`success:false`），不得真的打 challenges.cloudflare.com。
 *
 * 覆蓋：
 * - T147 `TURNSTILE_SECRET_KEY` 未設定 → 跳過驗證、200 並寄碼；warning 只記一次
 * - T148 secret 已設定 + token 無效（siteverify success=false）→ 400 TURNSTILE_FAILED，
 *        不寄碼、不建立 email_verifications，稽核 register_rejected(reason=turnstile_failed)
 * - T149 secret 已設定 + token 有效（success=true）→ 200 並寄碼
 * - T150 `registration-mode` 回傳 turnstileSiteKey（未設定 null／有設定字串）
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env } from "../src/auth";
import { setTurnstileTestHooks } from "../src/turnstile";

const E = env as unknown as Env;

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SECRET = "test-turnstile-secret";

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

async function get(path: string): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await app.request(path, {}, E, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function errorCode(body: unknown): string {
  return (body as { error?: { code?: string } })?.error?.code ?? "";
}

function requestCode(email: string, localPart: string, ip: string, turnstileToken?: string): Promise<Response> {
  return req(
    "/api/auth/register-request",
    {
      email,
      local_part: localPart,
      ...(turnstileToken === undefined ? {} : { turnstile_token: turnstileToken }),
    },
    ip
  );
}

interface SiteverifyCall {
  url: string;
  body: URLSearchParams;
}

/** siteverify 假回應；回傳每次呼叫的 form 內容供斷言（T148／T149） */
function mockSiteverify(success: boolean): { calls: SiteverifyCall[] } {
  const calls: SiteverifyCall[] = [];
  setTurnstileTestHooks({
    fetch: async (input, init) => {
      calls.push({ url: String(input), body: new URLSearchParams(String(init?.body ?? "")) });
      return new Response(JSON.stringify({ success }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { calls };
}

async function countVerificationRows(): Promise<number> {
  const row = await E.DB.prepare("SELECT COUNT(*) AS n FROM email_verifications").first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function lastAudit(): Promise<{ event: string; detail: string | null } | null> {
  return E.DB.prepare("SELECT event, detail FROM registration_audit ORDER BY id DESC LIMIT 1").first<{
    event: string;
    detail: string | null;
  }>();
}

beforeEach(async () => {
  installEmailMock();
  sentMails.length = 0;
  E.REGISTRATION_MODE = "email_verify";
  E.REGISTRATION_DISABLED = "false";
  E.TURNSTILE_SECRET_KEY = undefined;
  E.TURNSTILE_SITE_KEY = undefined;
  setTurnstileTestHooks({ fetch: null });

  for (const t of [
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
    await E.DB.prepare(`DELETE FROM ${t}`).run();
  }
  const ts = Date.now();
  await E.DB.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, status, role, created_at, updated_at)
     VALUES (1, 'owner', 'Owner', 'x', 'active', 'owner', ?1, ?1)`
  )
    .bind(ts)
    .run();
});

describe("T147–T150：D23 Turnstile", { timeout: 30_000 }, () => {
  it("T147 未設定 secret → 跳過驗證、200 並寄碼；warning 只記一次", async () => {
    E.TURNSTILE_SECRET_KEY = undefined;
    const siteverifyCalls: unknown[] = [];
    setTurnstileTestHooks({
      fetch: async () => {
        siteverifyCalls.push("called");
        throw new Error("未設定 secret 時不得呼叫 siteverify");
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const res = await requestCode("t147@example.com", "turn147", "203.0.113.147");
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ sent: true, expiresIn: 900 });

      // 第二次（不同 Email／IP，避開限流）：行為相同，但 warning 不重複
      const res2 = await requestCode("t147b@example.com", "turn147b", "203.0.113.148");
      expect(res2.status).toBe(200);

      expect(sentMails).toHaveLength(2);
      expect(siteverifyCalls).toHaveLength(0);
      expect(await countVerificationRows()).toBe(2);

      const missingSecretWarnings = warn.mock.calls.filter((args) =>
        String(args[0]).includes("TURNSTILE_SECRET_KEY")
      );
      expect(missingSecretWarnings).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("T148 secret 已設定 + token 無效 → 400 TURNSTILE_FAILED；不寄碼、不建驗證紀錄", async () => {
    E.TURNSTILE_SECRET_KEY = SECRET;
    const siteverify = mockSiteverify(false);

    const res = await requestCode("t148@example.com", "turn148", "203.0.113.149", "invalid-token");
    expect(res.status).toBe(400);
    const body = await json<{ error: { code: string; message: string } }>(res);
    expect(errorCode(body)).toBe("TURNSTILE_FAILED");
    expect(body.error.message).toBe("機器人驗證未通過，請重試");

    // 不寄碼、不建立 email_verifications
    expect(sentMails).toHaveLength(0);
    expect(await countVerificationRows()).toBe(0);

    // 呼叫 siteverify（form-urlencoded：secret／response／remoteip）
    expect(siteverify.calls).toHaveLength(1);
    expect(siteverify.calls[0]!.url).toBe(SITEVERIFY_URL);
    expect(siteverify.calls[0]!.body.get("secret")).toBe(SECRET);
    expect(siteverify.calls[0]!.body.get("response")).toBe("invalid-token");
    expect(siteverify.calls[0]!.body.get("remoteip")).toBe("203.0.113.149");

    // 稽核：register_rejected，只記 reason
    const audit = await lastAudit();
    expect(audit?.event).toBe("register_rejected");
    expect(JSON.parse(audit!.detail!)).toEqual({ reason: "turnstile_failed" });
  });

  it("T148 補：siteverify 網路失敗 → fail-open（200 並寄碼）＋ warning", async () => {
    E.TURNSTILE_SECRET_KEY = SECRET;
    setTurnstileTestHooks({
      fetch: async () => {
        throw new Error("network down");
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const res = await requestCode("t148b@example.com", "turn148b", "203.0.113.151", "some-token");
      expect(res.status).toBe(200);
      expect(sentMails).toHaveLength(1);
      expect(await countVerificationRows()).toBe(1);
      expect(warn.mock.calls.some((args) => String(args[0]).includes("fail-open"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("T149 secret 已設定 + token 有效 → 200 並寄碼", async () => {
    E.TURNSTILE_SECRET_KEY = SECRET;
    const siteverify = mockSiteverify(true);

    const res = await requestCode("t149@example.com", "turn149", "203.0.113.150", "valid-token");
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ sent: true, expiresIn: 900 });

    expect(siteverify.calls).toHaveLength(1);
    expect(siteverify.calls[0]!.body.get("secret")).toBe(SECRET);
    expect(siteverify.calls[0]!.body.get("response")).toBe("valid-token");
    expect(sentMails).toHaveLength(1);
    expect(await countVerificationRows()).toBe(1);
  });

  it("T150 registration-mode 回傳 turnstileSiteKey（未設定 null／空字串 null／有設定字串）", async () => {
    E.REGISTRATION_MODE = "email_verify";

    E.TURNSTILE_SITE_KEY = undefined;
    expect(await json(await get("/api/auth/registration-mode"))).toEqual({
      mode: "email_verify",
      turnstileSiteKey: null,
    });

    // wrangler.jsonc 的預設值是空字串 → 一樣視為未啟用
    E.TURNSTILE_SITE_KEY = "";
    expect(await json(await get("/api/auth/registration-mode"))).toEqual({
      mode: "email_verify",
      turnstileSiteKey: null,
    });

    E.TURNSTILE_SITE_KEY = "0x4AAAAAAA_test_site_key";
    expect(await json(await get("/api/auth/registration-mode"))).toEqual({
      mode: "email_verify",
      turnstileSiteKey: "0x4AAAAAAA_test_site_key",
    });
  });
});
