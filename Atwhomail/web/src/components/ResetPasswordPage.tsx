/**
 * ResetPasswordPage — `?reset=<token>` 的「設定新密碼」頁（docs/28 §6.3）
 *
 * 成功後由 App 清掉 query 並回到登入頁顯示提示；token 無效／過期時顯示 server 訊息，
 * 不提供任何 token 內容（避免洩漏）。
 */
import { useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import { resetPassword } from "../api/endpoints";
import { IconMail } from "./icons";

interface Props {
  token: string;
  onDone: (notice: string) => void;
}

export function ResetPasswordPage({ token, onDone }: Props) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (password !== confirm) {
      setError("兩次輸入的密碼不一致");
      return;
    }
    setBusy(true);
    try {
      await resetPassword(token, password);
      onDone("密碼已重設，請用新密碼登入。");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "重設失敗，請稍後再試");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <span className="brand-mark">
            <IconMail size={26} />
          </span>
          <div>
            <h1>AtWhoMail</h1>
            <p>設定新密碼</p>
          </div>
        </div>

        <form onSubmit={submit} className="login-form">
          <p className="login-hint">重設連結 30 分鐘內有效，且只能使用一次。</p>
          <label>
            新密碼
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="至少 8 個字元"
              autoComplete="new-password"
              autoFocus
              required
            />
          </label>
          <label>
            確認新密碼
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
            />
          </label>
          {error && <p className="login-error">{error}</p>}
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? "設定中…" : "設定新密碼"}
          </button>
        </form>
      </div>
    </div>
  );
}
