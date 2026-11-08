// @vitest-environment jsdom
/// <reference lib="dom" />
import { describe, expect, it } from "vitest";
import { htmlToMarkdown, renderMarkdown } from "../src/index.js";
import { sanitizeHtml } from "../src/markdown.js";
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

// The DOMPurify layer on its own, on HTML markdown-it would never write, so a
// weakened allow-list cannot hide behind markdown-it's own checks.
describe("the DOMPurify layer alone", () => {
  it.each([
    ['<a href="/relative">x</a>', "<a>x</a>"],
    ['<a href="//e.test/x">x</a>', "<a>x</a>"],
    ['<a href="javascript:alert(1)">x</a>', "<a>x</a>"],
    ['<a href="mailto:a@e.test">x</a>', "<a>x</a>"],
    // DOMPurify keeps a data: src on img, audio, video, source and track
    // whatever ALLOWED_URI_REGEXP says; this layer must not.
    ['<img src="data:image/png;base64,AAAA" onerror="alert(1)">', "<img>"],
    ['<img src="data:image/svg+xml;base64,PHN2Zz4=" alt="a">', '<img alt="a">'],
    ['<img src=" DATA:image/png;base64,AAAA">', "<img>"],
    ['<a href="data:text/html,x">x</a>', "<a>x</a>"],
    ['<img src="https://e.test/i.png" alt="a">', '<img src="https://e.test/i.png" alt="a">'],
    ['<img src="/i.png" alt="a">', '<img alt="a">'],
    ['<p onclick="alert(1)" style="color:red" class="c" id="i">x</p>', "<p>x</p>"],
    ["<script>alert(1)</script><p>x</p>", "<p>x</p>"],
    ['<div><span title="t">x</span></div>', "x"],
    [
      '<a href="https://e.test/" target="_blank" rel="opener">x</a>',
      '<a href="https://e.test/">x</a>',
    ],
    ['<ol start="3" type="a"><li>x</li></ol>', '<ol start="3"><li>x</li></ol>'],
  ])("%s", (html, expected) => {
    expect(sanitizeHtml(html)).toBe(expected);
  });
});

// The shared table directly beside a link the converter writes: the output
// holds exactly the paragraph and that link, with the payload as text. A "!"
// before the link once made it an image fetching the link's address (PR #24
// review).
describe("escaped designer text beside a link renders literally through renderMarkdown", () => {
  const LINK = '<a href="https://shop.example/x">store</a>';

  function expectTextAndLink(html: string, text: string): void {
    const { root, tags, attributes } = parse(html);
    expect(tags, html).toEqual(["p", "a"]);
    expect(attributes, html).toEqual([{ tag: "a", name: "href", value: "https://shop.example/x" }]);
    expect(root.querySelector("a")?.textContent).toBe("store");
    expect(root.querySelector("p")?.textContent).toBe(text);
  }

  it("a ! right before a link stays text and the link stays a link", () => {
    const html = renderMarkdown(htmlToMarkdown(`<p>Get the files here!${LINK}</p>`));
    expectTextAndLink(html, "Get the files here!store");
  });

  it.each(DESIGNER_PAYLOADS)("directly before a link: %j", (payload) => {
    const html = renderMarkdown(htmlToMarkdown(`<p>a ${htmlEscape(payload)}${LINK}</p>`));
    expectTextAndLink(html, `a ${payload}store`);
  });

  it.each(DESIGNER_PAYLOADS)("directly after a link: %j", (payload) => {
    const html = renderMarkdown(htmlToMarkdown(`<p>a ${LINK}${htmlEscape(payload)}x</p>`));
    expectTextAndLink(html, `a store${payload}x`);
  });
});

// Misnested inline tags through renderMarkdown: the payload stays text, and
// nothing but paragraph, emphasis, link and table elements comes out; above
// all no <img>, which a "!" left bare before a link's [ once produced, loading
// an address the designer chose (PR #24 review).
describe("escaped designer text beside misnested inline tags renders literally through renderMarkdown", () => {
  const ALLOWED = ["p", "em", "strong", "a", "table", "thead", "tbody", "tr", "th", "td"];

  function expectTextOnly(html: string, text: string): void {
    expectInert(html);
    const { root, tags } = parse(html);
    expect(tags, html).not.toContain("img");
    for (const tag of tags) expect(ALLOWED, html).toContain(tag);
    expect(root.textContent?.replace(/\s+/g, " ").trim(), html).toBe(text);
  }

  it("emphasis closed before the bold and link inside it makes no image", () => {
    const html = renderMarkdown(
      htmlToMarkdown('<p><i>!<b>abc<a href="https://evil.test/p.png">d</i></b></a></p>'),
    );
    expect(html).not.toMatch(/<img|evil\.test/);
    expectTextOnly(html, "!abcd");
  });

  // Issue #33: a bold opened in a cell's trailing spaces, which are trimmed
  // before the "; " between list items or nested table rows.
  it.each([
    [
      "before a list item in a cell",
      '<table><tr><td><ul><li>a</li><br><br><br><b><li>!<a href="https://evil.example/x.png">y</a></b></li></ul></td></tr></table>',
    ],
    [
      "before a row of a table nested in a cell",
      '<table><tr><td><table><tr><td>a</td></tr><br><br><b><tr><td>!<a href="https://evil.example/x.png">y</a></b></td></tr></table></td></tr></table>',
    ],
  ])("bold opened in a cell's trailing spaces %s makes no image", (_name, input) => {
    const html = renderMarkdown(htmlToMarkdown(input));
    expect(html).not.toMatch(/<img/);
    expectTextOnly(html, "a; !y");
  });

  it.each(DESIGNER_PAYLOADS)("a link closed before the bold inside it: %j", (payload) => {
    const p = htmlEscape(payload);
    const html = renderMarkdown(
      htmlToMarkdown(`<p>a <a href="https://e.test/">${p}<b>y</a>${p}z</b></p>`),
    );
    expectTextOnly(html, `a ${payload}y${payload}z`.replace(/\s+/g, " ").trim());
  });

  it.each(DESIGNER_PAYLOADS)("emphasis closed before a bold and a link: %j", (payload) => {
    const p = htmlEscape(payload);
    const html = renderMarkdown(
      htmlToMarkdown(`<p>a <i>${p}<b>abc<a href="https://evil.test/p.png">d</i>${p}</b>e</a></p>`),
    );
    expect(html).not.toMatch(/evil\.test/);
    expectTextOnly(html, `a ${payload}abcd${payload}e`.replace(/\s+/g, " ").trim());
  });

  it.each(DESIGNER_PAYLOADS)("bold left open across a table cell: %j", (payload) => {
    const p = htmlEscape(payload);
    const html = renderMarkdown(
      htmlToMarkdown(`<table><tr><td>a ${p}<b>y</td><td>z</b></td></tr></table>`),
    );
    expectTextOnly(html, `a ${payload}y z`.replace(/\s+/g, " ").trim());
  });
});
