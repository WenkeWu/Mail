/**
 * invites.ts — 邀請碼的**呈現**邏輯（docs/16 D4）
 *
 * 後端只存 `status`（`active`／`revoked`）與 `used_count`／`max_uses`／`expires_at`，
 * 「已用盡」「已過期」是**推導**出來的狀態 → 放在這裡當純函式，UI 與測試共用同一份判定。
 * ⚠️ 純顯示用：真正的拒絕判定在後端 `POST /api/auth/register`（前端推導不影響權限）。
 */

/** UI 狀態：有效／已撤銷／已用盡／已過期 */
export type InviteState = "active" | "revoked" | "exhausted" | "expired";

export interface InviteLike {
  status: string;
  used_count: number;
  max_uses: number;
  expires_at: number | null;
}

/**
 * 推導邀請碼狀態。判定順序與後端一致（`POST /api/auth/register` 步驟 3）：
 * 撤銷 → 過期 → 用盡 → 有效（後端對前兩者都回 `INVITE_INVALID`，用盡回 `INVITE_EXHAUSTED`）。
 */
export function inviteState(invite: InviteLike, nowMs: number = Date.now()): InviteState {
  if (invite.status !== "active") return "revoked";
  if (invite.expires_at !== null && invite.expires_at <= nowMs) return "expired";
  if (invite.used_count >= invite.max_uses) return "exhausted";
  return "active";
}

/** 狀態 → 中文標籤（表格顯示用） */
export const INVITE_STATE_LABEL: Record<InviteState, string> = {
  active: "有效",
  revoked: "已撤銷",
  exhausted: "已用盡",
  expired: "已過期",
};

/** 到期時間顯示：null = 不過期 */
export function formatExpiry(expiresAt: number | null): string {
  if (expiresAt === null) return "不過期";
  return new Date(expiresAt).toLocaleString("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
