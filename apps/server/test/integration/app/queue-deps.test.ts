// Build plan Task 30: the server passes startQueues a ServerQueueDeps, so
// leaving out a queue's worker or a schedule's handler fails to compile, not
// just a test. Each @ts-expect-error below is the assertion: tsc -b (the CI
// typecheck job) fails if leaving that dependency out ever compiles.
import { describe, expect, test } from "vitest";
import type { ServerQueueDeps } from "../../../src/jobs/queues.js";

const full: ServerQueueDeps = {
  ingestFile: async () => ({ modelId: "m", fileId: "f" }),
  purgeExpired: async () => undefined,
  sweepOrphans: async () => undefined,
  sweepUploads: async () => undefined,
  slicerJobs: {},
  pollOrca: async () => undefined,
  onIngested: async () => undefined,
  checkRenders: async () => undefined,
  reconvertDescriptions: async () => undefined,
  reconvertPending: async () => false,
};

describe("ServerQueueDeps", () => {
  test("requires every worker and schedule handler", () => {
    const { slicerJobs, pollOrca, onIngested, checkRenders, ...rest } = full;
    // @ts-expect-error -- the slicer queue would have no worker
    const noSlicer: ServerQueueDeps = { ...rest, pollOrca, onIngested, checkRenders };
    // @ts-expect-error -- the Orca poll would have no schedule
    const noPoll: ServerQueueDeps = { ...rest, slicerJobs, onIngested, checkRenders };
    // @ts-expect-error -- an ingested file's plates would wait for the Orca poll
    const noOnIngested: ServerQueueDeps = { ...rest, slicerJobs, pollOrca, checkRenders };
    // @ts-expect-error -- the render check would have no schedule
    const noCheck: ServerQueueDeps = { ...rest, slicerJobs, pollOrca, onIngested };
    expect([noSlicer, noPoll, noOnIngested, noCheck].every((d) => d !== undefined)).toBe(true);
  });

  test("requires the description re-conversion and its check (#357)", () => {
    const { reconvertDescriptions, reconvertPending, ...rest } = full;
    // @ts-expect-error -- the descriptions would never be converted again on upgrade
    const noRun: ServerQueueDeps = { ...rest, reconvertPending };
    // @ts-expect-error -- the re-conversion would never be queued
    const noCheck: ServerQueueDeps = { ...rest, reconvertDescriptions };
    expect([noRun, noCheck].every((d) => d !== undefined)).toBe(true);
  });
});
