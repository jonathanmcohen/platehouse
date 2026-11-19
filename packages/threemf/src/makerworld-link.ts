// The MakerWorld design a .3mf came from, for the model page's "View on
// MakerWorld" link. MakerWorld writes the design's ID into 3D/3dmodel.model
// as <metadata name="DesignId">; Bambu Studio reads it under that name
// (bbs_3mf.cpp, BBL_DESIGN_ID_TAG). The input is Project.makerWorldXml, the
// model file up to <resources (at most 256 KiB).
//
// Nothing from the file is ever used as a URL. The value must be a design ID
// (digits, no leading zero, at most 15 of them), or an https URL of a
// MakerWorld model page, from which only the ID is taken. makerWorldUrl then
// builds the link from the ID alone, so the only URL the app ever shows is
// https://makerworld.com/models/<digits>.

/** At most 15 digits: past Number.MAX_SAFE_INTEGER nothing is a real design. */
const DESIGN_ID = /^[1-9][0-9]{0,14}$/;

/** A MakerWorld model page: an optional locale, then /models/<id>, an optional slug. */
const MODEL_PATH = /^\/(?:[a-z]{2}(?:-[a-z]{2,4})?\/)?models\/([1-9][0-9]{0,14})(?:-[^/]*)?\/?$/i;

const HOSTS: ReadonlySet<string> = new Set(["makerworld.com", "www.makerworld.com"]);

/** The longest raw value read; a longer one is refused rather than cut. */
const MAX_VALUE_LENGTH = 300;

// The start tag of a <metadata name="DesignId"> element, matched where
// indexOf found "<metadata" (sticky), and its close tag. Every quantifier is
// bounded, so one attempt does a fixed amount of work and the scan for the
// start tag is linear in the prefix; the first start tag found ends the scan.
const DESIGN_ID_START = /<metadata\s{1,16}name\s{0,16}=\s{0,16}(["'])DesignId\1\s{0,16}>/y;
const METADATA_END = /<\/metadata\s{0,16}>/y;

const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

// One pass of the five XML entities and numeric references. MakerWorld's
// fields are escaped twice in the file (see packages/makerworld extract.ts).
function decodeOnce(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/g, (whole, ref: string) => {
    if (ref[0] !== "#") return XML_ENTITIES[ref] ?? whole;
    const hex = ref[1] === "x" || ref[1] === "X";
    const cp = hex ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)
      ? String.fromCodePoint(cp)
      : whole;
  });
}

/** The design ID in a value: the ID itself, or a MakerWorld model page URL. */
function idOf(value: string): string | null {
  if (DESIGN_ID.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  if (url.port !== "" || !HOSTS.has(url.hostname)) return null;
  return MODEL_PATH.exec(url.pathname)?.[1] ?? null;
}

/**
 * The MakerWorld design ID a 3dmodel.model prefix carries, or null when it
 * carries none or the value is not one. The first DesignId element wins.
 */
export function makerWorldDesignId(modelXmlPrefix: string): string | null {
  const xml = modelXmlPrefix ?? "";
  let pos = 0;
  for (;;) {
    const start = xml.indexOf("<metadata", pos);
    if (start === -1) return null;
    DESIGN_ID_START.lastIndex = start;
    if (!DESIGN_ID_START.test(xml)) {
      pos = start + 1;
      continue;
    }
    // The first DesignId element decides: one with no close tag right after
    // its text, or a text over MAX_VALUE_LENGTH, is no ID at all.
    const from = DESIGN_ID_START.lastIndex;
    const end = xml.indexOf("<", from);
    if (end === -1 || end - from > MAX_VALUE_LENGTH) return null;
    METADATA_END.lastIndex = end;
    if (!METADATA_END.test(xml)) return null;
    const raw = xml.slice(from, end);
    const value = decodeOnce(decodeOnce(decodeOnce(raw))).trim();
    return value === "" ? null : idOf(value);
  }
}

/** The MakerWorld page of a design, built from a valid ID only; null otherwise. */
export function makerWorldUrl(designId: string | null | undefined): string | null {
  if (typeof designId !== "string" || !DESIGN_ID.test(designId)) return null;
  return `https://makerworld.com/models/${designId}`;
}
