/**
 * localeSelectors.dom.spec.tsx — D32：登入頁的國家／語言選擇器
 *
 * 預設值依業界作法：已存偏好 → 瀏覽器語言 → 國家預設 → 繁中。
 * 這裡以 localStorage 固定繁中／台灣，再手動切換成 English／US，
 * 確認畫面文字、<html lang> 與偏好持久化都正確。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LoginPage } from "../src/components/LoginPage";
import { I18nProvider } from "../src/i18n";
import { installFetch } from "./dom-fetch";

function renderLogin(geo?: { country: string | null }) {
  const spy = installFetch((call) => {
    if (call.url === "/api/auth/registration-mode") {
      return { body: { mode: "email_verify", turnstileSiteKey: null } };
    }
    if (call.url === "/api/geo") {
      return { body: geo ?? { country: null } };
    }
    throw new Error(`未預期的請求：${call.method} ${call.url}`);
  });
  const view = render(
    <I18nProvider>
      <LoginPage notice={null} onLogin={vi.fn()} mode="public" />
    </I18nProvider>
  );
  return { ...view, spy };
}

function byId(id: string): HTMLSelectElement {
  return document.getElementById(id) as HTMLSelectElement;
}

describe("D32：登入頁國家／語言選擇", () => {
  it("預設繁中／台灣；切換 English 後畫面與 html lang 立即更新", async () => {
    localStorage.setItem("atwhomail.language", "zh-TW");
    localStorage.setItem("atwhomail.country", "TW");
    renderLogin();

    expect(screen.getByText("虛擬地址收發信")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "信箱登入" })).toBeTruthy();

    const language = screen.getByLabelText("語言") as HTMLSelectElement;
    expect(language.value).toBe("zh-TW");
    // 10 種語言（native names）
    expect(language.options).toHaveLength(10);
    expect(Array.from(language.options).map((o) => o.textContent)).toEqual(
      expect.arrayContaining(["English", "Español", "Deutsch", "日本語", "Français", "Português", "Русский", "Italiano", "简体中文", "繁體中文"])
    );
    fireEvent.change(language, { target: { value: "en" } });

    expect(await screen.findByText("Virtual address mail")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Mailbox sign-in" })).toBeTruthy();
    await waitFor(() => expect(document.documentElement.lang).toBe("en"));
    expect(localStorage.getItem("atwhomail.language")).toBe("en");
  });

  it("切換國家只改變區域偏好，不強制改語言；國家名稱依語言顯示", async () => {
    localStorage.setItem("atwhomail.language", "en");
    localStorage.setItem("atwhomail.country", "TW");
    renderLogin();

    const country = screen.getByLabelText("Country") as HTMLSelectElement;
    expect(country.value).toBe("TW");
    // 英文模式下國名為英文；只列 10 種語系的主要國家
    expect(screen.getByRole("option", { name: "United States" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Japan" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Thailand" })).toBeNull();

    fireEvent.change(country, { target: { value: "US" } });
    expect(localStorage.getItem("atwhomail.country")).toBe("US");
    expect(country.value).toBe("US");
    // 語言仍為 English（國家不強制改語言）
    expect(screen.getByLabelText("Language")).toBeTruthy();
    expect(document.documentElement.lang).toBe("en");
  });

  it("從未手動選語言時，換國家會套用該國第一語言（不寫入語言偏好）", () => {
    localStorage.removeItem("atwhomail.language");
    localStorage.setItem("atwhomail.country", "TW");
    renderLogin();

    fireEvent.change(byId("locale-country"), { target: { value: "JP" } });
    expect(byId("locale-country").value).toBe("JP");
    expect(byId("locale-language").value).toBe("ja");
    expect(localStorage.getItem("atwhomail.country")).toBe("JP");
    expect(localStorage.getItem("atwhomail.language")).toBeNull();
  });

  it("時區判斷不到 → 呼叫 /api/geo，並用該國第一語言；不寫入手動偏好", async () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockReturnValue({
      timeZone: "UTC",
      locale: "en-US",
      calendar: "gregory",
      numberingSystem: "latn",
    } as Intl.ResolvedDateTimeFormatOptions);
    localStorage.removeItem("atwhomail.language");
    localStorage.removeItem("atwhomail.country");

    const { spy } = renderLogin({ country: "JP" });

    await waitFor(() => expect(byId("locale-country").value).toBe("JP"));
    expect(byId("locale-language").value).toBe("ja");
    expect(spy.calls.some((c) => c.url === "/api/geo")).toBe(true);
    // 自動判斷不是「手動選擇」，不寫入 localStorage
    expect(localStorage.getItem("atwhomail.language")).toBeNull();
    expect(localStorage.getItem("atwhomail.country")).toBeNull();
  });
});
