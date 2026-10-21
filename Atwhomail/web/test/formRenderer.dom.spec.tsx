/**
 * formRenderer.dom.spec.tsx — docs/18 P2：RJSF 渲染、title 消毒、ReadingPane 降級與寄件人管理
 *
 * jsdom 下所有網路都經 `installFetch` mock（D12：不得真的打網路）。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { FormSchema, MailDetail } from "../src/api/types";
import { FormRenderer } from "../src/components/FormRenderer";
import { ReadingPane } from "../src/components/ReadingPane";
import { apiError, installFetch } from "./dom-fetch";

const SCHEMA: FormSchema = {
  type: "object",
  title: "Team survey",
  description: "Please answer",
  properties: {
    answer: { type: "string", title: "Answer", maxLength: 20 },
    agree: { type: "boolean", title: "Agree" },
  },
  required: ["answer"],
};

function detail(overrides: Partial<MailDetail> = {}): MailDetail {
  return {
    id: 1,
    from: "alice@atwho.org",
    to: [{ address: "bob@atwho.org", name: "" }],
    cc: [],
    subject: "Form subject",
    text_preview: "static fallback",
    message_id: "<m1@atwho.org>",
    received_at: 1_780_000_000_000,
    read_at: Date.now(),
    folder: "inbox",
    html_url: null,
    attachments: [],
    origin: "internal",
    kind: "interactive_form",
    delivery_scope: "internal",
    form_instance_id: 7,
    suspicious_form_claim: false,
    sender_spf: null,
    sender_dkim: null,
    sender_dmarc: null,
    ...overrides,
  };
}

function renderPane(d: MailDetail, bodyText = "STATIC FALLBACK") {
  return render(
    <ReadingPane
      detail={d}
      body={{ kind: "text", text: bodyText }}
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

describe("FormRenderer（RJSF）", () => {
  it("渲染欄位並以 formData 呼叫 onSubmit", async () => {
    const submitted: Array<Record<string, unknown>> = [];
    render(<FormRenderer schema={SCHEMA} onSubmit={(data) => submitted.push(data)} />);

    expect(screen.getByText("Team survey")).toBeTruthy();
    const answer = screen.getByLabelText(/Answer/) as HTMLInputElement;
    fireEvent.change(answer, { target: { value: "hello" } });
    fireEvent.click(screen.getByText("送出回覆"));

    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]).toMatchObject({ answer: "hello" });
  });

  it("title／description 消毒：script 標籤不會進入 DOM，只留純文字", () => {
    const unsafe: FormSchema = {
      ...SCHEMA,
      title: "<script>alert(1)</script>Safe title",
      description: "<img src=x onerror=alert(1)>Safe description",
    };
    const { container } = render(<FormRenderer schema={unsafe} onSubmit={() => {}} />);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/Safe title/)).toBeTruthy();
    expect(screen.getByText(/Safe description/)).toBeTruthy();
  });
});

describe("ReadingPane：互動式表單", () => {
  it("GET 成功 → 渲染 RJSF；送出回覆打自家 responses API", async () => {
    const spy = installFetch((call) => {
      if (call.url === "/api/forms/7" && call.method === "GET") {
        return {
          body: {
            form: {
              id: 7,
              message_id: 1,
              subject: "Form subject",
              status: "open",
              due_at: null,
              title: "Team survey",
              description: null,
              schema: SCHEMA,
            },
          },
        };
      }
      if (call.url === "/api/forms/7/responses" && call.method === "POST") {
        return { body: { ok: true, instance_id: 7, status: "submitted" } };
      }
      return apiError(404, "FORM_NOT_FOUND", "form not found");
    });

    renderPane(detail());
    const answer = await screen.findByLabelText(/Answer/);
    fireEvent.change(answer, { target: { value: "my reply" } });
    fireEvent.click(screen.getByText("送出回覆"));

    await screen.findByText("已送出回覆");
    const post = spy.calls.find((c) => c.url === "/api/forms/7/responses");
    expect(post).toBeTruthy();
    expect(post!.body).toEqual({ payload: { answer: "my reply" } });
  });

  it("GET 失敗（404）→ 顯示靜態文字、不報錯、不洩漏原因", async () => {
    installFetch(() => apiError(404, "FORM_NOT_FOUND", "form not found"));
    renderPane(detail());

    await waitFor(() => expect(screen.getByText("STATIC FALLBACK")).toBeTruthy());
    expect(screen.queryByText(/form not found/i)).toBeNull();
    expect(screen.queryByText(/FORM_NOT_FOUND/)).toBeNull();
  });

  it("寄件備份 → 顯示表單管理（回覆內容與撤回），非寄件人不顯示", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const spy = installFetch((call) => {
      if (call.url === "/api/forms/9/responses" && call.method === "GET") {
        return {
          body: {
            form: {
              id: 9,
              template_id: 3,
              message_id: 1,
              subject: "Form subject",
              status: "open",
              due_at: null,
              schema: SCHEMA,
            },
            instances: [
              {
                id: 9,
                recipient: "bob@atwho.org",
                status: "submitted",
                due_at: null,
                created_at: 1_780_000_000_000,
                submitted_at: 1_780_000_100_000,
                payload: { answer: "hi" },
              },
              {
                id: 10,
                recipient: "carol@atwho.org",
                status: "open",
                due_at: null,
                created_at: 1_780_000_000_000,
                submitted_at: null,
                payload: null,
              },
            ],
            responses: [
              { instance_id: 9, recipient: "bob@atwho.org", payload: { answer: "hi" }, submitted_at: 1_780_000_100_000 },
            ],
          },
        };
      }
      if (call.url === "/api/forms/9/revoke" && call.method === "POST") {
        return { body: { ok: true, instance_id: 9, template_id: 3, revoked: 1 } };
      }
      return apiError(404, "FORM_NOT_FOUND", "form not found");
    });

    renderPane(detail({ folder: "sent", form_instance_id: 9 }));
    expect(await screen.findByText("bob@atwho.org")).toBeTruthy();
    expect(screen.getByText(/hi/)).toBeTruthy();

    fireEvent.click(screen.getByText("撤回表單"));
    await waitFor(() => expect(spy.calls.some((c) => c.url === "/api/forms/9/revoke")).toBe(true));
    expect(confirmSpy).toHaveBeenCalled();
  });
});
