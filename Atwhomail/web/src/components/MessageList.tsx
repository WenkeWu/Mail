import { useEffect, useRef } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import type { MailListItem } from "../api/types";
import { MessageListItem } from "./MessageListItem";
import { IconInbox, IconSearch } from "./icons";

interface Props {
  items: MailListItem[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  nextCursor: string | null;
  /** 複選的 id（docs/19 §3） */
  selectedIds: Set<number>;
  /** 搜尋模式（folder=all）→ 顯示資料夾標籤、空狀態文案不同 */
  showFolderChip: boolean;
  query: string;
  onLoadMore: () => void;
  onSelect: (id: number, event: MouseEvent<HTMLButtonElement>) => void;
  /** 每列 checkbox：只切換選取（Shift＝範圍連選），不開信（docs/19 §6 D19-4） */
  onToggleSelect: (id: number, event: { shiftKey: boolean }) => void;
  /** Ctrl／Cmd+A（清單聚焦時）→ 全選 */
  onSelectAll: () => void;
}

export function MessageList({
  items,
  loading,
  loadingMore,
  error,
  nextCursor,
  selectedIds,
  showFolderChip,
  query,
  onLoadMore,
  onSelect,
  onToggleSelect,
  onSelectAll,
}: Props) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !nextCursor) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onLoadMore();
      },
      { rootMargin: "240px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [nextCursor, onLoadMore, items.length]);

  if (loading) {
    return (
      <div className="list-state">
        <div className="spinner" aria-label="載入中" />
        <p>載入中…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="list-state">
        <p className="error-text">{error}</p>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="list-state">
        {query ? <IconSearch size={34} /> : <IconInbox size={34} />}
        <p>{query ? `找不到符合「${query}」的信件` : "這裡沒有信件"}</p>
      </div>
    );
  }

  /** Ctrl／Cmd+A：只在焦點位於清單內時觸發（事件由 option／listbox 冒泡上來） */
  const handleKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if ((event.ctrlKey || event.metaKey) && (event.key === "a" || event.key === "A")) {
      event.preventDefault();
      onSelectAll();
    }
  };

  return (
    <div className="message-list">
      {/* listbox ＋ option：aria-multiselectable／aria-selected 供輔助技術讀取；tabIndex 讓清單可聚焦 */}
      <ul
        role="listbox"
        aria-multiselectable="true"
        aria-label="信件清單"
        tabIndex={0}
        className="mail-listbox"
        onKeyDown={handleKeyDown}
      >
        {items.map((item) => (
          <MessageListItem
            key={item.id}
            item={item}
            selected={selectedIds.has(item.id)}
            showFolder={showFolderChip}
            onSelect={onSelect}
            onToggleSelect={onToggleSelect}
          />
        ))}
      </ul>
      <div ref={sentinelRef} className="list-sentinel">
        {loadingMore && <span className="spinner small" />}
        {!nextCursor && items.length >= 50 && <span className="list-end">沒有更多信件了</span>}
      </div>
    </div>
  );
}
