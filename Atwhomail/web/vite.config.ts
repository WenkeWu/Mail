import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

/**
 * 開發時 `/api` 由 Vite proxy 轉往 API Worker（預設 production；可用
 * VITE_API_PROXY_TARGET=http://127.0.0.1:8787 改打本機 wrangler dev）。
 * 瀏覽器端一律同源 → 開發期無 CORS 問題；正式部署時以 VITE_API_BASE 指向 API。
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ".", "");
  const target = env.VITE_API_PROXY_TARGET || "https://atwhomail-api.ulhome.workers.dev";
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        "/api": { target, changeOrigin: true, secure: true },
      },
    },
    build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  };
});
