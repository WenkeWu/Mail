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
      setError(e instanceof ApiError ? e.message : "載入地址失敗");
    }
  }, []);

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
      setDeletedError(e instanceof ApiError ? e.message : "載入已刪除的地址失敗");
    }
  }, []);

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
      setError("名稱僅能用 a-z0-9._-（1–64 字元，不能以 . 或 - 開頭/結尾）");
      return;
    }
    if (password && password.length < 8) {
      setError("密碼至少 8 個字元（留空 = 此地址不能獨立登入）");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await createAddress(lp, password || undefined);
      onToast(`已建立 ${res.email}${password ? "（可獨立登入）" : ""}`);
      setLocalPart("");
      setPassword("");
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "建立失敗");
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = async (row: EmailAddressInfo) => {
    const next = row.status === "active" ? "disabled" : "active";
    try {
      await setAddressStatus(row.id, next);
      onToast(`${row.email} 已${next === "active" ? "啟用" : "停用"}`);
      await reload();
    } catch (e) {
      onToast(e instanceof ApiError ? e.message : "操作失敗", "error");
    }
  };

  const submitPassword = async () => {
    if (!pwTarget) return;
    if (pwValue.length < 8) {
      onToast("密碼至少 8 個字元", "error");
      return;
    }
    try {
      await setAddressPassword(pwTarget.id, pwValue);
      onToast(`${pwTarget.email} 密碼已更新`);
      setPwTarget(null);
      setPwValue("");
      await reload();
    } catch (e) {
      onToast(e instanceof ApiError ? e.message : "重設密碼失敗", "error");
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
      onToast(e instanceof ApiError ? e.message : "刪除失敗", "error");
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
      onToast(e instanceof ApiError ? e.message : "永久刪除失敗", "error");
    }
  };

  const submitMyPassword = async (e: FormEvent) => {
    e.preventDefault();
    if (session.kind !== "mailbox") return;
    if (myNewPw.length < 8) {
      onToast("新密碼至少 8 個字元", "error");
      return;
    }
    try {
      await setAddressPassword(session.addressId, myNewPw, myOldPw);
      onToast("密碼已更新，其他裝置的舊 session 已失效");
      setMyOldPw("");
      setMyNewPw("");
    } catch (err) {
      onToast(err instanceof ApiError ? err.message : "變更失敗", "error");
    }
  };

  return (
    <section className="address-page">
      <div className="page-head">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="返回">
          <IconBack size={20} />
        </button>
        <h1>{isOwner ? "地址管理" : "變更我的密碼"}</h1>
      </div>

      {isOwner ? (
        <>
          {/* D11-4：一頁一行的定位說明（地址管理＝你自己的信箱） */}
          <p className="muted small">{ADDRESS_MANAGER_HINT}</p>

          <form className="create-address" onSubmit={submitCreate}>
            <h2>
              <IconPlus size={18} /> 建立虛擬地址
            </h2>
            <div className="create-row">
              <div className="suffix-input">
                <input
                  value={localPart}
                  onChange={(e) => setLocalPart(e.target.value)}
                  placeholder="例如 sales01"
                  aria-label="地址名稱"
                />
                <span>@atwho.org</span>
              </div>
              <input
                type="text"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="登入密碼（留空 = 不可登入）"
                aria-label="地址密碼"
              />
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setPassword(randomPassword())}
                title="產生隨機密碼"
              >
                <IconKey size={16} /> 隨機
              </button>
              <button type="submit" className="btn-primary" disabled={busy}>
                {busy ? "建立中…" : "建立"}
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
                    <th>地址</th>
                    <th>狀態</th>
                    <th>可登入</th>
                    <th>建立時間</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {addresses.map((row) => (
                    <tr key={row.id} className={row.status !== "active" ? "row-dim" : ""}>
                      <td className="mono">{row.email}</td>
                      <td>
                        <span className={`status-pill ${row.status}`}>
                          {row.status === "active" ? "啟用" : row.status === "disabled" ? "停用" : "已刪除"}
                        </span>
                      </td>
                      <td>{row.has_password ? "是" : "否"}</td>
                      <td>{new Date(row.created_at).toLocaleDateString("zh-TW")}</td>
                      <td className="row-actions">
                        <button type="button" onClick={() => toggleStatus(row)}>
                          {row.status === "active" ? "停用" : "啟用"}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setPwTarget(row);
                            setPwValue("");
                          }}
                        >
                          重設密碼
                        </button>
                        <button type="button" className="danger" onClick={() => setDelTarget(row)}>
                          刪除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <p className="muted small">
            <strong>停用</strong>＝立刻停止收信（停用期間的來信直接丟棄）；<strong>刪除</strong>時可選
            「{ADDRESS_DELETE_SOFT_LABEL}」（soft：標記刪除、信件保留）或「{ADDRESS_DELETE_HARD_LABEL}」
            （hard：連同該地址所有信件與附件、R2 原始檔一併清除並釋放名稱，不可復原）。
          </p>

          {/*
            D11-5：「已刪除的地址」（垃圾桶）。soft 刪除過的地址不在上面的清單裡，但它的名稱、
            信件與 R2 物件都還在 —— 這裡是唯一能把這類殘留列永久清除的入口。
          */}
          <details className="deleted-addresses">
            <summary>
              {DELETED_ADDRESS_SECTION_TITLE}
              {/* 尚未載入完（含載入失敗）時不謊報「沒有已刪除的地址」 */}
              <span className="muted small">
                （{deleted === null ? "讀取中…" : deletedAddressCountLabel(deleted.length)}）
              </span>
            </summary>
            <p className="muted small">{DELETED_ADDRESS_SECTION_HINT}</p>

            {deletedError !== null ? (
              // 只有這一行會壞：其餘頁面功能（清單／建立／密碼）不受影響
              <p className="error-text">
                {deletedError}{" "}
                <button type="button" className="btn-secondary" onClick={() => void reloadDeleted()}>
                  重試
                </button>
              </p>
            ) : deleted === null ? (
              <div className="list-state">
                <div className="spinner" />
              </div>
            ) : deleted.length === 0 ? (
              <p className="muted small">目前沒有已刪除的地址。</p>
            ) : (
              <table className="address-table">
                <thead>
                  <tr>
                    <th>地址</th>
                    <th>刪除時間</th>
                    <th>信件數</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {deleted.map((row) => (
                    <tr key={row.id} className="row-dim">
                      <td className="mono">{row.email}</td>
                      <td>{new Date(row.deleted_at).toLocaleDateString("zh-TW")}</td>
                      <td>{row.messages} 封</td>
                      <td className="row-actions">
                        <button type="button" className="danger" onClick={() => setPurgeTarget(row)}>
                          {ADDRESS_DELETE_HARD_LABEL}
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
            <IconKey size={18} /> 變更 {session.email} 的密碼
          </h2>
          <input
            type="password"
            value={myOldPw}
            onChange={(e) => setMyOldPw(e.target.value)}
            placeholder="舊密碼"
            autoComplete="current-password"
            required
          />
          <input
            type="password"
            value={myNewPw}
            onChange={(e) => setMyNewPw(e.target.value)}
            placeholder="新密碼（至少 8 字元）"
            autoComplete="new-password"
            required
          />
          <button type="submit" className="btn-primary">
            更新密碼
          </button>
        </form>
      )}

      {pwTarget && (
        <Modal title={`重設 ${pwTarget.email} 的密碼`} onClose={() => setPwTarget(null)}>
          <input
            type="text"
            value={pwValue}
            onChange={(e) => setPwValue(e.target.value)}
            placeholder="新密碼（至少 8 字元）"
            autoFocus
          />
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={() => setPwValue(randomPassword())}>
              隨機產生
            </button>
            <button type="button" className="btn-primary" onClick={submitPassword}>
              確定
            </button>
          </div>
        </Modal>
      )}

      {delTarget && (
        <Modal title="刪除地址" onClose={() => setDelTarget(null)}>
          <p>
            要如何處理 <strong>{delTarget.email}</strong>？
          </p>
          {/* D11-3：顯示該地址的信件數，讓 owner 在選「永久刪除」前知道會刪掉多少 */}
          <p className="muted small">{addressMessageCountLine(delTarget.messages ?? 0)}</p>

          <div className="delete-option">
            <button type="button" className="btn-primary" onClick={() => void submitDelete("soft")}>
              {ADDRESS_DELETE_SOFT_LABEL}（預設）
            </button>
            <p className="muted small">{ADDRESS_DELETE_SOFT_DESC}</p>
          </div>

          <div className="delete-option danger">
            <button type="button" className="btn-danger" onClick={() => void submitDelete("hard")}>
              {ADDRESS_DELETE_HARD_LABEL}
            </button>
            <p className="warn-text">⚠️ {addressHardDeleteWarning()}</p>
          </div>

          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={() => setDelTarget(null)}>
              取消
            </button>
          </div>
        </Modal>
      )}

      {/* D11-5：已刪除地址的永久清除 —— 二次確認必須明寫清除範圍與「不可復原」 */}
      {purgeTarget && (
        <Modal title="永久刪除已刪除的地址" onClose={() => setPurgeTarget(null)}>
          <p>
            <strong>{purgeTarget.email}</strong> 目前是垃圾桶狀態（
            {new Date(purgeTarget.deleted_at).toLocaleDateString("zh-TW")} 刪除）。
          </p>
          <p className="muted small">{addressMessageCountLine(purgeTarget.messages)}</p>
          <p className="warn-text">⚠️ {deletedAddressPurgeWarning(purgeTarget.email)}</p>

          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={() => setPurgeTarget(null)}>
              取消
            </button>
            <button type="button" className="btn-danger" onClick={() => void submitPurge()}>
              {ADDRESS_DELETE_HARD_LABEL}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
