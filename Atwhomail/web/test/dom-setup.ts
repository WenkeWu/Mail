/**
 * DOM 測試的共同前置（docs/16 D12）。
 *
 * 兩件事：
 * 1. **清理**：`@testing-library/react` 的自動清理只在 `globals: true` 時生效，
 *    本 repo 不開 globals（一律明確 import）→ 這裡自己 `afterEach(cleanup)`，
 *    否則上一個測試的 DOM 會殘留，`getByText` 會因重複元素而爆錯。
 * 2. **網路安全網**：D12 明文「jsdom 下必須 mock `fetch`，不得真的打網路」。
 *    每個測試自己安裝 mock（`installFetch`）；這裡先鋪一個「一被呼叫就丟例外」的
 *    `fetch`，任何忘記 mock 的測試會**立刻失敗**而不是靜默地對外連線。
 *    （測試檔的 `beforeEach` 在本檔之後執行 → 測試自己的 mock 會覆蓋這一層。）
 */
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("D12：DOM 測試不得發出真實網路請求 —— 這個測試忘記安裝 fetch mock");
  });
});
