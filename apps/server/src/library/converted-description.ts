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
  // Every code point is at most 2 UTF-16 units, so a shorter string fits.
  if (markdown.length > MAX_DESCRIPTION_CODE_POINTS) {
    let count = 0;
    for (const _ of markdown) {
      count += 1;
      if (count > MAX_DESCRIPTION_CODE_POINTS) return "";
    }
  }
  return markdown;
}
