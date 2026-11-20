// The one cleaning step for error text the app stored and shows to a user
// (issue #239). The text is stored as the program that wrote it sent it:
// Orca's failure detail (estimates/service.ts), OpenSCAD's or the STEP
// converter's message, an inbox reason. It can hold the slicer's work
// paths, host paths, the slicer's or the store's URL, addresses and
// tokens, so it is cleaned when it is read for display, never when it is
// stored. That way rows already stored are cleaned too, and the stored
// text stays whole for anyone reading the database.
//
// Used by:
// - estimates/display.ts plateNumbers: the failure detail on the model page
//   and in the Public API v1 (both read plate numbers from it);
// - app-api/activity.ts: the Activity page's failed estimates and inbox
//   files, and its failed renders through scrubDerivedMessage (issue #273);
// - app-api/model.ts and api/v1.ts: a file's render or conversion message
//   (files.derived_message) on the model page's Files tab and in the Public
//   API v1 (issue #260), through scrubDerivedMessage.

/** Longest cleaned text shown, before "...". */
export const SCRUB_MAX_CHARS = 1_000;

/**
 * Longest render or conversion message shown by scrubDerivedMessage. The
 * slicer stores at most the last 2000 characters of OpenSCAD's or the STEP
 * converter's output (apps/slicer/src/sandbox.ts tailLines), and derived.ts
 * can put a sentence of about 150 characters in front of it
 * (PREVIOUS_RENDERS_SENTENCE and "OpenSCAD said:"), so this shows any
 * message the app stores whole.
 */
export const DERIVED_MESSAGE_MAX_CHARS = 2_500;

/** How scrubText cuts text over its limit: keep the start (the default) or the end. */
export interface ScrubOptions {
  maxChars?: number;
  keep?: "start" | "end";
}

/**
 * Takes out of stored error text everything a user must not be shown:
 * tokens and credentials, URLs (signed ones included), file system paths,
 * IP addresses, host:port pairs and internal host names. The words around
 * them stay, so the message still reads. Cut at SCRUB_MAX_CHARS characters
 * (options.maxChars), keeping the start with "..." after it, or with
 * options.keep "end", keeping the end with "..." before it.
 */
export function scrubText(text: string, options: ScrubOptions = {}): string {
  let out = text;
  out = out.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]");
  out = out.replace(/\bph_[A-Za-z0-9_-]{16,}/g, "[redacted]");
  out = out.replace(
    /\b(passwords?|passwd|secrets?|tokens?|api[_-]?keys?|access[_-]?keys?|credentials?)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    (_m, key: string, sep: string) => `${key}${sep}[redacted]`,
  );
  out = out.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi, "[address]");
  out = out.replace(/\b[A-Za-z]:\\[^\s"'<>)\]]*/g, "[path]");
  out = out.replace(/(^|[\s"'(=,[])~\/[^\s"'<>)\],]*/g, "$1[path]");
  out = out.replace(/(^|[\s"'(=,[])\/[^\s"'<>)\],]+/g, "$1[path]");
  out = out.replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, "[address]");
  out = out.replace(
    /\b(?=[A-Za-z0-9.-]*[A-Za-z])[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*:\d{2,5}\b/g,
    "[address]",
  );
  out = out.replace(
    /\b(?:[A-Za-z0-9-]+\.)+(?:local|lan|internal|home|arpa|localdomain)\b/gi,
    "[address]",
  );
  out = out.replace(/\blocalhost\b/gi, "[address]");
  out = out.trim();
  const max = options.maxChars ?? SCRUB_MAX_CHARS;
  if (out.length <= max) return out;
  return options.keep === "end" ? `...${out.slice(out.length - max)}` : `${out.slice(0, max)}...`;
}

/** scrubText for a column that may be null: null for none, and for text with nothing left to show. */
export function scrubDetail(text: string | null, options: ScrubOptions = {}): string | null {
  return text === null ? null : scrubText(text, options) || null;
}

/**
 * scrubDetail for a file's render or conversion message
 * (files.derived_message). OpenSCAD's and the STEP converter's error line
 * is the last line of their output, so the whole stored message is shown
 * (DERIVED_MESSAGE_MAX_CHARS), and text longer than that keeps its end.
 */
export function scrubDerivedMessage(text: string | null): string | null {
  return scrubDetail(text, { maxChars: DERIVED_MESSAGE_MAX_CHARS, keep: "end" });
}
