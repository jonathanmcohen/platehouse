// Issue #316: STL previews in the app. An .stl upload is stored as uploaded;
// after its row commits, ingest's afterCommit queues a render-stl job on the
// slicer queue, and the job streams the source to the slicer's /v1/stl/png
// (here a stub built on packages/slicer-contract) and stores the PNG as a
// render_png blob, which the library card and the model page show in place
// of the file-type icon. A render that fails keeps the icon and says why, as
// a failed .scad render does. A preview is only ever of the file's current
// source: when a replacement cannot be previewed, the previous version's
// preview is deleted, so the card shows the icon again rather than a picture
// of another file.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  createDerived,
  DERIVED_MESSAGES,
  type DerivedJob,
  RENDER_CHECK_GRACE_MS,
} from "../../../src/derived/derived.js";
import { PREVIEW_RETRIED } from "../../../src/derived/picture.js";
import { QUEUE } from "../../../src/jobs/queues.js";
import { BlobNotFound } from "../../../src/storage/s3.js";
import { renderedBytes, sandboxOff } from "../../support/slicer-stub.js";
import {
  blobsOf,
  type DerivedEnv,
  keysOf,
  readObject,
  settledFile,
  startDerivedEnv,
  until,
} from "../support/derived.js";
import { writeUpload } from "../support/ingest.js";

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

/** An ASCII STL unique to the test: its solid name carries the label. */
function uniqueStl(label: string): string {
  const name = `${label.replace(/[^a-z0-9]+/gi, "_")}_${randomBytes(6).toString("hex")}`;
  return (
    `solid ${name}\n facet normal 0 0 1\n  outer loop\n   vertex 0 0 0\n   vertex 1 0 0\n` +
    `   vertex 0 1 0\n  endloop\n endfacet\nendsolid ${name}\n`
  );
}

async function uploadStl(text: string, name = "Bracket.stl") {
  const path = await writeUpload(env, text);
  return env.ingestDerived.ingestFile({ tmpPath: path, originalName: name, target: "new" });
}

const PREVIEW_REJECTED = "The preview picture could not be rendered. OpenSCAD said:";

describe("STL previews (issue #316)", () => {
  test("an .stl upload gets a PNG preview rendered from its own bytes", async () => {
    const text = uniqueStl("preview");
    const { modelId, fileId } = await uploadStl(text);
    const file = await settledFile(env, fileId);

    // The picture has its own status; an STL's derivedStatus stays null, as
    // in 0.1.0 (issue #380).
    expect(file).toMatchObject({
      kind: "stl",
      previewStatus: "ok",
      previewMessage: null,
      derivedStatus: null,
      derivedMessage: null,
      renderStlBlobId: null,
      meshBlobId: null,
    });
    expect(file.renderPngBlobId).not.toBeNull();

    const blobs = await blobsOf(env, modelId);
    const png = blobs.find((b) => b.id === file.renderPngBlobId);
    expect(png).toMatchObject({ kind: "render_png", state: "stored", contentType: "image/png" });
    expect(await readObject(env, png?.key ?? "")).toEqual(renderedBytes("/v1/stl/png", text));
    expect(blobs.map((b) => b.kind).sort()).toEqual(["render_png", "source"]);
    expect(await keysOf(env, modelId)).toEqual(blobs.map((b) => b.key).sort());

    const calls = env.stub.renders.callsTo("/v1/stl/png");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.toString("utf8")).toBe(text);
    expect(calls[0]?.contentType).toBe("application/octet-stream");
    // An STL is previewed, never sent to OpenSCAD's .scad routes or converted.
    expect(env.stub.renders.calls.map((c) => c.route)).toEqual(["/v1/stl/png"]);

    const jobs = await env.boss.findJobs<DerivedJob>(QUEUE.slicer, { data: { fileId } });
    expect(jobs.map((j) => j.data.kind)).toEqual(["render-stl"]);
  });

  test("a binary .stl is previewed from its bytes as well", async () => {
    const bytes = Buffer.alloc(84 + 50);
    bytes.write(`binary ${randomBytes(6).toString("hex")}`, 0, "ascii");
    bytes.writeUInt32LE(1, 80);
    const path = await writeUpload(env, bytes);
    const { fileId } = await env.ingestDerived.ingestFile({
      tmpPath: path,
      originalName: "Binary.stl",
      target: "new",
    });
    const file = await settledFile(env, fileId);
    expect(file.previewStatus).toBe("ok");
    expect(env.stub.renders.callsTo("/v1/stl/png")[0]?.body.equals(bytes)).toBe(true);
  });

  test("a render OpenSCAD rejects keeps the source and the icon, and says why", async () => {
    const message = "ERROR: STL import: unexpected end of file <in> 'facet' & loop";
    env.stub.renders.queue("/v1/stl/png", { kind: "failed", message });
    const text = uniqueStl("rejected");
    const { modelId, fileId } = await uploadStl(text);
    const file = await settledFile(env, fileId);

    expect(file).toMatchObject({
      previewStatus: "failed",
      previewMessage: `${PREVIEW_REJECTED} ${message}`,
      renderPngBlobId: null,
    });
    const blobs = await blobsOf(env, modelId);
    expect(blobs.map((b) => b.kind)).toEqual(["source"]);
    expect(await readObject(env, blobs[0]?.key ?? "")).toEqual(Buffer.from(text));
  });

  // Issue #379: the slicer refuses an STL with no triangles itself, before
  // OpenSCAD runs, so its sentence is not put after "OpenSCAD said:".
  test("an STL the slicer refuses as having no triangles says so without blaming OpenSCAD", async () => {
    const notAnStl =
      "The file is not an STL with at least one triangle, so there is nothing to render.";
    env.stub.renders.queue("/v1/stl/png", { kind: "failed", message: notAnStl });
    const { fileId } = await uploadStl(`solid empty_${randomBytes(4).toString("hex")}\nendsolid\n`);
    const file = await settledFile(env, fileId);
    expect(file).toMatchObject({
      previewStatus: "failed",
      previewMessage: `The preview picture could not be rendered. ${notAnStl}`,
      derivedStatus: null,
    });
  });

  test("a picture the sandbox refuses is recorded once with its reason and is not in the always-retried set", async () => {
    env.stub.renders.always("/v1/stl/png", sandboxOff("old_kernel"));
    const { modelId, fileId } = await uploadStl(uniqueStl("sandbox off"));
    const file = await settledFile(env, fileId);
    expect(file).toMatchObject({
      previewStatus: "failed",
      previewMessage: DERIVED_MESSAGES.sandboxOffKernel,
      renderPngBlobId: null,
    });
    expect(PREVIEW_RETRIED).not.toContain(DERIVED_MESSAGES.sandboxOffKernel);
    expect((await blobsOf(env, modelId)).map((b) => b.kind)).toEqual(["source"]);
    // No wait and no retry: one call, one job, that ended failed.
    expect(env.stub.renders.callsTo("/v1/stl/png")).toHaveLength(1);
    const jobs = await env.boss.findJobs<DerivedJob>(QUEUE.slicer, { data: { fileId } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.output).toMatchObject({ status: "failed", reason: "sandbox_off" });
    expect(jobs[0]?.retryCount).toBe(0);
  });

  test("a slicer that stays busy through every retry ends with the slicer's message and no preview", async () => {
    env.stub.renders.always("/v1/stl/png", { kind: "busy" });
    const { modelId, fileId } = await uploadStl(uniqueStl("busy"));
    const file = await settledFile(env, fileId);
    expect(file).toMatchObject({
      previewStatus: "failed",
      previewMessage: DERIVED_MESSAGES.slicerError,
      renderPngBlobId: null,
    });
    expect((await blobsOf(env, modelId)).map((b) => b.kind)).toEqual(["source"]);
  });

  test("replacing an .stl renders a new preview and removes the old source and preview", async () => {
    const { modelId, fileId } = await uploadStl(uniqueStl("old"));
    const before = await settledFile(env, fileId);
    const oldBlobs = await blobsOf(env, modelId);
    expect(oldBlobs).toHaveLength(2);

    const next = uniqueStl("new");
    const { sourceBlobId } = await env.derived.replaceFile(fileId, await writeUpload(env, next));
    const after = await until(
      () => env.repos.files.get(fileId),
      (f) => f?.blobId === sourceBlobId && f?.previewStatus === "ok",
    );
    expect(after?.renderPngBlobId).not.toBe(before.renderPngBlobId);
    const blobs = await blobsOf(env, modelId);
    const png = blobs.find((b) => b.id === after?.renderPngBlobId);
    expect(await readObject(env, png?.key ?? "")).toEqual(renderedBytes("/v1/stl/png", next));
    expect(blobs.map((b) => b.id).sort()).toEqual([sourceBlobId, after?.renderPngBlobId].sort());
    for (const old of oldBlobs) {
      await expect(env.store.getBlobStream(old.key)).rejects.toBeInstanceOf(BlobNotFound);
    }
    expect(await keysOf(env, modelId)).toEqual(blobs.map((b) => b.key).sort());
  });

  test("a replacement OpenSCAD rejects becomes the file's source, and the previous preview is deleted so the icon shows", async () => {
    const { modelId, fileId } = await uploadStl(uniqueStl("rejected replacement, before"));
    const before = await settledFile(env, fileId);
    const oldPng = (await blobsOf(env, modelId)).find((b) => b.id === before.renderPngBlobId);
    if (!oldPng) throw new Error("no preview");
    env.stub.renders.reset();

    const message = "ERROR: STL import: not a valid STL";
    env.stub.renders.queue("/v1/stl/png", { kind: "failed", message });
    const next = uniqueStl("rejected replacement, after");
    const { sourceBlobId } = await env.derived.replaceFile(fileId, await writeUpload(env, next));
    // The picture stays ok while the replacement waits (issue #389), so wait
    // for the replacement itself to become the file's source.
    const after = await until(
      () => env.repos.files.get(fileId),
      (f) => f?.blobId === sourceBlobId && f.previewStatus !== "pending",
    );

    expect(after).toMatchObject({
      blobId: sourceBlobId,
      size: Buffer.byteLength(next),
      renderPngBlobId: null,
      previewStatus: "failed",
      previewMessage: `${PREVIEW_REJECTED} ${message}`,
    });
    const blobs = await blobsOf(env, modelId);
    expect(blobs.map((b) => b.id)).toEqual([sourceBlobId]);
    expect(await readObject(env, blobs[0]?.key ?? "")).toEqual(Buffer.from(next));
    await expect(env.store.getBlobStream(oldPng.key)).rejects.toBeInstanceOf(BlobNotFound);
    expect(await keysOf(env, modelId)).toEqual(blobs.map((b) => b.key).sort());
  });

  test("after a rejected replacement, a later replacement that renders gets a preview again", async () => {
    const { fileId } = await uploadStl(uniqueStl("again, before"));
    await settledFile(env, fileId);
    env.stub.renders.queue("/v1/stl/png", { kind: "failed", message: "ERROR: bad STL" });
    const rejected = await env.derived.replaceFile(
      fileId,
      await writeUpload(env, uniqueStl("again, rejected")),
    );
    expect(
      await until(
        () => env.repos.files.get(fileId),
        (f) => f?.blobId === rejected.sourceBlobId && f.previewStatus !== "pending",
      ),
    ).toMatchObject({ previewStatus: "failed" });
    await until(
      () => env.boss.findJobs(QUEUE.slicer, { data: { fileId } }),
      (js) => js.every((j) => j.state === "completed"),
    );

    const good = uniqueStl("again, renders");
    const { sourceBlobId } = await env.derived.replaceFile(fileId, await writeUpload(env, good));
    const after = await until(
      () => env.repos.files.get(fileId),
      (f) => f?.blobId === sourceBlobId && f?.previewStatus === "ok",
    );
    expect(after?.previewMessage).toBeNull();
    expect(after?.renderPngBlobId).not.toBeNull();
  });

  test("replaceFile refuses a file that is not an STL and stores nothing", async () => {
    const { modelId, fileId } = await uploadStl(uniqueStl("wrong type"));
    await settledFile(env, fileId);
    const keys = await keysOf(env, modelId);
    const error = await env.derived
      .replaceFile(fileId, await writeUpload(env, "ISO-10303-21;\nHEADER;\n"))
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect((error as { code?: string } | null)?.code).toBe("wrong_type");
    expect(await keysOf(env, modelId)).toEqual(keys);
  });
});

// The sequences two review rounds found, kept as named tests beside the
// property test (preview-invariant.test.ts).
describe("a replacement that is not saved leaves the picture's status alone (issue #389)", () => {
  test("an STL replacement the slicer fails on through every retry keeps the current picture shown", async () => {
    const { modelId, fileId } = await uploadStl(uniqueStl("389 kept"));
    const before = await settledFile(env, fileId);
    expect(before).toMatchObject({ previewStatus: "ok" });
    const png = before.renderPngBlobId;
    expect(png).not.toBeNull();

    env.stub.renders.always("/v1/stl/png", { kind: "busy" });
    const { sourceBlobId } = await env.derived.replaceFile(
      fileId,
      await writeUpload(env, uniqueStl("389 replacement")),
    );
    // The replacement's job uses every retry, then ends with the slicer's
    // failure, and the replacement is not saved.
    await until(
      () => env.boss.findJobs<DerivedJob>(QUEUE.slicer, { data: { sourceBlobId } }),
      (js) => js.length > 0 && js.every((j) => j.state === "completed"),
    );
    expect(await env.repos.files.get(fileId)).toMatchObject({
      blobId: before.blobId,
      renderPngBlobId: png,
      previewStatus: "ok",
      previewMessage: null,
    });
    expect(await env.repos.blobs.get(sourceBlobId)).toBeUndefined();
    // The kept picture is still stored and still the current source's.
    const blob = (await blobsOf(env, modelId)).find((b) => b.id === png);
    expect(blob?.kind).toBe("render_png");
  });
});

describe("a picture that failed because the slicer stayed down says it will be tried again", () => {
  test("its message says it is tried again automatically, and the backfill does", async () => {
    const stored = await env.ingest.ingestFile({
      tmpPath: await writeUpload(env, uniqueStl("outage wording")),
      originalName: "Outage.stl",
      target: "new",
    });
    let clock = Date.now();
    // Jobs held an hour, so only this test runs them; the slicer takes no connection.
    const send: typeof env.boss.send = (async (...args: unknown[]) => {
      const [name, data, options] = args as [string, object, Record<string, unknown>];
      return (env.boss.send as (...a: unknown[]) => Promise<string | null>)(name, data, {
        ...options,
        startAfter: 3600,
      });
    }) as typeof env.boss.send;
    // A port just closed, so the connection is refused (SlicerDown); fetch
    // refuses a well-known port such as 9 outright, which is not an outage.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const down = createDerived({
      db: env.db,
      store: env.store,
      slicerUrl: `http://127.0.0.1:${port}`,
      queue: { send, findJobs: env.boss.findJobs.bind(env.boss) },
      retryDelaySeconds: 1,
      now: () => new Date(clock),
    });
    const runHeld = async () => {
      const held = (
        await env.boss.findJobs<DerivedJob>(QUEUE.slicer, { data: { fileId: stored.fileId } })
      ).filter((j) => j.state === "created");
      const job = held[0];
      if (!job) throw new Error("no held job");
      await env.boss.cancel(QUEUE.slicer, job.id);
      return down.runJob(job.data, { retryCount: 0, retryLimit: job.retryLimit });
    };
    await down.renderStl(stored.fileId);
    expect(await runHeld()).toEqual({ status: "requeued", reason: "slicer_down" });
    clock += 3 * 60 * 60 * 1000;
    expect(await runHeld()).toEqual({ status: "failed", reason: "slicer_down" });

    const file = await env.repos.files.get(stored.fileId);
    expect(file?.previewStatus).toBe("failed");
    expect(file?.previewMessage).toMatch(/tried again automatically/i);
    expect(file?.previewMessage).not.toMatch(/started again/i);
    const run = await env.derived.backfillPreviews(
      new Date(Date.now() + RENDER_CHECK_GRACE_MS + 60_000),
    );
    expect(run.queued).toContain(stored.fileId);
  });
});
