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
import { useI18n } from "../i18n";
import { aliasPreview, normalizeAliasInput, validateAliasName } from "../lib/alias";
import { formatFullDate } from "../lib/format";
import { IconBack, IconPlus } from "./icons";

interface Props {
  session: Session;
  onBack: () => void;
  onToast: (message: string, kind?: "info" | "error") => void;
  /** 建立／變更／停用／刪除後通知上層重新載入別名快取（回覆時的 From 判斷會用到） */
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

const EMPTY_HINT = "尚未建立暱稱別名。隱身代號會在帳號建立時自動產生；暱稱別名可在下方建立。";

/**
 * 別名管理（D25；D31 改為三種寄信身分）。
 *
 * - **暱稱別名**：每帳號最多 1 個「啟用中」；可變更，舊的立即停用（來信回 550）
 * - **隱身代號**：帳號建立時由系統自動產生，不隨暱稱變更；由系統管理，不能停用／刪除
 * - owner 看名下全部；mailbox 只看自己地址的別名（後端 scope 判定）
 * - 停用／刪除皆為**軟停用**（不刪資料列；停用後寄到別名的信回 550）
 */
export function AliasManager({ session, onBack, onToast, onChanged, embedded = false }: Props) {
  const { t } = useI18n();
  const [aliases, setAliases] = useState<EmailAlias[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [targets, setTargets] = useState<AliasTarget[]>([]);
  const [targetId, setTargetId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [created, setCreated] = useState<CreatedAlias | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await listEmailAliases();
      setAliases(res.aliases);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("載入別名失敗"));
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
        if (!cancelled) setError(e instanceof ApiError ? e.message : t("載入地址失敗"));
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  const rows = aliases ?? [];
  /** D31：每個帳號最多 1 個啟用中的暱稱別名；已有時表單改為「變更」 */
  const activeNamed = rows.filter((a) => a.kind === "named" && a.status === "active");
  const replacing = activeNamed.length > 0;

  const nameError = name.trim() === "" ? null : validateAliasName(name);
  const normalizedName = normalizeAliasInput(name);
  const canSubmit = name.trim() !== "" && nameError === null && targetId !== "" && !busy;

  const submitCreate = async (e: FormEvent) => {
    e.preventDefault();
    const validation = validateAliasName(name);
    if (validation) {
      setError(t(validation));
      return;
    }
    if (!targetId) {
      setError(t("請選擇目標地址"));
      return;
    }
    if (
      replacing &&
      !window.confirm(
        t("變更暱稱別名？舊的 {addresses} 會立即停用（來信回 550）。", {
          addresses: activeNamed.map((a) => a.alias_address).join("、"),
        })
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await createEmailAlias(normalizedName, Number(targetId), replacing);
      setCreated(res);
      setName("");
      setCopied(null);
      onToast(
        replacing
          ? t("已變更暱稱別名 {address}（舊的已停用）", { address: res.alias_address })
          : t("已建立暱稱別名 {address}", { address: res.alias_address })
      );
      await reload();
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("建立別名失敗"));
    } finally {
      setBusy(false);
    }
  };

  const copyAlias = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(address);
      onToast(t("已複製別名"));
      window.setTimeout(() => setCopied((prev) => (prev === address ? null : prev)), 2500);
    } catch {
      onToast(t("複製失敗，請手動選取別名"), "error");
    }
  };

  const toggleStatus = async (row: EmailAlias) => {
    const next = row.status === "active" ? "disabled" : "active";
    setBusyId(row.id);
    try {
      await setEmailAliasStatus(row.id, next);
      onToast(
        next === "active"
          ? t("{address} 已啟用", { address: row.alias_address })
          : t("{address} 已停用", { address: row.alias_address })
      );
      await reload();
      onChanged?.();
    } catch (e) {
      onToast(e instanceof ApiError ? e.message : t("操作失敗"), "error");
    } finally {
      setBusyId(null);
    }
  };

  /** 刪除＝軟停用（後端不刪資料列，保留既有信件的 envelope_to 與稽核） */
  const removeAlias = async (row: EmailAlias) => {
    if (
      !window.confirm(
        t("停用別名 {address}？停用後寄到這個別名的信會遭拒收（550），資料列會保留。", {
          address: row.alias_address,
        })
      )
    ) {
      return;
    }
    setBusyId(row.id);
    try {
      await deleteEmailAlias(row.id);
      onToast(t("{address} 已停用", { address: row.alias_address }));
      await reload();
      onChanged?.();
    } catch (e) {
      onToast(e instanceof ApiError ? e.message : t("停用失敗"), "error");
    } finally {
      setBusyId(null);
    }
  };

  const createdTarget = useMemo(
    () =>
      created
        ? (targets.find((t) => t.id === created.target_address_id)?.email ?? `#${created.target_address_id}`)
        : "",
    [created, targets]
  );

  return (
    <section className={embedded ? "address-page alias-embedded" : "address-page"}>
      {!embedded && (
        <div className="page-head">
          <button type="button" className="icon-btn" onClick={onBack} aria-label={t("返回")}>
            <IconBack size={20} />
          </button>
          <h1>{t("別名管理")}</h1>
        </div>
      )}

      <p className="muted small">{t("每個帳號有三種寄信身分：真實 ID、暱稱別名（最多 1 個，可變更）、隱身代號（系統自動產生）。暱稱與隱身代號都能收信與回信；停用後寄到該地址的信會回 550。")}</p>

      <form className="create-address" onSubmit={submitCreate}>
        <h2>
          <IconPlus size={18} /> {replacing ? t("變更暱稱別名") : t("建立暱稱別名")}
        </h2>
        <div className="create-row alias-create-row">
          <div className="alias-name-input">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("名字（例：luke）")}
              aria-label={t("別名名字")}
              maxLength={12}
              autoComplete="off"
            />
            <span className="alias-name-suffix">{t("＋ 流水號 @atwho.org")}</span>
          </div>
          <select
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            aria-label={t("目標地址")}
            disabled={targets.length === 0}
          >
            {targets.length === 0 ? (
              <option value="">{t("沒有可用的目標地址")}</option>
            ) : (
              targets.map((target) => (
                <option key={target.id} value={String(target.id)}>
                  {target.email}
                </option>
              ))
            )}
          </select>
          <button type="submit" className="btn-primary" disabled={!canSubmit}>
            {busy ? t("處理中…") : replacing ? t("變更") : t("建立")}
          </button>
        </div>
        <p className={`muted small ${nameError ? "error-text" : ""}`} aria-live="polite">
          {nameError
            ? t(nameError)
            : replacing
              ? t("每個帳號限 1 個啟用中的暱稱別名；送出後舊的 {address} 會立即停用。", {
                  address: activeNamed[0]?.alias_address ?? "",
                })
              : t("僅限 3–12 個英文字母、不可使用保留字；實際地址例：{preview}", {
                  preview: aliasPreview(name || "luke"),
                })}
        </p>
        {error && <p className="error-text">{error}</p>}
      </form>

      {created && (
        <div className="alias-success" role="status">
          <div>
            <strong>{created.replaced?.length ? t("暱稱別名已變更") : t("暱稱別名已建立")}</strong>
            <p className="mono alias-success-address">{created.alias_address}</p>
            <p className="muted small">{t("目標地址：{address}。把這個別名給對方即可。", { address: createdTarget })}</p>
            {created.replaced?.length ? (
              <p className="muted small">
                {t("舊別名已停用：{addresses}", { addresses: created.replaced.join("、") })}
              </p>
            ) : null}
          </div>
          <button type="button" className="btn-secondary" onClick={() => void copyAlias(created.alias_address)}>
            {copied === created.alias_address ? t("已複製") : t("複製別名")}
          </button>
        </div>
      )}

      <p className="muted small">
        {t("隱身代號由系統在帳號建立時自動產生，對方只會看到隨機隱身代號；撰寫時選「隱身代號」模式即可使用，回信仍會送到你的真實 ID。")}
      </p>

      <div className="address-table-wrap">
        {aliases === null ? (
          <div className="list-state">
            <div className="spinner" />
          </div>
        ) : aliases.length === 0 ? (
          <div className="list-state">
            <p>{t(EMPTY_HINT)}</p>
          </div>
        ) : (
          <table className="address-table">
            <thead>
              <tr>
                <th>{t("別名")}</th>
                <th>{t("類型")}</th>
                <th>{t("目標地址")}</th>
                <th>{t("狀態")}</th>
                <th>{t("收到幾封")}</th>
                <th>{t("最後收到")}</th>
                <th>{t("操作")}</th>
              </tr>
            </thead>
            <tbody>
              {aliases.map((row) => (
                <tr key={row.id} className={row.status !== "active" ? "row-dim" : ""}>
                  <td className="mono">{row.alias_address}</td>
                  <td>{row.kind === "token" ? t("隱身代號") : t("暱稱")}</td>
                  <td className="mono">{row.target_email}</td>
                  <td>
                    <span className={`status-pill ${row.status}`}>
                      {row.status === "active" ? t("啟用") : t("停用")}
                    </span>
                  </td>
                  <td>{row.received_count}</td>
                  <td>{row.last_received_at === null ? "—" : formatFullDate(row.last_received_at)}</td>
                  <td className="row-actions">
                    {row.kind === "token" ? (
                      <>
                        <button type="button" onClick={() => void copyAlias(row.alias_address)}>
                          {copied === row.alias_address ? t("已複製") : t("複製")}
                        </button>
                        <span className="muted small">{t("系統管理")}</span>
                      </>
                    ) : (
                      <>
                        <button type="button" disabled={busyId === row.id} onClick={() => void toggleStatus(row)}>
                          {row.status === "active" ? t("停用") : t("啟用")}
                        </button>
                        {row.status === "active" && (
                          <button
                            type="button"
                            className="danger"
                            disabled={busyId === row.id}
                            onClick={() => void removeAlias(row)}
                          >
                            {t("刪除（停用）")}
                          </button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="muted small">
        {t("停用後寄到別名的來信會回 550（避免退信迴圈），真實地址不受影響；刪除為軟停用，資料列與既有信件紀錄會保留。隱身代號由系統管理，無法停用。")}
      </p>
    </section>
  );
}
