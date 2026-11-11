# 31 — 交接文件（HANDOFF）｜2026-11-05 收尾

> 用途：**開新對話**時，先讀這一份就能無縫接手（不必重讀長對話）。
> 專案：`D:\Mail`（git root）／程式 `D:\Mail\Atwhomail`｜PUBLIC repo `WenKeWu/Mail`

---

## 1. 現在是什麼狀態（全部已上線 ✅）

| 代號 | 功能 | 狀態 | 文件 |
|---|---|---|---|
| D20 | 註冊／配發 ID **撞二級網域偵測**（DoH、fail-open、快取、建議名稱、效能優化）| ✅ 上線 | docs/20 |
| D21 | 註冊改 **Email 6 位數驗證碼**（取消邀請碼；`REGISTRATION_MODE=email_verify`）| ✅ 上線 | docs/21 |
| D22 | 可分享註冊連結 `?register=1` | ✅ 上線 | docs/22 |
| D23 | **Turnstile 防機器人**（widget `atwho-entry`，site key 在 wrangler vars、secret 在 Worker secret）| ✅ 上線 | docs/23 |
| D25 | **別名 Alias Phase 1**（3–12 字母 ＋ 3 碼流水號；收信投遞；回外信自動用別名）| ✅ 上線 | docs/25 |
| D26 | **跨 App 共用登入**：`https://auth.atwho.org` 薄代理 ＋ `app_clients`／一次性 code 交換 | ✅ 上線 | docs/26、27 |
| D27 | **Google OAuth**（免註冊／免驗證碼、自動配發地址、配額 50/日）＋ **忘記／重設密碼** | ✅ 上線 | docs/28 |
| D29 | `app.atwho.org` **收斂管理功能** ＋ **「個人設置」頁**（ID／**備用電子郵件**／密碼／內嵌別名）| ✅ 上線 | docs/29 |
| **D31** | **三種寄信身分**：真實 ID（固定）／暱稱別名（每帳號 1 個，可變更）／Token（帳號建立時自動產生）；撰寫視窗三種隱私模式 | ✅ 上線（2026-11-06；migration 0015 @08:52 UTC、API @08:53 UTC）| docs/25、docs/29 |
| **D32** | **全站語系與區域設定**：登入頁＋個人設置的國家／語言選擇；**10 種語言**；**國家選單依目前語言過濾**；時區優先、判斷不到才用 Cloudflare IP 國別；日期依國家格式 | ✅ 上線（2026-11-06；`bfb5fd3`／API `11dd0a3e`／Pages `9873d79f`）<br>✅ 2026-11-07 國家過濾修正（Pages `b6c8a2ee`）| docs/32 |
| **D33** | **訪客每日配額統一 50**（既有＋新註冊＋OAuth）；管理頁可調 1–50；**超額被擋時寄提醒信給訪客的備用電子郵件**（每日最多一封；暖機期被擋也寄） | ✅ 上線（2026-11-08；`a27b4e4`／API `39a9abc2`／Pages `ceef6a57`）<br>✅ 2026-11-09 暖機期提醒修正（API `1796328d`） | docs/05 §2.32、docs/16 |
| D19 | 信箱 UX（軟刪／批次／清空垃圾桶／checkbox／D1 分塊／form FK）| ✅ 上線 | docs/19 |
| **D34** | **配額顯示與實際一致**：`/api/me`、`/api/account/settings` 多回 `effective_daily_quota`（暖機中 = min(配額, 暖機配額)）＋ `warmup_until`；個人設置／側欄顯示有效上限；撰寫鈕的額度判斷同步改用有效值 | ✅ 上線（2026-11-08；`168b03c`／API `29a1c860`／Pages `59de8e9d`）| docs/05 §2.32 |
| **D35** | **暖機期上限可調**：每地址 `warmup_quota`（預設 **20**、1–50）；`mail.atwho.org` 訪客管理「寄信設定」可調整；暖機期有效上限 = `min(每日配額, 暖機配額)` | ✅ 上線（2026-11-09；`48e20c9`／migration `0017` @ 06:47 UTC／API `4dbac525`／Pages `dcb1da60`）<br>✅ 2026-11-09 預設改 20（`d364e8e`／migration `0018` @07:49 UTC／API `49866c66`／Pages `55dd1d04`） | docs/05 §2.33、docs/16 |
| **D36** | **AtWho UI Style**：依 `D:\Form\docs\05_UI_Specification.md` 套用主色 `#1F4E79`、狀態色、8px 圓角、卡片陰影與 focus 樣式；**不改版面排佈** | ✅ 上線（2026-11-09；Pages `5f68a302`） | docs/36 |
| **D37** | **Mail 帳號中心＋五系統入口**：Mail／Form／Now／Chat／Flow 系統清單、頭像選單切換、登入後前往上次系統、D26 code 交換契約；遠端系統接入 | ✅ Mail 入口與契約上線（2026-11-10；Pages `0cd68ede`；D36/D37 已 commit `6c57afb`、Pages `d3e46160` 內容同前）<br>✅ Mail API `state`／`email` 部署（2026-11-10；API `2943668e`）<br>🟡 Chat `5c80f1a`、Form `94d802c`、Flow `a6e9684`（`feat/atwho-sso`）已推 GitHub，待遠端部署；Mail Web Pages 的 `state` 修正待部署；Now 待接入 | docs/37 |
| P1/P2、D16–D18 | 互動式表單（內部限定、四道鎖、RJSF lazy-load）| ✅ 上線 | docs/18 |
| D17 | 備份 13 表 ＋ watchdog 去抖 ＋ 退避重試 | ✅ 上線 | docs/17 |

**測試基準**：`pnpm test` → **603**（workerd 472 ＋ web DOM 131）；`pnpm lint` 8/8；`pnpm build` 8/8。

---

## 2. 最近一輪（2026-11-05）確定的產品決策

| 主題 | 定案 |
|---|---|
| OAuth 語意 | 「**只是少註冊步驟、直接註冊**」——Google 已驗證 email，**不再發驗證碼** |
| OAuth 首登 | **自動建立 visitor 帳號 ＋ 自動配發 1 個地址**；配額 **50 封/日**（D33 統一） |
| ID 推導 | email local part → 只留英文字母 → 截 12 字 → **撞二級網域加 3 碼流水號**（`ulhome` → `ulhome001`）|
| **備用電子郵件** | `users.contact_email`，**用途＝找回密碼**；個人設置頁以「備用電子郵件」呈現（**不要**出現「登入方式／Google 帳號」字樣）|
| 登入識別 | `itag` 或 `itag@gmail.com` **都接受** |
| 匿名範圍 | **只有對外（非 `atwho.org`）才匿名**；內部 `@atwho.org` 看真實地址 |
| 反向別名 | 🟡 **不實作**（本架構 API 直接控制 From，不需要 relay）|
| 別名命名 | 使用者輸入 3–12 字母；系統加 `0` ＋ 3 碼流水號（`luke001`）；**不自動分配** |
| 網域收斂 | `app.`（公開）**不得**出現地址管理／我的全部信箱／管理主控台；`mail.` 全開 |
| 別名位置 | **內嵌在「個人設置」頁**（不再有獨立「別名管理」入口）|
| **三種寄信身分**（D31） | **真實 ID**（固定）／**暱稱**（每帳號 1 個啟用中，可變更，舊的立即停用）／**隱身代號**（Token；帳號建立時自動產生 16 hex，不隨暱稱變更）|
| **語系預設**（D32） | 語言：已存偏好 → 該國第一語言 → English；國家：已存偏好 → **時區** → 時區判斷不到才用 **Cloudflare `CF-IPCountry`**（`/api/geo`）→ English fallback。國家選單**依語言過濾**（例：繁中→台港澳、日語→日本） |
| **訪客配額**（D33） | **所有訪客每日 50 封**；管理頁可調 1–50。超過**每日配額或暖機期上限**被擋時，寄提醒信到**訪客的備用電子郵件**（`users.contact_email`），每訪客每日最多一封；暖機期信件標明暖機上限與結束時間 |
| **暖機配額**（D35） | 每地址 `warmup_quota` 預設 **20**、可調 **1–50**；暖機期有效上限 `min(每日配額, 暖機配額)`；訪客管理的「寄信設定」可調整；`warmup_exempt=1` 仍可整個跳過 |

---

## 3. 金鑰與憑證（**只在本機，勿上傳**）

| 內容 | 路徑 |
|---|---|
| **金鑰總索引（先看這個）** | `C:\Users\johnny\.atwhomail-keys.txt`（ACL 只有 johnny）|
| 管理員帳密 | `C:\Users\johnny\.atwhomail-admin-credentials.txt` |
| CF API Token | `C:\Users\johnny\.atwhomail-cf-token` |
| 應用程式 secrets | `D:\Mail\Atwhomail\packages\api\.dev.vars` |
| Worker secrets | `TURNSTILE_SECRET_KEY`、`GOOGLE_CLIENT_SECRET`（已設）|
| wrangler OAuth | `%APPDATA%\xdg.config\.wrangler\config\default.toml`（ulhome@gmail.com）|

**重要事實**：密碼只存 argon2id（**不可還原**）；Gmail 密碼更不可能取得。

---

## 4. 常用指令（在 `D:\Mail\Atwhomail`）

```bash
pnpm test                 # 603 tests
pnpm lint                 # 8 workspace
pnpm build                # 8 workspace
pnpm secret:scan          # push 前必跑（PUBLIC repo）
pnpm deploy:api           # API Worker
cd packages/auth && node ../../node_modules/wrangler/bin/wrangler.js deploy   # auth.atwho.org
cd web && VITE_API_BASE=https://atwhomail-api.ulhome.workers.dev pnpm build \
  && pnpm exec wrangler pages deploy dist --project-name atwhomail-web --branch main
cd packages/api && node ../../node_modules/wrangler/bin/wrangler.js d1 migrations apply mail-d1 --remote
```

⚠️ MSYS 陷阱：`git`／`node`／`rg` 對 `/d/...` 會爆 → 用 `D:/...`；`search_files` 對 D 槽會失敗 → 用 `grep`。
⚠️ `wrangler d1 ... --remote` 偶發 `7403`（暫時性）→ **直接重試**即可。

---

## 5. 環境／資源 ID

| 項目 | 值 |
|---|---|
| Account | `533a594f9db29a17a751d43a40703992` |
| Zone `atwho.org` | `0f882d13adb83c8441803617f9a22511` |
| D1 `mail-d1` | `1d02352f-9f40-4e06-a95f-95a781a84998` |
| R2 | `mail-r2` |
| Pages | `atwhomail-web` |
| Workers | `atwhomail-api`／`-email-handler`／`-mta-sts`／`-heartbeat`／**`atwhomail-auth`** |
| 對外網址 | `app.atwho.org`（公開）／`mail.atwho.org`（Access，owner-only）／**`auth.atwho.org`**（SSO）|
| Migration 現況 | `0001`–`0017` 已套用 production（`0015` @ 2026-11-06 08:52 UTC；`0016_visitor_quota_50` @ 2026-11-08 00:19 UTC；`0017_warmup_quota` @ 2026-11-09）；`0018_warmup_quota_default_20` @ 2026-11-09 07:49 UTC（僅把仍為 5 者改 20，管理員自訂值保留）|

---

## 6. 帳號現況（D1）

| id | username | provider | 備用 email | role |
|---|---|---|---|---|
| 2 | `itag` | google（已連結）| `ulhome@gmail.com` ✅ | **owner** |
| 4 | `luke` | local | — | visitor |
| 5 | `winny` | local | — | visitor |
| 10 | `lukeinbox` | local | — | visitor |

**別名**：`itag001@atwho.org`（→ `itag@atwho.org`）✅
**SSO App**：`demo`（測試用，secret 在金鑰檔 ⚠️ 勿給正式系統）

---

## 7. 待辦／可選下一步

| # | 項目 | 估時 | 備註 |
|---|---|---|---|
| 1 | `invite` 模式也套用 D20 網域檢查 | 1h | 目前只有 `email_verify` 模式有檢查 |
| 2 | `mail.` 專屬 API 授權（管理端點只接受來自 management host）| 2h | 目前只是 UI 收斂，API 未依 host 限制 |
| 3 | ~~DMARC `p=none` → `quarantine`~~ | ✅ 2026-11-09 完成（owner 於 Dashboard 修改；8.8.8.8／1.1.1.1 實測 `p=quarantine`，`rua` 未變）| — |
| 4 | 手機原生 SDK（iOS/Android OAuth client）| 3h | 目前手機可用系統瀏覽器走同一套 Web client ✅ |
| 5 | `provider` 欄位改成可多值（local＋google 並存）| 2h | 目前連結 Google 後 `provider` 會變 `google`（但仍可用密碼登入 ✅）|
| 6 | 別名 Phase 2（反向別名）| 9h | **已決議不實作** ✅ |
| 7 | **D33 部署**：套用 `0016` → 部署 API → 部署前端 | — | ✅ 完成（2026-11-08；migration `0016` @00:19 UTC、API `39a9abc2`、Pages `ceef6a57`；後續 D34 API `29a1c860`／Pages `59de8e9d`） |
| 8 | **D33／D34 生產環境驗收**：配額顯示（暖機期上限）與超額提醒信 | 0.5h | 暖機期或每日配額被擋都會寄；用現有測試訪客重試即可（每日最多一封） |
| 9 | ~~**D35 部署**~~ ✅ 2026-11-09 完成（`0017` → API → 前端；訪客管理「寄信設定」已可調暖機期上限）| — | — |
| 10 | ~~**D35 預設改 20 部署**~~ ✅ 2026-11-09 完成 | — | `0018` 只改仍為 5 者；`luke01` 自訂 6 保留（要改成 20 請在訪客管理調整）|

---

## 8. 已知小限制（不影響使用）

- `users.password_hash` 是 `NOT NULL` → OAuth 帳號以**空字串**表示「未設定密碼」（`hasPassword()` 判定）
- OAuth callback 以 `302 → <origin><path>#oauth_token=…` 交付 session（token 只在 fragment，前端讀後立即清除 ✅）
- 部分測試逾時上調（30s→60s／90s，僅逾時、未改斷言）
- Cloudflare Pages 部署後 CDN 約需 **10–30 秒**才切換到新 bundle（驗證時若讀到舊 bundle 請稍候重試）

---

## 9. 開新對話時的第一句話（建議）

```
請讀 D:\Mail\docs\31-handoff.md 與 docs/mail_PRD_SRS.md §零、§二十一，然後接續處理：（你的需求）
```
