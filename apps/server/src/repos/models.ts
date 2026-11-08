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

export interface SearchQuery {
  /** Matched anywhere in name, caption, creator or a tag, ignoring case. */
  q: string;
  /** At most this many models, 1 to 200; 50 when left out. */
  limit?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

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
     * Live models whose name, caption, creator or any tag contains q,
     * ignoring case, best trigram match first. An empty q lists live models.
     */
    async search(query: SearchQuery): Promise<Model[]> {
      const q = query.q.trim();
      const limit = Math.min(Math.max(Math.trunc(query.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
      const pattern = containsPattern(q);
      return selectModels(db)
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
        )
        .orderBy(
          sql`greatest(
            similarity(models.name, ${q}),
            similarity(coalesce(models.caption, ''), ${q}),
            similarity(coalesce(creators.name, ''), ${q}))`,
          "desc",
        )
        .orderBy("models.name")
        .orderBy("models.id")
        .limit(limit)
        .execute();
    },

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
