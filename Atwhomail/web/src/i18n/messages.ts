/** 翻譯字典集合；各語言檔案由 `en.ts` 的同一組 key 產生。 */
import type { Language } from "./types";
import { EN_MESSAGES } from "./en";
import { ES_MESSAGES } from "./es";
import { DE_MESSAGES } from "./de";
import { JA_MESSAGES } from "./ja";
import { FR_MESSAGES } from "./fr";
import { PT_MESSAGES } from "./pt";
import { RU_MESSAGES } from "./ru";
import { IT_MESSAGES } from "./it";
import { ZH_CN_MESSAGES } from "./zh-CN";

export const MESSAGES: Partial<Record<Language, Record<string, string>>> = {
  en: EN_MESSAGES,
  es: ES_MESSAGES,
  de: DE_MESSAGES,
  ja: JA_MESSAGES,
  fr: FR_MESSAGES,
  pt: PT_MESSAGES,
  ru: RU_MESSAGES,
  it: IT_MESSAGES,
  "zh-CN": ZH_CN_MESSAGES,
};
