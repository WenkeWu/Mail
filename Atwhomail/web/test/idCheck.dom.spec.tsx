/**
 * idCheck.dom.spec.tsx — D20：註冊 ID 即時檢查與建議 chip（docs/20 §3.5）
 *
 * 只 mock 網路邊界（fetch）；debounce、React 狀態與 DOM 事件都是真的。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LoginPage } from "../src/components/LoginPage";
import { installFetch, type FakeReply, type FetchCall } from "./dom-fetch";

function routes(): (call: FetchCall) => FakeReply {
  return (call) => {
    if (call.url === "/api/auth/registration-mode") return { body: { mode: "email_verify" } };
    if (call.url === "/api/auth/check-id") {
      const label = (call.body as { label?: string } | null)?.label ?? "";
      if (label === "hp") {
        return {
          body: {
            available: false,
            reason: "MATCHES_DOMAIN",
            tldHit: "com",
            suggestions: ["myhp", "hpinbox"],
          },
        };
      }
      return { body: { available: true, reason: "OK" } };
    }
    throw new Error(`未預期的請求：${call.method} ${call.url}`);
  };
}

describe("D20：LoginPage ID 即時檢查", () => {
  it("500ms 後顯示撞網域原因與建議 chip；點 chip 會填入並重新檢查", async () => {
    const spy = installFetch(routes());
    render(<LoginPage notice={null} onLogin={vi.fn()} mode="public" />);

    fireEvent.click(screen.getByRole("tab", { name: "註冊" }));
    const input = (await screen.findByLabelText(/想要的 ID/)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "HP" } });

    expect(await screen.findByText(/已被 hp\.com 網域使用/)).toBeTruthy();
    await waitFor(() => expect(spy.countOf("/api/auth/check-id")).toBe(1));
    expect(spy.calls.find((c) => c.url === "/api/auth/check-id")?.body).toEqual({ label: "hp" });

    fireEvent.click(screen.getByRole("button", { name: "myhp" }));
    expect(input.value).toBe("myhp");

    expect(await screen.findByText("✅ 可用")).toBeTruthy();
    await waitFor(() => expect(spy.countOf("/api/auth/check-id")).toBe(2));
  });
});
