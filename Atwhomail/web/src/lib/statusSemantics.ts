/**
 * 停權（帳號）／停用（地址）的**語意文案**（D8-2／D8-3，docs/16 §3）。
 *
 * 為什麼要獨立成純函式：兩者在 UI 上看起來很像，但後果差很多（實作證據）——
 *
 * | | 停權帳號（`users.status`） | 停用地址（`email_addresses.status`） |
 * |---|---|---|
 * | 影響範圍 | 該使用者**全部地址** | **僅該一個地址** |
 * | 登入／寄信 | 擋 | 擋 |
 * | **收信** | ✅ **照收**（email-handler 只看地址狀態） | ❌ **靜默丟棄該信**（不可逆） |
 *
 * 把文案集中在這裡 → `VisitorManager` 只負責渲染，且可在無 DOM 環境下測試（本 repo 尚無 JSX runner）。
 */

/** 停權／復權按鈕文案（D8-2 指定用語） */
export function userStatusActionLabel(suspended: boolean): string {
  return suspended ? "復權帳號（恢復登入與寄信）" : "停權帳號（所有地址；仍可收信）";
}

/** 停用／啟用地址按鈕文案（D8-2 指定用語） */
export function addressStatusActionLabel(disabled: boolean): string {
  return disabled ? "啟用地址（恢復收信）" : "停用地址（連收信都停止）";
}

/** 停權／復權的差異說明（`title` tooltip） */
export function userStatusTooltip(suspended: boolean): string {
  return suspended
    ? "復權＝解除帳號層凍結，此人所有地址恢復可登入與寄信。"
    : "停權＝凍結此訪客的全部地址：立即無法登入與寄信，但來信仍會保留（收信不中斷）。";
}

/** 停用／啟用地址的差異說明（`title` tooltip） */
export function addressStatusTooltip(disabled: boolean): string {
  return disabled
    ? "啟用＝恢復此地址的收信與登入；停用期間已被丟棄的來信無法找回。"
    : "停用＝僅此一個地址（其他地址不受影響），且連收信都停止：停用期間的來信會直接丟棄、不保留。";
}

/**
 * 停用地址前的二次確認警語（D8-3）。
 *
 * ⚠️ 這句話必須完整顯示：地址停用是**不可逆的收信中斷**（信在 SMTP 階段就被丟棄，救不回來），
 *    與停權（來信照收）的後果完全不同，不能用同一句含糊帶過。
 */
export const ADDRESS_DISABLE_WARNING = "此地址將立即停止收信，停用期間的來信不會保留";

/** 停權前的二次確認警語 */
export const USER_SUSPEND_WARNING =
  "此帳號的所有地址將立即無法登入與寄信；來信仍會照常收到並保留，信件不會被刪除。";
