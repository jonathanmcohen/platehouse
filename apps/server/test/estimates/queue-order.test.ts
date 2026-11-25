// The slicer queue is one queue: one slice at a time, for every printer, in
// pg-boss's order (highest priority first, then oldest). How long a printer's
// waiting plates take is how many slices run up to and including its last
// one, not its own count (PR #240 review, eta-ignores-shared-queue).
import { describe, expect, test } from "vitest";
import { type QueuedWork, SLICE_PRIORITY, slicesThrough } from "../../src/estimates/service.js";

const P1S = "Bambu Lab P1S 0.4 nozzle";
const A1 = "Bambu Lab A1 0.4 nozzle";
const X1C = "Bambu Lab X1 Carbon 0.4 nozzle";

function job(id: number, printerId: string, priority = 0, at = id) {
  return {
    id: `j${id}`,
    slice: true,
    printerId,
    estimateId: `e${id}`,
    priority,
    createdOn: new Date(at * 1000),
  };
}

/** A render or mesh job (derived.ts): sent with pg-boss's default priority, 0, and no printer. */
function render(id: number, at = id) {
  return { id: `r${id}`, slice: false, priority: 0, createdOn: new Date(at * 1000) };
}

/** Every estimate the jobs name, as if each were still pending. */
function pendingOf(jobs: ReadonlyArray<QueuedWork>): Set<string> {
  const ids = jobs.map((work) => work.estimateId).filter((id) => id !== undefined);
  return new Set(ids);
}

describe("slicesThrough", () => {
  test("library work queued printer after printer: each finishes behind the ones before it", () => {
    const jobs = [
      ...[1, 2, 3].map((i) => job(i, P1S)),
      ...[4, 5, 6].map((i) => job(i, A1)),
      ...[7, 8, 9].map((i) => job(i, X1C)),
    ];
    const through = slicesThrough(jobs, 0, pendingOf(jobs));
    expect(through.get(P1S)).toBe(3);
    expect(through.get(A1)).toBe(6);
    expect(through.get(X1C)).toBe(9);
  });

  test("a slice already running is ahead of everything queued", () => {
    const jobs = [job(1, A1), job(2, A1)];
    const through = slicesThrough(jobs, 1, pendingOf(jobs));
    expect(through.get(A1)).toBe(3);
  });

  test("higher priority runs first, whatever its age, and the order is not the listing order", () => {
    const jobs = [
      job(3, X1C, 0, 3),
      job(1, A1, 0, 1),
      job(9, P1S, 1, 9), // a new upload's slice: ahead of the older library work
      job(2, A1, 0, 2),
    ];
    const through = slicesThrough(jobs, 0, pendingOf(jobs));
    expect(through.get(P1S)).toBe(1);
    expect(through.get(A1)).toBe(3);
    expect(through.get(X1C)).toBe(4);
  });

  test("interleaved jobs: a printer's figure is the position of its last slice", () => {
    const jobs = [job(1, A1), job(2, X1C), job(3, A1), job(4, X1C), job(5, X1C)];
    const through = slicesThrough(jobs, 0, pendingOf(jobs));
    expect(through.get(A1)).toBe(3);
    expect(through.get(X1C)).toBe(5);
  });

  test("an empty queue gives no printer a figure", () => {
    expect(slicesThrough([], 0, pendingOf([])).size).toBe(0);
  });

  test("an estimate with two jobs (an urgent copy of a library one) counts once, where it runs first", () => {
    const jobs = [
      { ...job(1, A1), estimateId: "e1" },
      { ...job(2, A1), estimateId: "e2" },
      { ...job(3, P1S, 1), estimateId: "e3" },
      // e3's library job, sent before its urgent copy; it ends at once when it runs.
      { ...job(0, P1S, 0, 0), estimateId: "e3" },
    ];
    const through = slicesThrough(jobs, 0, pendingOf(jobs));
    expect(through.get(P1S)).toBe(1);
    expect(through.get(A1)).toBe(3);
  });

  // PR #240 review, library-priority-ties-renders: renders and meshes are sent
  // with pg-boss's default priority, so library work must sit below it, or a
  // new .scad or STEP file waits behind a whole backfill.
  test("library work sits below pg-boss's default priority, and a plate someone waits on above it", () => {
    expect(SLICE_PRIORITY.library).toBeLessThan(0);
    expect(SLICE_PRIORITY.waiting).toBeGreaterThan(0);
    expect(Number.isInteger(SLICE_PRIORITY.library)).toBe(true);
  });

  test("a render queued after a printer's backfill runs before it, and counts in its figure", () => {
    const lib = SLICE_PRIORITY.library;
    const jobs = [job(1, A1, lib), job(2, A1, lib), job(3, A1, lib), render(4)];
    const through = slicesThrough(jobs, 0, pendingOf(jobs));
    expect(through.get(A1)).toBe(4);
  });

  test("a render takes a place in the queue but gives no printer a figure", () => {
    const jobs = [render(1), job(2, P1S, SLICE_PRIORITY.waiting), render(3)];
    const through = slicesThrough(jobs, 1, pendingOf(jobs));
    // The urgent slice runs first, after the one running now; the renders after it.
    expect(through.get(P1S)).toBe(2);
    expect([...through.keys()]).toEqual([P1S]);
  });

  test("a slice whose estimate is no longer pending takes no place", () => {
    // j3's estimate, e3, was sliced already: its leftover job ends at once when it runs.
    const jobs = [job(1, A1), job(2, P1S), job(3, A1)];
    const through = slicesThrough(jobs, 0, new Set(["e1", "e2"]));
    expect(through.get(A1)).toBe(1);
    expect(through.get(P1S)).toBe(2);
  });

  test("the queued copy of the estimate running now takes no place", () => {
    const jobs = [{ ...job(1, A1, SLICE_PRIORITY.waiting), estimateId: "eRun" }, job(2, A1)];
    const through = slicesThrough(jobs, 1, new Set(["e2"]));
    expect(through.get(A1)).toBe(2);
  });

  test("a slice with no estimate takes no place, and a render still does", () => {
    const jobs = [
      { id: "s1", slice: true, printerId: A1, priority: 0, createdOn: new Date(1000) },
      render(2),
      job(3, P1S),
    ];
    const through = slicesThrough(jobs, 0, new Set(["e3"]));
    expect(through.get(P1S)).toBe(2);
    expect(through.has(A1)).toBe(false);
  });
});
