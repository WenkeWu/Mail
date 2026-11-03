/**
 * mailSelection.dom.spec.tsx — docs/19 D19-2 前端複選／批次工具列
 *
 * 對應 docs/19 §3：
 * - **T69** Ctrl／Cmd 切換選取
 * - **T70** Shift 範圍選取
 * - **T74** 切換資料夾／地址（scopeKey）清空選取
 * 另驗證工具列依資料夾顯示可用動作、Ctrl/Cmd+A 全選、aria-selected。
 *
 * ⚠️ 這裡只驗**前端行為**；批次端點（T71／T72／T73）在
 * `packages/api/test/mail-delete-semantics.spec.ts` 以真實 D1／R2 驗證。
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { MailListItem } from "../src/api/types";
import { MailSelectionToolbar } from "../src/components/MailSelectionToolbar";
import { MessageList } from "../src/components/MessageList";
import { useMailSelection } from "../src/hooks/useMailSelection";

function item(id: number): MailListItem {
  return {
    id,
    from: `sender${id}@example.com`,
    subject: `subject ${id}`,
    text_preview: `preview ${id}`,
    received_at: 1_780_000_000_000 + id,
    read: false,
    has_attachments: false,
    folder: "inbox",
    origin: "external",
    kind: "normal",
    delivery_scope: "external",
  };
}

const ITEMS = [item(1), item(2), item(3), item(4)];

interface HarnessProps {
  items?: MailListItem[];
  scopeKey?: string;
  folder?: string;
  onTrash?: () => void;
  onPurge?: () => void;
}

/** 真實的 hook ＋ MessageList ＋ 工具列組合（不碰網路） */
function Harness({
  items = ITEMS,
  scopeKey = "inbox|",
  folder = "inbox",
  onTrash = () => {},
  onPurge = () => {},
}: HarnessProps) {
  const { selectedIds, select, selectAll, clear } = useMailSelection(items, scopeKey);
  const [opened, setOpened] = useState<number | null>(null);
  return (
    <div>
      <span data-testid="opened">{opened ?? "none"}</span>
      <MailSelectionToolbar
        count={selectedIds.size}
        folder={folder}
        onTrash={onTrash}
        onRestore={() => {}}
        onPurge={onPurge}
        onEmptyTrash={() => {}}
        onMarkRead={() => {}}
        onClear={clear}
      />
      <MessageList
        items={items}
        loading={false}
        loadingMore={false}
        error={null}
        nextCursor={null}
        selectedIds={selectedIds}
        showFolderChip={false}
        query=""
        onLoadMore={() => {}}
        onSelect={(id, event) => {
          if (select(id, event)) setOpened(id);
        }}
        onToggleSelect={() => {}}
        onSelectAll={selectAll}
      />
    </div>
  );
}

const rows = () => screen.getAllByRole("option");
const selectedFlags = () => rows().map((r) => r.getAttribute("aria-selected"));

describe("T69：Ctrl／Cmd 切換選取（不開信）", () => {
  it("Ctrl+點擊逐封切換；再點一次取消", () => {
    render(<Harness />);
    fireEvent.click(rows()[0]!, { ctrlKey: true });
    expect(selectedFlags()).toEqual(["true", "false", "false", "false"]);
    expect(screen.getByText("已選 1 封")).toBeTruthy();
    expect(screen.getByTestId("opened").textContent).toBe("none");

    fireEvent.click(rows()[1]!, { ctrlKey: true });
    expect(selectedFlags()).toEqual(["true", "true", "false", "false"]);
    expect(screen.getByText("已選 2 封")).toBeTruthy();

    fireEvent.click(rows()[0]!, { ctrlKey: true });
    expect(selectedFlags()).toEqual(["false", "true", "false", "false"]);
    expect(screen.getByText("已選 1 封")).toBeTruthy();
    expect(screen.getByTestId("opened").textContent).toBe("none");
  });

  it("Cmd（metaKey）同樣可切換", () => {
    render(<Harness />);
    fireEvent.click(rows()[2]!, { metaKey: true });
    expect(selectedFlags()).toEqual(["false", "false", "true", "false"]);
    expect(screen.getByTestId("opened").textContent).toBe("none");
  });

  it("一般點擊 → 單選並開信（清掉其他選取）", () => {
    render(<Harness />);
    fireEvent.click(rows()[0]!, { ctrlKey: true });
    fireEvent.click(rows()[1]!, { ctrlKey: true });
    fireEvent.click(rows()[2]!);
    expect(selectedFlags()).toEqual(["false", "false", "true", "false"]);
    expect(screen.getByTestId("opened").textContent).toBe("3");
  });
});

describe("T70：Shift 範圍連選", () => {
  it("先點第 1 封，再 Shift+點第 4 封 → 連選 1–4", () => {
    render(<Harness />);
    fireEvent.click(rows()[0]!);
    fireEvent.click(rows()[3]!, { shiftKey: true });
    expect(selectedFlags()).toEqual(["true", "true", "true", "true"]);
    expect(screen.getByText("已選 4 封")).toBeTruthy();
    // Shift 點擊不開新信（仍停留在第 1 封）
    expect(screen.getByTestId("opened").textContent).toBe("1");
  });

  it("反向連選（anchor 在下方）", () => {
    render(<Harness />);
    fireEvent.click(rows()[3]!);
    fireEvent.click(rows()[1]!, { shiftKey: true });
    expect(selectedFlags()).toEqual(["false", "true", "true", "true"]);
    expect(screen.getByText("已選 3 封")).toBeTruthy();
  });

  it("沒有 anchor 時 Shift+點擊只選該封", () => {
    render(<Harness />);
    fireEvent.click(rows()[2]!, { shiftKey: true });
    expect(selectedFlags()).toEqual(["false", "false", "true", "false"]);
  });
});

describe("Ctrl／Cmd+A 全選（清單聚焦時）", () => {
  it("listbox 收到 Ctrl+A → 全選", () => {
    render(<Harness />);
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "a", ctrlKey: true });
    expect(selectedFlags()).toEqual(["true", "true", "true", "true"]);
    expect(screen.getByText("已選 4 封")).toBeTruthy();
  });

  it("Cmd+A 亦同", () => {
    render(<Harness />);
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "a", metaKey: true });
    expect(selectedFlags()).toEqual(["true", "true", "true", "true"]);
  });

  it("清單可聚焦且 aria-multiselectable", () => {
    render(<Harness />);
    const listbox = screen.getByRole("listbox");
    expect(listbox.getAttribute("aria-multiselectable")).toBe("true");
    expect(listbox.getAttribute("tabindex")).toBe("0");
  });
});

describe("T74：切換資料夾／地址（scopeKey）清空選取", () => {
  it("scopeKey 改變 → 選取歸零、工具列消失", () => {
    const { rerender } = render(<Harness scopeKey="inbox|" />);
    fireEvent.click(rows()[0]!, { ctrlKey: true });
    fireEvent.click(rows()[1]!, { ctrlKey: true });
    expect(screen.getByText("已選 2 封")).toBeTruthy();

    rerender(<Harness scopeKey="trash|" folder="trash" />);
    expect(screen.queryByText(/已選 \d+ 封/)).toBeNull();
    expect(selectedFlags()).toEqual(["false", "false", "false", "false"]);
  });

  it("只改地址過濾也會清空", () => {
    const { rerender } = render(<Harness scopeKey="inbox|" />);
    fireEvent.click(rows()[1]!, { ctrlKey: true });
    expect(screen.getByText("已選 1 封")).toBeTruthy();
    rerender(<Harness scopeKey="inbox|7" />);
    expect(screen.queryByText(/已選 \d+ 封/)).toBeNull();
  });
});

describe("批次工具列：依資料夾顯示可用動作", () => {
  it("垃圾桶以外：移至垃圾桶／標為已讀", () => {
    const onTrash = vi.fn();
    const onMarkRead = vi.fn();
    render(
      <MailSelectionToolbar
        count={2}
        folder="inbox"
        onTrash={onTrash}
        onRestore={() => {}}
        onPurge={() => {}}
        onEmptyTrash={() => {}}
        onMarkRead={onMarkRead}
        onClear={() => {}}
      />
    );
    expect(screen.getByText("已選 2 封")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "還原" })).toBeNull();
    expect(screen.queryByRole("button", { name: "永久刪除" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "移至垃圾桶" }));
    fireEvent.click(screen.getByRole("button", { name: "標為已讀" }));
    expect(onTrash).toHaveBeenCalledTimes(1);
    expect(onMarkRead).toHaveBeenCalledTimes(1);
  });

  it("垃圾桶：還原／永久刪除（永久刪除需二次確認由上層負責）", () => {
    const onRestore = vi.fn();
    const onPurge = vi.fn();
    render(
      <MailSelectionToolbar
        count={3}
        folder="trash"
        onTrash={() => {}}
        onRestore={onRestore}
        onPurge={onPurge}
        onEmptyTrash={() => {}}
        onMarkRead={() => {}}
        onClear={() => {}}
      />
    );
    expect(screen.queryByRole("button", { name: "移至垃圾桶" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "還原" }));
    fireEvent.click(screen.getByRole("button", { name: "永久刪除" }));
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onPurge).toHaveBeenCalledTimes(1);
  });

  it("沒有選取 → 不渲染工具列", () => {
    const { container } = render(
      <MailSelectionToolbar
        count={0}
        folder="inbox"
        onTrash={() => {}}
        onRestore={() => {}}
        onPurge={() => {}}
        onEmptyTrash={() => {}}
        onMarkRead={() => {}}
        onClear={() => {}}
      />
    );
    expect(container.innerHTML).toBe("");
  });
});
