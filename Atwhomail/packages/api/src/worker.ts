/**
 * Cloudflare Workers 進入點：HTTP（Hono）＋ cron。
 *
 * `index.ts` 仍預設匯出 Hono app，測試直接 import 它；
 * 正式部署走本檔，cron 每 5 分鐘向 AllChat 拉取身分等級投影。
 */
import app from "./index";
import { syncAllChatLevels } from "./visitors";
import type { Env } from "./auth";

export default {
  fetch: app.fetch,
  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      syncAllChatLevels(env).catch((error) => {
        console.error("[atwhomail-api] allchat level sync failed", {
          error: String(error),
        });
      })
    );
  },
} satisfies ExportedHandler<Env>;
