/**
 * systems.dom.spec.tsx — D37 系統入口與「上次系統」
 *
 * 純函式／localStorage 測試（jsdom）；不涉及實際導轉。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  INTERNAL_SYSTEMS,
  LAST_SYSTEM_STORAGE_KEY,
  clearLastSystem,
  getLastSystem,
  isSystemId,
  setLastSystem,
  switchTargetFor,
  systemById,
} from "../src/lib/systems";

beforeEach(() => {
  localStorage.clear();
});

describe("D37：系統定義", () => {
  it("包含 Mail／Form／Now／Chat／Flow，且 app_id 與 callback 固定", () => {
    expect(INTERNAL_SYSTEMS.map((s) => s.id)).toEqual(["mail", "form", "now", "chat", "flow"]);
    expect(INTERNAL_SYSTEMS.map((s) => s.name)).toEqual(["Mail", "Form", "Now", "Chat", "Flow"]);
    expect(systemById("form")).toMatchObject({
      appId: "form",
      url: "https://form.atwho.org",
      redirectUri: "https://form.atwho.org/api/auth/atwho/callback",
    });
    expect(systemById("now")?.redirectUri).toBe("https://now.atwho.org/api/auth/atwho/callback");
    expect(systemById("chat")?.redirectUri).toBe("https://chat.atwho.org/api/auth/atwho/callback");
    expect(systemById("flow")).toMatchObject({
      appId: "flow",
      url: "https://flow.atwho.org",
      redirectUri: "https://flow.atwho.org/api/auth/atwho/callback",
    });
    // Mail 本身是入口，不需要 app client
    expect(systemById("mail")?.appId).toBeNull();
  });

  it("isSystemId 只接受五個系統 ID", () => {
    for (const id of ["mail", "form", "now", "chat", "flow"]) expect(isSystemId(id)).toBe(true);
    expect(isSystemId("demo")).toBe(false);
    expect(isSystemId(null)).toBe(false);
    expect(isSystemId("")).toBe(false);
  });
});

describe("D37：上次系統", () => {
  it("可讀寫與清除；不合法值回 null", () => {
    expect(getLastSystem()).toBeNull();
    setLastSystem("form");
    expect(localStorage.getItem(LAST_SYSTEM_STORAGE_KEY)).toBe("form");
    expect(getLastSystem()).toBe("form");
    clearLastSystem();
    expect(getLastSystem()).toBeNull();

    localStorage.setItem(LAST_SYSTEM_STORAGE_KEY, "demo");
    expect(getLastSystem()).toBeNull();
  });

  it("只有公開入口且上次系統不是 Mail 時才自動導轉", () => {
    expect(switchTargetFor("public", "form")).toMatchObject({ id: "form", appId: "form" });
    expect(switchTargetFor("public", "now")).toMatchObject({ id: "now", appId: "now" });
    expect(switchTargetFor("public", "chat")).toMatchObject({ id: "chat", appId: "chat" });
    expect(switchTargetFor("public", "flow")).toMatchObject({ id: "flow", appId: "flow" });
    expect(switchTargetFor("public", "mail")).toBeNull();
    expect(switchTargetFor("public", null)).toBeNull();
    expect(switchTargetFor("admin", "form")).toBeNull();
    expect(switchTargetFor("all", "form")).toBeNull();
  });
});
