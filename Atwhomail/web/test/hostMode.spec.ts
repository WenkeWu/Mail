/**
 * D1（docs/16 §3）— hostname → 登入頁顯示模式 / API 基底
 *
 * 對應 docs/16 §6 的 T7（前端分頁渲染邏輯）。這裡測的是**純函式**（實際 JSX 渲染需 DOM 測試環境，
 * 本 repo 尚無前端測試 runner → 僅覆蓋判定邏輯，並在檔內註明）。
 * ⚠️ 這些函式只影響 UI 與請求路徑，**不影響權限判定**（N3）。
 */
import { describe, expect, it } from "vitest";
import { APP_HOST, MAIL_HOST, loginModeFor, usesSameOriginApi } from "../src/lib/hostMode";

describe("T7：hostname → 登入頁顯示模式", () => {
  it("mail.atwho.org → admin（只顯示管理員登入）", () => {
    expect(loginModeFor(MAIL_HOST)).toBe("admin");
  });

  it("app.atwho.org → public（信箱登入＋註冊，不含管理員登入）", () => {
    expect(loginModeFor(APP_HOST)).toBe("public");
  });

  it("其他 hostname → all（三分頁，開發／預覽方便）", () => {
    expect(loginModeFor("localhost")).toBe("all");
    expect(loginModeFor("127.0.0.1")).toBe("all");
    expect(loginModeFor("atwhomail-web.pages.dev")).toBe("all");
    expect(loginModeFor("")).toBe("all");
  });

  it("大小寫不敏感（Hostname 可能被大寫化）", () => {
    expect(loginModeFor("MAIL.ATWHO.ORG")).toBe("admin");
    expect(loginModeFor("App.AtWho.Org")).toBe("public");
  });

  it("不會被後綴偽造騙過（evil-mail.atwho.org／mail.atwho.org.evil.com）", () => {
    expect(loginModeFor("evil-mail.atwho.org")).toBe("all");
    expect(loginModeFor("mail.atwho.org.evil.com")).toBe("all");
  });

  it("D3：只有 mail.atwho.org 走同源 /api（其餘維持原行為）", () => {
    expect(usesSameOriginApi(MAIL_HOST)).toBe(true);
    expect(usesSameOriginApi(APP_HOST)).toBe(false);
    expect(usesSameOriginApi("localhost")).toBe(false);
    expect(usesSameOriginApi("atwhomail-web.pages.dev")).toBe(false);
  });
});
