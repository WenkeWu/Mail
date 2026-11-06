import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import {
  createEmailAlias,
  deleteEmailAlias,
  listAddresses,
  listEmailAliases,
  setEmailAliasStatus,
} from "../api/endpoints";
import type { CreatedAlias, EmailAlias, Session } from "../api/types";
import { aliasPreview, normalizeAliasInput, validateAliasName } from "../lib/alias";
import { formatFullDate } from "../lib/format";
import { IconBack, IconPlus } from "./icons";

interface Props {
  session: Session;
  onBack: () => void;
  onToast: (message: string, kind?: "info" | "error") => void;
  /** 建立／停用／刪除後通知上層重新載入別名快取（回覆時的 From 判斷會用到） */
  onChanged?: () => void;
  /**
   * D29：嵌在「個人設置」頁內（隱藏自己的頁首／返回鍵）。
   * 功能完全相同，只是不再佔一個獨立頁面。
   */
  embedded?: boolean;
}

/** 可作為別名目標的地址（owner：名下 active 地址；mailbox：自己的地址） */
interface AliasTarget {
  id: number;
  email: string;
}

const EMPTY_HINT = "建立別名後，把別名給對方，對方就看不到你的真實地址";

/**
 * 別名管理（D25，docs/25 §6）。
 *
 * - owner 看名下全部別名；mailbox 只看自己地址的別名（後端 scope 判定）
 * - 建立時只需輸入名字（3–12 字母）與目標地址；流水號由後端原子分配
 * - 停用／刪除皆為**軟停用**（不刪資料列；停用後寄到別名的信回 550）
 */
export function AliasManager({ session, onBack, onToast, onChanged, embedded = false }: Props) {
  const [aliases, setAliases] = useState<EmailAlias[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targets, setTargets] = useState<AliasTarget[]>([]);
  const [targetId, setTargetId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [created, setCreated] = useState<CreatedAlias | null>(null);
  const [copied, setCopied] = useState(false);

  const reload = useCallback(async () => {
    try {
      const res = await listEmailAliases();
      setAliases(res.aliases);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "載入別名失敗");
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 目標地址：owner 取自己名下 active 的地址；mailbox 固定為自己的地址
  useEffect(() => {
    let cancelled = false;
    if (session.kind === "mailbox") {
      const own = { id: session.addressId, email: session.email };
      setTargets([own]);
      setTargetId(String(own.id));
      return () => {
        cancelled = true;
      };
    }
    listAddresses()
      .then((res) => {
        if (cancelled) return;
        const active = res.addresses
          .filter((a) => a.status === "active")
          .map((a) => ({ id: Number(a.id), email: a.email }));
        setTargets(active);
        setTargetId((prev) => (prev && active.some((a) => String(a.id) === prev) ? prev : String(active[0]?.id ?? "")));
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof ApiError ? e.message : "載入地址失敗");
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  const nameError = name.trim() === "" ? null : validateAliasName(name);
  const normalizedName = normalizeAliasInput(name);
  const canSubmit = name.trim() !== "" && nameError === null && targetId !== "" && !busy;

  const submitCreate = async (e: FormEvent) => {
    e.preventDefault();
    const validation = validateAliasName(name);
    if (validation) {
      setError(validation);
      return;
    }
    if (!targetId) {
      setError("請選擇目標地址");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await createEmailAlias(normalizedName, Number(targetId));
      setCreated(res);
      setName("");
      setCopied(false);
      onToast(`已建立別名 ${res.alias_address}`);
      await reload();
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "建立別名失敗");
    } finally {
      setBusy(false);
    }
  };

  const copyAlias = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      onToast("已複製別名");
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      onToast("複製失敗，請手動選取別名", "error");
    }
  };

  const toggleStatus = async (row: EmailAlias) => {
    const next = row.status === "active" ? "disabled" : "active";
    setBusyId(row.id);
    try {
      await setEmailAliasStatus(row.id, next);
      onToast(`${row.alias_address} 已${next === "active" ? "啟用" : "停用"}`);
      await reload();
      onChanged?.();
    } catch (e) {
      onToast(e instanceof ApiError ? e.message : "操作失敗", "error");
    } finally {
      setBusyId(null);
    }
  };

  /** 刪除＝軟停用（後端不刪資料列，保留既有信件的 envelope_to 與稽核） */
  const removeAlias = async (row: EmailAlias) => {
    if (!window.confirm(`停用別名 ${row.alias_address}？停用後寄到這個別名的信會遭拒收（550），資料列會保留。`)) {
      return;
    }
    setBusyId(row.id);
    try {
      await deleteEmailAlias(row.id);
      onToast(`${row.alias_address} 已停用`);
      await reload();
      onChanged?.();
    } catch (e) {
      onToast(e instanceof ApiError ? e.message : "停用失敗", "error");
    } finally {
      setBusyId(null);
    }
  };

  const targetLabel = useMemo(
    () => targets.find((t) => String(t.id) === targetId)?.email ?? "",
    [targets, targetId]
  );

  return (
    <section className={embedded ? "address-page alias-embedded" : "address-page"}>
      {!embedded && (
        <div className="page-head">
          <button type="button" className="icon-btn" onClick={onBack} aria-label="返回">
            <IconBack size={20} />
          </button>
          <h1>別名管理</h1>
        </div>
      )}

      <p className="muted small">
        別名讓你對外收信時不暴露真實地址；<strong>只有回覆外部寄件者</strong>時會自動以別名寄出。
        @atwho.org 內部寄件者仍會看到你的真實地址。
      </p>

      <form className="create-address" onSubmit={submitCreate}>
        <h2>
          <IconPlus size={18} /> 建立別名
        </h2>
        <div className="create-row alias-create-row">
          <div className="alias-name-input">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="名字（例：luke）"
              aria-label="別名名字"
              maxLength={12}
              autoComplete="off"
            />
            <span className="alias-name-suffix">＋ 流水號 @atwho.org</span>
          </div>
          <select
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            aria-label="目標地址"
            disabled={targets.length === 0}
          >
            {targets.length === 0 ? (
              <option value="">沒有可用的目標地址</option>
            ) : (
              targets.map((t) => (
                <option key={t.id} value={String(t.id)}>
                  {t.email}
                </option>
              ))
            )}
          </select>
          <button type="submit" className="btn-primary" disabled={!canSubmit}>
            {busy ? "建立中…" : "建立"}
          </button>
        </div>
        <p className={`muted small ${nameError ? "error-text" : ""}`} aria-live="polite">
          {nameError ?? `僅限 3–12 個英文字母、不可使用保留字；實際地址例：${aliasPreview(name || "luke")}`}
        </p>
        {error && <p className="error-text">{error}</p>}
      </form>

      {created && (
        <div className="alias-success" role="status">
          <div>
            <strong>別名已建立</strong>
            <p className="mono alias-success-address">{created.alias_address}</p>
            <p className="muted small">
              目標地址：{targetLabel || `#${created.target_address_id}`}。把這個別名給對方即可。
            </p>
          </div>
          <button type="button" className="btn-secondary" onClick={() => void copyAlias(created.alias_address)}>
            {copied ? "已複製" : "複製別名"}
          </button>
        </div>
      )}

      <div className="address-table-wrap">
        {aliases === null ? (
          <div className="list-state">
            <div className="spinner" />
          </div>
        ) : aliases.length === 0 ? (
          <div className="list-state">
            <p>{EMPTY_HINT}</p>
          </div>
        ) : (
          <table className="address-table">
            <thead>
              <tr>
                <th>別名</th>
                <th>目標地址</th>
                <th>狀態</th>
                <th>收到幾封</th>
                <th>最後收到</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {aliases.map((row) => (
                <tr key={row.id} className={row.status !== "active" ? "row-dim" : ""}>
                  <td className="mono">{row.alias_address}</td>
                  <td className="mono">{row.target_email}</td>
                  <td>
                    <span className={`status-pill ${row.status}`}>
                      {row.status === "active" ? "啟用" : "停用"}
                    </span>
                  </td>
                  <td>{row.received_count}</td>
                  <td>{row.last_received_at === null ? "—" : formatFullDate(row.last_received_at)}</td>
                  <td className="row-actions">
                    <button type="button" disabled={busyId === row.id} onClick={() => void toggleStatus(row)}>
                      {row.status === "active" ? "停用" : "啟用"}
                    </button>
                    {row.status === "active" && (
                      <button
                        type="button"
                        className="danger"
                        disabled={busyId === row.id}
                        onClick={() => void removeAlias(row)}
                      >
                        刪除（停用）
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="muted small">
        <strong>停用</strong>後寄到別名的來信會回 550（避免退信迴圈），真實地址不受影響；
        <strong>刪除</strong>為軟停用，資料列與既有信件紀錄會保留。
      </p>
    </section>
  );
}
