/**
 * sanitize.ts — HTML email 消毒（白名單制，使用 Workers 內建 HTMLRewriter）
 *
 * 政策（依 08-security-checklist.md #16）：
 *  - 移除危險元素：script / style / iframe / object / embed / form / link / meta / base / svg / math / …
 *  - 移除所有事件屬性（on*）、style、srcset、formaction、xlink:*、srcdoc
 *  - a[href] 僅允許 http(s): / mailto:；img[src] 僅允許 data:image/*（MVP 剝離遠端圖片）
 *  - 屬性白名單：title/width/height/align/colspan/rowspan/alt（a、img 另有專屬）
 *  - 移除 HTML 註解
 *
 * 設計原則：白名單（不在清單內一律刪），未知標籤保留結構但無屬性。
 */
const BLOCKED_ELEMENTS = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet",
  "form", "input", "button", "select", "option", "optgroup", "textarea", "label",
  "link", "meta", "base", "title", "svg", "math", "template", "noscript",
  "video", "audio", "source", "track", "canvas", "portal", "marquee", "frame",
  "dialog", "slot", "map", "area",
]);

const GLOBAL_ATTRS = new Set(["title", "width", "height", "align", "valign", "colspan", "rowspan", "alt", "dir", "lang"]);
const A_ATTRS = new Set(["href", "title"]);
const IMG_ATTRS = new Set(["src", "alt", "width", "height", "title"]);
const DROP_ALWAYS = new Set(["style", "srcset", "formaction", "srcdoc", "background", "action", "method", "ping"]);

function safeHref(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v.startsWith("http://") || v.startsWith("https://") || v.startsWith("mailto:");
}

function safeImgSrc(value: string): boolean {
  return value.trim().toLowerCase().startsWith("data:image/");
}

class ElementSanitizer {
  element(el: Element): void {
    const tag = el.tagName.toLowerCase();
    if (BLOCKED_ELEMENTS.has(tag)) {
      el.remove();
      return;
    }

    // 先收集屬性名（不可在迭代中修改）
    const names: string[] = [];
    for (const [name] of el.attributes) names.push(name);

    for (const name of names) {
      const lower = name.toLowerCase();
      if (lower.startsWith("on") || DROP_ALWAYS.has(lower) || lower.startsWith("xlink:")) {
        el.removeAttribute(name);
        continue;
      }
      const allowed = tag === "a" ? A_ATTRS : tag === "img" ? IMG_ATTRS : GLOBAL_ATTRS;
      if (!allowed.has(lower)) {
        el.removeAttribute(name);
        continue;
      }
      const value = el.getAttribute(name) ?? "";
      if (tag === "a" && lower === "href" && !safeHref(value)) el.removeAttribute(name);
      if (tag === "img" && lower === "src" && !safeImgSrc(value)) el.removeAttribute(name);
    }
  }
}

class DocumentSanitizer {
  comments(comment: Comment): void {
    comment.remove();
  }
}

/** 消毒 HTML；失敗時回傳空字串（呼叫端據此不儲存） */
export async function sanitizeHtml(html: string): Promise<string> {
  try {
    const transformed = new HTMLRewriter()
      .on("*", new ElementSanitizer())
      .onDocument(new DocumentSanitizer())
      .transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }));
    return await transformed.text();
  } catch (err) {
    console.error("[sanitize] failed", { error: String(err) });
    return "";
  }
}
