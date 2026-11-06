/**
 * accountSettings.dom.spec.tsx — D29：host 收斂 ＋ 個人設置（docs/29 §4 T173–T176、T179）
 *
 * 在 jsdom 中**真的渲染** Header／FolderSidebar／AccountSettings：
 * - T173：`app.atwho.org` ＋ owner → 看不到地址管理／我的全部信箱／邀請碼／訪客／App Clients／「管理員」
 * - T174：`mail.atwho.org` ＋ owner → 全部看得到
 * - T175：`app.atwho.org` ＋ visitor → 只看得到自己的信箱（側欄只有收件匣／寄件備份／垃圾桶）
 * - T176：頭像選單第一項為「個人設置」，所有 host／角色都有
 * - T179：個人設置頁顯示 ID／地址／Google Email／別名入口；OAuth 帳號顯示「尚未綁定 Google」與「設定密碼」
 *
 * ⚠️ hostname 只影響**顯示**（docs/16 N3）；權限仍由後端判定。
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AccountSettings } from "../src/components/AccountSettings";
import { FolderSidebar } from "../src/components/FolderSidebar";
import { Header } from "../src/components/Header";
import type { AccountSettingsResponse, Session } from "../src/api/types";
import { APP_HOST, MAIL_HOST, loginModeFor, showsAdminConsole } from "../src/lib/hostMode";
import { installFetch, type FetchCall, type FakeReply } from "./dom-fetch";

const OWNER: Session = { kind: "owner", token: "owner-token", userId: 1, username: "owner" };
const VISITOR: Session = { kind: "mailbox", token: "visitor-token", addressId: 10, email: "itag@atwho.org" };

function renderShell(host: string, session: Session) {
  const mode = loginModeFor(host);
  const showAdminConsole = session.kind === "owner" && showsAdminConsole(mode);
  const publicMode = !showsAdminConsole(mode);
  const view = render(
    <div>
      <Header
        session={session}
        searchInput=""
        onSearchInput={vi.fn()}
        onSubmitSearch={vi.fn()}
        onCompose={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenAddresses={vi.fn()}
        onOpenInvites={vi.fn()}
        onOpenVisitors={vi.fn()}
        onOpenApps={vi.fn()}
        showAdminConsole={showAdminConsole}
        onLogout={vi.fn()}
        onToggleSidebar={vi.fn()}
      />
      <FolderSidebar
        session={session}
        currentPage="mail"
        folder="inbox"
        queryActive={false}
        counts={null}
        addressFilter={null}
        onSelectFolder={vi.fn()}
        onSelectAddress={vi.fn()}
        onOpenAddresses={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenInvites={vi.fn()}
        onOpenVisitors={vi.fn()}
        onOpenApps={vi.fn()}
        showAdminConsole={showAdminConsole}
        publicMode={publicMode}
        onCompose={vi.fn()}
        open={false}
      />
    </div>
  );
  return { ...view, showAdminConsole, publicMode };
}

/** 頭像選單（Header）的所有按鈕；`<details>` 關閉時內容仍在 DOM（jsdom） */
function menuButtons(container: HTMLElement): HTMLElement[] {
  const menu = container.querySelector(".menu-pop");
  if (!menu) throw new Error("找不到頭像選單");
  return within(menu as HTMLElement).getAllByRole("button");
}

describe("T173／T174：host 收斂（owner）", () => {
  it("T173 app.atwho.org＋owner：地址管理／我的全部信箱／管理主控台全部隱藏，且不顯示「管理員」", () => {
    const { container } = renderShell(APP_HOST, OWNER);

    expect(screen.queryAllByText("地址管理")).toHaveLength(0);
    expect(screen.queryByText("我的全部信箱")).toBeNull();
    expect(screen.queryAllByText("邀請碼管理")).toHaveLength(0);
    expect(screen.queryAllByText("訪客管理")).toHaveLength(0);
    expect(screen.queryAllByText(/App Clients/)).toHaveLength(0);
    expect(screen.queryByText("管理主控台")).toBeNull();

    // 頭像標籤改為「個人帳號」——不得出現「管理員」
    expect(screen.queryByText("管理員")).toBeNull();
    expect(screen.getByText("個人帳號")).toBeTruthy();

    // 收斂後側欄只有：收件匣／寄件備份／垃圾桶（＋撰寫按鈕＋個人設置）
    expect(screen.getByText("收件匣")).toBeTruthy();
    expect(screen.getByText("寄件備份")).toBeTruthy();
    expect(screen.getByText("垃圾桶")).toBeTruthy();
    expect(screen.queryByText("封存")).toBeNull();
    expect(screen.queryByText("垃圾郵件")).toBeNull();
    expect(screen.getAllByText("個人設置").length).toBeGreaterThan(0);

    // 選單中也不應出現任何管理按鈕
    const labels = menuButtons(container).map((b) => b.textContent ?? "");
    expect(labels.some((t) => t.includes("地址管理"))).toBe(false);
    expect(labels.some((t) => t.includes("邀請碼"))).toBe(false);
    expect(labels.some((t) => t.includes("訪客"))).toBe(false);
    expect(labels.some((t) => t.includes("App Clients"))).toBe(false);
  });

  it("T174 mail.atwho.org＋owner：地址管理／我的全部信箱／管理主控台與「管理員」都看得到", () => {
    const { container } = renderShell(MAIL_HOST, OWNER);

    expect(screen.getAllByText("地址管理").length).toBeGreaterThan(0);
    expect(screen.getByText("我的全部信箱")).toBeTruthy();
    expect(screen.getAllByText("邀請碼管理").length).toBeGreaterThan(0);
    expect(screen.getAllByText("訪客管理").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/App Clients/).length).toBeGreaterThan(0);
    expect(screen.getByText("管理主控台")).toBeTruthy();
    expect(screen.getByText("管理員")).toBeTruthy();

    const labels = menuButtons(container).map((b) => b.textContent ?? "");
    expect(labels.some((t) => t.includes("地址管理"))).toBe(true);
  });
});

describe("T175：app＋visitor 只看得到自己的信箱", () => {
  it("不顯示地址篩選／我的全部信箱／管理功能", () => {
    renderShell(APP_HOST, VISITOR);

    expect(screen.queryAllByText("地址管理")).toHaveLength(0);
    expect(screen.queryByText("我的全部信箱")).toBeNull();
    expect(screen.queryAllByText("邀請碼管理")).toHaveLength(0);
    expect(screen.queryAllByText("訪客管理")).toHaveLength(0);
    expect(screen.queryAllByText(/App Clients/)).toHaveLength(0);

    // 側欄只剩收件匣／寄件備份／垃圾桶（＋撰寫／個人設置）
    expect(screen.getByText("收件匣")).toBeTruthy();
    expect(screen.getByText("寄件備份")).toBeTruthy();
    expect(screen.getByText("垃圾桶")).toBeTruthy();
    expect(screen.queryByText("封存")).toBeNull();
    expect(screen.queryByText("垃圾郵件")).toBeNull();
  });
});

describe("T176：頭像選單第一項是「個人設置」", () => {
  const cases: Array<[string, Session]> = [
    [APP_HOST, OWNER],
    [MAIL_HOST, OWNER],
    [APP_HOST, VISITOR],
    ["localhost", VISITOR],
  ];

  it.each(cases)("%s／%s 都有且為第一項", (host, session) => {
    const { container } = renderShell(host, session);
    const buttons = menuButtons(container);
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons[0]!.textContent).toContain("個人設置");
    // owner 2026-11-06：「撰寫新信」不放在頭像選單（頂部列／側欄已有撰寫按鈕）
    expect(buttons.some((b) => (b.textContent ?? "").includes("撰寫新信"))).toBe(false);
  });
});

// ── T179：個人設置頁內容 ──

function settingsFetch(body: AccountSettingsResponse, onCall?: (call: FetchCall) => void) {
  return installFetch((call) => {
    onCall?.(call);
    if (call.url === "/api/account/settings" && call.method === "GET") return { body };
    if (call.url === "/api/account/password" && call.method === "POST") return { body: { ok: true } } as FakeReply;
    // D29：別名管理已內嵌在個人設置頁 → 需要別名與地址清單
    if (call.url === "/api/email-aliases" && call.method === "GET") return { body: { aliases: [] } } as FakeReply;
    if (call.url === "/api/email-addresses" && call.method === "GET") return { body: { addresses: [] } } as FakeReply;
    throw new Error(`未預期的請求：${call.method} ${call.url}`);
  });
}

const VISITOR_SETTINGS: AccountSettingsResponse = {
  user_id: 2,
  username: "itag",
  role: "visitor",
  provider: "local",
  contact_email: "ulhome@gmail.com",
  has_password: 1,
  addresses: [
    { id: 10, email: "itag@atwho.org", status: "active", daily_send_quota: 5, sent_today: 2 },
  ],
};

function renderSettings() {
  render(
    <AccountSettings
      session={{ kind: "owner", token: "t", userId: 2, username: "itag" }}
      onBack={vi.fn()}
      onLogout={vi.fn()}
      onToast={vi.fn()}
      onAliasChanged={vi.fn()}
    />
  );
}

describe("T179：個人設置頁", () => {
  it("顯示 AtWhoMail ID／地址／Google Email／角色／登入方式／配額／別名入口", async () => {
    settingsFetch(VISITOR_SETTINGS);
    renderSettings();

    expect(await screen.findByText("itag")).toBeTruthy();
    expect(screen.getAllByText("itag@atwho.org").length).toBeGreaterThan(0);
    expect(screen.getByText("ulhome@gmail.com")).toBeTruthy();
    expect(screen.getByText("一般使用者")).toBeTruthy();
    // owner 2026-11-05：「登入方式」改名為「備用電子郵件」（用途：找回密碼）
    expect(screen.getAllByText("備用電子郵件").length).toBeGreaterThan(0);
    expect(screen.getByText("用於「忘記密碼」時寄送重設連結。")).toBeTruthy();
    expect(screen.queryByText("登入方式")).toBeNull();
    expect(screen.queryByText("Google 帳號")).toBeNull();
    expect(screen.getByText(/今日已寄 2 \/ 5/)).toBeTruthy();

    // D29／D31：別名管理內嵌（不再有「管理別名」按鈕）＋暱稱需自行建立、Token 系統自動產生
    expect(await screen.findByRole("button", { name: "建立" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /建立暱稱別名/ })).toBeTruthy();
    expect(screen.getByText("暱稱別名需自行建立（每帳號最多 1 個）；Token 由系統在帳號建立時自動產生。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "管理別名" })).toBeNull();

    // 有密碼 → 變更密碼表單（需要目前密碼）
    expect(screen.getByText("變更密碼")).toBeTruthy();
    expect(screen.getByPlaceholderText("目前的密碼")).toBeTruthy();
  });

  it("OAuth 帳號：顯示「尚未綁定 Google」與「設定密碼」（不需目前密碼）", async () => {
    settingsFetch({
      ...VISITOR_SETTINGS,
      username: "gmailuser",
      provider: "google",
      contact_email: null,
      has_password: 0,
      addresses: [
        { id: 30, email: "gmailuser@atwho.org", status: "active", daily_send_quota: 5, sent_today: 0 },
      ],
    });
    renderSettings();

    expect(await screen.findByText("（未提供）")).toBeTruthy();
    expect(screen.queryByText("尚未綁定 Google")).toBeNull();
    expect(screen.queryByText("登入方式")).toBeNull();
    expect(screen.getAllByText("備用電子郵件").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "設定密碼" })).toBeTruthy();
    expect(screen.queryByPlaceholderText("目前的密碼")).toBeNull();
  });

  it("無密碼者設定密碼：只送 new_password（免 current），成功後顯示需重新登入", async () => {
    const calls: FetchCall[] = [];
    settingsFetch(
      {
        ...VISITOR_SETTINGS,
        provider: "google",
        contact_email: "ulhome@gmail.com",
        has_password: 0,
      },
      (call) => calls.push(call)
    );
    renderSettings();

    fireEvent.change(await screen.findByPlaceholderText("新密碼（至少 8 個字元）"), {
      target: { value: "brand-new-password" },
    });
    fireEvent.change(screen.getByPlaceholderText("確認新密碼"), {
      target: { value: "brand-new-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "設定密碼" }));

    expect(await screen.findByText("密碼已更新")).toBeTruthy();
    const post = calls.find((c) => c.url === "/api/account/password" && c.method === "POST");
    expect(post?.body).toEqual({ new_password: "brand-new-password" });
  });
});
