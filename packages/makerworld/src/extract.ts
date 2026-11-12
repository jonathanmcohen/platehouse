// MakerWorld details from the start of a .3mf's 3D/3dmodel.model. Ported by
// behaviour from extractMakerWorld in automation Manyfold/makerworld-metadata
// at 1ce8c57; the input is the makerWorldXml string build plan Task 6's
// readProject returns (the model file read up to <resources, at most 256 KiB).

// Named entities: the five XML ones plus the HTML ones MakerWorld text uses
// most. Anything else named is left as written. Non-ASCII targets are written
// as escapes so this file stays ASCII.
const NAMED: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
  ["lsquo", "\u2018"],
  ["rsquo", "\u2019"],
  ["ldquo", "\u201c"],
  ["rdquo", "\u201d"],
  ["ndash", "\u2013"],
  ["mdash", "\u2014"],
  ["hellip", "\u2026"],
  ["bull", "\u2022"],
  ["middot", "\u00b7"],
  ["copy", "\u00a9"],
  ["reg", "\u00ae"],
  ["trade", "\u2122"],
  ["deg", "\u00b0"],
  ["times", "\u00d7"],
  ["plusmn", "\u00b1"],
  ["micro", "\u00b5"],
]);

// An entity reference. The lengths are markdown-it's (a name of at most 32
// characters, at most 6 hex or 7 decimal digits), which also keeps one match
// from scanning a long run of letters or digits.
const ENTITY_REF = /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{0,31});/g;

// The text one reference stands for, or null when it names nothing this
// module decodes: an unknown name, or a code point that is 0, a surrogate or
// past U+10FFFF.
function decodeRef(ref: string): string | null {
  if (ref[0] !== "#") return NAMED.get(ref) ?? null;
  const hex = ref[1] === "x" || ref[1] === "X";
  const cp = hex ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
  const valid = cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
  return valid ? String.fromCodePoint(cp) : null;
}

// One pass of entity decoding. Each reference this module decodes becomes
// decoded(its text); every other one is handed to keep, whose result stands
// in its place.
export function mapEntities(
  s: string,
  keep: (whole: string) => string,
  decoded: (text: string) => string = (text) => text,
): string {
  return s.replace(ENTITY_REF, (whole: string, ref: string) => {
    const text = decodeRef(ref);
    return text === null ? keep(whole) : decoded(text);
  });
}

// One pass of entity decoding: the named entities above and numeric
// references. Anything else is left as written.
export function decodeEntities(s: string): string {
  return mapEntities(s, (whole) => whole);
}

const blankToNull = (s: string): string | null => (s.trim() ? s : null);
const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

export interface MakerWorldDetails {
  title: string | null;
  designer: string;
  descriptionHtml: string | null;
  license: string | null;
}

// Designer names that are a generator's, not a person's: gridfinitylayouttool.com
// writes "Gridfinity Layout Tool" there and a placeholder title such as
// "Untitled Bin". Compared after case and spacing are folded.
const GENERATORS: ReadonlySet<string> = new Set(["gridfinity layout tool"]);

// The longest Designer kept, in UTF-16 code units after whitespace is
// collapsed (at most 900 UTF-8 bytes): the API's creator limit, 300, and far
// under the 2704-byte btree entry limit of creators.name (#143).
const MAX_DESIGNER_LENGTH = 300;

// The start tag of a <metadata name="..."> element, matched where it begins
// (sticky). Like the converter's TAG, nothing in it may run past a <, so an
// attempt that fails stops at the next tag; group 3 is the "/" of "/>".
const METADATA_START = /<metadata\s+name\s*=\s*(?:"([^"<]*)"|'([^'<]*)')[^<>]*?(\/)?>/y;
// A close tag, matched where "</metadata" was found (sticky).
const METADATA_END = /<\/metadata\s*>/y;

// Each <metadata name="..."> element in the prefix as [name, text], in order:
// a self-closing one has empty text, and one with text runs to the first
// close tag after its start tag (start tags in between are part of its text).
// An element with no close tag after it is skipped. That is what the
// source's single regular expression read, but that expression had two lazy
// scans that could each run to the end of the input from every <metadata,
// so a prefix of start tags that never close took time that grows with the
// square of its length (PR #24 review). Here every search moves forward
// only. Each start tag is matched where indexOf found it, and its close tag
// is searched for from there; the scan then resumes after that close tag, so
// no stretch of the input is searched for a close tag twice. When there is
// no close tag left, no later element can have text, and a self-closing one
// would add only an empty value, which reads the same as an absent one, so
// the scan stops there instead of searching to the end again from every
// later start tag. test/hostile.test.ts checks the time grows linearly.
function* metadataElements(xml: string): Generator<[string, string]> {
  // The first close tag at or after `from`, or -1.
  const nextClose = (from: number): number => {
    for (
      let at = xml.indexOf("</metadata", from);
      at !== -1;
      at = xml.indexOf("</metadata", at + 1)
    ) {
      METADATA_END.lastIndex = at;
      if (METADATA_END.test(xml)) return at;
    }
    return -1;
  };

  let pos = 0;
  for (;;) {
    const start = xml.indexOf("<metadata", pos);
    if (start === -1) return;
    METADATA_START.lastIndex = start;
    const m = METADATA_START.exec(xml);
    if (!m) {
      pos = start + 1;
      continue;
    }
    const name = m[1] ?? m[2] ?? "";
    const textStart = METADATA_START.lastIndex;
    if (m[3] === "/") {
      yield [name, ""];
      pos = textStart;
      continue;
    }
    const close = nextClose(textStart);
    if (close === -1) return;
    yield [name, xml.slice(textStart, close)];
    METADATA_END.lastIndex = close;
    METADATA_END.test(xml);
    pos = METADATA_END.lastIndex;
  }
}

// {title, designer, descriptionHtml, license} from the <metadata> elements, or
// null when the file is not a MakerWorld download.
//
// MakerWorld escapes its fields before Bambu Studio writes them into the XML,
// so in the file every one is escaped twice: a title's & is &amp;amp; and the
// description's <p> is &amp;lt;p&amp;gt;. Each value is decoded twice, which
// gives the description as the HTML MakerWorld stored; htmlToMarkdown then
// decodes the HTML's own entities. Title, designer and license get that third
// decode here, so a title MakerWorld stored with an entity in it still reads
// as text.
//
// Every field has NUL removed before anything else reads it, because each
// one is stored and Postgres text cannot hold a NUL (#78). A field that was
// only NUL is then blank, so it reads as absent. No entity decodes to NUL
// (decodeRef refuses code point 0), so a raw NUL is the only way one arrives.
//
// Null when there is no Designer: MakerWorld always writes one, Jon's own
// designs leave it empty, and other tools' exports carry only a placeholder
// title. Also null when the Designer is a generator's name, or longer than
// MAX_DESIGNER_LENGTH, which no MakerWorld name is: the designer is stored as
// creators.name, a btree unique key, and a btree entry over 2704 bytes fails
// the insert and with it the whole upload (#143). Such a Designer reads as no
// Designer rather than a clipped one, so two crafted names cannot become one
// creator and the file is still stored. The first occurrence of each field
// wins.
//
// A prefix cut by the 256 KiB read cap can hide any field after the cut,
// Designer included (Bambu Studio writes Description before Designer, so a
// long description can push it out and this returns null). Nothing in the
// prefix shows that a cut happened, so this cannot tell; a caller that needs
// to know must learn it from the reader (PR #24 review).
export function extractMakerWorld(modelXmlPrefix: string): MakerWorldDetails | null {
  const found = new Map<string, string>();
  for (const [name, value] of metadataElements(modelXmlPrefix ?? "")) {
    if (!found.has(name)) {
      found.set(name, decodeEntities(decodeEntities(value)).replaceAll("\u0000", ""));
    }
  }
  const text = (name: string): string | null =>
    blankToNull(collapse(decodeEntities(found.get(name) ?? "")));
  const designer = text("Designer");
  if (designer === null || designer.length > MAX_DESIGNER_LENGTH) return null;
  if (GENERATORS.has(designer.toLowerCase())) return null;
  const description = blankToNull(found.get("Description") ?? "");
  return {
    title: text("Title"),
    designer,
    descriptionHtml: description === null ? null : description.trim(),
    license: text("License"),
  };
}
