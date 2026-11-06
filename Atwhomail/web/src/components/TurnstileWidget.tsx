import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { loadTurnstileScript, type TurnstileApi } from "../lib/turnstile";

interface Props {
  siteKey: string;
  /** token 變更：通過 → token；過期／失敗 → `null`（呼叫端據此停用送出） */
  onToken: (token: string | null) => void;
  /** 變更即重新 render widget（Turnstile token 一次性；送出後需取得新 token） */
  resetKey?: number;
}

/**
 * D23：Turnstile widget（explicit render；theme auto）。
 * site key 未設定時 `LoginPage` 不會渲染本元件，也就不會載入腳本。
 */
export function TurnstileWidget({ siteKey, onToken, resetKey = 0 }: Props) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement | null>(null);
  // 父層每次 render 都會傳新的箭頭函式 → 以 ref 保存，避免 widget 被反覆重建
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let alive = true;
    let api: TurnstileApi | null = null;
    let widgetId: string | number | undefined;

    setLoading(true);
    setError(null);
    onTokenRef.current(null);

    loadTurnstileScript()
      .then((loaded) => {
        if (!alive) return;
        api = loaded;
        widgetId = loaded.render(container, {
          sitekey: siteKey,
          theme: "auto",
          callback: (token) => {
            if (!alive) return;
            setError(null);
            onTokenRef.current(token);
          },
          "expired-callback": () => {
            if (!alive) return;
            onTokenRef.current(null);
            setError(t("驗證已過期，請重新完成驗證。"));
          },
          "error-callback": () => {
            if (!alive) return;
            onTokenRef.current(null);
            setError(t("機器人驗證載入失敗，請重試。"));
          },
        });
        setLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        onTokenRef.current(null);
        setLoading(false);
        setError(t("機器人驗證載入失敗，請重試。"));
      });

    return () => {
      alive = false;
      if (api && widgetId !== undefined) {
        try {
          api.remove?.(widgetId);
        } catch {
          /* 清除失敗不影響表單（例如 iframe 已被移除） */
        }
      }
    };
  }, [siteKey, resetKey, t]);

  return (
    <div className="turnstile-widget">
      <div ref={containerRef} />
      {loading && <p className="login-hint">{t("正在載入機器人驗證…")}</p>}
      {error && (
        <p className="login-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
