// The redactor every printed line goes through (AC-003), and the cleaning of
// text that came from Manyfold.
import { describe, expect, it } from "vitest";
import { cleanText, createRedactor, REDACTED } from "../src/redact.js";

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
    expect(cleanText("abc‮def⁦g⁩")).toBe("abcdefg");
  });

  it("keeps ordinary text, accents and emoji", () => {
    expect(cleanText("Café über \u{1F600} 3D-Druck")).toBe("Café über \u{1F600} 3D-Druck");
  });
});
