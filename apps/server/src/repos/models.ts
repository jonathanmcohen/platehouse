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
   * Stored as license_note whenever the model has none, whatever its SPDX id
   * (license_note is always stored); it is added at the foot of the
   * description only when the description and both licence columns are
   * empty, since a description already set is never edited (Jon,
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
  /**
   * Only models after this one in the result order (keyset paging). Only
   * with the relevance sort: the cursor carries a rank, name and id.
   */
  after?: { rank: number; name: string; id: string } | undefined;
  /** The order; relevance (best match, then name and id) when left out. */
  sort?: LibrarySort | undefined;
  /** Whose numbers the time and weight sorts total; required for those sorts. */
  printer?: SortPrinter | undefined;
  /** At most this many models, 1 to 1000 (1001 for searchRankedCards). */
  limit: number;
}

/**
 * The library's orders (Jon, 2026-11-19). relevance is best match first;
 * the others are by date added, name ignoring case, total print time or
 * weight for the selected printer, and plate count. Every order ends with
 * the model's id, so it is total and a page never repeats or skips a model.
 */
export const LIBRARY_SORTS = [
  "relevance",
  "newest",
  "oldest",
  "name-asc",
  "name-desc",
  "time-asc",
  "time-desc",
  "weight-asc",
  "weight-desc",
  "plates-desc",
  "plates-asc",
] as const;

export type LibrarySort = (typeof LIBRARY_SORTS)[number];

/** The sort when none is named: best match while a search is active, else newest. */
export function defaultSort(q: string | undefined): LibrarySort {
  return (q ?? "").trim() === "" ? "newest" : "relevance";
}

/**
 * Whose numbers the time and weight sorts total, as the library's cards do
 * (app-api/library.ts numbersFor over estimates/display.ts plateNumbers): a
 * plate whose newest file numbers were sliced for fileModelId with
 * fileNozzle (the selected printer's) has those numbers when
 * fileNumbersCount, and none otherwise; any other plate has a finished
 * Platehouse estimate for printerId and orcaVersion, if any. fileModelId and
 * fileNozzle are null when the printer menu is unread or does not name the
 * selected printer. fileNumbersCount is false when the menu names the
 * selected printer after another with the same model and nozzle: the cards
 * label a file's numbers with that first printer, so the selected one never
 * gets them.
 */
export interface SortPrinter {
  printerId: string;
  orcaVersion: string | null;
  fileModelId: string | null;
  fileNozzle: number | null;
  fileNumbersCount: boolean;
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

/** Two nozzle sizes within this are the same, as in estimates/display.ts. */
const NOZZLE_TOLERANCE = 0.001;

/**
 * A model's total print time or weight for the printer: the sum over the
 * plates of its .3mf files, or null when it has no plates or any plate has
 * no numbers for that printer, the rule the library's cards total by. A
 * plate's numbers are its newest finished file numbers when those were
 * sliced for the printer's model and nozzle (and then only those, as
 * plateNumbers returns early), else the Platehouse estimate for the printer
 * and Orca version once it is finished. Each estimate lookup is served by
 * the estimates_key index (plate_id, source, ...), each plate lookup by
 * plates (file_id, index) and files_model_id.
 */
function totalFor(column: "time_seconds" | "weight_grams", printer: SortPrinter) {
  const col = sql.raw(column);
  return sql<number | null>`(
    select case when count(*) > 0 and count(n.v) = count(*) then sum(n.v) end
    from plates p
    join files f on f.id = p.file_id
    left join lateral (
      select e.printer_model_id, e.nozzle, e.${col} as v
      from estimates e
      where e.plate_id = p.id and e.source = 'file' and e.status = 'ok'
      order by e.created_at desc, e.id desc
      limit 1
    ) fe on true
    left join lateral (
      select e.status, e.${col} as v
      from estimates e
      where e.plate_id = p.id and e.source = 'platehouse'
        and e.printer_id = ${printer.printerId}
        and e.slicer_version is not distinct from cast(${printer.orcaVersion} as text)
      order by e.created_at desc, e.id desc
      limit 1
    ) pe on true
    cross join lateral (
      select case
        when cast(${printer.fileModelId} as text) is not null
          and fe.printer_model_id = cast(${printer.fileModelId} as text)
          and abs(fe.nozzle - cast(${printer.fileNozzle} as double precision)) < ${NOZZLE_TOLERANCE}
          then case when cast(${printer.fileNumbersCount} as boolean) then fe.v end
        when pe.status = 'ok' then pe.v
      end as v
    ) n
    where f.model_id = models.id and f.kind = '3mf'
  )`;
}

/** How many plates a model's .3mf files have. */
const PLATE_COUNT = sql<number>`(
  select count(*)
  from plates p
  join files f on f.id = p.file_id
  where f.model_id = models.id and f.kind = '3mf'
)`;

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
  function rankedQuery(query: RankedSearchQuery, maxLimit = MAX_RANKED_LIMIT) {
    const q = query.q.trim();
    const limit = Math.trunc(query.limit);
    if (!(limit >= 1 && limit <= maxLimit)) {
      throw new RangeError(`searchRanked takes a limit from 1 to ${maxLimit}`);
    }
    const sort = query.sort ?? "relevance";
    if (query.after !== undefined && sort !== "relevance") {
      throw new RangeError("A cursor pages only the relevance order");
    }
    const { printer } = query;
    const byTotal = sort.startsWith("time-") || sort.startsWith("weight-");
    if (byTotal && printer === undefined) {
      throw new RangeError(`The ${sort} sort needs the selected printer`);
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
    // The sort's order, then the model's id, so the order is total and a
    // page sliced from it never repeats or skips a model. A time, weight or
    // plate count tie goes by name ignoring case, then id.
    switch (sort) {
      case "relevance":
        select = select.orderBy(rank, "desc").orderBy("models.name").orderBy("models.id");
        break;
      case "newest":
      case "oldest": {
        const dir = sort === "newest" ? "desc" : "asc";
        select = select.orderBy("models.createdAt", dir).orderBy("models.id", dir);
        break;
      }
      case "name-asc":
      case "name-desc": {
        const dir = sort === "name-asc" ? "asc" : "desc";
        select = select
          .orderBy(sql`lower(models.name)`, dir)
          .orderBy("models.name", dir)
          .orderBy("models.id", dir);
        break;
      }
      case "plates-desc":
      case "plates-asc":
        select = select
          .orderBy(PLATE_COUNT, sort === "plates-desc" ? "desc" : "asc")
          .orderBy(sql`lower(models.name)`, "asc")
          .orderBy("models.id", "asc");
        break;
      default: {
        const total = totalFor(
          sort.startsWith("time-") ? "time_seconds" : "weight_grams",
          printer as SortPrinter,
        );
        const asc = sort.endsWith("-asc");
        select = select
          .orderBy(total, (ob) => (asc ? ob.asc().nullsLast() : ob.desc().nullsLast()))
          .orderBy(sql`lower(models.name)`, "asc")
          .orderBy("models.id", "asc");
      }
    }
    return { rank, select: select.limit(limit) };
  }

  async function searchRanked(query: RankedSearchQuery): Promise<Array<Model & { rank: number }>> {
    const { rank, select } = rankedQuery(query);
    return select.select(MODEL_COLUMNS).select(rank.as("rank")).execute();
  }

  async function searchRankedCards(query: RankedSearchQuery): Promise<RankedCard[]> {
    // Up to one past the most a numbered page counts, so one read tells
    // whether there are more matches than it counts.
    const { rank, select } = rankedQuery(query, MAX_RANKED_LIMIT + 1);
    return select
      .select(["models.id", "models.name", "creators.name as creator"])
      .select(rank.as("rank"))
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
