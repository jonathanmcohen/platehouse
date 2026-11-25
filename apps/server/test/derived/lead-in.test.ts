// Platehouse's sentences that end with a lead-in to a program's own words
// ("OpenSCAD said:", "The converter said:") are joined to the program's
// message by afterSentence. The slicer starts that message with the same
// lead-in, so a join says it once.
import { describe, expect, test } from "vitest";
import { afterSentence, DERIVED_MESSAGES } from "../../src/derived/client.js";

describe("a sentence joined to a program's message", () => {
  test("the previous-renders sentence for a .scad names OpenSCAD once", () => {
    expect(
      afterSentence(DERIVED_MESSAGES.previousRendersScad, "OpenSCAD said: ERROR: bad file"),
    ).toBe(`${DERIVED_MESSAGES.previousRendersScad} ERROR: bad file`);
  });

  test("the previous-renders sentence for a STEP file names the converter once", () => {
    expect(
      afterSentence(DERIVED_MESSAGES.previousRendersStep, "The converter said: no shapes"),
    ).toBe(`${DERIVED_MESSAGES.previousRendersStep} no shapes`);
  });

  test("the preview sentence names OpenSCAD once", () => {
    expect(afterSentence(DERIVED_MESSAGES.previewRejected, "OpenSCAD said: ERROR: CGAL")).toBe(
      `${DERIVED_MESSAGES.previewRejected} ERROR: CGAL`,
    );
  });

  test("only one lead-in is taken off", () => {
    expect(afterSentence(DERIVED_MESSAGES.previewRejected, "OpenSCAD said: OpenSCAD said: x")).toBe(
      `${DERIVED_MESSAGES.previewRejected} OpenSCAD said: x`,
    );
  });

  test("a message without the lead-in is kept whole", () => {
    expect(afterSentence(DERIVED_MESSAGES.previousRendersScad, "ERROR: bad file")).toBe(
      `${DERIVED_MESSAGES.previousRendersScad} ERROR: bad file`,
    );
  });

  test("another program's lead-in is kept", () => {
    expect(afterSentence(DERIVED_MESSAGES.previousRendersScad, "The converter said: x")).toBe(
      `${DERIVED_MESSAGES.previousRendersScad} The converter said: x`,
    );
  });

  test("a sentence with no lead-in keeps the message's", () => {
    expect(afterSentence(DERIVED_MESSAGES.previewFailed, "OpenSCAD said: x")).toBe(
      `${DERIVED_MESSAGES.previewFailed} OpenSCAD said: x`,
    );
  });
});
