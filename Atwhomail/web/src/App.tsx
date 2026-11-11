import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, UNAUTHORIZED_EVENT } from "./api/client";
import { appLogin } from "./api/endpoints";
import type { Session } from "./api/types";
import { clearSession, loadSession, saveSession } from "./auth/session";
import { AppHandoff } from "./components/AppHandoff";
import { AppShell } from "./components/AppShell";
import { LoginPage } from "./components/LoginPage";
import { ResetPasswordPage } from "./components/ResetPasswordPage";
import { parseAppLoginQuery } from "./lib/appLogin";
import { loginModeFor } from "./lib/hostMode";
import { getResetToken, takeOAuthSession } from "./lib/oauth";
import {
  getLastSystem,
  isSystemId,
  setLastSystem,
  switchTargetFor,
  type SystemDef,
} from "./lib/systems";
import { I18nProvider, useI18n } from "./i18n";

/**
 * 登入頁顯示模式：依 hostname 決定一次（docs/16 D1）
 * mail.atwho.org → 只顯示管理員登入｜app.atwho.org → 只顯示信箱／註冊｜其餘 → 全部
 * ⚠️ 僅影響 UI 顯示；權限一律由後端的 session 判定（N3）
 */
const LOGIN_MODE = loginModeFor(window.location.hostname);

/** 預設導向（測試可注入 `navigate`，避免真的觸發 jsdom navigation） */
const defaultNavigate = (url: string): void => {
  window.location.assign(url);
};

/**
 * D26（docs/27 §5）：`?app=` ＋ `?redirect_uri=` 的登入轉交。
 *
 * - 使用者完成既有登入流程（信箱／管理員／註冊）後，`session` 一出現就呼叫 app-login
 * - 成功 → `location.assign(redirect)`（**只用後端回傳的 redirect**）
 * - 失敗或參數不合法 → 顯示錯誤、**不導向**
 * - 完全沒帶 app／redirect_uri → 行為與 D26 之前完全相同（`?register=1`／`?invite=` 不受影響）
 */
export default function App({ navigate = defaultNavigate }: { navigate?: (url: string) => void } = {}) {
  return (
    <I18nProvider>
      <AppContent navigate={navigate} />
    </I18nProvider>
  );
}

function AppContent({ navigate }: { navigate: (url: string) => void }) {
  const { t } = useI18n();
  // D37：只有「這次真的登入」才套用上次系統；單純重新整理還原 session 不導轉
  const oauthLoginRef = useRef(false);
  // D27：Google OAuth callback 以 `#oauth_token=…` 導回 → 讀取後立即清除 fragment
  const [session, setSession] = useState<Session | null>(() => {
    const fromOAuth = takeOAuthSession(window);
    if (fromOAuth) {
      oauthLoginRef.current = true;
      saveSession(fromOAuth);
    }
    return fromOAuth ?? loadSession();
  });
  const [justLoggedIn, setJustLoggedIn] = useState(oauthLoginRef.current);
  /** D37：登入後的自動導轉只嘗試一次 */
  const autoSwitchAttempted = useRef(false);
  // D27：`?reset=<token>` → 先顯示設定新密碼頁（不論是否已登入）
  const [resetToken, setResetToken] = useState<string | null>(() => getResetToken(window.location.search));
  const [notice, setNotice] = useState<string | null>(null);
  /** 參數只在第一次 render 讀取（與 LoginPage 的 register／invite 行為一致） */
  const [appQuery] = useState(() => parseAppLoginQuery(window.location.search));
  const [handoff, setHandoff] = useState<{ status: "idle" | "pending" | "error"; error: string | null }>({
    status: "idle",
    error: null,
  });
  const [handoffAttempt, setHandoffAttempt] = useState(0);
  const [handoffDismissed, setHandoffDismissed] = useState(false);

  // 任何已登入請求收到 401（過期 / 密碼變更 TOKEN_STALE）→ 回登入頁
  useEffect(() => {
    const onUnauthorized = () => {
      clearSession();
      setSession(null);
      setJustLoggedIn(false);
      setNotice(t("登入已過期或密碼已變更，請重新登入。"));
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [t]);

  /** D26：登入後把 session 換成 App 的一次性 code，並導回其他 App */
  useEffect(() => {
    if (!appQuery.active || handoffDismissed) return;
    if (appQuery.error) {
      setHandoff({ status: "error", error: appQuery.error });
      return;
    }
    if (!session || !appQuery.app || !appQuery.redirectUri) return;

    let alive = true;
    setHandoff({ status: "pending", error: null });
    appLogin({ app: appQuery.app, redirect_uri: appQuery.redirectUri, state: appQuery.state ?? undefined })
      .then(({ redirect }) => {
        // D37：從哪個系統來，就記住哪個系統（下次在 Mail 登入後直接回去）
        if (isSystemId(appQuery.app)) setLastSystem(appQuery.app);
        // ⚠️ 只使用後端回傳的 redirect（前端提供的 redirect_uri 已經過後端白名單驗證）
        if (alive) navigate(redirect);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setHandoff({
          status: "error",
          error: err instanceof ApiError ? err.message : t("無法完成應用程式登入，請稍後再試"),
        });
      });
    return () => {
      alive = false;
    };
  }, [appQuery, session, handoffAttempt, handoffDismissed, navigate, t]);

  /**
   * D37：直接從 app.atwho.org 登入時，依「上次系統」自動前往 Form／Now／Chat。
   * - 只在公開入口生效；mail.atwho.org 管理入口留在 Mail
   * - 重新整理還原 session 不觸發（justLoggedIn=false）
   * - 失敗時清除偏好並留在 Mail，避免每次登入都被壞掉的系統卡住
   */
  useEffect(() => {
    if (!justLoggedIn || !session || appQuery.active || resetToken) return;
    if (autoSwitchAttempted.current) return;
    autoSwitchAttempted.current = true;
    setJustLoggedIn(false);

    const target = switchTargetFor(LOGIN_MODE, getLastSystem());
    if (!target?.appId || !target.redirectUri) return;
    appLogin({ app: target.appId, redirect_uri: target.redirectUri })
      .then(({ redirect }) => navigate(redirect))
      .catch((err: unknown) => {
        setLastSystem("mail");
        setNotice(err instanceof ApiError ? err.message : t("無法完成應用程式登入，請稍後再試"));
      });
  }, [justLoggedIn, session, appQuery.active, resetToken, navigate, t]);

  /** D37：帳號選單的系統切換 */
  const handleSwitchSystem = useCallback(
    (system: SystemDef) => {
      setLastSystem(system.id);
      if (!system.appId || !system.redirectUri) return;
      appLogin({ app: system.appId, redirect_uri: system.redirectUri })
        .then(({ redirect }) => navigate(redirect))
        .catch((err: unknown) => {
          setLastSystem("mail");
          setNotice(err instanceof ApiError ? err.message : t("無法完成應用程式登入，請稍後再試"));
        });
    },
    [navigate, t]
  );

  const handoffRequired = appQuery.active && !handoffDismissed;

  // D27：重設密碼頁優先於登入／信箱（連結可能在使用者已登入時開啟）
  if (resetToken) {
    return (
      <ResetPasswordPage
        token={resetToken}
        onDone={(message) => {
          try {
            window.history.replaceState(null, "", window.location.pathname);
          } catch {
            /* ignore */
          }
          setResetToken(null);
          setNotice(message);
        }}
      />
    );
  }

  if (!session) {
    return (
      <LoginPage
        // D26：參數不合法時在登入頁顯示錯誤（仍可正常登入；登入後不會導向）
        notice={handoffRequired && appQuery.error ? appQuery.error : notice}
        mode={LOGIN_MODE}
        onLogin={(next) => {
          saveSession(next);
          setNotice(null);
          setJustLoggedIn(true);
          setSession(next);
        }}
      />
    );
  }

  // D26：有效參數 → 顯示轉交畫面（成功時 navigate 後離開；失敗時留在本頁顯示錯誤）
  if (handoffRequired) {
    return (
      <AppHandoff
        app={appQuery.app}
        status={handoff.status === "error" ? "error" : "pending"}
        error={handoff.error ?? appQuery.error}
        onRetry={() => setHandoffAttempt((n) => n + 1)}
        onCancel={() => setHandoffDismissed(true)}
      />
    );
  }

  return (
    <AppShell
      session={session}
      hostMode={LOGIN_MODE}
      onSwitchSystem={handleSwitchSystem}
      flash={notice}
      onFlashShown={() => setNotice(null)}
      onLogout={() => {
        clearSession();
        setJustLoggedIn(false);
        setSession(null);
        setNotice(null);
      }}
    />
  );
}
