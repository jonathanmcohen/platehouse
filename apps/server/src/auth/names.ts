// Cleaning a person's display name, when it is recorded at sign-in
// (displayNameOf) and again when it is read back for the users and tokens
// lists, so a name recorded before the cleaning existed is shown clean too.

/** The longest display name a session keeps (the schema's limit, migration 0013). */
export const MAX_DISPLAY_NAME = 200;

/** text with each control character (C0, DEL and C1) made a space. */
function spaceControls(text: string): string {
  return Array.from(text, (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
  }).join("");
}

/**
 * Format characters (category Cf): the left-to-right and right-to-left marks,
 * the embedding, override and isolate controls, zero-width characters and
 * the like. They draw nothing but can reorder the text around them, so a
 * name that shows in a list beside other text cannot carry them. The
 * zero-width non-joiner and joiner (U+200C, U+200D) are the exception: they
 * are not direction controls, and Persian, some Indic scripts and emoji
 * sequences need them to be written correctly.
 */
const FORMAT_CHARACTERS = /(?![\u200c\u200d])\p{Cf}/gu;

/**
 * Joiners and white space draw nothing, so a name of only those is no name
 * (it would show as a blank label).
 */
const NOTHING_TO_SHOW = /^[\s\u200c\u200d]*$/u;

/**
 * A name with control and format characters taken out, white space trimmed
 * and collapsed, and cut to MAX_DISPLAY_NAME characters; null when nothing
 * is left.
 */
export function cleanName(value: string): string | null {
  const clean = spaceControls(value.replace(FORMAT_CHARACTERS, "")).replace(/\s+/g, " ").trim();
  if (NOTHING_TO_SHOW.test(clean)) return null;
  return Array.from(clean).slice(0, MAX_DISPLAY_NAME).join("");
}
