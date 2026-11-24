// Cleaning a person's display name, when it is recorded at sign-in
// (displayNameOf) and again when it is read back for the users and tokens
// lists, so a name recorded before the cleaning existed is shown clean too.
import { nothingToShow, stripFormatChars } from "../format-chars.js";

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
 * A name with control and format characters taken out, white space trimmed
 * and collapsed, and cut to MAX_DISPLAY_NAME characters; null when nothing
 * is left.
 */
export function cleanName(value: string): string | null {
  const clean = spaceControls(stripFormatChars(value)).replace(/\s+/g, " ").trim();
  if (nothingToShow(clean)) return null;
  return Array.from(clean).slice(0, MAX_DISPLAY_NAME).join("");
}
