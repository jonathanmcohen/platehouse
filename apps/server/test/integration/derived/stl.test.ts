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
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { DERIVED_MESSAGES, type DerivedJob } from "../../../src/derived/derived.js";
import { QUEUE } from "../../../src/jobs/queues.js";
import { BlobNotFound } from "../../../src/storage/s3.js";
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

    expect(file).toMatchObject({
      kind: "stl",
      derivedStatus: "ok",
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
    expect(file.derivedStatus).toBe("ok");
    expect(env.stub.renders.callsTo("/v1/stl/png")[0]?.body.equals(bytes)).toBe(true);
  });

  test("a render OpenSCAD rejects keeps the source and the icon, and says why", async () => {
    const message = "ERROR: STL import: unexpected end of file <in> 'facet' & loop";
    env.stub.renders.queue("/v1/stl/png", { kind: "failed", message });
    const text = uniqueStl("rejected");
    const { modelId, fileId } = await uploadStl(text);
    const file = await settledFile(env, fileId);

    expect(file).toMatchObject({
      derivedStatus: "failed",
      derivedMessage: `${PREVIEW_REJECTED} ${message}`,
      renderPngBlobId: null,
    });
    const blobs = await blobsOf(env, modelId);
    expect(blobs.map((b) => b.kind)).toEqual(["source"]);
    expect(await readObject(env, blobs[0]?.key ?? "")).toEqual(Buffer.from(text));
  });

  test("a slicer that stays busy through every retry ends with the slicer's message and no preview", async () => {
    env.stub.renders.always("/v1/stl/png", { kind: "busy" });
    const { modelId, fileId } = await uploadStl(uniqueStl("busy"));
    const file = await settledFile(env, fileId);
    expect(file).toMatchObject({
      derivedStatus: "failed",
      derivedMessage: DERIVED_MESSAGES.slicerError,
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
      (f) => f?.blobId === sourceBlobId && f?.derivedStatus === "ok",
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
    const after = await settledFile(env, fileId);

    expect(after).toMatchObject({
      blobId: sourceBlobId,
      size: Buffer.byteLength(next),
      renderPngBlobId: null,
      derivedStatus: "failed",
      derivedMessage: `${PREVIEW_REJECTED} ${message}`,
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
    await env.derived.replaceFile(fileId, await writeUpload(env, uniqueStl("again, rejected")));
    expect(await settledFile(env, fileId)).toMatchObject({ derivedStatus: "failed" });
    await until(
      () => env.boss.findJobs(QUEUE.slicer, { data: { fileId } }),
      (js) => js.every((j) => j.state === "completed"),
    );

    const good = uniqueStl("again, renders");
    const { sourceBlobId } = await env.derived.replaceFile(fileId, await writeUpload(env, good));
    const after = await until(
      () => env.repos.files.get(fileId),
      (f) => f?.blobId === sourceBlobId && f?.derivedStatus === "ok",
    );
    expect(after?.derivedMessage).toBeNull();
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
