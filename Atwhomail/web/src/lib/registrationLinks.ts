/**
 * registrationLinks.ts — 可分享的註冊／邀請連結（docs/22 D22）
 *
 * ⚠️ 安全邊界（docs/16 N3）：這些 query 參數**只影響前端顯示與預填**，
 *    不得影響任何權限判定。註冊模式由後端 `REGISTRATION_MODE` 決定，
 *    邀請碼是否有效也一律由後端在送出時驗證（無效 → `INVITE_INVALID`）。
 */

/** 對外註冊入口（訪客端；正式網域固定為 app.atwho.org） */
export const APP_REGISTRATION_BASE_URL = "https://app.atwho.org/";

/** 一般註冊連結（`email_verify` 模式用）：開啟後直接進註冊分頁 */
export const REGISTER_LINK = `${APP_REGISTRATION_BASE_URL}?register=1`;

/** 邀請連結：`?invite=<code>`；code 一律 encode 後才放進 URL */
export function inviteLink(code: string): string {
  return `${APP_REGISTRATION_BASE_URL}?invite=${encodeURIComponent(code)}`;
}

export interface RegistrationQuery {
  /** 是否自動切到「註冊」分頁（`register=1` 或帶 `invite`） */
  openRegister: boolean;
  /** URL 帶入的邀請碼（null = 未帶）；僅 `invite` 模式會預填到欄位 */
  inviteCode: string | null;
}

/**
 * 解析 `location.search`。
 * - `register=1` → 開註冊分頁
 * - `invite=<code>` → 開註冊分頁並預填邀請碼
 * - 兩者可並存（重複的 invite 取第一個；空字串視為未帶）
 */
export function parseRegistrationQuery(search: string): RegistrationQuery {
  const params = new URLSearchParams(search);
  const rawInvite = params.get("invite");
  const inviteCode = rawInvite && rawInvite.trim() !== "" ? rawInvite.trim() : null;
  const wantsRegister = params.get("register") === "1";
  return {
    openRegister: wantsRegister || inviteCode !== null,
    inviteCode,
  };
}

/**
 * 移除已處理的 `register`／`invite` 參數（保留其他 query、path 與 hash）。
 *
 * 用 `history.replaceState` 而非 pushState：不新增歷史紀錄，使用者按上一頁不會回到含碼網址；
 * 也避免把邀請碼留在可被複製／轉傳的網址列（docs/22 §2）。
 * 沒有這兩個參數時完全不動作。
 */
export function clearRegistrationParams(history: History, location: Location): void {
  const params = new URLSearchParams(location.search);
  if (!params.has("register") && !params.has("invite")) return;
  params.delete("register");
  params.delete("invite");
  const query = params.toString();
  history.replaceState(history.state, "", `${location.pathname}${query ? `?${query}` : ""}${location.hash}`);
}
