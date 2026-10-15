/**
 * D8-2／D8-3 的**前端純函式**測試（docs/16 §3）
 *
 * 涵蓋：停權／停用的按鈕文案與 tooltip 是否明寫「影響範圍」與「收信」後果，
 * 以及停用地址前的二次確認警語是否逐字包含必要的警告（不可逆的收信中斷）。
 *
 * ⚠️ 這裡測的是文案與顯示邏輯；**行為**（立即失效）由後端判定，
 *    對應的 API 測試見 `packages/api/test/admin-status.spec.ts`（T17–T19）。
 */
import { describe, expect, it } from "vitest";
import {
  ADDRESS_DISABLE_WARNING,
  USER_SUSPEND_WARNING,
  addressStatusActionLabel,
  addressStatusTooltip,
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
