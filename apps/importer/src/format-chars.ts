/**
 * Platehouse removes Unicode format characters (category Cf) from a file name
 * when it stores the file, except the zero-width non-joiner and joiner
 * (U+200C, U+200D). The importer compares Manyfold's names with the stored
 * ones, so it applies the same rule to the name Manyfold gives. This copy is
 * pinned to the server's rule by test/format-chars.test.ts.
 */
const FORMAT_CHARACTERS = /(?![‌‍])\p{Cf}/gu;

/** name without its format characters, the joiners U+200C and U+200D kept. */
export function stripFormatChars(name: string): string {
  return name.replace(FORMAT_CHARACTERS, "");
}
