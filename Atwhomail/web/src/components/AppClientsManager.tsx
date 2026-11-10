/**
 * AppClientsManager — D26 App Clients 管理（docs/27 §6；owner only）
 *
 * 最小 UI：
 *  - 列表（app_id／名稱／狀態／redirect_uris）
 *  - 新增（app_id、名稱、redirect_uris）→ secret **只顯示一次**（含複製）
 *  - 停用／啟用（軟停用；資料列保留）
 *
 * ⚠️ 後端所有 `/api/apps*` 端點皆 `requireOwner`；本頁只在 `mail.`／localhost 顯示，
 *    但真正的權限仍由後端判定（docs/16 N3）。
 * ⚠️ secret 只在建立回應出現一次；清單／更新都不會回傳（DB 只存雜湊）。
 */
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../api/client";
import { createApp, disableApp, listApps, updateApp } from "../api/endpoints";
import type { AppClient, CreatedAppClient } from "../api/types";
import { getFormatLocale, useI18n } from "../i18n";
import { INTERNAL_SYSTEMS, type SystemDef } from "../lib/systems";
import { IconBack, IconRefresh } from "./icons";
import { Modal } from "./Modal";

interface Props {
  onBack: () => void;
  onToast: (message: string, kind?: "info" | "error") => void;
}

function formatTime(ts: number): string {
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

/** 每行一個 redirect_uri（空白行忽略） */
function parseRedirectInput(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function AppClientsManager({ onBack, onToast }: Props) {
  const { t } = useI18n();
  const [apps, setApps] = useState<AppClient[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [newAppId, setNewAppId] = useState("");
  const [newName, setNewName] = useState("");
  const [newRedirects, setNewRedirects] = useState("");
  const [creating, setCreating] = useState(false);
  /** 建立成功後的一次性 secret；關閉視窗即清空（伺服器不會再回傳） */
  const [created, setCreated] = useState<CreatedAppClient | null>(null);
  /** D37：內部系統一鍵建立（form／now／chat） */
  const [creatingInternal, setCreatingInternal] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const res = await listApps();
      setApps(res.apps);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("載入 App Clients 失敗"));
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openCreate = () => {
    setNewAppId("");
    setNewName("");
    setNewRedirects("");
    setShowCreate(true);
  };

  const submitCreate = async () => {
    const appId = newAppId.trim();
    const name = newName.trim();
    const redirects = parseRedirectInput(newRedirects);
    if (!appId || !name || redirects.length === 0) {
      onToast(t("請填寫 App ID、名稱與至少一個 redirect_uri"), "error");
      return;
    }
    setCreating(true);
    try {
      const res = await createApp({ app_id: appId, name, redirect_uris: redirects });
      setShowCreate(false);
      setCreated(res);
      onToast(t("已建立 {appId}；請立即複製 secret（只顯示一次）", { appId: res.app_id }));
      await reload();
    } catch (e) {
      onToast(e instanceof ApiError ? e.message : t("建立 App 失敗"), "error");
    } finally {
      setCreating(false);
    }
  };

  /** D37：建立單一內部系統的 App Client（redirect_uri 由 systems.ts 單一來源提供） */
  const createInternal = async (system: SystemDef) => {
    if (!system.appId || !system.redirectUri) return;
    setCreatingInternal(system.appId);
    try {
      const res = await createApp({
        app_id: system.appId,
        name: system.name,
        redirect_uris: [system.redirectUri],
      });
      setCreated(res);
      onToast(t("已建立 {appId}；請立即複製 secret（只顯示一次）", { appId: res.app_id }));
      await reload();
    } catch (e) {
      onToast(e instanceof ApiError ? e.message : t("建立 App 失敗"), "error");
    } finally {
      setCreatingInternal(null);
    }
  };

  const setStatus = async (app: AppClient, status: "active" | "disabled") => {
    setBusyId(app.id);
    try {
      // 停用走 DELETE（後端軟停用）；啟用走 PATCH status='active'
      if (status === "disabled") await disableApp(app.id);
      else await updateApp(app.id, { status: "active" });
      onToast(
        status === "active"
          ? t("{appId} 已啟用", { appId: app.app_id })
          : t("{appId} 已停用", { appId: app.app_id })
      );
      await reload();
    } catch (e) {
      onToast(e instanceof ApiError ? e.message : t("更新失敗"), "error");
    } finally {
      setBusyId(null);
    }
  };

  const copySecret = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.app_secret);
      onToast(t("已複製 secret"));
    } catch {
      onToast(t("複製失敗，請手動選取 secret"), "error");
    }
  };

  return (
    <section className="address-page">
      <div className="page-head">
        <button type="button" className="icon-btn" onClick={onBack} aria-label={t("返回")}>
          <IconBack size={20} />
        </button>
        <h1>{t("應用程式（App Clients）")}</h1>
        <button type="button" className="btn-secondary" onClick={openCreate}>
          {t("新增 App")}
        </button>
        <button type="button" className="icon-btn" title={t("重新整理")} onClick={() => void reload()}>
          <IconRefresh size={18} />
        </button>
      </div>

      <p className="muted small">
        {t("其他 App 可導向 https://app.atwho.org/?app=<app_id>&redirect_uri=<回呼網址>；登入後由 https://auth.atwho.org/api/auth/exchange 以 app_secret 換取使用者 token。redirect_uri 必須完全相符白名單。")}
      </p>
      <p className="warn-text">
        {t("⚠️ app_secret 只會在建立時顯示一次；伺服器只保存雜湊，無法再取回。")}
      </p>

      {/* D37：Mail／Form／Now／Chat 的內部 App Client（一鍵建立；secret 只顯示一次） */}
      {apps && (
        <>
          <h2>{t("內部系統")}</h2>
          <div className="address-table-wrap">
            <table className="address-table">
              <thead>
                <tr>
                  <th>{t("名稱")}</th>
                  <th>App ID</th>
                  <th>Redirect URI</th>
                  <th>{t("狀態")}</th>
                  <th>{t("操作")}</th>
                </tr>
              </thead>
              <tbody>
                {INTERNAL_SYSTEMS.filter((s) => s.appId !== null && s.redirectUri !== null).map((system) => {
                  const existing = apps.find((a) => a.app_id === system.appId);
                  return (
                    <tr key={system.id}>
                      <td>{system.name}</td>
                      <td className="mono">{system.appId}</td>
                      <td className="mono small">{system.redirectUri}</td>
                      <td>
                        {existing ? (
                          <span className={`status-pill ${existing.status === "active" ? "active" : "disabled"}`}>
                            {existing.status === "active" ? t("啟用中") : t("已停用")}
                          </span>
                        ) : (
                          <span className="muted small">{t("尚未建立")}</span>
                        )}
                      </td>
                      <td className="row-actions">
                        {!existing && (
                          <button
                            type="button"
                            disabled={creatingInternal === system.appId}
                            onClick={() => void createInternal(system)}
                          >
                            {creatingInternal === system.appId ? "…" : t("建立")}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="address-table-wrap">
        {error ? (
          <div className="list-state error-text">{error}</div>
        ) : apps === null ? (
          <div className="list-state">
            <div className="spinner" />
          </div>
        ) : apps.length === 0 ? (
          <div className="list-state">{t("尚無 App Client")}</div>
        ) : (
          <table className="address-table">
            <thead>
              <tr>
                <th>App ID</th>
                <th>{t("名稱")}</th>
                <th>{t("狀態")}</th>
                <th>Redirect URIs</th>
                <th>{t("建立時間")}</th>
                <th>{t("操作")}</th>
              </tr>
            </thead>
            <tbody>
              {apps.map((a) => {
                const disabled = a.status !== "active";
                return (
                  <tr key={a.id} className={disabled ? "row-dim" : ""}>
                    <td className="mono">{a.app_id}</td>
                    <td>{a.name}</td>
                    <td>
                      <span className={`status-pill ${disabled ? "disabled" : "active"}`}>
                        {disabled ? t("已停用") : t("啟用中")}
                      </span>
                    </td>
                    <td>
                      <ul className="redirect-list">
                        {a.redirect_uris.map((uri) => (
                          <li key={uri} className="mono small">
                            {uri}
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td>{formatTime(a.created_at)}</td>
                    <td className="row-actions">
                      <button
                        type="button"
                        className={disabled ? "" : "danger"}
                        disabled={busyId === a.id}
                        onClick={() => void setStatus(a, disabled ? "active" : "disabled")}
                      >
                        {disabled ? t("啟用") : t("停用")}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {showCreate && (
        <Modal title={t("新增 App Client")} onClose={() => setShowCreate(false)}>
          <label className="field-row">
            <span>{t("App ID（小寫英數字／連字號，以字母開頭）")}</span>
            <input
              type="text"
              value={newAppId}
              onChange={(e) => setNewAppId(e.target.value)}
              placeholder={t("例如 mycrm")}
              autoFocus
            />
          </label>
          <label className="field-row">
            <span>{t("名稱")}</span>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t("例如 My CRM")}
            />
          </label>
          <label className="field-row">
            <span>{t("Redirect URIs（每行一個；必須 https，完整相符）")}</span>
            <textarea
              rows={4}
              value={newRedirects}
              onChange={(e) => setNewRedirects(e.target.value)}
              placeholder={"https://crm.example.com/auth/cb\nhttps://crm.example.com/auth/cb2"}
            />
          </label>
          <p className="muted small">
            {t("App ID 建立後不可修改；redirect_uri 可之後用 PATCH 更新。secret 將於建立成功後顯示一次。")}
          </p>
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={() => setShowCreate(false)}>
              {t("取消")}
            </button>
            <button type="button" className="btn-primary" disabled={creating} onClick={() => void submitCreate()}>
              {creating ? t("建立中…") : t("建立")}
            </button>
          </div>
        </Modal>
      )}

      {created && (
        <Modal title={t("{appId} 的 App Secret（只顯示一次）", { appId: created.app_id })} onClose={() => setCreated(null)}>
          <p className="warn-text">
            {t("⚠️ 請立即複製並保存。關閉此視窗後無法再次取得；若遺失只能停用後重新建立。")}
          </p>
          <code className="app-secret mono">{created.app_secret}</code>
          <p className="muted small">
            redirect_uris：
            {created.redirect_uris.map((uri) => (
              <span key={uri} className="mono">
                {" "}
                {uri}
              </span>
            ))}
          </p>
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={() => setCreated(null)}>
              {t("我已保存，關閉")}
            </button>
            <button type="button" className="btn-primary" onClick={() => void copySecret()}>
              {t("複製 secret")}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
