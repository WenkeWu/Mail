import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError } from "../api/client";
import { sendForm, sendMail } from "../api/endpoints";
import type { EmailAddressInfo, EmailAlias, FormSchema, Session } from "../api/types";
import { useI18n, translate, type Language } from "../i18n";
import { checkFileSize, fileToBase64, type PendingAttachment } from "../lib/files";
import { formatBytes } from "../lib/format";
import { splitRecipients, textToHtml } from "../lib/recipients";
import { IconClose, IconFile, IconPaperclip, IconSend } from "./icons";

export type DraftMode = "new" | "reply" | "replyAll" | "forward" | "form";

/** D31：撰寫時的三種隱私模式 */
export type PrivacyMode = "real" | "nickname" | "token";

export interface Draft {
  /** 每次開新草稿遞增 → 讓 ComposeWindow 重新掛載並套用初始值 */
  key: number;
  mode: DraftMode;
  from: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  bodyText: string;
}

interface Props {
  draft: Draft;
  session: Session;
  /** owner 才有（可選寄件地址）；mailbox 固定為自己 */
  addresses: EmailAddressInfo[];
  /** D31：可供「暱稱／隱身代號」模式使用的別名（由後端依 session scope 回傳） */
  aliases: EmailAlias[];
  onClose: () => void;
  onSent: (info: { from: string; to: string[] }) => void;
  onError: (message: string) => void;
  /** 第一次編輯時通知（用於「放棄未寄出的信」確認） */
  onDirty: () => void;
}

const MODE_TITLE: Record<DraftMode, string> = {
  new: "新信件",
  reply: "回覆",
  replyAll: "全部回覆",
  forward: "轉寄",
  form: "互動式表單",
};

/** 互動式表單的預設 schema（可編輯；後端仍會做白名單驗證） */
function defaultFormSchema(language: Language): string {
  return JSON.stringify(
    {
      type: "object",
      properties: {
        name: { type: "string", title: translate(language, "名稱"), maxLength: 100 },
        message: { type: "string", title: translate(language, "信件內容"), maxLength: 2000 },
      },
      required: ["message"],
    },
    null,
    2
  );
}

const INTERNAL_DOMAIN = "@atwho.org";

export function ComposeWindow({ draft, session, addresses, aliases, onClose, onSent, onError, onDirty }: Props) {
  const { t, language } = useI18n();
  const [from, setFrom] = useState(draft.from);
  const [to, setTo] = useState(draft.to);
  const [cc, setCc] = useState(draft.cc);
  const [bcc, setBcc] = useState(draft.bcc);
  const [subject, setSubject] = useState(draft.subject);
  const [showCc, setShowCc] = useState(draft.cc !== "");
  const [showBcc, setShowBcc] = useState(draft.bcc !== "");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // docs/18 P2：「互動式表單」模式（收件人只允許內部地址；送出打 /api/forms/send）
  const [interactive, setInteractive] = useState(draft.mode === "form");
  const [formDescription, setFormDescription] = useState("");
  const [schemaText, setSchemaText] = useState(() => defaultFormSchema(language));
  const editorRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // 初始內文（引用原文）；使用 innerHTML 前先 escape（textToHtml）
  // interactive 切回一般模式時編輯器會重新掛載 → 依賴 interactive 重新填入內容
  useEffect(() => {
    if (!interactive && editorRef.current) editorRef.current.innerHTML = textToHtml(draft.bodyText);
  }, [draft.key, draft.bodyText, interactive]);

  const activeAddresses = addresses.filter((a) => a.status === "active");
  /**
   * D31（owner 2026-11-06）：三種隱私模式
   * - `real`：真實 ID（固定；mailbox = 自己的地址，owner = 第一個 active 地址）
   * - `nickname`：1 個啟用中的暱稱別名（可在個人設置變更；舊的立即停用）
   * - `token`：帳號建立時系統自動產生的隱身代號（對方只看到隱身代號）
   *
   * 回覆草稿的 `draft.from` 會自動對應到正確模式；若別名已停用則退回真實 ID。
   * ⚠️ 互動式表單後端只接受真實地址 → 切換時自動改回真實 ID。
   */
  const primaryRealEmail = session.kind === "mailbox" ? session.email : (activeAddresses[0]?.email ?? "");
  const realIdEmail =
    session.kind === "owner" &&
    draft.from &&
    activeAddresses.some((a) => a.email.toLowerCase() === draft.from.toLowerCase())
      ? draft.from
      : primaryRealEmail;

  const ownEmailSet = new Set(
    session.kind === "mailbox"
      ? [session.email.toLowerCase()]
      : activeAddresses.map((a) => a.email.toLowerCase())
  );
  const usableAliases = aliases.filter(
    (a) => a.status === "active" && ownEmailSet.has(a.target_email.toLowerCase())
  );
  const nicknameAlias = usableAliases.find((a) => a.kind === "named") ?? null;
  const tokenAlias =
    usableAliases.find(
      (a) => a.kind === "token" && a.target_email.toLowerCase() === realIdEmail.toLowerCase()
    ) ??
    usableAliases.find((a) => a.kind === "token") ??
    null;

  /** 由目前的 `from` 反推模式（別名清單非同步載入後也會自動正確） */
  const mode: PrivacyMode =
    tokenAlias && from.toLowerCase() === tokenAlias.alias_address.toLowerCase()
      ? "token"
      : nicknameAlias && from.toLowerCase() === nicknameAlias.alias_address.toLowerCase()
        ? "nickname"
        : "real";

  const chooseMode = (next: PrivacyMode) => {
    touch();
    if (next === "real") setFrom(realIdEmail);
    else if (next === "nickname" && nicknameAlias) setFrom(nicknameAlias.alias_address);
    else if (next === "token" && tokenAlias) setFrom(tokenAlias.alias_address);
  };

  // 草稿的 From 指向已停用／不可用的別名 → 退回真實 ID（等別名清單載入後才判斷）
  useEffect(() => {
    if (aliases.length === 0 || !from) return;
    const known = aliases.find((a) => a.alias_address.toLowerCase() === from.toLowerCase());
    if (known && known.status !== "active") setFrom(realIdEmail);
  }, [aliases, from, realIdEmail]);

  /** 任何編輯都通知上層（放棄確認用） */
  const touch = () => onDirty();

  const exec = (command: string, value?: string) => {
    editorRef.current?.focus();
    document.execCommand(command, false, value);
  };

  const addLink = () => {
    const url = window.prompt(t("連結網址（https://…）"));
    if (url) exec("createLink", url);
  };

  const addFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const errors: string[] = [];
    let total = attachments.reduce((sum, a) => sum + a.size, 0);
    const next = [...attachments];
    for (const file of Array.from(files)) {
      const sizeError = checkFileSize(file, total);
      if (sizeError) {
        errors.push(sizeError);
        continue;
      }
      try {
        const content_base64 = await fileToBase64(file);
        next.push({
          filename: file.name,
          type: file.type || "application/octet-stream",
          content_base64,
          size: file.size,
        });
        total += file.size;
      } catch (e) {
        errors.push(
          e instanceof Error ? e.message : t("讀取檔案失敗：{filename}", { filename: file.name })
        );
      }
    }
    setAttachments(next);
    if (errors.length > 0) setError(errors.join("；"));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (sending) return;
    setError(null);

    const toList = splitRecipients(to);
    const ccList = splitRecipients(cc);
    const bccList = splitRecipients(bcc);
    if (!from) {
      setError(t("請選擇寄件地址"));
      return;
    }
    if (interactive && mode !== "real") {
      setError(t("互動式表單只能使用真實 ID 寄件"));
      return;
    }
    if (toList.length === 0) {
      setError(t("請填寫至少一個收件者"));
      return;
    }
    if (!subject.trim()) {
      setError(t("請填寫主旨"));
      return;
    }
    let formSchema: FormSchema | null = null;
    let html = "";
    let text = "";
    if (interactive) {
      const allRecipients = [...toList, ...ccList, ...bccList];
      if (allRecipients.some((a) => !a.toLowerCase().endsWith(INTERNAL_DOMAIN))) {
        setError(t("互動式表單只能寄給 @atwho.org 內部地址"));
        return;
      }
      if (attachments.length > 0) {
        setError(t("互動式表單不支援附件"));
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(schemaText);
      } catch {
        setError(t("表單 schema 不是有效的 JSON"));
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setError(t("表單 schema 必須是 JSON 物件"));
        return;
      }
      const candidate = parsed as Record<string, unknown>;
      if (
        candidate.type !== "object" ||
        typeof candidate.properties !== "object" ||
        candidate.properties === null ||
        Array.isArray(candidate.properties)
      ) {
        setError(t("表單 schema 需為 type=object 且包含 properties"));
        return;
      }
      formSchema = candidate as FormSchema;
    } else {
      html = editorRef.current?.innerHTML ?? "";
      text = editorRef.current?.innerText ?? "";
      if (!text.trim()) {
        setError(t("請輸入信件內容"));
        return;
      }
    }

    setSending(true);
    try {
      if (interactive && formSchema) {
        await sendForm({
          from,
          to: toList,
          ...(ccList.length ? { cc: ccList } : {}),
          ...(bccList.length ? { bcc: bccList } : {}),
          subject: subject.trim(),
          ...(formDescription.trim() ? { description: formDescription.trim() } : {}),
          schema: formSchema,
        });
      } else {
        await sendMail({
          from,
          to: toList,
          ...(ccList.length ? { cc: ccList } : {}),
          ...(bccList.length ? { bcc: bccList } : {}),
          subject: subject.trim(),
          text,
          html,
          ...(attachments.length
            ? {
                attachments: attachments.map((a) => ({
                  filename: a.filename,
                  type: a.type,
                  content_base64: a.content_base64,
                  disposition: "attachment" as const,
                })),
              }
            : {}),
        });
      }
      onSent({ from, to: toList });
    } catch (err) {
      const message = err instanceof ApiError ? `${err.message}（${err.code}）` : t("寄送失敗，請稍後再試");
      setError(message);
      onError(message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="compose-window" role="dialog" aria-label={t(MODE_TITLE[draft.mode])}>
      <div className="compose-head">
        <strong>{interactive ? t("互動式表單") : t(MODE_TITLE[draft.mode])}</strong>
        <div className="compose-mode-switch" role="tablist" aria-label={t("郵件模式")}>
          <button
            type="button"
            role="tab"
            aria-selected={!interactive}
            className={!interactive ? "active" : ""}
            onClick={() => {
              touch();
              setInteractive(false);
            }}
          >
            {t("一般信件")}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={interactive}
            className={interactive ? "active" : ""}
            onClick={() => {
              touch();
              setInteractive(true);
              // D31：互動式表單後端只接受真實地址 → 從暱稱／隱身代號自動改回真實 ID
              if (mode !== "real") setFrom(realIdEmail);
            }}
          >
            {t("互動式表單")}
          </button>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label={t("關閉")}>
          <IconClose size={16} />
        </button>
      </div>

      <form className="compose-form" onSubmit={submit}>
        <div className="compose-row">
          <label>{t("隱私模式")}</label>
          <div className="privacy-modes" role="radiogroup" aria-label={t("隱私模式")}>
            <button
              type="button"
              role="radio"
              aria-checked={mode === "real"}
              className={mode === "real" ? "active" : ""}
              title={realIdEmail || undefined}
              onClick={() => chooseMode("real")}
            >
              {t("真實 ID")}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === "nickname"}
              className={mode === "nickname" ? "active" : ""}
              disabled={!nicknameAlias || interactive}
              title={
                !nicknameAlias
                  ? t("尚未建立暱稱別名；請到「個人設置 → 匿名（別名）」建立")
                  : interactive
                    ? t("互動式表單只能使用真實 ID")
                    : nicknameAlias.alias_address
              }
              onClick={() => chooseMode("nickname")}
            >
              {t("暱稱")}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === "token"}
              className={mode === "token" ? "active" : ""}
              disabled={!tokenAlias || interactive}
              title={
                !tokenAlias
                  ? t("隱身代號尚未產生；請重新登入或聯絡管理者")
                  : interactive
                    ? t("互動式表單只能使用真實 ID")
                    : tokenAlias.alias_address
              }
              onClick={() => chooseMode("token")}
            >
              {t("隱身代號")}
            </button>
          </div>
        </div>

        <div className="compose-row">
          <label htmlFor="compose-from">{t("寄件者")}</label>
          <input id="compose-from" value={from} readOnly />
        </div>

        {!interactive && (
          <p className="compose-hint compose-from-hint">
            {mode === "real" && t("對方會看到你的真實 ID。")}
            {mode === "nickname" && t("對方會看到暱稱別名；回信仍會送到你的真實 ID。")}
            {mode === "token" && t("對方只會看到這組隱身代號，看不到真實 ID 或暱稱；回信仍會送到你的真實 ID。")}
          </p>
        )}
        {!interactive && !nicknameAlias && (
          <p className="compose-hint compose-from-hint">
            {t("尚未建立暱稱別名；請到「個人設置 → 匿名（別名）」建立後即可使用。")}
          </p>
        )}
        {!interactive && !tokenAlias && (
          <p className="compose-hint compose-from-hint">{t("隱身代號尚未產生；請重新登入或聯絡管理者。")}</p>
        )}

        <div className="compose-row">
          <label htmlFor="compose-to">{t("收件者")}</label>
          <input
            id="compose-to"
            value={to}
            onChange={(e) => {
              touch();
              setTo(e.target.value);
            }}
            placeholder={t("以逗號分隔多個地址")}
            autoComplete="off"
          />
          <span className="compose-cc-toggle">
            {!showCc && (
              <button type="button" onClick={() => setShowCc(true)}>
                {t("副本")}
              </button>
            )}
            {!showBcc && (
              <button type="button" onClick={() => setShowBcc(true)}>
                {t("密件副本")}
              </button>
            )}
          </span>
        </div>

        {showCc && (
          <div className="compose-row">
            <label htmlFor="compose-cc">{t("副本")}</label>
            <input
              id="compose-cc"
              value={cc}
              onChange={(e) => {
                touch();
                setCc(e.target.value);
              }}
              autoComplete="off"
            />
          </div>
        )}
        {showBcc && (
          <div className="compose-row">
            <label htmlFor="compose-bcc">{t("密件副本")}</label>
            <input
              id="compose-bcc"
              value={bcc}
              onChange={(e) => {
                touch();
                setBcc(e.target.value);
              }}
              autoComplete="off"
            />
          </div>
        )}

        <div className="compose-row">
          <label htmlFor="compose-subject">{t("主旨")}</label>
          <input
            id="compose-subject"
            value={subject}
            onChange={(e) => {
              touch();
              setSubject(e.target.value);
            }}
          />
        </div>

        {interactive ? (
          <>
            <div className="compose-row compose-stack-row">
              <label htmlFor="compose-form-description">{t("表單說明")}</label>
              <textarea
                id="compose-form-description"
                className="form-control"
                value={formDescription}
                onChange={(e) => {
                  touch();
                  setFormDescription(e.target.value);
                }}
                rows={2}
                maxLength={2000}
                placeholder={t("選填；會顯示在表單上方（純文字）")}
              />
            </div>
            <div className="compose-form-schema">
              <label htmlFor="compose-form-schema">{t("表單欄位（JSON Schema）")}</label>
              <textarea
                id="compose-form-schema"
                className="schema-editor"
                value={schemaText}
                onChange={(e) => {
                  touch();
                  setSchemaText(e.target.value);
                }}
                rows={12}
                spellCheck={false}
                aria-label={t("表單 schema")}
              />
              <p className="compose-hint">
                {t("僅支援基本型別、enum、format: date；禁止 $ref／anyOf／oneOf／allOf／patternProperties／dependencies。")}
                {t("收件人僅限 @atwho.org 內部地址。")}
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="compose-toolbar">
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => exec("bold")} title={t("粗體")}>
                <strong>B</strong>
              </button>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => exec("italic")} title={t("斜體")}>
                <em>I</em>
              </button>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => exec("underline")} title={t("底線")}>
                <u>U</u>
              </button>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => exec("insertUnorderedList")}
                title={t("項目符號")}
              >
                •≡
              </button>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={addLink} title={t("插入連結")}>
                🔗
              </button>
              <span className="toolbar-spacer" />
              <button type="button" onClick={() => fileRef.current?.click()} title={t("加入附件")}>
                <IconPaperclip size={16} />
              </button>
            </div>

            <div
              className="compose-editor"
              ref={editorRef}
              contentEditable
              suppressContentEditableWarning
              role="textbox"
              aria-multiline="true"
              aria-label={t("信件內容")}
              onInput={touch}
            />

            {attachments.length > 0 && (
              <ul className="compose-attachments">
                {attachments.map((a, i) => (
                  <li key={`${a.filename}-${i}`}>
                    <IconFile size={15} />
                    <span className="att-name">{a.filename}</span>
                    <span className="att-size">{formatBytes(a.size)}</span>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                      aria-label={t("移除 {filename}", { filename: a.filename })}
                    >
                      <IconClose size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {error && <p className="compose-error">{error}</p>}

        <div className="compose-footer">
          <button type="submit" className="btn-primary" disabled={sending}>
            <IconSend size={16} />
            {sending ? (interactive ? t("送出中…") : t("傳送中…")) : interactive ? t("送出表單") : t("傳送")}
          </button>
          <span className="compose-hint">
            {interactive
              ? t("互動式表單僅在 atwho.org 內部流動（不繞外網、不支援附件）")
              : t("附件單檔 ≤ 3.5 MiB（含內文總計 ≤ 5 MiB）")}
          </span>
        </div>

        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </form>
    </div>
  );
}
