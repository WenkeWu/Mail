/**
 * session 存放：sessionStorage（依 docs/12 §6 —— 不用 localStorage，降低 XSS 長期風險；
 * token 只存活於當前分頁，關閉分頁即失效）。
 */
import type { Session } from "../api/types";

const KEY = "atwhomail.session.v1";

export function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    if (!s || typeof s.token !== "string" || (s.kind !== "owner" && s.kind !== "mailbox")) return null;
    return s;
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    /* 無痕模式等情境寫入失敗 → 僅影響重整後需重新登入 */
  }
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
