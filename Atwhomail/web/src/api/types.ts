/** 與 atwhomail-api 的 wire 型別（snake_case，時間為 epoch ms） */

export type Folder = "inbox" | "sent" | "archive" | "trash" | "spam";
/** UI 可查詢的資料夾：`all` = 跨資料夾（搜尋用） */
export type FolderQuery = Folder | "all";

/** 分類由「進入路徑」決定（docs/18 §2）：外部 = MX、內部 = 本地寄送／本地直送 */
export type MailOrigin = "external" | "internal";
export type MailKind = "normal" | "interactive_form";
export type DeliveryScope = "internal" | "external";
/** 寄件者驗證結果（**僅供顯示**，永不授權；docs/18 §5.3） */
export type SenderAuthResult = "pass" | "fail" | "none" | "unknown";

export interface MailListItem {
  id: number;
  from: string;
  subject: string | null;
  text_preview: string | null;
  received_at: number;
  read: boolean;
  has_attachments: boolean;
  folder: Folder;
  origin: MailOrigin;
  kind: MailKind;
  delivery_scope: DeliveryScope;
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
  /** docs/18 P1：三類郵件（外部／內部／互動式） */
  origin: MailOrigin;
  kind: MailKind;
  delivery_scope: DeliveryScope;
  /** kind=interactive_form 時的表單實例；寄件備份指向該次寄送的代表實例 */
  form_instance_id: number | null;
  /** 外部信帶有表單標記（已丟棄、未啟用；僅供顯示） */
  suspicious_form_claim: boolean;
  /** 寄件者驗證結果（僅供顯示） */
  sender_spf: SenderAuthResult | null;
  sender_dkim: SenderAuthResult | null;
  sender_dmarc: SenderAuthResult | null;
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
  /**
   * 該地址的信件**總數**（含所有資料夾與垃圾桶；D11-3）。
   * 刪除對話框用它顯示「此地址有 N 封信，永久刪除將一併刪除」——與 `?mode=hard` 的刪除範圍一致。
   */
  messages?: number;
}

/**
 * **已軟刪除**（垃圾桶狀態）的地址（`GET /api/email-addresses?deleted=1`，D11-5）。
 *
 * ⚠️ 這些列仍佔住名稱（同名不可重建），信件與 R2 物件也都還在；唯一能清乾淨的路徑是
 * `deleteAddress(id, "hard")`。與 `EmailAddressInfo` 的差別：一定有 `deleted_at`、且只出現在
 * 「已刪除的地址」清單（預設的地址清單仍只列未刪除的地址）。
 */
export interface DeletedAddressInfo {
  id: number;
  email: string;
  status: "deleted";
  has_password: boolean;
  created_at: number;
  updated_at: number;
  /** 軟刪除時間（epoch ms） */
  deleted_at: number;
  /** 仍留在該地址下的信件數（含所有資料夾與垃圾桶；與 hard 實際清除的數量一致） */
  messages: number;
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
  /** P1：`internal` = 全內部收件人本地直送；`external` = 走 Cloudflare Email Service */
  delivery_scope?: DeliveryScope;
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

/** 邀請碼（GET /api/invites；`code` 全碼僅在 `?reveal=1` 時出現，docs/16 D4） */
export interface Invite {
  id: number;
  /** 前 4 碼 + "…"（預設列表即為此遮罩） */
  masked_code: string;
  /** 全碼；僅 `GET /api/invites?reveal=1`（owner）會回傳，且寫入稽核 */
  code?: string;
  max_uses: number;
  used_count: number;
  expires_at: number | null;
  status: "active" | "revoked";
  note: string | null;
  created_at: number;
}

/**
 * 訪客清單（GET /api/users?role=visitor，owner 專用，docs/16 D5）
 * ⚠️ N9：只含**數量與時間**（mail_count／last_activity_at），不含主旨／寄件者／內文。
 */
export interface VisitorAddress {
  id: number;
  email: string;
  status: "active" | "disabled" | "deleted";
  /** 1 = 可寄信；0 = 已關閉（安全閥） */
  can_send: number;
  daily_send_quota: number;
  sent_today: number;
  /** 1 = 不受註冊後 24 小時的暖機上限（migration 0007） */
  warmup_exempt: number;
}

export interface VisitorUser {
  id: number;
  username: string;
  /** API 詞彙（DB 端停權存為 'disabled'） */
  status: "active" | "suspended";
  created_at: number;
  /** 訪客的主要地址；尚未建立地址時為 null */
  address: VisitorAddress | null;
  /** 該地址信件數（僅數量，不含內容） */
  mail_count: number;
  /** 最近活動時間（最近一封信的時間；沒有信則為帳號更新時間） */
  last_activity_at: number | null;
}

/** 閱讀窗格的內文狀態（UI 專用） */
export type BodyState =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "html"; html: string }
  | { kind: "text"; text: string }
  | { kind: "empty" };
