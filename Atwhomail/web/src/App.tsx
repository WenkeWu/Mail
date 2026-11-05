import { useEffect, useState } from "react";
import { ApiError, UNAUTHORIZED_EVENT } from "./api/client";
import { appLogin } from "./api/endpoints";
import type { Session } from "./api/types";
import { clearSession, loadSession, saveSession } from "./auth/session";
import { AppHandoff } from "./components/AppHandoff";
import { AppShell } from "./components/AppShell";
import { LoginPage } from "./components/LoginPage";
import { parseAppLoginQuery } from "./lib/appLogin";
import { loginModeFor } from "./lib/hostMode";

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
  const [session, setSession] = useState<Session | null>(() => loadSession());
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
      setNotice("登入已過期或密碼已變更，請重新登入。");
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

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
    appLogin({ app: appQuery.app, redirect_uri: appQuery.redirectUri })
      .then(({ redirect }) => {
        // ⚠️ 只使用後端回傳的 redirect（前端提供的 redirect_uri 已經過後端白名單驗證）
        if (alive) navigate(redirect);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setHandoff({
          status: "error",
          error: err instanceof ApiError ? err.message : "無法完成應用程式登入，請稍後再試",
        });
      });
    return () => {
      alive = false;
    };
  }, [appQuery, session, handoffAttempt, handoffDismissed, navigate]);

  const handoffRequired = appQuery.active && !handoffDismissed;

  if (!session) {
    return (
      <LoginPage
        // D26：參數不合法時在登入頁顯示錯誤（仍可正常登入；登入後不會導向）
        notice={handoffRequired && appQuery.error ? appQuery.error : notice}
        mode={LOGIN_MODE}
        onLogin={(next) => {
          saveSession(next);
          setNotice(null);
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
      onLogout={() => {
        clearSession();
        setSession(null);
        setNotice(null);
      }}
    />
  );
}
