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
    include: ["packages/*/test/**/*.spec.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
