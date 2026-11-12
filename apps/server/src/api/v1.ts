// The Public API v1 (build plan Task 16; AC-082, AC-084, AC-085), for
// Claude Code and the Manyfold importer (Task 23). Every route is under
// /api/v1, bearer-class (auth/gate.ts) and behind the bearer hook
// (api/tokens.ts): a token, never a cookie, never a login redirect, and no
// Origin check. The operations are the contract's:
//
//   GET    /api/v1/openapi.json                    this API's description
//   GET    /api/v1/models?q&tag&collection&creator&externalRef&cursor&limit
//   POST   /api/v1/models                          201 {model} | 409 exists
//   GET    /api/v1/models/:id                      files, plates, estimates
//   GET    /api/v1/files/:id                       one file's details
//   GET    /api/v1/files/:id/content               the file's bytes
//   PUT    /api/v1/models/:id/tags/:tag            204 (DELETE: 204)
//   PUT    /api/v1/collections/:name/models/:id    204 (DELETE: 204)
//   POST   /api/v1/uploads (tus), HEAD and PATCH /api/v1/uploads/:id,
//   GET    /api/v1/uploads/:id/result              uploads/tus.ts, mounted by
//                                                  app.ts behind apiUploadHook
//
// - Nothing deletes, trashes or purges: the only DELETEs take a tag or a
//   collection membership off a model.
// - A model in the trash is invisible: reading it, its files or their bytes
//   is 404, it is never listed, tagging it is 404, and an upload into it is
//   refused 404 at creation (apiUploadHook) before any byte is stored. A
//   trash that lands while an upload is under way still wins: ingest refuses
//   the finished upload (the result says so) and stores nothing.
// - POST /api/v1/models takes the metadata and externalRef the importer
//   carries (decision 5). license is an SPDX id. A taken externalRef, on a
//   live or a trashed model, is 409 {"error":"exists","trashed":<bool>}, so
//   a re-run import skips a model Jon trashed rather than recreating it
//   (Review Focus 4).
// - externalRef= finds the live model with that reference (zero or one); it
//   is a lookup, not a filter, so it cannot be combined with the others.
// - JSON bodies are parsed in this scope only (the root app parses none),
//   after the bearer hook, so a refused request's body is never read; the
//   gate releases it. Errors answer JSON with no detail from the database or
//   the store.
// - No CORS plugin is registered and no answer carries an Access-Control
//   header, so a browser on another origin cannot read the API.
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { isUuid } from "../db/ids.js";
import { inTransaction } from "../db/kysely.js";
import type { DB, FileKind, ModelFile, ParseStatus } from "../db/types.js";
import type { PlateNumbers } from "../estimates/display.js";
import { createCollections } from "../library/collections.js";
import { createSearch, InvalidCursor, type LibrarySearch } from "../library/search.js";
import { createTags } from "../library/tags.js";
import { createRepos } from "../repos/index.js";
import type { Model } from "../repos/models.js";
import { BlobNotFound, type BlobStore, StoreError, StoreUnavailable } from "../storage/s3.js";
import type { AuthHook } from "../uploads/tus.js";
import { UNAUTHORIZED_DOC } from "./openapi.js";
import { createBearerHook, type Tokens } from "./tokens.js";

/** Where the API is mounted. */
export const API_PREFIX = "/api/v1";

/** The largest JSON body the API reads. */
export const JSON_BODY_LIMIT = 1024 * 1024;

/** What a file route answers when the store cannot give the bytes. */
export const FILE_UNAVAILABLE_MESSAGE = "This file is unavailable right now";

/** A model as the API shows it. */
export interface ApiModel {
  id: string;
  name: string;
  caption: string | null;
  description: string | null;
  creator: string | null;
  license: string | null;
  licenseNote: string | null;
  externalRef: string | null;
  tags: string[];
  collections: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ApiPlate {
  id: string;
  index: number;
  name: string | null;
  objectCount: number;
  numbers: PlateNumbers;
}

export interface ApiFile {
  id: string;
  modelId: string;
  name: string;
  originalName: string;
  kind: FileKind;
  size: number;
  sha256: string;
  parseStatus: ParseStatus;
  derivedStatus: string | null;
  derivedMessage: string | null;
  createdAt: string;
  updatedAt: string;
  plates: ApiPlate[];
}

export interface ApiModelDetail extends ApiModel {
  files: ApiFile[];
}

export interface ApiModelPage {
  models: ApiModel[];
  nextCursor: string | null;
}

export interface NewApiModel {
  name: string;
  caption?: string | undefined;
  description?: string | undefined;
  creator?: string | undefined;
  license?: string | undefined;
  externalRef?: string | undefined;
  tags?: string[] | undefined;
  collections?: string[] | undefined;
}

export type CreateOutcome = { model: ApiModel } | { exists: true; trashed: boolean };

/** What a file's content route answers in its headers. */
export interface FileHead {
  name: string;
  contentType: string;
  size: number;
}

export interface FileContent extends FileHead {
  stream: Readable;
}

/** What the API reads and changes; createApiLibrary over the database and store. */
export interface ApiLibrary {
  listModels(query: LibrarySearch & { externalRef?: string | undefined }): Promise<ApiModelPage>;
  createModel(input: NewApiModel): Promise<CreateOutcome>;
  getModel(id: string): Promise<ApiModelDetail | undefined>;
  getFile(id: string): Promise<ApiFile | undefined>;
  /**
   * What a HEAD on the file's content answers, read without opening the
   * store: BlobNotFound when its blob is not stored.
   */
  fileHead(id: string): Promise<FileHead | undefined>;
  /** The file's bytes; StoreUnavailable, BlobNotFound or StoreError when the store cannot give them. */
  openFile(id: string): Promise<FileContent | undefined>;
  modelIsLive(id: string): Promise<boolean>;
  addTag(modelId: string, tag: string): Promise<boolean>;
  removeTag(modelId: string, tag: string): Promise<boolean>;
  addToCollection(modelId: string, collection: string): Promise<boolean>;
  removeFromCollection(modelId: string, collection: string): Promise<boolean>;
}

export interface ApiDeps {
  tokens: Pick<Tokens, "authenticate">;
  library: ApiLibrary;
}

/**
 * The API when the server is given none: no token is ever live and the
 * library is empty, so every v1 route answers 401. Tests that are not about
 * the API use it; the server always passes its own.
 */
export const refusingApi: ApiDeps = Object.freeze({
  tokens: { authenticate: async () => undefined },
  library: {
    listModels: async () => ({ models: [], nextCursor: null }),
    createModel: async () => ({ exists: true as const, trashed: false }),
    getModel: async () => undefined,
    getFile: async () => undefined,
    fileHead: async () => undefined,
    openFile: async () => undefined,
    modelIsLive: async () => false,
    addTag: async () => false,
    removeTag: async () => false,
    addToCollection: async () => false,
    removeFromCollection: async () => false,
  },
});

function iso(date: Date): string {
  return date.toISOString();
}

function sqlState(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

export function createApiLibrary(deps: {
  db: Kysely<DB>;
  store: Pick<BlobStore, "getBlobStream">;
  /** Task 12's plateNumbers for the selected printer (estimates.plateNumbers). */
  plateNumbers(plateId: string): Promise<PlateNumbers>;
}): ApiLibrary {
  const { db, store } = deps;
  const repos = createRepos(db);
  const search = createSearch(db);
  const tags = createTags(db);
  const collections = createCollections(db);

  /** Tag and collection names of these models, in one query each. */
  async function labels(modelIds: string[]) {
    const tagsBy = new Map<string, string[]>();
    const collectionsBy = new Map<string, string[]>();
    if (modelIds.length === 0) return { tagsBy, collectionsBy };
    const [tagRows, collectionRows] = await Promise.all([
      db
        .selectFrom("modelTags")
        .innerJoin("tags", "tags.id", "modelTags.tagId")
        .select(["modelTags.modelId", "tags.name"])
        .where("modelTags.modelId", "in", modelIds)
        .orderBy("tags.name")
        .execute(),
      db
        .selectFrom("collectionModels")
        .innerJoin("collections", "collections.id", "collectionModels.collectionId")
        .select(["collectionModels.modelId", "collections.name"])
        .where("collectionModels.modelId", "in", modelIds)
        .orderBy("collections.name")
        .execute(),
    ]);
    for (const r of tagRows) tagsBy.set(r.modelId, [...(tagsBy.get(r.modelId) ?? []), r.name]);
    for (const r of collectionRows) {
      collectionsBy.set(r.modelId, [...(collectionsBy.get(r.modelId) ?? []), r.name]);
    }
    return { tagsBy, collectionsBy };
  }

  async function toApiModels(models: Model[]): Promise<ApiModel[]> {
    const { tagsBy, collectionsBy } = await labels(models.map((m) => m.id));
    return models.map((m) => ({
      id: m.id,
      name: m.name,
      caption: m.caption,
      description: m.descriptionMd,
      creator: m.creator,
      license: m.licenseSpdx,
      licenseNote: m.licenseNote,
      externalRef: m.externalRef,
      tags: tagsBy.get(m.id) ?? [],
      collections: collectionsBy.get(m.id) ?? [],
      createdAt: iso(m.createdAt),
      updatedAt: iso(m.updatedAt),
    }));
  }

  async function toApiFile(file: ModelFile): Promise<ApiFile> {
    const plates = await repos.plates.listForFile(file.id);
    return {
      id: file.id,
      modelId: file.modelId,
      name: file.name,
      originalName: file.originalName,
      kind: file.kind,
      size: Number(file.size),
      sha256: file.sha256.toString("hex"),
      parseStatus: file.parseStatus,
      derivedStatus: file.derivedStatus,
      derivedMessage: file.derivedMessage,
      createdAt: iso(file.createdAt),
      updatedAt: iso(file.updatedAt),
      plates: await Promise.all(
        plates.map(async (p) => ({
          id: p.id,
          index: p.index,
          name: p.name,
          objectCount: p.objectCount,
          numbers: await deps.plateNumbers(p.id),
        })),
      ),
    };
  }

  /** A file whose model is live; undefined for an unknown file or a trashed model. */
  async function liveFile(id: string): Promise<ModelFile | undefined> {
    const file = await repos.files.get(id);
    if (file === undefined) return undefined;
    return (await repos.models.get(file.modelId)) === undefined ? undefined : file;
  }

  /** A live file, its blob's key and its content headers; BlobNotFound when the blob is not stored. */
  async function storedFile(id: string): Promise<{ head: FileHead; key: string } | undefined> {
    const file = await liveFile(id);
    if (file === undefined) return undefined;
    const blob = await repos.blobs.get(file.blobId);
    if (blob === undefined || blob.state !== "stored") throw new BlobNotFound("GetObject");
    return {
      head: { name: file.name, contentType: blob.contentType, size: Number(file.size) },
      key: blob.key,
    };
  }

  /** The model with this externalRef, live or trashed. */
  async function byExternalRef(ref: string) {
    return db
      .selectFrom("models")
      .select(["id", "trashedAt"])
      .where("externalRef", "=", ref)
      .executeTakeFirst();
  }

  return {
    async listModels(query) {
      if (query.externalRef !== undefined) {
        const found = await byExternalRef(query.externalRef);
        const model =
          found === undefined || found.trashedAt !== null
            ? undefined
            : await repos.models.get(found.id);
        return { models: await toApiModels(model === undefined ? [] : [model]), nextCursor: null };
      }
      const page = await search.search(query);
      return { models: await toApiModels(page.models), nextCursor: page.nextCursor };
    },

    async createModel(input) {
      try {
        const id = await inTransaction(db, async (trx) => {
          const r = createRepos(trx);
          const model = await r.models.create({
            name: input.name.trim(),
            caption: input.caption ?? null,
            descriptionMd: input.description ?? null,
            creator: input.creator ?? null,
            licenseSpdx: input.license ?? null,
            externalRef: input.externalRef ?? null,
          });
          for (const tag of input.tags ?? []) await r.tags.add(model.id, tag);
          for (const name of input.collections ?? []) await r.collections.add(model.id, name);
          return model.id;
        });
        const model = await repos.models.get(id);
        if (model === undefined) throw new Error("the model just made is gone");
        const [shown] = await toApiModels([model]);
        if (shown === undefined) throw new Error("the model just made is gone");
        return { model: shown };
      } catch (error) {
        if (sqlState(error) === "23505" && input.externalRef !== undefined) {
          const taken = await byExternalRef(input.externalRef);
          if (taken !== undefined) return { exists: true, trashed: taken.trashedAt !== null };
        }
        throw error;
      }
    },

    async getModel(id) {
      const model = await repos.models.get(id);
      if (model === undefined) return undefined;
      const files = await db
        .selectFrom("files")
        .selectAll()
        .where("modelId", "=", model.id)
        .orderBy("createdAt")
        .orderBy("id")
        .execute();
      const [shown] = await toApiModels([model]);
      if (shown === undefined) return undefined;
      return { ...shown, files: await Promise.all(files.map(toApiFile)) };
    },

    async getFile(id) {
      const file = await liveFile(id);
      return file === undefined ? undefined : toApiFile(file);
    },

    async fileHead(id) {
      const found = await storedFile(id);
      return found === undefined ? undefined : found.head;
    },

    async openFile(id) {
      const found = await storedFile(id);
      if (found === undefined) return undefined;
      const stream = await store.getBlobStream(found.key);
      return { ...found.head, stream };
    },

    async modelIsLive(id) {
      return (await repos.models.get(id)) !== undefined;
    },

    addTag: (modelId, tag) => tags.addTag(modelId, tag),
    removeTag: (modelId, tag) => tags.removeTag(modelId, tag),
    addToCollection: (modelId, name) => collections.addToCollection(modelId, name),
    removeFromCollection: (modelId, name) => collections.removeFromCollection(modelId, name),
  };
}

/** The keys and decoded values of a tus Upload-Metadata header; undefined when malformed. */
export function uploadMetadata(header: unknown): Map<string, string | null> | undefined {
  if (typeof header !== "string") return undefined;
  const fields = new Map<string, string | null>();
  for (const pair of header.split(",")) {
    const [key, value, extra] = pair.trim().split(" ");
    if (key === undefined || key === "" || extra !== undefined) return undefined;
    fields.set(key, value === undefined ? null : Buffer.from(value, "base64").toString("utf8"));
  }
  return fields;
}

const NOT_FOUND = { error: "not_found" } as const;

/**
 * The /api/v1/uploads mount's hook: the bearer check, then, for a creation
 * that names a modelId, that model must be live, or the answer is 404 and
 * nothing is created. Metadata tus would refuse (malformed, a modelId that
 * is not a UUID) is left to tus's own 400.
 */
export function apiUploadHook(deps: ApiDeps): AuthHook {
  const bearer = createBearerHook(deps.tokens);
  return async (request, reply) => {
    await bearer(request, reply);
    if (reply.sent) return reply;
    if (request.method !== "POST") return;
    const modelId = uploadMetadata(request.headers["upload-metadata"])?.get("modelId");
    if (typeof modelId !== "string" || !isUuid(modelId)) return;
    let live: boolean;
    try {
      live = await deps.library.modelIsLive(modelId.toLowerCase());
    } catch (error) {
      request.log.warn({ err: error }, "api: could not check an upload's model");
      return reply.code(503).header("cache-control", "no-store").send({ error: "unavailable" });
    }
    if (!live) return reply.code(404).header("cache-control", "no-store").send(NOT_FOUND);
  };
}

// The JSON schemas of the routes: they validate requests, shape answers and
// are what the OpenAPI document describes. Fastify coerces scalars, so a
// "limit" of "10" is the number 10.

const nullableString = { type: "string", nullable: true } as const;

const ERROR = {
  type: "object",
  properties: { error: { type: "string" }, message: { type: "string" } },
  required: ["error"],
} as const;

const NOT_FOUND_DOC = {
  description: "No such live model or file (unknown, or in the trash)",
  ...ERROR,
} as const;

const MODEL = {
  type: "object",
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    caption: nullableString,
    description: { ...nullableString, description: "Markdown" },
    creator: nullableString,
    license: { ...nullableString, description: "An SPDX licence id" },
    licenseNote: nullableString,
    externalRef: nullableString,
    tags: { type: "array", items: { type: "string" } },
    collections: { type: "array", items: { type: "string" } },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
  required: [
    "id",
    "name",
    "caption",
    "description",
    "creator",
    "license",
    "licenseNote",
    "externalRef",
    "tags",
    "collections",
    "createdAt",
    "updatedAt",
  ],
} as const;

const NUMBERS = {
  type: "object",
  additionalProperties: true,
  description:
    "The plate's numbers for the selected printer: file (Bambu's own, from the .3mf, " +
    "labelled with the printer it was sliced for), platehouse (an OrcaSlicer estimate, " +
    "with state current, estimating or stale) and failure (why the estimate failed). " +
    "Each set has timeSeconds, weightGrams and per-filament grams.",
} as const;

const FILE = {
  type: "object",
  properties: {
    id: { type: "string" },
    modelId: { type: "string" },
    name: { type: "string" },
    originalName: { type: "string" },
    kind: { type: "string", enum: ["3mf", "stl", "step", "scad"] },
    size: { type: "integer" },
    sha256: { type: "string", description: "Hex" },
    parseStatus: { type: "string", enum: ["pending", "ok", "no_plate_data", "unavailable"] },
    derivedStatus: nullableString,
    derivedMessage: nullableString,
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    plates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          index: { type: "integer" },
          name: nullableString,
          objectCount: { type: "integer" },
          numbers: NUMBERS,
        },
        required: ["id", "index", "name", "objectCount", "numbers"],
      },
    },
  },
  required: [
    "id",
    "modelId",
    "name",
    "originalName",
    "kind",
    "size",
    "sha256",
    "parseStatus",
    "derivedStatus",
    "derivedMessage",
    "createdAt",
    "updatedAt",
    "plates",
  ],
} as const;

const MODEL_DETAIL = {
  type: "object",
  properties: { ...MODEL.properties, files: { type: "array", items: FILE } },
  required: [...MODEL.required, "files"],
} as const;

const ID_PARAM = { type: "string", maxLength: 100 } as const;
const LABEL = { type: "string", minLength: 1, maxLength: 100, pattern: "\\S" } as const;

const NEW_MODEL_KEYS = [
  "name",
  "caption",
  "description",
  "creator",
  "license",
  "externalRef",
  "tags",
  "collections",
] as const;

const NEW_MODEL = {
  type: "object",
  // propertyNames, not additionalProperties: false, which Fastify's
  // validator would strip silently: an unknown key is refused.
  propertyNames: { enum: NEW_MODEL_KEYS },
  properties: {
    name: { type: "string", minLength: 1, maxLength: 500, pattern: "\\S" },
    caption: { type: "string", maxLength: 2000 },
    description: { type: "string", maxLength: 200_000, description: "Markdown" },
    creator: { type: "string", minLength: 1, maxLength: 300, pattern: "\\S" },
    license: { type: "string", minLength: 1, maxLength: 200, description: "An SPDX licence id" },
    externalRef: {
      type: "string",
      minLength: 1,
      maxLength: 300,
      description: "Where the model came from, such as manyfold:<id>; unique",
    },
    tags: { type: "array", maxItems: 100, items: LABEL },
    collections: { type: "array", maxItems: 100, items: LABEL },
  },
  required: ["name"],
} as const;

const SEARCH_QUERY = {
  type: "object",
  properties: {
    q: {
      type: "string",
      maxLength: 200,
      description: "Matched in name, caption, creator and tags, ignoring case",
    },
    tag: { type: "string", maxLength: 100 },
    collection: { type: "string", maxLength: 100 },
    creator: { type: "string", maxLength: 300 },
    externalRef: {
      type: "string",
      maxLength: 300,
      description: "The live model with this reference; not combinable with the others",
    },
    cursor: { type: "string", maxLength: 2000, description: "nextCursor of the previous page" },
    limit: { type: "integer", minimum: 1, maximum: 200, description: "50 when left out" },
  },
} as const;

const NO_CONTENT = { description: "Done", type: "null" } as const;

type IdParams = { id: string };
type TagParams = { id: string; tag: string };
type CollectionParams = { name: string; id: string };
type SearchQuery = LibrarySearch & { externalRef?: string };

/** A file name for Content-Disposition: an ASCII fallback and the UTF-8 name. */
export function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function badRequest(reply: FastifyReply, message: string) {
  return reply.code(400).send({ error: "bad_request", message });
}

/** Registers the v1 routes (not the tus uploads, which app.ts mounts) behind the bearer hook. */
export async function registerV1(app: FastifyInstance, deps: ApiDeps): Promise<void> {
  const { library } = deps;
  const bearer = createBearerHook(deps.tokens);

  await app.register(
    async (scope) => {
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser(
        "application/json",
        { parseAs: "string", bodyLimit: JSON_BODY_LIMIT },
        scope.getDefaultJsonParser("error", "error"),
      );
      scope.addHook("onRequest", bearer);
      scope.addHook("onSend", async (_request, reply, payload) => {
        if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
        return payload;
      });
      scope.setErrorHandler(async (error, request, reply) => {
        const err = error as Error & { statusCode?: number; validation?: unknown };
        if (err.validation !== undefined) return badRequest(reply, err.message);
        const status = err.statusCode;
        if (status !== undefined && status >= 400 && status < 500) {
          return reply.code(status).send({ error: "bad_request", message: err.message });
        }
        // The cause (a database host, a bucket) goes to the log only.
        request.log.error({ err: error }, "api: the request failed");
        if (error instanceof StoreUnavailable) {
          return reply.code(503).send({ error: "unavailable" });
        }
        return reply.code(500).send({ error: "internal" });
      });

      scope.get(
        "/openapi.json",
        {
          schema: {
            summary: "This API's OpenAPI description",
            operationId: "openapi",
            response: {
              200: { type: "object", additionalProperties: true },
              401: UNAUTHORIZED_DOC,
            },
          },
        },
        async () => scope.swagger(),
      );

      scope.get<{ Querystring: SearchQuery }>(
        "/models",
        {
          schema: {
            summary: "Search the library",
            description:
              "Live models, best match first, a page at a time. Models in the trash never appear.",
            operationId: "searchModels",
            querystring: SEARCH_QUERY,
            response: {
              200: {
                type: "object",
                properties: {
                  models: { type: "array", items: MODEL },
                  nextCursor: { type: "string", nullable: true },
                },
                required: ["models", "nextCursor"],
              },
              400: ERROR,
              401: UNAUTHORIZED_DOC,
            },
          },
        },
        async (request, reply) => {
          const { externalRef, ...rest } = request.query;
          if (externalRef !== undefined) {
            const others = Object.values(rest).some((v) => v !== undefined);
            if (others)
              return badRequest(reply, "externalRef cannot be combined with other fields");
            return library.listModels({ externalRef });
          }
          try {
            return await library.listModels(rest);
          } catch (error) {
            if (error instanceof InvalidCursor) return badRequest(reply, error.message);
            throw error;
          }
        },
      );

      scope.post<{ Body: NewApiModel }>(
        "/models",
        {
          schema: {
            summary: "Make a model with no files yet",
            description:
              "Upload files into it with modelId. A taken externalRef is 409, with trashed " +
              "saying whether that model is in the trash.",
            operationId: "createModel",
            body: NEW_MODEL,
            response: {
              201: { type: "object", properties: { model: MODEL }, required: ["model"] },
              400: ERROR,
              401: UNAUTHORIZED_DOC,
              409: {
                description: "externalRef is taken",
                type: "object",
                properties: {
                  error: { type: "string", enum: ["exists"] },
                  trashed: { type: "boolean" },
                },
                required: ["error", "trashed"],
              },
              415: ERROR,
            },
          },
        },
        async (request, reply) => {
          const outcome = await library.createModel(request.body);
          if ("exists" in outcome) {
            return reply.code(409).send({ error: "exists", trashed: outcome.trashed });
          }
          return reply.code(201).send(outcome);
        },
      );

      scope.get<{ Params: IdParams }>(
        "/models/:id",
        {
          schema: {
            summary: "A model with its files, plates and estimates",
            operationId: "getModel",
            params: { type: "object", properties: { id: ID_PARAM }, required: ["id"] },
            response: { 200: MODEL_DETAIL, 401: UNAUTHORIZED_DOC, 404: NOT_FOUND_DOC },
          },
        },
        async (request, reply) => {
          const model = await library.getModel(request.params.id);
          return model === undefined ? reply.code(404).send(NOT_FOUND) : model;
        },
      );

      scope.get<{ Params: IdParams }>(
        "/files/:id",
        {
          schema: {
            summary: "A file with its plates and estimates",
            operationId: "getFile",
            params: { type: "object", properties: { id: ID_PARAM }, required: ["id"] },
            response: { 200: FILE, 401: UNAUTHORIZED_DOC, 404: NOT_FOUND_DOC },
          },
        },
        async (request, reply) => {
          const file = await library.getFile(request.params.id);
          return file === undefined ? reply.code(404).send(NOT_FOUND) : file;
        },
      );

      scope.get<{ Params: IdParams }>(
        "/files/:id/content",
        {
          schema: {
            summary: "A file's bytes",
            operationId: "getFileContent",
            produces: ["application/octet-stream"],
            params: { type: "object", properties: { id: ID_PARAM }, required: ["id"] },
            response: {
              200: { description: "The file, as uploaded", type: "string", format: "binary" },
              401: UNAUTHORIZED_DOC,
              404: NOT_FOUND_DOC,
              503: { description: FILE_UNAVAILABLE_MESSAGE, ...ERROR },
            },
          },
        },
        async (request, reply) => {
          // Fastify answers HEAD with this handler, and drains to its end any
          // stream a HEAD sends, so a HEAD never opens the store: it reads the
          // file and its blob from the database and sends an empty stream,
          // which keeps the file's Content-Length (an empty body would make
          // Fastify answer 0).
          const head = request.method === "HEAD";
          let content: FileHead | FileContent | undefined;
          try {
            content = head
              ? await library.fileHead(request.params.id)
              : await library.openFile(request.params.id);
          } catch (error) {
            if (
              error instanceof StoreUnavailable ||
              error instanceof BlobNotFound ||
              error instanceof StoreError
            ) {
              request.log.warn({ err: error }, "api: a file's bytes could not be read");
              return reply
                .code(503)
                .send({ error: "unavailable", message: FILE_UNAVAILABLE_MESSAGE });
            }
            throw error;
          }
          if (content === undefined) return reply.code(404).send(NOT_FOUND);
          return reply
            .header("content-type", content.contentType)
            .header("content-length", String(content.size))
            .header("content-disposition", contentDisposition(content.name))
            .header("x-content-type-options", "nosniff")
            .header("cache-control", "private, no-store")
            .send("stream" in content ? content.stream : Readable.from([]));
        },
      );

      // A tag or collection change: 204 when the model is live, 404 when not.
      async function change(
        reply: FastifyReply,
        modelId: string,
        run: () => Promise<boolean>,
        removing: boolean,
      ) {
        let done: boolean;
        try {
          done = await run();
        } catch (error) {
          if (error instanceof RangeError) return badRequest(reply, error.message);
          throw error;
        }
        // Taking off a label the model did not have is done all the same.
        if (!done && !(removing && (await library.modelIsLive(modelId)))) {
          return reply.code(404).send(NOT_FOUND);
        }
        return reply.code(204).send();
      }

      const tagSchema = (summary: string, operationId: string) => ({
        summary,
        operationId,
        params: {
          type: "object",
          properties: { id: ID_PARAM, tag: LABEL },
          required: ["id", "tag"],
        },
        response: { 204: NO_CONTENT, 400: ERROR, 401: UNAUTHORIZED_DOC, 404: NOT_FOUND_DOC },
      });
      scope.put<{ Params: TagParams }>(
        "/models/:id/tags/:tag",
        { schema: tagSchema("Tag a model", "addTag") },
        async (request: FastifyRequest<{ Params: TagParams }>, reply) => {
          const { id, tag } = request.params;
          return change(reply, id, () => library.addTag(id, tag), false);
        },
      );
      scope.delete<{ Params: TagParams }>(
        "/models/:id/tags/:tag",
        { schema: tagSchema("Untag a model", "removeTag") },
        async (request, reply) => {
          const { id, tag } = request.params;
          return change(reply, id, () => library.removeTag(id, tag), true);
        },
      );

      const collectionSchema = (summary: string, operationId: string) => ({
        summary,
        operationId,
        params: {
          type: "object",
          properties: { name: LABEL, id: ID_PARAM },
          required: ["name", "id"],
        },
        response: { 204: NO_CONTENT, 400: ERROR, 401: UNAUTHORIZED_DOC, 404: NOT_FOUND_DOC },
      });
      scope.put<{ Params: CollectionParams }>(
        "/collections/:name/models/:id",
        { schema: collectionSchema("Put a model in a collection", "addToCollection") },
        async (request, reply) => {
          const { name, id } = request.params;
          return change(reply, id, () => library.addToCollection(id, name), false);
        },
      );
      scope.delete<{ Params: CollectionParams }>(
        "/collections/:name/models/:id",
        { schema: collectionSchema("Take a model out of a collection", "removeFromCollection") },
        async (request, reply) => {
          const { name, id } = request.params;
          return change(reply, id, () => library.removeFromCollection(id, name), true);
        },
      );
    },
    { prefix: API_PREFIX },
  );
}
