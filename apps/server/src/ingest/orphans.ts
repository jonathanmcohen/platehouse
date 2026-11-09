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
import type { Kysely } from "kysely";
import type { DB } from "../db/types.js";
import { isBlobKey } from "../storage/keys.js";
import type { BlobStore } from "../storage/s3.js";

/** How old an object with no blob row must be before the sweep deletes it. */
export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

const PREFIX = "models/";

/** The store calls the sweep makes. */
export type OrphanStore = Pick<BlobStore, "listPage" | "deleteBlobs">;

export interface OrphanSweepResult {
  /** Objects listed under models/. */
  listed: number;
  /** Objects deleted: in the blob layout, no blob row, older than 24 hours. */
  deleted: number;
  /** Keys under models/ outside the blob layout, left alone. */
  outsideLayout: number;
}

function logLine(r: OrphanSweepResult): string {
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

  /** Deletes the objects with no blob row that were last written over 24 hours before now. */
  async function sweepOrphans(now: Date): Promise<OrphanSweepResult> {
    const cutoff = now.getTime() - ORPHAN_MIN_AGE_MS;
    const result: OrphanSweepResult = { listed: 0, deleted: 0, outsideLayout: 0 };
    try {
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
          } else if (o.lastModified !== undefined && o.lastModified.getTime() < cutoff) {
            old.push(o.key);
          }
        }
        if (old.length > 0) {
          const rows = await db.selectFrom("blobs").select("key").where("key", "in", old).execute();
          const known = new Set(rows.map((r) => r.key));
          const orphans = old.filter((key) => !known.has(key));
          if (orphans.length > 0) {
            await store.deleteBlobs(orphans);
            result.deleted += orphans.length;
          }
        }
        token = page.next;
      } while (token !== undefined);
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
