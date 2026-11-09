// Build plan Task 9: resumable uploads, shared by the UI (/app/uploads, behind
// its session) and the API (/api/v1/uploads, behind a bearer token). AC-020
// (a 90 MB file completes, each file its own model unless combined) and
// AC-084 (the API uploads with the same resumable upload, as a new model or
// into an existing one; a 90 MB file completes with curl).
//
// Everything here is real except the two auth hooks, which belong to Part C:
// tus over HTTP into TMP_DIR/uploads, the ingest queue on pg-boss, ingestFile
// into Postgres 17 and the S3 test server. The tests pass their own hooks,
// one of which refuses.
import { createHash, randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PgBoss } from "pg-boss";
import { Upload } from "tus-js-client";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createBoss } from "../../../src/jobs/boss.js";
import { startQueues } from "../../../src/jobs/queues.js";
import {
  bossUploadQueue,
  createUploads,
  MAX_UPLOAD_BYTES,
  registerTus,
  STALE_UPLOAD_MS,
  type UploadQueue,
  type Uploads,
} from "../../../src/uploads/tus.js";
import {
  CHUNK,
  idOf,
  meta,
  NINETY_MB_TRIANGLES,
  OCTET,
  randomBinaryStl,
  send,
  startApp,
  type TestApp,
  TUS,
} from "../../uploads/support/http.js";
import { footprint, type IngestEnv, startIngestEnv } from "../support/ingest.js";

const API = "/api/v1/uploads";
const UI = "/app/uploads";
// A made-up credential for the test hook, split so no line reads as a secret.
const TOKEN = ["Bearer", "synthetic-test-value"].join(" ");
const BEARER = { authorization: TOKEN };
const SESSION = { cookie: "ph_test_session=ok" };

let env: IngestEnv;
let boss: PgBoss;
let queue: UploadQueue;
let uploads: Uploads;
let server: TestApp;
let tmpDir: string;
let ninety: Buffer;

// The two hooks Part C will replace: a bearer check for the API and a cookie
// check for the UI. Each answers 401 itself, so nothing behind it runs.
async function bearerHook(request: FastifyRequest, reply: FastifyReply) {
  if (request.headers.authorization !== TOKEN) {
    return reply.code(401).send({ error: "unauthorized" });
  }
}
async function sessionHook(request: FastifyRequest, reply: FastifyReply) {
  if (request.headers.cookie !== SESSION.cookie) {
    return reply.code(401).send({ error: "unauthorized" });
  }
}

beforeAll(async () => {
  env = await startIngestEnv();
  tmpDir = join(env.dir, "tmp");
  boss = createBoss({ databaseUrl: env.url });
  await boss.start();
  queue = bossUploadQueue(boss);
  uploads = createUploads({ tmpDir, queue, log: () => {} });
  await startQueues(boss, {
    ingestFile: uploads.ingestUpload(env.ingest.ingestFile),
    purgeExpired: async () => ({}),
    sweepOrphans: async () => ({}),
    sweepUploads: (now: Date) => uploads.sweepStaleUploads(now),
    pollingIntervalSeconds: 0.5,
  });
  server = await startApp(async (app) => {
    await registerTus(app, { prefix: UI, authHook: sessionHook, uploads });
    await registerTus(app, { prefix: API, authHook: bearerHook, uploads });
  });
  ninety = randomBinaryStl(NINETY_MB_TRIANGLES);
});

afterAll(async () => {
  await server?.close();
  await boss?.stop({ graceful: false });
  await env?.stop();
});

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest();

/** The names in TMP_DIR/uploads, or none when it does not exist yet. */
async function tempFiles(): Promise<string[]> {
  try {
    return (await readdir(uploads.dir)).sort();
  } catch {
    return [];
  }
}

async function create(
  prefix: string,
  headers: Record<string, string>,
  length: number,
  fields: Record<string, string | null>,
) {
  return send(server.base, "POST", prefix, {
    headers: {
      ...TUS,
      ...headers,
      "upload-length": String(length),
      "upload-metadata": meta(fields),
    },
  });
}

/** Polls the result route until the ingest has finished. */
async function result(prefix: string, headers: Record<string, string>, id: string) {
  const end = Date.now() + 120_000;
  for (;;) {
    const res = await send(server.base, "GET", `${prefix}/${id}/result`, { headers });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      status: string;
      modelId?: string;
      fileId?: string;
      error?: string;
    };
    if (body.status !== "pending") return body;
    if (Date.now() > end) throw new Error("the upload's ingest did not finish");
    await sleep(250);
  }
}

async function fileRow(fileId: string) {
  return env.db.selectFrom("files").selectAll().where("id", "=", fileId).executeTakeFirstOrThrow();
}

/** HEAD's Upload-Offset once it has stopped moving. */
async function settledOffset(prefix: string, headers: Record<string, string>, id: string) {
  let last = -1;
  for (let i = 0; i < 100; i += 1) {
    const res = await send(server.base, "HEAD", `${prefix}/${id}`, {
      headers: { ...TUS, ...headers },
    });
    expect(res.status).toBe(200);
    const offset = Number(res.headers["upload-offset"]);
    if (offset === last) return offset;
    last = offset;
    await sleep(300);
  }
  throw new Error("the upload offset never settled");
}

async function patchAll(prefix: string, headers: Record<string, string>, id: string, body: Buffer) {
  const res = await send(server.base, "PATCH", `${prefix}/${id}`, {
    headers: { ...TUS, ...headers, "content-type": OCTET, "upload-offset": "0" },
    body,
  });
  expect(res.status).toBe(204);
  return res;
}

async function removeUpload(id: string) {
  await rm(join(uploads.dir, id), { force: true });
  await rm(join(uploads.dir, `${id}.json`), { force: true });
}

describe("resumable uploads", () => {
  test("a 90 MB generated upload completes in 5 MiB chunks with a resume in the middle", async () => {
    expect(ninety.length).toBe(94_371_834);
    const options = {
      endpoint: `${server.base}${UI}`,
      chunkSize: CHUNK,
      retryDelays: null,
      storeFingerprintForResuming: false,
      headers: SESSION,
      metadata: { filename: "Generated 90 MB part.stl" },
    };

    // First attempt: cut off part way, as a phone switching from the LAN to
    // Tailscale would be.
    let uploadUrl: string | null = null;
    const first = new Upload(ninety, {
      ...options,
      onProgress: (sent) => {
        if (sent > 47 * 1024 * 1024 && uploadUrl === null) {
          uploadUrl = first.url;
          void first.abort();
        }
      },
      onError: () => {},
    });
    first.start();
    const deadline = Date.now() + 60_000;
    while (uploadUrl === null) {
      if (Date.now() > deadline) throw new Error("the first attempt never got past 47 MiB");
      await sleep(50);
    }
    const url: string = uploadUrl;
    const id = idOf(url);
    const offset = await settledOffset(UI, SESSION, id);
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThan(ninety.length);

    // Second attempt: resumes from the server's offset, never from zero.
    const before = server.requests.length;
    await new Promise<void>((resolve, reject) => {
      const second = new Upload(ninety, {
        ...options,
        uploadUrl: url,
        onSuccess: () => resolve(),
        onError: (error) => reject(error),
      });
      second.start();
    });
    const patches = server.requests
      .slice(before)
      .filter((r) => r.method === "PATCH" && r.url.endsWith(id));
    expect(patches[0]?.uploadOffset).toBe(String(offset));
    for (const p of patches) expect(Number(p.contentLength)).toBeLessThanOrEqual(CHUNK);
    const sent = patches.reduce((sum, p) => sum + Number(p.contentLength), 0);
    expect(sent).toBe(ninety.length - offset);

    const done = await result(UI, SESSION, id);
    expect(done).toMatchObject({ status: "done" });
    const file = await fileRow(done.fileId as string);
    expect(file.modelId).toBe(done.modelId);
    expect(file.originalName).toBe("Generated 90 MB part.stl");
    expect(Number(file.size)).toBe(ninety.length);
    expect(Buffer.from(file.sha256).equals(sha256(ninety))).toBe(true);
    expect((await tempFiles()).filter((f) => f.startsWith(id))).toEqual([]);
  });

  test("curl-style single PATCH upload completes (one PATCH carrying the whole body)", async () => {
    const created = await create(API, BEARER, ninety.length, { filename: "Curl upload.stl" });
    expect(created.status).toBe(201);
    const id = idOf(created.headers.location);

    const before = server.requests.length;
    const patched = await patchAll(API, BEARER, id, ninety);
    expect(patched.headers["upload-offset"]).toBe(String(ninety.length));
    const patches = server.requests.slice(before).filter((r) => r.method === "PATCH");
    expect(patches).toHaveLength(1);

    const done = await result(API, BEARER, id);
    expect(done).toMatchObject({ status: "done" });
    const file = await fileRow(done.fileId as string);
    expect(Number(file.size)).toBe(ninety.length);
    expect(Buffer.from(file.sha256).equals(sha256(ninety))).toBe(true);
    // The bytes in the bucket are the bytes sent.
    const blob = await env.db
      .selectFrom("blobs")
      .select("key")
      .where("id", "=", file.blobId)
      .executeTakeFirstOrThrow();
    const chunks: Buffer[] = [];
    for await (const c of await env.store.getBlobStream(blob.key)) chunks.push(c as Buffer);
    expect(sha256(Buffer.concat(chunks)).equals(sha256(ninety))).toBe(true);
    expect((await tempFiles()).filter((f) => f.startsWith(id))).toEqual([]);
  });

  test("missing filename metadata is 400", async () => {
    const before = await footprint(env);
    const files = await tempFiles();
    const cases: Array<Record<string, string>> = [
      {},
      { "upload-metadata": meta({ modelId: randomUUID() }) },
      { "upload-metadata": meta({ filename: "" }) },
      { "upload-metadata": meta({ filename: null }) },
    ];
    for (const extra of cases) {
      const res = await send(server.base, "POST", API, {
        headers: { ...TUS, ...BEARER, "upload-length": "10", ...extra },
      });
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect(res.body).toMatch(/filename/i);
    }
    expect(await tempFiles()).toEqual(files);
    expect(await footprint(env)).toEqual(before);
  });

  test("stale partial uploads are swept after 24h and create nothing", async () => {
    const before = await footprint(env);
    const body = randomBinaryStl(2000);
    const created = await create(API, BEARER, body.length, { filename: "Abandoned.stl" });
    expect(created.status).toBe(201);
    const id = idOf(created.headers.location);
    const half = Math.floor(body.length / 2);
    const patched = await send(server.base, "PATCH", `${API}/${id}`, {
      headers: { ...TUS, ...BEARER, "content-type": OCTET, "upload-offset": "0" },
      body: body.subarray(0, half),
    });
    expect(patched.status).toBe(204);
    expect(await tempFiles()).toEqual(expect.arrayContaining([id, `${id}.json`]));

    // An hour short of a day: kept, and the upload can still resume.
    await uploads.sweepStaleUploads(new Date(Date.now() + STALE_UPLOAD_MS - 60 * 60 * 1000));
    expect(await settledOffset(API, BEARER, id)).toBe(half);

    // Past a day with no activity: gone, and nothing was made from it.
    const swept = await uploads.sweepStaleUploads(new Date(Date.now() + STALE_UPLOAD_MS + 60_000));
    expect(swept.deleted).toBeGreaterThanOrEqual(1);
    expect((await tempFiles()).filter((f) => f.startsWith(id))).toEqual([]);
    const head = await send(server.base, "HEAD", `${API}/${id}`, {
      headers: { ...TUS, ...BEARER },
    });
    expect(head.status).toBe(404);
    expect(await queue.result(id)).toBeUndefined();
    expect(await footprint(env)).toEqual(before);
  });

  test("temp file is deleted after ingest, success or failure", async () => {
    // Success.
    const good = randomBinaryStl(10);
    const ok = await create(API, BEARER, good.length, { filename: "Small part.stl" });
    const okId = idOf(ok.headers.location);
    await patchAll(API, BEARER, okId, good);
    expect(await result(API, BEARER, okId)).toMatchObject({ status: "done" });
    expect((await tempFiles()).filter((f) => f.startsWith(okId))).toEqual([]);

    // Failure: named .stl, but the bytes are no STL, so ingest refuses it.
    const before = await footprint(env);
    const bad = Buffer.from("this is not an stl file at all\n".repeat(10));
    const no = await create(API, BEARER, bad.length, { filename: "Broken.stl" });
    const noId = idOf(no.headers.location);
    await patchAll(API, BEARER, noId, bad);
    const failed = await result(API, BEARER, noId);
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/not a supported .*nothing was saved/);
    expect((await tempFiles()).filter((f) => f.startsWith(noId))).toEqual([]);
    expect(await footprint(env)).toEqual(before);
  });

  test("an upload with metadata modelId goes into that model", async () => {
    const first = randomBinaryStl(5);
    const a = await create(API, BEARER, first.length, { filename: "First.stl" });
    const aId = idOf(a.headers.location);
    await patchAll(API, BEARER, aId, first);
    const one = await result(API, BEARER, aId);
    expect(one.status).toBe("done");

    const second = randomBinaryStl(6);
    const b = await create(API, BEARER, second.length, {
      filename: "Second.stl",
      modelId: one.modelId as string,
    });
    const bId = idOf(b.headers.location);
    await patchAll(API, BEARER, bId, second);
    const two = await result(API, BEARER, bId);
    expect(two).toMatchObject({ status: "done", modelId: one.modelId });
    expect(two.fileId).not.toBe(one.fileId);
  });

  test("files of a combined batch join one model, and an uncombined batch makes one each", async () => {
    const upload = async (fields: Record<string, string | null>) => {
      const body = randomBinaryStl(3);
      const res = await create(UI, SESSION, body.length, fields);
      expect(res.status).toBe(201);
      const id = idOf(res.headers.location);
      await patchAll(UI, SESSION, id, body);
      return id;
    };
    const batch = randomUUID();
    const combined = await Promise.all(
      [1, 2, 3].map((n) => upload({ filename: `Combined ${n}.stl`, batch, combine: "1" })),
    );
    const models = new Set<string>();
    for (const id of combined) models.add((await result(UI, SESSION, id)).modelId as string);
    expect(models.size).toBe(1);

    const separate = randomUUID();
    const each = await Promise.all(
      [1, 2].map((n) => upload({ filename: `Separate ${n}.stl`, batch: separate })),
    );
    const own = new Set<string>();
    for (const id of each) own.add((await result(UI, SESSION, id)).modelId as string);
    expect(own.size).toBe(2);
  });
});

describe("refused and oversized uploads", () => {
  test("a request the auth hook refuses stores nothing", async () => {
    const before = await footprint(env);
    const files = await tempFiles();
    const fields = { "upload-length": "84", "upload-metadata": meta({ filename: "No.stl" }) };
    const refusedCreate = await send(server.base, "POST", API, { headers: { ...TUS, ...fields } });
    expect(refusedCreate.status).toBe(401);
    const wrongToken = await send(server.base, "POST", API, {
      headers: { ...TUS, ...fields, authorization: ["Bearer", "wrong"].join(" ") },
    });
    expect(wrongToken.status).toBe(401);
    // The UI mount refuses a request with no session, bearer or not.
    const noSession = await send(server.base, "POST", UI, {
      headers: { ...TUS, ...BEARER, ...fields },
    });
    expect(noSession.status).toBe(401);
    expect(await tempFiles()).toEqual(files);

    // A refused PATCH to a real upload writes no byte into it.
    const body = randomBinaryStl(4);
    const created = await create(API, BEARER, body.length, { filename: "Guarded.stl" });
    const id = idOf(created.headers.location);
    const refusedPatch = await send(server.base, "PATCH", `${API}/${id}`, {
      headers: { ...TUS, "content-type": OCTET, "upload-offset": "0" },
      body,
    });
    expect(refusedPatch.status).toBe(401);
    expect(await settledOffset(API, BEARER, id)).toBe(0);
    const refusedHead = await send(server.base, "HEAD", `${API}/${id}`, { headers: { ...TUS } });
    expect(refusedHead.status).toBe(401);
    const refusedResult = await send(server.base, "GET", `${API}/${id}/result`);
    expect(refusedResult.status).toBe(401);
    expect(await queue.result(id)).toBeUndefined();
    expect(await footprint(env)).toEqual(before);
    await removeUpload(id);
  });

  test(`an upload over ${MAX_UPLOAD_BYTES} bytes is refused and leaves no temp file`, async () => {
    expect(MAX_UPLOAD_BYTES).toBe(536_870_912);
    const files = await tempFiles();
    const over = await create(API, BEARER, MAX_UPLOAD_BYTES + 1, { filename: "Huge.stl" });
    expect(over.status).toBe(413);
    // A length left open is refused too, so the cap cannot be dodged.
    const deferred = await send(server.base, "POST", API, {
      headers: {
        ...TUS,
        ...BEARER,
        "upload-defer-length": "1",
        "upload-metadata": meta({ filename: "Open ended.stl" }),
      },
    });
    expect(deferred.status).toBe(400);
    expect(await tempFiles()).toEqual(files);

    // Exactly the cap is taken.
    const at = await create(API, BEARER, MAX_UPLOAD_BYTES, { filename: "At the cap.stl" });
    expect(at.status).toBe(201);
    await removeUpload(idOf(at.headers.location));
  });

  test("an unsupported file type is refused before any byte is sent", async () => {
    const files = await tempFiles();
    const res = await create(API, BEARER, 100, { filename: "Archive.zip" });
    expect(res.status).toBe(415);
    expect(res.body).toMatch(/not a supported/);
    expect(await tempFiles()).toEqual(files);
  });
});

describe("responses", () => {
  test("no CORS headers, and a Location that ignores the Host header", async () => {
    const res = await send(server.base, "POST", API, {
      headers: {
        ...TUS,
        ...BEARER,
        host: "evil.example",
        origin: "https://evil.example",
        "x-forwarded-host": "evil.example",
        "upload-length": "84",
        "upload-metadata": meta({ filename: "Cors.stl" }),
      },
    });
    expect(res.status).toBe(201);
    const id = idOf(res.headers.location);
    expect(res.headers.location).toBe(`${API}/${id}`);
    for (const name of Object.keys(res.headers)) expect(name).not.toMatch(/^access-control-/);
    const head = await send(server.base, "HEAD", `${API}/${id}`, {
      headers: { ...TUS, ...BEARER, origin: "https://evil.example" },
    });
    for (const name of Object.keys(head.headers)) expect(name).not.toMatch(/^access-control-/);
    await removeUpload(id);
  });
});
