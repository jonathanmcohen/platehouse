// Build plan Task 8: the pg-boss queues. ingest runs two at once, slicer is a
// singleton queue whose jobs Task 12 adds, and maintenance carries the cron
//   jobs: Task 14's purgeExpired daily at 03:30 local time (issue #38) and
// the orphan sweep daily at 04:00 local time (PR #49 review).
import { setTimeout as sleep } from "node:timers/promises";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { IngestInput, IngestResult } from "../../../src/ingest/ingest.js";
import { BOSS_SCHEMA, createBoss } from "../../../src/jobs/boss.js";
import {
  INGEST_CONCURRENCY,
  localTimeZone,
  MAINTENANCE_TASKS,
  PURGE_EXPIRED_CRON,
  QUEUE,
  SWEEP_ORPHANS_CRON,
  startQueues,
} from "../../../src/jobs/queues.js";
import { startTestPostgres, type TestPostgres } from "../support/db.js";

let pgc: TestPostgres;
let boss: PgBoss;
let dbUrl: string;
const purgeCalls: Date[] = [];
const sweepCalls: Date[] = [];
const ingestCalls: IngestInput[] = [];
let ingestImpl: (input: IngestInput) => Promise<IngestResult> = async () => ({
  modelId: "00000000-0000-7000-8000-000000000001",
  fileId: "00000000-0000-7000-8000-000000000002",
});

const deps = () => ({
  ingestFile: (input: IngestInput) => {
    ingestCalls.push(input);
    return ingestImpl(input);
  },
  purgeExpired: async (now: Date) => {
    purgeCalls.push(now);
    return { purged: [] };
  },
  sweepOrphans: async (now: Date) => {
    sweepCalls.push(now);
    return { listed: 0, deleted: 0, outsideLayout: 0 };
  },
  slicerConcurrency: 1,
  pollingIntervalSeconds: 0.5,
});

async function until<T>(read: () => Promise<T> | T, done: (v: T) => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error("timed out waiting for the job");
    await sleep(100);
  }
}

beforeAll(async () => {
  pgc = await startTestPostgres();
  const t = await pgc.freshDatabase();
  dbUrl = t.url;
  boss = createBoss({ databaseUrl: dbUrl });
  await boss.start();
  await startQueues(boss, deps());
});

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await pgc?.stop();
});

describe("queues", () => {
  test("pg-boss keeps its tables in the pgboss schema", () => {
    expect(BOSS_SCHEMA).toBe("pgboss");
  });

  test("the ingest, slicer and maintenance queues exist with their policies", async () => {
    const ingest = await boss.getQueue(QUEUE.ingest);
    const slicer = await boss.getQueue(QUEUE.slicer);
    const maintenance = await boss.getQueue(QUEUE.maintenance);
    expect(ingest?.policy).toBe("standard");
    expect(slicer?.policy).toBe("singleton");
    expect(maintenance?.policy).toBe("standard");
  });

  test("starting the queues again, as a restart does, changes nothing", async () => {
    // A second process on the same database, as after a restart.
    const again = createBoss({ databaseUrl: dbUrl });
    await again.start();
    try {
      await startQueues(again, deps());
    } finally {
      await again.stop({ graceful: false });
    }
    expect((await boss.getQueue(QUEUE.slicer))?.policy).toBe("singleton");
    expect((await boss.getQueue(QUEUE.ingest))?.retryLimit).toBe(0);
    expect(await boss.getSchedules(QUEUE.maintenance)).toHaveLength(2);
  });
});

describe("maintenance", () => {
  test("purgeExpired is scheduled daily at 03:30 local time", async () => {
    const schedules = await boss.getSchedules(QUEUE.maintenance);
    const purge = schedules.find((s) => s.key === MAINTENANCE_TASKS.purgeExpired);
    expect(purge).toMatchObject({
      name: QUEUE.maintenance,
      key: MAINTENANCE_TASKS.purgeExpired,
      cron: "30 3 * * *",
      timezone: localTimeZone(),
      data: { task: MAINTENANCE_TASKS.purgeExpired },
    });
    expect(PURGE_EXPIRED_CRON).toBe("30 3 * * *");
    expect(localTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  test("the orphan sweep is scheduled daily at 04:00 local time", async () => {
    const schedules = await boss.getSchedules(QUEUE.maintenance);
    expect(schedules.map((s) => s.key).sort()).toEqual(
      [MAINTENANCE_TASKS.purgeExpired, MAINTENANCE_TASKS.sweepOrphans].sort(),
    );
    const sweep = schedules.find((s) => s.key === MAINTENANCE_TASKS.sweepOrphans);
    expect(sweep).toMatchObject({
      name: QUEUE.maintenance,
      key: MAINTENANCE_TASKS.sweepOrphans,
      cron: "0 4 * * *",
      timezone: localTimeZone(),
      data: { task: MAINTENANCE_TASKS.sweepOrphans },
    });
    expect(SWEEP_ORPHANS_CRON).toBe("0 4 * * *");
  });

  test("a sweep-orphans job calls sweepOrphans with the time it ran", async () => {
    const before = sweepCalls.length;
    const sentAt = Date.now();
    await boss.send(QUEUE.maintenance, { task: MAINTENANCE_TASKS.sweepOrphans });
    await until(
      () => sweepCalls.length,
      (n) => n > before,
    );
    const now = sweepCalls[before];
    expect(now).toBeInstanceOf(Date);
    expect(now?.getTime()).toBeGreaterThanOrEqual(sentAt - 1000);
  });

  test("a purge-expired job calls purgeExpired with the time it ran", async () => {
    const before = purgeCalls.length;
    const sentAt = Date.now();
    await boss.send(QUEUE.maintenance, { task: MAINTENANCE_TASKS.purgeExpired });
    await until(
      () => purgeCalls.length,
      (n) => n > before,
    );
    const now = purgeCalls[before];
    expect(now).toBeInstanceOf(Date);
    expect(now?.getTime()).toBeGreaterThanOrEqual(sentAt - 1000);
  });

  test("an unknown maintenance task fails its job instead of passing silently", async () => {
    const id = await boss.send(QUEUE.maintenance, { task: "no-such-task" }, { retryLimit: 0 });
    if (id === null) throw new Error("job not created");
    const job = await until(
      () => boss.getJobById(QUEUE.maintenance, id),
      (j) => j?.state === "failed",
    );
    expect(JSON.stringify(job?.output)).toMatch(/no-such-task/);
  });
});

describe("ingest", () => {
  test("an ingest job runs ingestFile and keeps its result", async () => {
    const input: IngestInput = {
      tmpPath: "/data/tmp/uploads/synthetic-upload",
      originalName: "Queued.3mf",
      target: { batch: "batch-1", combine: true },
    };
    const id = await boss.send(QUEUE.ingest, input);
    if (id === null) throw new Error("job not created");
    const job = await until(
      () => boss.getJobById(QUEUE.ingest, id),
      (j) => j?.state === "completed",
    );
    expect(ingestCalls.at(-1)).toEqual(input);
    expect(job?.output).toEqual({
      modelId: "00000000-0000-7000-8000-000000000001",
      fileId: "00000000-0000-7000-8000-000000000002",
    });
  });

  test("a failed ingest is not retried: the upload fails visibly", async () => {
    ingestImpl = async () => {
      throw new Error("Storage is unavailable right now; nothing was saved");
    };
    try {
      const before = ingestCalls.length;
      const id = await boss.send(QUEUE.ingest, {
        tmpPath: "/data/tmp/uploads/failing",
        originalName: "Fails.stl",
        target: "new",
      });
      if (id === null) throw new Error("job not created");
      const job = await until(
        () => boss.getJobById(QUEUE.ingest, id),
        (j) => j?.state === "failed",
      );
      expect(JSON.stringify(job?.output)).toMatch(/nothing was saved/);
      await sleep(1500);
      expect(ingestCalls.length - before).toBe(1);
    } finally {
      ingestImpl = async () => ({
        modelId: "00000000-0000-7000-8000-000000000001",
        fileId: "00000000-0000-7000-8000-000000000002",
      });
    }
  });

  test(`ingest runs ${INGEST_CONCURRENCY} files at once`, async () => {
    expect(INGEST_CONCURRENCY).toBe(2);
    let running = 0;
    let peak = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    ingestImpl = async () => {
      running += 1;
      peak = Math.max(peak, running);
      if (running === INGEST_CONCURRENCY) release();
      await gate;
      running -= 1;
      return { modelId: "m", fileId: "f" };
    };
    try {
      const ids = await Promise.all(
        [1, 2, 3].map((n) =>
          boss.send(QUEUE.ingest, {
            tmpPath: `/data/tmp/uploads/parallel-${n}`,
            originalName: `Parallel ${n}.stl`,
            target: "new",
          }),
        ),
      );
      await Promise.race([
        gate,
        sleep(20_000).then(() => {
          throw new Error(`only ${peak} ingest job(s) ran at once`);
        }),
      ]);
      for (const id of ids) {
        if (id === null) throw new Error("job not created");
        await until(
          () => boss.getJobById(QUEUE.ingest, id),
          (j) => j?.state === "completed",
        );
      }
      expect(peak).toBe(INGEST_CONCURRENCY);
    } finally {
      ingestImpl = async () => ({
        modelId: "00000000-0000-7000-8000-000000000001",
        fileId: "00000000-0000-7000-8000-000000000002",
      });
    }
  });
});
