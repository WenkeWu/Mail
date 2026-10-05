/**
 * apply-migrations.ts — 測試池 setup：對測試 D1 套用 migrations/ 內全部 migration
 * （Cloudflare 官方 D1 測試 recipe）
 */
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
