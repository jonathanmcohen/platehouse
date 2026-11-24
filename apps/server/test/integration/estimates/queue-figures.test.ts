// The Settings queue figures (queueByPrinter) are counted by one SQL query over
// the slicer queue's queued jobs (issue #459), against Postgres 17. The query
// is held to slicesThrough, which stays the reference: over generated queues
// (slices for three printers, duplicate slices of one estimate at different
// priorities, renders with no printer, slices with no estimate, a job waiting
// out a retry) both must give every printer the same figure. Jobs are
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
const PLATES = 8;

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

/** Replaces every platehouse estimate with the given pending and running ones. */
async function seedEstimates(pending: string[], running: number): Promise<void> {
  await db.deleteFrom("estimates").execute();
  const rows = [
    ...pending.map((printerId) => ({ printerId, status: "pending" as const })),
    ...Array.from({ length: running }, () => ({
      printerId: PRINTERS[0] as string,
      status: "running" as const,
    })),
  ];
  for (const [i, row] of rows.entries()) {
    await db
      .insertInto("estimates")
      .values({
        id: uuidv7(),
        plateId: plateIds[i] as string,
        source: "platehouse",
        printerId: row.printerId,
        slicerVersion: null,
        status: row.status,
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
  const through = slicesThrough(work, running);
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
  await boss?.stop({ graceful: false });
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
      await seedEstimates(
        Array.from({ length: Math.floor(random() * 5) }, () => pick(PRINTERS)),
        Math.floor(random() * 3),
      );

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
    await seedEstimates([PRINTERS[0] as string], 0);
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
});
