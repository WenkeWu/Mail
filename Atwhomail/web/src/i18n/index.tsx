/**
 * i18n — AtWhoMail 全站語系與區域設定（D32）
 *
 * 支援 10 種語言、只列這些語言的**主要國家**（見 countries.ts）。
 *
 * 預設值：
 * 1. 使用者曾手動選擇 → localStorage 優先
 * 2. 國家：瀏覽器**時區** → 國家；時區判斷不到（或不在支援清單）才呼叫 `/api/geo`
 *    讀 Cloudflare `CF-IPCountry`
 * 3. 語言：該國家的**第一語言**；沒有對應 → English
 * 4. 國家仍判斷不到 → 英文；國家選單顯示「請選擇」placeholder
 *
 * 國家只影響「區域格式」（日期／數字）與首次預設語言；
 * 使用者手動選了語言之後，兩者各自獨立。
 *
 * 翻譯 key 直接使用**繁體中文原文**：zh-TW 原樣回傳，其他語言由 `messages.ts` 對照。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getGeo } from "../api/endpoints";
import {
  COUNTRY_LANGUAGE,
  TIMEZONE_COUNTRY,
  languageForCountry,
} from "./countries";
import { EN_MESSAGES } from "./en";
import { MESSAGES } from "./messages";
import type { Language } from "./types";

export type { Language } from "./types";
export { COUNTRY_CODES_LIST, languageForCountry } from "./countries";

export type TranslationVars = Record<string, string | number>;

export const LANGUAGE_STORAGE_KEY = "atwhomail.language";
export const COUNTRY_STORAGE_KEY = "atwhomail.country";

/** 語言選單用「該語言自己的名字」，不隨介面語言翻譯 */
export const LANGUAGES: Array<{ code: Language; label: string }> = [
  { code: "en", label: "English" },
  { code: "es", label: "Español" },
  { code: "de", label: "Deutsch" },
  { code: "ja", label: "日本語" },
  { code: "fr", label: "Français" },
  { code: "pt", label: "Português" },
  { code: "ru", label: "Русский" },
  { code: "it", label: "Italiano" },
  { code: "zh-CN", label: "简体中文" },
  { code: "zh-TW", label: "繁體中文" },
];

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export function isSupportedLanguage(value: string | null): value is Language {
  return LANGUAGES.some((item) => item.code === value);
}

export function isSupportedCountry(value: string | null): value is string {
  return (
    value !== null && Object.prototype.hasOwnProperty.call(COUNTRY_LANGUAGE, value)
  );
}

/** 瀏覽器時區 → 支援的國家；無法對應／不在支援清單 → null */
export function timezoneCountry(): string | null {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const mapped = TIMEZONE_COUNTRY[timeZone];
    return isSupportedCountry(mapped) ? mapped : null;
  } catch {
    return null;
  }
}

/**
 * 同步偵測國家：已存偏好 → 時區 → ""。
 * IP 國別是非同步，由 `I18nProvider` 在時區判斷不到時才呼叫 `/api/geo`。
 */
export function detectCountry(): string {
  const saved = safeGet(COUNTRY_STORAGE_KEY);
  if (isSupportedCountry(saved)) return saved;
  return timezoneCountry() ?? "";
}

/** 語言：已存偏好 → 該國第一語言 → English */
export function detectLanguage(country: string): Language {
  const saved = safeGet(LANGUAGE_STORAGE_KEY);
  if (isSupportedLanguage(saved)) return saved;
  return languageForCountry(country) ?? "en";
}

/** 語言基底：繁中保留 Hant、簡中保留 Hans，不因國家改變字體 */
function languageBase(language: Language): string {
  if (language === "zh-TW") return "zh-Hant";
  if (language === "zh-CN") return "zh-Hans";
  return language;
}

/** 區域格式 locale：語言基底 + 國家（例：en-TW／zh-Hant-US／zh-Hans-CN） */
export function formatLocaleFor(language: Language, country: string): string {
  if (!isSupportedCountry(country)) return language;
  const candidate = `${languageBase(language)}-${country}`;
  try {
    new Intl.DateTimeFormat(candidate);
    return candidate;
  } catch {
    return language;
  }
}

// ── 全域目前語系（給不經 React context 的純函式使用） ──
let runtimeLanguage: Language = "zh-TW";
let runtimeFormatLocale = "zh-TW";

export function setRuntimeLocale(language: Language, country: string): void {
  runtimeLanguage = language;
  runtimeFormatLocale = formatLocaleFor(language, country);
}

export function getLanguage(): Language {
  return runtimeLanguage;
}

export function getFormatLocale(): string {
  return runtimeFormatLocale;
}

/** 翻譯；`key` 是繁體中文原文（zh-TW 原樣回傳） */
export function translate(language: Language, key: string, vars?: TranslationVars): string {
  let text = MESSAGES[language]?.[key];
  if (text === undefined) {
    text = language === "zh-TW" || language === "zh-CN" ? key : (EN_MESSAGES[key] ?? key);
  }
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}

/** 給純函式（format.ts／statusSemantics.ts…）使用的翻譯 */
export function tGlobal(key: string, vars?: TranslationVars): string {
  return translate(runtimeLanguage, key, vars);
}

export interface I18nValue {
  language: Language;
  country: string;
  locale: string;
  setLanguage: (language: Language) => void;
  setCountry: (country: string) => void;
  t: (key: string, vars?: TranslationVars) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

const fallbackValue: I18nValue = {
  language: "zh-TW",
  country: "TW",
  locale: "zh-Hant-TW",
  setLanguage: () => {},
  setCountry: () => {},
  t: (key, vars) => translate("zh-TW", key, vars),
  formatNumber: (value, options) => new Intl.NumberFormat("zh-Hant-TW", options).format(value),
};

export function I18nProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState(() => {
    const country = detectCountry();
    return { country, language: detectLanguage(country) };
  });
  /**
   * 只有「時區無法對應到支援的國家」時才需要 IP 國別。
   * 時區優先（owner 2026-11-06 定案）；IP 只在時區判斷不到時使用。
   */
  const [geoPending, setGeoPending] = useState(() => prefs.country === "");

  // 讓純函式（format.ts／statusSemantics.ts）在第一次 render 就拿到正確語系
  setRuntimeLocale(prefs.language, prefs.country);

  const setLanguage = useCallback((next: Language) => {
    if (!isSupportedLanguage(next)) return;
    safeSet(LANGUAGE_STORAGE_KEY, next);
    setPrefs((prev) => ({ ...prev, language: next }));
  }, []);

  const setCountry = useCallback((next: string) => {
    if (!isSupportedCountry(next)) return;
    safeSet(COUNTRY_STORAGE_KEY, next);
    setPrefs((prev) => {
      // 使用者若從未手動選語言，換國家時跟著該國第一語言；手動選過則保持不變
      const savedLang = safeGet(LANGUAGE_STORAGE_KEY);
      return {
        country: next,
        language: isSupportedLanguage(savedLang)
          ? prev.language
          : (languageForCountry(next) ?? prev.language),
      };
    });
  }, []);

  // 時區判斷不到 → 以 Cloudflare CF-IPCountry 補救（不覆蓋手動選擇）
  useEffect(() => {
    if (!geoPending) return;
    let alive = true;
    getGeo()
      .then((res) => {
        if (!alive) return;
        const ipCountry = res.country;
        if (!isSupportedCountry(ipCountry)) return;
        // 等待期間使用者已手動選國家 → 不覆蓋
        if (isSupportedCountry(safeGet(COUNTRY_STORAGE_KEY))) return;
        setPrefs((prev) => {
          const savedLang = safeGet(LANGUAGE_STORAGE_KEY);
          return {
            country: ipCountry,
            language: isSupportedLanguage(savedLang)
              ? prev.language
              : (languageForCountry(ipCountry) ?? "en"),
          };
        });
      })
      .catch(() => {
        /* 取不到就維持英文／placeholder */
      })
      .finally(() => {
        if (alive) setGeoPending(false);
      });
    return () => {
      alive = false;
    };
  }, [geoPending]);

  const locale = useMemo(() => formatLocaleFor(prefs.language, prefs.country), [prefs]);
  const t = useCallback(
    (key: string, vars?: TranslationVars) => translate(prefs.language, key, vars),
    [prefs.language]
  );
  const formatNumber = useCallback(
    (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(locale, options).format(value),
    [locale]
  );

  useEffect(() => {
    setRuntimeLocale(prefs.language, prefs.country);
    document.documentElement.lang = prefs.language;
    document.documentElement.dataset.country = prefs.country;
  }, [prefs]);

  const value = useMemo<I18nValue>(
    () => ({
      language: prefs.language,
      country: prefs.country,
      locale,
      setLanguage,
      setCountry,
      t,
      formatNumber,
    }),
    [prefs, locale, setLanguage, setCountry, t, formatNumber]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** 元件內使用；不在 Provider 內時回退繁中（方便既有元件測試） */
export function useI18n(): I18nValue {
  return useContext(I18nContext) ?? fallbackValue;
}
