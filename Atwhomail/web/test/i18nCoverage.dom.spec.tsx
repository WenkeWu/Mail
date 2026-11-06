/**
 * i18nCoverage.dom.spec.tsx — D32：10 種語言的字典完整性。
 *
 * key 一律是 `en.ts` 的繁中原文；每個語言都必須有相同的 key、相同的
 * `{placeholder}` 集合，且沒有空字串。`zh-TW` 直接用 key，不需字典。
 */
import { describe, expect, it } from "vitest";
import { LANGUAGES } from "../src/i18n";
import { EN_MESSAGES } from "../src/i18n/en";
import { MESSAGES } from "../src/i18n/messages";

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]!).sort();
}

describe("D32：10 種語言字典完整", () => {
  const enKeys = Object.keys(EN_MESSAGES);

  it("每個語言都有與英文相同的 key、placeholder，且沒有空字串", () => {
    for (const { code } of LANGUAGES) {
      if (code === "zh-TW") continue; // 繁中直接用 key
      const dict = MESSAGES[code];
      expect(dict, code).toBeDefined();
      expect(Object.keys(dict!), code).toEqual(enKeys);
      for (const key of enKeys) {
        const value = dict![key];
        expect(value, `${code}: ${key}`).toBeTruthy();
        expect(placeholders(value!), `${code}: ${key}`).toEqual(placeholders(EN_MESSAGES[key]!));
      }
    }
  });
});
