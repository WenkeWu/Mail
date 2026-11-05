/**
 * appLogin.ts — `app.atwho.org` 的 App 登入轉交參數（D26，docs/27 §5）
 *
 * 其他 App 把人導到：
 *   https://app.atwho.org/?app=mycrm&redirect_uri=https%3A%2F%2Fcrm.example.com%2Fcb
 *
 * ⚠️ 安全邊界（docs/16 N3）：前端的檢查**只影響顯示與是否發起轉交**；
 *    app 是否存在、redirect_uri 是否在白名單，一律由後端 app-login 判定。
 *    前端不得自行把 redirect_uri 當成可信目的地（一定要以後端回的 `redirect` 為準）。
 */

export interface AppLoginQuery {
  /** 網址是否帶了 app／redirect_uri（任一）。false = 維持既有登入／註冊行為 */
  active: boolean;
  app: string | null;
  redirectUri: string | null;
  /** 參數不完整或格式錯誤時的提示（不導向；`null` = 正常） */
  error: string | null;
}

/** 與後端 app_clients.app_id 相同的格式（僅作前端早期提示） */
const APP_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * 解析 `location.search`。
 * - 兩個參數都沒帶 → `active:false`（完全不影響既有 `?register=1`／`?invite=` 行為）
 * - 只帶其中一個 → `active:true` ＋ error（顯示錯誤、不導向）
 * - app 格式或 redirect_uri 不是絕對網址 → `active:true` ＋ error
 */
export function parseAppLoginQuery(search: string): AppLoginQuery {
  const params = new URLSearchParams(search);
  const rawApp = params.get("app");
  const rawRedirect = params.get("redirect_uri");
  const app = rawApp?.trim() ?? "";
  const redirectUri = rawRedirect?.trim() ?? "";

  if (app === "" && redirectUri === "") {
    return { active: false, app: null, redirectUri: null, error: null };
  }
  if (app === "" || redirectUri === "") {
    return {
      active: true,
      app: app || null,
      redirectUri: redirectUri || null,
      error: "登入參數不完整：需要 app 與 redirect_uri",
    };
  }
  if (!APP_ID_RE.test(app)) {
    return { active: true, app, redirectUri, error: "app 參數格式錯誤（需為小寫英數字／連字號）" };
  }
  if (!isHttpUrl(redirectUri)) {
    return { active: true, app, redirectUri, error: "redirect_uri 必須是完整的 http(s) 網址" };
  }
  return { active: true, app, redirectUri, error: null };
}
