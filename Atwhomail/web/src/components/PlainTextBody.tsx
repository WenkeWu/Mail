/** 純文字內文：React 自動 escape，不走任何 HTML 路徑 */
export function PlainTextBody({ text }: { text: string }) {
  return <pre className="plain-body">{text}</pre>;
}
