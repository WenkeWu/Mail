/**
 * `AddressManager` 的**渲染測試**（docs/16 **D12**／T33；D11-3 與 D11-5 的對話框與區塊）。
 *
 * 為什麼要有這一組：D11-3（soft／hard 兩選項）與 D11-5（「已刪除的地址」區塊）原本只測到
 * `lib/statusSemantics.ts` 的**文案純函式**——文案對，不代表它真的被渲染出來、按鈕真的接上、
 * 或某個區塊壞掉時整頁會不會跟著壞。這裡在 jsdom 內**真的渲染元件**並以 `fetch` 假物件餵資料。
 *
 * 對應 docs/16 §6：
 * - T33-1：已刪除的地址區塊可渲染（含信件數與刪除時間）
 * - T33-2：刪除對話框的兩個選項（soft／hard）與「不可復原」警語
 * - T33-5：清單載入失敗 → 該區塊顯示錯誤且**不影響整頁**
 * - 追加：D11-5 的永久清除二次確認（逐字「含垃圾桶」「不可復原」）
 *
 * ⚠️ 全程只 mock `fetch`（網路邊界），元件、狀態、`ApiError` 轉換、DOM 事件都是真的。
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AddressManager } from "../src/components/AddressManager";
import type { DeletedAddressInfo, EmailAddressInfo, Session } from "../src/api/types";
import {
  ADDRESS_DELETE_HARD_LABEL,
  ADDRESS_DELETE_SOFT_DESC,
  ADDRESS_DELETE_SOFT_LABEL,
  DELETED_ADDRESS_SECTION_TITLE,
} from "../src/lib/statusSemantics";
import { apiError, installFetch, type FetchCall, type FakeReply } from "./dom-fetch";

const OWNER_SESSION: Session = { kind: "owner", token: "owner-token", userId: 1, username: "owner" };
const DELETED_URL = "/api/email-addresses?deleted=1";

const LIVE: EmailAddressInfo = {
  id: 11,
  email: "sales01@atwho.org",
  status: "active",
  has_password: true,
  created_at: Date.UTC(2026, 8, 1),
  updated_at: Date.UTC(2026, 8, 1),
  messages: 15,
};

/** 垃圾桶狀態（soft 刪除過）的地址：名稱還佔著、信件與 R2 物件都還在（D11-5） */
const TRASHED: DeletedAddressInfo = {
  id: 9,
  email: "old-sales@atwho.org",
  status: "deleted",
  has_password: false,
  created_at: Date.UTC(2026, 7, 2),
  updated_at: Date.UTC(2026, 9, 14),
  deleted_at: Date.UTC(2026, 9, 14),
  messages: 7,
};

const zhDate = (ts: number) => new Date(ts).toLocaleDateString("zh-TW");

/** 只認得這幾個端點；其餘請求一律讓測試爆掉（避免不小心多打了什麼） */
function routes(opts: { live?: FakeReply; deleted?: FakeReply }) {
  return (call: FetchCall): FakeReply => {
    if (call.url === DELETED_URL) return opts.deleted ?? { body: { addresses: [] } };
    if (call.url === "/api/email-addresses") {
      if (call.method === "DELETE") return { body: { addresses: [] } };
      return opts.live ?? { body: { addresses: [] } };
    }
    // soft 刪除：後端回 204（無 body）；hard：200 ＋ 刪除數量
    if (call.url === `/api/email-addresses/${LIVE.id}` && call.method === "DELETE") return { status: 204 };
    if (call.url === `/api/email-addresses/${LIVE.id}?mode=hard` && call.method === "DELETE") {
      return { body: { ok: true, id: LIVE.id, email: LIVE.email, mode: "hard", deleted: { messages: 15 } } };
    }
    throw new Error(`未預期的請求：${call.method} ${call.url}`);
  };
}

function renderManager(onToast = vi.fn()) {
  render(<AddressManager session={OWNER_SESSION} onBack={vi.fn()} onToast={onToast} />);
  return { onToast };
}

describe("T33-1（D11-5）：「已刪除的地址」區塊", () => {
  it("渲染地址、刪除時間與信件數，且數量文案同步", async () => {
    installFetch(routes({ live: { body: { addresses: [LIVE] } }, deleted: { body: { addresses: [TRASHED] } } }));
    renderManager();

    // 區塊標題（<summary> 內）與數量
    expect(await screen.findByText(DELETED_ADDRESS_SECTION_TITLE)).toBeTruthy();
    expect(screen.getByText(/共 1 個已刪除的地址/)).toBeTruthy();

    // 這一列的三個關鍵資訊：地址、刪除時間、信件數
    expect(screen.getByText(TRASHED.email)).toBeTruthy();
    expect(screen.getByText(`${TRASHED.messages} 封`)).toBeTruthy();
    expect(screen.getByText(zhDate(TRASHED.deleted_at))).toBeTruthy();

    // 顯示的是**刪除時間**（deleted_at），不是建立時間 —— 這是 owner 判斷「這批殘留多久了」的依據
    expect(screen.queryByText(zhDate(TRASHED.created_at))).toBeNull();

    // 垃圾桶列只能「永久刪除」；soft 已無意義（後端對已軟刪除的列做 soft 回 404）
    expect(screen.getByRole("button", { name: ADDRESS_DELETE_HARD_LABEL })).toBeTruthy();
  });

  it("空清單也明講「沒有已刪除的地址」，不謊報也不留白", async () => {
    installFetch(routes({ live: { body: { addresses: [LIVE] } }, deleted: { body: { addresses: [] } } }));
    renderManager();

    // 兩處都要講（summary 的數量與區塊內的空狀態），不讓人以為是壞掉
    expect(await screen.findByText(/（沒有已刪除的地址）/)).toBeTruthy();
    expect(screen.getByText("目前沒有已刪除的地址。")).toBeTruthy();
    expect(screen.queryByText(TRASHED.email)).toBeNull();
  });

  it("永久刪除的二次確認逐字明寫清除範圍（含垃圾桶）與「不可復原」（D11-5）", async () => {
    installFetch(routes({ live: { body: { addresses: [LIVE] } }, deleted: { body: { addresses: [TRASHED] } } }));
    renderManager();

    fireEvent.click(await screen.findByRole("button", { name: ADDRESS_DELETE_HARD_LABEL }));

    const dialog = screen.getByRole("dialog", { name: "永久刪除已刪除的地址" });
    // 講清楚是哪一個地址、有幾封信
    expect(within(dialog).getByText(TRASHED.email)).toBeTruthy();
    expect(within(dialog).getByText(`此地址有 ${TRASHED.messages} 封信，永久刪除將一併刪除`)).toBeTruthy();
    // ⚠️ 警語：所有信件與附件（含垃圾桶）＋不可復原
    const warn = within(dialog).getByText(/所有信件與附件（含垃圾桶）/);
    expect(warn.textContent).toContain("不可復原");
    // 未按確定之前不得發出任何刪除請求
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("T33-2（D11-3）：刪除地址的兩選項對話框", () => {
  it("兩個選項（soft／hard）都在，且 hard 附「不可復原」警語", async () => {
    installFetch(routes({ live: { body: { addresses: [LIVE] } }, deleted: { body: { addresses: [TRASHED] } } }));
    renderManager();

    // 現存地址列（不是垃圾桶列）的「刪除」
    fireEvent.click(await screen.findByRole("button", { name: "刪除" }));

    const dialog = screen.getByRole("dialog", { name: "刪除地址" });
    // ① soft（預設）：保留信件
    expect(within(dialog).getByRole("button", { name: new RegExp(ADDRESS_DELETE_SOFT_LABEL) })).toBeTruthy();
    expect(within(dialog).getByText(new RegExp(ADDRESS_DELETE_SOFT_DESC.slice(0, 20)))).toBeTruthy();
    // ② hard：不可復原
    expect(within(dialog).getByRole("button", { name: ADDRESS_DELETE_HARD_LABEL })).toBeTruthy();
    expect(within(dialog).getByText(/無法復原/)).toBeTruthy();
    // 對話框先講清楚會刪掉幾封信（D11-3）
    expect(within(dialog).getByText(`此地址有 ${LIVE.messages} 封信，永久刪除將一併刪除`)).toBeTruthy();
  });

  it("選 soft → 送出 DELETE（不帶 mode）；選 hard → 帶 ?mode=hard", async () => {
    const spy = installFetch(
      routes({ live: { body: { addresses: [LIVE] } }, deleted: { body: { addresses: [] } } })
    );
    const { onToast } = renderManager();

    // ── soft ──
    fireEvent.click(await screen.findByRole("button", { name: "刪除" }));
    let dialog = screen.getByRole("dialog", { name: "刪除地址" });
    fireEvent.click(within(dialog).getByRole("button", { name: new RegExp(ADDRESS_DELETE_SOFT_LABEL) }));

    const softCall = spy.calls.find((c) => c.method === "DELETE");
    expect(softCall?.url).toBe("/api/email-addresses/11");

    // ── hard（清單重載後再開一次對話框）──
    fireEvent.click(await screen.findByRole("button", { name: "刪除" }));
    dialog = screen.getByRole("dialog", { name: "刪除地址" });
    fireEvent.click(within(dialog).getByRole("button", { name: ADDRESS_DELETE_HARD_LABEL }));

    const hardCall = spy.calls.filter((c) => c.method === "DELETE").at(-1);
    expect(hardCall?.url).toBe("/api/email-addresses/11?mode=hard");
    // 兩種模式的 toast 語意不同（soft 說保留、hard 說已清除）
    await vi.waitFor(() => expect(onToast).toHaveBeenCalledWith(expect.stringContaining("已永久刪除")));
    expect(onToast).toHaveBeenCalledWith(expect.stringContaining("已停用"));
  });
});

describe("T33-5（D11-5）：清單載入失敗只壞該區塊", () => {
  it("「已刪除的地址」載入失敗 → 區塊內顯示錯誤＋重試，其餘頁面照常", async () => {
    const spy = installFetch(
      routes({
        live: { body: { addresses: [LIVE] } },
        deleted: apiError(500, "INTERNAL_ERROR", "伺服器忙碌中，請稍後再試"),
      })
    );
    renderManager();

    // 區塊內：錯誤訊息 ＋ 重試按鈕
    expect(await screen.findByText(/伺服器忙碌中/)).toBeTruthy();
    const retry = screen.getByRole("button", { name: "重試" });

    // 整頁不受影響：標題、建立表單、現存地址清單都還在
    expect(screen.getByRole("heading", { name: "地址管理" })).toBeTruthy();
    expect(screen.getByText("建立虛擬地址")).toBeTruthy();
    expect(screen.getByText(LIVE.email)).toBeTruthy();

    // 重試只重打失敗的那個端點
    expect(spy.countOf(DELETED_URL)).toBe(1);
    fireEvent.click(retry);
    await vi.waitFor(() => expect(spy.countOf(DELETED_URL)).toBe(2));
    expect(spy.countOf("/api/email-addresses")).toBe(1);
  });

  it("載入失敗時不假裝「沒有已刪除的地址」（讀取中…而非空清單）", async () => {
    installFetch(
      routes({ live: { body: { addresses: [LIVE] } }, deleted: apiError(500, "INTERNAL_ERROR", "讀取失敗") })
    );
    renderManager();

    await screen.findByText(/讀取失敗/);
    expect(screen.queryByText(/沒有已刪除的地址/)).toBeNull();
    expect(screen.getByText(/（讀取中…）/)).toBeTruthy();
  });
});
