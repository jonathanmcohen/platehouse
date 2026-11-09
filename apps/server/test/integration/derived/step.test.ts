// Build plan Task 13: STEP meshes in the app (AC-050, decision 2). A .step or
// .stp upload is stored as uploaded; after its row commits, ingest's
// afterCommit queues a mesh job on Task 8's slicer queue, and the job posts
// the source to the slicer's /v1/step/glb (here a stub built on
// packages/slicer-contract) and stores the GLB as a new mesh_glb blob, which
// is all the browser ever loads for a STEP file.
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { DerivedJob } from "../../../src/derived/derived.js";
import { QUEUE, SLICER_TASKS } from "../../../src/jobs/queues.js";
import { BlobNotFound } from "../../../src/storage/s3.js";
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
import { renderedBytes } from "../support/slicer-stub.js";

let env: DerivedEnv;

beforeAll(async () => {
  env = await startDerivedEnv();
});

afterAll(async () => {
  await env?.stop();
});

beforeEach(() => {
  env.stub.reset();
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

    const calls = env.stub.callsTo("/v1/step/glb");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.toString("utf8")).toBe(text);
    expect(calls[0]?.contentType).toBe("application/octet-stream");

    const jobs = await env.boss.findJobs<DerivedJob>(QUEUE.slicer, { data: { fileId } });
    expect(jobs.map((j) => j.data.task)).toEqual([SLICER_TASKS.convertStep]);
  });

  test("a .stp upload is meshed the same way", async () => {
    const { fileId } = await uploadStep(uniqueStep("stp"), "Housing.stp");
    const file = await settledFile(env, fileId);
    expect(file).toMatchObject({ kind: "step", derivedStatus: "ok" });
    expect(file.meshBlobId).not.toBeNull();
  });

  test("a conversion error keeps the source and shows the converter's message", async () => {
    const message = "STEP import failed: no shapes found <in> 'DATA' & section";
    env.stub.queue("/v1/step/glb", { kind: "failed", message });
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

  test("an .stl upload queues nothing and never reaches the slicer", async () => {
    const path = await writeUpload(env, ASCII_STL);
    const { fileId } = await env.ingestDerived.ingestFile({
      tmpPath: path,
      originalName: "Plain.stl",
      target: "new",
    });
    await sleep(2000);
    expect(await env.boss.findJobs(QUEUE.slicer, { data: { fileId } })).toEqual([]);
    expect(env.stub.calls).toHaveLength(0);
    expect((await env.repos.files.get(fileId))?.derivedStatus).toBeNull();
  });
});
