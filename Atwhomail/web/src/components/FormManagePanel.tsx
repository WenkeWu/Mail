/**
 * FormManagePanel — 寄件人對互動式表單的管理（docs/18 §3.4）
 *
 * 顯示同一批寄送（同 template）所有收件人的狀態與回覆，並可撤回整批。
 * 僅寄件人可見：`GET /api/forms/:id/responses` 對他人回 403／404 → 本元件直接不渲染
 * （不顯示錯誤、不洩漏表單是否存在）。
 */
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../api/client";
import { getFormResponses, revokeForm } from "../api/endpoints";
import type { FormInstanceSummary, FormResponsesResponse } from "../api/types";
import { formatFullDate } from "../lib/format";

type State =
  | { kind: "loading" }
  | { kind: "hidden" }
  | { kind: "ready"; data: FormResponsesResponse }
  | { kind: "error"; message: string };

const STATUS_LABEL: Record<string, string> = {
  open: "待填寫",
  submitted: "已送出",
  revoked: "已撤回",
  expired: "已逾期",
};

function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

function payloadText(inst: FormInstanceSummary): string {
  if (inst.payload === null) return "";
  try {
    return JSON.stringify(inst.payload, null, 2);
  } catch {
    return "（無法顯示回覆）";
  }
}

export function FormManagePanel({ instanceId }: { instanceId: number }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await getFormResponses(instanceId);
      setState({ kind: "ready", data });
    } catch (e) {
      // 403／404：不是寄件人或表單不存在 → 完全隱藏（不洩漏）
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
        setState({ kind: "hidden" });
        return;
      }
      setState({ kind: "error", message: e instanceof ApiError ? e.message : "無法載入表單回覆" });
    }
  }, [instanceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async () => {
    if (busy) return;
    if (
      !window.confirm(
        "撤回後，所有收件人將立即無法填寫此表單（已送出的回覆仍會保留）。確定要撤回這批表單嗎？"
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await revokeForm(instanceId);
      await load();
    } catch (e) {
      setState({ kind: "error", message: e instanceof ApiError ? e.message : "撤回失敗" });
    } finally {
      setBusy(false);
    }
  };

  if (state.kind === "hidden") return null;
  if (state.kind === "loading") {
    return (
      <div className="form-manage">
        <p className="muted">載入表單回覆…</p>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="form-manage">
        <p className="compose-error">{state.message}</p>
        <button type="button" className="btn-secondary" onClick={() => void load()}>
          重試
        </button>
      </div>
    );
  }

  const { data } = state;
  const canRevoke = data.instances.some((i) => i.status === "open" || i.status === "expired");
  return (
    <div className="form-manage">
      <div className="form-manage-head">
        <strong>互動式表單管理</strong>
        <span className="muted">
          {data.instances.filter((i) => i.status === "submitted").length} / {data.instances.length} 已回覆
        </span>
        {canRevoke && (
          <button type="button" className="btn-danger" onClick={() => void revoke()} disabled={busy}>
            {busy ? "撤回中…" : "撤回表單"}
          </button>
        )}
      </div>
      <ul className="form-instance-list">
        {data.instances.map((inst) => (
          <li key={inst.id} className={`form-instance status-${inst.status}`}>
            <div className="form-instance-row">
              <span className="form-instance-recipient">{inst.recipient}</span>
              <span className={`status-chip status-${inst.status}`}>{statusLabel(inst.status)}</span>
              {inst.submitted_at !== null && (
                <span className="muted">{formatFullDate(inst.submitted_at)}</span>
              )}
            </div>
            {inst.payload !== null && <pre className="form-response-payload">{payloadText(inst)}</pre>}
          </li>
        ))}
      </ul>
    </div>
  );
}
