// The organising pages' app API (rename, tags, flat collections, and the trash
// with restore and Empty trash): the Creators, Collections, Tags and Trash pages. Every route
// is session-class under /app/api (settings.ts, appApiScope), so it needs
// a signed-in session, and every state-changing one Origin = PUBLIC_ORIGIN.
//
//   GET    /app/api/creators | /collections | /tags   {<list>: [{name, models}]}
//   DELETE /app/api/tags?name= | /collections?name=   204 | 404: delete it (#312)
//   GET    /app/api/organise/models?creator|collection|tag&cursor
//                                                     {models, nextCursor}
//   PATCH  /app/api/models/:id   {name}               rename a model
//   PATCH  /app/api/files/:id    {name}               rename a file
//   PUT    /app/api/models/:id/tags?name=             tag {name} (DELETE: untag)
//   PUT    /app/api/models/:id/collections?name=      add {name} (DELETE: take out)
//   POST   /app/api/models/:id/trash                  move to the trash
//   GET    /app/api/trash                             {models: [... purgeAt], readAt, emptying, purging}
//   POST   /app/api/trash/:id/restore                 204 | 404 | 409 purge began
//   POST   /app/api/trash/empty  {cutoff}             202 {queued}
//   POST   /app/api/bulk/add-tags {ids, tags, view}   {changed, unchanged, failed, notInView, tags}
//   POST   /app/api/bulk/remove-tag {ids, tag, view}  {changed, unchanged, failed, notInView, tag}
//   POST   /app/api/bulk/add-to-collection {ids, collection, view}
//                                                     {changed, unchanged, failed, notInView, collection}
//   POST   /app/api/bulk/trash {ids, view}            {changed, unchanged, failed, notInView}
//   POST   /app/api/bulk/in-view {ids, view}          {ids}  the ones the view holds; changes nothing
//
// The bulk routes are the library's Select mode (the maintainer, 2026-11-19): up to
// MAX_BULK_IDS models (1000, as View all) a request, in one transaction, and
// a model that is in the trash or not found is reported in failed with its
// reason while the others change (repos/bulk.ts). Bulk trash is the same
// soft delete as Move to trash: restorable for 30 days, never a purge.
//
// The server keeps Select mode to the models the user can see (the maintainer,
// 2026-11-20, after the 0.1.0-rc.2 live checks): every bulk request carries
// view, the library view the selection was made in, with the same q, tag,
// collection, creator and printer fields as GET /app/api/library/ids (read
// by library.ts's viewOf, so a blank one is no filter; printer, like the
// sort, does not change which models a view holds). Only the posted models
// that view holds when the action runs are changed; the others come back in
// notInView, untouched. A request without a view is refused (400).
// /bulk/in-view answers the same question without acting: which of the
// posted models the view holds now, with no sort and no match cap. The
// library page's view check asks it about selected models past the first
// 1000 matches GET /app/api/library/ids answers (PR #313 review). These
// routes are the web app's own session API: the public API (v1) has no bulk
// routes, and its description and docs do not change.
//
// Every change calls the library module (library/): renameModel and renameFile (the
// display name only; the bucket key never changes), addTag and removeTag,
// addToCollection and removeFromCollection (flat collections, made on first
// use), trashModel, restoreModel and requestPurge. Each refuses a model that
// is unknown or in the trash, which is 404 here; taking off a tag or a
// collection the model does not have is 404 too. The lists count live
// models only, and the model rows are the library's search with one filter, a
// page of up to ROWS_PER_PAGE at a time.
//
// Deleting tags and collections (issue #312, the maintainer, 2026-11-21).
// DELETE /tags and /collections delete one by name, ignoring case, from
// every model that has it, trashed ones included, and change no model
// otherwise; 404 when there is no such name. Here, unlike in the public API,
// taking a tag off its last model (one model's Remove tag, bulk Remove tag)
// removes the tag, and so does deleting that model for good (trash.ts); a
// model in the trash still has its tags, so it keeps one. Collections are
// never removed on their own. The Tags and Collections lists show every tag
// and collection but one only trashed models use, so one no model uses is
// listed with 0 and can be deleted.
//
// Tags and collections are one per name ignoring case, and the first name
// written is the one kept, so a PUT answers {name}: the name the tag or
// collection is stored under, which may differ in capitals from the one
// asked for. The page shows that name on the chip it adds. The name goes in
// the query string, never the path: a browser's URL parser rewrites a path
// segment of "." or ".." (%2E too) before the request goes out, and such
// names can be stored through the public API v1's create-model body.
//
// A trashed model's purge date is its trash date plus TRASH_RETENTION_DAYS:
// the daily purge (03:30) removes it on its first run after that. A model
// whose purge has begun is listed with purgeStarted, and restore refuses it
// (409), as restoreModel does.
//
// Empty trash marks only what the page listed. GET /app/api/trash answers
// readAt, the database's time when it read the list (the clock that stamps
// trashed_at, so a browser's clock never matters), and the page sends it back
// as the cutoff. The route marks every model trashed at or before that
// millisecond in one statement (the library's requestPurge), queues an
// empty-trash job on the maintenance queue, and answers 202 {queued}, the
// number it marked, at once; the job purges them (the library's
// purgeMarked). A model another tab or browser trashed after the page read
// the list is not marked, and can be restored. The body is one timestamp
// however long the trash is. A cutoff that is not in readAt's form, or is
// later than the database's clock, is refused with 400.
//
// The races, under Postgres's READ COMMITTED. A restore that holds a model's
// row (restoreModel locks it FOR UPDATE) makes the marking statement wait;
// once the restore commits, the statement reads the row again, finds it live
// and leaves it, so the restore wins. A restore after the marking committed
// finds the marker and is refused (409 purge_started). The job is sent in the
// same transaction as the marking, so a mark never commits without its job,
// and is skipped when an empty-trash job is already queued and not started:
// that job lists the marked models when it starts, so it purges these too.
// The check reads that job's row FOR SHARE in the same transaction. pg-boss
// claims a job with FOR UPDATE SKIP LOCKED, so a worker passes over a job
// this check holds until the marks commit, and its list then has them; a job
// a worker claimed first makes the check wait, and once the claim commits
// the job is active, so the check finds none queued and sends a new one.
// Without the lock, a job claimed between the check and the commit could
// list the models before these marks are visible, and leave them marked
// with no job until the daily purge. The marking locks the models in id
// order, as the bulk actions do, so two requests at once do not deadlock:
// both mark the models trashed before the earlier cutoff, so one waits on
// the other's row locks until it commits, and then finds its job. A request
// that marks nothing sends none.
//
// While an empty-trash job is queued or running, GET /app/api/trash answers
// emptying: true, and purging counts the marked models on every page, so the
// Trash page can show them as being deleted until they are gone. A job that
// fails leaves its models marked and listed; the next Empty trash, or the
// daily purge, finishes them.
//
// What a cutoff cannot tell apart: a model whose trashing wrote its row
// before the list was read but committed after, or one trashed later in
// readAt's own millisecond, is marked though the page did not show it.
// trashed_at is the time the row is written once its lock is held
// (repos/models.ts; issue #193), so a trash that waits on the model's row
// lock (an ingest holds it FOR UPDATE while it writes, derived and live
// reads FOR SHARE) is stamped after the wait, and the first window is only
// the time between the row update and the commit. A model whose purge
// already began keeps its marker and is purged with the others, whenever it
// was trashed; such a model cannot be restored anyway, and the daily purge
// would finish it.
import type { FastifyInstance } from "fastify";
import { type Kysely, sql } from "kysely";
import type { PgBoss } from "pg-boss";
import type { DB, FileKind } from "../db/types.js";
import { bossDb } from "../jobs/boss.js";
import { ON_DEMAND_TASKS, QUEUE } from "../jobs/queues.js";
import { createCollections } from "../library/collections.js";
import { createRename } from "../library/rename.js";
import { createSearch, InvalidCursor } from "../library/search.js";
import { createTags } from "../library/tags.js";
import { type createTrash, PurgeStarted, TRASH_RETENTION_DAYS } from "../library/trash.js";
import { BOSS_JOB } from "../repos/activity.js";
import { bulkRepo, MAX_BULK_IDS, MAX_BULK_TAGS } from "../repos/bulk.js";
import { collectionsRepo } from "../repos/collections.js";
import { tagsRepo } from "../repos/tags.js";
import { MAX_PAGE_NUMBER, MAX_PAGE_SIZE, pageWindow, viewOf } from "./library.js";
import { appApiScope, need, refuse } from "./settings.js";

/** The model rows one request of /app/api/organise/models answers at most. */
export const ROWS_PER_PAGE = 100;

const DAY_MS = 86_400_000;

export interface OrganiseDeps {
  db: Kysely<DB>;
  trash: Pick<ReturnType<typeof createTrash>, "trashModel" | "restoreModel" | "requestPurge">;
  /** Where Empty trash queues its job, in the marking's transaction. */
  boss: Pick<PgBoss, "send">;
}

/** A model as the organising pages show it: its chips and its files. */
export interface OrganiseModel {
  id: string;
  name: string;
  creator: string | null;
  tags: string[];
  collections: string[];
  files: Array<{ id: string; name: string; kind: FileKind }>;
}

/** A model in the trash, with the day the daily purge removes it after. */
export interface TrashedModel {
  id: string;
  name: string;
  creator: string | null;
  trashedAt: string;
  purgeAt: string;
  purgeStarted: boolean;
}

const LABEL = { type: "string", minLength: 1, maxLength: 100, pattern: "\\S" } as const;
const ID = { type: "string", maxLength: 100 } as const;
const NAME_BODY = {
  type: "object",
  properties: { name: { type: "string", minLength: 1, maxLength: 500, pattern: "\\S" } },
  required: ["name"],
} as const;
const ID_PARAMS = { type: "object", properties: { id: ID }, required: ["id"] } as const;
const NAME_QUERY = {
  type: "object",
  properties: { name: LABEL },
  required: ["name"],
} as const;
const ROWS_QUERY = {
  type: "object",
  properties: {
    creator: { type: "string", maxLength: 300 },
    collection: { type: "string", maxLength: 100 },
    tag: { type: "string", maxLength: 100 },
    cursor: { type: "string", maxLength: 2000 },
  },
} as const;

/**
 * The library view a bulk action's selection was made in: the fields
 * GET /app/api/library/ids takes for which models match, with its limits.
 * Each may be left out; an empty object is the whole library.
 */
const BULK_VIEW = {
  type: "object",
  properties: {
    q: { type: "string", maxLength: 200 },
    tag: { type: "string", maxLength: 100 },
    collection: { type: "string", maxLength: 100 },
    creator: { type: "string", maxLength: 300 },
    printer: { type: "string", maxLength: 200 },
  },
} as const;

/** The selected models of a bulk action: 1 to MAX_BULK_IDS ids. */
const BULK_IDS = {
  type: "array",
  minItems: 1,
  maxItems: MAX_BULK_IDS,
  items: ID,
} as const;
const BULK_TAGS_BODY = {
  type: "object",
  properties: {
    ids: BULK_IDS,
    tags: { type: "array", minItems: 1, maxItems: MAX_BULK_TAGS, items: LABEL },
    view: BULK_VIEW,
  },
  required: ["ids", "tags", "view"],
} as const;
const BULK_TAG_BODY = {
  type: "object",
  properties: { ids: BULK_IDS, tag: LABEL, view: BULK_VIEW },
  required: ["ids", "tag", "view"],
} as const;
const BULK_COLLECTION_BODY = {
  type: "object",
  properties: { ids: BULK_IDS, collection: LABEL, view: BULK_VIEW },
  required: ["ids", "collection", "view"],
} as const;
const BULK_TRASH_BODY = {
  type: "object",
  properties: { ids: BULK_IDS, view: BULK_VIEW },
  required: ["ids", "view"],
} as const;
const BULK_IN_VIEW_BODY = BULK_TRASH_BODY;

const CUTOFF_BODY = {
  type: "object",
  properties: { cutoff: { type: "string", maxLength: 40 } },
  required: ["cutoff"],
} as const;

/** The form Date.prototype.toISOString writes, which readAt is sent in. */
const ISO_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const STALE_TRASH = "The trash list is out of date. Reload the page and try again.";

/** What a restore of a model whose purge has begun says (409 purge_started). */
export const PURGE_STARTED_MESSAGE =
  "Deleting this model for good has already begun, so it cannot be restored.";

type IdParams = { id: string };
type CutoffBody = { cutoff: string };
type NameQuery = { name: string };
type NameBody = { name: string };
type RowsQuery = { creator?: string; collection?: string; tag?: string; cursor?: string };
/** A bulk request's view, as BULK_VIEW lets it through. */
type BulkView = {
  q?: string;
  tag?: string;
  collection?: string;
  creator?: string;
  printer?: string;
};

/** Names with how many live models carry each, in alphabetical order ignoring case. */
async function creatorCounts(db: Kysely<DB>) {
  return db
    .selectFrom("creators")
    .innerJoin("models", "models.creatorId", "creators.id")
    .select(["creators.name", sql<number>`count(*)::int`.as("models")])
    .where("models.trashedAt", "is", null)
    .groupBy("creators.name")
    .orderBy(sql`lower(creators.name)`)
    .orderBy("creators.name")
    .execute();
}

/**
 * Tags with how many live models have each, in alphabetical order ignoring
 * case: every tag but one that only trashed models have (issue #312). A tag
 * no model has is listed with 0, so it can be deleted; one only trashed
 * models have is not, as a restore brings it back.
 */
async function tagCounts(db: Kysely<DB>) {
  return db
    .selectFrom("tags")
    .leftJoin("modelTags", "modelTags.tagId", "tags.id")
    .leftJoin("models", (join) =>
      join.onRef("models.id", "=", "modelTags.modelId").on("models.trashedAt", "is", null),
    )
    .select(["tags.name", sql<number>`count(models.id)::int`.as("models")])
    .groupBy(["tags.id", "tags.name"])
    .having(sql<boolean>`count(models.id) > 0 or count(model_tags.model_id) = 0`)
    .orderBy(sql`lower(tags.name)`)
    .orderBy("tags.name")
    .execute();
}

/** As tagCounts, for collections: an empty one is listed with 0 (issue #312). */
async function collectionCounts(db: Kysely<DB>) {
  return db
    .selectFrom("collections")
    .leftJoin("collectionModels", "collectionModels.collectionId", "collections.id")
    .leftJoin("models", (join) =>
      join.onRef("models.id", "=", "collectionModels.modelId").on("models.trashedAt", "is", null),
    )
    .select(["collections.name", sql<number>`count(models.id)::int`.as("models")])
    .groupBy(["collections.id", "collections.name"])
    .having(sql<boolean>`count(models.id) > 0 or count(collection_models.model_id) = 0`)
    .orderBy(sql`lower(collections.name)`)
    .orderBy("collections.name")
    .execute();
}

/**
 * The name a tag or collection is stored under, matched as its unique index
 * does. A delete can remove the row between the tagging commit and this read
 * (issue #431); the answer is then the name that was asked for.
 */
export async function storedName(
  db: Kysely<DB>,
  table: "tags" | "collections",
  name: string,
): Promise<string> {
  const row = await db
    .selectFrom(table)
    .select("name")
    .where(sql<boolean>`lower(name) = lower(${name.trim()})`)
    .executeTakeFirst();
  return row?.name ?? name.trim();
}

/** Each model's tags, collections and files, for the rows of the organising pages. */
async function organiseRows(
  db: Kysely<DB>,
  models: Array<{ id: string; name: string; creator: string | null }>,
): Promise<OrganiseModel[]> {
  if (models.length === 0) return [];
  const ids = models.map((m) => m.id);
  const [tagRows, collectionRows, fileRows] = await Promise.all([
    db
      .selectFrom("modelTags")
      .innerJoin("tags", "tags.id", "modelTags.tagId")
      .select(["modelTags.modelId", "tags.name"])
      .where("modelTags.modelId", "in", ids)
      .orderBy(sql`lower(tags.name)`)
      .orderBy("tags.name")
      .execute(),
    db
      .selectFrom("collectionModels")
      .innerJoin("collections", "collections.id", "collectionModels.collectionId")
      .select(["collectionModels.modelId", "collections.name"])
      .where("collectionModels.modelId", "in", ids)
      .orderBy(sql`lower(collections.name)`)
      .orderBy("collections.name")
      .execute(),
    db
      .selectFrom("files")
      .select(["id", "modelId", "name", "kind"])
      .where("modelId", "in", ids)
      .orderBy("createdAt")
      .orderBy("id")
      .execute(),
  ]);
  const group = <T extends { modelId: string }>(rows: T[]) => {
    const by = new Map<string, T[]>();
    for (const r of rows) by.set(r.modelId, [...(by.get(r.modelId) ?? []), r]);
    return by;
  };
  const tags = group(tagRows);
  const collections = group(collectionRows);
  const files = group(fileRows);
  return models.map((m) => ({
    id: m.id,
    name: m.name,
    creator: m.creator,
    tags: (tags.get(m.id) ?? []).map((t) => t.name),
    collections: (collections.get(m.id) ?? []).map((c) => c.name),
    files: (files.get(m.id) ?? []).map((f) => ({ id: f.id, name: f.name, kind: f.kind })),
  }));
}

/** The database's clock, which stamps trashed_at. */
async function databaseNow(db: Kysely<DB>): Promise<Date> {
  const { rows } = await sql<{ now: Date }>`select now() as now`.execute(db);
  const now = rows[0]?.now;
  if (now === undefined) throw new Error("select now() answered no row");
  return now;
}

/** Models on one page of the trash when the request names no limit. */
export const TRASH_PAGE_SIZE = 100;

/** GET /app/api/trash's query: a 1-based page and a page size, as the library's. */
const TRASH_QUERY = {
  type: "object",
  properties: {
    page: { type: "integer", minimum: 1, maximum: MAX_PAGE_NUMBER },
    limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_SIZE },
  },
} as const;

/**
 * One page of the trash, newest first, and readAt: the database's time when
 * it read the page, taken in the same statement so the list and the time
 * agree. A page past the end is served as the last page. Empty trash's
 * cutoff is readAt whichever page it came from, so a model trashed after it
 * is never purged unseen, on any page. emptying: an empty-trash job is
 * queued or running; purging: the trashed models with the purge marker, on
 * every page.
 */
async function trashListing(
  db: Kysely<DB>,
  query: { page?: number; limit?: number } = {},
): Promise<{
  models: TrashedModel[];
  readAt: string;
  page: number;
  pageSize: number;
  pageCount: number;
  total: number;
  emptying: boolean;
  purging: number;
}> {
  // The count and the page are separate reads, so total can differ from the
  // page by a model trashed between them; safety comes from readAt, not total.
  const pageSize = query.limit ?? TRASH_PAGE_SIZE;
  const counted = await db
    .selectFrom("models")
    .select(sql<string>`count(*)`.as("total"))
    .where("models.trashedAt", "is not", null)
    .executeTakeFirstOrThrow();
  const total = Number(counted.total);
  const window = pageWindow({ total, pageSize, page: query.page ?? 1 });
  const rows = await db
    .selectFrom("models")
    .leftJoin("creators", "creators.id", "models.creatorId")
    .select([
      "models.id",
      "models.name",
      "creators.name as creator",
      "models.trashedAt",
      "models.purgeStartedAt",
      sql<Date>`now()`.as("readAt"),
    ])
    .where("models.trashedAt", "is not", null)
    .orderBy("models.trashedAt", "desc")
    .orderBy("models.id", "desc")
    .limit(pageSize)
    .offset(window.start)
    .execute();
  const readAt = rows[0]?.readAt ?? (await databaseNow(db));
  const { rows: progress } = await sql<{ emptying: boolean; purging: number }>`
    select exists (
             select 1 from ${BOSS_JOB}
              where name = ${QUEUE.maintenance}
                and data->>'task' = ${ON_DEMAND_TASKS.emptyTrash}
                and state in ('created', 'retry', 'active')
           ) as emptying,
           (select count(*)::int from models
             where trashed_at is not null and purge_started_at is not null) as purging
  `.execute(db);
  const models = rows.map((r): TrashedModel => {
    const trashedAt = r.trashedAt as Date;
    return {
      id: r.id,
      name: r.name,
      creator: r.creator,
      trashedAt: trashedAt.toISOString(),
      purgeAt: new Date(trashedAt.getTime() + TRASH_RETENTION_DAYS * DAY_MS).toISOString(),
      purgeStarted: r.purgeStartedAt !== null,
    };
  });
  return {
    models,
    readAt: readAt.toISOString(),
    page: window.page,
    pageSize,
    pageCount: window.pageCount,
    total,
    emptying: progress[0]?.emptying ?? false,
    purging: progress[0]?.purging ?? 0,
  };
}

/** Registers the organising routes. */
export async function registerOrganiseApi(
  app: FastifyInstance,
  deps: OrganiseDeps | undefined,
): Promise<void> {
  const library = deps === undefined ? undefined : libraryCalls(deps.db);

  await appApiScope(app, (scope) => {
    // These three lists assume a household-sized library and are not paged.
    scope.get("/creators", async () => ({ creators: await creatorCounts(need(deps).db) }));
    scope.get("/collections", async () => ({
      collections: await collectionCounts(need(deps).db),
    }));
    scope.get("/tags", async () => ({ tags: await tagCounts(need(deps).db) }));

    // Delete a tag or a collection (issue #312): it comes off every model
    // that has it, trashed ones too, and no model changes otherwise. The
    // web app's own session routes; the public API v1 deletes nothing.
    scope.delete<{ Querystring: NameQuery }>(
      "/tags",
      { schema: { querystring: NAME_QUERY } },
      async (request, reply) => {
        const gone = await tagsRepo(need(deps).db).delete(request.query.name);
        return gone === null ? refuse(reply, 404, "not_found") : reply.code(204).send();
      },
    );
    scope.delete<{ Querystring: NameQuery }>(
      "/collections",
      { schema: { querystring: NAME_QUERY } },
      async (request, reply) => {
        const gone = await collectionsRepo(need(deps).db).delete(request.query.name);
        return gone === null ? refuse(reply, 404, "not_found") : reply.code(204).send();
      },
    );

    scope.get<{ Querystring: RowsQuery }>(
      "/organise/models",
      { schema: { querystring: ROWS_QUERY } },
      async (request, reply) => {
        const { db } = need(deps);
        const calls = need(library);
        const { creator, collection, tag, cursor } = request.query;
        try {
          const page = await calls.search({
            creator,
            collection,
            tag,
            cursor,
            limit: ROWS_PER_PAGE,
          });
          return { models: await organiseRows(db, page.models), nextCursor: page.nextCursor };
        } catch (error) {
          if (error instanceof InvalidCursor)
            return refuse(reply, 400, "bad_request", error.message);
          throw error;
        }
      },
    );

    scope.patch<{ Params: IdParams; Body: NameBody }>(
      "/models/:id",
      { schema: { params: ID_PARAMS, body: NAME_BODY } },
      async (request, reply) => {
        const done = await need(library).renameModel(request.params.id, request.body.name);
        return done ? reply.code(204).send() : refuse(reply, 404, "not_found");
      },
    );

    scope.patch<{ Params: IdParams; Body: NameBody }>(
      "/files/:id",
      { schema: { params: ID_PARAMS, body: NAME_BODY } },
      async (request, reply) => {
        const done = await need(library).renameFile(request.params.id, request.body.name);
        return done ? reply.code(204).send() : refuse(reply, 404, "not_found");
      },
    );

    scope.put<{ Params: IdParams; Querystring: NameQuery }>(
      "/models/:id/tags",
      { schema: { params: ID_PARAMS, querystring: NAME_QUERY } },
      async (request, reply) => {
        const { id } = request.params;
        const tag = request.query.name;
        const done = await need(library).addTag(id, tag);
        if (!done) return refuse(reply, 404, "not_found");
        return { name: await storedName(need(deps).db, "tags", tag) };
      },
    );

    scope.delete<{ Params: IdParams; Querystring: NameQuery }>(
      "/models/:id/tags",
      { schema: { params: ID_PARAMS, querystring: NAME_QUERY } },
      async (request, reply) => {
        const done = await need(library).removeTag(request.params.id, request.query.name);
        return done ? reply.code(204).send() : refuse(reply, 404, "not_found");
      },
    );

    scope.put<{ Params: IdParams; Querystring: NameQuery }>(
      "/models/:id/collections",
      { schema: { params: ID_PARAMS, querystring: NAME_QUERY } },
      async (request, reply) => {
        const { id } = request.params;
        const name = request.query.name;
        const done = await need(library).addToCollection(id, name);
        if (!done) return refuse(reply, 404, "not_found");
        return { name: await storedName(need(deps).db, "collections", name) };
      },
    );

    scope.delete<{ Params: IdParams; Querystring: NameQuery }>(
      "/models/:id/collections",
      { schema: { params: ID_PARAMS, querystring: NAME_QUERY } },
      async (request, reply) => {
        const { id } = request.params;
        const done = await need(library).removeFromCollection(id, request.query.name);
        return done ? reply.code(204).send() : refuse(reply, 404, "not_found");
      },
    );

    scope.post<{ Params: IdParams }>(
      "/models/:id/trash",
      { schema: { params: ID_PARAMS } },
      async (request, reply) => {
        const done = await need(deps).trash.trashModel(request.params.id);
        return done ? reply.code(204).send() : refuse(reply, 404, "not_found");
      },
    );

    // Bulk actions on the library's selection: one request, one transaction
    // (repos/bulk.ts), on the posted models the request's view holds. Each
    // answers what changed, what was left as it was, which models failed and
    // why, and which the view no longer holds; a model in the trash or not
    // found is a failure, never a 404 for the whole request.
    scope.post<{ Body: { ids: string[]; tags: string[]; view: BulkView } }>(
      "/bulk/add-tags",
      { schema: { body: BULK_TAGS_BODY } },
      async (request) => {
        const { ids, tags, view } = request.body;
        return bulkRepo(need(deps).db).addTags(ids, tags, viewOf(view));
      },
    );

    scope.post<{ Body: { ids: string[]; tag: string; view: BulkView } }>(
      "/bulk/remove-tag",
      { schema: { body: BULK_TAG_BODY } },
      async (request) => {
        const { ids, tag, view } = request.body;
        return bulkRepo(need(deps).db).removeTag(ids, tag, viewOf(view));
      },
    );

    scope.post<{ Body: { ids: string[]; collection: string; view: BulkView } }>(
      "/bulk/add-to-collection",
      { schema: { body: BULK_COLLECTION_BODY } },
      async (request) => {
        const { ids, collection, view } = request.body;
        return bulkRepo(need(deps).db).addToCollection(ids, collection, viewOf(view));
      },
    );

    scope.post<{ Body: { ids: string[]; view: BulkView } }>(
      "/bulk/trash",
      { schema: { body: BULK_TRASH_BODY } },
      async (request) => {
        const { ids, view } = request.body;
        return bulkRepo(need(deps).db).trash(ids, viewOf(view));
      },
    );

    // Which of the posted models the view holds now, for the library page's
    // view check; reads only, so it is not a transaction and is not retried.
    scope.post<{ Body: { ids: string[]; view: BulkView } }>(
      "/bulk/in-view",
      { schema: { body: BULK_IN_VIEW_BODY } },
      async (request) => {
        const { ids, view } = request.body;
        return { ids: await bulkRepo(need(deps).db).inView(ids, viewOf(view)) };
      },
    );

    scope.get<{ Querystring: { page?: number; limit?: number } }>(
      "/trash",
      { schema: { querystring: TRASH_QUERY } },
      async (request) => trashListing(need(deps).db, request.query),
    );

    scope.post<{ Params: IdParams }>(
      "/trash/:id/restore",
      { schema: { params: ID_PARAMS } },
      async (request, reply) => {
        try {
          const done = await need(deps).trash.restoreModel(request.params.id);
          return done ? reply.code(204).send() : refuse(reply, 404, "not_found");
        } catch (error) {
          if (error instanceof PurgeStarted) {
            return refuse(reply, 409, "purge_started", PURGE_STARTED_MESSAGE);
          }
          throw error;
        }
      },
    );

    scope.post<{ Body: CutoffBody }>(
      "/trash/empty",
      { schema: { body: CUTOFF_BODY } },
      async (request, reply) => {
        const { db, trash, boss } = need(deps);
        const { cutoff } = request.body;
        const at = Date.parse(cutoff);
        // Only readAt's own form: a date alone, an offset, or a day that
        // Date rolls over (February 30) is refused, not guessed at.
        if (!ISO_MILLIS.test(cutoff) || Number.isNaN(at) || new Date(at).toISOString() !== cutoff) {
          return refuse(reply, 400, "bad_request", STALE_TRASH, { code: "stale_trash" });
        }
        if (at > (await databaseNow(db)).getTime()) {
          return refuse(reply, 400, "bad_request", STALE_TRASH, { code: "stale_trash" });
        }
        // The marks and their job commit together. A job already queued
        // and not started, held FOR SHARE until the commit so no worker can
        // claim it before the marks are visible, lists the marked models
        // when it starts, so it is not sent twice.
        let queued = 0;
        await db.transaction().execute(async (trx) => {
          queued = await trash.requestPurge(new Date(at), trx);
          if (queued > 0) {
            const { rows: waiting } = await sql<{ id: string }>`
              select id from ${BOSS_JOB}
               where name = ${QUEUE.maintenance}
                 and state < 'active'
                 and data @> ${JSON.stringify({ task: ON_DEMAND_TASKS.emptyTrash })}::jsonb
               for share`.execute(trx);
            if (waiting.length === 0) {
              await boss.send(
                QUEUE.maintenance,
                { task: ON_DEMAND_TASKS.emptyTrash },
                { db: bossDb(trx) },
              );
            }
          }
        });
        return reply.code(202).send({ queued });
      },
    );
  });
}

/** The library module's organising calls over one database. */
function libraryCalls(db: Kysely<DB>) {
  return {
    ...createRename(db),
    // The app removes a tag its last model loses (issue #312); the API does not.
    ...createTags(db, { dropUnusedTags: true }),
    ...createCollections(db),
    ...createSearch(db),
  };
}
