import { describe, expect, it } from "vitest";
import { stripFormatChars as serverRule } from "../../server/src/format-chars.js";
import { stripFormatChars } from "../src/format-chars.js";

describe("the importer's format-character rule", () => {
  it("is the same rule as the server applies to stored names, for every code point", () => {
    for (let cp = 0; cp <= 0x10ffff; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const name = `a${String.fromCodePoint(cp)}b`;
      expect(stripFormatChars(name)).toBe(serverRule(name));
    }
  });

  it("removes U+200E but keeps the joiner and non-joiner", () => {
    const lrm = String.fromCodePoint(0x200e);
    const zwj = String.fromCodePoint(0x200d);
    expect(stripFormatChars(`a${lrm}b${zwj}c`)).toBe(`ab${zwj}c`);
  });
});
