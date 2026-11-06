# 32 — D32：全站語系與區域設定（i18n）

> 建立：2026-11-06｜狀態：**已上線（2026-11-06）**——API `11dd0a3e`、Pages `9873d79f`（`app.atwho.org`）、commit `bfb5fd3`
> 需求（owner）：登入頁加入**國家**與**語言**選擇；預設值依業界作法。
> 後續定案（2026-11-06）：支援 **10 種語言**、只列這些語言的**主要國家**；
> **時區優先，時區判斷不到才用 IP 國別**；多官方語言國家一律用**該國第一語言**；
> 全站（含管理頁）10 種語言。

## 1. 支援的語言

| 語言 | locale |
|---|---|
| English | `en` |
| Spanish | `es` |
| German | `de` |
| Japanese | `ja` |
| French | `fr` |
| Portuguese | `pt` |
| Russian | `ru` |
| Italian | `it` |
| 簡體中文（大陸）| `zh-CN` |
| 繁體中文（台、港、澳）| `zh-TW` |

## 2. 國家範圍

- 國家選單**只列**上述語言的**主要國家**（`web/src/i18n/countries.ts` 的 `COUNTRY_LANGUAGE`）。
- 不屬於這 10 種語系的國家目前**不列入**。
- 多官方語言國家依該國第一語言：
  - 加拿大 → English；瑞士 → German；新加坡 → English；香港／澳門 → 繁體中文。
  - 比利時（第一語言荷蘭語）、盧森堡（盧森堡語）、印度（印地語）、菲律賓（菲律賓語）等
    第一語言不在支援清單 → 暫不列入。

## 3. 預設判斷順序

1. **使用者已手動選擇**（`localStorage`）→ 直接使用，不再自動判斷。
2. **瀏覽器時區** → 對照國家（`TIMEZONE_COUNTRY`）。
3. 時區**判斷不到**（或對應到不在支援清單的國家）→ 呼叫 **`GET /api/geo`**：
   - API Worker 讀 Cloudflare **`CF-IPCountry`**。
   - `XX`（未知）、`T1`（Tor）、格式錯誤 → `null`。
   - 回應 `Cache-Control: no-store`（不可快取）。
4. 國家確定後 → 使用該國的**第一語言**（`COUNTRY_LANGUAGE`）。
5. 都無法判斷 → 語言 **English**；國家選單顯示「請選擇」placeholder。

- 自動判斷的結果**不會寫入** localStorage；只有使用者手動選擇才會保存。
- 使用者若從未手動選語言，切換國家時會跟著該國第一語言；手動選過語言則保持不變。
- 國家只影響區域格式（日期／數字）；手動選語言後兩者各自獨立。

## 4. 區域格式

- 繁中：`zh-Hant-<country>`（保留繁體）；簡中：`zh-Hans-<country>`（保留簡體）。
- 其他：`<language>-<country>`（例：`en-TW`、`es-MX`、`ja-JP`）。
- 不支援的組合退回語言本身。
- 套用：`lib/format.ts`（信件時間／完整日期）、`lib/invites.ts`（到期時間）、
  地址／訪客／App Clients 的日期顯示。

## 5. IP 國別端點

```http
GET /api/geo
→ 200 { "country": "TW" }   // 讀 CF-IPCountry
→ 200 { "country": null }   // 無標頭／XX／T1／格式錯誤
Cache-Control: no-store
```

- 公開、唯讀、不需登入；**只作為 UI 預設，不做任何權限判斷**。
- 隱私：只取國別代碼，不記錄 IP、不送第三方。
- 本機開發沒有 `CF-IPCountry` → 自動回退時區／English。

## 6. 實作

| 檔案 | 用途 |
|---|---|
| `web/src/i18n/index.tsx` | `I18nProvider`／`useI18n()`／偵測／格式 locale／`translate()` |
| `web/src/i18n/types.ts` | `Language`（10 種） |
| `web/src/i18n/countries.ts` | 國家→第一語言、時區→國家 |
| `web/src/i18n/messages.ts` | 各語言字典集合 |
| `web/src/i18n/en.ts`…`zh-CN.ts` | 各語言字典（key = 繁中原文，支援 `{name}` 插值） |
| `web/src/components/LocaleSelectors.tsx` | 國家／語言下拉選單（登入頁＋個人設置） |
| `packages/api/src/index.ts` | `GET /api/geo`（CF-IPCountry） |

## 7. 測試

- `web/test/i18n.dom.spec.tsx`：10 種語言、國家清單、第一語言對應、區域格式、預設順序。
- `web/test/localeSelectors.dom.spec.tsx`：切換語言／國家、IP 國別回退、偏好持久化。
- `web/test/i18nCoverage.dom.spec.tsx`：8 份字典與 `en.ts` 的 key 完全一致、placeholder 相同、無空值。
- `packages/api/test/geo.spec.ts`：`CF-IPCountry`、`XX`／`T1`／格式錯誤、`no-store`。

## 8. 已知限制

- **伺服器 API 回傳的錯誤訊息仍為繁中**（後端尚未 i18n）；靜態 UI 與日期格式已多語。
- 10 份字典目前**靜態打包**進主 bundle（build 首屏約 829 kB／gzip 254 kB，較多語前增加）；
  若需縮小首屏，可再改為「只載入目前語言」的動態 chunk（本次未做，避免影響同步 `t()` 介面）。
- 國家清單是「主要國家」curated list，不是 249 國全列；可依需求擴充。
- IP 國別可能受 VPN／公司代理／行動網路影響；使用者永遠可以手動改選。
- 自動判斷結果不寫入 localStorage；重新整理後會重新依時區／IP 判斷（手動選擇才會保存）。
