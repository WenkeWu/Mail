import { useCallback, useEffect, useRef, useState } from "react";
import { listMail } from "../api/endpoints";
import type { MailListItem } from "../api/types";

interface Params {
  /** "inbox" | "sent" | … | "all"（搜尋時呼叫端會傳 "all"） */
  folder: string;
  q: string;
  addressId: number | null;
  /** 變動即重新載入第一頁（保留給「重新整理」與動作後刷新） */
  refreshKey: number;
}

/**
 * 信件列表 + keyset 游標分頁。
 * - 以遞增序號丟棄過期回應（快速切換資料夾時不會被舊結果覆蓋）
 * - loadMore 會沿用產生游標當下的 folder/q/addressId（同一次載入期間）
 * - 動作造成的列變更以本地 removeItem/patchItem 更新 → 不重抓、保留捲動位置
 */
export function useMailList({ folder, q, addressId, refreshKey }: Params) {
  const [items, setItems] = useState<MailListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(
    async (cursor: string | null, append: boolean) => {
      const seq = ++seqRef.current;
      if (append) {
        setLoadingMore(true);
      } else {
        setLoading(true);
        setItems([]);
        setNextCursor(null);
      }
      setError(null);
      try {
        const res = await listMail({ folder, q, addressId, cursor });
        if (seq !== seqRef.current) return;
        setItems((prev) => {
          if (!append) return res.items;
          const seen = new Set(prev.map((i) => i.id));
          return [...prev, ...res.items.filter((i) => !seen.has(i.id))];
        });
        setNextCursor(res.nextCursor);
      } catch (e) {
        if (seq !== seqRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (seq === seqRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [folder, q, addressId]
  );

  useEffect(() => {
    void load(null, false);
  }, [load, refreshKey]);

  const loadMore = useCallback(() => {
    if (!nextCursor || loading || loadingMore) return;
    void load(nextCursor, true);
  }, [nextCursor, loading, loadingMore, load]);

  const removeItem = useCallback((id: number) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
  }, []);

  const patchItem = useCallback((id: number, patch: Partial<MailListItem>) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  }, []);

  return { items, nextCursor, loading, loadingMore, error, loadMore, removeItem, patchItem };
}
