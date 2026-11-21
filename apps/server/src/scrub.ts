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

/**
 * A run of the characters an address can be written with: an IPv4 or IPv6
 * address, in brackets or not, with a zone (%eth0) and a :port, and the
 * label and colon a message may put straight before it (eth0:fe80::1). The
 * text is split into maximal runs once, so every run is looked at once.
 */
const ADDRESS_RUN = /[0-9A-Za-z:.%_[\]-]+/g;

/**
 * Longest text one address can take: [, 45 characters of IPv6, a zone of up
 * to 32, ], and :65535. A longer candidate is never parsed, which keeps the
 * work for each start bounded and the scan linear in the run's length.
 */
const ADDRESS_MAX_CHARS = 100;

/** Characters that end a candidate: neither an address nor a zone holds them. */
function isBreak(c: string | undefined): boolean {
  return c === "-" || c === "_";
}

/** Characters a candidate may end with that are punctuation, not address. */
function isTrailing(c: string | undefined): boolean {
  return c === "." || c === "]" || c === ":";
}

/**
 * Whether a candidate with these counts could be an address at all, so the
 * parser is asked only about the few that could: an IPv4 address has three
 * dots (and a colon before a port); an IPv6 address has "::" and up to 9
 * colons (8 with a port, one more for the "::"), or no "::" and 6 to 8
 * colons (an IPv4 tail, eight groups, or eight groups and a port).
 */
function couldBeAddress(colons: number, dots: number, doubleColon: boolean): boolean {
  if (dots === 3 && colons <= 1) return true;
  return doubleColon ? colons >= 2 && colons <= 9 : colons >= 6 && colons <= 8;
}

/** A zone id: letters and digits, dots only between them (eth0, en0, eth0.100). */
const ZONE = /^[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*$/;

/**
 * An IPv4 address, or an IPv6 address (a zone allowed) that holds a digit,
 * as Node's own parser reads them. The digit rule keeps a C++ name made of
 * hex letters (Add::Feed) from reading as IPv6. Node takes any text as a
 * zone, so the zone is checked here, and a full stop after it stays.
 */
function isPlainAddress(text: string): boolean {
  const version = isIP(text);
  if (version === 4) return true;
  if (version !== 6) return false;
  const zone = text.indexOf("%");
  if (zone !== -1 && !ZONE.test(text.slice(zone + 1))) return false;
  return /\d/.test(zone === -1 ? text : text.slice(0, zone));
}

/** An address, an IPv6 address in brackets, or either with a :port. */
function isAddress(text: string): boolean {
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    if (close === -1) return false;
    const rest = text.slice(close + 1);
    return (
      (rest === "" || /^:\d{1,5}$/.test(rest)) &&
      isIP(text.slice(1, close)) === 6 &&
      isPlainAddress(text.slice(1, close))
    );
  }
  if (isPlainAddress(text)) return true;
  const colon = text.lastIndexOf(":");
  return (
    colon > 0 && /^\d{1,5}$/.test(text.slice(colon + 1)) && isPlainAddress(text.slice(0, colon))
  );
}

/**
 * Where the longest address that starts at start ends in the run, or -1.
 * A candidate ends at the next hyphen or underscore (stop), at that point
 * without trailing dots, colons and brackets, or just before any colon on
 * the way (an address followed by :label), and is at most
 * ADDRESS_MAX_CHARS long. The walk counts colons and dots as it goes, so
 * only a candidate couldBeAddress allows reaches the parser, longest first.
 */
function addressEnd(run: string, start: number, stop: number): number {
  const limit = Math.min(stop, start + ADDRESS_MAX_CHARS);
  const ends: number[] = [];
  let colons = 0;
  let dots = 0;
  let doubleColon = false;
  for (let e = start; e <= limit; e += 1) {
    const atColon = e < limit && run[e] === ":";
    if (e > start && (atColon || e === limit) && couldBeAddress(colons, dots, doubleColon)) {
      ends.push(e);
    }
    if (e === limit) break;
    if (atColon) {
      if (run[e - 1] === ":" && e - 1 >= start) doubleColon = true;
      colons += 1;
    } else if (run[e] === ".") {
      dots += 1;
    }
  }
  // The end without trailing punctuation, as in "at 2001:db8::1." or "192.0.2.7:".
  let trimmed = limit;
  while (trimmed > start && isTrailing(run[trimmed - 1])) trimmed -= 1;
  if (trimmed < limit && trimmed > start) ends.push(trimmed);
  ends.sort((a, b) => b - a);
  for (const end of ends) {
    if (isAddress(run.slice(start, end))) return end;
  }
  return -1;
}

/**
 * The run with each address in it replaced by [address]. A start is the
 * run's beginning, a bracket, or the character after a colon, hyphen or
 * underscore, so an address written straight after a label (eth0:fe80::1,
 * node-1:2001:db8::1) is found whatever the label holds. Starts are tried
 * left to right and the first one that begins an address wins, which is the
 * longest address there: when the text before an address could itself be
 * part of one (the "1:" in node-1:2001:db8::1), it goes too, so more is taken
 * out, never less.
 */
function scrubRun(run: string): string {
  const n = run.length;
  // stopAt[i]: the next hyphen or underscore at or after i, or n.
  const stopAt = new Int32Array(n + 1);
  stopAt[n] = n;
  for (let i = n - 1; i >= 0; i -= 1) {
    stopAt[i] = isBreak(run[i]) ? i : (stopAt[i + 1] as number);
  }
  let out = "";
  let kept = 0;
  let i = 0;
  while (i < n) {
    const prev = run[i - 1];
    const isStart = i === 0 || prev === ":" || isBreak(prev) || run[i] === "[";
    if (isStart && !isBreak(run[i])) {
      const end = addressEnd(run, i, stopAt[i] as number);
      if (end !== -1) {
        out += `${run.slice(kept, i)}[address]`;
        kept = end;
        i = end;
        continue;
      }
    }
    i += 1;
  }
  return kept === 0 ? run : out + run.slice(kept);
}

/** Every IPv4 and IPv6 address in text, bare, in brackets, with a zone or a port, as [address]. */
function scrubAddresses(text: string): string {
  return text.replace(ADDRESS_RUN, scrubRun);
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
 * IPv4 and IPv6 addresses (bare, or in brackets, with a zone or a port, and
 * after any label and colon), host:port pairs and internal host names. The
 * words around them stay, so the message still reads. Cut at SCRUB_MAX_CHARS
 * characters (options.maxChars), keeping the start with "..." after it, or
 * with options.keep "end", keeping the end with "..." before it. The work is
 * linear in the text's length: no rule scans a position twice.
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
