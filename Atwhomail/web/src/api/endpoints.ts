/** endpoints.ts — 每個 API 端點的型別化包裝（契約見 docs/05、docs/12） */
import { request, requestBlob, requestText } from "./client";
import type {
  CountsResponse,
  DeletedAddressInfo,
  EmailAddressInfo,
  FormResponsesResponse,
  FormSendPayload,
  FormSendResult,
  FormView,
  Invite,
  MailDetail,
  MailListResponse,
  MeResponse,
  SendPayload,
  SendResult,
  VisitorUser,
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

/**
 * **已軟刪除**（垃圾桶狀態）的地址清單（D11-5；僅 owner 名下）。
 *
 * 這些地址做過 soft delete（`deleted_at` 非空）→ 不出現在 `listAddresses()`，信件與 R2 物件
 * 仍保留、名稱也尚未釋放。地址管理頁的「已刪除的地址」區塊用它列出（地址／刪除時間／信件數）
 * 並提供「永久刪除」。
 */
export const listDeletedAddresses = () =>
  request<{ addresses: DeletedAddressInfo[] }>("/api/email-addresses?deleted=1");

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

/**
 * 刪除地址（D11，docs/16 §3）—— 兩種模式語意不同：
 * - `soft`（**預設**）：只標記 `status='deleted'`，**保留**信件與 R2；後端回 `204`（無 body）。
 * - `hard`：連同該地址所有信件與附件、R2 物件一併清除，並**移除該列以釋放名稱**；
 *   後端回 `200` 附刪除數量。⚠️ **不可復原**（前端必須二次確認，見 `AddressManager`）。
 *
 * D11-5：`hard` 也可用在**已軟刪除**（垃圾桶狀態）的地址上 —— 這是唯一能清掉這類殘留列與其
 * R2 物件、並釋放名稱的路徑（`soft` 對已軟刪除的地址仍回 `404`，見 `listDeletedAddresses`）。
 *
 * ⚠️ 只有 owner 名下自己的地址能刪（他人／訪客地址 → 404）；訪客地址請走 `deleteVisitor`。
 */
export const deleteAddress = (id: number, mode: "soft" | "hard" = "soft") =>
  request<AddressDeleteResult | undefined>(`/api/email-addresses/${id}${mode === "hard" ? "?mode=hard" : ""}`, {
    method: "DELETE",
  });

/** `DELETE /api/email-addresses/:id?mode=hard` 的回應（soft 為 204，故為 undefined） */
export interface AddressDeleteResult {
  ok?: boolean;
  id?: number;
  email?: string;
  mode?: "soft" | "hard";
  /** D11-5：`true` ＝ 這次是「從垃圾桶升級為永久刪除」（該列先前已 soft 刪除） */
  previously_deleted?: boolean;
  deleted?: { messages: number; attachments: number; aliases: number; r2_objects: number };
}

// ── 管理主控台（owner；僅 mail. 與 localhost 顯示的頁面，docs/16 D4／D5）──

/**
 * 邀請碼列表。`reveal=true` 時**額外**回傳全碼（後端寫稽核 `invite_revealed`）→ 僅在「複製」當下呼叫。
 */
export const listInvites = (reveal = false) =>
  request<{ invites: Invite[] }>(`/api/invites${reveal ? "?reveal=1" : ""}`);

export const createInvite = (payload: { max_uses?: number; expires_in_hours?: number | null; note?: string }) =>
  request<{ id: number; code: string; max_uses: number; expires_at: number | null }>("/api/invites", {
    method: "POST",
    json: payload,
  });

/** 撤銷邀請碼（soft：status='revoked'；冪等） */
export const revokeInvite = (id: number) => request<{ ok: boolean; id: number }>(`/api/invites/${id}`, { method: "DELETE" });

/** 訪客清單（owner；只含數量與時間 —— N9） */
export const listVisitors = () => request<{ users: VisitorUser[] }>("/api/users?role=visitor");

/** 停權／復權（C7 立即生效；DB 端 suspended → 'disabled'） */
export const setUserStatus = (id: number, status: "active" | "suspended") =>
  request<{ ok: boolean; id: number; status: string }>(`/api/users/${id}/status`, { method: "PATCH", json: { status } });

/** 調整每日寄信配額（1–200）與寄信安全閥 can_send（docs/16 D5） */
export const setUserQuota = (id: number, payload: { daily_send_quota?: number; can_send?: boolean }) =>
  request<{ ok: boolean; user_id: number; daily_send_quota: number | null; can_send: number | null }>(
    `/api/users/${id}/quota`,
    { method: "PATCH", json: payload }
  );

/** 暖機豁免（需 migration 0007；未套用時後端回 409 MIGRATION_REQUIRED） */
export const setUserWarmup = (id: number, warmupExempt: boolean) =>
  request<{ ok: boolean; user_id: number; warmup_exempt: number }>(`/api/users/${id}/warmup`, {
    method: "PATCH",
    json: { warmup_exempt: warmupExempt },
  });

/** 停用／啟用**訪客**地址（owner 專用；既有的 PATCH /api/email-addresses/:id 只認自己名下 → 對訪客 404） */
export const setVisitorAddressStatus = (id: number, status: "active" | "disabled") =>
  request<{ ok: boolean; id: number; email: string; status: string }>(`/api/email-addresses/${id}/status`, {
    method: "PATCH",
    json: { status },
  });

/**
 * 永久刪除**訪客**帳號（D9）：一併清除其地址、所有信件與附件、別名與登入計數。
 * ⚠️ 後端僅允許 `role='visitor'`（對 owner 帳號 → 403 `FORBIDDEN`）；`registration_audit` 保留。
 * ⚠️ 不可復原（前端必須先二次確認）；只是要暫停請改用 `setUserStatus(id, "suspended")`。
 */
export const deleteVisitor = (id: number) =>
  request<{ ok: boolean; id: number; username: string }>(`/api/users/${id}`, { method: "DELETE" });

// ── 互動式表單（docs/18 P2；僅自家 API，無外部連線）──

/**
 * 寄出互動式表單：後端會驗證所有收件人為本網域＋存在＋active（否則 `422
 * FORM_RECIPIENT_NOT_INTERNAL`），且**絕不呼叫 EMAIL.send()**（本地直送）。
 */
export const sendForm = (payload: FormSendPayload) =>
  request<FormSendResult>("/api/forms/send", { method: "POST", json: payload });

/**
 * 收件人取表單（四道鎖）。任何失敗（非收件人／已撤回／逾期／非互動式）都回 404
 * —— 呼叫端**不得**區分原因，一律降為靜態文字。
 */
export const getForm = (instanceId: number) => request<{ form: FormView }>(`/api/forms/${instanceId}`);

/** 送出回覆（payload 依 schema 驗證；重複送出 → FORM_ALREADY_SUBMITTED） */
export const submitFormResponse = (instanceId: number, payload: Record<string, unknown>) =>
  request<{ ok: boolean; instance_id: number; status: "submitted" }>(`/api/forms/${instanceId}/responses`, {
    method: "POST",
    json: { payload },
  });

/** 寄件人查看回覆（同一批 template 的所有實例；他人 → 403） */
export const getFormResponses = (instanceId: number) =>
  request<FormResponsesResponse>(`/api/forms/${instanceId}/responses`);

/** 寄件人撤回（同一批所有未完成實例；撤回後收件人 GET 立即 404 → 靜態） */
export const revokeForm = (instanceId: number) =>
  request<{ ok: boolean; instance_id: number; template_id: number; revoked: number }>(
    `/api/forms/${instanceId}/revoke`,
    { method: "POST" }
  );
