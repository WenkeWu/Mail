import { useState, type FormEvent } from "react";
import type { Session } from "../api/types";
import { useI18n } from "../i18n";
import { INTERNAL_SYSTEMS, type SystemDef } from "../lib/systems";
import {
  IconApps,
  IconLogout,
  IconMail,
  IconMenu,
  IconSearch,
  IconSettings,
  IconTicket,
  IconUsers,
} from "./icons";

interface Props {
  session: Session;
  searchInput: string;
  onSearchInput: (value: string) => void;
  onSubmitSearch: () => void;
  /** D29：個人設置（所有角色、所有 host 都有；選單第一項） */
  onOpenSettings: () => void;
  /** 地址管理：僅 `mail.`／localhost 的 owner 顯示（D29 host 收斂） */
  onOpenAddresses: () => void;
  /** D4：邀請碼管理（僅管理主控台） */
  onOpenInvites: () => void;
  /** D5：訪客管理（清單／停權／配額；僅管理主控台） */
  onOpenVisitors: () => void;
  /** D26：App Clients（第三方 App 登入整合；僅管理主控台） */
  onOpenApps: () => void;
  /**
   * 管理功能（地址管理／邀請碼／訪客／App Clients）的顯示開關。
   * `mail.`／localhost 為 true；`app.atwho.org`（public）為 false。
   * ⚠️ 僅 UI 收斂，權限仍由後端依 session scope 判定（N3）。
   */
  showAdminConsole: boolean;
  /** D37：切換到 Mail／Form／Now／Chat（未提供時不顯示切換區塊） */
  onSwitchSystem?: (system: SystemDef) => void;
  onLogout: () => void;
  /** 手機版側欄鈕：信箱頁＝切換側欄；子頁面＝回到信箱（AppShell 依 page 決定行為） */
  onToggleSidebar: () => void;
  /** 側欄鈕的無障礙名稱；預設「切換側欄」 */
  sidebarToggleLabel?: string;
}

/**
 * 頂部列＋頭像選單（D29，docs/29 §3）。
 *
 * 選單順序：
 * 1. **切換系統**（D37：Mail／Form／Now／Chat；登入後才有）
 * 2. **個人設置**（所有 host／角色）
 * 3. 管理功能（地址管理／邀請碼／訪客／App Clients）—— 僅 `mail.` 且 owner
 * 4. 登出
 *
 * ⚠️ 撰寫按鈕只在側欄（頂部列不重複提供；owner 2026-11-06 要求）。
 *
 * ⚠️ `app.atwho.org` 即使是 owner 也不顯示任何管理功能，頭像標籤改為「個人帳號」。
 */
export function Header({
  session,
  searchInput,
  onSearchInput,
  onSubmitSearch,
  onOpenSettings,
  onOpenAddresses,
  onOpenInvites,
  onOpenVisitors,
  onOpenApps,
  showAdminConsole,
  onSwitchSystem,
  onLogout,
  onToggleSidebar,
  sidebarToggleLabel,
}: Props) {
  const { t } = useI18n();
  const toggleLabel = sidebarToggleLabel ?? t("切換側欄");
  const [menuOpen, setMenuOpen] = useState(false);
  const identity = session.kind === "mailbox" ? session.email : session.username;
  const adminMode = session.kind === "owner" && showAdminConsole;
  const roleLabel =
    session.kind === "owner" ? (adminMode ? t("管理員") : t("個人帳號")) : t("信箱帳號");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmitSearch();
  };

  return (
    <header className="app-header">
      <button
        type="button"
        className="icon-btn sidebar-toggle"
        onClick={onToggleSidebar}
        aria-label={toggleLabel}
        title={toggleLabel}
      >
        <IconMenu size={20} />
      </button>
      <div className="header-brand">
        <span className="brand-mark small">
          <IconMail size={18} />
        </span>
        <span className="brand-name">AtWhoMail</span>
      </div>

      <form className="search-form" onSubmit={submit} role="search">
        <span className="search-icon">
          <IconSearch size={18} />
        </span>
        <input
          type="search"
          placeholder={t("搜尋所有信件（主旨、寄件者、內容）")}
          value={searchInput}
          onChange={(e) => onSearchInput(e.target.value)}
          aria-label={t("搜尋信件")}
        />
        {searchInput && (
          <button type="button" className="search-clear" onClick={() => onSearchInput("")} aria-label={t("清除搜尋")}>
            ×
          </button>
        )}
      </form>

      <div className="header-actions">
        <details
          className="account-menu"
          open={menuOpen}
          onToggle={(e) => setMenuOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary title={identity}>
            <span className={`avatar ${adminMode ? "avatar-owner" : ""}`}>
              {identity.charAt(0).toUpperCase()}
            </span>
          </summary>
          <div className="menu-pop">
            <div className="menu-identity">
              <strong>{identity}</strong>
              <span>{roleLabel}</span>
            </div>
            {/* D37：四系統入口；Mail 本身＝留在目前頁面 */}
            {onSwitchSystem && (
              <>
                <div className="menu-section">{t("切換系統")}</div>
                {INTERNAL_SYSTEMS.map((system) => (
                  <button
                    key={system.id}
                    type="button"
                    onClick={() => {
                      setMenuOpen(false);
                      onSwitchSystem(system);
                    }}
                  >
                    {system.name}
                  </button>
                ))}
              </>
            )}
            {/* D29：個人設置 —— 所有 host／角色都有 */}
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                onOpenSettings();
              }}
            >
              <IconSettings size={16} /> {t("個人設置")}
            </button>
            {/* D29：管理功能 —— 僅 mail.／localhost 的 owner（app. 完全隱藏） */}
            {adminMode && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenAddresses();
                  }}
                >
                  <IconUsers size={16} /> {t("地址管理")}
                </button>
                <div className="menu-section">{t("管理主控台")}</div>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenInvites();
                  }}
                >
                  <IconTicket size={16} /> {t("邀請碼管理")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenVisitors();
                  }}
                >
                  <IconUsers size={16} /> {t("訪客管理")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenApps();
                  }}
                >
                  <IconApps size={16} /> {t("應用程式（App Clients）")}
                </button>
              </>
            )}
            <button
              type="button"
              className="danger"
              onClick={() => {
                setMenuOpen(false);
                onLogout();
              }}
            >
              <IconLogout size={16} /> {t("登出")}
            </button>
          </div>
        </details>
      </div>
    </header>
  );
}
