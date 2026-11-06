/**
 * composeAlias.dom.spec.tsx — D31：撰寫視窗的三種隱私模式
 *
 * owner 2026-11-06 定案：
 * - 每個帳號有 1 個真實 ID（固定）、1 個啟用中的暱稱別名、1 個系統自動產生的隱身代號
 * - 撰寫介面用「真實 ID／暱稱／隱身代號」三種模式選擇，不再顯示可切換的地址清單
 * - 對方只會看到所選身分；回信仍會送到真實 ID
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { EmailAddressInfo, EmailAlias, Session } from "../src/api/types";
import { ComposeWindow, type Draft } from "../src/components/ComposeWindow";

const OWNER: Session = { kind: "owner", token: "t", userId: 1, username: "owner" };
const MAILBOX: Session = { kind: "mailbox", token: "t", addressId: 10, email: "alice@atwho.org" };

const ADDRESSES: EmailAddressInfo[] = [
  { id: 1, email: "alice@atwho.org", status: "active", has_password: true, created_at: 1, updated_at: 1 },
  { id: 2, email: "bob@atwho.org", status: "active", has_password: true, created_at: 1, updated_at: 1 },
];

const TOKEN_ADDRESS = "0123456789abcdef@atwho.org";

function alias(overrides: Partial<EmailAlias>): EmailAlias {
  return {
    id: 1,
    alias_address: "luke001@atwho.org",
    target_address_id: 1,
    target_email: "alice@atwho.org",
    status: "active",
    kind: "named",
    received_count: 0,
    last_received_at: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function draft(from: string): Draft {
  return { key: 1, mode: "new", from, to: "", cc: "", bcc: "", subject: "", bodyText: "" };
}

function renderCompose(session: Session, addresses: EmailAddressInfo[], aliases: EmailAlias[], from: string) {
  return render(
    <ComposeWindow
      draft={draft(from)}
      session={session}
      addresses={addresses}
      aliases={aliases}
      onClose={() => {}}
      onSent={() => {}}
      onError={() => {}}
      onDirty={() => {}}
    />
  );
}

function fromInput(): HTMLInputElement {
  return screen.getByLabelText("寄件者") as HTMLInputElement;
}

describe("D31：撰寫視窗的三種隱私模式", () => {
  it("owner：真實 ID 固定第一個 active 地址；可切換暱稱與隱身代號", () => {
    renderCompose(
      OWNER,
      ADDRESSES,
      [
        alias({ id: 1, alias_address: "luke001@atwho.org", kind: "named", target_email: "alice@atwho.org" }),
        alias({ id: 2, alias_address: TOKEN_ADDRESS, kind: "token", target_email: "alice@atwho.org" }),
      ],
      "alice@atwho.org"
    );

    expect(fromInput().value).toBe("alice@atwho.org");
    expect(fromInput().readOnly).toBe(true);
    expect(screen.getByRole("radio", { name: "真實 ID" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("radio", { name: "暱稱" }));
    expect(fromInput().value).toBe("luke001@atwho.org");
    expect(screen.getByText(/對方會看到暱稱別名/)).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "隱身代號" }));
    expect(fromInput().value).toBe(TOKEN_ADDRESS);
    expect(screen.getByText(/只會看到這組隱身代號/)).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "真實 ID" }));
    expect(fromInput().value).toBe("alice@atwho.org");
    expect(screen.getByText(/對方會看到你的真實 ID/)).toBeTruthy();
  });

  it("沒有暱稱別名 → 暱稱模式停用；隱身代號仍可用", () => {
    renderCompose(
      OWNER,
      ADDRESSES,
      [alias({ id: 2, alias_address: TOKEN_ADDRESS, kind: "token", target_email: "alice@atwho.org" })],
      "alice@atwho.org"
    );

    expect((screen.getByRole("radio", { name: "暱稱" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("radio", { name: "隱身代號" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("mailbox session：真實 ID 是自己的地址，也能選暱稱與隱身代號", () => {
    renderCompose(
      MAILBOX,
      [],
      [
        alias({ id: 1, alias_address: "luke001@atwho.org", kind: "named", target_address_id: 10 }),
        alias({ id: 2, alias_address: TOKEN_ADDRESS, kind: "token", target_address_id: 10 }),
      ],
      "alice@atwho.org"
    );

    expect(fromInput().value).toBe("alice@atwho.org");
    fireEvent.click(screen.getByRole("radio", { name: "隱身代號" }));
    expect(fromInput().value).toBe(TOKEN_ADDRESS);
  });

  it("切到互動式表單：從暱稱自動改回真實 ID，且暱稱／隱身代號停用", () => {
    renderCompose(
      OWNER,
      ADDRESSES,
      [alias({ id: 1, alias_address: "luke001@atwho.org", kind: "named", target_email: "alice@atwho.org" })],
      "luke001@atwho.org"
    );

    expect(fromInput().value).toBe("luke001@atwho.org");
    fireEvent.click(screen.getByRole("tab", { name: "互動式表單" }));

    expect(fromInput().value).toBe("alice@atwho.org");
    expect((screen.getByRole("radio", { name: "暱稱" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("radio", { name: "隱身代號" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("草稿指向已停用的別名 → 自動退回真實 ID", async () => {
    renderCompose(
      OWNER,
      ADDRESSES,
      [
        alias({
          id: 1,
          alias_address: "old999@atwho.org",
          kind: "named",
          status: "disabled",
          target_email: "alice@atwho.org",
        }),
      ],
      "old999@atwho.org"
    );

    await waitFor(() => expect(fromInput().value).toBe("alice@atwho.org"));
  });
});
