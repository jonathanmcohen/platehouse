// Entity helpers for the frozen converters in this folder. They are copies of
// the ones in ../extract.ts as they stood when the converters were frozen.
// Legacy code must never import live helpers: the frozen converters must keep
// producing exactly what they produced, whatever later changes to extract.ts.

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
