// Build plan Task 8: what each queue is created and worked with. The slicer
// queue is a singleton queue, so one slice runs at a time (Jon, 2026-11-08,
// PR #49: there is no SLICER_CONCURRENCY); Task 12 adds its jobs and its
// worker with these settings. A slicer job is retried by pg-boss's own retry
// settings, three times with backoff (Task 12), not by a loop in the handler.
import { describe, expect, test } from "vitest";
import {
  INGEST_CONCURRENCY,
  POLL_ORCA_CRON,
  QUEUE,
  queueSettings,
  SLICER_RETRY,
} from "../../src/jobs/queues.js";

describe("queueSettings", () => {
  test("slicer is a singleton queue worked one job at a time, retried 3 times with backoff", () => {
    expect(queueSettings().slicer).toEqual({
      name: QUEUE.slicer,
      queue: {
        policy: "singleton",
        retryLimit: 3,
        retryBackoff: true,
        retryDelay: 10,
        retryDelayMax: 120,
      },
      work: { localConcurrency: 1 },
    });
    expect(SLICER_RETRY).toEqual({
      retryLimit: 3,
      retryBackoff: true,
      retryDelay: 10,
      retryDelayMax: 120,
    });
  });

  test("the Orca-version poll runs every 10 minutes", () => {
    expect(POLL_ORCA_CRON).toBe("*/10 * * * *");
  });

  test("the settings take no slicer concurrency", () => {
    expect(queueSettings.length).toBe(0);
  });

  test("ingest runs two at once and never retries", () => {
    const { ingest } = queueSettings();
    expect(INGEST_CONCURRENCY).toBe(2);
    expect(ingest).toMatchObject({
      name: QUEUE.ingest,
      queue: { policy: "standard", retryLimit: 0 },
      work: { localConcurrency: INGEST_CONCURRENCY },
    });
  });

  test("maintenance runs one job at a time", () => {
    expect(queueSettings().maintenance).toMatchObject({
      name: QUEUE.maintenance,
      work: { localConcurrency: 1 },
    });
  });
});
