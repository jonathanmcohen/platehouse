// Build plan Task 13: OpenSCAD renders in the app (AC-052, AC-053). A .scad
// upload is stored as uploaded; after its row commits, ingest's afterCommit
// queues a render job on Task 8's singleton slicer queue, and the job posts
// the source to the slicer's /v1/scad/stl and /v1/scad/png (here a stub built
// on packages/slicer-contract) and stores what comes back as new blobs. A
// 409 busy or a dropped connection makes the job throw, and pg-boss retries
// it under its own retry settings (retryLimit 3, retryBackoff); the last
// attempt records slicer_error. A render error keeps the source and stores
// OpenSCAD's message in files.derived_message, as text.
import { randomBytes } from "node:crypto";
import { LIMITS } from "@platehouse/slicer-contract";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { DERIVED_MESSAGES, DerivedError, type DerivedJob } from "../../../src/derived/derived.js";
import { createIngest } from "../../../src/ingest/ingest.js";
import { QUEUE, SLICER_RETRY, SLICER_TASKS } from "../../../src/jobs/queues.js";
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
import { SCAD_TEXT, writeUpload } from "../support/ingest.js";
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

/** A .scad uploaded through ingest, with afterCommit queueing its render. */
async function uploadScad(text = SCAD_TEXT, name = "Bracket.scad") {
  const path = await writeUpload(env, text);
  return env.ingestDerived.ingestFile({ tmpPath: path, originalName: name, target: "new" });
}

/** A .scad stored through ingest with no afterCommit: nothing is queued. */
async function storeScad(text = SCAD_TEXT) {
  const path = await writeUpload(env, text);
  return env.ingest.ingestFile({ tmpPath: path, originalName: "Quiet.scad", target: "new" });
}

async function jobsFor(fileId: string) {
  return env.boss.findJobs<DerivedJob>(QUEUE.slicer, { data: { fileId } });
}

const unique = (label: string) => `// ${label} ${randomBytes(6).toString("hex")}\n${SCAD_TEXT}`;

describe("OpenSCAD renders (AC-052)", () => {
  test("a .scad upload produces an STL and a PNG blob", async () => {
    const text = unique("upload");
    const { modelId, fileId } = await uploadScad(text);
    const file = await settledFile(env, fileId);

    expect(file.derivedStatus).toBe("ok");
    expect(file.derivedMessage).toBeNull();
    expect(file.renderStlBlobId).not.toBeNull();
    expect(file.renderPngBlobId).not.toBeNull();
    expect(file.meshBlobId).toBeNull();

    const blobs = await blobsOf(env, modelId);
    const byId = new Map(blobs.map((b) => [b.id, b]));
    const stl = byId.get(file.renderStlBlobId ?? "");
    const png = byId.get(file.renderPngBlobId ?? "");
    expect(stl).toMatchObject({ kind: "render_stl", state: "stored", contentType: "model/stl" });
    expect(png).toMatchObject({ kind: "render_png", state: "stored", contentType: "image/png" });
    expect(byId.get(file.blobId)).toMatchObject({ kind: "source", state: "stored" });

    // The bytes the slicer rendered from exactly this source, stored as new blobs.
    expect(await readObject(env, stl?.key ?? "")).toEqual(renderedBytes("/v1/scad/stl", text));
    expect(await readObject(env, png?.key ?? "")).toEqual(renderedBytes("/v1/scad/png", text));
    expect(await readObject(env, byId.get(file.blobId)?.key ?? "")).toEqual(Buffer.from(text));

    // One object per stored blob row, and nothing else under the model.
    expect(await keysOf(env, modelId)).toEqual(blobs.map((b) => b.key).sort());
    expect(blobs).toHaveLength(3);

    for (const route of ["/v1/scad/stl", "/v1/scad/png"] as const) {
      const calls = env.stub.callsTo(route);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.body.toString("utf8")).toBe(text);
      expect(calls[0]?.contentType).toMatch(/^text\/plain/);
    }
  });

  test("ingest queues the render after the file's row commits, and never calls the slicer itself", async () => {
    let committedAtEnqueue: unknown;
    let slicerCallsAtEnqueue = -1;
    const path = await writeUpload(env, unique("after-commit"));
    const ingest = createIngest({
      db: env.db,
      store: env.store,
      afterCommit: async (stored) => {
        // Read on another pool connection: only a committed row is visible.
        committedAtEnqueue = await env.repos.files.get(stored.fileId);
        slicerCallsAtEnqueue = env.stub.calls.length;
        await env.derived.afterUpload(stored);
      },
    });
    const { fileId } = await ingest.ingestFile({
      tmpPath: path,
      originalName: "Committed.scad",
      target: "new",
    });

    expect(committedAtEnqueue).toMatchObject({ id: fileId, kind: "scad" });
    expect(slicerCallsAtEnqueue).toBe(0);

    const jobs = await jobsFor(fileId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      name: QUEUE.slicer,
      data: { task: SLICER_TASKS.renderScad, fileId },
      retryLimit: SLICER_RETRY.retryLimit,
      retryBackoff: true,
    });
    expect((await settledFile(env, fileId)).derivedStatus).toBe("ok");
  });

  test("render error keeps the source and shows OpenSCAD's message", async () => {
    // Markup in the message stays exactly as OpenSCAD wrote it: it is text
    // for the page to show, never HTML to render or to escape on the way in.
    const message =
      'ERROR: Parser error in file "input.scad", line 3: syntax error\n' +
      "<script>alert(1)</script> & <b>not bold</b>";
    env.stub.queue("/v1/scad/stl", { kind: "failed", message });
    const text = unique("render-error");
    const { modelId, fileId } = await uploadScad(text);
    const file = await settledFile(env, fileId);

    expect(file.derivedStatus).toBe("failed");
    expect(file.derivedMessage).toBe(message);
    expect(file.renderStlBlobId).toBeNull();
    expect(file.renderPngBlobId).toBeNull();

    const blobs = await blobsOf(env, modelId);
    expect(blobs.map((b) => b.kind)).toEqual(["source"]);
    expect(await keysOf(env, modelId)).toEqual([blobs[0]?.key]);
    expect(await readObject(env, blobs[0]?.key ?? "")).toEqual(Buffer.from(text));

    // A render error is OpenSCAD's answer, not a slicer fault: no retry.
    expect(env.stub.callsTo("/v1/scad/stl")).toHaveLength(1);
    const [job] = await jobsFor(fileId);
    expect(job?.retryCount).toBe(0);
    expect(job?.output).toMatchObject({ status: "failed", reason: "render_failed" });
  });

  test("a .scad over the renderer's 1 MiB limit fails with a message and is never sent", async () => {
    const text = `// ${"x".repeat(LIMITS.scadBodyBytes)}\n${SCAD_TEXT}`;
    const { modelId, fileId } = await uploadScad(text, "Huge.scad");
    const file = await settledFile(env, fileId);

    expect(file.derivedStatus).toBe("failed");
    expect(file.derivedMessage).toBe(DERIVED_MESSAGES.scadTooLarge);
    expect(env.stub.calls).toHaveLength(0);
    expect((await blobsOf(env, modelId)).map((b) => b.kind)).toEqual(["source"]);
  });
});

describe("retries through pg-boss", () => {
  test("a busy slicer is retried by pg-boss and the render lands", async () => {
    env.stub.queue("/v1/scad/stl", { kind: "busy" }, { kind: "busy" });
    const { fileId } = await storeScad(unique("busy"));
    const jobId = await env.derived.renderScad(fileId);

    const file = await settledFile(env, fileId);
    expect(file.derivedStatus).toBe("ok");
    expect(env.stub.callsTo("/v1/scad/stl").map((c) => c.answer)).toEqual([
      "busy",
      "busy",
      "render",
    ]);

    const job = await env.boss.getJobById(QUEUE.slicer, jobId);
    expect(job).toMatchObject({
      state: "completed",
      retryCount: 2,
      retryLimit: 3,
      retryBackoff: true,
    });
  });

  test("a slicer that drops every connection ends failed with slicer_error after 3 retries, never stuck", async () => {
    env.stub.always("/v1/scad/stl", { kind: "drop" });
    const { modelId, fileId } = await storeScad(unique("drop"));
    const jobId = await env.derived.renderScad(fileId);

    const file = await settledFile(env, fileId, 55_000);
    expect(file.derivedStatus).toBe("failed");
    expect(file.derivedMessage).toBe(DERIVED_MESSAGES.slicerError);
    expect(file.renderStlBlobId).toBeNull();
    // The first attempt and pg-boss's 3 retries; the job ran no loop of its own.
    expect(env.stub.callsTo("/v1/scad/stl")).toHaveLength(4);

    const job = await until(
      () => env.boss.getJobById(QUEUE.slicer, jobId),
      (j) => j?.state === "completed" || j?.state === "failed",
    );
    expect(job?.retryCount).toBe(3);
    expect(job?.output).toMatchObject({ status: "failed", reason: "slicer_error" });
    expect((await blobsOf(env, modelId)).map((b) => b.kind)).toEqual(["source"]);
  });
});

describe("replacing a .scad (AC-053)", () => {
  test("replacing a .scad renders a new STL and preview and removes the old blobs", async () => {
    const first = unique("before");
    const { modelId, fileId } = await uploadScad(first);
    const before = await settledFile(env, fileId);
    const oldBlobs = await blobsOf(env, modelId);
    expect(oldBlobs).toHaveLength(3);

    const second = unique("after");
    const path = await writeUpload(env, second);
    await env.derived.replaceFile(fileId, path);
    const after = await until(
      () => env.repos.files.get(fileId),
      (f) => f?.blobId !== before.blobId && f?.derivedStatus === "ok",
    );
    if (!after) throw new Error("file vanished");

    expect(after.name).toBe(before.name);
    expect(after.size).toBe(Buffer.byteLength(second));
    expect(after.renderStlBlobId).not.toBe(before.renderStlBlobId);
    expect(after.renderPngBlobId).not.toBe(before.renderPngBlobId);

    const blobs = await blobsOf(env, modelId);
    const byId = new Map(blobs.map((b) => [b.id, b]));
    expect(await readObject(env, byId.get(after.blobId)?.key ?? "")).toEqual(Buffer.from(second));
    expect(await readObject(env, byId.get(after.renderStlBlobId ?? "")?.key ?? "")).toEqual(
      renderedBytes("/v1/scad/stl", second),
    );
    expect(await readObject(env, byId.get(after.renderPngBlobId ?? "")?.key ?? "")).toEqual(
      renderedBytes("/v1/scad/png", second),
    );

    // The old source, STL and PNG are gone: rows and objects.
    expect(blobs).toHaveLength(3);
    for (const old of oldBlobs) {
      expect(byId.has(old.id)).toBe(false);
      await expect(env.store.getBlobStream(old.key)).rejects.toBeInstanceOf(BlobNotFound);
    }
    expect(await keysOf(env, modelId)).toEqual(blobs.map((b) => b.key).sort());
  });

  test("a replacement that fails part way leaves the previous version whole", async () => {
    const { modelId, fileId } = await uploadScad(unique("whole"));
    const before = await settledFile(env, fileId);
    const oldBlobs = await blobsOf(env, modelId);
    const oldKeys = await keysOf(env, modelId);

    // The STL renders, then the slicer goes away for the preview, every time.
    env.stub.always("/v1/scad/png", { kind: "drop" });
    const path = await writeUpload(env, unique("never lands"));
    await env.derived.replaceFile(fileId, path);
    const after = await until(
      () => env.repos.files.get(fileId),
      (f) => f?.derivedStatus === "failed",
      55_000,
    );

    expect(after).toMatchObject({
      blobId: before.blobId,
      size: before.size,
      renderStlBlobId: before.renderStlBlobId,
      renderPngBlobId: before.renderPngBlobId,
      derivedMessage: DERIVED_MESSAGES.replaceFailed,
    });
    expect(after?.sha256).toEqual(before.sha256);
    // No staged source and no half render left behind, in rows or objects.
    expect((await blobsOf(env, modelId)).map((b) => b.id)).toEqual(oldBlobs.map((b) => b.id));
    expect(await keysOf(env, modelId)).toEqual(oldKeys);
  });

  test("two replacements in a row end on the newer file", async () => {
    const { modelId, fileId } = await uploadScad(unique("first"));
    await settledFile(env, fileId);
    const second = unique("second");
    const third = unique("third");
    await env.derived.replaceFile(fileId, await writeUpload(env, second));
    await env.derived.replaceFile(fileId, await writeUpload(env, third));

    const after = await until(
      async () => ({
        file: await env.repos.files.get(fileId),
        jobs: await jobsFor(fileId),
      }),
      ({ file, jobs }) =>
        file?.derivedStatus === "ok" &&
        jobs.length === 3 &&
        jobs.every((j) => j.state === "completed"),
    );
    const blobs = await blobsOf(env, modelId);
    const byId = new Map(blobs.map((b) => [b.id, b]));
    expect(await readObject(env, byId.get(after.file?.blobId ?? "")?.key ?? "")).toEqual(
      Buffer.from(third),
    );
    expect(await readObject(env, byId.get(after.file?.renderStlBlobId ?? "")?.key ?? "")).toEqual(
      renderedBytes("/v1/scad/stl", third),
    );
    expect(blobs).toHaveLength(3);
    expect(await keysOf(env, modelId)).toEqual(blobs.map((b) => b.key).sort());
  });

  test("replaceFile refuses a file that is not a .scad and stores nothing", async () => {
    const { modelId, fileId } = await uploadScad(unique("refuse"));
    const before = await settledFile(env, fileId);
    const keys = await keysOf(env, modelId);
    const path = await writeUpload(env, Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));

    const error = await env.derived.replaceFile(fileId, path).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DerivedError);
    expect((error as DerivedError).code).toBe("wrong_type");
    expect(await keysOf(env, modelId)).toEqual(keys);
    expect(await env.repos.files.get(fileId)).toMatchObject({
      blobId: before.blobId,
      derivedStatus: "ok",
    });
  });
});
