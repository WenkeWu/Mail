/**
 * turnstile.ts — D23：Cloudflare Turnstile 前端載入器（docs/23 §4）
 *
 * - 只有 `registration-mode.turnstileSiteKey` 非空時才會呼叫；
 *   site key 未設定 → 完全不載入腳本、不顯示 widget（行為同 D21）。
 * - 以 `render=explicit` 載入，widget 由 `TurnstileWidget` 明確 render 到容器
 *   （避免隱式 render 誤抓頁面上其他元素）。
 * - 重複呼叫共用同一個 Promise；載入失敗後允許重試。
 */

export interface TurnstileRenderOptions {
  sitekey: string;
  theme?: "auto" | "light" | "dark";
  callback?: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: () => void;
  "timeout-callback"?: () => void;
}

export interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): string | number;
  reset(widgetId?: string | number): void;
  remove?(widgetId?: string | number): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

export const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

let loading: Promise<TurnstileApi> | null = null;

function waitForScript(script: HTMLScriptElement): Promise<TurnstileApi> {
  return new Promise((resolve, reject) => {
    const ready = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error("Turnstile API 未就緒"));
    };
    script.addEventListener("load", ready, { once: true });
    script.addEventListener("error", () => reject(new Error("Turnstile 腳本載入失敗")), { once: true });
  });
}

/** 載入 Turnstile 腳本；已載入（`window.turnstile` 存在）則立即回傳。 */
export function loadTurnstileScript(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (loading) return loading;

  const existing = document.querySelector<HTMLScriptElement>(`script[src="${TURNSTILE_SCRIPT_SRC}"]`);
  const script = existing ?? document.createElement("script");
  if (!existing) {
    script.src = TURNSTILE_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
  }

  loading = waitForScript(script);
  // 失敗後清掉快取，讓下次掛載可重試（例如網路恢復）
  loading.catch(() => {
    loading = null;
  });
  return loading;
}
