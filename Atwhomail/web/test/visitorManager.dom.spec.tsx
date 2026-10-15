/**
 * `VisitorManager` 的**渲染測試**（docs/16 **D12**／T33；D8-2／D8-3 與 D9 的文案與二次確認）。
 *
 * 為什麼要有這一組：「停權」與「停用」在畫面上長得幾乎一樣，但後果不同（一個來信照收、
 * 一個連收信都斷）。純函式測試只證明文案字串對；這裡證明**按鈕真的掛上那個文案與 tooltip**、
 * 二次確認**真的會跳出來**、而且警語在對話框裡逐字可見。
 *
 * 對應 docs/16 §6：
 * - T33-3：停權（所有地址；仍可收信）／停用（連收信都停止）的文案與 tooltip
 * - T33-4：刪除訪客的二次確認警語
 * - T33-5：清單載入失敗不影響整頁
 *
 * ⚠️ 全程只 mock `fetch`（網路邊界），元件、狀態、`ApiError` 轉換、DOM 事件都是真的。
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VisitorManager } from "../src/components/VisitorManager";
import type { VisitorUser } from "../src/api/types";
import {
  ADDRESS_DISABLE_WARNING,
  USER_DELETE_WARNING,
  VISITOR_MANAGER_HINT,
  addressStatusActionLabel,
  addressStatusTooltip,
  userStatusActionLabel,
  userStatusTooltip,
} from "../src/lib/statusSemantics";
import { apiError, installFetch, type FetchCall, type FakeReply } from "./dom-fetch";

const VISITORS_URL = "/api/users?role=visitor";

const VISITOR: VisitorUser = {
  id: 7,
  username: "visitor1",
  status: "active",
  created_at: Date.UTC(2026, 8, 10),
  address: {
    id: 21,
    email: "visitor1@atwho.org",
    status: "active",
    can_send: 1,
    daily_send_quota: 50,
    sent_today: 3,
    warmup_exempt: 0,
  },
  mail_count: 4,
  last_activity_at: Date.UTC(2026, 9, 13, 12, 0),
};

function routes(opts: { visitors?: FakeReply }) {
  return (call: FetchCall): FakeReply => {
    if (call.url === VISITORS_URL) return opts.visitors ?? { body: { users: [] } };
    if (call.url === `/api/users/${VISITOR.id}` && call.method === "DELETE") {
      return { body: { ok: true, id: VISITOR.id, username: VISITOR.username } };
    }
    throw new Error(`未預期的請求：${call.method} ${call.url}`);
  };
}

function renderManager(onToast = vi.fn()) {
  render(<VisitorManager onBack={vi.fn()} onToast={onToast} />);
  return { onToast };
}

describe("T33-3（D8-2）：停權與停用的文案與 tooltip", () => {
  it("兩顆按鈕的文案分別明寫「所有地址；仍可收信」與「連收信都停止」", async () => {
    installFetch(routes({ visitors: { body: { users: [VISITOR] } } }));
    renderManager();

    const suspend = await screen.findByRole("button", { name: userStatusActionLabel(false) });
    const disable = screen.getByRole("button", { name: addressStatusActionLabel(false) });

    expect(suspend.textContent).toContain("所有地址");
    expect(suspend.textContent).toContain("仍可收信");
    expect(disable.textContent).toContain("連收信都停止");
  });

  it("tooltip（title）說明兩者差異：停權＝全部地址但來信保留；停用＝僅此地址且來信直接丟棄", async () => {
    installFetch(routes({ visitors: { body: { users: [VISITOR] } } }));
    renderManager();

    const suspend = await screen.findByRole("button", { name: userStatusActionLabel(false) });
    const disable = screen.getByRole("button", { name: addressStatusActionLabel(false) });

    expect(suspend.getAttribute("title")).toBe(userStatusTooltip(false));
    expect(disable.getAttribute("title")).toBe(addressStatusTooltip(false));
    expect(suspend.getAttribute("title")).toContain("來信仍會保留");
    expect(disable.getAttribute("title")).toContain("直接丟棄");
    // 兩者必須不同，否則等於沒有說明差異
    expect(suspend.getAttribute("title")).not.toBe(disable.getAttribute("title"));
  });

  it("停用地址前的二次確認逐字顯示「此地址將立即停止收信，停用期間的來信不會保留」", async () => {
    installFetch(routes({ visitors: { body: { users: [VISITOR] } } }));
    renderManager();

    fireEvent.click(await screen.findByRole("button", { name: addressStatusActionLabel(false) }));

    const dialog = screen.getByRole("dialog", { name: "停用／啟用地址" });
    expect(within(dialog).getByText(VISITOR.address!.email)).toBeTruthy();
    expect(within(dialog).getByText(new RegExp(ADDRESS_DISABLE_WARNING))).toBeTruthy();
    // 停權的警語不得出現在停用對話框（兩者後果不同，不可互相頂替）
    expect(within(dialog).queryByText(/來信仍會照常收到並保留/)).toBeNull();
  });

  it("停權前的二次確認明寫「來信仍會照常收到並保留」（與停用的關鍵差別）", async () => {
    installFetch(routes({ visitors: { body: { users: [VISITOR] } } }));
    renderManager();

    fireEvent.click(await screen.findByRole("button", { name: userStatusActionLabel(false) }));

    const dialog = screen.getByRole("dialog", { name: "停權／復權" });
    expect(within(dialog).getByText(new RegExp(VISITOR.username))).toBeTruthy();
    expect(within(dialog).getByText(/來信仍會照常收到並保留/)).toBeTruthy();
    expect(within(dialog).queryByText(new RegExp(ADDRESS_DISABLE_WARNING))).toBeNull();
  });
});

describe("T33-4（D9）：刪除訪客的二次確認", () => {
  it("對話框標題與警語明寫「無法復原」並導向「停權」", async () => {
    installFetch(routes({ visitors: { body: { users: [VISITOR] } } }));
    renderManager();

    fireEvent.click(await screen.findByRole("button", { name: "刪除" }));

    const dialog = screen.getByRole("dialog", { name: "刪除訪客（無法復原）" });
    // 逐字比對警語（對話框標題本身也含「無法復原」→ 不能用模糊查詢）
    const warn = within(dialog).getByText(`⚠️ ${USER_DELETE_WARNING}`);
    expect(warn.textContent).toContain("所有信件與附件");
    expect(warn.textContent).toContain("請改用『停權』");
    expect(warn.textContent).toContain("無法復原");
    // 講清楚會刪掉幾封信（只講數量，N9）
    expect(within(dialog).getByText(new RegExp(`將一併清除該訪客的 ${VISITOR.mail_count} 封信件`))).toBeTruthy();
    // 未按確定之前不得發出 DELETE
    expect(screen.queryByText(/已永久刪除/)).toBeNull();
  });

  it("確定永久刪除 → 只送一次 DELETE /api/users/:id，並提示已刪除", async () => {
    const spy = installFetch(routes({ visitors: { body: { users: [VISITOR] } } }));
    const { onToast } = renderManager();

    fireEvent.click(await screen.findByRole("button", { name: "刪除" }));
    const dialog = screen.getByRole("dialog", { name: "刪除訪客（無法復原）" });
    fireEvent.click(within(dialog).getByRole("button", { name: "確定永久刪除" }));

    await vi.waitFor(() => expect(onToast).toHaveBeenCalledWith("visitor1 已永久刪除"));
    const deletes = spy.calls.filter((c) => c.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.url).toBe("/api/users/7");
    // 成功後對話框關閉
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("T33-5：訪客清單載入失敗不影響整頁", () => {
  it("清單錯誤顯示在清單區塊內，頁面說明與標題仍在", async () => {
    installFetch(routes({ visitors: apiError(403, "FORBIDDEN", "owner only") }));
    renderManager();

    expect(await screen.findByText(/owner only/)).toBeTruthy();
    // 整頁不壞：標題、N9 說明、定位說明（D11-4）都還在
    expect(screen.getByRole("heading", { name: "訪客管理" })).toBeTruthy();
    expect(screen.getByText(VISITOR_MANAGER_HINT)).toBeTruthy();
    expect(screen.getByText(/管理者看不到訪客信件的主旨、寄件者或內文/)).toBeTruthy();
    // 清單壞掉時不得顯示任何訪客列（不殘留舊資料）
    expect(screen.queryByText(VISITOR.username)).toBeNull();
  });
});
