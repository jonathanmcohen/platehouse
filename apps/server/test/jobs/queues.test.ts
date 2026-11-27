// What each queue is created and worked with. The slicer
// queue is a singleton queue, so one slice runs at a time (the maintainer, 2026-11-08,
// PR #49: there is no SLICER_CONCURRENCY); the estimates module adds its jobs and its
// worker with these settings. A slicer job is retried by pg-boss's own retry
// settings, three times with backoff, not by a loop in the handler.
import type { PgBoss } from "pg-boss";
import { describe, expect, test, vi } from "vitest";
import {
  BACKFILL_PREVIEWS_CRON,
  INGEST_CONCURRENCY,
  INGEST_EXPIRE_SECONDS,
  MAINTENANCE_TASKS,
  ON_DEMAND_TASKS,
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

  // Issue #441: pg-boss's default expiry, 15 minutes, marked a long import
  // failed while it carried on and stored the model.
  test("an ingest job may run for an hour before pg-boss expires it", () => {
    expect(INGEST_EXPIRE_SECONDS).toBe(3600);
    expect(queueSettings().ingest.queue).toMatchObject({ expireInSeconds: 3600 });
  });

  test("the upgrade queue is stately, never retried and worked one job at a time", () => {
    expect(QUEUE.upgrade).toBe("upgrade");
    expect(queueSettings().upgrade).toEqual({
      name: "upgrade",
      queue: { policy: "stately", retryLimit: 0 },
      work: { localConcurrency: 1 },
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
  const unscheduled: Array<{ name: string; key: string }> = [];
  const scheduled: Array<{ name: string; task: string }> = [];
  const sent: Array<{ name: string; data: { task: string }; options: unknown }> = [];
  const handlers = new Map<string, (jobs: unknown[]) => unknown>();
  const boss = {
    createQueue: vi.fn(async () => {}),
    updateQueue: vi.fn(async () => {}),
    schedule: vi.fn(async (name: string, _cron: string, data: { task: string }) => {
      calls.push(`schedule ${data.task}`);
      scheduled.push({ name, task: data.task });
    }),
    unschedule: vi.fn(async (name: string, key: string) => {
      calls.push(`unschedule ${key}`);
      unscheduled.push({ name, key });
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
  return { boss: boss as unknown as PgBoss, calls, sent, scheduled, unscheduled, handlers };
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
  test("applies the ingest expiry on every start, so a queue made before it gets it too", async () => {
    const { boss } = fakeBoss();
    await startQueues(boss, deps({}));
    expect(boss.updateQueue).toHaveBeenCalledWith(QUEUE.ingest, { expireInSeconds: 3600 });
    // The slicer queue keeps its retry settings alone; its jobs set their own expiry.
    expect(boss.updateQueue).toHaveBeenCalledWith(QUEUE.slicer, { ...SLICER_RETRY });
  });

  test("sends one Orca poll job at startup instead of running it", async () => {
    const { boss, calls, sent } = fakeBoss();
    const pollOrca = vi.fn(async () => {});
    await startQueues(boss, deps({ pollOrca }));
    expect(pollOrca).not.toHaveBeenCalled();
    expect(boss.send).toHaveBeenCalledWith(
      QUEUE.maintenance,
      { task: MAINTENANCE_TASKS.pollOrca },
      expect.anything(),
    );
    expect(sent.filter((s) => s.data.task === MAINTENANCE_TASKS.pollOrca)).toHaveLength(1);
    // After its schedule and the workers, so the slices it queues are worked at once.
    expect(
      calls.indexOf(`send ${QUEUE.maintenance} ${MAINTENANCE_TASKS.pollOrca}`),
    ).toBeGreaterThan(calls.indexOf(`work ${QUEUE.maintenance}`));
    expect(calls).toContain(`schedule ${MAINTENANCE_TASKS.pollOrca}`);
  });

  test("a startup poll job that cannot be sent is logged and does not stop the queues", async () => {
    const { boss } = fakeBoss();
    (boss as unknown as { send: () => Promise<never> }).send = async () => {
      throw new Error("connect ECONNREFUSED");
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(startQueues(boss, deps({ pollOrca: async () => {} }))).resolves.toBeUndefined();
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("startup Orca poll"));
    } finally {
      logged.mockRestore();
    }
  });

  // Issue #316: the preview backfill is scheduled every 5 minutes, one batch
  // a run, and also runs once at startup, after the workers start, so a
  // restart starts the first batch at once.
  test("schedules the preview backfill every 5 minutes and runs it once at startup, after the workers", async () => {
    const { boss, calls } = fakeBoss();
    const backfillPreviews = vi.fn(async (_now: Date) => {
      calls.push("backfillPreviews");
    });
    await startQueues(boss, deps({ backfillPreviews }));
    expect(backfillPreviews).toHaveBeenCalledTimes(1);
    expect(calls).toContain(`schedule ${MAINTENANCE_TASKS.backfillPreviews}`);
    expect(calls.indexOf("backfillPreviews")).toBeGreaterThan(
      calls.indexOf(`work ${QUEUE.maintenance}`),
    );
    expect(BACKFILL_PREVIEWS_CRON).toBe("*/5 * * * *");
    const scheduled = (boss.schedule as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[2] as { task: string }).task === MAINTENANCE_TASKS.backfillPreviews,
    );
    expect(scheduled?.[1]).toBe(BACKFILL_PREVIEWS_CRON);
  });

  test("a startup backfill that fails is logged and does not stop the queues", async () => {
    const { boss } = fakeBoss();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        startQueues(
          boss,
          deps({
            backfillPreviews: async () => {
              throw new Error("connect ECONNREFUSED");
            },
          }),
        ),
      ).resolves.toBeUndefined();
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("startup preview backfill"));
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

// The sandbox requeue (#480) runs after every preview backfill, and a failure
// of either never hides the other's.
describe("the sandbox requeue after the preview backfill (#480)", () => {
  const backfillJob = { data: { task: MAINTENANCE_TASKS.backfillPreviews } };

  async function maintenance(over: Partial<QueueDeps>) {
    const fake = fakeBoss();
    await startQueues(fake.boss, deps(over));
    const work = fake.handlers.get(QUEUE.maintenance);
    if (work === undefined) throw new Error("no worker");
    return work;
  }

  test("startQueues runs the requeue after the startup backfill", async () => {
    const { boss } = fakeBoss();
    const order: string[] = [];
    await startQueues(
      boss,
      deps({
        backfillPreviews: async () => {
          order.push("backfill");
        },
        requeueSandboxOff: async () => {
          order.push("requeue");
        },
      }),
    );
    expect(order).toEqual(["backfill", "requeue"]);
  });

  test("a startup requeue that throws is logged and does not stop the queues", async () => {
    const { boss } = fakeBoss();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        startQueues(
          boss,
          deps({
            backfillPreviews: async () => undefined,
            requeueSandboxOff: async () => {
              throw new Error("db gone");
            },
          }),
        ),
      ).resolves.toBeUndefined();
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("startup sandbox requeue"));
    } finally {
      logged.mockRestore();
    }
  });

  test("the maintenance handler for backfill-previews calls both", async () => {
    const backfillPreviews = vi.fn(async (_now: Date) => undefined);
    const requeueSandboxOff = vi.fn(async (_now: Date) => undefined);
    const work = await maintenance({ backfillPreviews, requeueSandboxOff });
    backfillPreviews.mockClear();
    requeueSandboxOff.mockClear();
    await work([backfillJob]);
    expect(backfillPreviews).toHaveBeenCalledTimes(1);
    expect(requeueSandboxOff).toHaveBeenCalledTimes(1);
  });

  test("a backfill that throws still runs the requeue, and the handler rejects with the backfill's error", async () => {
    let failing = false;
    const requeueSandboxOff = vi.fn(async (_now: Date) => undefined);
    const work = await maintenance({
      backfillPreviews: async () => {
        if (failing) throw new Error("backfill broke");
      },
      requeueSandboxOff,
    });
    requeueSandboxOff.mockClear();
    failing = true;
    await expect(work([backfillJob])).rejects.toThrow("backfill broke");
    expect(requeueSandboxOff).toHaveBeenCalledTimes(1);
  });

  test("a requeue that throws after a good backfill is logged and the handler resolves", async () => {
    let failing = false;
    const work = await maintenance({
      backfillPreviews: async () => undefined,
      requeueSandboxOff: async () => {
        if (failing) throw new Error("requeue broke");
      },
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      failing = true;
      await expect(work([backfillJob])).resolves.toBeUndefined();
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("queues: sandbox requeue:"));
    } finally {
      logged.mockRestore();
    }
  });

  test("a backfill error is not replaced by a requeue error", async () => {
    let failing = false;
    const work = await maintenance({
      backfillPreviews: async () => {
        if (failing) throw new Error("backfill broke");
      },
      requeueSandboxOff: async () => {
        if (failing) throw new Error("requeue broke");
      },
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      failing = true;
      await expect(work([backfillJob])).rejects.toThrow("backfill broke");
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("queues: sandbox requeue:"));
    } finally {
      logged.mockRestore();
    }
  });
});

// The description re-conversion (#357) is a one-time step on upgrade, not a
// schedule: startQueues sends it to the upgrade queue once the workers
// are up, only while it has not finished, and the upgrade worker runs it.
// The description re-conversion on upgrade (#357). Its lifecycle as a whole is
// checked by the seeded simulation in test/library/reconvert-lifecycle.test.ts;
// these are the named cases from the review rounds and issues #381 and #382.
describe("the description re-conversion on upgrade", () => {
  const TASK = UPGRADE_TASKS.reconvertDescriptions;
  const JOB = { name: QUEUE.upgrade, data: { task: TASK }, options: { retryLimit: 0 } };

  /** A job for the re-conversion, as pg-boss hands it to the upgrade worker. */
  function reconvertJob(signal = new AbortController().signal, expireInSeconds = 900) {
    return { data: { task: TASK }, signal, expireInSeconds };
  }

  /** Starts the queues with a re-conversion, and gives the upgrade and maintenance workers. */
  async function started(over: Partial<QueueDeps> = {}) {
    const fake = fakeBoss();
    const unschedule = (fake.boss as unknown as { unschedule: ReturnType<typeof vi.fn> })
      .unschedule;
    await startQueues(
      fake.boss,
      deps({
        reconvertPending: async () => true,
        reconvertDescriptions: async () => RECONVERT_PAUSED,
        ...over,
      }),
    );
    const work = fake.handlers.get(QUEUE.upgrade);
    const maintenanceWork = fake.handlers.get(QUEUE.maintenance);
    if (work === undefined || maintenanceWork === undefined) throw new Error("no worker");
    fake.sent.length = 0;
    fake.calls.length = 0;
    fake.unscheduled.length = 0;
    unschedule.mockClear();
    return { ...fake, unschedule, work, maintenanceWork };
  }

  test("while pending, is scheduled every 5 minutes and sent at once, with no pg-boss retry", async () => {
    const { boss, calls, sent } = fakeBoss();
    await startQueues(
      boss,
      deps({ reconvertPending: async () => true, reconvertDescriptions: async () => null }),
    );
    expect(RECONVERT_CRON).toBe("*/5 * * * *");
    expect(boss.schedule).toHaveBeenCalledWith(
      QUEUE.upgrade,
      RECONVERT_CRON,
      { task: TASK },
      {
        tz: "UTC",
        key: TASK,
        retryLimit: 0,
      },
    );
    expect(sent).toEqual([JOB]);
    expect(calls.indexOf(`send ${QUEUE.upgrade} ${TASK}`)).toBe(calls.length - 1);
    expect(calls.indexOf(`work ${QUEUE.upgrade}`)).toBeLessThan(calls.length - 1);
  });

  test("once finished, is neither scheduled nor sent, and a schedule left over is removed", async () => {
    const { boss, sent, scheduled, unscheduled } = fakeBoss();
    await startQueues(
      boss,
      deps({ reconvertPending: async () => false, reconvertDescriptions: async () => null }),
    );
    expect(sent).toEqual([]);
    expect(scheduled.filter((s) => s.task === TASK)).toEqual([]);
    expect(sent.filter((s) => s.name === QUEUE.upgrade)).toEqual([]);
    expect(unscheduled).toContainEqual({ name: QUEUE.upgrade, key: TASK });
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
    expect(unschedule).toHaveBeenCalledWith(QUEUE.upgrade, TASK);
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
    expect(unschedule).toHaveBeenCalledWith(QUEUE.upgrade, TASK);
  });

  test("a job that finds another run holding the step does nothing more (the lock)", async () => {
    const { work, sent, unschedule } = await started({ reconvertDescriptions: async () => null });
    await work([reconvertJob()]);
    expect(sent).toEqual([]);
    expect(unschedule).not.toHaveBeenCalled();
  });

  // Round 3: a run in slices inside the job's expiry.
  test("a paused slice goes on in a new upgrade job", async () => {
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

  test("the upgrade queue is created stately and worked one job at a time", async () => {
    const { boss, calls } = fakeBoss();
    await startQueues(boss, deps({}));
    expect(boss.createQueue).toHaveBeenCalledWith(
      QUEUE.upgrade,
      expect.objectContaining({ policy: "stately" }),
    );
    expect(boss.work).toHaveBeenCalledWith(
      QUEUE.upgrade,
      expect.objectContaining({ localConcurrency: 1 }),
      expect.any(Function),
    );
    expect(calls).toContain(`work ${QUEUE.upgrade}`);
  });

  test("is scheduled and sent on the upgrade queue, never on maintenance", async () => {
    const { boss, sent, scheduled } = fakeBoss();
    await startQueues(
      boss,
      deps({ reconvertPending: async () => true, reconvertDescriptions: async () => null }),
    );
    expect(scheduled.filter((s) => s.task === TASK)).toEqual([{ name: QUEUE.upgrade, task: TASK }]);
    expect(sent.filter((s) => s.data.task === TASK).map((s) => s.name)).toEqual([QUEUE.upgrade]);
  });

  test.each([true, false])(
    "start-up removes the old maintenance schedule for it (pending: %s)",
    async (pending) => {
      const { boss, unscheduled } = fakeBoss();
      await startQueues(
        boss,
        deps({ reconvertPending: async () => pending, reconvertDescriptions: async () => null }),
      );
      expect(unscheduled).toContainEqual({ name: QUEUE.maintenance, key: TASK });
    },
  );

  test("start-up carries on when there is no old maintenance schedule to remove", async () => {
    const { boss, sent } = fakeBoss();
    (boss as unknown as { unschedule: () => Promise<never> }).unschedule = async () => {
      throw new Error("Schedule not found");
    };
    await expect(
      startQueues(
        boss,
        deps({ reconvertPending: async () => true, reconvertDescriptions: async () => null }),
      ),
    ).resolves.toBeUndefined();
    expect(sent.map((s) => s.name)).toEqual([QUEUE.upgrade]);
  });

  test("a job left on the maintenance queue ends at once without a slice, and the run goes on on upgrade", async () => {
    const reconvertDescriptions = vi.fn(async () => RECONVERT_PAUSED);
    const { maintenanceWork, sent } = await started({ reconvertDescriptions });
    await maintenanceWork([{ data: { task: TASK } }]);
    expect(reconvertDescriptions).not.toHaveBeenCalled();
    expect(sent).toEqual([JOB]);
  });

  test("a job left on the maintenance queue sends nothing once the step has finished", async () => {
    let pending = true;
    const reconvertDescriptions = vi.fn(async () => RECONVERT_PAUSED);
    const { maintenanceWork, sent } = await started({
      reconvertPending: async () => pending,
      reconvertDescriptions,
    });
    pending = false;
    await maintenanceWork([{ data: { task: TASK } }]);
    expect(reconvertDescriptions).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  test("when finished, nothing is scheduled or sent on upgrade, and its schedule is removed", async () => {
    const { boss, sent, scheduled, unscheduled } = fakeBoss();
    await startQueues(
      boss,
      deps({ reconvertPending: async () => false, reconvertDescriptions: async () => null }),
    );
    expect(scheduled.some((s) => s.name === QUEUE.upgrade)).toBe(false);
    expect(sent.some((s) => s.name === QUEUE.upgrade)).toBe(false);
    expect(unscheduled).toContainEqual({ name: QUEUE.upgrade, key: TASK });
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

describe("Empty trash on the maintenance queue", () => {
  const TASK = ON_DEMAND_TASKS.emptyTrash;

  /** Starts the queues and gives the maintenance worker. */
  async function maintenanceWorker(over: Partial<QueueDeps> = {}) {
    const fake = fakeBoss();
    await startQueues(fake.boss, deps(over));
    const work = fake.handlers.get(QUEUE.maintenance);
    if (work === undefined) throw new Error("no maintenance worker");
    return { ...fake, work };
  }

  test("is sent by a request and never scheduled", async () => {
    expect(TASK).toBe("empty-trash");
    expect(Object.values(MAINTENANCE_TASKS)).not.toContain(TASK);
    const { scheduled } = await maintenanceWorker({ emptyTrash: async () => undefined });
    expect(scheduled.map((s) => s.task)).not.toContain(TASK);
  });

  test("runs the registered Empty trash with a signal that is not aborted", async () => {
    const seen: boolean[] = [];
    const { work } = await maintenanceWorker({
      emptyTrash: async (signal: AbortSignal) => {
        seen.push(signal.aborted);
      },
    });
    await work([{ data: { task: TASK }, signal: new AbortController().signal }]);
    expect(seen).toEqual([false]);
  });

  test("aborts the run's signal once the job's signal aborts", async () => {
    const job = new AbortController();
    const seen: boolean[] = [];
    const { work } = await maintenanceWorker({
      emptyTrash: async (signal: AbortSignal) => {
        seen.push(signal.aborted);
        job.abort();
        seen.push(signal.aborted);
      },
    });
    await work([{ data: { task: TASK }, signal: job.signal }]);
    expect(seen).toEqual([false, true]);
  });

  test("the server's stop aborts the run's signal", async () => {
    const shutdown = new AbortController();
    const seen: boolean[] = [];
    const { work } = await maintenanceWorker({
      shutdown: shutdown.signal,
      emptyTrash: async (signal: AbortSignal) => {
        seen.push(signal.aborted);
        shutdown.abort();
        seen.push(signal.aborted);
      },
    });
    await work([{ data: { task: TASK }, signal: new AbortController().signal }]);
    expect(seen).toEqual([false, true]);
  });

  test("a failed run fails the job", async () => {
    const { work } = await maintenanceWorker({
      emptyTrash: async () => {
        throw new Error("1 model could not be purged");
      },
    });
    await expect(
      work([{ data: { task: TASK }, signal: new AbortController().signal }]),
    ).rejects.toThrow("1 model could not be purged");
  });

  test("with no Empty trash registered, the job fails", async () => {
    const { work } = await maintenanceWorker();
    await expect(
      work([{ data: { task: TASK }, signal: new AbortController().signal }]),
    ).rejects.toThrow("No Empty trash is registered");
  });
});
