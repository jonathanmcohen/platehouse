// The library's numbered pages (GET /app/api/library?page=), the arithmetic
// alone: which slice of the matches a page is, how many pages there are, and
// what a page past the end or a bad page size becomes. The database side
// (filters, trash, the total) is in test/integration/app-api/library.test.ts.
import { describe, expect, test } from "vitest";
import {
  LIBRARY_PAGE_SIZE,
  PAGED_MATCH_CAP,
  pageSizeFor,
  pageWindow,
} from "../../src/app-api/library.js";

describe("pageWindow", () => {
  test("page 1 of 171 models at 48 a page is the first 48, of 4 pages", () => {
    expect(pageWindow({ total: 171, pageSize: 48, page: 1 })).toEqual({
      page: 1,
      pageCount: 4,
      start: 0,
      end: 48,
    });
  });

  test("the last page holds the remainder", () => {
    expect(pageWindow({ total: 171, pageSize: 48, page: 4 })).toEqual({
      page: 4,
      pageCount: 4,
      start: 144,
      end: 171,
    });
  });

  test("a page past the end is the last page, never an empty one", () => {
    expect(pageWindow({ total: 171, pageSize: 48, page: 9 })).toEqual({
      page: 4,
      pageCount: 4,
      start: 144,
      end: 171,
    });
  });

  test("a total that fills its pages exactly has no extra empty page", () => {
    expect(pageWindow({ total: 96, pageSize: 48, page: 3 })).toEqual({
      page: 2,
      pageCount: 2,
      start: 48,
      end: 96,
    });
  });

  test("no matches is one empty page 1", () => {
    expect(pageWindow({ total: 0, pageSize: 48, page: 5 })).toEqual({
      page: 1,
      pageCount: 1,
      start: 0,
      end: 0,
    });
  });

  test("a page below 1 or not a whole number is page 1, or rounded down", () => {
    expect(pageWindow({ total: 171, pageSize: 48, page: 0 }).page).toBe(1);
    expect(pageWindow({ total: 171, pageSize: 48, page: -3 }).page).toBe(1);
    expect(pageWindow({ total: 171, pageSize: 48, page: 2.7 }).page).toBe(2);
    expect(pageWindow({ total: 171, pageSize: 48, page: Number.NaN }).page).toBe(1);
  });
});

describe("pageSizeFor", () => {
  test("defaults to the library's 48 and stays within 1 to 200", () => {
    expect(LIBRARY_PAGE_SIZE).toBe(48);
    expect(pageSizeFor(undefined)).toBe(48);
    expect(pageSizeFor(200)).toBe(200);
    expect(pageSizeFor(500)).toBe(200);
    expect(pageSizeFor(0)).toBe(1);
    expect(pageSizeFor(12.9)).toBe(12);
  });
});

test("the paged match cap is searchRanked's own most, 1000", () => {
  // One ranked query reads at most this many matches per request; the
  // library's numbered pages and View all stop there and say so.
  expect(PAGED_MATCH_CAP).toBe(1000);
});
