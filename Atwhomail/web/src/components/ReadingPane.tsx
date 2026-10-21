import { useEffect, useState } from "react";
import { ApiError } from "../api/client";
import { getForm, submitFormResponse } from "../api/endpoints";
import type { AttachmentMeta, BodyState, FormView, MailDetail } from "../api/types";
import { avatarHue, avatarText, displaySender, formatBytes, formatFullDate } from "../lib/format";
import {
  CATEGORY_LABEL,
  CATEGORY_TITLE,
  hasSenderAuthFailure,
  mailCategory,
  senderAuthBadges,
  SUSPICIOUS_FORM_NOTE,
} from "../lib/mailCategory";
import { FormManagePanel } from "./FormManagePanel";
import { FormRenderer } from "./FormRenderer";
import { HtmlBody } from "./HtmlBody";
import { PlainTextBody } from "./PlainTextBody";
import {
  IconArchive,
  IconBack,
  IconDownload,
  IconFile,
  IconForward,
  IconInbox,
  IconMailOpen,
  IconReply,
  IconReplyAll,
  IconSpam,
  IconTrash,
} from "./icons";

interface Props {
  detail: MailDetail | null;
  body: BodyState;
  loading: boolean;
  downloadingId: number | null;
  onClose: () => void;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onToggleRead: (read: boolean) => void;
  onArchive: () => void;
  onMove: (folder: "inbox" | "spam" | "trash") => void;
  onDelete: () => void;
  onDownloadAttachment: (att: AttachmentMeta) => void;
}

type FormState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "fallback" }
  | { kind: "submitted" }
  | { kind: "ready"; form: FormView };

export function ReadingPane({
  detail,
  body,
  loading,
  downloadingId,
  onClose,
  onReply,
  onReplyAll,
  onForward,
  onToggleRead,
  onArchive,
  onMove,
  onDelete,
  onDownloadAttachment,
}: Props) {
  // docs/18 P2：互動式表單。收件人 GET 成功才渲染；任何失敗 → 靜態文字（不報錯、不洩漏）。
  // 寄件備份（folder=sent）不嘗試以收件人身分取表單，改顯示下方的表單管理面板。
  const [formState, setFormState] = useState<FormState>({ kind: "idle" });
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const instanceId = detail?.kind === "interactive_form" ? detail.form_instance_id : null;
  const formFolder = detail?.folder;

  useEffect(() => {
    setFormError(null);
    if (!detail || detail.kind !== "interactive_form" || detail.form_instance_id === null || detail.folder === "sent") {
      setFormState({ kind: "idle" });
      return;
    }
    let cancelled = false;
    const id = detail.form_instance_id;
    setFormState({ kind: "loading" });
    getForm(id)
      .then((res) => {
        if (!cancelled) setFormState({ kind: "ready", form: res.form });
      })
      .catch(() => {
        // 四道鎖任一失敗（含 404）→ 靜態文字；不顯示錯誤、不洩漏存在性
        if (!cancelled) setFormState({ kind: "fallback" });
      });
    return () => {
      cancelled = true;
    };
    // 只用穩定欄位當依賴：切換已讀／未讀會更新 detail 物件，但不得重設表單輸入
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.id, detail?.kind, detail?.form_instance_id, formFolder]);

  const submitForm = async (data: Record<string, unknown>) => {
    if (instanceId === null || formSubmitting) return;
    setFormSubmitting(true);
    setFormError(null);
    try {
      await submitFormResponse(instanceId, data);
      setFormState({ kind: "submitted" });
    } catch (e) {
      // 已關閉／已送出／逾期 → 直接降為靜態（不顯示技術錯誤）
      if (
        e instanceof ApiError &&
        ["FORM_CLOSED", "FORM_ALREADY_SUBMITTED", "FORM_EXPIRED", "FORM_NOT_FOUND"].includes(e.code)
      ) {
        setFormState({ kind: "fallback" });
      } else {
        setFormError(e instanceof ApiError ? e.message : "送出失敗，請稍後再試");
      }
    } finally {
      setFormSubmitting(false);
    }
  };

  if (!detail) {
    return (
      <section className="reading-pane empty">
        <div className="empty-state">
          <IconMailOpen size={44} />
          <p>選擇一封信件開始閱讀</p>
        </div>
      </section>
    );
  }

  const hue = avatarHue(detail.from);
  const unread = detail.read_at === null;
  const toLine = detail.to.map((a) => a.address).join(", ");
  const ccLine = detail.cc.map((a) => a.address).join(", ");
  // docs/18 P1：三類郵件徽章；寄件者驗證僅供顯示（SPF／DKIM／DMARC ≠ 授權）
  const category = mailCategory(detail);
  const authBadges = senderAuthBadges(detail);
  const authFailure = hasSenderAuthFailure(detail);

  return (
    <section className="reading-pane">
      <div className="reading-toolbar">
        <button type="button" className="icon-btn back-btn" onClick={onClose} aria-label="返回列表">
          <IconBack size={20} />
        </button>
        <div className="toolbar-group">
          <button type="button" className="icon-btn" onClick={onReply} title="回覆">
            <IconReply size={18} />
          </button>
          <button type="button" className="icon-btn" onClick={onReplyAll} title="全部回覆">
            <IconReplyAll size={18} />
          </button>
          <button type="button" className="icon-btn" onClick={onForward} title="轉寄">
            <IconForward size={18} />
          </button>
        </div>
        <div className="toolbar-group">
          <button
            type="button"
            className="icon-btn"
            onClick={() => onToggleRead(unread)}
            title={unread ? "標為已讀" : "標為未讀"}
          >
            <IconMailOpen size={18} />
          </button>
          {detail.folder === "trash" || detail.folder === "spam" ? (
            <button type="button" className="icon-btn" onClick={() => onMove("inbox")} title="移至收件匣">
              <IconInbox size={18} />
            </button>
          ) : (
            <button type="button" className="icon-btn" onClick={onArchive} title="封存">
              <IconArchive size={18} />
            </button>
          )}
          {detail.folder !== "spam" && (
            <button type="button" className="icon-btn" onClick={() => onMove("spam")} title="標為垃圾郵件">
              <IconSpam size={18} />
            </button>
          )}
          <button type="button" className="icon-btn danger" onClick={onDelete} title="刪除（移至垃圾桶）">
            <IconTrash size={18} />
          </button>
        </div>
      </div>

      <div className="reading-scroll">
        <header className="reading-head">
          <h1 className="reading-subject">{detail.subject || "(無主旨)"}</h1>
          <div className="reading-sender">
            <span className="avatar" style={{ background: `hsl(${hue} 58% 46%)` }}>
              {avatarText(detail.from)}
            </span>
            <div className="sender-lines">
              <div className="sender-name">{displaySender(detail.from)}</div>
              <div className="sender-meta">
                <span className={`mail-kind-badge kind-${category}`} title={CATEGORY_TITLE[category]}>
                  {CATEGORY_LABEL[category]}
                </span>
                <span>{formatFullDate(detail.received_at)}</span>
              </div>
              {detail.origin === "external" && (
                <div
                  className={`sender-auth ${authFailure ? "has-failure" : ""}`}
                  title="寄件者驗證結果僅供顯示，不會授權或改變郵件分類"
                >
                  {authBadges.map((badge) => (
                    <span key={badge.method} className={`auth-chip auth-${badge.tone}`}>
                      {badge.label}
                    </span>
                  ))}
                  {authFailure && <span className="auth-warning">⚠️ 寄件者驗證失敗，請留意釣魚</span>}
                </div>
              )}
              {detail.suspicious_form_claim && <p className="mail-warning">{SUSPICIOUS_FORM_NOTE}</p>}
              <details className="recipients">
                <summary>
                  寄給 {toLine.length > 60 ? `${toLine.slice(0, 60)}…` : toLine || "我"}
                  {detail.cc.length > 0 ? "（含副本）" : ""}
                </summary>
                <div className="recipients-detail">
                  <div>
                    <strong>寄件者：</strong>
                    {detail.from}
                  </div>
                  <div>
                    <strong>收件者：</strong>
                    {toLine || "—"}
                  </div>
                  {ccLine && (
                    <div>
                      <strong>副本：</strong>
                      {ccLine}
                    </div>
                  )}
                  <div>
                    <strong>資料夾：</strong>
                    {detail.folder} · 信件 ID {detail.id}
                  </div>
                </div>
              </details>
            </div>
          </div>
        </header>

        {/* docs/18 §3.4：寄件人可檢視回覆、撤回（僅寄件人；非寄件人端點回 403 → 元件自動隱藏） */}
        {detail.folder === "sent" && detail.kind === "interactive_form" && detail.form_instance_id !== null && (
          <FormManagePanel instanceId={detail.form_instance_id} />
        )}

        {detail.attachments.length > 0 && (
          <div className="attachment-strip">
            {detail.attachments.map((att) => (
              <button
                key={att.id}
                type="button"
                className="attachment-chip"
                onClick={() => onDownloadAttachment(att)}
                disabled={downloadingId === att.id}
                title={`下載 ${att.filename}`}
              >
                <IconFile size={18} />
                <span className="att-name">{att.filename}</span>
                <span className="att-size">{formatBytes(att.size_bytes)}</span>
                {downloadingId === att.id ? <span className="spinner small" /> : <IconDownload size={16} />}
              </button>
            ))}
          </div>
        )}

        <div className="reading-body">
          {formState.kind === "loading" ? (
            <div className="list-state">
              <div className="spinner" />
              <p>載入表單…</p>
            </div>
          ) : formState.kind === "ready" ? (
            <div className="form-pane">
              <p className="form-intro">{formState.form.description ?? ""}</p>
              <FormRenderer
                schema={formState.form.schema}
                submitting={formSubmitting}
                onSubmit={(data) => void submitForm(data)}
              />
              {formError && <p className="compose-error">{formError}</p>}
            </div>
          ) : formState.kind === "submitted" ? (
            <div className="form-success" role="status">
              <strong>已送出回覆</strong>
              <p>寄件人現在可以查看你的回覆。</p>
            </div>
          ) : loading || body.kind === "loading" ? (
            <div className="list-state">
              <div className="spinner" />
              <p>載入內容…</p>
            </div>
          ) : body.kind === "html" ? (
            <HtmlBody html={body.html} />
          ) : body.kind === "text" ? (
            <PlainTextBody text={body.text} />
          ) : (
            <p className="muted">（此信沒有可顯示的內文）</p>
          )}
        </div>
      </div>
    </section>
  );
}
