/**
 * turnstile.ts — D23：Cloudflare Turnstile 機器人驗證（docs/23）
 *
 * 設計原則（docs/23 §1、§3）：
 * - `TURNSTILE_SECRET_KEY` 未設定／空字串 → **跳過驗證**（行為同 D21），只記一次 warning
 *   （避免每個請求都洗版；每個 Worker isolate 最多一次）。
 * - siteverify 網路／API 失敗 → **fail-open**（放行＋warning；可用性優先，比照 docs/20 DoH 決策）。
 * - `success !== true` → 驗證失敗（呼叫端回 400 `TURNSTILE_FAILED`）。
 *
 * ⚠️ secret 只存在 Worker secret 中，不得寫入 repo（docs/16 N7）。
 */
import type { Env } from "./auth";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** fail-open 前的等待上限：Turnstile 掛掉時不可拖垮註冊（可用性優先） */
const SITEVERIFY_TIMEOUT_MS = 5_000;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const defaultFetch: FetchLike = (input, init) => fetch(input, init);

/**
 * 可注入的 fetch（僅供測試覆寫；傳 `null` 還原預設）。
 * 測試不得真的打 `challenges.cloudflare.com`（不可重現、拖慢、CI 可能無網路）。
 */
let fetchImpl: FetchLike = defaultFetch;
export function setTurnstileTestHooks(hooks: { fetch?: FetchLike | null }): void {
  if (hooks.fetch !== undefined) fetchImpl = hooks.fetch ?? defaultFetch;
}

/** 前端用的公開 site key；未設定／空字串 → `null`（前端不載入 widget） */
export function turnstileSiteKey(env: Env): string | null {
  const key = (env.TURNSTILE_SITE_KEY ?? "").trim();
  return key === "" ? null : key;
}

let missingSecretWarned = false;

export type TurnstileResult =
  /** 通過，或 secret 未設定（跳過） */
  | "ok"
  /** siteverify 明確回報 `success !== true` → 應拒絕請求 */
  | "failed"
  /** 網路／HTTP／解析失敗 → fail-open（放行），已記 warning */
  | "unavailable";

/**
 * 驗證 Turnstile token。
 *
 * @param token 前端 widget 取得的 token（缺少時傳 `undefined`／空字串；已啟用 secret 時即為失敗）
 * @param remoteIp 使用者 IP（`remoteip`；可為 null）
 */
export async function verifyTurnstile(
  env: Env,
  token: string | undefined,
  remoteIp: string | null
): Promise<TurnstileResult> {
  const secret = (env.TURNSTILE_SECRET_KEY ?? "").trim();
  if (secret === "") {
    if (!missingSecretWarned) {
      missingSecretWarned = true;
      console.warn(
        "[atwhomail-api] TURNSTILE_SECRET_KEY 未設定 — D23 機器人驗證未啟用（register-request 跳過 siteverify）"
      );
    }
    return "ok";
  }

  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", (token ?? "").trim());
  if (remoteIp) form.set("remoteip", remoteIp);

  try {
    const res = await fetchImpl(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn("[atwhomail-api] Turnstile siteverify HTTP error — fail-open", { status: res.status });
      return "unavailable";
    }
    const body = (await res.json()) as { success?: unknown };
    return body?.success === true ? "ok" : "failed";
  } catch (e) {
    // 網路錯誤／逾時／JSON 解析失敗 → fail-open（docs/23 §3；可用性優先）
    console.warn("[atwhomail-api] Turnstile siteverify unavailable — fail-open", { error: String(e) });
    return "unavailable";
  }
}
