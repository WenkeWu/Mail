/**
 * D26：`?app=`／`?redirect_uri=` 參數解析（docs/27 §5）。
 *
 * ⚠️ 這裡只測「前端是否發起轉交」與錯誤提示；app／redirect 的合法性仍由後端 app-login 判定。
 */
import { describe, expect, it } from "vitest";
import { parseAppLoginQuery } from "../src/lib/appLogin";

describe("parseAppLoginQuery", () => {
  it("完全沒帶參數 → active:false（不影響既有 register／invite 行為）", () => {
    expect(parseAppLoginQuery("")).toEqual({ active: false, app: null, redirectUri: null, error: null });
    expect(parseAppLoginQuery("?register=1")).toEqual({
      active: false,
      app: null,
      redirectUri: null,
      error: null,
    });
    expect(parseAppLoginQuery("?invite=abc")).toEqual({
      active: false,
      app: null,
      redirectUri: null,
      error: null,
    });
  });

  it("app ＋ redirect_uri → active:true 並去除前後空白", () => {
    const q = parseAppLoginQuery(
      "?app=mycrm&redirect_uri=https%3A%2F%2Fcrm.example.com%2Fcb"
    );
    expect(q).toEqual({
      active: true,
      app: "mycrm",
      redirectUri: "https://crm.example.com/cb",
      error: null,
    });
  });

  it("只帶其中一個 → error（不導向）", () => {
    expect(parseAppLoginQuery("?app=mycrm").error).toContain("不完整");
    expect(parseAppLoginQuery("?redirect_uri=https%3A%2F%2Fcrm.example.com%2Fcb").error).toContain(
      "不完整"
    );
    expect(parseAppLoginQuery("?app=&redirect_uri=").active).toBe(false);
  });

  it("app 格式錯誤 → error", () => {
    for (const app of ["MyCRM", "1crm", "a", "crm_app", "x".repeat(33)]) {
      const q = parseAppLoginQuery(
        `?app=${encodeURIComponent(app)}&redirect_uri=${encodeURIComponent("https://crm.example.com/cb")}`
      );
      expect(q.active).toBe(true);
      expect(q.error).toContain("app 參數格式錯誤");
    }
  });

  it("redirect_uri 不是完整 http(s) 網址 → error；http(s) 皆可（後端仍會比對白名單）", () => {
    const bad = parseAppLoginQuery(`?app=mycrm&redirect_uri=${encodeURIComponent("/cb")}`);
    expect(bad.error).toContain("http(s)");
    expect(bad.error).toBeTruthy();

    const https = parseAppLoginQuery(
      `?app=mycrm&redirect_uri=${encodeURIComponent("https://crm.example.com/cb")}`
    );
    expect(https.error).toBeNull();
    const http = parseAppLoginQuery(
      `?app=mycrm&redirect_uri=${encodeURIComponent("http://localhost:3000/cb")}`
    );
    expect(http.error).toBeNull();
  });
});
