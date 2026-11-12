// The orphan sweep's guard (PR #49 review, round 1). The bucket is the only
// copy of the bytes, so a sweep run against a database that has lost its rows
// (an empty volume, a wrong DATABASE_URL, an older dump, a second instance on
// the same bucket) must delete nothing. The sweep refuses to delete when the
// blobs table holds no stored rows, or when a run would delete more than its
// limit: 10 objects, or a tenth of the objects it listed in the blob layout
// when that is more, and never more than 100.
import type { Kysely } from "kysely";
import { afterEach, describe, expect, test, vi } from "vitest";
import { uuidv7 } from "../../src/db/ids.js";
import type { DB } from "../../src/db/types.js";
import {
  createOrphanSweep,
  ORPHAN_DELETE_CAP,
  ORPHAN_DELETE_FLOOR,
  ORPHAN_DELETE_SHARE,
  ORPHAN_MIN_AGE_MS,
  type OrphanStore,
  orphanDeleteLimit,
  orphanRefusal,
} from "../../src/ingest/orphans.js";
import { blobKey } from "../../src/storage/keys.js";

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

// Issue #54: a refused run is a sign to look at the database, so its line
// must stand out from the daily one. It goes to console.warn, where the daily
// line goes to console.info; main.ts passes neither hook, so these defaults
// are what the running server does.
describe("where a run's line goes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * The two blobs queries the sweep makes: no row has any listed key, and the
   * table holds a stored row only when storedRows is set.
   */
  function fakeDb(storedRows: boolean): Kysely<DB> {
    const query = {
      select: () => query,
      where: () => query,
      limit: () => query,
      execute: async () => [],
      executeTakeFirst: async () => (storedRows ? { id: uuidv7() } : undefined),
    };
    return { selectFrom: () => query } as unknown as Kysely<DB>;
  }

  /** A bucket holding `count` objects in the blob layout, all over 24 hours old. */
  function fakeStore(count: number): { store: OrphanStore; deleted: string[] } {
    const lastModified = new Date(Date.now() - 2 * ORPHAN_MIN_AGE_MS);
    const objects = Array.from({ length: count }, () => ({
      key: blobKey(uuidv7(), uuidv7()),
      size: 1,
      lastModified,
    }));
    const deleted: string[] = [];
    const store: OrphanStore = {
      listPage: async () => ({ objects, next: undefined }),
      deleteBlobs: async (keys) => {
        deleted.push(...keys);
      },
    };
    return { store, deleted };
  }

  function catchConsole(): { info: string[]; warn: string[] } {
    const lines = { info: [] as string[], warn: [] as string[] };
    vi.spyOn(console, "info").mockImplementation((line: unknown) => {
      lines.info.push(String(line));
    });
    vi.spyOn(console, "warn").mockImplementation((line: unknown) => {
      lines.warn.push(String(line));
    });
    return lines;
  }

  test("a run refused because the blobs table holds no stored rows goes to console.warn", async () => {
    const lines = catchConsole();
    const { store, deleted } = fakeStore(3);
    const result = await createOrphanSweep({ db: fakeDb(false), store }).sweepOrphans(new Date());
    expect(result.refused).toContain("no stored rows");
    expect(deleted).toEqual([]);
    expect(lines.info).toEqual([]);
    expect(lines.warn).toHaveLength(1);
    expect(lines.warn[0]).toContain("deleted nothing");
    expect(lines.warn[0]).toContain("no stored rows");
  });

  test("a run refused for going over its limit goes to console.warn", async () => {
    const lines = catchConsole();
    const { store, deleted } = fakeStore(ORPHAN_DELETE_FLOOR + 1);
    const result = await createOrphanSweep({ db: fakeDb(true), store }).sweepOrphans(new Date());
    expect(result.refused).toContain(`limit of ${ORPHAN_DELETE_FLOOR}`);
    expect(deleted).toEqual([]);
    expect(lines.info).toEqual([]);
    expect(lines.warn).toHaveLength(1);
    expect(lines.warn[0]).toContain("deleted nothing");
  });

  test("a run that deletes its orphans goes to console.info and warns nothing", async () => {
    const lines = catchConsole();
    const { store, deleted } = fakeStore(3);
    const result = await createOrphanSweep({ db: fakeDb(true), store }).sweepOrphans(new Date());
    expect(result.refused).toBeUndefined();
    expect(deleted).toHaveLength(3);
    expect(lines.warn).toEqual([]);
    expect(lines.info).toHaveLength(1);
    expect(lines.info[0]).toContain("deleted 3");
  });
});
