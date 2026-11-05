import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import {
  checkId,
  forgotPassword,
  getRegistrationMode,
  mailboxLogin,
  ownerLogin,
  register,
  registerRequest,
  registerVerify,
  userLogin,
} from "../api/endpoints";
import type { IdCheckResult, RegistrationMode, Session } from "../api/types";
import type { LoginMode } from "../lib/hostMode";
import { buildGoogleStartUrl } from "../lib/oauth";
import { clearRegistrationParams, parseRegistrationQuery } from "../lib/registrationLinks";
import { IconMail } from "./icons";
import { TurnstileWidget } from "./TurnstileWidget";

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
  // D21（docs/21 §6）
  EMAIL_INVALID: "請輸入有效的 Email 地址。",
  ID_TAKEN: "這個 ID 已被使用，請換一個。",
  ID_RESERVED: "此 ID 為系統保留，請換一個。",
  ID_MATCHES_DOMAIN: "這個 ID 與真實網域同名（品牌冒用風險），請改用下方建議。",
  CODE_INVALID: "驗證碼錯誤或已失效，請確認後再試。",
  CODE_EXPIRED: "驗證碼已過期（15 分鐘），請重新寄送。",
  CODE_LOCKED: "驗證碼錯誤次數過多，請重新寄送驗證碼。",
  CODE_COOLDOWN: "請稍候再重新寄送驗證碼。",
  CODE_DAILY_LIMIT: "此 Email 今日寄送次數已達上限（5 封），請明天再試。",
  REGISTRATION_CLOSED: "站方目前暫停開放註冊。",
  REGISTRATION_INVITE_ONLY: "目前為邀請碼註冊模式，請使用邀請碼。",
  REGISTRATION_EMAIL_VERIFY_REQUIRED: "請改用 Email 驗證碼完成註冊。",
  EMAIL_SEND_FAILED: "驗證碼寄送失敗，請稍後再試。",
  TURNSTILE_FAILED: "請重新完成下方的機器人驗證後再試。",
};

type Tab = "mailbox" | "owner" | "register";

const TAB_LABEL: Record<Tab, string> = {
  mailbox: "信箱登入",
  owner: "管理員登入",
  register: "註冊",
};

/** 組出「server 訊息（提示）」；沒有提示就只顯示 server 訊息 */
function registerErrorText(err: unknown): string {
  if (err instanceof ApiError) {
    const hint = REGISTER_HINTS[err.code];
    return hint ? `${err.message}（${hint}）` : err.message;
  }
  return "註冊失敗，請稍後再試";
}

/** 登入頁：Model C 的兩種身分（信箱／管理員）＋ 訪客註冊（D21：Email 驗證碼／邀請碼） */
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
  /**
   * D22（docs/22）：可分享的註冊／邀請連結。
   * `?register=1`／`?invite=<code>` 只影響「顯示哪個分頁」與「預填邀請碼」，
   * 不影響任何權限判定（N3）；註冊模式與邀請碼有效性仍由後端決定。
   * 參數只在第一次 render 讀取一次，處理後立刻清除（見下方 effect）。
   */
  const acceptsRegistrationLink = showRegister && mode !== "admin";
  const [initialQuery] = useState(() => parseRegistrationQuery(window.location.search));
  const [tab, setTab] = useState<Tab>(() =>
    mode === "admin" ? "owner" : acceptsRegistrationLink && initialQuery.openRegister ? "register" : "mailbox"
  );
  const [email, setEmail] = useState(() => {
    try {
      return localStorage.getItem(LAST_EMAIL_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [username, setUsername] = useState("owner");
  const [password, setPassword] = useState("");
  // 註冊欄位（邀請碼模式）；D22：`?invite=<code>` 會在首次 render 預填
  const [inviteCode, setInviteCode] = useState(() => initialQuery.inviteCode ?? "");
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  // 註冊欄位（D21 Email 驗證碼模式）
  const [regMode, setRegMode] = useState<RegistrationMode | null>(null);
  const [regEmail, setRegEmail] = useState("");
  const [regLocalPart, setRegLocalPart] = useState("");
  // D23：Turnstile（site key 由 registration-mode 取得；未設定 → null＝不顯示 widget）
  const [turnstileSiteKey, setTurnstileSiteKey] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);
  const turnstileRequired = regMode === "email_verify" && turnstileSiteKey !== null;
  const turnstileReady = !turnstileRequired || turnstileToken !== null;
  // D20：ID 即時檢查（debounce 500ms；只影響顯示，後端仍會複驗）
  const [idCheck, setIdCheck] = useState<IdCheckResult | null>(null);
  const [idChecking, setIdChecking] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [verificationCode, setVerificationCode] = useState("");
  const [resendIn, setResendIn] = useState(0);
  const [sendingCode, setSendingCode] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // D27（docs/28 §6）：忘記密碼流程＋NO_PASSWORD_SET 引導
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotSent, setForgotSent] = useState(false);
  const [noPasswordSet, setNoPasswordSet] = useState(false);
  /** D22：`?register=1` 開啟時，等 Email 欄位真正掛載後明確取得焦點 */
  const emailInputRef = useRef<HTMLInputElement | null>(null);

  // D21：註冊模式由後端決定（`REGISTRATION_MODE`；前端無法從建置期得知）。
  // D23：同一端點回傳 `turnstileSiteKey`；非 null 才載入 Turnstile widget。
  // 取不到／舊後端 → 回退 invite（無 widget），維持既有行為。
  useEffect(() => {
    if (!showRegister || mode === "admin") return;
    let alive = true;
    getRegistrationMode()
      .then((r) => {
        if (!alive) return;
        setRegMode(r.mode);
        setTurnstileSiteKey(r.turnstileSiteKey ?? null);
      })
      .catch(() => {
        if (!alive) return;
        setRegMode("invite");
        setTurnstileSiteKey(null);
      });
    return () => {
      alive = false;
    };
  }, [showRegister, mode]);

  // D22：連結參數只消費一次；處理完以 replaceState 清掉 register／invite
  //（避免使用者複製到含邀請碼的網址繼續轉傳）。非註冊入口（mail.）不動作。
  useEffect(() => {
    if (!acceptsRegistrationLink) return;
    clearRegistrationParams(window.history, window.location);
  }, [acceptsRegistrationLink]);

  // D22：`?register=1` → 註冊分頁的 Email 欄取得焦點（等註冊模式載入、欄位掛載後）
  useEffect(() => {
    if (!acceptsRegistrationLink || !initialQuery.openRegister) return;
    if (tab !== "register" || regMode !== "email_verify") return;
    emailInputRef.current?.focus();
  }, [acceptsRegistrationLink, initialQuery.openRegister, tab, regMode]);

  // 重寄倒數（60 秒）
  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = window.setInterval(() => {
      setResendIn((n) => (n <= 1 ? 0 : n - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendIn]);

  /**
   * D20（docs/20 §3.5）：ID 欄位停止輸入 500ms 後呼叫 `check-id`。
   * 只做提示；真正能否註冊由 `register-request`／`register-verify` 複驗（N3）。
   */
  useEffect(() => {
    if (tab !== "register" || regMode !== "email_verify" || codeSent) {
      setIdCheck(null);
      setIdChecking(false);
      return;
    }
    const name = regLocalPart.trim().toLowerCase();
    if (!name || !/^[a-z0-9][a-z0-9._-]*[a-z0-9]$|^[a-z0-9]$/.test(name)) {
      setIdCheck(null);
      setIdChecking(false);
      return;
    }

    let alive = true;
    const timer = window.setTimeout(() => {
      setIdChecking(true);
      checkId(name)
        .then((result) => {
          if (alive) setIdCheck(result);
        })
        .catch((err: unknown) => {
          if (!alive) return;
          setIdCheck(null);
          if (err instanceof ApiError && err.code === "RATE_LIMITED") {
            setError("ID 檢查過於頻繁，請稍後再試。");
          }
        })
        .finally(() => {
          if (alive) setIdChecking(false);
        });
    }, 500);

    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [tab, regMode, codeSent, regLocalPart]);

  const switchTab = (next: Tab) => {
    setTab(next);
    setError(null);
    setForgotOpen(false);
    setForgotSent(false);
    setNoPasswordSet(false);
  };

  /** D27：使用 Google 登入（透過 auth.atwho.org 薄代理；登入後導回目前路徑） */
  const startGoogle = (): void => {
    const current = `${window.location.pathname}${window.location.search}`;
    window.location.assign(buildGoogleStartUrl(current));
  };

  /** D27：寄送重設信（後端一律 200；前端只顯示「若帳號存在…」） */
  const sendForgot = async (): Promise<void> => {
    if (busy) return;
    setError(null);
    const identifier = forgotEmail.trim();
    if (!identifier) {
      setError("請輸入 Email 或使用者名稱");
      return;
    }
    setBusy(true);
    try {
      await forgotPassword(identifier);
      setForgotSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "寄送失敗，請稍後再試");
    } finally {
      setBusy(false);
    }
  };

  /** 寄送 6 位數驗證碼（D21；成功後顯示驗證碼欄位並啟動 60 秒倒數） */
  const sendCode = async (): Promise<void> => {
    if (sendingCode || busy) return;
    setError(null);
    const mail = regEmail.trim().toLowerCase();
    const name = regLocalPart.trim().toLowerCase();
    if (!mail || !name) {
      setError("請填寫 Email 與想要的 ID");
      return;
    }
    // D23：已啟用 Turnstile → token 有效才可寄碼（後端仍會複驗，前端不可信）
    if (turnstileRequired && !turnstileToken) {
      setError("請先完成機器人驗證");
      return;
    }
    setSendingCode(true);
    try {
      await registerRequest({
        email: mail,
        local_part: name,
        ...(turnstileRequired && turnstileToken ? { turnstile_token: turnstileToken } : {}),
      });
      setCodeSent(true);
      setVerificationCode("");
      setResendIn(60);
    } catch (err) {
      setError(registerErrorText(err));
    } finally {
      setSendingCode(false);
      // Turnstile token 是一次性的（送出後即被 siteverify 消耗）：重新取得，
      // 讓「重新寄送驗證碼」與失敗重試都使用新 token。
      if (turnstileRequired) {
        setTurnstileToken(null);
        setTurnstileResetKey((key) => key + 1);
      }
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || sendingCode) return;
    setError(null);
    setNoPasswordSet(false);

    if (tab === "register" && regMode === "email_verify" && !codeSent) {
      await sendCode();
      return;
    }
    if (tab === "register" && (regMode === null || regMode === "closed")) return;

    setBusy(true);
    try {
      if (tab === "register") {
        if (newPassword !== confirmPassword) {
          setError("兩次輸入的密碼不一致");
          return;
        }
        if (regMode === "email_verify") {
          const mail = regEmail.trim().toLowerCase();
          const name = regLocalPart.trim().toLowerCase();
          const code = verificationCode.trim();
          if (!mail || !name || !/^\d{6}$/.test(code) || !newPassword) {
            setError("請填寫 Email、ID、6 位數驗證碼與密碼");
            return;
          }
          const res = await registerVerify({ email: mail, local_part: name, code, password: newPassword });
          onLogin({ kind: "mailbox", token: res.token, addressId: res.address.id, email: res.address.email });
          return;
        }
        // 邀請碼模式（既有行為，完全不變）
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
        const identifier = email.trim();
        try {
          localStorage.setItem(LAST_EMAIL_KEY, identifier);
        } catch {
          /* ignore */
        }
        // D27：`*@atwho.org` 走既有地址登入（行為完全不變）；
        // 其他輸入（username／contact_email）走 user-login（docs/28 §3）。
        if (identifier.toLowerCase().endsWith("@atwho.org")) {
          const res = await mailboxLogin(identifier, password);
          onLogin({ kind: "mailbox", token: res.token, addressId: res.address.id, email: res.address.email });
        } else {
          const res = await userLogin(identifier, password);
          if (res.session === "owner") {
            onLogin({ kind: "owner", token: res.token, userId: res.user.id, username: res.user.username });
          } else if (res.session === "mailbox") {
            onLogin({ kind: "mailbox", token: res.token, addressId: res.address.id, email: res.address.email });
          } else {
            // 無可用地址的 visitor（OAuth 首登一定配發地址；理論上不會發生）
            setError("此帳號尚未配置信箱地址，請聯絡管理者。");
          }
        }
      } else {
        const res = await ownerLogin(username.trim(), password);
        onLogin({ kind: "owner", token: res.token, userId: res.user.id, username: res.user.username });
      }
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "NO_PASSWORD_SET") setNoPasswordSet(true);
        const hint = tab === "register" ? REGISTER_HINTS[err.code] : undefined;
        setError(hint ? `${err.message}（${hint}）` : err.message);
      } else {
        setError(tab === "register" ? "註冊失敗，請稍後再試" : "登入失敗，請稍後再試");
      }
    } finally {
      setBusy(false);
    }
  };

  /** 主要送出按鈕文案；`null` = 此狀態不顯示（載入中／已關閉／等待寄碼） */
  const submitLabel: string | null =
    tab === "register"
      ? regMode === "email_verify"
        ? codeSent
          ? busy
            ? "註冊中…"
            : "完成註冊並登入"
          : null
        : regMode === null || regMode === "closed"
          ? null
          : "註冊並登入"
      : forgotOpen
        ? null
        : busy
          ? "登入中…"
          : "登入";

  /** D23：site key 非空且為 email_verify 模式才顯示（未設定 → 完全不載入腳本） */
  const turnstileWidget =
    regMode === "email_verify" && turnstileSiteKey !== null ? (
      <TurnstileWidget siteKey={turnstileSiteKey} onToken={setTurnstileToken} resetKey={turnstileResetKey} />
    ) : null;

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
            regMode === null ? (
              <p className="login-hint">正在載入註冊設定…</p>
            ) : regMode === "closed" ? (
              <p className="login-hint">目前未開放註冊。</p>
            ) : regMode === "email_verify" ? (
              <>
                <label>
                  Email（收取驗證碼）
                  <input
                    ref={emailInputRef}
                    type="email"
                    value={regEmail}
                    onChange={(e) => setRegEmail(e.target.value)}
                    placeholder="you@example.com"
                    autoComplete="email"
                    disabled={codeSent}
                    required={!codeSent}
                    autoFocus
                  />
                </label>
                <label>
                  想要的 ID
                  <div className="suffix-input">
                    <input
                      type="text"
                      value={regLocalPart}
                      onChange={(e) => setRegLocalPart(e.target.value)}
                      placeholder="例如 friend01"
                      autoComplete="username"
                      disabled={codeSent}
                      required={!codeSent}
                    />
                    <span>@atwho.org</span>
                  </div>
                </label>
                {!codeSent && regLocalPart.trim() !== "" && (
                  <div className="id-check" aria-live="polite">
                    {idChecking ? (
                      <span className="id-check-pending">檢查中…</span>
                    ) : idCheck?.available ? (
                      <span className="id-check-ok">✅ 可用</span>
                    ) : idCheck?.reason === "MATCHES_DOMAIN" ? (
                      <span className="id-check-bad">
                        ❌ 已被{" "}
                        {idCheck.tldHit
                          ? `${regLocalPart.trim().toLowerCase()}.${idCheck.tldHit}`
                          : "現有"}{" "}
                        網域使用
                      </span>
                    ) : idCheck?.reason === "RESERVED" ? (
                      <span className="id-check-warn">⚠️ 保留字，請換一個</span>
                    ) : idCheck?.reason === "TAKEN" ? (
                      <span className="id-check-warn">⚠️ 已有人使用</span>
                    ) : null}
                    {idCheck && !idCheck.available && (idCheck.suggestions?.length ?? 0) > 0 && (
                      <div className="id-suggestions">
                        <span>建議：</span>
                        {idCheck.suggestions!.map((suggestion) => (
                          <button
                            key={suggestion}
                            type="button"
                            className="id-suggestion-chip"
                            onClick={() => {
                              setRegLocalPart(suggestion);
                              setIdCheck(null);
                            }}
                          >
                            {suggestion}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
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

                {codeSent && (
                  <>
                    <label>
                      驗證碼（6 位數）
                      <input
                        type="text"
                        className="code-input"
                        value={verificationCode}
                        onChange={(e) => setVerificationCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                        placeholder="000000"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={6}
                        required
                      />
                    </label>
                    <p className="login-hint">驗證碼已寄至 {regEmail.trim()}，15 分鐘內有效。</p>
                    {turnstileWidget}
                    <div className="register-actions">
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => void sendCode()}
                        disabled={resendIn > 0 || sendingCode || busy || !turnstileReady}
                      >
                        {sendingCode ? "寄送中…" : resendIn > 0 ? `重新寄送（${resendIn}s）` : "重新寄送驗證碼"}
                      </button>
                      <button
                        type="button"
                        className="btn-link"
                        onClick={() => {
                          setCodeSent(false);
                          setVerificationCode("");
                          setResendIn(0);
                          setError(null);
                        }}
                        disabled={busy}
                      >
                        修改 Email／ID
                      </button>
                    </div>
                  </>
                )}

                {!codeSent && (
                  <>
                    {turnstileWidget}
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => void sendCode()}
                      disabled={sendingCode || busy || !turnstileReady}
                    >
                      {sendingCode ? "寄送中…" : "寄送驗證碼"}
                    </button>
                  </>
                )}
              </>
            ) : (
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
            )
          ) : tab === "mailbox" ? (
            forgotOpen ? (
              <>
                <label>
                  Email 或使用者名稱
                  <input
                    type="text"
                    autoComplete="username"
                    placeholder="you@example.com 或 itag"
                    value={forgotEmail}
                    onChange={(e) => setForgotEmail(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void sendForgot();
                      }
                    }}
                    required
                    autoFocus
                  />
                </label>
                {forgotSent ? (
                  <p className="login-hint">若帳號存在，已寄出重設信（30 分鐘內有效）。</p>
                ) : (
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => void sendForgot()}
                    disabled={busy}
                  >
                    {busy ? "寄送中…" : "寄送重設信"}
                  </button>
                )}
                <button
                  type="button"
                  className="btn-link"
                  onClick={() => {
                    setForgotOpen(false);
                    setForgotSent(false);
                    setError(null);
                  }}
                  disabled={busy}
                >
                  返回登入
                </button>
              </>
            ) : (
              <>
                <label>
                  電子郵件地址或使用者名稱
                  <input
                    type="text"
                    autoComplete="username"
                    placeholder="you@atwho.org 或 itag"
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
                <div className="login-inline-links">
                  <button
                    type="button"
                    className="btn-link"
                    onClick={() => {
                      setForgotOpen(true);
                      setForgotEmail(email);
                      setForgotSent(false);
                      setNoPasswordSet(false);
                      setError(null);
                    }}
                  >
                    忘記密碼？
                  </button>
                </div>
                {noPasswordSet && (
                  <div className="login-guidance">
                    <p className="login-hint">
                      此帳號尚未設定密碼：請用 Google 登入，或使用「忘記密碼」設定。
                    </p>
                    <button type="button" className="btn-google" onClick={startGoogle}>
                      使用 Google 登入
                    </button>
                    <button
                      type="button"
                      className="btn-link"
                      onClick={() => {
                        setForgotOpen(true);
                        setForgotEmail(email);
                        setForgotSent(false);
                        setError(null);
                      }}
                    >
                      使用忘記密碼設定
                    </button>
                  </div>
                )}
              </>
            )
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

          {submitLabel && (
            <button type="submit" className="btn-primary" disabled={busy}>
              {submitLabel}
            </button>
          )}
        </form>

        {tab !== "register" && (
          <button type="button" className="btn-google" onClick={startGoogle}>
            使用 Google 登入
          </button>
        )}

        <p className="login-hint">
          {tab === "mailbox"
            ? "信箱登入僅能看到此地址的信件（可用範圍：收信匣、寄件備份、封存、垃圾郵件、垃圾桶）。"
            : tab === "owner"
              ? "管理員（owner）可管理所有虛擬地址，並以聚合視角查看全部信箱。"
              : regMode === "email_verify"
                ? "填寫 Email 收取 6 位數驗證碼；驗證成功後會建立你的信箱地址（寄信受每日配額限制）。"
                : regMode === "closed"
                  ? "站方目前暫停開放註冊。"
                  : "註冊需要邀請碼。註冊後會建立你自己的信箱地址（寄信受每日配額限制）。"}
        </p>
      </div>
    </div>
  );
}
