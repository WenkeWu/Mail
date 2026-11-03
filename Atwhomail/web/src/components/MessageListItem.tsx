import { memo } from "react";
import type { MouseEvent } from "react";
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
  onSelect: (id: number, event: MouseEvent<HTMLButtonElement>) => void;
  /**
   * 每列 checkbox（docs/19 §6 D19-4）：只切換選取，**不開信**。
   * Shift＋點 → 範圍連選（錨點由 useMailSelection 維護）。
   */
  onToggleSelect?: (id: number, event: { shiftKey: boolean }) => void;
}

export const MessageListItem = memo(function MessageListItem({
  item,
  selected,
  showFolder,
  onSelect,
  onToggleSelect,
}: Props) {
  const hue = avatarHue(item.from);
  // 寄件備份的 read_at 恆為 NULL，但不該顯示成未讀
  const unread = !item.read && item.folder !== "sent";
  const category = mailCategory(item);
  return (
    // 已選列的視覺（背景高亮＋左側色條）掛在整列，checkbox 也一併被涵蓋
    <li className={`mail-row-item ${unread ? "unread" : ""} ${selected ? "selected" : ""}`}>
      <input
        type="checkbox"
        className="mail-row-checkbox"
        aria-label={`選取信件：${item.subject || "(無主旨)"}`}
        checked={selected}
        // 選取狀態由 React state 控制；切換語意統一在 onClick（含 Shift 範圍連選）
        onChange={() => {}}
        onClick={(event) => {
          // ⚠️ 只切換選取：絕不讓點擊冒泡到列（列點擊會開信）
          event.stopPropagation();
          onToggleSelect?.(item.id, event);
        }}
      />
      <button
        type="button"
        // listbox 的 option：aria-selected 讓輔助技術知道複選狀態（docs/19 §3）
        role="option"
        aria-selected={selected}
        className="mail-row"
        onClick={(event) => onSelect(item.id, event)}
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
