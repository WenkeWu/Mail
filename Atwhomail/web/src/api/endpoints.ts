/** endpoints.ts — 每個 API 端點的型別化包裝（契約見 docs/05、docs/12） */
import { request, requestBlob, requestText } from "./client";
import type {
  CountsResponse,
  EmailAddressInfo,
  MailDetail,
  MailListResponse,
  MeResponse,
  SendPayload,
  SendResult,
} from "./types";

// ── Auth ──
export function ownerLogin(username: string, password: string) {
  return request<{ token: string; session: "owner"; user: { id: number; username: string } }>(
    "/api/auth/login",
    { method: "POST", json: { username, password } }
  );
}

export function mailboxLogin(email: string, password: string) {
  return request<{ token: string; session: "mailbox"; address: { id: number; email: string } }>(
    "/api/auth/mailbox-login",
    { method: "POST", json: { email, password } }
  );
}

/** 訪客註冊（Phase 1：需邀請碼；成功即回 mailbox session） */
export function register(payload: {
  invite_code: string;
  username: string;
  password: string;
  local_part?: string;
}) {
  return request<{ token: string; session: "mailbox"; address: { id: number; email: string } }>(
    "/api/auth/register",
    { method: "POST", json: payload }
  );
}

/** 目前 session 的身分與寄信配額（Phase 1） */
export const getMe = () => request<MeResponse>("/api/me");

/**
 * owner 本人變更自己的密碼（D7，docs/16 §3；需舊密碼）
 * 成功後所有既有 JWT 立即失效（`password_changed_at`）→ 前端須重新登入
 */
export const changeOwnerPassword = (oldPassword: string, newPassword: string) =>
  request<{ ok: boolean }>("/api/auth/owner-password/self", {
    method: "PATCH",
    json: { old_password: oldPassword, new_password: newPassword },
  });

// ── 信件列表 ──
export interface ListMailParams {
  folder: string;
  q?: string;
  addressId?: number | null;
  cursor?: string | null;
  limit?: number;
}

export function listMail(params: ListMailParams): Promise<MailListResponse> {
  const sp = new URLSearchParams({ folder: params.folder, limit: String(params.limit ?? 50) });
  if (params.q) sp.set("q", params.q);
  if (params.addressId != null) sp.set("address_id", String(params.addressId));
  if (params.cursor) sp.set("cursor", params.cursor);
  return request<MailListResponse>(`/api/mail/inbox?${sp.toString()}`);
}

export const getCounts = () => request<CountsResponse>("/api/mail/counts");

// ── 單封信 ──
export const getMail = (id: number) => request<MailDetail>(`/api/mail/${id}`);
export const getMailText = (id: number) =>
  request<{ id: number; text: string | null }>(`/api/mail/${id}/text`);
export const fetchMailHtml = (id: number) => requestText(`/api/mail/${id}/html`);

export const setRead = (id: number, read: boolean) =>
  request<{ id: number; read: boolean }>(`/api/mail/${id}/read`, { method: "PATCH", json: { read } });
export const archiveMail = (id: number) => request<{ id: number }>(`/api/mail/${id}/archive`, { method: "PATCH" });
export const moveMail = (id: number, folder: string) =>
  request<{ id: number; folder: string }>(`/api/mail/${id}/folder`, { method: "PATCH", json: { folder } });
export const deleteMail = (id: number) => request<void>(`/api/mail/${id}`, { method: "DELETE" });

// ── 寄信 / 附件 ──
export const sendMail = (payload: SendPayload) =>
  request<SendResult>("/api/mail/send", { method: "POST", json: payload });
export const downloadAttachment = (id: number) => requestBlob(`/api/attachments/${id}`);

// ── 地址管理（owner；mailbox 會拿 403）──
export const listAddresses = () => request<{ addresses: EmailAddressInfo[] }>("/api/email-addresses");

export const createAddress = (localPart: string, password?: string) =>
  request<{ id: number; email: string; status: string }>("/api/email-addresses", {
    method: "POST",
    json: password ? { local_part: localPart, password } : { local_part: localPart },
  });

export const setAddressStatus = (id: number, status: "active" | "disabled") =>
  request<{ id: number; status: string }>(`/api/email-addresses/${id}`, { method: "PATCH", json: { status } });

export const setAddressPassword = (id: number, newPassword: string, oldPassword?: string) =>
  request<{ ok: boolean }>(`/api/email-addresses/${id}/password`, {
    method: "PATCH",
    json: oldPassword ? { new_password: newPassword, old_password: oldPassword } : { new_password: newPassword },
  });

export const deleteAddress = (id: number) => request<void>(`/api/email-addresses/${id}`, { method: "DELETE" });
