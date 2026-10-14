import { useState, type FormEvent } from "react";
import type { Session } from "../api/types";
import { IconCompose, IconKey, IconLogout, IconMail, IconMenu, IconSearch, IconTicket, IconUsers } from "./icons";

interface Props {
  session: Session;
  searchInput: string;
  onSearchInput: (value: string) => void;
  onSubmitSearch: () => void;
  onCompose: () => void;
  onOpenAddresses: () => void;
  onChangePassword: () => void;
  /** D7：owner 的帳號設定（自行變更密碼） */
  onOpenAccountSettings: () => void;
  /** D4：邀請碼管理 */
  onOpenInvites: () => void;
  /** D5：訪客管理（清單／停權／配額） */
  onOpenVisitors: () => void;
  /**
   * 管理主控台（帳號設定／邀請碼／訪客管理）的顯示開關
   * （`mail.`／localhost 顯示；`app.` 不顯示 —— 僅 UI 收斂，權限仍由後端判定）
   */
  showAdminConsole: boolean;
  onLogout: () => void;
  onToggleSidebar: () => void;
  /** Phase 1：配額用盡／寄信權限關閉時停用撰寫（null = 可寄信） */
  composeBlockedReason?: string | null;
}

export function Header({
  session,
  searchInput,
  onSearchInput,
  onSubmitSearch,
  onCompose,
  onOpenAddresses,
  onChangePassword,
  onOpenAccountSettings,
  onOpenInvites,
  onOpenVisitors,
  showAdminConsole,
  onLogout,
  onToggleSidebar,
  composeBlockedReason = null,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const identity = session.kind === "mailbox" ? session.email : session.username;

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
            <span className={`avatar ${session.kind === "owner" ? "avatar-owner" : ""}`}>
              {identity.charAt(0).toUpperCase()}
            </span>
          </summary>
          <div className="menu-pop">
            <div className="menu-identity">
              <strong>{identity}</strong>
              <span>{session.kind === "owner" ? "管理員" : "信箱帳號"}</span>
            </div>
            <button
              type="button"
              disabled={composeBlockedReason !== null}
              title={composeBlockedReason ?? undefined}
              onClick={() => {
                setMenuOpen(false);
                onCompose();
              }}
            >
              <IconCompose size={16} /> 撰寫新信
            </button>
            {session.kind === "owner" && (
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenAddresses();
                }}
              >
                <IconUsers size={16} /> 地址管理
              </button>
            )}
            {/* D4／D5／D7：管理主控台（僅 mail.／localhost 顯示；app. 不顯示） */}
            {showAdminConsole && (
              <>
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
                    onOpenAccountSettings();
                  }}
                >
                  <IconKey size={16} /> 帳號設定（變更密碼）
                </button>
              </>
            )}
            {session.kind === "mailbox" && (
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onChangePassword();
                }}
              >
                <IconUsers size={16} /> 變更密碼
              </button>
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
