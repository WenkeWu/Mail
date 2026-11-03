/**
 * mailTrash.dom.spec.tsx — docs/19 §5 **D19-3**（UI 補做：清空垃圾桶 ＋ 單封操作）
 *
 * 對應測試：
 * - **T75** 垃圾桶檢視顯示「清空垃圾桶」；非垃圾桶不顯示
 * - **T76** 清空垃圾桶需二次確認；取消不呼叫 API；成功後顯示 `{count, r2_objects}` 並重載
 * - **T77** ReadingPane 單封「還原」→ 呼叫 restore、關閉 ReadingPane、回到 inbox
 * - **T78** ReadingPane 單封「永久刪除」→ 需確認；成功後關閉 ReadingPane 並更新清單
 *
 * ⚠️ 全程只 mock `fetch`（網路邊界，docs/16 D12）；`AppShell`、React 狀態、`ApiError`
 *    轉換與 DOM 事件都是真的。`window.confirm` 以 spy 控制（取消／確認）。
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MailDetail, MailListItem, Session } from "../src/api/types";
import { AppShell } from "../src/components/AppShell";
import { installFetch, type FetchCall, type FakeReply } from "./dom-fetch";

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

const INBOX_ITEMS = [item(201, "inbox", "Inbox mail")];
const TRASH_ITEMS = [item(101, "trash", "Trash one"), item(102, "trash", "Trash two")];

function detail(id = 101): MailDetail {
  return {
    id,
    from: "sender101@example.com",
    to: [{ address: "bob@atwho.org", name: "" }],
    cc: [],
    subject: "Trash one",
    text_preview: "preview",
    message_id: "<m101@example.com>",
    received_at: 1_780_000_000_101,
    // 非 null → 開信不會觸發 PATCH /read（避免測試多一次 counts 刷新）
    read_at: 1_780_000_000_102,
    folder: "trash",
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

interface ServerState {
  restored: boolean;
  purged: boolean;
  emptied: boolean;
}

/**
 * 有狀態的 fetch 假後端：還原／永久刪除／清空後，後續列表與 counts 會反映新狀態
 * （T77 要驗證「回 inbox」，不能只驗 API 呼叫）。
 */
function routes(state: ServerState) {
  const counts = () => ({
    folders: {
      inbox: { total: state.restored ? 2 : 1, unread: 0 },
      sent: { total: 0, unread: 0 },
      archive: { total: 0, unread: 0 },
      spam: { total: 0, unread: 0 },
      trash: { total: state.emptied || state.purged ? 0 : state.restored ? 1 : 2, unread: 0 },
    },
    addresses: null,
  });

  return (call: FetchCall): FakeReply => {
    const url = new URL(call.url, "http://localhost");

    if (url.pathname === "/api/me") {
      return { body: { role: "visitor", session: "mailbox", username: null, addresses: [] } };
    }
    if (url.pathname === "/api/mail/counts") return { body: counts() };

    if (url.pathname === "/api/mail/inbox") {
      const folder = url.searchParams.get("folder");
      if (folder === "trash") {
        const items = state.emptied
          ? []
          : state.purged
            ? TRASH_ITEMS.filter((i) => i.id !== 101)
            : TRASH_ITEMS;
        return { body: { items, nextCursor: null } };
      }
      return {
        body: {
          items: state.restored ? [...INBOX_ITEMS, { ...TRASH_ITEMS[0]!, folder: "inbox" as const }] : INBOX_ITEMS,
          nextCursor: null,
        },
      };
    }

    if (url.pathname === "/api/mail/101" && call.method === "GET") return { body: detail() };
    if (url.pathname === "/api/mail/101/text" && call.method === "GET") {
      return { body: { id: 101, text: "信件內文" } };
    }
    if (url.pathname === "/api/mail/101/restore" && call.method === "POST") {
      state.restored = true;
      return { body: { ok: true, id: 101, folder: "inbox" } };
    }
    if (url.pathname === "/api/mail/101" && call.method === "DELETE") {
      // D19-3：ReadingPane 的永久刪除必須帶 mode=hard（軟刪除不可出現在垃圾桶內）
      if (url.searchParams.get("mode") !== "hard") throw new Error("垃圾桶內不得呼叫軟刪除");
      state.purged = true;
      return { body: { ok: true, id: 101, messages: 1, attachments: 0, r2_objects: 2 } };
    }
    if (url.pathname === "/api/mail/trash/empty" && call.method === "POST") {
      state.emptied = true;
      return { body: { count: 2, r2_objects: 3 } };
    }

    throw new Error(`未預期的請求：${call.method} ${call.url}`);
  };
}

function renderShell() {
  const state: ServerState = { restored: false, purged: false, emptied: false };
  const spy = installFetch(routes(state));
  render(<AppShell session={SESSION} hostMode="all" onLogout={vi.fn()} />);
  return spy;
}

const nav = () => screen.getByRole("navigation", { name: "資料夾" });
const clickFolder = (name: RegExp) => fireEvent.click(within(nav()).getByRole("button", { name }));

/** ReadingPane 的按鈕名稱會與批次工具列重複（同一個開啟的信也被選取）→ 一律限定在 pane 內查詢 */
function readingPane() {
  const el = document.querySelector(".reading-pane");
  if (!el) throw new Error("ReadingPane 尚未渲染");
  return within(el as HTMLElement);
}

async function openTrashAndFirstMail() {
  await screen.findByText("Inbox mail");
  clickFolder(/^垃圾桶/);
  await screen.findByText("Trash one");
  fireEvent.click(screen.getAllByRole("option")[0]!);
  await waitFor(() => expect(readingPane().getByText("信件內文")).toBeTruthy());
}

const emptyTrashCalls = (spy: ReturnType<typeof installFetch>) =>
  spy.calls.filter((c) => c.method === "POST" && c.url === "/api/mail/trash/empty");

describe("T75：垃圾桶顯示「清空垃圾桶」；非垃圾桶不顯示", () => {
  it("收件匣沒有清空按鈕；切到垃圾桶才出現", async () => {
    renderShell();
    await screen.findByText("Inbox mail");
    expect(screen.queryByRole("button", { name: "清空垃圾桶" })).toBeNull();

    clickFolder(/^垃圾桶/);
    expect(await screen.findByRole("button", { name: "清空垃圾桶" })).toBeTruthy();

    clickFolder(/^收件匣/);
    await screen.findByText("Inbox mail");
    expect(screen.queryByRole("button", { name: "清空垃圾桶" })).toBeNull();
  });
});

describe("T76：清空垃圾桶需二次確認；取消不呼叫 API", () => {
  it("取消 → 不呼叫 POST；確認 → 顯示 {count, r2_objects} 並重載清單與計數", async () => {
    const spy = renderShell();
    await screen.findByText("Inbox mail");
    clickFolder(/^垃圾桶/);
    await screen.findByText("Trash one");

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "清空垃圾桶" }));

    // 二次確認文案：N 取自 counts.folders.trash.total（此假資料為 2）
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0]![0]).toBe("將永久刪除 2 封（含附件與原始檔），無法復原");
    expect(emptyTrashCalls(spy)).toHaveLength(0);
    expect(screen.getByText("Trash one")).toBeTruthy();

    // 確認 → 呼叫 API，摘要同時顯示 count 與 r2_objects
    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "清空垃圾桶" }));
    await waitFor(() => expect(emptyTrashCalls(spy)).toHaveLength(1));

    const toast = await screen.findByRole("status");
    expect(toast.textContent).toContain("2");
    expect(toast.textContent).toContain("3");

    // 重新載入清單（第二次 trash 列表請求）與資料夾計數（第二次 counts）
    await waitFor(() =>
      expect(spy.calls.filter((c) => c.url.startsWith("/api/mail/inbox?folder=trash")).length).toBeGreaterThanOrEqual(2)
    );
    await waitFor(() => expect(spy.calls.filter((c) => c.url === "/api/mail/counts").length).toBeGreaterThanOrEqual(2));
    await screen.findByText("這裡沒有信件");
  });
});

describe("T77：ReadingPane 單封「還原」", () => {
  it("呼叫 POST /api/mail/:id/restore、關閉 ReadingPane、更新清單與計數，信件回到 inbox", async () => {
    const spy = renderShell();
    await openTrashAndFirstMail();

    fireEvent.click(readingPane().getByRole("button", { name: "還原" }));

    await waitFor(() =>
      expect(spy.calls.some((c) => c.method === "POST" && c.url === "/api/mail/101/restore")).toBe(true)
    );
    // ReadingPane 關閉 + 該列從垃圾桶清單移除
    await screen.findByText("選擇一封信件開始閱讀");
    expect(screen.queryByText("Trash one")).toBeNull();
    // 左側計數同步重抓
    await waitFor(() => expect(spy.calls.filter((c) => c.url === "/api/mail/counts").length).toBeGreaterThanOrEqual(2));

    // 回到收件匣 → 信件確實出現在 inbox 清單（假後端的狀態已改變）
    clickFolder(/^收件匣/);
    expect(await screen.findByText("Trash one")).toBeTruthy();
  });
});

describe("T78：ReadingPane 單封「永久刪除」", () => {
  it("確認 → DELETE ?mode=hard、關閉 ReadingPane 並更新清單", async () => {
    const spy = renderShell();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    await openTrashAndFirstMail();

    fireEvent.click(readingPane().getByRole("button", { name: "永久刪除" }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0]![0]).toContain("含附件與原始檔");
    expect(confirmSpy.mock.calls[0]![0]).toContain("無法復原");

    await waitFor(() =>
      expect(spy.calls.some((c) => c.method === "DELETE" && c.url === "/api/mail/101?mode=hard")).toBe(true)
    );
    await screen.findByText("選擇一封信件開始閱讀");
    expect(screen.queryByText("Trash one")).toBeNull();
    await waitFor(() => expect(spy.calls.filter((c) => c.url === "/api/mail/counts").length).toBeGreaterThanOrEqual(2));
  });

  it("取消 → 不呼叫 DELETE，ReadingPane 與清單維持原狀", async () => {
    const spy = renderShell();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    await openTrashAndFirstMail();

    fireEvent.click(readingPane().getByRole("button", { name: "永久刪除" }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(spy.calls.some((c) => c.method === "DELETE" && c.url === "/api/mail/101?mode=hard")).toBe(false);
    // 畫面未被清空（ReadingPane 與清單都還在；主旨同時出現在兩處）
    expect(readingPane().getByText("信件內文")).toBeTruthy();
    expect(screen.getAllByText("Trash one").length).toBeGreaterThanOrEqual(1);
  });
});
