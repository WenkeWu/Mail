/**
 * D25 別名 Phase 1 的前端規則（純函式）。
 * 對應 docs/25 §7：T111（名字驗證）、T117（外部 → 別名）、T118（內部 → 真實地址）。
 *
 * 這支測試留在 workerd 測試池（根目錄 vitest include `web/test/**\/*.spec.ts`），
 * 不需要 DOM；元件的渲染測試另見 `aliasManager.dom.spec.tsx`。
 */
import { describe, expect, it } from "vitest";
import {
  ALIAS_RESERVED_NAMES,
  aliasPreview,
  isInternalAddress,
  normalizeAliasInput,
  replyFromFor,
  validateAliasName,
} from "../src/lib/alias";

const ALIASES = [
  { alias_address: "luke001@atwho.org", target_email: "alice@atwho.org", status: "active" as const },
  { alias_address: "old001@atwho.org", target_email: "alice@atwho.org", status: "disabled" as const },
];

describe("T111：建立表單的名字驗證（即時）", () => {
  it("3–12 個英文字母合法（大小寫皆可，正規化為小寫）", () => {
    expect(validateAliasName("luke")).toBeNull();
    expect(validateAliasName("Luke")).toBeNull();
    expect(validateAliasName("abcdefghijkl")).toBeNull();
    expect(validateAliasName("abc")).toBeNull();
    expect(normalizeAliasInput("  Luke  ")).toBe("luke");
  });

  it("長度不足／過長、數字、符號、保留字 → 顯示錯誤", () => {
    for (const name of ["", "ab", "abcdefghijklm", "luke1", "luke-1", "luke_1", "lu ke", "lüke"]) {
      expect(validateAliasName(name), name).not.toBeNull();
    }
    for (const name of ALIAS_RESERVED_NAMES) {
      expect(validateAliasName(name), name).toContain("保留字");
    }
  });

  it("預覽顯示系統會附加流水號", () => {
    expect(aliasPreview("luke")).toBe("luke001@atwho.org");
  });
});

describe("T117／T118：回覆 From（範圍 A）", () => {
  it("外部寄件者 → From 自動用別名", () => {
    const from = replyFromFor({
      envelopeTo: "luke001@atwho.org",
      sender: "External Person <ext@example.com>",
      aliases: ALIASES,
      fallbackFrom: "alice@atwho.org",
    });
    expect(from).toBe("luke001@atwho.org");
  });

  it("內部 @atwho.org 寄件者 → From 用別名的目標真實地址", () => {
    const from = replyFromFor({
      envelopeTo: "luke001@atwho.org",
      sender: "Bob <bob@atwho.org>",
      aliases: ALIASES,
      fallbackFrom: "fallback@atwho.org",
    });
    expect(from).toBe("alice@atwho.org");
  });

  it("不是寄給別名的信 → 維持預設地址", () => {
    expect(
      replyFromFor({
        envelopeTo: null,
        sender: "ext@example.com",
        aliases: ALIASES,
        fallbackFrom: "alice@atwho.org",
      })
    ).toBe("alice@atwho.org");
  });

  it("別名已停用或不在 scope 清單 → 退回預設地址（不得用失效別名寄信）", () => {
    expect(
      replyFromFor({
        envelopeTo: "old001@atwho.org",
        sender: "ext@example.com",
        aliases: ALIASES,
        fallbackFrom: "alice@atwho.org",
      })
    ).toBe("alice@atwho.org");
    expect(
      replyFromFor({
        envelopeTo: "other001@atwho.org",
        sender: "ext@example.com",
        aliases: ALIASES,
        fallbackFrom: "alice@atwho.org",
      })
    ).toBe("alice@atwho.org");
  });

  it("內部網域判定不分大小寫（含顯示名稱格式）", () => {
    expect(isInternalAddress("bob@atwho.org")).toBe(true);
    expect(isInternalAddress("Bob <BOB@AtWho.Org>")).toBe(true);
    expect(isInternalAddress("atwho.org@example.com")).toBe(false);
    expect(isInternalAddress("ext@example.com")).toBe(false);
  });
});
