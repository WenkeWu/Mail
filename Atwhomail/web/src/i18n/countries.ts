/**
 * 支援的國家與主要語言（D32，owner 2026-11-06 定案）
 *
 * 原則：
 * - 只列「第一語言」在上述 10 種語言的**主要國家**；其他國家暫不列入。
 * - 多官方語言國家一律依該國第一語言（例：瑞士→德語、加拿大→英語、新加坡→英語）。
 * - 國家選單**依目前語言過濾**：只顯示該語言為第一語言的國家
 *   （例：繁體中文→台／港／澳；簡體中文→中國；日語→日本）。
 */
import type { Language } from "./types";

export const COUNTRY_LANGUAGE: Record<string, Language> = {
  // English（第一語言為英語的主要國家）
  US: "en",
  GB: "en",
  CA: "en",
  AU: "en",
  NZ: "en",
  IE: "en",
  SG: "en",

  // Spanish
  ES: "es",
  MX: "es",
  AR: "es",
  CO: "es",
  CL: "es",
  PE: "es",
  VE: "es",
  EC: "es",
  GT: "es",
  CU: "es",
  BO: "es",
  DO: "es",
  HN: "es",
  PY: "es",
  SV: "es",
  NI: "es",
  CR: "es",
  PA: "es",
  UY: "es",
  PR: "es",
  GQ: "es",

  // German（瑞士以德語為第一語言）
  DE: "de",
  AT: "de",
  CH: "de",
  LI: "de",

  // Japanese
  JP: "ja",

  // French（法語為主要官方語言的國家）
  FR: "fr",
  MC: "fr",
  SN: "fr",
  CI: "fr",
  CM: "fr",
  BF: "fr",
  ML: "fr",
  NE: "fr",
  CF: "fr",
  CG: "fr",
  CD: "fr",
  GA: "fr",

  // Portuguese
  PT: "pt",
  BR: "pt",
  AO: "pt",
  MZ: "pt",
  CV: "pt",
  GW: "pt",
  ST: "pt",

  // Russian（俄語為主要官方語言的國家）
  RU: "ru",
  BY: "ru",

  // Italian
  IT: "it",
  SM: "it",
  VA: "it",

  // 簡體中文（大陸）
  CN: "zh-CN",

  // 繁體中文（台、港、澳）
  TW: "zh-TW",
  HK: "zh-TW",
  MO: "zh-TW",
};

export const COUNTRY_CODES_LIST: readonly string[] = Object.keys(COUNTRY_LANGUAGE);

/** 該國家的第一語言；不在支援清單 → null */
export function languageForCountry(country: string): Language | null {
  return Object.prototype.hasOwnProperty.call(COUNTRY_LANGUAGE, country)
    ? COUNTRY_LANGUAGE[country]!
    : null;
}

/** 以該語言為第一語言的國家（依 COUNTRY_LANGUAGE 宣告順序） */
export function countriesForLanguage(language: Language): readonly string[] {
  return COUNTRY_CODES_LIST.filter((code) => COUNTRY_LANGUAGE[code] === language);
}

/**
 * 時區 → 國家（只列支援的國家）。
 * 時區無法對應／不在支援清單 → null，前端才會改用 IP 國別。
 */
export const TIMEZONE_COUNTRY: Record<string, string> = {
  // ── English ──
  // US
  "America/New_York": "US",
  "America/Detroit": "US",
  "America/Kentucky/Louisville": "US",
  "America/Kentucky/Monticello": "US",
  "America/Indiana/Indianapolis": "US",
  "America/Indiana/Knox": "US",
  "America/Indiana/Marengo": "US",
  "America/Indiana/Petersburg": "US",
  "America/Indiana/Tell_City": "US",
  "America/Indiana/Vevay": "US",
  "America/Indiana/Vincennes": "US",
  "America/Indiana/Winamac": "US",
  "America/Chicago": "US",
  "America/Denver": "US",
  "America/Boise": "US",
  "America/Phoenix": "US",
  "America/Los_Angeles": "US",
  "America/Anchorage": "US",
  "America/Juneau": "US",
  "America/Sitka": "US",
  "America/Metlakatla": "US",
  "America/Yakutat": "US",
  "America/Nome": "US",
  "America/Adak": "US",
  "Pacific/Honolulu": "US",
  "America/North_Dakota/Center": "US",
  "America/North_Dakota/New_Salem": "US",
  "America/Menominee": "US",
  // Canada
  "America/Toronto": "CA",
  "America/Montreal": "CA",
  "America/Vancouver": "CA",
  "America/Edmonton": "CA",
  "America/Winnipeg": "CA",
  "America/Halifax": "CA",
  "America/St_Johns": "CA",
  "America/Regina": "CA",
  "America/Whitehorse": "CA",
  "America/Yellowknife": "CA",
  "America/Iqaluit": "CA",
  "America/Moncton": "CA",
  "America/Glace_Bay": "CA",
  "America/Goose_Bay": "CA",
  "America/Thunder_Bay": "CA",
  "America/Nipigon": "CA",
  "America/Rainy_River": "CA",
  "America/Rankin_Inlet": "CA",
  "America/Cambridge_Bay": "CA",
  "America/Inuvik": "CA",
  "America/Dawson": "CA",
  "America/Dawson_Creek": "CA",
  "America/Fort_Nelson": "CA",
  "America/Creston": "CA",
  "America/Atikokan": "CA",
  "America/Blanc-Sablon": "CA",
  // UK / Ireland / Singapore
  "Europe/London": "GB",
  "Europe/Dublin": "IE",
  "Asia/Singapore": "SG",
  // Australia
  "Australia/Sydney": "AU",
  "Australia/Melbourne": "AU",
  "Australia/Brisbane": "AU",
  "Australia/Perth": "AU",
  "Australia/Adelaide": "AU",
  "Australia/Hobart": "AU",
  "Australia/Darwin": "AU",
  "Australia/Lord_Howe": "AU",
  "Australia/Eucla": "AU",
  "Australia/Broken_Hill": "AU",
  // New Zealand
  "Pacific/Auckland": "NZ",
  "Pacific/Chatham": "NZ",

  // ── Spanish ──
  "Europe/Madrid": "ES",
  "Atlantic/Canary": "ES",
  "Africa/Ceuta": "ES",
  "America/Mexico_City": "MX",
  "America/Cancun": "MX",
  "America/Merida": "MX",
  "America/Monterrey": "MX",
  "America/Matamoros": "MX",
  "America/Mazatlan": "MX",
  "America/Chihuahua": "MX",
  "America/Ojinaga": "MX",
  "America/Hermosillo": "MX",
  "America/Tijuana": "MX",
  "America/Bahia_Banderas": "MX",
  "America/Argentina/Buenos_Aires": "AR",
  "America/Argentina/Cordoba": "AR",
  "America/Argentina/Mendoza": "AR",
  "America/Argentina/Salta": "AR",
  "America/Argentina/Tucuman": "AR",
  "America/Argentina/Ushuaia": "AR",
  "America/Argentina/La_Rioja": "AR",
  "America/Argentina/Rio_Gallegos": "AR",
  "America/Argentina/San_Juan": "AR",
  "America/Argentina/San_Luis": "AR",
  "America/Argentina/Catamarca": "AR",
  "America/Argentina/Jujuy": "AR",
  "America/Bogota": "CO",
  "America/Santiago": "CL",
  "Pacific/Easter": "CL",
  "America/Lima": "PE",
  "America/Caracas": "VE",
  "America/Guayaquil": "EC",
  "Pacific/Galapagos": "EC",
  "America/Guatemala": "GT",
  "America/Havana": "CU",
  "America/La_Paz": "BO",
  "America/Santo_Domingo": "DO",
  "America/Tegucigalpa": "HN",
  "America/Asuncion": "PY",
  "America/El_Salvador": "SV",
  "America/Managua": "NI",
  "America/Costa_Rica": "CR",
  "America/Panama": "PA",
  "America/Montevideo": "UY",
  "America/Puerto_Rico": "PR",
  "Africa/Malabo": "GQ",

  // ── German ──
  "Europe/Berlin": "DE",
  "Europe/Busingen": "DE",
  "Europe/Vienna": "AT",
  "Europe/Zurich": "CH",
  "Europe/Vaduz": "LI",

  // ── Japanese ──
  "Asia/Tokyo": "JP",

  // ── French ──
  "Europe/Paris": "FR",
  "Europe/Monaco": "MC",
  "Africa/Dakar": "SN",
  "Africa/Abidjan": "CI",
  "Africa/Douala": "CM",
  "Africa/Ouagadougou": "BF",
  "Africa/Bamako": "ML",
  "Africa/Niamey": "NE",
  "Africa/Ndjamena": "TD",
  "Africa/Bangui": "CF",
  "Africa/Brazzaville": "CG",
  "Africa/Kinshasa": "CD",
  "Africa/Lubumbashi": "CD",
  "Africa/Libreville": "GA",
  "Indian/Antananarivo": "MG",
  "Africa/Djibouti": "DJ",
  "Indian/Comoro": "KM",
  "America/Port-au-Prince": "HT",

  // ── Portuguese ──
  "Europe/Lisbon": "PT",
  "Atlantic/Madeira": "PT",
  "Atlantic/Azores": "PT",
  "America/Sao_Paulo": "BR",
  "America/Bahia": "BR",
  "America/Fortaleza": "BR",
  "America/Recife": "BR",
  "America/Manaus": "BR",
  "America/Belem": "BR",
  "America/Cuiaba": "BR",
  "America/Campo_Grande": "BR",
  "America/Porto_Velho": "BR",
  "America/Rio_Branco": "BR",
  "America/Noronha": "BR",
  "America/Araguaina": "BR",
  "America/Maceio": "BR",
  "America/Santarem": "BR",
  "America/Boa_Vista": "BR",
  "Africa/Luanda": "AO",
  "Africa/Maputo": "MZ",
  "Atlantic/Cape_Verde": "CV",
  "Africa/Bissau": "GW",
  "Africa/Sao_Tome": "ST",
  "Asia/Dili": "TL",

  // ── Russian ──
  "Europe/Moscow": "RU",
  "Europe/Kaliningrad": "RU",
  "Europe/Samara": "RU",
  "Europe/Volgograd": "RU",
  "Europe/Saratov": "RU",
  "Europe/Astrakhan": "RU",
  "Europe/Ulyanovsk": "RU",
  "Europe/Kirov": "RU",
  "Asia/Yekaterinburg": "RU",
  "Asia/Omsk": "RU",
  "Asia/Novosibirsk": "RU",
  "Asia/Barnaul": "RU",
  "Asia/Tomsk": "RU",
  "Asia/Novokuznetsk": "RU",
  "Asia/Krasnoyarsk": "RU",
  "Asia/Irkutsk": "RU",
  "Asia/Chita": "RU",
  "Asia/Yakutsk": "RU",
  "Asia/Khandyga": "RU",
  "Asia/Vladivostok": "RU",
  "Asia/Ust-Nera": "RU",
  "Asia/Magadan": "RU",
  "Asia/Sakhalin": "RU",
  "Asia/Srednekolymsk": "RU",
  "Asia/Kamchatka": "RU",
  "Asia/Anadyr": "RU",
  "Europe/Minsk": "BY",
  "Asia/Almaty": "KZ",
  "Asia/Aqtobe": "KZ",
  "Asia/Atyrau": "KZ",
  "Asia/Qostanay": "KZ",
  "Asia/Qyzylorda": "KZ",
  "Asia/Aqtau": "KZ",
  "Asia/Bishkek": "KG",
  "Asia/Dushanbe": "TJ",
  "Asia/Tashkent": "UZ",
  "Asia/Samarkand": "UZ",

  // ── Italian ──
  "Europe/Rome": "IT",
  "Europe/San_Marino": "SM",
  "Europe/Vatican": "VA",

  // ── Simplified Chinese ──
  "Asia/Shanghai": "CN",
  "Asia/Chongqing": "CN",
  "Asia/Harbin": "CN",
  "Asia/Urumqi": "CN",
  "Asia/Kashgar": "CN",

  // ── Traditional Chinese ──
  "Asia/Taipei": "TW",
  "Asia/Hong_Kong": "HK",
  "Asia/Macau": "MO",
};
