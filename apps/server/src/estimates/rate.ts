// How fast the slicer works through plates, for the settings page's "about
// how long" (issue #317).
//
// Up to 0.1.0 the page divided the work waiting by a fixed 3 plates a minute,
// measured on a 4-CPU test host. On the maintainer's server the real rate was
// about 9.2 plates a minute after adding a printer and 6.7 during a full
// re-estimate, so every time the page showed was about 2.6 to 3 times too
// long. The rate is now measured from the most recent finished slices.

/** How many of the most recent finished slices the rate is measured from. */
export const RATE_SAMPLE = 50;

/** Fewer finished slices than this give no measured rate: too few to tell. */
export const MIN_FINISHES_FOR_RATE = 10;

/**
 * The rate used while too few slices have finished to measure one: a new
 * install, or one that has sliced only a few plates. The lower of the two
 * live runs above (6.7 plates a minute), rounded down, so a first estimate
 * errs long rather than short, and far nearer than the old 3.
 */
export const FALLBACK_SLICES_PER_MINUTE = 6;

/** The shortest gap between two finishes the rate counts: at most 60 plates a minute. */
const MIN_GAP_MS = 1_000;

/** The lowest rate given, so a very slow slicer never reads as 0 plates a minute. */
const MIN_RATE = 0.1;

/**
 * Plates a minute, from finished slices' end times in any order, rounded to
 * one decimal place; null with fewer than MIN_FINISHES_FOR_RATE.
 *
 * Only the newest RATE_SAMPLE count. The slicer works one plate at a time, so
 * while it is busy the time between two finishes is one plate's slice (plus
 * any render or mesh that ran between them, which the page's queue counts
 * too). The rate is read from the median of those gaps, so the idle time
 * between two runs, one long gap among many short ones, does not slow it.
 */
export function sliceRate(finishedAt: readonly Date[]): number | null {
  const newest = finishedAt
    .map((d) => d.getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => b - a)
    .slice(0, RATE_SAMPLE);
  if (newest.length < MIN_FINISHES_FOR_RATE) return null;
  const gaps: number[] = [];
  for (let i = 1; i < newest.length; i += 1) {
    gaps.push(Math.max((newest[i - 1] as number) - (newest[i] as number), MIN_GAP_MS));
  }
  gaps.sort((a, b) => a - b);
  const middle = gaps.length / 2;
  const median = Number.isInteger(middle)
    ? ((gaps[middle - 1] as number) + (gaps[middle] as number)) / 2
    : (gaps[Math.floor(middle)] as number);
  const perMinute = Math.round((60_000 / median) * 10) / 10;
  return Math.max(perMinute, MIN_RATE);
}
