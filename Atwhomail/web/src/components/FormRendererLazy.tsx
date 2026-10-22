/**
 * FormRendererLazy — 互動式表單的 lazy 入口（docs/18 §15 D18-2）
 *
 * RJSF（`@rjsf/core` ＋ `@rjsf/validator-ajv8`）約 380 kB，只有開啟互動式郵件時才需要。
 * 以 `React.lazy()` 動態載入 `FormRenderer`，讓首屏 bundle 不再包含 RJSF；
 * 載入期間顯示「表單載入中…」。
 *
 * ⚠️ 不要從這個檔案以外的地方靜態 import `./FormRenderer`（會把 RJSF 拉回首屏 bundle）。
 */
import { lazy, Suspense } from "react";
import type { FormRendererProps } from "./FormRenderer";

const LazyFormRenderer = lazy(() =>
  import("./FormRenderer").then((m) => ({ default: m.FormRenderer }))
);

export function FormRenderer(props: FormRendererProps) {
  return (
    <Suspense
      fallback={
        <div className="list-state" role="status">
          <div className="spinner" />
          <p>表單載入中…</p>
        </div>
      }
    >
      <LazyFormRenderer {...props} />
    </Suspense>
  );
}
