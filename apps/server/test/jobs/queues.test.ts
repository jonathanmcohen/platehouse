// Build plan Task 8: what each queue is created and worked with. The slicer
// queue is a singleton queue worked at SLICER_CONCURRENCY; Task 12 adds its
// jobs and its worker with these settings.
import { describe, expect, test } from "vitest";
import { INGEST_CONCURRENCY, QUEUE, queueSettings } from "../../src/jobs/queues.js";

describe("queueSettings", () => {
  test("slicer is a singleton queue worked at SLICER_CONCURRENCY", () => {
    expect(queueSettings({ slicerConcurrency: 1 }).slicer).toMatchObject({
      name: QUEUE.slicer,
      queue: { policy: "singleton" },
      work: { localConcurrency: 1 },
    });
    expect(queueSettings({ slicerConcurrency: 3 }).slicer.work.localConcurrency).toBe(3);
  });

  test("ingest runs two at once and never retries", () => {
    const { ingest } = queueSettings({ slicerConcurrency: 1 });
    expect(INGEST_CONCURRENCY).toBe(2);
    expect(ingest).toMatchObject({
      name: QUEUE.ingest,
      queue: { policy: "standard", retryLimit: 0 },
      work: { localConcurrency: INGEST_CONCURRENCY },
    });
  });

  test("maintenance runs one job at a time", () => {
    expect(queueSettings({ slicerConcurrency: 1 }).maintenance).toMatchObject({
      name: QUEUE.maintenance,
      work: { localConcurrency: 1 },
    });
  });

  test.each([0, -1, 1.5, Number.NaN])("refuses a slicer concurrency of %s", (n) => {
    expect(() => queueSettings({ slicerConcurrency: n })).toThrow(RangeError);
  });
});
