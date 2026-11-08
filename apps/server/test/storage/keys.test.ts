import { describe, expect, it } from "vitest";
import { blobKey, isBlobKey } from "../../src/storage/keys.js";

// Hand-written UUIDv7 literals (version nibble 7, variant 8-b), lowercase.
const MODEL = "0190f5a8-3c2e-7a4b-9c1d-2e3f4a5b6c7d";
const BLOB = "0190f5a8-3c2f-7d10-a2b3-c4d5e6f70819";

describe("blobKey", () => {
  it("blobKey has no user text and matches models/<uuid>/<uuid>", () => {
    expect(blobKey(MODEL, BLOB)).toBe(
      "models/0190f5a8-3c2e-7a4b-9c1d-2e3f4a5b6c7d/0190f5a8-3c2f-7d10-a2b3-c4d5e6f70819",
    );
  });

  it("builds a key from ids made by crypto.randomUUIDv7", async () => {
    const { randomUUIDv7 } = await import("node:crypto");
    const model = randomUUIDv7();
    const blob = randomUUIDv7();
    expect(blobKey(model, blob)).toBe(`models/${model}/${blob}`);
  });

  // Anything that is not a lowercase hyphenated UUIDv7 could carry user text,
  // a path segment or an extension into the bucket, so it is refused.
  const notIds: Array<[label: string, value: string]> = [
    ["a file name", "Air Dry - AMS.3mf"],
    ["a path escape", "../0190f5a8-3c2f-7d10-a2b3-c4d5e6f70819"],
    ["a slash", "0190f5a8-3c2f-7d10-a2b3/c4d5e6f70819"],
    ["uppercase hex", "0190F5A8-3C2F-7D10-A2B3-C4D5E6F70819"],
    ["a UUIDv4", "9b2e4f1c-6a3d-4e8b-9f0a-1c2d3e4f5a6b"],
    ["a bad variant", "0190f5a8-3c2f-7d10-c2b3-c4d5e6f70819"],
    ["no hyphens", "0190f5a83c2f7d10a2b3c4d5e6f70819"],
    ["braces", "{0190f5a8-3c2f-7d10-a2b3-c4d5e6f70819}"],
    ["a trailing newline", "0190f5a8-3c2f-7d10-a2b3-c4d5e6f70819\n"],
    ["an extension", "0190f5a8-3c2f-7d10-a2b3-c4d5e6f70819.stl"],
    ["empty", ""],
  ];

  it.each(notIds)("refuses %s as the model id", (_label, value) => {
    expect(() => blobKey(value, BLOB)).toThrow(TypeError);
  });

  it.each(notIds)("refuses %s as the blob id", (_label, value) => {
    expect(() => blobKey(MODEL, value)).toThrow(TypeError);
  });

  it("names neither id in its error, only which argument failed", () => {
    expect(() => blobKey("Benchy by someone.3mf", BLOB)).toThrow(/modelId/);
    try {
      blobKey("Benchy by someone.3mf", BLOB);
    } catch (err) {
      expect(String(err)).not.toContain("Benchy");
    }
  });
});

describe("isBlobKey", () => {
  it("accepts a key in the contract layout", () => {
    expect(isBlobKey(`models/${MODEL}/${BLOB}`)).toBe(true);
  });

  it.each([
    ["no prefix", `${MODEL}/${BLOB}`],
    ["another prefix", `thumbs/${MODEL}/${BLOB}`],
    ["an extension", `models/${MODEL}/${BLOB}.3mf`],
    ["a third segment", `models/${MODEL}/${BLOB}/x`],
    ["a model prefix only", `models/${MODEL}/`],
    ["a file name", `models/${MODEL}/Air Dry - AMS.3mf`],
    ["a leading slash", `/models/${MODEL}/${BLOB}`],
    ["uppercase", `models/${MODEL.toUpperCase()}/${BLOB}`],
  ])("refuses %s", (_label, key) => {
    expect(isBlobKey(key)).toBe(false);
  });
});
