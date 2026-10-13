import { useEffect, useState } from "react";
import { getCounts } from "../api/endpoints";
import type { CountsResponse } from "../api/types";

/**
 * 側欄未讀統計：掛載／refreshKey 變動時抓取，之後每 60 秒輪詢，
 * 並在分頁重新可見時立即更新（沒有推播，這是唯一的新信感知來源）。
 */
export function useCounts(refreshKey: number) {
  const [counts, setCounts] = useState<CountsResponse | null>(null);

  useEffect(() => {
    let cancelled = false;

    const fetchCounts = async () => {
      try {
        const res = await getCounts();
        if (!cancelled) setCounts(res);
      } catch {
        /* 統計失敗不干擾主流程（例如剛登出時的 401 由全域處理） */
      }
    };

    void fetchCounts();
    const timer = window.setInterval(fetchCounts, 60_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void fetchCounts();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshKey]);

  return counts;
}
