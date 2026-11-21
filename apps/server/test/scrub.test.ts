// The one cleaning step for error text the app stored and shows to a user
// (src/scrub.ts; issue #239): Orca's failure detail on the model page, the
// Activity page and the Public API v1, OpenSCAD's or the STEP converter's
// message on the Activity page, the model page and the Public API v1 (issue
// #260; test/app-api/derived-message.test.ts), and the inbox reason on the
// Activity page.
//
// - scrubText: the stored text with any file system path, address, host
//   name or token taken out, keeping the words around them.
// - scrubDetail: scrubText for a column that may be null, null when nothing
//   is left to show.
// - scrubDerivedMessage: scrubDetail for OpenSCAD's or the STEP converter's
//   message, long enough for the whole stored message and keeping its end
//   when cut, since the program's error line is last.
//
// Every credential-shaped value here is made by the run, never written into
// this file.
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { describe, expect, test } from "vitest";
import {
  addressSpans,
  DERIVED_MESSAGE_MAX_CHARS,
  type Rule,
  regexRule,
  runRules,
  SCRUB_MAX_CHARS,
  scrubDerivedMessage,
  scrubDetail,
  scrubSpans,
  scrubText,
} from "../src/scrub.js";

/** A random value of n base64url characters, made by the run. */
function runValue(n: number): string {
  return randomBytes(n).toString("base64url").slice(0, n);
}

/** A token shaped like the app's own: ph_ and 43 base64url characters, made by the run. */
function runToken(): string {
  return ["ph", runValue(43)].join("_");
}

describe("scrubText", () => {
  test("keeps plain words as they are", () => {
    expect(scrubText("The slicer could not slice this plate.")).toBe(
      "The slicer could not slice this plate.",
    );
  });

  test("takes out absolute POSIX paths, keeping the words around them", () => {
    expect(
      scrubText('ERROR: Parser error in file "/tmp/render-x1/input.scad", line 3: syntax error'),
    ).toBe('ERROR: Parser error in file "[path]", line 3: syntax error');
    expect(scrubText("open /var/lib/platehouse/inbox/failed/a.3mf failed")).toBe(
      "open [path] failed",
    );
    expect(scrubText("/opt/orca/bin/orca-slicer exited with 139")).toBe("[path] exited with 139");
  });

  test("takes out home and Windows paths", () => {
    expect(scrubText("see ~/projects/x.scad")).toBe("see [path]");
    expect(scrubText("C:\\Users\\sam\\x.3mf is locked")).toBe("[path] is locked");
  });

  test("takes out URLs, signed or not", () => {
    const signature = runValue(24);
    expect(
      scrubText(`GET https://bucket.example.com/models/a/b?X-Amz-Signature=${signature} failed`),
    ).toBe("GET [address] failed");
    expect(scrubText("connect to http://slicer:8080/v1/slice")).toBe("connect to [address]");
  });

  test("takes out IP addresses and host:port pairs", () => {
    expect(scrubText("connect ECONNREFUSED 10.0.0.5:5432")).toBe("connect ECONNREFUSED [address]");
    expect(scrubText("no answer from slicer:8080")).toBe("no answer from [address]");
    expect(scrubText("db at platehouse-db:5432 refused")).toBe("db at [address] refused");
  });

  // IPv6 addresses (documentation and link-local ranges only), bare or in
  // brackets, with or without a port or a zone: none of it is left behind.
  test("takes out IPv6 addresses, bare or bracketed, with or without a port", () => {
    expect(scrubText("connect ECONNREFUSED 2001:db8::5:8000")).toBe(
      "connect ECONNREFUSED [address]",
    );
    expect(scrubText("connect ECONNREFUSED 2001:db8:3456::7:9000")).toBe(
      "connect ECONNREFUSED [address]",
    );
    expect(scrubText("connect ECONNREFUSED 2001:db8::7:50051")).toBe(
      "connect ECONNREFUSED [address]",
    );
    expect(scrubText("connect ECONNREFUSED ::1:3000")).toBe("connect ECONNREFUSED [address]");
    expect(scrubText("no route to 2001:db8:0:0:0:0:0:1 now")).toBe("no route to [address] now");
    expect(scrubText("no route to 2001:db8::1.")).toBe("no route to [address].");
    expect(scrubText("peer fe80::1%eth0 left")).toBe("peer [address] left");
    expect(scrubText("peer ::ffff:192.0.2.7 left")).toBe("peer [address] left");
    expect(scrubText("dial [fe80::1%eth0]:8080 failed")).toBe("dial [address] failed");
    expect(scrubText("dial [2001:db8::1] failed")).toBe("dial [address] failed");
    expect(scrubText("GET http://[2001:db8::1]:8080/v1/slice failed")).toBe("GET [address] failed");
  });

  // Straight after a word and a colon, with no space, the whole address
  // goes, as an IPv4 address does (peer:192.0.2.7), not just its first group.
  // When the address starts with two to five digits and a colon, the word
  // goes too: the scrub before 0.1.0 took peer:2001 out as a host and port,
  // and scrubText never takes out less than it did (issue #353).
  test("takes out an IPv6 address written straight after a word and a colon", () => {
    expect(scrubText("peer:2001:db8::1 left")).toBe("[address] left");
    expect(scrubText("peer:fe80::1%eth0 left")).toBe("peer:[address] left");
    expect(scrubText("dial tcp:2001:db8::7:8080 failed")).toBe("dial [address] failed");
    expect(scrubText("peer:192.0.2.7 left")).toBe("peer:[address] left");
  });

  // Issue #345: whatever comes before the colon (a word with digits, a
  // hyphen, an interface name), the address after it goes whole. The scan
  // takes the longest address from the first place one can start, so when
  // the end of the label is itself part of a valid address (the "1:" of
  // 1:2001:db8::1, the "0:" of 0:fe80::1), it goes too: more is taken out,
  // never less. A label before "2001:" goes whole, as the scrub before
  // 0.1.0 took node-1:2001 out as a host and port (issue #353).
  test("takes out an address after any label and a colon", () => {
    expect(scrubText("node-1:2001:db8::1 left")).toBe("[address] left");
    expect(scrubText("slicer1:2001:db8::1 left")).toBe("[address] left");
    expect(scrubText("eth0:fe80::1 up")).toBe("eth[address] up");
    for (const shown of [
      scrubText("node-1:2001:db8::1"),
      scrubText("slicer1:2001:db8::1"),
      scrubText("eth0:fe80::1"),
    ]) {
      expect(shown).not.toMatch(/db8|fe80|::1/);
    }
  });

  // One table, IPv4 and IPv6 through the same path: each input and what is shown.
  test.each([
    ["connect ECONNREFUSED 192.0.2.7:5432", "connect ECONNREFUSED [address]"],
    ["connect ECONNREFUSED 192.0.2.7", "connect ECONNREFUSED [address]"],
    ["host-192.0.2.7 refused", "host-[address] refused"],
    ["peer_2001:db8::1 left", "peer_[address] left"],
    // node:2001 is a host and port, as the scrub before 0.1.0 took it.
    ["eth0:node:2001:db8::1", "eth0:[address]"],
    // Issue #353: a host joined to a word with '_' goes whole.
    ["connect my_app-db:5432 refused", "connect [address] refused"],
    ["connect app_v2.db.example:5432 refused", "connect [address] refused"],
    ["connect redis_cache.internal:6379 refused", "connect [address] refused"],
    ["reach a-b.lan-2 now", "reach [address]-2 now"],
    ["a:b:2001:db8::1", "[address]"],
    ["backup 192.0.2.7-old", "backup [address]-old"],
    ["at 192.0.2.7:5432.", "at [address]."],
    ["slicer:8080 and db.internal:5432", "[address] and [address]"],
    ["x.server.lan.example.com", "[address].example.com"],
    ["see https://[2001:db8::1]:8080/v1 now", "see [address] now"],
    ["x9:y8:192.0.2.7:80 failed", "x9:y8:[address] failed"],
    ["at [2001:db8::1]:443.", "at [address]."],
    ["at fe80::1%en0.", "at [address]."],
    ["(2001:db8::1)", "([address])"],
    ["'2001:db8::1'", "'[address]'"],
    ["2001:db8::1, 192.0.2.7 and ::1", "[address], [address] and [address]"],
    ["link:[fe80::1%eth0]:8080 lost", "link:[address] lost"],
    ["::ffff:192.0.2.7", "[address]"],
    ["dial [192.0.2.7]:8080 failed", "dial [address] failed"],
    ["peer [10.0.0.5] left", "peer [address] left"],
    ["[WARN]10.0.0.5 unreachable", "[WARN][address] unreachable"],
    ["failed.10.0.0.5", "failed.[address]"],
    ["dial [10.0.0.5 failed", "dial [[address] failed"],
    ["version 2.5.0 at 12:34:56", "version 2.5.0 at 12:34:56"],
    ["plates [1:2] and [3:4]", "plates [1:2] and [3:4]"],
    ["Slic3r::GCode failed", "Slic3r::GCode failed"],
    ["Add::Feed and Bed::Face", "Add::Feed and Bed::Face"],
    ["ratio 16:9 at 1:2:3", "ratio 16:9 at 1:2:3"],
    ["build 2026.11.0.1", "build 2026.11.0.1"],
  ])("%j is shown as %j", (input, shown) => {
    expect(scrubText(input)).toBe(shown);
  });

  // A long message must take time in proportion to its length, never its
  // square: most of these inputs are single long runs of address characters,
  // the worst case for a scan that tries every start. Each takes well under
  // a second; a scan that went back over the run from every start took tens
  // of seconds at this size, so the 2-second limit only fails on that.
  test.each([
    ["colons and digits", "1:".repeat(100_000)],
    ["double colons", "1::".repeat(66_000)],
    ["hex groups", "abcd:".repeat(40_000)],
    ["addresses", "2001:db8::1 192.0.2.7:80 ".repeat(8_000)],
    ["dots and digits", "1.".repeat(100_000)],
    ["letters and hyphens", "a-".repeat(100_000)],
    ["letters and dots", "a.".repeat(100_000)],
    ["one long word", "a".repeat(200_000)],
    ["labels and colons", "eth0:".repeat(40_000)],
    ["brackets", "[1:".repeat(70_000)],
    ["words and spaces", "word 1:2 ".repeat(25_000)],
  ])("a 200,000-character message of %s is cleaned quickly", (_what, input) => {
    expect(input.length).toBeGreaterThanOrEqual(190_000);
    const started = performance.now();
    scrubText(input);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("leaves times, ratios, ranges and C++ names that look a little like IPv6 alone", () => {
    expect(scrubText("started 12:30:45, layers [1:2]")).toBe("started 12:30:45, layers [1:2]");
    expect(scrubText("Slic3r::GCode::process_layer failed")).toBe(
      "Slic3r::GCode::process_layer failed",
    );
    expect(scrubText("std::bad_alloc in Model::add")).toBe("std::bad_alloc in Model::add");
  });

  test("takes out internal host names", () => {
    expect(scrubText("could not reach platehouse.home.arpa")).toBe("could not reach [address]");
    expect(scrubText("server.lan is down")).toBe("[address] is down");
  });

  test("takes out tokens and credentials", () => {
    const token = runToken();
    expect(scrubText(`token ${token} refused`)).toBe("token [redacted] refused");
    expect(scrubText(`Authorization: Bearer ${runValue(20)}`)).toBe(
      "Authorization: Bearer [redacted]",
    );
    const key = ["pass", "word"].join("");
    expect(scrubText(`${key}=${runValue(12)} rejected`)).toBe(`${key}=[redacted] rejected`);
  });

  test("leaves a fraction, a ratio and a time alone", () => {
    expect(scrubText("plate 1/2 at 12:30, ratio 3:4")).toBe("plate 1/2 at 12:30, ratio 3:4");
  });

  test("cuts very long text", () => {
    const out = scrubText("x".repeat(5000));
    expect(out.length).toBeLessThanOrEqual(1003);
    expect(out.endsWith("...")).toBe(true);
  });
});

describe("scrubDerivedMessage", () => {
  test("is null for no message, and cleans a short one as scrubDetail does", () => {
    expect(scrubDerivedMessage(null)).toBeNull();
    expect(scrubDerivedMessage("  ")).toBeNull();
    expect(
      scrubDerivedMessage('ERROR: Parser error in file "/tmp/render-x1/input.scad", line 3'),
    ).toBe('ERROR: Parser error in file "[path]", line 3');
  });

  test("shows a whole stored message, the previous-renders sentence and a 2000-character tail together, uncut", () => {
    const message = `${"S".repeat(200)} ${"t".repeat(2000)}`;
    expect(message.length).toBeLessThanOrEqual(DERIVED_MESSAGE_MAX_CHARS);
    expect(scrubDerivedMessage(message)).toBe(message);
  });

  test("keeps the end of a message too long to show, where the program's error line is", () => {
    const message = `${"early output\n".repeat(400)}ERROR: the last line`;
    const out = scrubDerivedMessage(message);
    expect(out?.startsWith("...")).toBe(true);
    expect(out?.endsWith("ERROR: the last line")).toBe(true);
    expect(out?.length).toBeLessThanOrEqual(DERIVED_MESSAGE_MAX_CHARS + 3);
  });
});

describe("scrubDetail", () => {
  test("is null for no detail, and for a detail with nothing left to show", () => {
    expect(scrubDetail(null)).toBeNull();
    expect(scrubDetail("")).toBeNull();
    expect(scrubDetail("   ")).toBeNull();
  });

  test("keeps a detail that is all path as the placeholder, so the page still says there was one", () => {
    expect(scrubDetail("/work/job-1/input.3mf")).toBe("[path]");
  });

  test("cleans an Orca failure detail of its work path, host path, slicer URL, address and token, keeping the message", () => {
    const token = runToken();
    const detail =
      "Orca exited with -3 slicing /work/job-0198f0c4-7a1e/input.3mf " +
      "(profiles under /srv/platehouse/orca/BBL) via http://slicer:8080/v1/slice " +
      `at 192.0.2.10 with token ${token}: the object exceeds the plate`;
    const out = scrubDetail(detail);
    expect(out).toBe(
      "Orca exited with -3 slicing [path] (profiles under [path]) via [address] " +
        "at [address] with token [redacted]: the object exceeds the plate",
    );
    for (const secret of [
      "/work/",
      "input.3mf",
      "/srv/",
      "http://",
      "slicer:8080",
      "192.0.2.10",
      token,
    ]) {
      expect(out).not.toContain(secret);
    }
  });
});

// The address scrub is checked against its invariant, not only examples.
// Every round of review used to find one more character next to an address
// that hid it, so these tests state the property and try it on many
// generated messages. On any text, scrubText's output holds:
//
// (a) every span the IPv4 pattern the scan replaced took out lies inside a
//     span the scan takes out, so it never takes out less than that regex
//     did; checked on the scan's own spans (addressSpans) of the text, and
//     on scrubText's output, which holds no match of the pattern;
// (b) no IPv6 address s (net.isIP(s) === 6, holding a digit and at least two
//     colons) whose neighbours, where there are any, are not hex digits,
//     ':' or '.'; checked by brute force over every start and every end up
//     to 64 characters;
// (c) the text that only looks like an address (times, ranges, C++ names,
//     versions, hashes) comes out unchanged.

/** The IPv4 pattern scrub.ts used before the address scan. */
const OLD_IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/;

/** (a): the first match of the old IPv4 pattern left in text, if any. */
function leftoverIPv4(text: string): string | undefined {
  return OLD_IPV4.exec(text)?.[0];
}

/**
 * (a), on the scan's spans: the first span the old IPv4 pattern took out of
 * text (every match, as its global replace found them) that no span in
 * spans holds whole, if any.
 */
function uncoveredIPv4(
  text: string,
  spans: readonly (readonly [number, number])[],
): string | undefined {
  for (const m of text.matchAll(new RegExp(OLD_IPV4.source, "g"))) {
    const start = m.index;
    const end = start + m[0].length;
    if (!spans.some(([s, e]) => s <= start && end <= e)) return m[0];
  }
  return undefined;
}

/** A character an IPv6 address may run on into: a hex digit, ':' or '.'. */
function joins(c: string | undefined): boolean {
  return c !== undefined && /[0-9A-Fa-f:.]/.test(c);
}

/**
 * (b), by brute force: the first IPv6 address left in text, if any. Every
 * start and every end up to 64 characters is tried. It is slow, which is
 * fine here. Substrings with fewer than two colons or no digit are skipped
 * before isIP, since (b) does not count them anyway.
 */
function leftoverIPv6(text: string): string | undefined {
  for (let start = 0; start < text.length; start += 1) {
    if (joins(text[start - 1])) continue;
    let colons = 0;
    let digit = false;
    for (let end = start + 1; end <= Math.min(text.length, start + 64); end += 1) {
      const c = text[end - 1] as string;
      if (c === ":") colons += 1;
      else if (c >= "0" && c <= "9") digit = true;
      if (colons < 2 || !digit || joins(text[end])) continue;
      const s = text.slice(start, end);
      if (isIP(s) === 6) return s;
    }
  }
  return undefined;
}

/** (c): text that only looks like an address, which must come out unchanged. */
const LOOKALIKES = [
  "at 12:34:56",
  "times 01:02:03 and 23:59:59",
  "plates [1:2] and [3:4]",
  "Slic3r::GCode failed",
  "Add::Feed and Bed::Face",
  "std::bad_alloc in Model::add",
  "ratio 16:9 at 1:2:3",
  "version 2.5.0",
  "build 2026.11.0.1",
  "OrcaSlicer 2.3.1-beta",
  "sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "commit f1c966c4e60f30b244d382a5befca884336ca510",
];

/** Addresses from documentation and link-local ranges, in every form the scrub takes out. */
const ADDRESSES = [
  "10.0.0.5",
  "192.0.2.7",
  "198.51.100.23:8080",
  "203.0.113.9:65535",
  "999.1.2.3",
  "2001:db8::1",
  "2001:db8:0:0:0:0:0:1",
  "2001:db8::7:8080",
  "::1",
  "::ffff:192.0.2.7",
  "fe80::1%eth0",
  "fe80::a:b%en0",
  "[2001:db8::1]",
  "[2001:db8::1]:443",
  "[fe80::1%en0]:8080",
  "[192.0.2.7]",
  "[10.0.0.5]:5432",
];

/** What may sit straight before or after an address; "" is the start or end of the text. */
const NEIGHBOURS = [
  "",
  "g",
  "x",
  "Z",
  "a",
  "F",
  "abc",
  "Retrying",
  "nip.io",
  ".nip.io",
  ".Retrying",
  // Hex groups that can run on into an address: they make a longer address
  // that ends inside an IPv4 one (1:2:3:4:5:6:7:10 of 1:2:3:4:5:6:7:10.0.0.5).
  "1:2:3:4:5:6:7:",
  "a::b:c:d:e:f:",
  "[::1]:",
  "7",
  ".",
  "]",
  "[",
  "%",
  ":",
  "-",
  "_",
  "/",
  "@",
  "=",
  '"',
  "'",
  "中",
  "\u{1f600}",
  " ",
];

/** A small seeded generator (mulberry32), so every run tries the same messages. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)] as T;
}

/**
 * A message: a look-alike, a space, one or two addresses each between
 * neighbours (one to three on a side), a space and another look-alike.
 */
function message(random: () => number): { text: string; before: string; after: string } {
  const side = () => {
    const r = random();
    const count = r < 0.15 ? 3 : r < 0.5 ? 2 : 1;
    let s = "";
    for (let k = 0; k < count; k += 1) s += pick(random, NEIGHBOURS);
    return s;
  };
  let core = side() + pick(random, ADDRESSES) + side();
  if (random() < 0.4) core += pick(random, ADDRESSES) + side();
  const before = pick(random, LOOKALIKES);
  const after = pick(random, LOOKALIKES);
  return { text: `${before} ${core} ${after}`, before, after };
}

/** What is wrong with scrubText's output for text, or undefined when (a) and (b) hold. */
function brokenBy(text: string): string | undefined {
  const cut = uncoveredIPv4(text, addressSpans(text));
  if (cut !== undefined) return `${JSON.stringify(text)}: the scan cuts into ${cut}`;
  const out = scrubText(text);
  const v4 = leftoverIPv4(out);
  if (v4 !== undefined) return `${JSON.stringify(text)} -> ${JSON.stringify(out)} keeps ${v4}`;
  const v6 = leftoverIPv6(out);
  if (v6 !== undefined) return `${JSON.stringify(text)} -> ${JSON.stringify(out)} keeps ${v6}`;
  return undefined;
}

describe("the address scrub's invariant", () => {
  test("the oracle finds what it should: it is not a test that passes on anything", () => {
    expect(leftoverIPv4("reach 10.0.0.5.nip.io")).toBe("10.0.0.5");
    expect(leftoverIPv4("build 2026.11.0.1")).toBeUndefined();
    expect(leftoverIPv6("peer g2001:db8::1 left")).toBe("2001:db8::1");
    // "%" is not hex, ":" or ".", so the address before the zone counts on its own.
    expect(leftoverIPv6("at fe80::1%eth0.")).toBe("fe80::1");
    expect(leftoverIPv6("at [fe80::1]")).toBe("fe80::1");
    expect(leftoverIPv6("Add::Feed and 12:34:56")).toBeUndefined();
    expect(leftoverIPv6("[address]")).toBeUndefined();
    // A span that ends inside the old match does not hold it; one that starts before and ends after does.
    expect(uncoveredIPv4("x:10.0.0.5", [[0, 4]])).toBe("10.0.0.5");
    expect(uncoveredIPv4("x:10.0.0.5", [[0, 10]])).toBeUndefined();
    expect(uncoveredIPv4("x 10.0.0.5 and 192.0.2.7", [[2, 10]])).toBe("192.0.2.7");
  });

  test.each(LOOKALIKES)("(c) %j comes out unchanged", (text) => {
    expect(scrubText(text)).toBe(text);
  });

  // The examples earlier review rounds found, kept by name.
  test.each([
    ["round 1: an IPv4 address in brackets", "dial [192.0.2.7] failed", "dial [address] failed"],
    [
      "round 1: after a closing bracket",
      "[WARN]10.0.0.5 unreachable",
      "[WARN][address] unreachable",
    ],
    ["round 1: after a full stop", "failed.10.0.0.5", "failed.[address]"],
    ["round 2 (#351): before a host name", "reach 10.0.0.5.nip.io", "reach [address].nip.io"],
    ["round 2 (#351): before a word", "reach 10.0.0.5.Retrying", "reach [address].Retrying"],
    ["round 2 (#351): a bracket then letters", "[10.0.0.5]abc", "[address]abc"],
    ["round 3: seven hex groups before an IPv4 address", "1:2:3:4:5:6:7:10.0.0.5", "1:[address]"],
    ["round 3: '::' and six groups before one", "a::b:c:d:e:f:10.0.0.5", "a::b:c:d:e:f:[address]"],
    [
      "round 3: a bracketed address and a colon before one",
      "peer [::1]:1.2.3.4 left",
      "peer [address]:[address] left",
    ],
  ])("%s: %j is shown as %j", (_round, input, shown) => {
    expect(scrubText(input)).toBe(shown);
    expect(brokenBy(input)).toBeUndefined();
  });

  // A known limit, kept as the CHANGELOG states it: an address may not start
  // straight after a hex digit, so one written straight after a letter A to
  // F or a digit is not taken out whole. The replaced IPv4 pattern did not
  // take a10.0.0.5 out either (no word boundary before its "1").
  test("an address straight after a hex digit is not taken out whole", () => {
    expect(scrubText("a10.0.0.5")).toBe("a10.0.0.5");
    expect(leftoverIPv4("a10.0.0.5")).toBeUndefined();
    expect(scrubText("f2001:db8::1")).toBe("f2001:[address]");
  });

  test("(a), (b) and (c) hold for 3000 generated messages", () => {
    const random = seeded(0x5c2b);
    const broken: string[] = [];
    for (let i = 0; i < 3000; i += 1) {
      const { text, before, after } = message(random);
      const problem = brokenBy(text);
      if (problem !== undefined) broken.push(problem);
      const out = scrubText(text);
      if (!out.startsWith(`${before} `) || !out.endsWith(` ${after}`)) {
        broken.push(`${JSON.stringify(text)} -> ${JSON.stringify(out)} changed a look-alike`);
      }
    }
    expect(broken.length, broken.slice(0, 20).join("\n")).toBe(0);
  });
});

// The whole scrub, checked against the one it replaced. Each round of review
// found one more rule that took out less than before, so this states the
// promise for every rule at once: on any text, every span the scrub before
// 0.1.0 replaced lies inside a span scrubText replaces (scrubSpans). It is
// checked on the named cases below and on thousands of generated messages
// holding addresses, host:port pairs, URLs and internal host names next to
// every kind of neighbour.

/**
 * TEST ORACLE. A verbatim copy of scrubText from release/v0.1.0 at 68c02f6,
 * before this release changed it. Never edit it: it is the reference the
 * differential tests measure the current scrub against, so changing it would
 * change what they prove. Some of its patterns are quadratic on long runs, so
 * it only ever runs on short inputs (ORACLE_MAX_CHARS).
 */
function oldScrubText(
  text: string,
  options: { maxChars?: number; keep?: "start" | "end" } = {},
): string {
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

/** The longest input the oracle is run on, so its quadratic patterns stay quick. */
const ORACLE_MAX_CHARS = 2_000;

/**
 * The oracle's replacements as rules, with the same patterns in the same
 * order, so runRules can say which spans of the input each one replaced. A
 * replacement that keeps the start of its match ("$1[path]", a credential's
 * key) starts its span after what it keeps. oldSpansOf checks that these
 * rules give exactly the oracle's output, so they cannot drift from it.
 */
const OLD_RULES: readonly Rule[] = [
  regexRule(/\bBearer\s+\S+/gi, () => ({ from: 0, text: "Bearer [redacted]" })),
  regexRule(/\bph_[A-Za-z0-9_-]{16,}/g, () => ({ from: 0, text: "[redacted]" })),
  regexRule(
    /\b(passwords?|passwd|secrets?|tokens?|api[_-]?keys?|access[_-]?keys?|credentials?)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
    (m) => ({ from: (m[1] as string).length + (m[2] as string).length, text: "[redacted]" }),
  ),
  regexRule(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi, () => ({ from: 0, text: "[address]" })),
  regexRule(/\b[A-Za-z]:\\[^\s"'<>)\]]*/g, () => ({ from: 0, text: "[path]" })),
  regexRule(/(^|[\s"'(=,[])~\/[^\s"'<>)\],]*/g, (m) => ({
    from: (m[1] as string).length,
    text: "[path]",
  })),
  regexRule(/(^|[\s"'(=,[])\/[^\s"'<>)\],]+/g, (m) => ({
    from: (m[1] as string).length,
    text: "[path]",
  })),
  regexRule(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g, () => ({ from: 0, text: "[address]" })),
  regexRule(/\b(?=[A-Za-z0-9.-]*[A-Za-z])[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*:\d{2,5}\b/g, () => ({
    from: 0,
    text: "[address]",
  })),
  regexRule(/\b(?:[A-Za-z0-9-]+\.)+(?:local|lan|internal|home|arpa|localdomain)\b/gi, () => ({
    from: 0,
    text: "[address]",
  })),
  regexRule(/\blocalhost\b/gi, () => ({ from: 0, text: "[address]" })),
];

/** The spans of text the oracle replaced, after checking OLD_RULES give its output exactly. */
function oldSpansOf(text: string): [number, number][] {
  const { text: out, spans } = runRules(text, OLD_RULES, true);
  expect(out.trim(), JSON.stringify(text)).toBe(
    oldScrubText(text, { maxChars: Number.POSITIVE_INFINITY }),
  );
  return spans;
}

/**
 * The differential check: the first span of text the oracle replaced that no
 * span scrubText replaces holds whole, with both outputs, or undefined when
 * scrubText takes out everything the oracle did.
 */
function takesOutLess(text: string): string | undefined {
  if (text.length > ORACLE_MAX_CHARS) throw new Error("too long for the oracle");
  const now = scrubSpans(text);
  for (const [s, e] of oldSpansOf(text)) {
    if (!now.some(([ns, ne]) => ns <= s && e <= ne)) {
      return (
        `${JSON.stringify(text)}: the old scrub took out ${JSON.stringify(text.slice(s, e))}; ` +
        `old ${JSON.stringify(oldScrubText(text))}, now ${JSON.stringify(scrubText(text))}`
      );
    }
  }
  return undefined;
}

/** Host:port pairs, URLs and internal host names, every one synthetic. */
const HOST_PORTS = [
  "slicer:8080",
  "platehouse-db:5432",
  "db.internal:5432",
  "my_app-db:5432",
  "app_v2.db.example:5432",
  "redis_cache.internal:6379",
  "a.b.c:80",
  "x1:65535",
  "localhost:3000",
  "box-2.example.net:443",
];
const URLS = [
  "http://slicer:8080/v1/slice",
  "https://bucket.example.com/models/a/b?X-Amz-Signature=abc",
  "s3+https://store.example/x",
  "http://[2001:db8::1]:8080/v1",
  "ftp://files.example.org",
  "HTTP://UPPER.EXAMPLE/",
];
const INTERNAL_NAMES = [
  "server.lan",
  "platehouse.home.arpa",
  "nas.local",
  "db.internal",
  "box.localdomain",
  "my_host.lan",
  "a-b.lan-2",
  "x.local.example",
  "localhost",
];

/** Neighbours for every kind: word characters, '_', '-', '.', digits, punctuation and CJK. */
const ALL_NEIGHBOURS = [
  ...NEIGHBOURS,
  "_db",
  "app_",
  "my_",
  "_",
  "__",
  "x-",
  "-y",
  "9",
  "v2.",
  ".io",
  ",",
  ";",
  "(",
  ")",
  "!",
  "?",
  "#",
  "+",
  "*",
  "\\",
  "\t",
  "日本",
  "é",
];

/** A message for the differential check: one or two items of any kind, each between neighbours. */
function mixedMessage(random: () => number): string {
  const kinds = [ADDRESSES, HOST_PORTS, URLS, INTERNAL_NAMES];
  const side = () => {
    const r = random();
    const count = r < 0.15 ? 3 : r < 0.5 ? 2 : 1;
    let s = "";
    for (let k = 0; k < count; k += 1) s += pick(random, ALL_NEIGHBOURS);
    return s;
  };
  let core = side() + pick(random, pick(random, kinds)) + side();
  if (random() < 0.4) core += pick(random, pick(random, kinds)) + side();
  return `${pick(random, LOOKALIKES)} ${core} ${pick(random, LOOKALIKES)}`;
}

/** The named inputs the differential check runs on, beside the generated ones. */
const NAMED_DIFFERENTIAL = [
  // Issue #353: a host joined to a word with '_'.
  "connect my_app-db:5432 refused",
  "connect app_v2.db.example:5432 refused",
  "connect redis_cache.internal:6379 refused",
  ...LOOKALIKES,
  ...ADDRESSES.map((a) => `reach ${a} now`),
  ...HOST_PORTS.map((h) => `reach ${h} now`),
  ...URLS.map((u) => `GET ${u} failed`),
  ...INTERNAL_NAMES.map((n) => `reach ${n} now`),
  "dial [192.0.2.7] failed",
  "[WARN]10.0.0.5 unreachable",
  "failed.10.0.0.5",
  "reach 10.0.0.5.nip.io",
  "1:2:3:4:5:6:7:10.0.0.5",
  "peer [::1]:1.2.3.4 left",
  "Orca exited slicing /tmp/work/a.3mf via http://slicer:8080 token=abc",
  "Authorization: Bearer abc.def",
  "C:\\Users\\someone\\file.3mf and ~/models/x.stl",
];

describe("the whole scrub never takes out less than the scrub before 0.1.0", () => {
  test("the oracle's spans are the old scrub's, and the check finds what it should", () => {
    expect(oldScrubText("connect my_app-db:5432 refused")).toBe("connect my_app[address] refused");
    expect(oldSpansOf("connect my_app-db:5432 refused")).toEqual([[14, 22]]);
    expect(oldSpansOf("a ~/x b")).toEqual([[2, 5]]);
    expect(oldSpansOf("token=abc")).toEqual([[6, 9]]);
    expect(runRules("ab", [regexRule(/b/g, () => ({ from: 0, text: "[x]" }))], true).spans).toEqual(
      [[1, 2]],
    );
    // A replacement of a replacement spans everything both replaced.
    const twice = [
      regexRule(/b/g, () => ({ from: 0, text: "[x]" })),
      regexRule(/a\[x\]c/g, () => ({ from: 0, text: "[y]" })),
    ];
    expect(runRules("abc", twice, true)).toEqual({ text: "[y]", spans: [[0, 3]] });
  });

  test.each(NAMED_DIFFERENTIAL)("%j", (text) => {
    expect(takesOutLess(text)).toBeUndefined();
  });

  test("holds for 6000 generated messages of every kind", () => {
    const random = seeded(0x353);
    const broken: string[] = [];
    for (let i = 0; i < 6000; i += 1) {
      const text = mixedMessage(random);
      const problem = takesOutLess(text);
      if (problem !== undefined) broken.push(problem);
    }
    expect(broken.length, broken.slice(0, 20).join("\n")).toBe(0);
  });

  test("holds for the address invariant's 3000 generated messages", () => {
    const random = seeded(0x5c2b);
    const broken: string[] = [];
    for (let i = 0; i < 3000; i += 1) {
      const problem = takesOutLess(message(random).text);
      if (problem !== undefined) broken.push(problem);
    }
    expect(broken.length, broken.slice(0, 20).join("\n")).toBe(0);
  });
});
