/**
 * `LoginPage` 的 D21 註冊表單渲染測試（docs/21 §6）。
 *
 * 驗證三件事（jsdom；只 mock `fetch`，其餘狀態與事件都是真的）：
 * 1. `REGISTRATION_MODE=invite` → 仍顯示邀請碼欄位（向後相容、行為不變）
 * 2. `REGISTRATION_MODE=email_verify` → 顯示 Email／ID／密碼；寄碼後出現 6 位數欄位；
 *    完成驗證會呼叫 `register-verify` 並以回傳 token 自動登入
 * 3. `REGISTRATION_MODE=closed` → 顯示「目前未開放註冊。」
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LoginPage } from "../src/components/LoginPage";
import { installFetch, type FetchCall, type FakeReply } from "./dom-fetch";

const MODE_URL = "/api/auth/registration-mode";

function routes(mode: "invite" | "email_verify" | "closed", extra?: (call: FetchCall) => FakeReply | null) {
  return (call: FetchCall): FakeReply => {
    if (call.url === MODE_URL) return { body: { mode } };
    // D20：ID 欄位 debounce 後會呼叫 check-id（本檔不驗證提示，只回可用）
    if (call.url === "/api/auth/check-id") return { body: { available: true, reason: "OK" } };
    const reply = extra?.(call);
    if (reply) return reply;
    throw new Error(`未預期的請求：${call.method} ${call.url}`);
  };
}

function openRegisterTab(): void {
  fireEvent.click(screen.getByRole("tab", { name: "註冊" }));
}

describe("D21：LoginPage 註冊表單", () => {
  it("invite 模式：仍顯示邀請碼欄位，不顯示寄送驗證碼（向後相容）", async () => {
    installFetch(routes("invite"));
    render(<LoginPage notice={null} onLogin={vi.fn()} mode="public" />);
    openRegisterTab();

    expect(await screen.findByLabelText(/邀請碼/)).toBeTruthy();
    expect(screen.getByLabelText(/使用者名稱/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "寄送驗證碼" })).toBeNull();
  });

  it("email_verify 模式：寄碼 → 輸入 6 位數 → 驗證成功自動登入", async () => {
    const onLogin = vi.fn();
    const spy = installFetch(
      routes("email_verify", (call) => {
        if (call.url === "/api/auth/register-request") return { body: { sent: true, expiresIn: 900 } };
        if (call.url === "/api/auth/register-verify") {
          return {
            body: {
              token: "mailbox-token",
              session: "mailbox",
              address: { id: 7, email: "friend01@atwho.org" },
            },
          };
        }
        return null;
      })
    );
    render(<LoginPage notice={null} onLogin={onLogin} mode="public" />);
    openRegisterTab();

    fireEvent.change(await screen.findByLabelText(/Email（收取驗證碼）/), { target: { value: "Me@Example.com" } });
    fireEvent.change(screen.getByLabelText(/想要的 ID/), { target: { value: "Friend01" } });
    fireEvent.change(screen.getByLabelText("密碼"), { target: { value: "long-password-01" } });
    fireEvent.change(screen.getByLabelText("確認密碼"), { target: { value: "long-password-01" } });

    fireEvent.click(screen.getByRole("button", { name: "寄送驗證碼" }));
    await waitFor(() => expect(spy.countOf("/api/auth/register-request")).toBe(1));
    const requestCall = spy.calls.find((c) => c.url === "/api/auth/register-request")!;
    expect(requestCall.body).toEqual({ email: "me@example.com", local_part: "friend01" });

    const codeInput = await screen.findByLabelText(/驗證碼（6 位數）/);
    fireEvent.change(codeInput, { target: { value: "123456" } });
    expect(screen.getByText(/重新寄送（\d+s）/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "完成註冊並登入" }));
    await waitFor(() =>
      expect(onLogin).toHaveBeenCalledWith({
        kind: "mailbox",
        token: "mailbox-token",
        addressId: 7,
        email: "friend01@atwho.org",
      })
    );
    const verifyCall = spy.calls.find((c) => c.url === "/api/auth/register-verify")!;
    expect(verifyCall.body).toEqual({
      email: "me@example.com",
      local_part: "friend01",
      code: "123456",
      password: "long-password-01",
      country: "TW",
      language: "zh-TW",
    });
  });

  it("closed 模式：顯示目前未開放註冊，且沒有送出按鈕", async () => {
    installFetch(routes("closed"));
    render(<LoginPage notice={null} onLogin={vi.fn()} mode="public" />);
    openRegisterTab();

    expect(await screen.findByText("目前未開放註冊。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "寄送驗證碼" })).toBeNull();
    expect(screen.queryByRole("button", { name: "註冊並登入" })).toBeNull();
  });
});
