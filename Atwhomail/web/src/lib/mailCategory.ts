/**
 * mailCategory.ts — 三類郵件徽章與寄件者驗證顯示（docs/18 P1）。
 *
 * ⚠️ 這裡只做**顯示**：
 *  - 分類由後端依「進入路徑」寫入（origin／kind／delivery_scope），前端不從 From 推斷。
 *  - SPF／DKIM／DMARC 結果**永不授權**任何功能（docs/18 §5.3、§9）。
 */
import type { DeliveryScope, MailKind, MailOrigin, SenderAuthResult } from "../api/types";

export type MailCategory = "external" | "internal" | "interactive";

export interface MailCategoryInput {
  origin: MailOrigin;
  kind: MailKind;
  delivery_scope: DeliveryScope;
}

/**
 * 三類顯示分類：
 * - `interactive_form` → 互動式（唯一可能出現表單的種類）
 * - `origin=external` → 外部
 * - `origin=internal` 且 `delivery_scope=internal` → 內部
 * - 其餘（內部寄出、寄到外部）→ 外部（對使用者而言就是寄到外網）
 */
export function mailCategory(m: MailCategoryInput): MailCategory {
  if (m.kind === "interactive_form") return "interactive";
  if (m.origin === "external") return "external";
  if (m.delivery_scope === "internal") return "internal";
  return "external";
}

export const CATEGORY_LABEL: Record<MailCategory, string> = {
  external: "外部",
  internal: "內部",
  interactive: "互動式",
};

/** 徽章 tooltip（說明分類依據是進入路徑，不是 From） */
export const CATEGORY_TITLE: Record<MailCategory, string> = {
  external: "外部郵件（由外部系統寄入，或寄往外部）",
  internal: "內部郵件（atwho.org 內部本地直送）",
  interactive: "互動式表單郵件（僅能由 atwho.org 內部寄送）",
};

export interface SenderAuthBadge {
  method: "SPF" | "DKIM" | "DMARC";
  result: SenderAuthResult;
  label: string;
  tone: "pass" | "fail" | "neutral";
}

function authLabel(method: string, result: SenderAuthResult | null): Pick<SenderAuthBadge, "label" | "tone"> {
  switch (result) {
    case "pass":
      return { label: `${method} 通過`, tone: "pass" };
    case "fail":
      return { label: `${method} 失敗`, tone: "fail" };
    case "none":
      return { label: `${method} 未驗證`, tone: "neutral" };
    default:
      return { label: `${method} 未知`, tone: "neutral" };
  }
}

/** 三項寄件者驗證徽章（外部信才顯示；內部信不適用） */
export function senderAuthBadges(detail: {
  sender_spf: SenderAuthResult | null;
  sender_dkim: SenderAuthResult | null;
  sender_dmarc: SenderAuthResult | null;
}): SenderAuthBadge[] {
  return [
    { method: "SPF", result: detail.sender_spf ?? "unknown", ...authLabel("SPF", detail.sender_spf) },
    { method: "DKIM", result: detail.sender_dkim ?? "unknown", ...authLabel("DKIM", detail.sender_dkim) },
    { method: "DMARC", result: detail.sender_dmarc ?? "unknown", ...authLabel("DMARC", detail.sender_dmarc) },
  ];
}

/** 是否至少一項驗證失敗（給「⚠️ 驗證失敗」摘要用；仍可正常閱讀，T55） */
export function hasSenderAuthFailure(detail: {
  sender_spf: SenderAuthResult | null;
  sender_dkim: SenderAuthResult | null;
  sender_dmarc: SenderAuthResult | null;
}): boolean {
  return [detail.sender_spf, detail.sender_dkim, detail.sender_dmarc].includes("fail");
}

/** 外部信帶表單標記時顯示的說明（標記已丟棄，表單未啟用） */
export const SUSPICIOUS_FORM_NOTE =
  "此信帶有外部表單標記，已忽略；表單只會由 atwho.org 內部的互動式表單功能建立。";
