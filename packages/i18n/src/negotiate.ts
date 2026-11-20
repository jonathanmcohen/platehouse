// Which language a page is shown in (Jon, 2026-11-19): the choice saved in
// the ph_lang cookie when that language is still available, else the
// browser's languages (the Accept-Language header on the server,
// navigator.languages in the browser), else English. A browser language
// matches a locale exactly, ignoring case, or by its base language (es-MX
// takes es, and a local pt takes pt-BR when there is no pt-BR).

/** The cookie the language menu writes. */
export const LANG_COOKIE = "ph_lang";

/** English, the source of truth and the last fallback. */
export const SOURCE_LOCALE = "en";

/** A locale code as a file may be named: language, optional script, optional region. */
const LOCALE_SHAPE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$/;

/**
 * The canonical form of a locale code (es-mx becomes es-MX), or undefined
 * when it is not one of the shapes a catalog may have.
 */
export function canonicalLocale(code: string): string | undefined {
  if (code.length === 0 || code.length > 20) return undefined;
  let canonical: string;
  try {
    [canonical = ""] = Intl.getCanonicalLocales(code);
  } catch {
    return undefined;
  }
  return LOCALE_SHAPE.test(canonical) ? canonical : undefined;
}

/** The languages an Accept-Language header asks for, best first; q=0 is left out. */
export function parseAcceptLanguage(header: string | undefined): string[] {
  if (header === undefined || header.length > 2000) return [];
  const entries: Array<{ tag: string; q: number; order: number }> = [];
  header.split(",").forEach((part, order) => {
    const [range = "", ...params] = part.trim().split(";");
    const tag = range.trim();
    if (tag === "" || tag === "*") return;
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(p);
      if (m !== null) q = Number(m[1]);
    }
    if (!(q > 0)) return;
    entries.push({ tag, q, order });
  });
  entries.sort((a, b) => b.q - a.q || a.order - b.order);
  return entries.map((e) => e.tag);
}

function base(code: string): string {
  return code.split("-")[0]?.toLowerCase() ?? "";
}

/** The first available locale one of the wanted languages matches, exactly or by base language. */
export function matchLocale(
  wanted: readonly string[],
  available: readonly string[],
): string | undefined {
  for (const raw of wanted) {
    const want = canonicalLocale(raw);
    if (want === undefined) continue;
    const exact = available.find((a) => a.toLowerCase() === want.toLowerCase());
    if (exact !== undefined) return exact;
    const sameBase = available.find((a) => a.toLowerCase() === base(want));
    if (sameBase !== undefined) return sameBase;
    const anyRegion = available.find((a) => base(a) === base(want));
    if (anyRegion !== undefined) return anyRegion;
  }
  return undefined;
}

/**
 * The locale dates and numbers are formatted in (Jon, 2026-11-19, issue
 * 292): the browser's own full tag when its language is the one shown, so
 * an en-GB browser on English writes 19 Nov 2026, 13:52 and an es-MX browser
 * on Spanish writes Mexican dates; else the shown language itself (a de
 * browser that chose English formats as en). The words always come from the
 * shown language's catalog. A catalog for a bare language (en, es) takes
 * the browser's first tag in that language, in the browser's own order; a
 * catalog for a region (pt-BR) keeps its region, since its words are that
 * region's.
 */
export function formatLocale(shown: string, wanted: readonly string[]): string {
  if (shown.includes("-")) return shown;
  const tags = wanted.map((w) => canonicalLocale(w)).filter((w): w is string => w !== undefined);
  return tags.find((t) => base(t) === base(shown)) ?? shown;
}

/** The language to show: the saved choice when available, else the browser's, else English. */
export function resolveLocale(input: {
  saved?: string | undefined;
  wanted: readonly string[];
  available: readonly string[];
}): string {
  if (input.saved !== undefined) {
    const saved = canonicalLocale(input.saved);
    const hit =
      saved === undefined
        ? undefined
        : input.available.find((a) => a.toLowerCase() === saved.toLowerCase());
    if (hit !== undefined) return hit;
  }
  return matchLocale(input.wanted, input.available) ?? SOURCE_LOCALE;
}
