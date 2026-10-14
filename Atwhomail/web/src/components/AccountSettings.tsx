import { useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import { changeOwnerPassword } from "../api/endpoints";
import type { Session } from "../api/types";
import { IconBack, IconKey } from "./icons";

/** 錯誤碼 → 給人看的說明（docs/16 §3 D7；其餘沿用 server 訊息，例如 LOCKED 會帶解鎖時間） */
const ERROR_HINTS: Record<string, string> = {
  INVALID_OLD_PASSWORD: "舊密碼錯誤，請重新輸入",
  WEAK_PASSWORD: "新密碼不符規則：至少 8 個字元、最多 128",
  FORBIDDEN: "只有管理員帳號可以變更這個密碼",
};

interface Props {
  session: Session;
  onBack: () => void;
  onLogout: () => void;
  onToast: (message: string, kind?: "info" | "error") => void;
}

/**
 * 帳號設定（D7，docs/16 §3）—— owner 自行變更密碼。
 * 走 `PATCH /api/auth/owner-password/self`（owner session ＋ 舊密碼），
 * 與 rescue 路徑（`POST /api/auth/owner-password`，需 x-admin-token）互不影響。
 *
 * ⚠️ 成功後 `password_changed_at` 更新 → **所有裝置的既有登入立即失效**（預期的安全行為），
 *    因此完成畫面直接引導重新登入。
 */
export function AccountSettings({ session, onBack, onLogout, onToast }: Props) {
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (newPw !== confirmPw) {
      onToast("兩次輸入的新密碼不一致", "error");
      return;
    }
    if (newPw.length < 8) {
      onToast("新密碼至少 8 個字元", "error");
      return;
    }
    setBusy(true);
    try {
      await changeOwnerPassword(oldPw, newPw);
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError) {
        onToast(ERROR_HINTS[err.code] ?? err.message, "error");
      } else {
        onToast("變更密碼失敗", "error");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="address-page">
      <div className="page-head">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="返回">
          <IconBack size={20} />
        </button>
        <h1>帳號設定</h1>
      </div>

      {done ? (
        <div className="create-address narrow">
          <h2>
            <IconKey size={18} /> 密碼已更新
          </h2>
          <p className="muted">
            基於安全，<strong>所有裝置的既有登入已立即失效</strong>（包含這一台）。請用新密碼重新登入。
            （按下下方按鈕會清除這台裝置的 session）
          </p>
          <button type="button" className="btn-primary" onClick={onLogout}>
            重新登入
          </button>
        </div>
      ) : (
        <form className="create-address narrow" onSubmit={submit}>
          <h2>
            <IconKey size={18} /> 變更 {session.kind === "owner" ? "管理員" : ""}密碼
          </h2>
          <input
            type="password"
            value={oldPw}
            onChange={(e) => setOldPw(e.target.value)}
            placeholder="目前的密碼"
            autoComplete="current-password"
            required
          />
          <input
            type="password"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            placeholder="新密碼（至少 8 個字元）"
            autoComplete="new-password"
            required
          />
          <input
            type="password"
            value={confirmPw}
            onChange={(e) => setConfirmPw(e.target.value)}
            placeholder="確認新密碼"
            autoComplete="new-password"
            required
          />
          <div className="create-row">
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? "更新中…" : "更新密碼"}
            </button>
            <span className="muted small">更新後需要重新登入（其他裝置的 session 也會失效）</span>
          </div>
        </form>
      )}
    </section>
  );
}
