/**
 * D23：LoginPage 的 Turnstile widget（docs/23 §4）
 *
 * 只 mock 網路邊界（`fetch`）與 Cloudflare 的全域 `window.turnstile`；
 * 其餘（React 狀態、事件、表單流程）都是真的。
 *
 * 驗證：
 * 1. `turnstileSiteKey = null` → 不載入腳本、不顯示 widget（行為同 D21）
 * 2. site key 非空 → widget 以 `theme: "auto"` render；token 有效才可寄碼，
 *    且 `register-request` body 帶 `turnstile_token`
 * 3. token 過期 → 顯示提示並再次停用寄送
 * 4. 後端回 400 TURNSTILE_FAILED → 顯示錯誤並重新 render widget（取得新 token）
 * 5. site key 非空且腳本尚未載入 → 動態載入官方 `render=explicit` 腳本
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "../src/components/LoginPage";
import { installFetch, type FetchCall, type FakeReply } from "./dom-fetch";

const MODE_URL = "/api/auth/registration-mode";
const SEND_URL = "/api/auth/register-request";
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface FakeRenderOptions {
  sitekey: string;
  theme?: string;
  callback?: (token: string) => void;
  "expired-callback"?: () => void;
  "error-callback"?: () => void;
}

interface FakeTurnstile {
  render: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

function installTurnstile(): { api: FakeTurnstile; options: () => FakeRenderOptions } {
  let options: FakeRenderOptions | null = null;
  const api: FakeTurnstile = {
    render: vi.fn((_container: HTMLElement, opts: FakeRenderOptions) => {
      options = opts;
      return "widget-1";
    }),
    reset: vi.fn(),
    remove: vi.fn(),
  };
  (window as unknown as { turnstile: FakeTurnstile }).turnstile = api;
  return {
    api,
    options: () => {
      if (!options) throw new Error("widget 尚未 render");
      return options;
    },
  };
}

function routes(
  siteKey: string | null,
  sendReply: FakeReply = { body: { sent: true, expiresIn: 900 } }
) {
  return (call: FetchCall): FakeReply => {
    if (call.url === MODE_URL) return { body: { mode: "email_verify", turnstileSiteKey: siteKey } };
    if (call.url === "/api/auth/check-id") return { body: { available: true, reason: "OK" } };
    if (call.url === SEND_URL) return sendReply;
    throw new Error(`未預期的請求：${call.method} ${call.url}`);
  };
}

function openRegisterTab(): void {
  fireEvent.click(screen.getByRole("tab", { name: "註冊" }));
}

async function fillForm(): Promise<void> {
  fireEvent.change(await screen.findByLabelText(/Email（收取驗證碼）/), { target: { value: "me@example.com" } });
  fireEvent.change(screen.getByLabelText(/想要的 ID/), { target: { value: "friend01" } });
  fireEvent.change(screen.getByLabelText("密碼"), { target: { value: "long-password-01" } });
  fireEvent.change(screen.getByLabelText("確認密碼"), { target: { value: "long-password-01" } });
}

function sendButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "寄送驗證碼" }) as HTMLButtonElement;
}

afterEach(() => {
  delete (window as unknown as { turnstile?: unknown }).turnstile;
  document.querySelectorAll(`script[src="${SCRIPT_SRC}"]`).forEach((script) => script.remove());
});

describe("D23：Turnstile widget", () => {
  it("site key 未設定 → 不載入腳本、不顯示 widget，寄送按鈕照常可用", async () => {
    installFetch(routes(null));
    render(<LoginPage notice={null} onLogin={vi.fn()} mode="public" />);
    openRegisterTab();
    await fillForm();

    expect(document.querySelector(".turnstile-widget")).toBeNull();
    expect(document.querySelector(`script[src="${SCRIPT_SRC}"]`)).toBeNull();
    expect(sendButton().disabled).toBe(false);
  });

  it("site key 已設定 → widget（theme auto）；token 有效才可寄碼，送出帶 turnstile_token", async () => {
    const spy = installFetch(routes("site-key-123"));
    const { api, options } = installTurnstile();
    render(<LoginPage notice={null} onLogin={vi.fn()} mode="public" />);
    openRegisterTab();
    await fillForm();

    await waitFor(() => expect(api.render).toHaveBeenCalledTimes(1));
    expect(api.render.mock.calls[0]![1]).toMatchObject({ sitekey: "site-key-123", theme: "auto" });
    expect(sendButton().disabled).toBe(true);

    act(() => options().callback?.("turnstile-token-abc"));
    await waitFor(() => expect(sendButton().disabled).toBe(false));

    fireEvent.click(sendButton());
    await waitFor(() => expect(spy.countOf(SEND_URL)).toBe(1));
    expect(spy.calls.find((call) => call.url === SEND_URL)!.body).toEqual({
      email: "me@example.com",
      local_part: "friend01",
      turnstile_token: "turnstile-token-abc",
    });

    // 寄碼成功 → 進入驗證碼流程
    expect(await screen.findByLabelText(/驗證碼（6 位數）/)).toBeTruthy();
  });

  it("token 過期 → 顯示提示並停用寄送", async () => {
    installFetch(routes("site-key-123"));
    const { api, options } = installTurnstile();
    render(<LoginPage notice={null} onLogin={vi.fn()} mode="public" />);
    openRegisterTab();
    await fillForm();
    await waitFor(() => expect(api.render).toHaveBeenCalledTimes(1));

    act(() => options().callback?.("token-1"));
    await waitFor(() => expect(sendButton().disabled).toBe(false));

    act(() => options()["expired-callback"]?.());
    expect(await screen.findByText("驗證已過期，請重新完成驗證。")).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
  });

  it("後端回 TURNSTILE_FAILED → 顯示錯誤並重新 render widget（取得新 token）", async () => {
    installFetch(
      routes("site-key-123", {
        status: 400,
        body: { error: { code: "TURNSTILE_FAILED", message: "機器人驗證未通過，請重試" } },
      })
    );
    const { api, options } = installTurnstile();
    render(<LoginPage notice={null} onLogin={vi.fn()} mode="public" />);
    openRegisterTab();
    await fillForm();
    await waitFor(() => expect(api.render).toHaveBeenCalledTimes(1));

    act(() => options().callback?.("stale-token"));
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    fireEvent.click(sendButton());

    // 舊 token 已被消耗 → widget 重建（remove + render），按鈕回到停用
    await waitFor(() => expect(api.render).toHaveBeenCalledTimes(2));
    expect(api.remove).toHaveBeenCalledWith("widget-1");
    expect(await screen.findByText(/機器人驗證未通過，請重試/)).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
  });

  // 放最後：此案例會讓 loader 的 Promise 保持 pending（jsdom 不會真的下載腳本）
  it("site key 已設定且尚未載入腳本 → 動態載入官方 render=explicit 腳本", async () => {
    installFetch(routes("site-key-123"));
    render(<LoginPage notice={null} onLogin={vi.fn()} mode="public" />);
    openRegisterTab();
    await screen.findByLabelText(/Email（收取驗證碼）/);

    await waitFor(() => expect(document.querySelector(`script[src="${SCRIPT_SRC}"]`)).toBeTruthy());
  });
});
