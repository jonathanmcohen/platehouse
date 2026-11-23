import { describe, expect, test } from "vitest";
import {
  convertedDescription,
  MAX_DESCRIPTION_CODE_POINTS,
} from "../../src/library/converted-description.js";

describe("convertedDescription", () => {
  test("stores a description of exactly 200,000 code points", () => {
    const text = "a".repeat(MAX_DESCRIPTION_CODE_POINTS);
    expect(convertedDescription(`<p>${text}</p>`)).toBe(text);
  });

  test("drops one of 200,001 code points, as no description", () => {
    expect(convertedDescription(`<p>${"a".repeat(MAX_DESCRIPTION_CODE_POINTS + 1)}</p>`)).toBe("");
  });

  test("counts an astral character once, not as two UTF-16 units", () => {
    const text = "\u{1F600}".repeat(MAX_DESCRIPTION_CODE_POINTS);
    expect(convertedDescription(`<p>${text}</p>`)).toBe(text);
    expect(convertedDescription(`<p>${text}x</p>`)).toBe("");
  });

  test("gives nothing for no html", () => {
    expect(convertedDescription(null)).toBe("");
  });
});
