/**
 * formText.ts — 表單 title／description 的前端消毒（docs/18 §8、§9）。
 *
 * 後端已在寫入前消毒；前端仍再做一次（縱深防禦）：
 *  - 去控制字元與 HTML 標籤（保留純文字）
 *  - RJSF 一律以 React 文字節點渲染，不使用 dangerouslySetInnerHTML
 *  - 不執行、不解析 schema 內的任何程式碼
 */
import type { FormSchema } from "../api/types";

export function sanitizeDisplayText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/<[^>]*>/g, "")
    .trim()
    .slice(0, 2000);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 回傳只供顯示的 schema 副本：遞迴消毒 `title`／`description`。
 * 其餘結構原樣保留（型別／enum 等由後端驗證過）。
 */
export function sanitizeSchemaForDisplay(input: FormSchema): FormSchema {
  const clone = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(clone);
    if (!isPlainObject(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "title" || key === "description") {
        out[key] = sanitizeDisplayText(value);
      } else if (key === "properties" && isPlainObject(value)) {
        const props: Record<string, unknown> = {};
        for (const [name, child] of Object.entries(value)) props[name] = clone(child);
        out[key] = props;
      } else if (key === "items") {
        out[key] = clone(value);
      } else {
        out[key] = value;
      }
    }
    return out;
  };
  return clone(input) as FormSchema;
}

/** 表單標題（顯示用；已消毒） */
export function formTitle(schema: FormSchema, fallback: string): string {
  const title = sanitizeDisplayText(schema.title);
  return title || sanitizeDisplayText(fallback) || "互動式表單";
}
