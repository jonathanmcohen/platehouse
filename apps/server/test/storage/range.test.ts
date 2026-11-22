// getBlobRange (#357): part of an object, for the description re-conversion,
// which reads a .3mf's MakerWorld text without downloading the whole file.
// Checked against the scripted fake endpoint, so it runs without Docker; the
// failure cases every operation shares are in store-errors.test.ts.
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import { BlobNotFound, createBlobStore, StoreError } from "../../src/storage/s3.js";
import { type Handler, s3Error, startFakeS3 } from "./support/fake-s3.js";

const KEY = "models/0190f5a8-3c2e-7a4b-9c1d-2e3f4a5b6c7d/0190f5a8-3c2f-7d10-a2b3-c4d5e6f70819";

function settings(endpoint: string): Config["s3"] {
  return {
    endpoint,
    region: "us-east-1",
    bucket: "platehouse-test",
    accessKeyId: ["SYNTH", "ACCESS", "ID"].join(""),
    secretAccessKey: ["synthetic", "range", "secret"].join("-"),
    forcePathStyle: true,
  };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function fakeAt(handler: Handler) {
  const fake = await startFakeS3(handler);
  cleanups.push(() => fake.close());
  const store = createBlobStore(settings(fake.endpoint), { maxAttempts: 1 });
  cleanups.push(() => store.destroy());
  return { fake, store };
}

async function text(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

describe("getBlobRange", () => {
  it("asks for the bytes from start up to, not including, end, and returns them", async () => {
    const { fake, store } = await fakeAt(() => ({
      status: 206,
      headers: { "content-type": "application/octet-stream", "content-range": "bytes 10-14/100" },
      body: "hello",
    }));
    expect(await text(await store.getBlobRange(KEY, 10, 15))).toBe("hello");
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.method).toBe("GET");
    expect(fake.requests[0]?.path).toBe(`/platehouse-test/${KEY}`);
    expect(fake.requests[0]?.headers.range).toBe("bytes=10-14");
  });

  it("is BlobNotFound when the key does not exist", async () => {
    const { store } = await fakeAt(() => s3Error(404, "NoSuchKey"));
    await expect(store.getBlobRange(KEY, 0, 10)).rejects.toBeInstanceOf(BlobNotFound);
  });

  it("is a StoreError when the store refuses the range", async () => {
    const { store } = await fakeAt(() => s3Error(416, "InvalidRange"));
    await expect(store.getBlobRange(KEY, 0, 10)).rejects.toBeInstanceOf(StoreError);
  });

  it.each([
    ["a negative start", -1, 10],
    ["an end before the start", 10, 5],
    ["an empty range", 5, 5],
    ["a fraction", 0.5, 10],
  ])("refuses %s before it sends anything", async (_why, start, end) => {
    const { fake, store } = await fakeAt(() => ({ status: 206, body: "" }));
    await expect(store.getBlobRange(KEY, start, end)).rejects.toThrow(RangeError);
    expect(fake.requests).toHaveLength(0);
  });
});
