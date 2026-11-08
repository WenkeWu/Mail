/**
 * localeSelectors.dom.spec.tsx — D32：登入頁的國家／語言選擇器
 *
 * 預設值依業界作法：已存偏好 → 時區 → IP 國別 → 該國第一語言。
 * 國家選單**依目前語言過濾**：只列該語言為第一語言的國家。
 * 這裡以 localStorage 固定繁中／台灣，再手動切換語言，
 * 確認畫面文字、國家清單、<html lang> 與偏好持久化都正確。
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

function optionValues(id: string): string[] {
  return Array.from(byId(id).options)
    .map((o) => o.value)
    .sort();
}

describe("D32：登入頁國家／語言選擇", () => {
  it("預設繁中／台灣；切換 English 後語言、國家、畫面與 html lang 立即更新", async () => {
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
    // 繁中＝台／港／澳
    expect(byId("locale-country").value).toBe("TW");
    expect(optionValues("locale-country")).toEqual(["HK", "MO", "TW"]);

    fireEvent.change(language, { target: { value: "en" } });

    expect(await screen.findByText("Virtual address mail")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Mailbox sign-in" })).toBeTruthy();
    await waitFor(() => expect(document.documentElement.lang).toBe("en"));
    expect(localStorage.getItem("atwhomail.language")).toBe("en");
    // 國家自動切到該語言的第一個國家（English→US），清單只剩英語系國家
    await waitFor(() => expect(byId("locale-country").value).toBe("US"));
    expect(optionValues("locale-country")).toEqual(["AU", "CA", "GB", "IE", "NZ", "SG", "US"]);
    expect(localStorage.getItem("atwhomail.country")).toBe("US");
  });

  it("國家選單只列目前語言為第一語言的國家；切換國家只改區域偏好", async () => {
    localStorage.setItem("atwhomail.language", "en");
    localStorage.setItem("atwhomail.country", "US");
    renderLogin();

    const country = screen.getByLabelText("Country") as HTMLSelectElement;
    expect(country.value).toBe("US");
    // 英文模式下國名為英文；只列英語系國家
    expect(screen.getByRole("option", { name: "United States" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Japan" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Taiwan" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Thailand" })).toBeNull();

    fireEvent.change(country, { target: { value: "GB" } });
    expect(country.value).toBe("GB");
    expect(localStorage.getItem("atwhomail.country")).toBe("GB");
    // 語言仍為 English
    expect(byId("locale-language").value).toBe("en");
    expect(document.documentElement.lang).toBe("en");
  });

  it("切換語言時，國家自動改為該語言的第一個國家並保存", () => {
    localStorage.setItem("atwhomail.language", "zh-TW");
    localStorage.setItem("atwhomail.country", "TW");
    renderLogin();

    fireEvent.change(byId("locale-language"), { target: { value: "ja" } });
    expect(byId("locale-language").value).toBe("ja");
    expect(byId("locale-country").value).toBe("JP");
    expect(optionValues("locale-country")).toEqual(["JP"]);
    expect(localStorage.getItem("atwhomail.language")).toBe("ja");
    expect(localStorage.getItem("atwhomail.country")).toBe("JP");

    // 簡中＝只有中國
    fireEvent.change(byId("locale-language"), { target: { value: "zh-CN" } });
    expect(byId("locale-country").value).toBe("CN");
    expect(optionValues("locale-country")).toEqual(["CN"]);
    expect(localStorage.getItem("atwhomail.country")).toBe("CN");
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
    expect(optionValues("locale-country")).toEqual(["JP"]);
    expect(spy.calls.some((c) => c.url === "/api/geo")).toBe(true);
    // 自動判斷不是「手動選擇」，不寫入 localStorage
    expect(localStorage.getItem("atwhomail.language")).toBeNull();
    expect(localStorage.getItem("atwhomail.country")).toBeNull();
  });
});
