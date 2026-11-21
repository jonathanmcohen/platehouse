// Numbers, dates and lists for a language, through Intl (the maintainer, 2026-11-19).
// Units (g, kg, KB, h, min, %) are catalog messages, not Intl units, so the
// English output stays exactly what the UI showed before translations and
// each language writes its own (French Ko and Mo, a space before %).

const numberFormats = new Map<string, Intl.NumberFormat>();

/**
 * A number with at most maxFraction decimals and no thousands separator,
 * as the UI's figures have always been written (41.4, 1234.57), in the
 * language's decimal mark (41,4 in French and Spanish).
 */
export function formatDecimal(locale: string, value: number, maxFraction: number): string {
  const key = `${locale}|${maxFraction}`;
  let f = numberFormats.get(key);
  if (f === undefined) {
    f = new Intl.NumberFormat(locale, { maximumFractionDigits: maxFraction, useGrouping: false });
    numberFormats.set(key, f);
  }
  return f.format(value);
}

/** A date, or a date and time, in the language. */
export function formatDateTime(locale: string, iso: string | Date, withTime = false): string {
  const options: Intl.DateTimeFormatOptions = withTime
    ? { dateStyle: "medium", timeStyle: "short" }
    : { dateStyle: "medium" };
  return new Intl.DateTimeFormat(locale, options).format(
    typeof iso === "string" ? new Date(iso) : iso,
  );
}

/**
 * A list as the UI writes one: "a, b, c" in English, the language's own
 * short unit list elsewhere (French "a, b et c").
 */
export function formatList(locale: string, items: readonly string[]): string {
  return new Intl.ListFormat(locale, { type: "unit", style: "short" }).format(items);
}

/** A language's name in itself (espanol, francais), for the language menu. */
export function languageName(locale: string): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: "language" }).of(locale);
    if (name !== undefined && name !== locale)
      return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
  } catch {
    // An unknown code keeps its code as its name.
  }
  return locale;
}
