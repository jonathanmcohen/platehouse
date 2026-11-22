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

/**
 * The longest gap between two finishes the rate counts as the slicer at work.
 * A longer gap is idle time (models added now and then, one or two plates
 * each) and is left out. A live run sliced a plate every 6.5 to 9 seconds and
 * the 4-CPU test host one every 20, so five minutes is well above one plate's
 * slice; the slowest rate measured is 0.2 plates a minute.
 */
export const BUSY_GAP_MS = 5 * 60_000;

/**
 * Fewer gaps of BUSY_GAP_MS or less than this give no measured rate: the
 * gaps of one run of MIN_FINISHES_FOR_RATE back-to-back finishes.
 */
export const MIN_BUSY_GAPS = MIN_FINISHES_FOR_RATE - 1;

/**
 * Plates a minute, from finished slices' end times in any order, rounded to
 * one decimal place; null with fewer than MIN_FINISHES_FOR_RATE, or with
 * fewer than MIN_BUSY_GAPS gaps that are the slicer at work.
 *
 * Only the newest RATE_SAMPLE count. The slicer works one plate at a time, so
 * while it is busy the time between two finishes is one plate's slice (plus
 * any render or mesh that ran between them, which the page's queue counts
 * too). A gap longer than BUSY_GAP_MS is idle time and is left out, however
 * many there are: an install that adds a model now and then has mostly idle
 * gaps, and their median would read as a slicer taking hours a plate. The
 * rate is read from the median of the gaps that remain.
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
    const gap = (newest[i - 1] as number) - (newest[i] as number);
    if (gap <= BUSY_GAP_MS) gaps.push(Math.max(gap, MIN_GAP_MS));
  }
  if (gaps.length < MIN_BUSY_GAPS) return null;
  gaps.sort((a, b) => a - b);
  const middle = gaps.length / 2;
  const median = Number.isInteger(middle)
    ? ((gaps[middle - 1] as number) + (gaps[middle] as number)) / 2
    : (gaps[Math.floor(middle)] as number);
  return Math.round((60_000 / median) * 10) / 10;
}
