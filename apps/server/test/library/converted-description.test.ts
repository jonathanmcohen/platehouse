import { describe, expect, test } from "vitest";
import {
  convertedDescription,
  joinWithNote,
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

describe("joinWithNote", () => {
  const note = "Licence note.";

  test("keeps the note when the whole fits", () => {
    const text = "a".repeat(MAX_DESCRIPTION_CODE_POINTS - 1000);
    expect(joinWithNote(text, note)).toBe(`${text}\n\n${note}`);
  });

  test("drops the note alone when it would take the whole over the limit", () => {
    const text = "a".repeat(MAX_DESCRIPTION_CODE_POINTS - 5);
    expect(joinWithNote(text, note)).toBe(text);
  });

  test("keeps the note when the whole is exactly the limit", () => {
    const text = "a".repeat(MAX_DESCRIPTION_CODE_POINTS - note.length - 2);
    expect(joinWithNote(text, note)).toBe(`${text}\n\n${note}`);
  });

  test("gives the note alone for no text, and nothing for neither", () => {
    expect(joinWithNote("", note)).toBe(note);
    expect(joinWithNote("", null)).toBe("");
  });
});
