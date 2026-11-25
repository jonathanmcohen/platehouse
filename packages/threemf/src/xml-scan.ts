// A streaming tag scanner for the 3D model parts of a .3mf (issue #358). A
// model part can be hundreds of megabytes of <vertex> and <triangle> tags,
// too much to hold as one string or parse into a tree the way the config
// entries are (fast-xml-parser in parse.ts), so this reads the inflated text
// chunk by chunk and hands over one tag at a time. Text between tags is
// skipped: no value the mesh reader needs is text content.
//
// Rules, kept from parse.ts's config reading:
// - a DOCTYPE (and so any entity declaration) is damage: a 3MF part carries
//   no DTD, and none is ever read;
// - attribute values are decoded for the five XML entities and numeric
//   references only;
// - comments, CDATA and processing instructions are skipped whole;
// - a tag left open longer than MAX_TAG_CHARS (an unterminated quote, say)
//   is damage, so a hostile part cannot make the scanner hold the rest of
//   the file.
import { StringDecoder } from "node:string_decoder";
import { Damaged } from "./errors.js";

/** The longest a single tag may be, in characters; Bambu's longest tags are a few hundred. */
export const MAX_TAG_CHARS = 1024 * 1024;

export interface Tag {
  /** The element name without its namespace prefix: "vertex" for <vertex> and <m:vertex>. */
  name: string;
  /** True for </name>. */
  closing: boolean;
  /** True for <name ... />. */
  selfClosing: boolean;
  /** The text inside the angle brackets, for attrs(); empty for a closing tag. */
  raw: string;
}

/**
 * Hands each tag to onTag as the text arrives; call write per chunk, then
 * end. onScan, when given, is told how many characters each step is about
 * to look at, before it looks: the new text plus any unfinished tag carried
 * over from the last chunk, which is looked at again. A caller that counts
 * these has counted every character the scanner ever handles, so a file of
 * very long tags split over many chunks costs what it really costs.
 */
export class TagScanner {
  private readonly decoder = new StringDecoder("utf8");
  private pending = "";
  private readonly onTag: (tag: Tag) => void;
  private readonly onScan: ((chars: number) => void) | undefined;

  constructor(onTag: (tag: Tag) => void, onScan?: (chars: number) => void) {
    this.onTag = onTag;
    this.onScan = onScan;
  }

  write(chunk: Buffer): void {
    this.scan(this.decoder.write(chunk));
  }

  /** The end of the text; a tag still open is damage. */
  end(): void {
    this.scan(this.decoder.end());
    if (this.pending.includes("<")) throw new Damaged("model part ends inside a tag");
  }

  private scan(text: string): void {
    this.onScan?.(this.pending.length + text.length);
    const s = this.pending === "" ? text : this.pending + text;
    let i = 0;
    const n = s.length;
    for (;;) {
      const lt = s.indexOf("<", i);
      if (lt < 0) {
        this.pending = "";
        return;
      }
      const end = this.markupEnd(s, lt);
      if (end < 0) {
        this.pending = s.slice(lt);
        if (this.pending.length > MAX_TAG_CHARS) throw new Damaged("model part tag too long");
        return;
      }
      i = end + 1;
      if (i > n) i = n;
    }
  }

  /** Emits the markup starting at lt and returns the index of its last character, or -1 if incomplete. */
  private markupEnd(s: string, lt: number): number {
    const next = s.charCodeAt(lt + 1);
    if (Number.isNaN(next)) return -1;
    if (next === 0x21 /* ! */) {
      if (s.startsWith("<!--", lt)) return endOf(s, "-->", lt + 4);
      if (s.startsWith("<![CDATA[", lt)) return endOf(s, "]]>", lt + 9);
      // "<!D" could still be the start of "<!--" or "<![CDATA[" in the next chunk.
      if (s.length - lt < 9) return -1;
      throw new Damaged("model part with a DTD");
    }
    if (next === 0x3f /* ? */) return endOf(s, "?>", lt + 2);
    // A tag: the first > outside quotes ends it.
    let quote = 0;
    for (let j = lt + 1; j < s.length; j++) {
      const c = s.charCodeAt(j);
      if (quote !== 0) {
        if (c === quote) quote = 0;
      } else if (c === 0x22 || c === 0x27) {
        quote = c;
      } else if (c === 0x3e /* > */) {
        this.emit(s.slice(lt + 1, j));
        return j;
      }
    }
    return -1;
  }

  private emit(inner: string): void {
    if (inner.startsWith("/")) {
      this.onTag({
        name: localName(inner.slice(1).trim()),
        closing: true,
        selfClosing: false,
        raw: "",
      });
      return;
    }
    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const m = /^[^\s/>]+/.exec(body);
    if (m === null) return;
    this.onTag({ name: localName(m[0]), closing: false, selfClosing, raw: body });
  }
}

function endOf(s: string, marker: string, from: number): number {
  const at = s.indexOf(marker, from);
  return at < 0 ? -1 : at + marker.length - 1;
}

function localName(qualified: string): string {
  const colon = qualified.indexOf(":");
  return colon < 0 ? qualified : qualified.slice(colon + 1);
}

/** Whether c is a character JavaScript's \s matches. */
function isSpace(c: number): boolean {
  return (
    c === 0x20 ||
    (c >= 0x09 && c <= 0x0d) ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** Whether c may be in an attribute name: anything but a space, = or /. */
function isNameChar(c: number): boolean {
  return c !== 0x3d /* = */ && c !== 0x2f /* / */ && !isSpace(c);
}

/**
 * A tag's attributes by local name (p:path is "path"). The first of a
 * repeated name wins. Values are decoded for the XML entities.
 *
 * Each attribute is a name (a run of anything but spaces, = and /), spaces,
 * =, spaces and a value in double or single quotes; anything else between
 * them is passed over. The tag is walked once, in time that grows with its
 * length (review of PR #368): a regex for the same thing backtracks over a
 * long run with no = after it, so one crafted tag the size MAX_TAG_CHARS
 * allows cost minutes, outside the work budget.
 * - A name that is not followed by =, spaces and a quote is passed over
 *   whole: no shorter name inside it can be, as it ends at the same place.
 * - Once a quote has no closing quote after it, no later value in that quote
 *   can close either, so the tag is not searched for one again.
 */
export function attrs(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  const n = raw.length;
  let unclosedDouble = false;
  let unclosedSingle = false;
  let i = 0;
  while (i < n) {
    if (!isNameChar(raw.charCodeAt(i))) {
      i++;
      continue;
    }
    const start = i;
    while (i < n && isNameChar(raw.charCodeAt(i))) i++;
    const nameEnd = i;
    let j = nameEnd;
    while (j < n && isSpace(raw.charCodeAt(j))) j++;
    if (raw.charCodeAt(j) !== 0x3d /* = */) continue;
    j++;
    while (j < n && isSpace(raw.charCodeAt(j))) j++;
    const quote = raw.charCodeAt(j);
    const double = quote === 0x22; /* " */
    if (!double && quote !== 0x27 /* ' */) continue;
    if (double ? unclosedDouble : unclosedSingle) continue;
    const close = raw.indexOf(double ? '"' : "'", j + 1);
    if (close < 0) {
      if (double) unclosedDouble = true;
      else unclosedSingle = true;
      continue;
    }
    const name = localName(raw.slice(start, nameEnd));
    if (!out.has(name)) out.set(name, decodeEntities(raw.slice(j + 1, close)));
    i = close + 1;
  }
  return out;
}

const NAMED: Readonly<Record<string, string>> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
};

function decodeEntities(v: string): string {
  if (!v.includes("&")) return v;
  return v.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[a-z]+);/g, (whole, ref: string) => {
    if (ref.startsWith("#x")) return fromCode(Number.parseInt(ref.slice(2), 16), whole);
    if (ref.startsWith("#")) return fromCode(Number.parseInt(ref.slice(1), 10), whole);
    return Object.hasOwn(NAMED, ref) ? (NAMED[ref] ?? whole) : whole;
  });
}

function fromCode(code: number, whole: string): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : whole;
}
