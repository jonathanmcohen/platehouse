// Build plan Task 12: estimates, the printer setting and re-estimation
// (AC-031 to AC-034, AC-036; Review Focus 2 and 3). Files come in through
// the real ingest queue into a migrated Postgres 17 and the S3 test server;
// slices go to a slicer stub built on the slicer contract package
// (test/support/slicer-stub.ts), so every answer it gives is one contract v1
// allows. pg-boss runs on the same database with the queue settings the app
// uses, except that retries wait about a second instead of 10 s and more.
// Every file is synthetic.
import { setTimeout as sleep } from "node:timers/promises";
import { sql } from "kysely";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createSlicerClient, type SlicerClient } from "../../../src/estimates/client.js";
import {
  createEstimates,
  type Estimates,
  SLICER_DOWN_DETAIL,
  STORE_DOWN_DETAIL,
  UnknownPrinter,
} from "../../../src/estimates/service.js";
import type { IngestInput, IngestResult } from "../../../src/ingest/ingest.js";
import { createBoss } from "../../../src/jobs/boss.js";
import { MAINTENANCE_TASKS, QUEUE, startQueues } from "../../../src/jobs/queues.js";
import { StoreUnavailable } from "../../../src/storage/s3.js";
import { type SlicerStub, STUB_PRINTERS, startSlicerStub } from "../../support/slicer-stub.js";
import {
  build3mf,
  type IngestEnv,
  startIngestEnv,
  type ThreeMfSpec,
  writeUpload,
} from "../support/ingest.js";

const P1S = "Bambu Lab P1S 0.4 nozzle";
const X1C = "Bambu Lab X1 Carbon 0.4 nozzle";
const A1 = "Bambu Lab A1 0.4 nozzle";

let env: IngestEnv;
let stub: SlicerStub;
let boss: PgBoss;
let slicer: SlicerClient;
let estimates: Estimates;
/** The service's log lines. */
const logs: string[] = [];
/** While true, every read of a stored file fails as a store outage does. */
let storeDown = false;

async function until<T>(read: () => Promise<T> | T, done: (v: T) => boolean, ms = 45_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error(`timed out; last value ${JSON.stringify(value)}`);
    await sleep(100);
  }
}

/** Estimates still waiting or slicing. */
async function inFlight(): Promise<number> {
  const { rows } = await sql<{ n: number }>`
    select count(*)::int as n from estimates where status in ('pending', 'running')
  `.execute(env.db);
  return rows[0]?.n ?? -1;
}

/** Waits until the slicer queue has drained: no estimate is pending or running. */
async function drain(): Promise<void> {
  await until(inFlight, (n) => n === 0);
  await sleep(300);
  await until(inFlight, (n) => n === 0);
}

/** Uploads a synthetic .3mf through the ingest queue and returns its plates. */
async function upload(spec: ThreeMfSpec) {
  const tmpPath = await writeUpload(env, build3mf(spec));
  const input: IngestInput = { tmpPath, originalName: "Synthetic.3mf", target: "new" };
  const id = await boss.send(QUEUE.ingest, input);
  if (id === null) throw new Error("ingest job not created");
  const job = await until(
    () => boss.getJobById<IngestInput>(QUEUE.ingest, id),
    (j) => j?.state === "completed" || j?.state === "failed",
  );
  if (job?.state !== "completed") throw new Error(`ingest failed: ${JSON.stringify(job?.output)}`);
  const result = job.output as IngestResult;
  const plates = await env.repos.plates.listForFile(result.fileId);
  return { ...result, plates };
}

function plateId(plates: Array<{ id: string; index: number }>, index: number): string {
  const plate = plates.find((p) => p.index === index);
  if (!plate) throw new Error(`no plate ${index}`);
  return plate.id;
}

async function platehouseRows(id: string) {
  return env.db
    .selectFrom("estimates")
    .selectAll()
    .where("plateId", "=", id)
    .where("source", "=", "platehouse")
    .orderBy("createdAt")
    .execute();
}

beforeAll(async () => {
  env = await startIngestEnv();
  stub = await startSlicerStub();
  boss = createBoss({ databaseUrl: env.url });
  await boss.start();
  slicer = createSlicerClient({ url: stub.url, plateSeconds: 5 });
  estimates = createEstimates({
    db: env.db,
    boss,
    slicer,
    store: {
      getBlobStream: (key) =>
        storeDown
          ? Promise.reject(new StoreUnavailable("GetObject", "test outage"))
          : env.store.getBlobStream(key),
    },
    // The app's retry settings (SLICER_RETRY: 3 retries, backoff) with a
    // one-second delay, so the retry tests take seconds, not minutes.
    jobOptions: { retryDelay: 1, retryDelayMax: 1 },
    // And a slicer or store that is down is waited for 2 s per job, not
    // 30 s, with the app's 3 requeues before the plate fails.
    slicerDown: { waitMs: 2_000, pollMs: 100, requeues: 3 },
    log: (line) => logs.push(line),
  });
  await startQueues(boss, {
    ingestFile: (input) => env.ingest.ingestFile(input),
    purgeExpired: async () => ({ purged: [] }),
    sweepOrphans: async () => ({ listed: 0, deleted: 0, outsideLayout: 0 }),
    slicerJobs: estimates.slicerJobs,
    pollOrca: () => estimates.pollOrca(),
    onIngested: (result) => estimates.enqueueFile(result.fileId),
    pollingIntervalSeconds: 0.5,
  });
  // startQueues has run the Orca poll once, as at app startup.
  expect((await env.repos.settings.get()).lastOrcaVersion).toBe("2.5.0");
});

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await stub?.stop();
  await env?.stop();
});

beforeEach(async () => {
  stub.onSlice(() => ({ kind: "ok" }));
  storeDown = false;
  await drain();
  if ((await env.repos.settings.get()).printerId !== P1S) {
    await estimates.setPrinter(P1S);
    await drain();
  }
});

describe("the printer setting", () => {
  test("printer menu equals the slicer profile list", async () => {
    const printers = await estimates.listPrinters();
    expect(printers).toEqual((await slicer.profiles()).printers);
    expect(printers).toEqual(STUB_PRINTERS);
    // The default is the P1S with a 0.4 mm nozzle (AC-031).
    expect((await env.repos.settings.get()).printerId).toBe(P1S);
  });

  test("the printer list is read from the slicer once per Orca version", async () => {
    const before = stub.profileRequests;
    await estimates.listPrinters();
    await estimates.listPrinters();
    expect(stub.profileRequests - before).toBeLessThanOrEqual(1);
  });

  test("a printer that is not in the menu is refused and the setting stays", async () => {
    await expect(estimates.setPrinter("Bambu Lab Q9 0.4 nozzle")).rejects.toBeInstanceOf(
      UnknownPrinter,
    );
    expect((await env.repos.settings.get()).printerId).toBe(P1S);
  });

  test("the slicer queue retries 3 times with backoff and the Orca poll is on a 10-minute schedule", async () => {
    const queue = await boss.getQueue(QUEUE.slicer);
    expect(queue).toMatchObject({ policy: "singleton", retryLimit: 3, retryBackoff: true });
    const poll = (await boss.getSchedules(QUEUE.maintenance)).find(
      (s) => s.key === MAINTENANCE_TASKS.pollOrca,
    );
    expect(poll).toMatchObject({
      cron: "*/10 * * * *",
      data: { task: MAINTENANCE_TASKS.pollOrca },
    });
  });
});

describe("estimates", () => {
  test("file numbers for the selected printer suppress a Platehouse estimate", async () => {
    // Sliced in Bambu Studio for a P1S 0.4 (BBL C12), and P1S 0.4 is selected.
    const { plates } = await upload({ plates: 2, sliced: [1, 2], printerModelId: "C12" });
    await drain();
    for (const plate of plates) {
      expect(await platehouseRows(plate.id)).toEqual([]);
      const numbers = await estimates.plateNumbers(plate.id);
      expect(numbers.platehouse).toBeUndefined();
      expect(numbers.failure).toBeUndefined();
      expect(numbers.file).toMatchObject({
        source: "file",
        printerId: P1S,
        timeSeconds: 1000 * plate.index,
        weightGrams: 10 * plate.index + 0.5,
      });
    }
  });

  test("a file sliced for X1C on P1S shows Bambu numbers labelled X1C plus a P1S estimate", async () => {
    const { plates } = await upload({ plates: 1, sliced: [1], printerModelId: "BL-P001" });
    await drain();
    const numbers = await estimates.plateNumbers(plateId(plates, 1));
    expect(numbers.file).toMatchObject({
      source: "file",
      printerId: X1C,
      printerLabel: X1C,
      timeSeconds: 1000,
      weightGrams: 10.5,
    });
    expect(numbers.platehouse).toMatchObject({
      source: "platehouse",
      state: "current",
      printerId: P1S,
      slicer: "OrcaSlicer",
      slicerVersion: "2.5.0",
      processProfile: "0.20mm Standard @BBL X1C",
      timeSeconds: 600,
    });
    expect(numbers.platehouse?.staleFor).toBeUndefined();
    // Which preset produced each filament's numbers (AC-032, PR #55).
    expect(numbers.platehouse?.filaments).toEqual([
      expect.objectContaining({
        slot: 1,
        type: "PLA",
        profile: "Bambu PLA Basic @BBL P1S",
        profileSource: "bambu",
      }),
      expect.objectContaining({
        slot: 2,
        type: "PETG",
        profile: "Generic PETG @BBL P1S",
        profileSource: "generic",
      }),
    ]);
  });

  test("each filament's preset and its source are stored with the Platehouse numbers", async () => {
    const { plates } = await upload({ plates: 1 });
    await drain();
    const [row] = await platehouseRows(plateId(plates, 1));
    if (!row) throw new Error("no estimate");
    expect(row).toMatchObject({ status: "ok", slicerVersion: "2.5.0", printerId: P1S });
    const { rows } = await sql<{ slot: number; profile: string | null; source: string | null }>`
      select slot, profile, profile_source as source from estimate_filaments
      where estimate_id = ${row.id} order by slot
    `.execute(env.db);
    expect(rows).toEqual([
      { slot: 1, profile: "Bambu PLA Basic @BBL P1S", source: "bambu" },
      { slot: 2, profile: "Generic PETG @BBL P1S", source: "generic" },
    ]);
  });

  test("a filament with no preset for the printer is labelled as the file's own", async () => {
    await estimates.setPrinter(A1);
    const { plates } = await upload({ plates: 1 });
    await drain();
    const numbers = await estimates.plateNumbers(plateId(plates, 1));
    expect(numbers.platehouse).toMatchObject({ state: "current", printerId: A1 });
    expect(numbers.platehouse?.filaments.map((f) => [f.profile, f.profileSource])).toEqual([
      ["Generic PLA @BBL A1", "generic"],
      [null, "file"],
    ]);
  });

  test("old estimate stays visible marked for the previous printer until the new one lands", async () => {
    const { plates } = await upload({ plates: 1 });
    await drain();
    const id = plateId(plates, 1);
    expect((await estimates.plateNumbers(id)).platehouse).toMatchObject({
      state: "current",
      printerId: P1S,
      timeSeconds: 600,
    });

    const held = stub.hold();
    try {
      await estimates.setPrinter(X1C);
      await until(
        async () => (await platehouseRows(id)).some((r) => r.printerId === X1C),
        (v) => v,
      );
      const meanwhile = await estimates.plateNumbers(id);
      expect(meanwhile.platehouse).toMatchObject({
        state: "stale",
        staleFor: P1S,
        printerId: P1S,
        timeSeconds: 600,
      });
    } finally {
      held.release();
    }
    await drain();
    expect((await estimates.plateNumbers(id)).platehouse).toMatchObject({
      state: "current",
      printerId: X1C,
    });
  });

  test("a plate with no numbers yet shows that it is estimating", async () => {
    const held = stub.hold();
    try {
      const { plates } = await upload({ plates: 1 });
      const numbers = await estimates.plateNumbers(plateId(plates, 1));
      expect(numbers.platehouse).toMatchObject({
        state: "estimating",
        printerId: P1S,
        timeSeconds: null,
      });
    } finally {
      held.release();
    }
  });

  test("a failed plate shows its reason and siblings still get numbers", async () => {
    stub.onSlice((call) =>
      call.plate === 2
        ? { kind: "failed", code: -52, reason: "bed_too_small", detail: "objects outside the bed" }
        : { kind: "ok" },
    );
    const { plates } = await upload({ plates: 3 });
    await drain();
    const failed = await estimates.plateNumbers(plateId(plates, 2));
    expect(failed.failure).toMatchObject({
      reason: "bed_too_small",
      words: "The plate is too big for this printer's bed.",
      detail: "objects outside the bed",
    });
    for (const index of [1, 3]) {
      const numbers = await estimates.plateNumbers(plateId(plates, index));
      expect(numbers.failure).toBeUndefined();
      expect(numbers.platehouse).toMatchObject({ state: "current", timeSeconds: 600 * index });
    }
    const [row] = await platehouseRows(plateId(plates, 2));
    expect(row).toMatchObject({
      status: "failed",
      failureCode: -52,
      failureReason: "bed_too_small",
    });
  });

  test("retry re-queues without re-upload", async () => {
    stub.onSlice(() => ({
      kind: "failed",
      code: -17,
      reason: "process_not_compatible",
      detail: "process preset",
    }));
    const { modelId, plates } = await upload({ plates: 1 });
    await drain();
    const id = plateId(plates, 1);
    const failure = (await estimates.plateNumbers(id)).failure;
    expect(failure?.words).toBe("This file's print settings do not fit the selected printer.");
    const blobsBefore = await env.db
      .selectFrom("blobs")
      .select("id")
      .where("modelId", "=", modelId)
      .execute();

    stub.onSlice(() => ({ kind: "ok" }));
    if (!failure) throw new Error("no failure");
    expect(await estimates.retryEstimate(failure.estimateId)).toBe(true);
    await drain();
    const numbers = await estimates.plateNumbers(id);
    expect(numbers.failure).toBeUndefined();
    expect(numbers.platehouse).toMatchObject({ state: "current", printerId: P1S });
    const blobsAfter = await env.db
      .selectFrom("blobs")
      .select("id")
      .where("modelId", "=", modelId)
      .execute();
    expect(blobsAfter).toEqual(blobsBefore);
    // Retrying an estimate that has not failed changes nothing.
    expect(await estimates.retryEstimate(failure.estimateId)).toBe(false);
  });

  test("a busy slicer is retried by the job and the slice lands", async () => {
    let busy = 2;
    stub.onSlice(() => (busy-- > 0 ? { kind: "busy" } : { kind: "ok" }));
    const { plates } = await upload({ plates: 1 });
    await drain();
    const [row] = await platehouseRows(plateId(plates, 1));
    expect(row).toMatchObject({ status: "ok", attempts: 3 });
  });

  test("a slice lost to a slicer restart ends in failed, never stuck", async () => {
    stub.onSlice(() => ({ kind: "drop" }));
    const before = stub.calls.length;
    const { plates } = await upload({ plates: 1 });
    await drain();
    const id = plateId(plates, 1);
    const [row] = await platehouseRows(id);
    // One attempt and three retries, then failed with the slicer_error reason.
    expect(row).toMatchObject({ status: "failed", failureReason: "slicer_error", attempts: 4 });
    expect(stub.calls.length - before).toBe(4);
    expect((await estimates.plateNumbers(id)).failure).toMatchObject({
      reason: "slicer_error",
      words: "The slicer could not slice this plate.",
    });
  });

  test("a slicer down for longer than the retries last fails no plate, and the plates land when it is back", async () => {
    const before = stub.calls.length;
    await stub.down();
    let plates: Array<{ id: string; index: number }> = [];
    try {
      ({ plates } = await upload({ plates: 3 }));
      // Far longer than one attempt and three one-second retries take, so
      // without the wait every plate would have failed by now; and short of
      // the 4 two-second waits each of the 3 plates may spend in turn.
      await sleep(8_000);
      for (const plate of plates) {
        const rows = await platehouseRows(plate.id);
        expect(rows).toHaveLength(1);
        expect(["pending", "running"]).toContain(rows[0]?.status);
      }
    } finally {
      await stub.up();
    }
    await drain();
    for (const plate of plates) {
      expect(await platehouseRows(plate.id)).toEqual([
        expect.objectContaining({ status: "ok", printerId: P1S }),
      ]);
    }
    // Each plate was sliced once, when the slicer was back.
    expect(stub.calls.length - before).toBe(3);
  });

  test("a slicer that stays down fails the plate after 3 requeues, and the poll queues it again once the slicer is back", async () => {
    const before = stub.calls.length;
    logs.length = 0;
    await stub.down();
    let id = "";
    try {
      const { plates } = await upload({ plates: 1 });
      id = plateId(plates, 1);
      const [row] = await until(
        () => platehouseRows(id),
        (rows) => rows[0]?.status === "failed",
      );
      expect(row).toMatchObject({
        failureCode: null,
        failureReason: "slicer_error",
        failureDetail: SLICER_DOWN_DETAIL,
      });
      expect((await estimates.plateNumbers(id)).failure).toMatchObject({
        reason: "slicer_error",
        words: "The slicer could not slice this plate.",
      });
      // Each requeue and the failure were logged.
      expect(logs.filter((l) => l.includes("back on the queue"))).toHaveLength(3);
      expect(logs.filter((l) => l.includes("still down"))).toHaveLength(1);
      // The poll cannot reach the slicer either, so it queues nothing.
      await expect(estimates.pollOrca()).rejects.toThrow();
    } finally {
      await stub.up();
    }
    expect(stub.calls.length - before).toBe(0);
    await estimates.pollOrca();
    await drain();
    expect(await platehouseRows(id)).toEqual([expect.objectContaining({ status: "ok" })]);
    expect(stub.calls.length - before).toBe(1);
  });

  test("a plate that lost the slicer mid-slice keeps the retries it used when an outage puts it back on the queue", async () => {
    const before = stub.calls.length;
    logs.length = 0;
    let crashes = 0;
    stub.onSlice(() => {
      crashes += 1;
      if (crashes === 1) {
        // The first crash takes the slicer down for longer than a retry's
        // delay and a whole wait, so the plate goes back on the queue.
        setTimeout(() => {
          void stub.down().then(() => sleep(6_000).then(() => stub.up()));
        }, 0);
      }
      return { kind: "drop" };
    });
    const { plates } = await upload({ plates: 1 });
    const id = plateId(plates, 1);
    const [row] = await until(
      () => platehouseRows(id),
      (rows) => rows[0]?.status === "failed",
    );
    expect(logs.filter((l) => l.includes("back on the queue")).length).toBeGreaterThanOrEqual(1);
    // One attempt and three retries in all, the requeue between them
    // included: the requeued job did not start a fresh count.
    expect(stub.calls.length - before).toBe(4);
    expect(row).toMatchObject({ failureCode: null, failureReason: "slicer_error" });
    expect(row?.failureDetail).not.toBe(SLICER_DOWN_DETAIL);
    // Such a plate may be what brings the slicer down: the poll leaves it.
    await estimates.pollOrca();
    await drain();
    expect(await platehouseRows(id)).toEqual([expect.objectContaining({ status: "failed" })]);
    expect(stub.calls.length - before).toBe(4);
  });

  test("a busy retry before a long slicer outage fails with the slicer-down detail, and the poll queues it again once the slicer is back", async () => {
    // Issue #75: a 409 busy uses a retry, but it is not a lost connection,
    // so it must not make an outage failure read as a slice that stopped the
    // slicer, which the poll would leave failed.
    const before = stub.calls.length;
    logs.length = 0;
    let answered = 0;
    stub.onSlice(() => {
      answered += 1;
      if (answered === 1) {
        // Once the 409 is out, the slicer stops for longer than the 3
        // requeues' waits; the retry after the busy answer finds it down.
        setTimeout(() => {
          void stub.down();
        }, 300);
        return { kind: "busy" };
      }
      return { kind: "ok" };
    });
    let id = "";
    try {
      const { plates } = await upload({ plates: 1 });
      id = plateId(plates, 1);
      const [row] = await until(
        () => platehouseRows(id),
        (rows) => rows[0]?.status === "failed",
      );
      expect(row).toMatchObject({
        failureCode: null,
        failureReason: "slicer_error",
        failureDetail: SLICER_DOWN_DETAIL,
      });
      expect(logs.filter((l) => l.includes("back on the queue"))).toHaveLength(3);
      // The poll cannot reach the slicer either, so it queues nothing.
      await expect(estimates.pollOrca()).rejects.toThrow();
    } finally {
      await stub.up();
    }
    // Only the busy request reached the slicer.
    expect(stub.calls.length - before).toBe(1);
    await estimates.pollOrca();
    await drain();
    expect(await platehouseRows(id)).toEqual([expect.objectContaining({ status: "ok" })]);
    expect(stub.calls.length - before).toBe(2);
  });

  test("a store outage for longer than the retries last fails no plate", async () => {
    const before = stub.calls.length;
    storeDown = true;
    let plates: Array<{ id: string; index: number }> = [];
    try {
      ({ plates } = await upload({ plates: 2 }));
      // Longer than one attempt and three one-second retries take.
      await sleep(7_000);
      for (const plate of plates) {
        const rows = await platehouseRows(plate.id);
        expect(rows).toHaveLength(1);
        expect(["pending", "running"]).toContain(rows[0]?.status);
      }
    } finally {
      storeDown = false;
    }
    await drain();
    for (const plate of plates) {
      expect(await platehouseRows(plate.id)).toEqual([expect.objectContaining({ status: "ok" })]);
    }
    expect(stub.calls.length - before).toBe(2);
  });

  test("a store that stays down fails the plate, and the poll queues it again once the store answers", async () => {
    const before = stub.calls.length;
    storeDown = true;
    let id = "";
    try {
      const { plates } = await upload({ plates: 1 });
      id = plateId(plates, 1);
      const [row] = await until(
        () => platehouseRows(id),
        (rows) => rows[0]?.status === "failed",
      );
      expect(row).toMatchObject({
        failureCode: null,
        failureReason: "slicer_error",
        failureDetail: STORE_DOWN_DETAIL,
      });
      // The slicer answers but the store does not: the poll leaves the plate.
      await estimates.pollOrca();
      await sleep(500);
      expect(await platehouseRows(id)).toEqual([expect.objectContaining({ status: "failed" })]);
    } finally {
      storeDown = false;
    }
    await estimates.pollOrca();
    await drain();
    expect(await platehouseRows(id)).toEqual([expect.objectContaining({ status: "ok" })]);
    expect(stub.calls.length - before).toBe(1);
  });

  test("a slice lost while running fails with slicer_error, and a lost pending one is queued again", async () => {
    // A file ingested without the queue has no estimate and no job. Its two
    // plates get estimates with no job behind them, as after the app stopped
    // mid-slice (running) or before it sent the job (pending).
    const direct = await env.ingest.ingestFile({
      tmpPath: await writeUpload(env, build3mf({ plates: 2 })),
      originalName: "Lost.3mf",
      target: "new",
    });
    const plates = await env.repos.plates.listForFile(direct.fileId);
    const orca = (await env.repos.settings.get()).lastOrcaVersion;
    if (orca === null) throw new Error("no Orca version stored");
    const pending = (index: number) =>
      env.repos.estimates.upsertPending({
        plateId: plateId(plates, index),
        printerId: P1S,
        printerModelId: "C12",
        nozzle: 0.4,
        slicer: "OrcaSlicer",
        slicerVersion: orca,
      });
    const running = await pending(1);
    await env.db
      .updateTable("estimates")
      .set({ status: "running" })
      .where("id", "=", running.id)
      .execute();
    const waiting = await pending(2);
    expect(await boss.findJobs(QUEUE.slicer, { data: { estimateId: running.id } })).toEqual([]);
    expect(await boss.findJobs(QUEUE.slicer, { data: { estimateId: waiting.id } })).toEqual([]);

    await estimates.pollOrca();
    await drain();
    expect(await platehouseRows(plateId(plates, 1))).toEqual([
      expect.objectContaining({
        id: running.id,
        status: "failed",
        failureCode: null,
        failureReason: "slicer_error",
        failureDetail: "The slice was lost before it finished.",
      }),
    ]);
    expect(await platehouseRows(plateId(plates, 2))).toEqual([
      expect.objectContaining({ id: waiting.id, status: "ok" }),
    ]);
  });

  test("the lost-slice check leaves a slice that is running or queued alone", async () => {
    const before = stub.calls.length;
    const held = stub.hold();
    let plates: Array<{ id: string; index: number }> = [];
    try {
      ({ plates } = await upload({ plates: 2 }));
      // Plate 1 is slicing (held in the slicer), plate 2 waits in the queue.
      await until(
        () => stub.calls.length - before,
        (n) => n > 0,
      );
      await estimates.pollOrca();
      for (const plate of plates) {
        const [row] = await platehouseRows(plate.id);
        expect(["pending", "running"]).toContain(row?.status);
        // No second job was sent for it.
        const jobs = await boss.findJobs(QUEUE.slicer, { data: { estimateId: row?.id } });
        expect(jobs).toHaveLength(1);
      }
    } finally {
      held.release();
    }
    await drain();
    for (const plate of plates) {
      expect(await platehouseRows(plate.id)).toEqual([expect.objectContaining({ status: "ok" })]);
    }
    expect(stub.calls.length - before).toBe(2);
  });

  test("printer change supersedes queued estimates of the previous printer", async () => {
    const held = stub.hold();
    let plates: Array<{ id: string; index: number }> = [];
    try {
      ({ plates } = await upload({ plates: 3 }));
      // One P1S slice is held in the slicer, the other two wait in the queue.
      await until(
        () => stub.calls.length,
        (n) => n > 0,
      );
      await estimates.setPrinter(X1C);
      const queued = await boss.findJobs<{ printerId: string }>(QUEUE.slicer, { queued: true });
      expect(queued.filter((j) => j.data.printerId === P1S)).toEqual([]);
    } finally {
      held.release();
    }
    await drain();
    for (const plate of plates) {
      const rows = await platehouseRows(plate.id);
      expect(rows.filter((r) => r.printerId === P1S && r.status === "pending")).toEqual([]);
      expect(rows.find((r) => r.printerId === X1C)).toMatchObject({ status: "ok" });
      expect((await estimates.plateNumbers(plate.id)).platehouse).toMatchObject({
        state: "current",
        printerId: X1C,
      });
    }
  });

  test("every plate has numbers or a recorded reason after the queue drains (the AC-032 query)", async () => {
    stub.onSlice((call) =>
      call.plate === 1
        ? { kind: "failed", code: -16, reason: "machine_not_supported", detail: "machine" }
        : { kind: "ok" },
    );
    await upload({ plates: 2 });
    await upload({ plates: 1, sliced: [1], printerModelId: "C12" });
    // A file ingested without the queue has no estimate yet: the query finds it.
    const direct = await env.ingest.ingestFile({
      tmpPath: await writeUpload(env, build3mf({ plates: 1 })),
      originalName: "Direct.3mf",
      target: "new",
    });
    const [directPlate] = await env.repos.plates.listForFile(direct.fileId);
    if (!directPlate) throw new Error("no plate");
    await drain();
    expect(await estimates.platesWithoutNumbers()).toEqual([directPlate.id]);

    expect(await estimates.reestimateAll("startup")).toBeGreaterThanOrEqual(1);
    await drain();
    expect(await estimates.platesWithoutNumbers()).toEqual([]);
  });

  test("orca version change queues re-estimates for every live plate", async () => {
    const live = await upload({ plates: 2 });
    const trashed = await upload({ plates: 1 });
    await drain();
    expect(await env.repos.models.trash(trashed.modelId)).toBe(true);

    stub.setOrca("2.5.1");
    expect(await estimates.pollOrca()).toEqual({ orca: "2.5.1", changed: true });
    expect((await env.repos.settings.get()).lastOrcaVersion).toBe("2.5.1");
    await drain();

    for (const plate of live.plates) {
      const rows = await platehouseRows(plate.id);
      // AC-036: each estimate records the Orca version that produced it.
      expect(rows.map((r) => [r.slicerVersion, r.status])).toEqual([
        ["2.5.0", "ok"],
        ["2.5.1", "ok"],
      ]);
      expect((await estimates.plateNumbers(plate.id)).platehouse).toMatchObject({
        state: "current",
        slicerVersion: "2.5.1",
      });
    }
    expect((await platehouseRows(plateId(trashed.plates, 1))).map((r) => r.slicerVersion)).toEqual([
      "2.5.0",
    ]);
    // Every live plate the slicer has to estimate got a 2.5.1 estimate.
    expect(await estimates.platesWithoutNumbers()).toEqual([]);
    // The same version again queues nothing.
    expect(await estimates.pollOrca()).toEqual({ orca: "2.5.1", changed: false });
  });
});
