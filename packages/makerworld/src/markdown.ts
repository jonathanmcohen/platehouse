// A MakerWorld description (HTML) as Markdown, and Markdown as sanitised HTML
// for the web app. htmlToMarkdown is ported by behaviour from an earlier
// Manyfold metadata script. That converter escaped text for
// Kramdown, which Manyfold renders with; Platehouse renders with markdown-it,
// so the escaping here is re-derived for markdown-it,
// and the tests in test/markdown.test.ts and
// test/render.test.ts are the contract.

import DOMPurify, {
  type Config,
  type DOMPurify as Purifier,
  type UponSanitizeAttributeHookEvent,
  type WindowLike,
} from "dompurify";
import MarkdownItCallable, { type MarkdownIt } from "markdown-it";
import { decodeEntities, mapEntities } from "./extract.js";
import { htmlToMarkdownRc } from "./legacy/markdown-rc.js";

// Elements that end a paragraph where they open and close: a paragraph break,
// or a space inside a list item, a table cell or between a table's rows.
// Every other element the converter does not handle itself is dropped and
// its text kept, so an element that is a block on the page but missing here
// ran its text straight into the next block's (#357).
const BLOCK_0_1_0: ReadonlySet<string> = new Set([
  "p",
  "div",
  "section",
  "article",
  "blockquote",
  "pre",
  "figure",
  "header",
  "footer",
  "hr",
  "tr",
]);
const BLOCK: ReadonlySet<string> = new Set([
  ...BLOCK_0_1_0,
  // MakerWorld's own "Boost Me" box: a title above a line of text on its
  // site, written as these three elements. Their text once ran together,
  // "Boost MeWant more?" (#357). Version 4 needs no names here, as no
  // element HTML does not define runs in (HTML_ELEMENTS); they stay for
  // version 3, htmlToMarkdown011Rc1.
  "boostme",
  "boosttitle",
  "boostcontent",
  // The rest of the elements HTML itself displays as a block and that hold
  // plain text. Lists, headings and tables are handled on their own; a
  // caption, a menu and a dir are left out, as they sit inside a table or
  // hold list items, which those paths handle.
  "address",
  "aside",
  "center",
  "details",
  "dialog",
  "dd",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "form",
  "hgroup",
  "legend",
  "main",
  "nav",
  "search",
  "summary",
]);
/**
 * Every element the HTML standard defines, obsolete ones included, plus math
 * and svg, which it embeds. The current converter treats every element NOT
 * here as a block boundary, as BLOCK's elements are (the 0.1.1-rc.1 live
 * check): MakerWorld writes its own boxes as elements of its own (Boost Me
 * as boostme, boosttitle and boostcontent, Membership as commercialme,
 * commercialtitle and commercialcontent, a video as oembed), which its site
 * shows as blocks. Naming each box's elements fixed Boost Me and let the
 * Membership box run its title into its text ("MembershipWant to sell..."),
 * so no name is listed for them: a box added later, under any name, ends
 * its block too. An element here that the converter writes no markup for
 * and that is not in BLOCK is dropped with its text kept, as before.
 * MathML's own elements (mi, mo, ...) are not here, so a formula's parts
 * would be written apart; MakerWorld's editor writes none.
 */
export const HTML_ELEMENTS: ReadonlySet<string> = new Set([
  "a",
  "abbr",
  "acronym",
  "address",
  "applet",
  "area",
  "article",
  "aside",
  "audio",
  "b",
  "base",
  "basefont",
  "bdi",
  "bdo",
  "bgsound",
  "big",
  "blink",
  "blockquote",
  "body",
  "br",
  "button",
  "canvas",
  "caption",
  "center",
  "cite",
  "code",
  "col",
  "colgroup",
  "data",
  "datalist",
  "dd",
  "del",
  "details",
  "dfn",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "em",
  "embed",
  "fieldset",
  "figcaption",
  "figure",
  "font",
  "footer",
  "form",
  "frame",
  "frameset",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hgroup",
  "hr",
  "html",
  "i",
  "iframe",
  "image",
  "img",
  "input",
  "ins",
  "isindex",
  "kbd",
  "keygen",
  "label",
  "legend",
  "li",
  "link",
  "listing",
  "main",
  "map",
  "mark",
  "marquee",
  "math",
  "menu",
  "menuitem",
  "meta",
  "meter",
  "multicol",
  "nav",
  "nextid",
  "nobr",
  "noembed",
  "noframes",
  "noscript",
  "object",
  "ol",
  "optgroup",
  "option",
  "output",
  "p",
  "param",
  "picture",
  "plaintext",
  "pre",
  "progress",
  "q",
  "rb",
  "rp",
  "rt",
  "rtc",
  "ruby",
  "s",
  "samp",
  "script",
  "search",
  "section",
  "select",
  "selectedcontent",
  "slot",
  "small",
  "source",
  "spacer",
  "span",
  "strike",
  "strong",
  "style",
  "sub",
  "summary",
  "sup",
  "svg",
  "table",
  "tbody",
  "td",
  "template",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "time",
  "title",
  "tr",
  "track",
  "tt",
  "u",
  "ul",
  "var",
  "video",
  "wbr",
  "xmp",
]);
const DROP_CONTENT: ReadonlySet<string> = new Set([
  "script",
  "style",
  "iframe",
  "video",
  "audio",
  "object",
  "noscript",
  "template",
  "svg",
]);
// The dropped elements a browser reads as raw text: everything up to the
// matching close tag (</ then the name, any case, then HTML whitespace, / or
// >) is text, so nothing inside them is a tag. The tokenizer skips straight
// to that close tag and ends the element there, whatever follows the name;
// with none, the element runs to the end. The close tag itself is read as a
// browser reads an end tag (endTagEnd), so a < in it cannot fail it and
// leave the drop open (PR #154 review). Tokenizing tags
// in there let a quoted attribute value opened in the script text run past
// </script>, so the drop never ended and the rest of the description was
// hidden (issue #141). The other dropped elements hold markup a browser
// parses, so their tags still count. One simplification: a script whose text
// holds "<!--<script>" hides more in a browser (its next </script> does not
// end it), and the converter ends it at that close tag and shows what
// follows; nothing is hidden that a browser shows.
const RAW_TEXT_CLOSE: ReadonlyMap<string, RegExp> = new Map(
  ["script", "style", "iframe", "noscript"].map((name) => [
    name,
    new RegExp(`</${name}[\\t\\n\\f\\r />]`, "gi"),
  ]),
);
// Emphasis is written with *, never _: CommonMark refuses _ emphasis inside a
// word ("screw_s_" shows the underscores), and has no such rule for *. Text
// asterisks are escaped, so they cannot clash.
const EMPHASIS: ReadonlyMap<string, string> = new Map([
  ["strong", "**"],
  ["b", "**"],
  ["em", "*"],
  ["i", "*"],
]);
// Block markup the converter wrote, in the text a link or emphasis would wrap:
// a line that begins with a heading, list or table-row marker (tested on the
// whole segment, since a heading's marker follows the blank line it opens
// with), or a blank line inside the trimmed text. Text never matches: a line
// of text begins with the TEXT_LINE mark, and text mid-line has no newline.
// The output never holds more than two newlines in a row, so a wrap opened
// straight after a paragraph break holds no newline before the block it
// wraps; BLOCK_START catches that case, tested only when the wrap opened at a
// line's start.
const BLOCK_LINE = /\n[ \t]*(?:#{1,6} |- |\d+\. |\|)/;
const BLOCK_START = /^[ \t]*(?:#{1,6} |- |\d+\. |\|)/;
const BLANK_LINE = /\n[ \t]*\n/;
// Tags that open or close a block the converter writes itself.
const STRUCTURE = /^(?:h[1-6]|ul|ol|li|table|tr|td|th)$/;

// Marks text that begins a line; never present in decoded text (NUL is
// stripped from it) and removed before htmlToMarkdown returns.
const TEXT_LINE = "\0";
// Stands for the & of an entity reference the converter does not decode, so
// the escaping step leaves it alone and markdown-it decodes it. Stripped from
// text before use, like TEXT_LINE.
const PASS_AMP = "\u0001";
// Placeholders around each bold or italic element and each link address,
// while the converter writes. emitEmphasis reads the formatting of every
// character from the emphasis pairs, writes the marks itself, and takes the
// address placeholders out. They are private-use characters, stripped from
// text like the sentinels above.
const STRONG_OPEN = String.fromCharCode(0xe000);
const STRONG_CLOSE = String.fromCharCode(0xe001);
const EM_OPEN = String.fromCharCode(0xe002);
const EM_CLOSE = String.fromCharCode(0xe003);
const HREF_OPEN = String.fromCharCode(0xe004);
const HREF_CLOSE = String.fromCharCode(0xe005);
const PLACEHOLDERS = new RegExp(`[${STRONG_OPEN}-${HREF_CLOSE}]`, "g");
const stripSentinels = (s: string): string =>
  s.replaceAll(TEXT_LINE, "").replaceAll(PASS_AMP, "").replace(PLACEHOLDERS, "");

// Nesting caps. A crafted description could nest lists or emphasis thousands
// deep; past these depths a list is written at its parent's indent and an
// emphasis or link is ignored, so output grows no faster than input and no
// close tag scans a long stack. Real descriptions stay far below both.
const MAX_LIST_DEPTH = 8;
const MAX_INLINE_DEPTH = 16;

// The start of a tag: < or </ and the name. tagEnd finds where it ends.
// The name runs, as a browser reads it, from a letter to HTML whitespace, /
// or >, so "a-x", "a:x" and 'a"q"' are whole names and must be followed by
// one of those (the lookahead). The name once ended at the first character
// that was not a letter or digit, so <a-x href=...> was read as a link and
// <ul-x> or <h2:x> as a list or heading (issue #131). Such a name matches no
// tag onTag knows, so it is dropped and its text kept, like any unknown tag.
// The name holds no <, for the same reason the attributes hold none (see
// tagEnd).
const TAG = /<(\/?)([A-Za-z][^\t\n\f\r /<>]*)(?=[\t\n\f\r />])/y;
// One attribute of a tag, from the first character of its name, read as a
// browser's tokenizer reads it: the name runs to whitespace, /, = or >, but
// may begin with an = (so "=href" is not href); then an optional value,
// double-quoted, single-quoted or bare. hrefOf reads them in order.
// Whitespace here is HTML's, tab, LF, FF, CR and space, never JavaScript's
// \s: a browser keeps a no-break space, a BOM or a vertical tab inside a name
// or a bare value (PR #121 review).
const ATTR =
  /(=?[^\t\n\f\r /=>]*)(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:"([^"]*)"|'([^']*)'|([^\t\n\f\r >]*)))?/y;
// What separates attributes: HTML whitespace and /. Neither starts a name.
const ATTR_SKIP = /[\t\n\f\r /]/;
const isSpace = (c: string): boolean => /\s/.test(c);

interface Inline {
  readonly tag: string;
  start: number;
  readonly href: string | null;
}

// The converter's output, built from parts so that appending never copies
// what is already written. Reads look only near the end, and the last
// non-whitespace position is kept up to date, so "is there text after this
// point" costs nothing however long the output is.
//
// It also holds the open links and emphasis. Each one's start is a position
// in this buffer, and closing it writes its [ or marks there, so that start
// must always fall where an append began or where only whitespace was cut:
// anywhere else it could sit between a backslash and the character it
// escapes, and the marks would un-escape designer text (a "!" left bare
// before a link's [ makes it an image). The buffer is private, and the only
// ways to change it are below; each keeps every open start valid, so no
// caller has to remember to (PR #24 review, issue #33).
//   append                 adds text after every open start; none moves
//   truncate               an open start past the cut is moved back to it
//                          when only whitespace lay between, and the
//                          element is dropped when text did (its markup is
//                          never written, its text stays)
//   insert                 open starts after the insertion move with it
//   replaceTrailingSpace   an open start in the replaced whitespace moves to
//                          after the replacement
class Output {
  private parts: string[] = [];
  private size = 0;
  private lastText = -1;
  private readonly inline: Inline[] = []; // open emphasis and links, oldest first

  get length(): number {
    return this.size;
  }

  append(s: string): void {
    if (!s) return;
    this.parts.push(s);
    const last = lastNonSpace(s);
    if (last >= 0) this.lastText = this.size + last;
    this.size += s.length;
  }

  // Everything from position `from` to the end.
  from(from: number): string {
    if (from >= this.size) return "";
    let start = this.size;
    let i = this.parts.length;
    while (i > 0 && start > from) {
      i--;
      start -= (this.parts[i] as string).length;
    }
    return this.parts
      .slice(i)
      .join("")
      .slice(from - start);
  }

  // Drops everything from position `to` on. An open link or emphasis that
  // began after `to` keeps its place at `to` when only whitespace is cut
  // before it, and is dropped when text is: the text it would wrap is being
  // removed or rewritten.
  truncate(to: number): void {
    if (to >= this.size) return;
    const target = Math.max(0, to);
    const past = this.inline.filter((e) => e.start > target);
    if (past.length > 0) {
      const removed = this.from(target);
      for (const e of past) {
        if (removed.slice(0, e.start - target).trim() === "") e.start = target;
        else this.inline.splice(this.inline.indexOf(e), 1);
      }
    }
    this.cut(target);
  }

  // Inserts `s` at position `at`; open starts after `at` move with the text.
  insert(at: number, s: string): void {
    if (!s || at >= this.size) {
      this.append(s);
      return;
    }
    const rest = this.from(at);
    this.cut(at);
    this.append(s + rest);
    for (const e of this.inline) if (e.start > at) e.start += s.length;
  }

  // Replaces the whitespace at the end with `s`. An open link or emphasis
  // that began in that whitespace (or right where it began) now begins
  // after `s`, so `s` stays outside its markup.
  replaceTrailingSpace(s: string): void {
    const at = this.lastText + 1;
    const moved = this.inline.filter((e) => e.start >= at);
    this.cut(at);
    this.append(s);
    for (const e of moved) e.start = this.size;
  }

  // Opens a link or emphasis at the end; false (and nothing opened) past
  // MAX_INLINE_DEPTH.
  openInline(tag: string, href: string | null): boolean {
    if (this.inline.length >= MAX_INLINE_DEPTH) return false;
    this.inline.push({ tag, start: this.size, href });
    return true;
  }

  // Closes the innermost open `tag`, returning it, or undefined if none is
  // open. Writing its markup moves the text after its start, so every
  // element opened inside it and still open (misnested tags, as in
  // <i>a<b>b</i>c</b>) is dropped with it: its markup is never written.
  closeInline(tag: string): Readonly<Inline> | undefined {
    const idx = this.inline.findLastIndex((e) => e.tag === tag);
    if (idx === -1) return undefined;
    return this.inline.splice(idx)[0];
  }

  // Drops every open link or emphasis that began at or after `from`; markup
  // cannot span a table cell.
  endInlineFrom(from: number): void {
    for (let i = this.inline.length - 1; i >= 0; i--) {
      if ((this.inline[i] as Inline).start >= from) this.inline.splice(i, 1);
    }
  }

  // The character at position `at`; cheap near the end.
  charAt(at: number): string {
    if (at < 0 || at >= this.size) return "";
    let start = this.size;
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const part = this.parts[i] as string;
      start -= part.length;
      if (at >= start) return part.charAt(at - start);
    }
    return "";
  }

  last(): string {
    return this.charAt(this.size - 1);
  }

  hasTextFrom(from: number): boolean {
    return this.lastText >= from;
  }

  toString(): string {
    return this.parts.join("");
  }

  // The raw cut, with no care for open starts; only the methods above call
  // it, each after putting the starts it affects right.
  private cut(to: number): void {
    if (to >= this.size) return;
    const target = Math.max(0, to);
    while (this.parts.length > 0 && this.size > target) {
      const last = this.parts.pop() as string;
      this.size -= last.length;
      if (this.size < target) {
        this.parts.push(last.slice(0, target - this.size));
        this.size = target;
      }
    }
    // The last text was cut: find the new one by walking the parts from the
    // end, each character once. (Reading it through charAt, which walks the
    // parts from the end on every call, made a run of one-space parts cost
    // the square of its length; PR #24 review.)
    if (this.lastText >= this.size) {
      this.lastText = -1;
      let end = this.size;
      for (let p = this.parts.length - 1; p >= 0; p--) {
        const part = this.parts[p] as string;
        end -= part.length;
        const last = lastNonSpace(part);
        if (last >= 0) {
          this.lastText = end + last;
          break;
        }
      }
    }
  }
}

// The index of the last non-whitespace character in `s`, or -1.
function lastNonSpace(s: string): number {
  for (let i = s.length - 1; i >= 0; i--) if (!isSpace(s.charAt(i))) return i;
  return -1;
}

interface List {
  ordered: boolean;
  n: number;
  indent: string;
  lastContentCol: number;
  // A heading or table left this list (blockColumn), so its next item
  // starts after a blank line.
  breakBeforeItem: boolean;
}
// A list opened inside a table cell: written on the row, so it only counts.
interface CellList {
  ordered: boolean;
  n: number;
}
interface Item {
  markerStart: number;
  textStart: number;
  list: List | undefined;
  dropped: boolean;
  contentCol: number;
}
interface Table {
  nested: boolean;
  indent: string; // written before each row: the list item's indent, if any
  item: Item | undefined; // the list item the table opened in
  rows: number;
  cells: number;
  rowOpen: boolean; // a <tr> has opened and no </tr> has closed it yet
  rowStart: number;
  cellStart: number;
  maxCells: number;
  headerCells: number;
  headerEnd: number;
  sepEnd: number;
  lists: number; // lists opened outside its cells and still open
}

// Text as Markdown that markdown-it shows as written. Entities the converter
// knows are decoded first; any other reference is passed through for
// markdown-it to decode. Whitespace collapses to single spaces, so
// "&nbsp; &nbsp; " is one space and cannot indent a line into a code block.
// Then, in the decoded text only:
//   \ ` * _ [ ] ~ |   backslash-escaped anywhere (escapes, code, emphasis,
//                     links and images, fences and ~~, table rows)
//   !                 backslash-escaped anywhere: the converter writes a link's
//                     [ straight after the text before it, so a ! there would
//                     make the link an image
//   < >               backslash-escaped anywhere (autolinks, which markdown-it
//                     reads even with html off, and > quotes)
//   &                 backslash-escaped where it would start an entity, since
//                     markdown-it decodes &lt; and the rest in text
// Block syntax at a line's start is escaped later (escapeTextLineStart).
// Nothing else is: markdown-it has no math, attribute lists, definition lists
// or end-of-block markers, so $ { : ^ are plain text there.
function textToMarkdown(raw: string): string {
  return mapEntities(stripSentinels(raw), (whole) => PASS_AMP + whole.slice(1), stripSentinels)
    .replace(/\s+/g, " ")
    .replace(/[\\`*_[\]~|<>!]/g, "\\$&")
    .replace(/&(?=#?[A-Za-z0-9]+;)/g, "\\&")
    .replaceAll(PASS_AMP, "&");
}

// HTML to readable Markdown: h1-h6 to # headings (an empty one dropped, a
// trailing # escaped), p and br to paragraphs and line breaks, strong/b to
// **, em/i to *, ul/ol items to - and 1. (an empty item dropped, a nested
// list indented to its item's text, and so a heading or table in an item
// and the text after it), links to [text](href) for http(s) only,
// tables to pipe tables with the first row as the header (padded to the
// widest row; a heading or list in a cell stays on its row, items joined by
// "; "; a table in a cell is flattened into it, cells joined by spaces and
// rows by "; "), a block element, and any element HTML does not define, to a
// paragraph break (a space in a list item or a table cell), every other tag
// dropped (its text kept, except script, style and the like), comments
// dropped (an unterminated one drops the rest),
// runs of blank lines collapsed, trimmed. Text is escaped as textToMarkdown
// says; the converter's own markup is not escaped. A line break is a single
// newline, which renderMarkdown shows as a line break.
/**
 * The converter's version, raised whenever htmlToMarkdown writes something
 * different for some input. 1 is 0.1.0-rc.1 to rc.3, 2 is 0.1.0-rc.4 and
 * 0.1.0, 3 is 0.1.1-rc.1 (#357: a block boundary always breaks the
 * paragraph), 4 is 0.1.1 from rc.2 (every element HTML does not define is a
 * block boundary, so MakerWorld's Membership box and any box it adds later
 * no longer run their text together). Ingest stores it beside each
 * description it writes, so the re-conversion on upgrade
 * (apps/server/src/library/reconvert.ts) knows which stored descriptions an
 * older converter wrote, and its step is named for it, so it runs once for
 * each version.
 */
export const CONVERTER_VERSION = 4;

/** A MakerWorld description (HTML) as Markdown, with the current converter. */
export function htmlToMarkdown(html: string | null | undefined): string {
  return convert(html, BLOCK, true);
}

/**
 * htmlToMarkdown as 0.1.1-rc.1 shipped it (version 3), which knew BLOCK's
 * elements as blocks and dropped every other element it did not handle, its
 * text kept; test/fixtures/converter-0.1.1-rc.1.json holds what that release
 * wrote. Used only to recognise what it stored, never to write.
 */
export function htmlToMarkdown011Rc1(html: string | null | undefined): string {
  return convert(html, BLOCK, false);
}

/**
 * htmlToMarkdown as 0.1.0-rc.4 and 0.1.0 shipped it (version 2), which knew
 * only BLOCK_0_1_0 as blocks; test/fixtures/converter-0.1.0.json holds what
 * that release wrote. Used only to recognise what it stored, never to write.
 * A change to the converter that changes its output for any input other
 * than through which elements are blocks (BLOCK, and whether an element HTML
 * does not define is one) must first freeze a copy of convert, as
 * legacy/markdown-rc.ts freezes version 1.
 */
export function htmlToMarkdown010(html: string | null | undefined): string {
  return convert(html, BLOCK_0_1_0, false);
}

/**
 * What every earlier converter writes for html, oldest first, trimmed as
 * ingest stores it: version 1 (legacy/markdown-rc.ts), version 2
 * (htmlToMarkdown010) and version 3 (htmlToMarkdown011Rc1).
 */
export function earlierConversions(
  html: string | null | undefined,
): Array<{ version: number; markdown: string }> {
  return [
    { version: 1, markdown: htmlToMarkdownRc(html).trim() },
    { version: 2, markdown: htmlToMarkdown010(html).trim() },
    { version: 3, markdown: htmlToMarkdown011Rc1(html).trim() },
  ];
}

// blocks: the elements that end a paragraph. unknownIsBlock: whether every
// element HTML_ELEMENTS does not name ends one too (version 4 on).
function convert(
  html: string | null | undefined,
  blocks: ReadonlySet<string>,
  unknownIsBlock: boolean,
): string {
  if (!html) return "";
  const out = new Output();
  const lists: List[] = []; // open lists outside cells
  // Open lists inside the open cell, kept apart so that nothing outside a
  // cell scans past them, and emptied when the cell closes (PR #24 review).
  const cellLists: CellList[] = [];
  const tables: Table[] = []; // open tables
  const items: Item[] = []; // open list items outside cells
  let inCell = false;
  let listDepth = 0; // open lists outside cells
  let dropDepth = 0;
  let headingStart = -1;
  let headingMarker = -1; // where the open heading's line (indent, "#") begins
  let headingCol = 0; // the column the open heading is written at
  let headingItem: Item | undefined; // the list item the open heading is in
  let headingLists = 0; // lists open outside cells when the heading opened
  // A table or list structure ended the open heading before its close tag
  // (endHeading below); that close tag then must not break the block.
  let headingEnded = false;
  let itemStart = -1; // where the text of the open list item begins

  // A paragraph break; idempotent, so the output never holds more than two
  // newlines in a row (more would collapse to two at the end anyway).
  const breakBlock = (): void => {
    if (out.length === 0) out.append("\n\n");
    else if (out.last() !== "\n") out.append("\n\n");
    else if (out.charAt(out.length - 2) !== "\n") out.append("\n");
  };
  const outerList = (): List | undefined => lists.at(-1);
  // The open list item whose nested list, heading or table just closed,
  // while nothing has been written after it, and the column to write at:
  // text that follows goes back to that item, after a blank line (onText).
  let resume: { item: Item; col: number } | undefined;
  const resumeAt = (item: Item | undefined, col: number): void => {
    if (item && item === items.at(-1)) resume = { item, col };
  };
  // A list item with no text yet would keep a bare marker if a block (a
  // nested list, a heading, a table) opened in it: CommonMark does not read a
  // marker with nothing after it as the item meant, so a bare "-" or "1."
  // joins the item above or turns its text into a setext heading. The marker
  // is dropped, and an ordered list's numbering stays continuous.
  const dropBareMarker = (): void => {
    const item = items.at(-1);
    if (!item || item.dropped || out.hasTextFrom(item.textStart)) return;
    out.truncate(item.markerStart);
    item.dropped = true;
    itemStart = -1;
    if (item.list?.ordered) item.list.n--;
  };
  // The column a heading or table opened outside a cell is written at, after
  // dropBareMarker and a blank line. In a list item it is the item's indent,
  // so the block stays in the item: at column 0 it would end the list, and
  // in an ordered list the item's text after it would then run into the
  // next item's marker, which markdown-it reads as text unless the list
  // starts at 1 (PR #24 review). An item that lost its bare marker to the
  // block has no text to hold it, so the block leaves that list, at the
  // list's own indent (column 0 for a top-level list, the enclosing item's
  // indent for a nested one), and the list's next item starts after a blank
  // line so that it begins a list rather than running into the text.
  const blockColumn = (): number => {
    const item = items.at(-1);
    if (!item) return 0;
    if (!item.dropped) return item.contentCol;
    if (item.list) item.list.breakBeforeItem = true;
    return item.list?.indent.length ?? 0;
  };
  // True while the open list item (outside a cell) has no text yet.
  const itemEmpty = (): boolean => {
    const item = items.at(-1);
    return Boolean(item && !item.dropped && !out.hasTextFrom(item.textStart));
  };
  // A line break, outside a cell; at most two newlines in a row.
  const newline = (): void => {
    // In a cell, one space however many breaks: a space per <br> made a run
    // of one-space parts that a later cut re-read (PR #24 review).
    if (inCell) space();
    // In a list, one newline however many breaks, as a <p> in an item is a
    // space: a blank line there, with the text after it at column 0, ended
    // the list, and in an ordered list the next item then rendered as text,
    // since markdown-it lets a numbered list interrupt a paragraph only at 1
    // (PR #24 review).
    // In a table, outside its cells, one newline however many breaks, or a
    // space in a row before its first cell: a blank line there split the
    // table (PR #24 review).
    else if (tables.length > 0) tableLine();
    else if (lists.length > 0) endLine();
    else if (!(out.last() === "\n" && out.charAt(out.length - 2) === "\n")) out.append("\n");
  };
  const endLine = (): void => {
    if (out.length > 0 && out.last() !== "\n") out.append("\n");
  };
  // The open table that is not nested in a cell, while no cell is open in
  // it: between its rows, or in a row before its first cell.
  const rowTable = (): Table | undefined => (inCell ? undefined : tables.at(-1));
  // A line end in rowTable(), or a space in a row before its first cell,
  // where a line end would end the row. Text that follows on a line of its
  // own takes the table's indent (onText), which markdown-it reads as a
  // one-cell row.
  const tableLine = (): void => {
    if (tables.at(-1)?.rowOpen) space();
    else endLine();
  };
  // Inside a table cell a line break would end the pipe-table row, so a
  // heading or a list there is written on the row: a space where it opens or
  // closes, and "; " between list items.
  const space = (): void => {
    if (out.length > 0 && !isSpace(out.last())) out.append(" ");
  };
  // Closes the open cell of a table that is not nested in a cell: its text
  // trimmed and written as one pipe-table cell. Called by </td>, and by
  // whatever HTML lets close a cell with </td> left out (the next <td> or
  // <th>, <tr>, </tr>, </table>). A cell left open kept its start while a
  // link opened in it and closed in the next cell rewrote the text before
  // that start, and cutting the cell there split a backslash from the "!" it
  // escaped, which made the designer's link an image (PR #24 review).
  const closeCell = (t: Table): void => {
    if (!inCell) return;
    inCell = false;
    // A list left open in the cell ends with it.
    cellLists.length = 0;
    const cell = out
      .from(t.cellStart)
      .trim()
      .replace(/[ \t]{2,}/g, " ");
    // Markup cannot span cells.
    out.endInlineFrom(t.cellStart);
    out.truncate(t.cellStart);
    out.append(` ${cell} |`);
  };
  // Ends the open heading: its text collapsed onto its one line, an empty
  // heading dropped. CommonMark strips a run of # that ends a heading after
  // a space, so a trailing # is escaped ("Part #" stays "Part #", and
  // "Learn C#" is escaped the same way).
  //
  // The collapse rewrites everything from headingStart, so no table or list
  // item may hold a position past headingStart when it runs: a table that
  // opened in the heading and stayed open past its close once kept its old
  // header and separator ends, which then pointed into a later row's text,
  // and the header's pad split a backslash from the "!" it escaped, making
  // the designer's link an image (issue #40). So a table or list structure
  // that opens or closes while a heading is open ends the heading first
  // (onTag), and the rewrite only ever moves text and inline starts, which
  // Output keeps right.
  const endHeading = (): void => {
    if (headingStart < 0) return;
    const body = out.from(headingStart).replace(/\s+/g, " ").trim();
    const written = out.from(headingStart);
    if (!body) out.truncate(headingMarker);
    else {
      const text = /#$/.test(body) && !/\\#$/.test(body) ? `${body.slice(0, -1)}\\#` : body;
      if (text !== written) {
        out.truncate(headingStart);
        out.append(text);
      }
    }
    headingStart = -1;
  };

  // Where a line's text would begin if text came next: the end of the output
  // less any spaces after a newline (or the start), or after the open list
  // item's marker. -1 when the output is mid-line.
  const textLineStart = (): number => {
    let i = out.length;
    while (i > 0 && (out.charAt(i - 1) === " " || out.charAt(i - 1) === "\t")) i--;
    if (i === 0 || out.charAt(i - 1) === "\n") return i;
    if (itemStart >= 0 && out.length >= itemStart && i <= itemStart) return itemStart;
    return -1;
  };

  const onText = (raw: string): void => {
    if (dropDepth > 0) return;
    let t = textToMarkdown(raw);
    // Text that starts a line is marked, so the final pass can escape block
    // syntax there (a #, -, + ... that the converter did not write). A line
    // still starts here when only spaces follow the newline or the list
    // marker: those spaces (an &nbsp;, an empty <strong> </strong>) are
    // dropped, so whitespace never uses up a line start or indents it.
    if (!inCell && resume && resume.item === items.at(-1) && out.last() === "\n") {
      // Text after a nested list, heading or table in the same item: a blank
      // line ends the block, and the indent keeps the text in the item.
      // Whitespace alone writes nothing, so the list stays tight.
      t = t.trimStart();
      if (!t) return;
      breakBlock();
      out.append(" ".repeat(resume.col) + TEXT_LINE + t);
      resume = undefined;
      return;
    }
    if (!inCell) {
      // Text in a row after its last cell, outside any cell, ends the row:
      // written after the row's last pipe it broke the header row or was
      // dropped from a body row (issue #42). It goes on a line of its own
      // below, which markdown-it reads as a one-cell row. A link or emphasis
      // opened in the row cannot span the row's end, so it is dropped and
      // its text kept. (Text in a row before its first cell joins that cell;
      // in a row with no cell at all, closeRow keeps it as one.)
      const row = tables.at(-1);
      if (row?.rowOpen && row.cells > 0 && t.trim()) {
        out.endInlineFrom(row.rowStart);
        closeRow(row);
      }
      const lineStart = textLineStart();
      if (lineStart >= 0) {
        out.truncate(lineStart);
        t = t.trimStart();
        // Text on a line of its own in an open table, outside its cells (a
        // paragraph or heading between rows, say), takes the table's
        // indent: at column 0 it would end the list item the table is in,
        // and with it the table.
        const table = tables.at(-1);
        const ownLine = lineStart === 0 || out.charAt(lineStart - 1) === "\n";
        if (t) t = (table && ownLine ? table.indent : "") + TEXT_LINE + t;
      }
    }
    // A space meeting a space across dropped markup (an image, an empty
    // link) is one space, as HTML would show it.
    if (t.startsWith(" ") && out.last() === " ") t = t.slice(1);
    out.append(t);
  };

  const onTag = (closing: boolean, rawTag: string, attrs: string): void => {
    // A browser lowercases only A-Z in a tag name. toLowerCase also folds
    // Unicode, and TAG lets non-ASCII into a name, so U+212A KELVIN SIGN
    // would fold to k and make an unknown tag read as blockquote (PR #121
    // review).
    const tag = rawTag.replace(/[A-Z]/g, (c) => c.toLowerCase());
    if (DROP_CONTENT.has(tag)) {
      // A close always ends one drop, and a raw-text element always opens
      // one: a browser ignores a self-closing slash on both, and the
      // tokenizer skips a raw-text element's content to its close tag and
      // closes the drop there either way. Only an svg, say, can close itself
      // with a slash.
      if (closing) dropDepth = Math.max(0, dropDepth - 1);
      else if (RAW_TEXT_CLOSE.has(tag) || !attrs.trim().endsWith("/")) dropDepth++;
      return;
    }
    if (dropDepth > 0) return;
    // Some close tags are ignored on purpose, because acting on them wrote a
    // paragraph break or popped a list, which ended the list they sat in
    // (PR #24 review):
    //   - a heading close with no heading open (outside a table, where a
    //     heading is just its text), as a browser ignores it;
    //   - a </table> with no table open, as a browser ignores it (issue #48);
    //   - a </ul> or </ol> in a table, outside its cells, that closes no list
    //     opened between the table's rows. The table is a scope boundary, so
    //     a browser ignores it too; closing the list the table sits in split
    //     the table and ended that list (issue #43);
    //   - anywhere else, a </ul> or </ol> that does not match the innermost
    //     open list. This one differs from a browser when an outer list of
    //     that type is open: a browser closes every list up to that outer one,
    //     while the converter keeps them all open, so the text after the
    //     close stays in the innermost list (the test "a </ul> inside an
    //     ordered list nested in an unordered one keeps the numbering" pins
    //     it). With no list of that type open, the browser ignores it as well.
    if (closing) {
      const table = rowTable();
      const strayHeading =
        /^h[1-6]$/.test(tag) && !inCell && tables.length === 0 && headingStart < 0 && !headingEnded;
      const strayTable = tag === "table" && tables.length === 0;
      const strayList =
        (tag === "ul" || tag === "ol") &&
        !inCell &&
        (table ? table.lists === 0 : outerList()?.ordered !== (tag === "ol"));
      if (strayHeading || strayTable || strayList) return;
    }
    // A heading, list, item or table after a nested list, heading or table
    // writes its own block, so text after it does not go back to the item;
    // the close of a nested list, heading or table sets resume again below.
    if (STRUCTURE.test(tag)) resume = undefined;
    // A table or list structure inside an open heading ends the heading
    // first (endHeading says why). A heading is never open in a cell: one
    // opened there writes a space, and a cell opening ends it here.
    if (headingStart >= 0 && /^(?:ul|ol|li|table|tr|td|th)$/.test(tag)) {
      endHeading();
      headingEnded = true;
    }

    if (/^h[1-6]$/.test(tag) && (inCell || tables.length > 0)) {
      // In a cell, or between a table's rows, a heading is just its text: a
      // heading's blank line there would end the row or split the table
      // (PR #24 review). A heading that opened before the table and ended
      // where the table opened closes here too, writing no break.
      space();
      headingStart = -1;
      headingEnded = false;
      if (!inCell) headingItem = undefined;
    } else if (/^h[1-6]$/.test(tag)) {
      if (!closing) {
        dropBareMarker();
        breakBlock();
        headingMarker = out.length;
        headingCol = blockColumn();
        headingItem = items.at(-1);
        headingLists = lists.length;
        headingEnded = false;
        out.append(`${" ".repeat(headingCol)}${"#".repeat(Number(tag[1]))} `);
        headingStart = out.length;
      } else if (headingEnded) {
        // The heading already ended where a table or list opened in it (a
        // table still open is handled above). In a list that opened in the
        // heading the close is a space, as a paragraph's is in a list.
        // Otherwise it ends the heading's block, but only while the heading's
        // own list item is still the innermost open one and its list is
        // still open. Once that item or list has closed, the close is stray
        // and writes nothing: its paragraph break went into a later item,
        // which pushed the rest of that item to column 0 and ended the list
        // (issue #46).
        headingEnded = false;
        if (lists.length > headingLists) space();
        else if (headingItem === items.at(-1) && lists.length === headingLists) {
          breakBlock();
          resumeAt(headingItem, headingCol);
        }
        headingItem = undefined;
      } else {
        endHeading();
        breakBlock();
        resumeAt(headingItem, headingCol);
        headingItem = undefined;
      }
    } else if (tag === "br") {
      // A line break before an item's first text would leave a bare marker on
      // a line of its own; it is dropped so the text stays on the marker's line.
      if (inCell || !itemEmpty()) newline();
    } else if ((tag === "ul" || tag === "ol") && inCell) {
      if (!closing) cellLists.push({ ordered: tag === "ol", n: 0 });
      else cellLists.pop();
      space();
    } else if (tag === "li" && inCell) {
      // Only a list opened in this cell numbers its items; an outer list's
      // count is left alone.
      const list = cellLists.at(-1);
      if (!closing) {
        const n = list ? ++list.n : 1;
        const table = tables.at(-1);
        if (n > 1 && table && out.hasTextFrom(table.cellStart)) out.replaceTrailingSpace("; ");
        else space();
        if (list?.ordered) out.append(`${n}. `);
      }
    } else if ((tag === "ul" || tag === "ol") && rowTable()) {
      // A list between a table's rows is its items, each on a line of its
      // own (the <li> below): a list's blank line or "- " marker there ended
      // the table, so the rows after it showed as text with pipes (PR #24
      // review). A close with no such list open was ignored above (issue
      // #43), so the count never goes below 0.
      (rowTable() as Table).lists += closing ? -1 : 1;
      tableLine();
    } else if (tag === "li" && rowTable()) {
      tableLine();
    } else if (tag === "ul" || tag === "ol") {
      // A list nested in a list item continues that list; a top-level one is a block.
      if (!closing) {
        // An item with no text before its nested list loses its bare
        // marker: the nested items sit under the item before it.
        dropBareMarker();
        const parent = outerList();
        if (parent) endLine();
        else breakBlock();
        // CommonMark nests a list under an item only when it is indented to
        // the item's text: two spaces under "- ", three under "1. ".
        let indent = "";
        if (parent) {
          const item = items.at(-1);
          if (listDepth >= MAX_LIST_DEPTH) indent = parent.indent;
          else if (item && item.list === parent) indent = " ".repeat(item.contentCol);
          else indent = " ".repeat(parent.lastContentCol || parent.indent.length + 2);
        }
        lists.push({
          ordered: tag === "ol",
          n: 0,
          indent,
          lastContentCol: 0,
          breakBeforeItem: false,
        });
        listDepth++;
      } else {
        const closed = lists.pop();
        if (closed) listDepth--;
        // Items left open in the closed list (an <li> with no </li>) end with it.
        while (items.length > 0 && closed && items.at(-1)?.list === closed) {
          items.pop();
          itemStart = -1;
        }
        const parent = outerList();
        if (parent) {
          endLine();
          // Text after a nested list, still inside the item that holds it,
          // belongs to that item: it is written after a blank line at the
          // item's indent (onText), not at column 0, where CommonMark would
          // read it as a lazy continuation of the nested item's last line.
          const item = items.at(-1);
          if (closed && item?.list === parent) resumeAt(item, item.contentCol);
        } else breakBlock();
      }
    } else if (tag === "li") {
      const list = outerList();
      if (!closing) {
        // An item left open in this list (no </li>) ends where the next begins.
        while (items.length > 0 && list && items.at(-1)?.list === list) {
          const open = items.pop() as Item;
          if (!open.dropped && !out.hasTextFrom(open.textStart)) {
            out.truncate(open.markerStart);
            if (list.ordered) list.n--;
          }
        }
        if (list?.breakBeforeItem) {
          breakBlock();
          list.breakBeforeItem = false;
        } else endLine();
        const markerStart = out.length;
        const indent = list?.indent ?? "";
        const marker = list?.ordered ? `${++list.n}. ` : "- ";
        out.append(indent + marker);
        const contentCol = indent.length + marker.length;
        if (list) list.lastContentCol = contentCol;
        itemStart = out.length;
        items.push({ markerStart, textStart: out.length, list, dropped: false, contentCol });
      } else {
        // An empty item (<li>&nbsp;</li>, <li><br></li>) would leave a bare
        // "-" that joins the item above or turns it into a setext heading;
        // it is dropped, and an ordered list's numbering stays continuous.
        const item = items.pop();
        if (item && !item.dropped && !out.hasTextFrom(item.textStart)) {
          out.truncate(item.markerStart);
          if (item.list?.ordered) item.list.n--;
        }
        endLine();
        itemStart = -1;
      }
    } else if (EMPHASIS.has(tag) || tag === "a") {
      if (!closing) out.openInline(tag, tag === "a" ? hrefOf(attrs) : null);
      else {
        // Closing drops every element opened inside this one and still open.
        const open = out.closeInline(tag);
        if (!open) return;
        const seg = out.from(open.start);
        const core = seg.trim();
        const lead = seg.slice(0, seg.length - seg.trimStart().length);
        const trail = seg.slice(seg.trimEnd().length);
        let wrapped = seg;
        // A link or emphasis cannot span a block: around a paragraph break or
        // a heading, list item or table row the converter wrote, its markup
        // would show as text, so it is dropped and the content kept as is.
        const atLineStart = open.start === 0 || out.charAt(open.start - 1) === "\n";
        if (
          BLOCK_LINE.test(seg) ||
          (atLineStart && BLOCK_START.test(seg)) ||
          BLANK_LINE.test(core)
        ) {
          // keep seg unchanged
        } else if (tag === "a") {
          const href = open.href === null ? null : safeHref(open.href);
          // A link with no text (an image wrapped in a link, once the image is
          // dropped) produces nothing, not its address: a description that is
          // only a linked image must stay empty.
          // The address sits between placeholders, so emitEmphasis never
          // puts a mark in it or swaps its letters in the probe.
          if (href && core) wrapped = `${lead}[${core}](${HREF_OPEN}${href}${HREF_CLOSE})${trail}`;
        } else if (core) {
          // Placeholders, not marks: they record which text this element
          // made bold or italic, and emitEmphasis writes the marks once the
          // whole text is known.
          const strong = EMPHASIS.get(tag) === "**";
          wrapped =
            lead +
            (strong ? STRONG_OPEN : EM_OPEN) +
            core +
            (strong ? STRONG_CLOSE : EM_CLOSE) +
            trail;
        }
        if (wrapped !== seg) {
          out.truncate(open.start);
          out.append(wrapped);
        }
      }
    } else if (tag === "table") {
      // A table inside a table cell cannot be a pipe table there: it is
      // flattened into the outer cell as text, its cells joined by spaces and
      // its rows by "; ", and the outer cell stays open.
      if (!closing) {
        const outer = tables.at(-1);
        if (inCell && outer)
          tables.push({ ...newTable(), nested: true, cellStart: outer.cellStart });
        else {
          dropBareMarker();
          breakBlock();
          const indent = " ".repeat(blockColumn());
          tables.push({ ...newTable(), indent, item: items.at(-1) });
        }
      } else {
        const t = tables.pop();
        if (t?.nested) space();
        else {
          // A cell or row left open (no </td>, no </tr>) ends with the table.
          if (t) closeCell(t);
          if (t?.rowOpen) closeRow(t);
          if (t) padHeader(t);
          cellLists.length = 0;
          inCell = false;
          breakBlock();
          if (t) resumeAt(t.item, t.indent.length);
        }
      }
    } else if (tag === "tr" && tables.at(-1)?.nested) {
      const t = tables.at(-1) as Table;
      if (!closing) {
        if (t.rows > 0 && out.hasTextFrom(t.cellStart)) out.replaceTrailingSpace("; ");
        else space();
        t.cells = 0;
      } else t.rows++;
    } else if ((tag === "td" || tag === "th") && tables.at(-1)?.nested) {
      const t = tables.at(-1) as Table;
      if (!closing) {
        if (t.cells++ > 0) space();
      } else space();
    } else if (tag === "tr" && tables.length > 0) {
      const t = tables.at(-1) as Table;
      // A cell left open (no </td>) ends with its row.
      closeCell(t);
      if (!closing) {
        // A row left open (no </tr>) ends where the next begins.
        if (t.rowOpen) closeRow(t);
        openRow(t);
      } else if (t.rowOpen) {
        // A </tr> with no row open closes nothing. Closing anyway, before
        // the first row it cut from the row start a table begins with, 0,
        // which erased everything before the table; after a closed row it
        // wrote a blank line that split the table (PR #24 review).
        closeRow(t);
      }
    } else if ((tag === "td" || tag === "th") && tables.length > 0) {
      const t = tables.at(-1) as Table;
      // A cell left open (no </td>) ends where the next begins.
      closeCell(t);
      if (!closing) {
        // A cell with no row open (no <tr>) opens one, as a browser does; it
        // once opened outside any row, so its pipes showed as text.
        if (!t.rowOpen) openRow(t);
        // Markup cannot span a cell: a link or emphasis opened in the row
        // before this cell and closed inside it would rewrite the text
        // before the cell's start, and cutting the cell there split a
        // backslash from the "!" it escaped (PR #24 review).
        out.endInlineFrom(t.rowStart);
        t.cells++;
        inCell = true;
        t.cellStart = out.length;
      }
    } else if (blocks.has(tag) || (unknownIsBlock && !HTML_ELEMENTS.has(tag))) {
      // Inside a list item or a table cell a paragraph is just the text, with
      // a space where it opens or closes so two paragraphs' words stay apart.
      // Between a table's rows it is the same: a paragraph break there split
      // the table (PR #24 review). An element HTML does not define (a
      // MakerWorld box, a custom element, a malformed name) is the same
      // (HTML_ELEMENTS says why).
      if (lists.length === 0 && !inCell && tables.length === 0) breakBlock();
      else space();
    }
    // Every other tag HTML defines (img, span, font, ...) is dropped; its
    // text stays.
  };

  // Opens a row of a table that is not nested in a cell, on a line of its
  // own. Called by <tr>, and by a <td> or <th> with no row open.
  const openRow = (t: Table): void => {
    endLine();
    t.rowStart = out.length;
    t.cells = 0;
    t.rowOpen = true;
    out.append(`${t.indent}|`);
  };

  // Closes the open row of a table that is not nested in a cell. Called by
  // </tr>, and by whatever HTML lets close a row with </tr> left out (the
  // next <tr>, </table>). A row left open once got no separator after the
  // first row, so the table rendered as text, and did not count its cells,
  // so a wider last row lost the cells past the header (issue #41).
  const closeRow = (t: Table): void => {
    t.rowOpen = false;
    // A row with no cell but text in it (written straight after its pipe) is
    // a one-cell row; it was cut as empty, which deleted the text (issue #42).
    const textStart = t.rowStart + t.indent.length + 1;
    if (t.cells === 0 && out.hasTextFrom(textStart)) {
      t.cellStart = textStart;
      t.cells = 1;
      inCell = true;
      closeCell(t);
    }
    if (t.cells === 0) {
      out.truncate(t.rowStart); // an empty row leaves nothing
      return;
    }
    // The first row is the header, so the separator line follows it.
    if (t.rows === 0) {
      t.headerEnd = out.length;
      t.headerCells = t.cells;
      out.append(`\n${t.indent}|${" --- |".repeat(t.cells)}`);
      t.sepEnd = out.length;
      out.append("\n");
    } else out.append("\n");
    t.maxCells = Math.max(t.maxCells, t.cells);
    t.rows++;
  };

  // markdown-it drops the cells of a row past the header's count, so a table
  // whose widest row is wider than its first gets empty header cells.
  const padHeader = (t: Table): void => {
    const extra = t.maxCells - t.headerCells;
    if (t.rows === 0 || extra <= 0) return;
    // The separator's pad first, so the header's end has not moved yet.
    out.insert(t.sepEnd, " --- |".repeat(extra));
    out.insert(t.headerEnd, " |".repeat(extra));
  };

  // The tokenizer: comments, tags and text, each found by a scan that stops
  // at the next < or at the end of the comment, so the whole pass is linear.
  const tagScan = newTagScan(html);
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      onText(html.slice(i));
      break;
    }
    if (lt > i) {
      onText(html.slice(i, lt));
      i = lt;
    }
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      if (end === -1) break; // an unterminated comment runs to the end
      i = end + 3;
      continue;
    }
    TAG.lastIndex = i;
    const m = TAG.exec(html);
    const end = m ? tagEnd(html, TAG.lastIndex, tagScan) : -1;
    if (m && end !== -1) {
      const closing = m[1] === "/";
      const name = m[2] as string;
      onTag(closing, name, html.slice(TAG.lastIndex, end));
      i = end + 1;
      // A raw-text element's content is skipped whole (RAW_TEXT_CLOSE), and
      // its close tag ends it: the drop is closed here and the tokenizer
      // moves on after that tag's >, found by endTagEnd. The search starts
      // where the content does and the tokenizer moves on from where it
      // stops, so the pass stays linear.
      const lower = closing ? "" : name.replace(/[A-Z]/g, (c) => c.toLowerCase());
      const close = closing ? undefined : RAW_TEXT_CLOSE.get(lower);
      if (close !== undefined) {
        close.lastIndex = i;
        const found = close.exec(html);
        if (found === null) i = html.length;
        else {
          onTag(true, lower, "");
          const gt = endTagEnd(html, found.index + 2 + lower.length);
          i = gt === -1 ? html.length : gt + 1;
        }
      }
    } else {
      onText("<"); // a < that starts no tag is text
      i += 1;
    }
  }

  return emitEmphasis(out.toString());
}

// The converter's line-level finish: block syntax at a text line's start
// escaped, line ends trimmed, runs of blank lines collapsed. Placeholders
// pass through it as the marks would: none is whitespace, and none can make
// a line start look like block syntax.
function finishLines(raw: string): string {
  return raw
    .split("\n")
    .map((line) => trimLineEnd(escapeTextLineStart(line)).replace(/^ (?=\S)/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Bold and italic, decided from what each character should look like rather
// than from how marks pair (0.1.0 release review of PR #334, issues #346,
// #348 and #352). Checking how markdown-it paired the marks was always one
// level too shallow: marks that pair "correctly" can still render the wrong
// kind (<i><i>x</i></i> written **x** is bold) or land on other text.
//
// 1. Flatten. The converter wrote a placeholder pair around each bold or
//    italic element. From them, every character gets two flags, bold and
//    italic: an element inside one of its own kind adds nothing, so
//    <i><i>x</i></i> is just italic. Whitespace, a line break included,
//    takes the flags its two neighbours share, so marks hug the text; a
//    paragraph break and the text's ends are plain. Neighbouring characters
//    with the same flags form one run.
// 2. Emit. Each stretch of runs with a flag gets one emphasis of that kind,
//    the kind that runs on longer outermost, nested as marks must be.
// 3. Check. markdown-it, set up as renderMarkdown is, renders a probe copy
//    of the markdown in which every letter and digit is swapped for a
//    private-use character naming its run. Private-use characters are
//    neither whitespace nor punctuation, as letters and digits are not, so
//    markdown-it pairs the marks of the probe exactly as it pairs the real
//    ones. Each rendered character's bold and italic is then compared with
//    its run's flags, and the visible text with the text rendered with no
//    marks at all, so a mark showing as an asterisk is found too.
// 4. Repair. An emphasis whose text renders without it, or whose marks put
//    emphasis on text the HTML did not emphasise, loses its marks (its text
//    stays). In the first rounds only the innermost such emphases go, since
//    an inner one is often what breaks the outer; then every one found. The
//    probe is checked again, for at most MAX_EMPHASIS_ROUNDS rounds; after
//    that every mark is dropped, so the cost stays a few parses however
//    long the description, and nothing is ever shown that the HTML did not
//    say.
const INNERMOST_ROUNDS = 3;
const MAX_EMPHASIS_ROUNDS = 6;
const BOLD = 1;
const ITALIC = 2;

interface Run {
  readonly start: number;
  readonly end: number;
  readonly flags: number;
}

interface Span {
  readonly kind: number;
  readonly from: number; // first run
  to: number; // run after the last
  readonly parent: number; // enclosing span, or -1
  dropped: boolean;
}

let probeParser: MarkdownIt | null = null;

function emitEmphasis(raw: string): string {
  const { text, runs } = flatten(raw);
  const spans = layOut(runs);
  const finish = (s: string): string =>
    finishLines(s).replace(PLACEHOLDERS, (c) =>
      c === STRONG_OPEN || c === STRONG_CLOSE ? "**" : c === EM_OPEN || c === EM_CLOSE ? "*" : "",
    );
  if (spans.length === 0) return finish(text);

  const opensAt: number[][] = Array.from({ length: runs.length + 1 }, () => []);
  const closesAt: number[][] = Array.from({ length: runs.length + 1 }, () => []);
  spans.forEach((sp, id) => {
    (opensAt[sp.from] as number[]).push(id); // outer first: ids rise inward
    (closesAt[sp.to] as number[]).unshift(id); // inner first
  });
  probeParser ??= createMarkdownIt();
  const parser = probeParser;
  const probeText = probeRuns(text, runs, parser.utils);
  const build = (probe: boolean): string => {
    let s = "";
    for (let b = 0; b <= runs.length; b++) {
      for (const id of closesAt[b] as number[]) {
        const sp = spans[id] as Span;
        if (!sp.dropped) s += sp.kind === BOLD ? STRONG_CLOSE : EM_CLOSE;
      }
      for (const id of opensAt[b] as number[]) {
        const sp = spans[id] as Span;
        if (!sp.dropped) s += sp.kind === BOLD ? STRONG_OPEN : EM_OPEN;
      }
      if (b < runs.length) {
        const run = runs[b] as Run;
        s += probe ? probeText[b] : text.slice(run.start, run.end);
      }
    }
    return finish(s);
  };

  // The probe with no marks at all: the visible text every round must show.
  for (const sp of spans) sp.dropped = true;
  const plain = visible(parser, build(true));
  for (const sp of spans) sp.dropped = false;

  for (let round = 0; round < MAX_EMPHASIS_ROUNDS; round++) {
    const blamed = blame(visible(parser, build(true)), plain, runs, spans, opensAt, closesAt);
    if (blamed === null) return build(false);
    if (blamed.size === 0) break;
    // Innermost first: a blamed emphasis with a blamed one inside it waits.
    const waits = new Set<number>();
    if (round < INNERMOST_ROUNDS) {
      for (const id of blamed) {
        for (let up = (spans[id] as Span).parent; up !== -1; up = (spans[up] as Span).parent) {
          if (waits.has(up)) break;
          waits.add(up);
        }
      }
    }
    // Two blamed emphases side by side are often blamed for each other (in
    // **Note:***Use* neither shows); dropping one can let the other show. So
    // in a round no two that touch both go: the narrowest go first, then the
    // first in the text. One left waits a round, and goes then if it still
    // fails, no longer touching one with marks.
    const order = [...blamed]
      .filter((id) => !waits.has(id))
      .sort((p, q) => {
        const a = spans[p] as Span;
        const b = spans[q] as Span;
        return a.to - a.from - (b.to - b.from) || a.from - b.from;
      });
    const edges = new Set<number>();
    for (const id of order) {
      const sp = spans[id] as Span;
      if (round < INNERMOST_ROUNDS && (edges.has(sp.from) || edges.has(sp.to))) continue;
      sp.dropped = true;
      edges.add(sp.from);
      edges.add(sp.to);
    }
  }
  for (const sp of spans) sp.dropped = true;
  return build(false);
}

// The raw text without its emphasis placeholders, and its runs. A
// placeholder pair is the converter's record of one bold or italic element
// around the text it wrapped; one left without its partner (its other half
// was cut away with text) counts for nothing.
function flatten(raw: string): { text: string; runs: Run[] } {
  const paired = new Uint8Array(raw.length);
  const stack: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === STRONG_OPEN || c === EM_OPEN) stack.push(i);
    else if (c === STRONG_CLOSE || c === EM_CLOSE) {
      const top = stack.at(-1);
      if (top !== undefined && raw[top] === (c === STRONG_CLOSE ? STRONG_OPEN : EM_OPEN)) {
        stack.pop();
        paired[top] = 1;
        paired[i] = 1;
      }
    }
  }
  let text = "";
  const flags: number[] = [];
  let bold = 0;
  let italic = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] as string;
    if (c === STRONG_OPEN || c === STRONG_CLOSE || c === EM_OPEN || c === EM_CLOSE) {
      if (paired[i] === 1) {
        if (c === STRONG_OPEN) bold++;
        else if (c === STRONG_CLOSE) bold--;
        else if (c === EM_OPEN) italic++;
        else italic--;
      }
      continue;
    }
    text += c;
    flags.push((bold > 0 ? BOLD : 0) | (italic > 0 ? ITALIC : 0));
  }
  // Whitespace takes the flags both neighbours share, so a mark never sits
  // beside a space it would have to be read across. A line break counts as
  // whitespace (emphasis may run across one), and so does the text-line
  // sentinel; a newline beside another, a blank line, is a paragraph break,
  // which no emphasis crosses, so it is plain and separates.
  const loose = (c: string): boolean => c === " " || c === "\t" || c === TEXT_LINE;
  const breakAt = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\n") continue;
    let j = i + 1;
    while (j < text.length && loose(text[j] as string)) j++;
    if (j === text.length || text[j] === "\n") {
      breakAt[i] = 1;
      if (j < text.length) breakAt[j] = 1;
    }
    let k = i - 1;
    while (k >= 0 && loose(text[k] as string)) k--;
    if (k < 0) breakAt[i] = 1;
  }
  const blank = (i: number): boolean =>
    loose(text[i] as string) || (text[i] === "\n" && breakAt[i] === 0);
  for (let i = 0; i < text.length; i++) if (breakAt[i] === 1) flags[i] = 0;
  const before = new Array<number>(text.length);
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    before[i] = last;
    if (!blank(i)) last = flags[i] as number;
  }
  last = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    if (blank(i)) flags[i] = (before[i] as number) & last;
    else last = flags[i] as number;
  }
  const runs: Run[] = [];
  let start = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || flags[i] !== flags[start]) {
      if (i > start) runs.push({ start, end: i, flags: flags[start] as number });
      start = i;
    }
  }
  return { text, runs };
}

// One emphasis for each stretch of runs with a flag, as properly nested
// marks: at each run, the emphases whose flag it lacks close (with any opened
// inside them, which reopen if the run still has their flag), then the
// flags it has that are not open open, the one that runs on longer first.
function layOut(runs: readonly Run[]): Span[] {
  const extent = [BOLD, ITALIC].map((kind) => {
    const n = new Int32Array(runs.length + 1);
    for (let r = runs.length - 1; r >= 0; r--) {
      n[r] = ((runs[r] as Run).flags & kind) !== 0 ? (n[r + 1] as number) + 1 : 0;
    }
    return n;
  });
  const spans: Span[] = [];
  const open: number[] = [];
  runs.forEach((run, r) => {
    const low = open.findIndex((id) => (run.flags & (spans[id] as Span).kind) === 0);
    if (low !== -1) {
      for (const id of open.splice(low)) (spans[id] as Span).to = r;
    }
    const kinds = [BOLD, ITALIC]
      .filter((k) => (run.flags & k) !== 0 && !open.some((id) => (spans[id] as Span).kind === k))
      .sort((p, q) => (extent[q - 1]?.[r] as number) - (extent[p - 1]?.[r] as number));
    for (const kind of kinds) {
      open.push(spans.length);
      spans.push({ kind, from: r, to: runs.length, parent: open.at(-2) ?? -1, dropped: false });
    }
  });
  return spans;
}

// Which characters the probe swaps, and for what. A character that is
// neither whitespace nor punctuation (to markdown-it) becomes a letter tag;
// punctuation becomes a punctuation tag. Swapping never changes how
// markdown-it reads the marks, since that depends only on whether the
// characters beside them are whitespace, punctuation or neither. So nothing
// that is syntax is swapped: a link address and the parentheses around it, a
// list marker the converter wrote, a backslash, the bare [ ] | * _ ` ~ < > & !
// the converter writes as markup (in text it escapes them), and a bare
// - + = # outside text (a list marker or table rule). An escaped character
// is text, so it is swapped and its backslash kept. An entity reference is
// written as &amp;, which has the same characters at its edges.
function probeRuns(text: string, runs: readonly Run[], utils: MarkdownIt["utils"]): string[] {
  const alphabet = punctuationTags(utils);
  const keep = new Uint8Array(text.length);
  const entity = new Int32Array(text.length);
  const escaped = new Uint8Array(text.length);
  const inText = new Uint8Array(text.length);
  for (const m of text.matchAll(/&#?[A-Za-z0-9]+;/g)) entity[m.index] = m[0].length;
  for (const m of text.matchAll(/(^|\n)([ \t]*)(\d+[.)])/g)) {
    const at = m.index + (m[1] as string).length + (m[2] as string).length;
    keep.fill(1, at, at + (m[3] as string).length);
  }
  let inHref = false;
  let afterTextLine = false;
  let slashes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (c === "\n") afterTextLine = false;
    else if (c === TEXT_LINE) afterTextLine = true;
    if (c === HREF_OPEN) inHref = true;
    if (inHref) keep[i] = 1;
    if (c === HREF_CLOSE) inHref = false;
    if ((c === "(" && text[i + 1] === HREF_OPEN) || (c === ")" && text[i - 1] === HREF_CLOSE)) {
      keep[i] = 1;
    }
    escaped[i] = slashes % 2;
    slashes = c === "\\" ? slashes + 1 : 0;
    inText[i] = afterTextLine ? 1 : 0;
  }
  return runs.map((run, r) => {
    const letter = String.fromCodePoint(LETTER_BASE + (r % LETTER_COUNT));
    const punct = String.fromCodePoint(alphabet[r % alphabet.length] as number);
    let s = "";
    for (let i = run.start; i < run.end; ) {
      const cp = text.codePointAt(i) as number;
      const ch = String.fromCodePoint(cp);
      const length = entity[i] as number;
      if (length > 0 && keep[i] !== 1 && i + length <= run.end) {
        s += "&amp;";
        i += length;
        continue;
      }
      i += ch.length;
      if (
        keep[i - ch.length] === 1 ||
        cp <= 0x20 ||
        ch === TEXT_LINE ||
        ch === PASS_AMP ||
        (cp >= 0xe000 && cp <= 0xe005) ||
        utils.isWhiteSpace(cp)
      ) {
        s += ch;
      } else if (!utils.isPunctChar(ch)) s += letter;
      else if (ch === "\\") s += ch;
      else if (escaped[i - ch.length] === 1 || cp >= 0x80) s += punct;
      else if ("[]|*_`~<>&!".includes(ch)) s += ch;
      else if ("-+=#".includes(ch)) s += inText[i - ch.length] === 1 ? punct : ch;
      else s += punct;
    }
    return s;
  });
}

// The probe's alphabets: a run's index modulo the alphabet's size. Letter
// tags are plane-15 private-use characters, which markdown-it reads as
// neither whitespace nor punctuation. Punctuation tags are symbols from
// blocks assigned long ago (arrows, mathematical operators, box drawing,
// geometric shapes, Braille, supplemental mathematical operators), kept
// only where markdown-it's own isPunctChar says punctuation.
const LETTER_BASE = 0xf0000;
const LETTER_COUNT = 0xfffe;
const PUNCT_BLOCKS: Array<[number, number]> = [
  [0x2190, 0x22ff],
  [0x2500, 0x25ff],
  [0x2800, 0x28ff],
  [0x2a00, 0x2aff],
];
let punctAlphabet: number[] | null = null;
let punctPosition: Map<number, number> | null = null;

function punctuationTags(utils: MarkdownIt["utils"]): number[] {
  if (punctAlphabet === null) {
    const tags: number[] = [];
    for (const [from, to] of PUNCT_BLOCKS) {
      for (let cp = from; cp <= to; cp++) {
        if (utils.isPunctChar(String.fromCodePoint(cp)) && !utils.isWhiteSpace(cp)) tags.push(cp);
      }
    }
    punctAlphabet = tags;
    punctPosition = new Map(tags.map((cp, k) => [cp, k]));
  }
  return punctAlphabet;
}

// A probe character's run, given the run read just before it, or -1 for a
// character that is not a tag.
function tagRun(cp: number, prev: number): number {
  let v: number;
  let size: number;
  if (cp >= LETTER_BASE && cp < LETTER_BASE + LETTER_COUNT) {
    v = cp - LETTER_BASE;
    size = LETTER_COUNT;
  } else {
    const k = punctPosition?.get(cp);
    if (k === undefined || punctAlphabet === null) return -1;
    v = k;
    size = punctAlphabet.length;
  }
  const from = Math.max(0, prev);
  return from + ((((v - (from % size)) % size) + size) % size);
}

interface Shown {
  /** The visible characters, as code points, whitespace left out. */
  codes: number[];
  /** Each one's rendered bold and italic. */
  flags: number[];
}

// What markdown-it shows of the markdown: each visible character and its
// bold and italic, read from the tokens.
function visible(parser: MarkdownIt, markdown: string): Shown {
  const codes: number[] = [];
  const flags: number[] = [];
  for (const block of parser.parse(markdown, {})) {
    let strong = 0;
    let em = 0;
    for (const t of block.children ?? []) {
      if (t.type === "strong_open") strong++;
      else if (t.type === "strong_close") strong--;
      else if (t.type === "em_open") em++;
      else if (t.type === "em_close") em--;
      else if (t.type === "text" || t.type === "code_inline") {
        for (const ch of t.content) {
          const cp = ch.codePointAt(0) as number;
          if (parser.utils.isWhiteSpace(cp) || /\s/u.test(ch)) continue;
          codes.push(cp);
          flags.push((strong > 0 ? BOLD : 0) | (em > 0 ? ITALIC : 0));
        }
      }
    }
  }
  return { codes, flags };
}

// The emphases to drop, from the probe as rendered: null when every
// character looks as its run says and the visible text is the text with no
// marks; otherwise the emphases blamed, empty when none can be named.
function blame(
  shown: Shown,
  plain: Shown,
  runs: readonly Run[],
  spans: Span[],
  opensAt: readonly number[][],
  closesAt: readonly number[][],
): Set<number> | null {
  const blamed = new Set<number>();
  let wrong = false;
  // The kept emphasis of each kind over each run, and for each run boundary
  // the nearest kept emphasis of each kind that ends at or before it and
  // that starts at or after it.
  const over = [BOLD, ITALIC].map(() => new Int32Array(runs.length).fill(-1));
  const endsBy = [BOLD, ITALIC].map(() => new Int32Array(runs.length + 1).fill(-1));
  const startsFrom = [BOLD, ITALIC].map(() => new Int32Array(runs.length + 2).fill(-1));
  const flagged = [BOLD, ITALIC].map(() => new Int32Array(runs.length + 1));
  spans.forEach((sp, id) => {
    if (sp.dropped) return;
    const k = sp.kind - 1;
    (over[k] as Int32Array).fill(id, sp.from, sp.to);
    const e = endsBy[k] as Int32Array;
    if ((e[sp.to] as number) === -1) e[sp.to] = id;
    const s = startsFrom[k] as Int32Array;
    s[sp.from] = id;
  });
  for (let k = 0; k < 2; k++) {
    const e = endsBy[k] as Int32Array;
    for (let b = 1; b <= runs.length; b++) if (e[b] === -1) e[b] = e[b - 1] as number;
    const s = startsFrom[k] as Int32Array;
    for (let b = runs.length - 1; b >= 0; b--) if (s[b] === -1) s[b] = s[b + 1] as number;
    const f = flagged[k] as Int32Array;
    for (let r = 0; r < runs.length; r++) {
      f[r + 1] = (f[r] as number) + (((runs[r] as Run).flags & (k + 1)) !== 0 ? 1 : 0);
    }
  }
  const width = (id: number): number => (spans[id] as Span).to - (spans[id] as Span).from;
  // Emphasis of kind k showing on text from runs lo to hi that has none: the
  // kept emphasis of that kind nearest on either side paired across it, so
  // the narrower of the two goes; with neither, every kept emphasis over it.
  const across = (k: number, lo: number, hi: number): void => {
    const left = (endsBy[k] as Int32Array)[Math.max(0, Math.min(lo, runs.length))] as number;
    const right = (startsFrom[k] as Int32Array)[Math.max(0, hi + 1)] as number;
    if (left !== -1 && (right === -1 || width(left) <= width(right))) blamed.add(left);
    else if (right !== -1) blamed.add(right);
    else {
      for (let j = 0; j < 2; j++) {
        const id = (over[j] as Int32Array)[Math.max(0, Math.min(lo, runs.length - 1))] as number;
        if (id !== -1) blamed.add(id);
      }
    }
  };

  // The visible text must be the text with no marks: an extra * is a mark
  // shown as text, and the emphases with a mark between the runs around it
  // are blamed; anything else unexpected blames every emphasis.
  const extra: number[] = []; // positions in shown of characters not in plain
  for (let i = 0, j = 0; i < shown.codes.length || j < plain.codes.length; ) {
    if (i < shown.codes.length && j < plain.codes.length && shown.codes[i] === plain.codes[j]) {
      i++;
      j++;
    } else if (i < shown.codes.length && shown.codes[i] === 0x2a) {
      extra.push(i++);
    } else {
      for (let id = 0; id < spans.length; id++) if (!(spans[id] as Span).dropped) blamed.add(id);
      return blamed;
    }
  }

  // Read the probe: the run each tag names, in order.
  const runAt = new Int32Array(shown.codes.length).fill(-1);
  let prev = -1;
  for (let i = 0; i < shown.codes.length; i++) {
    const r = tagRun(shown.codes[i] as number, prev);
    if (r === -1) continue;
    runAt[i] = r;
    prev = r;
  }
  // The runs on either side of each untagged character: the last tag's run
  // before it and the next tag's after it.
  const prevRun = new Int32Array(shown.codes.length);
  const nextRun = new Int32Array(shown.codes.length);
  let seen = -1;
  for (let i = 0; i < shown.codes.length; i++) {
    if ((runAt[i] as number) !== -1) seen = runAt[i] as number;
    prevRun[i] = seen;
  }
  seen = runs.length;
  for (let i = shown.codes.length - 1; i >= 0; i--) {
    if ((runAt[i] as number) !== -1) seen = runAt[i] as number;
    nextRun[i] = seen;
  }

  for (const i of extra) {
    wrong = true;
    const lo = Math.max(0, prevRun[i] as number);
    const hi = Math.min(runs.length - 1, nextRun[i] as number);
    let found = false;
    // A mark sits on a run boundary from lo + 1 to hi; look at a bounded
    // number of them, so a long stretch with no letters costs nothing.
    for (let b = lo + 1; b <= hi && b <= lo + 64; b++) {
      for (const id of [...(opensAt[b] as number[]), ...(closesAt[b] as number[])]) {
        if (!(spans[id] as Span).dropped) {
          blamed.add(id);
          found = true;
        }
      }
    }
    if (!found) {
      for (let id = 0; id < spans.length; id++) if (!(spans[id] as Span).dropped) blamed.add(id);
    }
  }

  for (let i = 0; i < shown.codes.length; i++) {
    const got = shown.flags[i] as number;
    const r = runAt[i] as number;
    if (r !== -1) {
      // Emphasis the HTML did not give is wrong; so is a kept emphasis that
      // does not show. One already dropped is expected not to show.
      const want = (runs[r] as Run).flags;
      for (let k = 0; k < 2; k++) {
        const bit = k + 1;
        const id = (over[k] as Int32Array)[r] as number;
        if (id !== -1 && (got & bit) === 0) {
          wrong = true;
          blamed.add(id);
        } else if ((want & bit) === 0 && (got & bit) !== 0) {
          wrong = true;
          across(k, r, r);
        }
      }
    } else if (got !== 0) {
      // Punctuation and the like carry no tag: emphasis on one is right if a
      // run around it has that flag.
      const lo = Math.max(0, prevRun[i] as number);
      const hi = Math.min(runs.length - 1, nextRun[i] as number);
      for (let k = 0; k < 2; k++) {
        const f = flagged[k] as Int32Array;
        if ((got & (k + 1)) !== 0 && (f[hi + 1] as number) - (f[lo] as number) === 0) {
          wrong = true;
          across(k, lo, hi);
        }
      }
    }
  }
  return wrong ? blamed : null;
}

// What tagEnd keeps between the tags of one input, so the pass stays linear.
// lastQuote is the last position of each quote character, so a quote that
// opens a value with no closing quote after it fails at once rather than
// scanning to the end again. known holds, for each position where an
// attribute scan began, where that scan ended: 0 not scanned, 1 the tag does
// not close, k + 2 the tag closes at k. A tag that fails is read again from
// the next <, and a later tag can reach the same position: values quoted
// with both quote characters can chain through every following tag to the
// end, once for every tag start (hostile shape "mixed quotes holding <").
// From a given position the rest of the scan is the same whichever tag
// reached it, so the answer found once is reused.
interface TagScan {
  readonly lastQuote: Record<'"' | "'", number>;
  readonly known: Int32Array;
}

const newTagScan = (html: string): TagScan => ({
  lastQuote: { '"': html.lastIndexOf('"'), "'": html.lastIndexOf("'") },
  known: new Int32Array(html.length + 1),
});

const isHtmlSpace = (c: string): boolean =>
  c === " " || c === "\t" || c === "\n" || c === "\f" || c === "\r";

// Where a tag's attributes end: the position of the > that closes the tag,
// read from `at` (just after the name), or -1 when the tag does not close.
// The attributes are read as a browser's tokenizer reads them, and as ATTR
// does: a name runs to HTML whitespace, /, = or > and may begin with an =; a
// quote is an ordinary character in a name or a bare value, and opens a
// quoted value only straight after an = (and optional whitespace). Such a
// value may hold < or > and ends at its closing quote; with no closing quote
// the tag fails. Outside a quoted value a < fails the tag, so a tag-like run
// with no closing > fails at the next < and the whole pass stays linear.
// TAG once paired every quote it met after the name, so a stray quote in a
// name (<span"x y">) shifted the pairing: the tag failed and its markup
// showed as text, or it ran past its real > and hid the text after it (PR
// #121 review).
function tagEnd(html: string, from: number, scan: TagScan): number {
  const seen: number[] = [];
  const end = scanAttributes(html, from, scan, seen);
  for (const p of seen) scan.known[p] = end + 2;
  return end;
}

function scanAttributes(html: string, at: number, scan: TagScan, seen: number[]): number {
  const n = html.length;
  while (at < n) {
    const known = scan.known[at] as number;
    if (known !== 0) return known - 2;
    seen.push(at);
    const c = html.charAt(at);
    if (c === ">") return at;
    if (c === "<") return -1;
    if (isHtmlSpace(c) || c === "/") {
      at++;
      continue;
    }
    // An attribute name; its first character may be an =.
    at++;
    while (at < n) {
      const d = html.charAt(at);
      if (isHtmlSpace(d) || d === "/" || d === "=" || d === ">" || d === "<") break;
      at++;
    }
    let p = at;
    while (p < n && isHtmlSpace(html.charAt(p))) p++;
    if (html.charAt(p) !== "=") {
      at = p;
      continue;
    }
    p++;
    while (p < n && isHtmlSpace(html.charAt(p))) p++;
    const q = html.charAt(p);
    if (q === '"' || q === "'") {
      const close = scan.lastQuote[q] > p ? html.indexOf(q, p + 1) : -1;
      if (close === -1) return -1;
      at = close + 1;
    } else {
      while (p < n) {
        const d = html.charAt(p);
        if (isHtmlSpace(d) || d === ">" || d === "<") break;
        p++;
      }
      at = p;
    }
  }
  return -1;
}

// Where the close tag of a raw-text element ends: the position of its >,
// read from `at` (just after the name), or -1 when it has none. A browser
// reads it as an end tag in the script-data state: it always ends the
// element, and its attributes are read as a start tag's are, except that a
// < is an ordinary character in a name or a bare value rather than a
// failure. A > inside a quoted value does not end it; with a quote that never
// closes, a browser drops the rest of the input, and so does the caller.
// Unlike tagEnd this never fails at a <, so "</script <b>" ends the script at
// its > and the text after it shows, as in a browser (PR #154 review).
function endTagEnd(html: string, at: number): number {
  const n = html.length;
  while (at < n) {
    const c = html.charAt(at);
    if (c === ">") return at;
    if (isHtmlSpace(c) || c === "/") {
      at++;
      continue;
    }
    // An attribute name; its first character may be an =.
    at++;
    while (at < n) {
      const d = html.charAt(at);
      if (isHtmlSpace(d) || d === "/" || d === "=" || d === ">") break;
      at++;
    }
    let p = at;
    while (p < n && isHtmlSpace(html.charAt(p))) p++;
    if (html.charAt(p) !== "=") {
      at = p;
      continue;
    }
    p++;
    while (p < n && isHtmlSpace(html.charAt(p))) p++;
    const q = html.charAt(p);
    if (q === '"' || q === "'") {
      const close = html.indexOf(q, p + 1);
      if (close === -1) return -1;
      at = close + 1;
    } else {
      while (p < n) {
        const d = html.charAt(p);
        if (isHtmlSpace(d) || d === ">") break;
        p++;
      }
      at = p;
    }
  }
  return -1;
}

function newTable(): Table {
  return {
    nested: false,
    indent: "",
    item: undefined,
    rows: 0,
    cells: 0,
    rowOpen: false,
    rowStart: 0,
    cellStart: 0,
    maxCells: 0,
    headerCells: 0,
    headerEnd: 0,
    sepEnd: 0,
    lists: 0,
  };
}

function trimLineEnd(line: string): string {
  let end = line.length;
  while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t")) end--;
  return line.slice(0, end);
}

// Escape block syntax where a line's text begins: at the start of the line,
// or straight after a list marker this converter wrote. A mark found after
// anything else (inside ** or a link, say) is just removed, since the line
// does not start with text there. The characters, for markdown-it 15
// (CommonMark 0.31 plus GFM tables):
//   #          ATX heading
//   - +        list item, and - for a setext underline or a rule
//   N. N)      ordered list item (N. becomes N\., N) becomes N\))
//   =          setext underline
// Everything else that is block syntax (~ and ` fences, * and _ rules and
// list items, > quotes, | table rows, [ link reference definitions) is
// escaped wherever it appears in text.
function escapeTextLineStart(line: string): string {
  const at = line.indexOf(TEXT_LINE);
  if (at === -1) return line;
  const before = line.slice(0, at);
  const rest = line.slice(at + 1).replaceAll(TEXT_LINE, "");
  if (!/^[ \t]*(?:(?:-|\d+\.)[ \t]+)?$/.test(before)) return before + rest;
  return (
    before +
    rest.replace(
      /^([ \t]*)(?:([#+\-=])|(\d+)([.)]))/,
      (_all, sp: string, ch: string | undefined, digits: string, delim: string) =>
        sp + (ch ? `\\${ch}` : `${digits}\\${delim}`),
    )
  );
}

// The value of the attribute named exactly href (any case), read the way a
// browser reads a tag: one attribute at a time from the start, the first of
// two href attributes winning. Matching href= anywhere in the text once took
// an attribute whose name only ends in href (data-mce-href) or an href= inside
// another attribute's quoted value (issue #28). An href with no value is "",
// which safeHref refuses. null when there is no href attribute.
//
// tagEnd reads quotes as ATTR does, so the attributes it hands over hold no >
// outside a quoted value and no quote that opens a value without closing it.
// The two checks below keep hrefOf right on its own if that ever changes,
// since TAG once paired every quote and handed over both (PR #121 review): a
// > outside every value ends the tag in a browser, so nothing after it is an
// attribute; a bare value that starts with a quote means the quoted forms
// failed, and a browser's quoted value would run past the tag's >, so
// nothing later is an attribute and the link has no href.
function hrefOf(attrs: string): string | null {
  let at = 0;
  while (at < attrs.length) {
    if (attrs.charAt(at) === ">") return null;
    // Separators are skipped here one character at a time, so ATTR is only
    // tried where a name starts. It then always matches at least one
    // character, and the scan stays linear however many separators there are.
    if (ATTR_SKIP.test(attrs.charAt(at))) {
      at++;
      continue;
    }
    ATTR.lastIndex = at;
    const m = ATTR.exec(attrs) as RegExpExecArray;
    at = ATTR.lastIndex;
    const bare = m[4];
    if (bare !== undefined && (bare.startsWith('"') || bare.startsWith("'"))) return null;
    if ((m[1] as string).toLowerCase() === "href") return m[2] ?? m[3] ?? bare ?? "";
  }
  return null;
}

// A link's address as it may go into Markdown, or null to drop the link to its
// text. The attribute value is HTML, so its entities are decoded first. Only
// an absolute http: or https: URL is kept. The address is designer-controlled,
// so the characters that could end a CommonMark link destination early and
// start new Markdown after it - ( ) < > [ ] \ and any whitespace - are
// percent-encoded in the normalised href, and so are | (markdown-it splits a
// table row on it even inside a link) and ` (a code span). An & that would
// start an entity is backslash-escaped, since markdown-it decodes entities in
// a destination.
function safeHref(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(decodeEntities(raw).trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.href
    .replace(
      /[()<>[\]\\|`\s]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
    )
    .replace(/&(?=#?[A-Za-z0-9]+;)/g, "\\&");
}

// The markdown-it setup renderMarkdown uses: raw HTML off, so a tag in the
// Markdown is text; linkify off, so a bare address is text; links only to
// absolute http(s) addresses, so javascript:, data:, relative and
// protocol-relative ones render as text. The image rule is off: descriptions
// never render images (the maintainer, 2026-11-08, PR #24), so ![alt](url) is a "!" and
// a link to the address, and no description can make the page load a remote
// address. A newline in a paragraph is a line break, as it was for
// descriptions in Manyfold (Kramdown's GFM parser, hard_wrap on) and as
// htmlToMarkdown writes <br>.
export function createMarkdownIt(): MarkdownIt {
  const md = new MarkdownItCallable({ html: false, linkify: false, breaks: true });
  md.disable("image");
  md.validateLink = (url: string): boolean => /^https?:\/\//i.test(url.trim());
  return md;
}

// What DOMPurify lets through: the elements markdown-it writes, less img, and
// the attributes a link and an ordered list need. Anything else (an image, an
// event handler, a style, a class, a script) is removed. img is not allowed
// and is forbidden outright as well, so no description can load a remote
// address whatever markdown-it writes (the maintainer, 2026-11-08, PR #24). An href must
// be an absolute http(s) address: ALLOWED_URI_REGEXP says so, and
// keepHttpAddressesOnly below covers the data: exception DOMPurify makes on
// its own. markdown-it with html off writes nothing dangerous; this is the
// second, independent layer.
const PURIFY_CONFIG: Config = {
  ALLOWED_TAGS: [
    "p",
    "br",
    "strong",
    "em",
    "s",
    "a",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "li",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "code",
    "pre",
    "blockquote",
    "hr",
  ],
  FORBID_TAGS: ["img"],
  ALLOWED_ATTR: ["href", "title", "start"],
  ADD_URI_SAFE_ATTR: ["start"],
  ALLOWED_URI_REGEXP: /^https?:\/\//i,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

// DOMPurify keeps a src that starts with data: on img, audio, video, source
// and track whatever ALLOWED_URI_REGEXP says (its DATA_URI_TAGS exception,
// which config can add to but not empty). None of those elements is allowed
// now, but this hook still drops every href and src that is not an absolute
// http(s) address before DOMPurify's own checks, so a later change to the
// allow-list cannot bring the exception back.
function keepHttpAddressesOnly(_node: unknown, data: UponSanitizeAttributeHookEvent): void {
  if (data.attrName !== "href" && data.attrName !== "src") return;
  if (!/^https?:\/\//i.test(data.attrValue)) data.keepAttr = false;
}

let purifier: Purifier | undefined;
let renderer: MarkdownIt | undefined;

// DOMPurify sanitises through a DOM: the browser's in the web app. Without
// one it cannot sanitise at all, so renderMarkdown refuses to run rather
// than return markdown-it's output unsanitised.
function getPurifier(): Purifier {
  if (purifier) return purifier;
  const win = (globalThis as { window?: unknown }).window;
  if (win === undefined || win === null) {
    throw new Error("renderMarkdown needs a DOM to sanitise with; it runs in the browser");
  }
  const p = DOMPurify(win as WindowLike);
  if (!p.isSupported || typeof p.sanitize !== "function") {
    throw new Error("renderMarkdown needs a DOM that DOMPurify supports");
  }
  p.addHook("uponSanitizeAttribute", keepHttpAddressesOnly);
  purifier = p;
  return p;
}

// HTML passed through DOMPurify with PURIFY_CONFIG. Exported for the tests,
// which check this layer on its own; the package index does not export it.
export function sanitizeHtml(html: string): string {
  return getPurifier().sanitize(html, PURIFY_CONFIG);
}

// Markdown (a model's description) as HTML safe to put in the page: rendered
// by createMarkdownIt's setup, then passed through DOMPurify. Used by the web
// app's About tab (the model page).
export function renderMarkdown(md: string): string {
  getPurifier();
  renderer ??= createMarkdownIt();
  return sanitizeHtml(renderer.render(md));
}
