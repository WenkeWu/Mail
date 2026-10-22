/**
 * retry.ts — 連線類錯誤的重試（D17-2，docs/17 §7.2）
 *
 * 背景：2026-10-21 的 verify 與 10-22 的 agent tick 各出現一次
 * `Connection terminated due to connection timeout`（PostgreSQL）。單次抖動不該：
 *   - 讓 agent 結束（supervisor 60 秒後才重啟 → 5 分鐘的 tick 被拖成 10 分鐘）
 *   - 讓 verify 以 exit 1 收場 → watchdog 誤報
 *
 * 規則（嚴格照 docs/17 §7.2）：
 *   - 只重試**連線類**錯誤：訊息含 Connection terminated／ECONNRESET／ETIMEDOUT／timeout
 *   - 重試 3 次，退避 1s／2s／4s（首次失敗後等 1s、第二次後等 2s、第三次後等 4s）
 *   - 全數失敗才把最後一個錯誤往外丟（不得無限重試）
 *   - 非連線類錯誤（例如 SQL 語法錯誤）立即往外丟，不等待、不重試
 */

const CONNECTION_ERROR_PATTERNS = [
  /Connection terminated/i,
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /timeout/i,
];

/** 取出錯誤本身＋cause 鏈的可讀文字（Node 的 fetch 會把真正原因放在 cause） */
export function errorText(error: unknown, depth = 0): string {
  if (error === null || error === undefined) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    const parts = [error.message, error.name];
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") parts.push(code);
    const cause = (error as { cause?: unknown }).cause;
    if (cause !== undefined && depth < 3) parts.push(errorText(cause, depth + 1));
    return parts.filter(Boolean).join(" ");
  }
  if (typeof error === "object") {
    const e = error as { message?: unknown; code?: unknown; cause?: unknown };
    const parts: string[] = [];
    if (typeof e.message === "string") parts.push(e.message);
    if (typeof e.code === "string") parts.push(e.code);
    if (e.cause !== undefined && depth < 3) parts.push(errorText(e.cause, depth + 1));
    if (parts.length === 0) {
      try {
        return JSON.stringify(error);
      } catch {
        return String(error);
      }
    }
    return parts.filter(Boolean).join(" ");
  }
  return String(error);
}

export function isConnectionError(error: unknown): boolean {
  const text = errorText(error);
  return CONNECTION_ERROR_PATTERNS.some((re) => re.test(text));
}

/** 給 log 用的短摘要（避免把整份 stack／SQL 塞進日誌） */
export function summarizeError(error: unknown, max = 240): string {
  const text = errorText(error).replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export interface RetryOptions {
  /** 重試次數（不含第一次嘗試）；預設 3 → 最多 4 次 */
  retries?: number;
  /** 每次重試前的等待；預設 [1000, 2000, 4000] */
  delaysMs?: number[];
  /** 測試可注入；預設真的 setTimeout */
  sleep?: (ms: number) => Promise<void>;
  /** 重試紀錄（含第幾次與錯誤摘要） */
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** 測試可注入；預設 isConnectionError */
  isRetryable?: (error: unknown) => boolean;
}

export async function withConnectionRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const retries = Math.max(0, Math.trunc(options.retries ?? 3));
  const delays = options.delaysMs ?? [1000, 2000, 4000];
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const retryable = options.isRetryable ?? isConnectionError;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      const canRetry = attempt <= retries && retryable(error);
      if (!canRetry) throw error;

      const delayMs = delays[Math.min(attempt - 1, delays.length - 1)] ?? 1000;
      options.log?.("connection error, retrying", {
        attempt, // 第幾次嘗試失敗（1-based）
        nextAttempt: attempt + 1,
        maxAttempts: retries + 1,
        delayMs,
        error: summarizeError(error),
      });
      await sleep(delayMs);
    }
  }
}
