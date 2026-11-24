// STEP meshes in the app, converted on the server so a browser only ever loads a GLB. A .step or
// .stp upload is stored as uploaded; after its row commits, ingest's
// afterCommit queues a mesh job on the slicer queue, and the job posts
// the source to the slicer's /v1/step/glb (here a stub built on
// packages/slicer-contract) and stores the GLB as a new mesh_glb blob, which
// is all the browser ever loads for a STEP file.
//
// Issue #316: once the mesh is stored, the same transaction queues a
// preview-step job, which reads that stored GLB back, sends it to the
// slicer's /v1/stl/png as an STL and stores the PNG as a render_png blob. The
// STEP file is never converted a second time for its preview. A preview that
// fails keeps the mesh, shows the icon and says why.
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, truncate } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { LIMITS } from "@platehouse/slicer-contract";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { CONVERT_EXPIRE_SECONDS } from "../../../src/derived/client.js";
import {
  createDerived,
  DERIVED_KINDS,
  DERIVED_MESSAGES,
  type Derived,
  type DerivedDeps,
  DerivedError,
  type DerivedJob,
  type DerivedStore,
  RENDER_CHECK_GRACE_MS,
} from "../../../src/derived/derived.js";
import { QUEUE, SLICER_RETRY } from "../../../src/jobs/queues.js";
import { memoryGate } from "../../../src/memory/gate.js";
import { BlobNotFound, StoreError, StoreUnavailable } from "../../../src/storage/s3.js";
import { renderedBytes, sandboxOff } from "../../support/slicer-stub.js";
import {
  blobsOf,
  type DerivedEnv,
  keysOf,
  meshPreviewBytes,
  meshStl,
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

/** Before OpenSCAD's message when it rejects the mesh's preview (issue #316). */
const PREVIEW_REJECTED = "The preview picture could not be rendered. OpenSCAD said:";

/** Put before the converter's message when the mesh is from an earlier source than the file's. */
const PREVIOUS_MESH =
  "The STEP converter rejected the current version of this file, so the mesh shown is from an earlier version. The converter said:";

describe("STEP meshes", () => {
  test("a .step upload produces a GLB mesh blob, then a preview made from that mesh", async () => {
    const text = uniqueStep("mesh");
    const { modelId, fileId } = await uploadStep(text);
    const file = await settledFile(env, fileId);

    expect(file.derivedStatus).toBe("ok");
    expect(file.derivedMessage).toBeNull();
    // The picture's own status (issue #380).
    expect(file.previewStatus).toBe("ok");
    expect(file.previewMessage).toBeNull();
    expect(file.meshBlobId).not.toBeNull();
    expect(file.renderStlBlobId).toBeNull();
    expect(file.renderPngBlobId).not.toBeNull();

    const blobs = await blobsOf(env, modelId);
    const mesh = blobs.find((b) => b.id === file.meshBlobId);
    expect(mesh).toMatchObject({
      kind: "mesh_glb",
      state: "stored",
      contentType: "model/gltf-binary",
    });
    const meshBytes = await readObject(env, mesh?.key ?? "");
    expect(meshBytes).toEqual(renderedBytes("/v1/step/glb", text));
    const png = blobs.find((b) => b.id === file.renderPngBlobId);
    expect(png).toMatchObject({ kind: "render_png", state: "stored", contentType: "image/png" });
    expect(await readObject(env, png?.key ?? "")).toEqual(await meshPreviewBytes(meshBytes));
    expect(blobs.map((b) => b.kind).sort()).toEqual(["mesh_glb", "render_png", "source"]);
    expect(await keysOf(env, modelId)).toEqual(blobs.map((b) => b.key).sort());

    // One conversion: the preview is made from the stored mesh, sent as STL.
    const calls = env.stub.renders.callsTo("/v1/step/glb");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.toString("utf8")).toBe(text);
    expect(calls[0]?.contentType).toBe("application/octet-stream");
    const previews = env.stub.renders.callsTo("/v1/stl/png");
    expect(previews).toHaveLength(1);
    expect(previews[0]?.body.equals(await meshStl(meshBytes))).toBe(true);
    expect(previews[0]?.contentType).toBe("application/octet-stream");

    const jobs = await env.boss.findJobs<DerivedJob>(QUEUE.slicer, { data: { fileId } });
    expect(jobs.map((j) => j.data.kind)).toEqual([DERIVED_KINDS.convertStep, "preview-step"]);
    // The preview job renders the source the mesh was made from.
    expect(jobs[1]?.data.sourceBlobId).toBe(file.blobId);
  });

  test("a preview OpenSCAD rejects keeps the mesh, leaves no preview, and says why", async () => {
    const message = "ERROR: STL import: too many facets";
    env.stub.renders.queue("/v1/stl/png", { kind: "failed", message });
    const { modelId, fileId } = await uploadStep(uniqueStep("preview rejected"));
    const file = await settledFile(env, fileId);
    // The mesh is fine, so derivedStatus says ok; the failure is the
    // picture's alone (issue #380).
    expect(file).toMatchObject({
      derivedStatus: "ok",
      derivedMessage: null,
      previewStatus: "failed",
      previewMessage: `${PREVIEW_REJECTED} ${message}`,
      renderPngBlobId: null,
    });
    expect(file.meshBlobId).not.toBeNull();
    expect((await blobsOf(env, modelId)).map((b) => b.kind).sort()).toEqual(["mesh_glb", "source"]);
    expect(env.stub.renders.callsTo("/v1/step/glb")).toHaveLength(1);
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
    expect(file.renderPngBlobId).toBeNull();
    // No mesh, so no picture was ever queued.
    expect(file.previewStatus).toBeNull();
    const blobs = await blobsOf(env, modelId);
    expect(blobs.map((b) => b.kind)).toEqual(["source"]);
    expect(await readObject(env, blobs[0]?.key ?? "")).toEqual(Buffer.from(text));
    // With no mesh there is nothing to preview.
    expect(env.stub.renders.callsTo("/v1/stl/png")).toHaveLength(0);
  });

  test("a conversion the sandbox refuses is recorded once with its reason: no wait, no retry, no picture", async () => {
    env.stub.renders.always("/v1/step/glb", sandboxOff("check_failed"));
    const { modelId, fileId } = await uploadStep(uniqueStep("sandbox off"));
    const file = await settledFile(env, fileId);
    expect(file).toMatchObject({
      derivedStatus: "failed",
      derivedMessage: DERIVED_MESSAGES.convertSandboxOffCheck,
      meshBlobId: null,
      previewStatus: null,
    });
    expect((await blobsOf(env, modelId)).map((b) => b.kind)).toEqual(["source"]);
    expect(env.stub.renders.callsTo("/v1/step/glb")).toHaveLength(1);
    const jobs = await env.boss.findJobs<DerivedJob>(QUEUE.slicer, { data: { fileId } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.output).toMatchObject({ status: "failed", reason: "sandbox_off" });
    expect(jobs[0]?.retryCount).toBe(0);
  });

  test("a preview the sandbox refuses keeps the mesh and says the picture is off", async () => {
    env.stub.renders.always("/v1/stl/png", sandboxOff("old_kernel"));
    const { fileId } = await uploadStep(uniqueStep("preview sandbox off"));
    const file = await settledFile(env, fileId);
    expect(file).toMatchObject({
      derivedStatus: "ok",
      derivedMessage: null,
      previewStatus: "failed",
      previewMessage: DERIVED_MESSAGES.sandboxOffKernel,
      renderPngBlobId: null,
    });
    expect(file.meshBlobId).not.toBeNull();
    expect(env.stub.renders.callsTo("/v1/stl/png")).toHaveLength(1);
  });

  test("replacing a .step converts the new file and removes the old mesh, preview and source", async () => {
    const { modelId, fileId } = await uploadStep(uniqueStep("old"));
    const before = await settledFile(env, fileId);
    const oldBlobs = await blobsOf(env, modelId);

    const next = uniqueStep("new");
    await env.derived.replaceFile(fileId, await writeUpload(env, next));
    // derivedStatus is ok once the mesh is stored; the picture comes after.
    const after = await until(
      () => env.repos.files.get(fileId),
      (f) => f?.blobId !== before.blobId && f?.derivedStatus === "ok" && f?.previewStatus === "ok",
    );
    const blobs = await blobsOf(env, modelId);
    const mesh = blobs.find((b) => b.id === after?.meshBlobId);
    const meshBytes = await readObject(env, mesh?.key ?? "");
    expect(meshBytes).toEqual(renderedBytes("/v1/step/glb", next));
    const png = blobs.find((b) => b.id === after?.renderPngBlobId);
    expect(await readObject(env, png?.key ?? "")).toEqual(await meshPreviewBytes(meshBytes));
    expect(blobs).toHaveLength(3);
    expect(oldBlobs).toHaveLength(3);
    for (const old of oldBlobs) {
      await expect(env.store.getBlobStream(old.key)).rejects.toBeInstanceOf(BlobNotFound);
    }
  });

  test("a replacement the converter rejects becomes the file's source with the converter's message, and the previous mesh stays, marked as the previous version's", async () => {
    // The maintainer's decision on issue #103, as for a .scad: the replacement becomes
    // the source as uploaded, the previous GLB stays attached and is said to
    // be the previous version's, and only the old source is deleted. The
    // previous version's preview picture goes too (issue #316): a card
    // cannot say a picture is of an earlier version, so it shows the icon.
    const first = uniqueStep("convert error, before");
    const { modelId, fileId } = await uploadStep(first);
    const before = await settledFile(env, fileId);
    const oldSource = await env.repos.blobs.get(before.blobId);
    if (!oldSource) throw new Error("no source row");
    const oldPng = await env.repos.blobs.get(before.renderPngBlobId ?? "");
    if (!oldPng) throw new Error("no preview row");
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
      renderPngBlobId: null,
      previewStatus: null,
      previewMessage: null,
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
    // The old source and the old preview are gone, rows and objects.
    expect(blobs.map((b) => b.id).sort()).toEqual([sourceBlobId, before.meshBlobId].sort());
    expect(await env.repos.blobs.get(before.blobId)).toBeUndefined();
    await expect(env.store.getBlobStream(oldSource.key)).rejects.toBeInstanceOf(BlobNotFound);
    expect(await env.repos.blobs.get(oldPng.id)).toBeUndefined();
    await expect(env.store.getBlobStream(oldPng.key)).rejects.toBeInstanceOf(BlobNotFound);
    expect(await keysOf(env, modelId)).toEqual(blobs.map((b) => b.key).sort());
    // Nothing tries to preview the earlier version's mesh.
    expect(env.stub.renders.callsTo("/v1/stl/png")).toHaveLength(0);
  });

  // The slicer starts the converter's own words with "The converter said: ",
  // which the previous-mesh sentence already ends with: it is said once.
  test("a rejected replacement's message names the converter once after the previous-mesh sentence", async () => {
    const { fileId } = await uploadStep(uniqueStep("lead-in, before"));
    const before = await settledFile(env, fileId);
    expect(before.meshBlobId).not.toBeNull();
    env.stub.renders.reset();

    env.stub.renders.queue("/v1/step/glb", {
      kind: "failed",
      message: "The converter said: STEP import failed: no shapes found",
    });
    await env.derived.replaceFile(
      fileId,
      await writeUpload(env, uniqueStep("lead-in, replacement")),
    );
    expect(await settledFile(env, fileId)).toMatchObject({
      meshBlobId: before.meshBlobId,
      derivedStatus: "failed",
      derivedMessage: `${PREVIOUS_MESH} STEP import failed: no shapes found`,
    });
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
    // A newer replacement is queued, so no preview is queued for this mesh.
    expect(between).toMatchObject({
      blobId: original.blobId,
      derivedStatus: "pending",
      renderPngBlobId: null,
      previewStatus: null,
    });
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
      (f) => f?.blobId === sourceBlobId && f?.derivedStatus === "ok" && f?.previewStatus === "ok",
    );
    expect(after?.derivedMessage).toBeNull();
    expect(after?.previewMessage).toBeNull();
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
    // The new source, its mesh and the preview made from that mesh.
    expect(blobs.map((b) => b.kind).sort()).toEqual(["mesh_glb", "render_png", "source"]);
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

  // Until issue #316 an .stl queued nothing. It now queues its preview and
  // nothing else: it is never sent to the STEP converter (stl.test.ts covers
  // the preview itself).
  test("an .stl upload queues only its preview and is never converted", async () => {
    const path = await writeUpload(env, ASCII_STL);
    const { fileId } = await env.ingestDerived.ingestFile({
      tmpPath: path,
      originalName: "Plain.stl",
      target: "new",
    });
    await settledFile(env, fileId);
    const jobs = await env.boss.findJobs<DerivedJob>(QUEUE.slicer, { data: { fileId } });
    expect(jobs.map((j) => j.data.kind)).toEqual(["render-stl"]);
    expect(env.stub.renders.calls.map((c) => c.route)).toEqual(["/v1/stl/png"]);
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
    expect(jobs[0]?.data.kind).toBe(DERIVED_KINDS.convertStep);

    const file = await settledFile(env, fileId);
    expect(file.derivedStatus).toBe("ok");
    expect(file.meshBlobId).not.toBeNull();
    expect(file.renderPngBlobId).not.toBeNull();
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
    // The conversion it sent again, then the preview of the mesh it stored.
    expect(jobs.map((j) => j.data.kind)).toEqual([DERIVED_KINDS.convertStep, "preview-step"]);
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

// PR #363 review: a STEP file's picture could be left 'pending' with no job
// behind it, and the model page then polled every 5 s for good. A picture
// committed while a newer replacement's conversion is queued is stored
// 'pending' (settledOutcome); when that conversion then ends with no new
// mesh, nothing queued a picture and nothing settled the old one. The same
// is left by a preview job that finds the file changed under it.
describe("a STEP preview picture left pending with no job behind it is settled", () => {
  /**
   * A derived whose queue holds each job an hour, so only the test runs it;
   * with retryLimit 0 when noRetries, so a job the test fails ends failed
   * rather than waiting for a retry.
   */
  function holding(opts: { noRetries?: boolean; tmpDir?: string } = {}) {
    const send: PgBoss["send"] = async (...args: unknown[]) => {
      const [name, data, options] = args as [string, object, Record<string, unknown>];
      return (env.boss.send as (...a: unknown[]) => Promise<string | null>)(name, data, {
        ...options,
        startAfter: 3600,
        ...(opts.noRetries ? { retryLimit: 0 } : {}),
      });
    };
    return createDerived({
      db: env.db,
      store: env.store,
      slicerUrl: env.stub.url,
      queue: { send, findJobs: env.boss.findJobs.bind(env.boss) },
      retryDelaySeconds: 1,
      ...(opts.tmpDir === undefined ? {} : { tmpDir: opts.tmpDir }),
    });
  }

  /** The file's one held job of kind, taken off the queue so only the test runs it. */
  async function takeHeld(fileId: string, kind: DerivedJob["kind"]) {
    const held = (await env.boss.findJobs<DerivedJob>(QUEUE.slicer, { data: { fileId } })).filter(
      (j) => j.state === "created" && j.data.kind === kind,
    );
    expect(held).toHaveLength(1);
    const job = held[0];
    if (!job) throw new Error(`no held ${kind} job`);
    await env.boss.cancel(QUEUE.slicer, job.id);
    return job;
  }

  /**
   * A STEP file with its first mesh stored and its picture's job held, then
   * a replacement staged with its conversion held.
   */
  async function meshThenReplacement(label: string, opts: { noRetries?: boolean } = {}) {
    const { fileId } = await env.ingest.ingestFile({
      tmpPath: await writeUpload(env, uniqueStep(`${label}, original`)),
      originalName: "Housing.step",
      target: "new",
    });
    const original = await env.repos.files.get(fileId);
    if (!original) throw new Error("file not stored");
    const derived = holding(opts);
    expect(
      await derived.runJob(
        { kind: DERIVED_KINDS.convertStep, fileId, sourceBlobId: original.blobId },
        { retryCount: 0, retryLimit: SLICER_RETRY.retryLimit },
      ),
    ).toEqual({ status: "ok" });
    expect(await env.repos.files.get(fileId)).toMatchObject({
      derivedStatus: "ok",
      previewStatus: "pending",
      renderPngBlobId: null,
    });
    const staged = await derived.replaceFile(
      fileId,
      await writeUpload(env, uniqueStep(`${label}, replacement`)),
    );
    return { fileId, derived, original, stagedBlobId: staged.sourceBlobId };
  }

  /** Runs the held picture job of the original, which commits while the replacement is queued. */
  async function previewWhileQueued(fileId: string, derived: ReturnType<typeof createDerived>) {
    const job = await takeHeld(fileId, DERIVED_KINDS.previewStep);
    expect(await derived.runJob(job.data, { retryCount: 0, retryLimit: job.retryLimit })).toEqual({
      status: "ok",
    });
    const file = await env.repos.files.get(fileId);
    // The picture is stored and is of the current source, so it is ok and
    // shown while the replacement waits: a replacement not yet saved changes
    // nothing about the current source (issue #389).
    expect(file).toMatchObject({ derivedStatus: "pending", previewStatus: "ok" });
    expect(file?.renderPngBlobId).not.toBeNull();
    return file?.renderPngBlobId ?? "";
  }

  test("a picture committed while a replacement was queued is ok once that replacement's conversion ends with a slicer error", async () => {
    const { fileId, derived, original, stagedBlobId } = await meshThenReplacement("slicer error");
    const png = await previewWhileQueued(fileId, derived);

    env.stub.renders.always("/v1/step/glb", { kind: "drop" });
    const convert = await takeHeld(fileId, DERIVED_KINDS.convertStep);
    expect(convert.data.sourceBlobId).toBe(stagedBlobId);
    expect(
      await derived.runJob(convert.data, {
        retryCount: convert.retryLimit,
        retryLimit: convert.retryLimit,
      }),
    ).toEqual({ status: "failed", reason: "slicer_error" });

    // The replacement is dropped; the original keeps its mesh and the
    // picture made from it, which is no longer waiting on anything.
    expect(await env.repos.files.get(fileId)).toMatchObject({
      blobId: original.blobId,
      derivedStatus: "failed",
      derivedMessage: DERIVED_MESSAGES.replaceFailed,
      previewStatus: "ok",
      previewMessage: null,
      renderPngBlobId: png,
    });
  });

  test("a picture whose own job is still queued stays pending when the replacement's conversion ends with a slicer error", async () => {
    const { fileId, derived, original } = await meshThenReplacement("picture still queued");

    env.stub.renders.always("/v1/step/glb", { kind: "drop" });
    const convert = await takeHeld(fileId, DERIVED_KINDS.convertStep);
    expect(
      await derived.runJob(convert.data, {
        retryCount: convert.retryLimit,
        retryLimit: convert.retryLimit,
      }),
    ).toEqual({ status: "failed", reason: "slicer_error" });

    // The original's picture job still owns the picture's state.
    expect(await env.repos.files.get(fileId)).toMatchObject({
      blobId: original.blobId,
      derivedStatus: "failed",
      previewStatus: "pending",
      renderPngBlobId: null,
    });
    await takeHeld(fileId, DERIVED_KINDS.previewStep);
  });

  test("the render check marks ok a picture of the current source left pending when the replacement's conversion died", async () => {
    const { fileId, derived, original } = await meshThenReplacement("conversion died", {
      noRetries: true,
    });
    const png = await previewWhileQueued(fileId, derived);
    const convert = (await env.boss.findJobs<DerivedJob>(QUEUE.slicer, { data: { fileId } })).find(
      (j) => j.state === "created" && j.data.kind === DERIVED_KINDS.convertStep,
    );
    if (!convert) throw new Error("no held conversion");
    await env.boss.fail(QUEUE.slicer, convert.id, { message: "the process died mid-conversion" });

    const result = await env.derived.checkRenders(
      new Date(Date.now() + RENDER_CHECK_GRACE_MS + 60_000),
    );
    // The conversion did not finish; the picture did, so it is not failed.
    expect(result.failed).toContain(fileId);
    expect(await env.repos.files.get(fileId)).toMatchObject({
      blobId: original.blobId,
      derivedStatus: "failed",
      derivedMessage: DERIVED_MESSAGES.replaceLost,
      previewStatus: "ok",
      previewMessage: null,
      renderPngBlobId: png,
    });
  });

  test("the render check clears a picture left pending by a preview job that found the file changed under it", async () => {
    const { fileId, derived, stagedBlobId } = await meshThenReplacement("stale preview");
    // The replacement is rejected: it becomes the source and the original's
    // mesh stays, with no picture made from it yet.
    env.stub.renders.queue("/v1/step/glb", { kind: "failed", message: "STEP import failed" });
    const convert = await takeHeld(fileId, DERIVED_KINDS.convertStep);
    expect(
      await derived.runJob(convert.data, { retryCount: 0, retryLimit: convert.retryLimit }),
    ).toEqual({ status: "failed", reason: "render_failed" });
    // The original's picture job is for a source that is no longer the
    // file's, so it does not make the picture pending (issue #389): with no
    // picture, job or failure for the current source, there is none.
    expect(await env.repos.files.get(fileId)).toMatchObject({
      blobId: stagedBlobId,
      previewStatus: null,
      renderPngBlobId: null,
    });
    // When it runs, it finds the source changed and does nothing.
    const preview = await takeHeld(fileId, DERIVED_KINDS.previewStep);
    expect(
      await derived.runJob(preview.data, { retryCount: 0, retryLimit: preview.retryLimit }),
    ).toEqual({ status: "skipped", reason: "stale" });
    expect(await env.repos.files.get(fileId)).toMatchObject({
      blobId: stagedBlobId,
      previewStatus: null,
      renderPngBlobId: null,
    });

    const result = await env.derived.checkRenders(
      new Date(Date.now() + RENDER_CHECK_GRACE_MS + 60_000),
    );
    expect(result.failed).not.toContain(fileId);
    expect(await env.repos.files.get(fileId)).toMatchObject({
      blobId: stagedBlobId,
      derivedStatus: "failed",
      previewStatus: null,
      previewMessage: null,
      renderPngBlobId: null,
    });
    expect(env.stub.renders.callsTo("/v1/stl/png")).toHaveLength(0);
  });

  // Review of PR #409: a STEP preview reads its whole mesh into the app, so
  // it goes through the process's memory gate, shared with the plate mesh
  // builds, and asks the slicer for nothing while it waits for it.
  describe("and the process's memory gate", () => {
    /** A STEP file with its mesh stored and its picture's job taken off the queue. */
    async function meshWithHeldPreview(label: string) {
      const { fileId } = await env.ingest.ingestFile({
        tmpPath: await writeUpload(env, uniqueStep(label)),
        originalName: "Bracket.step",
        target: "new",
      });
      const file = await env.repos.files.get(fileId);
      if (!file) throw new Error("file not stored");
      const derived = holding();
      expect(
        await derived.runJob(
          { kind: DERIVED_KINDS.convertStep, fileId, sourceBlobId: file.blobId },
          { retryCount: 0, retryLimit: SLICER_RETRY.retryLimit },
        ),
      ).toEqual({ status: "ok" });
      const job = await takeHeld(fileId, DERIVED_KINDS.previewStep);
      return { fileId, derived, job };
    }

    /** Holds the process's memory gate, as a plate build does, until release(). */
    function holdGate() {
      let release: () => void = () => undefined;
      const held = memoryGate.run(
        "plate-held-by-the-test",
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
        new AbortController().signal,
      );
      return { release: () => release(), held };
    }

    test("a preview waits for a job holding the gate, sending nothing to the slicer meanwhile", async () => {
      const { fileId, derived, job } = await meshWithHeldPreview("gate, waits");
      const before = env.stub.renders.callsTo("/v1/stl/png").length;
      const gate = holdGate();
      try {
        const run = derived.runJob(job.data, { retryCount: 0, retryLimit: job.retryLimit });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(env.stub.renders.callsTo("/v1/stl/png")).toHaveLength(before);
        gate.release();
        await gate.held;
        expect(await run).toEqual({ status: "ok" });
        expect(env.stub.renders.callsTo("/v1/stl/png")).toHaveLength(before + 1);
        expect(await env.repos.files.get(fileId)).toMatchObject({ previewStatus: "ok" });
      } finally {
        gate.release();
      }
    });

    test("two previews of the same file from two jobs use a key each, so both run", async () => {
      const { derived, job } = await meshWithHeldPreview("gate, two jobs");
      const before = env.stub.renders.callsTo("/v1/stl/png").length;
      const gate = holdGate();
      try {
        const runs = ["job-a", "job-b"].map((jobId) =>
          derived.runJob(job.data, { retryCount: 0, retryLimit: job.retryLimit, jobId }),
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        gate.release();
        await gate.held;
        expect(await Promise.all(runs)).toEqual([{ status: "ok" }, { status: "ok" }]);
        expect(env.stub.renders.callsTo("/v1/stl/png")).toHaveLength(before + 2);
      } finally {
        gate.release();
      }
    });

    // Review of PR #409, follow-up: the slicer's answer is streamed to a
    // file in the job's own temp folder and stored from it; the folder goes
    // whatever the job's end.
    test("a job's temp folder is gone after a stored mesh, a refused conversion and a lost connection", async () => {
      const tmp = await mkdtemp(join(tmpdir(), "derived-jobs-"));
      try {
        const derived = holding({ tmpDir: tmp });
        const convert = async (label: string) => {
          const { fileId } = await env.ingest.ingestFile({
            tmpPath: await writeUpload(env, uniqueStep(label)),
            originalName: "Part.step",
            target: "new",
          });
          const file = await env.repos.files.get(fileId);
          if (!file) throw new Error("file not stored");
          return derived.runJob(
            { kind: DERIVED_KINDS.convertStep, fileId, sourceBlobId: file.blobId },
            { retryCount: 0, retryLimit: SLICER_RETRY.retryLimit },
          );
        };
        expect(await convert("temp folder, stored")).toEqual({ status: "ok" });
        expect(await readdir(tmp)).toEqual([]);
        env.stub.renders.queue("/v1/step/glb", { kind: "failed", message: "no shapes" });
        expect(await convert("temp folder, refused")).toEqual({
          status: "failed",
          reason: "render_failed",
        });
        expect(await readdir(tmp)).toEqual([]);
        env.stub.renders.queue("/v1/step/glb", { kind: "drop" });
        await expect(convert("temp folder, lost")).rejects.toThrow();
        expect(await readdir(tmp)).toEqual([]);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });

    test("a preview whose file lost its mesh while it waited does nothing", async () => {
      const { fileId, derived, job } = await meshWithHeldPreview("gate, superseded");
      const before = env.stub.renders.callsTo("/v1/stl/png").length;
      const gate = holdGate();
      try {
        const run = derived.runJob(job.data, { retryCount: 0, retryLimit: job.retryLimit });
        await new Promise((resolve) => setTimeout(resolve, 300));
        await env.db
          .updateTable("files")
          .set({ meshBlobId: null })
          .where("id", "=", fileId)
          .execute();
        gate.release();
        await gate.held;
        expect(await run).toEqual({ status: "skipped", reason: "stale" });
        expect(env.stub.renders.callsTo("/v1/stl/png")).toHaveLength(before);
      } finally {
        gate.release();
      }
    });
  });
});

// Issue #441: a STEP conversion's job expiry covers storing its mesh, on
// every send of a conversion job: queued for a file, for a replacement, by
// the render check, and again after a wait for a slicer that is down. The
// preview job a conversion queues keeps its options as they were.
describe("a STEP conversion's job expiry", () => {
  interface Sent {
    kind: string;
    fileId: string;
    options: Record<string, unknown>;
  }

  /** A queue that records each send and holds its job an hour, so only the test runs it. */
  function recordingQueue(sent: Sent[]): DerivedDeps["queue"] {
    const send: PgBoss["send"] = async (...args: unknown[]) => {
      const [name, data, options] = args as [string, DerivedJob, Record<string, unknown>];
      sent.push({ kind: data.kind, fileId: data.fileId, options });
      return (env.boss.send as (...a: unknown[]) => Promise<string | null>)(name, data, {
        ...options,
        startAfter: 3600,
      });
    };
    return { send, findJobs: env.boss.findJobs.bind(env.boss) };
  }

  function recording(sent: Sent[], overrides: Partial<DerivedDeps> = {}): Derived {
    return createDerived({
      db: env.db,
      store: env.store,
      slicerUrl: env.stub.url,
      queue: recordingQueue(sent),
      retryDelaySeconds: 1,
      ...overrides,
    });
  }

  /** Takes the file's one held conversion off the queue and runs it as its first attempt. */
  async function runHeldConversion(fileId: string, derived: Derived) {
    const held = (await env.boss.findJobs<DerivedJob>(QUEUE.slicer, { data: { fileId } })).filter(
      (j) => j.state === "created",
    );
    expect(held).toHaveLength(1);
    const job = held[0];
    if (!job) throw new Error("no held job");
    expect(job.data.kind).toBe(DERIVED_KINDS.convertStep);
    // pg-boss keeps the expiry the send gave.
    expect(job.expireInSeconds).toBe(CONVERT_EXPIRE_SECONDS);
    await env.boss.cancel(QUEUE.slicer, job.id);
    return derived.runJob(job.data, { retryCount: 0, retryLimit: job.retryLimit });
  }

  async function nothingListening(): Promise<string> {
    const s = createServer();
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", () => resolve()));
    const { port } = s.address() as AddressInfo;
    await new Promise<void>((resolve) => s.close(() => resolve()));
    return `http://127.0.0.1:${port}`;
  }

  /** A STEP file converted the usual way, with every job of it finished. */
  async function convertedStep(label: string): Promise<string> {
    const { fileId } = await uploadStep(uniqueStep(label));
    await settledFile(env, fileId);
    await until(
      () => env.boss.findJobs(QUEUE.slicer, { data: { fileId } }),
      (js) => js.every((j) => j.state === "completed"),
    );
    return fileId;
  }

  test("a conversion and its requeue after a wait for the slicer carry the expiry, and its preview does not", async () => {
    const fileId = await convertedStep("expiry");
    const sent: Sent[] = [];
    await recording(sent).convertStep(fileId);
    const down = recording(sent, { slicerUrl: await nothingListening() });
    expect(await runHeldConversion(fileId, down)).toEqual({
      status: "requeued",
      reason: "slicer_down",
    });
    expect(await runHeldConversion(fileId, recording(sent))).toEqual({ status: "ok" });

    expect(sent.map((s) => [s.kind, s.fileId, s.options.expireInSeconds])).toEqual([
      [DERIVED_KINDS.convertStep, fileId, CONVERT_EXPIRE_SECONDS],
      [DERIVED_KINDS.convertStep, fileId, CONVERT_EXPIRE_SECONDS],
      [DERIVED_KINDS.previewStep, fileId, undefined],
    ]);
    // The requeue keeps its own wait beside the expiry.
    expect(sent[1]?.options.startAfter).toEqual(expect.any(Number));
    expect(sent[2]?.options).not.toHaveProperty("expireInSeconds");
  });

  test("a replacement's conversion and one the render check queues carry the expiry", async () => {
    const replaced = await convertedStep("expiry, replaced");
    const sent: Sent[] = [];
    await recording(sent).replaceFile(
      replaced,
      await writeUpload(env, uniqueStep("expiry, replacement")),
    );

    // Stored with no afterCommit, so it has no status and no job.
    const unqueued = await env.ingest.ingestFile({
      tmpPath: await writeUpload(env, uniqueStep("expiry, never queued")),
      originalName: "Unqueued expiry.step",
      target: "new",
    });
    const result = await recording(sent).checkRenders(
      new Date(Date.now() + RENDER_CHECK_GRACE_MS + 60_000),
    );
    expect(result.queued).toContain(unqueued.fileId);

    const ofFile = (fileId: string) =>
      sent.filter((s) => s.fileId === fileId).map((s) => [s.kind, s.options.expireInSeconds]);
    expect(ofFile(replaced)).toEqual([[DERIVED_KINDS.convertStep, CONVERT_EXPIRE_SECONDS]]);
    expect(ofFile(unqueued.fileId)).toEqual([[DERIVED_KINDS.convertStep, CONVERT_EXPIRE_SECONDS]]);
  });
});
