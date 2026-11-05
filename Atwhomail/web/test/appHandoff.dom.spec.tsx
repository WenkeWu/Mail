/**
 * D26：`App` 的 `?app=`／`?redirect_uri=` 登入轉交（docs/27 §5）。
 *
 * 已登入（sessionStorage）→ 自動呼叫 app-login → 成功只導向**後端回傳**的 redirect；
 * 失敗（例如 redirect_uri 不在白名單）→ 顯示錯誤且不導向。
 */
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { apiError, installFetch } from "./dom-fetch";

const SESSION_KEY = "atwhomail.session.v1";
const OWNER_SESSION = {
  kind: "owner",
  token: "owner-token",
  userId: 1,
  username: "owner",
};

function setSession(): void {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(OWNER_SESSION));
}

afterEach(() => {
  sessionStorage.clear();
  window.history.replaceState({}, "", "/");
});

describe("D26：App 登入轉交", () => {
  it("已登入且參數有效 → 呼叫 app-login，並導向後端回傳的 redirect", async () => {
    setSession();
    window.history.replaceState(
      {},
      "",
      "/?app=mycrm&redirect_uri=" + encodeURIComponent("https://crm.example.com/cb")
    );
    const spy = installFetch((call) => {
      if (call.url === "/api/auth/app-login") {
        return { body: { redirect: "https://crm.example.com/cb?code=abc123" } };
      }
      throw new Error(`未預期的請求：${call.method} ${call.url}`);
    });
    const navigate = vi.fn();

    render(<App navigate={navigate} />);

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("https://crm.example.com/cb?code=abc123")
    );
    const call = spy.calls.find((c) => c.url === "/api/auth/app-login")!;
    expect(call.method).toBe("POST");
    expect(call.body).toEqual({ app: "mycrm", redirect_uri: "https://crm.example.com/cb" });
    expect(screen.getByText(/正在返回/)).toBeTruthy();
  });

  it("app-login 失敗 → 顯示錯誤、不導向", async () => {
    setSession();
    window.history.replaceState(
      {},
      "",
      "/?app=mycrm&redirect_uri=" + encodeURIComponent("https://crm.example.com/cb")
    );
    installFetch((call) => {
      if (call.url === "/api/auth/app-login") {
        return apiError(400, "INVALID_REDIRECT_URI", "redirect_uri 不在白名單內");
      }
      throw new Error(`未預期的請求：${call.method} ${call.url}`);
    });
    const navigate = vi.fn();

    render(<App navigate={navigate} />);

    expect(await screen.findByText(/redirect_uri 不在白名單內/)).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("參數不完整 → 顯示錯誤、不呼叫 app-login、不導向", async () => {
    setSession();
    window.history.replaceState({}, "", "/?app=mycrm");
    installFetch((call) => {
      throw new Error(`未預期的請求：${call.method} ${call.url}`);
    });
    const navigate = vi.fn();

    render(<App navigate={navigate} />);

    expect(await screen.findByText(/登入參數不完整/)).toBeTruthy();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("失敗後可「以 AtWhoMail 繼續」回到一般介面（不再導向）", async () => {
    setSession();
    window.history.replaceState(
      {},
      "",
      "/?app=mycrm&redirect_uri=" + encodeURIComponent("https://crm.example.com/cb")
    );
    installFetch((call) => {
      if (call.url === "/api/auth/app-login") {
        return apiError(400, "UNKNOWN_APP", "未知或已停用的 App");
      }
      // 按下「以 AtWhoMail 繼續」後 AppShell 會載入信件／地址等資料
      if (call.url === "/api/me") {
        return { body: { role: "owner", session: "owner", username: "owner", addresses: [] } };
      }
      if (call.url === "/api/email-addresses") return { body: { addresses: [] } };
      if (call.url === "/api/email-aliases") return { body: { aliases: [] } };
      if (call.url.startsWith("/api/mail/inbox")) return { body: { items: [], nextCursor: null } };
      if (call.url.startsWith("/api/mail/counts")) {
        return {
          body: {
            folders: {
              inbox: { total: 0, unread: 0 },
              sent: { total: 0, unread: 0 },
              archive: { total: 0, unread: 0 },
              trash: { total: 0, unread: 0 },
              spam: { total: 0, unread: 0 },
            },
            addresses: null,
          },
        };
      }
      return { body: {} };
    });
    const navigate = vi.fn();

    render(<App navigate={navigate} />);
    expect(await screen.findByText(/未知或已停用的 App/)).toBeTruthy();

    // 直接呼叫取消按鈕（不需要驗證 AppShell 的完整載入）
    screen.getByRole("button", { name: "以 AtWhoMail 繼續" }).click();
    await waitFor(() => expect(screen.queryByText(/未知或已停用的 App/)).toBeNull());
    expect(navigate).not.toHaveBeenCalled();
  });
});
