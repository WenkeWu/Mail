import { useEffect, useState } from "react";
import { UNAUTHORIZED_EVENT } from "./api/client";
import type { Session } from "./api/types";
import { clearSession, loadSession, saveSession } from "./auth/session";
import { AppShell } from "./components/AppShell";
import { LoginPage } from "./components/LoginPage";
import { loginModeFor } from "./lib/hostMode";

/**
 * 登入頁顯示模式：依 hostname 決定一次（docs/16 D1）
 * mail.atwho.org → 只顯示管理員登入｜app.atwho.org → 只顯示信箱／註冊｜其餘 → 全部
 * ⚠️ 僅影響 UI 顯示；權限一律由後端的 session 判定（N3）
 */
const LOGIN_MODE = loginModeFor(window.location.hostname);

export default function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [notice, setNotice] = useState<string | null>(null);

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

  if (!session) {
    return (
      <LoginPage
        notice={notice}
        mode={LOGIN_MODE}
        onLogin={(next) => {
          saveSession(next);
          setNotice(null);
          setSession(next);
        }}
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
