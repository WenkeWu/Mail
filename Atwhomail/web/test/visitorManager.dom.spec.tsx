/**
 * `VisitorManager` 的**渲染測試**（D12／T33；D8-2／D8-3、D9、D38）。
 *
 * D38 起管理頁預設是 Dashboard，不再自動列出全部訪客：
 * - 載入時只打 overview／attention（KPI 與注意事項）
 * - 必須輸入條件後按「搜尋」才會打 `/api/admin/visitors/search`
 * - 既有停權／停用／刪除／寄信設定的文案與二次確認維持不變
 *
 * ⚠️ 全程只 mock `fetch`（網路邊界），元件、狀態、`ApiError` 轉換、DOM 事件都是真的。
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VisitorManager } from "../src/components/VisitorManager";
import type { VisitorAttentionResponse, VisitorOverview, VisitorUser } from "../src/api/types";
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

const OVERVIEW: VisitorOverview = {
  totals: {
    total: 120,
    new_today: 3,
    new_7d: 17,
    active_7d: 42,
    suspended: 4,
    warming: 6,
    near_quota: 2,
    rejected_24h: 5,
  },
  by_country: [
    { key: "TW", count: 80 },
    { key: "UNKNOWN", count: 40 },
  ],
  by_language: [
    { key: "zh-TW", count: 90 },
    { key: "en", count: 30 },
  ],
  by_level: [
    { key: "T1", count: 70 },
    { key: "T0", count: 50 },
  ],
  trends: {
    registrations: [{ day: "2026-11-12", count: 3 }],
    sent: [{ day: "2026-11-12", count: 12 }],
  },
  sync: { configured: true, lastSyncedAt: Date.UTC(2026, 10, 13, 8, 0), lastError: null, cursor: "42", stale: false },
  filter_required: false,
};

const ATTENTION: VisitorAttentionResponse = {
  items: [
    {
      id: 9,
      username: "noisy",
      status: "active",
      created_at: Date.UTC(2026, 8, 10),
      last_seen_at: Date.UTC(2026, 10, 13, 7, 0),
      country_code: "TW",
      language: "zh-TW",
      address_id: 22,
      email: "noisy@atwho.org",
      address_status: "active",
      daily_send_quota: 50,
      sent_today: 48,
      level: "T0",
      level_status: "normal",
      quota_rejected_24h: 2,
      rate_rejected_24h: 0,
      login_failed_24h: 1,
      reasons: ["near_quota", "quota_rejected", "login_failed"],
      severity: "high",
    },
  ],
  sync: OVERVIEW.sync,
};

const VISITOR: VisitorUser = {
  id: 7,
  username: "visitor1",
  status: "active",
  created_at: Date.UTC(2026, 8, 10),
  country_code: "TW",
  language: "zh-TW",
  last_seen_at: Date.UTC(2026, 9, 13, 12, 0),
  level: "T1",
  level_status: "normal",
  address: {
    id: 21,
    email: "visitor1@atwho.org",
    status: "active",
    can_send: 1,
    daily_send_quota: 50,
    sent_today: 3,
    warmup_exempt: 0,
    warmup_quota: 20,
  },
  mail_count: 4,
  last_activity_at: Date.UTC(2026, 9, 13, 12, 0),
};

const SEARCH_PREFIX = "/api/admin/visitors/search";

function routes(opts: { search?: FakeReply; overview?: FakeReply } = {}) {
  return (call: FetchCall): FakeReply => {
    if (call.url === "/api/admin/visitors/overview") {
      return opts.overview ?? { body: OVERVIEW };
    }
    if (call.url === "/api/admin/visitors/attention?limit=10") {
      return { body: ATTENTION };
    }
    if (call.url.startsWith(SEARCH_PREFIX)) {
      return opts.search ?? { body: { users: [VISITOR], has_more: false, filter_required: false } };
    }
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

/** 填一個條件、按搜尋，等結果列出現。 */
async function searchVisitor(): Promise<void> {
  fireEvent.change(await screen.findByLabelText("ID 或 Email"), { target: { value: "visitor1" } });
  fireEvent.click(screen.getByRole("button", { name: "搜尋" }));
  await screen.findByRole("button", { name: userStatusActionLabel(false) });
}

describe("D38：Dashboard 與篩選式搜尋", () => {
  it("載入時只顯示 KPI／注意事項，不自動列出訪客", async () => {
    const spy = installFetch(routes());
    renderManager();

    expect(await screen.findByText("訪客總數")).toBeTruthy();
    expect(screen.getByText("120")).toBeTruthy();
    expect(screen.getByText("noisy")).toBeTruthy();
    expect(screen.getByText("接近每日配額")).toBeTruthy();
    expect(screen.getByText("設定條件後按「搜尋」；不會自動列出全部訪客。")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "訪客管理" })).toBeTruthy();
    expect(screen.getByText(VISITOR_MANAGER_HINT)).toBeTruthy();
    expect(screen.getByText(/管理者看不到訪客信件的主旨、寄件者或內文/)).toBeTruthy();

    expect(spy.countOf("/api/admin/visitors/overview")).toBe(1);
    expect(spy.countOf("/api/admin/visitors/attention?limit=10")).toBe(1);
    expect(spy.calls.some((call) => call.url.startsWith(SEARCH_PREFIX))).toBe(false);
    expect(spy.calls.some((call) => call.url === "/api/users?role=visitor")).toBe(false);
  });

  it("沒有條件就按搜尋 → 顯示提示，不送出請求", async () => {
    const spy = installFetch(routes());
    renderManager();

    fireEvent.click(screen.getByRole("button", { name: "搜尋" }));
    expect(await screen.findByText("請至少輸入一個搜尋或篩選條件。")).toBeTruthy();
    expect(spy.calls.some((call) => call.url.startsWith(SEARCH_PREFIX))).toBe(false);
  });

  it("有條件才搜尋；結果顯示國家／語系與唯讀等級", async () => {
    const spy = installFetch(routes());
    renderManager();
    await searchVisitor();

    const search = spy.calls.find((call) => call.url.startsWith(SEARCH_PREFIX));
    expect(search?.url).toContain("q=visitor1");
    expect(search?.url).toContain("limit=25");
    expect(screen.getByText("visitor1@atwho.org")).toBeTruthy();
    const table = screen.getByRole("table");
    expect(within(table).getByText("T1")).toBeTruthy();
    expect(within(table).getByText("TW")).toBeTruthy();
    expect(within(table).getByText(/zh-TW/)).toBeTruthy();
  });
});

describe("T33-3（D8-2）：停權與停用的文案與 tooltip", () => {
  it("兩顆按鈕的文案分別明寫「所有地址；仍可收信」與「連收信都停止」", async () => {
    installFetch(routes());
    renderManager();
    await searchVisitor();

    const suspend = screen.getByRole("button", { name: userStatusActionLabel(false) });
    const disable = screen.getByRole("button", { name: addressStatusActionLabel(false) });

    expect(suspend.textContent).toContain("所有地址");
    expect(suspend.textContent).toContain("仍可收信");
    expect(disable.textContent).toContain("連收信都停止");
  });

  it("tooltip（title）說明兩者差異：停權＝全部地址但來信保留；停用＝僅此地址且來信直接丟棄", async () => {
    installFetch(routes());
    renderManager();
    await searchVisitor();

    const suspend = screen.getByRole("button", { name: userStatusActionLabel(false) });
    const disable = screen.getByRole("button", { name: addressStatusActionLabel(false) });

    expect(suspend.getAttribute("title")).toBe(userStatusTooltip(false));
    expect(disable.getAttribute("title")).toBe(addressStatusTooltip(false));
    expect(suspend.getAttribute("title")).toContain("來信仍會保留");
    expect(disable.getAttribute("title")).toContain("直接丟棄");
    expect(suspend.getAttribute("title")).not.toBe(disable.getAttribute("title"));
  });

  it("停用地址前的二次確認逐字顯示「此地址將立即停止收信，停用期間的來信不會保留」", async () => {
    installFetch(routes());
    renderManager();
    await searchVisitor();

    fireEvent.click(screen.getByRole("button", { name: addressStatusActionLabel(false) }));

    const dialog = screen.getByRole("dialog", { name: "停用／啟用地址" });
    expect(dialog.textContent).toContain(VISITOR.address!.email);
    expect(within(dialog).getByText(new RegExp(ADDRESS_DISABLE_WARNING))).toBeTruthy();
    expect(within(dialog).queryByText(/來信仍會照常收到並保留/)).toBeNull();
  });

  it("停權前的二次確認明寫「來信仍會照常收到並保留」（與停用的關鍵差別）", async () => {
    installFetch(routes());
    renderManager();
    await searchVisitor();

    fireEvent.click(screen.getByRole("button", { name: userStatusActionLabel(false) }));

    const dialog = screen.getByRole("dialog", { name: "停權／復權" });
    expect(within(dialog).getByText(new RegExp(VISITOR.username))).toBeTruthy();
    expect(within(dialog).getByText(/來信仍會照常收到並保留/)).toBeTruthy();
    expect(within(dialog).queryByText(new RegExp(ADDRESS_DISABLE_WARNING))).toBeNull();
  });
});

describe("T33-4（D9）：刪除訪客的二次確認", () => {
  it("對話框標題與警語明寫「無法復原」並導向「停權」", async () => {
    installFetch(routes());
    renderManager();
    await searchVisitor();

    fireEvent.click(screen.getByRole("button", { name: "刪除" }));

    const dialog = screen.getByRole("dialog", { name: "刪除訪客（無法復原）" });
    const warn = within(dialog).getByText(`⚠️ ${USER_DELETE_WARNING}`);
    expect(warn.textContent).toContain("所有信件與附件");
    expect(warn.textContent).toContain("請改用『停權』");
    expect(warn.textContent).toContain("無法復原");
    expect(within(dialog).getByText(new RegExp(`將一併清除該訪客的 ${VISITOR.mail_count} 封信件`))).toBeTruthy();
    expect(screen.queryByText(/已永久刪除/)).toBeNull();
  });

  it("確定永久刪除 → 只送一次 DELETE /api/users/:id，並提示已刪除", async () => {
    const spy = installFetch(routes());
    const { onToast } = renderManager();
    await searchVisitor();

    fireEvent.click(screen.getByRole("button", { name: "刪除" }));
    const dialog = screen.getByRole("dialog", { name: "刪除訪客（無法復原）" });
    fireEvent.click(within(dialog).getByRole("button", { name: "確定永久刪除" }));

    await vi.waitFor(() => expect(onToast).toHaveBeenCalledWith("visitor1 已永久刪除"));
    const deletes = spy.calls.filter((c) => c.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.url).toBe("/api/users/7");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("T33-5：載入失敗不影響整頁", () => {
  it("搜尋錯誤顯示在結果區塊內，頁面說明與標題仍在", async () => {
    installFetch(routes({ search: apiError(403, "FORBIDDEN", "owner only") }));
    renderManager();
    await screen.findByText("訪客總數");

    fireEvent.change(screen.getByLabelText("ID 或 Email"), { target: { value: "visitor1" } });
    fireEvent.click(screen.getByRole("button", { name: "搜尋" }));

    expect(await screen.findByText(/owner only/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "訪客管理" })).toBeTruthy();
    expect(screen.getByText(VISITOR_MANAGER_HINT)).toBeTruthy();
    expect(screen.getByText(/管理者看不到訪客信件的主旨、寄件者或內文/)).toBeTruthy();
    expect(screen.queryByText(VISITOR.username)).toBeNull();
  });

  it("統計載入失敗只在 KPI 區顯示錯誤；搜尋表單仍可用", async () => {
    installFetch(routes({ overview: apiError(403, "FORBIDDEN", "stats denied") }));
    renderManager();

    expect(await screen.findByText(/stats denied/)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "訪客管理" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "搜尋" })).toBeTruthy();
  });
});

describe("D35：暖機期上限可調", () => {
  it("寄信設定預設顯示 20，儲存時一并送出 warmup_quota", async () => {
    const spy = installFetch((call) => {
      if (call.url.startsWith(SEARCH_PREFIX)) return { body: { users: [VISITOR], has_more: false, filter_required: false } };
      if (call.url === "/api/admin/visitors/overview") return { body: OVERVIEW };
      if (call.url === "/api/admin/visitors/attention?limit=10") return { body: ATTENTION };
      if (call.url === `/api/users/${VISITOR.id}/quota` && call.method === "PATCH") {
        return {
          body: {
            ok: true,
            user_id: VISITOR.id,
            daily_send_quota: 40,
            warmup_quota: 8,
            can_send: 1,
          },
        };
      }
      if (call.url.startsWith("/api/admin/visitors/search")) {
        return { body: { users: [VISITOR], has_more: false, filter_required: false } };
      }
      throw new Error(`未預期的請求：${call.method} ${call.url}`);
    });
    renderManager();
    await searchVisitor();

    fireEvent.click(screen.getByRole("button", { name: "寄信設定" }));
    const dialog = screen.getByRole("dialog", { name: `${VISITOR.username} 的寄信設定` });
    const daily = within(dialog).getByLabelText("每日寄信配額（1–50）") as HTMLInputElement;
    const warmup = within(dialog).getByLabelText("暖機期上限（1–50，預設 20）") as HTMLInputElement;
    expect(daily.value).toBe("50");
    expect(warmup.value).toBe("20");

    fireEvent.change(daily, { target: { value: "40" } });
    fireEvent.change(warmup, { target: { value: "8" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "套用" }));

    await waitFor(() => {
      const patch = spy.calls.find((c) => c.method === "PATCH");
      expect(patch?.body).toMatchObject({ daily_send_quota: 40, warmup_quota: 8 });
    });
  });
});
