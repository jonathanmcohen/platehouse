import { describe, expect, it } from "vitest";
import { createMarkdownIt, htmlToMarkdown } from "../src/markdown.js";

// Bold and italic text and markdown-it (0.1.0 release review, issues #346
// and #348). Whether ** or * is read as emphasis depends on CommonMark's
// flanking rules, the rule of 3 and how markdown-it pairs the runs, and a
// hand-written copy of those rules missed case after case (punctuation
// beside the marks, an emphasis nested at another's edge, bold holding two
// or more italics, nested bold in bold). The converter now writes every
// emphasis and asks markdown-it which marks it paired, dropping only the
// marks of an emphasis markdown-it would show as asterisks.
//
// The oracle here is markdown-it's rendered output with its tags, through
// the same setup renderMarkdown uses, so lost emphasis shows as a missing
// <strong> or <em> and stray marks show as asterisks.

const md = createMarkdownIt();
const render = (markdown: string): string => md.render(markdown);
const convert = (html: string): string => render(htmlToMarkdown(html));
/** The rendered text with its tags taken out. */
const textOf = (rendered: string): string => rendered.replace(/<[^>]+>/g, "").trim();
/** textToMarkdown's escaping, for the markdown that keeps every emphasis's marks. */
const esc = (s: string): string => s.replace(/[\\`*_[\]~|<>!]/g, "\\$&");

describe("the inputs the review raised render as markdown-it shows them", () => {
  it.each([
    // Punctuation beside the marks: markdown-it would show these asterisks,
    // so the marks go and the text stays.
    ["<p><b>Note:</b>Use M3 screws</p>", "<p>Note:Use M3 screws</p>\n"],
    ["<p>Size<b>(mm)</b></p>", "<p>Size(mm)</p>\n"],
    ["<p>Wow<b>!</b>great</p>", "<p>Wow!great</p>\n"],
    ["<p>see<i>[1]</i>here</p>", "<p>see[1]here</p>\n"],
    ["<p><b>Hinweis\u2026</b>Text</p>", "<p>Hinweis\u2026Text</p>\n"],
    ["<p><b>5\u20ac</b>each</p>", "<p>5\u20aceach</p>\n"],
    ["<p>Gr\u00f6\u00dfe<i>\u00bbS\u00ab</i></p>", "<p>Gr\u00f6\u00dfe\u00bbS\u00ab</p>\n"],
    ["<p><b>Note:</b><i>Use</i> it</p>", "<p>Note:<em>Use</em> it</p>\n"],
    ["<p><b><i>Note:</i></b>Use</p>", "<p>Note:Use</p>\n"],
    ["<p>Size<b><i>(mm)</i></b></p>", "<p>Size(mm)</p>\n"],
    // An emphasis nested at another's edge (round 1).
    ["<p>foo<b><i>bar</i></b>baz</p>", "<p>foo<em><strong>bar</strong></em>baz</p>\n"],
    ["<p><b>bar<i>x</i></b>baz</p>", "<p><strong>bar<em>x</em></strong>baz</p>\n"],
    ["<p>a<b><i>x</i>y</b>c</p>", "<p>a<strong><em>x</em>y</strong>c</p>\n"],
    ["<p>a<b>y<i>x</i></b>c</p>", "<p>a<strong>y<em>x</em></strong>c</p>\n"],
    ["<p>Size <b><i>(mm)</i></b>.</p>", "<p>Size <em><strong>(mm)</strong></em>.</p>\n"],
    // Bold holding two or more italics (round 2, issue #348).
    [
      "<p><b>a<i>PLA</i>b<i>PETG</i></b>c</p>",
      "<p><strong>a<em>PLA</em>b<em>PETG</em></strong>c</p>\n",
    ],
    [
      "<p>foo<b><i>a</i> and <i>b</i></b></p>",
      "<p>foo<strong><em>a</em> and <em>b</em></strong></p>\n",
    ],
    [
      "<p><b>a<i>PLA</i>b<i>PETG</i>c<i>TPU</i></b>d</p>",
      "<p><strong>a<em>PLA</em>b<em>PETG</em>c<em>TPU</em></strong>d</p>\n",
    ],
    [
      "<p>x<b><i>PLA</i> or <i>PETG</i> or <i>TPU</i></b>y</p>",
      "<p>x<strong><em>PLA</em> or <em>PETG</em> or <em>TPU</em></strong>y</p>\n",
    ],
    // Two italics back to back are one italic.
    ["<p><b><i>PLA</i><i>PETG</i></b>x</p>", "<p><em><strong>PLAPETG</strong></em>x</p>\n"],
    // CJK text, which has no spaces between words.
    [
      "<p>\u6750\u6599<b>\u63a8\u8350</b>\u6253\u5370</p>",
      "<p>\u6750\u6599<strong>\u63a8\u8350</strong>\u6253\u5370</p>\n",
    ],
    [
      "<p>\u6750\u6599<b>\u63a8\u8350<i>PLA</i>\u6216<i>PETG</i></b>\u6253\u5370</p>",
      "<p>\u6750\u6599<strong>\u63a8\u8350<em>PLA</em>\u6216<em>PETG</em></strong>\u6253\u5370</p>\n",
    ],
    [
      "<p>\u6750\u6599<b>\u63a8\u8350<i>PLA</i>\u3001<i>PETG</i>\u6216<i>TPU</i></b>\u6253\u5370</p>",
      "<p>\u6750\u6599<strong>\u63a8\u8350<em>PLA</em>\u3001<em>PETG</em>\u6216<em>TPU</em></strong>\u6253\u5370</p>\n",
    ],
    ["<p>\u6ce8\u610f<b>\uff1a</b>\u4f7f\u7528</p>", "<p>\u6ce8\u610f\uff1a\u4f7f\u7528</p>\n"],
    [
      "<p>\u6ce8\u610f<b>\u4f7f\u7528\uff1a</b>\u87ba\u4e1d</p>",
      "<p>\u6ce8\u610f\u4f7f\u7528\uff1a\u87ba\u4e1d</p>\n",
    ],
    // Nested emphasis of the same kind (issue #346): the inner one's marks go.
    ["<p><b>Size<b>x</b></b></p>", "<p><strong>Sizex</strong></p>\n"],
    ["<p><i>y<i>x</i></i></p>", "<p><em>yx</em></p>\n"],
    // Back to back (issue #346): different kinds pair as written, the same
    // kind is one emphasis.
    ["<p><b>a</b><i>b</i></p>", "<p><strong>a</strong><em>b</em></p>\n"],
    ["<p><i>a</i><b>b</b></p>", "<p><em>a</em><strong>b</strong></p>\n"],
    ["<p><b>a</b><b>b</b></p>", "<p><strong>ab</strong></p>\n"],
    ["<p><i>a</i><i>b</i></p>", "<p><em>ab</em></p>\n"],
    // An asterisk in a link address is not a mark.
    [
      '<p><a href="https://example.com/a*b">x</a> <b>y</b>z</p>',
      '<p><a href="https://example.com/a*b">x</a> <strong>y</strong>z</p>\n',
    ],
  ])("%s", (html, want) => {
    expect(convert(html)).toBe(want);
  });
});

describe("emphasis is kept where markdown-it reads it", () => {
  it.each([
    ["<p><b>Note:</b> Use</p>", "<p><strong>Note:</strong> Use</p>\n"],
    ["<p><b>Note:</b>, then</p>", "<p><strong>Note:</strong>, then</p>\n"],
    ["<p><b>Note:</b></p>", "<p><strong>Note:</strong></p>\n"],
    ["<p>(<b>mm</b>)</p>", "<p>(<strong>mm</strong>)</p>\n"],
    ["<p>a<b>b</b>c</p>", "<p>a<strong>b</strong>c</p>\n"],
    ["<p>Size <b>(mm)</b></p>", "<p>Size <strong>(mm)</strong></p>\n"],
    ["<p>Size<b>mm</b>.</p>", "<p>Size<strong>mm</strong>.</p>\n"],
    ["<p><i>e.g.</i> this</p>", "<p><em>e.g.</em> this</p>\n"],
    ["<p>x <b>Note:</b><br>Use</p>", "<p>x <strong>Note:</strong><br>\nUse</p>\n"],
  ])("%s", (html, want) => {
    expect(convert(html)).toBe(want);
  });
});

// Every combination of what comes before, the first and last character
// inside, and what comes after, for each shape. The text must always show as
// written. And wherever markdown-it pairs every mark of the markdown that
// keeps all of them, the converter must write that markdown's emphasis: the
// same rendered output, so no emphasis is lost that markdown-it would show.
describe("emphasis is kept exactly where markdown-it pairs it, whatever is beside it", () => {
  const outside = ["", "a", " ", "(", ".", "1", "\u20ac", "\u63a8"];
  const inside = ["x", "(", ")", ":", "*", "\u2026", "\u63a8"];
  const shapes: Array<[string, (a: string, z: string) => [string, string]]> = [
    ["bold", (a, z) => [`<b>${a}w${z}</b>`, `**${esc(a)}w${esc(z)}**`]],
    ["italic", (a, z) => [`<i>${a}w${z}</i>`, `*${esc(a)}w${esc(z)}*`]],
    [
      "italic at both edges of bold",
      (a, z) => [`<b><i>${a}w${z}</i></b>`, `***${esc(a)}w${esc(z)}***`],
    ],
    [
      "italic at the start of bold",
      (a, z) => [`<b><i>${a}w</i>${z}</b>`, `***${esc(a)}w*${esc(z)}**`],
    ],
    [
      "italic at the end of bold",
      (a, z) => [`<b>${a}<i>w${z}</i></b>`, `**${esc(a)}*w${esc(z)}***`],
    ],
    [
      "bold holding two italics",
      (a, z) => [`<b>${a}<i>P</i>w<i>Q</i>${z}</b>`, `**${esc(a)}*P*w*Q*${esc(z)}**`],
    ],
    [
      "bold holding three italics",
      (a, z) => [`<b><i>${a}</i>x<i>y</i>w<i>${z}</i></b>`, `***${esc(a)}*x*y*w*${esc(z)}***`],
    ],
  ];
  it.each(shapes)("%s", (_name, shape) => {
    const failures: string[] = [];
    for (const before of outside) {
      for (const first of inside) {
        for (const last of inside) {
          for (const after of outside) {
            const [inner, innerMarkdown] = shape(first, last);
            const html = `<p>${before}${inner}${after}</p>`;
            const allMarks = render(`${before}${innerMarkdown}${after}`);
            const written = textOf(`${before}${inner}${after}`);
            const got = convert(html);
            if (textOf(got) !== written) failures.push(`${html} shows ${JSON.stringify(got)}`);
            else if (textOf(allMarks) === written && got !== allMarks) {
              failures.push(
                `${html} gives ${JSON.stringify(got)}, not ${JSON.stringify(allMarks)}`,
              );
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("the converter's placeholders cannot come from the description", () => {
  const pua = (code: number): string => String.fromCharCode(code);
  it("drops private-use placeholder characters in text, written or as references", () => {
    expect(convert(`<p>a${pua(0xe000)}b${pua(0xe001)}c</p>`)).toBe("<p>abc</p>\n");
    expect(convert("<p>a&#xe002;b&#xe003;c&#57348;d</p>")).toBe("<p>abcd</p>\n");
  });
});
