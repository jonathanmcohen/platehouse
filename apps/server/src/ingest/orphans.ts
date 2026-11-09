// The orphan sweep (PR #49 review). An object under models/ can be left with
// no blob row: ingest puts its objects before the transaction that writes
// their rows, so a process that dies in between leaves them behind, and so
// does a failed ingest whose cleanup delete fails too (a store outage) or is
// skipped because the database could not say whether the rows committed. For
// a new model no purge ever reaches models/<modelId>/, and the AC-010
// reconciliation only counts. This sweep removes them.
//
// It lists models/ a page at a time and deletes an object only when all of
// these hold:
// - its key is in the blob layout, models/<modelId>/<blobId> (any other key
//   is left alone and counted: the app never deletes a key outside the
//   layout, as with a purge);
// - it was last written more than 24 hours before now, so an ingest still
//   uploading or about to commit is never touched;
// - no blob row, stored or pending, has its key, checked after the page is
//   listed.
// A key already gone is not an error, so a run that fails part way is
// finished by the next one. Each run logs one line of counts. It runs daily
// on the maintenance queue (jobs/queues.ts).
//
// The bucket is the only copy of the bytes, and "no blob row" is the sweep's
// only test, so a database that has lost its rows (an empty volume, a wrong
// DATABASE_URL, a restore from an older dump, a second instance on the same
// bucket) would make every object look like an orphan. So the sweep lists the
// whole prefix first and deletes nothing, logging why, when either holds:
// - the blobs table holds no stored rows;
// - the run would delete more than its limit: ORPHAN_DELETE_FLOOR objects, or
//   ORPHAN_DELETE_SHARE of the objects it listed in the blob layout when that
//   is more, and never more than ORPHAN_DELETE_CAP.
// Orphans are rare (a process that died mid-ingest), so a refused run is a
// sign to look at the database before anything is deleted.
import type { Kysely } from "kysely";
import type { DB } from "../db/types.js";
import { isBlobKey } from "../storage/keys.js";
import type { BlobStore } from "../storage/s3.js";

/** How old an object with no blob row must be before the sweep deletes it. */
export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** A run may always delete this many orphans... */
export const ORPHAN_DELETE_FLOOR = 10;
/** ...or this share of the objects it listed in the blob layout, when that is more... */
export const ORPHAN_DELETE_SHARE = 0.1;
/** ...but never more than this many. */
export const ORPHAN_DELETE_CAP = 100;

const PREFIX = "models/";

/** How many orphans one run may delete, given the objects it listed in the blob layout. */
export function orphanDeleteLimit(inLayout: number): number {
  const share = Math.floor(inLayout * ORPHAN_DELETE_SHARE);
  return Math.min(ORPHAN_DELETE_CAP, Math.max(ORPHAN_DELETE_FLOOR, share));
}

/** Why a run must delete nothing, or undefined when it may delete its orphans. */
export function orphanRefusal(run: {
  orphans: number;
  inLayout: number;
  hasStoredRows: boolean;
}): string | undefined {
  if (run.orphans === 0) return undefined;
  if (!run.hasStoredRows) {
    return (
      "the blobs table holds no stored rows, so the database may have lost its rows or not " +
      "be this library's; check DATABASE_URL and the database"
    );
  }
  const limit = orphanDeleteLimit(run.inLayout);
  if (run.orphans > limit) {
    return (
      `it would delete ${run.orphans} of ${run.inLayout} objects in the key layout, over the ` +
      `limit of ${limit} a run may delete; check the database before deleting them`
    );
  }
  return undefined;
}

/** The store calls the sweep makes. */
export type OrphanStore = Pick<BlobStore, "listPage" | "deleteBlobs">;

export interface OrphanSweepResult {
  /** Objects listed under models/. */
  listed: number;
  /** Objects deleted: in the blob layout, no blob row, older than 24 hours. */
  deleted: number;
  /** Keys under models/ outside the blob layout, left alone. */
  outsideLayout: number;
  /** Objects found in the blob layout with no blob row, older than 24 hours. */
  orphans: number;
  /** Why the run deleted nothing although it found orphans; undefined when it did not refuse. */
  refused?: string;
}

function logLine(r: OrphanSweepResult): string {
  if (r.refused !== undefined) {
    return (
      `orphan sweep: listed ${r.listed} objects under ${PREFIX}, found ${r.orphans} with no ` +
      `blob row older than 24 hours and deleted nothing: ${r.refused}`
    );
  }
  return (
    `orphan sweep: listed ${r.listed} objects under ${PREFIX}, deleted ${r.deleted} with no ` +
    `blob row older than 24 hours, left ${r.outsideLayout} outside the key layout`
  );
}

export function createOrphanSweep(deps: {
  db: Kysely<DB>;
  store: OrphanStore;
  /** Where the run's line goes; console.info when left out. */
  log?: (line: string) => void;
  /** Objects per listing page; the store's own limit (1000 on S3) when left out. */
  pageSize?: number;
}) {
  const { db, store, pageSize } = deps;
  const log = deps.log ?? ((line: string) => console.info(line));
  if (pageSize !== undefined && (!Number.isSafeInteger(pageSize) || pageSize < 1)) {
    throw new RangeError("pageSize must be a whole number of 1 or more");
  }

  /**
   * Deletes the objects with no blob row that were last written over 24 hours
   * before now, unless the guard refuses the run (see the file comment).
   */
  async function sweepOrphans(now: Date): Promise<OrphanSweepResult> {
    const cutoff = now.getTime() - ORPHAN_MIN_AGE_MS;
    const result: OrphanSweepResult = { listed: 0, deleted: 0, outsideLayout: 0, orphans: 0 };
    try {
      // The whole prefix is listed before anything is deleted, so the guard
      // sees the run's full count.
      const orphans: string[] = [];
      let inLayout = 0;
      let token: string | undefined;
      do {
        const page = await store.listPage(PREFIX, {
          token,
          ...(pageSize === undefined ? {} : { maxKeys: pageSize }),
        });
        result.listed += page.objects.length;
        const old: string[] = [];
        for (const o of page.objects) {
          if (!isBlobKey(o.key)) {
            result.outsideLayout += 1;
            continue;
          }
          inLayout += 1;
          if (o.lastModified !== undefined && o.lastModified.getTime() < cutoff) old.push(o.key);
        }
        if (old.length > 0) {
          const rows = await db.selectFrom("blobs").select("key").where("key", "in", old).execute();
          const known = new Set(rows.map((r) => r.key));
          for (const key of old) if (!known.has(key)) orphans.push(key);
        }
        token = page.next;
      } while (token !== undefined);
      result.orphans = orphans.length;

      if (orphans.length > 0) {
        const stored = await db
          .selectFrom("blobs")
          .select("id")
          .where("state", "=", "stored")
          .limit(1)
          .executeTakeFirst();
        const refused = orphanRefusal({
          orphans: orphans.length,
          inLayout,
          hasStoredRows: stored !== undefined,
        });
        if (refused !== undefined) {
          result.refused = refused;
        } else {
          await store.deleteBlobs(orphans);
          result.deleted = orphans.length;
        }
      }
    } catch (error) {
      log(`${logLine(result)}; stopped by an error, the next run finishes it`);
      throw error;
    }
    log(logLine(result));
    return result;
  }

  return { sweepOrphans };
}

export type OrphanSweep = ReturnType<typeof createOrphanSweep>;
