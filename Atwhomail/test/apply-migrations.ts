/**
 * apply-migrations.ts — 測試池 setup：
 * 1) 對測試 D1 套用 migrations/ 內全部 migration（Cloudflare 官方 D1 測試 recipe）
 * 2) D20：把 DoH fetch 預設為「全部 NXDOMAIN」
 *
 * 為什麼要 (2)：`register-request`／`register-verify` 現在會檢查二級網域（25 個 TLD）。
 * 測試環境不得真的打 `cloudflare-dns.com`（不可重現、拖慢、CI 可能無網路）。
 * 個別案例（T139／T141／T142）再用 `setDomainCheckTestHooks()` 覆寫成命中／失敗／計數。
 *
 * 3) D23：Turnstile siteverify 也預設為本機假回應（`success:false`）。
 *    既有測試未設定 `TURNSTILE_SECRET_KEY` → 根本不會呼叫；T148／T149 再以
 *    `setTurnstileTestHooks()` 覆寫成無效／有效 token。
 */
import { applyD1Migrations, env } from "cloudflare:test";
import { setDomainCheckTestHooks } from "../packages/api/src/domains";
import { setTurnstileTestHooks } from "../packages/api/src/turnstile";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

setDomainCheckTestHooks({
  fetch: async () =>
    new Response(JSON.stringify({ Status: 3 }), {
      status: 200,
      headers: { "content-type": "application/dns-json" },
    }),
});

setTurnstileTestHooks({
  fetch: async () =>
    new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
});
