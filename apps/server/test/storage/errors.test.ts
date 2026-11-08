// toStoreError's classification over error shapes the SDK and Node produce,
// built by hand so each shape is pinned whatever the local network does.
import { describe, expect, it } from "vitest";
import {
  BlobNotFound,
  StoreError,
  StoreUnavailable,
  toStoreError,
} from "../../src/storage/errors.js";

function sysError(code: string): Error {
  return Object.assign(new Error(`synthetic ${code}`), { code });
}

function s3Failure(name: string, status: number): Error {
  return Object.assign(new Error("synthetic"), { name, $metadata: { httpStatusCode: status } });
}

describe("toStoreError", () => {
  it.each(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EHOSTUNREACH"])(
    "a socket error %s is StoreUnavailable",
    (code) => {
      expect(toStoreError(sysError(code), "GetObject")).toBeInstanceOf(StoreUnavailable);
    },
  );

  it("an AggregateError from a dual-stack connect is StoreUnavailable", () => {
    // Node raises this when every address of a name (::1 and 127.0.0.1 for
    // localhost) refuses, and the outer error need not carry a code.
    const err = new AggregateError([sysError("ECONNREFUSED"), sysError("ECONNREFUSED")]);
    const mapped = toStoreError(err, "ListObjectsV2");
    expect(mapped).toBeInstanceOf(StoreUnavailable);
    expect((mapped as StoreUnavailable).reason).toBe("ECONNREFUSED");
  });

  it("a socket error wrapped as a cause is StoreUnavailable", () => {
    const err = new Error("outer", { cause: sysError("ECONNRESET") });
    expect(toStoreError(err, "PutObject")).toBeInstanceOf(StoreUnavailable);
  });

  it("the SDK's TimeoutError is StoreUnavailable", () => {
    const err = Object.assign(new Error("socket timed out"), { name: "TimeoutError" });
    expect(toStoreError(err, "GetObject")).toBeInstanceOf(StoreUnavailable);
  });

  it("a 404 is BlobNotFound only where the caller allows it", () => {
    const err = s3Failure("NoSuchKey", 404);
    expect(toStoreError(err, "GetObject", { notFound: true })).toBeInstanceOf(BlobNotFound);
    const plain = toStoreError(err, "HeadObject");
    expect(plain).toBeInstanceOf(StoreError);
    expect((plain as StoreError).code).toBe("NoSuchKey");
  });

  it("an error that is not an object is a StoreError with code Unknown", () => {
    const mapped = toStoreError("a string was thrown", "GetObject");
    expect(mapped).toBeInstanceOf(StoreError);
    expect((mapped as StoreError).code).toBe("Unknown");
  });
});
