import { createHash } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { isUuid, uuidv7 } from "../db/ids.js";
import { inTransaction } from "../db/kysely.js";
import type { DB, NameSource } from "../db/types.js";
import { cutName, fileStems } from "../ingest/names.js";

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
  /** Who named the model: its file, its .3mf's title, or a person (0005). */
  nameSource: NameSource;
  /** The MakerWorld design ID its .3mf carries, digits only; null when none. */
  makerworldDesignId: string | null;
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
  /**
   * Where the name came from. Ingest says "file" or "title"; any other caller
   * (the public API's create-model, the importer through it) gave the name
   * itself, so it is "user" when left out and nothing renames the model.
   */
  nameSource?: NameSource;
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
   * Stored as license_note whenever the model has none, whatever its SPDX id
   * (license_note is always stored); it is added at the foot of the
   * description only when the description and both licence columns are
   * empty, since a description already set is never edited (Jon,
   * 2026-11-08). The model page shows license_note (Task 20).
   */
  licenseNote?: string | null;
  /** The MakerWorld design ID, digits only (packages/threemf makerWorldDesignId). */
  makerworldDesignId?: string | null;
}

/** A model the "Use file titles" backfill would rename. */
export interface TitleRename {
  id: string;
  from: string;
  to: string;
}

/**
 * What the "Use file titles" backfill would do to the live models: the
 * renames, by current name, and how many models it leaves alone, by reason.
 */
export interface TitleNamePlan {
  /**
   * The SHA-256, in hex, of the renames list. Applying takes it back and
   * renames only when the list worked out then is the same one, so only the
   * renames the preview showed are ever made.
   */
  planId: string;
  renames: TitleRename[];
  skipped: {
    /** Renamed by a person (name_source 'user'). */
    renamedByUser: number;
    /** Already named from a title. */
    namedFromTitle: number;
    /** No title recorded (no caption). */
    noTitle: number;
    /** The title is the name it already has. */
    sameName: number;
    /** Its name is none of its files' names, so a person chose it. */
    nameNotFromFile: number;
    /**
     * Made by an import (it has an externalRef, such as manyfold:<id>): its
     * caption is the source library's own, copied as written, not its
     * .3mf's title, so it cannot name the model.
     */
    imported: number;
  };
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

/** A ranked match with only what a library card and a keyset cursor need. */
export interface RankedCard {
  id: string;
  name: string;
  creator: string | null;
  rank: number;
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

/** A Model's columns, from models left-joined to creators. */
const MODEL_COLUMNS = [
  "models.id",
  "models.name",
  "models.caption",
  "models.descriptionMd",
  "models.creatorId",
  "creators.name as creator",
  "models.licenseSpdx",
  "models.licenseNote",
  "models.externalRef",
  "models.nameSource",
  "models.makerworldDesignId",
  "models.trashedAt",
  "models.createdAt",
  "models.updatedAt",
] as const;

function selectModels(db: Kysely<DB>) {
  return db
    .selectFrom("models")
    .leftJoin("creators", "creators.id", "models.creatorId")
    .select(MODEL_COLUMNS);
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

  /**
   * The ranked search's query without its columns, and its rank expression:
   * the matches for query in the result order, at most query.limit.
   * searchRanked and searchRankedCards each add their own columns.
   */
  function rankedQuery(query: RankedSearchQuery) {
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

    let select = db
      .selectFrom("models")
      .leftJoin("creators", "creators.id", "models.creatorId")
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
    return {
      rank,
      select: select.orderBy(rank, "desc").orderBy("models.name").orderBy("models.id").limit(limit),
    };
  }

  async function searchRanked(query: RankedSearchQuery): Promise<Array<Model & { rank: number }>> {
    const { rank, select } = rankedQuery(query);
    return select.select(MODEL_COLUMNS).select(rank.as("rank")).execute();
  }

  async function searchRankedCards(query: RankedSearchQuery): Promise<RankedCard[]> {
    const { rank, select } = rankedQuery(query);
    return select
      .select(["models.id", "models.name", "creators.name as creator"])
      .select(rank.as("rank"))
      .execute();
  }

  async function titleNamePlan(): Promise<TitleNamePlan> {
    const models = await db
      .selectFrom("models")
      .select(["id", "name", "nameSource", "caption", "externalRef"])
      .where("trashedAt", "is", null)
      .orderBy("name")
      .orderBy("id")
      .execute();
    const files = await db
      .selectFrom("files")
      .innerJoin("models", "models.id", "files.modelId")
      .select(["files.modelId", "files.originalName"])
      .where("models.trashedAt", "is", null)
      .execute();
    const namesOf = new Map<string, string[]>();
    for (const f of files) {
      const list = namesOf.get(f.modelId);
      if (list === undefined) namesOf.set(f.modelId, [f.originalName]);
      else list.push(f.originalName);
    }
    const renames: TitleRename[] = [];
    const skipped: TitleNamePlan["skipped"] = {
      renamedByUser: 0,
      namedFromTitle: 0,
      noTitle: 0,
      sameName: 0,
      nameNotFromFile: 0,
      imported: 0,
    };
    for (const m of models) {
      const title = cutName(m.caption);
      if (m.nameSource === "user") skipped.renamedByUser += 1;
      else if (m.nameSource === "title") skipped.namedFromTitle += 1;
      else if (m.externalRef !== null) skipped.imported += 1;
      else if (title === null) skipped.noTitle += 1;
      else if (title === m.name) skipped.sameName += 1;
      else if (!fileStems(namesOf.get(m.id) ?? []).has(m.name)) skipped.nameNotFromFile += 1;
      else renames.push({ id: m.id, from: m.name, to: title });
    }
    const planId = createHash("sha256").update(JSON.stringify(renames)).digest("hex");
    return { planId, renames, skipped };
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
            nameSource: input.nameSource ?? "user",
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
     * nothing. A found licence note is stored whenever licenseNote is empty,
     * whatever licenseSpdx holds (Jon's decision: license_note is always
     * stored). A found SPDX id is filled only when both licence columns are
     * empty, and the note joins the foot of the description only when both
     * licence columns and the description were empty. False when the model
     * is unknown.
     */
    async fillMetadata(id: string, found: FoundMetadata): Promise<boolean> {
      if (!isUuid(id)) return false;
      const value = (v: string | null | undefined) => (v?.trim() ? v : undefined);
      const empty = (v: string | null) => v === null || v === "";
      return inTransaction(db, async (trx) => {
        // The row is locked, so the fields read here are the ones updated.
        const row = await trx
          .selectFrom("models")
          .select([
            "caption",
            "descriptionMd",
            "licenseSpdx",
            "licenseNote",
            "creatorId",
            "makerworldDesignId",
          ])
          .where("id", "=", id)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined) return false;
        const set: Partial<
          Record<
            | "caption"
            | "descriptionMd"
            | "licenseSpdx"
            | "licenseNote"
            | "creatorId"
            | "makerworldDesignId",
            string
          >
        > = {};
        const caption = value(found.caption);
        if (caption !== undefined && empty(row.caption)) set.caption = caption;
        const designId = value(found.makerworldDesignId);
        if (designId !== undefined && empty(row.makerworldDesignId)) {
          set.makerworldDesignId = designId;
        }

        const spdx = value(found.licenseSpdx);
        const note = value(found.licenseNote);
        const fillLicence =
          empty(row.licenseSpdx) && empty(row.licenseNote) && (spdx ?? note) !== undefined;
        if (fillLicence && spdx !== undefined) set.licenseSpdx = spdx;
        if (note !== undefined && empty(row.licenseNote)) set.licenseNote = note;

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
     * Names a live model from its .3mf's title, cut at the API's name limit,
     * when nobody has named it: only while name_source is 'file' and the
     * name is still one of its files' names (a raw stem or a cleaned file
     * name; see fileStems). A name a person set, by a rename (name_source
     * 'user') or before name_source existed (a name none of its files has),
     * is never overwritten (AC-022), and a model already named from a title
     * keeps that one. True when the name changed. Runs in the caller's
     * transaction when there is one, with the model's row locked.
     */
    async nameFromTitle(id: string, title: string | null | undefined): Promise<boolean> {
      const name = cutName(title);
      if (name === null || !isUuid(id)) return false;
      return inTransaction(db, async (trx) => {
        const row = await trx
          .selectFrom("models")
          .select(["name", "nameSource"])
          .where("id", "=", id)
          .where("trashedAt", "is", null)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined || row.nameSource !== "file" || row.name === name) return false;
        const files = await trx
          .selectFrom("files")
          .select("originalName")
          .where("modelId", "=", id)
          .execute();
        if (!fileStems(files.map((f) => f.originalName)).has(row.name)) return false;
        const result = await trx
          .updateTable("models")
          .set({ name, nameSource: "title", updatedAt: sql`now()` })
          .where("id", "=", id)
          .where("nameSource", "=", "file")
          .where("name", "=", row.name)
          .executeTakeFirst();
        return result.numUpdatedRows > 0n;
      });
    },

    /**
     * The "Use file titles" backfill's preview: which live models it would
     * rename from their file's title, and which it leaves alone and why.
     * The title is the model's caption, which ingest fills from the .3mf's
     * MakerWorld Title, so no file is read from the bucket. A model made by
     * an import (one with an externalRef) is skipped: the importer copies
     * the source library's caption as written, so it is not a title. The
     * other rules are nameFromTitle's. Changes nothing.
     */
    titleNamePlan,

    /**
     * Runs the backfill the preview with this planId showed: renames each
     * model it lists, in one transaction, and marks it named from its title.
     * The list is worked out again here, and when it is not the previewed one
     * (its planId differs: a model was renamed, a file added, a caption
     * changed) nothing is renamed and the answer is null, so a model the
     * preview did not show is never renamed. Each update also requires
     * name_source 'file' and the name the preview saw, so a rename that lands
     * while this runs still wins; renamed counts only the models changed.
     */
    async applyTitleNames(planId: string): Promise<{ renamed: number } | null> {
      return inTransaction(db, async (trx) => {
        const plan = await modelsRepo(trx).titleNamePlan();
        if (plan.planId !== planId) return null;
        let renamed = 0;
        for (const { id, from, to } of plan.renames) {
          const result = await trx
            .updateTable("models")
            .set({ name: to, nameSource: "title", updatedAt: sql`now()` })
            .where("id", "=", id)
            .where("nameSource", "=", "file")
            .where("name", "=", from)
            .where("trashedAt", "is", null)
            .executeTakeFirst();
          if (result.numUpdatedRows > 0n) renamed += 1;
        }
        return { renamed };
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

    /**
     * searchRanked's matches with only id, name, creator and rank, for a
     * numbered library page, which reads up to 1000 matches to slice one page
     * and count them, and needs no description or licence to do it.
     */
    searchRankedCards,

    /**
     * Moves a live model to the trash; false when it is unknown or already
     * there. trashed_at is the time the row is written once its lock is held
     * (issue #193), so Empty trash's cutoff, the time the page read the
     * trash, never covers a model trashed after that read. now() is the time
     * the statement began, so an UPDATE that waited on the model's row lock
     * (an ingest holds it FOR UPDATE while it writes) kept that earlier time.
     * clock_timestamp() alone is not enough either: when the holder changes
     * nothing, Postgres builds the new row, clock_timestamp() included, before
     * it waits and writes it as built. So the sub-select takes the row lock
     * first (FOR UPDATE, re-reading trashed_at after any wait), and the stamp
     * is taken after that.
     */
    async trash(id: string): Promise<boolean> {
      if (!isUuid(id)) return false;
      const result = await db
        .updateTable("models")
        .set({ trashedAt: sql`clock_timestamp()` })
        .where("id", "=", (eb) =>
          eb
            .selectFrom("models as locked")
            .select("locked.id")
            .where("locked.id", "=", id)
            .where("locked.trashedAt", "is", null)
            .forUpdate(),
        )
        .where("trashedAt", "is", null)
        .executeTakeFirst();
      return result.numUpdatedRows > 0n;
    },

    /**
     * Brings a trashed model back; false when it is unknown, not trashed, or
     * a purge of it has begun (purge_started_at is set: some of its objects
     * may already be gone, so only a purge may finish it, and the
     * models_purge_only_trashed check would refuse the update anyway).
     * library/trash.ts's restoreModel tells that last case apart and throws
     * PurgeStarted; this answers false for it, never a database error.
     */
    async restore(id: string): Promise<boolean> {
      if (!isUuid(id)) return false;
      const result = await db
        .updateTable("models")
        .set({ trashedAt: null })
        .where("id", "=", id)
        .where("trashedAt", "is not", null)
        .where("purgeStartedAt", "is", null)
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
