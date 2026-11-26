// The Range parser for downloads: one byte range, or nothing. Everything it
// cannot serve safely is ignored (the file goes out whole), never an error.
import { describe, expect, test } from "vitest";
import {
  ifRangeAllows,
  parseRange,
  type RangeChoice,
  rangePicker,
} from "../../src/delivery/range.js";

const U = "unsatisfiable" as const;

describe("parseRange", () => {
  const rows: Array<[unknown, number, RangeChoice]> = [
    ["bytes=0-9", 100, { start: 0, end: 9 }],
    ["bytes=90-", 100, { start: 90, end: 99 }],
    ["bytes=-10", 100, { start: 90, end: 99 }],
    ["bytes=-100", 100, { start: 0, end: 99 }],
    ["bytes=-1000", 100, { start: 0, end: 99 }],
    ["bytes=0-0", 100, { start: 0, end: 0 }],
    ["bytes=99-99", 100, { start: 99, end: 99 }],
    ["bytes=50-1000", 100, { start: 50, end: 99 }],
    ["bytes=50-99999999999999999999", 100, { start: 50, end: 99 }],
    ["bytes=100-", 100, U],
    ["bytes=100-200", 100, U],
    ["bytes=-0", 100, U],
    ["BYTES=0-9", 100, { start: 0, end: 9 }],
    ["Bytes=0-9", 100, { start: 0, end: 9 }],
    ["bytes= 0-9", 100, { start: 0, end: 9 }],
    ["bytes=0-9 \t", 100, { start: 0, end: 9 }],
    ["bytes=10-5", 100, undefined],
    ["bytes=10-5", 8, undefined],
    ["bytes=0-1,5-6", 100, undefined],
    ["bytes=0-1, 5-6", 100, undefined],
    ["bytes=0-1,", 100, undefined],
    ["items=0-9", 100, undefined],
    ["bytes 0-9", 100, undefined],
    ["bytes==0-9", 100, undefined],
    ["bytes=bytes=0-9", 100, undefined],
    ["bytes=-", 100, undefined],
    ["bytes=", 100, undefined],
    ["", 100, undefined],
    ["bytes=+1-2", 100, undefined],
    ["bytes=-+1", 100, undefined],
    ["bytes=1-2-3", 100, undefined],
    ["bytes=0x10-20", 100, undefined],
    ["bytes=١-٢", 100, undefined],
    ["bytes=99999999999999999999-", 100, undefined],
    ["bytes=-99999999999999999999", 100, undefined],
    ["bytes=0-9", 0, undefined],
    ["bytes=0-9", -5, undefined],
    ["bytes=0-9", 1.5, undefined],
    ["bytes=0-9", Number.NaN, undefined],
    [["bytes=0-9"], 100, undefined],
    [undefined, 100, undefined],
    [7, 100, undefined],
  ];
  test.each(rows)("%j with size %j gives %j", (header, size, expected) => {
    expect(parseRange(header, size)).toEqual(expected);
  });
});

describe("ifRangeAllows", () => {
  const tag = '"blob-1"';
  test("is true when the header is absent", () => {
    expect(ifRangeAllows(undefined, tag)).toBe(true);
    expect(ifRangeAllows(undefined, undefined)).toBe(true);
  });
  test("is true for the exact tag", () => {
    expect(ifRangeAllows(tag, tag)).toBe(true);
  });
  test("is true for the tag with surrounding spaces", () => {
    expect(ifRangeAllows(` ${tag} \t`, tag)).toBe(true);
  });
  test("is false for a weak tag", () => {
    expect(ifRangeAllows('W/"x"', '"x"')).toBe(false);
  });
  test("is false for a date", () => {
    expect(ifRangeAllows("Wed, 21 Oct 2015 07:28:00 GMT", tag)).toBe(false);
  });
  test("is false for another tag", () => {
    expect(ifRangeAllows('"blob-2"', tag)).toBe(false);
  });
  test("is false for any value when the record has no tag", () => {
    expect(ifRangeAllows(tag, undefined)).toBe(false);
  });
  test("is false for an array", () => {
    expect(ifRangeAllows([tag], tag)).toBe(false);
  });
});

describe("rangePicker", () => {
  const record = { size: 100, etag: '"b"' };
  test("is undefined for HEAD and POST", () => {
    expect(rangePicker({ range: "bytes=0-9" }, "HEAD")).toBeUndefined();
    expect(rangePicker({ range: "bytes=0-9" }, "POST")).toBeUndefined();
  });
  test("is undefined without a range header", () => {
    expect(rangePicker({}, "GET")).toBeUndefined();
    expect(rangePicker({ "if-range": '"b"' }, "GET")).toBeUndefined();
  });
  test("parses the range against the record's size", () => {
    expect(rangePicker({ range: "bytes=0-9" }, "GET")?.(record)).toEqual({
      start: 0,
      end: 9,
    });
  });
  test("parses when if-range matches the record's tag", () => {
    const pick = rangePicker({ range: "bytes=-10", "if-range": '"b"' }, "GET");
    expect(pick?.(record)).toEqual({ start: 90, end: 99 });
  });
  test("ignores the range when if-range does not match", () => {
    const pick = rangePicker({ range: "bytes=-10", "if-range": '"c"' }, "GET");
    expect(pick?.(record)).toBeUndefined();
  });
});

describe("never throws and never leaves [0, size)", () => {
  test("holds for 5,000 generated headers", () => {
    let seed = 0x2f6e2b1;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const alphabet = [..."bytes=0123456789-, \t+١"];
    const sizes = [1, 2, 7, 100, 2 ** 53 - 1];
    for (let i = 0; i < 5000; i++) {
      const length = Math.floor(next() * 20);
      let header = next() < 0.5 ? "bytes=" : "";
      for (let j = 0; j < length; j++) {
        header += alphabet[Math.floor(next() * alphabet.length)];
      }
      const size = sizes[i % sizes.length] as number;
      const got = parseRange(header, size);
      if (got === undefined || got === U) continue;
      expect(Number.isInteger(got.start), header).toBe(true);
      expect(Number.isInteger(got.end), header).toBe(true);
      expect(got.start, header).toBeGreaterThanOrEqual(0);
      expect(got.start, header).toBeLessThanOrEqual(got.end);
      expect(got.end, header).toBeLessThan(size);
    }
  });
});
