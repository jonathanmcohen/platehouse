// The public API reads Upload-Metadata the way tus does (issue #473), so the
// model check in apiUploadHook and tus's own parse never disagree about what a
// header says: what tus refuses is not read here either.
import { Metadata } from "@tus/server";
import { describe, expect, test } from "vitest";
import { uploadMetadata } from "../../src/api/v1.js";

const b64 = (text: string) => Buffer.from(text).toString("base64");

describe("uploadMetadata", () => {
  test("reads keys and decoded values, and a key with no value as null", () => {
    const header = `filename ${b64("a.stl")},duplicates ${b64("skip")},flag`;
    expect(uploadMetadata(header)).toEqual(
      new Map<string, string | null>([
        ["filename", "a.stl"],
        ["duplicates", "skip"],
        ["flag", null],
      ]),
    );
  });

  test.each([
    ["a value that is not base64", "modelId !!!!"],
    ["a value whose length is not a multiple of 4", "modelId abc"],
    ["a repeated key", `filename ${b64("a.stl")},filename ${b64("b.stl")}`],
    ["a key with a non-ASCII character", `fil${String.fromCodePoint(0xe9)}name ${b64("a.stl")}`],
    ["an empty pair", `filename ${b64("a.stl")},`],
    ["extra spaces inside a pair", `filename  ${b64("a.stl")}`],
    ["an empty header", ""],
  ])("is undefined for %s, as tus refuses it", (_why, header) => {
    expect(() => Metadata.parse(header)).toThrow();
    expect(uploadMetadata(header)).toBeUndefined();
  });

  test("is undefined when the header is not a string", () => {
    expect(uploadMetadata(undefined)).toBeUndefined();
    expect(uploadMetadata(["a"])).toBeUndefined();
  });
});
