/**
 * D27 DOM 測試（docs/28 §6）：Google 登入按鈕、忘記密碼、NO_PASSWORD_SET 引導、
 * `?reset=` 設定新密碼頁。
 *
 * 只 mock fetch（網路邊界）；React 狀態與事件都是真的。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LoginPage } from "../src/components/LoginPage";
import { ResetPasswordPage } from "../src/components/ResetPasswordPage";
import { installFetch, type FetchCall, type FakeReply } from "./dom-fetch";

function baseRoutes(extra: (call: FetchCall) => FakeReply | null) {
  return (call: FetchCall): FakeReply => {
    if (call.url === "/api/auth/registration-mode") return { body: { mode: "invite", turnstileSiteKey: null } };
    const reply = extra(call);
    if (reply) return reply;
    throw new Error(`未預期的請求：${call.method} ${call.url}`);
  };
}

describe("D27：LoginPage", () => {
  it("顯示「使用 Google 登入」按鈕", async () => {
    installFetch(baseRoutes(() => null));
    render(<LoginPage notice={null} onLogin={vi.fn()} mode="public" />);
    expect(await screen.findByRole("button", { name: "使用 Google 登入" })).toBeTruthy();
  });

  it("忘記密碼：輸入 Email → 呼叫 forgot-password → 顯示不洩漏提示", async () => {
    const spy = installFetch(
      baseRoutes((call) => {
        if (call.url === "/api/auth/forgot-password") return { body: { sent: true } };
        return null;
      })
    );
    render(<LoginPage notice={null} onLogin={vi.fn()} mode="public" />);

    fireEvent.click(await screen.findByRole("button", { name: "忘記密碼？" }));
    fireEvent.change(screen.getByLabelText("Email 或使用者名稱"), { target: { value: "itag@gmail.com" } });
    fireEvent.click(screen.getByRole("button", { name: "寄送重設信" }));

    await waitFor(() => expect(spy.countOf("/api/auth/forgot-password")).toBe(1));
    const call = spy.calls.find((c) => c.url === "/api/auth/forgot-password")!;
    expect(call.body).toEqual({ email: "itag@gmail.com" });
    expect(await screen.findByText("若帳號存在，已寄出重設信（30 分鐘內有效）。")).toBeTruthy();
  });

  it("NO_PASSWORD_SET → 顯示 Google 登入與忘記密碼引導", async () => {
    installFetch(
      baseRoutes((call) => {
        if (call.url === "/api/auth/user-login") {
          return {
            status: 400,
            body: {
              error: {
                code: "NO_PASSWORD_SET",
                message: "此帳號尚未設定密碼，請用 Google 登入，或使用『忘記密碼』設定",
              },
            },
          };
        }
        return null;
      })
    );
    render(<LoginPage notice={null} onLogin={vi.fn()} mode="public" />);

    fireEvent.change(await screen.findByLabelText("電子郵件地址或使用者名稱"), { target: { value: "itag" } });
    fireEvent.change(screen.getByLabelText("密碼"), { target: { value: "whatever-01" } });
    fireEvent.click(screen.getByRole("button", { name: "登入" }));

    expect(await screen.findByText("此帳號尚未設定密碼：請用 Google 登入，或使用「忘記密碼」設定。")).toBeTruthy();
    expect(screen.getByRole("button", { name: "使用忘記密碼設定" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "使用 Google 登入" }).length).toBeGreaterThan(0);
  });

  it("username／contact_email 走 user-login；@atwho.org 地址仍走 mailbox-login（零回歸）", async () => {
    const spy = installFetch(
      baseRoutes((call) => {
        if (call.url === "/api/auth/user-login") {
          return { body: { token: "t1", session: "owner", user: { id: 9, username: "itag" } } };
        }
        if (call.url === "/api/auth/mailbox-login") {
          return { body: { token: "t2", session: "mailbox", address: { id: 4, email: "friend01@atwho.org" } } };
        }
        return null;
      })
    );
    const onLogin = vi.fn();
    render(<LoginPage notice={null} onLogin={onLogin} mode="public" />);

    const identifier = await screen.findByLabelText("電子郵件地址或使用者名稱");
    const password = screen.getByLabelText("密碼");
    fireEvent.change(identifier, { target: { value: "itag" } });
    fireEvent.change(password, { target: { value: "pw-123456" } });
    fireEvent.click(screen.getByRole("button", { name: "登入" }));

    await waitFor(() =>
      expect(onLogin).toHaveBeenCalledWith({ kind: "owner", token: "t1", userId: 9, username: "itag" })
    );
    expect(spy.countOf("/api/auth/user-login")).toBe(1);
    expect(spy.countOf("/api/auth/mailbox-login")).toBe(0);
  });
});

describe("D27：ResetPasswordPage", () => {
  it("成功 → 呼叫 reset-password 並回報完成", async () => {
    const spy = installFetch((call) => {
      if (call.url === "/api/auth/reset-password") return { body: { ok: true } };
      throw new Error(`未預期的請求：${call.method} ${call.url}`);
    });
    const onDone = vi.fn();
    render(<ResetPasswordPage token="tok-123" onDone={onDone} />);

    fireEvent.change(screen.getByLabelText("新密碼"), { target: { value: "new-password-01" } });
    fireEvent.change(screen.getByLabelText("確認新密碼"), { target: { value: "new-password-01" } });
    fireEvent.click(screen.getByRole("button", { name: "設定新密碼" }));

    await waitFor(() => expect(onDone).toHaveBeenCalledWith("密碼已重設，請用新密碼登入。"));
    expect(spy.calls[0]!.body).toEqual({ token: "tok-123", new_password: "new-password-01" });
  });

  it("兩次密碼不一致 → 不送出請求", () => {
    const spy = installFetch(() => {
      throw new Error("不應送出請求");
    });
    render(<ResetPasswordPage token="tok-123" onDone={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("新密碼"), { target: { value: "new-password-01" } });
    fireEvent.change(screen.getByLabelText("確認新密碼"), { target: { value: "different-01" } });
    fireEvent.click(screen.getByRole("button", { name: "設定新密碼" }));
    expect(screen.getByText("兩次輸入的密碼不一致")).toBeTruthy();
    expect(spy.calls).toHaveLength(0);
  });

  it("token 過期 → 顯示 server 訊息", async () => {
    installFetch((call) => {
      if (call.url === "/api/auth/reset-password") {
        return { status: 400, body: { error: { code: "TOKEN_EXPIRED", message: "重設連結已過期，請重新申請" } } };
      }
      throw new Error(`未預期的請求：${call.method} ${call.url}`);
    });
    render(<ResetPasswordPage token="tok-expired" onDone={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("新密碼"), { target: { value: "new-password-01" } });
    fireEvent.change(screen.getByLabelText("確認新密碼"), { target: { value: "new-password-01" } });
    fireEvent.click(screen.getByRole("button", { name: "設定新密碼" }));
    expect(await screen.findByText("重設連結已過期，請重新申請")).toBeTruthy();
  });
});
