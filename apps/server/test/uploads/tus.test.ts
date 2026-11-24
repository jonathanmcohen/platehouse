// Resumable uploads, without Docker. The tus routes run on
// a real Fastify app over loopback HTTP into a real temp folder; only the
// ingest queue is a fake, so every rule of the upload layer itself is checked
// here: metadata, the size cap, the auth hook, resume after a cut-off PATCH,
// the result route, deleting the temp file after ingest and the stale sweep.
// The integration suite (test/integration/uploads) runs the same routes with
// pg-boss, ingestFile, Postgres and the S3 test server.
import { randomUUID } from "node:crypto";
import { link, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PgBoss } from "pg-boss";
import { Upload } from "tus-js-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  INGEST_FAILED_MESSAGE,
  IngestError,
  type IngestInput,
  IngestOutcomeUnknown,
} from "../../src/ingest/ingest.js";
import { QUEUE } from "../../src/jobs/queues.js";
import {
  bossUploadQueue,
  createUploads,
  EMPTY_UPLOAD_MESSAGE,
  MAX_UPLOAD_BYTES,
  MAX_UPLOADS_ON_DISK,
  MAX_UPLOADS_PER_PRINCIPAL,
  MIN_FREE_FILES,
  parseUploadMetadata,
  prepareUploads,
  registerTus,
  STALE_UPLOAD_MS,
  TOO_MANY_HELD_MESSAGE,
  TOO_MANY_UNFINISHED_MESSAGE,
  type UploadQueue,
  UploadRefused,
  type UploadResult,
  type Uploads,
  uploadsDir,
} from "../../src/uploads/tus.js";
import {
  idOf,
  interruptedPatch,
  meta,
  OCTET,
  patchStillSendingAfterAnswer,
  randomBinaryStl,
  send,
  startApp,
  type TestApp,
  TUS,
} from "./support/http.js";

class FakeQueue implements UploadQueue {
  readonly enqueued = new Map<string, IngestInput>();
  /** Every enqueue that succeeded, in order, repeats included. */
  readonly enqueueCalls: Array<[string, IngestInput]> = [];
  readonly results = new Map<string, UploadResult>();
  failEnqueue = false;
  failResult = false;

  async enqueue(id: string, input: IngestInput): Promise<void> {
    if (this.failEnqueue) throw new Error("connect ECONNREFUSED 10.9.8.7:5432");
    this.enqueued.set(id, input);
    this.enqueueCalls.push([id, input]);
  }

  async result(id: string): Promise<UploadResult | undefined> {
    if (this.failResult) throw new Error("connect ECONNREFUSED 10.9.8.7:5432");
    return this.results.get(id) ?? (this.enqueued.has(id) ? { status: "pending" } : undefined);
  }
}

const PREFIX = "/api/v1/uploads";

/**
 * The free space and free inodes the tests' upload stores report: plenty, so
 * no test depends on the room left in os.tmpdir() on the machine running it.
 * Only the tests about free space or inodes give their own, and one keeps
 * the real disk.
 */
const plentyOfRoom = async () => Number.MAX_SAFE_INTEGER;
const KEY = { "x-test-key": "letmein" };

/** tus-js-client's URL storage and its entries; the package does not export the names. */
type UrlStorage = NonNullable<Upload["options"]["urlStorage"]>;
type PreviousUpload = Awaited<ReturnType<Upload["findPreviousUploads"]>>[number];

async function keyHook(request: FastifyRequest, reply: FastifyReply) {
  if (request.headers["x-test-key"] !== KEY["x-test-key"]) {
    return reply.code(401).send({ error: "unauthorized" });
  }
}

let root: string;
let tmpDir: string;
let queue: FakeQueue;
let uploads: Uploads;
let server: TestApp;
let lines: string[];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "platehouse-tus-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  tmpDir = await mkdtemp(join(root, "tmp-"));
  queue = new FakeQueue();
  lines = [];
  uploads = createUploads({
    tmpDir,
    queue,
    log: (line) => lines.push(line),
    freeBytes: plentyOfRoom,
    freeFiles: plentyOfRoom,
  });
  server = await startApp(async (app) => {
    await registerTus(app, { prefix: PREFIX, authHook: keyHook, uploads });
  });
});

afterEach(async () => {
  await server.close();
});

async function tempFiles(): Promise<string[]> {
  try {
    return (await readdir(uploads.dir)).sort();
  } catch {
    return [];
  }
}

function create(length: number, fields: Record<string, string | null>, extra = {}) {
  return send(server.base, "POST", PREFIX, {
    headers: {
      ...TUS,
      ...KEY,
      "upload-length": String(length),
      "upload-metadata": meta(fields),
      ...extra,
    },
  });
}

function patch(id: string, offset: number, body: Buffer, headers: Record<string, string> = KEY) {
  return send(server.base, "PATCH", `${PREFIX}/${id}`, {
    headers: { ...TUS, ...headers, "content-type": OCTET, "upload-offset": String(offset) },
    body,
  });
}

function head(id: string, headers: Record<string, string> = KEY) {
  return send(server.base, "HEAD", `${PREFIX}/${id}`, { headers: { ...TUS, ...headers } });
}

async function resultOf(id: string, headers: Record<string, string> = KEY) {
  const res = await send(server.base, "GET", `${PREFIX}/${id}/result`, { headers });
  return { status: res.status, body: res.body === "" ? undefined : JSON.parse(res.body) };
}

describe("parseUploadMetadata", () => {
  const RLO = String.fromCodePoint(0x202e);
  const ZWSP = String.fromCodePoint(0x200b);

  test("drops invisible format characters from the file name (U+202E, U+200B)", () => {
    expect(parseUploadMetadata({ filename: `Ben${RLO}chy${ZWSP}.3mf` }).originalName).toBe(
      "Benchy.3mf",
    );
  });

  test("a name made only of format characters is refused as an empty name is", () => {
    expect(() => parseUploadMetadata({ filename: `${RLO}${ZWSP}` })).toThrow(
      "Upload-Metadata must carry the file's name as filename",
    );
    expect(() => parseUploadMetadata({ filename: "" })).toThrow(
      "Upload-Metadata must carry the file's name as filename",
    );
  });

  test("a filename alone makes a new model", () => {
    expect(parseUploadMetadata({ filename: "Benchy.3mf" })).toEqual({
      originalName: "Benchy.3mf",
      target: "new",
      duplicates: "allow",
    });
  });

  test("modelId puts the file into that model, lowercased", () => {
    const id = randomUUID().toUpperCase();
    expect(parseUploadMetadata({ filename: "a.stl", modelId: id })).toEqual({
      originalName: "a.stl",
      target: { modelId: id.toLowerCase() },
      duplicates: "allow",
    });
  });

  test.each([
    ["1", true],
    ["true", true],
    ["0", false],
    ["false", false],
  ])("batch with combine %s", (combine, expected) => {
    expect(parseUploadMetadata({ filename: "a.stl", batch: "b-1", combine })).toEqual({
      originalName: "a.stl",
      target: { batch: "b-1", combine: expected },
      duplicates: "allow",
    });
  });

  test("a batch without combine gives each file its own model", () => {
    expect(parseUploadMetadata({ filename: "a.stl", batch: "b-1" }).target).toEqual({
      batch: "b-1",
      combine: false,
    });
  });

  test("a long name, spaces and non-ASCII are kept as sent", () => {
    const accents = String.fromCodePoint(0xe9, 0xe8);
    const name = `${`Long name with spaces and ${accents} `.repeat(8)}.3mf`;
    expect(name.length).toBeGreaterThan(200);
    expect(parseUploadMetadata({ filename: name }).originalName).toBe(name);
  });

  test("duplicates: left out it is allow, so an API client that never sends it sees no change", () => {
    expect(parseUploadMetadata({ filename: "a.stl" }).duplicates).toBe("allow");
    expect(parseUploadMetadata({ filename: "a.stl", duplicates: "allow" }).duplicates).toBe(
      "allow",
    );
    expect(parseUploadMetadata({ filename: "a.stl", duplicates: "skip" }).duplicates).toBe("skip");
    expect(
      parseUploadMetadata({ filename: "a.stl", modelId: randomUUID(), duplicates: "skip" }),
    ).toMatchObject({ duplicates: "skip" });
  });

  test("metadata keys it does not know are ignored", () => {
    expect(parseUploadMetadata({ filename: "a.stl", filetype: "model/stl" }).target).toBe("new");
  });

  const refusals: Array<[string, Record<string, string | null> | undefined, number, RegExp]> = [
    ["no metadata", undefined, 400, /filename/],
    ["no filename", { modelId: randomUUID() }, 400, /filename/],
    ["an empty filename", { filename: "" }, 400, /filename/],
    ["a blank filename", { filename: "   " }, 400, /filename/],
    ["a filename with no value", { filename: null }, 400, /filename/],
    ["a NUL in the filename", { filename: "a\u0000.stl" }, 400, /filename/],
    ["a filename over 1024 characters", { filename: `${"a".repeat(1025)}.stl` }, 400, /filename/],
    ["a modelId that is no uuid", { filename: "a.stl", modelId: "42" }, 400, /modelId/],
    ["combine without a batch", { filename: "a.stl", combine: "1" }, 400, /batch/],
    ["an empty batch", { filename: "a.stl", batch: "" }, 400, /batch/],
    ["a batch over 200 characters", { filename: "a.stl", batch: "b".repeat(201) }, 400, /batch/],
    [
      "combine that is not 1, 0, true or false",
      { filename: "a.stl", batch: "b", combine: "yes" },
      400,
      /combine/,
    ],
    [
      "both modelId and batch",
      { filename: "a.stl", modelId: randomUUID(), batch: "b" },
      400,
      /modelId/,
    ],
    [
      "duplicates that is not skip or allow",
      { filename: "a.stl", duplicates: "no" },
      400,
      /duplicates/,
    ],
    ["duplicates with no value", { filename: "a.stl", duplicates: null }, 400, /duplicates/],
    ["an unsupported type", { filename: "notes.txt" }, 415, /not a supported/],
    ["no extension", { filename: "README" }, 415, /not a supported/],
  ];
  test.each(refusals)("refuses %s", (_label, metadata, status, message) => {
    let thrown: unknown;
    try {
      parseUploadMetadata(metadata);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UploadRefused);
    expect((thrown as UploadRefused).status).toBe(status);
    expect((thrown as UploadRefused).message).toMatch(message);
  });
});

describe("tus routes", () => {
  test("partial uploads live under TMP_DIR/uploads", () => {
    expect(uploads.dir).toBe(join(tmpDir, "uploads"));
    expect(uploadsDir("/data/tmp")).toBe("/data/tmp/uploads");
  });

  test("a finished upload queues its ingest under the upload id", async () => {
    const body = randomBinaryStl(20);
    const created = await create(body.length, { filename: "Part.stl", batch: "b", combine: "1" });
    expect(created.status).toBe(201);
    const id = idOf(created.headers.location);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(queue.enqueued.size).toBe(0);
    expect((await resultOf(id)).body).toEqual({ status: "pending" });

    const done = await patch(id, 0, body);
    expect(done.status).toBe(204);
    expect(done.headers["upload-offset"]).toBe(String(body.length));
    expect(queue.enqueued.get(id)).toEqual({
      tmpPath: join(uploads.dir, id),
      originalName: "Part.stl",
      target: { batch: "b", combine: true },
      duplicates: "allow",
    });
    expect((await readFile(join(uploads.dir, id))).equals(body)).toBe(true);
  });

  test("duplicates skip in the metadata reaches the queued ingest", async () => {
    const body = randomBinaryStl(20);
    const created = await create(body.length, { filename: "Part.stl", duplicates: "skip" });
    expect(created.status).toBe(201);
    const id = idOf(created.headers.location);
    expect((await patch(id, 0, body)).status).toBe(204);
    expect(queue.enqueued.get(id)).toMatchObject({ target: "new", duplicates: "skip" });
  });

  test("a bad duplicates value is refused at creation and stores nothing", async () => {
    const created = await create(10, { filename: "Part.stl", duplicates: "maybe" });
    expect(created.status).toBe(400);
    expect(created.body).toMatch(/duplicates/);
    expect(queue.enqueued.size).toBe(0);
  });

  test("a PATCH cut off part way resumes from the offset the server kept", async () => {
    const body = randomBinaryStl(40_000);
    const created = await create(body.length, { filename: "Phone upload.stl" });
    const id = idOf(created.headers.location);
    await interruptedPatch(server.base, `${PREFIX}/${id}`, {
      headers: { ...TUS, ...KEY, "content-type": OCTET, "upload-offset": "0" },
      body,
      sendBytes: Math.floor(body.length / 2),
    });
    // The server may still be finishing the cut-off request.
    let offset = -1;
    for (let i = 0; i < 50; i += 1) {
      const res = await head(id);
      if (res.status === 200) {
        const now = Number(res.headers["upload-offset"]);
        if (now === offset) break;
        offset = now;
      }
      await sleep(100);
    }
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThanOrEqual(Math.floor(body.length / 2));
    expect(queue.enqueued.size).toBe(0);

    const wrongOffset = await patch(id, 0, body);
    expect(wrongOffset.status).toBe(409);
    const rest = await patch(id, offset, body.subarray(offset));
    expect(rest.status).toBe(204);
    expect((await readFile(join(uploads.dir, id))).equals(body)).toBe(true);
    expect(queue.enqueued.has(id)).toBe(true);
  });

  // The store makes its folder in its constructor without waiting for it,
  // and TMP_DIR can be emptied while the server runs, so a creation can
  // arrive before the folder is there; it makes the folder, not a 500.
  test("a creation that arrives before the uploads folder is there makes it and is created", async () => {
    await rm(uploads.dir, { recursive: true, force: true });
    const res = await create(10, { filename: "a.stl" });
    expect(res.status, res.body).toBe(201);
    const id = idOf(res.headers.location);
    expect(await tempFiles()).toEqual([id, `${id}.json`].sort());
  });

  test("HEAD reports the offset and the length", async () => {
    const body = randomBinaryStl(100);
    const id = idOf((await create(body.length, { filename: "a.stl" })).headers.location);
    await patch(id, 0, body.subarray(0, 1000));
    const res = await head(id);
    expect(res.status).toBe(200);
    expect(res.headers["upload-offset"]).toBe("1000");
    expect(res.headers["upload-length"]).toBe(String(body.length));
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("an upload that cannot be queued is removed and answered 503", async () => {
    queue.failEnqueue = true;
    const body = randomBinaryStl(5);
    const id = idOf((await create(body.length, { filename: "a.stl" })).headers.location);
    const res = await patch(id, 0, body);
    expect(res.status).toBe(503);
    expect(res.body).toMatch(/nothing was saved/);
    expect(await tempFiles()).toEqual([]);
  });

  test("missing filename metadata is 400 and stores nothing", async () => {
    const res = await send(server.base, "POST", PREFIX, {
      headers: { ...TUS, ...KEY, "upload-length": "10" },
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatch(/filename/);
    expect(await tempFiles()).toEqual([]);
  });

  test("an unsupported type is 415 and stores nothing", async () => {
    const res = await create(10, { filename: "photo.jpg" });
    expect(res.status).toBe(415);
    expect(await tempFiles()).toEqual([]);
  });

  test("an upload over the cap is 413 and an open length is 400; neither stores anything", async () => {
    expect((await create(MAX_UPLOAD_BYTES + 1, { filename: "a.stl" })).status).toBe(413);
    const deferred = await send(server.base, "POST", PREFIX, {
      headers: {
        ...TUS,
        ...KEY,
        "upload-defer-length": "1",
        "upload-metadata": meta({ filename: "a.stl" }),
      },
    });
    expect(deferred.status).toBe(400);
    expect(deferred.body).toMatch(/Upload-Length/);
    expect(await tempFiles()).toEqual([]);
    expect((await create(MAX_UPLOAD_BYTES, { filename: "a.stl" })).status).toBe(201);
  });

  test("an empty upload is 400 with a plain sentence and stores nothing", async () => {
    const res = await create(0, { filename: "a.stl" });
    expect(res.status).toBe(400);
    expect(res.body).toBe(`${EMPTY_UPLOAD_MESSAGE}\n`);
    expect(EMPTY_UPLOAD_MESSAGE).toMatch(/^[A-Z][^\n]*\.$/);
    expect(await tempFiles()).toEqual([]);
    expect(queue.enqueued.size).toBe(0);
    expect((await create(1, { filename: "a.stl" })).status).toBe(201);
  });

  test("a PATCH carrying more than the declared length is refused", async () => {
    const id = idOf((await create(100, { filename: "a.stl" })).headers.location);
    const res = await patch(id, 0, randomBinaryStl(10));
    expect(res.status).toBe(413);
    expect(queue.enqueued.size).toBe(0);
  });

  test("a PATCH answered before its body is read does not hold its connection open", async () => {
    // tus answers a wrong offset (409) without reading the body. The rest of
    // the body must be read off and the connection closed, or the server
    // could never shut down and the connection would stay busy.
    const body = randomBinaryStl(40_000);
    const id = idOf((await create(body.length, { filename: "a.stl" })).headers.location);
    await patch(id, 0, body.subarray(0, 1000));
    const wrong = await patch(id, 0, body);
    expect(wrong.status).toBe(409);
    expect(wrong.headers.connection).toBe("close");
    const closed = await Promise.race([
      server.close().then(() => "closed"),
      sleep(3000).then(() => "still open"),
    ]);
    expect(closed).toBe("closed");
  });

  test("a client still sending when an early answer arrives can send the rest, and the connection then closes", async () => {
    // tus answers a wrong offset (409) before reading the body. The answer
    // goes out at once with Connection: close, and the connection stays open
    // only until the rest of the body has been read off: a client still
    // sending must not meet a reset (EPIPE, ECONNRESET), which could cost
    // it the answer, and the connection must not stay open after.
    const body = randomBinaryStl(40_000);
    const id = idOf((await create(body.length, { filename: "a.stl" })).headers.location);
    await patch(id, 0, body.subarray(0, 1000));
    const result = await patchStillSendingAfterAnswer(server.base, `${PREFIX}/${id}`, {
      headers: { ...TUS, ...KEY, "content-type": OCTET, "upload-offset": "0" },
      body,
      firstBytes: 64 * 1024,
      closeWithinMs: 3000,
    });
    expect(result.head).toMatch(/^HTTP\/1\.1 409 /);
    expect(result.head.toLowerCase()).toContain("\r\nconnection: close");
    expect(result.error).toBeNull();
    expect(result.written).toBe(body.length);
    expect(result.closed).toBe(true);
  });

  test("a refused request stores nothing and writes nothing", async () => {
    const res = await send(server.base, "POST", PREFIX, {
      headers: { ...TUS, "upload-length": "10", "upload-metadata": meta({ filename: "a.stl" }) },
    });
    expect(res.status).toBe(401);
    expect(await tempFiles()).toEqual([]);

    const body = randomBinaryStl(5);
    const id = idOf((await create(body.length, { filename: "a.stl" })).headers.location);
    expect((await patch(id, 0, body, {})).status).toBe(401);
    expect((await head(id, {})).status).toBe(401);
    expect((await resultOf(id, {})).status).toBe(401);
    expect((await stat(join(uploads.dir, id))).size).toBe(0);
    expect(queue.enqueued.size).toBe(0);
  });

  test("an id that is not an upload id is 404 on every route", async () => {
    for (const bad of ["abc", "..", "%2E%2E", "%2e%2e%2fetc", randomUUID().replace(/-/g, "")]) {
      expect((await head(bad)).status, bad).toBe(404);
      expect((await patch(bad, 0, Buffer.from("x"))).status, bad).toBe(404);
      expect((await resultOf(bad)).status, bad).toBe(404);
    }
    expect((await resultOf(randomUUID())).status).toBe(404);
  });

  test("the result route reports done and failed from the queue", async () => {
    const body = randomBinaryStl(5);
    const id = idOf((await create(body.length, { filename: "a.stl" })).headers.location);
    await patch(id, 0, body);
    expect(await resultOf(id)).toEqual({ status: 200, body: { status: "pending" } });
    const modelId = randomUUID();
    const fileId = randomUUID();
    queue.results.set(id, { status: "done", modelId, fileId, duplicates: [] });
    expect(await resultOf(id)).toEqual({
      status: 200,
      body: { status: "done", modelId, fileId, duplicates: [] },
    });
    queue.results.set(id, { status: "failed", error: "Nope; nothing was saved" });
    expect(await resultOf(id)).toEqual({
      status: 200,
      body: { status: "failed", error: "Nope; nothing was saved" },
    });
    // A refused duplicate reaches the client whole, as serialized JSON.
    const match = { modelId, modelName: "Clip", fileId, fileName: "Clip.stl" };
    queue.results.set(id, {
      status: "failed",
      error: "Already there; nothing was saved",
      code: "duplicate",
      duplicates: [match],
    });
    expect(await resultOf(id)).toEqual({
      status: 200,
      body: {
        status: "failed",
        error: "Already there; nothing was saved",
        code: "duplicate",
        duplicates: [match],
      },
    });
  });

  test("the /api/v1 result keeps a failure's code only for a duplicate, as its OpenAPI document says", async () => {
    const body = randomBinaryStl(5);
    const id = idOf((await create(body.length, { filename: "a.stl" })).headers.location);
    await patch(id, 0, body);
    queue.results.set(id, {
      status: "failed",
      error: "This file is not a supported file; nothing was saved",
      code: "unsupported_type",
    });
    expect(await resultOf(id)).toEqual({
      status: 200,
      body: { status: "failed", error: "This file is not a supported file; nothing was saved" },
    });
  });

  test("the /api/v1 result sends code duplicate only with the duplicates it matched (PR 287 review)", async () => {
    // An older or malformed job: an IngestError with code duplicate and no
    // list. The OpenAPI document promises the matches with that code, so the
    // public answer is a plain failure.
    const body = randomBinaryStl(5);
    const id = idOf((await create(body.length, { filename: "a.stl" })).headers.location);
    await patch(id, 0, body);
    const error = "Already there; nothing was saved";
    queue.results.set(id, { status: "failed", error, code: "duplicate" });
    expect(await resultOf(id)).toEqual({ status: 200, body: { status: "failed", error } });
    queue.results.set(id, { status: "failed", error, code: "duplicate", duplicates: [] });
    expect(await resultOf(id)).toEqual({ status: 200, body: { status: "failed", error } });
  });

  test("the /app result carries a failure's ingest code, for the page to say in its language", async () => {
    const both = await startApp(async (app) => {
      await registerTus(app, {
        prefix: "/app/uploads",
        authHook: keyHook,
        uploads,
        resultCodes: "all",
      });
      await registerTus(app, { prefix: PREFIX, authHook: keyHook, uploads });
    });
    try {
      const body = randomBinaryStl(5);
      const id = idOf((await create(body.length, { filename: "a.stl" })).headers.location);
      await patch(id, 0, body);
      const failed = {
        status: "failed" as const,
        error: "This file is not a supported file; nothing was saved",
        code: "unsupported_type",
      };
      queue.results.set(id, failed);
      const app = await send(both.base, "GET", `/app/uploads/${id}/result`, { headers: KEY });
      expect(JSON.parse(app.body)).toEqual(failed);
      const api = await send(both.base, "GET", `${PREFIX}/${id}/result`, { headers: KEY });
      expect(JSON.parse(api.body)).toEqual({ status: "failed", error: failed.error });
    } finally {
      await both.close();
    }
  });

  test("the result route answers 503 in plain words when the queue cannot be read", async () => {
    const body = randomBinaryStl(5);
    const id = idOf((await create(body.length, { filename: "a.stl" })).headers.location);
    await patch(id, 0, body);
    queue.failResult = true;
    const res = await resultOf(id);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: "unavailable",
      message: "The upload's result cannot be read right now. Try again shortly.",
    });
    expect(JSON.stringify(res.body)).not.toContain("ECONNREFUSED");
    queue.failResult = false;
    expect(await resultOf(id)).toEqual({ status: 200, body: { status: "pending" } });
  });

  // Issue #462: every byte arrived but the ingest was never queued, as when
  // the process stops between the last byte and onUploadFinish.
  /**
   * An upload whose data file holds the first `received` of its bytes,
   * written straight into the folder rather than PATCHed, so nothing queued it.
   */
  async function neverQueued(body: Buffer, received = body.length) {
    const created = await create(body.length, { filename: "Lost part.stl", duplicates: "skip" });
    expect(created.status).toBe(201);
    const id = idOf(created.headers.location);
    await writeFile(join(uploads.dir, id), body.subarray(0, received));
    return id;
  }

  const PENDING = { status: 200, body: { status: "pending" } };

  test("an upload whose bytes all arrived but was never queued is queued by its result route, once", async () => {
    const body = randomBinaryStl(10);
    const id = await neverQueued(body);
    const newLock = vi.spyOn(uploads.locker, "newLock");
    expect(queue.enqueueCalls).toEqual([]);

    expect(await resultOf(id)).toEqual(PENDING);
    expect(queue.enqueueCalls).toEqual([
      [
        id,
        {
          tmpPath: join(uploads.dir, id),
          originalName: "Lost part.stl",
          target: "new",
          duplicates: "skip",
        },
      ],
    ]);
    // Queued holding the upload's lock, as ingest's tidy-up is.
    expect(newLock).toHaveBeenCalledWith(id);

    // The job now answers; a send with the same id would add nothing anyway.
    expect(await resultOf(id)).toEqual(PENDING);
    expect(queue.enqueueCalls).toHaveLength(1);
  });

  test("an upload still one byte short is pending, is not queued and takes no lock", async () => {
    // Taking the lock would cancel a PATCH still sending (@tus/server's
    // MemoryLocker asks the holder to let go).
    const body = randomBinaryStl(10);
    const id = await neverQueued(body, body.length - 1);
    const newLock = vi.spyOn(uploads.locker, "newLock");
    expect(await resultOf(id)).toEqual(PENDING);
    expect(queue.enqueueCalls).toEqual([]);
    expect(newLock).not.toHaveBeenCalled();
  });

  test.each([
    ["no file name", {}],
    ["a type Platehouse does not take", { filename: "notes.txt" }],
    ["a duplicates value it does not know", { filename: "Lost part.stl", duplicates: "maybe" }],
  ])(
    "a complete upload never queued whose metadata no longer parses (%s) is 404 and not queued",
    async (_, metadata) => {
      const body = randomBinaryStl(10);
      const id = await neverQueued(body);
      const infoPath = join(uploads.dir, `${id}.json`);
      const info = JSON.parse(await readFile(infoPath, "utf8"));
      await writeFile(infoPath, JSON.stringify({ ...info, metadata }));
      expect(await resultOf(id)).toEqual({ status: 404, body: { error: "not_found" } });
      expect(queue.enqueueCalls).toEqual([]);
    },
  );

  test("a complete upload whose ingest already ran is never queued again by its result route", async () => {
    // Ingest wrote its outcome but could not delete the data file, so the
    // bytes are all there; the job itself has since been removed.
    const body = randomBinaryStl(10);
    const id = await neverQueued(body);
    const infoPath = join(uploads.dir, `${id}.json`);
    const info = JSON.parse(await readFile(infoPath, "utf8"));
    await writeFile(infoPath, JSON.stringify({ ...info, ingest: "stored" }));
    expect(await resultOf(id)).toEqual(PENDING);
    expect(queue.enqueueCalls).toEqual([]);
  });

  test("a complete upload never queued that cannot be queued now answers 503 and is queued by a later call", async () => {
    const body = randomBinaryStl(10);
    const id = await neverQueued(body);
    queue.failEnqueue = true;
    const res = await resultOf(id);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: "unavailable",
      message: "The upload's result cannot be read right now. Try again shortly.",
    });
    expect(JSON.stringify(res.body)).not.toContain("ECONNREFUSED");
    // Nothing is removed, so the next call can queue it.
    expect(await tempFiles()).toEqual([id, `${id}.json`].sort());
    queue.failEnqueue = false;
    expect(await resultOf(id)).toEqual(PENDING);
    expect(queue.enqueueCalls.map(([queued]) => queued)).toEqual([id]);
  });

  /** A finished upload that ingest has taken: its data file is gone. */
  async function ingested(body: Buffer) {
    const id = idOf((await create(body.length, { filename: "Phone part.stl" })).headers.location);
    expect((await patch(id, 0, body)).status).toBe(204);
    const input = queue.enqueued.get(id) as IngestInput;
    await uploads.ingestUpload(async () => ({ modelId: "m", fileId: "f" }))(input);
    queue.results.set(id, {
      status: "done",
      modelId: randomUUID(),
      fileId: randomUUID(),
      duplicates: [],
    });
    return id;
  }

  test("HEAD on an upload already ingested reports it finished", async () => {
    const body = randomBinaryStl(30);
    const id = await ingested(body);
    expect(await tempFiles()).toEqual([`${id}.json`]);
    const res = await head(id);
    expect(res.status).toBe(200);
    expect(res.headers["tus-resumable"]).toBe("1.0.0");
    expect(res.headers["upload-offset"]).toBe(String(body.length));
    expect(res.headers["upload-length"]).toBe(String(body.length));
    expect(res.headers["cache-control"]).toBe("no-store");
    for (const name of Object.keys(res.headers)) expect(name).not.toMatch(/^access-control-/);
    expect((await head(id, {})).status).toBe(401);
  });

  test("a client that lost the last 204 and resumes after ingest sends nothing again", async () => {
    // tus-js-client retries a failed PATCH with a HEAD; on a 4xx it drops the
    // upload and creates a new one, which would make a second model.
    const body = randomBinaryStl(30);
    const id = await ingested(body);
    const before = server.requests.length;
    await new Promise<void>((resolve, reject) => {
      const upload = new Upload(body, {
        endpoint: `${server.base}${PREFIX}`,
        uploadUrl: `${server.base}${PREFIX}/${id}`,
        retryDelays: null,
        storeFingerprintForResuming: false,
        headers: KEY,
        metadata: { filename: "Phone part.stl" },
        onSuccess: () => resolve(),
        onError: (error) => reject(error),
      });
      upload.start();
    });
    const after = server.requests.slice(before).map((r) => r.method);
    expect(after).toEqual(["HEAD"]);
    expect(queue.enqueued.size).toBe(1);
  });

  test("HEAD on an upload whose data is gone and that was never queued is not finished", async () => {
    const body = randomBinaryStl(5);
    const id = idOf((await create(body.length, { filename: "a.stl" })).headers.location);
    await rm(join(uploads.dir, id));
    const res = await head(id);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("HEAD after an ingest that failed with nothing saved answers 410", async () => {
    // An IngestError means no row was written, so sending the file again is
    // safe. tus-js-client meets a 4xx on HEAD by creating a new upload.
    const body = randomBinaryStl(30);
    const id = idOf((await create(body.length, { filename: "Phone part.stl" })).headers.location);
    expect((await patch(id, 0, body)).status).toBe(204);
    const refused = new IngestError("storage_unavailable", "Storage is unavailable right now");
    await expect(
      uploads.ingestUpload(async () => {
        throw refused;
      })(queue.enqueued.get(id) as IngestInput),
    ).rejects.toBe(refused);
    queue.results.set(id, { status: "failed", error: refused.message });

    const res = await head(id);
    expect(res.status).toBe(410);
    expect(res.headers["tus-resumable"]).toBe("1.0.0");
    for (const name of Object.keys(res.headers)) expect(name).not.toMatch(/^access-control-/);
    expect((await head(id, {})).status).toBe(401);
    expect(await resultOf(id)).toEqual({
      status: 200,
      body: { status: "failed", error: refused.message },
    });
    expect(await tempFiles()).toEqual([`${id}.json`]);
  });

  test.each([
    [
      "IngestOutcomeUnknown",
      new IngestOutcomeUnknown(new Error("Connection terminated unexpectedly")),
    ],
    ["any error that is not ingest's own", new Error("Connection terminated unexpectedly")],
  ])("HEAD after an ingest that failed with %s still answers finished", async (_label, lost) => {
    // When the database cannot say whether the commit landed, ingest keeps
    // what it stored and throws IngestOutcomeUnknown: the model may be in the
    // library, and a resend could make a second one. An error ingest never
    // throws is taken the same way, on the side that makes no duplicate.
    const body = randomBinaryStl(30);
    const id = idOf((await create(body.length, { filename: "Phone part.stl" })).headers.location);
    expect((await patch(id, 0, body)).status).toBe(204);
    await expect(
      uploads.ingestUpload(async () => {
        throw lost;
      })(queue.enqueued.get(id) as IngestInput),
    ).rejects.toBe(lost);
    queue.results.set(id, { status: "failed", error: "could not be confirmed" });

    const res = await head(id);
    expect(res.status).toBe(200);
    expect(res.headers["upload-offset"]).toBe(String(body.length));
    expect(res.headers["upload-length"]).toBe(String(body.length));
  });

  test("HEAD that meets ingest tidying the upload answers finished, never 410", async () => {
    // A lost-204 retry arrives at a time unrelated to the ingest. Here the
    // ingest finishes while tus is part way through answering the HEAD:
    // after it read the info file and before it looked at the data file. A
    // 410 would make tus-js-client send the whole file again and make a
    // second model.
    const body = randomBinaryStl(30);
    const id = idOf((await create(body.length, { filename: "Phone part.stl" })).headers.location);
    expect((await patch(id, 0, body)).status).toBe(204);

    const configstore = uploads.datastore.configstore;
    const get = configstore.get.bind(configstore);
    let reached = () => {};
    let release = () => {};
    const atInfoRead = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let armed = true;
    configstore.get = async (key) => {
      if (armed && key === id) {
        armed = false;
        reached();
        await gate;
      }
      return get(key);
    };

    const answer = head(id);
    await atInfoRead;
    const ingest = uploads.ingestUpload(async () => ({ modelId: "m", fileId: "f" }))(
      queue.enqueued.get(id) as IngestInput,
    );
    // Let the ingest finish its tidy-up now if anything lets it.
    await Promise.race([ingest, sleep(200)]);
    release();
    const res = await answer;
    await ingest;
    queue.results.set(id, {
      status: "done",
      modelId: randomUUID(),
      fileId: randomUUID(),
      duplicates: [],
    });

    expect(res.status).toBe(200);
    expect(res.headers["upload-offset"]).toBe(String(body.length));
    expect(res.headers["upload-length"]).toBe(String(body.length));
    expect(await tempFiles()).toEqual([`${id}.json`]);
    expect((await head(id)).headers["upload-offset"]).toBe(String(body.length));
  });

  test("a default tus-js-client sends a file again after a failed ingest, and not after a good one", async () => {
    // tus-js-client keeps its resume fingerprint after success by default
    // (removeFingerprintOnSuccess false), and the fingerprint is the file and
    // the endpoint, not the metadata, so a second send of the same file
    // resumes the first upload with a HEAD. The server's answer decides what
    // happens next, whatever the client sets.
    const urls = new Map<string, { fingerprint: string; upload: PreviousUpload }>();
    let key = 0;
    const urlStorage: UrlStorage = {
      findAllUploads: async () => [...urls.values()].map((u) => u.upload),
      findUploadsByFingerprint: async (fingerprint) =>
        [...urls.entries()]
          .filter(([, u]) => u.fingerprint === fingerprint)
          .map(([urlStorageKey, u]) => ({ ...u.upload, urlStorageKey })),
      removeUpload: async (urlStorageKey) => {
        urls.delete(urlStorageKey);
      },
      addUpload: async (fingerprint, upload) => {
        key += 1;
        urls.set(String(key), { fingerprint, upload });
        return String(key);
      },
    };
    const sendOnce = async (body: Buffer) => {
      const upload = new Upload(body, {
        endpoint: `${server.base}${PREFIX}`,
        retryDelays: null,
        urlStorage,
        storeFingerprintForResuming: true,
        headers: KEY,
        metadata: { filename: "Phone part.stl" },
      });
      expect(upload.options.removeFingerprintOnSuccess).toBe(false);
      const previous = await upload.findPreviousUploads();
      if (previous[0] !== undefined) upload.resumeFromPreviousUpload(previous[0]);
      const sent = server.requests.length;
      await new Promise<void>((resolve, reject) => {
        upload.options.onSuccess = () => resolve();
        upload.options.onError = (error) => reject(error);
        upload.start();
      });
      return {
        id: idOf(upload.url ?? ""),
        methods: server.requests.slice(sent).map((r) => r.method),
      };
    };
    const ingest = (id: string, ingestFile: Parameters<Uploads["ingestUpload"]>[0]) =>
      uploads
        .ingestUpload(ingestFile)(queue.enqueued.get(id) as IngestInput)
        .catch(() => undefined);

    // A good ingest: the same file sent again is told it finished and sends
    // nothing, so no second model.
    const good = randomBinaryStl(30);
    const stored = await sendOnce(good);
    expect(stored.methods).toEqual(["POST", "PATCH"]);
    await ingest(stored.id, async () => ({ modelId: "m", fileId: "f" }));
    queue.results.set(stored.id, {
      status: "done",
      modelId: randomUUID(),
      fileId: randomUUID(),
      duplicates: [],
    });
    expect(urls.size).toBe(1);
    const repeat = await sendOnce(good);
    expect(repeat.methods).toEqual(["HEAD"]);
    expect(repeat.id).toBe(stored.id);
    expect(queue.enqueued.size).toBe(1);

    // A failed ingest that saved nothing: the same file sent again is told
    // the upload is gone, and goes as a new upload into a new ingest.
    const other = randomBinaryStl(31);
    const failed = await sendOnce(other);
    expect(failed.methods).toEqual(["POST", "PATCH"]);
    await ingest(failed.id, async () => {
      throw new IngestError("storage_unavailable", "Storage is unavailable right now");
    });
    queue.results.set(failed.id, { status: "failed", error: "Storage is unavailable right now" });
    const resend = await sendOnce(other);
    expect(resend.methods).toEqual(["HEAD", "POST", "PATCH"]);
    expect(resend.id).not.toBe(failed.id);
    expect(queue.enqueued.size).toBe(3);
    expect(queue.enqueued.get(resend.id)?.originalName).toBe("Phone part.stl");
  });

  test("there is no DELETE, GET or OPTIONS on an upload", async () => {
    const id = idOf((await create(10, { filename: "a.stl" })).headers.location);
    for (const method of ["DELETE", "GET", "OPTIONS"]) {
      const res = await send(server.base, method, `${PREFIX}/${id}`, {
        headers: { ...TUS, ...KEY },
      });
      expect(res.status, method).toBe(404);
    }
    expect(await tempFiles()).toEqual([id, `${id}.json`].sort());
  });

  test("responses carry no CORS headers and a Location that ignores Host", async () => {
    const res = await create(
      10,
      { filename: "a.stl" },
      {
        host: "evil.example",
        origin: "https://evil.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
        forwarded: 'host="evil.example";proto=https',
      },
    );
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe(`${PREFIX}/${idOf(res.headers.location)}`);
    for (const r of [res, await head(idOf(res.headers.location))]) {
      for (const name of Object.keys(r.headers)) expect(name).not.toMatch(/^access-control-/);
    }
  });

  test("the UI and API mounts share one folder", async () => {
    const both = await startApp(async (app) => {
      await registerTus(app, { prefix: "/app/uploads", authHook: keyHook, uploads });
      await registerTus(app, { prefix: PREFIX, authHook: keyHook, uploads });
    });
    try {
      const res = await send(both.base, "POST", "/app/uploads", {
        headers: {
          ...TUS,
          ...KEY,
          "upload-length": "10",
          "upload-metadata": meta({ filename: "a.stl" }),
        },
      });
      expect(res.status).toBe(201);
      expect(res.headers.location).toMatch(/^\/app\/uploads\//);
      expect(await tempFiles()).toContain(idOf(res.headers.location));
    } finally {
      await both.close();
    }
  });
});

describe("limits on unfinished uploads", () => {
  const GIB = 1073741824;
  let limited: TestApp | undefined;
  let limitedUploads: Uploads;

  /** A server with its own uploads folder and these limits; x-test-principal names the sender. */
  async function startLimited(
    opts: {
      maxTempBytes?: number;
      freeBytes?: (dir: string) => Promise<number>;
      freeFiles?: (dir: string) => Promise<number>;
      now?: () => number;
    } = {},
  ): Promise<TestApp> {
    const dir = await mkdtemp(join(root, "limited-"));
    await prepareUploads(dir);
    limitedUploads = createUploads({
      tmpDir: dir,
      queue,
      log: (line) => lines.push(line),
      freeBytes: plentyOfRoom,
      freeFiles: plentyOfRoom,
      ...opts,
    });
    limited = await startApp(async (app) => {
      await registerTus(app, {
        prefix: PREFIX,
        authHook: keyHook,
        uploads: limitedUploads,
        principalOf: (request) => {
          const who = request.headers["x-test-principal"];
          return typeof who === "string" ? who : undefined;
        },
        holderOf: (request) => {
          const who = request.headers["x-test-holder"];
          return typeof who === "string" ? who : undefined;
        },
      });
    });
    return limited;
  }

  afterEach(async () => {
    await limited?.close();
    limited = undefined;
  });

  function createOn(app: TestApp, length: number, principal?: string, holder?: string) {
    return send(app.base, "POST", PREFIX, {
      headers: {
        ...TUS,
        ...KEY,
        "upload-length": String(length),
        "upload-metadata": meta({ filename: "a.stl" }),
        ...(principal === undefined ? {} : { "x-test-principal": principal }),
        ...(holder === undefined ? {} : { "x-test-holder": holder }),
      },
    });
  }

  async function limitedFiles(): Promise<string[]> {
    return (await readdir(limitedUploads.dir)).sort();
  }

  test("a new upload that would take unfinished uploads over the total is 507 and creates no file", async () => {
    const app = await startLimited({ maxTempBytes: 1000 });
    const first = await createOn(app, 600);
    expect(first.status).toBe(201);
    const before = await limitedFiles();

    const res = await createOn(app, 500);
    expect(res.status).toBe(507);
    expect(res.body).toMatch(/nothing was saved/);
    expect(await limitedFiles()).toEqual(before);
  });

  test("an upload is refused 507 unless the disk keeps 1 GiB free beyond its length", async () => {
    const declared = 5000;
    let free = declared + GIB - 1;
    const app = await startLimited({ freeBytes: async () => free });

    const short = await createOn(app, declared);
    expect(short.status).toBe(507);
    expect(short.body).toMatch(/nothing was saved/);
    expect(await limitedFiles()).toEqual([]);

    free = declared + GIB;
    expect((await createOn(app, declared)).status).toBe(201);
  });

  test("an upload is refused 507 when fewer than 10,000 free inodes would be left on the disk", async () => {
    let files = MIN_FREE_FILES - 1;
    const app = await startLimited({ freeFiles: async () => files });
    const short = await createOn(app, 100, "token:a");
    expect(short.status).toBe(507);
    expect(short.body).toMatch(/nothing was saved/);
    expect(await limitedFiles()).toEqual([]);
    expect(lines.some((l) => /\(507\) for token:a: .*inodes/.test(l))).toBe(true);

    files = MIN_FREE_FILES;
    expect((await createOn(app, 100)).status).toBe(201);
  });

  test("no more than 10,000 uploads may be in the folder at once, finished or not", {
    timeout: 60_000,
  }, async () => {
    expect(MAX_UPLOADS_ON_DISK).toBe(10_000);
    const app = await startLimited();
    // Info files kept after ingest: they hold no bytes, but each is an upload in the folder.
    const ids = Array.from({ length: MAX_UPLOADS_ON_DISK }, () => randomUUID());
    for (let i = 0; i < ids.length; i += 500) {
      await Promise.all(
        ids.slice(i, i + 500).map((id) => writeFile(join(limitedUploads.dir, `${id}.json`), "{}")),
      );
    }
    const full = await createOn(app, 1, "token:a");
    expect(full.status).toBe(507);
    expect(full.body).toMatch(/nothing was saved/);
    expect((await limitedFiles()).length).toBe(MAX_UPLOADS_ON_DISK);
    expect(lines.some((l) => /\(507\) for token:a: .*10000 uploads/.test(l))).toBe(true);

    await rm(join(limitedUploads.dir, `${ids[0]}.json`));
    expect((await createOn(app, 1, "token:a")).status).toBe(201);
    expect((await createOn(app, 1, "token:a")).status).toBe(507);
  });

  test("left to itself, the store reads the free space of the uploads folder's own disk", async () => {
    const dir = await mkdtemp(join(root, "real-disk-"));
    await prepareUploads(dir);
    const real = createUploads({ tmpDir: dir, queue, log: () => {} });
    const app = await startApp(async (app) => {
      await registerTus(app, { prefix: PREFIX, authHook: keyHook, uploads: real });
    });
    try {
      // statfs answers for the folder, so a small upload fits on any test disk.
      expect((await createOn(app, 1)).status).toBe(201);
    } finally {
      await app.close();
    }
  });

  test("a sender's 21st unfinished upload is 429; another sender and an unnamed one are not held back", async () => {
    const app = await startLimited();
    for (let i = 0; i < 20; i += 1) {
      expect((await createOn(app, 100, "session:a")).status, `upload ${i + 1}`).toBe(201);
    }
    const refused = await createOn(app, 100, "session:a");
    expect(refused.status).toBe(429);
    expect(refused.body).toMatch(/20 unfinished uploads/);
    expect((await limitedFiles()).length).toBe(40);

    expect((await createOn(app, 100, "token:b")).status).toBe(201);
    for (let i = 0; i < 21; i += 1) {
      expect((await createOn(app, 100)).status, `unnamed upload ${i + 1}`).toBe(201);
    }
  });

  test("only unfinished uploads count toward an owner's 20", async () => {
    const app = await startLimited();
    const body = randomBinaryStl(1);
    const ids: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const res = await createOn(app, body.length, "session:a");
      expect(res.status).toBe(201);
      ids.push(idOf(res.headers.location));
    }
    expect((await createOn(app, body.length, "session:a")).status).toBe(429);
    // A finished upload waiting for ingest still holds its bytes, but it is not unfinished.
    const finished = await send(app.base, "PATCH", `${PREFIX}/${ids[0]}`, {
      headers: { ...TUS, ...KEY, "content-type": OCTET, "upload-offset": "0" },
      body,
    });
    expect(finished.status).toBe(204);
    expect((await createOn(app, body.length, "session:a")).status).toBe(201);
  });

  test("the sender is kept in the info file, never in the metadata HEAD answers", async () => {
    const app = await startLimited();
    const id = idOf((await createOn(app, 100, "session:a")).headers.location);
    const info = JSON.parse(await readFile(join(limitedUploads.dir, `${id}.json`), "utf8"));
    expect(info.owner).toBe("session:a");
    expect(info.metadata).toEqual({ filename: "a.stl" });
    const res = await send(app.base, "HEAD", `${PREFIX}/${id}`, { headers: { ...TUS, ...KEY } });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.headers)).not.toContain("session:a");
  });

  test("two creations at once cannot both pass the total", async () => {
    const app = await startLimited({ maxTempBytes: 1000 });
    const answers = await Promise.all([createOn(app, 600), createOn(app, 600)]);
    expect(answers.map((r) => r.status).sort()).toEqual([201, 507]);
    expect((await limitedFiles()).length).toBe(2);
  });

  /** A finished 1-byte upload written straight into the folder, as one waiting for ingest. */
  async function finishedUpload(): Promise<string> {
    const id = randomUUID();
    await writeFile(join(limitedUploads.dir, id), "x");
    await writeFile(
      join(limitedUploads.dir, `${id}.json`),
      JSON.stringify({
        id,
        size: 1,
        offset: 0,
        metadata: { filename: "a.stl" },
        creation_date: new Date().toISOString(),
      }),
    );
    return id;
  }

  test("a creation whose files land while the next creation reads the folder is still counted", async () => {
    // The order is forced: the second check has read the folder's names
    // before the first creation writes its files, and goes on only once the
    // first has been answered (and given back its reservation).
    const app = await startLimited({ maxTempBytes: 1 + 1000 });
    const waiting = await finishedUpload();
    const store = limitedUploads.datastore;
    const configstore = store.configstore;
    const get = configstore.get.bind(configstore);
    const create = store.create.bind(store);
    let secondReading!: () => void;
    const reading = new Promise<void>((resolve) => {
      secondReading = resolve;
    });
    let firstAnswered!: () => void;
    const answered = new Promise<void>((resolve) => {
      firstAnswered = resolve;
    });
    let reads = 0;
    configstore.get = async (id) => {
      if (id === waiting) {
        reads += 1;
        if (reads === 2) {
          secondReading();
          await answered;
        }
      }
      return get(id);
    };
    store.create = async (upload) => {
      await reading;
      return create(upload);
    };

    const both = [createOn(app, 600), createOn(app, 600)];
    await Promise.race(both);
    firstAnswered();
    const answers = await Promise.all(both);
    expect(answers.map((r) => r.status).sort()).toEqual([201, 507]);
  });

  test("two creations at once never both pass the total when the folder already holds uploads", async () => {
    const app = await startLimited({ maxTempBytes: 100 + 1000 });
    for (let i = 0; i < 100; i += 1) await finishedUpload();
    for (let round = 0; round < 20; round += 1) {
      const answers = await Promise.all([createOn(app, 600), createOn(app, 600)]);
      expect(answers.map((r) => r.status).sort(), `round ${round + 1}`).toEqual([201, 507]);
      const made = answers.find((r) => r.status === 201);
      const id = idOf(made?.headers.location);
      await rm(join(limitedUploads.dir, id), { force: true });
      await rm(join(limitedUploads.dir, `${id}.json`), { force: true });
    }
  });

  test("a burst of creations takes exactly the room the total leaves", async () => {
    const app = await startLimited({ maxTempBytes: 100 + 1000 });
    for (let i = 0; i < 100; i += 1) await finishedUpload();
    const answers = await Promise.all(Array.from({ length: 40 }, () => createOn(app, 100)));
    expect(answers.filter((r) => r.status === 201)).toHaveLength(10);
    expect(answers.filter((r) => r.status === 507)).toHaveLength(30);
  });

  test("a burst of creations from one owner stops at its 20", async () => {
    const app = await startLimited();
    for (let i = 0; i < 100; i += 1) await finishedUpload();
    const answers = await Promise.all(
      Array.from({ length: 60 }, () => createOn(app, 1, "token:a")),
    );
    expect(answers.filter((r) => r.status === 201)).toHaveLength(20);
    expect(answers.filter((r) => r.status === 429)).toHaveLength(40);
  });

  test("an upload sending its bytes in the creation request counts once while they arrive", async () => {
    const app = await startLimited({ maxTempBytes: 1000 });
    // creation-with-upload: 100 of the 500 bytes sent, the rest held back.
    const held = httpRequest(new URL(PREFIX, app.base), {
      method: "POST",
      headers: {
        ...TUS,
        ...KEY,
        "upload-length": "500",
        "upload-metadata": meta({ filename: "a.stl" }),
        "content-type": OCTET,
        "content-length": "500",
        "x-test-principal": "token:a",
      },
    });
    const heldAnswer = new Promise<number>((resolve, reject) => {
      held.on("response", (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      held.on("error", reject);
    });
    try {
      held.write(Buffer.alloc(100));
      const deadline = Date.now() + 5000;
      for (;;) {
        const sizes = await Promise.all(
          (await limitedFiles())
            .filter((name) => !name.endsWith(".json"))
            .map(async (name) => (await stat(join(limitedUploads.dir, name))).size),
        );
        if (sizes.some((size) => size >= 100)) break;
        if (Date.now() > deadline) throw new Error("the first 100 bytes never landed");
        await sleep(10);
      }

      expect((await createOn(app, 500, "token:a")).status).toBe(201);

      held.end(Buffer.alloc(400));
      expect(await heldAnswer).toBe(201);
    } finally {
      // A failed check must not leave the request open for the server's close.
      if (!held.writableEnded) {
        heldAnswer.catch(() => {});
        held.destroy();
      }
    }
  });

  test("each refusal is logged with the sender it was for", async () => {
    const app = await startLimited({ maxTempBytes: 1000 });
    for (let i = 0; i < 20; i += 1) await createOn(app, 1, "session:a");
    expect((await createOn(app, 1, "session:a")).status).toBe(429);
    expect((await createOn(app, 1000, "token:b")).status).toBe(507);
    expect((await createOn(app, 1000)).status).toBe(507);
    expect(lines).toEqual([
      expect.stringMatching(/^uploads: refused a new upload \(429\) for session:a: /),
      expect.stringMatching(/^uploads: refused a new upload \(507\) for token:b: /),
      expect.stringMatching(/^uploads: refused a new upload \(507\) for no owner: /),
    ]);
  });

  test("the user behind an upload is kept in its info file beside its sender", async () => {
    const app = await startLimited();
    const id = idOf((await createOn(app, 100, "session:a", 'user "alice"')).headers.location);
    const info = JSON.parse(await readFile(join(limitedUploads.dir, `${id}.json`), "utf8"));
    expect(info).toMatchObject({ owner: "session:a", holder: 'user "alice"' });
    expect(info.metadata).toEqual({ filename: "a.stl" });
  });

  test("a 507 for the total names the three users holding the most room, and never a secret", async () => {
    const app = await startLimited({ maxTempBytes: 1000 });
    const made: Array<[number, string, string]> = [
      [200, "session:a1", 'user "alice"'],
      [200, "session:a2", 'user "alice"'],
      [300, "token:t1", 'token t1 made by user "bob"'],
      [250, "session:c", 'user "carol"'],
      [50, "session:d", 'user "dave"'],
    ];
    for (const [size, owner, holder] of made) {
      expect((await createOn(app, size, owner, holder)).status).toBe(201);
    }
    lines.length = 0;
    expect((await createOn(app, 100, "token:z", 'user "zed"')).status).toBe(507);
    expect(lines).toHaveLength(1);
    const line = lines[0] ?? "";
    expect(line).toMatch(/^uploads: refused a new upload \(507\) for token:z: /);
    expect(line).toContain(
      'held most by user "alice" (2 uploads, 400 bytes), token t1 made by user "bob" ' +
        '(1 upload, 300 bytes), user "carol" (1 upload, 250 bytes)',
    );
    expect(line).not.toContain("dave");
    expect(line).not.toContain(KEY["x-test-key"]);
  });

  test("refusals for one sender are logged at most once a minute, with a count of the rest", async () => {
    let clock = 1_000_000;
    const app = await startLimited({ maxTempBytes: 1000, now: () => clock });
    expect((await createOn(app, 1000, "session:a", 'user "alice"')).status).toBe(201);
    lines.length = 0;
    for (let i = 0; i < 3; i += 1) expect((await createOn(app, 1, "token:b")).status).toBe(507);
    // Another sender is logged on its own.
    expect((await createOn(app, 1, "token:c")).status).toBe(507);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/\(507\) for token:b: /);
    expect(lines[1]).toMatch(/\(507\) for token:c: /);

    clock += 59_000;
    expect((await createOn(app, 1, "token:b")).status).toBe(507);
    expect(lines).toHaveLength(2);
    clock += 2_000;
    expect((await createOn(app, 1, "token:b")).status).toBe(507);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatch(/\(507\) for token:b: .*3 more refusals for it were not logged/);
  });

  /** Info files written straight into the folder, as uploads kept after their ingest. */
  async function keptUploads(count: number, fields: Record<string, unknown>): Promise<string[]> {
    const ids = Array.from({ length: count }, () => randomUUID());
    for (let i = 0; i < ids.length; i += 500) {
      await Promise.all(
        ids
          .slice(i, i + 500)
          .map((id) =>
            writeFile(
              join(limitedUploads.dir, `${id}.json`),
              JSON.stringify({ id, size: 1, offset: 1, ingest: "stored", ...fields }),
            ),
          ),
      );
    }
    return ids;
  }

  test("a sender with 2,000 uploads on the server, finished ones included, gets 429; another sender does not", {
    timeout: 60_000,
  }, async () => {
    expect(MAX_UPLOADS_PER_PRINCIPAL).toBe(2000);
    const app = await startLimited();
    // 100 finished and waiting for ingest (data and info), 1,900 ingested (info only).
    for (let i = 0; i < 100; i += 1) {
      const id = randomUUID();
      await writeFile(join(limitedUploads.dir, id), "x");
      await writeFile(
        join(limitedUploads.dir, `${id}.json`),
        JSON.stringify({ id, size: 1, offset: 0, owner: "token:a", metadata: {} }),
      );
    }
    const kept = await keptUploads(1900, { owner: "token:a" });
    const refused = await createOn(app, 1, "token:a");
    expect(refused.status).toBe(429);
    expect(refused.body).toBe(`${TOO_MANY_HELD_MESSAGE}\n`);
    // The web app tells this 429 from the 20 unfinished one by these words.
    expect(TOO_MANY_HELD_MESSAGE).toContain("uploads on the server");
    expect(TOO_MANY_UNFINISHED_MESSAGE).not.toContain("uploads on the server");
    expect(lines.some((l) => /\(429\) for token:a: .*2000 uploads/.test(l))).toBe(true);
    expect((await createOn(app, 1, "token:b")).status).toBe(201);

    await rm(join(limitedUploads.dir, `${kept[0]}.json`));
    expect((await createOn(app, 1, "token:a")).status).toBe(201);
    expect((await createOn(app, 1, "token:a")).status).toBe(429);
  });

  test("a 507 for the 10,000 uploads names the three users holding the most uploads, kept ones included", {
    timeout: 60_000,
  }, async () => {
    const app = await startLimited();
    await keptUploads(6000, { holder: 'user "ann"' });
    await keptUploads(3000, { holder: 'user "ben"' });
    await keptUploads(900, { holder: 'user "cy"' });
    await keptUploads(99, { holder: 'user "dee"' });
    // One upload with bytes: the most bytes, but the fewest uploads.
    expect((await createOn(app, 5000, "session:e", 'user "eve"')).status).toBe(201);
    lines.length = 0;
    expect((await createOn(app, 1, "token:z")).status).toBe(507);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^uploads: refused a new upload \(507\) for token:z: .*10000 uploads/);
    expect(lines[0]).toContain(
      'held most by user "ann" (6000 uploads, 0 bytes), user "ben" (3000 uploads, 0 bytes), ' +
        'user "cy" (900 uploads, 0 bytes)',
    );
    expect(lines[0]).not.toContain("eve");
  });

  test("a 507 for the total still ranks holders by bytes, though another holds more uploads", async () => {
    const app = await startLimited({ maxTempBytes: 1000 });
    await keptUploads(50, { holder: 'user "many"' });
    expect((await createOn(app, 900, "session:big", 'user "big"')).status).toBe(201);
    lines.length = 0;
    expect((await createOn(app, 200, "token:z")).status).toBe(507);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('held most by user "big" (1 upload, 900 bytes), user "many" (50');
  });

  test("a sender's 429 line does not hide its 507 line in the same minute", async () => {
    const clock = 1_000_000;
    const app = await startLimited({ maxTempBytes: 20, now: () => clock });
    const ids: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const res = await createOn(app, 1, "token:a", 'user "al"');
      expect(res.status).toBe(201);
      ids.push(idOf(res.headers.location));
    }
    lines.length = 0;
    expect((await createOn(app, 1, "token:a", 'user "al"')).status).toBe(429);
    // One finishes, so the next is under the 20 but over the total.
    const done = await send(app.base, "PATCH", `${PREFIX}/${ids[0]}`, {
      headers: { ...TUS, ...KEY, "content-type": OCTET, "upload-offset": "0" },
      body: Buffer.from("x"),
    });
    expect(done.status).toBe(204);
    expect((await createOn(app, 1, "token:a", 'user "al"')).status).toBe(507);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/\(429\) for token:a: /);
    expect(lines[1]).toMatch(
      /\(507\) for token:a: .*held most by user "al" \(20 uploads, 20 bytes\)/,
    );
  });

  test("a creation that fails after passing the limits gives its share of the total back", async () => {
    const app = await startLimited({ maxTempBytes: 1000 });
    const store = limitedUploads.datastore;
    const create = store.create.bind(store);
    store.create = async () => {
      throw new Error("EIO: the disk failed");
    };
    expect((await createOn(app, 1000)).status).toBe(500);
    store.create = create;
    expect((await createOn(app, 1000)).status).toBe(201);
  });
});

describe("ingestUpload", () => {
  async function partial(name: string) {
    await writeFile(join(uploads.dir, name), "bytes");
    await writeFile(join(uploads.dir, `${name}.json`), "{}");
  }

  test("deletes the temp file after a successful ingest and keeps its info file for the sweep", async () => {
    const id = idOf((await create(10, { filename: "a.stl" })).headers.location);
    const input: IngestInput = {
      tmpPath: join(uploads.dir, id),
      originalName: "a.stl",
      target: "new",
    };
    const ingest = uploads.ingestUpload(async () => ({ modelId: "m", fileId: "f" }));
    expect(await ingest(input)).toEqual({ modelId: "m", fileId: "f" });
    expect(await tempFiles()).toEqual([`${id}.json`]);
  });

  test("deletes the temp file after a failed ingest and passes the error on", async () => {
    const id = randomUUID();
    await partial(id);
    const refused = new IngestError("unsupported_type", "Not supported; nothing was saved");
    const ingest = uploads.ingestUpload(async () => {
      throw refused;
    });
    await expect(
      ingest({ tmpPath: join(uploads.dir, id), originalName: "a.stl", target: "new" }),
    ).rejects.toBe(refused);
    expect(await tempFiles()).toEqual([`${id}.json`]);
  });

  test("tidies an upload only while it holds the upload's lock", async () => {
    // tus's HEAD and PATCH take the same lock, so neither can see the upload
    // half tidied.
    const id = idOf((await create(10, { filename: "a.stl" })).headers.location);
    const held = uploads.locker.newLock(id);
    await held.lock(new AbortController().signal, async () => {});
    const ingest = uploads.ingestUpload(async () => ({ modelId: "m", fileId: "f" }))({
      tmpPath: join(uploads.dir, id),
      originalName: "a.stl",
      target: "new",
    });
    await Promise.race([ingest, sleep(200)]);
    expect(await tempFiles()).toEqual([id, `${id}.json`].sort());
    await held.unlock();
    expect(await ingest).toEqual({ modelId: "m", fileId: "f" });
    expect(await tempFiles()).toEqual([`${id}.json`]);
  });

  test("never deletes a file outside TMP_DIR/uploads", async () => {
    const outside = join(tmpDir, "inbox-file.stl");
    await writeFile(outside, "inbox bytes");
    const ingest = uploads.ingestUpload(async () => ({ modelId: "m", fileId: "f" }));
    await ingest({ tmpPath: outside, originalName: "inbox-file.stl", target: "new" });
    expect((await readFile(outside, "utf8")).toString()).toBe("inbox bytes");
  });
});

describe("sweepStaleUploads", () => {
  const later = (ms: number) => new Date(Date.now() + ms);
  const PAST_A_DAY = STALE_UPLOAD_MS + 60_000;

  async function partialUpload() {
    const body = randomBinaryStl(50);
    const id = idOf((await create(body.length, { filename: "a.stl" })).headers.location);
    await patch(id, 0, body.subarray(0, 500));
    return id;
  }

  test("keeps an upload touched within the last 24 hours", async () => {
    const id = await partialUpload();
    const r = await uploads.sweepStaleUploads(later(STALE_UPLOAD_MS - 60_000));
    expect(r).toMatchObject({ deleted: 0, kept: 1 });
    expect(await tempFiles()).toEqual([id, `${id}.json`].sort());
  });

  test("deletes a partial upload untouched for 24 hours, and logs one line", async () => {
    await partialUpload();
    const r = await uploads.sweepStaleUploads(later(PAST_A_DAY));
    expect(r).toMatchObject({ listed: 1, deleted: 1, kept: 0 });
    expect(await tempFiles()).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/deleted 1 untouched for 24 hours, 0 that received nothing/);
  });

  test("keeps a finished upload whose ingest is still queued, however old", async () => {
    const body = randomBinaryStl(5);
    const id = idOf((await create(body.length, { filename: "a.stl" })).headers.location);
    await patch(id, 0, body);
    expect(await queue.result(id)).toEqual({ status: "pending" });
    const r = await uploads.sweepStaleUploads(later(PAST_A_DAY));
    expect(r).toMatchObject({ deleted: 0, kept: 1 });
    expect(await tempFiles()).toContain(id);
  });

  test("deletes an old upload whose ingest finished but left its file behind", async () => {
    const body = randomBinaryStl(5);
    const id = idOf((await create(body.length, { filename: "a.stl" })).headers.location);
    await patch(id, 0, body);
    queue.results.set(id, { status: "failed", error: "x" });
    expect((await uploads.sweepStaleUploads(later(PAST_A_DAY))).deleted).toBe(1);
    expect(await tempFiles()).toEqual([]);
  });

  test("keeps an ingested upload's info file for a day after its ingest, however old the upload", async () => {
    const body = randomBinaryStl(5);
    const id = idOf((await create(body.length, { filename: "a.stl" })).headers.location);
    await patch(id, 0, body);
    // An upload that took two days to finish.
    const old = new Date(Date.now() - 2 * STALE_UPLOAD_MS);
    await utimes(join(uploads.dir, `${id}.json`), old, old);
    await utimes(join(uploads.dir, id), old, old);
    await uploads.ingestUpload(async () => ({ modelId: "m", fileId: "f" }))(
      queue.enqueued.get(id) as IngestInput,
    );
    queue.results.set(id, {
      status: "done",
      modelId: randomUUID(),
      fileId: randomUUID(),
      duplicates: [],
    });

    expect(await uploads.sweepStaleUploads(later(STALE_UPLOAD_MS - 60_000))).toMatchObject({
      deleted: 0,
      kept: 1,
    });
    expect(await tempFiles()).toEqual([`${id}.json`]);
    expect((await uploads.sweepStaleUploads(later(PAST_A_DAY))).deleted).toBe(1);
    expect(await tempFiles()).toEqual([]);
  });

  test("deletes a lone data file or a lone info file left for a day", async () => {
    await uploads.sweepStaleUploads(later(0));
    const a = randomUUID();
    const b = randomUUID();
    await writeFile(join(uploads.dir, a), "data only");
    await writeFile(join(uploads.dir, `${b}.json`), "{}");
    const r = await uploads.sweepStaleUploads(later(PAST_A_DAY));
    expect(r.deleted).toBe(2);
    expect(await tempFiles()).toEqual([]);
  });

  test("leaves files that are not uploads alone", async () => {
    await uploads.sweepStaleUploads(later(0));
    await writeFile(join(uploads.dir, "notes.txt"), "not ours");
    const r = await uploads.sweepStaleUploads(later(PAST_A_DAY));
    expect(r).toMatchObject({ deleted: 0, skipped: 1 });
    expect(await tempFiles()).toEqual(["notes.txt"]);
  });

  test("an uploads folder that does not exist yet is an empty sweep", async () => {
    const fresh = createUploads({ tmpDir: join(root, "never-made"), queue, log: () => {} });
    expect(await fresh.sweepStaleUploads(later(PAST_A_DAY))).toEqual({
      listed: 0,
      deleted: 0,
      deletedEmpty: 0,
      deletedExpired: 0,
      kept: 0,
      skipped: 0,
    });
  });

  const MINUTE = 60_000;

  test("deletes an upload that received no byte for an hour, and says which rule did", async () => {
    const id = idOf((await create(1000, { filename: "a.stl" })).headers.location);
    expect((await stat(join(uploads.dir, id))).size).toBe(0);
    const r = await uploads.sweepStaleUploads(later(61 * MINUTE));
    expect(r).toMatchObject({ listed: 1, deleted: 1, deletedEmpty: 1, kept: 0 });
    expect(await tempFiles()).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /deleted 0 untouched for 24 hours, 1 that received nothing for an hour/,
    );
  });

  test("keeps an upload that received no byte when it was touched within the hour", async () => {
    const id = idOf((await create(1000, { filename: "a.stl" })).headers.location);
    const r = await uploads.sweepStaleUploads(later(59 * MINUTE));
    expect(r).toMatchObject({ deleted: 0, kept: 1 });
    expect(await tempFiles()).toEqual([id, `${id}.json`].sort());
  });

  /** Makes an upload look created `age` ago and last written `touched` ago. */
  async function backdate(id: string, age: number, touched: number) {
    const infoPath = join(uploads.dir, `${id}.json`);
    const info = JSON.parse(await readFile(infoPath, "utf8"));
    await writeFile(
      infoPath,
      JSON.stringify({ ...info, creation_date: new Date(Date.now() - age).toISOString() }),
    );
    const at = new Date(Date.now() - touched);
    await utimes(infoPath, at, at);
    await utimes(join(uploads.dir, id), at, at);
  }

  test("deletes an unfinished upload 24 hours after it was created, whatever it last received", async () => {
    const id = await partialUpload();
    await backdate(id, 25 * 60 * MINUTE, 60 * MINUTE);
    const r = await uploads.sweepStaleUploads(new Date());
    expect(r).toMatchObject({ listed: 1, deleted: 1, deletedExpired: 1, kept: 0 });
    expect(await tempFiles()).toEqual([]);
    expect(lines[0]).toMatch(/and 1 unfinished 24 hours after it was created/);
  });

  test("keeps an unfinished upload created 23 hours ago that received a byte an hour ago", async () => {
    const id = await partialUpload();
    await backdate(id, 23 * 60 * MINUTE, 60 * MINUTE);
    const r = await uploads.sweepStaleUploads(new Date());
    expect(r).toMatchObject({ deleted: 0, kept: 1 });
    expect(await tempFiles()).toEqual([id, `${id}.json`].sort());
  });

  test("a finished upload waiting for ingest is not deleted for its age", async () => {
    const body = randomBinaryStl(5);
    const id = idOf((await create(body.length, { filename: "a.stl" })).headers.location);
    await patch(id, 0, body);
    await backdate(id, 25 * 60 * MINUTE, 60 * MINUTE);
    expect(await uploads.sweepStaleUploads(new Date())).toMatchObject({ deleted: 0, kept: 1 });
  });

  test("keeps an upload that has received some bytes when it was untouched for an hour", async () => {
    const id = await partialUpload();
    const r = await uploads.sweepStaleUploads(later(61 * MINUTE));
    expect(r).toMatchObject({ deleted: 0, deletedEmpty: 0, kept: 1 });
    expect(await tempFiles()).toEqual([id, `${id}.json`].sort());
  });

  test("deletes an upload by any rule only while it holds the upload's lock", async () => {
    const empty = idOf((await create(1000, { filename: "a.stl" })).headers.location);
    const idle = await partialUpload();
    const held = [uploads.locker.newLock(empty), uploads.locker.newLock(idle)];
    for (const lock of held) await lock.lock(new AbortController().signal, async () => {});
    const sweep = uploads.sweepStaleUploads(later(PAST_A_DAY));
    await Promise.race([sweep, sleep(200)]);
    expect(await tempFiles()).toEqual([empty, `${empty}.json`, idle, `${idle}.json`].sort());
    for (const lock of held) await lock.unlock();
    expect(await sweep).toMatchObject({ deleted: 2, deletedEmpty: 1, kept: 0 });
    expect(await tempFiles()).toEqual([]);
  });

  // A PATCH holds the upload's lock while it writes. The sweep asks for that
  // lock before it deletes, which stops the PATCH, so no byte is written to
  // a file the sweep has already deleted, where no limit would count it.
  test("an upload still being written past its age limit is stopped, then deleted, and nothing more is written", {
    timeout: 20_000,
  }, async () => {
    const body = randomBinaryStl(50_000);
    const id = idOf((await create(body.length, { filename: "a.stl" })).headers.location);
    const held = httpRequest(new URL(`${PREFIX}/${id}`, server.base), {
      method: "PATCH",
      headers: {
        ...TUS,
        ...KEY,
        "content-type": OCTET,
        "upload-offset": "0",
        "content-length": String(body.length),
      },
    });
    const ended = new Promise<void>((resolve) => {
      held.on("response", (res) => {
        res.resume();
        res.on("end", () => resolve());
        res.on("error", () => resolve());
      });
      held.on("error", () => resolve());
      held.on("close", () => resolve());
    });
    // A second name for the data file: it shows what is written to the file
    // after the sweep has removed it from the folder.
    const second = join(root, `second-name-${id}`);
    try {
      held.write(body.subarray(0, 1000));
      const deadline = Date.now() + 5000;
      while ((await stat(join(uploads.dir, id))).size < 1000) {
        if (Date.now() > deadline) throw new Error("the first bytes never landed");
        await sleep(10);
      }
      await link(join(uploads.dir, id), second);
      await backdate(id, 25 * 60 * MINUTE, 0);

      const r = await uploads.sweepStaleUploads(new Date());
      expect(r).toMatchObject({ listed: 1, deleted: 1, deletedExpired: 1, kept: 0 });
      expect(await tempFiles()).toEqual([]);
      const atDelete = (await stat(second)).size;

      // The client goes on sending; none of it may reach the deleted file.
      held.write(body.subarray(1000, 20_000));
      await Promise.race([ended, sleep(8000)]);
      expect((await stat(second)).size).toBe(atDelete);
      expect(await tempFiles()).toEqual([]);
      // The PATCH was answered or closed, so it holds nothing open.
      const state = await Promise.race([ended.then(() => "ended"), sleep(100).then(() => "open")]);
      expect(state).toBe("ended");
    } finally {
      held.destroy();
      await rm(second, { force: true });
    }
  });
});

describe("prepareUploads", () => {
  test("makes the uploads folder under a fresh temp folder", async () => {
    const fresh = await mkdtemp(join(root, "prepare-"));
    await prepareUploads(fresh);
    expect((await stat(uploadsDir(fresh))).isDirectory()).toBe(true);
  });

  test("an existing uploads folder is fine", async () => {
    const fresh = await mkdtemp(join(root, "prepare-"));
    await prepareUploads(fresh);
    await prepareUploads(fresh);
    expect((await stat(uploadsDir(fresh))).isDirectory()).toBe(true);
  });

  test("a temp folder that cannot hold it rejects with ENOTDIR", async () => {
    const file = join(await mkdtemp(join(root, "prepare-")), "a-file");
    await writeFile(file, "not a folder");
    await expect(prepareUploads(join(file, "tmp"))).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});

describe("bossUploadQueue", () => {
  function fakeBoss(job: unknown) {
    const sent: unknown[] = [];
    const boss = {
      send: async (...args: unknown[]) => {
        sent.push(args);
        return "id";
      },
      getJobById: async (name: string, id: string) => {
        sent.push(["get", name, id]);
        return job;
      },
    } as unknown as PgBoss;
    return { boss, sent };
  }

  test("enqueue sends an ingest job whose id is the upload id", async () => {
    const { boss, sent } = fakeBoss(null);
    const id = randomUUID();
    const input: IngestInput = {
      tmpPath: "/data/tmp/uploads/x",
      originalName: "a.stl",
      target: "new",
    };
    await bossUploadQueue(boss).enqueue(id, input);
    expect(sent).toEqual([[QUEUE.ingest, input, { id }]]);
  });

  test("a job that does not exist is no result", async () => {
    expect(await bossUploadQueue(fakeBoss(null).boss).result(randomUUID())).toBeUndefined();
  });

  test.each(["created", "retry", "active"])("a %s job is pending", async (state) => {
    expect(await bossUploadQueue(fakeBoss({ state }).boss).result(randomUUID())).toEqual({
      status: "pending",
    });
  });

  test("a completed job is done with its model and file, and no duplicates when it had none", async () => {
    // Also how a job stored before duplicates were reported reads.
    const output = { modelId: randomUUID(), fileId: randomUUID() };
    expect(
      await bossUploadQueue(fakeBoss({ state: "completed", output }).boss).result(randomUUID()),
    ).toEqual({ status: "done", ...output, duplicates: [] });
  });

  const MATCH = {
    modelId: randomUUID(),
    modelName: "Clip",
    fileId: randomUUID(),
    fileName: "Clip.stl",
  };

  test("a completed job stored anyway lists the live copies that were already there", async () => {
    const output = { modelId: randomUUID(), fileId: randomUUID(), duplicates: [MATCH] };
    expect(
      await bossUploadQueue(fakeBoss({ state: "completed", output }).boss).result(randomUUID()),
    ).toEqual({ status: "done", ...output });
  });

  test("a refused duplicate says so with code duplicate and the copies it matched", async () => {
    // As pg-boss stores a thrown DuplicateFile: its own fields beside name and message.
    const message = `This file is already in the library, in the model "Clip" (id ${MATCH.modelId}), so it was skipped; nothing was saved`;
    const output = {
      name: "IngestError",
      code: "duplicate",
      message,
      duplicates: [MATCH],
      stack: "IngestError: ...",
    };
    expect(
      await bossUploadQueue(fakeBoss({ state: "failed", output }).boss).result(randomUUID()),
    ).toEqual({ status: "failed", error: message, code: "duplicate", duplicates: [MATCH] });
  });

  test("a duplicate entry that is not a file and model is left out, never passed on", async () => {
    const output = {
      modelId: randomUUID(),
      fileId: randomUUID(),
      duplicates: [MATCH, { modelId: 4, modelName: "x" }, null, "text"],
    };
    const r = await bossUploadQueue(fakeBoss({ state: "completed", output }).boss).result(
      randomUUID(),
    );
    expect(r).toEqual({
      status: "done",
      modelId: output.modelId,
      fileId: output.fileId,
      duplicates: [MATCH],
    });
  });

  test.each(["Storage is unavailable right now; nothing was saved", INGEST_FAILED_MESSAGE])(
    "an IngestError's message is shown as written: %s",
    async (message) => {
      const output = { name: "IngestError", message };
      expect(
        await bossUploadQueue(fakeBoss({ state: "failed", output }).boss).result(randomUUID()),
      ).toEqual({ status: "failed", error: output.message });
    },
  );

  test.each([
    [
      "any other error",
      { state: "failed", output: { name: "Error", message: "connect ECONNREFUSED 10.0.0.1:5432" } },
    ],
    [
      "a commit whose outcome is not known",
      {
        state: "failed",
        output: {
          name: "IngestOutcomeUnknown",
          message: "The commit's outcome is not known: connect ECONNREFUSED 10.0.0.1:5432",
        },
      },
    ],
    ["a cancelled job", { state: "cancelled", output: null }],
    ["a completed job with no result", { state: "completed", output: null }],
  ])("%s shows a plain failure with no internal detail", async (_label, job) => {
    const r = await bossUploadQueue(fakeBoss(job).boss).result(randomUUID());
    expect(r?.status).toBe("failed");
    expect(JSON.stringify(r)).not.toMatch(/ECONNREFUSED|10\.0\.0\.1/);
    // Ingest keeps what it stored when it cannot tell whether its commit went
    // through, so a plain failure must not promise that nothing was saved.
    const error = r && "error" in r ? r.error : "";
    expect(error).toMatch(/check the library before sending it again/);
    expect(error).not.toMatch(/nothing was saved/);
  });
});
