import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * 前端 **DOM 測試**環境（docs/16 D12）。
 *
 * 為什麼要獨立成一份設定：根目錄的 `vitest.config.ts` 跑在 `@cloudflare/vitest-plugin` 的
 * **workerd pool**（測 D1／R2／Hono 端點），該 pool 沒有 DOM，`.tsx` 元件無法渲染。
 * 這裡改用 vitest 內建的 **jsdom** 環境 ＋ React 19 ＋ `@testing-library/react`，
 * 只收 `test/**\/*.dom.spec.tsx`（後綴 `.dom.` 是刻意的：根目錄的 `include` 是
 * `web/test/**\/*.spec.ts`，**不會**把這些檔案抓進 workerd pool 再跑一次）。
 *
 * ⚠️ 純函式測試（`hostMode.spec.ts`／`adminConsole.spec.ts`／`statusSemantics.spec.ts`）
 *    仍留在原本的 pool，一個字都沒改（D12 明文要求）。
 *
 * 執行方式：根目錄 `pnpm test` 會先跑 workerd pool，再 `pnpm --filter @atwhomail/web run test`
 * 跑這一組；也可以直接在 `web/` 目錄 `pnpm test`。
 */
export default defineConfig({
  root: rootDir,
  plugins: [react()],
  test: {
    name: "web-dom",
    environment: "jsdom",
    include: ["test/**/*.dom.spec.tsx"],
    setupFiles: ["./test/dom-setup.ts"],
    // 每個測試都必須自己安裝 fetch mock（見 dom-setup.ts 的失敗安全網）
    unstubGlobals: true,
    restoreMocks: true,
    testTimeout: 15_000,
  },
});
