// The orphan sweep's guard (PR #49 review, round 1). The bucket is the only
// copy of the bytes, so a sweep run against a database that has lost its rows
// (an empty volume, a wrong DATABASE_URL, an older dump, a second instance on
// the same bucket) must delete nothing. The sweep refuses to delete when the
// blobs table holds no stored rows, or when a run would delete more than its
// limit: 10 objects, or a tenth of the objects it listed in the blob layout
// when that is more, and never more than 100.
import { describe, expect, test } from "vitest";
import {
  ORPHAN_DELETE_CAP,
  ORPHAN_DELETE_FLOOR,
  ORPHAN_DELETE_SHARE,
  orphanDeleteLimit,
  orphanRefusal,
} from "../../src/ingest/orphans.js";

describe("orphanDeleteLimit", () => {
  test("the limits are 10 objects, a tenth of those listed, and 100 at most", () => {
    expect(ORPHAN_DELETE_FLOOR).toBe(10);
    expect(ORPHAN_DELETE_SHARE).toBe(0.1);
    expect(ORPHAN_DELETE_CAP).toBe(100);
  });

  test.each([
    [0, 10],
    [7, 10],
    [100, 10],
    [109, 10],
    [250, 25],
    [999, 99],
    [1000, 100],
    [50_000, 100],
  ])("with %i objects listed in the blob layout a run may delete %i", (listed, limit) => {
    expect(orphanDeleteLimit(listed)).toBe(limit);
  });
});

describe("orphanRefusal", () => {
  test("allows a run whose orphans are within the limit while stored rows exist", () => {
    expect(orphanRefusal({ orphans: 10, inLayout: 40, hasStoredRows: true })).toBeUndefined();
    expect(orphanRefusal({ orphans: 25, inLayout: 250, hasStoredRows: true })).toBeUndefined();
  });

  test("refuses any delete when the blobs table holds no stored rows", () => {
    const reason = orphanRefusal({ orphans: 1, inLayout: 1, hasStoredRows: false });
    expect(reason).toContain("no stored rows");
  });

  test("refuses a run over its limit, naming the counts", () => {
    const reason = orphanRefusal({ orphans: 11, inLayout: 40, hasStoredRows: true });
    expect(reason).toContain("11 of 40");
    expect(reason).toContain("limit of 10");
  });

  test("refuses a run that would empty most of a large library", () => {
    expect(orphanRefusal({ orphans: 101, inLayout: 5000, hasStoredRows: true })).toContain(
      "limit of 100",
    );
    expect(orphanRefusal({ orphans: 4900, inLayout: 5000, hasStoredRows: true })).toBeDefined();
  });

  test("has nothing to refuse when there are no orphans", () => {
    expect(orphanRefusal({ orphans: 0, inLayout: 5000, hasStoredRows: false })).toBeUndefined();
  });
});
