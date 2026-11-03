/**
 * mailCheckbox.dom.spec.tsx — docs/19 §6 **D19-4**（每封信列 checkbox）
 *
 * 對應測試：
 * - **T79** 每列都有 checkbox；點擊切換選取且**不開啟信件**（不呼叫 GET /api/mail/:id）
 * - **T80** Shift＋點 checkbox → 範圍連選（錨點＝最近一次點擊）
 * - **T81** 表頭全選 → 全部勾選；再點 → 全部取消
 * - **T82** 部分選取時表頭 checkbox 為 indeterminate
 * - **T83** 切換資料夾後選取清空、checkbox 全部未勾
 *
 * ⚠️ 只 mock `fetch`（網路邊界，docs/16 D12）；`AppShell`、React 狀態與 DOM 事件都是真的。
 * 「不開信」同時以**畫面**（ReadingPane 空狀態）與**請求紀錄**（沒有 GET /api/mail/:id）驗證。
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MailDetail, MailListItem, Session } from "../src/api/types";
import { AppShell } from "../src/components/AppShell";
import { installFetch, type FetchCall, type FakeReply, type FetchSpy } from "./dom-fetch";

const SESSION: Session = { kind: "mailbox", token: "test-token", addressId: 1, email: "bob@atwho.org" };

function item(id: number, folder: "inbox" | "trash", subject: string): MailListItem {
  return {
    id,
    from: `sender${id}@example.com`,
    subject,
    text_preview: `preview ${id}`,
    received_at: 1_780_000_000_000 + id,
    read: true,
    has_attachments: false,
    folder,
    origin: "external",
    kind: "normal",
    delivery_scope: "external",
  };
}

const INBOX_ITEMS = [
  item(301, "inbox", "Inbox one"),
  item(302, "inbox", "Inbox two"),
  item(303, "inbox", "Inbox three"),
  item(304, "inbox", "Inbox four"),
];
const TRASH_ITEMS = [item(401, "trash", "Trash one"), item(402, "trash", "Trash two")];

function detail(id: number): MailDetail {
  return {
    id,
    from: `sender${id}@example.com`,
    to: [{ address: "bob@atwho.org", name: "" }],
    cc: [],
    subject: `subject ${id}`,
    text_preview: "preview",
    message_id: `<m${id}@example.com>`,
    received_at: 1_780_000_000_000 + id,
    read_at: 1_780_000_000_500,
    folder: "inbox",
    html_url: null,
    attachments: [],
    origin: "external",
    kind: "normal",
    delivery_scope: "external",
    form_instance_id: null,
    suspicious_form_claim: false,
    sender_spf: null,
    sender_dkim: null,
    sender_dmarc: null,
  };
}

const COUNTS = {
  folders: {
    inbox: { total: INBOX_ITEMS.length, unread: 0 },
    sent: { total: 0, unread: 0 },
    archive: { total: 0, unread: 0 },
    spam: { total: 0, unread: 0 },
    trash: { total: TRASH_ITEMS.length, unread: 0 },
  },
  addresses: null,
};

function routes(call: FetchCall): FakeReply {
  const url = new URL(call.url, "http://localhost");

  if (url.pathname === "/api/me") {
    return { body: { role: "visitor", session: "mailbox", username: null, addresses: [] } };
  }
  if (url.pathname === "/api/mail/counts") return { body: COUNTS };
  if (url.pathname === "/api/mail/inbox") {
    const folder = url.searchParams.get("folder");
    return { body: { items: folder === "trash" ? TRASH_ITEMS : INBOX_ITEMS, nextCursor: null } };
  }

  // 若 checkbox 真的觸發開信，這裡會回得出內容 → 測試以 `spy.calls` 明確斷言「沒發生」
  const single = /^\/api\/mail\/(\d+)$/.exec(url.pathname);
  if (single && call.method === "GET") return { body: detail(Number(single[1])) };
  const text = /^\/api\/mail\/(\d+)\/text$/.exec(url.pathname);
  if (text) return { body: { id: Number(text[1]), text: "信件內文" } };

  throw new Error(`未預期的請求：${call.method} ${call.url}`);
}

function renderShell(): FetchSpy {
  const spy = installFetch(routes);
  render(<AppShell session={SESSION} hostMode="all" onLogout={vi.fn()} />);
  return spy;
}

/** 表頭的全選 checkbox（在 listbox 之外，避免與列 checkbox 混淆） */
const headerCheckbox = () => screen.getByRole("checkbox", { name: "全選信件" }) as HTMLInputElement;

/** 目前清單中每一列的 checkbox（依畫面順序） */
const rowCheckboxes = () =>
  within(screen.getByRole("listbox")).getAllByRole("checkbox") as HTMLInputElement[];

const checkedFlags = () => rowCheckboxes().map((box) => box.checked);

/** 開啟信件會打 GET /api/mail/:id（不含 /counts、/inbox 等固定路徑） */
const singleMailRequests = (spy: FetchSpy) =>
  spy.calls.filter((call) => {
    const path = new URL(call.url, "http://localhost").pathname;
    return call.method === "GET" && /^\/api\/mail\/\d+$/.test(path);
  });

const clickFolder = (name: RegExp) =>
  fireEvent.click(within(screen.getByRole("navigation", { name: "資料夾" })).getByRole("button", { name }));

describe("T79：每列 checkbox；點擊只切換選取、不開信", () => {
  it("每列都有 checkbox，aria-label 含主旨", async () => {
    renderShell();
    await screen.findByText("Inbox one");

    const boxes = rowCheckboxes();
    expect(boxes).toHaveLength(INBOX_ITEMS.length);
    expect(boxes[0]!.getAttribute("aria-label")).toBe("選取信件：Inbox one");
    expect(boxes[3]!.getAttribute("aria-label")).toBe("選取信件：Inbox four");
  });

  it("點擊 checkbox → 勾選＋工具列「已選 1 封」，且不開信、不呼叫 /api/mail/:id", async () => {
    const spy = renderShell();
    await screen.findByText("Inbox one");

    fireEvent.click(rowCheckboxes()[0]!);

    expect(rowCheckboxes()[0]!.checked).toBe(true);
    expect(screen.getByText("已選 1 封")).toBeTruthy();
    // 已選列的視覺掛在整列（背景高亮＋左側色條）
    expect(rowCheckboxes()[0]!.closest("li")!.classList.contains("selected")).toBe(true);

    // ⚠️ 絕對不可開信：ReadingPane 維持空狀態，且沒有 GET /api/mail/:id
    expect(screen.getByText("選擇一封信件開始閱讀")).toBeTruthy();
    expect(singleMailRequests(spy)).toHaveLength(0);
  });

  it("再點一次 → 取消選取、工具列消失", async () => {
    renderShell();
    await screen.findByText("Inbox one");

    fireEvent.click(rowCheckboxes()[1]!);
    expect(screen.getByText("已選 1 封")).toBeTruthy();

    fireEvent.click(rowCheckboxes()[1]!);
    expect(rowCheckboxes()[1]!.checked).toBe(false);
    expect(screen.queryByText(/已選 \d+ 封/)).toBeNull();
  });
});

describe("T80：Shift＋點 checkbox → 範圍連選", () => {
  it("先點第 1 列，再 Shift+點第 3 列 → 連選 1–3", async () => {
    const spy = renderShell();
    await screen.findByText("Inbox one");

    fireEvent.click(rowCheckboxes()[0]!);
    fireEvent.click(rowCheckboxes()[2]!, { shiftKey: true });

    expect(checkedFlags()).toEqual([true, true, true, false]);
    expect(screen.getByText("已選 3 封")).toBeTruthy();
    // Shift 範圍連選同樣不開信
    expect(singleMailRequests(spy)).toHaveLength(0);
  });

  it("反向連選（錨點在下方）", async () => {
    renderShell();
    await screen.findByText("Inbox one");

    fireEvent.click(rowCheckboxes()[3]!);
    fireEvent.click(rowCheckboxes()[1]!, { shiftKey: true });

    expect(checkedFlags()).toEqual([false, true, true, true]);
    expect(screen.getByText("已選 3 封")).toBeTruthy();
  });
});

describe("T81：表頭全選 → 全部勾選；再點 → 全部取消", () => {
  it("全選／取消全選只作用於目前載入的清單", async () => {
    renderShell();
    await screen.findByText("Inbox one");

    const all = headerCheckbox();
    expect(all.checked).toBe(false);

    fireEvent.click(all);
    expect(checkedFlags()).toEqual([true, true, true, true]);
    expect(headerCheckbox().checked).toBe(true);
    expect(headerCheckbox().indeterminate).toBe(false);
    expect(screen.getByText("已選 4 封")).toBeTruthy();

    fireEvent.click(headerCheckbox());
    expect(checkedFlags()).toEqual([false, false, false, false]);
    expect(headerCheckbox().checked).toBe(false);
    expect(headerCheckbox().indeterminate).toBe(false);
    expect(screen.queryByText(/已選 \d+ 封/)).toBeNull();
  });
});

describe("T82：部分選取時表頭 checkbox 為 indeterminate", () => {
  it("勾選部分列 → checked=false、indeterminate=true", async () => {
    renderShell();
    await screen.findByText("Inbox one");

    fireEvent.click(rowCheckboxes()[1]!);
    expect(headerCheckbox().checked).toBe(false);
    expect(headerCheckbox().indeterminate).toBe(true);

    fireEvent.click(rowCheckboxes()[3]!);
    expect(headerCheckbox().checked).toBe(false);
    expect(headerCheckbox().indeterminate).toBe(true);

    // 全部選取後不再是半選
    fireEvent.click(headerCheckbox());
    expect(headerCheckbox().checked).toBe(true);
    expect(headerCheckbox().indeterminate).toBe(false);
  });
});

describe("T83：切換資料夾後選取清空、checkbox 全部未勾", () => {
  it("在收件匣選取 → 切到垃圾桶 → 選取與勾選狀態皆歸零", async () => {
    renderShell();
    await screen.findByText("Inbox one");

    fireEvent.click(rowCheckboxes()[0]!);
    fireEvent.click(rowCheckboxes()[1]!);
    expect(screen.getByText("已選 2 封")).toBeTruthy();

    clickFolder(/^垃圾桶/);
    await screen.findByText("Trash one");

    expect(rowCheckboxes()).toHaveLength(TRASH_ITEMS.length);
    expect(checkedFlags()).toEqual([false, false]);
    expect(headerCheckbox().checked).toBe(false);
    expect(headerCheckbox().indeterminate).toBe(false);
    expect(screen.queryByText(/已選 \d+ 封/)).toBeNull();
  });
});
