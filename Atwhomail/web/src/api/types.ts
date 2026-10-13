/** 與 atwhomail-api 的 wire 型別（snake_case，時間為 epoch ms） */

export type Folder = "inbox" | "sent" | "archive" | "trash" | "spam";
/** UI 可查詢的資料夾：`all` = 跨資料夾（搜尋用） */
export type FolderQuery = Folder | "all";

export interface MailListItem {
  id: number;
  from: string;
  subject: string | null;
  text_preview: string | null;
  received_at: number;
  read: boolean;
  has_attachments: boolean;
  folder: Folder;
}

export interface MailListResponse {
  items: MailListItem[];
  nextCursor: string | null;
}

export interface AddressRef {
  address: string;
  name: string;
}

export interface AttachmentMeta {
  id: number;
  filename: string;
  content_type: string;
  size_bytes: number;
}

export interface MailDetail {
  id: number;
  from: string;
  to: AddressRef[];
  cc: AddressRef[];
  subject: string | null;
  text_preview: string | null;
  message_id: string | null;
  received_at: number;
  read_at: number | null;
  folder: Folder;
  /** 相對 API 路徑；null = 此信沒有 HTML 內文 */
  html_url: string | null;
  attachments: AttachmentMeta[];
}

export interface FolderCount {
  total: number;
  unread: number;
}

export interface AddressCount {
  id: number;
  email: string;
  total: number;
  unread: number;
}

export interface CountsResponse {
  folders: Record<Folder, FolderCount>;
  /** 僅 owner session 有值（mailbox → null） */
  addresses: AddressCount[] | null;
}

export interface EmailAddressInfo {
  id: number;
  email: string;
  status: "active" | "disabled" | "deleted";
  has_password: boolean;
  created_at: number;
  updated_at: number;
}

/** 登入 session（Model C：owner 或單一信箱） */
export type Session =
  | { kind: "owner"; token: string; userId: number; username: string }
  | { kind: "mailbox"; token: string; addressId: number; email: string };

export interface SendAttachment {
  filename: string;
  type: string;
  content_base64: string;
  disposition?: "attachment" | "inline";
}

export interface SendPayload {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text?: string;
  html?: string;
  attachments?: SendAttachment[];
}

export interface SendResult {
  messageId: string;
  send_status: string;
  from: string;
  to: string[];
}

/** GET /api/me（Phase 1：身分與寄信配額） */
export interface MeAddress {
  id: number;
  email: string;
  /** 1 = 可寄信；0 = 已關閉（安全閥） */
  can_send: number;
  daily_send_quota: number;
  sent_today: number;
  quota_reset_at: number | null;
}

export interface MeResponse {
  role: "owner" | "visitor";
  session: "owner" | "mailbox";
  username: string | null;
  addresses: MeAddress[];
}

/** 閱讀窗格的內文狀態（UI 專用） */
export type BodyState =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "html"; html: string }
  | { kind: "text"; text: string }
  | { kind: "empty" };
