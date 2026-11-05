/**
 * `AliasManager` 的渲染測試（D25，docs/25 §6）。
 *
 * 只 mock `fetch`（網路邊界），元件、驗證、表單與 DOM 事件都是真的。
 * API 規則本身（T109–T118）在 `packages/api/test/alias.spec.ts`；
 * 這裡確認 UI 真的把「建立 → 顯示別名＋複製」與「停用」接上。
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AliasManager } from "../src/components/AliasManager";
import type { EmailAddressInfo, EmailAlias, Session } from "../src/api/types";
import { installFetch, type FetchCall, type FakeReply } from "./dom-fetch";

const OWNER_SESSION: Session = { kind: "owner", token: "owner-token", userId: 1, username: "owner" };

const ADDRESS: EmailAddressInfo = {
  id: 11,
  email: "alice@atwho.org",
  status: "active",
  has_password: true,
  created_at: Date.UTC(2026, 8, 1),
  updated_at: Date.UTC(2026, 8, 1),
};

const ALIAS: EmailAlias = {
  id: 7,
  alias_address: "luke001@atwho.org",
  target_address_id: 11,
  target_email: "alice@atwho.org",
  status: "active",
  received_count: 3,
  last_received_at: Date.UTC(2026, 10, 1, 12, 0, 0),
  created_at: Date.UTC(2026, 9, 1),
  updated_at: Date.UTC(2026, 9, 1),
};

function routes(opts: { aliases?: EmailAlias[] }): (call: FetchCall) => FakeReply {
  return (call) => {
    if (call.url === "/api/email-aliases" && call.method === "GET") {
      return { body: { aliases: opts.aliases ?? [] } };
    }
    if (call.url === "/api/email-aliases" && call.method === "POST") {
      return { status: 201, body: { id: 7, alias_address: "luke001@atwho.org", target_address_id: 11, status: "active" } };
    }
    if (call.url === "/api/email-aliases/7" && call.method === "PATCH") {
      return { body: { ok: true, id: 7, alias_address: ALIAS.alias_address, status: "disabled" } };
    }
    if (call.url === "/api/email-addresses") {
      return { body: { addresses: [ADDRESS] } };
    }
    throw new Error(`未預期的請求：${call.method} ${call.url}`);
  };
}

function renderManager(opts: { aliases?: EmailAlias[] } = {}) {
  const onToast = vi.fn();
  const onChanged = vi.fn();
  const spy = installFetch(routes(opts));
  render(<AliasManager session={OWNER_SESSION} onBack={vi.fn()} onToast={onToast} onChanged={onChanged} />);
  return { onToast, onChanged, spy };
}

describe("AliasManager（D25）", () => {
  it("空狀態顯示「對方看不到真實地址」提示", async () => {
    renderManager();
    expect(await screen.findByText(/建立別名後，把別名給對方，對方就看不到你的真實地址/)).toBeTruthy();
  });

  it("名字即時驗證：少於 3 個字母 → 顯示錯誤且不送出 POST", async () => {
    const { spy } = renderManager();
    const input = screen.getByLabelText("別名名字");
    fireEvent.change(input, { target: { value: "ab" } });
    expect(await screen.findByText("至少 3 個英文字母")).toBeTruthy();
    expect(spy.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("保留字 → 顯示錯誤", async () => {
    renderManager();
    fireEvent.change(screen.getByLabelText("別名名字"), { target: { value: "admin" } });
    expect(await screen.findByText(/保留字/)).toBeTruthy();
  });

  it("建立成功 → 顯示完整別名與複製按鈕，並送出正確 payload", async () => {
    const { spy, onChanged } = renderManager();
    await screen.findByText(/建立別名後/); // 等初始載入完成
    fireEvent.change(screen.getByLabelText("別名名字"), { target: { value: "Luke" } });
    fireEvent.click(screen.getByRole("button", { name: "建立" }));

    expect(await screen.findByText("別名已建立")).toBeTruthy();
    expect(screen.getByText("luke001@atwho.org")).toBeTruthy();
    expect(screen.getByRole("button", { name: "複製別名" })).toBeTruthy();
    expect(spy.calls.find((c) => c.method === "POST")?.body).toEqual({
      name: "luke",
      target_address_id: 11,
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("列表顯示收到幾封／最後收到時間，停用會打 PATCH", async () => {
    const { spy } = renderManager({ aliases: [ALIAS] });
    const row = (await screen.findByText(ALIAS.alias_address)).closest("tr")!;
    expect(within(row).getByText("3")).toBeTruthy();
    expect(within(row).getByText("alice@atwho.org")).toBeTruthy();

    fireEvent.click(within(row).getByRole("button", { name: "停用" }));
    await waitFor(() =>
      expect(spy.calls.find((c) => c.method === "PATCH")?.body).toEqual({ status: "disabled" })
    );
  });
});
