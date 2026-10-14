import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import { createInvite, listInvites, revokeInvite } from "../api/endpoints";
import type { Invite } from "../api/types";
import { INVITE_STATE_LABEL, formatExpiry, inviteState } from "../lib/invites";
import { IconBack, IconPlus } from "./icons";
import { Modal } from "./Modal";

/**
 * 邀請碼管理（D4，docs/16 §3）—— 建立／列表／撤銷／複製。
 *
 * ⚠️ **僅在 `mail.atwho.org` 與 localhost（`all` 模式）顯示**；`app.atwho.org` 不顯示（UI 收斂）。
 *    權限本身與此無關：`/api/invites*` 一律 `requireOwner`，訪客 JWT 只會拿到 403（N3）。
 * ⚠️ 複製需要全碼 → 呼叫 `GET /api/invites?reveal=1`（後端寫稽核 `invite_revealed`）；
 *    一般列表仍只回遮罩碼。
 */
interface Props {
  onBack: () => void;
  onToast: (message: string, kind?: "info" | "error") => void;
}

/** 撤銷狀態（後端為 soft：`status='revoked'`，資料列永不刪除） */
const REVOCABLE = new Set(["active", "expired", "exhausted"]);

export function InviteManager({ onBack, onToast }: Props) {
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [maxUses, setMaxUses] = useState("1");
  const [expiresHours, setExpiresHours] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<Invite | null>(null);
  /** 已透過 reveal 取得的全碼（僅存在記憶體，不落地） */
  const [revealed, setRevealed] = useState<Record<number, string>>({});
  const [copiedId, setCopiedId] = useState<number | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await listInvites();
      setInvites(res.invites);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "載入邀請碼失敗");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const submitCreate = async (e: FormEvent) => {
    e.preventDefault();
    const uses = Number(maxUses);
    if (!Number.isInteger(uses) || uses < 1 || uses > 100) {
      setError("使用次數需為 1–100 的整數");
      return;
    }
    let hours: number | null = null;
    if (expiresHours.trim() !== "") {
      hours = Number(expiresHours);
      if (!Number.isFinite(hours) || hours < 1 || hours > 8760) {
        setError("有效時數需為 1–8760（留空 = 不過期）");
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      const res = await createInvite({
        max_uses: uses,
        expires_in_hours: hours,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onToast("已建立邀請碼（已複製到剪貼簿）");
      void copyToClipboard(res.code, res.id);
      setNote("");
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "建立失敗");
    } finally {
      setBusy(false);
    }
  };

  /** 複製到剪貼簿（失敗不阻斷：全碼仍會顯示在列表，可手動選取） */
  const copyToClipboard = async (code: string, id: number) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 2500);
      return true;
    } catch {
      return false;
    }
  };

  /** 複製：先以 reveal 取得全碼（後端寫稽核），再寫入剪貼簿 */
  const handleCopy = async (row: Invite) => {
    try {
      const known = revealed[row.id];
      if (known) {
        const ok = await copyToClipboard(known, row.id);
        onToast(ok ? "已複製邀請碼" : "無法存取剪貼簿，請手動複製列表中的邀請碼", ok ? "info" : "error");
        return;
      }
      const res = await listInvites(true);
      const full = res.invites.find((i) => i.id === row.id)?.code;
      if (!full) {
        onToast("找不到邀請碼（可能已被撤銷）", "error");
        return;
      }
      setRevealed((prev) => ({ ...prev, [row.id]: full }));
      const ok = await copyToClipboard(full, row.id);
      onToast(ok ? "已複製邀請碼" : "已顯示邀請碼，請手動複製", ok ? "info" : "error");
    } catch (e) {
      onToast(e instanceof ApiError ? e.message : "取得邀請碼失敗", "error");
    }
  };

  const submitRevoke = async () => {
    if (!revokeTarget) return;
    try {
      await revokeInvite(revokeTarget.id);
      onToast("邀請碼已撤銷");
      setRevealed((prev) => {
        const next = { ...prev };
        delete next[revokeTarget.id];
        return next;
      });
      setRevokeTarget(null);
      await reload();
    } catch (e) {
      onToast(e instanceof ApiError ? e.message : "撤銷失敗", "error");
    }
  };

  return (
    <section className="address-page">
      <div className="page-head">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="返回">
          <IconBack size={20} />
        </button>
        <h1>邀請碼管理</h1>
      </div>

      <form className="create-address" onSubmit={submitCreate}>
        <h2>
          <IconPlus size={18} /> 建立邀請碼
        </h2>
        <div className="create-row">
          <input
            type="number"
            min={1}
            max={100}
            value={maxUses}
            onChange={(e) => setMaxUses(e.target.value)}
            placeholder="使用次數（1–100）"
            aria-label="使用次數"
          />
          <input
            type="number"
            min={1}
            max={8760}
            value={expiresHours}
            onChange={(e) => setExpiresHours(e.target.value)}
            placeholder="有效時數（留空 = 不過期）"
            aria-label="有效時數"
          />
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="備註（例如：給小明 2026-10）"
            aria-label="備註"
            maxLength={200}
          />
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? "建立中…" : "建立"}
          </button>
        </div>
        {error && <p className="error-text">{error}</p>}
        <p className="muted small">
          邀請碼即註冊憑證：只在建立當下與「複製」時以全碼呈現，其餘一律遮罩；每次複製都會在稽核留下紀錄。
        </p>
      </form>

      <div className="address-table-wrap">
        {invites === null ? (
          <div className="list-state">
            <div className="spinner" />
          </div>
        ) : invites.length === 0 ? (
          <div className="list-state">尚無邀請碼</div>
        ) : (
          <table className="address-table">
            <thead>
              <tr>
                <th>備註</th>
                <th>邀請碼</th>
                <th>已用／上限</th>
                <th>到期時間</th>
                <th>狀態</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {invites.map((row) => {
                const state = inviteState(row);
                const shown = revealed[row.id] ?? row.masked_code;
                return (
                  <tr key={row.id} className={state !== "active" ? "row-dim" : ""}>
                    <td>{row.note ?? <span className="muted">—</span>}</td>
                    <td className="invite-code mono" title={revealed[row.id] ?? "按「複製」取得完整邀請碼"}>
                      {shown}
                    </td>
                    <td>
                      {row.used_count} / {row.max_uses}
                    </td>
                    <td>{formatExpiry(row.expires_at)}</td>
                    <td>
                      <span className={`status-pill ${state}`}>{INVITE_STATE_LABEL[state]}</span>
                    </td>
                    <td className="row-actions">
                      <button type="button" onClick={() => void handleCopy(row)} disabled={state === "revoked"}>
                        {copiedId === row.id ? "已複製" : "複製"}
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => setRevokeTarget(row)}
                        disabled={!REVOCABLE.has(state) || state === "revoked"}
                      >
                        撤銷
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
        撤銷為 soft（保留紀錄，狀態改為「已撤銷」）；已撤銷的邀請碼無法再用於註冊，也無法復原。
      </p>

      {revokeTarget && (
        <Modal title="撤銷邀請碼" onClose={() => setRevokeTarget(null)}>
          <p>
            確定要撤銷這組邀請碼嗎？
            {revokeTarget.note ? (
              <>
                （備註：<strong>{revokeTarget.note}</strong>）
              </>
            ) : null}
          </p>
          <p className="muted small">
            撤銷後將無法再用於註冊（已註冊的帳號不受影響），且無法復原 —— 需要時請重新建立。
          </p>
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={() => setRevokeTarget(null)}>
              取消
            </button>
            <button type="button" className="btn-danger" onClick={() => void submitRevoke()}>
              確定撤銷
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
