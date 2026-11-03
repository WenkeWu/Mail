/**
 * 批次動作工具列（docs/19 §3）。
 * 只在有選取時出現；可用動作依目前資料夾決定：
 * - 垃圾桶：還原／永久刪除
 * - 其他資料夾（含跨資料夾搜尋）：移至垃圾桶／標為已讀
 */
interface Props {
  count: number;
  /** `MailList` 目前查詢的資料夾（"all" = 跨資料夾搜尋） */
  folder: string;
  busy?: boolean;
  onTrash: () => void;
  onRestore: () => void;
  onPurge: () => void;
  onMarkRead: () => void;
  onClear: () => void;
}

export function MailSelectionToolbar({
  count,
  folder,
  busy = false,
  onTrash,
  onRestore,
  onPurge,
  onMarkRead,
  onClear,
}: Props) {
  if (count === 0) return null;
  const inTrash = folder === "trash";
  return (
    <div className="selection-toolbar" role="toolbar" aria-label="批次動作">
      <span className="selection-count" aria-live="polite">
        已選 {count} 封
      </span>
      {inTrash ? (
        <>
          <button type="button" onClick={onRestore} disabled={busy}>
            還原
          </button>
          <button type="button" className="danger" onClick={onPurge} disabled={busy}>
            永久刪除
          </button>
        </>
      ) : (
        <>
          <button type="button" onClick={onTrash} disabled={busy}>
            移至垃圾桶
          </button>
          <button type="button" onClick={onMarkRead} disabled={busy}>
            標為已讀
          </button>
        </>
      )}
      <button type="button" className="link" onClick={onClear} disabled={busy}>
        取消選取
      </button>
    </div>
  );
}
