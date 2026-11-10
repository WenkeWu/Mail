# 36 — D36：AtWho UI Style（視覺樣式對齊）

> 建立：2026-11-09｜狀態：**已上線（2026-11-09；Cloudflare Pages `5f68a302`，`app.atwho.org`）**
> 參考：`D:\Form\docs\05_UI_Specification.md`（v1.2）
> 範圍：**只調整視覺樣式，不改版面排佈**（grid 欄寬、元件位置、間距與尺寸維持原樣）。

## 1. 色彩

`web/src/styles.css` 的 `:root` 改為 AtWho design tokens：

| Token | 值 | 用途 |
|---|---|---|
| `--primary` | `#1F4E79` | 主色（header、主要按鈕、focus、連結） |
| `--primary-hover` | `#173F62` | 主色 hover／漸層終點 |
| `--primary-soft` | `#EAF2F8` | 主色淡底（選取、hover） |
| `--secondary` | `#22A699` | 次要色（一般使用者頭像） |
| `--accent` | `#F2994A` | 強調色（owner 頭像） |
| `--success` / `--success-soft` / `--success-text` | `#27AE60`／`#D1FAE5`／`#047857` | 成功、內部郵件、通過驗證 |
| `--warning` / `--warning-soft` / `--warning-text` | `#F2C94C`／`#FEF3C7`／`#B45309` | 暖機、注意事項 |
| `--danger` / `--danger-soft` / `--danger-text` | `#EB5757`／`#FEE2E2`／`#B91C1C` | 錯誤、刪除、超額 |
| `--surface` / `--panel` | `#FFFFFF` | 卡片／面板 |
| `--bg` | `#F8FAFC` | 頁面底色 |
| `--border` | `#E0E0E0` | 一般邊框／分隔線 |
| `--border-strong` | `#D1D5DB` | 輸入框邊框 |
| `--text` / `--muted` | `#1F2937`／`#4B5563` | 主要／次要文字 |
| `--disabled` | `#9CA3AF` | 停用 |
| `--shadow` | `0 1px 3px rgba(15,23,42,.08)` | 卡片陰影 |
| `--shadow-lg` | `0 12px 32px rgba(15,23,42,.16)` | 浮層（選單／Modal／Toast） |
| `--radius` | `8px` | 按鈕／卡片／輸入框圓角 |

- 既有 class 仍使用 `--purple*` 命名；`styles.css` 保留別名，統一指向 primary，避免大規模改名。
- 原本的紫色、綠色、紅色、黃色色碼已逐一映射到上表（狀態徽章、驗證 chip、警告框等）。

## 2. 元件

- **按鈕**：主要／次要／危險／撰寫／批次工具列／隱私模式／登入分頁 → `8px` 圓角；次要按鈕為白底＋ primary 邊框與文字。
- **表單**：預設邊框 `#D1D5DB`、圓角 `8px`；focus 為主色邊框＋淡主色光暈。
- **卡片**：登入卡、Modal、設定卡等為白底、`#E5E7EB` 細邊框、`8px` 圓角、輕陰影。
- **標題**：`h1/h2/h3` 統一 600 字重；不變更字級與行高，避免影響既有版面。
- **Header**：主色深藍底＋底部淡分隔線；搜尋框與登入頁漸層同步改為主色系。
- **狀態色**：成功（內部郵件／通過驗證）、警告（暖機／注意）、危險（失敗／刪除）一律使用上表 token。

## 3. 未變更

- 三欄 grid 欄寬、列表高度、側欄寬度、元件排列與間距。
- 字級與行高（避免文字換行造成版面位移）。
- 所有功能、API、權限與 i18n 行為。

## 4. 驗證

- `pnpm --filter @atwhomail/web run typecheck` ✅
- `pnpm --filter @atwhomail/web test` → 125 ✅
- `pnpm --filter @atwhomail/web build` ✅
- 登入頁以 headless Chrome 截圖確認：深藍主色、白色卡片、8px 圓角、主色按鈕與 focus 光暈。
