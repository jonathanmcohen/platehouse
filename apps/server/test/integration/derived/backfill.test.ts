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
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  createDerived,
  DERIVED_MESSAGES,
  type DerivedDeps,
  type DerivedJob,
  RENDER_CHECK_GRACE_MS,
} from "../../../src/derived/derived.js";
import { QUEUE } from "../../../src/jobs/queues.js";
import { renderedBytes } from "../../support/slicer-stub.js";
import {
  blobsOf,
  type DerivedEnv,
  meshPreviewBytes,
  readObject,
  settledFile,
  startDerivedEnv,
} from "../support/derived.js";
import { STEP_TEXT, writeUpload } from "../support/ingest.js";

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
  expect(await env.repos.files.get(stored.fileId)).toMatchObject({ derivedStatus: null });
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
  if (file.renderPngBlobId !== null) {
    const png = await env.repos.blobs.get(file.renderPngBlobId);
    await env.db
      .updateTable("files")
      .set({ renderPngBlobId: null, derivedStatus: "ok", derivedMessage: null })
      .where("id", "=", stored.fileId)
      .execute();
    if (png) {
      await env.db.deleteFrom("blobs").where("id", "=", png.id).execute();
      await env.store.deleteBlobs([png.key]);
    }
  }
  expect(await env.repos.files.get(stored.fileId)).toMatchObject({
    derivedStatus: "ok",
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

describe("the preview backfill (issue #316)", () => {
  test("existing STL and STEP files get previews, a STEP's from its stored mesh with no second conversion", async () => {
    const stl = await legacyStl("Legacy bracket");
    const step = await legacyStep("Legacy housing");
    env.stub.renders.reset();

    const result = await env.derived.backfillPreviews(later());
    expect(result.queued).toEqual(expect.arrayContaining([stl.fileId, step.fileId]));

    const stlFile = await settledFile(env, stl.fileId);
    expect(stlFile.derivedStatus).toBe("ok");
    const stlPng = (await blobsOf(env, stl.modelId)).find((b) => b.id === stlFile.renderPngBlobId);
    expect(await readObject(env, stlPng?.key ?? "")).toEqual(
      renderedBytes("/v1/stl/png", stl.text),
    );

    const stepFile = await settledFile(env, step.fileId);
    expect(stepFile).toMatchObject({ derivedStatus: "ok", meshBlobId: step.meshBlobId });
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
    expect(await env.repos.files.get(third.fileId)).toMatchObject({ derivedStatus: null });

    for (const f of [first, second]) {
      for (const j of await previewJobs(f.fileId)) await env.boss.cancel(QUEUE.slicer, j.id);
    }
    const two = await batched.backfillPreviews(later());
    expect(two.queued).toEqual([third.fileId]);
    for (const j of await previewJobs(third.fileId)) await env.boss.cancel(QUEUE.slicer, j.id);
  });

  test("it leaves alone a file in the trash, a failed render, a STEP with no mesh, and a file inside the grace period", async () => {
    const trashed = await legacyStl("Trashed bracket");
    await env.db
      .updateTable("models")
      .set({ trashedAt: new Date() })
      .where("id", "=", trashed.modelId)
      .execute();
    const failed = await legacyStl("Failed bracket");
    await env.db
      .updateTable("files")
      .set({ derivedStatus: "failed", derivedMessage: "The slicer could not render this file." })
      .where("id", "=", failed.fileId)
      .execute();
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

  test("a preview that failed because the slicer or storage stayed down, or could not be queued, is tried again", async () => {
    // A slicer image older than the app answers the preview route 404, which
    // waits like a slicer that is down and then ends with the slicerDown
    // sentence. None of these says anything about the file.
    const slicerDown = await legacyStl("Slicer down bracket");
    const queueFailed = await legacyStl("Queue failed bracket");
    const storeDown = await legacyStep("Store down housing");
    const outages: [string, string][] = [
      [slicerDown.fileId, DERIVED_MESSAGES.slicerDown],
      [queueFailed.fileId, DERIVED_MESSAGES.queueFailed],
      [storeDown.fileId, DERIVED_MESSAGES.storeDown],
    ];
    for (const [id, message] of outages) {
      await env.db
        .updateTable("files")
        .set({ derivedStatus: "failed", derivedMessage: message })
        .where("id", "=", id)
        .execute();
    }
    env.stub.renders.reset();

    const result = await env.derived.backfillPreviews(later());
    for (const [id] of outages) expect(result.queued).toContain(id);

    for (const [id] of outages) {
      const file = await settledFile(env, id);
      expect(file).toMatchObject({ derivedStatus: "ok", derivedMessage: null });
      expect(file.renderPngBlobId).not.toBeNull();
    }
    // The STEP file's preview came from its stored mesh, with no second conversion.
    expect(await env.repos.files.get(storeDown.fileId)).toMatchObject({
      meshBlobId: storeDown.meshBlobId,
    });
    expect(env.stub.renders.callsTo("/v1/step/glb")).toHaveLength(0);
    expect((await previewJobs(storeDown.fileId)).map((j) => j.data.kind)).toEqual(["preview-step"]);
  });

  test("an outage failure waits out the grace period before it is tried again", async () => {
    const stl = await legacyStl("Just failed bracket");
    const old = new Date(Date.now() - 2 * RENDER_CHECK_GRACE_MS);
    // Stored long ago, failed just now.
    await env.db
      .updateTable("files")
      .set({
        derivedStatus: "failed",
        derivedMessage: DERIVED_MESSAGES.slicerDown,
        createdAt: old,
        updatedAt: new Date(),
      })
      .where("id", "=", stl.fileId)
      .execute();

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
    expect(await settledFile(env, stl.fileId)).toMatchObject({ derivedStatus: "ok" });
  });

  test("a preview the program rejected, or that failed in a way a file can cause, is not tried again", async () => {
    // A slicer error or a render that did not finish is how a file that
    // crashes or hangs the slicer ends, so it is never queued again (issue #90).
    const rejected = await legacyStl("Rejected bracket");
    const lost = await legacyStl("Lost bracket");
    const refused = await legacyStl("Refused bracket");
    const stepRejected = await legacyStep("Rejected housing");
    const kept: [string, string][] = [
      [rejected.fileId, `${DERIVED_MESSAGES.previewRejected} bad mesh`],
      [lost.fileId, DERIVED_MESSAGES.renderLost],
      [refused.fileId, DERIVED_MESSAGES.storeRefused],
      [stepRejected.fileId, `${DERIVED_MESSAGES.previewRejected} bad mesh`],
    ];
    for (const [id, message] of kept) {
      await env.db
        .updateTable("files")
        .set({ derivedStatus: "failed", derivedMessage: message })
        .where("id", "=", id)
        .execute();
    }

    const run = await env.derived.backfillPreviews(later());
    for (const [id, message] of kept) {
      expect(run.queued).not.toContain(id);
      expect(await previewJobs(id)).toHaveLength(0);
      expect(await env.repos.files.get(id)).toMatchObject({
        derivedStatus: "failed",
        derivedMessage: message,
      });
    }
  });
});
