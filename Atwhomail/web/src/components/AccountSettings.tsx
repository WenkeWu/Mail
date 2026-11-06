import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import { changeAccountPassword, getAccountSettings } from "../api/endpoints";
import type { AccountSettingsResponse } from "../api/types";
import { IconAt, IconBack, IconKey, IconUsers } from "./icons";

/** 錯誤碼 → 給人看的說明（其餘沿用 server 訊息，例如 LOCKED 會帶解鎖時間） */
const ERROR_HINTS: Record<string, string> = {
  INVALID_CURRENT_PASSWORD: "目前密碼錯誤，請重新輸入",
  WEAK_PASSWORD: "新密碼不符規則：至少 8 個字元、最多 128",
  SCOPE_NOT_ALLOWED: "此登入方式不可變更密碼",
};

const ROLE_LABEL: Record<string, string> = {
  owner: "管理員",
  visitor: "一般使用者",
};

const ADDRESS_STATUS_LABEL: Record<string, string> = {
  active: "使用中",
  disabled: "已停用",
  deleted: "已刪除",
};

interface Props {
  onBack: () => void;
  onLogout: () => void;
  onToast: (message: string, kind?: "info" | "error") => void;
  /** 別名管理（既有 AliasManager；設定頁只保留入口，不再有獨立側欄／選單項） */
  onManageAliases: () => void;
}

/**
 * 個人設定（D29，docs/29 §2.2）
 *
 * 顯示自己的 AtWhoMail ID／地址／Google Email／登入方式／配額，
 * 並提供「變更密碼」（已有密碼）或「設定密碼」（Google OAuth 帳號）。
 *
 * ⚠️ 成功後 `password_changed_at` 會更新 → **所有裝置的既有登入立即失效**（預期的安全行為），
 *    因此完成畫面直接引導重新登入。
 */
export function AccountSettings({ onBack, onLogout, onToast, onManageAliases }: Props) {
  const [data, setData] = useState<AccountSettingsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    getAccountSettings()
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(e instanceof ApiError ? e.message : "無法載入個人設定");
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const copyAddress = useCallback(
    async (address: string) => {
      try {
        await navigator.clipboard.writeText(address);
        setCopied(address);
        onToast("已複製信箱地址");
        window.setTimeout(() => setCopied((prev) => (prev === address ? null : prev)), 2500);
      } catch {
        onToast("複製失敗，請手動選取地址", "error");
      }
    },
    [onToast]
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (data?.has_password === 1 && currentPw === "") {
      onToast("請輸入目前的密碼", "error");
      return;
    }
    if (newPw.length < 8) {
      onToast("新密碼至少 8 個字元", "error");
      return;
    }
    if (newPw !== confirmPw) {
      onToast("兩次輸入的新密碼不一致", "error");
      return;
    }
    setBusy(true);
    try {
      await changeAccountPassword(newPw, data?.has_password === 1 ? currentPw : undefined);
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError) {
        onToast(ERROR_HINTS[err.code] ?? err.message, "error");
      } else {
        onToast("密碼更新失敗", "error");
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
        <h1>個人設定</h1>
      </div>

      {done ? (
        <div className="create-address narrow">
          <h2>
            <IconKey size={18} /> 密碼已更新
          </h2>
          <p className="muted">
            基於安全，<strong>所有裝置的既有登入已立即失效</strong>（包含這一台）。請用新密碼重新登入。
          </p>
          <button type="button" className="btn-primary" onClick={onLogout}>
            重新登入
          </button>
        </div>
      ) : loadError ? (
        <div className="create-address narrow">
          <p className="error-text">{loadError}</p>
          <button type="button" className="btn-secondary" onClick={() => setReloadKey((k) => k + 1)}>
            重試
          </button>
        </div>
      ) : data === null ? (
        <div className="list-state">
          <div className="spinner" />
        </div>
      ) : (
        <div className="settings-grid">
          <section className="create-address settings-card">
            <h2>
              <IconUsers size={18} /> 身分
            </h2>
            <dl className="settings-list">
              <div>
                <dt>AtWhoMail ID</dt>
                <dd className="mono">{data.username}</dd>
              </div>
              <div>
                <dt>角色</dt>
                <dd>{ROLE_LABEL[data.role] ?? data.role}</dd>
              </div>
              <div>
                <dt>信箱地址</dt>
                <dd>
                  {data.addresses.length === 0 ? (
                    <span className="muted">（尚無地址）</span>
                  ) : (
                    data.addresses.map((a) => (
                      <div key={a.id} className="settings-address-row">
                        <span className="mono">{a.email}</span>
                        <span className={`status-pill ${a.status}`}>
                          {ADDRESS_STATUS_LABEL[a.status] ?? a.status}
                        </span>
                        <button type="button" className="btn-secondary" onClick={() => void copyAddress(a.email)}>
                          {copied === a.email ? "已複製" : "複製"}
                        </button>
                      </div>
                    ))
                  )}
                </dd>
              </div>
            </dl>
          </section>

          <section className="create-address settings-card">
            <h2>
              <IconKey size={18} /> 登入方式
            </h2>
            <dl className="settings-list">
              <div>
                <dt>Google 帳號</dt>
                <dd>{data.contact_email ?? "尚未綁定 Google"}</dd>
              </div>
              <div>
                <dt>本機密碼</dt>
                <dd>{data.has_password === 1 ? "已設定" : "未設定（OAuth 帳號）"}</dd>
              </div>
            </dl>
          </section>

          <section className="create-address settings-card">
            <h2>
              <IconKey size={18} /> {data.has_password === 1 ? "變更密碼" : "設定密碼"}
            </h2>
            <form className="settings-form" onSubmit={submit}>
              {data.has_password === 1 && (
                <input
                  type="password"
                  value={currentPw}
                  onChange={(e) => setCurrentPw(e.target.value)}
                  placeholder="目前的密碼"
                  autoComplete="current-password"
                  required
                />
              )}
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
              <button type="submit" className="btn-primary" disabled={busy}>
                {busy ? "更新中…" : data.has_password === 1 ? "更新密碼" : "設定密碼"}
              </button>
              <p className="muted small">更新後所有裝置（含這一台）都需要用新密碼重新登入。</p>
            </form>
          </section>

          <section className="create-address settings-card">
            <h2>
              <IconAt size={18} /> 匿名（別名）
            </h2>
            <p className="muted small">別名需自行建立，系統不會自動分配。</p>
            <button type="button" className="btn-secondary" onClick={onManageAliases}>
              管理別名
            </button>
          </section>

          <section className="create-address settings-card">
            <h2>
              <IconUsers size={18} /> 配額
            </h2>
            {data.role === "visitor" ? (
              data.addresses.length === 0 ? (
                <p className="muted small">尚無可用地址。</p>
              ) : (
                data.addresses.map((a) => (
                  <p key={a.id} className="muted small settings-quota">
                    <span className="mono">{a.email}</span>：今日已寄 {a.sent_today} / {a.daily_send_quota}
                  </p>
                ))
              )
            ) : (
              <p className="muted small">不適用（管理員帳號）。</p>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
