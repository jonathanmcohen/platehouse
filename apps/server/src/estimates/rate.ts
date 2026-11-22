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
