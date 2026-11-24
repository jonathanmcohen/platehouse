/**
 * Unicode format characters (category Cf) in a name shown beside other text:
 * the left-to-right and right-to-left marks, the embedding, override and
 * isolate controls, zero-width characters and the like. They draw nothing but
 * can reorder the text around them. The zero-width non-joiner and joiner
 * (U+200C, U+200D) are the exception: they are not direction controls, and
 * Persian, some Indic scripts and emoji sequences need them to be written
 * correctly. One rule for every name: sign-in names (auth/names.ts), upload
 * names and the inbox's (issue #473).
 */
const FORMAT_CHARACTERS = /(?![\u200c\u200d])\p{Cf}/gu;

/**
 * Joiners and white space draw nothing, so a name of only those is no name
 * (it would show as a blank label).
 */
const NOTHING_TO_SHOW = /^[\s\u200c\u200d]*$/u;

/** name without its format characters, the joiners U+200C and U+200D kept. */
export function stripFormatChars(name: string): string {
  return name.replace(FORMAT_CHARACTERS, "");
}

/** Whether name draws nothing: empty, or only white space and joiners. */
export function nothingToShow(name: string): boolean {
  return NOTHING_TO_SHOW.test(name);
}
