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
//
// The whole scrub's promise, which test/scrub.test.ts checks against a
// frozen copy of the scrub before 0.1.0 on the same messages and more: every
// span that scrub replaced lies inside a span scrubText replaces
// (scrubSpans), for every rule, not only addresses. Each rule gives its
// edits (runRules), and the network rules (addresses, host:port pairs,
// internal host names, localhost) are found on the same text and replaced as
// one union (NETWORK_RULE), so no replacement hides from another rule the
// text it would have taken.

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
 * NETWORK_RULE replaces each with [address]; test/scrub.test.ts checks
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

/**
 * One change a cleaning rule makes: the text from start to end (end not
 * included) becomes replacement.
 */
export type Edit = readonly [start: number, end: number, replacement: string];

/** A cleaning rule: its edits to text, left to right, none overlapping. */
export type Rule = (text: string) => Edit[];

/**
 * A rule from a global regex, run as String.replace runs it: for each match,
 * edit says from how many characters into the match the replacement starts
 * (what comes before stays as it was) and what replaces the rest, or
 * undefined to leave the match alone.
 */
export function regexRule(
  re: RegExp,
  edit: (m: RegExpExecArray) => { from: number; text: string } | undefined,
): Rule {
  if (!re.global) throw new Error("regexRule needs a global regex");
  return (text) => {
    const edits: Edit[] = [];
    for (const m of text.matchAll(re)) {
      const e = edit(m as RegExpExecArray);
      if (e !== undefined) edits.push([m.index + e.from, m.index + m[0].length, e.text]);
    }
    return edits;
  };
}

/**
 * Runs rules over text, each on the text the one before left, and gives the
 * result. With track, it also gives the spans of the original text that were
 * replaced, as [start, end) left to right: each run of replacement text in
 * the result maps back to the smallest span holding everything it replaced,
 * replacements of replacements included. The work is linear in the text's
 * length for each rule.
 */
export function runRules(
  text: string,
  rules: readonly Rule[],
  track = false,
): { text: string; spans: [number, number][] } {
  let current = text;
  // For each character of current: the original span it stands for, and
  // whether it is replacement text. Kept only when tracking.
  let from: number[] = [];
  let to: number[] = [];
  let inserted: boolean[] = [];
  if (track) {
    from = Array.from({ length: text.length }, (_, i) => i);
    to = Array.from({ length: text.length }, (_, i) => i + 1);
    inserted = new Array<boolean>(text.length).fill(false);
  }
  for (const rule of rules) {
    const edits = rule(current);
    if (edits.length === 0) continue;
    let out = "";
    let kept = 0;
    const nFrom: number[] = [];
    const nTo: number[] = [];
    const nInserted: boolean[] = [];
    const copy = (a: number, b: number) => {
      for (let i = a; i < b; i += 1) {
        nFrom.push(from[i] as number);
        nTo.push(to[i] as number);
        nInserted.push(inserted[i] as boolean);
      }
    };
    for (const [start, end, replacement] of edits) {
      out += current.slice(kept, start) + replacement;
      if (track) {
        copy(kept, start);
        let f = start < from.length ? (from[start] as number) : text.length;
        let t = start > 0 ? (to[start - 1] as number) : 0;
        for (let i = start; i < end; i += 1) {
          f = Math.min(f, from[i] as number);
          t = Math.max(t, to[i] as number);
        }
        if (end === start) t = f;
        for (let k = 0; k < replacement.length; k += 1) {
          nFrom.push(f);
          nTo.push(t);
          nInserted.push(true);
        }
      }
      kept = end;
    }
    out += current.slice(kept);
    if (track) {
      copy(kept, current.length);
      from = nFrom;
      to = nTo;
      inserted = nInserted;
    }
    current = out;
  }
  const spans: [number, number][] = [];
  if (track) {
    let i = 0;
    while (i < current.length) {
      if (!inserted[i]) {
        i += 1;
        continue;
      }
      let f = from[i] as number;
      let t = to[i] as number;
      while (i < current.length && inserted[i]) {
        f = Math.min(f, from[i] as number);
        t = Math.max(t, to[i] as number);
        i += 1;
      }
      const last = spans.at(-1);
      if (last !== undefined && f <= last[1]) last[1] = Math.max(last[1], t);
      else spans.push([f, t]);
    }
  }
  return { text: current, spans };
}

/**
 * A URL's scheme and "://": the scheme run starts where a run of scheme
 * characters starts and is read whole in one step (a lookahead with a
 * back-reference, which never gives characters back), so no position is
 * scanned twice.
 */
const SCHEME_RUN = String.raw`(?<![a-z0-9+.-])(?=([a-z0-9+.-]+))\1:\/\/`;

/**
 * A URL's body after "://": its host may be an IPv6 address in brackets
 * (http://[2001:db8::1]:8080/).
 */
const URL_BODY = String.raw`\[[^\]\s]*\][^\s"'<>)\]]*|[^\s"'<>)\]]+`;

/**
 * Every URL in text, as [address], keeping what came before its scheme in
 * the run (1-http:// keeps "1-"). A run in which no scheme starts (7http://)
 * is not a URL, and the scan goes on straight after its "://", so a URL
 * written inside what follows is still found.
 */
function urlEdits(text: string): Edit[] {
  const edits: Edit[] = [];
  const scheme = new RegExp(SCHEME_RUN, "gi");
  const body = new RegExp(URL_BODY, "y");
  for (let m = scheme.exec(text); m !== null; m = scheme.exec(text)) {
    const from = schemeStart(m[1] as string);
    if (from === -1) continue;
    body.lastIndex = m.index + m[0].length;
    const b = body.exec(text);
    if (b === null) continue;
    const end = body.lastIndex;
    edits.push([m.index + from, end, "[address]"]);
    scheme.lastIndex = end;
  }
  return edits;
}

/**
 * Where a URL's scheme starts in its run of scheme characters: a scheme
 * starts with a letter, so a run such as 1-http:// keeps its "1-". -1 when
 * no scheme starts in the run.
 */
function schemeStart(run: string): number {
  const at = /(?:^|[+.-])[a-z]/i.exec(run);
  if (at === null) return -1;
  return at[0].length === 1 ? at.index : at.index + 1;
}

/** Dotted labels, none empty. */
const LABELS = /^[\w-]+(?:\.[\w-]+)*$/;

/** Where the host starts in a host:port's run, or -1 when the run holds no host. */
function hostStart(run: string): number {
  // Leading dots, and anything up to a doubled dot, are not part of the host.
  const doubled = run.lastIndexOf("..");
  let from = doubled === -1 ? 0 : doubled + 2;
  while (run[from] === ".") from += 1;
  const host = run.slice(from);
  return LABELS.test(host) && /[A-Za-z]/.test(host) ? from : -1;
}

function isRunChar(c: string | undefined): boolean {
  return c !== undefined && /^[\w.-]$/.test(c);
}

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /^\w$/.test(c);
}

/**
 * Every host and port in text (slicer:8080, db.internal:5432,
 * my_app-db:5432): a whole run of host characters (letters, digits, '_',
 * '-', '.') then ":" and two to five digits that no letter or '_' follows,
 * the host checked as dotted labels holding a letter (hostStart). Every run
 * is tried, so a candidate that fails the check never hides the run after
 * it (the digits of 7:8080-db:5432 start the next run). A candidate whose
 * port lies in a span the replaced IPv4 pattern took (the "192" of
 * peer:192.0.2.7) is not one: that pattern ran first and took the address.
 * Linear: each character is read once as part of a run and once as a port.
 */
function hostPortSpans(text: string, inIPv4: Uint8Array): [number, number][] {
  const spans: [number, number][] = [];
  let i = 0;
  while (i < text.length) {
    if (!isRunChar(text[i])) {
      i += 1;
      continue;
    }
    let e = i;
    while (isRunChar(text[e])) e += 1;
    if (text[e] === ":") {
      let d = e + 1;
      while (d < text.length && d - e <= 6 && isDigit(text[d])) d += 1;
      const digits = d - e - 1;
      let port = digits >= 2 && digits <= 5 && !isWordChar(text[d]);
      for (let k = e + 1; port && k < d; k += 1) if (inIPv4[k] === 1) port = false;
      if (port) {
        const from = hostStart(text.slice(i, e));
        if (from !== -1) spans.push([i + from, d]);
      }
    }
    i = e;
  }
  return spans;
}

/** The last label of a name on an internal network. */
const INTERNAL_TLDS = ["localdomain", "internal", "local", "home", "arpa", "lan"];

/** A run of host name characters, read whole from where it starts. */
const NAME_RUN_RE = /(?<![\w.-])(?=([\w.-]+))\1/g;

/**
 * How long the internal network's name that starts label is: the whole
 * label (lan), or the part before a hyphen (lan-2 holds lan); 0 when it
 * holds none.
 */
function internalLength(label: string): number {
  const lower = label.toLowerCase();
  for (const tld of INTERNAL_TLDS) {
    if (lower === tld || lower.startsWith(`${tld}-`)) return tld.length;
  }
  return 0;
}

/**
 * The internal host names in a run (server.lan, platehouse.home.arpa,
 * redis_cache.internal), as spans of text. The run is cut at each
 * underscore and at each empty label; in each chain of dotted labels left,
 * everything from the first label up to the end of the last internal
 * network's name that has a label before it is taken out.
 */
function internalNameSpans(run: string, offset: number): [number, number][] {
  const spans: [number, number][] = [];
  // Labels with their places in the run; an underscore ends a chain as an
  // empty label does.
  const labels: { start: number; text: string }[] = [];
  let start = 0;
  for (let i = 0; i <= run.length; i += 1) {
    const c = run[i];
    if (i === run.length || c === "." || c === "_") {
      labels.push({ start, text: run.slice(start, i) });
      if (c === "_") labels.push({ start: i, text: "" });
      start = i + 1;
    }
  }
  let i = 0;
  while (i < labels.length) {
    if ((labels[i] as { text: string }).text === "") {
      i += 1;
      continue;
    }
    let end = i;
    while (end < labels.length && (labels[end] as { text: string }).text !== "") end += 1;
    for (let k = end - 1; k > i; k -= 1) {
      const label = labels[k] as { start: number; text: string };
      const length = internalLength(label.text);
      if (length > 0) {
        const first = labels[i] as { start: number };
        spans.push([offset + first.start, offset + label.start + length]);
        break;
      }
    }
    i = end;
  }
  return spans;
}

/**
 * The network rule: addresses (addressSpans), host:port pairs, internal host
 * names and localhost, each found on the same text, and every span any of
 * them finds taken out, overlapping spans as one [address]. Found on the same
 * text, no rule's replacement hides from another the text it would have
 * taken: an address glued to a host name and port (nip.io203.0.113.9:8080)
 * is taken out with its host, as the host:port rule alone would take it.
 * Each finder is linear, and so is the merge.
 */
const NETWORK_RULE: Rule = (text) => {
  const spans: [number, number][] = [...addressSpans(text)];
  const inIPv4 = new Uint8Array(text.length + 1);
  for (const m of text.matchAll(REPLACED_IPV4)) inIPv4.fill(1, m.index, m.index + m[0].length);
  spans.push(...hostPortSpans(text, inIPv4));
  for (const m of text.matchAll(NAME_RUN_RE)) {
    spans.push(...internalNameSpans(m[1] as string, m.index));
  }
  for (const m of text.matchAll(/\blocalhost\b/gi)) spans.push([m.index, m.index + m[0].length]);
  spans.sort((x, y) => x[0] - y[0] || y[1] - x[1]);
  const edits: Edit[] = [];
  let start = -1;
  let end = -1;
  for (const [s, e] of spans) {
    if (s < end) {
      end = Math.max(end, e);
      continue;
    }
    if (start !== -1) edits.push([start, end, "[address]"]);
    start = s;
    end = e;
  }
  if (start !== -1) edits.push([start, end, "[address]"]);
  return edits;
};

/** scrubText's rules, in the order they run. */
const RULES: readonly Rule[] = [
  regexRule(/\bBearer\s+\S+/gi, () => ({ from: 0, text: "Bearer [redacted]" })),
  regexRule(/\bph_[A-Za-z0-9_-]{16,}/g, () => ({ from: 0, text: "[redacted]" })),
  regexRule(
    /\b(passwords?|passwd|secrets?|tokens?|api[_-]?keys?|access[_-]?keys?|credentials?)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    (m) => ({ from: (m[1] as string).length + (m[2] as string).length, text: "[redacted]" }),
  ),
  urlEdits,
  regexRule(/\b[A-Za-z]:\\[^\s"'<>)\]]*/g, () => ({ from: 0, text: "[path]" })),
  regexRule(/(^|[\s"'(=,[])~\/[^\s"'<>)\],]*/g, (m) => ({
    from: (m[1] as string).length,
    text: "[path]",
  })),
  regexRule(/(^|[\s"'(=,[])\/[^\s"'<>)\],]+/g, (m) => ({
    from: (m[1] as string).length,
    text: "[path]",
  })),
  NETWORK_RULE,
];

/**
 * The spans of text (before trimming and cutting) that scrubText replaces,
 * as [start, end) left to right. test/scrub.test.ts checks that they hold
 * every span the scrub before 0.1.0 replaced.
 */
export function scrubSpans(text: string): [number, number][] {
  return runRules(text, RULES, true).spans;
}

/**
 * Takes out of stored error text everything a user must not be shown:
 * tokens and credentials, URLs (signed ones included), file system paths,
 * IPv4 and IPv6 addresses (bare, or in brackets, with a zone or a port),
 * host:port pairs and internal host names. It never takes out less than the
 * scrub before 0.1.0 did: every span that one replaced lies inside a span
 * this one replaces. The words around them stay, so the message still
 * reads. Cut at SCRUB_MAX_CHARS characters (options.maxChars), keeping the
 * start with "..." after it, or with options.keep "end", keeping the end
 * with "..." before it. The work is linear in the text's length.
 */
export function scrubText(text: string, options: ScrubOptions = {}): string {
  const out = runRules(text, RULES).text.trim();
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
