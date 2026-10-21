import { memo } from "react";
import type { MailListItem } from "../api/types";
import { avatarHue, avatarText, displaySender, relativeTime } from "../lib/format";
import { CATEGORY_LABEL, CATEGORY_TITLE, mailCategory } from "../lib/mailCategory";
import { FOLDER_LABEL } from "../lib/labels";
import { IconPaperclip } from "./icons";

interface Props {
  item: MailListItem;
  selected: boolean;
  /** folder=all（搜尋）時顯示資料夾標籤 */
  showFolder: boolean;
  onSelect: (id: number) => void;
}

export const MessageListItem = memo(function MessageListItem({ item, selected, showFolder, onSelect }: Props) {
  const hue = avatarHue(item.from);
  // 寄件備份的 read_at 恆為 NULL，但不該顯示成未讀
  const unread = !item.read && item.folder !== "sent";
  const category = mailCategory(item);
  return (
    <li>
      <button
        type="button"
        className={`mail-row ${unread ? "unread" : ""} ${selected ? "selected" : ""}`}
        onClick={() => onSelect(item.id)}
      >
        <span className="avatar" style={{ background: `hsl(${hue} 58% 46%)` }}>
          {avatarText(item.from)}
        </span>
        <span className="mail-row-main">
          <span className="mail-row-top">
            <span className="mail-sender">{displaySender(item.from)}</span>
            <span className={`mail-kind-badge kind-${category}`} title={CATEGORY_TITLE[category]}>
              {CATEGORY_LABEL[category]}
            </span>
            <span className="mail-time">{relativeTime(item.received_at)}</span>
          </span>
          <span className="mail-subject">
            {item.subject || "(無主旨)"}
            {item.has_attachments && (
              <span className="clip" aria-label="含附件">
                <IconPaperclip size={13} />
              </span>
            )}
          </span>
          <span className="mail-preview">{item.text_preview ?? ""}</span>
        </span>
        {showFolder && <span className="folder-chip">{FOLDER_LABEL[item.folder]}</span>}
      </button>
    </li>
  );
});
