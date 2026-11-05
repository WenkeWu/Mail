/**
 * D27 前端純函式（docs/28 §6）：Google 起始網址、callback fragment、reset token。
 * 留在 workerd pool（純函式，不需要 DOM）。
 */
import { describe, expect, it } from "vitest";
import {
  buildGoogleStartUrl,
  getResetToken,
  parseOAuthFragment,
  takeOAuthSession,
} from "../src/lib/oauth";

describe("D27：buildGoogleStartUrl", () => {
  it("固定導向 auth.atwho.org 的 start，redirect_after 正確編碼", () => {
    const url = new URL(buildGoogleStartUrl("/inbox?tab=all"));
    expect(`${url.origin}${url.pathname}`).toBe("https://auth.atwho.org/api/auth/oauth/google/start");
    expect(url.searchParams.get("redirect_after")).toBe("/inbox?tab=all");
  });

  it("空路徑 → /", () => {
    expect(new URL(buildGoogleStartUrl("")).searchParams.get("redirect_after")).toBe("/");
  });
});

describe("D27：parseOAuthFragment", () => {
  it("owner session", () => {
    expect(
      parseOAuthFragment("#oauth_token=tok&oauth_session=owner&oauth_user_id=7&oauth_username=itag")
    ).toEqual({ kind: "owner", token: "tok", userId: 7, username: "itag" });
  });

  it("mailbox session", () => {
    expect(
      parseOAuthFragment("#oauth_token=tok&oauth_session=mailbox&oauth_address_id=3&oauth_email=a@atwho.org")
    ).toEqual({ kind: "mailbox", token: "tok", addressId: 3, email: "a@atwho.org" });
  });

  it("缺欄位／未知 session／空 hash → null（不儲存半殘 session）", () => {
    expect(parseOAuthFragment("")).toBeNull();
    expect(parseOAuthFragment("#oauth_token=tok&oauth_session=owner")).toBeNull();
    expect(parseOAuthFragment("#oauth_token=tok&oauth_session=user&oauth_user_id=1&oauth_username=x")).toBeNull();
    expect(parseOAuthFragment("#oauth_session=mailbox&oauth_address_id=3&oauth_email=a@atwho.org")).toBeNull();
  });
});

describe("D27：takeOAuthSession", () => {
  it("讀取後清除 fragment（token 不留在網址列）", () => {
    const replaced: string[] = [];
    const win = {
      location: { hash: "#oauth_token=tok&oauth_session=mailbox&oauth_address_id=3&oauth_email=a@atwho.org", pathname: "/", search: "?x=1" },
      history: {
        replaceState: (_data: unknown, _unused: string, url?: string) => {
          replaced.push(url ?? "");
        },
      },
    };
    expect(takeOAuthSession(win)).toMatchObject({ kind: "mailbox", addressId: 3 });
    expect(replaced).toEqual(["/?x=1"]);
  });

  it("無 fragment → null，不動 history", () => {
    let called = false;
    const win = {
      location: { hash: "", pathname: "/", search: "" },
      history: {
        replaceState: () => {
          called = true;
        },
      },
    };
    expect(takeOAuthSession(win)).toBeNull();
    expect(called).toBe(false);
  });
});

describe("D27：getResetToken", () => {
  it("讀取 ?reset=；空白視為沒有", () => {
    expect(getResetToken("?reset=abc123")).toBe("abc123");
    expect(getResetToken("?reset=")).toBeNull();
    expect(getResetToken("")).toBeNull();
  });
});
