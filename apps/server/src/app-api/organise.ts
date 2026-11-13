// The organising pages' app API (build plan Task 21; AC-060, AC-061, AC-062,
// AC-063 UI): the Creators, Collections, Tags and Trash pages. Every route
// is session-class under /app/api (settings.ts, appApiScope), so it needs
// Jon's session, and every state-changing one Origin = PUBLIC_ORIGIN.
//
//   GET    /app/api/creators | /collections | /tags   {<list>: [{name, models}]}
//   GET    /app/api/organise/models?creator|collection|tag&cursor
//                                                     {models, nextCursor}
//   PATCH  /app/api/models/:id   {name}               rename a model
//   PATCH  /app/api/files/:id    {name}               rename a file
//   PUT    /app/api/models/:id/tags?name=             tag {name} (DELETE: untag)
//   PUT    /app/api/models/:id/collections?name=      add {name} (DELETE: take out)
//   POST   /app/api/models/:id/trash                  move to the trash
//   GET    /app/api/trash                             {models: [... purgeAt]}
//   POST   /app/api/trash/:id/restore                 204 | 404 | 409 purge began
//   POST   /app/api/trash/empty  {ids}                {purged}
//
// Every change calls what Task 14 built: renameModel and renameFile (the
// display name only; the bucket key never changes), addTag and removeTag,
// addToCollection and removeFromCollection (flat collections, made on first
// use), trashModel, restoreModel and emptyTrash. Each refuses a model that
// is unknown or in the trash, which is 404 here; taking off a tag or a
// collection the model does not have is 404 too. The lists count live
// models only, and the model rows are Task 14's search with one filter, a
// page of up to ROWS_PER_PAGE at a time.
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
// Empty trash takes the ids the page listed and purges only those still in
// the trash: a model something else trashed after the page read the list (an
// API v1 client, the importer, another tab) stays, and can be restored.
import type { FastifyInstance } from "fastify";
import { type Kysely, sql } from "kysely";
import type { DB, FileKind } from "../db/types.js";
import { createCollections } from "../library/collections.js";
import { createRename } from "../library/rename.js";
import { createSearch, InvalidCursor } from "../library/search.js";
import { createTags } from "../library/tags.js";
import {
  type createTrash,
  PurgeIncomplete,
  PurgeStarted,
  TRASH_RETENTION_DAYS,
} from "../library/trash.js";
import { appApiScope, need, refuse } from "./settings.js";

/** The model rows one request of /app/api/organise/models answers at most. */
export const ROWS_PER_PAGE = 100;

const DAY_MS = 86_400_000;

export interface OrganiseDeps {
  db: Kysely<DB>;
  trash: Pick<ReturnType<typeof createTrash>, "trashModel" | "restoreModel" | "emptyTrash">;
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

const IDS_BODY = {
  type: "object",
  properties: { ids: { type: "array", items: ID } },
  required: ["ids"],
} as const;

type IdParams = { id: string };
type IdsBody = { ids: string[] };
type NameQuery = { name: string };
type NameBody = { name: string };
type RowsQuery = { creator?: string; collection?: string; tag?: string; cursor?: string };

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

async function tagCounts(db: Kysely<DB>) {
  return db
    .selectFrom("tags")
    .innerJoin("modelTags", "modelTags.tagId", "tags.id")
    .innerJoin("models", "models.id", "modelTags.modelId")
    .select(["tags.name", sql<number>`count(*)::int`.as("models")])
    .where("models.trashedAt", "is", null)
    .groupBy("tags.name")
    .orderBy(sql`lower(tags.name)`)
    .orderBy("tags.name")
    .execute();
}

async function collectionCounts(db: Kysely<DB>) {
  return db
    .selectFrom("collections")
    .innerJoin("collectionModels", "collectionModels.collectionId", "collections.id")
    .innerJoin("models", "models.id", "collectionModels.modelId")
    .select(["collections.name", sql<number>`count(*)::int`.as("models")])
    .where("models.trashedAt", "is", null)
    .groupBy("collections.name")
    .orderBy(sql`lower(collections.name)`)
    .orderBy("collections.name")
    .execute();
}

/** The name a tag or collection is stored under, matched as its unique index does. */
async function storedName(
  db: Kysely<DB>,
  table: "tags" | "collections",
  name: string,
): Promise<string> {
  const row = await db
    .selectFrom(table)
    .select("name")
    .where(sql<boolean>`lower(name) = lower(${name.trim()})`)
    .executeTakeFirstOrThrow();
  return row.name;
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

async function trashedModels(db: Kysely<DB>): Promise<TrashedModel[]> {
  const rows = await db
    .selectFrom("models")
    .leftJoin("creators", "creators.id", "models.creatorId")
    .select([
      "models.id",
      "models.name",
      "creators.name as creator",
      "models.trashedAt",
      "models.purgeStartedAt",
    ])
    .where("models.trashedAt", "is not", null)
    .orderBy("models.trashedAt", "desc")
    .orderBy("models.id", "desc")
    .execute();
  return rows.map((r) => {
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
}

/** Registers the organising routes. */
export async function registerOrganiseApi(
  app: FastifyInstance,
  deps: OrganiseDeps | undefined,
): Promise<void> {
  const library = deps === undefined ? undefined : libraryCalls(deps.db);

  await appApiScope(app, (scope) => {
    scope.get("/creators", async () => ({ creators: await creatorCounts(need(deps).db) }));
    scope.get("/collections", async () => ({
      collections: await collectionCounts(need(deps).db),
    }));
    scope.get("/tags", async () => ({ tags: await tagCounts(need(deps).db) }));

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

    scope.get("/trash", async () => ({ models: await trashedModels(need(deps).db) }));

    scope.post<{ Params: IdParams }>(
      "/trash/:id/restore",
      { schema: { params: ID_PARAMS } },
      async (request, reply) => {
        try {
          const done = await need(deps).trash.restoreModel(request.params.id);
          return done ? reply.code(204).send() : refuse(reply, 404, "not_found");
        } catch (error) {
          if (error instanceof PurgeStarted) {
            return refuse(
              reply,
              409,
              "purge_started",
              "Deleting this model for good has already begun, so it cannot be restored.",
            );
          }
          throw error;
        }
      },
    );

    scope.post<{ Body: IdsBody }>(
      "/trash/empty",
      { schema: { body: IDS_BODY } },
      async (request, reply) => {
        try {
          const { purged } = await need(deps).trash.emptyTrash(request.body.ids);
          return { purged: purged.length };
        } catch (error) {
          if (error instanceof PurgeIncomplete) {
            request.log.error({ err: error }, "app api: empty trash was not finished");
            const n = error.failed.length;
            return reply.code(500).send({
              error: "incomplete",
              purged: error.purged.length,
              message: `${n} ${n === 1 ? "model" : "models"} could not be deleted and ${n === 1 ? "stays" : "stay"} in the trash; the next purge tries again.`,
            });
          }
          throw error;
        }
      },
    );
  });
}

/** Task 14's organising calls over one database. */
function libraryCalls(db: Kysely<DB>) {
  return {
    ...createRename(db),
    ...createTags(db),
    ...createCollections(db),
    ...createSearch(db),
  };
}
