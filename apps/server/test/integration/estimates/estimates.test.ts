// Estimates, the printer setting and re-estimation
// (the printer menu and its default, every plate's numbers and their source,
// background slicing, plain failure reasons, the Orca version on each
// estimate, a slice lost to a slicer restart ending in failed and never stuck,
// and a second printer change superseding the first). Files come in through
// the real ingest queue into a migrated Postgres 17 and the S3 test server;
// slices go to a slicer stub built on the slicer contract package
// (test/support/slicer-stub.ts), so every answer it gives is one contract 2
// allows. pg-boss runs on the same database with the queue settings the app
// uses, except that retries wait about a second instead of 10 s and more.
// Every file is synthetic.
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { sql } from "kysely";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createSlicerClient, type SlicerClient } from "../../../src/estimates/client.js";
import { OTHER_PRINTER_LABEL } from "../../../src/estimates/display.js";
import {
  createEstimates,
  type Estimates,
  libraryPlatesFor,
  MAX_MY_PRINTERS,
  PrinterListRefused,
  PrintersChanged,
  SANDBOX_OFF_CHECK_DETAIL,
  SANDBOX_OFF_KERNEL_DETAIL,
  SLICE_PRIORITY,
  SLICER_DOWN_DETAIL,
  STORE_DOWN_DETAIL,
  UnknownPrinter,
} from "../../../src/estimates/service.js";
import type { IngestInput, IngestResult } from "../../../src/ingest/ingest.js";
import { createBoss } from "../../../src/jobs/boss.js";
import { MAINTENANCE_TASKS, QUEUE, startQueues } from "../../../src/jobs/queues.js";
import { StoreUnavailable } from "../../../src/storage/s3.js";
import {
  type SlicerStub,
  STUB_PRINTERS,
  sandboxOff,
  startSlicerStub,
} from "../../support/slicer-stub.js";
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
/**
 * A stand-in for derived.ts's render and mesh jobs: a job of this kind on the
 * slicer queue, sent with no priority as derived.ts sends its own. Each run
 * records how many slices the stub had been asked for when it started.
 */
const RENDER_KIND = "synthetic-render";
const renderRuns: number[] = [];
/** While true, every read of a stored file fails as a store outage does. */
let storeDown = false;
/**
 * While true, every read of a stored file starts and then fails partway
 * through, as a store that restarts or times out mid-read does.
 */
let storeBreaksMidRead = false;

/** A stream that gives the first bytes of the real one, then fails. */
function brokenRead(real: Readable): Readable {
  real.destroy();
  let reads = 0;
  return new Readable({
    read() {
      reads += 1;
      if (reads === 1) this.push(Buffer.from("PK\u0003\u0004"));
      else this.destroy(new Error("synthetic: the store dropped the read"));
    },
  });
}

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
      getBlobStream: async (key) => {
        if (storeDown) throw new StoreUnavailable("GetObject", "test outage");
        const real = await env.store.getBlobStream(key);
        return storeBreaksMidRead ? brokenRead(real) : real;
      },
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
    sweepUploads: async () => undefined,
    slicerJobs: {
      ...estimates.slicerJobs,
      [RENDER_KIND]: async () => {
        renderRuns.push(stub.calls.length);
      },
    },
    pollOrca: () => estimates.pollOrca(),
    onIngested: (result) => estimates.enqueueFile(result.fileId),
    pollingIntervalSeconds: 0.5,
  });
  // startQueues sends the Orca poll as a job, as at app startup; wait for it.
  await until(
    async () => (await env.repos.settings.get()).lastOrcaVersion,
    (v) => v === "2.5.0",
  );
});

afterAll(async () => {
  await boss?.stop({ graceful: false });
  await stub?.stop();
  await env?.stop();
});

beforeEach(async () => {
  stub.onSlice(() => ({ kind: "ok" }));
  stub.setSandbox({ state: "on", reason: null, detail: null, allowUnsandboxed: false });
  storeDown = false;
  storeBreaksMidRead = false;
  await drain();
  const settings = await env.repos.settings.get();
  if (settings.printerId !== P1S || settings.myPrinters.join("|") !== P1S) {
    await estimates.setPrinter(P1S);
    await estimates.pollOrca();
    await drain();
  }
});

describe("the printer setting", () => {
  test("printer menu equals the slicer profile list", async () => {
    const printers = await estimates.listPrinters();
    expect(printers).toEqual((await slicer.profiles()).printers);
    expect(printers).toEqual(STUB_PRINTERS);
    // The default is the P1S with a 0.4 mm nozzle.
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

  // A plate whose file carries its own numbers for a printer never gets a
  // Platehouse estimate for it, so the library re-estimate (every Orca poll,
  // the startup one included) must not fetch it again and again only for
  // enqueue to skip it: the library query leaves it out, for that printer's
  // BBL model and nozzle only.
  test("the library re-estimate leaves out plates whose file has its own numbers for the printer", async () => {
    const own = await upload({ plates: 2, sliced: [1, 2], printerModelId: "C12" });
    const plain = await upload({ plates: 1 });
    await drain();
    // An Orca version nothing was estimated with, so every other live plate is due.
    const orca = "0.0.0-synthetic";
    const byId = (id: string) => {
      const printer = STUB_PRINTERS.find((p) => p.id === id);
      if (!printer) throw new Error(`no stub printer ${id}`);
      return printer;
    };
    const p1s06 = { ...byId(P1S), id: "Bambu Lab P1S 0.6 nozzle", nozzle: 0.6 };
    const forP1S = await libraryPlatesFor(env.db, byId(P1S), orca);
    const forA1 = await libraryPlatesFor(env.db, byId(A1), orca);
    const forP1S06 = await libraryPlatesFor(env.db, p1s06, orca);
    for (const plate of own.plates) {
      expect(forP1S).not.toContain(plate.id);
      expect(forA1).toContain(plate.id);
      expect(forP1S06).toContain(plate.id);
    }
    for (const plate of plain.plates) expect(forP1S).toContain(plate.id);
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
    // Which preset produced each filament's numbers (PR #55).
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

  // Issue #198: with no menu printer for the file's printer, Bambu's numbers
  // were labelled with its raw code ("Sliced for Q9"). The printer id stays
  // the file's own; only the label is plain words.
  test("file numbers for a printer the menu does not have are labelled in plain words", async () => {
    const { plates } = await upload({ plates: 1, sliced: [1], printerModelId: "Q9" });
    await drain();
    const numbers = await estimates.plateNumbers(plateId(plates, 1));
    expect(numbers.file).toMatchObject({
      source: "file",
      printerId: "Q9",
      printerLabel: OTHER_PRINTER_LABEL,
      timeSeconds: 1000,
    });
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
    await estimates.pollOrca();
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
      await estimates.pollOrca();
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

  test("a slice refused for the sandbox is recorded once with its own detail, and is estimated again only once the sandbox is on", async () => {
    for (const [reason, detail] of [
      ["old_kernel", SANDBOX_OFF_KERNEL_DETAIL],
      ["check_failed", SANDBOX_OFF_CHECK_DETAIL],
    ] as const) {
      const before = stub.calls.length;
      stub.onSlice(() => sandboxOff(reason));
      stub.setSandbox({
        state: "off",
        reason,
        detail: "the sandbox is off",
        allowUnsandboxed: false,
      });
      const { plates } = await upload({ plates: 1 });
      const id = plateId(plates, 1);
      const [row] = await until(
        () => platehouseRows(id),
        (rows) => rows[0]?.status === "failed",
      );
      expect(row).toMatchObject({
        failureCode: null,
        failureReason: "slicer_error",
        failureDetail: detail,
      });
      // No retry and no outage wait: the one request was refused and recorded.
      expect(stub.calls.length - before).toBe(1);

      // Off and not allowed: the poll queues nothing.
      await estimates.pollOrca();
      await drain();
      expect(await platehouseRows(id)).toEqual([expect.objectContaining({ status: "failed" })]);
      expect(stub.calls.length - before).toBe(1);

      // Still checking: nothing either.
      stub.setSandbox({ state: "checking", reason: null, detail: null, allowUnsandboxed: false });
      await estimates.pollOrca();
      await drain();
      expect(stub.calls.length - before).toBe(1);

      // On: it is estimated again once, and a second poll queues none.
      stub.onSlice(() => ({ kind: "ok" }));
      stub.setSandbox({ state: "on", reason: null, detail: null, allowUnsandboxed: false });
      await estimates.pollOrca();
      await drain();
      expect(await platehouseRows(id)).toEqual([expect.objectContaining({ status: "ok" })]);
      expect(stub.calls.length - before).toBe(2);
      await estimates.pollOrca();
      await drain();
      expect(stub.calls.length - before).toBe(2);
    }
  });

  test("a sandbox that is off but allowed to run slices unsandboxed queues the refused estimates again", async () => {
    const before = stub.calls.length;
    stub.onSlice(() => sandboxOff("old_kernel"));
    stub.setSandbox({ state: "off", reason: "old_kernel", detail: "old", allowUnsandboxed: false });
    const { plates } = await upload({ plates: 1 });
    const id = plateId(plates, 1);
    await until(
      () => platehouseRows(id),
      (rows) => rows[0]?.status === "failed",
    );
    stub.onSlice(() => ({ kind: "ok" }));
    stub.setSandbox({ state: "off", reason: "old_kernel", detail: "old", allowUnsandboxed: true });
    await estimates.pollOrca();
    await drain();
    expect(await platehouseRows(id)).toEqual([expect.objectContaining({ status: "ok" })]);
    expect(stub.calls.length - before).toBe(2);
  });

  test("the sandbox requeue takes only estimates of live models, so refused estimates in the trash never hold back a live one", async () => {
    stub.onSlice(() => sandboxOff("old_kernel"));
    stub.setSandbox({ state: "off", reason: "old_kernel", detail: "old", allowUnsandboxed: false });
    // A model whose estimate the sandbox refused, moved to the trash, with
    // 51 more refused estimates on plates of its file: more than one poll's
    // batch of 50, and all older than the live estimate below.
    const trashed = await upload({ plates: 1 });
    const [dead] = await until(
      () => platehouseRows(plateId(trashed.plates, 1)),
      (rows) => rows[0]?.status === "failed",
    );
    if (dead === undefined) throw new Error("no estimate for the trashed model");
    expect(dead.failureDetail).toBe(SANDBOX_OFF_KERNEL_DETAIL);
    expect(await env.repos.models.trash(trashed.modelId)).toBe(true);
    const deadPlates = Array.from({ length: 51 }, (_, i) => ({
      id: randomUUID(),
      fileId: trashed.fileId,
      index: i + 2,
      name: null,
      objectCount: 1,
      thumbnailBlobId: null,
    }));
    await env.db.insertInto("plates").values(deadPlates).execute();
    await env.db
      .insertInto("estimates")
      .values(
        deadPlates.map((plate) => ({
          id: randomUUID(),
          plateId: plate.id,
          source: "platehouse" as const,
          printerId: dead.printerId,
          printerModelId: dead.printerModelId,
          nozzle: dead.nozzle,
          slicer: dead.slicer,
          slicerVersion: dead.slicerVersion,
          processProfile: null,
          status: "failed" as const,
          timeSeconds: null,
          weightGrams: null,
          failureCode: null,
          failureReason: "slicer_error",
          failureDetail: SANDBOX_OFF_KERNEL_DETAIL,
          createdAt: sql<Date>`now() - interval '1 day'`,
          finishedAt: new Date(),
        })),
      )
      .execute();

    const { plates } = await upload({ plates: 1 });
    const id = plateId(plates, 1);
    await until(
      () => platehouseRows(id),
      (rows) => rows[0]?.status === "failed",
    );

    stub.onSlice(() => ({ kind: "ok" }));
    stub.setSandbox({ state: "on", reason: null, detail: null, allowUnsandboxed: false });
    await estimates.pollOrca();
    await drain();
    expect(await platehouseRows(id)).toEqual([expect.objectContaining({ status: "ok" })]);
    // The trashed model's estimates stay as they were.
    expect(await platehouseRows(plateId(trashed.plates, 1))).toEqual([
      expect.objectContaining({ status: "failed", failureDetail: SANDBOX_OFF_KERNEL_DETAIL }),
    ]);
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

  test("a store that keeps failing mid-read is a store outage: no retry is used, and the poll queues the plate again", async () => {
    // The file starts going out to the slicer and the read then fails. That
    // is the store's fault, not a connection the slicer accepted and lost,
    // so it is waited out like any store outage and never counts as a lost
    // connection (which would leave the plate failed for good).
    logs.length = 0;
    storeBreaksMidRead = true;
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
      expect(logs.filter((l) => l.includes("the store is down; back on the queue"))).toHaveLength(
        3,
      );
      expect(logs.filter((l) => l.includes("the store is still down"))).toHaveLength(1);
    } finally {
      storeBreaksMidRead = false;
    }
    const before = stub.calls.length;
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
      await estimates.pollOrca();
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

  test("every plate has numbers or a recorded reason after the queue drains", async () => {
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
      // Each estimate records the Orca version that produced it.
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

// My printers (the maintainer, 2026-11-19): the printers the user owns, each estimated for
// every plate, one of them the default. The tests share one library, so
// counts are measured from the database rather than assumed.
describe("My printers", () => {
  /** Live plates with no Platehouse estimate for printerId at the current Orca version. */
  async function unestimated(printerId: string): Promise<number> {
    const orca = (await env.repos.settings.get()).lastOrcaVersion;
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n
      from plates p join files f on f.id = p.file_id join models m on m.id = f.model_id
      where m.trashed_at is null
        and not exists (
          select 1 from estimates e
          where e.plate_id = p.id and e.source = 'platehouse'
            and e.printer_id = ${printerId} and e.slicer_version = ${orca}
        )
    `.execute(env.db);
    return rows[0]?.n ?? -1;
  }

  async function queuedJobs() {
    return boss.findJobs<{ printerId: string; estimateId: string }>(QUEUE.slicer, {
      queued: true,
    });
  }

  /** Slice jobs not yet finished (a worker may have claimed some): queued or active. */
  async function liveJobs() {
    const jobs = await boss.findJobs<{ printerId: string; estimateId: string }>(QUEUE.slicer, {});
    return jobs.filter((j) => ["created", "retry", "active"].includes(j.state));
  }

  test("queueing a library for a printer makes one estimate and one job per plate, and twice queues nothing more", async () => {
    await upload({ plates: 3 });
    await drain();
    const orca = (await env.repos.settings.get()).lastOrcaVersion ?? "";
    const printer = (await slicer.profiles()).printers.find((p) => p.id === A1);
    if (printer === undefined) throw new Error("no A1 in the stub's menu");
    const expected = await unestimated(A1);
    expect(expected).toBeGreaterThanOrEqual(3);
    const held = stub.hold();
    try {
      expect(await estimates.queueLibraryFor(printer, orca)).toBe(expected);
      expect(await estimates.queueLibraryFor(printer, orca)).toBe(0);
      const jobs = (await liveJobs()).filter((j) => j.data.printerId === A1);
      expect(jobs).toHaveLength(expected);
      expect(new Set(jobs.map((j) => j.data.estimateId)).size).toBe(expected);
      expect(jobs.every((j) => j.priority === SLICE_PRIORITY.library)).toBe(true);
      // The same expiry the one-job path (sendSlice) gives.
      const probe = await upload({ plates: 1 });
      await estimates.enqueueFile(probe.fileId);
      const single = (await liveJobs()).find(
        (j) => j.data.printerId !== A1 && j.priority === SLICE_PRIORITY.waiting,
      );
      expect(single).toBeDefined();
      expect(new Set(jobs.map((j) => j.expireInSeconds))).toEqual(
        new Set([single?.expireInSeconds]),
      );
    } finally {
      held.release();
    }
    await drain();
  });

  test("a pending estimate whose job was never inserted is queued again by the next poll", async () => {
    const { plates } = await upload({ plates: 1 });
    await drain();
    const orca = (await env.repos.settings.get()).lastOrcaVersion ?? "";
    const plate = plates[0];
    if (plate === undefined) throw new Error("no plate");
    // What a crash between the bulk insert of estimates and of their jobs
    // leaves: the plate's P1S estimate pending, with no job anywhere.
    await sql`delete from estimates where plate_id = ${plate.id} and source = 'platehouse'`.execute(
      env.db,
    );
    const orphan = await env.repos.estimates.upsertPending({
      plateId: plate.id,
      printerId: P1S,
      printerModelId: null,
      nozzle: null,
      slicer: "orca",
      slicerVersion: orca,
    });
    expect(orphan.status).toBe("pending");
    const held = stub.hold();
    try {
      await estimates.pollOrca();
      const jobs = (await liveJobs()).filter((j) => j.data.estimateId === orphan.id);
      expect(jobs).toHaveLength(1);
    } finally {
      held.release();
    }
    await drain();
  });

  test("adding a printer queues every existing plate for it, and the default stays", async () => {
    const { plates } = await upload({ plates: 2 });
    await drain();
    const expected = await unestimated(A1);
    expect(expected).toBeGreaterThanOrEqual(2);

    const held = stub.hold();
    // The stub's call log holds every earlier test's calls too.
    const before = stub.calls.length;
    try {
      const saved = await estimates.savePrinters({ printers: [P1S, A1], defaultId: P1S });
      expect(saved).toEqual({
        added: [{ printerId: A1, queued: expected, through: expected }],
        removed: [],
      });
      expect(await env.repos.settings.get()).toMatchObject({
        printerId: P1S,
        myPrinters: [P1S, A1],
      });
      // Saving only counted them; the poll it sent queues them (run here
      // too, so the test does not wait on the maintenance worker).
      await estimates.pollOrca();
      // The queue shows the work: every one of those plates waits for the A1.
      await until(
        () => stub.calls.length,
        (n) => n > before,
      );
      expect((await estimates.queueByPrinter()).get(A1)).toEqual({
        waiting: expected,
        through: expected,
      });
      expect((await estimates.queueByPrinter()).has(P1S)).toBe(false);
      // Library-wide work goes behind anything a person is waiting on.
      expect(
        (await queuedJobs()).every(
          (j) => j.data.printerId === A1 && j.priority === SLICE_PRIORITY.library,
        ),
      ).toBe(true);
    } finally {
      held.release();
    }
    await drain();
    expect(await estimates.platesWithoutNumbers(A1)).toEqual([]);
    for (const plate of plates) {
      // The default printer's numbers are what a page shows first...
      expect((await estimates.plateNumbers(plate.id)).platehouse).toMatchObject({
        state: "current",
        printerId: P1S,
        printerName: "Bambu Lab P1S, 0.4 mm nozzle",
      });
      // ...and the A1's are there for the switch.
      expect((await estimates.plateNumbers(plate.id, A1)).platehouse).toMatchObject({
        state: "current",
        printerId: A1,
        printerName: "Bambu Lab A1, 0.4 mm nozzle",
      });
    }
  });

  // PR #240 review, eta-ignores-shared-queue: the slicer is one queue, so a
  // printer whose plates are queued behind another printer's waits for them.
  test("with two printers' work queued, the second's last plate is behind all of the first's", async () => {
    await upload({ plates: 1 });
    await upload({ plates: 1 });
    await drain();
    const missingA1 = await unestimated(A1);
    const missingX1C = await unestimated(X1C);
    const held = stub.hold();
    const before = stub.calls.length;
    try {
      const saved = await estimates.savePrinters({ printers: [P1S, A1, X1C], defaultId: P1S });
      expect(saved.added.map((a) => a.printerId)).toEqual([A1, X1C]);
      // A plate whose file already carries Bambu's own numbers for a printer
      // is not queued for it (an earlier test uploads one sliced for the
      // X1C), so a printer's count can be below its missing estimates.
      const forA1 = saved.added[0]?.queued ?? 0;
      const forX1C = saved.added[1]?.queued ?? 0;
      expect(forA1).toBeGreaterThanOrEqual(2);
      expect(forA1).toBeLessThanOrEqual(missingA1);
      expect(forX1C).toBeGreaterThanOrEqual(2);
      expect(forX1C).toBeLessThanOrEqual(missingX1C);
      // The answer comes before the poll queues anything (a maintenance
      // worker may already have started it): the A1 is through after its own
      // plates, and the X1C after its own at least, and behind the A1's at most.
      expect(saved.added[0]?.through).toBe(forA1);
      expect(saved.added[1]?.through).toBeGreaterThanOrEqual(forX1C);
      expect(saved.added[1]?.through).toBeLessThanOrEqual(forA1 + forX1C);
      await estimates.pollOrca();

      // Once the first A1 slice is running in the slicer, the figures are exact.
      await until(
        () => stub.calls.length,
        (n) => n > before,
      );
      await until(
        async () =>
          (
            await env.db
              .selectFrom("estimates")
              .select("id")
              .where("status", "=", "running")
              .execute()
          ).length,
        (n) => n === 1,
      );
      const queue = await estimates.queueByPrinter();
      expect(queue.get(A1)).toEqual({ waiting: forA1, through: forA1 });
      expect(queue.get(X1C)).toEqual({ waiting: forX1C, through: forA1 + forX1C });
    } finally {
      held.release();
    }
    await drain();
    expect((await estimates.queueByPrinter()).size).toBe(0);
  });

  // The Orca poll can run between ingest storing a new file's plates and
  // onIngested queueing them; it then queues them as library work. The
  // upload's own queueing must still put them ahead of a long backfill.
  test("a new file's plates the poll queued first still get urgent slices from the upload", async () => {
    await estimates.savePrinters({ printers: [P1S, A1], defaultId: P1S });
    await estimates.pollOrca();
    await drain();
    const held = stub.hold();
    const before = stub.calls.length;
    let ids: string[] = [];
    try {
      // A slice of another upload holds the slicer.
      await upload({ plates: 1 });
      await until(
        () => stub.calls.length,
        (n) => n > before,
      );
      // A file ingested without onIngested, as at the moment the poll runs.
      const direct = await env.ingest.ingestFile({
        tmpPath: await writeUpload(env, build3mf({ plates: 2 })),
        originalName: "Raced.3mf",
        target: "new",
      });
      expect(await estimates.reestimateAll("poll")).toBe(4);
      ids = (
        await env.db
          .selectFrom("estimates")
          .innerJoin("plates", "plates.id", "estimates.plateId")
          .select("estimates.id")
          .where("plates.fileId", "=", direct.fileId)
          .execute()
      ).map((r) => r.id);
      expect(ids).toHaveLength(4);
      // Then the upload's own queueing.
      await estimates.enqueueFile(direct.fileId);
      const queued = await boss.findJobs<{ estimateId: string }>(QUEUE.slicer, { queued: true });
      for (const id of ids) {
        expect(
          queued.some((j) => j.data.estimateId === id && j.priority === SLICE_PRIORITY.waiting),
          id,
        ).toBe(true);
      }
      // Each estimate counts once in the queue's figures: the slice running
      // now, the upload's urgent A1 slice, then the raced file's four urgent
      // copies (its library copies are not counted again).
      expect((await estimates.queueByPrinter()).get(A1)?.through).toBe(2 + ids.length);
    } finally {
      held.release();
    }
    await drain();
    // The leftover library copies ended without slicing anything twice.
    const rows = await env.db
      .selectFrom("estimates")
      .select(["status", "attempts"])
      .where("id", "in", ids)
      .execute();
    expect(rows.map((r) => [r.status, r.attempts])).toEqual([
      ["ok", 1],
      ["ok", 1],
      ["ok", 1],
      ["ok", 1],
    ]);
  });

  test("a new plate queues a slice for every printer, the default first, ahead of library work", async () => {
    await upload({ plates: 1 });
    await upload({ plates: 1 });
    await drain();
    expect(await unestimated(A1)).toBeGreaterThanOrEqual(2);
    const held = stub.hold();
    // The stub's call log holds every earlier test's calls too.
    const before = stub.calls.length;
    let first = 0;
    try {
      // Library work for the A1: the first slice is held in the slicer, the
      // rest wait in the queue.
      await estimates.savePrinters({ printers: [P1S, A1], defaultId: P1S });
      await estimates.pollOrca();
      await until(
        () => stub.calls.length,
        (n) => n > before,
      );
      first = stub.calls.length;
      expect(first).toBe(before + 1);
      expect(stub.calls[before]).toMatchObject({ printer: A1 });
      // A new three-plate file arrives meanwhile.
      const { plates } = await upload({ plates: 3 });
      const estimateIds = async () =>
        (
          await env.db
            .selectFrom("estimates")
            .select("id")
            .where(
              "plateId",
              "in",
              plates.map((p) => p.id),
            )
            .execute()
        ).map((r) => r.id);
      // Wait for the upload's own six urgent jobs, not just the six rows: the
      // Orca poll may have made the rows first, as library work (see the test
      // above), and the urgent copies follow.
      const urgent = await until(
        async () => {
          const ids = await estimateIds();
          return (await queuedJobs()).filter(
            (j) => j.priority === SLICE_PRIORITY.waiting && ids.includes(j.data.estimateId),
          );
        },
        (jobs) => jobs.length === 6,
      );
      expect(urgent).toHaveLength(6);
    } finally {
      held.release();
    }
    await drain();
    // After the held slice, the new file's six slices ran first: its plates
    // for the default printer, then for the A1, before the library's.
    expect(stub.calls.slice(first, first + 6).map((c) => [c.printer, c.plate])).toEqual([
      [P1S, 1],
      [P1S, 2],
      [P1S, 3],
      [A1, 1],
      [A1, 2],
      [A1, 3],
    ]);
    expect(stub.calls.length).toBeGreaterThan(first + 6);
  });

  // PR #240 review, library-priority-ties-renders: an OpenSCAD render or a
  // STEP mesh shares the slicer queue and is sent at pg-boss's default
  // priority. It must not wait behind a printer's whole backfill.
  test("a render queued behind a printer backfill runs before it, and the wait counts it", async () => {
    await upload({ plates: 1 });
    await upload({ plates: 1 });
    await drain();
    expect(await unestimated(A1)).toBeGreaterThanOrEqual(2);
    renderRuns.length = 0;
    const held = stub.hold();
    const before = stub.calls.length;
    let first = 0;
    let queued = 0;
    try {
      // Library work for the A1: the first slice is held in the slicer, the
      // rest wait in the queue.
      const saved = await estimates.savePrinters({ printers: [P1S, A1], defaultId: P1S });
      queued = saved.added[0]?.queued ?? 0;
      expect(queued).toBeGreaterThanOrEqual(2);
      await estimates.pollOrca();
      await until(
        () => stub.calls.length,
        (n) => n > before,
      );
      first = stub.calls.length;
      await until(
        async () =>
          (
            await env.db
              .selectFrom("estimates")
              .select("id")
              .where("status", "=", "running")
              .execute()
          ).length,
        (n) => n === 1,
      );
      // A .scad file arrives meanwhile: its render is sent as derived.ts
      // sends one, with no priority.
      expect(await boss.send(QUEUE.slicer, { kind: RENDER_KIND })).not.toBeNull();
      // The A1's wait counts the render, which now runs ahead of its plates.
      expect((await estimates.queueByPrinter()).get(A1)).toEqual({
        waiting: queued,
        through: queued + 1,
      });
    } finally {
      held.release();
    }
    await drain();
    await until(
      () => renderRuns.length,
      (n) => n === 1,
    );
    // The render ran straight after the held slice, before the rest of the backfill.
    expect(renderRuns).toEqual([first]);
    expect(stub.calls.length).toBeGreaterThanOrEqual(first + queued - 1);
  });

  test("removing a printer stops its pending work, and its finished numbers stay", async () => {
    await estimates.savePrinters({ printers: [P1S, A1], defaultId: P1S });
    await estimates.pollOrca();
    await drain();
    const done = await upload({ plates: 1 });
    await drain();
    const doneId = plateId(done.plates, 1);
    expect((await platehouseRows(doneId)).map((r) => [r.printerId, r.status])).toEqual([
      [P1S, "ok"],
      [A1, "ok"],
    ]);

    const held = stub.hold();
    // The stub's call log holds every earlier test's calls too.
    const before = stub.calls.length;
    let plates: Array<{ id: string; index: number }> = [];
    try {
      ({ plates } = await upload({ plates: 3 }));
      await until(
        () => stub.calls.length,
        (n) => n > before,
      );
      await until(
        async () => (await queuedJobs()).filter((j) => j.data.printerId === A1).length,
        (n) => n === 3,
      );
      const saved = await estimates.savePrinters({ printers: [P1S], defaultId: P1S });
      expect(saved).toEqual({ added: [], removed: [A1] });
      // Its queued slices are cancelled and its waiting estimates gone.
      expect((await queuedJobs()).filter((j) => j.data.printerId === A1)).toEqual([]);
      expect((await estimates.queueByPrinter()).has(A1)).toBe(false);
    } finally {
      held.release();
    }
    await drain();
    for (const plate of plates) {
      const rows = await platehouseRows(plate.id);
      expect(rows.filter((r) => r.printerId === A1)).toEqual([]);
      expect(rows.find((r) => r.printerId === P1S)).toMatchObject({ status: "ok" });
    }
    // A plate the A1 had already estimated keeps those numbers.
    expect((await platehouseRows(doneId)).map((r) => [r.printerId, r.status])).toEqual([
      [P1S, "ok"],
      [A1, "ok"],
    ]);
  });

  test("reading another printer's numbers, or reordering, never starts a slice", async () => {
    await estimates.savePrinters({ printers: [P1S, A1], defaultId: P1S });
    await estimates.pollOrca();
    const { plates } = await upload({ plates: 2 });
    await drain();
    const calls = stub.calls.length;
    const rows = await env.db.selectFrom("estimates").select("id").execute();

    for (const plate of plates) {
      await estimates.plateNumbers(plate.id, A1);
      await estimates.plateNumbers(plate.id, P1S);
      // A printer outside My printers: numbers are read, nothing is queued.
      expect((await estimates.plateNumbers(plate.id, X1C)).platehouse).toBeUndefined();
    }
    await estimates.platesWithoutNumbers(X1C);
    // A new order and a new default slice nothing either.
    expect(await estimates.savePrinters({ printers: [A1, P1S], defaultId: A1 })).toEqual({
      added: [],
      removed: [],
    });
    expect(await env.repos.settings.get()).toMatchObject({ printerId: A1, myPrinters: [A1, P1S] });

    await sleep(1_000);
    expect(stub.calls.length).toBe(calls);
    expect(await queuedJobs()).toEqual([]);
    expect(await env.db.selectFrom("estimates").select("id").execute()).toEqual(rows);
    // The default printer is now the A1, so the default numbers are the A1's.
    expect((await estimates.plateNumbers(plateId(plates, 1))).platehouse).toMatchObject({
      state: "current",
      printerId: A1,
    });
  });

  test("a printer still in My printers is never shown as another printer's stale numbers", async () => {
    await estimates.savePrinters({ printers: [P1S], defaultId: P1S });
    const { plates } = await upload({ plates: 1 });
    await drain();
    const id = plateId(plates, 1);
    const held = stub.hold();
    try {
      await estimates.savePrinters({ printers: [P1S, X1C], defaultId: P1S });
      await estimates.pollOrca();
      // The X1C's estimate is on its way: the X1C view says estimating, and
      // does not pass the P1S's numbers off as old X1C numbers.
      expect((await estimates.plateNumbers(id, X1C)).platehouse).toMatchObject({
        state: "estimating",
        printerId: X1C,
        timeSeconds: null,
      });
    } finally {
      held.release();
    }
    await drain();
  });

  test("a list that is empty, too long, repeats a printer or leaves out the default is refused", async () => {
    const before = await env.repos.settings.get();
    const refused: Array<{ printers: string[]; defaultId: string }> = [
      { printers: [], defaultId: P1S },
      { printers: [P1S, P1S], defaultId: P1S },
      { printers: [P1S, A1], defaultId: X1C },
      {
        printers: Array.from({ length: MAX_MY_PRINTERS + 1 }, (_, i) => `Printer ${i} 0.4 nozzle`),
        defaultId: "Printer 0 0.4 nozzle",
      },
    ];
    for (const patch of refused) {
      await expect(estimates.savePrinters(patch)).rejects.toBeInstanceOf(PrinterListRefused);
    }
    // A printer the slicer's menu does not have cannot be added.
    await expect(
      estimates.savePrinters({ printers: [P1S, "Bambu Lab Q9 0.4 nozzle"], defaultId: P1S }),
    ).rejects.toBeInstanceOf(UnknownPrinter);
    expect(await env.repos.settings.get()).toMatchObject({
      printerId: before.printerId,
      myPrinters: before.myPrinters,
    });
  });

  test("a list saved from an old read is refused, so a printer added elsewhere keeps its work", async () => {
    await estimates.savePrinters({ printers: [P1S], defaultId: P1S });
    const { plates } = await upload({ plates: 1 });
    await drain();
    const id = plateId(plates, 1);
    const held = stub.hold();
    try {
      // Window A reads My printers: [P1S].
      const readByA = (await env.repos.settings.get()).printersVersion;
      // Window B adds the X1C: its plate is queued for it.
      await estimates.savePrinters({ printers: [P1S, X1C], defaultId: P1S, version: readByA });
      await estimates.pollOrca();
      const forX1C = async () =>
        (await platehouseRows(id)).filter((r) => r.printerId === X1C).map((r) => r.id);
      const waiting = await forX1C();
      expect(waiting).toHaveLength(1);
      // Window A, still showing [P1S], saves a list without the X1C: refused.
      await expect(
        estimates.savePrinters({ printers: [P1S], defaultId: P1S, version: readByA }),
      ).rejects.toBeInstanceOf(PrintersChanged);
      expect(await env.repos.settings.get()).toMatchObject({ myPrinters: [P1S, X1C] });
      // Its waiting estimate was not dropped.
      expect(await forX1C()).toEqual(waiting);
      // Saved from the version as it is now, the removal goes through.
      const now = (await env.repos.settings.get()).printersVersion;
      expect(
        await estimates.savePrinters({ printers: [P1S], defaultId: P1S, version: now }),
      ).toEqual({ added: [], removed: [X1C] });
    } finally {
      held.release();
    }
    await drain();
  });

  // Issue #272: the same, when window B changed only the default.
  test("a save from an old read cannot put back a default changed elsewhere", async () => {
    await estimates.savePrinters({ printers: [P1S, X1C], defaultId: P1S });
    await estimates.pollOrca();
    await drain();
    const readByA = (await env.repos.settings.get()).printersVersion;
    // Window B makes the X1C the default; the list is unchanged.
    await estimates.savePrinters({ printers: [P1S, X1C], defaultId: X1C, version: readByA });
    // Window A, still showing P1S as the default, moves a printer: refused.
    await expect(
      estimates.savePrinters({ printers: [X1C, P1S], defaultId: P1S, version: readByA }),
    ).rejects.toBeInstanceOf(PrintersChanged);
    expect(await env.repos.settings.get()).toMatchObject({
      printerId: X1C,
      myPrinters: [P1S, X1C],
    });
  });

  test("a listed printer the slicer stopped offering stays in the list and is skipped", async () => {
    const gone = "Bambu Lab A1 mini 0.4 nozzle";
    // As after an Orca update renamed its preset: listed, but not in the menu.
    await env.repos.settings.savePrinters({ printers: [P1S, gone], defaultId: P1S });
    const { plates } = await upload({ plates: 1 });
    await drain();
    expect((await platehouseRows(plateId(plates, 1))).map((r) => r.printerId)).toEqual([P1S]);
    expect(logs.some((line) => line.includes(`${gone} is in My printers`))).toBe(true);
    // Keeping it while adding another is allowed; only added printers must be offered.
    expect(
      await estimates.savePrinters({ printers: [P1S, gone, X1C], defaultId: P1S }),
    ).toMatchObject({ removed: [], added: [{ printerId: X1C }] });
    await estimates.pollOrca();
    await drain();
  });
});
