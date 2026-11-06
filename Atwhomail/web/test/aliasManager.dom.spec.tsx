/**
 * `AliasManager` 的渲染測試（D25；D31 三種寄信身分）。
 *
 * 只 mock `fetch`（網路邊界），元件、驗證、表單與 DOM 事件都是真的。
 * API 規則本身在 `packages/api/test/alias.spec.ts`；
 * 這裡確認 UI 接上「建立／變更暱稱別名」、「隱身代號系統管理」與「停用」。
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const NAMED_ALIAS: EmailAlias = {
  id: 7,
  alias_address: "luke001@atwho.org",
  target_address_id: 11,
  target_email: "alice@atwho.org",
  status: "active",
  kind: "named",
  received_count: 3,
  last_received_at: Date.UTC(2026, 10, 1, 12, 0, 0),
  created_at: Date.UTC(2026, 9, 1),
  updated_at: Date.UTC(2026, 9, 1),
};

const TOKEN_ALIAS: EmailAlias = {
  id: 8,
  alias_address: "0123456789abcdef@atwho.org",
  target_address_id: 11,
  target_email: "alice@atwho.org",
  status: "active",
  kind: "token",
  received_count: 1,
  last_received_at: null,
  created_at: Date.UTC(2026, 9, 1),
  updated_at: Date.UTC(2026, 9, 1),
};

function routes(opts: { aliases?: EmailAlias[]; postReply?: FakeReply }): (call: FetchCall) => FakeReply {
  return (call) => {
    if (call.url === "/api/email-aliases" && call.method === "GET") {
      return { body: { aliases: opts.aliases ?? [] } };
    }
    if (call.url === "/api/email-aliases" && call.method === "POST") {
      return (
        opts.postReply ?? {
          status: 201,
          body: {
            id: 7,
            alias_address: "luke001@atwho.org",
            target_address_id: 11,
            status: "active",
            kind: "named",
          },
        }
      );
    }
    if (call.url === "/api/email-aliases/7" && call.method === "PATCH") {
      return { body: { ok: true, id: 7, alias_address: NAMED_ALIAS.alias_address, status: "disabled" } };
    }
    if (call.url === "/api/email-addresses") {
      return { body: { addresses: [ADDRESS] } };
    }
    throw new Error(`未預期的請求：${call.method} ${call.url}`);
  };
}

function renderManager(opts: { aliases?: EmailAlias[]; postReply?: FakeReply } = {}) {
  const onToast = vi.fn();
  const onChanged = vi.fn();
  const spy = installFetch(routes(opts));
  render(<AliasManager session={OWNER_SESSION} onBack={vi.fn()} onToast={onToast} onChanged={onChanged} />);
  return { onToast, onChanged, spy };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AliasManager（D25／D31）", () => {
  it("空狀態說明暱稱需自行建立、隱身代號由系統產生", async () => {
    renderManager();
    expect(await screen.findByText(/尚未建立暱稱別名。隱身代號會在帳號建立時自動產生/)).toBeTruthy();
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

  it("建立成功 → 顯示暱稱別名與複製按鈕，並送出正確 payload", async () => {
    const { spy, onChanged } = renderManager();
    await screen.findByText(/尚未建立暱稱別名/); // 等初始載入完成
    fireEvent.change(screen.getByLabelText("別名名字"), { target: { value: "Luke" } });
    fireEvent.click(screen.getByRole("button", { name: "建立" }));

    expect(await screen.findByText("暱稱別名已建立")).toBeTruthy();
    expect(screen.getByText("luke001@atwho.org")).toBeTruthy();
    expect(screen.getByRole("button", { name: "複製別名" })).toBeTruthy();
    expect(spy.calls.find((c) => c.method === "POST")?.body).toEqual({
      name: "luke",
      target_address_id: 11,
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("已有啟用中的暱稱別名 → 表單改為「變更」，送出 replace_existing 並顯示舊別名已停用", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { spy } = renderManager({
      aliases: [NAMED_ALIAS],
      postReply: {
        status: 201,
        body: {
          id: 9,
          alias_address: "robert001@atwho.org",
          target_address_id: 11,
          status: "active",
          kind: "named",
          replaced: ["luke001@atwho.org"],
        },
      },
    });

    expect(await screen.findByRole("heading", { name: /變更暱稱別名/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("別名名字"), { target: { value: "robert" } });
    fireEvent.click(screen.getByRole("button", { name: "變更" }));

    expect(await screen.findByText("暱稱別名已變更")).toBeTruthy();
    expect(screen.getByText(/舊別名已停用：luke001@atwho.org/)).toBeTruthy();
    expect(spy.calls.find((c) => c.method === "POST")?.body).toEqual({
      name: "robert",
      target_address_id: 11,
      replace_existing: true,
    });
  });

  it("列表顯示收到幾封／最後收到時間，停用暱稱會打 PATCH", async () => {
    const { spy } = renderManager({ aliases: [NAMED_ALIAS] });
    const row = (await screen.findByText(NAMED_ALIAS.alias_address)).closest("tr")!;
    expect(within(row).getByText("3")).toBeTruthy();
    expect(within(row).getByText("alice@atwho.org")).toBeTruthy();
    expect(within(row).getByText("暱稱")).toBeTruthy();

    fireEvent.click(within(row).getByRole("button", { name: "停用" }));
    await waitFor(() =>
      expect(spy.calls.find((c) => c.method === "PATCH")?.body).toEqual({ status: "disabled" })
    );
  });

  it("隱身代號列標示「隱身代號」、只有複製按鈕，沒有停用／刪除", async () => {
    renderManager({ aliases: [NAMED_ALIAS, TOKEN_ALIAS] });
    const row = (await screen.findByText(TOKEN_ALIAS.alias_address)).closest("tr")!;
    expect(within(row).getByText("隱身代號")).toBeTruthy();
    expect(within(row).getByRole("button", { name: "複製" })).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "停用" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "刪除（停用）" })).toBeNull();
    expect(within(row).getByText("系統管理")).toBeTruthy();
  });
});
