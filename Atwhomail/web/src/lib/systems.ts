/**
 * systems.ts — AtWho 系統入口（D37）
 *
 * Mail 是帳號中心（IdP）；登入後可切換到 Mail／Form／Now／Chat／Flow。
 * 其他系統透過 D26 一次性 code 交換取得身分，各自建立 session。
 *
 * ⚠️ `redirectUri` 必須與 Mail `app_clients.redirect_uris` 完全相符；
 *    若遠端系統改路徑，這裡與 DB 要一起更新。
 * ⚠️ Mail 本身不用 app client；其他三個系統各自的 app_secret 只放遠端後端。
 */
import type { LoginMode } from "./hostMode";

export type SystemId = "mail" | "form" | "now" | "chat" | "flow";

export interface SystemDef {
  id: SystemId;
  /** 顯示名稱（專有名詞，不翻譯） */
  name: string;
  /** 系統首頁 */
  url: string;
  /** D26 app client id；Mail 本身不需要 */
  appId: string | null;
  /** D26 callback；必須與 app_clients 白名單完全相符 */
  redirectUri: string | null;
}

export const LAST_SYSTEM_STORAGE_KEY = "atwho.lastSystem";

export const INTERNAL_SYSTEMS: readonly SystemDef[] = [
  {
    id: "mail",
    name: "Mail",
    url: "https://app.atwho.org",
    appId: null,
    redirectUri: null,
  },
  {
    id: "form",
    name: "Form",
    url: "https://form.atwho.org",
    appId: "form",
    redirectUri: "https://form.atwho.org/api/auth/atwho/callback",
  },
  {
    id: "now",
    name: "Now",
    url: "https://now.atwho.org",
    appId: "now",
    redirectUri: "https://now.atwho.org/api/auth/atwho/callback",
  },
  {
    id: "chat",
    name: "Chat",
    url: "https://chat.atwho.org",
    appId: "chat",
    redirectUri: "https://chat.atwho.org/api/auth/atwho/callback",
  },
  {
    id: "flow",
    name: "Flow",
    url: "https://flow.atwho.org",
    appId: "flow",
    redirectUri: "https://flow.atwho.org/api/auth/atwho/callback",
  },
];

export function isSystemId(value: string | null | undefined): value is SystemId {
  return INTERNAL_SYSTEMS.some((system) => system.id === value);
}

export function systemById(id: string | null | undefined): SystemDef | null {
  return INTERNAL_SYSTEMS.find((system) => system.id === id) ?? null;
}

/** 讀取「上次使用的系統」；沒有／不合法 → null */
export function getLastSystem(): SystemId | null {
  try {
    const value = localStorage.getItem(LAST_SYSTEM_STORAGE_KEY);
    return isSystemId(value) ? value : null;
  } catch {
    return null;
  }
}

/** 記住「上次使用的系統」 */
export function setLastSystem(id: SystemId): void {
  try {
    localStorage.setItem(LAST_SYSTEM_STORAGE_KEY, id);
  } catch {
    /* private mode／storage 被停用 → 忽略 */
  }
}

/** 清除偏好（登出或測試用） */
export function clearLastSystem(): void {
  try {
    localStorage.removeItem(LAST_SYSTEM_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * 登入後是否要自動前往其他系統。
 *
 * - 只在**公開入口**（app.atwho.org）自動導轉；`mail.atwho.org` 是管理入口，留在 Mail。
 * - 上次系統是 Mail／沒設定 → 留在 Mail。
 * - 回傳的系統一定具備 appId + redirectUri。
 */
export function switchTargetFor(loginMode: LoginMode, lastSystem: SystemId | null): SystemDef | null {
  if (loginMode !== "public") return null;
  if (!lastSystem || lastSystem === "mail") return null;
  const system = systemById(lastSystem);
  if (!system?.appId || !system.redirectUri) return null;
  return system;
}
