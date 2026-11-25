// Issue #316: the one-time preview backfill. STL and STEP files stored
// before previews existed get one: an STL with no render status yet, and a
// STEP whose mesh is stored and current but which has no preview. A STEP's
// preview is made from its stored mesh, never by converting the STEP file
// again. backfillPreviews is a maintenance task: it queues at most one batch
// of preview jobs on the slicer queue, and the next batch only once none of
// the last is still waiting, so uploads and slices are never stuck behind a
// whole library. Two runs at once queue each file once, and a run after the
// work is done queues nothing.
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxState } from "@platehouse/slicer-contract";
import { sql } from "kysely";
import type { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { PreviewFailureReason } from "../../../src/db/types.js";
import { PREVIOUS_RENDERS_SENTENCE, TempFileError } from "../../../src/derived/client.js";
import {
  BACKFILL_LOCK_KEY,
  createDerived,
  DERIVED_KINDS,
  DERIVED_MESSAGES,
  type DerivedDeps,
  type DerivedJob,
  RENDER_CHECK_GRACE_MS,
} from "../../../src/derived/derived.js";
import type { SlicerState } from "../../../src/estimates/slicer-state.js";
import { QUEUE, SLICER_RETRY } from "../../../src/jobs/queues.js";
import { renderedBytes, sandboxOff } from "../../support/slicer-stub.js";
import {
  blobsOf,
  type DerivedEnv,
  meshPreviewBytes,
  readObject,
  settledFile,
  startDerivedEnv,
  until,
} from "../support/derived.js";
import { SCAD_TEXT, STEP_TEXT, writeUpload } from "../support/ingest.js";

let env: DerivedEnv;

beforeAll(async () => {
  env = await startDerivedEnv();
});

afterAll(async () => {
  await env?.stop();
});

beforeEach(() => {
  env.stub.renders.reset();
});

// A test that fails on an assertion skips its own clean-up, and the jobs it
// queued then run into the next tests. Cancel what a backfill left queued:
// its picture jobs and its maintenance jobs. Render jobs without `backfill`
// are left alone, as cancelling them would leave files pending.
afterEach(async () => {
  const pictures = await env.boss.findJobs<DerivedJob>(QUEUE.slicer, {
    data: { backfill: true },
    queued: true,
  });
  if (pictures.length > 0) {
    await env.boss.cancel(
      QUEUE.slicer,
      pictures.map((j) => j.id),
    );
  }
  const live = new Set(["created", "retry", "active"]);
  const maintenance = (await backfillMaintenanceJobs()).filter((j) => live.has(j.state));
  if (maintenance.length > 0) {
    await env.boss.cancel(
      QUEUE.maintenance,
      maintenance.map((j) => j.id),
    );
  }
});

/** A time past the render check's grace period for every file written so far. */
const later = () => new Date(Date.now() + RENDER_CHECK_GRACE_MS + 60_000);

function uniqueStl(label: string): string {
  const name = `${label.replace(/[^a-z0-9]+/gi, "_")}_${randomBytes(6).toString("hex")}`;
  return (
    `solid ${name}\n facet normal 0 0 1\n  outer loop\n   vertex 0 0 0\n   vertex 2 0 0\n` +
    `   vertex 0 2 0\n  endloop\n endfacet\nendsolid ${name}\n`
  );
}

function uniqueStep(label: string): string {
  return STEP_TEXT.replace(
    "HEADER;\n",
    `HEADER;\n/* ${label} ${randomBytes(6).toString("hex")} */\n`,
  );
}

/** An STL stored as 0.1.0 left it: no render status and no job. */
async function legacyStl(label: string) {
  const text = uniqueStl(label);
  const stored = await env.ingest.ingestFile({
    tmpPath: await writeUpload(env, text),
    originalName: `${label}.stl`,
    target: "new",
  });
  expect(await env.repos.files.get(stored.fileId)).toMatchObject({
    derivedStatus: null,
    previewStatus: null,
  });
  return { ...stored, text };
}

/** A STEP file as 0.1.0 left it: its mesh stored, status ok, and no preview. */
async function legacyStep(label: string) {
  const stored = await env.ingestDerived.ingestFile({
    tmpPath: await writeUpload(env, uniqueStep(label)),
    originalName: `${label}.step`,
    target: "new",
  });
  const file = await settledFile(env, stored.fileId);
  expect(file.meshBlobId).not.toBeNull();
  const png =
    file.renderPngBlobId === null ? undefined : await env.repos.blobs.get(file.renderPngBlobId);
  await env.db
    .updateTable("files")
    .set({ renderPngBlobId: null, previewStatus: null, previewMessage: null })
    .where("id", "=", stored.fileId)
    .execute();
  if (png) {
    await env.db.deleteFrom("blobs").where("id", "=", png.id).execute();
    await env.store.deleteBlobs([png.key]);
  }
  expect(await env.repos.files.get(stored.fileId)).toMatchObject({
    derivedStatus: "ok",
    previewStatus: null,
    renderPngBlobId: null,
  });
  return { ...stored, meshBlobId: file.meshBlobId };
}

/**
 * The preview jobs the backfill queued for a file. Only those: a STEP file
 * made by legacyStep was uploaded the normal way, so its conversion already
 * queued (and ran) a preview of its own before the test removed the picture.
 */
async function previewJobs(fileId: string) {
  const kinds: readonly string[] = ["render-stl", "preview-step"];
  return (await env.boss.findJobs<DerivedJob>(QUEUE.slicer, { data: { fileId } })).filter(
    (j) => kinds.includes(j.data.kind) && j.data.backfill === true,
  );
}

/** The backfill-previews jobs on the maintenance queue, in any state. */
async function backfillMaintenanceJobs() {
  return env.boss.findJobs(QUEUE.maintenance, { data: { task: "backfill-previews" } });
}

describe("the preview backfill (issue #316)", () => {
  test("existing STL and STEP files get previews, a STEP's from its stored mesh with no second conversion", async () => {
    const stl = await legacyStl("Legacy bracket");
    const step = await legacyStep("Legacy housing");
    env.stub.renders.reset();

    const result = await env.derived.backfillPreviews(later());
    expect(result.queued).toEqual(expect.arrayContaining([stl.fileId, step.fileId]));

    const stlFile = await settledFile(env, stl.fileId);
    expect(stlFile).toMatchObject({ previewStatus: "ok", derivedStatus: null });
    const stlPng = (await blobsOf(env, stl.modelId)).find((b) => b.id === stlFile.renderPngBlobId);
    expect(await readObject(env, stlPng?.key ?? "")).toEqual(
      renderedBytes("/v1/stl/png", stl.text),
    );

    const stepFile = await settledFile(env, step.fileId);
    expect(stepFile).toMatchObject({
      derivedStatus: "ok",
      previewStatus: "ok",
      meshBlobId: step.meshBlobId,
    });
    const stepBlobs = await blobsOf(env, step.modelId);
    const mesh = stepBlobs.find((b) => b.id === step.meshBlobId);
    const stepPng = stepBlobs.find((b) => b.id === stepFile.renderPngBlobId);
    expect(stepPng?.kind).toBe("render_png");
    expect(await readObject(env, stepPng?.key ?? "")).toEqual(
      await meshPreviewBytes(await readObject(env, mesh?.key ?? "")),
    );

    // No STEP file was converted again.
    expect(env.stub.renders.callsTo("/v1/step/glb")).toHaveLength(0);
    expect(env.stub.renders.callsTo("/v1/stl/png")).toHaveLength(2);
    const stepJobs = await previewJobs(step.fileId);
    expect(stepJobs.map((j) => j.data.kind)).toEqual(["preview-step"]);
    expect(stepJobs[0]?.data).toMatchObject({ backfill: true, sourceBlobId: stepFile.blobId });
    expect((await previewJobs(stl.fileId))[0]?.data).toMatchObject({
      kind: "render-stl",
      backfill: true,
    });
  });

  test("two runs at once queue each file once, and a run after the work is done queues nothing", async () => {
    const stl = await legacyStl("Twice bracket");
    const step = await legacyStep("Twice housing");
    const ours = [stl.fileId, step.fileId];

    const [a, b] = await Promise.all([
      env.derived.backfillPreviews(later()),
      env.derived.backfillPreviews(later()),
    ]);
    const queued = [...a.queued, ...b.queued].filter((id) => ours.includes(id));
    expect(queued.sort()).toEqual([...ours].sort());

    await settledFile(env, stl.fileId);
    await settledFile(env, step.fileId);
    const again = await env.derived.backfillPreviews(later());
    expect(again.queued).toEqual([]);
    for (const id of ours) expect(await previewJobs(id)).toHaveLength(1);
  });

  test("a run waits while another holds the backfill lock, then queues its batch", async () => {
    // Jobs held an hour, so the batch stays queued until the test cancels it.
    const send: PgBoss["send"] = async (...args: unknown[]) => {
      const [name, data, options] = args as [string, object, Record<string, unknown>];
      return (env.boss.send as (...a: unknown[]) => Promise<string | null>)(name, data, {
        ...options,
        startAfter: 3600,
      });
    };
    const queue: DerivedDeps["queue"] = { send, findJobs: env.boss.findJobs.bind(env.boss) };
    const batched = createDerived({
      db: env.db,
      store: env.store,
      slicerUrl: env.stub.url,
      queue,
      retryDelaySeconds: 1,
      backfillBatch: 2,
    });
    const files = [await legacyStl("Lock one"), await legacyStl("Lock two")];
    const ours = files.map((f) => f.fileId);

    // Another run, played by a transaction that holds the same advisory lock.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding: () => void = () => {};
    const holds = new Promise<void>((resolve) => {
      holding = resolve;
    });
    const holder = env.db
      .transaction()
      .execute(async (trx) => {
        await sql`select pg_advisory_xact_lock(${BACKFILL_LOCK_KEY}::bigint)`.execute(trx);
        holding();
        await gate;
      })
      .catch((error: unknown) => {
        holding();
        throw error;
      });
    await holds;

    let settled = false;
    const run = batched.backfillPreviews(later()).finally(() => {
      settled = true;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(settled).toBe(false);
      for (const id of ours) expect(await previewJobs(id)).toHaveLength(0);

      release();
      await holder;
      const result = await run;
      expect(result.queued.filter((id) => ours.includes(id)).sort()).toEqual([...ours].sort());
    } finally {
      // Harmless a second time. Neither promise may reject unobserved, or
      // after the env has stopped.
      release();
      await Promise.allSettled([holder, run]);
      for (const f of files) {
        for (const job of await previewJobs(f.fileId)) {
          await env.boss.cancel(QUEUE.slicer, job.id);
        }
      }
    }
  });

  test("it queues one batch at a time, the next only once none of the last is still waiting", async () => {
    // Jobs held an hour, so the batch stays queued until the test cancels it.
    const send: PgBoss["send"] = async (...args: unknown[]) => {
      const [name, data, options] = args as [string, object, Record<string, unknown>];
      return (env.boss.send as (...a: unknown[]) => Promise<string | null>)(name, data, {
        ...options,
        startAfter: 3600,
      });
    };
    const queue: DerivedDeps["queue"] = { send, findJobs: env.boss.findJobs.bind(env.boss) };
    const batched = createDerived({
      db: env.db,
      store: env.store,
      slicerUrl: env.stub.url,
      queue,
      retryDelaySeconds: 1,
      backfillBatch: 2,
    });
    const first = await legacyStl("Batch one");
    const second = await legacyStl("Batch two");
    const third = await legacyStl("Batch three");

    const one = await batched.backfillPreviews(later());
    expect(one.queued).toEqual([first.fileId, second.fileId]);
    // The batch is still waiting, so nothing more is queued.
    expect((await batched.backfillPreviews(later())).queued).toEqual([]);
    expect(await env.repos.files.get(third.fileId)).toMatchObject({ previewStatus: null });

    for (const f of [first, second]) {
      for (const j of await previewJobs(f.fileId)) await env.boss.cancel(QUEUE.slicer, j.id);
    }
    const two = await batched.backfillPreviews(later());
    expect(two.queued).toEqual([third.fileId]);
    for (const j of await previewJobs(third.fileId)) await env.boss.cancel(QUEUE.slicer, j.id);
  });

  test("when a batch's last picture is done, the next batch is sent at once", async () => {
    // The env's worker runs the picture jobs; this derived only queues them.
    const batched = createDerived({
      db: env.db,
      store: env.store,
      slicerUrl: env.stub.url,
      queue: env.boss,
      retryDelaySeconds: 1,
      backfillBatch: 1,
    });
    const first = await legacyStl("Catch-up one");
    const second = await legacyStl("Catch-up two");
    const before = await backfillMaintenanceJobs();

    try {
      const run = await batched.backfillPreviews(later());
      expect(run.queued).toContain(first.fileId);
      await settledFile(env, first.fileId);

      // The maintenance worker of this env may already have taken the job, so
      // any state counts.
      await until(backfillMaintenanceJobs, (jobs) => jobs.length > before.length);
    } finally {
      // Out of the later tests' way: nothing here queues the second file, and
      // the job sent would keep retrying (this env has no backfill handler).
      // The jobs are read again: the wait above may have thrown before it
      // returned any.
      await env.db
        .updateTable("models")
        .set({ trashedAt: new Date() })
        .where("id", "=", second.modelId)
        .execute();
      for (const j of await backfillMaintenanceJobs()) {
        if (!before.some((o) => o.id === j.id)) await env.boss.cancel(QUEUE.maintenance, j.id);
      }
    }
  });

  test("no next batch is sent while another backfill picture is still queued", async () => {
    // The first job sent is held an hour; the second goes to the worker.
    let held: string | null = null;
    const send: PgBoss["send"] = async (...args: unknown[]) => {
      const [name, data, options] = args as [string, object, Record<string, unknown>];
      const hold = held === null && name === QUEUE.slicer;
      const id = await (env.boss.send as (...a: unknown[]) => Promise<string | null>)(
        name,
        data,
        hold ? { ...options, startAfter: 3600 } : options,
      );
      if (hold) held = id;
      return id;
    };
    const queue: DerivedDeps["queue"] = { send, findJobs: env.boss.findJobs.bind(env.boss) };
    const batched = createDerived({
      db: env.db,
      store: env.store,
      slicerUrl: env.stub.url,
      queue,
      retryDelaySeconds: 1,
      backfillBatch: 2,
    });
    const a = await legacyStl("Held one");
    const b = await legacyStl("Held two");
    const before = await backfillMaintenanceJobs();

    const run = await batched.backfillPreviews(later());
    expect(run.queued).toEqual([a.fileId, b.fileId]);
    // The second picture completes while the first stays queued.
    await settledFile(env, b.fileId);
    // The worker sends the next batch within a poll (0.5s) of the picture
    // finishing, so 1.5s covers the window.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await backfillMaintenanceJobs()).toHaveLength(before.length);

    for (const j of await previewJobs(a.fileId)) await env.boss.cancel(QUEUE.slicer, j.id);
  });

  test("it leaves alone a file in the trash, a failed render, a STEP with no mesh, and a file inside the grace period", async () => {
    const trashed = await legacyStl("Trashed bracket");
    await env.db
      .updateTable("models")
      .set({ trashedAt: new Date() })
      .where("id", "=", trashed.modelId)
      .execute();
    const failed = await legacyStl("Failed bracket");
    await failedAttempt(failed.fileId, "render_failed", "The slicer could not render this file.");
    env.stub.renders.queue("/v1/step/glb", { kind: "failed", message: "no shapes" });
    const unconverted = await env.ingestDerived.ingestFile({
      tmpPath: await writeUpload(env, uniqueStep("Unconverted housing")),
      originalName: "Unconverted.step",
      target: "new",
    });
    expect(await settledFile(env, unconverted.fileId)).toMatchObject({
      derivedStatus: "failed",
      meshBlobId: null,
    });
    const ignored = [trashed.fileId, failed.fileId, unconverted.fileId];

    // Just written, so still inside the grace period at the real time.
    const recent = await legacyStl("Recent bracket");
    const now = await env.derived.backfillPreviews(new Date());
    expect(now.queued).not.toContain(recent.fileId);
    for (const id of ignored) expect(now.queued).not.toContain(id);
    // Out of the later runs' way.
    await env.db
      .updateTable("models")
      .set({ trashedAt: new Date() })
      .where("id", "=", recent.modelId)
      .execute();

    const run = await env.derived.backfillPreviews(later());
    for (const id of ignored) expect(run.queued).not.toContain(id);
    for (const id of ignored) expect(await previewJobs(id)).toHaveLength(0);
  });

  test("a STEP file whose replacement was dropped after its own mesh was stored gets its picture from that mesh", async () => {
    // PR #363 review: the original's conversion finishes while a newer
    // replacement is queued, so it queues no picture (the replacement's own
    // conversion would). The replacement then ends with a slicer error and
    // is not saved, so the file keeps its source and a stored mesh of it,
    // with derivedStatus 'failed' (the replace* sentence) and no picture.
    // Nothing else would ever queue that picture.
    const send: PgBoss["send"] = async (...args: unknown[]) => {
      const [name, data, options] = args as [string, object, Record<string, unknown>];
      return (env.boss.send as (...a: unknown[]) => Promise<string | null>)(name, data, {
        ...options,
        startAfter: 3600,
      });
    };
    const holding = createDerived({
      db: env.db,
      store: env.store,
      slicerUrl: env.stub.url,
      queue: { send, findJobs: env.boss.findJobs.bind(env.boss) },
      retryDelaySeconds: 1,
    });
    const { modelId, fileId } = await env.ingest.ingestFile({
      tmpPath: await writeUpload(env, uniqueStep("Dropped replacement, original")),
      originalName: "Dropped.step",
      target: "new",
    });
    const original = await env.repos.files.get(fileId);
    if (!original) throw new Error("file not stored");
    await holding.replaceFile(
      fileId,
      await writeUpload(env, uniqueStep("Dropped replacement, replacement")),
    );
    expect(
      await env.derived.runJob(
        { kind: DERIVED_KINDS.convertStep, fileId, sourceBlobId: original.blobId },
        { retryCount: 0, retryLimit: SLICER_RETRY.retryLimit },
      ),
    ).toEqual({ status: "ok" });
    const held = (await env.boss.findJobs<DerivedJob>(QUEUE.slicer, { data: { fileId } })).filter(
      (j) => j.state === "created" && j.data.kind === DERIVED_KINDS.convertStep,
    );
    expect(held).toHaveLength(1);
    const convert = held[0];
    if (!convert) throw new Error("no held conversion");
    await env.boss.cancel(QUEUE.slicer, convert.id);
    env.stub.renders.always("/v1/step/glb", { kind: "drop" });
    expect(
      await env.derived.runJob(convert.data, {
        retryCount: convert.retryLimit,
        retryLimit: convert.retryLimit,
      }),
    ).toEqual({ status: "failed", reason: "slicer_error" });
    env.stub.renders.reset();
    const dropped = await env.repos.files.get(fileId);
    expect(dropped).toMatchObject({
      blobId: original.blobId,
      derivedStatus: "failed",
      derivedMessage: DERIVED_MESSAGES.replaceFailed,
      renderPngBlobId: null,
      previewStatus: null,
    });
    const meshBlobId = dropped?.meshBlobId;
    if (!meshBlobId) throw new Error("no mesh");

    const run = await env.derived.backfillPreviews(later());
    expect(run.queued).toContain(fileId);
    const file = await settledFile(env, fileId);
    expect(file).toMatchObject({
      blobId: original.blobId,
      meshBlobId,
      derivedStatus: "failed",
      previewStatus: "ok",
      previewMessage: null,
    });
    const blobs = await blobsOf(env, modelId);
    const mesh = blobs.find((b) => b.id === meshBlobId);
    const png = blobs.find((b) => b.id === file.renderPngBlobId);
    expect(await readObject(env, png?.key ?? "")).toEqual(
      await meshPreviewBytes(await readObject(env, mesh?.key ?? "")),
    );
    // From the stored mesh, with no second conversion.
    expect(env.stub.renders.callsTo("/v1/step/glb")).toHaveLength(0);
    expect((await previewJobs(fileId)).map((j) => j.data.kind)).toEqual(["preview-step"]);
  });

  test("a STEP file whose replacement the converter rejected, left with the previous version's mesh, is not taken", async () => {
    // Its derivedStatus is 'failed' too, but its mesh is of the earlier
    // source, so a picture of it would be of the wrong version.
    const stored = await env.ingestDerived.ingestFile({
      tmpPath: await writeUpload(env, uniqueStep("Rejected replacement, original")),
      originalName: "Rejected.step",
      target: "new",
    });
    const before = await settledFile(env, stored.fileId);
    env.stub.renders.queue("/v1/step/glb", { kind: "failed", message: "STEP import failed" });
    await env.derived.replaceFile(
      stored.fileId,
      await writeUpload(env, uniqueStep("Rejected replacement, replacement")),
    );
    expect(await settledFile(env, stored.fileId)).toMatchObject({
      meshBlobId: before.meshBlobId,
      derivedStatus: "failed",
      renderPngBlobId: null,
      previewStatus: null,
    });

    const run = await env.derived.backfillPreviews(later());
    expect(run.queued).not.toContain(stored.fileId);
    expect(await previewJobs(stored.fileId)).toHaveLength(0);
  });

  /**
   * Leaves the facts a failed picture attempt for the file's current source
   * records, and the status recomputePreview works out from them (issue
   * #389): failed, with the attempt's reason.
   */
  async function failedAttempt(
    fileId: string,
    reason: PreviewFailureReason,
    message: string,
    times: { createdAt?: Date; updatedAt?: Date } = {},
  ) {
    await env.db
      .updateTable("files")
      .set((eb) => ({
        previewFailureSourceBlobId: eb.ref("blobId"),
        previewFailureMessage: message,
        previewFailureReason: reason,
        previewStatus: "failed",
        previewMessage: message,
        ...times,
      }))
      .where("id", "=", fileId)
      .execute();
  }

  test("a preview that failed because the slicer or storage stayed down, or could not be queued, is tried again", async () => {
    // A slicer image older than the app answers the preview route 404, which
    // waits like a slicer that is down and then ends with the
    // previewSlicerDown sentence. None of these says anything about the file.
    // Each is written as the facts a failed attempt for the file's current
    // source leaves, with the status worked out from them (issue #389).
    const slicerDown = await legacyStl("Slicer down bracket");
    const queueFailed = await legacyStl("Queue failed bracket");
    const storeDown = await legacyStep("Store down housing");
    const outages: [string, PreviewFailureReason, string][] = [
      [slicerDown.fileId, "slicer_down", DERIVED_MESSAGES.previewSlicerDown],
      [queueFailed.fileId, "queue_failed", DERIVED_MESSAGES.previewQueueFailed],
      [storeDown.fileId, "store_down", DERIVED_MESSAGES.previewStoreDown],
    ];
    for (const [id, reason, message] of outages) await failedAttempt(id, reason, message);
    env.stub.renders.reset();

    const result = await env.derived.backfillPreviews(later());
    for (const [id] of outages) expect(result.queued).toContain(id);

    for (const [id] of outages) {
      const file = await settledFile(env, id);
      expect(file).toMatchObject({ previewStatus: "ok", previewMessage: null });
      expect(file.renderPngBlobId).not.toBeNull();
    }
    // The STEP file's preview came from its stored mesh, with no second conversion.
    // Its derivedStatus, the mesh's, stayed ok the whole time (issue #380).
    expect(await env.repos.files.get(storeDown.fileId)).toMatchObject({
      meshBlobId: storeDown.meshBlobId,
      derivedStatus: "ok",
    });
    expect(env.stub.renders.callsTo("/v1/step/glb")).toHaveLength(0);
    expect((await previewJobs(storeDown.fileId)).map((j) => j.data.kind)).toEqual(["preview-step"]);
  });

  test("a preview whose temp folder could not be written is recorded on its last attempt and tried again", async () => {
    // Issue #415: a job folder that cannot be made (a full disk, a read-only
    // or missing TMP_DIR) fails every picture job before the slicer is
    // asked. An earlier attempt is left to pg-boss's retry with nothing
    // recorded; the last records the temp file sentence, which the backfill
    // queues again, rather than ending as a render that did not finish.
    const noTemp = createDerived({
      db: env.db,
      store: env.store,
      slicerUrl: env.stub.url,
      queue: env.boss,
      retryDelaySeconds: 1,
      tmpDir: join(tmpdir(), `platehouse-no-such-folder-${randomBytes(6).toString("hex")}`),
    });
    const stl = await legacyStl("Temp folder bracket");
    const step = await legacyStep("Temp folder housing");
    const jobs: [string, DerivedJob][] = [];
    for (const [fileId, kind] of [
      [stl.fileId, DERIVED_KINDS.renderStl],
      [step.fileId, DERIVED_KINDS.previewStep],
    ] as const) {
      const file = await env.repos.files.get(fileId);
      if (!file) throw new Error("file not stored");
      jobs.push([fileId, { kind, fileId, sourceBlobId: file.blobId }]);
    }
    env.stub.renders.reset();

    for (const [fileId, job] of jobs) {
      await expect(
        noTemp.runJob(job, { retryCount: 0, retryLimit: SLICER_RETRY.retryLimit }),
      ).rejects.toBeInstanceOf(TempFileError);
      expect(await env.repos.files.get(fileId)).toMatchObject({
        previewStatus: null,
        previewMessage: null,
      });
      expect(
        await noTemp.runJob(job, {
          retryCount: SLICER_RETRY.retryLimit,
          retryLimit: SLICER_RETRY.retryLimit,
        }),
      ).toEqual({ status: "failed", reason: "temp_failed" });
      expect(await env.repos.files.get(fileId)).toMatchObject({
        previewStatus: "failed",
        previewMessage: DERIVED_MESSAGES.previewTempFailed,
        previewFailureReason: "temp_failed",
        renderPngBlobId: null,
      });
    }
    // Nothing was ever sent to the slicer.
    expect(env.stub.renders.callsTo("/v1/stl/png")).toHaveLength(0);

    const run = await env.derived.backfillPreviews(later());
    for (const [fileId] of jobs) {
      expect(run.queued).toContain(fileId);
      const file = await settledFile(env, fileId);
      expect(file).toMatchObject({ previewStatus: "ok", previewMessage: null });
      expect(file.renderPngBlobId).not.toBeNull();
    }
    expect(env.stub.renders.callsTo("/v1/step/glb")).toHaveLength(0);
  });

  test("an outage failure is retried by its code, whatever its stored wording", async () => {
    // A failure stored by an older version holds an older sentence; the
    // code, not the text, says it is an outage.
    const stl = await legacyStl("Reworded outage bracket");
    const old = new Date(Date.now() - 2 * RENDER_CHECK_GRACE_MS);
    await failedAttempt(stl.fileId, "slicer_down", "an older wording of the outage sentence", {
      createdAt: old,
      updatedAt: old,
    });
    env.stub.renders.reset();

    const run = await env.derived.backfillPreviews(later());
    expect(run.queued).toContain(stl.fileId);
    expect(await settledFile(env, stl.fileId)).toMatchObject({ previewStatus: "ok" });
  });

  test("a render failure is not retried even when its text reads like an outage", async () => {
    const stl = await legacyStl("Look-alike bracket");
    const old = new Date(Date.now() - 2 * RENDER_CHECK_GRACE_MS);
    await failedAttempt(stl.fileId, "render_failed", DERIVED_MESSAGES.previewSlicerDown, {
      createdAt: old,
      updatedAt: old,
    });

    const run = await env.derived.backfillPreviews(later());
    expect(run.queued).not.toContain(stl.fileId);
    expect(await previewJobs(stl.fileId)).toHaveLength(0);
  });

  test("an outage failure waits out the grace period before it is tried again", async () => {
    const stl = await legacyStl("Just failed bracket");
    const old = new Date(Date.now() - 2 * RENDER_CHECK_GRACE_MS);
    // Stored long ago, failed just now.
    await failedAttempt(stl.fileId, "slicer_down", DERIVED_MESSAGES.previewSlicerDown, {
      createdAt: old,
      updatedAt: new Date(),
    });

    const now = await env.derived.backfillPreviews(new Date());
    expect(now.queued).not.toContain(stl.fileId);
    expect(await previewJobs(stl.fileId)).toHaveLength(0);

    await env.db
      .updateTable("files")
      .set({ updatedAt: old })
      .where("id", "=", stl.fileId)
      .execute();
    const run = await env.derived.backfillPreviews(new Date());
    expect(run.queued).toContain(stl.fileId);
    expect(await settledFile(env, stl.fileId)).toMatchObject({ previewStatus: "ok" });
  });

  test("a preview the program rejected, or that failed in a way a file can cause, is not tried again", async () => {
    // A slicer error or a render that did not finish is how a file that
    // crashes or hangs the slicer ends, so it is never queued again (issue #90).
    const rejected = await legacyStl("Rejected bracket");
    const lost = await legacyStl("Lost bracket");
    const refused = await legacyStl("Refused bracket");
    const stepRejected = await legacyStep("Rejected housing");
    const kept: [string, PreviewFailureReason, string][] = [
      [rejected.fileId, "render_failed", `${DERIVED_MESSAGES.previewRejected} bad mesh`],
      [lost.fileId, "lost", DERIVED_MESSAGES.renderLost],
      [refused.fileId, "render_failed", DERIVED_MESSAGES.storeRefused],
      [stepRejected.fileId, "render_failed", `${DERIVED_MESSAGES.previewRejected} bad mesh`],
    ];
    for (const [id, reason, message] of kept) await failedAttempt(id, reason, message);

    const run = await env.derived.backfillPreviews(later());
    for (const [id, , message] of kept) {
      expect(run.queued).not.toContain(id);
      expect(await previewJobs(id)).toHaveLength(0);
      expect(await env.repos.files.get(id)).toMatchObject({
        previewStatus: "failed",
        previewMessage: message,
      });
    }
  });
});

// A slicer whose sandbox is off refuses pictures, renders and STEP previews
// and says so in its health. What the app does with the files it refused
// depends on that health: nothing while it is off or unknown, and a second
// try once it is on (STEP conversions also when the slicer allows them
// without the sandbox).
const ON: SandboxState = { state: "on", reason: null, detail: null, allowUnsandboxed: false };
const CHECKING: SandboxState = {
  state: "checking",
  reason: null,
  detail: null,
  allowUnsandboxed: false,
};
const off = (allowUnsandboxed: boolean): SandboxState => ({
  state: "off",
  reason: "old_kernel",
  detail: "the kernel is too old",
  allowUnsandboxed,
});

/** A derived whose slicer health reports sandbox (null: health has not answered). */
function derivedReporting(sandbox: SandboxState | null, batch?: number) {
  const slicerState: SlicerState = {
    current: async () => ({
      timeouts: { sliceSeconds: 180, scadSeconds: 120, stepSeconds: 120, uploadSeconds: 600 },
      sandbox,
    }),
  };
  return createDerived({
    db: env.db,
    store: env.store,
    slicerUrl: env.stub.url,
    queue: env.boss,
    retryDelaySeconds: 1,
    slicerState,
    ...(batch === undefined ? {} : { backfillBatch: batch }),
  });
}

/** Jobs of a file, every kind. */
async function jobsOf(fileId: string) {
  return env.boss.findJobs<DerivedJob>(QUEUE.slicer, { data: { fileId } });
}

describe("files a slicer with its sandbox off refused", () => {
  test("a picture refused for the sandbox is a backfill candidate only while health says it is on, and not again right after a new refusal", async () => {
    const stl = await legacyStl("Sandbox bracket");
    // Stored long ago as well as refused long ago: a candidate must have been
    // created before the cutoff too, so the passes at new Date() below test
    // the refusal's own grace period (updatedAt), not the file's age.
    const old = new Date(Date.now() - 2 * RENDER_CHECK_GRACE_MS);
    await env.db
      .updateTable("files")
      .set((eb) => ({
        previewFailureSourceBlobId: eb.ref("blobId"),
        previewFailureMessage: DERIVED_MESSAGES.sandboxOffKernel,
        previewFailureReason: "sandbox_off_kernel",
        previewStatus: "failed",
        previewMessage: DERIVED_MESSAGES.sandboxOffKernel,
        createdAt: old,
        updatedAt: old,
      }))
      .where("id", "=", stl.fileId)
      .execute();

    for (const sandbox of [off(false), off(true), CHECKING, null]) {
      const run = await derivedReporting(sandbox).backfillPreviews(later());
      expect(run.queued).not.toContain(stl.fileId);
    }
    expect(await previewJobs(stl.fileId)).toHaveLength(0);

    // The slicer is on, but refuses this one again: recorded again, then
    // left alone until the grace period has passed once more.
    env.stub.renders.always("/v1/stl/png", sandboxOff("old_kernel"));
    const on = derivedReporting(ON);
    expect((await on.backfillPreviews(later())).queued).toContain(stl.fileId);
    const again = await until(
      () => env.repos.files.get(stl.fileId),
      (f) => f?.previewStatus === "failed" && f.updatedAt.getTime() > old.getTime(),
    );
    expect(again).toMatchObject({
      previewMessage: DERIVED_MESSAGES.sandboxOffKernel,
      previewFailureReason: "sandbox_off_kernel",
    });
    // The handler writes the row before pg-boss completes its job, and a file
    // with a live job is never queued, so wait for the job too: the next two
    // passes then test the grace period, not the job (CI run 45323577150).
    await until(
      () => previewJobs(stl.fileId),
      (js) => js.length === 1 && js.every((j) => j.state === "completed"),
    );
    expect((await on.backfillPreviews(new Date())).queued).not.toContain(stl.fileId);
    expect(await previewJobs(stl.fileId)).toHaveLength(1);

    // Once the sandbox is on for real, the next pass makes the picture.
    env.stub.renders.reset();
    await env.db
      .updateTable("files")
      .set({ updatedAt: old })
      .where("id", "=", stl.fileId)
      .execute();
    expect((await on.backfillPreviews(new Date())).queued).toContain(stl.fileId);
    expect(await settledFile(env, stl.fileId)).toMatchObject({ previewStatus: "ok" });
  });

  /** A .scad or STEP file that a refused render or conversion left failed with message. */
  async function refused(kind: "scad" | "step", message: string) {
    const text =
      kind === "scad"
        ? `// ${randomBytes(6).toString("hex")}\n${SCAD_TEXT}`
        : uniqueStep("Refused conversion");
    const stored = await env.ingest.ingestFile({
      tmpPath: await writeUpload(env, text),
      originalName: kind === "scad" ? "Refused.scad" : "Refused.step",
      target: "new",
    });
    await env.db
      .updateTable("files")
      .set({ derivedStatus: "failed", derivedMessage: message })
      .where("id", "=", stored.fileId)
      .execute();
    return stored.fileId;
  }

  test("a render or conversion refused for the sandbox is queued only when health allows it, and once", async () => {
    const scad = await refused("scad", DERIVED_MESSAGES.sandboxOffCheck);
    const step = await refused("step", DERIVED_MESSAGES.convertSandboxOffKernel);

    // Unknown, still being checked, or off and not allowed: nothing.
    for (const sandbox of [null, CHECKING, off(false)]) {
      expect(await derivedReporting(sandbox).requeueSandboxOff(new Date())).toBe(0);
    }
    expect(await jobsOf(scad)).toHaveLength(0);
    expect(await jobsOf(step)).toHaveLength(0);

    // Off but the slicer allows STEP conversions without it: the STEP file
    // only, never a render.
    expect(await derivedReporting(off(true)).requeueSandboxOff(new Date())).toBe(1);
    expect((await jobsOf(step)).map((j) => j.data.kind)).toContain(DERIVED_KINDS.convertStep);
    // Its job has run before the next run, which waits for any still queued.
    expect(await settledFile(env, step)).toMatchObject({ derivedStatus: "ok" });
    expect(await jobsOf(scad)).toHaveLength(0);
    expect(await env.repos.files.get(scad)).toMatchObject({
      derivedStatus: "failed",
      derivedMessage: DERIVED_MESSAGES.sandboxOffCheck,
    });

    // On: the render too. The STEP file is pending or done, so not again.
    const on = derivedReporting(ON);
    expect(await on.requeueSandboxOff(new Date())).toBe(1);
    expect((await jobsOf(scad)).map((j) => j.data.kind)).toEqual([DERIVED_KINDS.renderScad]);
    expect(await settledFile(env, scad)).toMatchObject({ derivedStatus: "ok" });
    expect(await settledFile(env, step)).toMatchObject({ derivedStatus: "ok" });

    // A second run right after queues nothing.
    expect(await on.requeueSandboxOff(new Date())).toBe(0);
    expect(await jobsOf(scad)).toHaveLength(1);
  });

  /** A queue that holds each job an hour, so what is queued stays queued. */
  function holding(): DerivedDeps["queue"] {
    const send: PgBoss["send"] = async (...args: unknown[]) => {
      const [name, data, options] = args as [string, object, Record<string, unknown>];
      return (env.boss.send as (...a: unknown[]) => Promise<string | null>)(name, data, {
        ...options,
        startAfter: 3600,
      });
    };
    return { send, findJobs: env.boss.findJobs.bind(env.boss) };
  }

  test("it queues at most one batch per run, and the next only once none of the last is still queued", async () => {
    const first = await refused("scad", DERIVED_MESSAGES.sandboxOffKernel);
    const second = await refused("scad", DERIVED_MESSAGES.sandboxOffKernel);
    const batched = createDerived({
      db: env.db,
      store: env.store,
      slicerUrl: env.stub.url,
      queue: holding(),
      retryDelaySeconds: 1,
      backfillBatch: 1,
      slicerState: {
        current: async () => ({
          timeouts: { sliceSeconds: 180, scadSeconds: 120, stepSeconds: 120, uploadSeconds: 600 },
          sandbox: ON,
        }),
      },
    });
    expect(await batched.requeueSandboxOff(new Date())).toBe(1);
    // The batch is still queued, so nothing more is queued.
    expect(await batched.requeueSandboxOff(new Date())).toBe(0);
    const queued = [...(await jobsOf(first)), ...(await jobsOf(second))];
    expect(queued).toHaveLength(1);
    expect(queued[0]?.data.requeue).toBe(true);

    for (const j of queued) await env.boss.cancel(QUEUE.slicer, j.id);
    expect(await batched.requeueSandboxOff(new Date())).toBe(1);
    for (const j of [...(await jobsOf(first)), ...(await jobsOf(second))]) {
      await env.boss.cancel(QUEUE.slicer, j.id);
    }
  });

  test("both stored forms of the message are queued: the sentence alone, and after the previous-renders sentence", async () => {
    const plain = await refused("scad", DERIVED_MESSAGES.sandboxOffKernel);
    const led = await refused(
      "scad",
      `${PREVIOUS_RENDERS_SENTENCE.scad} ${DERIVED_MESSAGES.sandboxOffCheck}`,
    );
    const stepLed = await refused(
      "step",
      `${PREVIOUS_RENDERS_SENTENCE.step} ${DERIVED_MESSAGES.convertSandboxOffCheck}`,
    );
    expect(await derivedReporting(ON).requeueSandboxOff(new Date())).toBe(3);
    for (const id of [plain, led, stepLed]) expect(await jobsOf(id)).toHaveLength(1);
  });

  test("a program's message that ends with a sandbox sentence is never queued", async () => {
    const sentences = [
      ["scad", DERIVED_MESSAGES.sandboxOffKernel],
      ["scad", DERIVED_MESSAGES.sandboxOffCheck],
      ["step", DERIVED_MESSAGES.convertSandboxOffKernel],
      ["step", DERIVED_MESSAGES.convertSandboxOffCheck],
    ] as const;
    const ids: string[] = [];
    for (const [kind, sentence] of sentences) {
      const lead = kind === "scad" ? "OpenSCAD said:" : "The converter said:";
      const previous =
        kind === "scad" ? PREVIOUS_RENDERS_SENTENCE.scad : PREVIOUS_RENDERS_SENTENCE.step;
      for (const message of [
        `${lead} ${sentence}`,
        `${lead} ERROR: x\n${sentence}`,
        `${previous} ${lead} ${sentence}`,
        `${previous} ${lead} ERROR: x\n${sentence}`,
        `ERROR: x ${sentence}`,
      ]) {
        ids.push(await refused(kind, message));
      }
    }
    expect(await derivedReporting(ON).requeueSandboxOff(new Date())).toBe(0);
    for (const id of ids) expect(await jobsOf(id)).toHaveLength(0);
  });

  test("a file that has a live job, or is no longer failed, is not queued again", async () => {
    const busy = await refused("scad", DERIVED_MESSAGES.sandboxOffKernel);
    const file = await env.repos.files.get(busy);
    if (!file) throw new Error("no file");
    const held: DerivedJob = {
      kind: DERIVED_KINDS.renderScad,
      fileId: busy,
      sourceBlobId: file.blobId,
    };
    const id = await (env.boss.send as (...a: unknown[]) => Promise<string | null>)(
      QUEUE.slicer,
      held,
      { ...SLICER_RETRY, startAfter: 3600 },
    );
    expect(await derivedReporting(ON).requeueSandboxOff(new Date())).toBe(0);
    expect(await jobsOf(busy)).toHaveLength(1);
    if (id !== null) await env.boss.cancel(QUEUE.slicer, id);
  });

  test("a render refused for another reason is left alone", async () => {
    const other = await refused("scad", `${DERIVED_MESSAGES.previousRendersScad} ERROR: bad file`);
    expect(await derivedReporting(ON).requeueSandboxOff(new Date())).toBe(0);
    expect(await jobsOf(other)).toHaveLength(0);
  });
});
