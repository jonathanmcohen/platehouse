// @vitest-environment jsdom
/// <reference lib="dom" />
import { describe, expect, it } from "vitest";
import { htmlToMarkdown, renderMarkdown } from "../src/index.js";
import { DESIGNER_PAYLOADS, htmlEscape } from "./support/payloads.js";

// renderMarkdown is markdown-it (html off, linkify off, http(s) links only)
// with its output passed through DOMPurify. The web app runs it in the
// browser (build plan Task 20); here jsdom stands in for the browser's DOM.

interface Parsed {
  root: HTMLElement;
  tags: string[];
  attributes: Array<{ tag: string; name: string; value: string }>;
}

function parse(html: string): Parsed {
  const root = document.createElement("div");
  root.innerHTML = html;
  const elements = Array.from(root.querySelectorAll("*"));
  return {
    root,
    tags: elements.map((el) => el.tagName.toLowerCase()),
    attributes: elements.flatMap((el) =>
      Array.from(el.attributes).map((a) => ({
        tag: el.tagName.toLowerCase(),
        name: a.name,
        value: a.value,
      })),
    ),
  };
}

// No script-capable element, no event handler and no address that is not
// http(s), anywhere in the output.
function expectInert(html: string): void {
  const { tags, attributes } = parse(html);
  for (const bad of ["script", "iframe", "object", "embed", "svg", "math", "style", "form"]) {
    expect(tags, html).not.toContain(bad);
  }
  for (const a of attributes) {
    expect(a.name, html).not.toMatch(/^on/i);
    expect(a.name, html).not.toBe("style");
    if (a.name === "href" || a.name === "src") expect(a.value, html).toMatch(/^https?:\/\//i);
  }
}

describe("escaped designer text renders literally through renderMarkdown", () => {
  it.each(DESIGNER_PAYLOADS)("at a line's start: %j", (payload) => {
    const text = `${payload}x`;
    const html = renderMarkdown(htmlToMarkdown(`<p>${htmlEscape(text)}</p>`));
    const { root, tags, attributes } = parse(html);
    expect(tags).toEqual(["p"]);
    expect(attributes).toEqual([]);
    expect(root.querySelector("p")?.textContent).toBe(text.trim());
  });

  it.each(DESIGNER_PAYLOADS)("mid-line: %j", (payload) => {
    const text = `a ${payload}x`;
    const html = renderMarkdown(htmlToMarkdown(`<p>${htmlEscape(text)}</p>`));
    const { root, tags, attributes } = parse(html);
    expect(tags).toEqual(["p"]);
    expect(attributes).toEqual([]);
    expect(root.querySelector("p")?.textContent).toBe(text);
  });
});

describe("a script or event-handler payload does not survive", () => {
  it("raw HTML in a designer description leaves no element and no handler", () => {
    const description =
      "<p>Intro</p><script>alert(1)</script><img src=x onerror=alert(1)>" +
      '<a href="javascript:alert(1)" onclick="alert(1)">click</a>' +
      '<svg onload="alert(1)"><circle /></svg><iframe src="https://e.test/"></iframe>' +
      '<p onmouseover="alert(1)" style="color:red">styled</p>' +
      '<object data="https://e.test/x.swf"></object><style>p{}</style>';
    const html = renderMarkdown(htmlToMarkdown(description));
    expectInert(html);
    expect(parse(html).tags).toEqual(["p", "p", "p"]);
    expect(parse(html).root.textContent).toBe("Intro\nclick\nstyled\n");
  });

  const HOSTILE_MARKDOWN = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    '<a href="javascript:alert(1)">x</a>',
    "<javascript:alert(1)>",
    "[x](javascript:alert(1))",
    "[x](JAVASCRIPT:alert(1))",
    "[x](  javascript:alert(1))",
    "[x](java&#115;cript:alert(1))",
    "[x](&#106;avascript:alert(1))",
    "[x](vbscript:msgbox(1))",
    "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
    "[x](file:///etc/passwd)",
    "[x](/relative)",
    "[x](//e.test/protocol-relative)",
    "![x](javascript:alert(1))",
    "![x](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)",
    '[x](https://e.test "t" onmouseover="alert(1)")',
    "[x]: javascript:alert(1)\n\n[x]",
    "```html\n<script>alert(1)</script>\n```",
    "    <script>alert(1)</script>",
    "<div onclick=alert(1)>x</div>",
  ];

  it.each(HOSTILE_MARKDOWN)("hostile Markdown typed directly: %j", (markdown) => {
    const html = renderMarkdown(markdown);
    expectInert(html);
    const { tags } = parse(html);
    expect(tags).not.toContain("img");
    for (const tag of tags) {
      expect(["p", "a", "pre", "code", "strong", "em"], `${tag} in ${html}`).toContain(tag);
    }
  });
});

describe("renderMarkdown keeps the Markdown it is meant to show", () => {
  it("http and https links survive with their address", () => {
    const { attributes, tags } = parse(
      renderMarkdown("[a](https://e.test/x?y=1&z=2) [b](http://e.test/)"),
    );
    expect(tags).toEqual(["p", "a", "a"]);
    expect(attributes).toEqual([
      { tag: "a", name: "href", value: "https://e.test/x?y=1&z=2" },
      { tag: "a", name: "href", value: "http://e.test/" },
    ]);
  });

  it("a line break in a paragraph is a <br>", () => {
    expect(renderMarkdown("a\nb")).toBe("<p>a<br>\nb</p>\n");
  });

  it("the converter's headings, lists, tables and emphasis render", () => {
    const md = htmlToMarkdown(
      "<h2>Kit</h2><p><strong>Bold</strong> and <em>it</em></p><ol><li>a</li></ol>" +
        "<table><tr><td>h</td></tr><tr><td>c</td></tr></table>",
    );
    expect(parse(renderMarkdown(md)).tags).toEqual([
      "h2",
      "p",
      "strong",
      "em",
      "ol",
      "li",
      "table",
      "thead",
      "tr",
      "th",
      "tbody",
      "tr",
      "td",
    ]);
  });

  it("DOMPurify runs with the allow-list: a fenced block's class attribute is removed", () => {
    // markdown-it writes class="language-js" here; only DOMPurify removes it.
    expect(renderMarkdown("```js\nx\n```")).toBe("<pre><code>x\n</code></pre>\n");
  });

  it("an ordered list keeps its start number", () => {
    expect(renderMarkdown("3. a")).toBe('<ol start="3">\n<li>a</li>\n</ol>\n');
  });

  it("empty input renders nothing", () => {
    expect(renderMarkdown("")).toBe("");
  });
});
