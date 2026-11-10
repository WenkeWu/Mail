/**
 * D26：App Clients 管理 UI（docs/27 §6）。
 *
 * 驗證：列表、建立後 secret **只顯示一次**、關閉後不再出現、停用會送 PATCH。
 * 只 mock fetch（網路邊界），其餘狀態／事件都是真的。
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppClientsManager } from "../src/components/AppClientsManager";
import type { AppClient } from "../src/api/types";
import { installFetch, type FetchCall, type FakeReply } from "./dom-fetch";

const APP: AppClient = {
  id: 1,
  app_id: "mycrm",
  name: "My CRM",
  redirect_uris: ["https://crm.example.com/cb"],
  status: "active",
  created_at: Date.UTC(2026, 10, 5, 8, 0),
  updated_at: Date.UTC(2026, 10, 5, 8, 0),
};

const SECRET = "a".repeat(64);

function routes(state: { disabled: boolean }): (call: FetchCall) => FakeReply {
  return (call) => {
    if (call.url === "/api/apps" && call.method === "GET") {
      return { body: { apps: [{ ...APP, status: state.disabled ? "disabled" : "active" }] } };
    }
    if (call.url === "/api/apps" && call.method === "POST") {
      return {
        status: 201,
        body: { app_id: "mycrm", app_secret: SECRET, redirect_uris: ["https://crm.example.com/cb"] },
      };
    }
    if (call.url === `/api/apps/${APP.id}` && call.method === "DELETE") {
      state.disabled = true;
      return { body: { ok: true, app: { ...APP, status: "disabled" } } };
    }
    throw new Error(`未預期的請求：${call.method} ${call.url}`);
  };
}

function renderManager() {
  const onToast = vi.fn();
  render(<AppClientsManager onBack={vi.fn()} onToast={onToast} />);
  return { onToast };
}

describe("AppClientsManager", () => {
  it("列出 app_id／名稱／狀態／redirect_uris（清單不含 secret）", async () => {
    installFetch(routes({ disabled: false }));
    renderManager();

    expect(await screen.findByText("mycrm")).toBeTruthy();
    expect(screen.getByText("My CRM")).toBeTruthy();
    expect(screen.getByText("啟用中")).toBeTruthy();
    expect(screen.getByText("https://crm.example.com/cb")).toBeTruthy();
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("建立 App → secret 只顯示一次；關閉後不再出現", async () => {
    const spy = installFetch(routes({ disabled: false }));
    renderManager();

    await screen.findByText("mycrm");
    fireEvent.click(screen.getByRole("button", { name: "新增 App" }));

    const dialog = screen.getByRole("dialog", { name: "新增 App Client" });
    fireEvent.change(within(dialog).getByLabelText(/App ID/), { target: { value: "mycrm2" } });
    fireEvent.change(within(dialog).getByLabelText(/^名稱$/), { target: { value: "My CRM 2" } });
    fireEvent.change(within(dialog).getByLabelText(/Redirect URIs/), {
      target: { value: "https://crm2.example.com/cb\n\nhttps://crm2.example.com/cb2" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "建立" }));

    const secretDialog = await screen.findByRole("dialog", { name: /App Secret/ });
    expect(within(secretDialog).getByText(SECRET)).toBeTruthy();
    // 空白行被忽略；POST body 為正規化後的 redirect_uris
    const post = spy.calls.find((c) => c.url === "/api/apps" && c.method === "POST")!;
    expect(post.body).toEqual({
      app_id: "mycrm2",
      name: "My CRM 2",
      redirect_uris: ["https://crm2.example.com/cb", "https://crm2.example.com/cb2"],
    });

    fireEvent.click(within(secretDialog).getByRole("button", { name: "我已保存，關閉" }));
    await waitFor(() => expect(screen.queryByText(SECRET)).toBeNull());
    // 清單／後續操作不得再取得 secret
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("D37：可一鍵建立內部系統 App Client（redirect_uri 由 systems.ts 提供）", async () => {
    const spy = installFetch((call) => {
      if (call.url === "/api/apps" && call.method === "GET") return { body: { apps: [] } };
      if (call.url === "/api/apps" && call.method === "POST") {
        return {
          status: 201,
          body: {
            app_id: "form",
            app_secret: SECRET,
            redirect_uris: ["https://form.atwho.org/api/auth/atwho/callback"],
          },
        };
      }
      throw new Error(`未預期的請求：${call.method} ${call.url}`);
    });
    renderManager();

    const row = (await screen.findByText("Form")).closest("tr") as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "建立" }));

    const post = await waitFor(() => {
      const call = spy.calls.find((c) => c.url === "/api/apps" && c.method === "POST");
      expect(call).toBeTruthy();
      return call!;
    });
    expect(post.body).toEqual({
      app_id: "form",
      name: "Form",
      redirect_uris: ["https://form.atwho.org/api/auth/atwho/callback"],
    });
    expect(await screen.findByRole("dialog", { name: /App Secret/ })).toBeTruthy();
  });

  it("停用 → DELETE（軟停用），狀態變為已停用", async () => {
    const state = { disabled: false };
    const spy = installFetch(routes(state));
    const { onToast } = renderManager();

    await screen.findByText("mycrm");
    fireEvent.click(screen.getByRole("button", { name: "停用" }));

    await waitFor(() => expect(screen.getByText("已停用")).toBeTruthy());
    const call = spy.calls.find((c) => c.url === `/api/apps/${APP.id}` && c.method === "DELETE")!;
    expect(call.body).toBeNull();
    expect(onToast).toHaveBeenCalledWith("mycrm 已停用");
    expect(screen.getByRole("button", { name: "啟用" })).toBeTruthy();
  });
});
