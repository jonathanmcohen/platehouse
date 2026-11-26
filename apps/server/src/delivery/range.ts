// The Range header on downloads (RFC 9110 section 14): one byte range, or
// nothing.
//
// - Only the `bytes` unit and only a single range are served: `first-last`,
//   `first-` and `-suffix`. Multi-range (any comma) and any other unit are
//   ignored, so the file goes out whole with a 200. A header this module
//   cannot read is never a 400 and never a 500.
// - A file of 0 bytes ignores Range (there is no byte to ask for).
// - A range that starts past the end, or a zero-length suffix, is
//   "unsatisfiable" (a 416). A last byte past the end is clamped to the end.
// - If-Range is a strong comparison against the route's ETag only: the
//   routes send no Last-Modified, so a date never matches, and neither does a
//   weak tag, a list or another file's tag. A mismatch ignores the Range.
// - Whatever comes back is either undefined, "unsatisfiable", or integers
//   with 0 <= start <= end < size.
//
// Header values are typed unknown: a header map can hold an array, and
// nothing in it is trusted. This module imports nothing from the app.

/** `end` is inclusive; always `0 <= start <= end < size`. */
export interface ByteRange {
  start: number;
  end: number;
}

/** `undefined` means ignore the header and send the whole file. */
export type RangeChoice = ByteRange | "unsatisfiable" | undefined;

export type PickRange = (record: { size: number; etag: string | undefined }) => RangeChoice;

// ASCII digits only; no sign, no other numeral systems. Optional space or tab
// after `=` and at the end.
const RANGE = /^bytes=[ \t]*(?:([0-9]+)-([0-9]*)|-([0-9]+))[ \t]*$/i;

export function parseRange(header: unknown, size: number): RangeChoice {
  if (typeof header !== "string") return undefined;
  if (!Number.isSafeInteger(size) || size <= 0) return undefined;
  const match = RANGE.exec(header);
  if (!match) return undefined;
  const [, firstText, lastText, suffixText] = match;

  if (suffixText !== undefined) {
    const n = Number(suffixText);
    if (n === 0) return "unsatisfiable";
    if (!Number.isSafeInteger(n)) return undefined;
    if (n >= size) return { start: 0, end: size - 1 };
    return { start: size - n, end: size - 1 };
  }

  const first = Number(firstText);
  if (!Number.isSafeInteger(first)) return undefined;
  if (lastText === undefined || lastText === "") {
    return first >= size ? "unsatisfiable" : { start: first, end: size - 1 };
  }
  const last = Number(lastText);
  // Checked before the size: a backwards range is malformed, not unsatisfiable.
  if (Number.isSafeInteger(last) && last < first) return undefined;
  if (first >= size) return "unsatisfiable";
  return { start: first, end: Number.isSafeInteger(last) ? Math.min(last, size - 1) : size - 1 };
}

export function ifRangeAllows(ifRange: unknown, etag: string | undefined): boolean {
  if (ifRange === undefined) return true;
  if (etag === undefined || typeof ifRange !== "string") return false;
  return ifRange.trim() === etag;
}

export function rangePicker(
  headers: { range?: unknown; "if-range"?: unknown },
  method: string,
): PickRange | undefined {
  if (method !== "GET" || headers.range === undefined) return undefined;
  return (record) =>
    ifRangeAllows(headers["if-range"], record.etag)
      ? parseRange(headers.range, record.size)
      : undefined;
}
