/**
 * 附件處理：先在前端擋大小，避免打到 API 的 5 MiB 上限（PAYLOAD_TOO_LARGE）。
 * 依 docs/05 §2.3：base64 膨脹 ×4/3 → 單檔 3.5 MiB、總計 4.5 MiB。
 */
import { formatBytes } from "./format";
import { tGlobal } from "../i18n";

export const MAX_FILE_BYTES = Math.floor(3.5 * 1024 * 1024);
export const MAX_TOTAL_BYTES = Math.floor(4.5 * 1024 * 1024);

export interface PendingAttachment {
  filename: string;
  type: string;
  content_base64: string;
  size: number;
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(tGlobal("讀取檔案失敗：{filename}", { filename: file.name })));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : "");
    };
    reader.readAsDataURL(file);
  });
}

/** 檢查單檔與總量限制；回傳錯誤訊息（null = 通過） */
export function checkFileSize(file: File, currentTotal: number): string | null {
  if (file.size > MAX_FILE_BYTES) {
    return tGlobal("「{filename}」{size} 超過單檔上限 {limit}", {
      filename: file.name,
      size: formatBytes(file.size),
      limit: formatBytes(MAX_FILE_BYTES),
    });
  }
  if (currentTotal + file.size > MAX_TOTAL_BYTES) {
    return tGlobal("附件總計將超過 {limit}（寄信總量上限 5 MiB）", { limit: formatBytes(MAX_TOTAL_BYTES) });
  }
  return null;
}
