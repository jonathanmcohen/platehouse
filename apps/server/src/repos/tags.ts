import { type Kysely, sql } from "kysely";
import { isUuid } from "../db/ids.js";
import { inTransaction } from "../db/kysely.js";
import type { DB } from "../db/types.js";
import { SettingsInputError } from "../input-error.js";
import { deleteLabel, ensureLabels } from "./labels.js";

// Tags are matched ignoring case ("PLA" and "pla" are one tag), with
// Postgres's lower() on both sides so the rule is the unique index's rule.
//
// Unused tags (issue #312). In the app, a tag no model has any more is
// removed when its last model loses it: Remove tag on a model, bulk Remove
// tag, and a model deleted for good from the trash. A model in the trash
// still has its tags, since a restore brings them back, so it keeps a tag.
// The public API's untag leaves the tag, as the API never deletes anything
// (remove without dropUnused). The removal locks the tag FOR UPDATE before
// it reads whether any link is left, in a later statement, so a link being
// made at the same time (labels.ts, ensureLabels) commits first and is seen.
// Every lock here is taken in the order model, tag, link, as a link's own
// statements take them, and several tags in id order.

function tagName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") throw new SettingsInputError("A tag name must not be empty");
  return trimmed;
}

export interface RemoveTagOptions {
  /** Remove the tag too when no model, live or trashed, has it afterwards. */
  dropUnused?: boolean;
}

export function tagsRepo(db: Kysely<DB>) {
  return {
    /** Tags a model, making the tag on first use; tagging twice is a no-op. */
    async add(modelId: string, name: string): Promise<void> {
      const tag = tagName(name);
      await inTransaction(db, async (trx) => {
        const [tagId] = await ensureLabels(trx, "tags", [tag]);
        if (tagId === undefined) throw new Error(`tags: no row for ${JSON.stringify(tag)}`);
        await trx
          .insertInto("modelTags")
          .values({ modelId, tagId })
          .onConflict((oc) => oc.columns(["modelId", "tagId"]).doNothing())
          .execute();
      });
    },

    /**
     * Untags a model. False when it was not tagged. The tag itself stays,
     * unless dropUnused is set and no model has it any more.
     */
    async remove(modelId: string, name: string, options: RemoveTagOptions = {}): Promise<boolean> {
      if (!isUuid(modelId)) return false;
      if (options.dropUnused !== true) {
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
      }
      return inTransaction(db, async (trx) => {
        const tag = await trx
          .selectFrom("tags")
          .select("id")
          .where(sql<boolean>`lower(name) = lower(${name.trim()})`)
          .forUpdate()
          .executeTakeFirst();
        if (tag === undefined) return false;
        const result = await trx
          .deleteFrom("modelTags")
          .where("modelId", "=", modelId)
          .where("tagId", "=", tag.id)
          .executeTakeFirst();
        if (result.numDeletedRows === 0n) return false;
        await tagsRepo(trx).dropUnused([tag.id]);
        return true;
      });
    },

    /**
     * Locks FOR UPDATE, in id order, the tags a model has, and answers their
     * ids: a purge takes them before it deletes the model, so it can then
     * remove the ones no other model has (dropUnused). Needs a transaction.
     */
    async lockForModel(modelId: string): Promise<string[]> {
      if (!isUuid(modelId)) return [];
      const { rows } = await sql<{ id: string }>`
        select t.id
        from tags t
        join model_tags mt on mt.tag_id = t.id
        where mt.model_id = ${modelId}
        order by t.id
        for update of t
      `.execute(db);
      return rows.map((r) => r.id);
    },

    /**
     * Deletes the given tags that no model, live or trashed, has; answers
     * how many. The caller holds them FOR UPDATE (remove, lockForModel), so
     * no link to one can be made between this check and the commit.
     */
    async dropUnused(tagIds: readonly string[]): Promise<number> {
      if (tagIds.length === 0) return 0;
      const result = await db
        .deleteFrom("tags")
        .where("id", "in", [...tagIds])
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom("modelTags")
                .select("modelTags.tagId")
                .whereRef("modelTags.tagId", "=", "tags.id"),
            ),
          ),
        )
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },

    /**
     * Deletes the tag of this name, ignoring case, from every model that
     * has it, trashed ones included; no model changes otherwise. The name
     * as it was stored, or null when there is no such tag.
     */
    async delete(name: string): Promise<string | null> {
      return deleteLabel(db, "tags", name);
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
