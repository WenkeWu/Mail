import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import {
  createAddress,
  deleteAddress,
  listAddresses,
  setAddressPassword,
  setAddressStatus,
} from "../api/endpoints";
import type { EmailAddressInfo, Session } from "../api/types";
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

  const isOwner = session.kind === "owner";

  const reload = useCallback(async () => {
    try {
      const res = await listAddresses();
      setAddresses(res.addresses);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "載入地址失敗");
    }
  }, []);

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

  const submitDelete = async () => {
    if (!delTarget) return;
    try {
      await deleteAddress(delTarget.id);
      onToast(`${delTarget.email} 已刪除（soft delete）`);
      setDelTarget(null);
      await reload();
    } catch (e) {
      onToast(e instanceof ApiError ? e.message : "刪除失敗", "error");
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
            刪除為 soft delete（保留備份追溯）；停用後該地址收到的信會被直接丟棄。
          </p>
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
            確定要刪除 <strong>{delTarget.email}</strong> 嗎？
          </p>
          <p className="muted small">此後寄到該地址的信件會被丟棄（soft delete，資料保留供備份）。</p>
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={() => setDelTarget(null)}>
              取消
            </button>
            <button type="button" className="btn-danger" onClick={submitDelete}>
              刪除
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
