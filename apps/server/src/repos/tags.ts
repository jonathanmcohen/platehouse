import { type Kysely, sql } from "kysely";
import { isUuid, uuidv7 } from "../db/ids.js";
import { inTransaction } from "../db/kysely.js";
import type { DB } from "../db/types.js";

// Tags are matched ignoring case ("PLA" and "pla" are one tag), with
// Postgres's lower() on both sides so the rule is the unique index's rule.

function tagName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw new RangeError("A tag name must not be empty");
  return trimmed;
}

export function tagsRepo(db: Kysely<DB>) {
  return {
    /** Tags a model, making the tag on first use; tagging twice is a no-op. */
    async add(modelId: string, name: string): Promise<void> {
      const tag = tagName(name);
      await inTransaction(db, async (trx) => {
        await trx
          .insertInto("tags")
          .values({ id: uuidv7(), name: tag })
          .onConflict((oc) => oc.expression(sql`lower(name)`).doNothing())
          .execute();
        await trx
          .insertInto("modelTags")
          .columns(["modelId", "tagId"])
          .expression((eb) =>
            eb
              .selectFrom("tags")
              .select([sql<string>`cast(${modelId} as uuid)`.as("modelId"), "tags.id as tagId"])
              .where(sql<boolean>`lower(tags.name) = lower(${tag})`),
          )
          .onConflict((oc) => oc.columns(["modelId", "tagId"]).doNothing())
          .execute();
      });
    },

    /** Untags a model; the tag itself stays. False when it was not tagged. */
    async remove(modelId: string, name: string): Promise<boolean> {
      if (!isUuid(modelId)) return false;
      const result = await db
        .deleteFrom("modelTags")
        .where("modelId", "=", modelId)
        .where("tagId", "in", (eb) =>
          eb
            .selectFrom("tags")
            .select("tags.id")
            .where(sql<boolean>`lower(tags.name) = lower(${name.trim()})`),
        )
        .executeTakeFirst();
      return result.numDeletedRows > 0n;
    },

    /** A model's tag names, in alphabetical order ignoring case. */
    async forModel(modelId: string): Promise<string[]> {
      if (!isUuid(modelId)) return [];
      const rows = await db
        .selectFrom("modelTags")
        .innerJoin("tags", "tags.id", "modelTags.tagId")
        .select("tags.name")
        .where("modelTags.modelId", "=", modelId)
        .orderBy(sql`lower(tags.name)`)
        .orderBy("tags.name")
        .execute();
      return rows.map((r) => r.name);
    },
  };
}

export type TagsRepo = ReturnType<typeof tagsRepo>;
