// The storage layer's failure contract, checked against a scripted fake
// endpoint so it runs without Docker: which failures are StoreUnavailable
// (connect, timeout, a gateway with the store behind it down), which are not
// (404, access denied), what readVersioning makes of each, and that no error
// carries the secret access key in any form a log would print.
import { Readable } from "node:stream";
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import {
  BlobNotFound,
  type BlobStore,
  createBlobStore,
  StoreError,
  StoreUnavailable,
} from "../../src/storage/s3.js";
import {
  closedPortEndpoint,
  type Handler,
  s3Error,
  startBlackHole,
  startFakeS3,
  xml,
} from "./support/fake-s3.js";

// Synthetic values, joined from parts so that no source line looks like a
// credential.
const SECRET = ["synthetic", "secret", "never", "in", "an", "error", "4f1c"].join("-");
const ACCESS = ["SYNTH", "ACCESS", "ID"].join("");
const KEY = "models/0190f5a8-3c2e-7a4b-9c1d-2e3f4a5b6c7d/0190f5a8-3c2f-7d10-a2b3-c4d5e6f70819";
const KEY2 = "models/0190f5a8-3c2e-7a4b-9c1d-2e3f4a5b6c7d/0190f5a8-3c30-7e21-b3c4-d5e6f7081920";

function settings(endpoint: string): Config["s3"] {
  return {
    endpoint,
    region: "us-east-1",
    bucket: "platehouse-test",
    accessKeyId: ACCESS,
    secretAccessKey: SECRET,
    forcePathStyle: true,
  };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function storeAt(handler: Handler, maxAttempts = 1): Promise<BlobStore> {
  const fake = await startFakeS3(handler);
  cleanups.push(() => fake.close());
  const store = createBlobStore(settings(fake.endpoint), { maxAttempts });
  cleanups.push(() => store.destroy());
  return store;
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

// Every way an error reaches a log: message, stack, util.inspect (console and
// pino's serializer walk it) and JSON.
function everyRendering(err: Error): string {
  return [err.message, String(err.stack), inspect(err, { depth: 10 }), JSON.stringify(err)].join(
    "\n",
  );
}

// One call of each store operation, for the failure cases that apply to all.
const operations: Array<[name: string, call: (s: BlobStore) => Promise<unknown>]> = [
  [
    "putBlob",
    (s) =>
      s.putBlob(Readable.from([Buffer.from("abc")]), {
        key: KEY,
        size: 3,
        contentType: "model/stl",
      }),
  ],
  ["getBlobStream", (s) => s.getBlobStream(KEY)],
  ["deleteBlobs", (s) => s.deleteBlobs([KEY])],
  ["listPrefix", (s) => s.listPrefix("models/")],
  ["readVersioning", (s) => s.readVersioning()],
];

describe("a store that cannot be reached", () => {
  it.each(operations)("refused connection: %s throws StoreUnavailable", async (_name, call) => {
    const store = createBlobStore(settings(await closedPortEndpoint()), { maxAttempts: 1 });
    cleanups.push(() => store.destroy());
    const err = await errorOf(call(store));
    expect(err).toBeInstanceOf(StoreUnavailable);
    expect(err.name).toBe("StoreUnavailable");
    expect(everyRendering(err)).not.toContain(SECRET);
  });

  it.each(operations)(
    "no answer within the timeout: %s throws StoreUnavailable",
    async (_n, call) => {
      const hole = await startBlackHole();
      cleanups.push(() => hole.close());
      const store = createBlobStore(settings(hole.endpoint), {
        maxAttempts: 1,
        connectionTimeoutMs: 500,
        socketTimeoutMs: 500,
      });
      cleanups.push(() => store.destroy());
      const err = await errorOf(call(store));
      expect(err).toBeInstanceOf(StoreUnavailable);
      expect(everyRendering(err)).not.toContain(SECRET);
    },
  );

  it("an outage is retried up to maxAttempts times, then StoreUnavailable", async () => {
    let calls = 0;
    const store = await storeAt(() => {
      calls += 1;
      return s3Error(503, "ServiceUnavailable");
    }, 3);
    const err = await errorOf(store.listPrefix("models/"));
    expect(err).toBeInstanceOf(StoreUnavailable);
    expect(calls).toBe(3);
  });

  it.each([502, 503, 504])("HTTP %i from a gateway is StoreUnavailable", async (status) => {
    const store = await storeAt(() => s3Error(status, "ServiceUnavailable"));
    const err = await errorOf(store.listPrefix("models/"));
    expect(err).toBeInstanceOf(StoreUnavailable);
  });
});

describe("failures that are not an outage", () => {
  it("a missing object is BlobNotFound, never StoreUnavailable", async () => {
    const store = await storeAt(() =>
      s3Error(404, "NoSuchKey", "The specified key does not exist."),
    );
    const err = await errorOf(store.getBlobStream(KEY));
    expect(err).toBeInstanceOf(BlobNotFound);
    expect(err).not.toBeInstanceOf(StoreUnavailable);
  });

  it("access denied is a StoreError naming the S3 code, not StoreUnavailable", async () => {
    const store = await storeAt(() => s3Error(403, "AccessDenied", "Access Denied."));
    const err = await errorOf(store.listPrefix("models/"));
    expect(err).toBeInstanceOf(StoreError);
    expect(err).not.toBeInstanceOf(StoreUnavailable);
    expect((err as StoreError).code).toBe("AccessDenied");
    expect((err as StoreError).status).toBe(403);
  });

  it("a signature mismatch is a StoreError and carries no secret", async () => {
    // A provider's SignatureDoesNotMatch reply echoes request details back;
    // none of it may reach the error.
    const store = await storeAt(() =>
      s3Error(403, "SignatureDoesNotMatch", `string to sign mentions ${ACCESS} and ${SECRET}`),
    );
    const err = await errorOf(store.getBlobStream(KEY));
    expect(err).toBeInstanceOf(StoreError);
    expect(everyRendering(err)).not.toContain(SECRET);
  });

  it("a provider error code that is not a plain word is not copied into the error", async () => {
    // Plain text in <Code>, so the SDK passes it on as the error's code.
    const store = await storeAt(() => s3Error(400, `Bad code ${SECRET}`));
    const err = await errorOf(store.listPrefix("models/"));
    expect(err).toBeInstanceOf(StoreError);
    expect((err as StoreError).code).toBe("Unknown");
    expect(everyRendering(err)).not.toContain(SECRET);
  });

  it("a 404 for a missing bucket is a StoreError, not BlobNotFound", async () => {
    // A misnamed or deleted bucket answers GetObject with 404 too; that is a
    // broken setup, not a missing object.
    const store = await storeAt(() =>
      s3Error(404, "NoSuchBucket", "The specified bucket does not exist."),
    );
    const err = await errorOf(store.getBlobStream(KEY));
    expect(err).not.toBeInstanceOf(BlobNotFound);
    expect(err).toBeInstanceOf(StoreError);
    expect((err as StoreError).code).toBe("NoSuchBucket");
    expect((err as StoreError).status).toBe(404);
  });

  it("a delete the store partly refuses is a StoreError", async () => {
    const store = await storeAt(() =>
      xml(
        `<DeleteResult><Error><Key>${KEY}</Key><Code>AccessDenied</Code><Message>no</Message></Error></DeleteResult>`,
      ),
    );
    const err = await errorOf(store.deleteBlobs([KEY]));
    expect(err).toBeInstanceOf(StoreError);
    expect((err as StoreError).code).toBe("AccessDenied");
  });
});

// A source far bigger than one 5 MiB part, so lib-storage uploads it in parts
// and is still reading it when a part fails. Made lazily, a chunk at a time.
function largeSource(total: number): Readable {
  const chunk = Buffer.alloc(256 * 1024, 0x61);
  let sent = 0;
  return new Readable({
    read() {
      if (sent >= total) {
        this.push(null);
        return;
      }
      const n = Math.min(chunk.length, total - sent);
      sent += n;
      this.push(n === chunk.length ? chunk : chunk.subarray(0, n));
    },
  });
}

describe("putBlob when the store fails partway through a multipart upload", () => {
  const LARGE = 64 * 1024 * 1024;

  // The store takes part 1, then answers every later part with failure. When
  // a part fails, lib-storage stops reading and pipeline() tears the source
  // down with an error of its own (an AbortError on Node 26, a premature-close
  // error on others); that teardown must not stand in for the store's error.
  function multipartStore(failure: ReturnType<typeof s3Error>): Handler {
    return (req) => {
      if (req.method === "POST" && req.query.has("uploads")) {
        return xml(
          `<InitiateMultipartUploadResult><Bucket>platehouse-test</Bucket><Key>${KEY}</Key><UploadId>synthetic-upload</UploadId></InitiateMultipartUploadResult>`,
        );
      }
      if (req.method === "PUT" && req.query.has("partNumber")) {
        return req.query.get("partNumber") === "1"
          ? { status: 200, headers: { etag: '"synthetic-part-1"' } }
          : failure;
      }
      if (req.method === "DELETE") return { status: 204 };
      return s3Error(400, "UnexpectedRequest");
    };
  }

  it("an outage after the first part is StoreUnavailable, not the stream teardown", async () => {
    const store = await storeAt(multipartStore(s3Error(503, "ServiceUnavailable")));
    const err = await errorOf(
      store.putBlob(largeSource(LARGE), { key: KEY, size: LARGE, contentType: "model/stl" }),
    );
    expect(err).toBeInstanceOf(StoreUnavailable);
  });

  it("a part the store refuses after the first is a StoreError naming the S3 code", async () => {
    const store = await storeAt(multipartStore(s3Error(403, "AccessDenied")));
    const err = await errorOf(
      store.putBlob(largeSource(LARGE), { key: KEY, size: LARGE, contentType: "model/stl" }),
    );
    expect(err).toBeInstanceOf(StoreError);
    expect((err as StoreError).code).toBe("AccessDenied");
  });
});

describe("putBlob when the check after the upload fails", () => {
  it("deletes the uploaded object before it throws", async () => {
    const fake = await startFakeS3((req) => {
      if (req.method === "PUT") return { status: 200, headers: { etag: '"synthetic"' } };
      if (req.method === "HEAD") return { status: 403 };
      if (req.method === "DELETE") return { status: 204 };
      return s3Error(400, "UnexpectedRequest");
    });
    cleanups.push(() => fake.close());
    const store = createBlobStore(settings(fake.endpoint), { maxAttempts: 1 });
    cleanups.push(() => store.destroy());
    const err = await errorOf(
      store.putBlob(Readable.from([Buffer.from("abc")]), {
        key: KEY,
        size: 3,
        contentType: "model/stl",
      }),
    );
    expect(err).toBeInstanceOf(StoreError);
    expect((err as StoreError).operation).toBe("HeadObject");
    expect(fake.requests.map((r) => r.method)).toEqual(["PUT", "HEAD", "DELETE"]);
    expect(fake.requests[2]?.path).toBe(`/platehouse-test/${KEY}`);
  });
});

describe("readVersioning", () => {
  const status = (body: string) =>
    xml(
      `<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${body}</VersioningConfiguration>`,
    );

  it.each([
    { label: "Enabled", reply: status("<Status>Enabled</Status>"), want: "enabled" },
    { label: "Suspended", reply: status("<Status>Suspended</Status>"), want: "suspended" },
    { label: "no Status (never enabled)", reply: status(""), want: "off" },
    {
      label: "a Status no provider documents",
      reply: status("<Status>Sometimes</Status>"),
      want: "unknown",
    },
    { label: "access denied", reply: s3Error(403, "AccessDenied"), want: "unknown" },
    {
      label: "not implemented by the provider",
      reply: s3Error(501, "NotImplemented"),
      want: "unknown",
    },
  ] as const)("$label reads as $want", async ({ reply, want }) => {
    const store = await storeAt(() => reply);
    expect(await store.readVersioning()).toBe(want);
  });

  it("asks the configured bucket for its versioning state", async () => {
    const fake = await startFakeS3(() => status("<Status>Enabled</Status>"));
    cleanups.push(() => fake.close());
    const store = createBlobStore(settings(fake.endpoint), { maxAttempts: 1 });
    cleanups.push(() => store.destroy());
    await store.readVersioning();
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.method).toBe("GET");
    // Path-style, the bucket as the only path segment (the SDK adds a slash).
    expect(fake.requests[0]?.path).toBe("/platehouse-test/");
    expect(fake.requests[0]?.query.has("versioning")).toBe(true);
  });
});

describe("listPrefix", () => {
  it("follows continuation tokens until the listing ends", async () => {
    const pages: Record<string, string> = {
      "": `<IsTruncated>true</IsTruncated><NextContinuationToken>page2</NextContinuationToken><Contents><Key>${KEY}</Key><Size>3</Size></Contents>`,
      page2: `<IsTruncated>false</IsTruncated><Contents><Key>${KEY2}</Key><Size>5</Size></Contents>`,
    };
    const store = await storeAt((req) =>
      xml(
        `<ListBucketResult>${pages[req.query.get("continuation-token") ?? ""]}</ListBucketResult>`,
      ),
    );
    expect(await store.listPrefix("models/")).toEqual([
      { key: KEY, size: 3 },
      { key: KEY2, size: 5 },
    ]);
  });
});

describe("guards that need no store", () => {
  it("putBlob refuses a key outside the contract layout before any request", async () => {
    const fake = await startFakeS3(() => ({ status: 200 }));
    cleanups.push(() => fake.close());
    const store = createBlobStore(settings(fake.endpoint), { maxAttempts: 1 });
    cleanups.push(() => store.destroy());
    const err = await errorOf(
      store.putBlob(Readable.from([Buffer.from("x")]), {
        key: "models/someone/Benchy.3mf",
        size: 1,
        contentType: "model/3mf",
      }),
    );
    expect(err).toBeInstanceOf(TypeError);
    expect(fake.requests).toHaveLength(0);
  });

  it("deleteBlobs refuses a key outside the contract layout before any request", async () => {
    const fake = await startFakeS3(() => ({ status: 200 }));
    cleanups.push(() => fake.close());
    const store = createBlobStore(settings(fake.endpoint), { maxAttempts: 1 });
    cleanups.push(() => store.destroy());
    const err = await errorOf(store.deleteBlobs([KEY, "models/"]));
    expect(err).toBeInstanceOf(TypeError);
    expect(fake.requests).toHaveLength(0);
  });

  it("deleteBlobs with no keys sends nothing", async () => {
    const fake = await startFakeS3(() => ({ status: 200 }));
    cleanups.push(() => fake.close());
    const store = createBlobStore(settings(fake.endpoint), { maxAttempts: 1 });
    cleanups.push(() => store.destroy());
    await store.deleteBlobs([]);
    expect(fake.requests).toHaveLength(0);
  });

  it("a source stream that fails reaches the caller as its own error, not StoreUnavailable", async () => {
    const store = await storeAt(() => ({ status: 200 }));
    const failing = new Readable({
      read() {
        const err = Object.assign(new Error("synthetic read failure"), { code: "EIO" });
        this.destroy(err);
      },
    });
    const err = await errorOf(
      store.putBlob(failing, { key: KEY, size: 10, contentType: "model/stl" }),
    );
    expect(err).not.toBeInstanceOf(StoreUnavailable);
    expect((err as NodeJS.ErrnoException).code).toBe("EIO");
  });
});
