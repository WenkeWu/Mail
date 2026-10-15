/**
 * D8-2／D8-3／D9 的**前端純函式**測試（docs/16 §3）
 *
 * 涵蓋：停權／停用的按鈕文案與 tooltip 是否明寫「影響範圍」與「收信」後果、
 * 停用地址前的二次確認警語（不可逆的收信中斷），以及**刪除訪客**（D9）的按鈕文案、
 * tooltip 與二次確認警語（逐字必須明寫「無法復原」並導向「停權」）。
 *
 * ⚠️ 這裡測的是文案與顯示邏輯；**行為**（立即失效／完整清除）由後端判定，
 *    對應的 API 測試見 `packages/api/test/admin-status.spec.ts`（T17–T19）與
 *    `packages/api/test/admin-delete.spec.ts`（T20–T24）。
 */
import { describe, expect, it } from "vitest";
import {
  ADDRESS_DELETE_HARD_LABEL,
  ADDRESS_DELETE_SOFT_DESC,
  ADDRESS_DELETE_SOFT_LABEL,
  ADDRESS_DISABLE_WARNING,
  ADDRESS_MANAGER_HINT,
  USER_DELETE_LABEL,
  USER_DELETE_WARNING,
  USER_SUSPEND_WARNING,
  VISITOR_MANAGER_HINT,
  addressDeleteToast,
  addressHardDeleteWarning,
  addressMessageCountLine,
  addressStatusActionLabel,
  addressStatusTooltip,
  userDeleteTooltip,
  userStatusActionLabel,
  userStatusTooltip,
} from "../src/lib/statusSemantics";

describe("D8-2：停權／停用的按鈕文案必須點出後果差異", () => {
  it("停權按鈕明寫「所有地址」與「仍可收信」", () => {
    const label = userStatusActionLabel(false);
    expect(label).toContain("停權帳號");
    expect(label).toContain("所有地址");
    expect(label).toContain("仍可收信");
  });

  it("停用按鈕明寫「連收信都停止」", () => {
    const label = addressStatusActionLabel(false);
    expect(label).toContain("停用地址");
    expect(label).toContain("連收信都停止");
  });

  it("反向動作（復權／啟用）文案對稱且不誤導", () => {
    expect(userStatusActionLabel(true)).toContain("復權帳號");
    expect(addressStatusActionLabel(true)).toContain("啟用地址");
    // 反向動作不得沿用「停止收信」的警語
    expect(addressStatusActionLabel(true)).not.toContain("連收信都停止");
  });

  it("tooltip 說明差異：停權＝全部地址但來信仍保留；停用＝僅此地址且來信直接丟棄", () => {
    const suspendTip = userStatusTooltip(false);
    expect(suspendTip).toContain("全部地址");
    expect(suspendTip).toContain("來信仍會保留");

    const disableTip = addressStatusTooltip(false);
    expect(disableTip).toContain("僅此一個地址");
    expect(disableTip).toContain("直接丟棄");
    // 兩者必須不同（否則等於沒有說明差異）
    expect(suspendTip).not.toBe(disableTip);
  });
});

describe("D8-3：停用地址前的二次確認", () => {
  it("警語逐字包含「此地址將立即停止收信，停用期間的來信不會保留」", () => {
    expect(ADDRESS_DISABLE_WARNING).toBe("此地址將立即停止收信，停用期間的來信不會保留");
  });

  it("停權警語與停用警語不同：停權不刪信、來信照收", () => {
    expect(USER_SUSPEND_WARNING).toContain("來信仍會照常收到並保留");
    expect(USER_SUSPEND_WARNING).not.toBe(ADDRESS_DISABLE_WARNING);
  });
});

describe("D9：刪除訪客的按鈕與二次確認", () => {
  it("刪除按鈕文案為「刪除」（danger 樣式由 VisitorManager 套用）", () => {
    expect(USER_DELETE_LABEL).toBe("刪除");
  });

  it("二次確認警語逐字包含「將永久刪除…所有信件與附件，且無法復原」與「請改用『停權』」", () => {
    expect(USER_DELETE_WARNING).toBe(
      "將永久刪除該訪客的帳號、地址、所有信件與附件，且無法復原；若只是要暫停，請改用『停權』"
    );
    // 逐字要求的關鍵片段（拆開斷言 → 訊息被改動時能指出少了哪一段）
    expect(USER_DELETE_WARNING).toContain("帳號、地址");
    expect(USER_DELETE_WARNING).toContain("所有信件與附件");
    expect(USER_DELETE_WARNING).toContain("無法復原");
    expect(USER_DELETE_WARNING).toContain("停權");
  });

  it("刪除警語與停權／停用警語互不相同（三者後果不同，不能共用一句）", () => {
    expect(USER_DELETE_WARNING).not.toBe(USER_SUSPEND_WARNING);
    expect(USER_DELETE_WARNING).not.toBe(ADDRESS_DISABLE_WARNING);
  });

  it("tooltip 說明與停權的差別：刪除不可逆、只想暫停請用停權", () => {
    const tip = userDeleteTooltip();
    expect(tip).toContain("無法復原");
    expect(tip).toContain("停權");
    expect(tip).toContain("信件");
  });
});

// ───────────── D11：地址刪除語意補平（docs/16 §3）─────────────

describe("D11-3：地址刪除對話框的兩個選項與信件數", () => {
  it("兩個選項文案分別是「停用並保留信件」（soft）與「永久刪除」（hard）", () => {
    expect(ADDRESS_DELETE_SOFT_LABEL).toBe("停用並保留信件");
    expect(ADDRESS_DELETE_HARD_LABEL).toBe("永久刪除");
  });

  it("soft 選項說明明寫「信件與附件保留」（與 hard 的差別）", () => {
    expect(ADDRESS_DELETE_SOFT_DESC).toContain("信件與附件保留");
    expect(ADDRESS_DELETE_SOFT_DESC).not.toContain("無法復原");
  });

  it("hard 警語逐字點出後果：所有信件與附件、清除 R2、釋放名稱、無法復原", () => {
    const warn = addressHardDeleteWarning();
    expect(warn).toContain("所有信件與附件");
    expect(warn).toContain("R2");
    expect(warn).toContain("釋放名稱");
    expect(warn).toContain("無法復原");
  });

  it("兩個選項的文案互不相同（後果不同，不可共用一句）", () => {
    expect(ADDRESS_DELETE_SOFT_LABEL).not.toBe(ADDRESS_DELETE_HARD_LABEL);
    expect(addressHardDeleteWarning()).not.toBe(ADDRESS_DELETE_SOFT_DESC);
    expect(addressHardDeleteWarning()).not.toBe(USER_DELETE_WARNING);
  });

  it("對話框顯示信件數：「此地址有 N 封信，永久刪除將一併刪除」（含 0 封）", () => {
    expect(addressMessageCountLine(15)).toBe("此地址有 15 封信，永久刪除將一併刪除");
    expect(addressMessageCountLine(0)).toBe("此地址有 0 封信，永久刪除將一併刪除");
  });

  it("只講數量、不帶主旨／寄件者（N9 精神）", () => {
    const line = addressMessageCountLine(3);
    expect(line).not.toContain("主旨");
    expect(line).not.toContain("寄件者");
  });

  it("刪除成功的 toast 依模式區分（soft 說保留、hard 說已清除）", () => {
    expect(addressDeleteToast("sales01@atwho.org", "soft")).toContain("信件保留");
    expect(addressDeleteToast("sales01@atwho.org", "hard")).toContain("已永久刪除");
    expect(addressDeleteToast("sales01@atwho.org", "soft")).not.toBe(
      addressDeleteToast("sales01@atwho.org", "hard")
    );
  });
});

describe("D11-4：地址管理／訪客管理的定位說明", () => {
  it("地址管理＝你自己的信箱", () => {
    expect(ADDRESS_MANAGER_HINT).toContain("地址管理＝你自己的信箱");
  });

  it("訪客管理＝別人用邀請碼註冊的帳號", () => {
    expect(VISITOR_MANAGER_HINT).toContain("訪客管理＝別人用邀請碼註冊的帳號");
  });

  it("兩句說明互不相同，且各自點出對象（避免兩頁被誤解為同一件事）", () => {
    expect(ADDRESS_MANAGER_HINT).not.toBe(VISITOR_MANAGER_HINT);
    expect(VISITOR_MANAGER_HINT).toContain("不是你自己的信箱");
  });
});
