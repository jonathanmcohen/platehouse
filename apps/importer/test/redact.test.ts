// The redactor every printed line goes through (AC-003), and the cleaning of
// text that came from Manyfold.
import { describe, expect, it } from "vitest";
import { cleanText, createRedactor, quoteBody, REDACTED } from "../src/redact.js";

describe("createRedactor", () => {
  it("replaces every occurrence of each secret", () => {
    const r = createRedactor(["alpha-123", "beta-456"]);
    expect(r.redact("a alpha-123 b beta-456 c alpha-123")).toBe(
      `a ${REDACTED} b ${REDACTED} c ${REDACTED}`,
    );
  });

  it("replaces a secret's URL-encoded form too", () => {
    const r = createRedactor(["a/b+c=d"]);
    expect(r.redact(`x=${encodeURIComponent("a/b+c=d")}`)).toBe(`x=${REDACTED}`);
  });

  it("takes secrets added later, such as a token or a signed query", () => {
    const r = createRedactor([]);
    r.add("sig=0011aabb");
    expect(r.redact("GET host/path?sig=0011aabb")).toBe(`GET host/path?${REDACTED}`);
  });

  it("replaces the longer of two overlapping secrets whole", () => {
    const r = createRedactor(["abc", "abcdef"]);
    expect(r.redact("abcdef")).toBe(REDACTED);
  });

  it("replaces a secret registered with padding when it is echoed trimmed, padded or cleaned", () => {
    const pads = ["\n", "\r\n", "\t", " ", " \n"];
    for (const pad of pads) {
      for (const registered of [`tok-123456${pad}`, `${pad}tok-123456`, `${pad}tok-123456${pad}`]) {
        const r = createRedactor([registered]);
        for (const echoed of [
          "tok-123456",
          `tok-123456${pad}`,
          `${pad}tok-123456`,
          cleanText(registered),
          encodeURIComponent("tok-123456"),
        ]) {
          expect(r.redact(`x ${echoed} y`), JSON.stringify([registered, echoed])).not.toContain(
            "tok-123456",
          );
        }
      }
    }
  });

  it("ignores a value that is only whitespace or control characters instead of matching everything", () => {
    const r = createRedactor([" ", "\n", "\t \r\n"]);
    expect(r.redact("nothing secret here")).toBe("nothing secret here");
  });

  it("ignores empty and missing values instead of matching everything", () => {
    const r = createRedactor(["", undefined]);
    r.add("");
    r.add(undefined);
    expect(r.redact("nothing secret here")).toBe("nothing secret here");
  });
});

describe("cleanText", () => {
  it("removes control characters", () => {
    expect(cleanText("a\u001b[2Jb\u0007c\u0000d\u009be")).toBe("a[2Jbcde");
  });

  it("removes newlines and tabs, so one value stays one line", () => {
    expect(cleanText("one\ntwo\r\tthree")).toBe("onetwothree");
  });

  it("removes bidi overrides and isolates", () => {
    const rlo = String.fromCodePoint(0x202e);
    const lri = String.fromCodePoint(0x2066);
    const pdi = String.fromCodePoint(0x2069);
    expect(cleanText(`abc${rlo}def${lri}g${pdi}`)).toBe("abcdefg");
  });

  it("keeps ordinary text, accents and emoji", () => {
    const text = `Caf${String.fromCodePoint(0xe9)} ${String.fromCodePoint(0xfc)}ber ${String.fromCodePoint(0x1f600)} 3D-Druck`;
    expect(cleanText(text)).toBe(text);
  });
});

describe("quoteBody", () => {
  const r = createRedactor(["abcdefghijkl"]);

  it("redacts a secret split by a newline, tab, CR, VT or FF", () => {
    for (const ws of ["\n", "\t", "\r", "\u000b", "\u000c", "\r\n"]) {
      expect(quoteBody(`xx abcdef${ws}ghijkl`, r.redact, 200)).toBe(`xx ${REDACTED}`);
    }
  });

  it("puts the quote on one line, with ordinary space runs made one space", () => {
    expect(quoteBody("  a   b\u00a0\u00a0c  ", r.redact, 200)).toBe("a b c");
  });

  it("redacts before it cuts, so a secret across the limit is not printed in part", () => {
    expect(quoteBody(`${"x".repeat(195)}abcdefghijkl`, r.redact, 200)).toBe(
      `${"x".repeat(195)}${REDACTED.slice(0, 5)}`,
    );
  });
});
