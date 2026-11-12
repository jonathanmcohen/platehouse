// Build plan Task 13: STEP meshes in the app (AC-050, decision 2). A .step or
// .stp upload is stored as uploaded; after its row commits, ingest's
// afterCommit queues a mesh job on Task 8's slicer queue, and the job posts
// the source to the slicer's /v1/step/glb (here a stub built on
// packages/slicer-contract) and stores the GLB as a new mesh_glb blob, which
// is all the browser ever loads for a STEP file.
import { randomBytes } from "node:crypto";
import { truncate } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { LIMITS } from "@platehouse/slicer-contract";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  createDerived,
  DERIVED_KINDS,
  DERIVED_MESSAGES,
  type DerivedDeps,
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

/** Put before the converter's message when the mesh is from an earlier source than the file's. */
const PREVIOUS_MESH =
  "The STEP converter rejected the current version of this file, so the mesh shown is from an earlier version. The converter said:";

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

  test("a replacement the converter rejects becomes the file's source with the converter's message, and the previous mesh stays, marked as the previous version's", async () => {
    // Jon's decision on issue #103, as for a .scad: the replacement becomes
    // the source as uploaded, the previous GLB stays attached and is said to
    // be the previous version's, and only the old source is deleted.
    const first = uniqueStep("convert error, before");
    const { modelId, fileId } = await uploadStep(first);
    const before = await settledFile(env, fileId);
    const oldSource = await env.repos.blobs.get(before.blobId);
    if (!oldSource) throw new Error("no source row");
    env.stub.renders.reset();

    const message = "STEP import failed: no shapes found";
    env.stub.renders.queue("/v1/step/glb", { kind: "failed", message });
    const next = uniqueStep("convert error, replacement");
    const { sourceBlobId } = await env.derived.replaceFile(fileId, await writeUpload(env, next));
    const after = await settledFile(env, fileId);

    expect(after).toMatchObject({
      blobId: sourceBlobId,
      size: Buffer.byteLength(next),
      meshBlobId: before.meshBlobId,
      derivedStatus: "failed",
      derivedMessage: `${PREVIOUS_MESH} ${message}`,
    });
    const blobs = await blobsOf(env, modelId);
    const byId = new Map(blobs.map((b) => [b.id, b]));
    const source = byId.get(sourceBlobId);
    expect(await readObject(env, source?.key ?? "")).toEqual(Buffer.from(next));
    // The previous GLB is still served, and its row is older than the source.
    const mesh = byId.get(before.meshBlobId ?? "");
    expect(await readObject(env, mesh?.key ?? "")).toEqual(renderedBytes("/v1/step/glb", first));
    expect(mesh?.createdAt.getTime()).toBeLessThan(source?.createdAt.getTime() ?? 0);
    // Only the old source is gone, row and object.
    expect(blobs.map((b) => b.id).sort()).toEqual([sourceBlobId, before.meshBlobId].sort());
    expect(await env.repos.blobs.get(before.blobId)).toBeUndefined();
    await expect(env.store.getBlobStream(oldSource.key)).rejects.toBeInstanceOf(BlobNotFound);
    expect(await keysOf(env, modelId)).toEqual(blobs.map((b) => b.key).sort());
  });

  test("a replacement the converter rejects, staged before the original's first mesh finished, still says the mesh is the previous version's", async () => {
    // The original's mesh commits after the replacement is staged, so its
    // row is written later than the replacement's source row; it is still
    // the original's mesh.
    const first = uniqueStep("late mesh, original");
    const { modelId, fileId } = await env.ingest.ingestFile({
      tmpPath: await writeUpload(env, first),
      originalName: "Housing.step",
      target: "new",
    });
    const original = await env.repos.files.get(fileId);
    if (!original) throw new Error("file not stored");
    const originalSource = await env.repos.blobs.get(original.blobId);
    if (!originalSource) throw new Error("no source row");

    // The replacement's job is held an hour, so only this test runs it.
    const holding = createDerived({
      db: env.db,
      store: env.store,
      slicerUrl: env.stub.url,
      queue: {
        send: ((name: string, data: object, options: Record<string, unknown>) =>
          env.boss.send(name, data, { ...options, startAfter: 3600 })) as typeof env.boss.send,
        findJobs: env.boss.findJobs.bind(env.boss),
      },
      retryDelaySeconds: 1,
    });
    const staged = await holding.replaceFile(
      fileId,
      await writeUpload(env, uniqueStep("late mesh, replacement")),
    );
    const stagedSource = await env.repos.blobs.get(staged.sourceBlobId);
    if (!stagedSource) throw new Error("no staged source row");

    expect(
      await env.derived.runJob(
        { kind: DERIVED_KINDS.convertStep, fileId, sourceBlobId: original.blobId },
        { retryCount: 0, retryLimit: SLICER_RETRY.retryLimit },
      ),
    ).toEqual({ status: "ok" });
    const between = await env.repos.files.get(fileId);
    expect(between).toMatchObject({ blobId: original.blobId, derivedStatus: "pending" });
    const meshId = between?.meshBlobId;
    if (!meshId) throw new Error("no mesh");

    const message = "STEP import failed: no shapes found";
    env.stub.renders.queue("/v1/step/glb", { kind: "failed", message });
    const held = (await env.boss.findJobs<DerivedJob>(QUEUE.slicer, { data: { fileId } })).filter(
      (j) => j.state === "created",
    );
    expect(held).toHaveLength(1);
    const job = held[0];
    if (!job) throw new Error("no held job");
    await env.boss.cancel(QUEUE.slicer, job.id);
    expect(
      await env.derived.runJob(job.data, { retryCount: 0, retryLimit: job.retryLimit }),
    ).toEqual({ status: "failed", reason: "render_failed" });

    expect(await env.repos.files.get(fileId)).toMatchObject({
      blobId: staged.sourceBlobId,
      meshBlobId: meshId,
      derivedStatus: "failed",
      derivedMessage: `${PREVIOUS_MESH} ${message}`,
    });
    const mesh = (await blobsOf(env, modelId)).find((b) => b.id === meshId);
    expect(mesh?.createdAt.getTime()).toBe(originalSource.createdAt.getTime());
    expect(mesh?.createdAt.getTime()).toBeLessThan(stagedSource.createdAt.getTime());
    expect(await readObject(env, mesh?.key ?? "")).toEqual(renderedBytes("/v1/step/glb", first));
  });

  test("after a rejected STEP replacement, a later replacement that converts deletes the previous mesh and the rejected source", async () => {
    const { modelId, fileId } = await uploadStep(uniqueStep("later mesh, before"));
    const before = await settledFile(env, fileId);
    const oldBlobs = await blobsOf(env, modelId);
    env.stub.renders.reset();

    env.stub.renders.queue("/v1/step/glb", { kind: "failed", message: "STEP import failed" });
    const rejected = await env.derived.replaceFile(
      fileId,
      await writeUpload(env, uniqueStep("later mesh, rejected")),
    );
    expect(await settledFile(env, fileId)).toMatchObject({
      blobId: rejected.sourceBlobId,
      meshBlobId: before.meshBlobId,
      derivedStatus: "failed",
    });
    const rejectedKey = (await env.repos.blobs.get(rejected.sourceBlobId))?.key ?? "";
    await until(
      () => env.boss.findJobs(QUEUE.slicer, { data: { fileId } }),
      (js) => js.every((j) => j.state === "completed"),
    );

    const good = uniqueStep("later mesh, converts");
    const { sourceBlobId } = await env.derived.replaceFile(fileId, await writeUpload(env, good));
    const after = await until(
      () => env.repos.files.get(fileId),
      (f) => f?.blobId === sourceBlobId && f?.derivedStatus === "ok",
    );
    expect(after?.derivedMessage).toBeNull();
    const blobs = await blobsOf(env, modelId);
    const byId = new Map(blobs.map((b) => [b.id, b]));
    expect(await readObject(env, byId.get(after?.meshBlobId ?? "")?.key ?? "")).toEqual(
      renderedBytes("/v1/step/glb", good),
    );
    for (const old of oldBlobs) {
      expect(byId.has(old.id)).toBe(false);
      await expect(env.store.getBlobStream(old.key)).rejects.toBeInstanceOf(BlobNotFound);
    }
    expect(byId.has(rejected.sourceBlobId)).toBe(false);
    await expect(env.store.getBlobStream(rejectedKey)).rejects.toBeInstanceOf(BlobNotFound);
    expect(blobs).toHaveLength(2);
    expect(await keysOf(env, modelId)).toEqual(blobs.map((b) => b.key).sort());
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

// Issue #104, as for a .scad: after a replacement the converter rejected, the
// file keeps the previous version's mesh and its message says so, and a later
// final failure that is the slicer's or the store's, or a conversion the
// render check finds dead, keeps that sentence before its own message. Only
// the sentence goes, not "The converter said:".
const PREVIOUS_VERSION_STEP =
  "The STEP converter rejected the current version of this file, so the mesh shown is from an earlier version.";

/** A further replacement the store refused, or whose conversion did not finish, is dropped. */
const REPLACE_STORE_REFUSED_MESSAGE = "Storage refused the replacement, so it was not saved.";
const REPLACE_LOST_MESSAGE = "The render of the replacement did not finish, so it was not saved.";

describe("after a rejected STEP replacement, a later failure keeps the previous-version sentence (issue #104)", () => {
  /** A queue that holds each job an hour, so only the test runs it; retryLimit 0 when noRetries. */
  function holdingQueue(opts: { noRetries?: boolean } = {}): DerivedDeps["queue"] {
    const send: PgBoss["send"] = async (...args: unknown[]) => {
      const [name, data, options] = args as [string, object, Record<string, unknown>];
      return (env.boss.send as (...a: unknown[]) => Promise<string | null>)(name, data, {
        ...options,
        startAfter: 3600,
        ...(opts.noRetries ? { retryLimit: 0 } : {}),
      });
    };
    return { send, findJobs: env.boss.findJobs.bind(env.boss) };
  }

  function derivedWith(overrides: Partial<DerivedDeps>) {
    return createDerived({
      db: env.db,
      store: env.store,
      slicerUrl: env.stub.url,
      queue: holdingQueue(),
      retryDelaySeconds: 1,
      ...overrides,
    });
  }

  async function heldJob(fileId: string) {
    const held = (await env.boss.findJobs<DerivedJob>(QUEUE.slicer, { data: { fileId } })).filter(
      (j) => j.state === "created",
    );
    expect(held).toHaveLength(1);
    const job = held[0];
    if (!job) throw new Error("no held job");
    return job;
  }

  /** Takes the file's one held job off the queue and runs it, as its first or its last attempt. */
  async function runHeld(
    fileId: string,
    derived: ReturnType<typeof createDerived>,
    opts: { last?: boolean } = {},
  ) {
    const job = await heldJob(fileId);
    await env.boss.cancel(QUEUE.slicer, job.id);
    return derived.runJob(job.data, {
      retryCount: opts.last ? job.retryLimit : 0,
      retryLimit: job.retryLimit,
    });
  }

  async function nothingListening(): Promise<string> {
    const s = createServer();
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", () => resolve()));
    const { port } = s.address() as AddressInfo;
    await new Promise<void>((resolve) => s.close(() => resolve()));
    return `http://127.0.0.1:${port}`;
  }

  /** A converted STEP file, then a replacement the converter rejects. */
  async function rejectedReplacement(label: string) {
    const { modelId, fileId } = await uploadStep(uniqueStep(`${label}, original`));
    const before = await settledFile(env, fileId);
    const refusal = "STEP import failed: no shapes found";
    env.stub.renders.queue("/v1/step/glb", { kind: "failed", message: refusal });
    const { sourceBlobId } = await env.derived.replaceFile(
      fileId,
      await writeUpload(env, uniqueStep(`${label}, rejected`)),
    );
    expect(await settledFile(env, fileId)).toMatchObject({
      blobId: sourceBlobId,
      meshBlobId: before.meshBlobId,
      derivedStatus: "failed",
      derivedMessage: `${PREVIOUS_MESH} ${refusal}`,
    });
    await until(
      () => env.boss.findJobs(QUEUE.slicer, { data: { fileId } }),
      (js) => js.every((j) => j.state === "completed"),
    );
    env.stub.renders.reset();
    return { modelId, fileId, before, rejectedBlobId: sourceBlobId };
  }

  async function expectKept(
    fileId: string,
    before: { meshBlobId: string | null },
    rejectedBlobId: string,
    message: string,
  ) {
    expect(await env.repos.files.get(fileId)).toMatchObject({
      blobId: rejectedBlobId,
      meshBlobId: before.meshBlobId,
      derivedStatus: "failed",
      derivedMessage: `${PREVIOUS_VERSION_STEP} ${message}`,
    });
  }

  test("a conversion of the rejected source whose slicer stays down past 2 hours keeps the sentence", async () => {
    const { fileId, before, rejectedBlobId } = await rejectedReplacement("slicer down");
    let now = Date.now();
    const refused = await nothingListening();
    const down = () => derivedWith({ slicerUrl: refused, now: () => new Date(now) });
    await derivedWith({}).convertStep(fileId);

    expect(await runHeld(fileId, down())).toEqual({ status: "requeued", reason: "slicer_down" });
    now += 2 * 60 * 60 * 1000 + 1000;
    expect(await runHeld(fileId, down())).toEqual({ status: "failed", reason: "slicer_down" });
    await expectKept(fileId, before, rejectedBlobId, DERIVED_MESSAGES.slicerDown);
  });

  test("a further replacement whose source the store refuses partway on the last attempt keeps the sentence and the rejected source", async () => {
    const { modelId, fileId, before, rejectedBlobId } = await rejectedReplacement("refused");
    const blobsBefore = (await blobsOf(env, modelId)).map((b) => b.id);
    const next = uniqueStep("refused, never sent whole");
    await derivedWith({}).replaceFile(fileId, await writeUpload(env, next));
    // The first bytes of the staged source, then a body that fails with no
    // network code: a store that answered and refused (issue #102).
    const refusing: DerivedStore = {
      putBlob: env.store.putBlob.bind(env.store),
      getBlobStream: async () => {
        let sent = false;
        return new Readable({
          read() {
            if (sent) {
              setTimeout(() => this.destroy(new StoreError("GetObject", "Unknown")), 10);
              return;
            }
            sent = true;
            this.push(Buffer.from(next.slice(0, 64)));
          },
        });
      },
      deleteBlobs: env.store.deleteBlobs.bind(env.store),
    };

    expect(await runHeld(fileId, derivedWith({ store: refusing }), { last: true })).toEqual({
      status: "failed",
      reason: "store_refused",
    });
    await expectKept(fileId, before, rejectedBlobId, REPLACE_STORE_REFUSED_MESSAGE);
    expect((await blobsOf(env, modelId)).map((b) => b.id)).toEqual(blobsBefore);
  });

  test("a further replacement whose last job died keeps the sentence and the rejected source when the render check settles it", async () => {
    const { fileId, before, rejectedBlobId } = await rejectedReplacement("died");
    await derivedWith({ queue: holdingQueue({ noRetries: true }) }).replaceFile(
      fileId,
      await writeUpload(env, uniqueStep("died, replacement")),
    );
    const job = await heldJob(fileId);
    await env.boss.fail(QUEUE.slicer, job.id, { message: "the process died mid-conversion" });

    const result = await env.derived.checkRenders(
      new Date(Date.now() + RENDER_CHECK_GRACE_MS + 60_000),
    );
    expect(result.failed).toContain(fileId);
    await expectKept(fileId, before, rejectedBlobId, REPLACE_LOST_MESSAGE);
  });

  test("a conversion of the rejected source that cannot be queued keeps the sentence", async () => {
    const { fileId, before, rejectedBlobId } = await rejectedReplacement("not queued");
    const send: PgBoss["send"] = async () => {
      throw new Error("the queue refused the job");
    };
    const failing = derivedWith({
      queue: { send, findJobs: env.boss.findJobs.bind(env.boss) },
    });

    await expect(failing.convertStep(fileId)).rejects.toThrow("the queue refused the job");
    await expectKept(fileId, before, rejectedBlobId, DERIVED_MESSAGES.queueFailed);
  });

  // Issue #146: while the file is pending it still shows the previous
  // version's mesh, so the sentence stays, alone, until the job settles.
  // Before, every pending write cleared the message to null.
  async function expectPending(
    fileId: string,
    before: { meshBlobId: string | null },
    rejectedBlobId: string,
  ) {
    expect(await env.repos.files.get(fileId)).toMatchObject({
      blobId: rejectedBlobId,
      meshBlobId: before.meshBlobId,
      derivedStatus: "pending",
      derivedMessage: PREVIOUS_VERSION_STEP,
    });
  }

  test("a queued conversion of the rejected source keeps the sentence while it is pending", async () => {
    const { fileId, before, rejectedBlobId } = await rejectedReplacement("pending");
    await derivedWith({}).convertStep(fileId);
    await expectPending(fileId, before, rejectedBlobId);
  });

  test("a further replacement keeps the sentence while it is pending", async () => {
    const { fileId, before, rejectedBlobId } = await rejectedReplacement("replacement pending");
    await derivedWith({}).replaceFile(
      fileId,
      await writeUpload(env, uniqueStep("held replacement")),
    );
    await expectPending(fileId, before, rejectedBlobId);
  });

  test("a conversion of the rejected source that fails while a newer replacement is queued leaves the file pending with the sentence", async () => {
    const { fileId, before, rejectedBlobId } = await rejectedReplacement("newer queued");
    const held = derivedWith({});
    await held.convertStep(fileId);
    await held.replaceFile(fileId, await writeUpload(env, uniqueStep("newer queued, held")));
    const jobs = await env.boss.findJobs<DerivedJob>(QUEUE.slicer, { data: { fileId } });
    const reConvert = jobs.find(
      (j) => j.state === "created" && j.data.sourceBlobId === rejectedBlobId,
    );
    if (!reConvert) throw new Error("no held conversion");
    await env.boss.cancel(QUEUE.slicer, reConvert.id);
    env.stub.renders.always("/v1/step/glb", { kind: "drop" });

    const outcome = await held.runJob(reConvert.data, {
      retryCount: reConvert.retryLimit,
      retryLimit: reConvert.retryLimit,
    });
    expect(outcome).toEqual({ status: "failed", reason: "slicer_error" });
    await expectPending(fileId, before, rejectedBlobId);
  });
});
