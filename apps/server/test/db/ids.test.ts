import { describe, expect, test } from "vitest";
import { isUuid, uuidv7 } from "../../src/db/ids.js";

// The bucket key contract wants model and blob ids as UUIDv7, lowercase and
// hyphenated (build plan, Bucket key layout). Every id the repositories mint
// comes from uuidv7().
const V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuidv7", () => {
  test("is lowercase, hyphenated, version 7 with the RFC 9562 variant", () => {
    for (let i = 0; i < 1000; i++) {
      expect(uuidv7()).toMatch(V7);
    }
  });

  test("carries the current Unix time in milliseconds in its first 48 bits", () => {
    const before = Date.now();
    const id = uuidv7();
    const after = Date.now();
    const ms = Number.parseInt(id.replaceAll("-", "").slice(0, 12), 16);
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(after);
  });

  test("puts the given time in the timestamp field", () => {
    const at = Date.UTC(2026, 10, 8, 12, 0, 0, 123);
    const id = uuidv7(at);
    expect(id.slice(0, 13)).toBe(
      `${at.toString(16).padStart(12, "0").slice(0, 8)}-${at.toString(16).padStart(12, "0").slice(8)}`,
    );
  });

  test("ids minted in later milliseconds sort after earlier ones", () => {
    const a = uuidv7(1_000);
    const b = uuidv7(1_001);
    expect(a < b).toBe(true);
  });

  test("does not repeat across many ids in the same millisecond", () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => uuidv7(42)));
    expect(ids.size).toBe(10_000);
  });

  test("refuses a time outside 0 to 2^48 - 1 ms", () => {
    expect(() => uuidv7(-1)).toThrow(RangeError);
    expect(() => uuidv7(2 ** 48)).toThrow(RangeError);
    expect(() => uuidv7(1.5)).toThrow(RangeError);
  });
});

// Repositories answer "not found" for an id that is not a uuid, instead of
// sending it to Postgres and getting an invalid-input error back.
describe("isUuid", () => {
  test("accepts a uuid in either case", () => {
    expect(isUuid(uuidv7())).toBe(true);
    expect(isUuid(uuidv7().toUpperCase())).toBe(true);
    expect(isUuid("00000000-0000-0000-0000-000000000000")).toBe(true);
  });

  test.each([
    "",
    "not-a-uuid",
    "../etc/passwd",
    "0190f3a1-7c2b-7d4e-8f00-12345678901",
    "0190f3a1-7c2b-7d4e-8f00-1234567890123",
    " 0190f3a1-7c2b-7d4e-8f00-123456789012",
    "0190f3a1-7c2b-7d4e-8f00-123456789012\n",
    "{0190f3a1-7c2b-7d4e-8f00-123456789012}",
    "0190f3a17c2b7d4e8f00123456789012",
    "0190f3a1-7c2b-7d4e-8f00-12345678901g",
  ])("refuses %j", (value) => {
    expect(isUuid(value)).toBe(false);
  });
});
