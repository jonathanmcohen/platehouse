import { createHash } from "node:crypto";
import { type Kysely, sql } from "kysely";
import { isUuid, uuidv7 } from "../db/ids.js";
import { inTransaction } from "../db/kysely.js";
import type { DB, NameSource } from "../db/types.js";
import { cutName, fileStems } from "../ingest/names.js";
import { descriptionSha256 } from "../library/description-hash.js";

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
   * empty, since a description already set is never edited (the maintainer,
   * 2026-11-08). The model page shows license_note (Task 20).
   */
  licenseNote?: string | null;
  /** The MakerWorld design ID, digits only (packages/threemf makerWorldDesignId). */
  makerworldDesignId?: string | null;
  /**
   * Where descriptionMd was converted from (ingest only): the .3mf and the
   * converter version. When the description is filled, its SHA-256, this
   * version and this file are stored with it (migration 0010), so the
   * re-conversion (library/reconvert.ts) can tell later that it is still
   * exactly what the converter wrote. Left out, as for the API's
   * create-model, a description filled is recorded as from no converter.
   */
  descriptionSource?: { fileId: string; converter: number };
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
    /**
     * name_source 'user': renamed by a person, or made through the public
     * API's create-model (the Manyfold import among them), which stores
     * 'user' too, so the page says "named by you or through the API".
     */
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
    /**
     * Its caption was not read from a .3mf by ingest (#258). A caption has
     * two writers: ingest, which fills an empty one from a .3mf's MakerWorld
     * Title, and the public API's create-model, which takes free text. Only
     * a model ingest made counts, one that shares its transaction, and so
     * its created_at, with one of its files; a model the API made never
     * does, since its files come in later requests.
     */
    captionNotFromFile: number;
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
 * What decides which live models a library view shows: its search and its
 * tag, collection and creator filters. Its order (sort) and the printer
 * whose numbers it shows do not change which models are in it.
 */
export type LibraryView = Pick<RankedSearchQuery, "q" | "tag" | "collection" | "creator">;

/**
 * The library's orders (the maintainer, 2026-11-19). relevance is best match first;
 * the others are by date added, name ignoring case, total print time or
 * weight for the selected printer, and plate count. Every order ends with
 * the model's id, so it is total and models that tie always come in the
 * same order. Pages sliced by offset hold together only while the order
 * holds still: a model whose time or weight total arrives between two
 * requests moves, and it or a model on a page boundary can repeat or be
 * skipped.
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

/**
 * How many leading characters of a name the name index holds (migration
 * 0009: lower(left(name, 200)), left(name, 200)). Two whole names of up to
 * 500 characters went over btree's row limit in CJK script or emoji; 200
 * characters stay under it in any script. The name sort orders by that
 * prefix first, then by the whole name. Written into the query as a literal,
 * since Postgres matches an index expression only to the same expression.
 */
export const NAME_SORT_CHARS = 200;
const NAME_PREFIX = sql.lit(NAME_SORT_CHARS);

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
   * The live models a view shows, as a query from models left-joined to
   * creators with no columns, order or limit: the search (name, caption,
   * creator or a tag, ignoring case; blank matches every live model) and
   * the tag, collection and creator filters. The ranked search and inView
   * both start from it, so a bulk action decides which models a view holds
   * exactly as the library page lists them.
   */
  function viewQuery(view: LibraryView) {
    const pattern = containsPattern(view.q.trim());
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
    const { tag, collection, creator } = view;
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
    return select;
  }

  /**
   * Of these ids (well-formed, lowercase), the ones the view shows now, in
   * the order given: live models that match its search and filters. The
   * sort and the paged match cap play no part, so this is every match, not
   * only the first 1000 a page can reach.
   */
  async function inView(view: LibraryView, ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = await viewQuery(view)
      .select("models.id")
      .where("models.id", "in", [...ids])
      .execute();
    const found = new Set(rows.map((r) => r.id));
    return ids.filter((id) => found.has(id));
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
    const rank = sql<number>`round(greatest(
        similarity(models.name, ${q}),
        similarity(coalesce(models.caption, ''), ${q}),
        similarity(coalesce(creators.name, ''), ${q}),
        coalesce((
          select max(similarity(t.name, ${q}))
          from model_tags mt join tags t on t.id = mt.tag_id
          where mt.model_id = models.id), 0)
      ) * ${SEARCH_RANK_MAX})::integer`;

    let select = viewQuery(query);
    const { after } = query;
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
    // The sort's order, then the model's id, so the order is total and
    // models that tie always come in the same order. (A model whose time or
    // weight total arrives between two page requests still moves.) A time,
    // weight or plate count tie goes by name ignoring case, then id.
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
        // The index's prefix first (NAME_SORT_CHARS), then the whole name.
        select = select
          .orderBy(sql`lower(left(models.name, ${NAME_PREFIX}))`, dir)
          .orderBy(sql`left(models.name, ${NAME_PREFIX})`, dir)
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

  async function titleNamePlan(): Promise<TitleNamePlan> {
    const models = await db
      .selectFrom("models")
      .select(["id", "name", "nameSource", "caption", "externalRef"])
      // Made by ingest: one of its files was written in the transaction
      // that made the model (now() is the transaction's start, so the two
      // created_at values are equal to the microsecond). Compared in SQL,
      // since a JavaScript Date keeps only milliseconds.
      .select((eb) =>
        eb
          .exists(
            eb
              .selectFrom("files")
              .select("files.id")
              .whereRef("files.modelId", "=", "models.id")
              .whereRef("files.createdAt", "=", "models.createdAt"),
          )
          .as("madeByIngest"),
      )
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
      captionNotFromFile: 0,
    };
    for (const m of models) {
      const title = cutName(m.caption);
      if (m.nameSource === "user") skipped.renamedByUser += 1;
      else if (m.nameSource === "title") skipped.namedFromTitle += 1;
      else if (m.externalRef !== null) skipped.imported += 1;
      else if (title === null) skipped.noTitle += 1;
      else if (!m.madeByIngest) skipped.captionNotFromFile += 1;
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
     * that is null or empty, so nothing the user set is overwritten. The name is
     * never touched. A found value that is null, empty or blank writes
     * nothing. A found licence note is stored whenever licenseNote is empty,
     * whatever licenseSpdx holds (the maintainer's decision: license_note is always
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

        let source: Partial<
          Record<"descriptionSha256" | "descriptionFileId", string> & {
            descriptionConverter: number;
          }
        > = {};
        if (empty(row.descriptionMd)) {
          const parts = [value(found.descriptionMd), fillLicence ? note : undefined];
          const description = parts.filter((p) => p !== undefined).join("\n\n");
          if (description !== "") {
            set.descriptionMd = description;
            if (found.descriptionSource !== undefined) {
              source = {
                descriptionSha256: descriptionSha256(description),
                descriptionConverter: found.descriptionSource.converter,
                descriptionFileId: found.descriptionSource.fileId,
              };
            }
          }
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
          .set({ ...set, ...source, updatedAt: sql`now()` })
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
     * 'user', which migration 0006 also gave every model a person named
     * before name_source existed) or a name none of its files has, is never
     * overwritten (AC-022), and a model already named from a title
     * keeps that one. Only while the caption is empty, too, so this title is
     * the one fillMetadata then stores as the caption: a model whose caption
     * an earlier .3mf already filled keeps its name, so its name and caption
     * never disagree and Use file titles (which names it from that caption)
     * picks the same title. True when the name changed. Runs in the caller's
     * transaction when there is one, with the model's row locked.
     */
    async nameFromTitle(id: string, title: string | null | undefined): Promise<boolean> {
      const name = cutName(title);
      if (name === null || !isUuid(id)) return false;
      return inTransaction(db, async (trx) => {
        const row = await trx
          .selectFrom("models")
          .select(["name", "nameSource", "caption"])
          .where("id", "=", id)
          .where("trashedAt", "is", null)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined || row.nameSource !== "file" || row.name === name) return false;
        // fillMetadata's test for an empty caption.
        if (row.caption !== null && row.caption !== "") return false;
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
     * the source library's caption as written, so it is not a title. So is
     * any other model ingest did not make (captionNotFromFile, #258), such
     * as one made through the public API's create-model, whose caption is
     * the client's free text. The other rules are nameFromTitle's. Changes
     * nothing.
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
     * Of some models, the ones a library view shows now: its search and
     * filters, the ranked search's own rule (repos/bulk.ts keeps a bulk
     * action to them). Trashed models never appear.
     */
    inView,

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
