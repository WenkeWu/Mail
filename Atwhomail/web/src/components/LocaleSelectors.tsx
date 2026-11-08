/**
 * 國家／語言選擇器（D32）。
 * 顯示名稱依目前語言由 `Intl.DisplayNames` 產生；
 * 國家選單**只列該語言為第一語言的國家**，並依名稱排序。
 */
import { useMemo } from "react";
import {
  countriesForLanguage,
  LANGUAGES,
  useI18n,
  type Language,
} from "../i18n";

export function LocaleSelectors({ className = "" }: { className?: string }) {
  const { language, country, setLanguage, setCountry, t } = useI18n();

  const countries = useMemo(() => {
    let display: Intl.DisplayNames | null = null;
    try {
      display = new Intl.DisplayNames([language], { type: "region" });
    } catch {
      display = null;
    }
    return [...countriesForLanguage(language)]
      .map((code) => ({ code, name: display?.of(code) ?? code }))
      .sort((a, b) => a.name.localeCompare(b.name, language));
  }, [language]);

  return (
    <div className={`locale-selectors ${className}`.trim()}>
      <label htmlFor="locale-country">
        <span>{t("國家")}</span>
        <select
          id="locale-country"
          value={country}
          onChange={(e) => setCountry(e.target.value)}
          aria-label={t("國家")}
        >
          {country === "" && (
            <option value="" disabled>
              {t("請選擇")}
            </option>
          )}
          {countries.map((item) => (
            <option key={item.code} value={item.code}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      <label htmlFor="locale-language">
        <span>{t("語言")}</span>
        <select
          id="locale-language"
          value={language}
          onChange={(e) => setLanguage(e.target.value as Language)}
          aria-label={t("語言")}
        >
          {LANGUAGES.map((item) => (
            <option key={item.code} value={item.code}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
