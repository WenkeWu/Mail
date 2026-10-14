import { useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import { mailboxLogin, ownerLogin, register } from "../api/endpoints";
import type { Session } from "../api/types";
import type { LoginMode } from "../lib/hostMode";
import { IconMail } from "./icons";

interface Props {
  notice: string | null;
  onLogin: (session: Session) => void;
  /** 是否顯示「註冊」分頁（Phase 1 訪客邀請制；預設 true） */
  showRegister?: boolean;
  /**
   * 顯示模式（docs/16 D1；由 App 依 hostname 決定）：
   * - `admin`：只顯示「管理員登入」（mail.atwho.org）
   * - `public`：只顯示「信箱登入」＋「註冊」（app.atwho.org）
   * - `all`：三分頁全顯示（localhost／pages.dev 等；預設值，維持既有行為）
   * ⚠️ 僅影響 UI；權限一律由後端判定
   */
  mode?: LoginMode;
}

const LAST_EMAIL_KEY = "atwhomail.lastEmail";

/** §4.2 錯誤碼 → 給人看的說明（server 訊息為主，這裡補「該怎麼做」） */
const REGISTER_HINTS: Record<string, string> = {
  INVITE_INVALID: "請確認邀請碼是否正確、尚未被撤銷或已過期。",
  INVITE_EXHAUSTED: "此邀請碼的使用次數已用盡，請索取新的邀請碼。",
  ADDRESS_TAKEN: "這個名稱已被使用，請換一個。",
  INVALID_LOCAL_PART: "名稱只能用小寫英數字與 . _ -（1–64 字元，不能以 . 或 - 開頭或結尾）。",
  WEAK_PASSWORD: "密碼至少 10 個字元，且不能是純數字。",
  REGISTRATION_DISABLED: "站方目前暫停開放註冊。",
  RATE_LIMITED: "嘗試次數過多，請稍後再試（連續失敗 5 次會鎖定 15 分鐘）。",
};

type Tab = "mailbox" | "owner" | "register";

const TAB_LABEL: Record<Tab, string> = {
  mailbox: "信箱登入",
  owner: "管理員登入",
  register: "註冊",
};

/** 登入頁：Model C 的兩種身分（信箱／管理員）＋ Phase 1 的訪客註冊（邀請碼） */
export function LoginPage({ notice, onLogin, showRegister = true, mode = "all" }: Props) {
  /**
   * 分頁清單依模式決定（docs/16 D1；僅顯示面）：
   * - admin（mail.）→ 只有管理員登入
   * - public（app.）→ 信箱登入（＋註冊，若 showRegister）
   * - all（其他）  → 信箱登入（＋註冊）＋管理員登入
   */
  const tabList: Tab[] =
    mode === "admin"
      ? ["owner"]
      : mode === "public"
        ? showRegister
          ? ["mailbox", "register"]
          : ["mailbox"]
        : showRegister
          ? ["mailbox", "register", "owner"]
          : ["mailbox", "owner"];
  const [tab, setTab] = useState<Tab>(mode === "admin" ? "owner" : "mailbox");
  const [email, setEmail] = useState(() => {
    try {
      return localStorage.getItem(LAST_EMAIL_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [username, setUsername] = useState("owner");
  const [password, setPassword] = useState("");
  // 註冊欄位
  const [inviteCode, setInviteCode] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const switchTab = (next: Tab) => {
    setTab(next);
    setError(null);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (tab === "register") {
        if (newPassword !== confirmPassword) {
          setError("兩次輸入的密碼不一致");
          return;
        }
        const code = inviteCode.trim();
        const name = newUsername.trim().toLowerCase();
        if (!code || !name || !newPassword) {
          setError("請填寫邀請碼、使用者名稱與密碼");
          return;
        }
        const res = await register({ invite_code: code, username: name, password: newPassword });
        onLogin({ kind: "mailbox", token: res.token, addressId: res.address.id, email: res.address.email });
        return;
      }
      if (tab === "mailbox") {
        const res = await mailboxLogin(email.trim(), password);
        try {
          localStorage.setItem(LAST_EMAIL_KEY, email.trim());
        } catch {
          /* ignore */
        }
        onLogin({ kind: "mailbox", token: res.token, addressId: res.address.id, email: res.address.email });
      } else {
        const res = await ownerLogin(username.trim(), password);
        onLogin({ kind: "owner", token: res.token, userId: res.user.id, username: res.user.username });
      }
    } catch (err) {
      if (err instanceof ApiError) {
        const hint = tab === "register" ? REGISTER_HINTS[err.code] : undefined;
        setError(hint ? `${err.message}（${hint}）` : err.message);
      } else {
        setError(tab === "register" ? "註冊失敗，請稍後再試" : "登入失敗，請稍後再試");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <span className="brand-mark">
            <IconMail size={26} />
          </span>
          <div>
            <h1>AtWhoMail</h1>
            <p>{mode === "admin" ? "管理員入口" : "虛擬地址收發信"}</p>
          </div>
        </div>

        <div className="login-tabs" role="tablist">
          {tabList.map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              className={tab === t ? "active" : ""}
              onClick={() => switchTab(t)}
            >
              {TAB_LABEL[t]}
            </button>
          ))}
        </div>

        {notice && <p className="login-notice">{notice}</p>}

        <form onSubmit={submit} className="login-form">
          {tab === "register" ? (
            <>
              <label>
                邀請碼
                <input
                  type="text"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  placeholder="向邀請你的人索取"
                  autoComplete="off"
                  required
                  autoFocus
                />
              </label>
              <label>
                使用者名稱（同時為你的信箱地址）
                <div className="suffix-input">
                  <input
                    type="text"
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                    placeholder="例如 friend01"
                    autoComplete="username"
                    required
                  />
                  <span>@atwho.org</span>
                </div>
              </label>
              <label>
                密碼
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="至少 10 個字元、非純數字"
                  autoComplete="new-password"
                  required
                />
              </label>
              <label>
                確認密碼
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  required
                />
              </label>
            </>
          ) : tab === "mailbox" ? (
            <>
              <label>
                電子郵件地址
                <input
                  type="email"
                  autoComplete="username"
                  placeholder="you@atwho.org"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                />
              </label>
              <label>
                密碼
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </label>
            </>
          ) : (
            <>
              <label>
                管理員帳號
                <input
                  type="text"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                  autoFocus
                />
              </label>
              <label>
                密碼
                <input
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </label>
            </>
          )}

          {error && <p className="login-error">{error}</p>}

          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? (tab === "register" ? "註冊中…" : "登入中…") : tab === "register" ? "註冊並登入" : "登入"}
          </button>
        </form>

        <p className="login-hint">
          {tab === "mailbox"
            ? "信箱登入僅能看到此地址的信件（可用範圍：收信匣、寄件備份、封存、垃圾郵件、垃圾桶）。"
            : tab === "owner"
              ? "管理員（owner）可管理所有虛擬地址，並以聚合視角查看全部信箱。"
              : "註冊需要邀請碼。註冊後會建立你自己的信箱地址（寄信受每日配額限制）。"}
        </p>
      </div>
    </div>
  );
}
