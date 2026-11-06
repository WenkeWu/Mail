import { useEffect } from "react";
import { useI18n } from "../i18n";
import { IconClose } from "./icons";

interface Props {
  message: string;
  kind?: "info" | "error";
  onClose: () => void;
}

/** 簡易浮動提示（自動 4.5 秒消失；錯誤停留較久） */
export function Toast({ message, kind = "info", onClose }: Props) {
  const { t } = useI18n();
  useEffect(() => {
    const timer = window.setTimeout(onClose, kind === "error" ? 7000 : 4500);
    return () => window.clearTimeout(timer);
  }, [message, kind, onClose]);

  return (
    <div className={`toast toast-${kind}`} role="status">
      <span>{message}</span>
      <button type="button" className="icon-btn" onClick={onClose} aria-label={t("關閉通知")}>
        <IconClose size={16} />
      </button>
    </div>
  );
}
