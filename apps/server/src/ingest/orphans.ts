// The orphan sweep (PR #49 review): deletes objects under models/ that have
// no blob row and are older than 24 hours. Not implemented yet.
import type { Kysely } from "kysely";
import type { DB } from "../db/types.js";
import type { BlobStore } from "../storage/s3.js";

/** How old an object with no blob row must be before the sweep deletes it. */
export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

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

export function createOrphanSweep(_deps: {
  db: Kysely<DB>;
  store: OrphanStore;
  log?: (line: string) => void;
  pageSize?: number;
}) {
  async function sweepOrphans(_now: Date): Promise<OrphanSweepResult> {
    throw new Error("sweepOrphans is not implemented yet");
  }
  return { sweepOrphans };
}
