// The trash (build plan Task 14; AC-063, Q11). Delete moves a model to the
// trash, where it is invisible to the library, search and the API; restore
// brings it back with its files, tags and collections, which a trashing never
// touches. A trashed model is purged 30 days after it was trashed
// (purgeExpired), or at once by Empty trash (emptyTrash).
//
// A purge removes one model at a time, in its own transaction:
//   1. lock the model's row FOR UPDATE, and go on only if it is still in the
//      trash (and, for purgeExpired, still past the cutoff), so a restore or
//      an organising call made meanwhile waits for the purge and then finds
//      no model;
//   2. delete the bucket objects: every blob row's key, plus anything listed
//      under models/<modelId>/, such as an upload that landed without its row
//      being marked stored;
//   3. list models/<modelId>/ again and expect zero objects (the Purge
//      contract);
//   4. only then delete the model's row; its files, plates, estimates, blobs
//      and tag and collection links go with it (on delete cascade).
// A failure at any step rolls the rows back and leaves the model in the trash.
// Deleting an object that is already gone is not an error, so the next run
// finishes the job: a purge is idempotent on retry.
//
// A purge that failed after step 2 leaves a model in the trash whose rows are
// intact but whose objects are gone, or some of them. restoreModel checks for
// that before it brings a model back: it locks the row FOR UPDATE, lists
// models/<modelId>/, and refuses with FilesMissing when any stored blob's key
// is not there. The model stays in the trash and the next purge finishes it.
//
// The daily 03:30 schedule for purgeExpired belongs to the job runner (Task
// 8), which registers it on the maintenance queue.
import type { Kysely } from "kysely";
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

/** Objects were still under a model's prefix after the purge deleted them. */
export class ObjectsRemain extends Error {
  readonly modelId: string;
  readonly count: number;

  constructor(modelId: string, count: number) {
    super(`${count} objects are still under the model's prefix after the purge deleted its blobs`);
    this.name = "ObjectsRemain";
    this.modelId = modelId;
    this.count = count;
  }
}

/**
 * restoreModel refused: stored blobs of the trashed model are no longer in the
 * bucket, because a purge deleted them and then failed. The model stays in the
 * trash, and the next purge removes it.
 */
export class FilesMissing extends Error {
  readonly modelId: string;
  readonly missing: number;

  constructor(modelId: string, missing: number) {
    super(
      `${missing} stored blobs of the trashed model are no longer in the bucket; a purge has begun, so it cannot be restored`,
    );
    this.name = "FilesMissing";
    this.modelId = modelId;
    this.missing = missing;
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

  /** Purges one model; false when it is no longer in the trash (or not past cutoff). */
  async function purgeModel(modelId: string, cutoff: Date | undefined): Promise<boolean> {
    return db.transaction().execute(async (trx) => {
      let lock = trx
        .selectFrom("models")
        .select("id")
        .where("id", "=", modelId)
        .where("trashedAt", "is not", null);
      if (cutoff !== undefined) lock = lock.where("trashedAt", "<", cutoff);
      if ((await lock.forUpdate().executeTakeFirst()) === undefined) return false;

      const prefix = `models/${modelId}/`;
      const rows = await trx
        .selectFrom("blobs")
        .select("key")
        .where("modelId", "=", modelId)
        .execute();
      const listed = await store.listPrefix(prefix);
      const keys = [...new Set([...rows.map((r) => r.key), ...listed.map((o) => o.key)])].filter(
        isBlobKey,
      );
      if (keys.length > 0) await store.deleteBlobs(keys);

      const left = await store.listPrefix(prefix);
      if (left.length > 0) throw new ObjectsRemain(modelId, left.length);

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
     * FilesMissing, and leaves the model in the trash, when a purge already
     * deleted any of its stored blobs' objects; a store error when the bucket
     * cannot be listed.
     */
    async restoreModel(id: string): Promise<boolean> {
      if (!isUuid(id)) return false;
      return db.transaction().execute(async (trx) => {
        const trashed = await trx
          .selectFrom("models")
          .select("id")
          .where("id", "=", id)
          .where("trashedAt", "is not", null)
          .forUpdate()
          .executeTakeFirst();
        if (trashed === undefined) return false;
        // isUuid and the uuid column accept any case, but bucket keys are
        // lowercase and S3 prefixes are case-sensitive, so go on with the id
        // as Postgres returns it (canonical lowercase), not the caller's text.
        const modelId = trashed.id;

        const stored = await trx
          .selectFrom("blobs")
          .select("key")
          .where("modelId", "=", modelId)
          .where("state", "=", "stored")
          .execute();
        if (stored.length > 0) {
          const listed = new Set((await store.listPrefix(`models/${modelId}/`)).map((o) => o.key));
          const missing = stored.filter((b) => !listed.has(b.key)).length;
          if (missing > 0) throw new FilesMissing(modelId, missing);
        }

        return modelsRepo(trx).restore(modelId);
      });
    },

    /**
     * Empty trash: purges every model in the trash. Throws PurgeIncomplete,
     * after trying them all, when any could not be purged.
     */
    async emptyTrash(): Promise<PurgeResult> {
      const trashed = await db
        .selectFrom("models")
        .select("id")
        .where("trashedAt", "is not", null)
        .orderBy("trashedAt")
        .orderBy("id")
        .execute();
      return purgeAll(
        trashed.map((m) => m.id),
        undefined,
      );
    },

    /**
     * Purges every model trashed more than TRASH_RETENTION_DAYS before now.
     * Throws PurgeIncomplete, after trying them all, when any could not be
     * purged; a later run retries those.
     */
    async purgeExpired(now: Date): Promise<PurgeResult> {
      if (Number.isNaN(now.getTime())) throw new RangeError("purgeExpired needs a valid date");
      const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * DAY_MS);
      const expired = await models.purgeable(cutoff);
      return purgeAll(
        expired.map((m) => m.id),
        cutoff,
      );
    },
  };
}
