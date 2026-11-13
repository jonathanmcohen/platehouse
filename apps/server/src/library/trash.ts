// The trash (build plan Task 14; AC-063, Q11). Delete moves a model to the
// trash, where it is invisible to the library, search and the API; restore
// brings it back with its files, tags and collections, which a trashing never
// touches. A trashed model is purged 30 days after it was trashed
// (purgeExpired), or at once by Empty trash (emptyTrash). purgeExpired also
// finishes every purge that began and failed, however recently the model was
// trashed, so a failed Empty trash does not wait 30 days for its retry.
//
// A purge removes one model at a time:
//   1. in a transaction, lock the model's row FOR UPDATE, only if it is still
//      in the trash (and, for purgeExpired, still past the cutoff or already
//      marked by an earlier purge that failed), so a
//      restore that holds the row makes the purge wait and then find no
//      trashed model; read its blob rows and list models/<modelId>/;
//   2. still in that transaction, set purge_started_at (migration 0002) and
//      commit, just before the first object delete. A failure before this
//      point (the store unreachable at the listing, the lock or a read
//      failing) rolls it back and leaves no marker, so the model can still be
//      restored: nothing of it was deleted;
//   3. delete the bucket objects: every blob row's key, plus every listed key
//      that is in the models/<modelId>/<blobId> layout, such as an upload that
//      landed without its row being marked stored. The app never deletes a
//      key outside that layout (the store refuses to), so an object like a
//      folder marker made in an S3 console stays where it is;
//   4. in a second transaction, lock the row again, list models/<modelId>/
//      and expect zero objects (the Purge contract). Anything left fails the
//      purge with ObjectsRemain, which names the first keys left, so an object
//      outside the layout can be found and removed by hand;
//   5. only then delete the model's row; its files, plates, estimates, blobs
//      and tag and collection links go with it (on delete cascade).
// A failure at or after step 3 leaves the model in the trash, its marker
// set: some of its objects may be gone. Deleting an object that is already
// gone is not an error, so the next run finishes the job: a purge is
// idempotent on retry. The row is not held while objects are deleted, but
// nothing can change the model then: the organising calls refuse a trashed
// model, and restore refuses one whose marker is set.
//
// restoreModel refuses a model whose marker is set, with PurgeStarted: its
// purge may have deleted some of its objects already, and the next purge
// finishes it. Any other trashed model is restored without looking at the
// bucket. An object lost some other way (AC-010 reconciliation counts stored
// rows against objects) shows as unavailable when it is read
// (getBlobStream's BlobNotFound); it never makes a model unrestorable.
//
// The daily 03:30 schedule for purgeExpired belongs to the job runner (Task
// 8), which registers it on the maintenance queue.
import { type Kysely, sql } from "kysely";
import { isUuid } from "../db/ids.js";
import type { DB } from "../db/types.js";
import { modelsRepo } from "../repos/models.js";
import { isBlobKey } from "../storage/keys.js";
import type { BlobStore } from "../storage/s3.js";

/** Days a model stays in the trash before purgeExpired removes it. */
export const TRASH_RETENTION_DAYS = 30;

const DAY_MS = 86_400_000;

/** The two store calls a purge needs; the real one is createBlobStore's. */
export type PurgeStore = Pick<BlobStore, "deleteBlobs" | "listPrefix">;

export interface PurgeResult {
  /** The ids of the models purged, in the order they were purged. */
  purged: string[];
}

/** How many leftover keys ObjectsRemain names. */
const REMAIN_KEYS_SHOWN = 10;

/**
 * Objects were still under a model's prefix after the purge deleted its
 * blobs. Usually a key outside the models/<modelId>/<blobId> layout, which
 * the app never deletes: remove it by hand and the next purge finishes.
 */
export class ObjectsRemain extends Error {
  readonly modelId: string;
  /** How many objects were left. */
  readonly count: number;
  /** The first keys left, at most REMAIN_KEYS_SHOWN of them. */
  readonly keys: string[];

  constructor(modelId: string, keys: readonly string[]) {
    const shown = keys.slice(0, REMAIN_KEYS_SHOWN);
    const more = keys.length > shown.length ? ` and ${keys.length - shown.length} more` : "";
    super(
      `${keys.length} objects are still under models/${modelId}/ after the purge deleted its blobs: ` +
        `${shown.join(", ")}${more}. The app deletes only keys in the models/<modelId>/<blobId> ` +
        "layout; remove any other by hand and the next purge finishes",
    );
    this.name = "ObjectsRemain";
    this.modelId = modelId;
    this.count = keys.length;
    this.keys = shown;
  }
}

/**
 * restoreModel refused: a purge of the trashed model has begun, and may
 * already have deleted some of its objects. The model stays in the trash,
 * and the next purge removes it.
 */
export class PurgeStarted extends Error {
  readonly modelId: string;
  readonly purgeStartedAt: Date;

  constructor(modelId: string, purgeStartedAt: Date) {
    super(
      `A purge of the trashed model began at ${purgeStartedAt.toISOString()} and may already have deleted its files, so it cannot be restored; the next purge finishes it`,
    );
    this.name = "PurgeStarted";
    this.modelId = modelId;
    this.purgeStartedAt = purgeStartedAt;
  }
}

/**
 * Some models could not be purged. The others were; the failed ones are still
 * in the trash with their rows, and the next run tries them again.
 */
export class PurgeIncomplete extends Error {
  readonly purged: string[];
  readonly failed: Array<{ modelId: string; error: unknown }>;

  constructor(purged: string[], failed: Array<{ modelId: string; error: unknown }>) {
    super(
      `Purged ${purged.length} trashed models; ${failed.length} could not be purged and stay in the trash`,
    );
    this.name = "PurgeIncomplete";
    this.purged = purged;
    this.failed = failed;
  }
}

export function createTrash(deps: { db: Kysely<DB>; store: PurgeStore }) {
  const { db, store } = deps;
  const models = modelsRepo(db);

  /**
   * Purges one model; false when it is no longer in the trash, or, given a
   * cutoff, when it is neither past the cutoff nor marked by an earlier purge.
   */
  async function purgeModel(modelId: string, cutoff: Date | undefined): Promise<boolean> {
    const prefix = `models/${modelId}/`;

    // Steps 1 and 2: read what to delete, then mark the model and commit. A
    // marker an earlier failed purge set is kept as it was.
    const keys = await db.transaction().execute(async (trx) => {
      let trashed = trx
        .selectFrom("models")
        .select("id")
        .where("id", "=", modelId)
        .where("trashedAt", "is not", null);
      // A marked model is never restored, so its purge is finished whatever
      // its trash date.
      if (cutoff !== undefined) {
        trashed = trashed.where((eb) =>
          eb.or([eb("trashedAt", "<", cutoff), eb("purgeStartedAt", "is not", null)]),
        );
      }
      // Gone, restored, or trashed again since: not this purge's to remove.
      if ((await trashed.forUpdate().executeTakeFirst()) === undefined) return undefined;

      const rows = await trx
        .selectFrom("blobs")
        .select("key")
        .where("modelId", "=", modelId)
        .execute();
      const listed = await store.listPrefix(prefix);

      await trx
        .updateTable("models")
        .set((eb) => ({ purgeStartedAt: eb.fn.coalesce("purgeStartedAt", sql<Date>`now()`) }))
        .where("id", "=", modelId)
        .execute();
      // Only keys in the blob layout: the store refuses to delete any other,
      // and step 4 reports what is left.
      return [...new Set([...rows.map((r) => r.key), ...listed.map((o) => o.key)])].filter(
        isBlobKey,
      );
    });
    if (keys === undefined) return false;

    // Step 3: the marker is committed, so from here a failure keeps it.
    if (keys.length > 0) await store.deleteBlobs(keys);

    // Steps 4 and 5.
    return db.transaction().execute(async (trx) => {
      const lock = await trx
        .selectFrom("models")
        .select("id")
        .where("id", "=", modelId)
        .where("trashedAt", "is not", null)
        .where("purgeStartedAt", "is not", null)
        .forUpdate()
        .executeTakeFirst();
      // Gone: another purge finished it meanwhile.
      if (lock === undefined) return false;

      const left = await store.listPrefix(prefix);
      if (left.length > 0) {
        throw new ObjectsRemain(
          modelId,
          left.map((o) => o.key),
        );
      }

      await trx.deleteFrom("models").where("id", "=", modelId).execute();
      return true;
    });
  }

  async function purgeAll(ids: string[], cutoff: Date | undefined): Promise<PurgeResult> {
    const purged: string[] = [];
    const failed: Array<{ modelId: string; error: unknown }> = [];
    for (const id of ids) {
      try {
        if (await purgeModel(id, cutoff)) purged.push(id);
      } catch (error) {
        failed.push({ modelId: id, error });
      }
    }
    if (failed.length > 0) throw new PurgeIncomplete(purged, failed);
    return { purged };
  }

  return {
    /** Moves a live model to the trash; false when it is unknown, malformed or already there. */
    trashModel(id: string): Promise<boolean> {
      return models.trash(id);
    },

    /**
     * Brings a trashed model back with its files, tags and collections; false
     * when it is unknown, malformed, live, or purged meanwhile. Throws
     * PurgeStarted, and leaves the model in the trash, when a purge of it has
     * begun. It does not read the bucket: an object lost some other way shows
     * as unavailable when it is read, and does not stop the restore.
     */
    async restoreModel(id: string): Promise<boolean> {
      if (!isUuid(id)) return false;
      return db.transaction().execute(async (trx) => {
        const trashed = await trx
          .selectFrom("models")
          .select(["id", "purgeStartedAt"])
          .where("id", "=", id)
          .where("trashedAt", "is not", null)
          .forUpdate()
          .executeTakeFirst();
        if (trashed === undefined) return false;
        if (trashed.purgeStartedAt !== null) {
          throw new PurgeStarted(trashed.id, trashed.purgeStartedAt);
        }
        // isUuid and the uuid column accept any case; go on with the id as
        // Postgres returns it (canonical lowercase), not the caller's text.
        return modelsRepo(trx).restore(trashed.id);
      });
    },

    /**
     * Empty trash: purges every model in the trash, or, given ids, only those
     * of them still in the trash, so a caller showing a list purges what it
     * showed and not a model trashed since. Malformed, unknown and live ids
     * are skipped. Throws PurgeIncomplete, after trying them all, when any
     * could not be purged.
     */
    async emptyTrash(only?: readonly string[]): Promise<PurgeResult> {
      let query = db.selectFrom("models").select("id").where("trashedAt", "is not", null);
      if (only !== undefined) {
        const ids = [...new Set(only.filter(isUuid))];
        if (ids.length === 0) return { purged: [] };
        // One array parameter, not one per id, so a long list stays inside
        // Postgres's parameter limit.
        query = query.where("id", "=", sql<string>`any(${ids}::uuid[])`);
      }
      const trashed = await query.orderBy("trashedAt").orderBy("id").execute();
      return purgeAll(
        trashed.map((m) => m.id),
        undefined,
      );
    },

    /**
     * Purges every model trashed more than TRASH_RETENTION_DAYS before now,
     * and every trashed model whose purge began and failed, however recently
     * it was trashed (such as one a failed Empty trash left half deleted).
     * Throws PurgeIncomplete, after trying them all, when any could not be
     * purged; a later run retries those.
     */
    async purgeExpired(now: Date): Promise<PurgeResult> {
      if (Number.isNaN(now.getTime())) throw new RangeError("purgeExpired needs a valid date");
      const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * DAY_MS);
      const expired = await models.purgeable(cutoff);
      // Marked models not yet past the cutoff, all trashed after every model
      // in expired, so the list stays oldest first.
      const started = await db
        .selectFrom("models")
        .select("id")
        .where("trashedAt", ">=", cutoff)
        .where("purgeStartedAt", "is not", null)
        .orderBy("trashedAt")
        .orderBy("id")
        .execute();
      return purgeAll(
        [...expired, ...started].map((m) => m.id),
        cutoff,
      );
    },
  };
}
