// How fast the slicer works through plates, for the settings page's "about
// how long" (issues #317 and #375).
//
// Up to 0.1.0 the page divided the work waiting by a fixed 3 plates a minute,
// measured on a 4-CPU test host. On the maintainer's server the real rate was
// about 9.2 plates a minute after adding a printer and 6.7 during a full
// re-estimate, so every time the page showed was about 2.6 to 3 times too
// long.
//
// The rate is the slicer's throughput while it was busy: idle time between
// jobs never counts, however short or long, and a slow slice always counts,
// however slow. Reading it from the gaps between finishes cannot do that, as
// a gap mixes slicing with idle time and no cutoff tells them apart (two
// review rounds on PR #361, issue #375). So each slice's own working time is
// recorded instead: a slice job sets started_at when it begins work
// (migration 0010), and finished_at minus started_at is the time the slicer
// spent on that plate. The rate is the number of slices over the sum of
// their times.

/** How many of the most recent successful slices the rate is measured from. */
export const RATE_SAMPLE = 50;

/** Fewer measured slices than this give no measured rate: too few to tell. */
export const MIN_FINISHES_FOR_RATE = 10;

/**
 * The rate used while too few slices have a measured time: a new install,
 * one that has sliced only a few plates, or one just upgraded from a version
 * that recorded no start times. The lower of the two live runs above (6.7
 * plates a minute), rounded down, so a first estimate errs long rather than
 * short, and far nearer than the old 3.
 */
export const FALLBACK_SLICES_PER_MINUTE = 6;

/** One successful slice: when the attempt that finished began work, and when it ended. */
export interface TimedSlice {
  startedAt: Date;
  finishedAt: Date;
}

/**
 * Plates a minute while the slicer was busy, from successful slices in any
 * order: of the newest RATE_SAMPLE by finish time, how many there are over
 * the sum of their working times (finishedAt - startedAt), to two
 * significant figures (9.2, 0.33, 12). Null with fewer than
 * MIN_FINISHES_FOR_RATE slices, or when their times add up to nothing.
 *
 * Idle time is never counted, as it lies between one slice's finish and the
 * next one's start, and no slice is ever left out for being slow. A mean,
 * not a median: the time a queue takes is its plates' times added up, so
 * with plates of very different weights the median of their times would
 * read too fast or too slow.
 */
export function sliceRate(slices: readonly TimedSlice[]): number | null {
  const newest = slices
    .map((s) => ({ start: s.startedAt.getTime(), end: s.finishedAt.getTime() }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end))
    .sort((a, b) => b.end - a.end)
    .slice(0, RATE_SAMPLE);
  if (newest.length < MIN_FINISHES_FOR_RATE) return null;
  const busyMs = newest.reduce((sum, s) => sum + Math.max(s.end - s.start, 0), 0);
  if (busyMs <= 0) return null;
  return Number(((newest.length / busyMs) * 60_000).toPrecision(2));
}
