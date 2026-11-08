// A MakerWorld description (HTML) as Markdown, and Markdown as sanitised HTML
// for the web app. htmlToMarkdown is ported by behaviour from automation
// Manyfold/makerworld-metadata at 1ce8c57. That converter escaped text for
// Kramdown, which Manyfold renders with; Platehouse renders with markdown-it,
// so the escaping here is re-derived for markdown-it (build plan Task 7,
// requirements lesson 5) and the tests in test/markdown.test.ts and
// test/render.test.ts are the contract.

import DOMPurify, { type Config, type DOMPurify as Purifier, type WindowLike } from "dompurify";
import MarkdownItCallable, { type MarkdownIt } from "markdown-it";
import { decodeEntities, mapEntities } from "./extract.js";

const BLOCK: ReadonlySet<string> = new Set([
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

// Marks text that begins a line; never present in decoded text (NUL is
// stripped from it) and removed before htmlToMarkdown returns.
const TEXT_LINE = "\0";
// Stands for the & of an entity reference the converter does not decode, so
// the escaping step leaves it alone and markdown-it decodes it. Stripped from
// text before use, like TEXT_LINE.
const PASS_AMP = "\u0001";
const stripSentinels = (s: string): string => s.replaceAll(TEXT_LINE, "").replaceAll(PASS_AMP, "");

// Nesting caps. A crafted description could nest lists or emphasis thousands
// deep; past these depths a list is written at its parent's indent and an
// emphasis or link is ignored, so output grows no faster than input and no
// close tag scans a long stack. Real descriptions stay far below both.
const MAX_LIST_DEPTH = 8;
const MAX_INLINE_DEPTH = 16;

// A tag. Outside quotes the attributes may hold no < or >, so a tag-like run
// with no closing > fails at the next <; a quoted value may hold either and
// ends at its closing quote.
const TAG = /<(\/?)([A-Za-z][A-Za-z0-9]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/y;
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const isSpace = (c: string): boolean => /\s/.test(c);

// The converter's output, built from parts so that appending never copies
// what is already written. Reads look only near the end, and the last
// non-whitespace position is kept up to date, so "is there text after this
// point" costs nothing however long the output is.
class Output {
  private parts: string[] = [];
  length = 0;
  lastText = -1;

  append(s: string): void {
    if (!s) return;
    this.parts.push(s);
    for (let i = s.length - 1; i >= 0; i--) {
      if (!isSpace(s.charAt(i))) {
        this.lastText = this.length + i;
        break;
      }
    }
    this.length += s.length;
  }

  // Everything from position `from` to the end.
  from(from: number): string {
    if (from >= this.length) return "";
    let start = this.length;
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

  // Drops everything from position `to` on.
  truncate(to: number): void {
    if (to >= this.length) return;
    const target = Math.max(0, to);
    while (this.parts.length > 0 && this.length > target) {
      const last = this.parts.pop() as string;
      this.length -= last.length;
      if (this.length < target) {
        this.parts.push(last.slice(0, target - this.length));
        this.length = target;
      }
    }
    if (this.lastText >= this.length) {
      this.lastText = -1;
      for (let i = this.length - 1; i >= 0; i--) {
        if (!isSpace(this.charAt(i))) {
          this.lastText = i;
          break;
        }
      }
    }
  }

  // The character at position `at`; cheap near the end.
  charAt(at: number): string {
    if (at < 0 || at >= this.length) return "";
    let start = this.length;
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const part = this.parts[i] as string;
      start -= part.length;
      if (at >= start) return part.charAt(at - start);
    }
    return "";
  }

  last(): string {
    return this.charAt(this.length - 1);
  }

  hasTextFrom(from: number): boolean {
    return this.lastText >= from;
  }

  trimEnd(): void {
    this.truncate(this.lastText + 1);
  }

  toString(): string {
    return this.parts.join("");
  }
}

interface List {
  ordered: boolean;
  n: number;
  cell: boolean;
  indent: string;
  lastContentCol: number;
}
interface Item {
  markerStart: number;
  textStart: number;
  list: List | undefined;
  dropped: boolean;
  contentCol: number;
}
interface Inline {
  tag: string;
  start: number;
  href: string | null;
}
interface Table {
  nested: boolean;
  rows: number;
  cells: number;
  rowStart: number;
  cellStart: number;
  maxCells: number;
  headerCells: number;
  headerEnd: number;
  sepEnd: number;
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
// list indented to its item's text), links to [text](href) for http(s) only,
// tables to pipe tables with the first row as the header (padded to the
// widest row; a heading or list in a cell stays on its row, items joined by
// "; "; a table in a cell is flattened into it, cells joined by spaces and
// rows by "; "), every other tag dropped (its text kept, except script,
// style and the like), comments dropped (an unterminated one drops the rest),
// runs of blank lines collapsed, trimmed. Text is escaped as textToMarkdown
// says; the converter's own markup is not escaped. A line break is a single
// newline, which renderMarkdown shows as a line break.
export function htmlToMarkdown(html: string | null | undefined): string {
  if (!html) return "";
  const out = new Output();
  const inline: Inline[] = []; // open emphasis and links
  const lists: List[] = []; // open lists
  const tables: Table[] = []; // open tables
  const items: Item[] = []; // open list items outside cells
  let inCell = false;
  let listDepth = 0; // open lists outside cells
  let dropDepth = 0;
  let headingStart = -1;
  let headingMarker = -1; // where the open heading's "#" marker begins
  let itemStart = -1; // where the text of the open list item begins

  const clampInline = (): void => {
    for (const e of inline) e.start = Math.min(e.start, out.length);
  };
  // A paragraph break; idempotent, so the output never holds more than two
  // newlines in a row (more would collapse to two at the end anyway).
  const breakBlock = (): void => {
    if (out.length === 0) out.append("\n\n");
    else if (out.last() !== "\n") out.append("\n\n");
    else if (out.charAt(out.length - 2) !== "\n") out.append("\n");
  };
  const outerList = (): List | undefined => lists.findLast((l) => !l.cell);
  // A list item with no text yet would keep a bare marker if a block (a
  // nested list, a heading, a table) opened in it: CommonMark does not read a
  // marker with nothing after it as the item meant, so a bare "-" or "1."
  // joins the item above or turns its text into a setext heading. The marker
  // is dropped, and an ordered list's numbering stays continuous.
  const dropBareMarker = (): void => {
    const item = items.at(-1);
    if (!item || item.dropped || out.hasTextFrom(item.textStart)) return;
    out.truncate(item.markerStart);
    clampInline();
    item.dropped = true;
    itemStart = -1;
    if (item.list?.ordered) item.list.n--;
  };
  // True while the open list item (outside a cell) has no text yet.
  const itemEmpty = (): boolean => {
    const item = items.at(-1);
    return Boolean(item && !item.dropped && !out.hasTextFrom(item.textStart));
  };
  // A line break, outside a cell; at most two newlines in a row.
  const newline = (): void => {
    if (inCell) out.append(" ");
    else if (!(out.last() === "\n" && out.charAt(out.length - 2) === "\n")) out.append("\n");
  };
  const endLine = (): void => {
    if (out.length > 0 && out.last() !== "\n") out.append("\n");
  };
  // Inside a table cell a line break would end the pipe-table row, so a
  // heading or a list there is written on the row: a space where it opens or
  // closes, and "; " between list items.
  const space = (): void => {
    if (out.length > 0 && !isSpace(out.last())) out.append(" ");
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
    if (!inCell) {
      const lineStart = textLineStart();
      if (lineStart >= 0) {
        out.truncate(lineStart);
        clampInline();
        t = t.trimStart();
        if (t) t = TEXT_LINE + t;
      }
    }
    // A space meeting a space across dropped markup (an image, an empty
    // link) is one space, as HTML would show it.
    if (t.startsWith(" ") && out.last() === " ") t = t.slice(1);
    out.append(t);
  };

  const onTag = (closing: boolean, rawTag: string, attrs: string): void => {
    const tag = rawTag.toLowerCase();
    if (DROP_CONTENT.has(tag)) {
      if (!attrs.trim().endsWith("/")) dropDepth = Math.max(0, dropDepth + (closing ? -1 : 1));
      return;
    }
    if (dropDepth > 0) return;

    if (/^h[1-6]$/.test(tag) && inCell) {
      space();
      headingStart = -1;
    } else if (/^h[1-6]$/.test(tag)) {
      if (!closing) {
        dropBareMarker();
        breakBlock();
        headingMarker = out.length;
        out.append(`${"#".repeat(Number(tag[1]))} `);
        headingStart = out.length;
      } else {
        if (headingStart >= 0) {
          const body = out.from(headingStart).replace(/\s+/g, " ").trim();
          // An empty heading would leave a bare "##", which is not a heading
          // with text; it is dropped. CommonMark strips a run of # that ends
          // a heading after a space, so a trailing # is escaped ("Part #"
          // stays "Part #", and "Learn C#" is escaped the same way).
          if (!body) out.truncate(headingMarker);
          else {
            out.truncate(headingStart);
            out.append(/#$/.test(body) && !/\\#$/.test(body) ? `${body.slice(0, -1)}\\#` : body);
          }
          clampInline();
        }
        headingStart = -1;
        breakBlock();
      }
    } else if (tag === "br") {
      // A line break before an item's first text would leave a bare marker on
      // a line of its own; it is dropped so the text stays on the marker's line.
      if (inCell || !itemEmpty()) newline();
    } else if ((tag === "ul" || tag === "ol") && inCell) {
      if (!closing)
        lists.push({ ordered: tag === "ol", n: 0, cell: true, indent: "", lastContentCol: 0 });
      else lists.pop();
      space();
    } else if (tag === "li" && inCell) {
      // Only a list opened in this cell numbers its items; an outer list's
      // count is left alone.
      const last = lists.at(-1);
      const list = last?.cell ? last : undefined;
      if (!closing) {
        const n = list ? ++list.n : 1;
        const table = tables.at(-1);
        if (n > 1 && table && out.hasTextFrom(table.cellStart)) {
          out.trimEnd();
          out.append("; ");
        } else space();
        if (list?.ordered) out.append(`${n}. `);
      }
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
        lists.push({ ordered: tag === "ol", n: 0, cell: false, indent, lastContentCol: 0 });
        listDepth++;
      } else {
        const closed = outerList();
        if (closed) {
          lists.splice(lists.lastIndexOf(closed), 1);
          listDepth--;
        }
        // Items left open in the closed list (an <li> with no </li>) end with it.
        while (items.length > 0 && closed && items.at(-1)?.list === closed) {
          items.pop();
          itemStart = -1;
        }
        if (outerList()) endLine();
        else breakBlock();
      }
    } else if (tag === "li") {
      const list = outerList();
      if (!closing) {
        // An item left open in this list (no </li>) ends where the next begins.
        while (items.length > 0 && list && items.at(-1)?.list === list) {
          const open = items.pop() as Item;
          if (!open.dropped && !out.hasTextFrom(open.textStart)) {
            out.truncate(open.markerStart);
            clampInline();
            if (list.ordered) list.n--;
          }
        }
        endLine();
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
          clampInline();
          if (item.list?.ordered) item.list.n--;
        }
        endLine();
        itemStart = -1;
      }
    } else if (EMPHASIS.has(tag) || tag === "a") {
      if (!closing) {
        if (inline.length >= MAX_INLINE_DEPTH) return;
        const href = tag === "a" ? hrefOf(attrs) : null;
        inline.push({ tag, start: out.length, href });
      } else {
        const idx = inline.findLastIndex((e) => e.tag === tag);
        if (idx === -1) return;
        const [open] = inline.splice(idx, 1) as [Inline];
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
          if (href && core) wrapped = `${lead}[${core}](${href})${trail}`;
        } else if (core) {
          const mark = EMPHASIS.get(tag) as string;
          wrapped = lead + mark + core + mark + trail;
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
          tables.push(newTable());
        }
      } else {
        const t = tables.pop();
        if (t?.nested) space();
        else {
          if (t) padHeader(t);
          // A list left open in a cell ends with the table.
          while (lists.at(-1)?.cell) lists.pop();
          inCell = false;
          breakBlock();
        }
      }
    } else if (tag === "tr" && tables.at(-1)?.nested) {
      const t = tables.at(-1) as Table;
      if (!closing) {
        if (t.rows > 0 && out.hasTextFrom(t.cellStart)) {
          out.trimEnd();
          out.append("; ");
        } else space();
        t.cells = 0;
      } else t.rows++;
    } else if ((tag === "td" || tag === "th") && tables.at(-1)?.nested) {
      const t = tables.at(-1) as Table;
      if (!closing) {
        if (t.cells++ > 0) space();
      } else space();
    } else if (tag === "tr" && tables.length > 0) {
      const t = tables.at(-1) as Table;
      if (!closing) {
        endLine();
        t.rowStart = out.length;
        t.cells = 0;
        out.append("|");
      } else if (t.cells === 0) {
        out.truncate(t.rowStart); // an empty row leaves nothing
        clampInline();
      } else {
        // The first row is the header, so the separator line follows it.
        if (t.rows === 0) {
          t.headerEnd = out.length;
          t.headerCells = t.cells;
          out.append(`\n|${" --- |".repeat(t.cells)}`);
          t.sepEnd = out.length;
          out.append("\n");
        } else out.append("\n");
        t.maxCells = Math.max(t.maxCells, t.cells);
        t.rows++;
      }
    } else if ((tag === "td" || tag === "th") && tables.length > 0) {
      const t = tables.at(-1) as Table;
      if (!closing) {
        t.cells++;
        inCell = true;
        t.cellStart = out.length;
      } else if (inCell) {
        inCell = false;
        const cell = out
          .from(t.cellStart)
          .trim()
          .replace(/[ \t]{2,}/g, " ");
        out.truncate(t.cellStart);
        out.append(` ${cell} |`);
        clampInline();
      }
    } else if (BLOCK.has(tag)) {
      // Inside a list item or a table cell a paragraph is just the text, with
      // a space where it opens or closes so two paragraphs' words stay apart.
      if (lists.length === 0 && !inCell) breakBlock();
      else space();
    }
    // Every other tag (img, span, font, ...) is dropped; its text stays.
  };

  // markdown-it drops the cells of a row past the header's count, so a table
  // whose widest row is wider than its first gets empty header cells.
  const padHeader = (t: Table): void => {
    const extra = t.maxCells - t.headerCells;
    if (t.rows === 0 || extra <= 0) return;
    const rest = out.from(t.headerEnd);
    const headPad = " |".repeat(extra);
    const sepPad = " --- |".repeat(extra);
    const sepAt = t.sepEnd - t.headerEnd;
    out.truncate(t.headerEnd);
    out.append(headPad + rest.slice(0, sepAt) + sepPad + rest.slice(sepAt));
    for (const e of inline) {
      if (e.start > t.sepEnd) e.start += headPad.length + sepPad.length;
      else if (e.start > t.headerEnd) e.start += headPad.length;
    }
  };

  // The tokenizer: comments, tags and text, each found by a scan that stops
  // at the next < or at the end of the comment, so the whole pass is linear.
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
    if (m) {
      onTag(m[1] === "/", m[2] as string, m[3] as string);
      i = TAG.lastIndex;
    } else {
      onText("<"); // a < that starts no tag is text
      i += 1;
    }
  }

  return out
    .toString()
    .split("\n")
    .map((line) => trimLineEnd(escapeTextLineStart(line)).replace(/^ (?=\S)/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function newTable(): Table {
  return {
    nested: false,
    rows: 0,
    cells: 0,
    rowStart: 0,
    cellStart: 0,
    maxCells: 0,
    headerCells: 0,
    headerEnd: 0,
    sepEnd: 0,
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

function hrefOf(attrs: string): string | null {
  const m = HREF.exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
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
// Markdown is text; linkify off, so a bare address is text; links and images
// only to absolute http(s) addresses, so javascript:, data:, relative and
// protocol-relative ones render as text. A newline in a paragraph is a line
// break, as it was for descriptions in Manyfold (Kramdown's GFM parser,
// hard_wrap on) and as htmlToMarkdown writes <br>.
export function createMarkdownIt(): MarkdownIt {
  const md = new MarkdownItCallable({ html: false, linkify: false, breaks: true });
  md.validateLink = (url: string): boolean => /^https?:\/\//i.test(url.trim());
  return md;
}

// What DOMPurify lets through: exactly the elements markdown-it writes, the
// attributes a link, an image and an ordered list need, and only http(s)
// addresses. Anything else (an event handler, a style, a class, a script) is
// removed. markdown-it with html off writes nothing dangerous; this is the
// second, independent layer.
const PURIFY_CONFIG: Config = {
  ALLOWED_TAGS: [
    "p",
    "br",
    "strong",
    "em",
    "s",
    "a",
    "img",
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
  ALLOWED_ATTR: ["href", "src", "alt", "title", "start"],
  ADD_URI_SAFE_ATTR: ["start"],
  ALLOWED_URI_REGEXP: /^https?:\/\//i,
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

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
// app's About tab (build plan Task 20).
export function renderMarkdown(md: string): string {
  getPurifier();
  renderer ??= createMarkdownIt();
  return sanitizeHtml(renderer.render(md));
}
