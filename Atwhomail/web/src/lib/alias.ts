/**
 * D25（docs/25）：別名 Phase 1 的前端規則。
 *
 * 這裡刻意做成**純函式**（不碰 DOM／網路）：
 *  - 建立表單的即時驗證（3–12 字母、非保留字）
 *  - 回覆時依「範圍 A」決定 From（外部寄件者 → 別名；@atwho.org 內部 → 真實地址）
 * 後端仍會重驗一次（前端驗證僅為 UX，不是權限邊界）。
 */
import type { EmailAlias } from "../api/types";
import { parseAddress } from "./format";

/** 使用者輸入的「名字」：3–12 個英文字母（儲存小寫；不得有數字／符號） */
export const ALIAS_NAME_PATTERN = /^[a-z]{3,12}$/;

/** 保留字（與後端 ALIAS_RESERVED_NAMES 一致；docs/25 §1） */
export const ALIAS_RESERVED_NAMES = [
  "admin",
  "postmaster",
  "abuse",
  "root",
  "noreply",
  "mailerdaemon",
  "hostmaster",
  "webmaster",
  "support",
] as const;

const RESERVED = new Set<string>(ALIAS_RESERVED_NAMES);

/** 內部寄件者網域（範圍 A：同域不匿名） */
export const INTERNAL_DOMAIN = "@atwho.org";

export function normalizeAliasInput(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * 即時驗證使用者輸入的名字。
 * 回傳 `null` = 合法；否則回傳可直接顯示的錯誤訊息。
 */
export function validateAliasName(raw: string): string | null {
  const name = normalizeAliasInput(raw);
  if (!name) return "請輸入 3–12 個英文字母";
  if (name.length < 3) return "至少 3 個英文字母";
  if (name.length > 12) return "最多 12 個英文字母";
  if (/[0-9]/.test(name)) return "不可包含數字（流水號由系統分配）";
  if (!ALIAS_NAME_PATTERN.test(name)) return "只能使用英文字母（a–z）";
  if (RESERVED.has(name)) return "此名稱為保留字，請改用其他名稱";
  return null;
}

/**
 * 預覽建立後的別名（流水號由後端分配，這裡只示範第一號）。
 * 例：`luke` → `luke001@atwho.org`
 */
export function aliasPreview(raw: string): string {
  return `${normalizeAliasInput(raw)}001@atwho.org`;
}

/** 是否為 @atwho.org 內部地址（寄件者判斷用；範圍 A） */
export function isInternalAddress(email: string): boolean {
  return parseAddress(email).address.toLowerCase().endsWith(INTERNAL_DOMAIN);
}

export interface ReplyFromInput {
  /** 原始信件寄給哪個別名（`messages.envelope_to`）；null = 寄給真實地址 */
  envelopeTo: string | null | undefined;
  /** 原始寄件者（可含顯示名稱） */
  sender: string;
  /** session scope 內的別名清單 */
  aliases: Array<Pick<EmailAlias, "alias_address" | "target_email" | "status">>;
  /** 找不到別名時的預設寄件地址 */
  fallbackFrom: string;
}

/**
 * 回覆時的 From（docs/25 §5、範圍 A）：
 *  - 信件不是寄給別名（`envelope_to` 為空）→ 維持預設真實地址
 *  - 寄給別名且**外部**寄件者 → 用該別名（對外匿名）
 *  - 寄給別名且**內部**（@atwho.org）寄件者 → 用別名的目標真實地址（對內不匿名）
 *  - 別名已停用／不在清單 → 退回預設地址（不讓使用者用失效別名寄信）
 *
 * ⚠️ 只有「回覆」會自動帶入別名；Phase 1 不支援以別名主動寄新信（docs/25 §8）。
 */
export function replyFromFor({ envelopeTo, sender, aliases, fallbackFrom }: ReplyFromInput): string {
  const target = (envelopeTo ?? "").trim().toLowerCase();
  if (!target) return fallbackFrom;
  const alias = aliases.find((a) => a.alias_address.toLowerCase() === target && a.status === "active");
  if (!alias) return fallbackFrom;
  return isInternalAddress(sender) ? alias.target_email : alias.alias_address;
}
