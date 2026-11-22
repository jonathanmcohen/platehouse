// The slicer's rate for the settings page's "about how long" (issue #317):
// measured from the most recent finished slices rather than a fixed 3 plates
// a minute, with a fallback while too few have finished.
//
// The slicer works one plate at a time, so while it is busy the time between
// two finishes is one plate's slice. A gap longer than BUSY_GAP_MS is idle
// time and is left out; the rate is read from the middle (the median) of the
// gaps that remain, and there is none while too few remain.
import { describe, expect, test } from "vitest";
import {
  BUSY_GAP_MS,
  FALLBACK_SLICES_PER_MINUTE,
  MIN_BUSY_GAPS,
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

  test("a gap longer than five minutes is idle time, not a slice", () => {
    expect(BUSY_GAP_MS).toBe(5 * 60_000);
    expect(MIN_BUSY_GAPS).toBe(MIN_FINISHES_FOR_RATE - 1);
    // A plate every 20 minutes is models added now and then, not a slow
    // slicer: no gap is a slice, so there is no measured rate.
    expect(sliceRate(finishes(20, 1_200_000))).toBeNull();
  });

  test("the slowest rate measured is one plate in five minutes", () => {
    expect(sliceRate(finishes(20, BUSY_GAP_MS))).toBe(0.2);
  });

  test("single-plate models added one at a time give no rate, not a crawl", () => {
    // The newest 50 finishes are each an upload's only slice, hours apart.
    const isolated = Array.from(
      { length: RATE_SAMPLE },
      (_, i) => new Date(END - i * 3 * 3_600_000),
    );
    expect(sliceRate(isolated)).toBeNull();
  });

  test("mostly isolated finishes give no rate while too few gaps are slices", () => {
    // Eight two-plate uploads an hour apart (8 slice gaps of 6.5 seconds),
    // then older single-plate uploads: fewer slice gaps than MIN_BUSY_GAPS.
    const pairs = Array.from({ length: 8 }, (_, i) => [
      new Date(END - i * 3_600_000),
      new Date(END - i * 3_600_000 - 6_500),
    ]).flat();
    const oldest = END - 8 * 3_600_000;
    const isolated = Array.from(
      { length: RATE_SAMPLE - pairs.length },
      (_, i) => new Date(oldest - i * 3_600_000),
    );
    expect(MIN_BUSY_GAPS).toBeGreaterThan(8);
    expect(sliceRate([...pairs, ...isolated])).toBeNull();
  });

  test("idle gaps that outnumber the slices do not slow the rate", () => {
    // Two-plate uploads an hour apart: 25 slice gaps of 6.5 seconds among 24
    // idle hours. Counting every gap, the median would be an hour.
    const pairs = Array.from({ length: RATE_SAMPLE / 2 }, (_, i) => [
      new Date(END - i * 3_600_000),
      new Date(END - i * 3_600_000 - 6_500),
    ]).flat();
    expect(sliceRate(pairs)).toBe(9.2);
  });

  test("just enough slice gaps among idle ones give a measured rate", () => {
    // MIN_BUSY_GAPS + 1 back-to-back finishes, then isolated ones an hour apart.
    const run = finishes(MIN_BUSY_GAPS + 1, 6_500);
    const oldest = END - MIN_BUSY_GAPS * 6_500;
    const isolated = Array.from({ length: 20 }, (_, i) => new Date(oldest - (i + 1) * 3_600_000));
    expect(sliceRate([...run, ...isolated])).toBe(9.2);
    expect(sliceRate([...run.slice(1), ...isolated])).toBeNull();
  });

  test("the fallback is 6 plates a minute", () => {
    expect(FALLBACK_SLICES_PER_MINUTE).toBe(6);
  });
});
