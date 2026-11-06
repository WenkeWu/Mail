import { useState, type FormEvent } from "react";
import type { Session } from "../api/types";
import {
  IconApps,
  IconCompose,
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
  onCompose: () => void;
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
  onLogout: () => void;
  onToggleSidebar: () => void;
  /** Phase 1：配額用盡／寄信權限關閉時停用撰寫（null = 可寄信） */
  composeBlockedReason?: string | null;
}

/**
 * 頂部列＋頭像選單（D29，docs/29 §3）。
 *
 * 選單順序：
 * 1. **個人設置**（所有 host／角色）
 * 2. 管理功能（地址管理／邀請碼／訪客／App Clients）—— 僅 `mail.` 且 owner
 * 3. 登出
 *
 * ⚠️ 選單內**不提供**「撰寫新信」：頂部列與側欄已有撰寫按鈕（owner 2026-11-06 要求）。
 *
 * ⚠️ `app.atwho.org` 即使是 owner 也不顯示任何管理功能，頭像標籤改為「個人帳號」。
 */
export function Header({
  session,
  searchInput,
  onSearchInput,
  onSubmitSearch,
  onCompose,
  onOpenSettings,
  onOpenAddresses,
  onOpenInvites,
  onOpenVisitors,
  onOpenApps,
  showAdminConsole,
  onLogout,
  onToggleSidebar,
  composeBlockedReason = null,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const identity = session.kind === "mailbox" ? session.email : session.username;
  const adminMode = session.kind === "owner" && showAdminConsole;
  const roleLabel =
    session.kind === "owner" ? (adminMode ? "管理員" : "個人帳號") : "信箱帳號";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmitSearch();
  };

  return (
    <header className="app-header">
      <button type="button" className="icon-btn sidebar-toggle" onClick={onToggleSidebar} aria-label="切換側欄">
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
          placeholder="搜尋所有信件（主旨、寄件者、內容）"
          value={searchInput}
          onChange={(e) => onSearchInput(e.target.value)}
          aria-label="搜尋信件"
        />
        {searchInput && (
          <button type="button" className="search-clear" onClick={() => onSearchInput("")} aria-label="清除搜尋">
            ×
          </button>
        )}
      </form>

      <div className="header-actions">
        <button
          type="button"
          className="btn-compose"
          onClick={onCompose}
          disabled={composeBlockedReason !== null}
          title={composeBlockedReason ?? "撰寫新信"}
        >
          <IconCompose size={17} />
          撰寫
        </button>

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
            {/* D29：選單第一項 —— 所有 host／角色都有 */}
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false);
                onOpenSettings();
              }}
            >
              <IconSettings size={16} /> 個人設置
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
                  <IconUsers size={16} /> 地址管理
                </button>
                <div className="menu-section">管理主控台</div>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenInvites();
                  }}
                >
                  <IconTicket size={16} /> 邀請碼管理
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenVisitors();
                  }}
                >
                  <IconUsers size={16} /> 訪客管理
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenApps();
                  }}
                >
                  <IconApps size={16} /> 應用程式（App Clients）
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
              <IconLogout size={16} /> 登出
            </button>
          </div>
        </details>
      </div>
    </header>
  );
}
