// The slicer queue is one queue: one slice at a time, for every printer, in
// pg-boss's order (highest priority first, then oldest). How long a printer's
// waiting plates take is how many slices run up to and including its last
// one, not its own count (PR #240 review, eta-ignores-shared-queue).
import { describe, expect, test } from "vitest";
import { slicesThrough } from "../../src/estimates/service.js";

const P1S = "Bambu Lab P1S 0.4 nozzle";
const A1 = "Bambu Lab A1 0.4 nozzle";
const X1C = "Bambu Lab X1 Carbon 0.4 nozzle";

function job(id: number, printerId: string, priority = 0, at = id) {
  return { id: `j${id}`, printerId, priority, createdOn: new Date(at * 1000) };
}

describe("slicesThrough", () => {
  test("library work queued printer after printer: each finishes behind the ones before it", () => {
    const jobs = [
      ...[1, 2, 3].map((i) => job(i, P1S)),
      ...[4, 5, 6].map((i) => job(i, A1)),
      ...[7, 8, 9].map((i) => job(i, X1C)),
    ];
    const through = slicesThrough(jobs, 0);
    expect(through.get(P1S)).toBe(3);
    expect(through.get(A1)).toBe(6);
    expect(through.get(X1C)).toBe(9);
  });

  test("a slice already running is ahead of everything queued", () => {
    const through = slicesThrough([job(1, A1), job(2, A1)], 1);
    expect(through.get(A1)).toBe(3);
  });

  test("higher priority runs first, whatever its age, and the order is not the listing order", () => {
    const jobs = [
      job(3, X1C, 0, 3),
      job(1, A1, 0, 1),
      job(9, P1S, 1, 9), // a new upload's slice: ahead of the older library work
      job(2, A1, 0, 2),
    ];
    const through = slicesThrough(jobs, 0);
    expect(through.get(P1S)).toBe(1);
    expect(through.get(A1)).toBe(3);
    expect(through.get(X1C)).toBe(4);
  });

  test("interleaved jobs: a printer's figure is the position of its last slice", () => {
    const jobs = [job(1, A1), job(2, X1C), job(3, A1), job(4, X1C), job(5, X1C)];
    const through = slicesThrough(jobs, 0);
    expect(through.get(A1)).toBe(3);
    expect(through.get(X1C)).toBe(5);
  });

  test("an empty queue gives no printer a figure", () => {
    expect(slicesThrough([], 0).size).toBe(0);
  });
});
