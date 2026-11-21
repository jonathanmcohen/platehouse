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

import { isIP } from "node:net";

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

// The address scan's invariant, which test/scrub.test.ts checks on thousands
// of generated messages: every span the IPv4 pattern it replaced
// (/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g) took out lies inside a span
// it takes out, and after it the text holds no IPv6 address holding a digit
// whose neighbours are not hex digits, ':' or '.'. At every place an address
// could start, the longest address that starts there (up to
// ADDRESS_MAX_CHARS) is taken out, whatever follows it, except that it may
// not end strictly inside a span of the replaced pattern. An address may
// not start straight after a hex digit, so one written straight after a
// letter A to F or a digit (a10.0.0.5, f2001:db8::1) is not taken out whole;
// the replaced pattern did not take a10.0.0.5 out either.

/**
 * Longest text one address can take: [, 45 characters of IPv6, a zone of up
 * to 32, ], and :65535. No candidate is longer, which bounds the work at
 * each start and keeps the scan linear in the text's length.
 */
const ADDRESS_MAX_CHARS = 100;

function isHexDigit(c: string | undefined): boolean {
  return c !== undefined && /^[0-9A-Fa-f]$/.test(c);
}

function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= "0" && c <= "9";
}

/** A zone id: letters and digits, dots only between them (eth0, en0, eth0.100). */
const ZONE = /^[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*$/;

/** A dotted quad as the replaced pattern read it: any one to three digits in each part. */
const DOTTED_QUAD = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * An IPv4 address (any dotted quad, as the replaced pattern took), or an
 * IPv6 address, a zone allowed, that holds a digit (in the zone too), as
 * Node's own parser reads it. The digit rule keeps a C++ name made of hex
 * letters (Add::Feed) from reading as IPv6. Node takes nearly any text as a
 * zone, so the zone is checked here, and a full stop after it stays.
 */
function isPlainAddress(text: string): boolean {
  if (DOTTED_QUAD.test(text)) return true;
  const version = isIP(text);
  if (version === 4) return true;
  if (version !== 6) return false;
  const zone = text.indexOf("%");
  if (zone !== -1 && !ZONE.test(text.slice(zone + 1))) return false;
  return /\d/.test(text);
}

/**
 * An address: plain, in brackets ([192.0.2.7], [2001:db8::1%eth0]), or
 * either with a :port.
 */
function isAddress(text: string): boolean {
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    if (close === -1) return false;
    const rest = text.slice(close + 1);
    return (rest === "" || /^:\d{1,5}$/.test(rest)) && isPlainAddress(text.slice(1, close));
  }
  if (isPlainAddress(text)) return true;
  const colon = text.lastIndexOf(":");
  return (
    colon > 0 && /^\d{1,5}$/.test(text.slice(colon + 1)) && isPlainAddress(text.slice(0, colon))
  );
}

/**
 * The ends of the text from start that could be an unbracketed address,
 * shortest first. The walk stops as soon as no longer text could be one: a
 * character no address holds, a group of more than five digits or letters,
 * more than nine colons, a second "::", or more than three dots before a
 * zone. It keeps only ends isAddress could accept: the text ends in a hex
 * digit, a zone character or "::", holds a digit, and has three dots (a
 * dotted quad, perhaps with a port, or an IPv6 address ending in one) or
 * none and at least two colons (IPv6). So only those are parsed.
 */
function plainEnds(text: string, start: number): number[] {
  const ends: number[] = [];
  const limit = Math.min(text.length, start + ADDRESS_MAX_CHARS);
  let colons = 0;
  let dots = 0;
  let doubles = 0;
  let group = 0;
  let digit = false;
  let zone = -1;
  const plausible = () => digit && (dots === 3 || (dots === 0 && colons >= 2));
  for (let e = start; e < limit; e += 1) {
    const c = text[e] as string;
    if (isDigit(c)) digit = true;
    if (zone !== -1) {
      if (!/^[0-9A-Za-z.]$/.test(c)) break;
      if (c !== "." && digit) ends.push(e + 1);
      continue;
    }
    if (c === ":") {
      colons += 1;
      if (colons > 9) break;
      if (e > start && text[e - 1] === ":") {
        doubles += 1;
        if (doubles > 1) break;
        if (plausible()) ends.push(e + 1);
      }
      group = 0;
    } else if (c === ".") {
      dots += 1;
      if (dots > 3) break;
      group = 0;
    } else if (c === "%") {
      if (colons < 2) break;
      zone = e;
    } else if (isHexDigit(c)) {
      group += 1;
      if (group > 5) break;
      if (plausible()) ends.push(e + 1);
    } else {
      break;
    }
  }
  return ends;
}

/**
 * The ends of the text from a [ at start that could be a bracketed address,
 * shortest first: just after the ], and after each digit of a :port.
 */
function bracketEnds(text: string, start: number): number[] {
  const limit = Math.min(text.length, start + ADDRESS_MAX_CHARS);
  let close = -1;
  for (let e = start + 1; e < limit; e += 1) {
    const c = text[e] as string;
    if (c === "]") {
      close = e;
      break;
    }
    if (!/^[0-9A-Za-z:.%]$/.test(c)) return [];
  }
  if (close === -1) return [];
  const ends = [close + 1];
  if (text[close + 1] === ":") {
    for (let e = close + 2; e < Math.min(limit, close + 7) && isDigit(text[e]); e += 1) {
      ends.push(e + 1);
    }
  }
  return ends;
}

/** The IPv4 pattern the address scan replaced, with its global flag as it was used. */
const REPLACED_IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g;

/**
 * For each place in text, whether it falls strictly inside a span the
 * replaced IPv4 pattern took out (after its first character, before its
 * end). An address may not end there.
 */
function insideReplacedIPv4(text: string): Uint8Array {
  const inside = new Uint8Array(text.length + 1);
  for (const m of text.matchAll(REPLACED_IPV4)) {
    inside.fill(1, m.index + 1, m.index + m[0].length);
  }
  return inside;
}

/**
 * Where the longest address that starts at start ends, or -1. An end that
 * falls strictly inside a span the replaced IPv4 pattern took out is
 * skipped, so 1:2:3:4:5:6:7:10 never takes the "10" of 10.0.0.5 and leaves
 * ".0.0.5" behind.
 */
function addressEnd(text: string, start: number, inside: Uint8Array): number {
  const ends = text[start] === "[" ? bracketEnds(text, start) : plainEnds(text, start);
  for (let k = ends.length - 1; k >= 0; k -= 1) {
    const end = ends[k] as number;
    if (inside[end] === 0 && isAddress(text.slice(start, end))) return end;
  }
  return -1;
}

/**
 * Where every IPv4 and IPv6 address in text is, bare, in brackets, with a
 * zone or a port: [start, end) spans, left to right, none overlapping.
 * scrubAddresses replaces each with [address]; test/scrub.test.ts checks
 * the scan's invariant on them. An address can start at a [, or at a hex digit or a
 * colon that does not come straight after a hex digit (inside a hex run
 * such as a hash or a C++ name, a later start would only cut a word in
 * two). Starts are tried left to right, and at each the longest address
 * there is taken out. Straight after one, the text before is "[address]",
 * not a hex digit, so the next character may start another.
 */
export function addressSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  const inside = insideReplacedIPv4(text);
  let kept = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const afterHex = i !== kept && isHexDigit(text[i - 1]);
    const canStart = c === "[" || ((isHexDigit(c) || c === ":") && !afterHex);
    if (canStart) {
      const end = addressEnd(text, i, inside);
      if (end !== -1) {
        spans.push([i, end]);
        kept = end;
        i = end;
        continue;
      }
    }
    i += 1;
  }
  return spans;
}

/** Every address addressSpans finds in text, as [address]. */
function scrubAddresses(text: string): string {
  let out = "";
  let kept = 0;
  for (const [start, end] of addressSpans(text)) {
    out += `${text.slice(kept, start)}[address]`;
    kept = end;
  }
  return kept === 0 ? text : out + text.slice(kept);
}

/**
 * A URL: its scheme starts where a run of scheme characters starts, read
 * whole in one step (a lookahead with a back-reference, which never gives
 * characters back), so no position is scanned twice. The host may be an
 * IPv6 address in brackets (http://[2001:db8::1]:8080/).
 */
const URL_RE =
  /(?<![a-z0-9+.-])(?=([a-z0-9+.-]+))\1:\/\/(?:\[[^\]\s]*\][^\s"'<>)\]]*|[^\s"'<>)\]]+)/gi;

/** A URL as [address], keeping what came before its scheme when the run did not start with one. */
function scrubUrl(match: string, scheme: string): string {
  // A scheme starts with a letter; a run such as 1-http:// keeps its "1-".
  const at = /(?:^|[+.-])[a-z]/i.exec(scheme);
  if (at === null) return match;
  const from = at[0].length === 1 ? at.index : at.index + 1;
  return `${scheme.slice(0, from)}[address]`;
}

/**
 * A host and port (slicer:8080, db.internal:5432): the host starts where a
 * run of host characters starts and is read whole, as URL_RE reads a scheme,
 * then checked as dotted labels holding a letter.
 */
const HOST_PORT_RE = /(?<![\w.-])(?=([A-Za-z0-9.-]+))\1:\d{2,5}(?!\w)/g;

/** Dotted labels, none empty. */
const LABELS = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/;

function scrubHostPort(match: string, run: string): string {
  // Leading dots, and anything up to a doubled dot, are not part of the host.
  const doubled = run.lastIndexOf("..");
  let from = doubled === -1 ? 0 : doubled + 2;
  while (run[from] === ".") from += 1;
  const host = run.slice(from);
  if (!LABELS.test(host) || !/[A-Za-z]/.test(host)) return match;
  return `${run.slice(0, from)}[address]`;
}

/** The last label of a name on an internal network. */
const INTERNAL_TLDS = new Set(["local", "lan", "internal", "home", "arpa", "localdomain"]);

/** A run of host name characters, read whole from where it starts. */
const NAME_RUN_RE = /(?<![\w.-])(?=([A-Za-z0-9_.-]+))\1/g;

/**
 * Internal host names in a run (server.lan, platehouse.home.arpa): in each
 * chain of dotted labels, everything up to the last label that is an
 * internal network's, when at least one label comes before it, as
 * [address]. A label with an underscore is not a host label and breaks the
 * chain.
 */
function scrubInternalNames(run: string): string {
  const labels = run.split(".");
  const out: string[] = [];
  let i = 0;
  while (i < labels.length) {
    const label = labels[i] as string;
    if (!/^[A-Za-z0-9-]+$/.test(label)) {
      out.push(label);
      i += 1;
      continue;
    }
    // The chain of valid labels from i.
    let end = i;
    while (end < labels.length && /^[A-Za-z0-9-]+$/.test(labels[end] as string)) end += 1;
    let last = -1;
    for (let k = end - 1; k > i; k -= 1) {
      if (INTERNAL_TLDS.has((labels[k] as string).toLowerCase())) {
        last = k;
        break;
      }
    }
    if (last === -1) {
      out.push(...labels.slice(i, end));
    } else {
      out.push("[address]", ...labels.slice(last + 1, end));
    }
    i = end;
  }
  return out.join(".");
}

/**
 * Takes out of stored error text everything a user must not be shown:
 * tokens and credentials, URLs (signed ones included), file system paths,
 * IPv4 and IPv6 addresses (bare, or in brackets, with a zone or a port,
 * whatever comes after them, and after anything but a hex digit), host:port
 * pairs and internal host
 * names. The words around them stay, so the message still reads. Cut at
 * SCRUB_MAX_CHARS characters (options.maxChars), keeping the start with
 * "..." after it, or with options.keep "end", keeping the end with "..."
 * before it. The work is linear in the text's length.
 */
export function scrubText(text: string, options: ScrubOptions = {}): string {
  let out = text;
  out = out.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]");
  out = out.replace(/\bph_[A-Za-z0-9_-]{16,}/g, "[redacted]");
  out = out.replace(
    /\b(passwords?|passwd|secrets?|tokens?|api[_-]?keys?|access[_-]?keys?|credentials?)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    (_m, key: string, sep: string) => `${key}${sep}[redacted]`,
  );
  out = out.replace(URL_RE, scrubUrl);
  out = out.replace(/\b[A-Za-z]:\\[^\s"'<>)\]]*/g, "[path]");
  out = out.replace(/(^|[\s"'(=,[])~\/[^\s"'<>)\],]*/g, "$1[path]");
  out = out.replace(/(^|[\s"'(=,[])\/[^\s"'<>)\],]+/g, "$1[path]");
  out = scrubAddresses(out);
  out = out.replace(HOST_PORT_RE, scrubHostPort);
  out = out.replace(NAME_RUN_RE, (_m, run: string) => scrubInternalNames(run));
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
