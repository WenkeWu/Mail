import type { CountsResponse, Folder, FolderQuery, Session } from "../api/types";
import { useI18n } from "../i18n";
import {
  IconApps,
  IconArchive,
  IconCompose,
  IconInbox,
  IconSend,
  IconSettings,
  IconSpam,
  IconTicket,
  IconTrash,
  IconUsers,
} from "./icons";

/** 主視圖（信件／地址管理／別名／個人設置／管理主控台頁面） */
export type AppPage = "mail" | "addresses" | "aliases" | "settings" | "invites" | "visitors" | "apps";

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
  /** D29：個人設置（所有角色、所有 host） */
  onOpenSettings: () => void;
  /** D4：邀請碼管理 */
  onOpenInvites: () => void;
  /** D5：訪客管理／停權／配額 */
  onOpenVisitors: () => void;
  /** D26：App Clients（第三方 App 的登入整合） */
  onOpenApps: () => void;
  /**
   * 管理功能（地址管理／邀請碼／訪客／App Clients）的顯示開關
   * （`mail.`／localhost 顯示；`app.` 不顯示 —— 僅 UI 收斂，權限仍由後端判定）
   */
  showAdminConsole: boolean;
  /**
   * D29：`app.atwho.org`（public）模式 —— 側欄只留
   * 收件匣／寄件備份／垃圾桶／撰寫／個人設置；不顯示地址篩選、「我的全部信箱」與任何管理功能。
   */
  publicMode: boolean;
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
  onOpenSettings,
  onOpenInvites,
  onOpenVisitors,
  onOpenApps,
  showAdminConsole,
  publicMode,
  onCompose,
  open,
  quotaLine = null,
  composeBlockedReason = null,
}: Props) {
  const { t } = useI18n();
  // D29：public（app.atwho.org）只留下收件匣／寄件備份／垃圾桶
  const folderItems = publicMode
    ? FOLDER_ITEMS.filter((item) => item.key === "inbox" || item.key === "sent" || item.key === "trash")
    : FOLDER_ITEMS;
  return (
    <nav className={`sidebar ${open ? "open" : ""}`} aria-label={t("資料夾")}>
      <button
        type="button"
        className="btn-compose sidebar-compose"
        onClick={onCompose}
        disabled={composeBlockedReason !== null}
        title={composeBlockedReason ?? t("撰寫新信")}
      >
        <IconCompose size={18} />
        {t("撰寫")}
      </button>
      {quotaLine && (
        <p className={`quota-line ${quotaLine.sent >= quotaLine.limit || !quotaLine.canSend ? "exhausted" : ""}`}>
          {quotaLine.canSend
            ? t("今日寄信 {sent} / {limit}", { sent: quotaLine.sent, limit: quotaLine.limit })
            : t("寄信權限已關閉")}
        </p>
      )}

      <ul className="folder-list">
        {folderItems.map(({ key, label, Icon }) => {
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
                <span className="folder-label">{t(label)}</span>
                {unread > 0 && <span className="badge">{unread > 99 ? "99+" : unread}</span>}
                {unread === 0 && (c?.total ?? 0) > 0 && <span className="count-muted">{c?.total}</span>}
              </button>
            </li>
          );
        })}
      </ul>

      {/* D29：別名管理已併入「個人設置」，不再有獨立入口 */}
      {session.kind === "owner" && !publicMode && (
        <>
          <div className="sidebar-section">{t("我的信箱")}</div>
          <ul className="folder-list">
            <li>
              <button
                type="button"
                className={`folder-item ${currentPage === "mail" && addressFilter === null ? "active" : ""}`}
                onClick={() => onSelectAddress(null)}
                title={t("你名下所有地址的信件（不含其他使用者）")}
              >
                <IconUsers size={18} />
                {/* 文案修正（docs/16 §3 D5）：語意是「你名下全部地址」，不是全站所有使用者 */}
                <span className="folder-label">{t("我的全部信箱")}</span>
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
                <span className="folder-label">{t("地址管理")}</span>
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
                    <span className="folder-label">{t("邀請碼管理")}</span>
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    className={`folder-item ${currentPage === "visitors" ? "active" : ""}`}
                    onClick={onOpenVisitors}
                  >
                    <IconUsers size={18} />
                    <span className="folder-label">{t("訪客管理")}</span>
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    className={`folder-item ${currentPage === "apps" ? "active" : ""}`}
                    onClick={onOpenApps}
                    title={t("第三方 App 的登入整合（app_secret 只顯示一次）")}
                  >
                    <IconApps size={18} />
                    <span className="folder-label">{t("應用程式")}</span>
                  </button>
                </li>
              </>
            )}
          </ul>
        </>
      )}

      {/* D29：個人設置（所有角色、所有 host；選單第一項的側欄對應入口） */}
      <ul className="folder-list sidebar-settings">
        <li>
          <button
            type="button"
            className={`folder-item ${currentPage === "settings" ? "active" : ""}`}
            onClick={onOpenSettings}
          >
            <IconSettings size={18} />
            <span className="folder-label">{t("個人設置")}</span>
          </button>
        </li>
      </ul>
    </nav>
  );
}
