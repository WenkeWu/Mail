import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import { changeAccountPassword, getAccountSettings } from "../api/endpoints";
import type { AccountSettingsResponse, Session } from "../api/types";
import { useI18n } from "../i18n";
import { formatShortDateTime } from "../lib/format";
import { AliasManager } from "./AliasManager";
import { IconAt, IconBack, IconKey, IconSettings, IconUsers } from "./icons";
import { LocaleSelectors } from "./LocaleSelectors";

/** 錯誤碼 → 給人看的說明（其餘沿用 server 訊息，例如 LOCKED 會帶解鎖時間） */
const ERROR_HINTS: Record<string, string> = {
  INVALID_CURRENT_PASSWORD: "目前密碼錯誤，請重新輸入",
  WEAK_PASSWORD: "新密碼不符規則：至少 8 個字元、最多 128",
  SCOPE_NOT_ALLOWED: "此登入憑證不可變更密碼",
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
  session: Session;
  onBack: () => void;
  onLogout: () => void;
  onToast: (message: string, kind?: "info" | "error") => void;
  /** D29：別名建立／變更後通知上層重載別名快取（回覆時的 From 判斷會用到） */
  onAliasChanged?: () => void;
}

/**
 * 個人設置（D29，docs/29 §2.2；owner 2026-11-05 要求把「別名管理」併入本頁）
 *
 * 顯示自己的 AtWhoMail ID／角色／**備用電子郵件（用途：找回密碼）**／信箱地址／配額，
 * 提供「變更密碼」（已有密碼）或「設定密碼」（Google OAuth 帳號），
 * 並**內嵌完整的別名管理**（不再有獨立的「別名管理」入口）。
 *
 * ⚠️ 成功後 `password_changed_at` 會更新 → **所有裝置的既有登入立即失效**（預期的安全行為），
 *    因此完成畫面直接引導重新登入。
 */
export function AccountSettings({ session, onBack, onLogout, onToast, onAliasChanged }: Props) {
  const { t } = useI18n();
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
        if (!cancelled) setLoadError(e instanceof ApiError ? e.message : t("無法載入個人設置"));
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, t]);

  const copyAddress = useCallback(
    async (address: string) => {
      try {
        await navigator.clipboard.writeText(address);
        setCopied(address);
        onToast(t("已複製信箱地址"));
        window.setTimeout(() => setCopied((prev) => (prev === address ? null : prev)), 2500);
      } catch {
        onToast(t("複製失敗，請手動選取地址"), "error");
      }
    },
    [onToast, t]
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (data?.has_password === 1 && currentPw === "") {
      onToast(t("請輸入目前的密碼"), "error");
      return;
    }
    if (newPw.length < 8) {
      onToast(t("新密碼至少 8 個字元"), "error");
      return;
    }
    if (newPw !== confirmPw) {
      onToast(t("兩次輸入的新密碼不一致"), "error");
      return;
    }
    setBusy(true);
    try {
      await changeAccountPassword(newPw, data?.has_password === 1 ? currentPw : undefined);
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError) {
        const hint = ERROR_HINTS[err.code];
        onToast(hint ? t(hint) : err.message, "error");
      } else {
        onToast(t("密碼更新失敗"), "error");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="address-page">
      <div className="page-head">
        <button type="button" className="icon-btn" onClick={onBack} aria-label={t("返回")}>
          <IconBack size={20} />
        </button>
        <h1>{t("個人設置")}</h1>
      </div>

      {done ? (
        <div className="create-address narrow">
          <h2>
            <IconKey size={18} /> {t("密碼已更新")}
          </h2>
          <p className="muted">
            {t("基於安全，")}
            <strong>{t("所有裝置的既有登入已立即失效")}</strong>
            {t("（包含這一台）。請用新密碼重新登入。")}
          </p>
          <button type="button" className="btn-primary" onClick={onLogout}>
            {t("重新登入")}
          </button>
        </div>
      ) : loadError ? (
        <div className="create-address narrow">
          <p className="error-text">{loadError}</p>
          <button type="button" className="btn-secondary" onClick={() => setReloadKey((k) => k + 1)}>
            {t("重試")}
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
              <IconSettings size={18} /> {t("語言與國家")}
            </h2>
            <LocaleSelectors />
            <p className="muted small">{t("這些設定會套用到整個介面與日期格式。")}</p>
          </section>

          <section className="create-address settings-card">
            <h2>
              <IconUsers size={18} /> {t("身分")}
            </h2>
            <dl className="settings-list">
              <div>
                <dt>AtWhoMail ID</dt>
                <dd className="mono">{data.username}</dd>
              </div>
              <div>
                <dt>{t("角色")}</dt>
                <dd>{t(ROLE_LABEL[data.role] ?? data.role)}</dd>
              </div>
              <div>
                <dt>{t("信箱地址")}</dt>
                <dd>
                  {data.addresses.length === 0 ? (
                    <span className="muted">{t("（尚無地址）")}</span>
                  ) : (
                    data.addresses.map((a) => (
                      <div key={a.id} className="settings-address-row">
                        <span className="mono">{a.email}</span>
                        <span className={`status-pill ${a.status}`}>
                          {t(ADDRESS_STATUS_LABEL[a.status] ?? a.status)}
                        </span>
                        <button type="button" className="btn-secondary" onClick={() => void copyAddress(a.email)}>
                          {copied === a.email ? t("已複製") : t("複製")}
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
              <IconAt size={18} /> {t("備用電子郵件")}
            </h2>
            <dl className="settings-list">
              <div>
                <dt>{t("備用電子郵件")}</dt>
                <dd className="mono">
                  {data.contact_email ? data.contact_email : <span className="muted">{t("（未提供）")}</span>}
                </dd>
              </div>
            </dl>
            <p className="muted small">{t("用於「忘記密碼」時寄送重設連結。")}</p>
          </section>

          <section className="create-address settings-card">
            <h2>
              <IconKey size={18} /> {data.has_password === 1 ? t("變更密碼") : t("設定密碼")}
            </h2>
            <form className="settings-form" onSubmit={submit}>
              {data.has_password === 1 && (
                <input
                  type="password"
                  value={currentPw}
                  onChange={(e) => setCurrentPw(e.target.value)}
                  placeholder={t("目前的密碼")}
                  autoComplete="current-password"
                  required
                />
              )}
              <input
                type="password"
                value={newPw}
                onChange={(e) => setNewPw(e.target.value)}
                placeholder={t("新密碼（至少 8 個字元）")}
                autoComplete="new-password"
                required
              />
              <input
                type="password"
                value={confirmPw}
                onChange={(e) => setConfirmPw(e.target.value)}
                placeholder={t("確認新密碼")}
                autoComplete="new-password"
                required
              />
              <button type="submit" className="btn-primary" disabled={busy}>
                {busy ? t("更新中…") : data.has_password === 1 ? t("更新密碼") : t("設定密碼")}
              </button>
              <p className="muted small">{t("更新後所有裝置（含這一台）都需要用新密碼重新登入。")}</p>
            </form>
          </section>

          <section className="create-address settings-card">
            <h2>
              <IconAt size={18} /> {t("匿名（別名）")}
            </h2>
            <p className="muted small">{t("暱稱別名需自行建立（每帳號最多 1 個）；隱身代號由系統在帳號建立時自動產生。")}</p>
            <AliasManager
              embedded
              session={session}
              onBack={() => {}}
              onToast={onToast}
              onChanged={onAliasChanged}
            />
          </section>

          <section className="create-address settings-card">
            <h2>
              <IconUsers size={18} /> {t("配額")}
            </h2>
            {data.role === "visitor" ? (
              data.addresses.length === 0 ? (
                <p className="muted small">{t("尚無可用地址。")}</p>
              ) : (
                data.addresses.map((a) => (
                  <p key={a.id} className="muted small settings-quota">
                    <span className="mono">{a.email}</span>
                    {a.warmup_until
                      ? t("：今日已寄 {sent} / {limit}（暖機期上限，至 {until}）", {
                          sent: a.sent_today,
                          limit: a.effective_daily_quota,
                          until: formatShortDateTime(a.warmup_until),
                        })
                      : t("：今日已寄 {sent} / {limit}", {
                          sent: a.sent_today,
                          limit: a.effective_daily_quota,
                        })}
                  </p>
                ))
              )
            ) : (
              <p className="muted small">{t("不適用（管理員帳號）。")}</p>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
