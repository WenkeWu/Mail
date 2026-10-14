import type { CountsResponse, Folder, FolderQuery, Session } from "../api/types";
import {
  IconArchive,
  IconCompose,
  IconInbox,
  IconKey,
  IconSend,
  IconSpam,
  IconTicket,
  IconTrash,
  IconUsers,
} from "./icons";

/** 主視圖（信件／地址管理／管理主控台頁面） */
export type AppPage = "mail" | "addresses" | "account" | "invites" | "visitors";

interface Props {
  session: Session;
  currentPage: AppPage;
  folder: FolderQuery;
  /** 搜尋中 → 資料夾選取暫不作用（列表為 folder=all） */
  queryActive: boolean;
  counts: CountsResponse | null;
  addressFilter: number | null;
  onSelectFolder: (folder: Folder) => void;
  onSelectAddress: (id: number | null) => void;
  onOpenAddresses: () => void;
  /** D7：owner 的帳號設定（自行變更密碼） */
  onOpenAccountSettings: () => void;
  /** D4：邀請碼管理 */
  onOpenInvites: () => void;
  /** D5：訪客管理／停權／配額 */
  onOpenVisitors: () => void;
  /**
   * 管理主控台（帳號設定／邀請碼／訪客管理）的顯示開關
   * （`mail.`／localhost 顯示；`app.` 不顯示 —— 僅 UI 收斂，權限仍由後端判定）
   */
  showAdminConsole: boolean;
  onCompose: () => void;
  open: boolean;
  /** Phase 1：visitor 的寄信配額顯示（owner 為 null） */
  quotaLine?: { sent: number; limit: number; canSend: boolean } | null;
  /** Phase 1：配額用盡／寄信權限關閉時停用撰寫（null = 可寄信） */
  composeBlockedReason?: string | null;
}

const FOLDER_ITEMS: Array<{ key: Folder; label: string; Icon: typeof IconInbox }> = [
  { key: "inbox", label: "收件匣", Icon: IconInbox },
  { key: "sent", label: "寄件備份", Icon: IconSend },
  { key: "archive", label: "封存", Icon: IconArchive },
  { key: "spam", label: "垃圾郵件", Icon: IconSpam },
  { key: "trash", label: "垃圾桶", Icon: IconTrash },
];

export function FolderSidebar({
  session,
  currentPage,
  folder,
  queryActive,
  counts,
  addressFilter,
  onSelectFolder,
  onSelectAddress,
  onOpenAddresses,
  onOpenAccountSettings,
  onOpenInvites,
  onOpenVisitors,
  showAdminConsole,
  onCompose,
  open,
  quotaLine = null,
  composeBlockedReason = null,
}: Props) {
  return (
    <nav className={`sidebar ${open ? "open" : ""}`} aria-label="資料夾">
      <button
        type="button"
        className="btn-compose sidebar-compose"
        onClick={onCompose}
        disabled={composeBlockedReason !== null}
        title={composeBlockedReason ?? "撰寫新信"}
      >
        <IconCompose size={18} />
        撰寫
      </button>
      {quotaLine && (
        <p className={`quota-line ${quotaLine.sent >= quotaLine.limit || !quotaLine.canSend ? "exhausted" : ""}`}>
          {quotaLine.canSend
            ? `今日寄信 ${quotaLine.sent} / ${quotaLine.limit}`
            : "寄信權限已關閉"}
        </p>
      )}

      <ul className="folder-list">
        {FOLDER_ITEMS.map(({ key, label, Icon }) => {
          const c = counts?.folders?.[key];
          const unread = key === "sent" ? 0 : (c?.unread ?? 0);
          const active = currentPage === "mail" && !queryActive && folder === key;
          return (
            <li key={key}>
              <button
                type="button"
                className={`folder-item ${active ? "active" : ""}`}
                onClick={() => onSelectFolder(key)}
              >
                <Icon size={18} />
                <span className="folder-label">{label}</span>
                {unread > 0 && <span className="badge">{unread > 99 ? "99+" : unread}</span>}
                {unread === 0 && (c?.total ?? 0) > 0 && <span className="count-muted">{c?.total}</span>}
              </button>
            </li>
          );
        })}
      </ul>

      {session.kind === "owner" && (
        <>
          <div className="sidebar-section">我的信箱</div>
          <ul className="folder-list">
            <li>
              <button
                type="button"
                className={`folder-item ${currentPage === "mail" && addressFilter === null ? "active" : ""}`}
                onClick={() => onSelectAddress(null)}
                title="你名下所有地址的信件（不含其他使用者）"
              >
                <IconUsers size={18} />
                {/* 文案修正（docs/16 §3 D5）：語意是「你名下全部地址」，不是全站所有使用者 */}
                <span className="folder-label">我的全部信箱</span>
              </button>
            </li>
            {(counts?.addresses ?? []).map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  className={`folder-item ${currentPage === "mail" && addressFilter === a.id ? "active" : ""}`}
                  onClick={() => onSelectAddress(a.id)}
                  title={a.email}
                >
                  <span className="folder-label ellipsis">{a.email.split("@")[0]}</span>
                  {a.unread > 0 && <span className="badge">{a.unread > 99 ? "99+" : a.unread}</span>}
                </button>
              </li>
            ))}
          </ul>
          <ul className="folder-list sidebar-bottom">
            <li>
              <button
                type="button"
                className={`folder-item ${currentPage === "addresses" ? "active" : ""}`}
                onClick={onOpenAddresses}
              >
                <IconUsers size={18} />
                <span className="folder-label">地址管理</span>
              </button>
            </li>
            {/* D4／D5／D7：管理主控台（僅 mail.／localhost 顯示；app. 不顯示） */}
            {showAdminConsole && (
              <>
                <li>
                  <button
                    type="button"
                    className={`folder-item ${currentPage === "invites" ? "active" : ""}`}
                    onClick={onOpenInvites}
                  >
                    <IconTicket size={18} />
                    <span className="folder-label">邀請碼管理</span>
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    className={`folder-item ${currentPage === "visitors" ? "active" : ""}`}
                    onClick={onOpenVisitors}
                  >
                    <IconUsers size={18} />
                    <span className="folder-label">訪客管理</span>
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    className={`folder-item ${currentPage === "account" ? "active" : ""}`}
                    onClick={onOpenAccountSettings}
                  >
                    <IconKey size={18} />
                    <span className="folder-label">帳號設定</span>
                  </button>
                </li>
              </>
            )}
          </ul>
        </>
      )}
    </nav>
  );
}
