// Build plan Task 12, AC-034: a plate that cannot be sliced shows the
// slicer's reason in plain words. The six sentences are the plan's, word for
// word; filament_temperature and toolpath_conflict were added to the reason
// map later (Jon, 2026-11-08, gate run 3) and their sentences are pinned here.
import { REASONS } from "@platehouse/slicer-contract";
import { describe, expect, test } from "vitest";
import { isReason, REASON_WORDS, reasonWords } from "../../src/estimates/reasons.js";

describe("reason words", () => {
  test.each([
    ["process_not_compatible", "This file's print settings do not fit the selected printer."],
    ["machine_not_supported", "This file cannot be switched to the selected printer."],
    ["bed_too_small", "The plate is too big for this printer's bed."],
    [
      "nozzle_mismatch",
      "This plate needs a different nozzle or extruder setup than the selected printer has.",
    ],
    ["timeout", "Slicing took too long and was stopped."],
    ["slicer_error", "The slicer could not slice this plate."],
    [
      "filament_temperature",
      "The filaments on this plate need print temperatures too far apart to print together.",
    ],
    ["toolpath_conflict", "The slicer found print paths on this plate that would collide."],
  ])("%s reads exactly as written", (reason, words) => {
    expect(reasonWords(reason)).toBe(words);
  });

  test("every reason the contract names has its own words, in ASCII", () => {
    expect(Object.keys(REASON_WORDS).sort()).toEqual([...REASONS].sort());
    for (const reason of REASONS) {
      expect(REASON_WORDS[reason].length).toBeGreaterThan(10);
      expect(REASON_WORDS[reason]).toMatch(/^[\x20-\x7e]+$/);
    }
  });

  test.each(["too_large", "", "constructor", "__proto__", null])(
    "an unknown reason (%s) reads as a slicer error",
    (reason) => {
      expect(reasonWords(reason)).toBe("The slicer could not slice this plate.");
    },
  );

  test("isReason accepts the contract's reasons and nothing else", () => {
    for (const reason of REASONS) expect(isReason(reason)).toBe(true);
    for (const other of ["toString", "SLICER_ERROR", 1, null, undefined]) {
      expect(isReason(other)).toBe(false);
    }
  });
});
