import { htmlToMarkdown } from "@platehouse/makerworld";

/** The longest description stored, in code points: the API's own limit. */
export const MAX_DESCRIPTION_CODE_POINTS = 200_000;

/**
 * A MakerWorld description as the Markdown stored for a model: converted and
 * trimmed, or "" (no description) when there is none or it is over the limit.
 * It is dropped, not cut, because a cut Markdown document could end inside a
 * construct. Ingest and the description re-conversion both store through it.
 */
export function convertedDescription(html: string | null): string {
  if (!html) return "";
  const markdown = htmlToMarkdown(html).trim();
  return fits(markdown) ? markdown : "";
}

/** True when text is at most MAX_DESCRIPTION_CODE_POINTS code points. */
export function fits(text: string): boolean {
  // Every code point is at most 2 UTF-16 units, so a shorter string fits.
  if (text.length <= MAX_DESCRIPTION_CODE_POINTS) return true;
  let count = 0;
  for (const _ of text) {
    count += 1;
    if (count > MAX_DESCRIPTION_CODE_POINTS) return false;
  }
  return true;
}

/**
 * The description as stored: the text, then the licence note after a blank
 * line, a blank part left out. When the note would take the whole over the
 * limit, the note alone is left out (the licence note column still holds it),
 * so what is stored always fits.
 */
export function joinWithNote(markdown: string, note: string | null | undefined): string {
  const withNote = [markdown, note ?? ""].filter((p) => p !== "").join("\n\n");
  return fits(withNote) ? withNote : markdown;
}
