import type { AttachmentMeta, BodyState, MailDetail } from "../api/types";
import { avatarHue, avatarText, displaySender, formatBytes, formatFullDate } from "../lib/format";
import {
  CATEGORY_LABEL,
  CATEGORY_TITLE,
  hasSenderAuthFailure,
  mailCategory,
  senderAuthBadges,
  SUSPICIOUS_FORM_NOTE,
} from "../lib/mailCategory";
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
          {loading || body.kind === "loading" ? (
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
