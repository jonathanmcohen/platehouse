// From the PR #156 security review: delivery compares an object's
// real size with the recorded one before it sends a header, so the stream
// carries the Content-Length the store answered GetObject with. Checked here
// against the storage tests' scripted fake endpoint, so this file needs no
// Docker, and for a stream the store did not open.
//
// A Range request reads the object with getBlobRange, and the routes mounted
// here as the server mounts them (the download, a blob and the API's file
// content) answer 503 before any header when the store ignored the range
// (RangeIgnored) or its Content-Range gives a total that is not the record
// (SizeMismatch): the bytes sent are exactly the range of the recorded
// object, or none.
//
// Every value here is synthetic, joined from parts so that no source line
// looks like a credential.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createTokens } from "../../../src/api/tokens.js";
import {
  FILE_UNAVAILABLE_MESSAGE,
  type FileHead,
  readStored,
  refusingApi,
} from "../../../src/api/v1.js";
import { buildApp } from "../../../src/app.js";
import { SESSION_COOKIE } from "../../../src/auth/sessions.js";
import type { DeliveryDeps } from "../../../src/delivery/download.js";
import {
  type BlobStore,
  createBlobStore,
  objectSize,
  reportObjectSize,
} from "../../../src/storage/s3.js";
import { createUploads } from "../../../src/uploads/tus.js";
import { type Handler, startFakeS3 } from "../../storage/support/fake-s3.js";
import { authTestApp, memoryTokenStore, testAuth } from "../support/oidc-issuer.js";

const SECRET = ["synthetic", "secret", "never", "in", "an", "error", "7a2e"].join("-");
const ACCESS = ["SYNTH", "ACCESS", "ID"].join("");
const KEY = "models/0190f5a8-3c2e-7a4b-9c1d-2e3f4a5b6c7d/0190f5a8-3c2f-7d10-a2b3-c4d5e6f70819";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function storeAt(handler: Handler): Promise<BlobStore> {
  const fake = await startFakeS3(handler);
  cleanups.push(() => fake.close());
  const store = createBlobStore(
    {
      endpoint: fake.endpoint,
      region: "us-east-1",
      bucket: "platehouse-test",
      accessKeyId: ACCESS,
      secretAccessKey: SECRET,
      forcePathStyle: true,
    },
    { maxAttempts: 1 },
  );
  cleanups.push(() => store.destroy());
  return store;
}

describe("objectSize", () => {
  it("reports the object's size as the store sent it", async () => {
    const store = await storeAt(() => ({
      status: 200,
      headers: { "content-type": "application/octet-stream" },
      body: "synthetic object bytes",
    }));
    const stream = await store.getBlobStream(KEY);
    expect(objectSize(stream)).toBe(22);
    stream.destroy();
  });

  it("reports no size for a stream the store did not open", () => {
    expect(objectSize(Readable.from([Buffer.from("abc")]))).toBeUndefined();
    const reported = reportObjectSize(Readable.from([Buffer.from("abc")]), 3);
    expect(objectSize(reported)).toBe(3);
  });
});

describe("a range answer the store did not honour, through the routes", () => {
  const FILE_ID = "0190f5a8-3c2e-7a4b-9c1d-2e3f4a5b6c80";
  const BLOB_ID = "0190f5a8-3c2e-7a4b-9c1d-2e3f4a5b6c81";
  /** The record: 100 bytes. */
  const SIZE = 100;
  const WHOLE = "a".repeat(SIZE);

  /**
   * The download and blob routes, mounted as the server mounts them, over
   * stubs that read the record's object from the fake store with the real
   * readStored. Answers a GET of each with a Range of the first ten bytes.
   */
  async function rangedAnswers(handler: Handler) {
    const store = await storeAt(handler);
    const fileHead: FileHead = {
      name: "Part.3mf",
      contentType: "model/3mf",
      size: SIZE,
      etag: `"${BLOB_ID}"`,
    };
    const blobHead: FileHead = { name: BLOB_ID, contentType: "model/3mf", size: SIZE };
    const files: DeliveryDeps["files"] = {
      fileHead: async () => fileHead,
      openFile: async (id, pick) =>
        id === FILE_ID ? readStored(store, KEY, fileHead, pick) : undefined,
    };
    const library: DeliveryDeps["library"] = {
      linkFile: async () => undefined,
      blobKind: async (id) => (id === BLOB_ID ? "source" : undefined),
      blobHead: async () => blobHead,
      openBlob: async (id, pick) =>
        id === BLOB_ID
          ? readStored(store, KEY, { ...blobHead, etag: `"${BLOB_ID}"` }, pick)
          : undefined,
    };
    const t = await testAuth();
    cleanups.push(() => t.issuer.stop());
    const dir = await mkdtemp(join(tmpdir(), "platehouse-fake-s3-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const app = await buildApp({
      health: { database: async () => 1, queuesRunning: () => true },
      uploads: createUploads({
        tmpDir: dir,
        queue: { enqueue: async () => {}, result: async () => undefined },
        log: () => {},
      }),
      auth: t.auth,
      delivery: { files, library, linkSecret: "f".repeat(64), now: () => t.clock.now },
    });
    cleanups.push(() => app.close());
    const session = (await t.sessions.start("someone")).id;
    const answers = [];
    for (const url of [`/files/${FILE_ID}/download`, `/blobs/${BLOB_ID}`]) {
      const res = await app.inject({
        method: "GET",
        url,
        headers: { range: "bytes=0-9" },
        cookies: { [SESSION_COOKIE]: session },
      });
      answers.push({ url, res });
    }
    return answers;
  }

  function expectUnavailable(answers: Awaited<ReturnType<typeof rangedAnswers>>) {
    for (const { url, res } of answers) {
      expect(res.statusCode, url).toBe(503);
      expect(res.json(), url).toEqual({ error: "unavailable", message: FILE_UNAVAILABLE_MESSAGE });
      expect(res.headers["cache-control"], url).toBe("no-store");
      for (const header of ["content-range", "content-disposition", "accept-ranges", "etag"]) {
        expect(res.headers[header], `${url} ${header}`).toBeUndefined();
      }
    }
  }

  it("a store that sends the whole object with no Content-Range is 503 (RangeIgnored)", async () => {
    const answers = await rangedAnswers(() => ({
      status: 200,
      headers: { "content-type": "application/octet-stream" },
      body: WHOLE,
    }));
    expectUnavailable(answers);
  });

  it("a range whose Content-Range total is not the record is 503 (SizeMismatch)", async () => {
    const answers = await rangedAnswers(() => ({
      status: 206,
      headers: { "content-type": "application/octet-stream", "content-range": "bytes 0-9/101" },
      body: WHOLE.slice(0, 10),
    }));
    expectUnavailable(answers);
  });

  it("a store that honours the range with the record's total is 206 with those bytes", async () => {
    const answers = await rangedAnswers(() => ({
      status: 206,
      headers: { "content-type": "application/octet-stream", "content-range": "bytes 0-9/100" },
      body: "0123456789",
    }));
    for (const { url, res } of answers) {
      expect(res.statusCode, url).toBe(206);
      expect(res.body, url).toBe("0123456789");
      expect(res.headers["content-range"], url).toBe("bytes 0-9/100");
    }
  });
});

describe("a range answer the store did not honour, through the API's file content", () => {
  const FILE_ID = "0190f5a8-3c2e-7a4b-9c1d-2e3f4a5b6c90";
  const BLOB_ID = "0190f5a8-3c2e-7a4b-9c1d-2e3f4a5b6c91";
  /** The record: 100 bytes. */
  const SIZE = 100;

  /**
   * GET /api/v1/files/:id/content with a bearer token and a Range of the
   * first ten bytes, the library's openFile reading the record's object from
   * the fake store with the real readStored.
   */
  async function rangedAnswer(handler: Handler) {
    const store = await storeAt(handler);
    const head: FileHead = {
      name: "Part.3mf",
      contentType: "model/3mf",
      size: SIZE,
      etag: `"${BLOB_ID}"`,
    };
    const tokens = createTokens({ store: memoryTokenStore() });
    const library = {
      ...refusingApi.library,
      fileHead: async (id: string) => (id === FILE_ID ? head : undefined),
      openFile: async (id: string, pick?: Parameters<typeof readStored>[3]) =>
        id === FILE_ID ? readStored(store, KEY, head, pick) : undefined,
    };
    const t = await authTestApp({ api: { tokens, library } });
    cleanups.push(() => t.close());
    const { token } = await tokens.createToken("fake s3 range");
    return t.app.inject({
      method: "GET",
      url: `/api/v1/files/${FILE_ID}/content`,
      headers: { authorization: `Bearer ${token}`, range: "bytes=0-9" },
    });
  }

  function expectUnavailable(res: Awaited<ReturnType<typeof rangedAnswer>>) {
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "unavailable", message: FILE_UNAVAILABLE_MESSAGE });
    expect(res.headers["cache-control"]).toBe("no-store");
    for (const header of ["content-range", "content-disposition", "accept-ranges", "etag"]) {
      expect(res.headers[header], header).toBeUndefined();
    }
  }

  it("a store that sends the whole object with no Content-Range is 503 (RangeIgnored)", async () => {
    expectUnavailable(
      await rangedAnswer(() => ({
        status: 200,
        headers: { "content-type": "application/octet-stream" },
        body: "a".repeat(SIZE),
      })),
    );
  });

  it("a range whose Content-Range total is not the record is 503 (SizeMismatch)", async () => {
    expectUnavailable(
      await rangedAnswer(() => ({
        status: 206,
        headers: { "content-type": "application/octet-stream", "content-range": "bytes 0-9/101" },
        body: "a".repeat(10),
      })),
    );
  });

  it("a store that honours the range with the record's total is 206 with those bytes", async () => {
    const res = await rangedAnswer(() => ({
      status: 206,
      headers: { "content-type": "application/octet-stream", "content-range": "bytes 0-9/100" },
      body: "0123456789",
    }));
    expect(res.statusCode).toBe(206);
    expect(res.body).toBe("0123456789");
    expect(res.headers["content-range"]).toBe("bytes 0-9/100");
    expect(res.headers["content-length"]).toBe("10");
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers.etag).toBe(`"${BLOB_ID}"`);
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });
});
