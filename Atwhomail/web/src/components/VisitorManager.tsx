import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../api/client";
import {
  deleteVisitor,
  getVisitorAttention,
  getVisitorOverview,
  searchVisitors,
  setUserQuota,
  setUserStatus,
  setUserWarmup,
  setVisitorAddressStatus,
  triggerAllChatSync,
} from "../api/endpoints";
import type {
  VisitorAttentionItem,
  VisitorAttentionResponse,
  VisitorOverview,
  VisitorUser,
} from "../api/types";
import { getFormatLocale, useI18n } from "../i18n";
import {
  ADDRESS_DISABLE_WARNING,
  USER_DELETE_LABEL,
  USER_DELETE_WARNING,
  USER_SUSPEND_WARNING,
  VISITOR_MANAGER_HINT,
  addressStatusActionLabel,
  addressStatusTooltip,
  userDeleteTooltip,
  userStatusActionLabel,
  userStatusTooltip,
} from "../lib/statusSemantics";
import { IconBack, IconRefresh } from "./icons";
import { Modal } from "./Modal";

/**
 * 訪客管理（D38）—— Dashboard ＋ 篩選式搜尋。
 *
 * 為什麼不再預設列出全部訪客：訪客數成長後，完整清單會讓管理頁與 D1 越來越慢，
 * 而且管理者真正需要的是「趨勢、分類與異常」，不是逐列掃描。
 *
 * - 上方：KPI／國家／語系／AllChat 等級分佈／趨勢／需要注意的訪客
 * - 下方：必須至少一個條件才搜尋（ID／Email／國家／語系／狀態／等級／風險），每頁 25 筆、最多 50 筆
 * - 等級由 **AllChat** 管理；Mail 只顯示投影，不提供修改（避免兩個 source of truth）
 *
 * ⚠️ N9：只呈現數量、時間、狀態、地區／語系與等級；**不顯示**任何信件主旨、寄件者或內文。
 * ⚠️ 權限一律由後端判定：所有 dashboard／search／action 端點皆 `requireOwner`。
 */
interface Props {
  onBack: () => void;
  onToast: (message: string, kind?: "info" | "error") => void;
}

/** 最近活動時間顯示（無活動 → 「—」） */
function formatActivity(ts: number | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(getFormatLocale(), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatTime(ts: number | null): string {
  return ts ? formatActivity(ts) : "—";
}

interface EditState {
  user: VisitorUser;
  quota: string;
  warmupQuota: string;
  canSend: boolean;
  warmupExempt: boolean;
}

interface Filters {
  q: string;
  country: string;
  language: string;
  status: string;
  level: string;
  risk: string;
}

const EMPTY_FILTERS: Filters = { q: "", country: "", language: "", status: "", level: "", risk: "" };

function hasFilter(filters: Filters): boolean {
  return Boolean(
    filters.q.trim() ||
      filters.country ||
      filters.language ||
      filters.status ||
      filters.level ||
      filters.risk
  );
}

/** 等級只是 AllChat 的投影；未知／未同步一律顯示「未同步」。 */
function levelLabel(level: string | null | undefined): string {
  return level ? level.toUpperCase() : "—";
}

const REASON_KEYS: Record<string, string> = {
  near_quota: "接近每日配額",
  quota_rejected: "今日曾被配額阻擋",
  rate_rejected: "今日曾被限流阻擋",
  login_failed: "今日有登入失敗",
  allchat_restricted: "AllChat 等級受限",
  suspended: "帳號已停權",
};

function DistributionCard({
  title,
  rows,
  emptyText,
}: {
  title: string;
  rows: Array<{ key: string; count: number }>;
  emptyText: string;
}) {
  const max = Math.max(1, ...rows.map((row) => row.count));
  return (
    <div className="visitor-card">
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <p className="muted small">{emptyText}</p>
      ) : (
        <div className="dist-list">
          {rows.map((row) => (
            <div className="dist-row" key={row.key}>
              <span className="dist-key mono">{row.key === "UNKNOWN" ? "—" : row.key}</span>
              <span className="dist-bar" aria-hidden="true">
                <span style={{ width: `${Math.max(3, (row.count / max) * 100)}%` }} />
              </span>
              <span className="dist-count">{row.count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TrendCard({
  title,
  points,
  emptyText,
}: {
  title: string;
  points: Array<{ day: string; count: number }>;
  emptyText: string;
}) {
  const recent = points.slice(-14);
  const max = Math.max(1, ...recent.map((point) => point.count));
  return (
    <div className="visitor-card">
      <h2>{title}</h2>
      {recent.length === 0 ? (
        <p className="muted small">{emptyText}</p>
      ) : (
        <div className="mini-bars" role="img" aria-label={title}>
          {recent.map((point) => (
            <span
              key={point.day}
              className="mini-bar"
              style={{ height: `${Math.max(4, (point.count / max) * 100)}%` }}
              title={`${point.day}：${point.count}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function VisitorManager({ onBack, onToast }: Props) {
  const { t } = useI18n();
  const [overview, setOverview] = useState<VisitorOverview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [attention, setAttention] = useState<VisitorAttentionResponse | null>(null);
  const [attentionError, setAttentionError] = useState<string | null>(null);
  const [loadingDashboard, setLoadingDashboard] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters | null>(null);
  const [page, setPage] = useState(1);
  const [results, setResults] = useState<VisitorUser[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [filterHint, setFilterHint] = useState(false);

  const [busyId, setBusyId] = useState<number | null>(null);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [confirm, setConfirm] = useState<{ user: VisitorUser; action: "suspend" | "address-off" | "delete" } | null>(
    null
  );

  const loadDashboard = useCallback(async () => {
    setLoadingDashboard(true);
    const [ov, at] = await Promise.allSettled([getVisitorOverview(), getVisitorAttention(10)]);
    if (ov.status === "fulfilled") {
      setOverview(ov.value);
      setOverviewError(null);
    } else {
      setOverviewError(ov.reason instanceof ApiError ? ov.reason.message : t("載入訪客統計失敗"));
    }
    if (at.status === "fulfilled") {
      setAttention(at.value);
      setAttentionError(null);
    } else {
      setAttentionError(at.reason instanceof ApiError ? at.reason.message : t("載入注意事項失敗"));
    }
    setLoadingDashboard(false);
  }, [t]);

  const runSearch = useCallback(
    async (query: Filters, nextPage: number) => {
      if (!hasFilter(query)) {
        setFilterHint(true);
        setResults(null);
        setSearchError(null);
        return;
      }
      setFilterHint(false);
      setSearching(true);
      setSearchError(null);
      try {
        const res = await searchVisitors({
          q: query.q.trim() || undefined,
          country: query.country || undefined,
          language: query.language || undefined,
          status: query.status || undefined,
          level: query.level || undefined,
          risk: query.risk || undefined,
          page: nextPage,
          limit: 25,
        });
        setResults(res.users);
        setHasMore(res.has_more);
        setPage(nextPage);
        setApplied(query);
      } catch (e) {
        setSearchError(e instanceof ApiError ? e.message : t("搜尋訪客失敗"));
      } finally {
        setSearching(false);
      }
    },
    [t]
  );

  const refreshAfterAction = useCallback(async () => {
    await loadDashboard();
    if (applied) await runSearch(applied, page);
  }, [applied, loadDashboard, page, runSearch]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  /** 停權／復權（C7 一鍵止血：立即擋登入與寄信） */
  const applyUserStatus = async (user: VisitorUser, status: "active" | "suspended") => {
    setBusyId(user.id);
    try {
      await setUserStatus(user.id, status);
      onToast(
        status === "active"
          ? t("{username} 已復權", { username: user.username })
          : t("{username} 已停權", { username: user.username })
      );
      setConfirm(null);
      await refreshAfterAction();
    } catch (e) {
      onToast(e instanceof ApiError ? e.message : t("操作失敗"), "error");
    } finally {
      setBusyId(null);
    }
  };

  /** 停用／啟用地址（D5 新端點；舊端點對訪客地址一律 404） */
  const applyAddressStatus = async (user: VisitorUser, status: "active" | "disabled") => {
    if (!user.address) return;
    setBusyId(user.id);
    try {
      await setVisitorAddressStatus(user.address.id, status);
      onToast(
        status === "active"
          ? t("{email} 已啟用", { email: user.address.email })
          : t("{email} 已停用", { email: user.address.email })
      );
      setConfirm(null);
      await refreshAfterAction();
    } catch (e) {
      onToast(e instanceof ApiError ? e.message : t("操作失敗"), "error");
    } finally {
      setBusyId(null);
    }
  };

  /**
   * 永久刪除訪客（D9）：後端一次清除帳號／地址／所有信件與附件／別名／登入計數
   *（`registration_audit` 保留），且該地址的既有登入立即失效（後端 D10）。
   */
  const deleteUser = async (user: VisitorUser) => {
    setBusyId(user.id);
    try {
      await deleteVisitor(user.id);
      onToast(t("{username} 已永久刪除", { username: user.username }));
      setConfirm(null);
      await refreshAfterAction();
    } catch (e) {
      onToast(e instanceof ApiError ? e.message : t("刪除失敗"), "error");
    } finally {
      setBusyId(null);
    }
  };

  const openEdit = (user: VisitorUser) => {
    setEdit({
      user,
      quota: String(user.address?.daily_send_quota ?? ""),
      warmupQuota: String(user.address?.warmup_quota ?? 20),
      canSend: (user.address?.can_send ?? 1) === 1,
      warmupExempt: (user.address?.warmup_exempt ?? 0) === 1,
    });
  };

  /** 套用每日配額／暖機上限（皆 1–50）＋寄信安全閥；暖機豁免為選配（migration 0007 未套用時回 409） */
  const submitEdit = async () => {
    if (!edit) return;
    const quota = Number(edit.quota);
    if (!Number.isInteger(quota) || quota < 1 || quota > 50) {
      onToast(t("每日配額需為 1–50 的整數"), "error");
      return;
    }
    const warmupQuota = Number(edit.warmupQuota);
    if (!Number.isInteger(warmupQuota) || warmupQuota < 1 || warmupQuota > 50) {
      onToast(t("暖機配額需為 1–50 的整數"), "error");
      return;
    }
    setBusyId(edit.user.id);
    try {
      await setUserQuota(edit.user.id, {
        daily_send_quota: quota,
        warmup_quota: warmupQuota,
        can_send: edit.canSend,
      });
      const wasExempt = (edit.user.address?.warmup_exempt ?? 0) === 1;
      if (edit.warmupExempt !== wasExempt) {
        try {
          await setUserWarmup(edit.user.id, edit.warmupExempt);
        } catch (e) {
          if (e instanceof ApiError && e.code === "MIGRATION_REQUIRED") {
            onToast(t("配額已更新；暖機豁免需要先套用 migration 0007"), "error");
            setEdit(null);
            await refreshAfterAction();
            return;
          }
          throw e;
        }
      }
      onToast(t("{username} 的寄信設定已更新", { username: edit.user.username }));
      setEdit(null);
      await refreshAfterAction();
    } catch (e) {
      onToast(e instanceof ApiError ? e.message : t("更新失敗"), "error");
    } finally {
      setBusyId(null);
    }
  };

  const submitSearch = () => {
    void runSearch(filters, 1);
  };

  const clearSearch = () => {
    setFilters(EMPTY_FILTERS);
    setApplied(null);
    setResults(null);
    setHasMore(false);
    setSearchError(null);
    setFilterHint(false);
    setPage(1);
  };

  const viewAttention = (item: VisitorAttentionItem) => {
    const query = { ...EMPTY_FILTERS, q: item.username };
    setFilters(query);
    void runSearch(query, 1);
  };

  const manualSync = async () => {
    setSyncing(true);
    try {
      const res = await triggerAllChatSync();
      onToast(t("AllChat 等級已同步（{count} 筆）", { count: res.synced }));
      await loadDashboard();
    } catch (e) {
      onToast(e instanceof ApiError ? e.message : t("同步失敗"), "error");
    } finally {
      setSyncing(false);
    }
  };

  const totals = overview?.totals;
  const sync = overview?.sync ?? attention?.sync;
  const countryRows = (overview?.by_country ?? []).map((row) => ({
    key: row.key,
    count: row.count,
  }));
  const languageRows = overview?.by_language ?? [];
  const levelRows = overview?.by_level ?? [];

  return (
    <section className="address-page visitor-dashboard">
      <div className="page-head">
        <button type="button" className="icon-btn" onClick={onBack} aria-label={t("返回")}>
          <IconBack size={20} />
        </button>
        <h1>{t("訪客管理")}</h1>
        <button type="button" className="icon-btn" title={t("重新整理")} onClick={() => void loadDashboard()}>
          <IconRefresh size={18} />
        </button>
      </div>

      <p className="muted small">
        {t("只顯示帳號狀態、配額與數量／時間（信件數、最近活動）。基於權限邊界（N9），管理者看不到訪客信件的主旨、寄件者或內文。")}
      </p>
      <p className="muted small">{t(VISITOR_MANAGER_HINT)}</p>

      {/* ── KPI ── */}
      {overviewError ? (
        <div className="visitor-card error-text">{overviewError}</div>
      ) : loadingDashboard && !overview ? (
        <div className="visitor-card list-state">
          <div className="spinner" />
        </div>
      ) : (
        <>
          <div className="kpi-grid">
            {[
              { key: "total", label: "訪客總數", value: totals?.total ?? 0 },
              { key: "new_today", label: "今日新增", value: totals?.new_today ?? 0 },
              { key: "new_7d", label: "近 7 天新增", value: totals?.new_7d ?? 0 },
              { key: "active_7d", label: "近 7 天活躍", value: totals?.active_7d ?? 0 },
              { key: "warming", label: "暖機中", value: totals?.warming ?? 0 },
              { key: "near_quota", label: "接近配額", value: totals?.near_quota ?? 0 },
              { key: "rejected_24h", label: "24h 異常訊號", value: totals?.rejected_24h ?? 0 },
              { key: "suspended", label: "已停權", value: totals?.suspended ?? 0 },
            ].map((card) => (
              <div className="kpi-card" key={card.key}>
                <span className="kpi-label">{t(card.label)}</span>
                <strong className="kpi-value">{card.value}</strong>
              </div>
            ))}
          </div>

          <div className="visitor-grid">
            <DistributionCard title={t("國家分佈")} rows={countryRows} emptyText={t("尚無資料")} />
            <DistributionCard title={t("語系分佈")} rows={languageRows} emptyText={t("尚無資料")} />
            <DistributionCard title={t("AllChat 等級分佈")} rows={levelRows} emptyText={t("尚未同步")} />
            <TrendCard
              title={t("近 14 天註冊")}
              points={overview?.trends.registrations ?? []}
              emptyText={t("尚無資料")}
            />
            <TrendCard
              title={t("近 14 天寄出")}
              points={overview?.trends.sent ?? []}
              emptyText={t("尚無資料")}
            />
            <div className="visitor-card">
              <h2>{t("AllChat 等級同步")}</h2>
              {sync ? (
                <>
                  <p className="small">
                    {sync.configured
                      ? sync.stale
                        ? t("同步落後（超過 15 分鐘未更新）")
                        : t("同步正常")
                      : t("尚未設定 AllChat 內部 API")}
                  </p>
                  <p className="muted small">
                    {t("最後同步：{time}", { time: formatTime(sync.lastSyncedAt) })}
                  </p>
                  {sync.lastError && <p className="error-text small">{sync.lastError}</p>}
                  <div className="sync-actions">
                    <button type="button" onClick={() => void manualSync()} disabled={syncing || !sync.configured}>
                      {syncing ? t("同步中…") : t("立即同步")}
                    </button>
                    <a href="https://chat.atwho.org" target="_blank" rel="noreferrer">
                      {t("在 AllChat 管理等級")}
                    </a>
                  </div>
                </>
              ) : (
                <p className="muted small">{t("尚未取得同步狀態")}</p>
              )}
            </div>
          </div>
        </>
      )}

      {/* ── 需要注意的訪客 ── */}
      <section className="visitor-section">
        <div className="section-head">
          <h2>{t("需要注意的訪客")}</h2>
          <span className="muted small">{t("近 24 小時訊號")}</span>
        </div>
        {attentionError ? (
          <div className="visitor-card error-text">{attentionError}</div>
        ) : loadingDashboard && !attention ? (
          <div className="visitor-card list-state">
            <div className="spinner" />
          </div>
        ) : (attention?.items.length ?? 0) === 0 ? (
          <div className="visitor-card list-state">{t("目前沒有需要注意的訪客")}</div>
        ) : (
          <div className="attention-list">
            {attention!.items.map((item) => (
              <div className={`attention-row ${item.severity === "high" ? "high" : ""}`} key={item.id}>
                <div className="attention-main">
                  <span className="mono">{item.username}</span>
                  {item.email && <span className="muted small mono">{item.email}</span>}
                </div>
                <div className="attention-reasons">
                  {item.reasons.map((reason) => (
                    <span className="status-pill exhausted" key={reason}>
                      {t(REASON_KEYS[reason] ?? reason)}
                    </span>
                  ))}
                </div>
                <div className="attention-meta muted small">
                  <span>{item.country_code ?? "—"}</span>
                  <span>{item.language ?? "—"}</span>
                  <span title={t("AllChat 等級")}>{levelLabel(item.level)}</span>
                  <span>
                    {item.sent_today ?? 0}/{item.daily_send_quota ?? "—"}
                  </span>
                  <span>{formatTime(item.last_seen_at)}</span>
                </div>
                <button type="button" onClick={() => viewAttention(item)}>
                  {t("查看")}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── 篩選式搜尋 ── */}
      <section className="visitor-section">
        <div className="section-head">
          <h2>{t("搜尋訪客")}</h2>
          <span className="muted small">{t("至少一個條件；每頁 25 筆，最多 50 筆")}</span>
        </div>

        <form
          className="visitor-filters"
          onSubmit={(event) => {
            event.preventDefault();
            submitSearch();
          }}
        >
          <label>
            <span>{t("ID 或 Email")}</span>
            <input
              value={filters.q}
              onChange={(e) => setFilters({ ...filters, q: e.target.value })}
              placeholder={t("訪客 ID 或地址")}
            />
          </label>
          <label>
            <span>{t("國家")}</span>
            <select value={filters.country} onChange={(e) => setFilters({ ...filters, country: e.target.value })}>
              <option value="">{t("全部")}</option>
              {countryRows.map((row) => (
                <option key={row.key} value={row.key}>
                  {row.key === "UNKNOWN" ? t("未知") : row.key}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("語系")}</span>
            <select value={filters.language} onChange={(e) => setFilters({ ...filters, language: e.target.value })}>
              <option value="">{t("全部")}</option>
              {languageRows.map((row) => (
                <option key={row.key} value={row.key}>
                  {row.key === "UNKNOWN" ? t("未知") : row.key}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t("帳號狀態")}</span>
            <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
              <option value="">{t("全部")}</option>
              <option value="active">{t("正常")}</option>
              <option value="suspended">{t("已停權")}</option>
            </select>
          </label>
          <label>
            <span>{t("AllChat 等級")}</span>
            <select value={filters.level} onChange={(e) => setFilters({ ...filters, level: e.target.value })}>
              <option value="">{t("全部")}</option>
              {["T0", "T1", "T2", "T3", "T4"].map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
              <option value="UNKNOWN">{t("未同步")}</option>
            </select>
          </label>
          <label>
            <span>{t("風險訊號")}</span>
            <select value={filters.risk} onChange={(e) => setFilters({ ...filters, risk: e.target.value })}>
              <option value="">{t("全部")}</option>
              <option value="near_quota">{t("接近配額")}</option>
              <option value="quota">{t("曾被配額阻擋")}</option>
              <option value="rate">{t("曾被限流阻擋")}</option>
              <option value="login">{t("登入失敗")}</option>
              <option value="restricted">{t("AllChat 等級受限")}</option>
            </select>
          </label>
          <div className="filter-actions">
            <button type="submit" className="btn-primary" disabled={searching}>
              {searching ? t("搜尋中…") : t("搜尋")}
            </button>
            <button type="button" className="btn-secondary" onClick={clearSearch}>
              {t("清除")}
            </button>
          </div>
        </form>

        {filterHint && <p className="muted small">{t("請至少輸入一個搜尋或篩選條件。")}</p>}

        <div className="address-table-wrap">
          {searchError ? (
            <div className="list-state error-text">{searchError}</div>
          ) : searching && results === null ? (
            <div className="list-state">
              <div className="spinner" />
            </div>
          ) : results === null ? (
            <div className="list-state">{t("設定條件後按「搜尋」；不會自動列出全部訪客。")}</div>
          ) : results.length === 0 ? (
            <div className="list-state">{t("找不到符合條件的訪客")}</div>
          ) : (
            <table className="address-table visitor-table">
              <thead>
                <tr>
                  <th>{t("帳號")}</th>
                  <th>{t("地址")}</th>
                  <th>{t("國家／語系")}</th>
                  <th>{t("等級")}</th>
                  <th>{t("狀態")}</th>
                  <th>{t("配額")}</th>
                  <th>{t("今日已寄")}</th>
                  <th>{t("信件數")}</th>
                  <th>{t("最近活動")}</th>
                  <th>{t("操作")}</th>
                </tr>
              </thead>
              <tbody>
                {results.map((u) => {
                  const a = u.address;
                  const suspended = u.status !== "active";
                  const addressOff = a ? a.status !== "active" : false;
                  const lastActivity = u.last_activity_at ?? u.last_seen_at ?? null;
                  return (
                    <tr key={u.id} className={suspended || addressOff ? "row-dim" : ""}>
                      <td className="mono">{u.username}</td>
                      <td className="mono">{a?.email ?? <span className="muted">{t("（無地址）")}</span>}</td>
                      <td>
                        <span className="mono">{u.country_code ?? "—"}</span>
                        <span className="muted small"> / {u.language ?? "—"}</span>
                      </td>
                      <td>
                        <span className="status-pill level">{levelLabel(u.level)}</span>
                        {u.level_status === "restricted" && (
                          <span className="status-pill suspended pill-inline">{t("受限")}</span>
                        )}
                      </td>
                      <td>
                        <span className={`status-pill ${suspended ? "suspended" : "active"}`}>
                          {suspended ? t("已停權") : t("正常")}
                        </span>
                        {a && (
                          <span className={`status-pill ${addressOff ? "disabled" : "active"} pill-inline`}>
                            {addressOff ? t("地址停用") : t("地址啟用")}
                          </span>
                        )}
                        {a?.can_send === 0 && <span className="status-pill disabled pill-inline">{t("禁止寄信")}</span>}
                      </td>
                      <td>{a ? a.daily_send_quota : "—"}</td>
                      <td>{a ? a.sent_today : "—"}</td>
                      <td>{u.mail_count}</td>
                      <td>{formatActivity(lastActivity)}</td>
                      <td className="row-actions">
                        <button
                          type="button"
                          className={suspended ? "" : "danger"}
                          disabled={busyId === u.id}
                          title={userStatusTooltip(suspended)}
                          onClick={() => setConfirm({ user: u, action: "suspend" })}
                        >
                          {userStatusActionLabel(suspended)}
                        </button>
                        {a && (
                          <button
                            type="button"
                            className={addressOff ? "" : "danger"}
                            disabled={busyId === u.id}
                            title={addressStatusTooltip(addressOff)}
                            onClick={() => setConfirm({ user: u, action: "address-off" })}
                          >
                            {addressStatusActionLabel(addressOff)}
                          </button>
                        )}
                        <button type="button" disabled={!a || busyId === u.id} onClick={() => openEdit(u)}>
                          {t("寄信設定")}
                        </button>
                        {/* D9：永久刪除（danger）；二次確認見下方 Modal */}
                        <button
                          type="button"
                          className="danger"
                          disabled={busyId === u.id}
                          title={userDeleteTooltip()}
                          onClick={() => setConfirm({ user: u, action: "delete" })}
                        >
                          {t(USER_DELETE_LABEL)}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {results !== null && (
          <div className="pager-row">
            <button
              type="button"
              disabled={page <= 1 || searching}
              onClick={() => applied && void runSearch(applied, page - 1)}
            >
              {t("上一頁")}
            </button>
            <span className="muted small">{t("第 {page} 頁", { page })}</span>
            <button
              type="button"
              disabled={!hasMore || searching}
              onClick={() => applied && void runSearch(applied, page + 1)}
            >
              {t("下一頁")}
            </button>
          </div>
        )}
      </section>

      <p className="muted small">
        {t("停權帳號＝凍結該訪客全部地址：立即無法登入與寄信，但來信仍會照收並保留。停用地址＝僅該一個地址，且連收信都停止——停用期間的來信會被直接丟棄，不會保留。")}
      </p>

      {confirm && (
        <Modal
          title={
            confirm.action === "suspend"
              ? t("停權／復權")
              : confirm.action === "delete"
                ? t("刪除訪客（無法復原）")
                : t("停用／啟用地址")
          }
          onClose={() => setConfirm(null)}
        >
          {confirm.action === "suspend" ? (
            <>
              <p>
                {confirm.user.status === "active"
                  ? t("確定要停權 {username} 嗎？", { username: confirm.user.username })
                  : t("確定要復權 {username} 嗎？", { username: confirm.user.username })}
              </p>
              {confirm.user.status === "active" ? (
                <p className="warn-text">⚠️ {t(USER_SUSPEND_WARNING)}</p>
              ) : (
                <p className="muted small">{t("復權後，此人名下所有地址恢復可登入與寄信（收信狀態不變）。")}</p>
              )}
              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={() => setConfirm(null)}>
                  {t("取消")}
                </button>
                <button
                  type="button"
                  className={confirm.user.status === "active" ? "btn-danger" : "btn-primary"}
                  onClick={() => void applyUserStatus(confirm.user, confirm.user.status === "active" ? "suspended" : "active")}
                >
                  {confirm.user.status === "active" ? t("確定停權") : t("確定復權")}
                </button>
              </div>
            </>
          ) : confirm.action === "delete" ? (
            <>
              <p>
                {t("確定要永久刪除訪客 {username}{email} 嗎？", {
                  username: confirm.user.username,
                  email: confirm.user.address ? `（${confirm.user.address.email}）` : "",
                })}
              </p>
              {/* D9：刪除是不可逆的完整清除，警語必須逐字顯示，並導向「停權」 */}
              <p className="warn-text">⚠️ {t(USER_DELETE_WARNING)}</p>
              <p className="muted small">
                {t("將一併清除該訪客的 {count} 封信件與其附件，並立即讓其現有登入失效；註冊與管理稽核紀錄會保留。此動作沒有復原方式。", {
                  count: confirm.user.mail_count,
                })}
              </p>
              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={() => setConfirm(null)}>
                  {t("取消")}
                </button>
                <button
                  type="button"
                  className="btn-danger"
                  disabled={busyId === confirm.user.id}
                  onClick={() => void deleteUser(confirm.user)}
                >
                  {busyId === confirm.user.id ? t("刪除中…") : t("確定永久刪除")}
                </button>
              </div>
            </>
          ) : (
            <>
              <p>
                {confirm.user.address?.status === "active"
                  ? t("確定要停用 {email} 嗎？", { email: confirm.user.address?.email ?? "" })
                  : t("確定要啟用 {email} 嗎？", { email: confirm.user.address?.email ?? "" })}
              </p>
              {confirm.user.address?.status === "active" ? (
                // D8-3：地址停用是**不可逆的收信中斷**（信在 SMTP 階段即被丟棄），必須明寫後果
                <p className="warn-text">⚠️ {t(ADDRESS_DISABLE_WARNING)}</p>
              ) : (
                <p className="muted small">
                  {t("啟用後該地址恢復收信與登入；停用期間已被丟棄的來信無法找回。")}
                </p>
              )}
              <div className="modal-actions">
                <button type="button" className="btn-secondary" onClick={() => setConfirm(null)}>
                  {t("取消")}
                </button>
                <button
                  type="button"
                  className={confirm.user.address?.status === "active" ? "btn-danger" : "btn-primary"}
                  onClick={() =>
                    void applyAddressStatus(
                      confirm.user,
                      confirm.user.address?.status === "active" ? "disabled" : "active"
                    )
                  }
                >
                  {confirm.user.address?.status === "active" ? t("確定停用") : t("確定啟用")}
                </button>
              </div>
            </>
          )}
        </Modal>
      )}

      {edit && (
        <Modal title={t("{username} 的寄信設定", { username: edit.user.username })} onClose={() => setEdit(null)}>
          <label className="field-row">
            <span>{t("每日寄信配額（1–50）")}</span>
            <input
              type="number"
              min={1}
              max={50}
              value={edit.quota}
              onChange={(e) => setEdit({ ...edit, quota: e.target.value })}
            />
          </label>
          <label className="field-row">
            <span>{t("暖機期上限（1–50，預設 20）")}</span>
            <input
              type="number"
              min={1}
              max={50}
              value={edit.warmupQuota}
              onChange={(e) => setEdit({ ...edit, warmupQuota: e.target.value })}
            />
          </label>
          <label className="field-row checkbox-row">
            <input
              type="checkbox"
              checked={edit.canSend}
              onChange={(e) => setEdit({ ...edit, canSend: e.target.checked })}
            />
            <span>{t("允許寄信（取消勾選＝安全閥：立即停止此帳號寄信）")}</span>
          </label>
          <label className="field-row checkbox-row">
            <input
              type="checkbox"
              checked={edit.warmupExempt}
              onChange={(e) => setEdit({ ...edit, warmupExempt: e.target.checked })}
            />
            <span>{t("暖機豁免（跳過註冊後 24 小時的暖機上限）")}</span>
          </label>
          <p className="warn-text">
            {t("⚠️ 暖機豁免會讓新帳號立刻能寄到每日配額上限，可能影響寄信聲譽（新網域尤其敏感）。豁免後仍受每日配額與每小時限流約束，不是無上限；此外需要 migration 0007 已套用。")}
          </p>
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={() => setEdit(null)}>
              {t("取消")}
            </button>
            <button type="button" className="btn-primary" onClick={() => void submitEdit()} disabled={busyId === edit.user.id}>
              {busyId === edit.user.id ? t("套用中…") : t("套用")}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
