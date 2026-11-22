// The slicer's rate for the settings page's "about how long" (issue #317):
// measured from the most recent finished slices rather than a fixed 3 plates
// a minute, with a fallback while too few have finished.
//
// The slicer works one plate at a time, so while it is busy the time between
// two finishes is one plate's slice. The rate is read from the middle (the
// median) of those gaps, so the idle time between two runs, one long gap
// among many short ones, does not slow it.
import { describe, expect, test } from "vitest";
import {
  FALLBACK_SLICES_PER_MINUTE,
  MIN_FINISHES_FOR_RATE,
  RATE_SAMPLE,
  sliceRate,
} from "../../src/estimates/rate.js";

const END = Date.parse("2026-11-21T20:00:00Z");

/** n finishes, newest first, gapMs apart, the newest at END. */
function finishes(n: number, gapMs: number): Date[] {
  return Array.from({ length: n }, (_, i) => new Date(END - i * gapMs));
}

describe("sliceRate", () => {
  test("a plate every 6.5 seconds is about 9.2 plates a minute", () => {
    expect(sliceRate(finishes(20, 6_500))).toBe(9.2);
  });

  test("a plate every 20 seconds is 3 plates a minute", () => {
    expect(sliceRate(finishes(20, 20_000))).toBe(3);
  });

  test("is rounded to one decimal place", () => {
    // 60 / 7 = 8.571...
    expect(sliceRate(finishes(20, 7_000))).toBe(8.6);
  });

  test("with fewer finishes than MIN_FINISHES_FOR_RATE there is no rate", () => {
    expect(MIN_FINISHES_FOR_RATE).toBe(10);
    expect(sliceRate([])).toBeNull();
    expect(sliceRate(finishes(1, 6_500))).toBeNull();
    expect(sliceRate(finishes(MIN_FINISHES_FOR_RATE - 1, 6_500))).toBeNull();
    expect(sliceRate(finishes(MIN_FINISHES_FOR_RATE, 6_500))).toBe(9.2);
  });

  test("an idle hour between two runs does not slow the rate", () => {
    const first = finishes(10, 6_500);
    const later = finishes(10, 6_500).map((d) => new Date(d.getTime() + 3_600_000));
    expect(sliceRate([...later, ...first])).toBe(9.2);
  });

  test("the order the finishes come in does not matter", () => {
    const list = finishes(20, 6_500);
    expect(sliceRate([...list].reverse())).toBe(9.2);
  });

  test("only the newest RATE_SAMPLE finishes count", () => {
    expect(RATE_SAMPLE).toBe(50);
    const fast = finishes(RATE_SAMPLE, 6_500);
    const oldest = fast.at(-1)?.getTime() ?? END;
    // 100 older, slow finishes before them: a plate a minute.
    const slow = Array.from({ length: 100 }, (_, i) => new Date(oldest - (i + 1) * 60_000));
    expect(sliceRate([...fast, ...slow])).toBe(9.2);
  });

  test("finishes at the same instant never give an endless rate", () => {
    const same = Array.from({ length: 20 }, () => new Date(END));
    const rate = sliceRate(same);
    expect(rate).not.toBeNull();
    expect(Number.isFinite(rate)).toBe(true);
    expect(rate).toBeLessThanOrEqual(60);
  });

  test("a very slow slicer still has a rate above zero", () => {
    // A plate every 20 minutes.
    expect(sliceRate(finishes(20, 1_200_000))).toBe(0.1);
  });

  test("the fallback is 6 plates a minute", () => {
    expect(FALLBACK_SLICES_PER_MINUTE).toBe(6);
  });
});
