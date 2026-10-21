/**
 * sanitize.ts — 本地直送用的 HTML 消毒（白名單制，Workers 內建 HTMLRewriter）
 *
 * 為什麼 API 也需要一份：`POST /api/mail/send` 收件人全為內部時改為**本地直送**（docs/18 §3.1、P1），
 * 內文會直接寫入 D1／R2 並由 `/api/mail/:id/html` 提供，不再經過 Cloudflare Email Service。
 * 因此寄信端也必須套用與收信端相同的消毒政策（08 §16），避免信任邊界因「內部」而放鬆。
 *
 * 政策與 `packages/email-handler/src/sanitize.ts` 一致（刻意保持兩份同步；收信端流程不得變更）：
 *  - 移除危險元素（script／iframe／form／svg…）與所有事件屬性、style、srcdoc…
 *  - a[href] 僅允許 http(s):／mailto:；img[src] 僅允許 data:image/*
 *  - 屬性白名單；移除 HTML 註解
 *
 * 失敗時回傳空字串（呼叫端據此不儲存 HTML）；不得把原始 HTML 直接寫入 R2。
 */
const BLOCKED_ELEMENTS = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet",
  "form", "input", "button", "select", "option", "optgroup", "textarea", "label",
  "link", "meta", "base", "title", "svg", "math", "template", "noscript",
  "video", "audio", "source", "track", "canvas", "portal", "marquee",
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
    console.error("[api/sanitize] failed", { error: String(err) });
    return "";
  }
}
