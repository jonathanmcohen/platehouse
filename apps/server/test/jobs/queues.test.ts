// Build plan Task 8: what each queue is created and worked with. The slicer
// queue is a singleton queue, so one slice runs at a time (the maintainer, 2026-11-08,
// PR #49: there is no SLICER_CONCURRENCY); Task 12 adds its jobs and its
// worker with these settings. A slicer job is retried by pg-boss's own retry
// settings, three times with backoff (Task 12), not by a loop in the handler.
import type { PgBoss } from "pg-boss";
import { describe, expect, test, vi } from "vitest";
import {
  INGEST_CONCURRENCY,
  MAINTENANCE_TASKS,
  POLL_ORCA_CRON,
  QUEUE,
  type QueueDeps,
  queueSettings,
  RECONVERT_SLICE_SECONDS,
  SLICER_RETRY,
  startQueues,
  UPGRADE_TASKS,
} from "../../src/jobs/queues.js";
import { RECONVERT_PAUSED } from "../../src/library/reconvert.js";

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

/** A boss that records what startQueues asks of it and runs no job. */
function fakeBoss() {
  const calls: string[] = [];
  const sent: Array<{ name: string; data: { task: string }; options: unknown }> = [];
  const handlers = new Map<string, (jobs: unknown[]) => unknown>();
  const boss = {
    createQueue: vi.fn(async () => {}),
    updateQueue: vi.fn(async () => {}),
    schedule: vi.fn(async (_name: string, _cron: string, data: { task: string }) => {
      calls.push(`schedule ${data.task}`);
    }),
    work: vi.fn(async (name: string, _opts: unknown, handler: (jobs: unknown[]) => unknown) => {
      calls.push(`work ${name}`);
      handlers.set(name, handler);
      return name;
    }),
    send: vi.fn(async (name: string, data: { task: string }, options: unknown) => {
      calls.push(`send ${name} ${data.task}`);
      sent.push({ name, data, options });
      return "job-id";
    }),
  };
  return { boss: boss as unknown as PgBoss, calls, sent, handlers };
}

function deps(extra: Partial<QueueDeps>): QueueDeps {
  return {
    ingestFile: async () => {
      throw new Error("not in these tests");
    },
    purgeExpired: async () => undefined,
    sweepOrphans: async () => undefined,
    sweepUploads: async () => undefined,
    timeZone: "UTC",
    ...extra,
  };
}

describe("startQueues", () => {
  test("runs the Orca poll once at startup, after its schedule and the workers", async () => {
    const { boss, calls } = fakeBoss();
    const pollOrca = vi.fn(async () => {
      calls.push("pollOrca");
    });
    await startQueues(boss, deps({ pollOrca }));
    expect(pollOrca).toHaveBeenCalledTimes(1);
    expect(calls.indexOf("pollOrca")).toBe(calls.length - 1);
    expect(calls).toContain(`schedule ${MAINTENANCE_TASKS.pollOrca}`);
    expect(calls).toContain(`work ${QUEUE.maintenance}`);
  });

  test("a startup poll that fails is logged and does not stop the queues", async () => {
    const { boss } = fakeBoss();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        startQueues(
          boss,
          deps({
            pollOrca: async () => {
              throw new Error("connect ECONNREFUSED");
            },
          }),
        ),
      ).resolves.toBeUndefined();
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("startup Orca poll"));
    } finally {
      logged.mockRestore();
    }
  });

  test("with no Orca poll there is nothing to run at startup", async () => {
    const { boss, calls } = fakeBoss();
    await startQueues(boss, deps({}));
    expect(calls.some((c) => c.includes(MAINTENANCE_TASKS.pollOrca))).toBe(false);
  });
});

// The description re-conversion (#357) is a one-time step on upgrade, not a
// schedule: startQueues sends it to the maintenance queue once the workers
// are up, only while it has not finished, and the maintenance worker runs it.
describe("the description re-conversion on upgrade", () => {
  test("is sent once to the maintenance queue while it is pending, after the workers start", async () => {
    const { boss, calls, sent } = fakeBoss();
    await startQueues(
      boss,
      deps({ reconvertPending: async () => true, reconvertDescriptions: async () => undefined }),
    );
    expect(sent).toEqual([
      {
        name: QUEUE.maintenance,
        data: { task: UPGRADE_TASKS.reconvertDescriptions },
        options: undefined,
      },
    ]);
    expect(calls.indexOf(`send ${QUEUE.maintenance} ${UPGRADE_TASKS.reconvertDescriptions}`)).toBe(
      calls.length - 1,
    );
    expect(calls).toContain(`work ${QUEUE.maintenance}`);
  });

  test("is not sent once it has finished", async () => {
    const { boss, sent } = fakeBoss();
    await startQueues(
      boss,
      deps({ reconvertPending: async () => false, reconvertDescriptions: async () => undefined }),
    );
    expect(sent).toEqual([]);
  });

  test("is not sent when the server gives no re-conversion", async () => {
    const { boss, sent } = fakeBoss();
    await startQueues(boss, deps({}));
    expect(sent).toEqual([]);
  });

  test("a check that fails is logged and does not stop the queues", async () => {
    const { boss, sent } = fakeBoss();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        startQueues(
          boss,
          deps({
            reconvertPending: async () => {
              throw new Error("connection terminated");
            },
            reconvertDescriptions: async () => undefined,
          }),
        ),
      ).resolves.toBeUndefined();
      expect(sent).toEqual([]);
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("description re-conversion"));
    } finally {
      logged.mockRestore();
    }
  });

  /** A maintenance job for the re-conversion, as pg-boss hands it to the worker. */
  function reconvertJob(signal = new AbortController().signal, expireInSeconds = 900) {
    return { data: { task: UPGRADE_TASKS.reconvertDescriptions }, signal, expireInSeconds };
  }

  test("the maintenance worker runs it for its task, and sends no more when it finishes", async () => {
    const { boss, handlers, sent } = fakeBoss();
    const reconvertDescriptions = vi.fn(async (_stop: () => boolean) => ({ checked: 1 }));
    await startQueues(boss, deps({ reconvertPending: async () => false, reconvertDescriptions }));
    const work = handlers.get(QUEUE.maintenance);
    await work?.([reconvertJob()]);
    expect(reconvertDescriptions).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
  });

  // pg-boss fails a job that outlasts its expiry (15 minutes on the
  // maintenance queue) while the handler carries on, and the maintenance
  // worker fetches nothing until it returns. So a run gets a slice of the
  // job's time, stops when the slice is used or the job's signal aborts, and
  // a run that stopped with models left goes on in a new job. The scheduled
  // tasks queued meanwhile were created first, so they run before it.
  test("a run that paused goes on in a new maintenance job", async () => {
    const { boss, handlers, sent } = fakeBoss();
    const reconvertDescriptions = vi.fn(async (_stop: () => boolean) => RECONVERT_PAUSED);
    await startQueues(boss, deps({ reconvertPending: async () => false, reconvertDescriptions }));
    await handlers.get(QUEUE.maintenance)?.([reconvertJob()]);
    expect(sent).toEqual([
      {
        name: QUEUE.maintenance,
        data: { task: UPGRADE_TASKS.reconvertDescriptions },
        options: undefined,
      },
    ]);
  });

  test("tells the run to stop once its slice of the job's expiry is used", async () => {
    vi.useFakeTimers();
    try {
      const { boss, handlers } = fakeBoss();
      const answers: boolean[] = [];
      const reconvertDescriptions = vi.fn(async (stop: () => boolean) => {
        answers.push(stop());
        vi.advanceTimersByTime(RECONVERT_SLICE_SECONDS * 1000 - 1);
        answers.push(stop());
        vi.advanceTimersByTime(1);
        answers.push(stop());
        return RECONVERT_PAUSED;
      });
      await startQueues(boss, deps({ reconvertPending: async () => false, reconvertDescriptions }));
      await handlers.get(QUEUE.maintenance)?.([reconvertJob()]);
      expect(answers).toEqual([false, false, true]);
      expect(RECONVERT_SLICE_SECONDS).toBeLessThanOrEqual(900 / 3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a job with a short expiry gets a third of it", async () => {
    vi.useFakeTimers();
    try {
      const { boss, handlers } = fakeBoss();
      const answers: boolean[] = [];
      const reconvertDescriptions = vi.fn(async (stop: () => boolean) => {
        vi.advanceTimersByTime(20_000 - 1);
        answers.push(stop());
        vi.advanceTimersByTime(1);
        answers.push(stop());
        return RECONVERT_PAUSED;
      });
      await startQueues(boss, deps({ reconvertPending: async () => false, reconvertDescriptions }));
      await handlers.get(QUEUE.maintenance)?.([reconvertJob(undefined, 60)]);
      expect(answers).toEqual([false, true]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("tells the run to stop once the job's signal aborts", async () => {
    const { boss, handlers } = fakeBoss();
    const controller = new AbortController();
    const answers: boolean[] = [];
    const reconvertDescriptions = vi.fn(async (stop: () => boolean) => {
      answers.push(stop());
      controller.abort();
      answers.push(stop());
      return RECONVERT_PAUSED;
    });
    await startQueues(boss, deps({ reconvertPending: async () => false, reconvertDescriptions }));
    await handlers.get(QUEUE.maintenance)?.([reconvertJob(controller.signal)]);
    expect(answers).toEqual([false, true]);
  });

  test("is not a scheduled task, so the Activity page's schedule labels stay as they are", () => {
    expect(Object.values(MAINTENANCE_TASKS)).not.toContain(UPGRADE_TASKS.reconvertDescriptions);
  });
});
