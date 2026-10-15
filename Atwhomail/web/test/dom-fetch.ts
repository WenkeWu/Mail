/**
 * DOM 測試用的 **fetch 假物件**（docs/16 D12：jsdom 下不得真的打網路）。
 *
 * 元件一律經 `api/endpoints.ts` → `api/client.ts` 的 `request()` 發送，最終呼叫全域 `fetch`。
 * 這裡把它換成「依 URL 回傳預先準備好的 JSON」的函式，並記錄每一次呼叫，
 * 讓測試能同時斷言**畫面**與**送出的請求**。
 *
 * ⚠️ 只 mock `fetch`（＝網路邊界），其餘（React 狀態、`ApiError` 轉換、DOM 事件）全是真的。
 */
import { vi } from "vitest";

export interface FetchCall {
  /** 例如 "/api/email-addresses?deleted=1" */
  url: string;
  method: string;
  /** 有 JSON body 時已解析，否則 null */
  body: unknown;
}

export interface FakeReply {
  /** 預設 200 */
  status?: number;
  /** 會被 `JSON.stringify`；未給＝空 body（例如 204） */
  body?: unknown;
}

export type FetchHandler = (call: FetchCall) => FakeReply | Promise<FakeReply>;

export interface FetchSpy {
  calls: FetchCall[];
  /** 對某個 URL 的呼叫次數（用來驗證「重試」真的重新打了一次） */
  countOf(url: string): number;
}

/** 安裝 fetch mock；回傳的 `calls` 會即時累積。 */
export function installFetch(handler: FetchHandler): FetchSpy {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const rawBody = typeof init.body === "string" ? init.body : null;
    const call: FetchCall = {
      url,
      method: init.method ?? "GET",
      body: rawBody === null ? null : (JSON.parse(rawBody) as unknown),
    };
    calls.push(call);
    const reply = await handler(call);
    const status = reply.status ?? 200;
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return {
    calls,
    countOf: (url) => calls.filter((c) => c.url === url).length,
  };
}

/** 後端錯誤回應的形狀（`{ error: { code, message } }`，見 docs/05） */
export function apiError(status: number, code: string, message: string): FakeReply {
  return { status, body: { error: { code, message } } };
}
