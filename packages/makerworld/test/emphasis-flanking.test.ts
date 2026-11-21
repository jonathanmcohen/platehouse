import { describe, expect, it } from "vitest";
import { createMarkdownIt, htmlToMarkdown } from "../src/markdown.js";

// Bold or italic text pressed against punctuation (0.1.0 release review).
// CommonMark's flanking rules decide whether ** or * is emphasis: an opening
// mark followed by punctuation must have whitespace, punctuation or the line
// start before it, and a closing mark after punctuation must have whitespace,
// punctuation or the end after it. The converter once wrapped every bold or
// italic run in marks without checking, so "<b>Note:</b>Use" became
// "**Note:**Use", which markdown-it shows with its asterisks. Where the marks
// would not be read as emphasis the converter now drops them and keeps the
// text. Every case renders through the same markdown-it setup as
// renderMarkdown, so the renderer, not this file, decides what is emphasis.

const md = createMarkdownIt();
const render = (markdown: string): string => md.render(markdown);
/** The rendered text with its tags taken out. */
const shown = (html: string): string =>
  render(htmlToMarkdown(html))
    .replace(/<[^>]+>/g, "")
    .trim();

describe("emphasis beside punctuation never shows its marks", () => {
  it("drops the marks of bold text that ends in punctuation right before a letter", () => {
    const out = htmlToMarkdown("<p><b>Note:</b>Use M3 screws</p>");
    expect(out).toBe("Note:Use M3 screws");
    expect(render(out)).toBe("<p>Note:Use M3 screws</p>\n");
  });

  it("drops the marks of bold text that starts with punctuation right after a letter", () => {
    const out = htmlToMarkdown("<p>Size<b>(mm)</b></p>");
    expect(out).toBe("Size(mm)");
    expect(render(out)).toBe("<p>Size(mm)</p>\n");
  });

  it("drops the marks when the converter's own escaping puts punctuation beside them", () => {
    expect(shown("<p>Wow<b>!</b>great</p>")).toBe("Wow!great");
    expect(shown("<p>see<i>[1]</i>here</p>")).toBe("see[1]here");
  });

  it("counts Unicode punctuation and symbols as punctuation, as markdown-it does", () => {
    expect(shown("<p><b>Hinweis\u2026</b>Text</p>")).toBe("Hinweis\u2026Text");
    expect(shown("<p><b>5\u20ac</b>each</p>")).toBe("5\u20aceach");
    expect(shown("<p>Gr\u00f6\u00dfe<i>\u00bbS\u00ab</i></p>")).toBe(
      "Gr\u00f6\u00dfe\u00bbS\u00ab",
    );
  });

  it("drops the marks when an emphasis or a link follows straight after", () => {
    const em = render(htmlToMarkdown("<p><b>Note:</b><i>Use</i> it</p>"));
    expect(em).toBe("<p>Note:<em>Use</em> it</p>\n");
    const link = render(
      htmlToMarkdown('<p><b>Note:</b><a href="https://example.com/x">Use</a></p>'),
    );
    expect(link).not.toContain("*");
    expect(link).toContain('<a href="https://example.com/x">Use</a>');
  });

  it("drops the marks of nested emphasis that closes at the same place", () => {
    expect(shown("<p><b><i>Note:</i></b>Use</p>")).toBe("Note:Use");
    expect(shown("<p>Size<b><i>(mm)</i></b></p>")).toBe("Size(mm)");
  });

  // Every combination of what comes before, the first and last character
  // inside, and what comes after: the text must show exactly as written.
  it.each(["b", "i", "strong", "em"])("shows <%s> text as written whatever is beside it", (tag) => {
    const outside = ["", "a", " ", "(", ".", "\u00e9", "1", "\u20ac"];
    const inside = ["x", "(", ")", ":", "!", "*", "\u2026", "\u20ac", "\u00e9"];
    const failures: string[] = [];
    for (const before of outside) {
      for (const first of inside) {
        for (const last of inside) {
          for (const after of outside) {
            const html = `<p>${before}<${tag}>${first}w${last}</${tag}>${after}</p>`;
            const want = `${before}${first}w${last}${after}`.trim();
            const got = shown(html);
            if (got !== want) failures.push(`${html} -> ${JSON.stringify(got)}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  // The same with an emphasis nested at the outer one's edge, where the two
  // sets of marks meet and markdown-it reads them as one run.
  it.each([
    ["inner at both edges", (a: string, z: string) => `<b><i>${a}w${z}</i></b>`],
    ["inner at the start", (a: string, z: string) => `<b><i>${a}w</i>${z}</b>`],
    ["inner at the end", (a: string, z: string) => `<b>${a}<i>w${z}</i></b>`],
  ])("shows nested emphasis text as written, %s", (_name, inner) => {
    const outside = ["", "a", " ", "(", ".", "\u20ac"];
    const inside = ["x", "(", ")", ":", "*", "\u2026"];
    const failures: string[] = [];
    for (const before of outside) {
      for (const first of inside) {
        for (const last of inside) {
          for (const after of outside) {
            const html = `<p>${before}${inner(first, last)}${after}</p>`;
            const want = `${before}${first}w${last}${after}`.trim();
            const got = shown(html);
            if (got !== want) failures.push(`${html} -> ${JSON.stringify(got)}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("emphasis beside punctuation is kept where markdown-it reads it", () => {
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
    // An inner emphasis's marks at the outer one's edge join its marks in one
    // run, and markdown-it checks the characters outside the whole run.
    ["<p>foo<b><i>bar</i></b>baz</p>", "<p>foo<em><strong>bar</strong></em>baz</p>\n"],
    ["<p><b>bar<i>x</i></b>baz</p>", "<p><strong>bar<em>x</em></strong>baz</p>\n"],
    ["<p>a<b><i>x</i>y</b>c</p>", "<p>a<strong><em>x</em>y</strong>c</p>\n"],
    ["<p>a<b>y<i>x</i></b>c</p>", "<p>a<strong>y<em>x</em></strong>c</p>\n"],
    ["<p>Size <b><i>(mm)</i></b>.</p>", "<p>Size <em><strong>(mm)</strong></em>.</p>\n"],
  ])("%s", (html, want) => {
    expect(render(htmlToMarkdown(html))).toBe(want);
  });
});
