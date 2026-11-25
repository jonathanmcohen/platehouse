// The Settings queue figures (queueByPrinter) are counted by one SQL query over
// the slicer queue's queued jobs (issue #459), against Postgres 17. The query
// is held to slicesThrough, which stays the reference: over generated queues
// (slices for three printers, duplicate slices of one estimate at different
// priorities, renders with no printer, slices with no estimate or a malformed
// one, slices whose estimate is running, finished, failed or deleted, a job
// waiting out a retry) both must give every printer the same figure. Jobs are
// inserted delayed by an hour so that nothing runs them.
import { createHash, randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { uuidv7 } from "../../../src/db/ids.js";
import { migrate } from "../../../src/db/migrate.js";
import type { DB } from "../../../src/db/types.js";
import { createSlicerClient } from "../../../src/estimates/client.js";
import {
  createEstimates,
  type Estimates,
  type PrinterQueue,
  type QueuedWork,
  SLICE_JOB_KIND,
  slicesThrough,
} from "../../../src/estimates/service.js";
import { createBoss } from "../../../src/jobs/boss.js";
import { QUEUE, queueSettings } from "../../../src/jobs/queues.js";
import { createRepos } from "../../../src/repos/index.js";
import { startTestPostgres, type TestPostgres } from "../support/db.js";

const PRINTERS = ["Printer A", "Printer B", "Printer C"];
const CASES = 25;
const PLATES = 16;

let pgc: TestPostgres;
let db: Kysely<DB>;
let boss: PgBoss;
let estimates: Estimates;
const plateIds: string[] = [];

/** A small seeded generator (mulberry32), so a failing case can be replayed. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function addPlate(index: number): Promise<string> {
  const modelId = uuidv7();
  await db
    .insertInto("models")
    .values({ id: modelId, name: `Model ${index}` })
    .execute();
  const blobId = uuidv7();
  await db
    .insertInto("blobs")
    .values({
      id: blobId,
      modelId,
      key: `models/${modelId}/${blobId}`,
      kind: "source",
      contentType: "application/octet-stream",
      size: 10,
      sha256: createHash("sha256").update(blobId).digest(),
      state: "stored",
    })
    .execute();
  const fileId = uuidv7();
  await db
    .insertInto("files")
    .values({
      id: fileId,
      modelId,
      blobId,
      name: "Part.3mf",
      originalName: "Part.3mf",
      kind: "3mf",
      size: 10,
      sha256: createHash("sha256").update(fileId).digest(),
    })
    .execute();
  const plateId = uuidv7();
  await db.insertInto("plates").values({ id: plateId, fileId, index: 1, objectCount: 1 }).execute();
  return plateId;
}

type SeededStatus = "pending" | "running" | "ok" | "failed";

/**
 * Replaces every platehouse estimate with the given ones, each on its own
 * plate, which keeps the unique key (plate, source, printer, slicer version)
 * satisfied.
 */
async function seedEstimates(
  rows: Array<{ id?: string; printerId: string; status: SeededStatus }>,
): Promise<void> {
  await db.deleteFrom("estimates").execute();
  for (const [i, row] of rows.entries()) {
    await db
      .insertInto("estimates")
      .values({
        id: row.id ?? uuidv7(),
        plateId: plateIds[i] as string,
        source: "platehouse",
        printerId: row.printerId,
        slicerVersion: null,
        status: row.status,
        // The table's checks: a finished estimate has its figures, a failed one its reason.
        ...(row.status === "ok" ? { timeSeconds: 60, weightGrams: 1 } : {}),
        ...(row.status === "failed" ? { failureReason: "slicer_error" } : {}),
      })
      .execute();
  }
}

/** Every job in the slicer queue is gone; the queue itself stays. */
async function clearQueue(): Promise<void> {
  await sql`delete from pgboss.job where name = ${QUEUE.slicer}`.execute(db);
}

/** The reference: slicesThrough over the queued jobs as pg-boss lists them. */
async function expectedQueue(): Promise<Map<string, PrinterQueue>> {
  const jobs = await boss.findJobs<{ kind?: string; printerId?: unknown; estimateId?: unknown }>(
    QUEUE.slicer,
    { queued: true, limit: 100_000 },
  );
  const work: QueuedWork[] = jobs.map((job) => {
    const slice = job.data?.kind === SLICE_JOB_KIND;
    return {
      id: job.id,
      slice,
      ...(slice && typeof job.data.printerId === "string" ? { printerId: job.data.printerId } : {}),
      ...(slice && typeof job.data.estimateId === "string"
        ? { estimateId: job.data.estimateId }
        : {}),
      priority: job.priority,
      createdOn: new Date(job.createdOn),
    };
  });
  const running = (
    await db
      .selectFrom("estimates")
      .select(sql<number>`count(*)::int`.as("n"))
      .where("status", "=", "running")
      .executeTakeFirstOrThrow()
  ).n;
  const pendingRows = await db
    .selectFrom("estimates")
    .select("id")
    .where("status", "=", "pending")
    .execute();
  const pending = new Set(pendingRows.map((row) => row.id));
  const through = slicesThrough(work, running, pending);
  const waiting = await db
    .selectFrom("estimates")
    .select(["printerId", sql<number>`count(*)::int`.as("n")])
    .where("status", "in", ["pending", "running"])
    .groupBy("printerId")
    .execute();
  return new Map(
    waiting.map((r) => [
      r.printerId,
      { waiting: r.n, through: Math.max(through.get(r.printerId) ?? running, r.n) },
    ]),
  );
}

beforeAll(async () => {
  pgc = await startTestPostgres();
  const t = await pgc.freshDatabase();
  await migrate(t.db);
  db = t.db;
  boss = createBoss({ databaseUrl: t.url });
  await boss.start();
  await boss.createQueue(QUEUE.slicer, queueSettings().slicer.queue);
  // queueByPrinter never calls the slicer or the store.
  estimates = createEstimates({
    db,
    boss,
    slicer: createSlicerClient({ url: "http://127.0.0.1:9", plateSeconds: 5 }),
    store: {
      getBlobStream: async () => {
        throw new Error("the queue figures never read a file");
      },
    },
    log: () => undefined,
  });
  await createRepos(db).settings.savePrinters({
    printers: PRINTERS,
    defaultId: PRINTERS[0] as string,
  });
  for (let i = 0; i < PLATES; i += 1) plateIds.push(await addPlate(i));
});

afterAll(async () => {
  // Graceful, so work in flight ends before pg-boss closes (issue #490).
  await boss?.stop({ graceful: true, timeout: 20_000 });
  await pgc?.stop();
});

describe("queueByPrinter", () => {
  test("queue figures from SQL match slicesThrough", async () => {
    const random = seeded(459);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    let compared = 0;
    for (let n = 0; n < CASES; n += 1) {
      await clearQueue();
      const estimateIds = Array.from({ length: 5 }, () => randomUUID());
      const jobs = Array.from({ length: Math.floor(random() * 15) }, () => {
        const roll = random();
        const id = randomUUID();
        const priority = pick([-1, 0, 1]);
        if (roll < 0.25)
          return { id, priority, data: { kind: "synthetic-render", fileId: randomUUID() } };
        if (roll < 0.3)
          return { id, priority, data: { kind: SLICE_JOB_KIND, printerId: pick(PRINTERS) } };
        if (roll < 0.35)
          return {
            id,
            priority,
            data: { kind: SLICE_JOB_KIND, printerId: pick(PRINTERS), estimateId: "not-a-uuid" },
          };
        return {
          id,
          priority,
          data: { kind: SLICE_JOB_KIND, printerId: pick(PRINTERS), estimateId: pick(estimateIds) },
        };
      });
      if (jobs.length > 0) {
        await boss.insert(
          QUEUE.slicer,
          jobs.map((job) => ({ ...job, startAfter: 3600 })),
        );
        // A few distinct creation times, so ties fall to the id as well as to the time.
        for (const job of jobs) {
          await sql`
            update pgboss.job
               set created_on = timestamptz '2026-01-01 00:00:00+00' + ${Math.floor(random() * 4)} * interval '1 second'
             where name = ${QUEUE.slicer} and id = ${job.id}
          `.execute(db);
        }
        // One job is waiting out a retry.
        const retrying = pick(jobs);
        await sql`
          update pgboss.job set state = 'retry'
           where name = ${QUEUE.slicer} and id = ${retrying.id}
        `.execute(db);
      }
      // The jobs' estimates in every state, or deleted (no row) one time in five.
      const statuses: SeededStatus[] = ["pending", "running", "ok", "failed"];
      const jobEstimates = estimateIds.flatMap((estimateId) =>
        random() < 0.2
          ? []
          : [{ id: estimateId, printerId: pick(PRINTERS), status: pick(statuses) }],
      );
      const waiting = Array.from({ length: Math.floor(random() * 5) }, () => ({
        printerId: pick(PRINTERS),
        status: "pending" as const,
      }));
      const running = Array.from({ length: Math.floor(random() * 3) }, () => ({
        printerId: PRINTERS[0] as string,
        status: "running" as const,
      }));
      await seedEstimates([...jobEstimates, ...waiting, ...running]);

      const expected = await expectedQueue();
      const actual = await estimates.queueByPrinter();
      expect(Object.fromEntries(actual), `case ${n}`).toEqual(Object.fromEntries(expected));
      compared += expected.size;
    }
    await clearQueue();
    // The generated queues gave the comparison something to compare.
    expect(compared).toBeGreaterThan(10);
  });

  test("reads no job rows into memory", async () => {
    await clearQueue();
    await seedEstimates([{ printerId: PRINTERS[0] as string, status: "pending" }]);
    await boss.insert(QUEUE.slicer, [
      {
        data: { kind: SLICE_JOB_KIND, printerId: PRINTERS[0], estimateId: randomUUID() },
        startAfter: 3600,
      },
    ]);
    const findJobs = vi.spyOn(boss, "findJobs").mockRejectedValue(new Error("findJobs was called"));
    try {
      const queue = await estimates.queueByPrinter();
      expect(queue.get(PRINTERS[0] as string)).toEqual({ waiting: 1, through: 1 });
      expect(findJobs).not.toHaveBeenCalled();
    } finally {
      findJobs.mockRestore();
      await clearQueue();
    }
  });

  test("a finished estimate's leftover job, a running estimate's queued copy and a malformed job take no place", async () => {
    await clearQueue();
    const [A, B] = PRINTERS as [string, string];
    const R = uuidv7();
    const F = uuidv7();
    const P1 = uuidv7();
    const P2 = uuidv7();
    await seedEstimates([
      { id: R, printerId: A, status: "running" },
      { id: F, printerId: A, status: "ok" },
      { id: P1, printerId: A, status: "pending" },
      { id: P2, printerId: B, status: "pending" },
    ]);
    const slice = (estimateId?: unknown) => ({
      kind: SLICE_JOB_KIND,
      printerId: A,
      ...(estimateId === undefined ? {} : { estimateId }),
    });
    await boss.insert(QUEUE.slicer, [
      // Ahead of everything: one render, which takes a place, and six slices that do not.
      { data: { kind: "synthetic-render" }, priority: 1, startAfter: 3600 },
      { data: slice(F), priority: 1, startAfter: 3600 },
      { data: slice(R), priority: 1, startAfter: 3600 },
      { data: slice("not-a-uuid"), priority: 1, startAfter: 3600 },
      { data: slice(42), priority: 1, startAfter: 3600 },
      { data: slice(), priority: 1, startAfter: 3600 },
      { data: slice(randomUUID()), priority: 1, startAfter: 3600 },
      {
        data: { kind: SLICE_JOB_KIND, printerId: A, estimateId: P1 },
        priority: 0,
        startAfter: 3600,
      },
      {
        data: { kind: SLICE_JOB_KIND, printerId: B, estimateId: P2 },
        priority: -1,
        startAfter: 3600,
      },
    ]);
    try {
      const actual = Object.fromEntries(await estimates.queueByPrinter());
      expect(actual).toEqual({
        [A]: { waiting: 2, through: 3 },
        [B]: { waiting: 1, through: 4 },
      });
      expect(actual).toEqual(Object.fromEntries(await expectedQueue()));
    } finally {
      await clearQueue();
    }
  });
});
