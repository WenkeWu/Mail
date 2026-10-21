/**
 * composeForm.dom.spec.tsx — docs/18 P2：ComposeWindow 的「互動式表單」模式
 *
 * 驗證：外部收件人在前端就被擋下；內部收件人送出時打 `/api/forms/send`（不是 /api/mail/send）。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EmailAddressInfo, Session } from "../src/api/types";
import { ComposeWindow, type Draft } from "../src/components/ComposeWindow";
import { installFetch } from "./dom-fetch";

const SESSION: Session = { kind: "owner", token: "t", userId: 1, username: "owner" };

const ADDRESSES: EmailAddressInfo[] = [
  { id: 1, email: "alice@atwho.org", status: "active", has_password: true, created_at: 1, updated_at: 1 },
  { id: 2, email: "bob@atwho.org", status: "active", has_password: true, created_at: 1, updated_at: 1 },
];

function draft(): Draft {
  return {
    key: 1,
    mode: "new",
    from: "alice@atwho.org",
    to: "",
    cc: "",
    bcc: "",
    subject: "",
    bodyText: "",
  };
}

function renderCompose(onSent: () => void) {
  return render(
    <ComposeWindow
      draft={draft()}
      session={SESSION}
      addresses={ADDRESSES}
      onClose={() => {}}
      onSent={onSent}
      onError={() => {}}
      onDirty={() => {}}
    />
  );
}

describe("ComposeWindow：互動式表單模式", () => {
  it("外部收件人 → 前端即擋下（不發出請求）", async () => {
    const spy = installFetch(() => ({ body: {} }));
    renderCompose(() => {});

    fireEvent.click(screen.getByRole("tab", { name: "互動式表單" }));
    fireEvent.change(screen.getByLabelText("收件者"), { target: { value: "outside@example.com" } });
    fireEvent.change(screen.getByLabelText("主旨"), { target: { value: "survey" } });
    fireEvent.click(screen.getByText("送出表單"));

    expect(await screen.findByText(/只能寄給 @atwho.org 內部地址/)).toBeTruthy();
    expect(spy.calls.length).toBe(0);
  });

  it("內部收件人 → 打 POST /api/forms/send 並帶 schema", async () => {
    const onSent = vi.fn();
    const spy = installFetch((call) => {
      if (call.url === "/api/forms/send" && call.method === "POST") {
        return {
          status: 201,
          body: {
            ok: true,
            template_id: 1,
            template_key: "k",
            message_id: "m",
            sent_message_id: 2,
            instances: [{ id: 3, recipient: "bob@atwho.org" }],
          },
        };
      }
      return { body: {} };
    });
    renderCompose(onSent);

    fireEvent.click(screen.getByRole("tab", { name: "互動式表單" }));
    fireEvent.change(screen.getByLabelText("收件者"), { target: { value: "bob@atwho.org" } });
    fireEvent.change(screen.getByLabelText("主旨"), { target: { value: "survey" } });
    fireEvent.click(screen.getByText("送出表單"));

    await waitFor(() => expect(onSent).toHaveBeenCalledWith({ from: "alice@atwho.org", to: ["bob@atwho.org"] }));
    const call = spy.calls.find((c) => c.url === "/api/forms/send");
    expect(call).toBeTruthy();
    const body = call!.body as {
      from: string;
      to: string[];
      subject: string;
      schema: { type: string; properties: Record<string, unknown> };
    };
    expect(body.from).toBe("alice@atwho.org");
    expect(body.to).toEqual(["bob@atwho.org"]);
    expect(body.subject).toBe("survey");
    expect(body.schema.type).toBe("object");
    expect(body.schema.properties.message).toBeTruthy();
    // 不能誤打一般寄信端點
    expect(spy.calls.some((c) => c.url === "/api/mail/send")).toBe(false);
  });

  it("schema 不是合法 JSON → 顯示錯誤、不送出", async () => {
    const spy = installFetch(() => ({ body: {} }));
    renderCompose(() => {});

    fireEvent.click(screen.getByRole("tab", { name: "互動式表單" }));
    fireEvent.change(screen.getByLabelText("收件者"), { target: { value: "bob@atwho.org" } });
    fireEvent.change(screen.getByLabelText("主旨"), { target: { value: "survey" } });
    fireEvent.change(screen.getByLabelText("表單 schema"), { target: { value: "{not json" } });
    fireEvent.click(screen.getByText("送出表單"));

    expect(await screen.findByText("表單 schema 不是有效的 JSON")).toBeTruthy();
    expect(spy.calls.length).toBe(0);
  });
});
