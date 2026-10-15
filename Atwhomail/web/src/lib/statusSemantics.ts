/**
 * 管理動作的**語意文案**：停權（帳號）／停用（地址）（D8-2／D8-3）與刪除（D9），docs/16 §3。
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

// ───────────── D9：刪除訪客（docs/16 §3；與停權的差別）─────────────

/** 刪除按鈕文案（danger 樣式；僅 owner 的管理頁可見） */
export const USER_DELETE_LABEL = "刪除";

/** 刪除按鈕的 tooltip：與「停權」的差別（停權可逆、刪除不可逆） */
export function userDeleteTooltip(): string {
  return "刪除＝永久移除該訪客的帳號、地址、所有信件與附件（無法復原）；若只是要暫停，請改用「停權」。";
}

/**
 * 刪除訪客前的二次確認警語（D9）。
 *
 * ⚠️ 這句話必須**逐字**顯示：刪除是不可逆的完整清除（帳號／地址／所有信件與附件），
 *    與停權（可逆、信件保留）後果完全不同，且必須把使用者導向正確的動作（停權）。
 */
export const USER_DELETE_WARNING =
  "將永久刪除該訪客的帳號、地址、所有信件與附件，且無法復原；若只是要暫停，請改用『停權』";

// ───────────── D11：地址刪除語意補平（docs/16 §3）─────────────

/**
 * D11-4：**地址管理**頁的定位說明（單一來源）。
 *
 * 為什麼要寫這一句：兩頁（地址管理／訪客管理）都在管理「地址」，但對象完全不同 ——
 * 地址管理是**你自己的信箱**（`owner_user_id`＝你），刪除語意是自己的資料；
 * 訪客管理是**別人用邀請碼註冊的帳號**（D9 才是那裡的刪除）。誤解會導致刪錯東西。
 */
export const ADDRESS_MANAGER_HINT =
  "地址管理＝你自己的信箱：這裡只列出你名下的地址，信件與附件都是你的資料。";

/** D11-4：**訪客管理**頁的定位說明（單一來源） */
export const VISITOR_MANAGER_HINT =
  "訪客管理＝別人用邀請碼註冊的帳號：不是你自己的信箱，你只看得到數量與時間，讀不到他們的信件內容。";

/** D11-3 ①：停用並保留信件（soft；**預設**選項） */
export const ADDRESS_DELETE_SOFT_LABEL = "停用並保留信件";

/** ① soft 選項的後果說明 */
export const ADDRESS_DELETE_SOFT_DESC =
  "標記為已刪除：此後寄到該地址的信會被丟棄，但現有的信件與附件保留（之後仍可再永久刪除）。";

/** D11-3 ②：永久刪除（hard） */
export const ADDRESS_DELETE_HARD_LABEL = "永久刪除";

/**
 * D11-3 ②：hard 選項的後果說明（必須明寫「不可復原」與清除範圍：信件／附件／R2／釋放名稱）。
 */
export function addressHardDeleteWarning(): string {
  return "永久刪除將連同該地址的所有信件與附件、雲端原始檔（R2）一併清除，並釋放名稱供重新建立；無法復原。";
}

/**
 * D11-3：刪除對話框顯示的信件數（例：「此地址有 15 封信，永久刪除將一併刪除」）。
 *
 * ⚠️ 只顯示**數量**（N9 精神）：owner 管理自己的地址時看得到自己的信，但這裡的口徑與
 *    訪客管理一致 —— 對話框只講數量，不帶主旨／寄件者。
 */
export function addressMessageCountLine(count: number): string {
  return `此地址有 ${count} 封信，永久刪除將一併刪除`;
}

/** 刪除成功後的 toast 文案（兩種模式語意不同，不可共用一句） */
export function addressDeleteToast(email: string, mode: "soft" | "hard"): string {
  return mode === "hard" ? `${email} 已永久刪除（信件與附件已清除，名稱已釋放）` : `${email} 已停用（soft delete，信件保留）`;
}

// ───────────── D11-5：已刪除的地址（垃圾桶）與永久清除（docs/16 §3）─────────────

/**
 * 「已刪除的地址」收合區塊的標題（`AddressManager` 專用，僅 owner 可見）。
 *
 * 為什麼需要這一區：soft 刪除過的地址**不會**出現在地址清單（`deleted_at IS NULL` 的條件），
 * 若沒有這個入口，那些仍佔著名稱、信件與 R2 物件也還在的列就永遠清不掉（D11 的已知限制）。
 */
export const DELETED_ADDRESS_SECTION_TITLE = "已刪除的地址";

/** 區塊內的一行說明：這批地址現在是什麼狀態、以及唯一可行的下一步 */
export const DELETED_ADDRESS_SECTION_HINT =
  "這些地址已停用（寄來的信會被丟棄），但信件、附件與雲端原始檔仍在、名稱也還沒釋放；要清乾淨只能「永久刪除」。";

/** 區塊標題旁的數量（清單為空時也要明講，避免使用者以為壞掉） */
export function deletedAddressCountLabel(count: number): string {
  return count === 0 ? "沒有已刪除的地址" : `共 ${count} 個已刪除的地址`;
}

/**
 * D11-5：對**已刪除的地址**按「永久刪除」的二次確認內容。
 *
 * ⚠️ 必須逐字講清楚清除範圍與不可復原（規格明文）：**所有信件與附件（含垃圾桶）**、**不可復原**。
 *    比 D11-3 的 `addressHardDeleteWarning()` 更強調「垃圾桶裡的也會清掉」—— 因為這批地址
 *    已經在垃圾桶狀態，使用者容易誤以為「已經刪過了，不會再刪掉什麼」。
 */
export function deletedAddressPurgeWarning(email: string): string {
  return `將清除 ${email} 的所有信件與附件（含垃圾桶）與雲端原始檔（R2），並釋放地址名稱；不可復原。`;
}
