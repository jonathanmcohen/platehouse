// Build plan Task 17, PR #156 security review: delivery compares an object's
// real size with the recorded one before it sends a header, so the stream
// carries the Content-Length the store answered GetObject with. Checked here
// against the storage tests' scripted fake endpoint, so this file needs no
// Docker, and for a stream the store did not open.
//
// Every value here is synthetic, joined from parts so that no source line
// looks like a credential.
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  type BlobStore,
  createBlobStore,
  objectSize,
  reportObjectSize,
} from "../../../src/storage/s3.js";
import { type Handler, startFakeS3 } from "../../storage/support/fake-s3.js";

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
