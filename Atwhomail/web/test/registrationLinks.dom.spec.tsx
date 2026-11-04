/**
 * D22（docs/22 §5）：可分享的註冊／邀請連結 —— T100–T104。
 *
 * T100 `?register=1` → 註冊分頁＋Email autofocus
 * T101 `?invite=ABC` → 註冊分頁＋邀請碼欄預填
 * T102 處理後 URL query 已清除（replaceState）
 * T103 `REGISTRATION_MODE=closed` ＋ `?register=1` → 暫停提示、不顯示表單
 * T104 管理端「複製邀請連結」→ clipboard 內容正確（mock clipboard）
 *
 * ⚠️ 這裡只驗證**顯示與預填**；權限／註冊模式仍由後端判定（N3）。
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InviteManager } from "../src/components/InviteManager";
import { LoginPage } from "../src/components/LoginPage";
import { installFetch, type FakeReply, type FetchCall } from "./dom-fetch";

const MODE_URL = "/api/auth/registration-mode";

function routes(mode: "invite" | "email_verify" | "closed") {
  return (call: FetchCall): FakeReply => {
    if (call.url === MODE_URL) return { body: { mode } };
    throw new Error(`未預期的請求：${call.method} ${call.url}`);
  };
}

function setLocation(path: string): void {
  window.history.replaceState(null, "", path);
}

function installClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

beforeEach(() => {
  setLocation("/");
});

describe("D22 T100–T103：LoginPage 註冊連結", () => {
  it("T100 `?register=1` → 自動進註冊分頁，Email 欄取得焦點", async () => {
    setLocation("/?register=1");
    installFetch(routes("email_verify"));
    render(<LoginPage notice={null} onLogin={vi.fn()} mode="public" />);

    const email = await screen.findByLabelText(/Email（收取驗證碼）/);
    expect(screen.getByRole("tab", { name: "註冊" }).getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(email));
  });

  it("T101 `?invite=ABC` → 自動進註冊分頁並預填邀請碼（invite 模式）", async () => {
    setLocation("/?invite=ABC");
    installFetch(routes("invite"));
    render(<LoginPage notice={null} onLogin={vi.fn()} mode="public" />);

    const inviteInput = (await screen.findByLabelText(/邀請碼/)) as HTMLInputElement;
    expect(inviteInput.value).toBe("ABC");
    expect(screen.getByRole("tab", { name: "註冊" }).getAttribute("aria-selected")).toBe("true");
  });

  it("T102 處理後以 replaceState 清除 register／invite query", async () => {
    setLocation("/?invite=ABC&register=1");
    installFetch(routes("invite"));
    render(<LoginPage notice={null} onLogin={vi.fn()} mode="public" />);

    await screen.findByLabelText(/邀請碼/);
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(window.location.pathname).toBe("/");
  });

  it("T103 closed 模式 ＋ `?register=1` → 顯示暫停提示，不顯示任何註冊表單", async () => {
    setLocation("/?register=1");
    installFetch(routes("closed"));
    render(<LoginPage notice={null} onLogin={vi.fn()} mode="public" />);

    expect(await screen.findByText("目前未開放註冊。")).toBeTruthy();
    expect(screen.getByText("站方目前暫停開放註冊。")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "註冊" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByLabelText(/Email（收取驗證碼）/)).toBeNull();
    expect(screen.queryByRole("button", { name: "寄送驗證碼" })).toBeNull();
    expect(screen.queryByLabelText(/邀請碼/)).toBeNull();
  });
});

describe("D22 T104：管理端邀請／一般註冊連結", () => {
  const INVITE = {
    id: 5,
    masked_code: "ABC1…",
    max_uses: 1,
    used_count: 0,
    expires_at: null as number | null,
    status: "active" as const,
    note: "給小明",
    created_at: 1_800_000_000_000,
  };

  function adminRoutes(mode: "invite" | "email_verify" = "email_verify") {
    return (call: FetchCall): FakeReply => {
      if (call.url === MODE_URL) return { body: { mode } };
      if (call.url === "/api/invites" && call.method === "GET") return { body: { invites: [INVITE] } };
      if (call.url === "/api/invites?reveal=1") return { body: { invites: [{ ...INVITE, code: "ABC123" }] } };
      if (call.url === "/api/invites" && call.method === "POST") {
        return { body: { id: 9, code: "NEWCODE", max_uses: 1, expires_at: null } };
      }
      throw new Error(`未預期的請求：${call.method} ${call.url}`);
    };
  }

  it("T104 列表「複製邀請連結」→ 剪貼簿為 `https://app.atwho.org/?invite=<code>`", async () => {
    const writeText = installClipboard();
    const onToast = vi.fn();
    installFetch(adminRoutes());
    render(<InviteManager onBack={vi.fn()} onToast={onToast} />);

    await screen.findByText("ABC1…");
    fireEvent.click(screen.getByRole("button", { name: "複製邀請連結" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("https://app.atwho.org/?invite=ABC123")
    );
    expect(onToast).toHaveBeenCalledWith("已複製連結");
  });

  it("email_verify 模式：顯示一般註冊連結卡片，一鍵複製正確 URL", async () => {
    const writeText = installClipboard();
    installFetch(adminRoutes("email_verify"));
    render(<InviteManager onBack={vi.fn()} onToast={vi.fn()} />);

    expect(await screen.findByText("一般註冊連結")).toBeTruthy();
    expect(screen.getByDisplayValue("https://app.atwho.org/?register=1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "複製連結" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("https://app.atwho.org/?register=1")
    );
  });

  it("invite 模式：不顯示一般註冊連結卡片", async () => {
    installClipboard();
    installFetch(adminRoutes("invite"));
    render(<InviteManager onBack={vi.fn()} onToast={vi.fn()} />);

    await screen.findByText("ABC1…");
    await waitFor(() => expect(screen.queryByText("一般註冊連結")).toBeNull());
  });

  it("建立新邀請碼後：對話框顯示邀請連結，一鍵複製", async () => {
    const writeText = installClipboard();
    const onToast = vi.fn();
    installFetch(adminRoutes());
    render(<InviteManager onBack={vi.fn()} onToast={onToast} />);

    await screen.findByText("ABC1…");
    fireEvent.click(screen.getByRole("button", { name: "建立" }));

    const dialog = await screen.findByRole("dialog", { name: "已建立邀請碼" });
    expect(within(dialog).getByDisplayValue("https://app.atwho.org/?invite=NEWCODE")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "複製邀請連結" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("https://app.atwho.org/?invite=NEWCODE")
    );
    expect(onToast).toHaveBeenCalledWith("已複製連結");
  });
});
