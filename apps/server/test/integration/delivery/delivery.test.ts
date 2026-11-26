// File delivery and slicer links against Postgres 17 and
// the S3 test server: no bucket credential or signed URL reaches a client, a
// store outage shows a file as unavailable without marking it lost, slicer
// links work without a session for one file and 10 minutes, and hostile file
// names stay safe in downloads and links.
//
// Everything is real but the login: files and blobs in the database, bytes
// in the bucket, the download and blob routes and the slicer links served by
// buildApp over HTTP. The store can be switched to one whose endpoint
// nothing listens on, so an outage is the S3 client's own failure. Every
// answer this file reads is kept, and one test checks that none carries the
// S3 endpoint, the bucket, an object key, an access key or a signature.
//
// Every file and name here is generated; nothing is a designer file or a
// real secret.
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreateBucketCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApiLibrary, FILE_UNAVAILABLE_MESSAGE } from "../../../src/api/v1.js";
import { buildApp } from "../../../src/app.js";
import { SESSION_COOKIE } from "../../../src/auth/sessions.js";
import { migrate } from "../../../src/db/migrate.js";
import type { DB } from "../../../src/db/types.js";
import { createDeliveryLibrary } from "../../../src/delivery/download.js";
import { linkFileName, type SlicerLink } from "../../../src/delivery/links.js";
import { type DisplayContext, plateNumbersMany } from "../../../src/estimates/display.js";
import { createRepos } from "../../../src/repos/index.js";
import { type BlobStore, createBlobStore } from "../../../src/storage/s3.js";
import { createUploads } from "../../../src/uploads/tus.js";
import { type StartedS3, startS3 } from "../support/containers.js";
import { startTestPostgres, type TestPostgres } from "../support/db.js";
import { type LibraryEnv, seedStoredModel, storeBlob } from "../support/library.js";
import { TEST_ORIGIN, type TestAuth, testAuth } from "../support/oidc-issuer.js";

// Non-ASCII names are built from code points, so this file stays ASCII.
const E_ACUTE = String.fromCodePoint(0xe9);
/** "Cafe uber" with its accents, then two CJK characters. */
const ACCENTED = String.fromCodePoint(
  0x43,
  0x61,
  0x66,
  0xe9,
  0x20,
  0xfc,
  0x62,
  0x65,
  0x72,
  0x20,
  0x65e5,
  0x672c,
);

/** What a link's name segment never carries (linkSegment in delivery/links.ts). */
const UNSAFE_IN_SEGMENT = /[/\\%?#;\p{Cc}\p{Cf}]/gu;
/** The same, for one test (no global flag, so no state between calls). */
const UNSAFE_CHAR = /[/\\%?#;\p{Cc}\p{Cf}]/u;
/** U+202E RIGHT-TO-LEFT OVERRIDE: "rlo<RLO>exe.3mf" displays as "rlofm3.exe". */
const RLO = String.fromCodePoint(0x202e);

const CONTEXT: DisplayContext = {
  printerId: "Bambu Lab P1S 0.4 nozzle",
  orcaVersion: null,
  printers: [],
};

let pgc: TestPostgres;
let s3: StartedS3;
let bucket: string;
let env: LibraryEnv;
let realStore: BlobStore;
/** A store whose endpoint nothing listens on: every call is the client's own outage. */
let deadStore: BlobStore;
let storeDown = false;
let t: TestAuth;
let app: FastifyInstance;
let dir: string;
let base: string;
let sessionCookie: string;

interface Answer {
  status: number;
  headers: Headers;
  bytes: Buffer;
  text: string;
}

/** Every answer this file read, for the no-S3-detail check. */
const answers: Answer[] = [];

/** The ETag this app sends on a revalidated blob: its quoted id, a UUID. */
const OWN_ETAG = /^"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"$/;

async function call(
  method: string,
  path: string,
  opts: { session?: boolean; headers?: Record<string, string> } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.session) headers.cookie = `${SESSION_COOKIE}=${sessionCookie}`;
  const res = await fetch(`${base}${path}`, { method, headers });
  const bytes = Buffer.from(await res.arrayBuffer());
  const answer = {
    status: res.status,
    headers: res.headers,
    bytes,
    text: bytes.toString("latin1"),
  };
  answers.push(answer);
  return answer;
}

async function mint(fileId: string): Promise<SlicerLink> {
  const res = await call("POST", `/app/api/files/${fileId}/slicer-link`, {
    session: true,
    headers: { origin: TEST_ORIGIN },
  });
  expect(res.status, res.text).toBe(200);
  return JSON.parse(res.text) as SlicerLink;
}

/** The path of a link URL, kept exactly as minted (percent escapes and all). */
function pathOf(url: string): string {
  const at = url.indexOf("/s/");
  return url.slice(at);
}

/** A file of a model with its own stored bytes and the given names. */
async function seedNamedFile(modelId: string, name: string, originalName = name) {
  const bytes = Buffer.from(`named ${randomBytes(12).toString("hex")} ${name.length}`);
  const source = await storeBlob(env, modelId, "source", bytes);
  const file = await env.repos.files.create({
    modelId,
    blobId: source.id,
    name,
    originalName,
    kind: "3mf",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest(),
  });
  return { file, source, bytes };
}

function store(): BlobStore {
  return storeDown ? deadStore : realStore;
}

beforeAll(async () => {
  [pgc, s3] = await Promise.all([startTestPostgres(), startS3()]);
  const database = await pgc.freshDatabase();
  const db: Kysely<DB> = database.db;
  await migrate(db);
  bucket = `platehouse-t17-${randomBytes(4).toString("hex")}`;
  await s3.client.send(new CreateBucketCommand({ Bucket: bucket }));
  const s3Config = {
    endpoint: s3.endpoint,
    region: s3.region,
    bucket,
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
    forcePathStyle: true,
  };
  realStore = createBlobStore(s3Config);
  deadStore = createBlobStore({ ...s3Config, endpoint: "http://127.0.0.1:9" });
  const client = s3.client;
  env = {
    db,
    url: database.url,
    repos: createRepos(db),
    store: realStore,
    putRaw: async (key, bytes) => {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes }));
    },
    stop: async () => {},
  };
  // The routes' store: the real one, or the dead one while storeDown is set.
  const switching: Pick<BlobStore, "getBlobStream" | "getBlobRange" | "headBlob"> = {
    getBlobStream: (key) => store().getBlobStream(key),
    getBlobRange: (key, start, end) => store().getBlobRange(key, start, end),
    headBlob: (key) => store().headBlob(key),
  };
  t = await testAuth();
  dir = await mkdtemp(join(tmpdir(), "platehouse-delivery-"));
  app = await buildApp({
    health: { database: async () => 1, queuesRunning: () => true },
    uploads: createUploads({
      tmpDir: dir,
      queue: { enqueue: async () => {}, result: async () => undefined },
      log: () => {},
    }),
    auth: t.auth,
    delivery: {
      files: createApiLibrary({
        db,
        store: switching,
        displayContext: async () => CONTEXT,
        plateNumbersMany: (ctx, ids) => plateNumbersMany(db, ctx, ids),
      }),
      library: createDeliveryLibrary({ db, store: switching }),
      linkSecret: randomBytes(32).toString("hex"),
      now: () => t.clock.now,
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  base = `http://127.0.0.1:${address.port}`;
  sessionCookie = (await t.sessions.start("someone")).id;
});

afterAll(async () => {
  await app?.close();
  await t?.issuer.stop();
  realStore?.destroy();
  deadStore?.destroy();
  if (dir) await rm(dir, { recursive: true, force: true });
  await Promise.all([pgc?.stop(), s3?.stop()]);
});

describe("slicer links", () => {
  test("link works with no session and returns the file bytes", async () => {
    const seeded = await seedStoredModel(env);
    const link = await mint(seeded.file.id);
    const res = await call("GET", pathOf(link.url));
    expect(res.status).toBe(200);
    expect(res.bytes.equals(seeded.bytes)).toBe(true);
    expect(createHash("sha256").update(res.bytes).digest().equals(seeded.file.sha256)).toBe(true);
    expect(res.headers.get("content-length")).toBe(String(seeded.bytes.length));
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("link last segment is the file name with extension and the URL has no query string", async () => {
    const seeded = await seedStoredModel(env);
    const link = await mint(seeded.file.id);
    const url = new URL(link.url);
    expect(url.origin).toBe(TEST_ORIGIN);
    expect(url.search).toBe("");
    expect(link.url).not.toContain("?");
    const last = link.url.slice(link.url.lastIndexOf("/") + 1);
    expect(decodeURIComponent(last)).toBe(seeded.file.name);
    expect(last.endsWith(".3mf")).toBe(true);
  });

  test("a renamed file without its extension still links with the real extension", async () => {
    const seeded = await seedStoredModel(env);
    const { file } = await seedNamedFile(seeded.model.id, "Renamed plate", "plate.3mf");
    const link = await mint(file.id);
    expect(link.url.endsWith("/Renamed%20plate.3mf")).toBe(true);
    const res = await call("GET", pathOf(link.url));
    expect(res.status).toBe(200);
    // A browser or slicer that names the file from Content-Disposition gets
    // the real extension too, on the link and on the download.
    const expected = `attachment; filename="Renamed plate.3mf"; filename*=UTF-8''Renamed%20plate.3mf`;
    expect(res.headers.get("content-disposition")).toBe(expected);
    const download = await call("GET", `/files/${file.id}/download`, { session: true });
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toBe(expected);
  });

  test("link expires after 10 minutes: 9:59 works, 10:01 is 403 with an empty body", async () => {
    const seeded = await seedStoredModel(env);
    const link = await mint(seeded.file.id);
    const start = t.clock.now;
    try {
      t.clock.advance(9 * 60_000 + 59_000);
      const live = await call("GET", pathOf(link.url));
      expect(live.status).toBe(200);
      expect(live.bytes.equals(seeded.bytes)).toBe(true);
      t.clock.advance(2_000);
      const dead = await call("GET", pathOf(link.url));
      expect(dead.status).toBe(403);
      expect(dead.bytes.length).toBe(0);
    } finally {
      t.clock.now = start;
    }
  });

  test("an altered token is 403 with no bytes", async () => {
    const seeded = await seedStoredModel(env);
    const link = await mint(seeded.file.id);
    const [, , token, name] = pathOf(link.url).split("/");
    const raw = Buffer.from(token ?? "", "base64url");
    for (const i of [0, 15, 16, 19, 20, 35]) {
      const altered = Buffer.from(raw);
      altered[i] = (altered[i] ?? 0) ^ 0x01;
      const res = await call("GET", `/s/${altered.toString("base64url")}/${name}`);
      expect(res.status, `byte ${i}`).toBe(403);
      expect(res.bytes.length, `byte ${i}`).toBe(0);
    }
  });

  test("a link for file A cannot fetch file B", async () => {
    const a = await seedStoredModel(env);
    const b = await seedStoredModel(env);
    const linkA = await mint(a.file.id);
    const linkB = await mint(b.file.id);
    const [, , tokenA] = pathOf(linkA.url).split("/");
    const raw = Buffer.from(tokenA ?? "", "base64url");
    Buffer.from(b.file.id.replaceAll("-", ""), "hex").copy(raw, 0);
    const swapped = await call("GET", `/s/${raw.toString("base64url")}/x.3mf`);
    expect(swapped.status).toBe(403);
    expect(swapped.bytes.length).toBe(0);
    const ownA = await call("GET", pathOf(linkA.url));
    const ownB = await call("GET", pathOf(linkB.url));
    expect(ownA.bytes.equals(a.bytes)).toBe(true);
    expect(ownB.bytes.equals(b.bytes)).toBe(true);
    expect(ownA.bytes.equals(b.bytes)).toBe(false);
  });

  test("a link minted before the model was trashed stops working, and none is minted after", async () => {
    const seeded = await seedStoredModel(env);
    const link = await mint(seeded.file.id);
    await env.repos.models.trash(seeded.model.id);
    const res = await call("GET", pathOf(link.url));
    expect(res.status).toBe(403);
    expect(res.bytes.length).toBe(0);
    const again = await call("POST", `/app/api/files/${seeded.file.id}/slicer-link`, {
      session: true,
      headers: { origin: TEST_ORIGIN },
    });
    expect(again.status).toBe(404);
  });
});

describe("downloads and blobs", () => {
  test("download streams the stored bytes as an attachment", async () => {
    const seeded = await seedStoredModel(env);
    const res = await call("GET", `/files/${seeded.file.id}/download`, { session: true });
    expect(res.status).toBe(200);
    expect(res.bytes.equals(seeded.bytes)).toBe(true);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="/);
  });

  test("a thumbnail is served with the immutable cache header", async () => {
    const seeded = await seedStoredModel(env);
    const res = await call("GET", `/blobs/${seeded.thumbnail.id}`, { session: true });
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/^png /);
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
  });

  test("a source blob is revalidated, and a matching If-None-Match is 304 without a body", async () => {
    const seeded = await seedStoredModel(env);
    const path = `/blobs/${seeded.source.id}`;
    const etag = `"${seeded.source.id}"`;
    const plain = await call("GET", path, { session: true });
    expect(plain.status).toBe(200);
    expect(plain.headers.get("cache-control")).toBe("private, no-cache");
    expect(plain.headers.get("etag")).toBe(etag);
    for (const value of [etag, `W/${etag}`, "*"]) {
      const res = await call("GET", path, { session: true, headers: { "if-none-match": value } });
      expect(res.status, value).toBe(304);
      expect(res.headers.get("etag"), value).toBe(etag);
      expect(res.headers.get("cache-control"), value).toBe("private, no-cache");
      expect(res.bytes.length, value).toBe(0);
    }
    const other = await call("GET", path, {
      session: true,
      headers: { "if-none-match": '"something-else"' },
    });
    expect(other.status).toBe(200);
  });

  test("a conditional request for a trashed model's blob is 404", async () => {
    const seeded = await seedStoredModel(env);
    await env.repos.models.trash(seeded.model.id);
    const res = await call("GET", `/blobs/${seeded.source.id}`, {
      session: true,
      headers: { "if-none-match": `"${seeded.source.id}"` },
    });
    expect(res.status).toBe(404);
  });

  test("a trashed model's file and blobs are 404", async () => {
    const seeded = await seedStoredModel(env);
    await env.repos.models.trash(seeded.model.id);
    for (const path of [`/files/${seeded.file.id}/download`, `/blobs/${seeded.thumbnail.id}`]) {
      const res = await call("GET", path, { session: true });
      expect(res.status, path).toBe(404);
    }
  });
});

describe("ranges", () => {
  // One byte range per request, read from the bucket with a ranged
  // GetObject: the download, a source blob and a slicer link of one file.
  async function targets() {
    const seeded = await seedStoredModel(env);
    const link = await mint(seeded.file.id);
    const row = await env.db
      .selectFrom("files")
      .select("blobId")
      .where("id", "=", seeded.file.id)
      .executeTakeFirstOrThrow();
    const fileEtag = `"${row.blobId}"`;
    return {
      seeded,
      fileEtag,
      list: [
        {
          path: `/files/${seeded.file.id}/download`,
          session: true,
          etag: fileEtag,
          attachment: true,
        },
        {
          path: `/blobs/${seeded.source.id}`,
          session: true,
          etag: `"${seeded.source.id}"`,
          attachment: false,
        },
        { path: pathOf(link.url), session: false, etag: fileEtag, attachment: true },
      ],
    };
  }

  test("a range is 206 with those bytes and the 200's headers", async () => {
    const { seeded, list } = await targets();
    const n = seeded.bytes.length;
    expect(n).toBeGreaterThan(20);
    for (const target of list) {
      const whole = await call("GET", target.path, { session: target.session });
      expect(whole.status, target.path).toBe(200);
      expect(whole.headers.get("accept-ranges"), target.path).toBe("bytes");
      expect(whole.headers.get("etag"), target.path).toBe(target.etag);
      const res = await call("GET", target.path, {
        session: target.session,
        headers: { range: "bytes=0-9" },
      });
      expect(res.status, target.path).toBe(206);
      expect(res.bytes.equals(seeded.bytes.subarray(0, 10)), target.path).toBe(true);
      expect(res.headers.get("content-range"), target.path).toBe(`bytes 0-9/${n}`);
      expect(res.headers.get("content-length"), target.path).toBe("10");
      expect(res.headers.get("accept-ranges"), target.path).toBe("bytes");
      expect(res.headers.get("etag"), target.path).toBe(target.etag);
      for (const header of [
        "content-type",
        "cache-control",
        "x-content-type-options",
        "content-disposition",
      ]) {
        expect(res.headers.get(header), `${target.path} ${header}`).toBe(whole.headers.get(header));
      }
      expect(res.headers.get("content-disposition") !== null, target.path).toBe(target.attachment);
    }
  });

  test("a suffix, an open end and a last byte past the end", async () => {
    const { seeded, list } = await targets();
    const n = seeded.bytes.length;
    for (const target of list) {
      for (const [range, start, end] of [
        ["bytes=-5", n - 5, n - 1],
        ["bytes=5-", 5, n - 1],
        ["bytes=5-99999", 5, n - 1],
      ] as const) {
        const label = `${target.path} ${range}`;
        const res = await call("GET", target.path, { session: target.session, headers: { range } });
        expect(res.status, label).toBe(206);
        expect(res.bytes.equals(seeded.bytes.subarray(start, end + 1)), label).toBe(true);
        expect(res.headers.get("content-range"), label).toBe(`bytes ${start}-${end}/${n}`);
      }
    }
  });

  test("a range from the size on is 416 with no file header; several ranges are 200 in full", async () => {
    const { seeded, list } = await targets();
    const n = seeded.bytes.length;
    for (const target of list) {
      const refused = await call("GET", target.path, {
        session: target.session,
        headers: { range: `bytes=${n}-` },
      });
      expect(refused.status, target.path).toBe(416);
      expect(refused.headers.get("content-range"), target.path).toBe(`bytes */${n}`);
      expect(refused.headers.get("cache-control"), target.path).toBe("no-store");
      expect(refused.bytes.length, target.path).toBe(0);
      for (const header of ["content-type", "content-disposition", "accept-ranges", "etag"]) {
        expect(refused.headers.get(header), `${target.path} ${header}`).toBeNull();
      }
      const several = await call("GET", target.path, {
        session: target.session,
        headers: { range: "bytes=0-1,5-6" },
      });
      expect(several.status, target.path).toBe(200);
      expect(several.bytes.equals(seeded.bytes), target.path).toBe(true);
      expect(several.headers.get("content-range"), target.path).toBeNull();
    }
  });

  test("If-Range with the ETag is 206, with another tag 200 in full; a HEAD ignores Range", async () => {
    const { seeded, list } = await targets();
    for (const target of list) {
      const matched = await call("GET", target.path, {
        session: target.session,
        headers: { range: "bytes=0-9", "if-range": target.etag },
      });
      expect(matched.status, target.path).toBe(206);
      expect(matched.bytes.equals(seeded.bytes.subarray(0, 10)), target.path).toBe(true);
      const other = await call("GET", target.path, {
        session: target.session,
        headers: { range: "bytes=0-9", "if-range": `"${seeded.thumbnail.id}"` },
      });
      expect(other.status, target.path).toBe(200);
      expect(other.bytes.equals(seeded.bytes), target.path).toBe(true);
      const head = await call("HEAD", target.path, {
        session: target.session,
        headers: { range: "bytes=0-9" },
      });
      expect(head.status, target.path).toBe(200);
      expect(head.headers.get("content-length"), target.path).toBe(String(seeded.bytes.length));
      expect(head.headers.get("accept-ranges"), target.path).toBe("bytes");
      expect(head.headers.get("etag"), target.path).toBe(target.etag);
      expect(head.bytes.length, target.path).toBe(0);
    }
  });

  test("the file's ETag is its blob's id, quoted, a UUID like the blobs'", async () => {
    const { seeded, fileEtag } = await targets();
    expect(fileEtag).toMatch(OWN_ETAG);
    for (const method of ["GET", "HEAD"]) {
      const res = await call(method, `/files/${seeded.file.id}/download`, { session: true });
      expect(res.headers.get("etag"), method).toBe(fileEtag);
    }
  });

  test("after a range request, a trashed model's file is 404", async () => {
    const { seeded } = await targets();
    const path = `/files/${seeded.file.id}/download`;
    const before = await call("GET", path, { session: true, headers: { range: "bytes=0-9" } });
    expect(before.status).toBe(206);
    await env.repos.models.trash(seeded.model.id);
    const after = await call("GET", path, { session: true, headers: { range: "bytes=0-9" } });
    expect(after.status).toBe(404);
    expect(after.headers.get("content-range")).toBeNull();
  });
});

describe("the store down", () => {
  test("store down: download is 503 and the file is not marked missing", async () => {
    const seeded = await seedStoredModel(env);
    const link = await mint(seeded.file.id);
    const rows = async () => ({
      model: await env.db
        .selectFrom("models")
        .selectAll()
        .where("id", "=", seeded.model.id)
        .executeTakeFirst(),
      files: await env.db
        .selectFrom("files")
        .selectAll()
        .where("modelId", "=", seeded.model.id)
        .execute(),
      blobs: await env.db
        .selectFrom("blobs")
        .selectAll()
        .where("modelId", "=", seeded.model.id)
        .orderBy("id")
        .execute(),
    });
    const before = await rows();
    storeDown = true;
    try {
      for (const [method, path, session] of [
        ["GET", `/files/${seeded.file.id}/download`, true],
        ["HEAD", `/files/${seeded.file.id}/download`, true],
        ["GET", `/blobs/${seeded.thumbnail.id}`, true],
        ["HEAD", `/blobs/${seeded.thumbnail.id}`, true],
        ["GET", pathOf(link.url), false],
        ["HEAD", pathOf(link.url), false],
      ] as const) {
        const res = await call(method, path, { session });
        expect(res.status, `${method} ${path}`).toBe(503);
        if (method === "GET") expect(res.text, path).toContain(FILE_UNAVAILABLE_MESSAGE);
        expect(res.text, path).not.toContain("127.0.0.1");
        expect(res.text, path).not.toContain("ECONNREFUSED");
      }
    } finally {
      storeDown = false;
    }
    const after = await rows();
    expect(after).toEqual(before);
    expect(after.files[0]?.parseStatus).toBe(before.files[0]?.parseStatus);
    expect(after.blobs.every((b) => b.state === "stored")).toBe(true);
    const back = await call("GET", `/files/${seeded.file.id}/download`, { session: true });
    expect(back.status).toBe(200);
    expect(back.bytes.equals(seeded.bytes)).toBe(true);
  });
});

describe("an object whose size differs from the record (PR #156 security review)", () => {
  // A restored older object version, or a write to the bucket behind the
  // app's back, leaves an object under the key whose size is not the
  // recorded one. Sending it would put bytes past Content-Length on the
  // keep-alive socket, or leave the client waiting for the rest, so the
  // route answers 503 before any header instead.
  test.each([
    ["longer", 7],
    ["shorter", -5],
  ])("an object %s than its record is 503 before any header", async (_label, delta) => {
    const seeded = await seedStoredModel(env);
    const link = await mint(seeded.file.id);
    const thumbnail = await env.repos.blobs.get(seeded.thumbnail.id);
    const thumbnailSize = Number(thumbnail?.size ?? 0);
    expect(thumbnailSize).toBeGreaterThan(5);
    await env.putRaw(seeded.source.key, randomBytes(seeded.bytes.length + delta));
    await env.putRaw(seeded.thumbnail.key, randomBytes(thumbnailSize + delta));
    for (const [path, session] of [
      [`/files/${seeded.file.id}/download`, true],
      [`/blobs/${seeded.thumbnail.id}`, true],
      [pathOf(link.url), false],
    ] as const) {
      const res = await call("GET", path, { session });
      expect(res.status, path).toBe(503);
      expect(JSON.parse(res.text), path).toEqual({
        error: "unavailable",
        message: FILE_UNAVAILABLE_MESSAGE,
      });
      expect(res.headers.get("content-disposition"), path).toBeNull();
      expect(res.headers.get("cache-control"), path).toBe("no-store");
      // A HEAD answers what the GET does: the HeadObject's size is compared
      // with the record too, so it is not 200 with a Content-Length the GET
      // will never deliver (issue #164).
      const head = await call("HEAD", path, { session });
      expect(head.status, `HEAD ${path}`).toBe(503);
      expect(head.headers.get("content-disposition"), `HEAD ${path}`).toBeNull();
    }
    // The object put back at its recorded size is served whole again.
    await env.putRaw(seeded.source.key, seeded.bytes);
    const back = await call("GET", pathOf(link.url));
    expect(back.status).toBe(200);
    expect(back.bytes.equals(seeded.bytes)).toBe(true);
  });
});

describe("hostile file names", () => {
  const hostile = [
    "a b  c.3mf",
    `${ACCENTED}.3mf`,
    "../../etc/passwd.3mf",
    "..\\..\\boot.ini.3mf",
    "a/b/c.3mf",
    "\"quoted\" 'single'.3mf",
    "semi;colon,comma=eq.3mf",
    "percent %2F %00.3mf",
    "hash # question ?.3mf",
    "new\nline\r\ttab.3mf",
    `rlo${RLO}exe.3mf`,
    `${"x".repeat(230)}.3mf`,
    `${E_ACUTE.repeat(210)}.3mf`,
    "..",
  ];

  /** The parts of a Content-Disposition this route writes. */
  function disposition(header: string | null) {
    expect(header).not.toBeNull();
    const value = header ?? "";
    expect(value).toMatch(/^[\x20-\x7e]+$/);
    const m =
      /^attachment; filename="([^"\\]*)"; filename\*=UTF-8''([A-Za-z0-9%._~!$&+^`|-]*)$/.exec(
        value,
      );
    expect(m, value).not.toBeNull();
    return { fallback: m?.[1] ?? "", encoded: m?.[2] ?? "" };
  }

  test("slicer link and download keep hostile names safe", async () => {
    const seeded = await seedStoredModel(env);
    for (const name of hostile) {
      const { file, bytes } = await seedNamedFile(seeded.model.id, name, "orig.3mf");
      // The stored name, with the real extension added when it lacks one,
      // and in Content-Disposition with / and \, control characters
      // (\p{Cc}), invisible format characters (\p{Cf}) and line and
      // paragraph separators (\p{Zl}, \p{Zp}) replaced by _, so no browser
      // shows a reordered or broken name and no client that honours
      // filename* sees a directory part (issue #164; PR #211 security review
      // and review).
      const expected = linkFileName({ name, originalName: "orig.3mf", kind: "3mf" }).replace(
        /[/\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
        "_",
      );

      const download = await call("GET", `/files/${file.id}/download`, { session: true });
      expect(download.status, name).toBe(200);
      expect(download.bytes.equals(bytes), name).toBe(true);
      const d = disposition(download.headers.get("content-disposition"));
      expect(decodeURIComponent(d.encoded), name).toBe(expected);
      expect(d.fallback, name).toMatch(/^[\x20-\x7e]*$/);

      const link = await mint(file.id);
      const url = new URL(link.url);
      expect(url.origin, name).toBe(TEST_ORIGIN);
      expect(url.search, name).toBe("");
      const segments = pathOf(link.url).split("/");
      expect(segments, name).toHaveLength(4);
      const last = segments[3] ?? "";
      // The segment has / \ % ? # ;, control characters and invisible
      // format characters (\p{Cf}) replaced by _ (the maintainer, 2026-11-12);
      // Content-Disposition keeps the rest of the stored name, its / and \
      // replaced as well.
      expect(last, name).toBe(encodeURIComponent(expected.replace(UNSAFE_IN_SEGMENT, "_")));
      expect(decodeURIComponent(last), name).not.toMatch(UNSAFE_CHAR);
      expect(last.endsWith(".3mf"), name).toBe(true);
      const fetched = await call("GET", pathOf(link.url));
      expect(fetched.status, name).toBe(200);
      expect(fetched.bytes.equals(bytes), name).toBe(true);
      const l = disposition(fetched.headers.get("content-disposition"));
      expect(decodeURIComponent(l.encoded), name).toBe(expected);
    }
  });

  test("two files with the same name in one model each get their own bytes", async () => {
    const seeded = await seedStoredModel(env);
    const one = await seedNamedFile(seeded.model.id, "Same name.3mf");
    const two = await seedNamedFile(seeded.model.id, "Same name.3mf");
    expect(one.bytes.equals(two.bytes)).toBe(false);
    for (const f of [one, two]) {
      const download = await call("GET", `/files/${f.file.id}/download`, { session: true });
      expect(download.bytes.equals(f.bytes)).toBe(true);
      const link = await mint(f.file.id);
      expect(link.url.endsWith("/Same%20name.3mf")).toBe(true);
      const fetched = await call("GET", pathOf(link.url));
      expect(fetched.bytes.equals(f.bytes)).toBe(true);
    }
  });
});

describe("no S3 detail in any answer", () => {
  test("responses carry no S3 host, key or signature", async () => {
    // Make sure every kind of answer is in the set, then read them all: the
    // ones this test makes, and any the tests before it recorded.
    const start = answers.length;
    const seeded = await seedStoredModel(env);
    const link = await mint(seeded.file.id);
    await call("GET", pathOf(link.url));
    await call("HEAD", pathOf(link.url));
    await call("GET", `/files/${seeded.file.id}/download`, { session: true });
    await call("GET", `/blobs/${seeded.thumbnail.id}`, { session: true });
    storeDown = true;
    try {
      await call("GET", `/files/${seeded.file.id}/download`, { session: true });
      await call("GET", pathOf(link.url));
    } finally {
      storeDown = false;
    }
    const endpoint = new URL(s3.endpoint);
    const forbidden = [
      s3.endpoint,
      endpoint.host,
      `:${endpoint.port}`,
      bucket,
      seeded.source.key,
      seeded.thumbnail.key,
      "models/",
      s3.accessKeyId,
      s3.secretAccessKey,
      "X-Amz-",
      "x-amz-",
      "Signature=",
      "AWSAccessKeyId",
      "127.0.0.1:9",
    ];
    // At least the six this test makes itself, so it passes or fails on its
    // own when run alone.
    expect(answers.length - start).toBeGreaterThanOrEqual(6);
    for (const answer of answers) {
      const headerText = [...answer.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
      for (const name of answer.headers.keys()) {
        expect(name.toLowerCase().startsWith("x-amz"), name).toBe(false);
        // Only our own blob-id ETag is allowed ("<uuid>", quoted); an S3 ETag
        // is a quoted MD5 hex and would show a store's own header.
        if (name.toLowerCase() === "etag") {
          expect(answer.headers.get(name), name).toMatch(OWN_ETAG);
        }
      }
      for (const needle of forbidden) {
        expect(headerText.includes(needle), `${needle} in headers`).toBe(false);
        expect(answer.text.includes(needle), `${needle} in a body`).toBe(false);
      }
    }
  });
});
