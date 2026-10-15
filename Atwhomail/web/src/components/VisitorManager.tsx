import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../api/client";
import { listVisitors, setUserQuota, setUserStatus, setUserWarmup, setVisitorAddressStatus } from "../api/endpoints";
import type { VisitorUser } from "../api/types";
import {
  ADDRESS_DISABLE_WARNING,
  USER_SUSPEND_WARNING,
  addressStatusActionLabel,
  addressStatusTooltip,
  userStatusActionLabel,
  userStatusTooltip,
} from "../lib/statusSemantics";
import { IconBack, IconRefresh } from "./icons";
import { Modal } from "./Modal";

/**
 * 訪客管理（D5，docs/16 §3）—— 清單／停權／地址停用／配額／暖機豁免。
 *
 * D8（docs/16 §3）：**停權（帳號層）與停用（地址層）後果不同**，按鈕文案／tooltip／二次確認
 * 一律取自 `lib/statusSemantics.ts`（停權＝全部地址、**來信照收**；停用＝僅此地址且**連收信都停**）。
 *
 * ⚠️ **僅在 `mail.atwho.org` 與 localhost（`all` 模式）顯示**；`app.atwho.org` 不顯示（UI 收斂）。
 *    權限一律由後端判定：`GET /api/users?role=visitor` 與所有 PATCH 端點皆 `requireOwner`（N3）。
 * ⚠️ **N9（權限邊界）**：本頁只呈現**數量與時間**（信件數、最近活動）與帳號／地址狀態，
 *    **不顯示**任何主旨、寄件者或內文；owner 也無法藉 `/api/mail/*` 讀取訪客信件。
 */
interface Props {
  onBack: () => void;
  onToast: (message: string, kind?: "info" | "error") => void;
}

/** 最近活動時間顯示（無活動 → 「—」） */
function formatActivity(ts: number | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

interface EditState {
  user: VisitorUser;
  quota: string;
  canSend: boolean;
  warmupExempt: boolean;
}

export function VisitorManager({ onBack, onToast }: Props) {
  const [visitors, setVisitors] = useState<VisitorUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [confirm, setConfirm] = useState<{ user: VisitorUser; action: "suspend" | "address-off" } | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await listVisitors();
      setVisitors(res.users);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "載入訪客清單失敗");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** 停權／復權（C7 一鍵止血：立即擋登入與寄信） */
  const applyUserStatus = async (user: VisitorUser, status: "active" | "suspended") => {
    setBusyId(user.id);
    try {
      await setUserStatus(user.id, status);
      onToast(`${user.username} 已${status === "active" ? "復權" : "停權"}`);
      setConfirm(null);
      await reload();
    } catch (e) {
      onToast(e instanceof ApiError ? e.message : "操作失敗", "error");
    } finally {
      setBusyId(null);
    }
  };

  /** 停用／啟用地址（D5 新端點；舊端點對訪客地址一律 404） */
  const applyAddressStatus = async (user: VisitorUser, status: "active" | "disabled") => {
    if (!user.address) return;
    setBusyId(user.id);
    try {
      await setVisitorAddressStatus(user.address.id, status);
      onToast(`${user.address.email} 已${status === "active" ? "啟用" : "停用"}`);
      setConfirm(null);
      await reload();
    } catch (e) {
      onToast(e instanceof ApiError ? e.message : "操作失敗", "error");
    } finally {
      setBusyId(null);
    }
  };

  const openEdit = (user: VisitorUser) => {
    setEdit({
      user,
      quota: String(user.address?.daily_send_quota ?? ""),
      canSend: (user.address?.can_send ?? 1) === 1,
      warmupExempt: (user.address?.warmup_exempt ?? 0) === 1,
    });
  };

  /** 套用配額（1–200）＋寄信安全閥；暖機豁免為選配（migration 0007 未套用時回 409） */
  const submitEdit = async () => {
    if (!edit) return;
    const quota = Number(edit.quota);
    if (!Number.isInteger(quota) || quota < 1 || quota > 200) {
      onToast("每日配額需為 1–200 的整數", "error");
      return;
    }
    setBusyId(edit.user.id);
    try {
      await setUserQuota(edit.user.id, { daily_send_quota: quota, can_send: edit.canSend });
      const wasExempt = (edit.user.address?.warmup_exempt ?? 0) === 1;
      if (edit.warmupExempt !== wasExempt) {
        try {
          await setUserWarmup(edit.user.id, edit.warmupExempt);
        } catch (e) {
          if (e instanceof ApiError && e.code === "MIGRATION_REQUIRED") {
            onToast("配額已更新；暖機豁免需要先套用 migration 0007", "error");
            setEdit(null);
            await reload();
            return;
          }
          throw e;
        }
      }
      onToast(`${edit.user.username} 的寄信設定已更新`);
      setEdit(null);
      await reload();
    } catch (e) {
      onToast(e instanceof ApiError ? e.message : "更新失敗", "error");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="address-page">
      <div className="page-head">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="返回">
          <IconBack size={20} />
        </button>
        <h1>訪客管理</h1>
        <button type="button" className="icon-btn" title="重新整理" onClick={() => void reload()}>
          <IconRefresh size={18} />
        </button>
      </div>

      <p className="muted small">
        只顯示帳號狀態、配額與<strong>數量／時間</strong>（信件數、最近活動）。
        基於權限邊界（N9），管理者看不到訪客信件的主旨、寄件者或內文。
      </p>

      <div className="address-table-wrap">
        {error ? (
          <div className="list-state error-text">{error}</div>
        ) : visitors === null ? (
          <div className="list-state">
            <div className="spinner" />
          </div>
        ) : visitors.length === 0 ? (
          <div className="list-state">尚無訪客帳號</div>
        ) : (
          <table className="address-table">
            <thead>
              <tr>
                <th>帳號</th>
                <th>地址</th>
                <th>狀態</th>
                <th>配額</th>
                <th>今日已寄</th>
                <th>信件數</th>
                <th>最近活動</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {visitors.map((u) => {
                const a = u.address;
                const suspended = u.status !== "active";
                const addressOff = a ? a.status !== "active" : false;
                return (
                  <tr key={u.id} className={suspended || addressOff ? "row-dim" : ""}>
                    <td className="mono">{u.username}</td>
                    <td className="mono">{a?.email ?? <span className="muted">（無地址）</span>}</td>
                    <td>
                      <span className={`status-pill ${suspended ? "suspended" : "active"}`}>
                        {suspended ? "已停權" : "正常"}
                      </span>
                      {a && (
                        <span className={`status-pill ${addressOff ? "disabled" : "active"} pill-inline`}>
                          {addressOff ? "地址停用" : "地址啟用"}
                        </span>
                      )}
                      {a?.can_send === 0 && <span className="status-pill disabled pill-inline">禁止寄信</span>}
                    </td>
                    <td>{a ? a.daily_send_quota : "—"}</td>
                    <td>{a ? a.sent_today : "—"}</td>
                    <td>{u.mail_count}</td>
                    <td>{formatActivity(u.last_activity_at)}</td>
                    <td className="row-actions">
                      <button
                        type="button"
                        className={suspended ? "" : "danger"}
                        disabled={busyId === u.id}
                        title={userStatusTooltip(suspended)}
                        onClick={() => setConfirm({ user: u, action: "suspend" })}
                      >
                        {userStatusActionLabel(suspended)}
                      </button>
                      {a && (
                        <button
                          type="button"
                          className={addressOff ? "" : "danger"}
                          disabled={busyId === u.id}
                          title={addressStatusTooltip(addressOff)}
                          onClick={() => setConfirm({ user: u, action: "address-off" })}
                        >
                          {addressStatusActionLabel(addressOff)}
                        </button>
                      )}
                      <button type="button" disabled={!a || busyId === u.id} onClick={() => openEdit(u)}>
                        寄信設定
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <p className="muted small">
        <strong>停權帳號</strong>＝凍結該訪客<strong>全部地址</strong>：立即無法登入與寄信，但
        <strong>來信仍會照收並保留</strong>。<strong>停用地址</strong>＝僅該一個地址，且
        <strong>連收信都停止</strong>——停用期間的來信會被直接丟棄，不會保留。
      </p>

      {confirm && (
        <Modal
          title={confirm.action === "suspend" ? "停權／復權" : "停用／啟用地址"}
          onClose={() => setConfirm(null)}
        >
          {confirm.action === "suspend" ? (
            <>
              <p>
                確定要{confirm.user.status === "active" ? "停權" : "復權"}{" "}
                <strong>{confirm.user.username}</strong> 嗎？
              </p>
              {confirm.user.status === "active" ? (
                <p className="warn-text">⚠️ {USER_SUSPEND_WARNING}</p>
              ) : (
                <p className="muted small">復權後，此人名下所有地址恢復可登入與寄信（收信狀態不變）。</p>
              )}
              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={() => setConfirm(null)}>
                  取消
                </button>
                <button
                  type="button"
                  className={confirm.user.status === "active" ? "btn-danger" : "btn-primary"}
                  onClick={() => void applyUserStatus(confirm.user, confirm.user.status === "active" ? "suspended" : "active")}
                >
                  確定{confirm.user.status === "active" ? "停權" : "復權"}
                </button>
              </div>
            </>
          ) : (
            <>
              <p>
                確定要{confirm.user.address?.status === "active" ? "停用" : "啟用"}{" "}
                <strong>{confirm.user.address?.email}</strong> 嗎？
              </p>
              {confirm.user.address?.status === "active" ? (
                // D8-3：地址停用是**不可逆的收信中斷**（信在 SMTP 階段即被丟棄），必須明寫後果
                <p className="warn-text">⚠️ {ADDRESS_DISABLE_WARNING}</p>
              ) : (
                <p className="muted small">
                  啟用後該地址恢復收信與登入；停用期間已被丟棄的來信無法找回。
                </p>
              )}
              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={() => setConfirm(null)}>
                  取消
                </button>
                <button
                  type="button"
                  className={confirm.user.address?.status === "active" ? "btn-danger" : "btn-primary"}
                  onClick={() =>
                    void applyAddressStatus(
                      confirm.user,
                      confirm.user.address?.status === "active" ? "disabled" : "active"
                    )
                  }
                >
                  確定{confirm.user.address?.status === "active" ? "停用" : "啟用"}
                </button>
              </div>
            </>
          )}
        </Modal>
      )}

      {edit && (
        <Modal title={`${edit.user.username} 的寄信設定`} onClose={() => setEdit(null)}>
          <label className="field-row">
            <span>每日寄信配額（1–200）</span>
            <input
              type="number"
              min={1}
              max={200}
              value={edit.quota}
              onChange={(e) => setEdit({ ...edit, quota: e.target.value })}
            />
          </label>
          <label className="field-row checkbox-row">
            <input
              type="checkbox"
              checked={edit.canSend}
              onChange={(e) => setEdit({ ...edit, canSend: e.target.checked })}
            />
            <span>允許寄信（取消勾選＝安全閥：立即停止此帳號寄信）</span>
          </label>
          <label className="field-row checkbox-row">
            <input
              type="checkbox"
              checked={edit.warmupExempt}
              onChange={(e) => setEdit({ ...edit, warmupExempt: e.target.checked })}
            />
            <span>暖機豁免（跳過註冊後 24 小時的 5 封上限）</span>
          </label>
          <p className="warn-text">
            ⚠️ 暖機豁免會讓新帳號<strong>立刻</strong>能寄到每日配額上限，可能影響寄信聲譽（新網域尤其敏感）。
            豁免後仍受<strong>每日配額</strong>與每小時限流約束，不是無上限；此外需要 migration 0007 已套用。
          </p>
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={() => setEdit(null)}>
              取消
            </button>
            <button type="button" className="btn-primary" onClick={() => void submitEdit()} disabled={busyId === edit.user.id}>
              {busyId === edit.user.id ? "套用中…" : "套用"}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
