/**
 * @atwhomail/shared — 兩端共用的型別與純函式。
 * Phase 2：先放基礎型別；Phase 3（schema 定案）後補齊並與 03 文件對齊。
 */

/** email_addresses.status */
export type AddressStatus = "active" | "disabled" | "deleted";

/** users.status */
export type UserStatus = "active" | "disabled";

/** messages.folder（Model C：信箱以 address_id 為 scope） */
export type MailFolder = "inbox" | "sent" | "archive" | "trash" | "spam";

/** 寄出追蹤 */
export type SendStatus = "sent" | "bounced" | "failed";

/** epoch ms（與 03 文件一致） */
export type EpochMs = number;

/** 登入 session scope（Model C，05 文件 §2.0） */
export type SessionScope =
  | { kind: "owner"; userId: number }
  | { kind: "mailbox"; addressId: number; email: string };

export interface EmailAddress {
  id: number;
  userId: number;
  localPart: string;
  domain: string;
  email: string;
  status: AddressStatus;
  /** NULL（null）= 不可直接登入 */
  passwordHash: string | null;
  createdAt: EpochMs;
  updatedAt: EpochMs;
  deletedAt: EpochMs | null;
}

export interface MailMessage {
  id: number;
  ownerUserId: number;
  /** Model C scope 主鍵：收信=收件地址；寄信=From 地址 */
  addressId: number;
  folder: MailFolder;
  fromAddress: string;
  toAddresses: string[];
  subject: string | null;
  textPreview: string | null;
  receivedAt: EpochMs;
  readAt: EpochMs | null;
  sendStatus: SendStatus | null;
}
