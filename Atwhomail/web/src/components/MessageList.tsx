import { useEffect, useRef } from "react";
import type { MailListItem } from "../api/types";
import { MessageListItem } from "./MessageListItem";
import { IconInbox, IconSearch } from "./icons";

interface Props {
  items: MailListItem[];
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  nextCursor: string | null;
  selectedId: number | null;
  /** 搜尋模式（folder=all）→ 顯示資料夾標籤、空狀態文案不同 */
  showFolderChip: boolean;
  query: string;
  onLoadMore: () => void;
  onSelect: (id: number) => void;
}

export function MessageList({
  items,
  loading,
  loadingMore,
  error,
  nextCursor,
  selectedId,
  showFolderChip,
  query,
  onLoadMore,
  onSelect,
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

  return (
    <div className="message-list">
      <ul>
        {items.map((item) => (
          <MessageListItem
            key={item.id}
            item={item}
            selected={item.id === selectedId}
            showFolder={showFolderChip}
            onSelect={onSelect}
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
