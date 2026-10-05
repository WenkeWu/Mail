/**
 * paths.ts — R2 key ↔ 本地路徑對應（09 文件 §3）
 *
 * `mail/` 前綴在本地鏡像省略（文件規定結構：<root>/2026/09/<uuid>.eml）；
 * `attachments/...` 原樣保留。
 */
import { join } from "node:path";

export function localPathFor(root: string, r2Key: string): string {
  const rel = r2Key.startsWith("mail/") ? r2Key.slice("mail/".length) : r2Key;
  return join(root, rel);
}
