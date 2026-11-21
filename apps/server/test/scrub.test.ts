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
import { describe, expect, test } from "vitest";
import {
  DERIVED_MESSAGE_MAX_CHARS,
  scrubDerivedMessage,
  scrubDetail,
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
  test("takes out an IPv6 address written straight after a word and a colon", () => {
    expect(scrubText("peer:2001:db8::1 left")).toBe("peer:[address] left");
    expect(scrubText("peer:fe80::1%eth0 left")).toBe("peer:[address] left");
    expect(scrubText("dial tcp:2001:db8::7:8080 failed")).toBe("dial tcp:[address] failed");
    expect(scrubText("peer:192.0.2.7 left")).toBe("peer:[address] left");
  });

  // Issue #345: whatever comes before the colon (a word with digits, a
  // hyphen, an interface name), the address after it goes whole. In
  // node-1:2001:db8::1 the "1:" is itself part of a valid address
  // (1:2001:db8::1), so it goes too: more is taken out, never less.
  test("takes out an address after any label and a colon", () => {
    expect(scrubText("node-1:2001:db8::1 left")).toBe("node-[address] left");
    expect(scrubText("slicer1:2001:db8::1 left")).toBe("slicer1:[address] left");
    expect(scrubText("eth0:fe80::1 up")).toBe("eth0:[address] up");
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
    ["eth0:node:2001:db8::1", "eth0:node:[address]"],
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
