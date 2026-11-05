/**
 * AppHandoff — D26 登入後轉交畫面（docs/27 §5）
 *
 * 使用者已在 `app.atwho.org` 登入；前端向 `app-login` 取得一次性 code 後
 * `location.assign(redirect)` 回到其他 App。這裡只負責顯示「正在返回」與失敗訊息。
 *
 * ⚠️ 失敗時**不導向**（也不把使用者自行提供的 redirect_uri 當成目的地）——
 *    只有後端回傳的 `redirect` 才會被使用。
 */
import { IconMail } from "./icons";

interface Props {
  /** 目標 App ID（僅顯示） */
  app: string | null;
  status: "pending" | "error";
  error: string | null;
  onRetry: () => void;
  /** 放棄轉交，繼續使用 AtWhoMail（不影響已建立的 session） */
  onCancel: () => void;
}

export function AppHandoff({ app, status, error, onRetry, onCancel }: Props) {
  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <span className="brand-mark">
            <IconMail size={26} />
          </span>
          <div>
            <h1>AtWhoMail</h1>
            <p>應用程式登入</p>
          </div>
        </div>

        {status === "pending" ? (
          <>
            <p className="login-hint">登入成功，正在返回{app ? `「${app}」` : "應用程式"}…</p>
            <div className="list-state">
              <div className="spinner" />
            </div>
          </>
        ) : (
          <>
            <p className="login-error">{error ?? "無法完成應用程式登入，請稍後再試"}</p>
            <p className="login-hint">
              授權失敗時不會帶你前往其他網站。你可以重試，或先繼續使用 AtWhoMail。
            </p>
            <div className="register-actions">
              <button type="button" className="btn-secondary" onClick={onRetry}>
                重試
              </button>
              <button type="button" className="btn-link" onClick={onCancel}>
                以 AtWhoMail 繼續
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
