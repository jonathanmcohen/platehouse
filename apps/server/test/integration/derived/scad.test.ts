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
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { LIMITS } from "@platehouse/slicer-contract";
import type { PgBoss } from "pg-boss";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Config } from "../../../src/config.js";
import {
  createDerived,
  DERIVED_KINDS,
  DERIVED_MESSAGES,
  type DerivedDeps,
  DerivedError,
  type DerivedJob,
  type DerivedStore,
  derivedJobHandlers,
  RENDER_CHECK_GRACE_MS,
} from "../../../src/derived/derived.js";
import { createIngest } from "../../../src/ingest/ingest.js";
import { QUEUE, SLICER_RETRY } from "../../../src/jobs/queues.js";
import {
  BlobNotFound,
  createBlobStore,
  StoreError,
  StoreUnavailable,
} from "../../../src/storage/s3.js";
import { type Reply, s3Error, startFakeS3 } from "../../storage/support/fake-s3.js";
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
import { SCAD_TEXT, writeUpload } from "../support/ingest.js";

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

/**
 * A second createDerived on the same database, bucket, slicer and pg-boss,
 * with deps overridden. Its jobs are run by the env's worker all the same.
 */
function derivedWith(overrides: Partial<DerivedDeps>) {
  return createDerived({
    db: env.db,
    store: env.store,
    slicerUrl: env.stub.url,
    queue: env.boss,
    retryDelaySeconds: 1,
    ...overrides,
  });
}

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
      const calls = env.stub.renders.callsTo(route);
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
        slicerCallsAtEnqueue = env.stub.renders.calls.length;
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
      data: { kind: DERIVED_KINDS.renderScad, fileId },
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
    env.stub.renders.queue("/v1/scad/stl", { kind: "failed", message });
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
    expect(env.stub.renders.callsTo("/v1/scad/stl")).toHaveLength(1);
    // The file is updated inside the job, just before pg-boss completes it.
    const [job] = await until(
      () => jobsFor(fileId),
      (jobs) => jobs[0]?.state === "completed",
    );
    expect(job?.retryCount).toBe(0);
    expect(job?.output).toMatchObject({ status: "failed", reason: "render_failed" });
  });

  test("a .scad over the renderer's 1 MiB limit fails with a message and is never sent", async () => {
    const text = `// ${"x".repeat(LIMITS.scadBodyBytes)}\n${SCAD_TEXT}`;
    const { modelId, fileId } = await uploadScad(text, "Huge.scad");
    const file = await settledFile(env, fileId);

    expect(file.derivedStatus).toBe("failed");
    expect(file.derivedMessage).toBe(DERIVED_MESSAGES.scadTooLarge);
    expect(env.stub.renders.calls).toHaveLength(0);
    expect((await blobsOf(env, modelId)).map((b) => b.kind)).toEqual(["source"]);
  });
});

describe("retries through pg-boss", () => {
  test("a busy slicer is retried by pg-boss and the render lands", async () => {
    env.stub.renders.queue("/v1/scad/stl", { kind: "busy" }, { kind: "busy" });
    const { fileId } = await storeScad(unique("busy"));
    const jobId = await env.derived.renderScad(fileId);

    const file = await settledFile(env, fileId);
    expect(file.derivedStatus).toBe("ok");
    expect(env.stub.renders.callsTo("/v1/scad/stl").map((c) => c.answer)).toEqual([
      "busy",
      "busy",
      "render",
    ]);

    const job = await until(
      () => env.boss.getJobById(QUEUE.slicer, jobId),
      (j) => j?.state === "completed",
    );
    expect(job).toMatchObject({
      state: "completed",
      retryCount: 2,
      retryLimit: 3,
      retryBackoff: true,
    });
  });

  test("a slicer that drops every connection ends failed with slicer_error after 3 retries, never stuck", async () => {
    env.stub.renders.always("/v1/scad/stl", { kind: "drop" });
    const { modelId, fileId } = await storeScad(unique("drop"));
    const jobId = await env.derived.renderScad(fileId);

    const file = await settledFile(env, fileId, 55_000);
    expect(file.derivedStatus).toBe("failed");
    expect(file.derivedMessage).toBe(DERIVED_MESSAGES.slicerError);
    expect(file.renderStlBlobId).toBeNull();
    // The first attempt and pg-boss's 3 retries; the job ran no loop of its own.
    expect(env.stub.renders.callsTo("/v1/scad/stl")).toHaveLength(4);

    const job = await until(
      () => env.boss.getJobById(QUEUE.slicer, jobId),
      (j) => j?.state === "completed" || j?.state === "failed",
    );
    expect(job?.retryCount).toBe(3);
    expect(job?.output).toMatchObject({ status: "failed", reason: "slicer_error" });
    expect((await blobsOf(env, modelId)).map((b) => b.kind)).toEqual(["source"]);
  });
});

describe("renders of a trashed model", () => {
  test("renderScad refuses a file whose model is in the trash and queues nothing", async () => {
    const { modelId, fileId } = await storeScad(unique("trashed"));
    const before = await env.repos.files.get(fileId);
    expect(await env.repos.models.trash(modelId)).toBe(true);

    const error = await env.derived.renderScad(fileId).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DerivedError);
    expect((error as DerivedError).code).toBe("not_found");
    expect(await jobsFor(fileId)).toEqual([]);
    expect(await env.repos.files.get(fileId)).toMatchObject({
      derivedStatus: before?.derivedStatus ?? null,
    });
    expect((await blobsOf(env, modelId)).map((b) => b.kind)).toEqual(["source"]);
  });
});

describe("queueing a render", () => {
  test("the pending status and the job commit together: a send that fails leaves no job", async () => {
    const { fileId } = await storeScad(unique("queue-atomic"));
    expect((await env.repos.files.get(fileId))?.derivedStatus).toBeNull();

    // The job is written, then the process "dies" before renderScad returns.
    // Read on another pool connection while the send runs: nothing of the
    // transaction is visible yet.
    let statusAtSend: unknown = "unread";
    const send: PgBoss["send"] = async (...args: unknown[]) => {
      statusAtSend = (await env.repos.files.get(fileId))?.derivedStatus;
      await (env.boss.send as (...a: unknown[]) => Promise<string | null>)(...args);
      throw new Error("the process died after sending the job");
    };
    const dying = derivedWith({
      queue: { send, findJobs: env.boss.findJobs.bind(env.boss) },
    });
    await expect(dying.renderScad(fileId)).rejects.toThrow("the process died");

    expect(statusAtSend).toBeNull();
    // The job rolled back with the status, so no file reads pending with no job.
    expect(await jobsFor(fileId)).toEqual([]);
    expect(await env.repos.files.get(fileId)).toMatchObject({
      derivedStatus: "failed",
      derivedMessage: DERIVED_MESSAGES.queueFailed,
    });
  });
});

/** A URL on 127.0.0.1 where nothing listens, so a connection is refused. */
async function nothingListening(): Promise<string> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", () => resolve()));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

const SANDBOX_OFF_MESSAGE =
  "OpenSCAD renders are off: the sandbox self-test failed (synthetic probe readable).";

describe("a slicer that cannot render right now (uses no retry)", () => {
  test("a slicer that takes no connection: the job waits for it, and the render lands once it answers", async () => {
    const { fileId } = await storeScad(unique("refused"));
    const file = await env.repos.files.get(fileId);
    if (!file) throw new Error("no file");
    const job: DerivedJob = { kind: DERIVED_KINDS.renderScad, fileId, sourceBlobId: file.blobId };
    // An attempt that has already used one retry (say, on a busy answer),
    // run against a slicer that is stopped.
    const down = derivedWith({ slicerUrl: await nothingListening() });
    const outcome = await down.runJob(job, {
      retryCount: 1,
      retryLimit: SLICER_RETRY.retryLimit,
    });
    expect(outcome).toEqual({ status: "requeued", reason: "slicer_down" });
    expect((await env.repos.files.get(fileId))?.derivedStatus).not.toBe("failed");

    // The env's worker runs the job it queued, against a slicer that answers.
    const done = await settledFile(env, fileId);
    expect(done.derivedStatus).toBe("ok");
    expect(env.stub.renders.callsTo("/v1/scad/stl")).toHaveLength(1);
    const jobs = await jobsFor(fileId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toMatchObject({ ...job, waits: 1 });
    // The outage used no retry, and the one used before it stays used.
    expect(jobs[0]?.retryLimit).toBe(SLICER_RETRY.retryLimit - 1);
  });

  test("a replacement sent while OpenSCAD renders are off keeps the previous version and renders once they are back", async () => {
    const { modelId, fileId } = await uploadScad(unique("sandbox before"));
    const before = await settledFile(env, fileId);
    const oldBlobs = await blobsOf(env, modelId);
    // Count only the replacement's calls below, not the upload's own render.
    env.stub.renders.reset();

    env.stub.renders.always("/v1/scad/stl", { kind: "failed", message: SANDBOX_OFF_MESSAGE });
    const second = unique("sandbox after");
    const { sourceBlobId } = await env.derived.replaceFile(fileId, await writeUpload(env, second));

    // The job asks again, waiting longer each time, and never records the
    // slicer's message as the file's verdict or swaps the replacement in.
    await until(
      () => env.stub.renders.callsTo("/v1/scad/stl").length,
      (n) => n >= 3,
    );
    expect(await env.repos.files.get(fileId)).toMatchObject({
      blobId: before.blobId,
      renderStlBlobId: before.renderStlBlobId,
      renderPngBlobId: before.renderPngBlobId,
      derivedStatus: "pending",
      derivedMessage: null,
    });
    const waiting = new Set((await blobsOf(env, modelId)).map((b) => b.id));
    for (const old of oldBlobs) expect(waiting.has(old.id)).toBe(true);
    expect(waiting.has(sourceBlobId)).toBe(true);

    // The sandbox works again.
    env.stub.renders.reset();
    const after = await until(
      () => env.repos.files.get(fileId),
      (f) => f?.blobId === sourceBlobId && f?.derivedStatus === "ok",
    );
    const byId = new Map((await blobsOf(env, modelId)).map((b) => [b.id, b]));
    expect(await readObject(env, byId.get(after?.renderStlBlobId ?? "")?.key ?? "")).toEqual(
      renderedBytes("/v1/scad/stl", second),
    );
    const jobs = await jobsFor(fileId);
    const waits = jobs.filter(
      (j) => (j.output as { reason?: string } | null)?.reason === "slicer_down",
    );
    expect(waits.length).toBeGreaterThanOrEqual(3);
    expect(jobs.every((j) => j.retryCount === 0)).toBe(true);
  });
});

/** How long a job waits for a slicer that is down before the render ends. */
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const SLICER_DOWN_MESSAGE =
  "The slicer is not answering. The render will need to be started again.";
const REPLACE_SLICER_DOWN_MESSAGE =
  "The slicer is not answering, so the previous version is kept. The replacement will need to be sent again.";
const LIVE = new Set(["created", "retry", "active"]);

/** DerivedDeps.now: a clock the test moves by hand. */
function clocked(now: () => Date): Partial<DerivedDeps> {
  return { now };
}

/**
 * A queue that holds each job an hour, with the retries it was sent with,
 * so the env's worker leaves it for the test to run.
 */
function holdingQueue(): DerivedDeps["queue"] {
  const send: PgBoss["send"] = async (...args: unknown[]) => {
    const [name, data, options] = args as [string, object, Record<string, unknown>];
    return (env.boss.send as (...a: unknown[]) => Promise<string | null>)(name, data, {
      ...options,
      startAfter: 3600,
    });
  };
  return { send, findJobs: env.boss.findJobs.bind(env.boss) };
}

/**
 * Takes the file's one held job off the queue and runs it with derived, as
 * the worker would on its first attempt, or on its last when last is set.
 */
async function runHeld(
  fileId: string,
  derived: ReturnType<typeof createDerived>,
  opts: { last?: boolean } = {},
) {
  const held = (await jobsFor(fileId)).filter((j) => j.state === "created");
  expect(held).toHaveLength(1);
  const job = held[0];
  if (!job) throw new Error("no held job");
  await env.boss.cancel(QUEUE.slicer, job.id);
  return derived.runJob(job.data, {
    retryCount: opts.last ? job.retryLimit : 0,
    retryLimit: job.retryLimit,
  });
}

describe("a slicer that stays down (issue #100)", () => {
  test("a replacement whose slicer refuses connections for more than 2 hours ends failed, keeps the previous version and drops its staged source", async () => {
    const { modelId, fileId } = await uploadScad(unique("down for good"));
    const before = await settledFile(env, fileId);
    const oldBlobs = await blobsOf(env, modelId);
    const oldKeys = await keysOf(env, modelId);
    let now = Date.now();
    const clock = () => new Date(now);
    const refused = await nothingListening();
    // A fresh createDerived for each run, as after a restart: only what the
    // job itself carries is kept between runs.
    const down = () =>
      derivedWith({ slicerUrl: refused, queue: holdingQueue(), ...clocked(clock) });
    const staged = await derivedWith({ queue: holdingQueue() }).replaceFile(
      fileId,
      await writeUpload(env, unique("never renders")),
    );
    const stagedBlob = (await blobsOf(env, modelId)).find((b) => b.id === staged.sourceBlobId);
    if (!stagedBlob) throw new Error("no staged source row");

    expect(await runHeld(fileId, down())).toEqual({ status: "requeued", reason: "slicer_down" });
    // Just inside 2 hours of the first refusal, the job still waits.
    now += TWO_HOURS_MS - 60_000;
    expect(await runHeld(fileId, down())).toEqual({ status: "requeued", reason: "slicer_down" });
    expect(await env.repos.files.get(fileId)).toMatchObject({
      blobId: before.blobId,
      derivedStatus: "pending",
      derivedMessage: null,
    });

    // Past 2 hours, the render ends.
    now += 2 * 60_000;
    expect(await runHeld(fileId, down())).toEqual({ status: "failed", reason: "slicer_down" });
    expect(await env.repos.files.get(fileId)).toMatchObject({
      blobId: before.blobId,
      renderStlBlobId: before.renderStlBlobId,
      renderPngBlobId: before.renderPngBlobId,
      derivedStatus: "failed",
      derivedMessage: REPLACE_SLICER_DOWN_MESSAGE,
    });
    // The staged source's row and object are gone; the previous version is whole.
    expect((await blobsOf(env, modelId)).map((b) => b.id)).toEqual(oldBlobs.map((b) => b.id));
    expect(await keysOf(env, modelId)).toEqual(oldKeys);
    await expect(env.store.getBlobStream(stagedBlob.key)).rejects.toBeInstanceOf(BlobNotFound);

    // It stopped waiting, and the wait used none of the job's retries.
    const jobs = await jobsFor(fileId);
    expect(jobs.filter((j) => LIVE.has(j.state))).toEqual([]);
    const replacementJobs = jobs.filter((j) => j.data.sourceBlobId === staged.sourceBlobId);
    expect(replacementJobs).toHaveLength(3);
    expect(replacementJobs.every((j) => j.retryLimit === SLICER_RETRY.retryLimit)).toBe(true);
  });

  test("a render whose slicer refuses connections for more than 2 hours ends failed with a plain message", async () => {
    const { fileId } = await storeScad(unique("first render, down for good"));
    let now = Date.now();
    const clock = () => new Date(now);
    const refused = await nothingListening();
    const down = () =>
      derivedWith({ slicerUrl: refused, queue: holdingQueue(), ...clocked(clock) });
    await derivedWith({ queue: holdingQueue() }).renderScad(fileId);

    expect(await runHeld(fileId, down())).toEqual({ status: "requeued", reason: "slicer_down" });
    now += TWO_HOURS_MS + 1000;
    expect(await runHeld(fileId, down())).toEqual({ status: "failed", reason: "slicer_down" });
    expect(await env.repos.files.get(fileId)).toMatchObject({
      derivedStatus: "failed",
      derivedMessage: SLICER_DOWN_MESSAGE,
      renderStlBlobId: null,
      renderPngBlobId: null,
    });
    const jobs = await jobsFor(fileId);
    expect(jobs.filter((j) => LIVE.has(j.state))).toEqual([]);
    expect(jobs.every((j) => j.retryLimit === SLICER_RETRY.retryLimit)).toBe(true);
  });

  test("a slicer that answers again before 2 hours have passed renders the replacement normally", async () => {
    const { modelId, fileId } = await uploadScad(unique("down for a while"));
    const before = await settledFile(env, fileId);
    let now = Date.now();
    const clock = () => new Date(now);
    const refused = await nothingListening();
    const second = unique("renders after the outage");
    const staged = await derivedWith({ queue: holdingQueue() }).replaceFile(
      fileId,
      await writeUpload(env, second),
    );

    const down = derivedWith({ slicerUrl: refused, queue: holdingQueue(), ...clocked(clock) });
    expect(await runHeld(fileId, down)).toEqual({ status: "requeued", reason: "slicer_down" });

    // The slicer is back just before the 2 hours are up.
    now += TWO_HOURS_MS - 60_000;
    const back = derivedWith({ queue: holdingQueue(), ...clocked(clock) });
    expect(await runHeld(fileId, back)).toEqual({ status: "ok" });
    const after = await env.repos.files.get(fileId);
    expect(after).toMatchObject({
      blobId: staged.sourceBlobId,
      derivedStatus: "ok",
      derivedMessage: null,
    });
    expect(after?.renderStlBlobId).not.toBe(before.renderStlBlobId);
    const byId = new Map((await blobsOf(env, modelId)).map((b) => [b.id, b]));
    expect(await readObject(env, byId.get(after?.renderStlBlobId ?? "")?.key ?? "")).toEqual(
      renderedBytes("/v1/scad/stl", second),
    );

    const jobs = await jobsFor(fileId);
    expect(jobs.filter((j) => LIVE.has(j.state))).toEqual([]);
    expect(jobs.every((j) => j.retryLimit === SLICER_RETRY.retryLimit)).toBe(true);
  });
});

const STORE_DOWN_MESSAGE = "Storage is not answering. The render will need to be started again.";
const REPLACE_STORE_DOWN_MESSAGE =
  "Storage is not answering, so the previous version is kept. The replacement will need to be sent again.";

/** The env's store with reads, writes or both failing as StoreUnavailable; deletes still work. */
function storeDown(opts: { reads?: boolean; writes?: boolean }): DerivedStore {
  return {
    putBlob: opts.writes
      ? async () => {
          throw new StoreUnavailable("PutObject", "ECONNREFUSED");
        }
      : env.store.putBlob.bind(env.store),
    getBlobStream: opts.reads
      ? async () => {
          throw new StoreUnavailable("GetObject", "ECONNREFUSED");
        }
      : env.store.getBlobStream.bind(env.store),
    deleteBlobs: env.store.deleteBlobs.bind(env.store),
  };
}

describe("a store that cannot be reached (uses no retry)", () => {
  test("a store outage on the last attempt waits for the store instead of failing the file, and the render lands once it answers", async () => {
    const { fileId } = await storeScad(unique("store down, last attempt"));
    const file = await env.repos.files.get(fileId);
    if (!file) throw new Error("no file");
    const job: DerivedJob = { kind: DERIVED_KINDS.renderScad, fileId, sourceBlobId: file.blobId };
    const down = derivedWith({ store: storeDown({ reads: true }) });
    const outcome = await down.runJob(job, {
      retryCount: SLICER_RETRY.retryLimit,
      retryLimit: SLICER_RETRY.retryLimit,
    });
    expect(outcome).toEqual({ status: "requeued", reason: "store_down" });
    const waiting = await env.repos.files.get(fileId);
    expect(waiting?.derivedStatus).not.toBe("failed");
    expect(waiting?.derivedMessage).toBeNull();
    expect(env.stub.renders.calls).toHaveLength(0);

    // The env's worker runs the job it queued, against a store that answers.
    const done = await settledFile(env, fileId);
    expect(done.derivedStatus).toBe("ok");
    const jobs = await jobsFor(fileId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toMatchObject({ ...job, waits: 1 });
    // The job had no retries left, and the outage handed it none.
    expect(jobs[0]?.retryLimit).toBe(0);
  });

  test("a replacement whose store cannot take the renders for more than 2 hours ends failed with a storage message, keeps the previous version and drops its staged source", async () => {
    const { modelId, fileId } = await uploadScad(unique("store down for good"));
    const before = await settledFile(env, fileId);
    const oldBlobs = await blobsOf(env, modelId);
    const oldKeys = await keysOf(env, modelId);
    let now = Date.now();
    const clock = () => new Date(now);
    const down = () =>
      derivedWith({
        store: storeDown({ writes: true }),
        queue: holdingQueue(),
        ...clocked(clock),
      });
    const staged = await derivedWith({ queue: holdingQueue() }).replaceFile(
      fileId,
      await writeUpload(env, unique("never stored")),
    );
    const stagedBlob = (await blobsOf(env, modelId)).find((b) => b.id === staged.sourceBlobId);
    if (!stagedBlob) throw new Error("no staged source row");

    expect(await runHeld(fileId, down())).toEqual({ status: "requeued", reason: "store_down" });
    // Just inside 2 hours of the first failure, the job still waits.
    now += TWO_HOURS_MS - 60_000;
    expect(await runHeld(fileId, down())).toEqual({ status: "requeued", reason: "store_down" });
    expect(await env.repos.files.get(fileId)).toMatchObject({
      blobId: before.blobId,
      derivedStatus: "pending",
      derivedMessage: null,
    });

    // Past 2 hours, the render ends.
    now += 2 * 60_000;
    expect(await runHeld(fileId, down())).toEqual({ status: "failed", reason: "store_down" });
    expect(await env.repos.files.get(fileId)).toMatchObject({
      blobId: before.blobId,
      renderStlBlobId: before.renderStlBlobId,
      renderPngBlobId: before.renderPngBlobId,
      derivedStatus: "failed",
      derivedMessage: REPLACE_STORE_DOWN_MESSAGE,
    });
    expect((await blobsOf(env, modelId)).map((b) => b.id)).toEqual(oldBlobs.map((b) => b.id));
    expect(await keysOf(env, modelId)).toEqual(oldKeys);
    await expect(env.store.getBlobStream(stagedBlob.key)).rejects.toBeInstanceOf(BlobNotFound);

    // It stopped waiting, and the wait used none of the job's retries.
    const jobs = await jobsFor(fileId);
    expect(jobs.filter((j) => LIVE.has(j.state))).toEqual([]);
    const replacementJobs = jobs.filter((j) => j.data.sourceBlobId === staged.sourceBlobId);
    expect(replacementJobs).toHaveLength(3);
    expect(replacementJobs.every((j) => j.retryLimit === SLICER_RETRY.retryLimit)).toBe(true);
  });

  test("a render whose source cannot be read for more than 2 hours ends failed with a storage message, not a slicer one", async () => {
    const { fileId } = await storeScad(unique("first render, store down for good"));
    let now = Date.now();
    const clock = () => new Date(now);
    const down = () =>
      derivedWith({ store: storeDown({ reads: true }), queue: holdingQueue(), ...clocked(clock) });
    await derivedWith({ queue: holdingQueue() }).renderScad(fileId);

    expect(await runHeld(fileId, down())).toEqual({ status: "requeued", reason: "store_down" });
    now += TWO_HOURS_MS + 1000;
    expect(await runHeld(fileId, down())).toEqual({ status: "failed", reason: "store_down" });
    expect(await env.repos.files.get(fileId)).toMatchObject({
      derivedStatus: "failed",
      derivedMessage: STORE_DOWN_MESSAGE,
      renderStlBlobId: null,
      renderPngBlobId: null,
    });
    expect(env.stub.renders.calls).toHaveLength(0);
    const jobs = await jobsFor(fileId);
    expect(jobs.filter((j) => LIVE.has(j.state))).toEqual([]);
    expect(jobs.every((j) => j.retryLimit === SLICER_RETRY.retryLimit)).toBe(true);
  });
});

const STORE_REFUSED_MESSAGE = "Storage refused this file, so the render could not finish.";
const REPLACE_STORE_REFUSED_MESSAGE =
  "Storage refused the replacement, so the previous version is kept.";

/** Synthetic store settings for a scripted fake S3 endpoint. */
function fakeSettings(endpoint: string): Config["s3"] {
  return {
    endpoint,
    region: "us-east-1",
    bucket: "platehouse-test",
    accessKeyId: ["SYNTH", "ACCESS", "ID"].join(""),
    secretAccessKey: ["synthetic", "fake", "s3", "secret"].join("-"),
    forcePathStyle: true,
  };
}

/** The bucket key of a blob row. */
async function sourceKeyOf(blobId: string): Promise<string> {
  const blob = await env.repos.blobs.get(blobId);
  if (!blob) throw new Error("no blob row");
  return blob.key;
}

const fakeStores: Array<() => Promise<void> | void> = [];

/**
 * The env's store with reads or writes sent to a real BlobStore on a fake S3
 * endpoint that gives reply to every request, so the error the job sees is
 * the one the storage layer makes of a store that answers and refuses. One
 * attempt per call, so the SDK does not retry the refusal itself. Deletes
 * still go to the env's store.
 */
async function refusingStore(opts: { reads?: Reply; writes?: Reply }): Promise<DerivedStore> {
  const at = async (reply: Reply) => {
    const fake = await startFakeS3(() => reply);
    fakeStores.push(() => fake.close());
    const store = createBlobStore(fakeSettings(fake.endpoint), { maxAttempts: 1 });
    fakeStores.push(() => store.destroy());
    return store;
  };
  const reads = opts.reads === undefined ? env.store : await at(opts.reads);
  const writes = opts.writes === undefined ? env.store : await at(opts.writes);
  return {
    putBlob: writes.putBlob.bind(writes),
    getBlobStream: reads.getBlobStream.bind(reads),
    deleteBlobs: env.store.deleteBlobs.bind(env.store),
  };
}

// Issue #102: a store that answers and refuses (an HTTP 500, AccessDenied,
// NoSuchBucket) or a source object that is gone is neither an outage nor
// the slicer's doing. The file gets a storage message of its own, never the
// slicer's. A 500 may pass, so it uses pg-boss's retries; a 4xx refusal and
// a missing object will not, so they end the render at once.
describe("a store that answers and refuses (issue #102)", () => {
  afterEach(async () => {
    while (fakeStores.length > 0) await fakeStores.pop()?.();
  });

  test("the last attempt against a store whose GetObject answers 500 records the storage message, not the slicer one", async () => {
    const text = unique("store answers 500");
    const { modelId, fileId } = await storeScad(text);
    const file = await env.repos.files.get(fileId);
    if (!file) throw new Error("no file");
    const job: DerivedJob = { kind: DERIVED_KINDS.renderScad, fileId, sourceBlobId: file.blobId };
    const refusing = derivedWith({
      store: await refusingStore({ reads: s3Error(500, "InternalError") }),
    });

    const outcome = await refusing.runJob(job, {
      retryCount: SLICER_RETRY.retryLimit,
      retryLimit: SLICER_RETRY.retryLimit,
    });
    expect(outcome).toEqual({ status: "failed", reason: "store_refused" });
    const after = await env.repos.files.get(fileId);
    expect(after).toMatchObject({
      blobId: file.blobId,
      derivedStatus: "failed",
      derivedMessage: STORE_REFUSED_MESSAGE,
      renderStlBlobId: null,
      renderPngBlobId: null,
    });
    expect(after?.derivedMessage).not.toBe(DERIVED_MESSAGES.slicerError);
    expect(env.stub.renders.calls).toHaveLength(0);
    // The source is kept.
    expect((await blobsOf(env, modelId)).map((b) => b.kind)).toEqual(["source"]);
    expect(await readObject(env, await sourceKeyOf(file.blobId))).toEqual(Buffer.from(text));
  });

  test("a GetObject that answers 500 is left to pg-boss to retry, and only the last attempt records the storage message", async () => {
    const { fileId } = await storeScad(unique("store answers 500, early attempt"));
    const file = await env.repos.files.get(fileId);
    if (!file) throw new Error("no file");
    const job: DerivedJob = { kind: DERIVED_KINDS.renderScad, fileId, sourceBlobId: file.blobId };
    const refusing = derivedWith({
      store: await refusingStore({ reads: s3Error(500, "InternalError") }),
    });

    for (const retryCount of [0, SLICER_RETRY.retryLimit - 1]) {
      await expect(
        refusing.runJob(job, { retryCount, retryLimit: SLICER_RETRY.retryLimit }),
      ).rejects.toBeInstanceOf(StoreError);
      const waiting = await env.repos.files.get(fileId);
      expect(waiting?.derivedStatus).not.toBe("failed");
      expect(waiting?.derivedMessage).toBeNull();
    }

    // The last attempt settles the file, so nothing is left for the render
    // check to find.
    expect(
      await refusing.runJob(job, {
        retryCount: SLICER_RETRY.retryLimit,
        retryLimit: SLICER_RETRY.retryLimit,
      }),
    ).toEqual({ status: "failed", reason: "store_refused" });
    expect(await env.repos.files.get(fileId)).toMatchObject({
      derivedStatus: "failed",
      derivedMessage: STORE_REFUSED_MESSAGE,
    });
  });

  test("a replacement whose GetObject answers 500 on the last attempt keeps the previous version and discards the staged source", async () => {
    const { modelId, fileId } = await uploadScad(unique("replacement, store answers 500"));
    const before = await settledFile(env, fileId);
    const oldBlobs = await blobsOf(env, modelId);
    const oldKeys = await keysOf(env, modelId);
    env.stub.renders.reset();
    const staged = await derivedWith({ queue: holdingQueue() }).replaceFile(
      fileId,
      await writeUpload(env, unique("replacement never read")),
    );
    const stagedBlob = (await blobsOf(env, modelId)).find((b) => b.id === staged.sourceBlobId);
    if (!stagedBlob) throw new Error("no staged source row");
    const refusing = derivedWith({
      store: await refusingStore({ reads: s3Error(500, "InternalError") }),
      queue: holdingQueue(),
    });

    expect(await runHeld(fileId, refusing, { last: true })).toEqual({
      status: "failed",
      reason: "store_refused",
    });
    expect(await env.repos.files.get(fileId)).toMatchObject({
      blobId: before.blobId,
      renderStlBlobId: before.renderStlBlobId,
      renderPngBlobId: before.renderPngBlobId,
      derivedStatus: "failed",
      derivedMessage: REPLACE_STORE_REFUSED_MESSAGE,
    });
    expect((await blobsOf(env, modelId)).map((b) => b.id)).toEqual(oldBlobs.map((b) => b.id));
    expect(await keysOf(env, modelId)).toEqual(oldKeys);
    await expect(env.store.getBlobStream(stagedBlob.key)).rejects.toBeInstanceOf(BlobNotFound);
    expect(env.stub.renders.calls).toHaveLength(0);
    expect((await jobsFor(fileId)).filter((j) => LIVE.has(j.state))).toEqual([]);
  });

  test("a source object that is gone gets the storage message on the first attempt, with no retry", async () => {
    const { fileId } = await storeScad(unique("source object gone"));
    const file = await env.repos.files.get(fileId);
    if (!file) throw new Error("no file");
    await env.store.deleteBlobs([await sourceKeyOf(file.blobId)]);
    const job: DerivedJob = { kind: DERIVED_KINDS.renderScad, fileId, sourceBlobId: file.blobId };

    const outcome = await env.derived.runJob(job, {
      retryCount: 0,
      retryLimit: SLICER_RETRY.retryLimit,
    });
    expect(outcome).toEqual({ status: "failed", reason: "store_refused" });
    expect(await env.repos.files.get(fileId)).toMatchObject({
      derivedStatus: "failed",
      derivedMessage: STORE_REFUSED_MESSAGE,
      renderStlBlobId: null,
      renderPngBlobId: null,
    });
    expect(env.stub.renders.calls).toHaveLength(0);
  });

  test("a store that answers AccessDenied when the renders are stored ends the render on the first attempt with the storage message", async () => {
    const { modelId, fileId } = await storeScad(unique("renders refused"));
    const file = await env.repos.files.get(fileId);
    if (!file) throw new Error("no file");
    const job: DerivedJob = { kind: DERIVED_KINDS.renderScad, fileId, sourceBlobId: file.blobId };
    const refusing = derivedWith({
      store: await refusingStore({ writes: s3Error(403, "AccessDenied") }),
    });

    const outcome = await refusing.runJob(job, {
      retryCount: 0,
      retryLimit: SLICER_RETRY.retryLimit,
    });
    expect(outcome).toEqual({ status: "failed", reason: "store_refused" });
    expect(await env.repos.files.get(fileId)).toMatchObject({
      derivedStatus: "failed",
      derivedMessage: STORE_REFUSED_MESSAGE,
      renderStlBlobId: null,
      renderPngBlobId: null,
    });
    // The slicer rendered; only storing the renders was refused, and nothing
    // of them is kept.
    expect(env.stub.renders.callsTo("/v1/scad/stl")).toHaveLength(1);
    expect((await blobsOf(env, modelId)).map((b) => b.kind)).toEqual(["source"]);
    expect(await keysOf(env, modelId)).toEqual([await sourceKeyOf(file.blobId)]);
  });
});

describe("the slicer queue's worker", () => {
  test("an unknown slicer job kind fails its job instead of passing silently", async () => {
    const id = await env.boss.send(QUEUE.slicer, { kind: "no-such-kind" }, { retryLimit: 0 });
    if (id === null) throw new Error("job not created");
    const job = await until(
      () => env.boss.getJobById(QUEUE.slicer, id),
      (j) => j?.state === "failed",
    );
    expect(JSON.stringify(job?.output)).toMatch(/Unknown slicer job kind: no-such-kind/);
    expect(env.stub.renders.calls).toHaveLength(0);
  });

  test("the render and mesh kinds register into the slicer queue's one handler map", () => {
    expect(Object.keys(derivedJobHandlers(env.derived)).sort()).toEqual(
      [DERIVED_KINDS.convertStep, DERIVED_KINDS.renderScad].sort(),
    );
    expect(DERIVED_KINDS).toEqual({ renderScad: "render-scad", convertStep: "convert-step" });
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
    env.stub.renders.always("/v1/scad/png", { kind: "drop" });
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

  test("a replacement made before the first render finishes keeps the file pending until it lands", async () => {
    const first = unique("first render");
    const second = unique("replaced early");
    const { fileId } = await storeScad(first);
    const original = await env.repos.files.get(fileId);
    if (!original) throw new Error("file not stored");

    // The replacement's first attempt finds the slicer busy, and pg-boss
    // holds it 5 to 10 s before the retry: a newer source is queued.
    env.stub.renders.queue("/v1/scad/stl", { kind: "busy" });
    await derivedWith({ retryDelaySeconds: 5 }).replaceFile(fileId, await writeUpload(env, second));
    await until(
      () => env.stub.renders.callsTo("/v1/scad/stl").length,
      (n) => n === 1,
    );

    // Meanwhile the first render, of the source being replaced, finishes.
    const outcome = await env.derived.runJob(
      { kind: DERIVED_KINDS.renderScad, fileId, sourceBlobId: original.blobId },
      { retryCount: 0, retryLimit: SLICER_RETRY.retryLimit },
    );
    expect(outcome).toEqual({ status: "ok" });
    const between = await env.repos.files.get(fileId);
    expect(between).toMatchObject({ blobId: original.blobId, derivedStatus: "pending" });
    expect(between?.renderStlBlobId).not.toBeNull();

    // The replacement lands and the file is done.
    const after = await until(
      () => env.repos.files.get(fileId),
      (f) => f?.blobId !== original.blobId && f?.derivedStatus === "ok",
    );
    const blobs = await blobsOf(env, after?.modelId ?? "");
    const byId = new Map(blobs.map((b) => [b.id, b]));
    expect(await readObject(env, byId.get(after?.renderStlBlobId ?? "")?.key ?? "")).toEqual(
      renderedBytes("/v1/scad/stl", second),
    );
  });

  test("a replacement that ends in slicer_error while a newer one is queued leaves the file pending", async () => {
    const { modelId, fileId } = await uploadScad(unique("base"));
    const before = await settledFile(env, fileId);
    const older = unique("older replacement");
    const newer = unique("newer replacement");

    // Both replacements' first attempts find the slicer busy, so both wait
    // 5 to 10 s for a retry.
    env.stub.renders.queue("/v1/scad/stl", { kind: "busy" }, { kind: "busy" });
    const slow = derivedWith({ retryDelaySeconds: 5 });
    const staged = await slow.replaceFile(fileId, await writeUpload(env, older));
    await slow.replaceFile(fileId, await writeUpload(env, newer));
    await until(
      () => env.stub.renders.callsTo("/v1/scad/stl").length,
      (n) => n === 2,
    );

    // The older replacement's last attempt loses the slicer.
    env.stub.renders.always("/v1/scad/stl", { kind: "drop" });
    const outcome = await env.derived.runJob(
      { kind: DERIVED_KINDS.renderScad, fileId, sourceBlobId: staged.sourceBlobId },
      { retryCount: SLICER_RETRY.retryLimit, retryLimit: SLICER_RETRY.retryLimit },
    );
    env.stub.renders.always("/v1/scad/stl", { kind: "render" });
    expect(outcome).toEqual({ status: "failed", reason: "slicer_error" });
    expect(await env.repos.files.get(fileId)).toMatchObject({
      blobId: before.blobId,
      derivedStatus: "pending",
      derivedMessage: null,
    });
    expect((await blobsOf(env, modelId)).some((b) => b.id === staged.sourceBlobId)).toBe(false);

    // The newer replacement lands.
    const after = await until(
      () => env.repos.files.get(fileId),
      (f) => f?.blobId !== before.blobId && f?.derivedStatus === "ok",
    );
    const blobs = await blobsOf(env, modelId);
    const byId = new Map(blobs.map((b) => [b.id, b]));
    expect(await readObject(env, byId.get(after?.blobId ?? "")?.key ?? "")).toEqual(
      Buffer.from(newer),
    );
  });

  test("the staged source and its job commit together: a send that fails leaves neither", async () => {
    const { modelId, fileId } = await uploadScad(unique("atomic"));
    const before = await settledFile(env, fileId);
    const oldBlobs = await blobsOf(env, modelId);
    const oldKeys = await keysOf(env, modelId);

    // The job is written, then the process "dies" before replaceFile returns.
    const send: PgBoss["send"] = async (...args: unknown[]) => {
      await (env.boss.send as (...a: unknown[]) => Promise<string | null>)(...args);
      throw new Error("the process died after sending the job");
    };
    const dying = derivedWith({
      queue: { send, findJobs: env.boss.findJobs.bind(env.boss) },
    });
    await expect(
      dying.replaceFile(fileId, await writeUpload(env, unique("never"))),
    ).rejects.toThrow("the process died");

    // No job, no staged row, no object, and the file as it was.
    const jobs = await jobsFor(fileId);
    expect(jobs.filter((j) => j.data.sourceBlobId !== before.blobId)).toEqual([]);
    expect((await blobsOf(env, modelId)).map((b) => b.id)).toEqual(oldBlobs.map((b) => b.id));
    expect(await keysOf(env, modelId)).toEqual(oldKeys);
    expect(await env.repos.files.get(fileId)).toMatchObject({
      blobId: before.blobId,
      derivedStatus: "ok",
      derivedMessage: null,
    });
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

  test("replaceFile refuses a .scad over the renderer's 1 MiB limit and stores nothing", async () => {
    const { modelId, fileId } = await uploadScad(unique("too large"));
    const before = await settledFile(env, fileId);
    // Count only the calls replaceFile makes, not the upload's own render.
    env.stub.renders.reset();
    const keys = await keysOf(env, modelId);
    const blobs = (await blobsOf(env, modelId)).map((b) => b.id);
    const jobCount = (await jobsFor(fileId)).length;
    const path = await writeUpload(env, `// ${"x".repeat(LIMITS.scadBodyBytes)}\n${SCAD_TEXT}`);

    const error = await env.derived.replaceFile(fileId, path).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DerivedError);
    expect((error as DerivedError).code).toBe("too_large");
    expect((error as DerivedError).message).toMatch(/1 MiB/);
    expect(await keysOf(env, modelId)).toEqual(keys);
    expect((await blobsOf(env, modelId)).map((b) => b.id)).toEqual(blobs);
    expect(await jobsFor(fileId)).toHaveLength(jobCount);
    expect(env.stub.renders.calls).toHaveLength(0);
    expect(await env.repos.files.get(fileId)).toMatchObject({
      blobId: before.blobId,
      renderStlBlobId: before.renderStlBlobId,
      renderPngBlobId: before.renderPngBlobId,
      derivedStatus: "ok",
    });
  });
});

/** A time past the render check's grace period, as a later run sees it. */
const pastGrace = () => new Date(Date.now() + RENDER_CHECK_GRACE_MS + 60_000);

/**
 * A createDerived whose jobs are held: each is sent to start in an hour and
 * with no retries, so it stays queued until the test fails it with
 * boss.fail, which is what pg-boss does when a job's last attempt dies.
 */
function heldDerived() {
  const send: PgBoss["send"] = async (...args: unknown[]) => {
    const [name, data, options] = args as [string, object, Record<string, unknown>];
    return (env.boss.send as (...a: unknown[]) => Promise<string | null>)(name, data, {
      ...options,
      startAfter: 3600,
      retryLimit: 0,
    });
  };
  return derivedWith({ queue: { send, findJobs: env.boss.findJobs.bind(env.boss) } });
}

/** The one job queued for the file, failed as pg-boss fails a job whose last attempt died. */
async function killJob(fileId: string): Promise<string> {
  const queued = (await jobsFor(fileId)).filter((j) => j.state === "created");
  expect(queued).toHaveLength(1);
  const id = queued[0]?.id ?? "";
  await env.boss.fail(QUEUE.slicer, id, { message: "the process died mid-render" });
  expect((await env.boss.getJobById(QUEUE.slicer, id))?.state).toBe("failed");
  return id;
}

/** A settled .scad, then a replacement whose job is held, as replaceFile leaves it. */
async function heldReplacement(label: string) {
  const { modelId, fileId } = await uploadScad(unique(label));
  const before = await settledFile(env, fileId);
  const staged = await heldDerived().replaceFile(fileId, await writeUpload(env, unique(label)));
  const stagedBlob = (await blobsOf(env, modelId)).find((b) => b.id === staged.sourceBlobId);
  if (!stagedBlob) throw new Error("no staged source row");
  expect(stagedBlob).toMatchObject({ kind: "source", state: "stored" });
  expect(await env.repos.files.get(fileId)).toMatchObject({ derivedStatus: "pending" });
  return { modelId, fileId, before, stagedBlob };
}

describe("the render check (issues #90 and #91)", () => {
  test("it waits longer than a render job's expiry before it acts", async () => {
    const { fileId } = await uploadScad(unique("expiry"));
    await settledFile(env, fileId);
    const [job] = await jobsFor(fileId);
    expect(job?.expireInSeconds).toBeGreaterThan(0);
    expect(RENDER_CHECK_GRACE_MS).toBeGreaterThan(
      (job?.expireInSeconds ?? Number.POSITIVE_INFINITY) * 1000,
    );
  });

  test("a .scad left with no status and no job is queued once the grace period has passed (#91)", async () => {
    // A database failure right after ingest committed: the row is there,
    // derived_status is null and no job was queued.
    const text = unique("never queued");
    const { fileId } = await storeScad(text);
    expect(await env.repos.files.get(fileId)).toMatchObject({ derivedStatus: null });
    expect(await jobsFor(fileId)).toEqual([]);

    // Inside the grace period the check leaves it alone.
    const early = await env.derived.checkRenders(new Date());
    expect(early.queued).not.toContain(fileId);
    expect(await jobsFor(fileId)).toEqual([]);

    const result = await env.derived.checkRenders(pastGrace());
    expect(result.queued).toContain(fileId);
    const jobs = await jobsFor(fileId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      data: { kind: DERIVED_KINDS.renderScad, fileId },
      retryLimit: SLICER_RETRY.retryLimit,
    });

    const file = await settledFile(env, fileId);
    expect(file.derivedStatus).toBe("ok");
    expect(env.stub.renders.callsTo("/v1/scad/stl").map((c) => c.body.toString("utf8"))).toEqual([
      text,
    ]);
  });

  test("a pending file whose last job died is marked failed and not queued again (#90)", async () => {
    const { fileId } = await storeScad(unique("died"));
    await heldDerived().renderScad(fileId);
    expect(await env.repos.files.get(fileId)).toMatchObject({ derivedStatus: "pending" });
    await killJob(fileId);

    const result = await env.derived.checkRenders(pastGrace());
    expect(result.failed).toContain(fileId);
    expect(result.queued).not.toContain(fileId);
    expect(await env.repos.files.get(fileId)).toMatchObject({
      derivedStatus: "failed",
      derivedMessage: DERIVED_MESSAGES.renderLost,
    });
    // A file that kills the slicer must not loop: no new job.
    expect(await jobsFor(fileId)).toHaveLength(1);
  });

  test("a replacement whose last job died keeps the previous version and loses its staged source (#90)", async () => {
    const { modelId, fileId, before, stagedBlob } = await heldReplacement("replacement died");
    await killJob(fileId);

    const result = await env.derived.checkRenders(pastGrace());
    expect(result.failed).toContain(fileId);
    expect(result.discarded).toContain(stagedBlob.id);

    // The file is as it was before the replacement, and says why.
    const after = await env.repos.files.get(fileId);
    expect(after).toMatchObject({
      blobId: before.blobId,
      renderStlBlobId: before.renderStlBlobId,
      renderPngBlobId: before.renderPngBlobId,
      derivedStatus: "failed",
      derivedMessage: DERIVED_MESSAGES.replaceLost,
    });
    // The staged source's row and object are gone; nothing else is.
    const blobs = await blobsOf(env, modelId);
    expect(blobs.map((b) => b.id).sort()).toEqual(
      [before.blobId, before.renderStlBlobId, before.renderPngBlobId].sort(),
    );
    await expect(env.store.getBlobStream(stagedBlob.key)).rejects.toBeInstanceOf(BlobNotFound);
    expect(await keysOf(env, modelId)).toEqual(blobs.map((b) => b.key).sort());
    expect(await jobsFor(fileId)).toHaveLength(2);
  });

  test("a staged source whose object cannot be deleted keeps its row, and the next run removes both", async () => {
    const { modelId, fileId, stagedBlob } = await heldReplacement("store down");
    await killJob(fileId);

    // Object first, then row: a store that refuses the delete leaves the row,
    // so the next run still finds the object.
    const downStore: DerivedStore = {
      putBlob: env.store.putBlob.bind(env.store),
      getBlobStream: env.store.getBlobStream.bind(env.store),
      deleteBlobs: async () => {
        throw new Error("the store is down");
      },
    };
    const first = await derivedWith({ store: downStore }).checkRenders(pastGrace());
    expect(first.discarded).not.toContain(stagedBlob.id);
    expect((await blobsOf(env, modelId)).some((b) => b.id === stagedBlob.id)).toBe(true);
    expect(await readObject(env, stagedBlob.key)).toBeInstanceOf(Buffer);

    // A retry after the object went but the row did not finishes the job.
    await env.store.deleteBlobs([stagedBlob.key]);
    const second = await env.derived.checkRenders(pastGrace());
    expect(second.discarded).toContain(stagedBlob.id);
    expect((await blobsOf(env, modelId)).some((b) => b.id === stagedBlob.id)).toBe(false);
    expect(await keysOf(env, modelId)).toEqual(
      (await blobsOf(env, modelId)).map((b) => b.key).sort(),
    );
  });

  test("a file and a staged source that a live job still owns are left untouched", async () => {
    const { modelId, fileId, before, stagedBlob } = await heldReplacement("live job");
    const blobsBefore = await blobsOf(env, modelId);
    const keysBefore = await keysOf(env, modelId);

    const result = await env.derived.checkRenders(pastGrace());
    expect(result.failed).not.toContain(fileId);
    expect(result.queued).not.toContain(fileId);
    expect(result.discarded).not.toContain(stagedBlob.id);
    expect(await env.repos.files.get(fileId)).toMatchObject({
      blobId: before.blobId,
      derivedStatus: "pending",
      derivedMessage: null,
    });
    expect(await blobsOf(env, modelId)).toEqual(blobsBefore);
    expect(await keysOf(env, modelId)).toEqual(keysBefore);
    const jobs = await jobsFor(fileId);
    expect(jobs.filter((j) => j.state === "created")).toHaveLength(1);

    // The held job is failed so it never runs during a later test; the next
    // run then settles the file and removes the staged source.
    await killJob(fileId);
  });

  test("a second run does nothing", async () => {
    const { fileId: lost } = await storeScad(unique("second run lost"));
    await heldDerived().renderScad(lost);
    await killJob(lost);
    const { fileId: unqueued } = await storeScad(unique("second run unqueued"));

    const first = await env.derived.checkRenders(pastGrace());
    expect(first.failed).toContain(lost);
    expect(first.queued).toContain(unqueued);
    await settledFile(env, unqueued);

    const second = await env.derived.checkRenders(pastGrace());
    expect(second).toEqual({ queued: [], failed: [], discarded: [] });
    expect(await jobsFor(lost)).toHaveLength(1);
    expect(await jobsFor(unqueued)).toHaveLength(1);
  });
});
