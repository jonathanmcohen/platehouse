// Build plan Task 13: STEP meshes in the app (AC-050, decision 2). A .step or
// .stp upload is stored as uploaded; after its row commits, ingest's
// afterCommit queues a mesh job on Task 8's slicer queue, and the job posts
// the source to the slicer's /v1/step/glb (here a stub built on
// packages/slicer-contract) and stores the GLB as a new mesh_glb blob, which
// is all the browser ever loads for a STEP file.
import { randomBytes } from "node:crypto";
import { truncate } from "node:fs/promises";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { LIMITS } from "@platehouse/slicer-contract";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  createDerived,
  DERIVED_KINDS,
  DerivedError,
  type DerivedJob,
  type DerivedStore,
  RENDER_CHECK_GRACE_MS,
} from "../../../src/derived/derived.js";
import { QUEUE, SLICER_RETRY } from "../../../src/jobs/queues.js";
import { BlobNotFound, StoreError, StoreUnavailable } from "../../../src/storage/s3.js";
import { renderedBytes } from "../../support/slicer-stub.js";
import {
  blobsOf,
  type DerivedEnv,
  keysOf,
  readObject,
  settledFile,
  startDerivedEnv,
  until,
} from "../support/derived.js";
import { ASCII_STL, STEP_TEXT, writeUpload } from "../support/ingest.js";

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

/** A STEP file unique to the test: a comment line in its header section. */
function uniqueStep(label: string): string {
  return STEP_TEXT.replace(
    "HEADER;\n",
    `HEADER;\n/* ${label} ${randomBytes(6).toString("hex")} */\n`,
  );
}

async function uploadStep(text: string, name = "Housing.step") {
  const path = await writeUpload(env, text);
  return env.ingestDerived.ingestFile({ tmpPath: path, originalName: name, target: "new" });
}

describe("STEP meshes (AC-050)", () => {
  test("a .step upload produces a GLB mesh blob", async () => {
    const text = uniqueStep("mesh");
    const { modelId, fileId } = await uploadStep(text);
    const file = await settledFile(env, fileId);

    expect(file.derivedStatus).toBe("ok");
    expect(file.derivedMessage).toBeNull();
    expect(file.meshBlobId).not.toBeNull();
    expect(file.renderStlBlobId).toBeNull();
    expect(file.renderPngBlobId).toBeNull();

    const blobs = await blobsOf(env, modelId);
    const mesh = blobs.find((b) => b.id === file.meshBlobId);
    expect(mesh).toMatchObject({
      kind: "mesh_glb",
      state: "stored",
      contentType: "model/gltf-binary",
    });
    expect(await readObject(env, mesh?.key ?? "")).toEqual(renderedBytes("/v1/step/glb", text));
    expect(blobs.map((b) => b.kind).sort()).toEqual(["mesh_glb", "source"]);
    expect(await keysOf(env, modelId)).toEqual(blobs.map((b) => b.key).sort());

    const calls = env.stub.renders.callsTo("/v1/step/glb");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.toString("utf8")).toBe(text);
    expect(calls[0]?.contentType).toBe("application/octet-stream");

    const jobs = await env.boss.findJobs<DerivedJob>(QUEUE.slicer, { data: { fileId } });
    expect(jobs.map((j) => j.data.kind)).toEqual([DERIVED_KINDS.convertStep]);
  });

  test("a .stp upload is meshed the same way", async () => {
    const { fileId } = await uploadStep(uniqueStep("stp"), "Housing.stp");
    const file = await settledFile(env, fileId);
    expect(file).toMatchObject({ kind: "step", derivedStatus: "ok" });
    expect(file.meshBlobId).not.toBeNull();
  });

  test("a conversion error keeps the source and shows the converter's message", async () => {
    const message = "STEP import failed: no shapes found <in> 'DATA' & section";
    env.stub.renders.queue("/v1/step/glb", { kind: "failed", message });
    const text = uniqueStep("convert-error");
    const { modelId, fileId } = await uploadStep(text);
    const file = await settledFile(env, fileId);

    expect(file.derivedStatus).toBe("failed");
    expect(file.derivedMessage).toBe(message);
    expect(file.meshBlobId).toBeNull();
    const blobs = await blobsOf(env, modelId);
    expect(blobs.map((b) => b.kind)).toEqual(["source"]);
    expect(await readObject(env, blobs[0]?.key ?? "")).toEqual(Buffer.from(text));
  });

  test("replacing a .step converts the new file and removes the old mesh and source", async () => {
    const { modelId, fileId } = await uploadStep(uniqueStep("old"));
    const before = await settledFile(env, fileId);
    const oldBlobs = await blobsOf(env, modelId);

    const next = uniqueStep("new");
    await env.derived.replaceFile(fileId, await writeUpload(env, next));
    const after = await until(
      () => env.repos.files.get(fileId),
      (f) => f?.blobId !== before.blobId && f?.derivedStatus === "ok",
    );
    const blobs = await blobsOf(env, modelId);
    const mesh = blobs.find((b) => b.id === after?.meshBlobId);
    expect(await readObject(env, mesh?.key ?? "")).toEqual(renderedBytes("/v1/step/glb", next));
    expect(blobs).toHaveLength(2);
    for (const old of oldBlobs) {
      await expect(env.store.getBlobStream(old.key)).rejects.toBeInstanceOf(BlobNotFound);
    }
  });

  test("a replacement the converter rejects keeps the previous source and mesh and drops its staged source", async () => {
    const { modelId, fileId } = await uploadStep(uniqueStep("convert error, before"));
    const before = await settledFile(env, fileId);
    const oldBlobs = await blobsOf(env, modelId);
    const oldKeys = await keysOf(env, modelId);
    env.stub.renders.reset();

    const message = "STEP import failed: no shapes found";
    env.stub.renders.queue("/v1/step/glb", { kind: "failed", message });
    const { sourceBlobId } = await env.derived.replaceFile(
      fileId,
      await writeUpload(env, uniqueStep("convert error, replacement")),
    );
    const after = await settledFile(env, fileId);

    expect(after).toMatchObject({
      blobId: before.blobId,
      meshBlobId: before.meshBlobId,
      derivedStatus: "failed",
      derivedMessage: message,
    });
    expect((await blobsOf(env, modelId)).map((b) => b.id)).toEqual(oldBlobs.map((b) => b.id));
    expect(await keysOf(env, modelId)).toEqual(oldKeys);
    expect(await env.repos.blobs.get(sourceBlobId)).toBeUndefined();
  });

  test("replaceFile refuses a STEP file over the converter's 256 MiB limit and stores nothing", async () => {
    const { modelId, fileId } = await uploadStep(uniqueStep("too large"));
    const before = await settledFile(env, fileId);
    // Count only the calls replaceFile makes, not the upload's own conversion.
    env.stub.renders.reset();
    const keys = await keysOf(env, modelId);
    const jobCount = (await env.boss.findJobs(QUEUE.slicer, { data: { fileId } })).length;
    // A real STEP header, then extended past the limit without writing the
    // bytes (a sparse file), since nothing is meant to read them.
    const path = await writeUpload(env, uniqueStep("too large replacement"));
    await truncate(path, LIMITS.stepBodyBytes + 1);

    const error = await env.derived.replaceFile(fileId, path).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DerivedError);
    expect((error as DerivedError).code).toBe("too_large");
    expect((error as DerivedError).message).toMatch(/256 MiB/);
    expect(await keysOf(env, modelId)).toEqual(keys);
    expect(await env.boss.findJobs(QUEUE.slicer, { data: { fileId } })).toHaveLength(jobCount);
    expect(env.stub.renders.calls).toHaveLength(0);
    expect(await env.repos.files.get(fileId)).toMatchObject({
      blobId: before.blobId,
      meshBlobId: before.meshBlobId,
      derivedStatus: "ok",
    });
  });

  test("an .stl upload queues nothing and never reaches the slicer", async () => {
    const path = await writeUpload(env, ASCII_STL);
    const { fileId } = await env.ingestDerived.ingestFile({
      tmpPath: path,
      originalName: "Plain.stl",
      target: "new",
    });
    await sleep(2000);
    expect(await env.boss.findJobs(QUEUE.slicer, { data: { fileId } })).toEqual([]);
    expect(env.stub.renders.calls).toHaveLength(0);
    expect((await env.repos.files.get(fileId))?.derivedStatus).toBeNull();
  });
});

describe("the render check (issue #91)", () => {
  test("a STEP file left with no status and no job is queued once the grace period has passed", async () => {
    const text = uniqueStep("never queued");
    const path = await writeUpload(env, text);
    // Stored with no afterCommit, as a database failure right after ingest
    // committed leaves it: derived_status null and no job.
    const { fileId } = await env.ingest.ingestFile({
      tmpPath: path,
      originalName: "Unqueued.step",
      target: "new",
    });
    expect(await env.repos.files.get(fileId)).toMatchObject({ derivedStatus: null });

    const result = await env.derived.checkRenders(
      new Date(Date.now() + RENDER_CHECK_GRACE_MS + 60_000),
    );
    expect(result.queued).toContain(fileId);
    const jobs = await env.boss.findJobs<DerivedJob>(QUEUE.slicer, { data: { fileId } });
    expect(jobs.map((j) => j.data.kind)).toEqual([DERIVED_KINDS.convertStep]);

    const file = await settledFile(env, fileId);
    expect(file.derivedStatus).toBe("ok");
    expect(file.meshBlobId).not.toBeNull();
  });
});

// PR #60 review: a STEP source is streamed from the bucket as it is sent, so
// the store can go away partway through the send (a bucket restart). That is
// a store outage like one that fails the GetObject itself: the job waits for
// the store without using a retry, and the file is never blamed on the
// slicer, even on its last attempt.
describe("a store that goes away while a STEP source is sent", () => {
  /**
   * The first bytes of text, then error: by default the outage getBlobStream
   * reports for a dropped body.
   */
  function cutOff(
    text: string,
    error: Error = new StoreUnavailable("GetObject", "ECONNRESET"),
  ): Readable {
    let sent = false;
    return new Readable({
      read() {
        if (sent) {
          setTimeout(() => this.destroy(error), 10);
          return;
        }
        sent = true;
        this.push(Buffer.from(text.slice(0, 64)));
      },
    });
  }

  test("a source read that fails partway on the last attempt waits for the store, and the mesh lands once it answers", async () => {
    const text = uniqueStep("store goes away");
    const path = await writeUpload(env, text);
    // Stored with no afterCommit, so the only job is the one run below.
    const { fileId } = await env.ingest.ingestFile({
      tmpPath: path,
      originalName: "Housing.step",
      target: "new",
    });
    const file = await env.repos.files.get(fileId);
    if (!file) throw new Error("no file");
    const job: DerivedJob = { kind: DERIVED_KINDS.convertStep, fileId, sourceBlobId: file.blobId };
    const store: DerivedStore = {
      putBlob: env.store.putBlob.bind(env.store),
      getBlobStream: async () => cutOff(text),
      deleteBlobs: env.store.deleteBlobs.bind(env.store),
    };
    const derived = createDerived({
      db: env.db,
      store,
      slicerUrl: env.stub.url,
      queue: env.boss,
      retryDelaySeconds: 1,
    });

    const outcome = await derived.runJob(job, {
      retryCount: SLICER_RETRY.retryLimit,
      retryLimit: SLICER_RETRY.retryLimit,
    });
    expect(outcome).toEqual({ status: "requeued", reason: "store_down" });
    const waiting = await env.repos.files.get(fileId);
    expect(waiting?.derivedStatus).not.toBe("failed");
    expect(waiting?.derivedMessage).toBeNull();
    // The source is kept for the next attempt.
    const source = await env.repos.blobs.get(file.blobId);
    expect(await readObject(env, source?.key ?? "")).toEqual(Buffer.from(text));

    // The env's worker runs the job it queued, against a store that answers.
    const done = await settledFile(env, fileId);
    expect(done.derivedStatus).toBe("ok");
    expect(done.meshBlobId).not.toBeNull();
    const jobs = await env.boss.findJobs<DerivedJob>(QUEUE.slicer, { data: { fileId } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toMatchObject({ ...job, waits: 1 });
  });

  // Issue #102: a body that fails with no network code is a store that
  // answered and refused (StoreError), not an outage and not the slicer.
  test("a source read that the store refuses partway on the last attempt records the storage message, not the slicer one", async () => {
    const text = uniqueStep("store refuses partway");
    const path = await writeUpload(env, text);
    const { fileId } = await env.ingest.ingestFile({
      tmpPath: path,
      originalName: "Housing.step",
      target: "new",
    });
    const file = await env.repos.files.get(fileId);
    if (!file) throw new Error("no file");
    const job: DerivedJob = { kind: DERIVED_KINDS.convertStep, fileId, sourceBlobId: file.blobId };
    const store: DerivedStore = {
      putBlob: env.store.putBlob.bind(env.store),
      getBlobStream: async () => cutOff(text, new StoreError("GetObject", "Unknown")),
      deleteBlobs: env.store.deleteBlobs.bind(env.store),
    };
    const derived = createDerived({
      db: env.db,
      store,
      slicerUrl: env.stub.url,
      queue: env.boss,
      retryDelaySeconds: 1,
    });

    const outcome = await derived.runJob(job, {
      retryCount: SLICER_RETRY.retryLimit,
      retryLimit: SLICER_RETRY.retryLimit,
    });
    expect(outcome).toEqual({ status: "failed", reason: "store_refused" });
    expect(await env.repos.files.get(fileId)).toMatchObject({
      derivedStatus: "failed",
      derivedMessage: "Storage refused this file, so the render could not finish.",
      meshBlobId: null,
    });
    // The source is kept.
    const source = await env.repos.blobs.get(file.blobId);
    expect(await readObject(env, source?.key ?? "")).toEqual(Buffer.from(text));
  });
});
