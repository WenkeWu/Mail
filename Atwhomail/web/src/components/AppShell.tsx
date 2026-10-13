import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../api/client";
import {
  archiveMail,
  deleteMail,
  downloadAttachment,
  fetchMailHtml,
  getMail,
  getMailText,
  getMe,
  listAddresses,
  moveMail,
  setRead,
} from "../api/endpoints";
import type {
  AttachmentMeta,
  BodyState,
  EmailAddressInfo,
  Folder,
  FolderQuery,
  MailDetail,
  MeResponse,
  Session,
} from "../api/types";
import { useCounts } from "../hooks/useCounts";
import { useMailList } from "../hooks/useMailList";
import { displaySender, formatFullDate, parseAddress } from "../lib/format";
import { joinRecipients, quoteText, withPrefix } from "../lib/recipients";
import { AddressManager } from "./AddressManager";
import { ComposeWindow, type Draft, type DraftMode } from "./ComposeWindow";
import { FolderSidebar } from "./FolderSidebar";
import { Header } from "./Header";
import { MessageList } from "./MessageList";
import { ReadingPane } from "./ReadingPane";
import { Toast } from "./Toast";
import { IconRefresh } from "./icons";

const LAST_FROM_KEY = "atwhomail.lastFrom";

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

export function AppShell({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [page, setPage] = useState<"mail" | "addresses">("mail");
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
  /** Phase 1：session 身分與寄信配額（visitor 顯示配額、配額用盡則停用撰寫） */
  const [me, setMe] = useState<MeResponse | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftDirty, setDraftDirty] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [downloadingId, setDownloadingId] = useState<number | null>(null);

  const searchActive = query !== "";
  const listFolder: string = searchActive ? "all" : folder;

  const { items, nextCursor, loading, loadingMore, error, loadMore, removeItem, patchItem } = useMailList({
    folder: listFolder,
    q: query,
    addressId: addressFilter,
    refreshKey: listRefreshKey,
  });
  const counts = useCounts(countsRefreshKey);

  const showToast = useCallback((message: string, kind: "info" | "error" = "info") => {
    setToast({ message, kind });
  }, []);

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
    const blocked = me.addresses.filter((a) => a.can_send !== 1 || a.sent_today >= a.daily_send_quota);
    if (blocked.length < me.addresses.length) return null;
    return blocked[0]!.can_send !== 1
      ? "此帳號的寄信權限已關閉，請聯絡管理者"
      : "今日寄信額度已用完（每日 00:00 UTC 重置）";
  }, [me]);

  /** 側欄配額顯示（僅 visitor，依 docs/14 §4.5） */
  const quotaLine = useMemo(() => {
    if (!me || me.role !== "visitor" || !me.addresses[0]) return null;
    const a = me.addresses[0];
    return { sent: a.sent_today, limit: a.daily_send_quota, canSend: a.can_send === 1 };
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

  const ownAddresses = useMemo(() => {
    if (session.kind === "mailbox") return new Set([session.email.toLowerCase()]);
    return new Set(addresses.map((a) => a.email.toLowerCase()));
  }, [session, addresses]);

  const defaultFrom = useMemo(() => {
    if (session.kind === "mailbox") return session.email;
    const active = addresses.filter((a) => a.status === "active").map((a) => a.email);
    let last = "";
    try {
      last = sessionStorage.getItem(LAST_FROM_KEY) ?? "";
    } catch {
      /* ignore */
    }
    return active.includes(last) ? last : (active[0] ?? "");
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
        showToast(e instanceof ApiError ? e.message : "無法載入信件", "error");
      } finally {
        if (seq === selectSeq.current) setDetailLoading(false);
      }
    },
    [patchItem, showToast]
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
      setCountsRefreshKey((k) => k + 1);
    },
    [removeItem, selectedId, closeReading]
  );

  const handleArchive = useCallback(async () => {
    if (!detail) return;
    try {
      await archiveMail(detail.id);
      afterRemoved(detail.id);
      showToast("已封存");
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "封存失敗", "error");
    }
  }, [detail, afterRemoved, showToast]);

  const handleMove = useCallback(
    async (target: "inbox" | "spam" | "trash") => {
      if (!detail) return;
      try {
        await moveMail(detail.id, target);
        afterRemoved(detail.id);
        showToast(`已移至${FOLDER_TITLE[target]}`);
      } catch (e) {
        showToast(e instanceof ApiError ? e.message : "搬移失敗", "error");
      }
    },
    [detail, afterRemoved, showToast]
  );

  const handleDelete = useCallback(async () => {
    if (!detail) return;
    try {
      await deleteMail(detail.id);
      afterRemoved(detail.id);
      showToast("已移至垃圾桶");
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : "刪除失敗", "error");
    }
  }, [detail, afterRemoved, showToast]);

  const handleToggleRead = useCallback(
    async (read: boolean) => {
      if (!detail) return;
      try {
        await setRead(detail.id, read);
        patchItem(detail.id, { read });
        setDetail((prev) => (prev && prev.id === detail.id ? { ...prev, read_at: read ? Date.now() : null } : prev));
        setCountsRefreshKey((k) => k + 1);
      } catch (e) {
        showToast(e instanceof ApiError ? e.message : "操作失敗", "error");
      }
    },
    [detail, patchItem, showToast]
  );

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
        showToast(e instanceof ApiError ? e.message : "下載失敗", "error");
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
      return window.confirm("目前有未寄出的信件，確定要放棄並開新的撰寫視窗嗎？");
    }
    return true;
  }, [draft, draftDirty]);

  const openCompose = useCallback(() => {
    if (!guardDraft()) return;
    if (composeBlockedReason) {
      showToast(composeBlockedReason, "error");
      return;
    }
    if (session.kind === "owner" && addresses.filter((a) => a.status === "active").length === 0) {
      showToast("目前沒有可用的寄件地址，請先到「地址管理」建立地址", "error");
      return;
    }
    openDraft({ mode: "new" });
  }, [guardDraft, openDraft, session, addresses, showToast, composeBlockedReason]);

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
      const quoteHeader = `\n\n在 ${formatFullDate(detail.received_at)}，${displaySender(detail.from)} 寫道：\n`;
      const quoted = `${quoteHeader}${quoteText(original)}`;

      if (mode === "reply") {
        openDraft({ mode, to: sender, subject: withPrefix(detail.subject, "Re:"), bodyText: quoted });
      } else if (mode === "replyAll") {
        const to = [sender, ...detail.to.map((a) => a.address.toLowerCase())].filter(
          (a) => a && !ownAddresses.has(a)
        );
        const cc = detail.cc.map((a) => a.address.toLowerCase()).filter((a) => a && !ownAddresses.has(a));
        openDraft({
          mode,
          to: joinRecipients([...new Set(to)]),
          cc: joinRecipients([...new Set(cc)]),
          subject: withPrefix(detail.subject, "Re:"),
          bodyText: quoted,
        });
      } else {
        const fwdHeader =
          `\n\n---------- 轉寄郵件 ----------\n` +
          `寄件者：${detail.from}\n` +
          `日期：${formatFullDate(detail.received_at)}\n` +
          `主旨：${detail.subject ?? "(無主旨)"}\n` +
          `收件者：${detail.to.map((a) => a.address).join(", ") || "—"}\n\n`;
        openDraft({
          mode,
          to: "",
          subject: withPrefix(detail.subject, "Fwd:"),
          bodyText: `${fwdHeader}${original}`,
        });
      }
    },
    [detail, guardDraft, openDraft, ownAddresses]
  );

  const handleSent = useCallback(
    (info: { from: string; to: string[] }) => {
      setDraft(null);
      setDraftDirty(false);
      try {
        sessionStorage.setItem(LAST_FROM_KEY, info.from);
      } catch {
        /* ignore */
      }
      showToast(`已寄出：${info.to.join(", ")}`);
      setCountsRefreshKey((k) => k + 1);
      if (listFolder === "sent" || listFolder === "all") setListRefreshKey((k) => k + 1);
    },
    [showToast, listFolder]
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
    ? `搜尋「${query}」`
    : addressFilter !== null
      ? `${FOLDER_TITLE[folder]} · ${addresses.find((a) => a.id === addressFilter)?.email.split("@")[0] ?? ""}`
      : FOLDER_TITLE[folder];

  return (
    <div className={`app ${page === "addresses" ? "app-page" : ""}`}>
      <Header
        session={session}
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        onSubmitSearch={submitSearch}
        onCompose={openCompose}
        onOpenAddresses={() => setPage("addresses")}
        onChangePassword={() => setPage("addresses")}
        onLogout={onLogout}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        composeBlockedReason={composeBlockedReason}
      />

      {page === "addresses" ? (
        <AddressManager
          session={session}
          onBack={() => setPage("mail")}
          onToast={showToast}
        />
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
            onCompose={openCompose}
            open={sidebarOpen}
            quotaLine={quotaLine}
            composeBlockedReason={composeBlockedReason}
          />

          <section className={`list-pane ${selectedId !== null ? "has-selection" : ""}`}>
            <div className="list-head">
              <h2>{listTitle}</h2>
              <button
                type="button"
                className="icon-btn"
                title="重新整理"
                onClick={() => setListRefreshKey((k) => k + 1)}
              >
                <IconRefresh size={17} />
              </button>
            </div>
            {searchActive && (
              <div className="search-bar">
                跨資料夾搜尋結果
                <button
                  type="button"
                  onClick={() => {
                    setQuery("");
                    setSearchInput("");
                  }}
                >
                  清除搜尋
                </button>
              </div>
            )}
            <MessageList
              items={items}
              loading={loading}
              loadingMore={loadingMore}
              error={error}
              nextCursor={nextCursor}
              selectedId={selectedId}
              showFolderChip={searchActive}
              query={query}
              onLoadMore={loadMore}
              onSelect={(id) => void selectMail(id)}
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
          onClose={() => {
            if (draftDirty && !window.confirm("放棄這封未寄出的信件？")) return;
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
