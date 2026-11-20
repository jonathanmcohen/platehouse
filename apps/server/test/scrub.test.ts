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
    expect(scrubText("C:\\Users\\jon\\x.3mf is locked")).toBe("[path] is locked");
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
