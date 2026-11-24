import { type Kysely, sql } from "kysely";
import { isUuid } from "../db/ids.js";
import { inTransaction } from "../db/kysely.js";
import type { DB } from "../db/types.js";
import { SettingsInputError } from "../input-error.js";
import { deleteLabel, ensureLabels } from "./labels.js";

// Collections are flat (one cannot hold another) and, like tags, matched ignoring case with
// Postgres's lower() on both sides. A model can sit in many collections.

function collectionName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw new SettingsInputError("A collection name must not be empty");
  return trimmed;
}

export function collectionsRepo(db: Kysely<DB>) {
  return {
    /** Puts a model in a collection, making it on first use; twice is a no-op. */
    async add(modelId: string, name: string): Promise<void> {
      const collection = collectionName(name);
      await inTransaction(db, async (trx) => {
        // Found or made, and locked, so a Delete of it at the same time
        // cannot leave the model out of it unseen (labels.ts).
        const [collectionId] = await ensureLabels(trx, "collections", [collection]);
        if (collectionId === undefined) {
          throw new Error(`collections: no row for ${JSON.stringify(collection)}`);
        }
        await trx
          .insertInto("collectionModels")
          .values({ collectionId, modelId })
          .onConflict((oc) => oc.columns(["collectionId", "modelId"]).doNothing())
          .execute();
      });
    },

    /**
     * Deletes the collection of this name, ignoring case, taking every model
     * out of it, trashed ones included; no model changes otherwise. The name
     * as it was stored, or null when there is no such collection. Nothing
     * else removes a collection: an empty one stays until it is deleted.
     */
    async delete(name: string): Promise<string | null> {
      return deleteLabel(db, "collections", name);
    },

    /** Takes a model out of a collection; false when it was not in it. */
    async remove(modelId: string, name: string): Promise<boolean> {
      if (!isUuid(modelId)) return false;
      const result = await db
        .deleteFrom("collectionModels")
        .where("modelId", "=", modelId)
        .where("collectionId", "in", (eb) =>
          eb
            .selectFrom("collections")
            .select("collections.id")
            .where(sql<boolean>`lower(collections.name) = lower(${name.trim()})`),
        )
        .executeTakeFirst();
      return result.numDeletedRows > 0n;
    },

    /** The names of a model's collections, in alphabetical order ignoring case. */
    async forModel(modelId: string): Promise<string[]> {
      if (!isUuid(modelId)) return [];
      const rows = await db
        .selectFrom("collectionModels")
        .innerJoin("collections", "collections.id", "collectionModels.collectionId")
        .select("collections.name")
        .where("collectionModels.modelId", "=", modelId)
        .orderBy(sql`lower(collections.name)`)
        .orderBy("collections.name")
        .execute();
      return rows.map((r) => r.name);
    },
  };
}

export type CollectionsRepo = ReturnType<typeof collectionsRepo>;
