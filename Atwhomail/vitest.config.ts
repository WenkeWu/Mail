import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * 正式測試環境（Phase 16）
 * - Workers 測試整合：測試在 workerd 內執行（支援 HTMLRewriter / D1 / R2）
 * - D1 migrations 於 setup 階段自動套用（test/apply-migrations.ts）
 * - 密鑰以 bindings 注入；全程本機執行，不觸及任何遠端資源
 */
export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations(path.join(rootDir, "migrations"));
      return {
        wrangler: { configPath: "./test/wrangler.jsonc" },
        miniflare: {
          compatibilityDate: "2026-06-01",
          bindings: {
            JWT_SECRET: "test-jwt-secret",
            ADMIN_TOKEN: "test-admin-token",
            TEST_MIGRATIONS: migrations,
          },
        },
      };
    }),
  ],
  test: {
    // 2026-10-14：加入 web/ 的測試（D1 的 hostname→顯示模式純函式，docs/16 §6 T7；
    // 前端只有純函式可在此 pool 測，JSX 渲染需 DOM 環境，本 repo 尚無該 runner）
    include: ["packages/*/test/**/*.spec.ts", "web/test/**/*.spec.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
    /**
     * 2026-10-13：逾時由預設 5s 放寬到 30s。
     * 原因：argon2id 每次雜湊／驗證約 0.7–0.9 秒，而「登入鎖定（6 次驗證）」「註冊（雜湊）」
     * 「配額（多次登入＋寄信）」等案例一次要做 4–6 次 → 實測最慢已達 4.6 秒，逼近 5 秒上限；
     * 機器一有負載（例如排程備份同時在跑）就會整批 timeout（實測一次 7 案例同時紅）。
     * 這些測試是「真的在算密碼」而不是卡住，放寬逾時才是正確的處置。
     */
    testTimeout: 30_000,
    /**
     * 2026-10-15：`hookTimeout` 一併由預設 10s 放寬到 30s。
     * 原因與 `testTimeout` 完全相同（機器有負載時整批變慢），但**預設值不同** ——
     * `testTimeout` 放寬後 hook 仍是 10s，於是 `beforeEach`（清 8 張表 ＋ 種 owner）
     * 在滿載時成為新的瓶頸：實測 `admin-status.spec.ts` 出現 `Hook timed out in 10000ms`
     * （同一案例單獨跑 100% 通過，屬環境負載而非行為回歸）。
     */
    hookTimeout: 30_000,
  },
});
