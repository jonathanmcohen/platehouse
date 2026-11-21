// storeRefusalOf's split of a store that answered and refused (issue #102)
// into a refusal a pg-boss retry may clear ("retry") and one it cannot
// ("final"). Throttling and request timeouts are answered with a 4xx by
// S3 and several S3-compatible stores, and pass once the store catches up,
// so they are "retry" like a 5xx; a refusal that names the request or the
// setup as wrong is "final". These cases start no container; they sit with
// the render tests under test/integration/derived/, where build plan Task 13
// puts its tests.
import { describe, expect, it } from "vitest";
import { storeRefusalOf } from "../../../src/derived/derived.js";
import { BlobNotFound, StoreError, StoreUnavailable } from "../../../src/storage/errors.js";

describe("storeRefusalOf", () => {
  it.each([
    ["InternalError", 500],
    ["ServiceUnavailable", 501],
    ["Unknown", undefined],
  ] as const)("a %s (HTTP %s) is left to pg-boss to retry", (code, status) => {
    expect(storeRefusalOf(new StoreError("GetObject", code, status))).toBe("retry");
  });

  it.each([
    ["TooManyRequests", 429],
    ["SlowDown", 429],
    ["RequestTimeout", 408],
    ["RequestTimeout", 400],
    ["SlowDown", 400],
  ] as const)(
    "a throttled or timed-out request (%s, HTTP %s) is left to pg-boss to retry",
    (code, status) => {
      expect(storeRefusalOf(new StoreError("PutObject", code, status))).toBe("retry");
    },
  );

  it.each([
    ["AccessDenied", 403],
    ["NoSuchBucket", 404],
    ["InvalidArgument", 400],
    ["EntityTooLarge", 400],
  ] as const)("a %s (HTTP %s) ends the render at once", (code, status) => {
    expect(storeRefusalOf(new StoreError("PutObject", code, status))).toBe("final");
  });

  it("a source object that is gone ends the render at once", () => {
    expect(storeRefusalOf(new BlobNotFound("GetObject"))).toBe("final");
  });

  it("an unreachable store or any other error is not a refusal", () => {
    expect(storeRefusalOf(new StoreUnavailable("GetObject", "HTTP 503"))).toBeNull();
    expect(storeRefusalOf(new Error("something else"))).toBeNull();
  });
});
