import { useCallback, useEffect, useRef, useState } from "react";
import type { MailListItem } from "../api/types";

/** 點擊時修飾鍵（React MouseEvent 結構上相容） */
export interface SelectionModifiers {
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

/**
 * 依目前列表順序取 anchor → target 的連續 id（含兩端）。
 * 找不到 anchor（例如列表已重新載入）→ 只選 target。
 */
export function rangeSelection(items: MailListItem[], anchorId: number, targetId: number): number[] {
  const a = items.findIndex((i) => i.id === anchorId);
  const b = items.findIndex((i) => i.id === targetId);
  if (a < 0 || b < 0) return [targetId];
  const [start, end] = a <= b ? [a, b] : [b, a];
  return items.slice(start, end + 1).map((i) => i.id);
}

/**
 * 信件列表複選狀態（docs/19 §3）。
 *
 * - state 一律是 `Set<number>`（大量 id 的 has() 是 O(1)）
 * - 點擊語意：shift → 範圍連選；ctrl／meta → 切換單封；一般 → 單選（回傳 true 讓呼叫端開信）
 * - `scopeKey`（資料夾／地址／搜尋）一變 → **清空選取**，避免跨清單的殘留選取
 */
export function useMailSelection(items: MailListItem[], scopeKey: string) {
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const anchorRef = useRef<number | null>(null);
  const scopeRef = useRef(scopeKey);

  useEffect(() => {
    if (scopeRef.current === scopeKey) return;
    scopeRef.current = scopeKey;
    anchorRef.current = null;
    setSelectedIds(new Set());
  }, [scopeKey]);

  const clear = useCallback(() => {
    anchorRef.current = null;
    setSelectedIds(new Set());
  }, []);

  /**
   * 處理列表點擊。回傳 `true` 代表「一般點擊」——呼叫端應同時開信。
   * shift／ctrl／meta 只改選取，不開信（與常見郵件軟體一致）。
   */
  const select = useCallback(
    (id: number, mods: SelectionModifiers = {}): boolean => {
      if (mods.shiftKey) {
        const anchor = anchorRef.current ?? id;
        setSelectedIds(new Set(rangeSelection(items, anchor, id)));
        anchorRef.current = anchor; // 範圍連選期間 anchor 固定
        return false;
      }
      if (mods.ctrlKey || mods.metaKey) {
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        anchorRef.current = id;
        return false;
      }
      setSelectedIds(new Set([id]));
      anchorRef.current = id;
      return true;
    },
    [items]
  );

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(items.map((i) => i.id)));
    anchorRef.current = items.length > 0 ? items[0]!.id : null;
  }, [items]);

  return { selectedIds, select, selectAll, clear };
}
