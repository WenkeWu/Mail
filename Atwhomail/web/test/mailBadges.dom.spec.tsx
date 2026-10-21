/**
 * mailBadges.dom.spec.tsx — docs/18 P1：三類郵件徽章與寄件者驗證顯示（T53／T55）
 *
 * 只驗證**畫面顯示**：分類來自後端欄位（不是 From），SPF／DKIM／DMARC 僅供參考。
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { MailDetail, MailListItem } from "../src/api/types";
import { MessageListItem } from "../src/components/MessageListItem";
import { ReadingPane } from "../src/components/ReadingPane";

function detail(overrides: Partial<MailDetail> = {}): MailDetail {
  return {
    id: 1,
    from: "Alice <alice@atwho.org>",
    to: [{ address: "bob@atwho.org", name: "" }],
    cc: [],
    subject: "Hello",
    text_preview: "preview",
    message_id: "<m1@atwho.org>",
    received_at: 1_780_000_000_000,
    read_at: null,
    folder: "inbox",
    html_url: null,
    attachments: [],
    origin: "external",
    kind: "normal",
    delivery_scope: "external",
    form_instance_id: null,
    suspicious_form_claim: false,
    sender_spf: "pass",
    sender_dkim: "pass",
    sender_dmarc: "pass",
    ...overrides,
  };
}

function renderPane(d: MailDetail) {
  return render(
    <ReadingPane
      detail={d}
      body={{ kind: "text", text: "訊息內容仍可正常閱讀" }}
      loading={false}
      downloadingId={null}
      onClose={() => {}}
      onReply={() => {}}
      onReplyAll={() => {}}
      onForward={() => {}}
      onToggleRead={() => {}}
      onArchive={() => {}}
      onMove={() => {}}
      onDelete={() => {}}
      onDownloadAttachment={() => {}}
    />
  );
}

describe("三類郵件徽章", () => {
  it("外部信件：From 是 atwho.org 也顯示「外部」（T53：分類不看 From）", () => {
    renderPane(detail({ from: "Alice <alice@atwho.org>", origin: "external" }));
    expect(screen.getByText("外部")).toBeTruthy();
    expect(screen.queryByText("內部")).toBeNull();
    expect(screen.queryByText("互動式")).toBeNull();
  });

  it("內部一般郵件顯示「內部」，且不顯示寄件者驗證徽章", () => {
    renderPane(
      detail({
        origin: "internal",
        delivery_scope: "internal",
        sender_spf: null,
        sender_dkim: null,
        sender_dmarc: null,
      })
    );
    expect(screen.getByText("內部")).toBeTruthy();
    expect(screen.queryByText(/SPF/)).toBeNull();
  });

  it("互動式表單郵件顯示「互動式」", () => {
    renderPane(
      detail({
        origin: "internal",
        kind: "interactive_form",
        delivery_scope: "internal",
        form_instance_id: 7,
      })
    );
    expect(screen.getByText("互動式")).toBeTruthy();
  });
});

describe("寄件者驗證（僅顯示，T55）", () => {
  it("失敗時顯示 SPF／DKIM／DMARC 失敗與警示，但信件內容仍可閱讀", () => {
    renderPane(detail({ sender_spf: "fail", sender_dkim: "fail", sender_dmarc: "fail" }));
    expect(screen.getByText("SPF 失敗")).toBeTruthy();
    expect(screen.getByText("DKIM 失敗")).toBeTruthy();
    expect(screen.getByText("DMARC 失敗")).toBeTruthy();
    expect(screen.getByText(/寄件者驗證失敗/)).toBeTruthy();
    expect(screen.getByText("訊息內容仍可正常閱讀")).toBeTruthy();
  });

  it("缺少結果時顯示「未知」而非假裝通過", () => {
    renderPane(detail({ sender_spf: null, sender_dkim: "none", sender_dmarc: null }));
    expect(screen.getByText("SPF 未知")).toBeTruthy();
    expect(screen.getByText("DKIM 未驗證")).toBeTruthy();
    expect(screen.getByText("DMARC 未知")).toBeTruthy();
  });
});

describe("列表徽章", () => {
  it("MessageListItem 顯示分類徽章", () => {
    const item: MailListItem = {
      id: 3,
      from: "ext@example.com",
      subject: "s",
      text_preview: "p",
      received_at: 1_780_000_000_000,
      read: false,
      has_attachments: false,
      folder: "inbox",
      origin: "external",
      kind: "normal",
      delivery_scope: "external",
    };
    render(<MessageListItem item={item} selected={false} showFolder={false} onSelect={() => {}} />);
    expect(screen.getByText("外部")).toBeTruthy();
  });
});
