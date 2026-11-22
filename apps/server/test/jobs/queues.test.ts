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
  RECONVERT_CRON,
  RECONVERT_SLICE_SECONDS,
  reconvertBackoffMs,
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
// The description re-conversion on upgrade (#357). Its lifecycle as a whole is
// checked by the seeded simulation in test/library/reconvert-lifecycle.test.ts;
// these are the named cases from the review rounds and issues #381 and #382.
describe("the description re-conversion on upgrade", () => {
  const TASK = UPGRADE_TASKS.reconvertDescriptions;
  const JOB = { name: QUEUE.maintenance, data: { task: TASK }, options: { retryLimit: 0 } };

  /** A maintenance job for the re-conversion, as pg-boss hands it to the worker. */
  function reconvertJob(signal = new AbortController().signal, expireInSeconds = 900) {
    return { data: { task: TASK }, signal, expireInSeconds };
  }

  /** Starts the queues with a re-conversion, and gives the maintenance worker. */
  async function started(over: Partial<QueueDeps> = {}) {
    const fake = fakeBoss();
    const unschedule = vi.fn(async (_name: string, _key: string) => {
      fake.calls.push(`unschedule ${_key}`);
    });
    (fake.boss as unknown as { unschedule: typeof unschedule }).unschedule = unschedule;
    await startQueues(
      fake.boss,
      deps({
        reconvertPending: async () => true,
        reconvertDescriptions: async () => RECONVERT_PAUSED,
        ...over,
      }),
    );
    const work = fake.handlers.get(QUEUE.maintenance);
    if (work === undefined) throw new Error("no maintenance worker");
    fake.sent.length = 0;
    fake.calls.length = 0;
    return { ...fake, unschedule, work };
  }

  test("while pending, is scheduled every 5 minutes and sent at once, with no pg-boss retry", async () => {
    const { boss, calls, sent } = fakeBoss();
    (boss as unknown as { unschedule: () => Promise<void> }).unschedule = async () => {};
    await startQueues(
      boss,
      deps({ reconvertPending: async () => true, reconvertDescriptions: async () => null }),
    );
    expect(RECONVERT_CRON).toBe("*/5 * * * *");
    expect(boss.schedule).toHaveBeenCalledWith(
      QUEUE.maintenance,
      RECONVERT_CRON,
      { task: TASK },
      {
        tz: "UTC",
        key: TASK,
        retryLimit: 0,
      },
    );
    expect(sent).toEqual([JOB]);
    expect(calls.indexOf(`send ${QUEUE.maintenance} ${TASK}`)).toBe(calls.length - 1);
    expect(calls.indexOf(`work ${QUEUE.maintenance}`)).toBeLessThan(calls.length - 1);
  });

  test("once finished, is neither scheduled nor sent, and a schedule left over is removed", async () => {
    const { boss, sent } = fakeBoss();
    const unschedule = vi.fn(async () => {});
    (boss as unknown as { unschedule: typeof unschedule }).unschedule = unschedule;
    await startQueues(
      boss,
      deps({ reconvertPending: async () => false, reconvertDescriptions: async () => null }),
    );
    expect(sent).toEqual([]);
    expect(boss.schedule).not.toHaveBeenCalledWith(
      QUEUE.maintenance,
      RECONVERT_CRON,
      expect.anything(),
      expect.anything(),
    );
    expect(unschedule).toHaveBeenCalledWith(QUEUE.maintenance, TASK);
  });

  test("is not sent when the server gives no re-conversion", async () => {
    const { boss, sent } = fakeBoss();
    await startQueues(boss, deps({}));
    expect(sent).toEqual([]);
  });

  test("a start-up check that fails is logged and does not stop the queues", async () => {
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

  test("a run that finishes removes the schedule and sends no more", async () => {
    const { work, sent, unschedule } = await started({
      reconvertDescriptions: async () => ({ checked: 1 }),
    });
    await work([reconvertJob()]);
    expect(sent).toEqual([]);
    expect(unschedule).toHaveBeenCalledWith(QUEUE.maintenance, TASK);
  });

  test("a job that finds the step finished removes the schedule without running", async () => {
    let pending = true;
    const reconvertDescriptions = vi.fn(async () => RECONVERT_PAUSED);
    const { work, unschedule } = await started({
      reconvertPending: async () => pending,
      reconvertDescriptions,
    });
    pending = false;
    await work([reconvertJob()]);
    expect(reconvertDescriptions).not.toHaveBeenCalled();
    expect(unschedule).toHaveBeenCalledWith(QUEUE.maintenance, TASK);
  });

  test("a job that finds another run holding the step does nothing more (the lock)", async () => {
    const { work, sent, unschedule } = await started({ reconvertDescriptions: async () => null });
    await work([reconvertJob()]);
    expect(sent).toEqual([]);
    expect(unschedule).not.toHaveBeenCalled();
  });

  // Round 3: a run in slices inside the job's expiry.
  test("a run that paused goes on in a new maintenance job", async () => {
    const { work, sent } = await started();
    await work([reconvertJob()]);
    expect(sent).toEqual([JOB]);
  });

  test("tells the run to stop once its slice of the job's expiry is used", async () => {
    vi.useFakeTimers();
    try {
      const answers: boolean[] = [];
      const { work } = await started({
        reconvertDescriptions: async (stop: () => boolean) => {
          answers.push(stop());
          vi.advanceTimersByTime(RECONVERT_SLICE_SECONDS * 1000 - 1);
          answers.push(stop());
          vi.advanceTimersByTime(1);
          answers.push(stop());
          return RECONVERT_PAUSED;
        },
      });
      await work([reconvertJob()]);
      expect(answers).toEqual([false, false, true]);
      expect(RECONVERT_SLICE_SECONDS).toBeLessThanOrEqual(900 / 3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a job with a short expiry gets a third of it", async () => {
    vi.useFakeTimers();
    try {
      const answers: boolean[] = [];
      const { work } = await started({
        reconvertDescriptions: async (stop: () => boolean) => {
          vi.advanceTimersByTime(20_000 - 1);
          answers.push(stop());
          vi.advanceTimersByTime(1);
          answers.push(stop());
          return RECONVERT_PAUSED;
        },
      });
      await work([reconvertJob(undefined, 60)]);
      expect(answers).toEqual([false, true]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("aborts the run's signal once the job's signal aborts", async () => {
    const controller = new AbortController();
    const seen: boolean[] = [];
    const { work } = await started({
      reconvertDescriptions: async (_stop: () => boolean, signal: AbortSignal) => {
        seen.push(signal.aborted);
        controller.abort();
        seen.push(signal.aborted);
        return RECONVERT_PAUSED;
      },
    });
    await work([reconvertJob(controller.signal)]);
    expect(seen).toEqual([false, true]);
  });

  // #381: a stop while the re-conversion runs must end it at once, not at
  // pg-boss's 10 s limit, when it is counted as cut off and the process exits 1.
  test("the server's stop aborts the run in hand at once, and no next job is sent", async () => {
    const shutdown = new AbortController();
    let entered!: () => void;
    const inRun = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { work, sent } = await started({
      shutdown: shutdown.signal,
      // A run that only ever ends when told to, as one stuck on a read does.
      reconvertDescriptions: (_stop: () => boolean, signal: AbortSignal) =>
        new Promise((resolve) => {
          entered();
          signal.addEventListener("abort", () => resolve(RECONVERT_PAUSED), { once: true });
        }),
    });
    const handled = work([reconvertJob()]);
    await inRun;
    shutdown.abort();
    await expect(handled).resolves.toBeUndefined();
    expect(sent).toEqual([]);
  });

  test("a job that comes once the server is stopping does nothing", async () => {
    const shutdown = new AbortController();
    const reconvertDescriptions = vi.fn(async () => RECONVERT_PAUSED);
    const { work, sent } = await started({ shutdown: shutdown.signal, reconvertDescriptions });
    shutdown.abort();
    await work([reconvertJob()]);
    expect(reconvertDescriptions).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  test("an error once the stop began is the stop's, so it starts no back-off", async () => {
    const shutdown = new AbortController();
    let calls = 0;
    const { work } = await started({
      shutdown: shutdown.signal,
      reconvertDescriptions: async () => {
        calls += 1;
        if (calls === 1) {
          shutdown.abort();
          throw new Error("connection terminated by the stop");
        }
        return RECONVERT_PAUSED;
      },
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(work([reconvertJob()])).resolves.toBeUndefined();
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  // #382: an outage of the store or the database only delays it. The handler
  // never throws for one (pg-boss would retry at once, twice), and the jobs
  // that come in the back-off do nothing, so a store that is down is not
  // hammered; the schedule goes on asking.
  test("an outage never fails the job, and backs off 5, 10, 20, 40, then 60 minutes", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-21T00:00:00Z") });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let up = false;
      const reconvertDescriptions = vi.fn(async () => {
        if (!up) throw new Error("Storage is unavailable right now (GetObject: ECONNREFUSED)");
        return RECONVERT_PAUSED;
      });
      const { work, sent } = await started({ reconvertDescriptions });
      const runs = () => reconvertDescriptions.mock.calls.length;
      for (const minutes of [5, 10, 20, 40, 60, 60]) {
        const before = runs();
        await expect(work([reconvertJob()])).resolves.toBeUndefined();
        expect(runs()).toBe(before + 1);
        vi.advanceTimersByTime(minutes * 60_000 - 1);
        await work([reconvertJob()]); // within the back-off: nothing
        expect(runs()).toBe(before + 1);
        vi.advanceTimersByTime(1);
      }
      expect(sent).toEqual([]);
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("goes on in 5 minutes"));
      up = true;
      await work([reconvertJob()]);
      expect(sent).toEqual([JOB]);
      // A success ends the back-off: the next job runs at once.
      await work([reconvertJob()]);
      expect(runs()).toBe(8);
    } finally {
      logged.mockRestore();
      vi.useRealTimers();
    }
  });

  test("a database that is down when the job checks the step backs off too", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-21T00:00:00Z") });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let down = false;
      const reconvertDescriptions = vi.fn(async () => RECONVERT_PAUSED);
      const { work } = await started({
        reconvertPending: async () => {
          if (down) throw new Error("connect ECONNREFUSED");
          return true;
        },
        reconvertDescriptions,
      });
      down = true;
      await expect(work([reconvertJob()])).resolves.toBeUndefined();
      down = false;
      await work([reconvertJob()]);
      expect(reconvertDescriptions).not.toHaveBeenCalled();
      vi.advanceTimersByTime(5 * 60_000);
      await work([reconvertJob()]);
      expect(reconvertDescriptions).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
      vi.useRealTimers();
    }
  });

  test("a failed send of the next job is logged, and the schedule goes on", async () => {
    const { work, boss } = await started();
    (boss as unknown as { send: () => Promise<never> }).send = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(work([reconvertJob()])).resolves.toBeUndefined();
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("next re-conversion job"));
    } finally {
      logged.mockRestore();
    }
  });

  test("reconvertBackoffMs doubles from 5 minutes up to an hour", () => {
    expect([1, 2, 3, 4, 5, 6, 20].map((n) => reconvertBackoffMs(n) / 60_000)).toEqual([
      5, 10, 20, 40, 60, 60, 60,
    ]);
  });

  test("is not one of the fixed maintenance schedules", () => {
    expect(Object.values(MAINTENANCE_TASKS)).not.toContain(TASK);
  });
});
