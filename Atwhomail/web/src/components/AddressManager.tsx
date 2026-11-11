import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import {
  createAddress,
  deleteAddress,
  listAddresses,
  listDeletedAddresses,
  setAddressPassword,
  setAddressStatus,
} from "../api/endpoints";
import type { DeletedAddressInfo, EmailAddressInfo, Session } from "../api/types";
import { useI18n } from "../i18n";
import {
  ADDRESS_DELETE_HARD_LABEL,
  ADDRESS_DELETE_SOFT_DESC,
  ADDRESS_DELETE_SOFT_LABEL,
  ADDRESS_MANAGER_HINT,
  DELETED_ADDRESS_SECTION_HINT,
  DELETED_ADDRESS_SECTION_TITLE,
  addressDeleteToast,
  addressHardDeleteWarning,
  addressMessageCountLine,
  deletedAddressCountLabel,
  deletedAddressPurgeWarning,
} from "../lib/statusSemantics";
import { IconBack, IconKey, IconPlus } from "./icons";
import { Modal } from "./Modal";

interface Props {
  session: Session;
  onBack: () => void;
  onToast: (message: string, kind?: "info" | "error") => void;
}

const LOCAL_PART_RE = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i;
const randomPassword = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789"[b % 54]).join("");
};

export function AddressManager({ session, onBack, onToast }: Props) {
  const { t, locale } = useI18n();
  const [addresses, setAddresses] = useState<EmailAddressInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localPart, setLocalPart] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [pwTarget, setPwTarget] = useState<EmailAddressInfo | null>(null);
  const [pwValue, setPwValue] = useState("");
  const [delTarget, setDelTarget] = useState<EmailAddressInfo | null>(null);
  const [myOldPw, setMyOldPw] = useState("");
  const [myNewPw, setMyNewPw] = useState("");
  // D11-5：「已刪除的地址」（垃圾桶）區塊 —— 自己的 state 與自己的 error（見 reloadDeleted）
  const [deleted, setDeleted] = useState<DeletedAddressInfo[] | null>(null);
  const [deletedError, setDeletedError] = useState<string | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<DeletedAddressInfo | null>(null);

  const isOwner = session.kind === "owner";

  const reloadLive = useCallback(async () => {
    try {
      const res = await listAddresses();
      setAddresses(res.addresses);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("載入地址失敗"));
    }
  }, [t]);

  /**
   * 載入「已刪除的地址」（D11-5）。
   *
   * ⚠️ 失敗**只影響這一個區塊**（錯誤放在自己的 state 並提供「重試」）：地址清單、建立地址、
   *    密碼等既有功能照常運作 —— 垃圾桶清單載不到不得讓整頁壞掉。
   */
  const reloadDeleted = useCallback(async () => {
    try {
      const res = await listDeletedAddresses();
      setDeleted(res.addresses);
      setDeletedError(null);
    } catch (e) {
      setDeletedError(e instanceof ApiError ? e.message : t("載入已刪除的地址失敗"));
    }
  }, [t]);

  /** 兩份清單一起重載：soft／hard 刪除都會同時改變「現存」與「垃圾桶」兩個區塊 */
  const reload = useCallback(async () => {
    await Promise.all([reloadLive(), reloadDeleted()]);
  }, [reloadLive, reloadDeleted]);

  useEffect(() => {
    if (isOwner) void reload();
  }, [isOwner, reload]);

  const submitCreate = async (e: FormEvent) => {
    e.preventDefault();
    const lp = localPart.trim().toLowerCase();
    if (!LOCAL_PART_RE.test(lp) || lp.length > 64) {
      setError(t("名稱僅能用 a-z0-9._-（1–64 字元，不能以 . 或 - 開頭/結尾）"));
      return;
    }
    if (/^[0-9]+$/.test(lp)) {
      setError(t("❌ ID 不能是純數字"));
      return;
    }
    if (password && password.length < 8) {
      setError(t("密碼至少 8 個字元（留空 = 此地址不能獨立登入）"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await createAddress(lp, password || undefined);
      onToast(
        password
          ? t("已建立 {email}（可獨立登入）", { email: res.email })
          : t("已建立 {email}", { email: res.email })
      );
      setLocalPart("");
      setPassword("");
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("建立失敗"));
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = async (row: EmailAddressInfo) => {
    const next = row.status === "active" ? "disabled" : "active";
    try {
      await setAddressStatus(row.id, next);
      onToast(
        next === "active"
          ? t("{email} 已啟用", { email: row.email })
          : t("{email} 已停用", { email: row.email })
      );
      await reload();
    } catch (e) {
      onToast(e instanceof ApiError ? e.message : t("操作失敗"), "error");
    }
  };

  const submitPassword = async () => {
    if (!pwTarget) return;
    if (pwValue.length < 8) {
      onToast(t("密碼至少 8 個字元"), "error");
      return;
    }
    try {
      await setAddressPassword(pwTarget.id, pwValue);
      onToast(t("{email} 密碼已更新", { email: pwTarget.email }));
      setPwTarget(null);
      setPwValue("");
      await reload();
    } catch (e) {
      onToast(e instanceof ApiError ? e.message : t("重設密碼失敗"), "error");
    }
  };

  const submitDelete = async (mode: "soft" | "hard") => {
    if (!delTarget) return;
    try {
      await deleteAddress(delTarget.id, mode);
      onToast(addressDeleteToast(delTarget.email, mode));
      setDelTarget(null);
      await reload();
    } catch (e) {
      onToast(e instanceof ApiError ? e.message : t("刪除失敗"), "error");
    }
  };

  /** D11-5：把「垃圾桶狀態」的地址升級為永久刪除（hard；不可復原，已先二次確認） */
  const submitPurge = async () => {
    if (!purgeTarget) return;
    try {
      await deleteAddress(purgeTarget.id, "hard");
      onToast(addressDeleteToast(purgeTarget.email, "hard"));
      setPurgeTarget(null);
      await reload();
    } catch (e) {
      onToast(e instanceof ApiError ? e.message : t("永久刪除失敗"), "error");
    }
  };

  const submitMyPassword = async (e: FormEvent) => {
    e.preventDefault();
    if (session.kind !== "mailbox") return;
    if (myNewPw.length < 8) {
      onToast(t("新密碼至少 8 個字元"), "error");
      return;
    }
    try {
      await setAddressPassword(session.addressId, myNewPw, myOldPw);
      onToast(t("密碼已更新，其他裝置的舊 session 已失效"));
      setMyOldPw("");
      setMyNewPw("");
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : t("變更失敗"), "error");
    }
  };

  return (
    <section className="address-page">
      <div className="page-head">
        <button type="button" className="icon-btn" onClick={onBack} aria-label={t("返回")}>
          <IconBack size={20} />
        </button>
        <h1>{isOwner ? t("地址管理") : t("變更我的密碼")}</h1>
      </div>

      {isOwner ? (
        <>
          {/* D11-4：一頁一行的定位說明（地址管理＝你自己的信箱） */}
          <p className="muted small">{t(ADDRESS_MANAGER_HINT)}</p>

          <form className="create-address" onSubmit={submitCreate}>
            <h2>
              <IconPlus size={18} /> {t("建立虛擬地址")}
            </h2>
            <div className="create-row">
              <div className="suffix-input">
                <input
                  value={localPart}
                  onChange={(e) => setLocalPart(e.target.value)}
                  placeholder={t("例如 sales01")}
                  aria-label={t("地址名稱")}
                />
                <span>@atwho.org</span>
              </div>
              <input
                type="text"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t("登入密碼（留空 = 不可登入）")}
                aria-label={t("地址密碼")}
              />
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setPassword(randomPassword())}
                title={t("產生隨機密碼")}
              >
                <IconKey size={16} /> {t("隨機")}
              </button>
              <button type="submit" className="btn-primary" disabled={busy}>
                {busy ? t("建立中…") : t("建立")}
              </button>
            </div>
            {error && <p className="error-text">{error}</p>}
          </form>

          <div className="address-table-wrap">
            {addresses === null ? (
              <div className="list-state">
                <div className="spinner" />
              </div>
            ) : (
              <table className="address-table">
                <thead>
                  <tr>
                    <th>{t("地址")}</th>
                    <th>{t("狀態")}</th>
                    <th>{t("可登入")}</th>
                    <th>{t("建立時間")}</th>
                    <th>{t("操作")}</th>
                  </tr>
                </thead>
                <tbody>
                  {addresses.map((row) => (
                    <tr key={row.id} className={row.status !== "active" ? "row-dim" : ""}>
                      <td className="mono">{row.email}</td>
                      <td>
                        <span className={`status-pill ${row.status}`}>
                          {row.status === "active" ? t("啟用") : row.status === "disabled" ? t("停用") : t("已刪除")}
                        </span>
                      </td>
                      <td>{row.has_password ? t("是") : t("否")}</td>
                      <td>{new Date(row.created_at).toLocaleDateString(locale)}</td>
                      <td className="row-actions">
                        <button type="button" onClick={() => toggleStatus(row)}>
                          {row.status === "active" ? t("停用") : t("啟用")}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setPwTarget(row);
                            setPwValue("");
                          }}
                        >
                          {t("重設密碼")}
                        </button>
                        <button type="button" className="danger" onClick={() => setDelTarget(row)}>
                          {t("刪除")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <p className="muted small">
            {t("停用＝立刻停止收信（停用期間的來信直接丟棄）；刪除時可選「{soft}」（soft：標記刪除、信件保留）或「{hard}」（hard：連同該地址所有信件與附件、R2 原始檔一併清除並釋放名稱，不可復原）。", {
              soft: t(ADDRESS_DELETE_SOFT_LABEL),
              hard: t(ADDRESS_DELETE_HARD_LABEL),
            })}
          </p>

          {/*
            D11-5：「已刪除的地址」（垃圾桶）。soft 刪除過的地址不在上面的清單裡，但它的名稱、
            信件與 R2 物件都還在 —— 這裡是唯一能把這類殘留列永久清除的入口。
          */}
          <details className="deleted-addresses">
            <summary>
              {t(DELETED_ADDRESS_SECTION_TITLE)}
              {/* 尚未載入完（含載入失敗）時不謊報「沒有已刪除的地址」 */}
              <span className="muted small">
                （{deleted === null ? t("讀取中…") : deletedAddressCountLabel(deleted.length)}）
              </span>
            </summary>
            <p className="muted small">{t(DELETED_ADDRESS_SECTION_HINT)}</p>

            {deletedError !== null ? (
              // 只有這一行會壞：其餘頁面功能（清單／建立／密碼）不受影響
              <p className="error-text">
                {deletedError}{" "}
                <button type="button" className="btn-secondary" onClick={() => void reloadDeleted()}>
                  {t("重試")}
                </button>
              </p>
            ) : deleted === null ? (
              <div className="list-state">
                <div className="spinner" />
              </div>
            ) : deleted.length === 0 ? (
              <p className="muted small">{t("目前沒有已刪除的地址。")}</p>
            ) : (
              <table className="address-table">
                <thead>
                  <tr>
                    <th>{t("地址")}</th>
                    <th>{t("刪除時間")}</th>
                    <th>{t("信件數")}</th>
                    <th>{t("操作")}</th>
                  </tr>
                </thead>
                <tbody>
                  {deleted.map((row) => (
                    <tr key={row.id} className="row-dim">
                      <td className="mono">{row.email}</td>
                      <td>{new Date(row.deleted_at).toLocaleDateString(locale)}</td>
                      <td>{t("{count} 封", { count: row.messages })}</td>
                      <td className="row-actions">
                        <button type="button" className="danger" onClick={() => setPurgeTarget(row)}>
                          {t(ADDRESS_DELETE_HARD_LABEL)}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </details>
        </>
      ) : (
        <form className="create-address narrow" onSubmit={submitMyPassword}>
          <h2>
            <IconKey size={18} /> {t("變更 {email} 的密碼", { email: session.email })}
          </h2>
          <input
            type="password"
            value={myOldPw}
            onChange={(e) => setMyOldPw(e.target.value)}
            placeholder={t("舊密碼")}
            autoComplete="current-password"
            required
          />
          <input
            type="password"
            value={myNewPw}
            onChange={(e) => setMyNewPw(e.target.value)}
            placeholder={t("新密碼（至少 8 字元）")}
            autoComplete="new-password"
            required
          />
          <button type="submit" className="btn-primary">
            {t("更新密碼")}
          </button>
        </form>
      )}

      {pwTarget && (
        <Modal title={t("重設 {email} 的密碼", { email: pwTarget.email })} onClose={() => setPwTarget(null)}>
          <input
            type="text"
            value={pwValue}
            onChange={(e) => setPwValue(e.target.value)}
            placeholder={t("新密碼（至少 8 字元）")}
            autoFocus
          />
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={() => setPwValue(randomPassword())}>
              {t("隨機產生")}
            </button>
            <button type="button" className="btn-primary" onClick={submitPassword}>
              {t("確定")}
            </button>
          </div>
        </Modal>
      )}

      {delTarget && (
        <Modal title={t("刪除地址")} onClose={() => setDelTarget(null)}>
          <p>
            {t("要如何處理 {email}？", { email: delTarget.email })}
          </p>
          {/* D11-3：顯示該地址的信件數，讓 owner 在選「永久刪除」前知道會刪掉多少 */}
          <p className="muted small">{addressMessageCountLine(delTarget.messages ?? 0)}</p>

          <div className="delete-option">
            <button type="button" className="btn-primary" onClick={() => void submitDelete("soft")}>
              {t("{label}（預設）", { label: t(ADDRESS_DELETE_SOFT_LABEL) })}
            </button>
            <p className="muted small">{t(ADDRESS_DELETE_SOFT_DESC)}</p>
          </div>

          <div className="delete-option danger">
            <button type="button" className="btn-danger" onClick={() => void submitDelete("hard")}>
              {t(ADDRESS_DELETE_HARD_LABEL)}
            </button>
            <p className="warn-text">⚠️ {addressHardDeleteWarning()}</p>
          </div>

          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={() => setDelTarget(null)}>
              {t("取消")}
            </button>
          </div>
        </Modal>
      )}

      {/* D11-5：已刪除地址的永久清除 —— 二次確認必須明寫清除範圍與「不可復原」 */}
      {purgeTarget && (
        <Modal title={t("永久刪除已刪除的地址")} onClose={() => setPurgeTarget(null)}>
          <p>
            <strong>{purgeTarget.email}</strong>{" "}
            {t("目前是垃圾桶狀態（{date} 刪除）。", {
              date: new Date(purgeTarget.deleted_at).toLocaleDateString(locale),
            })}
          </p>
          <p className="muted small">{addressMessageCountLine(purgeTarget.messages)}</p>
          <p className="warn-text">⚠️ {deletedAddressPurgeWarning(purgeTarget.email)}</p>

          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={() => setPurgeTarget(null)}>
              {t("取消")}
            </button>
            <button type="button" className="btn-danger" onClick={() => void submitPurge()}>
              {t(ADDRESS_DELETE_HARD_LABEL)}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
