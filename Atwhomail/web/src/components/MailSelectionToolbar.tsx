/**
 * 批次動作工具列（docs/19 §3；D19-3 追加「清空垃圾桶」）。
 * 有選取時出現；可用動作依目前資料夾決定：
 * - 垃圾桶：還原／永久刪除，並提供「清空垃圾桶」（未選取時仍顯示）
 * - 其他資料夾（含跨資料夾搜尋）：移至垃圾桶／標為已讀
 */
import { useI18n } from "../i18n";

interface Props {
  count: number;
  /** `MailList` 目前查詢的資料夾（"all" = 跨資料夾搜尋） */
  folder: string;
  /**
   * 垃圾桶目前總封數（`GET /api/mail/counts` 的 `folders.trash.total`，session scope）。
   * 只用於「清空垃圾桶」的二次確認文案；0 時按鈕停用。
   */
  trashCount?: number;
  busy?: boolean;
  onTrash: () => void;
  onRestore: () => void;
  onPurge: () => void;
  onEmptyTrash: () => void;
  onMarkRead: () => void;
  onClear: () => void;
}

export function MailSelectionToolbar({
  count,
  folder,
  trashCount = 0,
  busy = false,
  onTrash,
  onRestore,
  onPurge,
  onEmptyTrash,
  onMarkRead,
  onClear,
}: Props) {
  const { t } = useI18n();
  const inTrash = folder === "trash";
  // 垃圾桶即使沒有選取也要顯示「清空垃圾桶」；其他資料夾只在有選取時出現
  if (count === 0 && !inTrash) return null;
  return (
    <div className="selection-toolbar" role="toolbar" aria-label={t("批次動作")}>
      {count > 0 && (
        <span className="selection-count" aria-live="polite">
          {t("已選 {count} 封", { count })}
        </span>
      )}
      {inTrash ? (
        <>
          {count > 0 && (
            <>
              <button type="button" onClick={onRestore} disabled={busy}>
                {t("還原")}
              </button>
              <button type="button" className="danger" onClick={onPurge} disabled={busy}>
                {t("永久刪除")}
              </button>
            </>
          )}
          <button
            type="button"
            className="danger"
            onClick={onEmptyTrash}
            disabled={busy || trashCount === 0}
            title={
              trashCount === 0
                ? t("垃圾桶是空的")
                : t("永久刪除垃圾桶內 {count} 封（含附件與原始檔）", { count: trashCount })
            }
          >
            {t("清空垃圾桶")}
          </button>
        </>
      ) : (
        <>
          <button type="button" onClick={onTrash} disabled={busy}>
            {t("移至垃圾桶")}
          </button>
          <button type="button" onClick={onMarkRead} disabled={busy}>
            {t("標為已讀")}
          </button>
        </>
      )}
      {count > 0 && (
        <button type="button" className="link" onClick={onClear} disabled={busy}>
          {t("取消選取")}
        </button>
      )}
    </div>
  );
}
