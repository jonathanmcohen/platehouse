import { type Kysely, sql } from "kysely";
import { isUuid, uuidv7 } from "../db/ids.js";
import { inTransaction } from "../db/kysely.js";
import type { DB } from "../db/types.js";

export interface Model {
  id: string;
  name: string;
  caption: string | null;
  descriptionMd: string | null;
  creatorId: string | null;
  /** The creator's name, or null when the model has no creator. */
  creator: string | null;
  licenseSpdx: string | null;
  licenseNote: string | null;
  externalRef: string | null;
  trashedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewModel {
  id?: string;
  name: string;
  caption?: string | null;
  descriptionMd?: string | null;
  /** A creator name; the creator row is made on first use. */
  creator?: string | null;
  licenseSpdx?: string | null;
  licenseNote?: string | null;
  externalRef?: string | null;
}

/** Metadata a parse or an import found; fillMetadata writes only into empty fields. */
export interface FoundMetadata {
  caption?: string | null;
  /** The description as Markdown, without any licence footer. */
  descriptionMd?: string | null;
  creator?: string | null;
  licenseSpdx?: string | null;
  /**
   * A licence with no SPDX id, in words ("License on MakerWorld: ...").
   * Stored as license_note whenever the licence is filled; it is added at
   * the foot of the description only when the description is empty and
   * filled here too, since a description already set is never edited (Jon,
   * 2026-11-08). The model page shows license_note (Task 20).
   */
  licenseNote?: string | null;
}

export interface SearchQuery {
  /** Matched anywhere in name, caption, creator or a tag, ignoring case. */
  q: string;
  /** At most this many models, 1 to 200; 50 when left out. */
  limit?: number;
}

export interface RankedSearchQuery {
  /** As SearchQuery.q; empty or blank lists every live model. */
  q: string;
  /** Only models with this tag, ignoring case. */
  tag?: string | undefined;
  /** Only models in this collection, ignoring case. */
  collection?: string | undefined;
  /** Only models by the creator with exactly this name. */
  creator?: string | undefined;
  /** Only models after this one in the result order (keyset paging). */
  after?: { rank: number; name: string; id: string } | undefined;
  /** At most this many models, 1 to 1000. */
  limit: number;
}

/**
 * A model's search rank: the best pg_trgm similarity of q to its name,
 * caption, creator or any of its tags, scaled to a whole number from 0 to
 * SEARCH_RANK_MAX. A whole number, so a page cursor can carry it exactly.
 */
export const SEARCH_RANK_MAX = 1_000_000;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_RANKED_LIMIT = 1000;

/** q as a LIKE pattern that matches it literally anywhere in the text. */
function containsPattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, "\\$&")}%`;
}

function selectModels(db: Kysely<DB>) {
  return db
    .selectFrom("models")
    .leftJoin("creators", "creators.id", "models.creatorId")
    .select([
      "models.id",
      "models.name",
      "models.caption",
      "models.descriptionMd",
      "models.creatorId",
      "creators.name as creator",
      "models.licenseSpdx",
      "models.licenseNote",
      "models.externalRef",
      "models.trashedAt",
      "models.createdAt",
      "models.updatedAt",
    ]);
}

/** The creator's id, making the creator on first use. */
async function creatorId(db: Kysely<DB>, name: string): Promise<string> {
  await db
    .insertInto("creators")
    .values({ id: uuidv7(), name })
    .onConflict((oc) => oc.column("name").doNothing())
    .execute();
  const row = await db
    .selectFrom("creators")
    .select("id")
    .where("name", "=", name)
    .executeTakeFirstOrThrow();
  return row.id;
}

export function modelsRepo(db: Kysely<DB>) {
  async function get(id: string, opts: { includeTrashed?: boolean } = {}) {
    if (!isUuid(id)) return undefined;
    let query = selectModels(db).where("models.id", "=", id);
    if (!opts.includeTrashed) query = query.where("models.trashedAt", "is", null);
    return query.executeTakeFirst();
  }

  async function searchRanked(query: RankedSearchQuery): Promise<Array<Model & { rank: number }>> {
    const q = query.q.trim();
    const limit = Math.trunc(query.limit);
    if (!(limit >= 1 && limit <= MAX_RANKED_LIMIT)) {
      throw new RangeError(`searchRanked takes a limit from 1 to ${MAX_RANKED_LIMIT}`);
    }
    const pattern = containsPattern(q);
    const rank = sql<number>`round(greatest(
        similarity(models.name, ${q}),
        similarity(coalesce(models.caption, ''), ${q}),
        similarity(coalesce(creators.name, ''), ${q}),
        coalesce((
          select max(similarity(t.name, ${q}))
          from model_tags mt join tags t on t.id = mt.tag_id
          where mt.model_id = models.id), 0)
      ) * ${SEARCH_RANK_MAX})::integer`;

    let select = selectModels(db)
      .select(rank.as("rank"))
      .where("models.trashedAt", "is", null)
      .where((eb) =>
        eb.or([
          eb("models.name", "ilike", pattern),
          eb("models.caption", "ilike", pattern),
          eb("creators.name", "ilike", pattern),
          eb.exists(
            eb
              .selectFrom("modelTags")
              .innerJoin("tags", "tags.id", "modelTags.tagId")
              .select("modelTags.tagId")
              .whereRef("modelTags.modelId", "=", "models.id")
              .where("tags.name", "ilike", pattern),
          ),
        ]),
      );
    const { tag, collection, creator, after } = query;
    if (tag !== undefined) {
      select = select.where(({ exists, selectFrom }) =>
        exists(
          selectFrom("modelTags")
            .innerJoin("tags", "tags.id", "modelTags.tagId")
            .select("modelTags.tagId")
            .whereRef("modelTags.modelId", "=", "models.id")
            .where(sql<boolean>`lower(tags.name) = lower(${tag.trim()})`),
        ),
      );
    }
    if (collection !== undefined) {
      select = select.where(({ exists, selectFrom }) =>
        exists(
          selectFrom("collectionModels")
            .innerJoin("collections", "collections.id", "collectionModels.collectionId")
            .select("collectionModels.collectionId")
            .whereRef("collectionModels.modelId", "=", "models.id")
            .where(sql<boolean>`lower(collections.name) = lower(${collection.trim()})`),
        ),
      );
    }
    if (creator !== undefined) {
      select = select.where("creators.name", "=", creator.trim());
    }
    if (after !== undefined) {
      // The rows after the cursor in the order below: rank down, then name
      // and id up.
      select = select.where(
        sql<boolean>`(${rank} < ${after.rank}
          or (${rank} = ${after.rank}
              and (models.name > ${after.name}
                   or (models.name = ${after.name} and models.id > cast(${after.id} as uuid)))))`,
      );
    }
    return select
      .orderBy(rank, "desc")
      .orderBy("models.name")
      .orderBy("models.id")
      .limit(limit)
      .execute();
  }

  return {
    /**
     * Makes a model. A taken externalRef, live or trashed, fails with
     * Postgres error 23505 (unique_violation).
     */
    async create(input: NewModel): Promise<Model> {
      const id = input.id ?? uuidv7();
      return inTransaction(db, async (trx) => {
        const creator = input.creator?.trim();
        await trx
          .insertInto("models")
          .values({
            id,
            name: input.name,
            caption: input.caption ?? null,
            descriptionMd: input.descriptionMd ?? null,
            creatorId: creator ? await creatorId(trx, creator) : null,
            licenseSpdx: input.licenseSpdx ?? null,
            licenseNote: input.licenseNote ?? null,
            externalRef: input.externalRef ?? null,
          })
          .execute();
        return selectModels(trx).where("models.id", "=", id).executeTakeFirstOrThrow();
      });
    },

    /** A model by id; a trashed one only with includeTrashed. */
    get,

    /**
     * Fill-only metadata (AC-022): writes each found value only into a field
     * that is null or empty, so nothing Jon set is overwritten. The name is
     * never touched. A found value that is null, empty or blank writes
     * nothing. The licence is one field held in two columns: it is filled
     * only when both licenseSpdx and licenseNote are empty, so a MakerWorld
     * note never lands beside an SPDX id Jon chose, and the note joins the
     * foot of the description only when the licence and the description are
     * both filled here. False when the model is unknown.
     */
    async fillMetadata(id: string, found: FoundMetadata): Promise<boolean> {
      if (!isUuid(id)) return false;
      const value = (v: string | null | undefined) => (v?.trim() ? v : undefined);
      const empty = (v: string | null) => v === null || v === "";
      return inTransaction(db, async (trx) => {
        // The row is locked, so the fields read here are the ones updated.
        const row = await trx
          .selectFrom("models")
          .select(["caption", "descriptionMd", "licenseSpdx", "licenseNote", "creatorId"])
          .where("id", "=", id)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return false;
        const set: Partial<
          Record<"caption" | "descriptionMd" | "licenseSpdx" | "licenseNote" | "creatorId", string>
        > = {};
        const caption = value(found.caption);
        if (caption !== undefined && empty(row.caption)) set.caption = caption;

        const spdx = value(found.licenseSpdx);
        const note = value(found.licenseNote);
        const fillLicence =
          empty(row.licenseSpdx) && empty(row.licenseNote) && (spdx ?? note) !== undefined;
        if (fillLicence && spdx !== undefined) set.licenseSpdx = spdx;
        if (fillLicence && note !== undefined) set.licenseNote = note;

        if (empty(row.descriptionMd)) {
          const parts = [value(found.descriptionMd), fillLicence ? note : undefined];
          const description = parts.filter((p) => p !== undefined).join("\n\n");
          if (description !== "") set.descriptionMd = description;
        }
        // The creator row is made only when it will be used, so no creator
        // is left in the sidebar without a model.
        const creator = value(found.creator)?.trim();
        if (creator !== undefined && row.creatorId === null) {
          set.creatorId = await creatorId(trx, creator);
        }
        if (Object.keys(set).length === 0) return true;
        const result = await trx
          .updateTable("models")
          .set({ ...set, updatedAt: sql`now()` })
          .where("id", "=", id)
          .executeTakeFirst();
        return result.numUpdatedRows > 0n;
      });
    },

    /**
     * Live models whose name, caption, creator or any tag contains q,
     * ignoring case, best trigram match first. An empty q lists live models.
     */
    async search(query: SearchQuery): Promise<Model[]> {
      const limit = Math.min(Math.max(Math.trunc(query.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
      const rows = await searchRanked({ q: query.q, limit });
      return rows.map(({ rank: _rank, ...model }) => model);
    },

    /**
     * The query under search, for library search (library/search.ts): it
     * adds tag, collection and creator filters and keyset paging, and returns
     * each model's rank for the page cursor. Trashed models never appear.
     */
    searchRanked,

    /** Moves a live model to the trash; false when it is unknown or already there. */
    async trash(id: string): Promise<boolean> {
      if (!isUuid(id)) return false;
      const result = await db
        .updateTable("models")
        .set({ trashedAt: sql`now()` })
        .where("id", "=", id)
        .where("trashedAt", "is", null)
        .executeTakeFirst();
      return result.numUpdatedRows > 0n;
    },

    /** Brings a trashed model back; false when it is unknown or not trashed. */
    async restore(id: string): Promise<boolean> {
      if (!isUuid(id)) return false;
      const result = await db
        .updateTable("models")
        .set({ trashedAt: null })
        .where("id", "=", id)
        .where("trashedAt", "is not", null)
        .executeTakeFirst();
      return result.numUpdatedRows > 0n;
    },

    /** Models trashed before the given time, oldest first: what a purge removes. */
    async purgeable(before: Date): Promise<Model[]> {
      return selectModels(db)
        .where("models.trashedAt", "is not", null)
        .where("models.trashedAt", "<", before)
        .orderBy("models.trashedAt")
        .orderBy("models.id")
        .execute();
    },
  };
}

export type ModelsRepo = ReturnType<typeof modelsRepo>;
