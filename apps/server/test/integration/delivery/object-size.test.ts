// Build plan Task 17, PR #156 security review: delivery compares an object's
// real size with the recorded one before it sends a header, so the stream
// getBlobStream returns carries the size the store answered GetObject with
// (objectSize). Checked here against the real S3 test server, including an
// object overwritten under the same key, as a restored older version or a
// write behind the app's back would leave it.
//
// Every byte here is random; nothing is a designer file or a real secret.
import { randomBytes, randomUUIDv7 } from "node:crypto";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { CreateBucketCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { blobKey } from "../../../src/storage/keys.js";
import { type BlobStore, createBlobStore, objectSize } from "../../../src/storage/s3.js";
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

async function newStore(): Promise<{ bucket: string; store: BlobStore }> {
  const bucket = `platehouse-t17-${randomBytes(4).toString("hex")}`;
  await server().client.send(new CreateBucketCommand({ Bucket: bucket }));
  const target = server();
  const store = createBlobStore({
    endpoint: target.endpoint,
    region: target.region,
    bucket,
    accessKeyId: target.accessKeyId,
    secretAccessKey: target.secretAccessKey,
    forcePathStyle: true,
  });
  stores.push(store);
  return { bucket, store };
}

describe("getBlobStream", () => {
  it("reports the stored object's size, also after the object is overwritten", async () => {
    const { bucket, store } = await newStore();
    const key = blobKey(randomUUIDv7(), randomUUIDv7());
    await store.putBlob(Readable.from([randomBytes(1234)]), {
      key,
      size: 1234,
      contentType: "model/stl",
    });
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
});
