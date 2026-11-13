---
title: 註冊 ID 與二級網域同名偵測（D20）
status: 現況
updated: 2026-11-11
read-when: 改註冊 ID 檢查／撞網域偵測時（D20）
---

# 20 — 註冊 ID 與二級網域同名偵測（D20）

> 建立：2026-11-04｜狀態：**設計待審**（尚未實作）
> 需求（owner）：「註冊時先偵測要註冊的 ID 是否有相同的 DNS 名稱。例：使用者填 `HP`，而 DNS 可找到 `hp.com`（不管頂級網域，只要二級網域和 HP 一樣），就不能註冊；系統也要推薦可用的 ID。」

## 1. 為什麼要做

`hp@atwho.org` 這種地址會被誤認為 **HP 官方**（品牌冒用／釣魚 ✅）。
在 `atwho.org` 內，地址的第一段（local part）就是使用者的公開身分，**撞到真實企業二級網域**應視為不可註冊 ✅。

## 2. 判定規則

1. 取 ID（local part）→ 正規化：小寫、去空白、只允許 `a-z0-9._-`；**不可為純數字**（例：`123456` 不可，`123abc` 可）
2. 對一組 TLD 逐一查 DNS：`<id>.<tld>` 是否存在
3. **任一 TLD 存在 → 不可註冊**（不管頂級網域 ✅ 只看二級網域是否同名 ✅）
4. 同時檢查：
   - **保留字**：`admin`、`postmaster`、`abuse`、`root`、`noreply`、`no-reply`、`mailer-daemon`、`hostmaster`、`webmaster`、`support`…（不可註冊 ✅）
   - **系統既有地址**：`alerts@`、`app@`、`itag@`、`tlsrpt@`、`noreply@`（取 `email_addresses` 現有資料 ✅）
   - **人工封鎖清單**（新表 `id_blocklist`，owner 可維護 ✅）

### TLD 清單（第一版，25 個）
```
com net org io co ai app dev me info biz xyz
tw cn jp hk sg uk de us tech cloud shop online site store
```
> ⚠️ 清單可調整；不在清單內的 TLD **不會被檢查**（例：`.museum`、`.aero`）→ 這是已知限制。

## 3. 技術實作

### 3.1 DNS 查詢（Cloudflare DoH）
- Worker 內用 `fetch('https://cloudflare-dns.com/dns-query?name=<id>.<tld>&type=NS', {headers:{accept:'application/dns-json'}})` ✅
- 判定：`Status === 0`（NOERROR）且有 `Answer` → 存在 ✅；`Status === 3`（NXDOMAIN）→ 不存在 ✅
- 平行查詢（`Promise.allSettled` ✅），**總逾時 2 秒** ✅，最多 25 個子請求 ✅
- ⚠️ 子請求成本：免費方案 50/請求 → 25 個可接受 ✅；付費方案 1000 ✅

### 3.2 快取（新表 `domain_checks`）
```sql
CREATE TABLE domain_checks (
  label      TEXT PRIMARY KEY,   -- 正規化後的 id
  hit        INTEGER NOT NULL,   -- 1=有同名網域, 0=無
  tld_hit    TEXT,               -- 命中的 TLD（如 'com'）
  checked_at INTEGER NOT NULL
);
```
- TTL：`hit=1` → **90 天**；`hit=0` → **7 天**（新網域可能陸續註冊 ✅）
- 同一 ID 重複註冊嘗試 → 直接讀快取 ✅（幾乎零延遲）

### 3.3 API

| 端點 | 用途 |
|---|---|
| `POST /api/auth/check-id` | 前端即時檢查 `{id}` → `{available, reason, suggestions[]}`；同 IP 每分鐘 20 次 ✅ |
| `POST /api/auth/register`（既有）| 建立前**強制**再檢查一次（不可只信前端 ✅）；不合格 → `422 ID_MATCHES_DOMAIN` 或 `422 ID_RESERVED` + `suggestions[]` |

### 3.4 建議名稱產生（suggestions）
- 規則（依序，每類最多 2 個）：
  1. `<id>-mail`、`<id>mail`
  2. `my<id>`、`<id>-inbox`
  3. `<id>-atwho`、`<id><兩位數>`（如 `hp42`）
- **每個候選都要通過同一檢查** ✅（避免建議了也不能用 ⚠️）
- 為控制延遲：最多檢查 **6 個候選** ✅（快取命中時幾乎無成本 ✅）；全不過 → 回空陣列 ＋ 文案「請改用其他名稱」
- 前端把建議做成**可點選的 chip**（點一下填入 ✅）

### 3.5 前端
- 註冊表單的 ID 欄位：輸入停止 500ms 後呼叫 `check-id` ✅
- 顯示：✅ 可用 / ❌ 已被 `<id>.com` 使用（附原因）/ ❌ 純數字 / ⚠️ 保留字
- 建議 chip 一列（最多 6 個 ✅，可點選 ✅）
- 送出時仍由後端複驗 ✅（前端不可信 ✅ N3 原則 ✅）

## 4. 已知限制與風險（需你決定）

| # | 議題 | 選項 |
|---|---|---|
| 1 | **DNS 查不到但網域存在**（罕見：無 NS 記錄的保留域名 ✅）| 接受（best-effort ✅）|
| 2 | **DNS 查詢失敗／逾時** | (A) **fail-open**：放行＋記錄 → 不影響註冊可用性 ✅（建議 ✅）<br>(B) **fail-closed**：擋下 → 安全優先但可能因 DNS 故障全面擋註冊 ⚠️ |
| 3 | 三級網域（`hp.co.uk`）| 不查（依你的「只看二級」✅）；要查需擴大 TLD 清單（`co.uk`、`com.tw`… ✅ 成本上升 ✅）|
| 4 | 商標但無網域 | 檢查不到 → 需人工 `id_blocklist` ✅ |
| 5 | 註冊延遲 | 首次檢查約 +0.3–1.5 秒（快取後 ~0 ✅）|
| 6 | 既有地址是否回溯檢查 | 建議**不回溯**（不打擾現有使用者 ✅），只套用新註冊 ✅ |

## 5. 工作量估計

| 項目 | 估時 |
|---|---|
| 後端（檢查器＋快取＋2 端點＋保留字＋建議）| ~3 小時 |
| 前端（即時檢查＋建議 chip）| ~2 小時 |
| 測試（T92–T99：命中／未命中／保留字／逾時 fail-open／建議全不可用／快取命中／速率限制／註冊複驗）| ~1.5 小時 |

## 6. 驗收案例（草案）

| ID | 預期 |
|---|---|
| `hp` | ❌ 阻擋（`hp.com` 存在）→ 建議 `hp-mail`、`hp42`… |
| `google` | ❌ 阻擋 |
| `zzqqxxyy123` | ✅ 可註冊（不存在）|
| `admin` | ❌ 保留字 |
| `itag` | ❌ 系統既有地址 |
| `hp-mail` | ✅ 若 `hp-mail.com` 不存在 → 可註冊 ✅ |
