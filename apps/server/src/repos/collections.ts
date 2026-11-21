import { type Kysely, sql } from "kysely";
import { isUuid, uuidv7 } from "../db/ids.js";
import { inTransaction } from "../db/kysely.js";
import type { DB } from "../db/types.js";

// Collections are flat (Q17) and, like tags, matched ignoring case with
// Postgres's lower() on both sides. A model can sit in many collections.

function collectionName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw new RangeError("A collection name must not be empty");
  return trimmed;
}

export function collectionsRepo(db: Kysely<DB>) {
  return {
    /** Puts a model in a collection, making it on first use; twice is a no-op. */
    async add(modelId: string, name: string): Promise<void> {
      const collection = collectionName(name);
      await inTransaction(db, async (trx) => {
        await trx
          .insertInto("collections")
          .values({ id: uuidv7(), name: collection })
          .onConflict((oc) => oc.expression(sql`lower(name)`).doNothing())
          .execute();
        await trx
          .insertInto("collectionModels")
          .columns(["collectionId", "modelId"])
          .expression((eb) =>
            eb
              .selectFrom("collections")
              .select([
                "collections.id as collectionId",
                sql<string>`cast(${modelId} as uuid)`.as("modelId"),
              ])
              .where(sql<boolean>`lower(collections.name) = lower(${collection})`),
          )
          .onConflict((oc) => oc.columns(["collectionId", "modelId"]).doNothing())
          .execute();
      });
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
