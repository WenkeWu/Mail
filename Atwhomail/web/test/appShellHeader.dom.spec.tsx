/**
 * appShellHeader.dom.spec.tsx — 頂部列與手機側欄鈕（owner 2026-11-06 回饋）
 *
 * - 頂部列**不再重複**「撰寫」按鈕；撰寫只在側欄。
 * - `.sidebar-toggle` 在信箱頁＝切換側欄；在子頁面（個人設置等，沒有側欄）＝回到信箱。
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Session } from "../src/api/types";
import { AppShell } from "../src/components/AppShell";
import { installFetch, type FetchCall, type FakeReply } from "./dom-fetch";

const SESSION: Session = { kind: "mailbox", token: "t", addressId: 1, email: "alice@atwho.org" };

const COUNTS = {
  folders: {
    inbox: { total: 0, unread: 0 },
    sent: { total: 0, unread: 0 },
    archive: { total: 0, unread: 0 },
    trash: { total: 0, unread: 0 },
    spam: { total: 0, unread: 0 },
  },
  addresses: null,
};

function routes(call: FetchCall): FakeReply {
  const url = new URL(call.url, "http://localhost");
  if (url.pathname === "/api/me") {
    return { body: { role: "visitor", session: "mailbox", username: null, addresses: [] } };
  }
  if (url.pathname === "/api/mail/counts") return { body: COUNTS };
  if (url.pathname === "/api/mail/inbox") return { body: { items: [], nextCursor: null } };
  if (url.pathname === "/api/email-aliases") return { body: { aliases: [] } };
  if (url.pathname === "/api/email-addresses") return { body: { addresses: [] } };
  if (url.pathname === "/api/account/settings") {
    return {
      body: {
        user_id: 1,
        username: "alice",
        role: "visitor",
        provider: "local",
        contact_email: null,
        has_password: 1,
        addresses: [
          { id: 1, email: "alice@atwho.org", status: "active", daily_send_quota: 20, sent_today: 0 },
        ],
      },
    };
  }
  throw new Error(`未預期的請求：${call.method} ${call.url}`);
}

describe("頂部列與側欄鈕", () => {
  it("頂部沒有撰寫按鈕；子頁面的側欄鈕回到信箱，信箱頁才切換側欄", async () => {
    installFetch(routes);
    const { container } = render(<AppShell session={SESSION} hostMode="public" onLogout={() => {}} />);

    const header = container.querySelector(".app-header") as HTMLElement;
    expect(header).toBeTruthy();
    // 頂部列不重複提供撰寫；側欄仍保留一個
    expect(within(header).queryByRole("button", { name: /撰寫/ })).toBeNull();
    expect(screen.getAllByRole("button", { name: /撰寫/ }).length).toBeGreaterThan(0);

    // 進入個人設置（子頁面沒有側欄）——點頂部頭像選單那一項
    fireEvent.click(within(header).getByRole("button", { name: /個人設置/ }));
    expect(await screen.findByRole("heading", { name: "個人設置" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "回到信箱" })).toBeTruthy();

    // 點側欄鈕 → 回到信箱（不是切換不存在的側欄）
    fireEvent.click(screen.getByRole("button", { name: "回到信箱" }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "個人設置" })).toBeNull());
    expect(screen.getAllByText("收件匣").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "切換側欄" })).toBeTruthy();
  });
});
