// Build plan Task 19: the library page looks up each plate's numbers with at
// most PLATE_NUMBERS_CONCURRENCY lookups in flight (mapLimit), so a page of
// many plates does not take the whole database pool at once. The page itself,
// with one display context per page, is tested against Postgres under
// test/integration/app-api/.
import { describe, expect, test } from "vitest";
import { mapLimit, PLATE_NUMBERS_CONCURRENCY } from "../../src/app-api/library.js";

/** Lets every pending promise callback run. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("mapLimit", () => {
  test("keeps the results in the items' order", async () => {
    const out = await mapLimit([30, 10, 20, 0], 2, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms * 2;
    });
    expect(out).toEqual([60, 20, 40, 0]);
  });

  test("never has more than the limit in flight, and uses all of it", async () => {
    let inFlight = 0;
    let most = 0;
    const releases: Array<() => void> = [];
    const done = mapLimit(
      Array.from({ length: 10 }, (_, i) => i),
      3,
      async (i) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise<void>((resolve) => releases.push(resolve));
        inFlight -= 1;
        return i;
      },
    );
    for (let round = 0; round < 20; round += 1) {
      await tick();
      expect(inFlight).toBeLessThanOrEqual(3);
      for (const release of releases.splice(0)) release();
    }
    expect(await done).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(most).toBe(3);
  });

  test("an empty list calls nothing", async () => {
    let calls = 0;
    expect(
      await mapLimit([], 4, async () => {
        calls += 1;
      }),
    ).toEqual([]);
    expect(calls).toBe(0);
  });

  test("a failure rejects the whole map", async () => {
    await expect(
      mapLimit([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("the database is down");
        return n;
      }),
    ).rejects.toThrow("the database is down");
  });

  test("the library's cap is small next to the pool of 10", () => {
    expect(PLATE_NUMBERS_CONCURRENCY).toBeGreaterThan(0);
    expect(PLATE_NUMBERS_CONCURRENCY).toBeLessThanOrEqual(4);
  });
});
