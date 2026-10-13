import type { Folder } from "../api/types";

export const FOLDER_LABEL: Record<Folder, string> = {
  inbox: "收件匣",
  sent: "寄件備份",
  archive: "封存",
  spam: "垃圾郵件",
  trash: "垃圾桶",
};
