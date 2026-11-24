import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FORMAT_CHARACTERS, stripFormatChars } from "../src/format-chars.js";

// The importer cannot import from apps/server, so its copy of the rule is
// pinned to the server's file by reading that file's regular expression.
const server = readFileSync(new URL("../../server/src/format-chars.ts", import.meta.url), "utf8");

describe("the importer's format-character rule", () => {
  it("is the regular expression the server removes from stored names", () => {
    const [, source, flags] = /const FORMAT_CHARACTERS = \/(.+)\/([a-z]*);/.exec(server) ?? [];
    expect(source).toBeDefined();
    expect(FORMAT_CHARACTERS.source).toBe(new RegExp(source as string, flags).source);
    expect(FORMAT_CHARACTERS.flags).toBe(flags);
  });

  it("removes U+200E but keeps the joiner and non-joiner", () => {
    const lrm = String.fromCodePoint(0x200e);
    const zwj = String.fromCodePoint(0x200d);
    const zwnj = String.fromCodePoint(0x200c);
    expect(stripFormatChars(`a${lrm}b${zwj}c${zwnj}d`)).toBe(`ab${zwj}c${zwnj}d`);
  });

  it("removes each other format character a stored name loses", () => {
    for (const cp of [0x200b, 0x200f, 0xfeff, 0x00ad, 0x202e]) {
      expect(stripFormatChars(`a${String.fromCodePoint(cp)}b`)).toBe("ab");
    }
  });
});
