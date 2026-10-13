import { useMemo } from "react";

/**
 * HTML 信件內文的唯一渲染路徑（安全設計，docs/08 §16）：
 * - 內容已由收信端 HTMLRewriter 白名單消毒；此處再以 sandbox iframe 隔離
 * - 不使用 dangerouslySetInnerHTML
 * - sandbox 不含 allow-scripts / allow-same-origin → 即使消毒被繞過也無法執行、
 *   無法讀取 sessionStorage（token）或父頁面 DOM
 * - 補上 meta CSP（消毒後的內容不含 meta，純防禦縱深）與 base target=_blank（連結另開分頁）
 */
const PREAMBLE =
  '<meta charset="utf-8">' +
  '<base target="_blank">' +
  '<meta http-equiv="Content-Security-Policy" ' +
  'content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'">';

interface Props {
  html: string;
}

export function HtmlBody({ html }: Props) {
  const doc = useMemo(() => PREAMBLE + html, [html]);
  return (
    <iframe
      className="html-body"
      title="信件內容"
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      srcDoc={doc}
    />
  );
}
