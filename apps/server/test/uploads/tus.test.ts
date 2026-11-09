// Build plan Task 9: resumable uploads, without Docker. The tus routes run on
// a real Fastify app over loopback HTTP into a real temp folder; only the
// ingest queue is a fake, so every rule of the upload layer itself is checked
// here: metadata, the size cap, the auth hook, resume after a cut-off PATCH,
// the result route, deleting the temp file after ingest and the stale sweep.
// The integration suite (test/integration/uploads) runs the same routes with
// pg-boss, ingestFile, Postgres and the S3 test server.
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PgBoss } from "pg-boss";
import { Upload } from "tus-js-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { IngestError, type IngestInput } from "../../src/ingest/ingest.js";
import { QUEUE } from "../../src/jobs/queues.js";
import {
  bossUploadQueue,
  createUploads,
  MAX_UPLOAD_BYTES,
  parseUploadMetadata,
  registerTus,
  STALE_UPLOAD_MS,
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
  randomBinaryStl,
  send,
  startApp,
  type TestApp,
  TUS,
} from "./support/http.js";

class FakeQueue implements UploadQueue {
  readonly enqueued = new Map<string, IngestInput>();
  readonly results = new Map<string, UploadResult>();
  failEnqueue = false;

  async enqueue(id: string, input: IngestInput): Promise<void> {
    if (this.failEnqueue) throw new Error("queue is down");
    this.enqueued.set(id, input);
  }

  async result(id: string): Promise<UploadResult | undefined> {
    return this.results.get(id) ?? (this.enqueued.has(id) ? { status: "pending" } : undefined);
  }
}

const PREFIX = "/api/v1/uploads";
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
  uploads = createUploads({ tmpDir, queue, log: (line) => lines.push(line) });
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
  test("a filename alone makes a new model", () => {
    expect(parseUploadMetadata({ filename: "Benchy.3mf" })).toEqual({
      originalName: "Benchy.3mf",
      target: "new",
    });
  });

  test("modelId puts the file into that model, lowercased", () => {
    const id = randomUUID().toUpperCase();
    expect(parseUploadMetadata({ filename: "a.stl", modelId: id })).toEqual({
      originalName: "a.stl",
      target: { modelId: id.toLowerCase() },
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
    });
    expect((await readFile(join(uploads.dir, id))).equals(body)).toBe(true);
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
    queue.results.set(id, { status: "done", modelId, fileId });
    expect(await resultOf(id)).toEqual({ status: 200, body: { status: "done", modelId, fileId } });
    queue.results.set(id, { status: "failed", error: "Nope; nothing was saved" });
    expect(await resultOf(id)).toEqual({
      status: 200,
      body: { status: "failed", error: "Nope; nothing was saved" },
    });
  });

  /** A finished upload that ingest has taken: its data file is gone. */
  async function ingested(body: Buffer) {
    const id = idOf((await create(body.length, { filename: "Phone part.stl" })).headers.location);
    expect((await patch(id, 0, body)).status).toBe(204);
    const input = queue.enqueued.get(id) as IngestInput;
    await uploads.ingestUpload(async () => ({ modelId: "m", fileId: "f" }))(input);
    queue.results.set(id, { status: "done", modelId: randomUUID(), fileId: randomUUID() });
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

  test("HEAD after an ingest whose outcome is unknown still answers finished", async () => {
    // When the database cannot say whether the commit landed, ingest keeps
    // what it stored and throws the database's own error: the model may be
    // in the library, and a resend could make a second one.
    const body = randomBinaryStl(30);
    const id = idOf((await create(body.length, { filename: "Phone part.stl" })).headers.location);
    expect((await patch(id, 0, body)).status).toBe(204);
    const lost = new Error("Connection terminated unexpectedly");
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
    queue.results.set(id, { status: "done", modelId: randomUUID(), fileId: randomUUID() });

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
    queue.results.set(stored.id, { status: "done", modelId: randomUUID(), fileId: randomUUID() });
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
    expect(lines[0]).toMatch(/deleted 1/);
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
    queue.results.set(id, { status: "done", modelId: randomUUID(), fileId: randomUUID() });

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
      kept: 0,
      skipped: 0,
    });
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

  test("a completed job is done with its model and file", async () => {
    const output = { modelId: randomUUID(), fileId: randomUUID() };
    expect(
      await bossUploadQueue(fakeBoss({ state: "completed", output }).boss).result(randomUUID()),
    ).toEqual({ status: "done", ...output });
  });

  test("an IngestError's message is shown as written", async () => {
    const output = {
      name: "IngestError",
      message: "Storage is unavailable right now; nothing was saved",
    };
    expect(
      await bossUploadQueue(fakeBoss({ state: "failed", output }).boss).result(randomUUID()),
    ).toEqual({ status: "failed", error: output.message });
  });

  test.each([
    [
      "any other error",
      { state: "failed", output: { name: "Error", message: "connect ECONNREFUSED 10.0.0.1:5432" } },
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
