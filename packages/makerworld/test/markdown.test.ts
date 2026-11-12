import { describe, expect, it } from "vitest";
import { createMarkdownIt, htmlToMarkdown } from "../src/markdown.js";
import { DESIGNER_PAYLOADS, htmlEscape } from "./support/payloads.js";

// Ported by behaviour from automation Manyfold/makerworld-metadata
// test/metadata.test.mjs at 1ce8c57 (the htmlToMarkdown cases). The source
// escaped for Kramdown 2.5.2 and kramdown-parser-gfm 1.1.0. Platehouse renders
// with markdown-it 15 (CommonMark plus GFM tables and strikethrough), so the
// escaping was re-derived for markdown-it (build plan Task 7, requirements
// lesson 5), and every expected string below is the markdown-it form.
//
// What changed from the Kramdown rules, each case marked "CommonMark" below:
// - < and > are backslash-escaped, not written as &lt; and &gt;, because
//   markdown-it reads <https://...> as a link even with html off.
// - & is escaped where it would start an entity, because markdown-it decodes
//   &lt; and the rest in text; an entity the converter does not decode is
//   passed through so markdown-it decodes it.
// - $ { : ^ are left alone: markdown-it has no math, attribute lists,
//   definition lists or end-of-block markers.
// - "N)" at a line's start is escaped like "N.": CommonMark reads both as an
//   ordered list item.
// - A list nested in an ordered item is indented to the item's text (three
//   spaces under "1. "), which is where CommonMark looks for it.
// - A table whose later rows have more cells than the first gets empty header
//   cells, because markdown-it drops cells past the header's count.
// Many cases also render the result through the same markdown-it setup that
// renderMarkdown uses, so the escaping is checked against the real renderer.

const md = createMarkdownIt();
const render = (markdown: string): string => md.render(markdown);
// The same setup with markdown-it's image rule back on. renderMarkdown never
// renders an image (Jon, 2026-11-08), so a "!" the converter left bare before
// a link's [ no longer shows there; this renderer still turns it into an
// <img>, so the escaping checks below keep their teeth.
const withImages = createMarkdownIt().enable("image");
const renderWithImages = (markdown: string): string => withImages.render(markdown);
const para = (inner: string): string => `<p>${inner}</p>\n`;

describe("htmlToMarkdown: ported cases", () => {
  it("htmlToMarkdown: headings, emphasis and line breaks", () => {
    const out = htmlToMarkdown(
      "<h1>Top</h1><h3>Sub</h3><p>a <strong>bold</strong> and <em>it</em><br>next <b>b</b> <i>i</i></p>",
    );
    expect(out).toBe("# Top\n\n### Sub\n\na **bold** and *it*\nnext **b** *i*");
    expect(render(out)).toBe(
      "<h1>Top</h1>\n<h3>Sub</h3>\n<p>a <strong>bold</strong> and <em>it</em><br>\nnext <strong>b</strong> <em>i</em></p>\n",
    );
  });

  it("htmlToMarkdown: emphasis markers hug the text, empty emphasis is dropped", () => {
    expect(htmlToMarkdown("<p>x<strong> bold </strong>y<em></em></p>")).toBe("x **bold** y");
  });

  it("htmlToMarkdown: unordered and ordered lists", () => {
    const out = htmlToMarkdown(
      "<p>Kit:</p><ul><li>one</li><li><p>two</p></li></ul><ol><li>first</li><li>second</li></ol>",
    );
    expect(out).toBe("Kit:\n\n- one\n- two\n\n1. first\n2. second");
    expect(render(out)).toBe(
      "<p>Kit:</p>\n<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n<ol>\n<li>first</li>\n<li>second</li>\n</ol>\n",
    );
  });

  it("htmlToMarkdown: a nested list is indented under its item", () => {
    const out = htmlToMarkdown("<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>");
    expect(out).toBe("- a\n  - b\n- c");
    expect(render(out)).toBe("<ul>\n<li>a\n<ul>\n<li>b</li>\n</ul>\n</li>\n<li>c</li>\n</ul>\n");
    // CommonMark: under "1. " the nested list needs three spaces, not two.
    const ordered = htmlToMarkdown("<ol><li>a<ul><li>b</li></ul></li><li>c</li></ol>");
    expect(ordered).toBe("1. a\n   - b\n2. c");
    expect(render(ordered)).toBe(
      "<ol>\n<li>a\n<ul>\n<li>b</li>\n</ul>\n</li>\n<li>c</li>\n</ol>\n",
    );
    const deep = htmlToMarkdown("<ol><li>a<ol><li>b<ul><li>c</li></ul></li></ol></li></ol>");
    expect(deep).toBe("1. a\n   1. b\n      - c");
    expect(render(deep)).toBe(
      "<ol>\n<li>a\n<ol>\n<li>b\n<ul>\n<li>c</li>\n</ul>\n</li>\n</ol>\n</li>\n</ol>\n",
    );
  });

  // PR #24 review: text after a nested list in the same item was written at
  // column 0, where CommonMark reads it as a lazy continuation of the nested
  // item's paragraph. It needs a blank line and the outer item's indent.
  it("text after a nested list stays in its own item, not the nested one", () => {
    const out = htmlToMarkdown("<ul><li>a<ul><li>b</li></ul>c</li></ul>");
    expect(out).toBe("- a\n  - b\n\n  c");
    expect(render(out)).toBe(
      "<ul>\n<li>\n<p>a</p>\n<ul>\n<li>b</li>\n</ul>\n<p>c</p>\n</li>\n</ul>\n",
    );
    // Under "1. " the text is indented three spaces.
    const ordered = htmlToMarkdown("<ol><li>a<ul><li>b</li></ul>c</li><li>d</li></ol>");
    expect(ordered).toBe("1. a\n   - b\n\n   c\n2. d");
    expect(render(ordered)).toBe(
      "<ol>\n<li>\n<p>a</p>\n<ul>\n<li>b</li>\n</ul>\n<p>c</p>\n</li>\n<li>\n<p>d</p>\n</li>\n</ol>\n",
    );
    // Each level returns to its own item.
    const deep = htmlToMarkdown("<ul><li>a<ul><li>b<ul><li>x</li></ul>y</li></ul>z</li></ul>");
    expect(deep).toBe("- a\n  - b\n    - x\n\n    y\n\n  z");
    expect(render(deep)).toBe(
      "<ul>\n<li>\n<p>a</p>\n<ul>\n<li>\n<p>b</p>\n<ul>\n<li>x</li>\n</ul>\n<p>y</p>\n</li>\n</ul>\n<p>z</p>\n</li>\n</ul>\n",
    );
    // Emphasis, a line break or a paragraph tag before the text changes nothing.
    expect(htmlToMarkdown("<ul><li>a<ul><li>b</li></ul><b>c</b></li></ul>")).toBe(
      "- a\n  - b\n\n  **c**",
    );
    expect(htmlToMarkdown("<ul><li>a<ul><li>b</li></ul><br><p>c</p></li></ul>")).toBe(
      "- a\n  - b\n\n  c",
    );
    // Block syntax in that text is still escaped, so it stays text.
    const hash = htmlToMarkdown("<ul><li>a<ul><li>b</li></ul># c</li></ul>");
    expect(hash).toBe("- a\n  - b\n\n  \\# c");
    expect(render(hash)).toContain("<p># c</p>");
    // Only whitespace after the nested list adds nothing: the list stays tight.
    expect(htmlToMarkdown("<ul><li>a<ul><li>b</li></ul> </li><li>d</li></ul>")).toBe(
      "- a\n  - b\n- d",
    );
  });

  // PR #24 review: a heading or table in a list item was written at column 0,
  // which ends the list, and the item's text after it went to column 0 too.
  // In an ordered list the next item's marker then sat straight under that
  // paragraph, and markdown-it lets an ordered list interrupt a paragraph
  // only when it starts at 1, so the next item rendered as text ("b 2. c").
  // The heading or table, and the text after it, now stay in the item: a
  // blank line, then the item's indent.
  describe("a heading or table in a list item, and the text after it, stay in the item", () => {
    const loose = (tag: "ol" | "ul", first: string): string =>
      `<${tag}>\n<li>\n<p>a</p>\n${first}\n<p>b</p>\n</li>\n<li>\n<p>c</p>\n</li>\n</${tag}>\n`;
    const H3 = "<h3>H</h3>";
    const ONE_CELL = "<table>\n<thead>\n<tr>\n<th>x</th>\n</tr>\n</thead>\n</table>";
    const TWO_ROWS =
      "<table>\n<thead>\n<tr>\n<th>x</th>\n<th>y</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>1</td>\n<td></td>\n</tr>\n</tbody>\n</table>";

    it.each([
      [
        "a heading, ordered",
        "<ol><li>a<h3>H</h3>b</li><li>c</li></ol>",
        "1. a\n\n   ### H\n\n   b\n2. c",
        loose("ol", H3),
      ],
      [
        "a heading, unordered",
        "<ul><li>a<h3>H</h3>b</li><li>c</li></ul>",
        "- a\n\n  ### H\n\n  b\n- c",
        loose("ul", H3),
      ],
      [
        "a table, ordered",
        "<ol><li>a<table><tr><td>x</td></tr></table>b</li><li>c</li></ol>",
        "1. a\n\n   | x |\n   | --- |\n\n   b\n2. c",
        loose("ol", ONE_CELL),
      ],
      [
        "a table, unordered, its header padded",
        "<ul><li>a<table><tr><td>x</td><td>y</td></tr><tr><td>1</td></tr></table>b</li><li>c</li></ul>",
        "- a\n\n  | x | y |\n  | --- | --- |\n  | 1 |\n\n  b\n- c",
        loose("ul", TWO_ROWS),
      ],
    ])("%s", (_name, html, markdown, rendered) => {
      const out = htmlToMarkdown(html);
      expect(out).toBe(markdown);
      expect(render(out)).toBe(rendered);
    });

    it("in a nested item, at that item's indent", () => {
      const out = htmlToMarkdown(
        "<ol><li>a<ol><li>n<h3>H</h3>m</li><li>o</li></ol>b</li><li>c</li></ol>",
      );
      expect(out).toBe("1. a\n   1. n\n\n      ### H\n\n      m\n   2. o\n\n   b\n2. c");
      expect(render(out)).toBe(
        "<ol>\n<li>\n<p>a</p>\n<ol>\n<li>\n<p>n</p>\n<h3>H</h3>\n<p>m</p>\n</li>\n<li>\n<p>o</p>\n</li>\n</ol>\n<p>b</p>\n</li>\n<li>\n<p>c</p>\n</li>\n</ol>\n",
      );
    });

    it("emphasis, block syntax or nothing after the heading", () => {
      expect(htmlToMarkdown("<ol><li>a<h3>H</h3><b>b</b> more</li><li>c</li></ol>")).toBe(
        "1. a\n\n   ### H\n\n   **b** more\n2. c",
      );
      const escaped = htmlToMarkdown("<ol><li>a<h3>H</h3>3. b</li><li>c</li></ol>");
      expect(escaped).toBe("1. a\n\n   ### H\n\n   3\\. b\n2. c");
      expect(render(escaped)).toContain("<p>3. b</p>");
      const last = htmlToMarkdown("<ol><li>a<h3>H</h3></li><li>c</li></ol>");
      expect(last).toBe("1. a\n\n   ### H\n\n2. c");
      expect(render(last)).toBe(
        "<ol>\n<li>\n<p>a</p>\n<h3>H</h3>\n</li>\n<li>\n<p>c</p>\n</li>\n</ol>\n",
      );
      // An empty heading writes nothing, and the text after it stays in the item.
      const empty = htmlToMarkdown("<ol><li>a<h3></h3>b</li><li>c</li></ol>");
      expect(empty).toBe("1. a\n\n   b\n2. c");
      expect(render(empty)).toBe(
        "<ol>\n<li>\n<p>a</p>\n<p>b</p>\n</li>\n<li>\n<p>c</p>\n</li>\n</ol>\n",
      );
    });

    // An item whose first content is a heading or table loses its bare marker
    // (see "leaves no bare marker" below), so the block leaves that list, as
    // before. The text after it follows the block, and the next item starts
    // after a blank line, where markdown-it starts a new list at its number.
    it.each([
      ["a heading", "<h3>H</h3>", "### H", H3],
      [
        "a table",
        "<table><tr><td>t</td></tr></table>",
        "| t |\n| --- |",
        ONE_CELL.replace("x", "t"),
      ],
    ])("%s first in an ordered item", (_name, block, blockMd, blockHtml) => {
      const out = htmlToMarkdown(`<ol><li>x</li><li>${block}b</li><li>c</li></ol>`);
      expect(out).toBe(`1. x\n\n${blockMd}\n\nb\n\n2. c`);
      expect(render(out)).toBe(
        `<ol>\n<li>x</li>\n</ol>\n${blockHtml}\n<p>b</p>\n<ol start="2">\n<li>c</li>\n</ol>\n`,
      );
    });

    it("a heading first in a nested ordered item stays in the outer item", () => {
      const out = htmlToMarkdown(
        "<ol><li>a<ol><li><h3>H</h3>m</li><li>o</li></ol>b</li><li>c</li></ol>",
      );
      expect(out).toBe("1. a\n\n   ### H\n\n   m\n\n   1. o\n\n   b\n2. c");
      expect(render(out)).toBe(
        "<ol>\n<li>\n<p>a</p>\n<h3>H</h3>\n<p>m</p>\n<ol>\n<li>o</li>\n</ol>\n<p>b</p>\n</li>\n<li>\n<p>c</p>\n</li>\n</ol>\n",
      );
    });
  });

  it("htmlToMarkdown: a table becomes a pipe table with the first row as header", () => {
    const html =
      "<p>Sizes:</p><table><tbody>" +
      "<tr><td><p><strong>Code</strong></p></td><td><p><strong>Pad Size</strong></p></td></tr>" +
      "<tr><td><p>1</p></td><td><p>Small pad<br>with glue | tape</p></td></tr>" +
      "<tr></tr>" +
      "<tr><td>2</td><td>&lt;X$9</td></tr>" +
      "</tbody></table><p>After.</p>";
    const out = htmlToMarkdown(html);
    // CommonMark: < is \<, and $ needs no escape.
    expect(out).toBe(
      "Sizes:\n\n| **Code** | **Pad Size** |\n| --- | --- |\n| 1 | Small pad with glue \\| tape |\n| 2 | \\<X$9 |\n\nAfter.",
    );
    expect(render(out)).toBe(
      "<p>Sizes:</p>\n<table>\n<thead>\n<tr>\n<th><strong>Code</strong></th>\n<th><strong>Pad Size</strong></th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>1</td>\n<td>Small pad with glue | tape</td>\n</tr>\n<tr>\n<td>2</td>\n<td>&lt;X$9</td>\n</tr>\n</tbody>\n</table>\n<p>After.</p>\n",
    );
  });

  it("block syntax: the reviewer's tilde fence stays text", () => {
    const out = htmlToMarkdown("<p>Notes<br>~~~~~~</p><p>Mix 2*3</p><p>~~~~~~</p>");
    expect(out).toBe("Notes\n\\~\\~\\~\\~\\~\\~\n\nMix 2\\*3\n\n\\~\\~\\~\\~\\~\\~");
    expect(render(out)).toBe("<p>Notes<br>\n~~~~~~</p>\n<p>Mix 2*3</p>\n<p>~~~~~~</p>\n");
  });

  it("block syntax: a backtick fence stays text", () => {
    const out = htmlToMarkdown("<p>```</p><p>x</p><p>```</p>");
    expect(out).toBe("\\`\\`\\`\n\nx\n\n\\`\\`\\`");
    expect(render(out)).toBe("<p>```</p>\n<p>x</p>\n<p>```</p>\n");
  });

  it("block syntax: a line starting with # is not a heading", () => {
    expect(htmlToMarkdown("<p># of pins: 12</p>")).toBe("\\# of pins: 12");
    expect(render("\\# of pins: 12")).toBe(para("# of pins: 12"));
    expect(htmlToMarkdown("<p>Intro<br># of pins</p>")).toBe("Intro\n\\# of pins");
    expect(render("Intro\n\\# of pins")).toBe(para("Intro<br>\n# of pins"));
    expect(htmlToMarkdown("<p>  ## spaced</p>")).toBe("\\## spaced");
  });

  it("block syntax: a line starting with > is not a blockquote", () => {
    // CommonMark: > is backslash-escaped, at a line's start and anywhere else.
    const out = htmlToMarkdown("<p>&gt; quoted<br>> raw</p>");
    expect(out).toBe("\\> quoted\n\\> raw");
    expect(render(out)).toBe(para("&gt; quoted<br>\n&gt; raw"));
  });

  it("block syntax: lines starting with -, + or a number and a dot are not list items", () => {
    const out = htmlToMarkdown("<p>- a<br>+ b<br>12. c</p>");
    expect(out).toBe("\\- a\n\\+ b\n12\\. c");
    expect(render(out)).toBe(para("- a<br>\n+ b<br>\n12. c"));
    // Inside a list item the text is parsed as blocks too.
    const inList = htmlToMarkdown("<ul><li>3. foo</li><li># bar</li></ul>");
    expect(inList).toBe("- 3\\. foo\n- \\# bar");
    expect(render(inList)).toBe("<ul>\n<li>3. foo</li>\n<li># bar</li>\n</ul>\n");
    expect(htmlToMarkdown("<ol><li>- x</li></ol>")).toBe("1. \\- x");
    // CommonMark: "N)" is an ordered list marker too.
    const paren = htmlToMarkdown("<p>1) c<br>10) d</p><ul><li>2) e</li></ul>");
    expect(paren).toBe("1\\) c\n10\\) d\n\n- 2\\) e");
    expect(render(paren)).toBe("<p>1) c<br>\n10) d</p>\n<ul>\n<li>2) e</li>\n</ul>\n");
  });

  it("block syntax: a horizontal rule stays text", () => {
    expect(htmlToMarkdown("<p>---</p>")).toBe("\\---");
    expect(htmlToMarkdown("<p>* * *</p>")).toBe("\\* \\* \\*");
    expect(htmlToMarkdown("<p>___</p>")).toBe("\\_\\_\\_");
    expect(render("\\---\n\n\\* \\* \\*\n\n\\_\\_\\_")).toBe(
      "<p>---</p>\n<p>* * *</p>\n<p>___</p>\n",
    );
  });

  it("block syntax: an = or - line under text is not a setext heading", () => {
    expect(htmlToMarkdown("<p>Title<br>===</p>")).toBe("Title\n\\===");
    expect(render("Title\n\\===")).toBe(para("Title<br>\n==="));
    expect(htmlToMarkdown("<p>Title<br>--</p>")).toBe("Title\n\\--");
    expect(render("Title\n\\--")).toBe(para("Title<br>\n--"));
  });

  it("block syntax: a pipe in text is not a table row", () => {
    expect(htmlToMarkdown("<p>a | b</p>")).toBe("a \\| b");
    expect(htmlToMarkdown("<p>| x |</p>")).toBe("\\| x \\|");
    // A header row and a delimiter row made of text stay two lines of text.
    const out = htmlToMarkdown("<p>a | b<br>--- | ---</p>");
    expect(out).toBe("a \\| b\n\\--- \\| ---");
    expect(render(out)).toBe(para("a | b<br>\n--- | ---"));
  });

  it("block syntax: ~~ pairs are not strikethrough", () => {
    const out = htmlToMarkdown("<p>~~5m, glue ~~9 dabs</p>");
    expect(out).toBe("\\~\\~5m, glue \\~\\~9 dabs");
    expect(render(out)).toBe(para("~~5m, glue ~~9 dabs"));
  });

  it("block syntax: definition lists, math, attribute lists and end-of-block markers stay text", () => {
    // CommonMark: markdown-it has none of these, so nothing is escaped.
    expect(htmlToMarkdown("<p>Term<br>: def</p>")).toBe("Term\n: def");
    expect(render("Term\n: def")).toBe(para("Term<br>\n: def"));
    expect(htmlToMarkdown("<p>$$x$$ costs US$5</p>")).toBe("$$x$$ costs US$5");
    expect(render("$$x$$ costs US$5")).toBe(para("$$x$$ costs US$5"));
    expect(htmlToMarkdown("<p>{:.big} text</p>")).toBe("{:.big} text");
    expect(render("{:.big} text")).toBe(para("{:.big} text"));
    expect(htmlToMarkdown("<p>a<br>^</p>")).toBe("a\n^");
    expect(render("a\n^")).toBe(para("a<br>\n^"));
  });

  it("block syntax: the converter's own markup is not escaped", () => {
    const out = htmlToMarkdown(
      '<h2>Kit</h2><ul><li>one</li></ul><ol><li>first</li></ol><p><strong># x</strong> and <a href="https://e.test">- y</a></p>',
    );
    expect(out).toBe("## Kit\n\n- one\n\n1. first\n\n**# x** and [- y](https://e.test/)");
    expect(render(out)).toBe(
      '<h2>Kit</h2>\n<ul>\n<li>one</li>\n</ul>\n<ol>\n<li>first</li>\n</ol>\n<p><strong># x</strong> and <a href="https://e.test/">- y</a></p>\n',
    );
    // A blank emphasis at the start of a line leaves nothing behind.
    expect(htmlToMarkdown("<p><strong> </strong>x</p>")).toBe("x");
  });

  it("block syntax: whitespace-only text before a line's text does not use up the line start", () => {
    expect(htmlToMarkdown("<p>&nbsp;<span># x</span></p>")).toBe("\\# x");
    expect(htmlToMarkdown("<p><strong> </strong>- x</p>")).toBe("\\- x");
    expect(
      htmlToMarkdown("<p>&nbsp;<span># of pins</span></p><p><strong> </strong>- 2 pcs</p>"),
    ).toBe("\\# of pins\n\n\\- 2 pcs");
    expect(htmlToMarkdown("<ul><li>&nbsp;<span>+ x</span></li></ul>")).toBe("- \\+ x");
    expect(htmlToMarkdown("<p>a<br>&nbsp;<em> </em>1. x</p>")).toBe("a\n1\\. x");
  });

  it("block syntax: a paragraph indented with non-breaking spaces is not a code block", () => {
    expect(htmlToMarkdown("<p>Intro</p><p>&nbsp; &nbsp; Step 1</p>")).toBe("Intro\n\nStep 1");
    expect(htmlToMarkdown("<p>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;# Step</p>")).toBe("\\# Step");
    // Spaces spread over several pieces of text, and after a line break.
    expect(
      htmlToMarkdown(
        "<p>a</p><p><span>&nbsp;</span><span>&nbsp;</span><span>&nbsp;</span><span>&nbsp;</span>b</p>",
      ),
    ).toBe("a\n\nb");
    expect(htmlToMarkdown("<p>a<br>&nbsp; &nbsp; b</p>")).toBe("a\nb");
    expect(htmlToMarkdown("<ul><li>&nbsp; &nbsp; &nbsp;one</li></ul>")).toBe("- one");
    // Inside a line, non-breaking spaces still separate words.
    expect(htmlToMarkdown("<p>a&nbsp;&nbsp;b</p>")).toBe("a b");
  });

  it("htmlToMarkdown: two paragraphs in one table cell or list item keep a space between them", () => {
    expect(
      htmlToMarkdown(
        "<table><tr><td>Item</td></tr><tr><td><p>Small pad</p><p>with glue</p></td></tr></table>",
      ),
    ).toBe("| Item |\n| --- |\n| Small pad with glue |");
    expect(htmlToMarkdown("<ul><li><p>First</p><p>Second</p></li></ul>")).toBe("- First Second");
    expect(htmlToMarkdown("<ol><li><div>a</div><div>b</div></li><li>c</li></ol>")).toBe(
      "1. a b\n2. c",
    );
    // A block that opens straight after the marker or the cell adds nothing.
    expect(htmlToMarkdown("<ul><li><p># x</p></li></ul>")).toBe("- \\# x");
  });

  it("htmlToMarkdown: a list or a heading in a table cell stays on the row", () => {
    // A line break would end the pipe-table row, so a cell writes none.
    expect(
      htmlToMarkdown(
        "<table><tr><td>Parts</td></tr><tr><td><ul><li>a</li><li>b</li></ul></td></tr></table>",
      ),
    ).toBe("| Parts |\n| --- |\n| a; b |");
    expect(
      htmlToMarkdown(
        "<table><tr><td>Steps</td></tr><tr><td>Do:<ol><li>a</li><li>b</li></ol>then</td></tr></table>",
      ),
    ).toBe("| Steps |\n| --- |\n| Do: 1. a; 2. b then |");
    expect(
      htmlToMarkdown(
        "<table><tr><td>x</td></tr><tr><td><ul><li>a<ul><li>b</li></ul></li><li>c</li></ul></td></tr></table>",
      ),
    ).toBe("| x |\n| --- |\n| a b; c |");
    expect(htmlToMarkdown("<table><tr><td>x</td></tr><tr><td>a<h4>b</h4>c</td></tr></table>")).toBe(
      "| x |\n| --- |\n| a b c |",
    );
    // A heading's or item's text is not a line start inside a cell: the row
    // begins with "|", so a # or - there is plain text and stays unescaped.
    const cells = htmlToMarkdown(
      "<table><tr><td><h2># one</h2></td><td><ul><li>- two</li></ul></td></tr></table>",
    );
    expect(cells).toBe("| # one | - two |\n| --- | --- |");
    expect(render(cells)).toBe(
      "<table>\n<thead>\n<tr>\n<th># one</th>\n<th>- two</th>\n</tr>\n</thead>\n</table>\n",
    );
    // A table inside an outer list item leaves that list's numbering alone,
    // and sits in the item at its indent.
    const inItem = htmlToMarkdown(
      "<ol><li>a<table><tr><td><ol><li>x</li><li>y</li></ol></td></tr></table></li><li>b</li></ol>",
    );
    expect(inItem).toBe("1. a\n\n   | 1. x; 2. y |\n   | --- |\n\n2. b");
    expect(render(inItem)).toBe(
      "<ol>\n<li>\n<p>a</p>\n<table>\n<thead>\n<tr>\n<th>1. x; 2. y</th>\n</tr>\n</thead>\n</table>\n</li>\n<li>\n<p>b</p>\n</li>\n</ol>\n",
    );
    // Outside a table a list and a heading are unchanged, and after one they still work.
    expect(
      htmlToMarkdown(
        "<table><tr><td><ul><li>a</li></ul></td></tr></table><h3>H</h3><ul><li>b</li><li>c</li></ul>",
      ),
    ).toBe("| a |\n| --- |\n\n### H\n\n- b\n- c");
  });

  it("htmlToMarkdown: http and https links kept, a javascript: link drops to its text", () => {
    const out = htmlToMarkdown(
      '<p><a href="https://example.com/a?b=1&amp;c=2">site</a> <a href="javascript:alert(1)">click</a> <a href="http://x.test">x</a></p>',
    );
    expect(out).toBe("[site](https://example.com/a?b=1&c=2) click [x](http://x.test/)");
    expect(render(out)).toBe(
      para(
        '<a href="https://example.com/a?b=1&amp;c=2">site</a> click <a href="http://x.test/">x</a>',
      ),
    );
  });

  it("a | in a link address in a table cell does not split the row (#30)", () => {
    const out = htmlToMarkdown(
      '<table><tr><td><a href="https://a.test/?a|b">t</a></td><td>u</td></tr></table>',
    );
    expect(out).toBe("| [t](https://a.test/?a%7Cb) | u |\n| --- | --- |");
    expect(render(out)).toBe(
      '<table>\n<thead>\n<tr>\n<th><a href="https://a.test/?a%7Cb">t</a></th>\n<th>u</th>\n</tr>\n</thead>\n</table>\n',
    );
    expect(htmlToMarkdown('<p><a href="https://a.test/p|q">t</a></p>')).toBe(
      "[t](https://a.test/p%7Cq)",
    );
  });

  it("a description that is only a linked image converts to nothing (#31)", () => {
    expect(
      htmlToMarkdown(
        '<p><a href="https://example.com/big.png"><img src="https://example.com/a.png"></a></p>',
      ),
    ).toBe("");
    expect(
      htmlToMarkdown(
        '<p><a href="https://e.test/1"><img src="a.png"></a> <a href="https://e.test/2"><img src="b.png"></a></p><p>&nbsp;</p>',
      ),
    ).toBe("");
    // Text beside the linked image is kept; the image link itself leaves nothing.
    expect(
      htmlToMarkdown('<p>See <a href="https://e.test/big.png"><img src="a.png"></a> above</p>'),
    ).toBe("See above");
    // A linked image with a caption inside the link keeps the caption as the link text.
    expect(htmlToMarkdown('<p><a href="https://e.test/x"><img src="a.png"> Photo</a></p>')).toBe(
      "[Photo](https://e.test/x)",
    );
  });

  it("htmlToMarkdown: a link address cannot end its link early and add Markdown", () => {
    // The reviewer's example: a ) and a [ in the address would end the link and
    // start a javascript: link after it.
    const out = htmlToMarkdown('<a href="https://a.test/x) [click](javascript:alert(1)">t</a>');
    expect(out).toBe("[t](https://a.test/x%29%20%5Bclick%5D%28javascript:alert%281%29)");
    expect(render(out)).toBe(
      para('<a href="https://a.test/x%29%20%5Bclick%5D%28javascript:alert%281%29">t</a>'),
    );
    // A space, a < or > and a line break from &#10; are encoded too.
    expect(htmlToMarkdown('<a href="https://a.test/a b<c>">t</a>')).toBe(
      "[t](https://a.test/a%20b%3Cc%3E)",
    );
    expect(
      htmlToMarkdown('<a href="https://a.test/?q=1&#10;# x ![i](https://e.test/i.png)">t</a>'),
    ).toBe("[t](https://a.test/?q=1#%20x%20!%5Bi%5D%28https://e.test/i.png%29)");
    // A link with no text produces nothing (#31); its address is not shown.
    expect(htmlToMarkdown('<p>a <a href="https://a.test/x]_y_"></a>b</p>')).toBe("a b");
    // Not an absolute http(s) URL: dropped to its text.
    expect(
      htmlToMarkdown(
        '<a href="https://">t</a> <a href=" JavaScript:alert(1)">u</a> <a href="/rel">v</a>',
      ),
    ).toBe("t u v");
  });

  // The address is read from the attribute named exactly href. The first
  // href= anywhere in the tag once won, so an attribute whose name only ends
  // in href (TinyMCE writes data-mce-href) or an href= inside another
  // attribute's quoted value linked to the wrong address (issue #28).
  it.each([
    [
      "an attribute whose name ends in href, before href",
      '<a data-mce-href="https://a.test/" href="https://b.test/">t</a>',
    ],
    ["data-href before href", "<a data-href='https://a.test/' href=https://b.test/>t</a>"],
    [
      "href= inside another attribute's quoted value",
      '<a title="x href=https://a.test/ y" href="https://b.test/">t</a>',
    ],
    [
      "href= inside a single-quoted value",
      "<a title='href=\"https://a.test/\"' href='https://b.test/'>t</a>",
    ],
    ["an upper-case HREF", '<a class="x" HREF="https://b.test/">t</a>'],
    [
      "two href attributes: the first wins, as in a browser",
      '<a href="https://b.test/" href="https://a.test/">t</a>',
    ],
    ["spaces around the =", '<a target=_blank href = "https://b.test/">t</a>'],
    // A browser starts an attribute name with a stray =, so this name is
    // "=href", not href.
    [
      "an attribute named =href before href",
      '<a =href="https://a.test/" href="https://b.test/">t</a>',
    ],
  ])("a link's address comes from its href attribute: %s", (_name, html) => {
    const out = htmlToMarkdown(html);
    expect(out).toBe("[t](https://b.test/)");
    expect(render(out)).toBe(para('<a href="https://b.test/">t</a>'));
  });

  it.each([
    ["no href at all", '<a data-mce-href="https://a.test/">t</a>'],
    ["href only inside a value", '<a title="href=https://a.test/">t</a>'],
    ["href with no value", '<a href title="https://a.test/">t</a>'],
    // A browser splits attributes only on tab, LF, FF, CR and space, so a
    // no-break space or a BOM is part of the name (PR #121 review).
    ["a no-break space inside a name", '<a data-x\u00a0href="https://a.test/">t</a>'],
    ["a BOM inside a name", '<a data-x\ufeffhref="https://a.test/">t</a>'],
    ["a no-break space before the =", '<a href\u00a0="https://a.test/">t</a>'],
  ])("a link with no href attribute drops to its text: %s", (_name, html) => {
    expect(htmlToMarkdown(html)).toBe("t");
  });

  // A stray quote in a name or a bare value is an ordinary character to a
  // browser, which ends the tag at the first > outside a quoted value, so an
  // href after it is not an attribute of the link and the text after that >
  // shows. A quote that opens a value straight after an = and never closes
  // runs, in a browser, past the tag's > to the end, so no later href is an
  // attribute either; the converter does not hide the rest of the
  // description, it keeps the tag's markup as text. Either way there is no
  // link (PR #121 review). The converter once paired every quote after a tag
  // name, so each of these read as one tag and wrote only "t".
  it.each([
    [
      "an href after a > that ends the tag",
      '<a x"y>z" href="https://a.test/">t</a>',
      'z" href="https://a.test/"\\>t',
    ],
    [
      "an href after a > after a bare value",
      "<a x=y'>z' href=https://a.test/>t</a>",
      "z' href=https://a.test/\\>t",
    ],
    [
      "an unterminated double-quoted value before href",
      "<a b'c=\" d' href=https://a.test/>t</a>",
      "\\<a b'c=\" d' href=https://a.test/\\>t",
    ],
    [
      "an unterminated single-quoted value before href",
      '<a b"c=\' d" href=https://a.test/>t</a>',
      '\\<a b"c=\' d" href=https://a.test/\\>t',
    ],
    [
      "an unterminated quoted href value",
      "<a x'y href=\"https://a.test/ z'>t</a>",
      "\\<a x'y href=\"https://a.test/ z'\\>t",
    ],
  ])("a stray quote before href makes no link: %s", (_name, html, text) => {
    const out = htmlToMarkdown(html);
    expect(out).toBe(text);
    expect(render(out)).not.toMatch(/<a /);
  });

  // A browser's tag name runs to HTML whitespace, / or >, so <a-x>, <a:x> and
  // <a"q"> are other elements, not anchors, and <ul-x> or <h2:x> is no list
  // or heading. The converter once ended the name at the first character that
  // was not a letter or digit, so each of these acted as the element its name
  // began with (issue #131). Each is now an unknown element: its tags are
  // dropped and its text stays, exactly as for a <span>.
  it.each([
    ["a hyphen after a", '<p><a-x href="https://e.test/">t</a-x></p>', "<p><span>t</span></p>"],
    ["a colon after a", '<p><a:x href="https://e.test/">t</a:x></p>', "<p><span>t</span></p>"],
    ["a quote after a", '<p><a"q" href="https://e.test/">t</a></p>', "<p><span>t</span></p>"],
    ["upper case", '<p><A-X HREF="https://e.test/">t</A-X></p>', "<p><span>t</span></p>"],
  ])("a tag whose name only begins with a makes no link: %s", (_name, html, asSpan) => {
    const out = htmlToMarkdown(html);
    expect(out).toBe(htmlToMarkdown(asSpan));
    expect(out).toBe("t");
    expect(render(out)).not.toMatch(/<a /);
  });

  const asSpan = (html: string, name: string): string =>
    html.replaceAll(`<${name}>`, "<span>").replaceAll(`</${name}>`, "</span>");

  // Each would open a list nested in the item; as an unknown element it opens
  // none, so its item is the outer list's next item.
  it.each([
    ["ul-x", "ul", "<ul><li>a<ul-x><li>b</li></ul-x>c</li></ul>"],
    ["ul:x", "ul", "<ul><li>a<ul:x><li>b</li></ul:x>c</li></ul>"],
    ["ol:x", "ol", "<ol><li>a<ol:x><li>b</li></ol:x>c</li><li>d</li></ol>"],
    ['ol"q"', "ol", '<ol><li>a<ol"q"><li>b</li></ol"q">c</li><li>d</li></ol>'],
  ])("a tag whose name only begins with a list name opens no list: %s", (name, list, html) => {
    const out = htmlToMarkdown(html);
    expect(out).toBe(htmlToMarkdown(asSpan(html, name)));
    expect(render(out).match(new RegExp(`<${list}>`, "g"))).toHaveLength(1);
  });

  it.each([
    ["h2:x", "<p>x</p><h2:x>Title</h2:x><p>y</p>"],
    ["h1-x", "<p>x</p><h1-x>Title</h1-x><p>y</p>"],
    ['h3"q"', '<p>x</p><h3"q">Title</h3"q"><p>y</p>'],
  ])("a tag whose name only begins with a heading name is no heading: %s", (name, html) => {
    const out = htmlToMarkdown(html);
    expect(out).toBe(htmlToMarkdown(asSpan(html, name)));
    expect(render(out)).not.toMatch(/<h[1-6]>/);
  });

  // A quote in a tag name is part of the name, and a browser opens a quoted
  // value only straight after an =, so the quote after y below belongs to the
  // attribute name y" and the tag ends at its first >. The converter once
  // paired every quote it met after the name, so an odd number of quotes in a
  // name made the tag fail and its markup show as text, or run past its real
  // > to a later one and hide the text between (PR #121 review).
  it.each([
    ["an odd number of quotes in the name", '<p>a<span"x y">b</span>c</p>', "abc"],
    ["an odd number of quotes in an end tag", '<p>a<span>b</span"x y">c</p>', "abc"],
    ["inch marks after the tag", '<p>a<span"x y">5" tall > 3" wide</span>c</p>', null],
  ])("a quote in a tag name ends the tag where a browser does: %s", (_name, html, text) => {
    const out = htmlToMarkdown(html);
    const plain = html.replaceAll('<span"x y">', "<span>").replaceAll('</span"x y">', "</span>");
    expect(out).toBe(htmlToMarkdown(plain));
    if (text !== null) expect(out).toBe(text);
    expect(out).not.toContain("span");
  });

  // A browser lowercases only A-Z in a tag name. JavaScript's toLowerCase
  // also folds Unicode, and U+212A KELVIN SIGN folds to k, so a name holding
  // it once read as blockquote and wrote a paragraph break.
  it("a tag name is lowercased in ASCII only, so a Kelvin sign makes no blockquote", () => {
    const name = "bloc\u212aquote";
    const html = `<p>a<${name}>b</${name}>c</p>`;
    const out = htmlToMarkdown(html);
    expect(out).toBe(htmlToMarkdown(asSpan(html, name)));
    expect(out).toBe("abc");
  });

  it("a tag whose name only begins with script keeps its text, as a browser shows it", () => {
    expect(htmlToMarkdown("<p>a<script-x>b</script-x>c</p>")).toBe("abc");
  });

  it.each([
    ["a tab", '<a\thref="https://b.test/">t</a>'],
    ["a line feed", '<a\nhref="https://b.test/">t</a>'],
    ["a form feed", '<a\fhref="https://b.test/">t</a>'],
    ["a carriage return", '<a\rhref="https://b.test/">t</a>'],
    ["a slash", '<a/href="https://b.test/">t</a>'],
  ])("a tag name ended by %s is still the element", (_name, html) => {
    expect(htmlToMarkdown(html)).toBe("[t](https://b.test/)");
  });

  it("a heading or list whose name is ended by > is still structure", () => {
    const out = htmlToMarkdown("<h2>T</h2><ul><li>a</li></ul>");
    expect(render(out)).toBe("<h2>T</h2>\n<ul>\n<li>a</li>\n</ul>\n");
  });

  it("a > inside a quoted value does not end the attribute scan", () => {
    const out = htmlToMarkdown("<a title='a>b' href=\"https://b.test/\">t</a>");
    expect(out).toBe("[t](https://b.test/)");
  });

  it("a no-break space inside a bare href value stays in the address", () => {
    const out = htmlToMarkdown("<a href=https://b.test/a\u00a0b>t</a>");
    expect(out).toBe("[t](https://b.test/a%C2%A0b)");
    expect(render(out)).toBe(para('<a href="https://b.test/a%C2%A0b">t</a>'));
  });

  it("htmlToMarkdown: image-only input gives an empty string", () => {
    expect(
      htmlToMarkdown('<p><img src="https://example.com/a.png" alt="a"></p><p>&nbsp;</p>'),
    ).toBe("");
    expect(htmlToMarkdown("   ")).toBe("");
    expect(htmlToMarkdown("")).toBe("");
    expect(htmlToMarkdown(null)).toBe("");
    expect(htmlToMarkdown(undefined)).toBe("");
  });

  it("htmlToMarkdown: script and style contents are dropped, other tags keep their text", () => {
    expect(
      htmlToMarkdown("<div><span>kept</span><script>bad()</script><style>p{}</style></div>"),
    ).toBe("kept");
  });

  it("htmlToMarkdown: entities decoded, blank lines collapsed, result trimmed", () => {
    const out = htmlToMarkdown(
      "<p>&lt;3 &amp; &quot;q&quot; &#x41;&#66; caf&eacute;?</p><p></p><p></p><p>end&hellip;</p>\n\n",
    );
    // CommonMark: the < is \<, and &eacute;, which the converter does not
    // decode, is passed through for markdown-it to decode.
    expect(out).toBe('\\<3 & "q" AB caf&eacute;?\n\nend\u2026');
    expect(render(out)).toBe("<p>&lt;3 &amp; &quot;q&quot; AB caf\u00e9?</p>\n<p>end\u2026</p>\n");
  });

  it("htmlToMarkdown: text that looks like a tag stays text", () => {
    expect(htmlToMarkdown("<p>Fit &lt;Q7&gt; pins</p>")).toBe("Fit \\<Q7\\> pins");
    expect(render("Fit \\<Q7\\> pins")).toBe(para("Fit &lt;Q7&gt; pins"));
    const img = htmlToMarkdown('<p>&lt;img src="https://example.com/a.png"&gt;</p>');
    expect(img).toBe('\\<img src="https://example.com/a.png"\\>');
    expect(render(img)).toBe(para("&lt;img src=&quot;https://example.com/a.png&quot;&gt;"));
    // A lone < that starts no tag, and a > at line start (a Markdown quote).
    expect(htmlToMarkdown("<p>a < b</p><p>&gt; not a quote</p>")).toBe(
      "a \\< b\n\n\\> not a quote",
    );
  });

  it("htmlToMarkdown: Markdown span characters in text stay text", () => {
    expect(htmlToMarkdown("<p>Mix 2*3 and 4*10 parts</p>")).toBe("Mix 2\\*3 and 4\\*10 parts");
    const spans = htmlToMarkdown("<p>**not bold** _x_ `code` [t](https://e.test) a\\b</p>");
    expect(spans).toBe("\\*\\*not bold\\*\\* \\_x\\_ \\`code\\` \\[t\\](https://e.test) a\\\\b");
    expect(render(spans)).toBe(para("**not bold** _x_ `code` [t](https://e.test) a\\b"));
    // The converter's own markup is left alone; escaped text inside it stays escaped.
    const own = htmlToMarkdown(
      '<p><strong>2*3</strong> <em>a_b</em> <a href="https://e.test/a_b">[x]</a></p>',
    );
    expect(own).toBe("**2\\*3** *a\\_b* [\\[x\\]](https://e.test/a_b)");
    expect(render(own)).toBe(
      para('<strong>2*3</strong> <em>a_b</em> <a href="https://e.test/a_b">[x]</a>'),
    );
    // A pipe in a table cell is still escaped after a backslash in the text.
    const cell = htmlToMarkdown("<table><tr><td>a\\|b</td></tr></table>");
    expect(cell).toBe("| a\\\\\\|b |\n| --- |");
    expect(render(cell)).toBe(
      "<table>\n<thead>\n<tr>\n<th>a\\|b</th>\n</tr>\n</thead>\n</table>\n",
    );
  });

  it("an empty list item or heading leaves no bare marker (#26)", () => {
    expect(htmlToMarkdown("<ul><li>a</li><li>&nbsp;</li></ul>")).toBe("- a");
    expect(htmlToMarkdown("<ul><li>Step one</li><li><br></li><li>Step two</li></ul>")).toBe(
      "- Step one\n- Step two",
    );
    // The numbering stays continuous across a dropped ordered item.
    expect(htmlToMarkdown("<ol><li>a</li><li> </li><li>b</li></ol>")).toBe("1. a\n2. b");
    // An item holding only a nested list loses its own bare marker; the nested
    // items sit under the item before it, as editors that write this mean.
    const nested = htmlToMarkdown(
      "<ul><li>a</li><li><ul><li>x</li><li></li></ul></li><li>b</li></ul>",
    );
    expect(nested).toBe("- a\n  - x\n- b");
    expect(render(nested)).toBe("<ul>\n<li>a\n<ul>\n<li>x</li>\n</ul>\n</li>\n<li>b</li>\n</ul>\n");
    expect(htmlToMarkdown("<ul><li><ul><li>x</li></ul></li></ul>")).toBe("- x");
    expect(htmlToMarkdown("<p>Before</p><h2><br></h2><p>After</p>")).toBe("Before\n\nAfter");
    expect(htmlToMarkdown("<h3>&nbsp;</h3>")).toBe("");
  });

  it("a heading, table or line break first in a list item leaves no bare marker", () => {
    expect(htmlToMarkdown("<ul><li>a</li><li><br>text</li></ul>")).toBe("- a\n- text");
    expect(htmlToMarkdown("<ul><li>a</li><li><br><br>text<br>more</li></ul>")).toBe(
      "- a\n- text\nmore",
    );
    expect(htmlToMarkdown("<ul><li>a</li><li><h3>T</h3></li></ul>")).toBe("- a\n\n### T");
    expect(htmlToMarkdown("<ol><li>a</li><li><h3>T</h3></li></ol><ol><li>b</li></ol>")).toBe(
      "1. a\n\n### T\n\n1. b",
    );
    expect(htmlToMarkdown("<ul><li>a</li><li><table><tr><td>x</td></tr></table></li></ul>")).toBe(
      "- a\n\n| x |\n| --- |",
    );
    // Once the item has text, a heading or line break inside it is unchanged.
    expect(htmlToMarkdown("<ul><li>a<br>b</li></ul>")).toBe("- a\nb");
    expect(render("- a\nb")).toBe("<ul>\n<li>a<br>\nb</li>\n</ul>\n");
    // No line anywhere is a bare marker.
    for (const html of [
      "<ul><li>a</li><li><br>t</li></ul>",
      "<ol><li>a</li><li><h2>T</h2>x</li></ol>",
      "<ul><li>a</li><li><table><tr><td>x</td></tr></table>y</li></ul>",
    ]) {
      for (const line of htmlToMarkdown(html).split("\n")) {
        expect(line, html).not.toMatch(/^\s*(?:-|\d+\.)$/);
      }
    }
  });

  // An empty line inside a list item (two or more <br> in a row) once wrote
  // a blank line, and the text after it went to column 0, which ends the
  // list; in an ordered list the next item then rendered as text, since
  // markdown-it lets a numbered list interrupt a paragraph only at 1 (PR #24
  // review). In a list a run of <br> is one line break, as a <p> in an item
  // is a space, so the item and the list hold.
  it("two or more line breaks in a list item keep the next item an item", () => {
    expect(htmlToMarkdown("<ol><li>a<br><br>b</li><li>c</li></ol>")).toBe("1. a\nb\n2. c");
    expect(render("1. a\nb\n2. c")).toBe("<ol>\n<li>a<br>\nb</li>\n<li>c</li>\n</ol>\n");
    expect(htmlToMarkdown("<ul><li>a<br><br><br>b</li><li>c</li></ul>")).toBe("- a\nb\n- c");
    expect(render("- a\nb\n- c")).toBe("<ul>\n<li>a<br>\nb</li>\n<li>c</li>\n</ul>\n");
    const nested = htmlToMarkdown("<ol><li>x<ol><li>a<br><br>b</li><li>c</li></ol></li></ol>");
    expect(nested).toBe("1. x\n   1. a\nb\n   2. c");
    expect(render(nested)).toBe(
      "<ol>\n<li>x\n<ol>\n<li>a<br>\nb</li>\n<li>c</li>\n</ol>\n</li>\n</ol>\n",
    );
    // Outside a list a run of <br> still writes a blank line.
    expect(htmlToMarkdown("<p>a<br><br>b</p>")).toBe("a\n\nb");
  });

  it("a heading ending in # keeps it (#27)", () => {
    expect(htmlToMarkdown("<h2>Learn C#</h2>")).toBe("## Learn C\\#");
    expect(render("## Learn C\\#")).toBe("<h2>Learn C#</h2>\n");
    // CommonMark strips a closing # run after a space, so this is the case
    // that loses its # without the escape.
    expect(htmlToMarkdown("<h3>Part # </h3>")).toBe("### Part \\#");
    expect(render("### Part \\#")).toBe("<h3>Part #</h3>\n");
    expect(htmlToMarkdown("<h2>C##</h2>")).toBe("## C#\\#");
    expect(render("## C#\\#")).toBe("<h2>C##</h2>\n");
    expect(htmlToMarkdown("<h2># 1</h2>")).toBe("## # 1");
    expect(render("## # 1")).toBe("<h2># 1</h2>\n");
  });

  it("emphasis touching a letter is still emphasis (#28)", () => {
    expect(htmlToMarkdown("<p>screw<em>s</em> and nuts</p>")).toBe("screw*s* and nuts");
    expect(render("screw*s* and nuts")).toBe(para("screw<em>s</em> and nuts"));
    expect(htmlToMarkdown("<p>a<i> b</i>c</p>")).toBe("a *b*c");
    expect(render("a *b*c")).toBe(para("a <em>b</em>c"));
  });

  it("a table nested in a table cell stays inside the cell (#29)", () => {
    expect(
      htmlToMarkdown(
        "<table><tr><td>a<table><tr><td>b</td><td>c</td></tr><tr><td>d</td></tr></table>e</td><td>f</td></tr>" +
          "<tr><td>g</td><td>h</td></tr></table><p>After</p>",
      ),
    ).toBe("| a b c; d e | f |\n| --- | --- |\n| g | h |\n\nAfter");
    // The reviewer's input.
    expect(
      htmlToMarkdown("<table><tr><td>a<table><tr><td>b</td></tr></table>c</td></tr></table>"),
    ).toBe("| a b c |\n| --- |");
  });

  it("htmlToMarkdown leaves a link or emphasis that wraps a block as plain text", () => {
    // Wrapping text that holds a paragraph break or a heading the converter
    // wrote would show the brackets, address or asterisks as text.
    expect(htmlToMarkdown('<a href="https://x.test"><p>Part one</p><p>Part two</p></a>')).toBe(
      "Part one\n\nPart two",
    );
    expect(htmlToMarkdown("<strong><h3>T</h3></strong>")).toBe("### T");
    expect(htmlToMarkdown("<em><p>a</p><p>b</p></em>")).toBe("a\n\nb");
    expect(htmlToMarkdown('<a href="https://x.test"><h2>T</h2></a>')).toBe("## T");
    // A block opened in a list item before any text drops the item's bare
    // marker; the wrap no longer reaches into the heading.
    expect(htmlToMarkdown("<ul><li><strong><h3>T</h3></strong></li></ul>")).toBe("### T");
    expect(htmlToMarkdown('<ul><li><a href="https://x.test"><h3>T</h3></a></li></ul>')).toBe(
      "### T",
    );
    expect(htmlToMarkdown("<ul><li><b>a<ul><li>b</li></ul></b></li></ul>")).toBe("- a\n  - b");
    // A wrap around one paragraph, or a line break in text, still applies.
    expect(htmlToMarkdown('<a href="https://x.test"><p>Part one</p></a>')).toBe(
      "[Part one](https://x.test/)",
    );
    expect(htmlToMarkdown("<strong><p>bold</p></strong>")).toBe("**bold**");
    expect(htmlToMarkdown("<p><strong>a<br>b</strong></p>")).toBe("**a\nb**");
    expect(render("**a\nb**")).toBe(para("<strong>a<br>\nb</strong>"));
    expect(
      htmlToMarkdown('<p>a <strong># x</strong> and <a href="https://e.test">- y</a></p>'),
    ).toBe("a **# x** and [- y](https://e.test/)");
    expect(htmlToMarkdown("<b><table><tr><td>c</td></tr></table></b>")).toBe("| c |\n| --- |");
  });
});

// The markdown-it layer of renderMarkdown on its own, without DOMPurify, so a
// weakened markdown-it setup cannot hide behind the sanitiser.
describe("the markdown-it layer alone", () => {
  it.each([
    "[x](/relative)",
    "[x](//e.test/protocol-relative)",
    "[x](javascript:alert(1))",
    "[x](mailto:a@e.test)",
    "[x](data:text/html,x)",
    "![x](/i.png)",
    "![x](data:image/png;base64,AAAA)",
    "<mailto:a@e.test>",
  ])("a link or image that is not absolute http(s) is text: %j", (markdown) => {
    const html = render(markdown);
    expect(html).not.toMatch(/<a |<img /);
  });

  // Descriptions never render images (Jon, 2026-11-08): the image rule is
  // off, so an image to an http(s) address is a "!" and a link to it.
  it("an absolute http(s) link is kept, and an image is a link to its address", () => {
    expect(render("[x](https://e.test/a) ![i](http://e.test/i.png) <https://e.test/b>")).toBe(
      para(
        '<a href="https://e.test/a">x</a> !<a href="http://e.test/i.png">i</a> <a href="https://e.test/b">https://e.test/b</a>',
      ),
    );
  });

  it.each([
    "![i](https://e.test/i.png)",
    '![i](https://e.test/i.png "t")',
    "![i][r]\n\n[r]: https://e.test/i.png",
    "[![i](https://e.test/i.png)](https://e.test/)",
    "| ![i](https://e.test/i.png) |\n| --- |",
    "## ![i](https://e.test/i.png)",
  ])("an image to an http(s) address is no <img>: %j", (markdown) => {
    expect(render(markdown)).not.toMatch(/<img/);
  });

  it("raw HTML is text", () => {
    expect(render("<script>alert(1)</script> <b onclick=x>b</b>")).toBe(
      para("&lt;script&gt;alert(1)&lt;/script&gt; &lt;b onclick=x&gt;b&lt;/b&gt;"),
    );
  });

  it("a bare address is text", () => {
    expect(render("see https://e.test/x and www.e.test")).toBe(
      para("see https://e.test/x and www.e.test"),
    );
  });
});

describe("htmlToMarkdown: re-derived for markdown-it", () => {
  it("text that spells an autolink stays text", () => {
    const out = htmlToMarkdown("<p>&lt;https://e.test&gt; and &lt;javascript:alert(1)&gt;</p>");
    expect(out).toBe("\\<https://e.test\\> and \\<javascript:alert(1)\\>");
    expect(render(out)).toBe(para("&lt;https://e.test&gt; and &lt;javascript:alert(1)&gt;"));
  });

  it("text that spells an entity stays text, and an undecoded entity is passed through", () => {
    // &amp;lt; in the HTML is the text "&lt;": escaped so markdown-it shows it.
    const literal = htmlToMarkdown("<p>&amp;lt;b&amp;gt; &amp;#42; &amp; x</p>");
    expect(literal).toBe("\\&lt;b\\&gt; \\&#42; & x");
    expect(render(literal)).toBe(para("&amp;lt;b&amp;gt; &amp;#42; &amp; x"));
    // An entity the converter's own table lacks reaches markdown-it as written.
    expect(htmlToMarkdown("<p>caf&eacute; &ast;x&ast; &bogus;</p>")).toBe(
      "caf&eacute; &ast;x&ast; &bogus;",
    );
    expect(render("caf&eacute; &ast;x&ast; &bogus;")).toBe(para("caf\u00e9 *x* &amp;bogus;"));
  });

  it("an & in a link address that spells an entity is escaped", () => {
    const out = htmlToMarkdown('<a href="https://e.test/?a=1&amp;lt;b">t</a>');
    expect(out).toBe("[t](https://e.test/?a=1\\&lt;b)");
    expect(render(out)).toBe(para('<a href="https://e.test/?a=1&amp;lt;b">t</a>'));
  });

  it("a backtick in a link address is encoded", () => {
    const out = htmlToMarkdown('<a href="https://e.test/?q=`x`">t</a>');
    expect(out).toBe("[t](https://e.test/?q=%60x%60)");
    expect(render(out)).toBe(para('<a href="https://e.test/?q=%60x%60">t</a>'));
  });

  it("a later row with more cells than the first keeps every cell", () => {
    const out = htmlToMarkdown(
      "<table><tr><td>a</td></tr><tr><td>b</td><td>c</td><td>d</td></tr></table>",
    );
    expect(out).toBe("| a | | |\n| --- | --- | --- |\n| b | c | d |");
    expect(render(out)).toBe(
      "<table>\n<thead>\n<tr>\n<th>a</th>\n<th></th>\n<th></th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>b</td>\n<td>c</td>\n<td>d</td>\n</tr>\n</tbody>\n</table>\n",
    );
  });

  it("an unclosed li starts a sibling item, not a nested one", () => {
    const out = htmlToMarkdown("<ul><li>a<li>b</ul><ol><li>c<li>d</ol>");
    expect(out).toBe("- a\n- b\n\n1. c\n2. d");
  });

  it("an unterminated comment drops the rest, as a browser does", () => {
    expect(htmlToMarkdown("<p>kept</p><!-- <p>gone</p>")).toBe("kept");
    expect(htmlToMarkdown("<p>a<!-- x -->b</p>")).toBe("ab");
  });

  it("a tag-like run with no closing > stays text", () => {
    const out = htmlToMarkdown("<p>a <b c</p>");
    expect(out).toBe("a \\<b c");
  });

  it("control characters the converter uses internally cannot be smuggled in", () => {
    // &#1; and a raw U+0001 or NUL are dropped; none can turn the text after
    // them into an entity markdown-it decodes, or into a line-start mark.
    const out = htmlToMarkdown("<p>x&#1;lt;y \u0001lt; \0# z</p>");
    expect(out).toBe("xlt;y lt; # z");
    expect(render(out)).toBe(para("xlt;y lt; # z"));
  });
});

// Escaped designer text renders literally: each payload from the shared
// table is converted, rendered by markdown-it, and must come back holding
// exactly that text and no other element. render.test.ts runs the same table
// through renderMarkdown, DOMPurify included.
describe("escaped designer text renders literally (markdown-it)", () => {
  it.each(DESIGNER_PAYLOADS)("at a line's start: %j", (payload) => {
    const text = `${payload}x`;
    const out = htmlToMarkdown(`<p>${htmlEscape(text)}</p>`);
    expect(render(out)).toBe(para(htmlEscape(text.trim())));
  });

  it.each(DESIGNER_PAYLOADS)("mid-line: %j", (payload) => {
    const text = `a ${payload}x`;
    const out = htmlToMarkdown(`<p>${htmlEscape(text)}</p>`);
    expect(render(out)).toBe(para(htmlEscape(text)));
  });

  it.each(DESIGNER_PAYLOADS)("after a line break: %j", (payload) => {
    const out = htmlToMarkdown(`<p>a<br>${htmlEscape(`${payload}x`)}</p>`);
    expect(render(out)).toBe(para(`a<br>\n${htmlEscape(`${payload}x`)}`));
  });

  it.each(DESIGNER_PAYLOADS)("first in a list item: %j", (payload) => {
    const out = htmlToMarkdown(`<ul><li>${htmlEscape(`${payload}x`)}</li></ul>`);
    expect(render(out)).toBe(`<ul>\n<li>${htmlEscape(`${payload}x`.trim())}</li>\n</ul>\n`);
  });

  it.each(DESIGNER_PAYLOADS)("in a table cell: %j", (payload) => {
    const out = htmlToMarkdown(
      `<table><tr><td>${htmlEscape(`${payload}x`)}</td><td>y</td></tr></table>`,
    );
    expect(render(out)).toBe(
      `<table>\n<thead>\n<tr>\n<th>${htmlEscape(`${payload}x`.trim())}</th>\n<th>y</th>\n</tr>\n</thead>\n</table>\n`,
    );
  });

  it.each(DESIGNER_PAYLOADS)("as heading text: %j", (payload) => {
    const out = htmlToMarkdown(`<h2>${htmlEscape(`x${payload}`)}</h2>`);
    expect(render(out)).toBe(`<h2>${htmlEscape(`x${payload}`.trim())}</h2>\n`);
  });
});

// The same table directly beside markup the converter writes itself: a link
// and emphasis. Nothing separates a link's [ or an emphasis mark from the
// text before or after it, so a payload must stay text there too: a "!"
// before a link must not turn it into an image (PR #24 review).
describe("escaped designer text beside converter markup renders literally (markdown-it)", () => {
  const LINK = '<a href="https://shop.example/x">store</a>';
  const LINK_OUT = '<a href="https://shop.example/x">store</a>';

  it("a ! right before a link keeps the link and the !", () => {
    const out = htmlToMarkdown(`<p>Sample line ends here!${LINK}</p>`);
    expect(out).toBe("Sample line ends here\\![store](https://shop.example/x)");
    expect(render(out)).toBe(para(`Sample line ends here!${LINK_OUT}`));
  });

  it.each(DESIGNER_PAYLOADS)("directly before a link: %j", (payload) => {
    const out = htmlToMarkdown(`<p>a ${htmlEscape(payload)}${LINK}</p>`);
    expect(render(out)).toBe(para(`a ${htmlEscape(payload)}${LINK_OUT}`));
  });

  it.each(DESIGNER_PAYLOADS)("directly after a link: %j", (payload) => {
    const out = htmlToMarkdown(`<p>a ${LINK}${htmlEscape(payload)}x</p>`);
    expect(render(out)).toBe(para(`a ${LINK_OUT}${htmlEscape(payload)}x`));
  });

  it.each(DESIGNER_PAYLOADS)("directly around strong: %j", (payload) => {
    const p = htmlEscape(payload);
    const out = htmlToMarkdown(`<p>a ${p}<strong>b</strong>${p}x</p>`);
    expect(render(out)).toBe(para(`a ${p}<strong>b</strong>${p}x`));
  });

  it.each(DESIGNER_PAYLOADS)("directly around em: %j", (payload) => {
    const p = htmlEscape(payload);
    const out = htmlToMarkdown(`<p>a ${p}<em>b</em>${p}x</p>`);
    expect(render(out)).toBe(para(`a ${p}<em>b</em>${p}x`));
  });
});

// Misnested inline tags. Closing a link or emphasis writes its [ or marks at
// the point it opened, and rewriting a heading or a table cell can move text;
// an element still open across either must not keep a start that now points
// between a backslash and the character it escapes, or its later marks would
// un-escape designer text (and a "!" left bare before a link's [ would make
// it an image). Each case below rendered wrong before the fix (PR #24 review).
describe("escaped designer text beside misnested inline tags renders literally (markdown-it)", () => {
  it("a link closed before the bold inside it keeps the designer's *", () => {
    const out = htmlToMarkdown('<p><a href="https://e.test/">*<b>y</a>z</b></p>');
    expect(out).toBe("[\\*y](https://e.test/)z");
    expect(render(out)).toBe(para('<a href="https://e.test/">*y</a>z'));
  });

  it("emphasis closed before the bold and link inside it makes no image", () => {
    const out = htmlToMarkdown('<p><i>!<b>abc<a href="https://evil.test/p.png">d</i></b></a></p>');
    expect(out).toBe("*\\!abcd*");
    expect(renderWithImages(out)).not.toMatch(/<img/);
    expect(render(out)).toBe(para("<em>!abcd</em>"));
  });

  it("bold left open across a table cell keeps the designer's *", () => {
    const out = htmlToMarkdown("<table><tr><td>a *<b>y</td><td>z</b></td></tr></table>");
    expect(out).toBe("| a \\*y | z |\n| --- | --- |");
  });

  it("bold left open across a heading whose trailing # is escaped keeps the #", () => {
    const out = htmlToMarkdown("<h2>Learn C#<b></h2></b><p>z</p>");
    expect(out).toBe("## Learn C\\#\n\nz");
    expect(render(out)).toBe("<h2>Learn C#</h2>\n<p>z</p>\n");
  });

  // The cell's trailing spaces (one per <br>) are trimmed before the "; "
  // between list items, and before the "; " between the rows of a table
  // nested in the cell. A bold opened inside those spaces once kept its old
  // start, which then fell on the "!" after its backslash: the "!" came out
  // bare before the link's [ and made it an image (issue #33). The bold now
  // starts after the "; " that replaced those spaces.
  it("bold opened in a cell's trailing spaces before a list item makes no image", () => {
    const out = htmlToMarkdown(
      '<table><tr><td><ul><li>a</li><br><br><br><b><li>!<a href="https://evil.example/x.png">y</a></b></li></ul></td></tr></table>',
    );
    expect(out).toBe("| a; **\\![y](https://evil.example/x.png)** |\n| --- |");
    expect(renderWithImages(out)).not.toMatch(/<img/);
  });

  it("bold opened in a cell's trailing spaces before a nested table row makes no image", () => {
    const out = htmlToMarkdown(
      '<table><tr><td><table><tr><td>a</td></tr><br><br><b><tr><td>!<a href="https://evil.example/x.png">y</a></b></td></tr></table></td></tr></table>',
    );
    expect(out).toBe("| a; **\\![y](https://evil.example/x.png)** |\n| --- |");
    expect(renderWithImages(out)).not.toMatch(/<img/);
  });

  // HTML lets a page leave out </td>: the next <td> closes the cell. That
  // cell once stayed open, so a link left open in it and closed in the next
  // cell rewrote the text before the next cell's start; cutting the cell
  // there split "\\!" and left the "!" bare before the designer's link,
  // which made it an image (PR #24 review). The open cell is now closed
  // first, as </td> closes it.
  it("a cell left open by a missing </td> makes no image", () => {
    const out = htmlToMarkdown(
      '<table><tr><td><a href="https://ok.example/">!<td><a href="https://evil.example/x.png">t</a></a></td></tr></table>',
    );
    expect(out).toBe("| \\! | [t](https://evil.example/x.png) |\n| --- | --- |");
    expect(renderWithImages(out)).not.toMatch(/<img/);
  });

  it("a cell left open by a missing </td> is closed by the next cell, its row or its table", () => {
    expect(htmlToMarkdown("<table><tr><td>a<td>b</tr><tr><td>c<td>d</table>")).toBe(
      "| a | b |\n| --- | --- |\n| c | d |",
    );
    expect(htmlToMarkdown("<table><tr><th>a</tr><tr><td>b</td></tr></table>")).toBe(
      "| a |\n| --- |\n| b |",
    );
  });

  // Issue #40: a heading opened before a table and closed between its rows.
  // The heading's whitespace collapse rewrote the table's header and
  // separator rows, which shrank them, while the table kept its old header
  // and separator ends; a later row wider than the header then had its pad
  // inserted at those stale ends, inside the row's own text, between a
  // backslash and the "!" it escaped, which made the designer's link an
  // image. The heading now ends where the table opens.
  const EVIL = "https://evil.example/x.png";

  it("a heading closed between a table's rows keeps the table and the designer's ! (#40)", () => {
    const out = htmlToMarkdown(
      `<h2>a${"<p>a".repeat(12)}` +
        `<table><tr><td>b</td></tr></h2><tr><td>!<a href="${EVIL}">tttttttt</a></td><td>z</td></tr></table>`,
    );
    expect(out).toBe(
      `## ${"a ".repeat(12)}a\n\n| b | |\n| --- | --- |\n| \\![tttttttt](${EVIL}) | z |`,
    );
    expect(renderWithImages(out)).not.toMatch(/<img/);
    expect(render(out)).toBe(
      `<h2>${"a ".repeat(12)}a</h2>\n<table>\n<thead>\n<tr>\n<th>b</th>\n<th></th>\n</tr>\n</thead>\n` +
        `<tbody>\n<tr>\n<td>!<a href="${EVIL}">tttttttt</a></td>\n<td>z</td>\n</tr>\n</tbody>\n</table>\n`,
    );
  });

  it("a heading closed inside a list item it opened keeps the list (#40)", () => {
    const out = htmlToMarkdown(
      `<h2>a<p>a<p>a<p>a<ul><li></h2>!!!!<li><a href="${EVIL}">t</a></li></ul>`,
    );
    expect(out).toBe(`## a a a a\n\n- \\!\\!\\!\\!\n- [t](${EVIL})`);
    expect(renderWithImages(out)).not.toMatch(/<img/);
  });

  // The same cause through every position a heading's rewrite could leave
  // behind: a table's header and separator ends and its row start, and a list
  // item's marker and text starts. However many paragraphs shrink in the
  // heading, the designer's "!" stays escaped.
  const HEADING_ACROSS: Array<[string, (p: string) => string]> = [
    [
      "a table row wider than the header",
      (p) =>
        `<h2>a${p}<table><tr><td>b</td></tr></h2><tr><td>!<a href="${EVIL}">tttttttt</a></td><td>z</td></tr></table>`,
    ],
    [
      "a list item with no text yet",
      (p) => `<h2>a${p}<ul><li></h2>!!!!<li><a href="${EVIL}">t</a></li></ul>`,
    ],
    [
      "an ordered list item with no text yet",
      (p) => `<h2>a${p}<ol><li>x<li></h2>!!!!</li><li>!<a href="${EVIL}">t</a></ol>`,
    ],
    [
      "a table row opened in the heading",
      (p) =>
        `<table><tr><td>a</td></tr><h2>x${p}<tr></h2>!!!!</tr><tr><td>!<a href="${EVIL}">t</a></td><td>z</td></tr></table>`,
    ],
    [
      "a table cell opened in the heading",
      (p) =>
        `<table><tr><td>a</td><h2>x${p}<td>!!</h2>!!</td></tr><tr><td>!<a href="${EVIL}">t</a></td><td>z</td><td>w</td></tr></table>`,
    ],
  ];
  const SHRINKS = Array.from({ length: 12 }, (_, i) => i + 1);

  it.each(HEADING_ACROSS.flatMap(([name, make]) => SHRINKS.map((n) => [name, n, make] as const)))(
    "a heading closed across %s, after %i paragraphs, makes no image (#40)",
    (_name, n, make) => {
      const out = htmlToMarkdown(make("<p>a".repeat(n)));
      expect(renderWithImages(out), out).not.toMatch(/<img/);
    },
  );

  // Issue #41: HTML lets a page leave out </tr>; the next <tr> or the
  // table's end closes the row, as the next <td> closes a cell.
  it.each([
    [
      "a <tr> closes the row before it",
      "<table><tr><td>a<tr><td>b</table>",
      "| a |\n| --- |\n| b |",
    ],
    [
      "</table> closes the last row, which can widen the header",
      "<table><tr><td>a</td></tr><tr><td>b<td>c</table>",
      "| a | |\n| --- | --- |\n| b | c |",
    ],
    [
      "a row closed by the next <tr> can widen the header",
      "<table><tr><td>a<td>b<tr><td>c<td>d<td>e</table>",
      "| a | b | |\n| --- | --- | --- |\n| c | d | e |",
    ],
    [
      "an empty row left open leaves nothing",
      "<table><tr><td>a</td></tr><tr></table>",
      "| a |\n| --- |",
    ],
    [
      "an empty row closed by the next <tr> leaves nothing",
      "<table><tr><td>a</td></tr><tr><tr><td>b</td></tr></table>",
      "| a |\n| --- |\n| b |",
    ],
  ])("a row left open by a missing </tr>: %s (#41)", (_name, html, expected) => {
    const out = htmlToMarkdown(html);
    expect(out).toBe(expected);
    expect(render(out)).toMatch(/^<table>/);
  });

  it("a row left open by a missing </tr> keeps every cell in the rendered table (#41)", () => {
    const html = render(htmlToMarkdown("<table><tr><td>a</td></tr><tr><td>b<td>c</table>"));
    expect(html).toBe(
      "<table>\n<thead>\n<tr>\n<th>a</th>\n<th></th>\n</tr>\n</thead>\n" +
        "<tbody>\n<tr>\n<td>b</td>\n<td>c</td>\n</tr>\n</tbody>\n</table>\n",
    );
  });

  // A </tr> with no row open closes nothing. It once ran the row close
  // anyway: before the first <tr> the empty row it found was cut from the
  // table's row start, still 0, which erased everything written before the
  // table; after a closed row it wrote a blank line that split the table
  // (PR #24 review).
  it.each([
    [
      "before the first row",
      "<p>Intro text</p><table></tr><tr><td>a</td></tr></table>",
      "Intro text\n\n| a |\n| --- |",
    ],
    [
      "in a tbody before the first row",
      "<p>Intro text</p><table><tbody></tr><tr><td>a</td></tr></tbody></table>",
      "Intro text\n\n| a |\n| --- |",
    ],
    [
      "between rows",
      "<table><tr><td>a</td></tr></tr><tr><td>b</td></tr></table>",
      "| a |\n| --- |\n| b |",
    ],
  ])("a stray </tr> %s closes nothing", (_name, html, expected) => {
    const out = htmlToMarkdown(html);
    expect(out).toBe(expected);
    expect(render(out).match(/<table>/g)).toHaveLength(1);
  });

  // A <td> or <th> with no row open opens one, as a browser does; the cell
  // once opened with no row, so its pipes showed as text outside the table
  // (PR #24 review).
  it.each([
    ["with no <tr> at all", "<table><td>a</td><td>b</td></table>", "| a | b |\n| --- | --- |"],
    [
      "before the first <tr>",
      "<table><td>a</td><tr><td>b</td></tr></table>",
      "| a |\n| --- |\n| b |",
    ],
    ["after a closed row", "<table><tr><td>a</td></tr><td>b</td></table>", "| a |\n| --- |\n| b |"],
    ["as a <th>", "<table><th>a</th></table>", "| a |\n| --- |"],
  ])("a cell with no row open opens one: %s", (_name, html, expected) => {
    const out = htmlToMarkdown(html);
    expect(out).toBe(expected);
    expect(render(out)).toMatch(/^<table>/);
  });

  // A link or emphasis opened in a row before its first cell and closed in
  // the cell rewrote the text before the cell's start, and cutting the cell
  // there split a backslash from the "!" it escaped, leaving image syntax
  // and un-escaped designer text (PR #24 review). Markup cannot span a cell,
  // so a cell opening drops what opened earlier in its row.
  it.each([
    ["a link", '<a href="https://h.test/">!', "</a>"],
    ["bold", "<b>!", "</b>"],
    ["emphasis", "<i>!", "</i>"],
  ])("%s opened in a row before its first cell makes no image", (_name, open, close) => {
    const out = htmlToMarkdown(
      `<table><tr>${open}<td><a href="${EVIL}">t</a>${close}</td></tr></table>`,
    );
    expect(out).toBe(`|\\! [t](${EVIL}) |\n| --- |`);
    expect(renderWithImages(out)).not.toMatch(/<img/);
  });

  it.each(DESIGNER_PAYLOADS)("a link opened in a row before its first cell: %j", (payload) => {
    const p = htmlEscape(payload);
    const out = htmlToMarkdown(
      `<table><tr><a href="https://h.test/">${p}!<td><a href="${EVIL}">t</a>${p}z</a></td></tr></table>`,
    );
    const html = render(out);
    expect(renderWithImages(out)).not.toMatch(/<img/);
    expect(html).toMatch(/^<table>/);
    expect(html).toContain(`<a href="${EVIL}">t</a>`);
    expect(html).not.toContain("https://h.test/");
  });

  // A paragraph or heading between a table's rows once wrote a blank line
  // that split the table, so the rows after it showed as text with pipes
  // (PR #24 review). Its text now stays in the table, on a line of its own,
  // which markdown-it reads as a one-cell row.
  it.each([
    ["a paragraph", "<p>x</p>"],
    ["a heading", "<h2>x</h2>"],
    ["a div", "<div>x</div>"],
  ])("%s between a table's rows keeps the table whole", (_name, block) => {
    const out = htmlToMarkdown(`<table><tr><td>a</td></tr>${block}<tr><td>b</td></tr></table>`);
    expect(out).toBe("| a |\n| --- |\nx\n| b |");
    expect(render(out)).toBe(
      "<table>\n<thead>\n<tr>\n<th>a</th>\n</tr>\n</thead>\n" +
        "<tbody>\n<tr>\n<td>x</td>\n</tr>\n<tr>\n<td>b</td>\n</tr>\n</tbody>\n</table>\n",
    );
  });

  // A <br> between a table's rows wrote a second newline, and a list there
  // wrote a blank line or a "- " line, either of which ended the table, so
  // the rows after it showed as text with pipes (PR #24 review). A <br>
  // there is at most one newline, and a list's items are lines of their own,
  // which markdown-it reads as one-cell rows.
  it.each([
    ["a <br>", "<br>", "| a |\n| --- |\n| b |"],
    ["two <br>s", "<br><br>", "| a |\n| --- |\n| b |"],
    ["a list", "<ul><li>x</li></ul>", "| a |\n| --- |\nx\n| b |"],
    ["an ordered list of two", "<ol><li>x</li><li>y</li></ol>", "| a |\n| --- |\nx\ny\n| b |"],
    ["a bare <li>", "<li>x</li>", "| a |\n| --- |\nx\n| b |"],
    ["a bare <li> left open", "<li>x", "| a |\n| --- |\nx\n| b |"],
    ["text, a list and text", "t<ul><li>x</li></ul>u", "| a |\n| --- |\nt\nx\nu\n| b |"],
  ])("%s between a table's rows keeps the table whole", (_name, between, expected) => {
    const out = htmlToMarkdown(`<table><tr><td>a</td></tr>${between}<tr><td>b</td></tr></table>`);
    expect(out).toBe(expected);
    const html = render(out);
    expect(html.match(/<table>/g)).toHaveLength(1);
    expect(html).toMatch(/^<table>/);
    expect(html).toContain("<td>b</td>");
  });

  it("a list between the rows of a table in a list item keeps the table in the item", () => {
    const out = htmlToMarkdown(
      "<ul><li>i<table><tr><td>a</td></tr><ul><li>x</li></ul><br><tr><td>b</td></tr></table></li><li>j</li></ul>",
    );
    expect(out).toBe("- i\n\n  | a |\n  | --- |\n  x\n  | b |\n\n- j");
    expect(render(out)).toBe(
      "<ul>\n<li>\n<p>i</p>\n<table>\n<thead>\n<tr>\n<th>a</th>\n</tr>\n</thead>\n" +
        "<tbody>\n<tr>\n<td>x</td>\n</tr>\n<tr>\n<td>b</td>\n</tr>\n</tbody>\n</table>\n</li>\n" +
        "<li>\n<p>j</p>\n</li>\n</ul>\n",
    );
  });

  it.each([
    ["a <br>", "<br>"],
    ["a list", "<ul><li>x</li></ul>"],
  ])("%s in a row before its first cell keeps the row whole", (_name, before) => {
    const out = htmlToMarkdown(`<table><tr>${before}<td>a</td></tr><tr><td>b</td></tr></table>`);
    const html = render(out);
    expect(html.match(/<table>/g)).toHaveLength(1);
    expect(html).toMatch(/^<table>/);
    expect(html).toContain("<td>b</td>");
  });

  // Text directly in a <tr>, outside any cell, was deleted when the row had
  // no cell, and written after the row's last pipe when it came after a
  // cell, which broke the header row or was dropped from a body row (issue
  // #42). A row with no cell now keeps its text as a one-cell row; text after
  // a row's last cell ends that row and goes on a line of its own, which
  // markdown-it reads as a one-cell row. Text before a row's first cell
  // still joins that cell (above).
  it.each([
    ["a row with no cell", "<tr><td>a</td></tr><tr>Note</tr>", "| a |\n| --- |\n| Note |"],
    ["the only row, with no cell", "<tr>Note</tr>", "| Note |\n| --- |"],
    ["a row with no cell left open", "<tr><td>a</td></tr><tr>Note", "| a |\n| --- |\n| Note |"],
    [
      "a row with no cell before the next row",
      "<tr>Note<tr><td>b</td></tr>",
      "| Note |\n| --- |\n| b |",
    ],
    [
      "after the header row's last cell",
      "<tr><td>a</td>Note</tr><tr><td>b</td></tr>",
      "| a |\n| --- |\nNote\n| b |",
    ],
    [
      "after a body row's last cell",
      "<tr><td>x</td></tr><tr><td>a</td>Note</tr>",
      "| x |\n| --- |\n| a |\nNote",
    ],
    ["after a <br> after the last cell", "<tr><td>a</td><br>Note</tr>", "| a |\n| --- |\nNote"],
    ["in a <p> after the last cell", "<tr><td>a</td><p>Note</p></tr>", "| a |\n| --- |\nNote"],
    [
      "in a list after the last cell",
      "<tr><td>a</td><ul><li>Note</li></ul></tr>",
      "| a |\n| --- |\nNote",
    ],
    [
      "in bold after the last cell",
      "<tr><td>a</td><b>Note</b></tr><tr><td>b</td></tr>",
      "| a |\n| --- |\nNote\n| b |",
    ],
    ["between two cells", "<tr><td>a</td>Note<td>b</td></tr>", "| a |\n| --- |\nNote\n| b |"],
  ])("text in a table row outside any cell is kept: %s", (_name, rows, expected) => {
    const out = htmlToMarkdown(`<table>${rows}</table>`);
    expect(out).toBe(expected);
    const html = render(out);
    expect(html.match(/<table>/g)).toHaveLength(1);
    expect(html).toMatch(/^<table>/);
    expect(html).toMatch(/<t[dh]>Note<\/t[dh]>/);
  });

  it("text in a row outside any cell of a table in a list item stays in the item", () => {
    const out = htmlToMarkdown(
      "<ul><li>i<table><tr><td>a</td>Note</tr><tr>More</tr></table></li><li>j</li></ul>",
    );
    expect(out).toBe("- i\n\n  | a |\n  | --- |\n  Note\n  | More |\n\n- j");
    expect(render(out)).toBe(
      "<ul>\n<li>\n<p>i</p>\n<table>\n<thead>\n<tr>\n<th>a</th>\n</tr>\n</thead>\n" +
        "<tbody>\n<tr>\n<td>Note</td>\n</tr>\n<tr>\n<td>More</td>\n</tr>\n</tbody>\n</table>\n</li>\n" +
        "<li>\n<p>j</p>\n</li>\n</ul>\n",
    );
  });

  it.each([
    ["a row with no cell", (p: string) => `<tr><td>a</td></tr><tr>w${p}z</tr>`],
    ["after the header row's last cell", (p: string) => `<tr><td>a</td>w${p}z</tr>`],
    [
      "after a body row's last cell",
      (p: string) => `<tr><td>a</td></tr><tr><td>b</td>w${p}z</tr><tr><td>c</td></tr>`,
    ],
  ])("designer text in a table row outside any cell renders literally: %s", (_name, rows) => {
    for (const payload of DESIGNER_PAYLOADS) {
      const p = htmlEscape(payload);
      const out = htmlToMarkdown(`<table>${rows(p)}</table>`);
      const html = render(out);
      expect(renderWithImages(out), payload).not.toMatch(/<img/);
      expect(html.match(/<table>/g), payload).toHaveLength(1);
      expect(html, payload).toContain(`<td>w${p}z</td>`);
    }
  });

  it.each(DESIGNER_PAYLOADS)("a list between a table's rows: %j", (payload) => {
    const p = htmlEscape(payload);
    const out = htmlToMarkdown(
      `<table><tr><td>a</td></tr><ul><li>${p}x</li><li>- ${p}</li></ul><br><br><tr><td>b</td></tr></table>`,
    );
    const html = render(out);
    expect(renderWithImages(out)).not.toMatch(/<img/);
    expect(html.match(/<table>/g)).toHaveLength(1);
    expect(html).toContain("<td>b</td>");
  });

  it("two paragraphs between a table's rows keep their words apart", () => {
    const out = htmlToMarkdown(
      "<table><tr><td>a</td></tr><p>x</p><p>y</p><tr><td>b</td></tr></table>",
    );
    expect(out).toBe("| a |\n| --- |\nx y\n| b |");
    expect(render(out).match(/<table>/g)).toHaveLength(1);
  });

  it("a paragraph between the rows of a table in a list item keeps the table in the item", () => {
    const out = htmlToMarkdown(
      "<ul><li>i<table><tr><td>a</td></tr><p>x</p><tr><td>b</td></tr></table></li></ul>",
    );
    expect(out).toBe("- i\n\n  | a |\n  | --- |\n  x\n  | b |");
    expect(render(out)).toBe(
      "<ul>\n<li>\n<p>i</p>\n<table>\n<thead>\n<tr>\n<th>a</th>\n</tr>\n</thead>\n" +
        "<tbody>\n<tr>\n<td>x</td>\n</tr>\n<tr>\n<td>b</td>\n</tr>\n</tbody>\n</table>\n</li>\n</ul>\n",
    );
  });

  it.each(DESIGNER_PAYLOADS)("a paragraph between a table's rows: %j", (payload) => {
    const p = htmlEscape(payload);
    const out = htmlToMarkdown(`<table><tr><td>a</td></tr><p>${p}x</p><tr><td>b</td></tr></table>`);
    const html = render(out);
    expect(renderWithImages(out)).not.toMatch(/<img/);
    expect(html.match(/<table>/g)).toHaveLength(1);
    expect(html).toContain("<td>b</td>");
  });

  it.each(DESIGNER_PAYLOADS)("a link left open across a missing </td>: %j", (payload) => {
    const p = htmlEscape(payload);
    const out = htmlToMarkdown(
      `<table><tr><td><a href="https://e.test/">${p}!<td><a href="https://evil.example/x.png">t</a>${p}z</a></td></tr></table>`,
    );
    const html = render(out);
    expect(renderWithImages(out)).not.toMatch(/<img/);
    expect(html).toBe(
      `<table>\n<thead>\n<tr>\n<th>${p}!</th>\n<th><a href="https://evil.example/x.png">t</a>${p}z</th>\n</tr>\n</thead>\n</table>\n`,
    );
  });

  it.each(DESIGNER_PAYLOADS)("a link closed before the bold inside it: %j", (payload) => {
    const p = htmlEscape(payload);
    const out = htmlToMarkdown(`<p>a <a href="https://e.test/">${p}<b>y</a>${p}z</b></p>`);
    expect(render(out)).toBe(para(`a <a href="https://e.test/">${p}y</a>${p}z`));
  });

  it.each(DESIGNER_PAYLOADS)("emphasis closed before the bold inside it: %j", (payload) => {
    const p = htmlEscape(payload);
    const out = htmlToMarkdown(`<p>a <i>${p}<b>y</i>${p}z</b></p>`);
    expect(render(out)).toBe(para(`a <em>${p}y</em>${p}z`));
  });

  it.each(DESIGNER_PAYLOADS)("emphasis closed before a bold and a link: %j", (payload) => {
    const p = htmlEscape(payload);
    const out = htmlToMarkdown(
      `<p>a <i>${p}<b>abc<a href="https://evil.test/p.png">d</i>${p}</b>e</a></p>`,
    );
    const html = render(out);
    expect(renderWithImages(out)).not.toMatch(/<img/);
    expect(html).toBe(para(`a <em>${p}abcd</em>${p}e`));
  });

  it.each(DESIGNER_PAYLOADS)("bold left open across a table cell: %j", (payload) => {
    const p = htmlEscape(payload);
    const out = htmlToMarkdown(`<table><tr><td>a ${p}<b>y</td><td>z</b></td></tr></table>`);
    expect(render(out)).toBe(
      `<table>\n<thead>\n<tr>\n<th>a ${p}y</th>\n<th>z</th>\n</tr>\n</thead>\n</table>\n`,
    );
  });

  it.each(DESIGNER_PAYLOADS)("bold left open across a heading ending in #: %j", (payload) => {
    const p = htmlEscape(payload);
    const out = htmlToMarkdown(`<h2>a ${p}C#<b></h2></b>`);
    expect(render(out)).toBe(`<h2>a ${p}C#</h2>\n`);
  });
});

// A close tag with nothing of its kind open is one a browser ignores. A stray
// </h2> (no heading open) still wrote a paragraph break, which in a list item
// pushed the item's later text to column 0 and ended the list; a </ul> or
// </ol> that did not match the open list closed it anyway, so later items
// lost their numbering or fell out of the list (PR #24 review). Both are now
// ignored, so the text runs on as a browser shows it.
describe("a close tag with nothing of its kind open is ignored", () => {
  it.each([
    [
      "a stray </h2> in an ordered item",
      "<ol><li>a</h2>b</li><li>c</li></ol>",
      "1. ab\n2. c",
      "<ol>\n<li>ab</li>\n<li>c</li>\n</ol>\n",
    ],
    [
      "a stray </h3> in an unordered item",
      "<ul><li>a</h3>b</li><li>c</li></ul>",
      "- ab\n- c",
      "<ul>\n<li>ab</li>\n<li>c</li>\n</ul>\n",
    ],
    ["a stray </h2> in a paragraph", "<p>a</h2>b</p>", "ab", para("ab")],
    [
      "a stray </h2> after a heading has closed",
      "<ol><li><h2>h</h2>a</h2>b</li><li>c</li></ol>",
      null,
      null,
    ],
    [
      "a </ul> in an ordered list",
      "<ol><li>a</ul>b</li><li>c</li></ol>",
      "1. ab\n2. c",
      "<ol>\n<li>ab</li>\n<li>c</li>\n</ol>\n",
    ],
    [
      "an </ol> in an unordered list",
      "<ul><li>a</ol>b</li><li>c</li></ul>",
      "- ab\n- c",
      "<ul>\n<li>ab</li>\n<li>c</li>\n</ul>\n",
    ],
    ["a </ul> with no list open", "<p>a</ul>b</p>", "ab", para("ab")],
    // A </table> with no table open wrote a paragraph break, which ended the
    // list it sat in (issue #48).
    [
      "a </table> in an ordered item",
      "<ol><li>a</table>b</li><li>c</li></ol>",
      "1. ab\n2. c",
      "<ol>\n<li>ab</li>\n<li>c</li>\n</ol>\n",
    ],
    [
      "a </table> in an unordered item",
      "<ul><li>a</table>b</li><li>c</li></ul>",
      "- ab\n- c",
      "<ul>\n<li>ab</li>\n<li>c</li>\n</ul>\n",
    ],
    ["a </table> in a paragraph", "<p>a</table>b</p>", "ab", para("ab")],
    [
      "a </table> after a table has closed",
      "<ol><li>a<table><tr><td>t</td></tr></table></table>b</li><li>c</li></ol>",
      null,
      null,
    ],
  ])("%s", (_name, html, expected, rendered) => {
    const out = htmlToMarkdown(html);
    if (expected !== null) expect(out).toBe(expected);
    if (rendered !== null) expect(render(out)).toBe(rendered);
    // Whatever else, the list is one list and its last item stays in it.
    if (html.startsWith("<ol>")) {
      const r = render(out);
      expect(r.match(/<ol>/g)).toHaveLength(1);
      expect(r).toMatch(/<li>(?:\n<p>)?c(?:<\/p>\n)?<\/li>\n<\/ol>\n$/);
    }
  });

  it("a </ul> inside an ordered list nested in an unordered one keeps the numbering", () => {
    const out = htmlToMarkdown("<ul><li>a<ol><li>b</ul>c</li><li>d</li></ol></li><li>e</li></ul>");
    expect(out).toBe("- a\n  1. bc\n  2. d\n- e");
    expect(render(out)).toBe(
      "<ul>\n<li>a\n<ol>\n<li>bc</li>\n<li>d</li>\n</ol>\n</li>\n<li>e</li>\n</ul>\n",
    );
  });

  // A table is a scope boundary: a browser ignores a </ul> or </ol> in it
  // that closes no list opened inside it. In a table inside a list item of
  // the same type, the converter closed that outer list instead, which split
  // the table and ended the list (issue #43). The close is now ignored, so
  // the output is what it would be without it.
  // Each place takes the stray close (or "" for the same input without it)
  // and the type of list the case is about. In a list, the last item holds a
  // nested list, which stays nested only while the outer list is still open:
  // a list popped by the stray close once wrote that item with no list
  // behind it, which in an unordered list looked the same until then.
  const TABLE_STRAY_PLACES: Array<[string, (close: string, list: string) => string]> = [
    ["between rows", (c) => `<table><tr><td>a</td></tr>${c}<tr><td>b</td></tr></table>`],
    [
      "in a row, after a cell",
      (c) => `<table><tr><td>a</td>${c}<td>x</td></tr><tr><td>b</td></tr></table>`,
    ],
    [
      "in a row, before its first cell",
      (c) => `<table><tr><td>a</td></tr><tr>${c}<td>b</td></tr></table>`,
    ],
    [
      "after the cell its list opened in",
      (c, list) => `<table><tr><td>a</td></tr><tr><td><${list}><li>b</td>${c}</tr></table>`,
    ],
  ];
  const LAST_ITEM = "<li>j<ul><li>k</li></ul></li>";
  const TABLE_STRAY_CASES = TABLE_STRAY_PLACES.flatMap(([place, make]) =>
    ["</ul>", "</ol>"].flatMap((close) => {
      const same = close === "</ol>" ? "ol" : "ul";
      const other = close === "</ol>" ? "ul" : "ol";
      return [
        [`${close} ${place}, top-level table`, make(close, same), make("", same)],
        [
          `${close} ${place}, table in a list item of the same type`,
          `<${same}><li>i${make(close, same)}</li>${LAST_ITEM}</${same}>`,
          `<${same}><li>i${make("", same)}</li>${LAST_ITEM}</${same}>`,
        ],
        [
          `${close} ${place}, table in a list item of the other type`,
          `<${other}><li>i${make(close, same)}</li>${LAST_ITEM}</${other}>`,
          `<${other}><li>i${make("", same)}</li>${LAST_ITEM}</${other}>`,
        ],
      ] as Array<[string, string, string]>;
    }),
  );
  it.each(TABLE_STRAY_CASES)(
    "a stray list close in a table is ignored: %s",
    (_name, html, without) => {
      const out = htmlToMarkdown(html);
      expect(out).toBe(htmlToMarkdown(without));
      const r = render(out);
      expect(r.match(/<table>/g)).toHaveLength(1);
      expect(r).toMatch(/<td>(?:- |1\. )?b<\/td>/);
      expect(renderWithImages(out)).not.toMatch(/<img/);
      if (html.startsWith("<ul>") || html.startsWith("<ol>")) {
        const list = html.slice(1, 3);
        // One outer list, plus the nested <ul> in its last item.
        expect(r.match(new RegExp(`<${list}>`, "g"))).toHaveLength(list === "ul" ? 2 : 1);
        // The last item is still an item of that list, its nested list in it.
        expect(r).toMatch(
          new RegExp(
            `<li>\\n?(?:<p>)?j(?:</p>)?\\n<ul>\\n<li>k</li>\\n</ul>\\n</li>\\n</${list}>\\n$`,
          ),
        );
        // The table stays inside the first item.
        expect(r.indexOf("<table>")).toBeLessThan(r.indexOf("j"));
      }
    },
  );

  // A heading a table or list ended before its close tag kept its "ended"
  // mark, so a stray heading close in a later list item still wrote a
  // paragraph break: the rest of that item went to column 0, the list ended,
  // and the next numbered item rendered as text (issue #46).
  it.each([
    [
      "a table ended the heading",
      "<ol><li>a<h2>x<table><tr><td>t</td></tr></table></li><li>b</h2>c</li><li>d</li></ol>",
    ],
    [
      "a nested list ended the heading",
      "<ol><li><h2>x<ul><li>y</li></ul></li><li>a</h3>b</li><li>d</li></ol>",
    ],
    [
      "the heading's item closed and a later list holds the close",
      "<ol><li>a<h2>x<table><tr><td>t</td></tr></table></li></ol><ol><li>b</h2>c</li><li>d</li></ol>",
    ],
  ])("a stray heading close after an unclosed heading keeps a later list: %s", (_name, html) => {
    const out = htmlToMarkdown(html);
    const r = render(out);
    expect(renderWithImages(out)).not.toMatch(/<img/);
    // "d" is still an item, the last of its ordered list.
    expect(r).toMatch(/<li>(?:\n<p>)?d(?:<\/p>\n)?<\/li>\n<\/ol>\n$/);
    // The item that holds the stray close keeps its text together.
    expect(r).not.toMatch(/<p>c<\/p>|<p>b<\/p>/);
  });

  it("a stray heading close after an unclosed heading writes nothing (#46)", () => {
    expect(
      htmlToMarkdown(
        "<ol><li>a<h2>x<table><tr><td>t</td></tr></table></li><li>b</h2>c</li><li>d</li></ol>",
      ),
    ).toBe(
      htmlToMarkdown(
        "<ol><li>a<h2>x<table><tr><td>t</td></tr></table></li><li>bc</li><li>d</li></ol>",
      ),
    );
    // The heading sat in a list with no item; once that list has closed, its
    // close is stray too.
    expect(htmlToMarkdown("<ul><h2>x<table><tr><td>t</td></tr></table></ul>a</h2>b")).toBe(
      htmlToMarkdown("<ul><h2>x<table><tr><td>t</td></tr></table></ul>ab"),
    );
  });

  it("a mismatched heading close still ends the open heading", () => {
    const out = htmlToMarkdown("<h2>x</h3><p>y</p>");
    expect(out).toBe("## x\n\ny");
    expect(render(out)).toBe("<h2>x</h2>\n<p>y</p>\n");
  });
});
