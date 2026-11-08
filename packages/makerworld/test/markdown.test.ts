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

  it("htmlToMarkdown: a table becomes a pipe table with the first row as header", () => {
    const html =
      "<p>Storage:</p><table><tbody>" +
      "<tr><td><p><strong>Rank</strong></p></td><td><p><strong>Storage Type</strong></p></td></tr>" +
      "<tr><td><p>1</p></td><td><p>Foil bag<br>with clip | zip</p></td></tr>" +
      "<tr></tr>" +
      "<tr><td>2</td><td>&lt;US$1</td></tr>" +
      "</tbody></table><p>After.</p>";
    const out = htmlToMarkdown(html);
    // CommonMark: < is \<, and $ needs no escape.
    expect(out).toBe(
      "Storage:\n\n| **Rank** | **Storage Type** |\n| --- | --- |\n| 1 | Foil bag with clip \\| zip |\n| 2 | \\<US$1 |\n\nAfter.",
    );
    expect(render(out)).toBe(
      "<p>Storage:</p>\n<table>\n<thead>\n<tr>\n<th><strong>Rank</strong></th>\n<th><strong>Storage Type</strong></th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>1</td>\n<td>Foil bag with clip | zip</td>\n</tr>\n<tr>\n<td>2</td>\n<td>&lt;US$1</td>\n</tr>\n</tbody>\n</table>\n<p>After.</p>\n",
    );
  });

  it("block syntax: the reviewer's tilde fence stays text", () => {
    const out = htmlToMarkdown("<p>Notes<br>~~~~~~</p><p>Use M3*8</p><p>~~~~~~</p>");
    expect(out).toBe("Notes\n\\~\\~\\~\\~\\~\\~\n\nUse M3\\*8\n\n\\~\\~\\~\\~\\~\\~");
    expect(render(out)).toBe("<p>Notes<br>\n~~~~~~</p>\n<p>Use M3*8</p>\n<p>~~~~~~</p>\n");
  });

  it("block syntax: a backtick fence stays text", () => {
    const out = htmlToMarkdown("<p>```</p><p>x</p><p>```</p>");
    expect(out).toBe("\\`\\`\\`\n\nx\n\n\\`\\`\\`");
    expect(render(out)).toBe("<p>```</p>\n<p>x</p>\n<p>```</p>\n");
  });

  it("block syntax: a line starting with # is not a heading", () => {
    expect(htmlToMarkdown("<p># of parts: 12</p>")).toBe("\\# of parts: 12");
    expect(render("\\# of parts: 12")).toBe(para("# of parts: 12"));
    expect(htmlToMarkdown("<p>Intro<br># of parts</p>")).toBe("Intro\n\\# of parts");
    expect(render("Intro\n\\# of parts")).toBe(para("Intro<br>\n# of parts"));
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
    const out = htmlToMarkdown("<p>~~3h, filament ~~40g</p>");
    expect(out).toBe("\\~\\~3h, filament \\~\\~40g");
    expect(render(out)).toBe(para("~~3h, filament ~~40g"));
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
      htmlToMarkdown("<p>&nbsp;<span># of parts</span></p><p><strong> </strong>- 2 pcs</p>"),
    ).toBe("\\# of parts\n\n\\- 2 pcs");
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
        "<table><tr><td>Item</td></tr><tr><td><p>Foil bag</p><p>with clip</p></td></tr></table>",
      ),
    ).toBe("| Item |\n| --- |\n| Foil bag with clip |");
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
    // A table inside an outer list item leaves that list's numbering alone.
    expect(
      htmlToMarkdown(
        "<ol><li>a<table><tr><td><ol><li>x</li><li>y</li></ol></td></tr></table></li><li>b</li></ol>",
      ),
    ).toBe("1. a\n\n| 1. x; 2. y |\n| --- |\n\n2. b");
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
    expect(htmlToMarkdown("<p>Use &lt;M3x8&gt; screws</p>")).toBe("Use \\<M3x8\\> screws");
    expect(render("Use \\<M3x8\\> screws")).toBe(para("Use &lt;M3x8&gt; screws"));
    const img = htmlToMarkdown('<p>&lt;img src="https://example.com/a.png"&gt;</p>');
    expect(img).toBe('\\<img src="https://example.com/a.png"\\>');
    expect(render(img)).toBe(para("&lt;img src=&quot;https://example.com/a.png&quot;&gt;"));
    // A lone < that starts no tag, and a > at line start (a Markdown quote).
    expect(htmlToMarkdown("<p>a < b</p><p>&gt; not a quote</p>")).toBe(
      "a \\< b\n\n\\> not a quote",
    );
  });

  it("htmlToMarkdown: Markdown span characters in text stay text", () => {
    expect(htmlToMarkdown("<p>Use M3*8 and M4*10 bolts</p>")).toBe("Use M3\\*8 and M4\\*10 bolts");
    const spans = htmlToMarkdown("<p>**not bold** _x_ `code` [t](https://e.test) a\\b</p>");
    expect(spans).toBe("\\*\\*not bold\\*\\* \\_x\\_ \\`code\\` \\[t\\](https://e.test) a\\\\b");
    expect(render(spans)).toBe(para("**not bold** _x_ `code` [t](https://e.test) a\\b"));
    // The converter's own markup is left alone; escaped text inside it stays escaped.
    const own = htmlToMarkdown(
      '<p><strong>M3*8</strong> <em>a_b</em> <a href="https://e.test/a_b">[x]</a></p>',
    );
    expect(own).toBe("**M3\\*8** *a\\_b* [\\[x\\]](https://e.test/a_b)");
    expect(render(own)).toBe(
      para('<strong>M3*8</strong> <em>a_b</em> <a href="https://e.test/a_b">[x]</a>'),
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
