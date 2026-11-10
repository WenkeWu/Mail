import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../api/client";
import {
  archiveMail,
  batchMail,
  deleteMail,
  downloadAttachment,
  emptyTrash,
  fetchMailHtml,
  listEmailAliases,
  getMail,
  getMailText,
  getMe,
  hardDeleteMail,
  listAddresses,
  moveMail,
  restoreMail,
  setRead,
  type MailBatchAction,
} from "../api/endpoints";
import type {
  AttachmentMeta,
  BodyState,
  EmailAddressInfo,
  EmailAlias,
  Folder,
  FolderQuery,
  MailDetail,
  MeResponse,
  Session,
} from "../api/types";
import { useCounts } from "../hooks/useCounts";
import { useMailList } from "../hooks/useMailList";
import { useMailSelection } from "../hooks/useMailSelection";
import { useI18n } from "../i18n";
import { replyFromFor } from "../lib/alias";
import { displaySender, formatFullDate, parseAddress } from "../lib/format";
import { showsAdminConsole, type LoginMode } from "../lib/hostMode";
import { joinRecipients, quoteText, withPrefix } from "../lib/recipients";
import type { SystemDef } from "../lib/systems";
import { AccountSettings } from "./AccountSettings";
import { AddressManager } from "./AddressManager";
import { AliasManager } from "./AliasManager";
import { AppClientsManager } from "./AppClientsManager";
import { ComposeWindow, type Draft, type DraftMode } from "./ComposeWindow";
import { FolderSidebar, type AppPage } from "./FolderSidebar";
import { Header } from "./Header";
import { InviteManager } from "./InviteManager";
import { MailSelectionToolbar } from "./MailSelectionToolbar";
import { MessageList } from "./MessageList";
import { ReadingPane } from "./ReadingPane";
import { Toast } from "./Toast";
import { VisitorManager } from "./VisitorManager";
import { IconRefresh } from "./icons";

const FOLDER_TITLE: Record<FolderQuery, string> = {
  inbox: "收件匣",
  sent: "寄件備份",
  archive: "封存",
  spam: "垃圾郵件",
  trash: "垃圾桶",
  all: "所有信件",
};

interface ToastState {
  message: string;
  kind: "info" | "error";
}

export function AppShell({
  session,
  hostMode,
  onSwitchSystem,
  flash,
  onFlashShown,
  onLogout,
}: {
  session: Session;
  /** 顯示模式（由 App 依 hostname 決定；docs/16 D1）——僅用於 UI 收斂，權限仍由後端判定 */
  hostMode: LoginMode;
  /** D37：切換系統（未提供時 Header 不顯示切換區塊） */
  onSwitchSystem?: (system: SystemDef) => void;
  /** D37：登入後導轉失敗等一次性訊息（以 toast 顯示） */
  flash?: string | null;
  onFlashShown?: () => void;
  onLogout: () => void;
}) {
  const [page, setPage] = useState<AppPage>("mail");
  const [folder, setFolder] = useState<Folder>("inbox");
  const [addressFilter, setAddressFilter] = useState<number | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<MailDetail | null>(null);
  const [body, setBody] = useState<BodyState>({ kind: "none" });
  const [detailLoading, setDetailLoading] = useState(false);
  const [listRefreshKey, setListRefreshKey] = useState(0);
  const [countsRefreshKey, setCountsRefreshKey] = useState(0);
  const [addresses, setAddresses] = useState<EmailAddressInfo[]>([]);
  /** D25：session scope 內的別名（回覆外部寄件者時決定 From；範圍 A） */
  const [aliases, setAliases] = useState<EmailAlias[]>([]);
  const [aliasRefreshKey, setAliasRefreshKey] = useState(0);
  /** Phase 1：session 身分與寄信配額（visitor 顯示配額、配額用盡則停用撰寫） */
  const [me, setMe] = useState<MeResponse | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftDirty, setDraftDirty] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [downloadingId, setDownloadingId] = useState<number | null>(null);
  const { t } = useI18n();

  /**
   * 管理功能（地址管理、邀請碼／訪客／App Clients）只在 `mail.`（admin）與本機開發（all）顯示；
   * `app.`（public，訪客入口）**即使是 owner 也完全隱藏**（D29，docs/29 §2.1）。
   * ⚠️ 純 UI 收斂——後端仍以 session 的 owner scope 判定（N3）。
   */
  const canUseAdminConsole = session.kind === "owner" && showsAdminConsole(hostMode);
  /** D29：`app.atwho.org`（public）—— 沿用 `showsAdminConsole` 的反向判斷 */
  const publicMode = !showsAdminConsole(hostMode);

  const searchActive = query !== "";
  const listFolder: string = searchActive ? "all" : folder;

  const { items, nextCursor, loading, loadingMore, error, loadMore, removeItem, patchItem } = useMailList({
    folder: listFolder,
    q: query,
    addressId: addressFilter,
    refreshKey: listRefreshKey,
  });
  const counts = useCounts(countsRefreshKey);
  /**
   * 複選（docs/19 §3）。`scopeKey` 一變（資料夾／地址／搜尋）即清空選取，
   * 避免把上一份清單的 id 帶到新清單做批次動作。
   */
  const {
    selectedIds,
    select,
    toggle: toggleSelection,
    selectAll,
    clear: clearSelection,
  } = useMailSelection(items, `${listFolder}|${addressFilter ?? ""}|${query}`);
  const [batchBusy, setBatchBusy] = useState(false);
  const [emptyTrashBusy, setEmptyTrashBusy] = useState(false);

  /**
   * 垃圾桶總封數（session scope）。用於「清空垃圾桶」的二次確認文案；
   * `GET /api/mail/counts` 尚未載入時，退回目前清單長度（至少不是 0）。
   */
  const trashCount = counts?.folders?.trash?.total ?? (listFolder === "trash" ? items.length : 0);

  /**
   * docs/19 D19-4：表頭「全選」checkbox。
   * 只以**目前載入的清單**（`items`）計算，不跨資料夾、不含尚未載入的分頁。
   * 全部已選 → checked；部分已選 → indeterminate（DOM 屬性以 ref 設定）。
   */
  const selectedInListCount = useMemo(
    () => items.reduce((count, item) => (selectedIds.has(item.id) ? count + 1 : count), 0),
    [items, selectedIds]
  );
  const allInListSelected = items.length > 0 && selectedInListCount === items.length;
  const someInListSelected = selectedInListCount > 0;
  const selectAllRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someInListSelected && !allInListSelected;
    }
  }, [someInListSelected, allInListSelected]);

  const showToast = useCallback((message: string, kind: "info" | "error" = "info") => {
    setToast({ message, kind });
  }, []);

  // D37：把 App 層的一次性錯誤（例如切換系統失敗）顯示成 toast
  useEffect(() => {
    if (!flash) return;
    showToast(flash, "error");
    onFlashShown?.();
  }, [flash, onFlashShown, showToast]);

  // Phase 1：身分與配額（visitor 的寄信額度；配額用盡時停用撰寫）
  useEffect(() => {
    let cancelled = false;
    getMe()
      .then((res) => {
        if (!cancelled) setMe(res);
      })
      .catch(() => {
        /* 401 由全域處理；其餘不阻斷主流程 */
      });
    return () => {
      cancelled = true;
    };
  }, [session, countsRefreshKey]);

  /** 撰寫被擋的原因（null = 可寄信）。owner 需「所有地址」都被擋才擋。 */
  const composeBlockedReason = useMemo(() => {
    if (!me || me.addresses.length === 0) return null;
    // D34：以**有效**上限判斷（暖機期是 min(配額, 5)），否則 UI 會以為還能寄
    const blocked = me.addresses.filter((a) => a.can_send !== 1 || a.sent_today >= a.effective_daily_quota);
    if (blocked.length < me.addresses.length) return null;
    return blocked[0]!.can_send !== 1
      ? t("此帳號的寄信權限已關閉，請聯絡管理者")
      : t("今日寄信額度已用完（每日 00:00 UTC 重置）");
  }, [me, t]);

  /** 側欄配額顯示（僅 visitor，依 docs/14 §4.5） */
  const quotaLine = useMemo(() => {
    if (!me || me.role !== "visitor" || !me.addresses[0]) return null;
    const a = me.addresses[0];
    // D34：顯示**有效**上限（暖機期為 5），並帶上暖機結束時間供提示
    return {
      sent: a.sent_today,
      limit: a.effective_daily_quota,
      canSend: a.can_send === 1,
      warmupUntil: a.warmup_until,
    };
  }, [me]);

  // owner：地址清單（寄件者選單 + 地址過濾）
  useEffect(() => {
    if (session.kind !== "owner") return;
    let cancelled = false;
    listAddresses()
      .then((res) => {
        if (!cancelled) setAddresses(res.addresses);
      })
      .catch(() => {
        /* 401 由全域處理；其餘不阻斷主流程 */
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  // D25：別名清單（owner 全部／mailbox 自己地址的）——回覆時判斷 From 用
  useEffect(() => {
    let cancelled = false;
    listEmailAliases()
      .then((res) => {
        if (!cancelled) setAliases(res.aliases);
      })
      .catch(() => {
        /* 401 由全域處理；其餘不阻斷主流程（回覆時會再嘗試重抓） */
      });
    return () => {
      cancelled = true;
    };
  }, [session, aliasRefreshKey]);

  const ownAddresses = useMemo(() => {
    if (session.kind === "mailbox") return new Set([session.email.toLowerCase()]);
    return new Set(addresses.map((a) => a.email.toLowerCase()));
  }, [session, addresses]);

  /**
   * D31：真實 ID 固定在帳號的第一個 active 地址（owner 多地址時也一樣，不在撰寫視窗切換）。
   * mailbox session 固定為自己的地址。
   */
  const defaultFrom = useMemo(() => {
    if (session.kind === "mailbox") return session.email;
    return addresses.find((a) => a.status === "active")?.email ?? "";
  }, [session, addresses]);

  // ── 開信（含內文載入與自動標已讀）──
  const selectSeq = useRef(0);
  const selectMail = useCallback(
    async (id: number) => {
      const seq = ++selectSeq.current;
      setSelectedId(id);
      setDetail(null);
      setDetailLoading(true);
      setBody({ kind: "none" });
      setSidebarOpen(false);
      try {
        const d = await getMail(id);
        if (seq !== selectSeq.current) return;
        setDetail(d);
        setBody({ kind: "loading" });

        let nextBody: BodyState = { kind: "empty" };
        if (d.html_url) {
          try {
            const html = await fetchMailHtml(d.id);
            nextBody = { kind: "html", html };
          } catch {
            nextBody = { kind: "empty" };
          }
        }
        if (nextBody.kind === "empty") {
          try {
            const t = await getMailText(d.id);
            nextBody = t.text ? { kind: "text", text: t.text } : { kind: "empty" };
          } catch {
            nextBody = d.text_preview ? { kind: "text", text: d.text_preview } : { kind: "empty" };
          }
        }
        if (seq !== selectSeq.current) return;
        setBody(nextBody);

        if (d.read_at === null) {
          patchItem(id, { read: true });
          setDetail((prev) => (prev && prev.id === id ? { ...prev, read_at: Date.now() } : prev));
          try {
            await setRead(id, true);
            setCountsRefreshKey((k) => k + 1);
          } catch {
            /* 標已讀失敗不影響閱讀 */
          }
        }
      } catch (e) {
        if (seq !== selectSeq.current) return;
        setBody({ kind: "none" });
        showToast(e instanceof ApiError ? e.message : t("無法載入信件"), "error");
      } finally {
        if (seq === selectSeq.current) setDetailLoading(false);
      }
    },
    [patchItem, showToast, t]
  );

  const closeReading = useCallback(() => {
    selectSeq.current++;
    setSelectedId(null);
    setDetail(null);
    setBody({ kind: "none" });
  }, []);

  // ── 信件動作（本地更新列表，只重抓統計）──
  const afterRemoved = useCallback(
    (id: number) => {
      removeItem(id);
      if (selectedId === id) closeReading();
      // 單封動作後同步清掉選取，避免工具列停留在已不存在的 id（批次動作另由 handleBatch 清除）
      clearSelection();
      setCountsRefreshKey((k) => k + 1);
    },
    [removeItem, selectedId, closeReading, clearSelection]
  );

  const handleArchive = useCallback(async () => {
    if (!detail) return;
    try {
      await archiveMail(detail.id);
      afterRemoved(detail.id);
      showToast(t("已封存"));
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : t("封存失敗"), "error");
    }
  }, [detail, afterRemoved, showToast, t]);

  const handleMove = useCallback(
    async (target: "inbox" | "spam" | "trash") => {
      if (!detail) return;
      try {
        await moveMail(detail.id, target);
        afterRemoved(detail.id);
        showToast(t("已移至{target}", { target: t(FOLDER_TITLE[target]) }));
      } catch (e) {
        showToast(e instanceof ApiError ? e.message : t("搬移失敗"), "error");
      }
    },
    [detail, afterRemoved, showToast, t]
  );

  const handleDelete = useCallback(async () => {
    if (!detail) return;
    try {
      await deleteMail(detail.id);
      afterRemoved(detail.id);
      showToast(t("已移至垃圾桶"));
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : t("刪除失敗"), "error");
    }
  }, [detail, afterRemoved, showToast, t]);

  /** docs/19 D19-3：單封還原（僅垃圾桶；成功後關閉 ReadingPane、更新清單與計數） */
  const handleRestore = useCallback(async () => {
    if (!detail) return;
    try {
      await restoreMail(detail.id);
      afterRemoved(detail.id);
      showToast(t("已還原至收件匣"));
    } catch (e) {
      // 失敗時保留目前畫面（不清空、不關閉）
      showToast(e instanceof ApiError ? e.message : t("還原失敗"), "error");
    }
  }, [detail, afterRemoved, showToast, t]);

  /** docs/19 D19-3：單封永久刪除（二次確認 → hard delete；不可復原） */
  const handleHardDelete = useCallback(async () => {
    if (!detail) return;
    const label = detail.subject || t("(無主旨)");
    if (!window.confirm(t("將永久刪除「{label}」（含附件與原始檔），無法復原", { label }))) return;
    try {
      await hardDeleteMail(detail.id);
      afterRemoved(detail.id);
      showToast(t("已永久刪除"));
    } catch (e) {
      // 失敗時保留目前畫面（不清空、不關閉）
      showToast(e instanceof ApiError ? e.message : t("永久刪除失敗"), "error");
    }
  }, [detail, afterRemoved, showToast, t]);

  /**
   * docs/19 D19-3：清空垃圾桶。
   * 二次確認的 N 取自 `counts.folders.trash.total`（session scope，與端點刪除範圍一致）；
   * 成功後顯示 `{count, r2_objects}` 摘要，並重新載入清單與資料夾計數。
   */
  const handleEmptyTrash = useCallback(async () => {
    if (emptyTrashBusy) return;
    const count = trashCount;
    if (!window.confirm(t("將永久刪除 {count} 封（含附件與原始檔），無法復原", { count }))) return;
    setEmptyTrashBusy(true);
    try {
      const res = await emptyTrash();
      if (detail?.folder === "trash") closeReading();
      clearSelection();
      setListRefreshKey((k) => k + 1);
      setCountsRefreshKey((k) => k + 1);
      showToast(t("已清空垃圾桶：永久刪除 {count} 封、{objects} 個附件／原始檔物件", {
        count: res.count,
        objects: res.r2_objects,
      }));
    } catch (e) {
      // 失敗時保留清單與畫面，只顯示錯誤
      showToast(e instanceof ApiError ? e.message : t("清空垃圾桶失敗"), "error");
    } finally {
      setEmptyTrashBusy(false);
    }
  }, [emptyTrashBusy, trashCount, detail, closeReading, clearSelection, showToast, t]);

  const handleToggleRead = useCallback(
    async (read: boolean) => {
      if (!detail) return;
      try {
        await setRead(detail.id, read);
        patchItem(detail.id, { read });
        setDetail((prev) => (prev && prev.id === detail.id ? { ...prev, read_at: read ? Date.now() : null } : prev));
        setCountsRefreshKey((k) => k + 1);
      } catch (e) {
        showToast(e instanceof ApiError ? e.message : t("操作失敗"), "error");
      }
    },
    [detail, patchItem, showToast, t]
  );

  // ── 複選／批次（docs/19 D19-2）──
  /** 列表點擊：shift／ctrl 只改選取；一般點擊同時開信 */
  const handleRowSelect = useCallback(
    (id: number, event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
      const open = select(id, event);
      if (open) void selectMail(id);
    },
    [select, selectMail]
  );

  /**
   * docs/19 D19-4：每列 checkbox。
   * 一般點擊＝切換單封（不需要 Ctrl／Cmd）；Shift＋點＝範圍連選。
   * ⚠️ 只改選取，**不得開信**（`toggleSelection` 永遠回傳 false，也不呼叫 selectMail）。
   */
  const handleCheckboxToggle = useCallback(
    (id: number, event: { shiftKey: boolean }) => {
      toggleSelection(id, { shiftKey: event.shiftKey });
    },
    [toggleSelection]
  );

  const handleBatch = useCallback(
    async (action: MailBatchAction) => {
      const ids = [...selectedIds];
      if (ids.length === 0) return;
      setBatchBusy(true);
      try {
        await batchMail(action, ids);
        if (action === "read") {
          for (const id of ids) patchItem(id, { read: true });
          showToast(t("已將 {count} 封標為已讀", { count: ids.length }));
        } else {
          for (const id of ids) removeItem(id);
          if (selectedId !== null && ids.includes(selectedId)) closeReading();
          showToast(
            action === "trash"
              ? t("已將 {count} 封移至垃圾桶", { count: ids.length })
              : action === "restore"
                ? t("已還原 {count} 封", { count: ids.length })
                : t("已永久刪除 {count} 封", { count: ids.length })
          );
        }
        setCountsRefreshKey((k) => k + 1);
        clearSelection();
      } catch (e) {
        // 後端整批未執行（例如任一 id 越權 → 404）→ 保留選取讓使用者修正
        showToast(e instanceof ApiError ? e.message : t("批次操作失敗"), "error");
      } finally {
        setBatchBusy(false);
      }
    },
    [selectedIds, patchItem, removeItem, selectedId, closeReading, showToast, clearSelection, t]
  );

  const handleBatchPurge = useCallback(() => {
    if (selectedIds.size === 0) return;
    if (!window.confirm(t("永久刪除 {count} 封信？此動作無法復原。", { count: selectedIds.size }))) return;
    void handleBatch("purge");
  }, [selectedIds, handleBatch, t]);

  const handleDownload = useCallback(
    async (att: AttachmentMeta) => {
      setDownloadingId(att.id);
      try {
        const blob = await downloadAttachment(att.id);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = att.filename || "attachment";
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 15_000);
      } catch (e) {
        showToast(e instanceof ApiError ? e.message : t("下載失敗"), "error");
      } finally {
        setDownloadingId(null);
      }
    },
    [showToast]
  );

  // ── 撰寫 ──
  const openDraft = useCallback(
    (partial: Partial<Omit<Draft, "key">>) => {
      setDraft((prev) => ({
        key: (prev?.key ?? 0) + 1,
        mode: "new",
        from: defaultFrom,
        to: "",
        cc: "",
        bcc: "",
        subject: "",
        bodyText: "",
        ...partial,
      }));
      setDraftDirty(false);
    },
    [defaultFrom]
  );

  const guardDraft = useCallback((): boolean => {
    if (draft && draftDirty) {
      return window.confirm(t("目前有未寄出的信件，確定要放棄並開新的撰寫視窗嗎？"));
    }
    return true;
  }, [draft, draftDirty, t]);

  const openCompose = useCallback(() => {
    if (!guardDraft()) return;
    if (composeBlockedReason) {
      showToast(composeBlockedReason, "error");
      return;
    }
    if (session.kind === "owner" && addresses.filter((a) => a.status === "active").length === 0) {
      showToast(
        publicMode
          ? t("目前沒有可用的寄件地址，請聯絡管理者")
          : t("目前沒有可用的寄件地址，請先到「地址管理」建立地址"),
        "error"
      );
      return;
    }
    openDraft({ mode: "new" });
  }, [guardDraft, openDraft, session, addresses, showToast, composeBlockedReason, publicMode, t]);

  const openReplyLike = useCallback(
    async (mode: DraftMode) => {
      if (!detail) return;
      if (!guardDraft()) return;
      let original = detail.text_preview ?? "";
      try {
        const t = await getMailText(detail.id);
        if (t.text) original = t.text;
      } catch {
        /* 退回 preview */
      }
      const sender = parseAddress(detail.from).address.toLowerCase();
      const quoteHeader = `\n\n${t("在 {date}，{sender} 寫道：", {
        date: formatFullDate(detail.received_at),
        sender: displaySender(detail.from),
      })}\n`;
      const quoted = `${quoteHeader}${quoteText(original)}`;

      /**
       * D25（docs/25 §5、範圍 A）：只有「回覆」才依別名決定 From。
       * 外部寄件者 → 別名；@atwho.org 內部寄件者 → 別名的目標真實地址。
       * 這裡重抓一次清單，避免使用者剛建立／停用別名後狀態過期。
       */
      let from = defaultFrom;
      if (mode !== "forward" && detail.envelope_to) {
        let latest = aliases;
        try {
          const res = await listEmailAliases();
          latest = res.aliases;
          setAliases(latest);
        } catch {
          /* 取不到就用既有快取；退回預設地址 */
        }
        from = replyFromFor({
          envelopeTo: detail.envelope_to,
          sender: detail.from,
          aliases: latest,
          fallbackFrom: defaultFrom,
        });
      }

      if (mode === "reply") {
        openDraft({ mode, from, to: sender, subject: withPrefix(detail.subject, "Re:"), bodyText: quoted });
      } else if (mode === "replyAll") {
        const to = [sender, ...detail.to.map((a) => a.address.toLowerCase())].filter(
          (a) => a && !ownAddresses.has(a)
        );
        const cc = detail.cc.map((a) => a.address.toLowerCase()).filter((a) => a && !ownAddresses.has(a));
        openDraft({
          mode,
          from,
          to: joinRecipients([...new Set(to)]),
          cc: joinRecipients([...new Set(cc)]),
          subject: withPrefix(detail.subject, "Re:"),
          bodyText: quoted,
        });
      } else {
        const fwdHeader =
          `\n\n---------- ${t("轉寄郵件")} ----------\n` +
          `${t("寄件者：")}${detail.from}\n` +
          `${t("日期：")}${formatFullDate(detail.received_at)}\n` +
          `${t("主旨：")}${detail.subject ?? t("(無主旨)")}\n` +
          `${t("收件者：")}${detail.to.map((a) => a.address).join(", ") || "—"}\n\n`;
        openDraft({
          mode,
          to: "",
          subject: withPrefix(detail.subject, "Fwd:"),
          bodyText: `${fwdHeader}${original}`,
        });
      }
    },
    [detail, guardDraft, openDraft, ownAddresses, aliases, defaultFrom, t]
  );

  const handleSent = useCallback(
    (info: { from: string; to: string[] }) => {
      setDraft(null);
      setDraftDirty(false);
      showToast(t("已寄出：{to}", { to: info.to.join(", ") }));
      setCountsRefreshKey((k) => k + 1);
      if (listFolder === "sent" || listFolder === "all") setListRefreshKey((k) => k + 1);
    },
    [showToast, listFolder, t]
  );

  // ── 導覽 ──
  const selectFolder = (f: Folder) => {
    setFolder(f);
    setQuery("");
    setSearchInput("");
    setPage("mail");
    closeReading();
    setSidebarOpen(false);
  };

  const selectAddress = (id: number | null) => {
    setAddressFilter(id);
    setPage("mail");
    closeReading();
    setSidebarOpen(false);
  };

  const submitSearch = () => {
    const q = searchInput.trim();
    setQuery(q);
    setPage("mail");
    closeReading();
  };

  const listTitle = searchActive
    ? t("搜尋「{query}」", { query })
    : addressFilter !== null
      ? `${t(FOLDER_TITLE[folder])} · ${addresses.find((a) => a.id === addressFilter)?.email.split("@")[0] ?? ""}`
      : t(FOLDER_TITLE[folder]);

  return (
    <div className={`app ${page !== "mail" ? "app-page" : ""}`}>
      <Header
        session={session}
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        onSubmitSearch={submitSearch}
        onOpenSettings={() => setPage("settings")}
        onOpenAddresses={() => setPage("addresses")}
        onOpenInvites={() => setPage("invites")}
        onOpenVisitors={() => setPage("visitors")}
        onOpenApps={() => setPage("apps")}
        showAdminConsole={canUseAdminConsole}
        onSwitchSystem={onSwitchSystem}
        onLogout={onLogout}
        onToggleSidebar={() => {
          // 子頁面（個人設置／地址管理…）沒有渲染側欄 → 這個按鈕改為「回到信箱」。
          if (page !== "mail") {
            setPage("mail");
            setSidebarOpen(false);
            return;
          }
          setSidebarOpen((v) => !v);
        }}
        sidebarToggleLabel={page === "mail" ? t("切換側欄") : t("回到信箱")}
      />

      {page === "addresses" && canUseAdminConsole ? (
        <AddressManager
          session={session}
          onBack={() => setPage("mail")}
          onToast={showToast}
        />
      ) : page === "settings" ? (
        <AccountSettings
          session={session}
          onBack={() => setPage("mail")}
          onLogout={onLogout}
          onToast={showToast}
          onAliasChanged={() => setAliasRefreshKey((k) => k + 1)}
        />
      ) : page === "aliases" ? (
        <AliasManager
          session={session}
          onBack={() => setPage("settings")}
          onToast={showToast}
          onChanged={() => setAliasRefreshKey((k) => k + 1)}
        />
      ) : page === "invites" && canUseAdminConsole ? (
        <InviteManager onBack={() => setPage("mail")} onToast={showToast} />
      ) : page === "visitors" && canUseAdminConsole ? (
        <VisitorManager onBack={() => setPage("mail")} onToast={showToast} />
      ) : page === "apps" && canUseAdminConsole ? (
        <AppClientsManager onBack={() => setPage("mail")} onToast={showToast} />
      ) : (
        <>
          <FolderSidebar
            session={session}
            currentPage={page}
            folder={folder}
            queryActive={searchActive}
            counts={counts}
            addressFilter={addressFilter}
            onSelectFolder={selectFolder}
            onSelectAddress={selectAddress}
            onOpenAddresses={() => setPage("addresses")}
            onOpenSettings={() => setPage("settings")}
            onOpenInvites={() => setPage("invites")}
            onOpenVisitors={() => setPage("visitors")}
            onOpenApps={() => setPage("apps")}
            showAdminConsole={canUseAdminConsole}
            publicMode={publicMode}
            onCompose={openCompose}
            open={sidebarOpen}
            quotaLine={quotaLine}
            composeBlockedReason={composeBlockedReason}
          />

          <section className={`list-pane ${selectedId !== null ? "has-selection" : ""}`}>
            <div className="list-head">
              {/* 表頭全選（docs/19 §6 D19-4）：全部已選／部分已選（indeterminate）／未選 */}
              <input
                ref={selectAllRef}
                type="checkbox"
                className="list-select-all"
                aria-label={t("全選信件")}
                title={t("全選目前清單的信件")}
                checked={allInListSelected}
                disabled={items.length === 0}
                onChange={() => {
                  if (allInListSelected) clearSelection();
                  else selectAll();
                }}
              />
              <h2>{listTitle}</h2>
              <button
                type="button"
                className="icon-btn"
                title={t("重新整理")}
                onClick={() => setListRefreshKey((k) => k + 1)}
              >
                <IconRefresh size={17} />
              </button>
            </div>
            {searchActive && (
              <div className="search-bar">
                {t("跨資料夾搜尋結果")}
                <button
                  type="button"
                  onClick={() => {
                    setQuery("");
                    setSearchInput("");
                  }}
                >
                  {t("清除搜尋")}
                </button>
              </div>
            )}
            <MailSelectionToolbar
              count={selectedIds.size}
              folder={listFolder}
              trashCount={trashCount}
              busy={batchBusy || emptyTrashBusy}
              onTrash={() => void handleBatch("trash")}
              onRestore={() => void handleBatch("restore")}
              onPurge={handleBatchPurge}
              onEmptyTrash={() => void handleEmptyTrash()}
              onMarkRead={() => void handleBatch("read")}
              onClear={clearSelection}
            />
            <MessageList
              items={items}
              loading={loading}
              loadingMore={loadingMore}
              error={error}
              nextCursor={nextCursor}
              selectedIds={selectedIds}
              showFolderChip={searchActive}
              query={query}
              onLoadMore={loadMore}
              onSelect={handleRowSelect}
              onToggleSelect={handleCheckboxToggle}
              onSelectAll={selectAll}
            />
          </section>

          <ReadingPane
            detail={detail}
            body={body}
            loading={detailLoading}
            downloadingId={downloadingId}
            onClose={closeReading}
            onReply={() => void openReplyLike("reply")}
            onReplyAll={() => void openReplyLike("replyAll")}
            onForward={() => void openReplyLike("forward")}
            onToggleRead={(read) => void handleToggleRead(read)}
            onArchive={() => void handleArchive()}
            onMove={(f) => void handleMove(f)}
            onDelete={() => void handleDelete()}
            onRestore={() => void handleRestore()}
            onHardDelete={() => void handleHardDelete()}
            onDownloadAttachment={(att) => void handleDownload(att)}
          />
        </>
      )}

      {draft && (
        <ComposeWindow
          key={draft.key}
          draft={draft}
          session={session}
          addresses={addresses}
          aliases={aliases}
          onClose={() => {
            if (draftDirty && !window.confirm(t("放棄這封未寄出的信件？"))) return;
            setDraft(null);
            setDraftDirty(false);
          }}
          onDirty={() => setDraftDirty(true)}
          onSent={handleSent}
          onError={(message) => showToast(message, "error")}
        />
      )}

      {toast && <Toast message={toast.message} kind={toast.kind} onClose={() => setToast(null)} />}
    </div>
  );
}
