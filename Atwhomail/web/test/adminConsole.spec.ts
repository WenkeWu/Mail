/**
 * D4／D5 的**前端純函式**測試（docs/16 §3）
 *
 * 涵蓋：管理主控台頁面的顯示開關（mail.／localhost 顯示、app. 不顯示）與邀請碼狀態推導。
 * ⚠️ 這裡測的是顯示邏輯；**權限**由後端判定（`requireOwner`），對應的 API 測試見
 *    `packages/api/test/admin-console.spec.ts`（T12–T16）。實際 JSX 渲染需 DOM 環境，
 *    本 repo 尚無該 runner → 與 hostMode.spec.ts 相同，只覆蓋可測的純函式。
 */
import { describe, expect, it } from "vitest";
import { APP_HOST, MAIL_HOST, loginModeFor, showsAdminConsole } from "../src/lib/hostMode";
import { INVITE_STATE_LABEL, formatExpiry, inviteState } from "../src/lib/invites";

describe("D4／D5：管理主控台的顯示開關（僅 UI 收斂，非權限判定）", () => {
  it("mail.atwho.org（admin）與 localhost／預覽（all）顯示；app.atwho.org（public）不顯示", () => {
    expect(showsAdminConsole(loginModeFor(MAIL_HOST))).toBe(true);
    expect(showsAdminConsole(loginModeFor("localhost"))).toBe(true);
    expect(showsAdminConsole(loginModeFor("127.0.0.1"))).toBe(true);
    expect(showsAdminConsole(loginModeFor("atwhomail-web.pages.dev"))).toBe(true);
    expect(showsAdminConsole(loginModeFor(APP_HOST))).toBe(false);
  });
});

describe("D4：邀請碼狀態推導", () => {
  const base = { status: "active", used_count: 0, max_uses: 1, expires_at: null as number | null };
  const NOW = 1_800_000_000_000;

  it("有效／已撤銷／已用盡／已過期", () => {
    expect(inviteState(base, NOW)).toBe("active");
    expect(inviteState({ ...base, status: "revoked" }, NOW)).toBe("revoked");
    expect(inviteState({ ...base, used_count: 1 }, NOW)).toBe("exhausted");
    expect(inviteState({ ...base, used_count: 5, max_uses: 5 }, NOW)).toBe("exhausted");
    expect(inviteState({ ...base, expires_at: NOW - 1 }, NOW)).toBe("expired");
    expect(inviteState({ ...base, expires_at: NOW + 1 }, NOW)).toBe("active");
  });

  it("判定順序與後端一致：撤銷 → 過期 → 用盡（後端對前兩者皆回 INVITE_INVALID）", () => {
    expect(inviteState({ status: "revoked", used_count: 9, max_uses: 1, expires_at: NOW - 1 }, NOW)).toBe("revoked");
    expect(inviteState({ status: "active", used_count: 9, max_uses: 1, expires_at: NOW - 1 }, NOW)).toBe("expired");
  });

  it("每一種狀態都有中文標籤；到期時間：null = 不過期", () => {
    for (const s of ["active", "revoked", "exhausted", "expired"] as const) {
      expect(INVITE_STATE_LABEL[s]).toBeTruthy();
    }
    expect(formatExpiry(null)).toBe("不過期");
    expect(formatExpiry(NOW)).toMatch(/\d{4}/);
  });
});
