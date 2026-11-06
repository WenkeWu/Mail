/**
 * i18n.dom.spec.tsx — D32 語系／區域設定的純函式測試。
 *
 * 支援 10 種語言；國家清單只包含這些語言的「主要國家」。
 * 預設：時區 → 國家；時區判斷不到才由 Provider 呼叫 `/api/geo`；語言＝該國第一語言。
 */
import { describe, expect, it } from "vitest";
import {
  COUNTRY_CODES_LIST,
  LANGUAGE_STORAGE_KEY,
  COUNTRY_STORAGE_KEY,
  detectCountry,
  detectLanguage,
  formatLocaleFor,
  isSupportedCountry,
  isSupportedLanguage,
  languageForCountry,
  translate,
} from "../src/i18n";

describe("D32：語言與國家預設", () => {
  it("支援 10 種語言", () => {
    for (const code of ["en", "es", "de", "ja", "fr", "pt", "ru", "it", "zh-CN", "zh-TW"]) {
      expect(isSupportedLanguage(code), code).toBe(true);
    }
    expect(isSupportedLanguage("ko")).toBe(false);
    expect(isSupportedLanguage(null)).toBe(false);
  });

  it("國家清單只含 10 種語系的主要國家", () => {
    for (const code of ["TW", "HK", "MO", "CN", "US", "GB", "CA", "AU", "JP", "ES", "MX", "DE", "FR", "BR", "PT", "RU", "IT"]) {
      expect(COUNTRY_CODES_LIST, code).toContain(code);
    }
    // 第一語言不是這 10 種（例：泰語）→ 不列入
    expect(isSupportedCountry("TH")).toBe(false);
    expect(isSupportedCountry("ZZ")).toBe(false);
  });

  it("國家第一語言對應", () => {
    expect(languageForCountry("TW")).toBe("zh-TW");
    expect(languageForCountry("HK")).toBe("zh-TW");
    expect(languageForCountry("MO")).toBe("zh-TW");
    expect(languageForCountry("CN")).toBe("zh-CN");
    expect(languageForCountry("US")).toBe("en");
    expect(languageForCountry("JP")).toBe("ja");
    expect(languageForCountry("ES")).toBe("es");
    expect(languageForCountry("DE")).toBe("de");
    expect(languageForCountry("FR")).toBe("fr");
    expect(languageForCountry("BR")).toBe("pt");
    expect(languageForCountry("RU")).toBe("ru");
    expect(languageForCountry("IT")).toBe("it");
    expect(languageForCountry("TH")).toBeNull();
  });

  it("區域格式使用語言＋國家（繁中／簡中保留字體）", () => {
    expect(formatLocaleFor("en", "TW")).toBe("en-TW");
    expect(formatLocaleFor("zh-TW", "US")).toBe("zh-Hant-US");
    expect(formatLocaleFor("zh-CN", "CN")).toBe("zh-Hans-CN");
    expect(formatLocaleFor("ja", "JP")).toBe("ja-JP");
    expect(formatLocaleFor("en", "ZZ")).toBe("en");
  });

  it("已存偏好優先於時區", () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "en");
    localStorage.setItem(COUNTRY_STORAGE_KEY, "US");
    expect(detectCountry()).toBe("US");
    expect(detectLanguage("US")).toBe("en");
  });

  it("沒有已存偏好時：國家由時區（或空）決定；語言用該國第一語言、最後回退英文", () => {
    localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    localStorage.removeItem(COUNTRY_STORAGE_KEY);
    expect(detectLanguage("US")).toBe("en");
    expect(detectLanguage("JP")).toBe("ja");
    expect(detectLanguage("")).toBe("en");
    // 時區能對應到支援國家就用它；否則為空（Provider 才會呼叫 IP）
    const detected = detectCountry();
    expect(detected === "" || isSupportedCountry(detected)).toBe(true);
  });

  it("翻譯以繁中原文為 key；英文有對照、變數可插值、缺翻譯安全回退", () => {
    expect(translate("zh-TW", "收件匣")).toBe("收件匣");
    expect(translate("en", "收件匣")).toBe("Inbox");
    expect(translate("en", "已建立 {email}", { email: "a@b.c" })).toBe("Created a@b.c");
    expect(translate("en", "未翻譯的字串")).toBe("未翻譯的字串");
  });
});
