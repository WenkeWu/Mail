import { describe, it, expect } from "vitest";
import { sanitizeHtml } from "../../email-handler/src/sanitize";

describe("sanitizeHtml（08 文件 #16 白名單消毒）", () => {
  it("移除 script 與事件屬性", async () => {
    const out = await sanitizeHtml(`<p onclick="x()">hi</p><script>alert(1)</script>`);
    expect(out).not.toContain("<script");
    expect(out).not.toContain("onclick");
    expect(out).toContain("hi");
  });

  it("移除 style 標籤與 style 屬性", async () => {
    const out = await sanitizeHtml(`<style>body{x:1}</style><p style="color:red">t</p>`);
    expect(out).not.toContain("<style");
    expect(out).not.toContain("style=");
    expect(out).toContain("t");
  });

  it("移除 iframe / svg / object / form", async () => {
    const out = await sanitizeHtml(
      `<iframe src="http://evil"></iframe><svg onload="a()"></svg><object data="x"></object><form><input></form>`
    );
    for (const bad of ["<iframe", "<svg", "<object", "<form", "<input"]) expect(out).not.toContain(bad);
  });

  it("移除 HTML 註解", async () => {
    const out = await sanitizeHtml(`<!-- secret --><p>x</p>`);
    expect(out).not.toContain("<!--");
    expect(out).toContain("x");
  });

  it("剝離遠端圖片但保留 data: 內嵌圖", async () => {
    const dataImg = "data:image/png;base64,iVBORw0KGgo=";
    const out = await sanitizeHtml(`<img src="http://evil/t.png" alt="r"><img src="${dataImg}" alt="i">`);
    expect(out).not.toContain("http://evil");
    expect(out).toContain(dataImg);
  });

  it("javascript: 連結被移除、https 連結保留", async () => {
    const out = await sanitizeHtml(`<a href="javascript:alert(1)">bad</a><a href="https://ok.example/x">good</a>`);
    expect(out).not.toContain("javascript:");
    expect(out).toContain("https://ok.example/x");
  });

  it("保留一般標籤與文字結構", async () => {
    const out = await sanitizeHtml(`<h1>標題</h1><p>Hello <b>bold</b></p>`);
    expect(out).toContain("<h1>標題</h1>");
    expect(out).toContain("<b>bold</b>");
  });
});
