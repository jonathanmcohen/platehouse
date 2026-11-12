// The storage layer against the real S3 test server (build plan Task 5;
// AC-010, AC-012, AC-013). The first test proves the server itself keeps
// object versions, because the versioning checks below mean nothing on a
// server that only pretends to.
import { createHash, randomBytes, randomUUIDv7 } from "node:crypto";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { inspect } from "node:util";
import {
  CreateBucketCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../../../src/config.js";
import { blobKey } from "../../../src/storage/keys.js";
import {
  BlobNotFound,
  type BlobStore,
  createBlobStore,
  objectSize,
  StoreError,
  StoreUnavailable,
} from "../../../src/storage/s3.js";
import { type StartedS3, startS3 } from "../support/containers.js";

let s3: StartedS3 | undefined;
const stores: BlobStore[] = [];

beforeAll(async () => {
  s3 = await startS3();
});

afterAll(async () => {
  for (const store of stores) store.destroy();
  await s3?.stop();
});

function server(): StartedS3 {
  if (!s3) throw new Error("S3 container did not start");
  return s3;
}

function settingsFor(target: StartedS3, bucket: string, secret?: string): Config["s3"] {
  return {
    endpoint: target.endpoint,
    region: target.region,
    bucket,
    accessKeyId: target.accessKeyId,
    secretAccessKey: secret ?? target.secretAccessKey,
    forcePathStyle: true,
  };
}

let bucketCount = 0;
async function newBucket(versioning?: "Enabled" | "Suspended"): Promise<string> {
  bucketCount += 1;
  const bucket = `platehouse-t5-${bucketCount}-${randomBytes(3).toString("hex")}`;
  await server().client.send(new CreateBucketCommand({ Bucket: bucket }));
  if (versioning) {
    await server().client.send(
      new PutBucketVersioningCommand({
        Bucket: bucket,
        VersioningConfiguration: { Status: versioning },
      }),
    );
  }
  return bucket;
}

function storeFor(bucket: string): BlobStore {
  const store = createBlobStore(settingsFor(server(), bucket));
  stores.push(store);
  return store;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Feeds a buffer in uneven chunks, as a file or upload stream would.
function streamOf(bytes: Buffer, chunk = 64 * 1024 + 7): Readable {
  const parts: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += chunk) parts.push(bytes.subarray(i, i + chunk));
  return Readable.from(parts);
}

function everyRendering(err: Error): string {
  return [err.message, String(err.stack), inspect(err, { depth: 10 }), JSON.stringify(err)].join(
    "\n",
  );
}

async function errorOf(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    return err as Error;
  }
  throw new Error("expected the call to fail");
}

describe("the S3 test server", () => {
  it("keeps every version of an object in a versioned bucket", async () => {
    const bucket = await newBucket("Enabled");
    const key = blobKey(randomUUIDv7(), randomUUIDv7());
    for (const body of ["first", "second"]) {
      await server().client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
    }
    const listed = await server().client.send(
      new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key }),
    );
    const versions = (listed.Versions ?? []).filter((v) => v.Key === key);
    expect(versions).toHaveLength(2);
    const ids = new Set(versions.map((v) => v.VersionId));
    expect(ids.size).toBe(2);
    expect(ids.has("null")).toBe(false);
  });
});

describe("putBlob", () => {
  it.each([
    ["a small blob (one PUT)", 1000],
    ["a 12 MiB blob (multipart)", 12 * 1024 * 1024 + 13],
    ["an empty blob", 0],
  ])("putBlob returns the sha256 of the bytes and HEAD size matches: %s", async (_label, size) => {
    const bucket = await newBucket();
    const store = storeFor(bucket);
    const bytes = randomBytes(size);
    const key = blobKey(randomUUIDv7(), randomUUIDv7());

    const result = await store.putBlob(streamOf(bytes), {
      key,
      size,
      contentType: "application/vnd.ms-package.3dmanufacturing-3dmodel+xml",
    });

    expect(result.size).toBe(size);
    expect(result.sha256).toBeInstanceOf(Buffer);
    expect(result.sha256.toString("hex")).toBe(sha256(bytes));
    const head = await server().client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    expect(head.ContentLength).toBe(size);
    expect(head.ContentType).toBe("application/vnd.ms-package.3dmanufacturing-3dmodel+xml");
    const back = await buffer(await store.getBlobStream(key));
    expect(sha256(back)).toBe(sha256(bytes));
  });

  it("refuses a blob whose bytes do not match the declared size and keeps nothing", async () => {
    const bucket = await newBucket();
    const store = storeFor(bucket);
    const model = randomUUIDv7();
    const key = blobKey(model, randomUUIDv7());

    const err = await errorOf(
      store.putBlob(streamOf(randomBytes(500)), { key, size: 1000, contentType: "model/stl" }),
    );

    expect(err).toBeInstanceOf(StoreError);
    expect((err as StoreError).code).toBe("SizeMismatch");
    expect(await store.listPrefix(`models/${model}/`)).toEqual([]);
  });
});

describe("getBlobStream", () => {
  it("reports the stored object's size, also after the object is overwritten", async () => {
    const bucket = await newBucket();
    const store = storeFor(bucket);
    const key = blobKey(randomUUIDv7(), randomUUIDv7());
    await store.putBlob(streamOf(randomBytes(1234)), { key, size: 1234, contentType: "model/stl" });
    const stream = await store.getBlobStream(key);
    expect(objectSize(stream)).toBe(1234);
    expect((await buffer(stream)).length).toBe(1234);
    // A restored older version, or a write behind the app's back, changes
    // the object under the same key; the size reported is the new one.
    await server().client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: randomBytes(99) }),
    );
    const again = await store.getBlobStream(key);
    expect(objectSize(again)).toBe(99);
    again.destroy();
  });

  it("a missing key is BlobNotFound, not StoreUnavailable", async () => {
    const store = storeFor(await newBucket());
    const err = await errorOf(store.getBlobStream(blobKey(randomUUIDv7(), randomUUIDv7())));
    expect(err).toBeInstanceOf(BlobNotFound);
    expect(err).not.toBeInstanceOf(StoreUnavailable);
  });
});

describe("headBlob", () => {
  it("resolves for a stored object, and a missing key is a 404 StoreError, not an outage", async () => {
    const store = storeFor(await newBucket());
    const key = blobKey(randomUUIDv7(), randomUUIDv7());
    await store.putBlob(streamOf(Buffer.from("synthetic")), {
      key,
      size: 9,
      contentType: "model/stl",
    });
    await expect(store.headBlob(key)).resolves.toBeUndefined();
    await store.deleteBlobs([key]);
    const err = await errorOf(store.headBlob(key));
    expect(err).toBeInstanceOf(StoreError);
    expect(err).not.toBeInstanceOf(StoreUnavailable);
    expect((err as StoreError).status).toBe(404);
  });
});

describe("listPrefix and deleteBlobs", () => {
  it("lists only the objects under a model and nothing after the purge", async () => {
    const store = storeFor(await newBucket());
    const model = randomUUIDv7();
    const other = randomUUIDv7();
    const keys = [blobKey(model, randomUUIDv7()), blobKey(model, randomUUIDv7())];
    const otherKey = blobKey(other, randomUUIDv7());
    for (const [i, key] of [...keys, otherKey].entries()) {
      const bytes = randomBytes(10 + i);
      await store.putBlob(streamOf(bytes), { key, size: bytes.length, contentType: "image/png" });
    }

    const listed = await store.listPrefix(`models/${model}/`);
    expect(listed.map((o) => o.key).sort()).toEqual([...keys].sort());
    expect(listed.map((o) => o.size).sort()).toEqual([10, 11]);
    expect(await store.listPrefix("models/")).toHaveLength(3);

    await store.deleteBlobs(keys);
    expect(await store.listPrefix(`models/${model}/`)).toEqual([]);
    expect((await store.listPrefix(`models/${other}/`)).map((o) => o.key)).toEqual([otherKey]);
  });

  it("a purge in a versioned bucket also leaves the model prefix empty", async () => {
    const store = storeFor(await newBucket("Enabled"));
    const model = randomUUIDv7();
    const key = blobKey(model, randomUUIDv7());
    await store.putBlob(streamOf(randomBytes(32)), { key, size: 32, contentType: "model/stl" });
    await store.deleteBlobs([key]);
    expect(await store.listPrefix(`models/${model}/`)).toEqual([]);
  });

  it("deleting a key that is already gone succeeds, so a purge can be retried", async () => {
    const store = storeFor(await newBucket());
    await store.deleteBlobs([blobKey(randomUUIDv7(), randomUUIDv7())]);
  });
});

describe("listPage", () => {
  it("lists one page at a time, with each object's last-modified time", async () => {
    const store = storeFor(await newBucket());
    const keys = [1, 2, 3].map(() => blobKey(randomUUIDv7(), randomUUIDv7()));
    const startedAt = Date.now();
    for (const key of keys) {
      await store.putBlob(streamOf(randomBytes(8)), { key, size: 8, contentType: "model/stl" });
    }

    const first = await store.listPage("models/", { maxKeys: 2 });
    expect(first.objects).toHaveLength(2);
    expect(first.next).toEqual(expect.any(String));
    const second = await store.listPage("models/", { token: first.next, maxKeys: 2 });
    expect(second.objects).toHaveLength(1);
    expect(second.next).toBeUndefined();

    const listed = [...first.objects, ...second.objects];
    expect(listed.map((o) => o.key).sort()).toEqual([...keys].sort());
    for (const o of listed) {
      expect(o.size).toBe(8);
      expect(o.lastModified).toBeInstanceOf(Date);
      // S3 keeps whole seconds; allow for that and for clock skew.
      expect(Math.abs((o.lastModified?.getTime() ?? 0) - startedAt)).toBeLessThan(120_000);
    }
  });

  it("an empty prefix lists no objects and no next page", async () => {
    const store = storeFor(await newBucket());
    expect(await store.listPage("models/")).toEqual({ objects: [], next: undefined });
  });
});

describe("readVersioning", () => {
  it("versioning off is reported as off (bucket created without versioning)", async () => {
    expect(await storeFor(await newBucket()).readVersioning()).toBe("off");
  });

  it("versioning enabled is reported as enabled", async () => {
    expect(await storeFor(await newBucket("Enabled")).readVersioning()).toBe("enabled");
  });

  it("versioning suspended is reported as suspended", async () => {
    expect(await storeFor(await newBucket("Suspended")).readVersioning()).toBe("suspended");
  });
});

describe("a stopped store", () => {
  it("a stopped store throws StoreUnavailable, not a 500-shaped error", async () => {
    const own = await startS3();
    const bucket = "platehouse-t5-stopped";
    await own.client.send(new CreateBucketCommand({ Bucket: bucket }));
    const store = createBlobStore(settingsFor(own, bucket), { maxAttempts: 1 });
    stores.push(store);
    const key = blobKey(randomUUIDv7(), randomUUIDv7());
    await store.putBlob(streamOf(randomBytes(8)), { key, size: 8, contentType: "model/stl" });
    const secret = own.secretAccessKey;
    await own.stop();

    // Each call starts only when it is awaited, so no rejection goes unhandled.
    const calls: Array<() => Promise<unknown>> = [
      () => store.putBlob(streamOf(randomBytes(8)), { key, size: 8, contentType: "model/stl" }),
      () => store.getBlobStream(key),
      () => store.listPrefix("models/"),
      () => store.deleteBlobs([key]),
      () => store.readVersioning(),
    ];
    for (const call of calls) {
      const err = await errorOf(call());
      expect(err).toBeInstanceOf(StoreUnavailable);
      expect(everyRendering(err)).not.toContain(secret);
    }
  });
});

describe("secrets in errors", () => {
  it("secret access key never appears in logged errors", async () => {
    const bucket = await newBucket();
    const wrong = ["wrong", "synthetic", "secret", randomBytes(6).toString("hex")].join("-");
    const store = createBlobStore(settingsFor(server(), bucket, wrong), { maxAttempts: 1 });
    stores.push(store);
    const key = blobKey(randomUUIDv7(), randomUUIDv7());

    const errors = [
      await errorOf(store.listPrefix("models/")),
      await errorOf(store.getBlobStream(key)),
      await errorOf(store.putBlob(streamOf(randomBytes(8)), { key, size: 8, contentType: "x/y" })),
      await errorOf(store.deleteBlobs([key])),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(StoreError);
      const text = everyRendering(err);
      expect(text).not.toContain(wrong);
      expect(text).not.toContain(server().secretAccessKey);
    }
  });
});
