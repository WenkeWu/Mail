/** 收件者輸入解析與回覆/轉寄主旨處理 */
import { parseAddress } from "./format";

/** "A <a@x.com>, b@y.com; c@z" → ["a@x.com","b@y.com","c@z"]（去重、小寫） */
export function splitRecipients(input: string): string[] {
  const out: string[] = [];
  for (const chunk of input.split(/[,;\n]/)) {
    const s = chunk.trim();
    if (!s) continue;
    const addr = parseAddress(s).address.toLowerCase();
    if (addr.includes("@")) out.push(addr);
  }
  return [...new Set(out)];
}

export function joinRecipients(list: string[]): string {
  return list.join(", ");
}

/** 回覆引言：每行加 "> " */
export function quoteText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

/** 主旨前綴（已存在就不重複加） */
export function withPrefix(subject: string | null, prefix: "Re:" | "Fwd:"): string {
  const s = (subject ?? "").trim();
  if (!s) return prefix;
  return s.toLowerCase().startsWith(prefix.toLowerCase()) ? s : `${prefix} ${s}`;
}

/** 純文字 → 安全的 HTML（給 contentEditable 初始內容；換行轉 <br>） */
export function textToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return escaped.replace(/\r?\n/g, "<br>");
}
