/**
 * client.ts — API 呼叫包裝。
 * - 每個請求都帶 `Authorization: Bearer <token>`（token 即時讀 sessionStorage）
 * - 錯誤統一轉為 ApiError{status, code, message}（訊息直接用 server 的中文說明）
 * - 已登入狀態下收到 401（UNAUTHORIZED / TOKEN_STALE）→ 發全域事件，由 App 清除 session
 *   並顯示「登入已過期」；登入端點本身的 401（密碼錯）不會觸發
 */
import { loadSession } from "../auth/session";
import { usesSameOriginApi } from "../lib/hostMode";

export const UNAUTHORIZED_EVENT = "atwhomail:unauthorized";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** 建置期注入的 API 基底（正式站以 `VITE_API_BASE=https://atwhomail-api.ulhome.workers.dev` 建置） */
const ENV_API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/+$/, "");

/**
 * API 基底網址（docs/16 D3）：
 * - `mail.atwho.org` → **空字串＝同源**：由 Pages Function `functions/api/[[path]].ts` 代理到 API Worker，
 *   並沿路轉發 Cloudflare Access 的 JWT（Access 只保護這個 hostname）
 * - 其餘（localhost／127.0.0.1／app.atwho.org／*.pages.dev）→ **維持原行為**（建置期的 VITE_API_BASE；
 *   開發時為相對路徑，交由 Vite proxy 轉往本機 API）
 *
 * ⚠️ 這只決定「請求送往哪裡」，不是權限判定（後端一律依 session 授權，docs/16 N3）。
 */
export const API_BASE = usesSameOriginApi(typeof window === "undefined" ? "" : window.location.hostname)
  ? ""
  : ENV_API_BASE;

/** 相對 API 路徑（例如信件詳情的 html_url）需經此轉為實際 URL */
export const apiUrl = (path: string): string => `${API_BASE}${path}`;

async function toError(res: Response): Promise<ApiError> {
  let code = `HTTP_${res.status}`;
  let message = `請求失敗（HTTP ${res.status}）`;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    if (body?.error?.code) code = body.error.code;
    if (body?.error?.message) message = body.error.message;
  } catch {
    /* 非 JSON 回應（例如上游 502）→ 使用預設訊息 */
  }
  return new ApiError(res.status, code, message);
}

async function fetchWithAuth(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  const session = loadSession();
  if (session?.token) headers.set("Authorization", `Bearer ${session.token}`);
  let body = rest.body;
  if (json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(json);
  }
  const res = await fetch(apiUrl(path), { ...rest, headers, body });
  if (res.status === 401 && session?.token) {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }
  return res;
}

export async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const res = await fetchWithAuth(path, init);
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** 取純文字回應（sanitized HTML 內文） */
export async function requestText(path: string): Promise<string> {
  const res = await fetchWithAuth(path);
  if (!res.ok) throw await toError(res);
  return await res.text();
}

/** 取二進位（附件下載 —— 必須帶 Bearer，不能直接用 <a href>） */
export async function requestBlob(path: string): Promise<Blob> {
  const res = await fetchWithAuth(path);
  if (!res.ok) throw await toError(res);
  return await res.blob();
}
