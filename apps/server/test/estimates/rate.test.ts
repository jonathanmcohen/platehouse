// The slicer's rate for the settings page's "about how long" (issues #317 and
// #375): the slicer's throughput while busy, from each successful slice's own
// working time (finished_at - started_at), with a fallback while too few
// slices have one. Idle time between jobs never counts, however short or
// long, and a slow slice always counts, however slow.
//
// The named cases from both review rounds of PR #361 are kept here with what
// they now give: idle hours (round 1) and idle minutes (round 2, issue #375)
// between slices leave the rate alone, and slow slices are never dropped.
// rate-simulation.test.ts checks the rule against random workloads.
import { describe, expect, test } from "vitest";
import {
  FALLBACK_SLICES_PER_MINUTE,
  MIN_FINISHES_FOR_RATE,
  RATE_SAMPLE,
  sliceRate,
  type TimedSlice,
} from "../../src/estimates/rate.js";

const END = Date.parse("2026-11-21T20:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * n slices, newest first, each taking sliceMs, with idleMs between one's
 * finish and the next one's start; the newest finishes at end.
 */
function slices(n: number, sliceMs: number, idleMs = 0, end = END): TimedSlice[] {
  const out: TimedSlice[] = [];
  let finish = end;
  for (let i = 0; i < n; i += 1) {
    out.push({ startedAt: new Date(finish - sliceMs), finishedAt: new Date(finish) });
    finish -= sliceMs + idleMs;
  }
  return out;
}

describe("sliceRate", () => {
  test("a plate every 6.5 seconds is about 9.2 plates a minute", () => {
    expect(sliceRate(slices(20, 6_500))).toBe(9.2);
  });

  test("a plate every 20 seconds is 3 plates a minute", () => {
    expect(sliceRate(slices(20, 20_000))).toBe(3);
  });

  test("is rounded to two significant figures", () => {
    // 60 / 7 = 8.571...
    expect(sliceRate(slices(20, 7_000))).toBe(8.6);
    // 60 / 4.8 = 12.5
    expect(sliceRate(slices(20, 4_800))).toBe(13);
    // 1 / 7 minutes = 0.1428...
    expect(sliceRate(slices(20, 7 * MINUTE))).toBe(0.14);
  });

  test("with fewer slices than MIN_FINISHES_FOR_RATE there is no rate", () => {
    expect(MIN_FINISHES_FOR_RATE).toBe(10);
    expect(sliceRate([])).toBeNull();
    expect(sliceRate(slices(1, 6_500))).toBeNull();
    expect(sliceRate(slices(MIN_FINISHES_FOR_RATE - 1, 6_500))).toBeNull();
    expect(sliceRate(slices(MIN_FINISHES_FOR_RATE, 6_500))).toBe(9.2);
  });

  test("the order the slices come in does not matter", () => {
    expect(sliceRate([...slices(20, 6_500)].reverse())).toBe(9.2);
  });

  test("only the newest RATE_SAMPLE slices count", () => {
    expect(RATE_SAMPLE).toBe(50);
    const fast = slices(RATE_SAMPLE, 6_500);
    const oldest = fast.at(-1)?.startedAt.getTime() ?? END;
    // 100 older slices of a minute each.
    const slow = slices(100, MINUTE, 0, oldest);
    expect(sliceRate([...fast, ...slow])).toBe(9.2);
  });

  test("slices that took no time give no rate rather than an endless one", () => {
    const instant = Array.from({ length: 20 }, () => ({
      startedAt: new Date(END),
      finishedAt: new Date(END),
    }));
    expect(sliceRate(instant)).toBeNull();
  });

  test("the fallback is 6 plates a minute", () => {
    expect(FALLBACK_SLICES_PER_MINUTE).toBe(6);
  });

  describe("idle time never counts (round 1: idle hours)", () => {
    test("an idle hour between two runs does not slow the rate", () => {
      const later = slices(10, 6_500);
      const first = slices(10, 6_500, 0, END - 10 * 6_500 - HOUR);
      expect(sliceRate([...later, ...first])).toBe(9.2);
    });

    test("single-plate models added one at a time, hours apart, give the slicer's own speed", () => {
      expect(sliceRate(slices(RATE_SAMPLE, 6_500, 3 * HOUR))).toBe(9.2);
    });

    test("idle gaps that outnumber the slices do not slow the rate", () => {
      // Two-plate uploads an hour apart: 25 pairs, each pair back to back.
      const pairs = Array.from({ length: RATE_SAMPLE / 2 }, (_, i) =>
        slices(2, 6_500, 0, END - i * HOUR),
      ).flat();
      expect(sliceRate(pairs)).toBe(9.2);
    });
  });

  describe("idle time never counts (round 2, issue #375: idle minutes)", () => {
    test("single-plate models queued 2 minutes apart, each after the last finished, give the slicer's own speed", () => {
      // Every finish is about 2 minutes after the last; the old gap rule read 0.5 a minute.
      expect(sliceRate(slices(RATE_SAMPLE, 6_500, 2 * MINUTE - 6_500))).toBe(9.2);
    });

    test.each([1, 2, 3, 4, 5])("idle gaps of %d minutes leave the rate alone", (minutes) => {
      expect(sliceRate(slices(RATE_SAMPLE, 6_500, minutes * MINUTE))).toBe(9.2);
    });
  });

  describe("a slow slice always counts (round 2, issue #375)", () => {
    test("on a host where every plate takes 6 minutes, the rate is 1 in 6 minutes, not the fallback", () => {
      expect(sliceRate(slices(20, 6 * MINUTE))).toBe(0.17);
    });

    test("a slice of 20 minutes counts", () => {
      expect(sliceRate(slices(20, 20 * MINUTE))).toBe(0.05);
    });

    test("some slow plates among fast ones slow the rate by their share of the time", () => {
      // 25 plates of 6.5 seconds and 25 of 6 minutes: 50 plates in 9162.5 seconds.
      const fast = slices(25, 6_500);
      const slow = slices(25, 6 * MINUTE, 0, END - 25 * 6_500);
      expect(sliceRate([...fast, ...slow])).toBe(0.33);
    });
  });
});
