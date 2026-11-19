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
//   GET    /api/v1/files/:id/content               the file's bytes (HEAD: its
//                                                  headers, after a HeadObject)
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
// - A file's derivedMessage (files.derived_message, OpenSCAD's or the STEP
//   converter's own text) is cleaned by scrubDerivedMessage (src/scrub.ts;
//   issue #260) as it is read, so no slicer temp path or address is
//   answered; the whole stored message is kept, and a longer one keeps its
//   end, where the program's error line is. The stored row is left as it is.
// - No CORS plugin is registered and no answer carries an Access-Control
//   header, so a browser on another origin cannot read the API.
// - A file's content is named and sized here once for every route that
//   delivers it (issue #164): this route, the download and the slicer link
//   (delivery/download.ts and links.ts) all read a file through
//   createApiLibrary. Its name is linkFileName's (the stored name, with the
//   file's real extension added when a rename left it without one), written
//   by contentDisposition. Its object must be the recorded size: a GET
//   checks the size the store reported before any header (checkObjectSize)
//   and counts the bytes as they go (exactSize), and a HEAD compares the
//   HeadObject's size (fileHead), so a HEAD answers 503 where the GET would.
import { pipeline, Readable, Transform } from "node:stream";
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
import { DERIVED_MESSAGE_MAX_CHARS, scrubDerivedMessage } from "../scrub.js";
import {
  BlobNotFound,
  type BlobStore,
  objectSize,
  StoreError,
  StoreUnavailable,
} from "../storage/s3.js";
import type { AuthHook } from "../uploads/tus.js";
import {
  BAD_REQUEST_DOC,
  ERROR_DOC,
  EXAMPLE_IDS,
  EXAMPLE_NUMBERS,
  INTERNAL_DOC,
  NOT_FOUND_DOC,
  PLATE_NUMBERS,
  UNAUTHORIZED_DOC,
  UNAVAILABLE_DOC,
} from "./openapi.js";
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
  /** The render or conversion message, cleaned by scrubDerivedMessage, its end kept (issue #260); null with none. */
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

/** The extensions each file kind is stored under, the first the default. */
const EXTENSIONS: Record<FileKind, readonly string[]> = {
  "3mf": [".3mf"],
  stl: [".stl"],
  step: [".step", ".stp"],
  scad: [".scad"],
};

/**
 * The name a file is delivered under, in a slicer link's last segment and
 * in Content-Disposition on every route that names a file: the stored
 * (display) name, which a rename may have left without its extension, with
 * the file's real extension added when it does not already end in one for
 * its kind (case ignored). The real extension is the original name's, when
 * that is one for the kind, else the kind's first, in lower case.
 */
export function linkFileName(file: { name: string; originalName: string; kind: FileKind }): string {
  const exts = EXTENSIONS[file.kind];
  const lower = file.name.toLowerCase();
  if (exts.some((ext) => lower.endsWith(ext))) return file.name;
  const original = file.originalName.toLowerCase();
  const ext = exts.find((e) => original.endsWith(e)) ?? exts[0] ?? "";
  return `${file.name}${ext}`;
}

/**
 * Throws StoreError (HeadObject, SizeMismatch) when the store reported a
 * size for the object that is not the recorded one, so a HEAD answers 503
 * where the GET would. No reported size passes.
 */
export function checkHeadSize(reported: number | undefined, recorded: number): void {
  if (reported !== undefined && reported !== recorded) {
    throw new StoreError("HeadObject", "SizeMismatch");
  }
}

/**
 * Throws StoreError (GetObject, SizeMismatch), after closing the stream,
 * when the store reported an object size for the content's stream that is
 * not its recorded size, so the route answers 503 before any header. A
 * stream with no reported size passes; exactSize still counts its bytes.
 */
export function checkObjectSize(content: FileHead | FileContent): void {
  if (!("stream" in content)) return;
  const reported = objectSize(content.stream);
  if (reported === undefined || reported === content.size) return;
  content.stream.destroy();
  throw new StoreError("GetObject", "SizeMismatch");
}

/**
 * The stream, passed through only while it holds exactly size bytes. A
 * chunk that would take it past size errors the stream before any of that
 * chunk is sent, and an end short of size errors it too; Fastify then
 * destroys the response (or, before any header, answers through the scope's
 * error handler, 503 with the file's content headers taken off by
 * dropContentHeaders). The last byte is held until the source ends, so a
 * client never receives the whole Content-Length from an object that turns
 * out longer. Destroying the result destroys the source.
 */
export function exactSize(source: Readable, size: number): Readable {
  let seen = 0;
  let held: Buffer | undefined;
  const counted = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length;
      if (seen > size) {
        done(new StoreError("GetObject", "SizeMismatch"));
        return;
      }
      if (seen === size && chunk.length > 0) {
        held = chunk.subarray(chunk.length - 1);
        done(null, chunk.length > 1 ? chunk.subarray(0, chunk.length - 1) : undefined);
        return;
      }
      done(null, chunk);
    },
    flush(done) {
      if (seen !== size) {
        done(new StoreError("GetObject", "SizeMismatch"));
        return;
      }
      done(null, held);
    },
  });
  pipeline(source, counted, () => {
    // An error reaches Fastify through counted, which pipeline destroys
    // with it; this callback only keeps pipeline from throwing.
  });
  return counted;
}

/** True for content that carries its bytes (a GET), false for headers only (a HEAD). */
function isContent(content: FileHead | FileContent): content is FileContent {
  return "stream" in content;
}

/** The headers a file's answer sets that describe the bytes, not the answer. */
const CONTENT_HEADERS = ["content-type", "content-length", "content-disposition"] as const;

/**
 * Takes a file's content headers off an error answer. A stream that fails
 * before its first byte is answered through the scope's error handler, but
 * Fastify has already copied the reply's headers onto the raw response
 * (res.setHeader) and removes only its own copy of content-type and
 * content-length; reply.getHeader falls back to the raw response. Left
 * there, the file's content-type makes the JSON error an invalid payload
 * (Fastify's own 500 instead of the 503), and its Content-Disposition would
 * make a client save the error under the model's file name (PR #156 review).
 */
export function dropContentHeaders(reply: FastifyReply): void {
  for (const name of CONTENT_HEADERS) {
    reply.removeHeader(name);
    if (!reply.raw.headersSent) reply.raw.removeHeader(name);
  }
}

/** What the API reads and changes; createApiLibrary over the database and store. */
export interface ApiLibrary {
  listModels(query: LibrarySearch & { externalRef?: string | undefined }): Promise<ApiModelPage>;
  createModel(input: NewApiModel): Promise<CreateOutcome>;
  getModel(id: string): Promise<ApiModelDetail | undefined>;
  getFile(id: string): Promise<ApiFile | undefined>;
  /**
   * What a HEAD on the file's content answers: the headers from the database,
   * once a HeadObject (no body) confirms the object is in the bucket at its
   * recorded size, so a HEAD fails where the GET would. The name is
   * linkFileName's. BlobNotFound when its blob is not stored; StoreUnavailable
   * or StoreError when the store cannot confirm the object, or reports
   * another size (StoreError, SizeMismatch).
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
  store: Pick<BlobStore, "getBlobStream" | "headBlob">;
  /** Task 12's plateNumbers for the default printer of My printers (estimates.plateNumbers). */
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
      derivedMessage: scrubDerivedMessage(file.derivedMessage),
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
      head: { name: linkFileName(file), contentType: blob.contentType, size: Number(file.size) },
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
      if (found === undefined) return undefined;
      checkHeadSize(await store.headBlob(found.key), found.head.size);
      return found.head;
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
//
// Their documentation (summary, description, tags, examples, and the
// description of every property and answer) changes nothing a request or
// answer does: a request schema only gains annotation keywords Ajv ignores
// (description, examples; never default, which Ajv would apply), and a
// response schema never changes a type, a property or what is required,
// since Fastify serializes with it (test/api/v1-answers.test.ts pins the
// answers byte for byte, test/api/openapi.test.ts the documentation).

const nullableString = { type: "string", nullable: true } as const;

/** A model as the examples show it. */
const EXAMPLE_MODEL = {
  id: EXAMPLE_IDS.model,
  name: "Cable clip",
  caption: "A snap-on clip for desk cables",
  description: "Prints without supports. Use PETG for a stronger snap.",
  creator: "Example Maker",
  license: "CC-BY-4.0",
  licenseNote: null,
  externalRef: null,
  tags: ["clips", "desk"],
  collections: ["Office"],
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-02T11:30:00.000Z",
} as const;

/** A file as the examples show it. */
const EXAMPLE_FILE = {
  id: EXAMPLE_IDS.file,
  modelId: EXAMPLE_IDS.model,
  name: "cable-clip.3mf",
  originalName: "cable-clip.3mf",
  kind: "3mf",
  size: 1843200,
  sha256: "9f2c4a7e1b3d5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8",
  parseStatus: "ok",
  derivedStatus: null,
  derivedMessage: null,
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-01T10:00:00.000Z",
  plates: [
    {
      id: EXAMPLE_IDS.plate,
      index: 1,
      name: "Clips x4",
      objectCount: 4,
      numbers: EXAMPLE_NUMBERS,
    },
  ],
} as const;

const MODEL = {
  type: "object",
  properties: {
    id: { type: "string", description: "The model's id, a UUID" },
    name: { type: "string" },
    caption: { ...nullableString, description: "A one-line summary" },
    description: { ...nullableString, description: "Markdown" },
    creator: { ...nullableString, description: "Who designed it" },
    license: { ...nullableString, description: "An SPDX licence id, such as CC-BY-4.0" },
    licenseNote: { ...nullableString, description: "Licence text that is not an SPDX id" },
    externalRef: {
      ...nullableString,
      description: "Where the model came from, such as manyfold:<id>; unique",
    },
    tags: { type: "array", items: { type: "string" }, description: "Its tags, A to Z" },
    collections: {
      type: "array",
      items: { type: "string" },
      description: "The collections it is in, A to Z",
    },
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

// An open object: a plate's numbers are serialized as they are, whatever
// sets they hold. The document shows their shape instead (the marker below;
// openapi.ts PLATE_NUMBERS_DOC).
const NUMBERS = {
  type: "object",
  additionalProperties: true,
  [PLATE_NUMBERS]: true,
  description:
    "The plate's numbers for the default printer of My printers (Settings): file " +
    "(Bambu's own, from the .3mf, labelled with the printer it was sliced for), " +
    "platehouse (an OrcaSlicer estimate, with state current, estimating or stale) and " +
    "failure (why the estimate failed). Each set has timeSeconds, weightGrams and " +
    "per-filament grams, and names its printer by printerId (the Orca preset name), " +
    "printerLabel and printerName (the printer in full, such as " +
    '"Bambu Lab P1S, 0.4 mm nozzle"; added with My printers).',
} as const;

const FILE = {
  type: "object",
  properties: {
    id: { type: "string", description: "The file's id, a UUID" },
    modelId: { type: "string", description: "The model it belongs to" },
    name: { type: "string", description: "Its name in Platehouse, which can be renamed" },
    originalName: { type: "string", description: "The name it was uploaded with" },
    kind: { type: "string", enum: ["3mf", "stl", "step", "scad"] },
    size: { type: "integer", description: "Bytes" },
    sha256: { type: "string", description: "The SHA-256 of its bytes, in hex" },
    parseStatus: {
      type: "string",
      enum: ["pending", "ok", "no_plate_data", "unavailable"],
      description:
        "Whether its plates were read: ok, or no_plate_data for a .3mf with no plates " +
        "Platehouse can read. Files other than .3mf have no plates.",
    },
    derivedStatus: {
      ...nullableString,
      description:
        "For .scad and STEP files, the preview render: pending, ok or failed. Null for " +
        "other kinds.",
    },
    derivedMessage: {
      ...nullableString,
      description:
        "The render or conversion message, such as why it failed, cleaned of work paths, " +
        `addresses and tokens; at most ${DERIVED_MESSAGE_MAX_CHARS} characters, keeping the ` +
        "end of a longer one, where the error line is",
    },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
    plates: {
      type: "array",
      description: "A .3mf file's plates, in order; empty for other kinds",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          index: { type: "integer", description: "The plate's number in the file, from 1" },
          name: { ...nullableString, description: "The plate's name in the file" },
          objectCount: { type: "integer", description: "Objects on the plate" },
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
  properties: {
    ...MODEL.properties,
    files: { type: "array", items: FILE, description: "Its files, oldest first" },
  },
  required: [...MODEL.required, "files"],
} as const;

const ID_PARAM = { type: "string", maxLength: 100 } as const;
const LABEL = { type: "string", minLength: 1, maxLength: 100, pattern: "\\S" } as const;

/** A path parameter's schema: ID_PARAM or LABEL, with what it names and an example. */
function pathParam<T extends object>(schema: T, description: string, example: string) {
  return { ...schema, description, examples: [example] };
}

const MODEL_ID_PARAM = pathParam(ID_PARAM, "The model's id", EXAMPLE_IDS.model);
const FILE_ID_PARAM = pathParam(ID_PARAM, "The file's id", EXAMPLE_IDS.file);

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
    name: {
      type: "string",
      minLength: 1,
      maxLength: 500,
      pattern: "\\S",
      description: "The model's name, 1 to 500 characters, not blank",
    },
    caption: { type: "string", maxLength: 2000, description: "A one-line summary" },
    description: { type: "string", maxLength: 200_000, description: "Markdown" },
    creator: {
      type: "string",
      minLength: 1,
      maxLength: 300,
      pattern: "\\S",
      description: "Who designed it",
    },
    license: { type: "string", minLength: 1, maxLength: 200, description: "An SPDX licence id" },
    externalRef: {
      type: "string",
      minLength: 1,
      maxLength: 300,
      description: "Where the model came from, such as manyfold:<id>; unique",
    },
    tags: {
      type: "array",
      maxItems: 100,
      items: LABEL,
      description: "Up to 100 tags, each 1 to 100 characters",
    },
    collections: {
      type: "array",
      maxItems: 100,
      items: LABEL,
      description: "Up to 100 collections, each 1 to 100 characters; made on first use",
    },
  },
  required: ["name"],
  examples: [
    {
      name: "Cable clip",
      caption: "A snap-on clip for desk cables",
      creator: "Example Maker",
      license: "CC-BY-4.0",
      tags: ["clips", "desk"],
      collections: ["Office"],
    },
  ],
} as const;

const SEARCH_QUERY = {
  type: "object",
  properties: {
    q: {
      type: "string",
      maxLength: 200,
      description: "Words matched in name, caption, creator and tags, ignoring case",
      examples: ["clip"],
    },
    tag: {
      type: "string",
      maxLength: 100,
      description: "Only models with this tag, ignoring case",
      examples: ["desk"],
    },
    collection: {
      type: "string",
      maxLength: 100,
      description: "Only models in this collection, ignoring case",
      examples: ["Office"],
    },
    creator: {
      type: "string",
      maxLength: 300,
      description: "Only models by this creator, exactly as written",
      examples: ["Example Maker"],
    },
    externalRef: {
      type: "string",
      maxLength: 300,
      description:
        "The live model with this reference (zero or one); cannot be combined with the others",
      examples: ["manyfold:42"],
    },
    cursor: {
      type: "string",
      maxLength: 2000,
      description: "nextCursor from the previous page, to read the next one",
      examples: ["WzAsIkNhYmxlIGNsaXAiLCIwMTkzYTVjMiJd"],
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 200,
      description: "Models per page, 1 to 200; 50 when left out",
      examples: [20],
    },
  },
} as const;

const NO_CONTENT = { description: "Done", type: "null" } as const;

/** 400 for a tag or collection change. */
const LABEL_BAD_REQUEST = {
  ...BAD_REQUEST_DOC,
  // Not "over 100 characters": a longer name is the router's 414 before this
  // route runs (openapi.ts PARAM_TOO_LONG_DOC).
  description: "The tag or collection name is blank",
  examples: [{ error: "bad_request", message: 'params/tag must match pattern "\\S"' }],
} as const;

/** 413 for a JSON body over JSON_BODY_LIMIT. */
const TOO_LARGE_DOC = {
  ...ERROR_DOC,
  description: "The JSON body is over 1 MiB",
  examples: [{ error: "bad_request", message: "Request body is too large" }],
} as const;

/** 415 for a body that is not JSON. */
const NOT_JSON_DOC = {
  ...ERROR_DOC,
  description: "The body is not sent as Content-Type: application/json",
  examples: [{ error: "bad_request", message: "Unsupported Media Type" }],
} as const;

/** The answers every v1 route can give besides its own: no token, the database down, a bug. */
const COMMON_ERRORS = {
  401: UNAUTHORIZED_DOC,
  500: INTERNAL_DOC,
  503: UNAVAILABLE_DOC,
} as const;

type IdParams = { id: string };
type TagParams = { id: string; tag: string };
type CollectionParams = { name: string; id: string };
type SearchQuery = LibrarySearch & { externalRef?: string };

/** What filename* never carries: each is replaced by "_" before encoding. */
const UNSAFE_IN_FILENAME_STAR = /[/\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * A file name for Content-Disposition, the one writer every route that names
 * a file uses: an ASCII fallback, with anything outside printable ASCII,
 * quotes, / and \ replaced by _, and the UTF-8 name in filename*, with / and
 * \ replaced by _ there too, so no client sees a directory part, whether it
 * reads filename= or, as RFC 6266 has it prefer, filename* (PR #211 review),
 * and with control characters (\p{Cc}: TAB, CR, LF, NUL, the C1 controls),
 * invisible format characters (\p{Cf}: bidi overrides and isolates,
 * zero-width characters) and the line and paragraph separators (\p{Zl},
 * \p{Zp}) replaced by _, so a browser or slicer never shows a name reordered
 * to read as another extension or broken across lines (issue #164; PR #211
 * security review). A slicer link's name segment replaces that same set (/,
 * \, \p{Cc}, \p{Cf}, \p{Zl}, \p{Zp}) and also % ? # and ;, which only a URL
 * needs (links.ts UNSAFE_IN_SEGMENT).
 */
export function contentDisposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\/]/g, "_");
  const encoded = encodeURIComponent(name.replace(UNSAFE_IN_FILENAME_STAR, "_")).replace(
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
        // The cause (a database host, a bucket) goes to the log only. A
        // file's stream that fails before its first byte lands here with
        // the file's content headers already set; they come off, so the
        // error is not saved under the file's name.
        request.log.error({ err: error }, "api: the request failed");
        dropContentHeaders(reply);
        if (error instanceof StoreUnavailable) {
          return reply.code(503).send({ error: "unavailable" });
        }
        if (error instanceof StoreError || error instanceof BlobNotFound) {
          return reply.code(503).send({ error: "unavailable", message: FILE_UNAVAILABLE_MESSAGE });
        }
        return reply.code(500).send({ error: "internal" });
      });

      scope.get(
        "/openapi.json",
        {
          schema: {
            summary: "This API's OpenAPI description",
            description:
              "This document: every operation, its parameters, bodies, answers and examples, " +
              "in OpenAPI 3.0 JSON. Load it into an OpenAPI tool to generate a client. The " +
              "server URL in it is Platehouse's configured public address.",
            tags: ["About the API"],
            operationId: "openapi",
            response: {
              200: {
                description: "The OpenAPI 3.0 document",
                type: "object",
                additionalProperties: true,
                examples: [
                  {
                    openapi: "3.0.3",
                    info: { title: "Platehouse API", version: "1.0.0" },
                    servers: [{ url: "https://platehouse.example.com/api/v1" }],
                    paths: {},
                  },
                ],
              },
              ...COMMON_ERRORS,
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
              "Live models, best match first and then by name, a page at a time. With no " +
              "parameters it lists the whole library. q, tag, collection and creator can be " +
              "combined, and each narrows the list. Models in the trash never appear.\n\n" +
              "To read every page, pass the answer's nextCursor as cursor until nextCursor " +
              "is null. Keep the other parameters the same from page to page.\n\n" +
              "externalRef is a lookup rather than a filter: it answers the one live model " +
              "with that reference, or none, and cannot be sent with any other parameter.",
            tags: ["Models"],
            operationId: "searchModels",
            querystring: SEARCH_QUERY,
            response: {
              200: {
                description: "One page of models",
                type: "object",
                properties: {
                  models: { type: "array", items: MODEL },
                  nextCursor: {
                    type: "string",
                    nullable: true,
                    description: "Pass as cursor for the next page; null on the last page",
                  },
                },
                required: ["models", "nextCursor"],
                examples: [
                  { models: [EXAMPLE_MODEL], nextCursor: "WzAsIkNhYmxlIGNsaXAiLCIwMTkzYTVjMiJd" },
                ],
              },
              400: {
                ...BAD_REQUEST_DOC,
                description:
                  "A parameter is outside its limits, the cursor is not one this API made, " +
                  "or externalRef was sent with another parameter",
                examples: [
                  { error: "bad_request", message: "querystring/limit must be <= 200" },
                  { error: "bad_request", message: "The cursor is not valid" },
                ],
              },
              ...COMMON_ERRORS,
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
              "Makes an empty model with the details given, ready for files: upload them with " +
              "its id as modelId in the upload's metadata. Only name is required. Tags and " +
              "collections are made on first use. A field this API does not know is refused " +
              "rather than ignored. The name given is kept: a .3mf uploaded into the model " +
              "later never renames it from its title, though its MakerWorld details fill any " +
              "of caption, creator, description and licence the model left empty.\n\n" +
              "externalRef records where a model came from and is unique, so an import that " +
              "runs twice makes each model once: a taken externalRef is 409, with trashed " +
              "saying whether that model is in the trash.",
            tags: ["Models"],
            operationId: "createModel",
            body: NEW_MODEL,
            response: {
              201: {
                description: "Made; the new model, with no files",
                type: "object",
                properties: { model: MODEL },
                required: ["model"],
                examples: [{ model: EXAMPLE_MODEL }],
              },
              400: {
                ...BAD_REQUEST_DOC,
                description:
                  "The body is not valid JSON, has a field this API does not know, or a field " +
                  "outside its limits",
                examples: [
                  {
                    error: "bad_request",
                    message:
                      "body must be equal to one of the allowed values, body property name " +
                      "must be valid",
                  },
                ],
              },
              409: {
                description:
                  "externalRef is taken by another model; trashed is true when that model " +
                  "is in the trash",
                type: "object",
                properties: {
                  error: { type: "string", enum: ["exists"] },
                  trashed: { type: "boolean" },
                },
                required: ["error", "trashed"],
                examples: [{ error: "exists", trashed: false }],
              },
              413: TOO_LARGE_DOC,
              415: NOT_JSON_DOC,
              ...COMMON_ERRORS,
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
            summary: "Get a model with its files, plates and estimates",
            description:
              "One live model with all its details, its files oldest first, each .3mf " +
              "file's plates, and each plate's print time, weight and filaments for the " +
              "default printer of My printers (Settings). A model in the trash is 404.",
            tags: ["Models"],
            operationId: "getModel",
            params: { type: "object", properties: { id: MODEL_ID_PARAM }, required: ["id"] },
            response: {
              200: {
                ...MODEL_DETAIL,
                description: "The model",
                examples: [{ ...EXAMPLE_MODEL, files: [EXAMPLE_FILE] }],
              },
              404: NOT_FOUND_DOC,
              ...COMMON_ERRORS,
            },
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
            summary: "Get a file with its plates and estimates",
            description:
              "One file's details: its name, kind, size and SHA-256, whether its plates were " +
              "read, and each plate's print time, weight and filaments. A file of a model in " +
              "the trash is 404. GET /files/{id}/content downloads its bytes.",
            tags: ["Files"],
            operationId: "getFile",
            params: { type: "object", properties: { id: FILE_ID_PARAM }, required: ["id"] },
            response: {
              200: { ...FILE, description: "The file", examples: [EXAMPLE_FILE] },
              404: NOT_FOUND_DOC,
              ...COMMON_ERRORS,
            },
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
            summary: "Download a file",
            description:
              "The file's bytes, exactly as uploaded. Content-Disposition names the file " +
              "(with its real extension, such as .3mf) and Content-Length is its size. HEAD " +
              "answers the same headers with no body, after checking the bytes are in " +
              "storage. A file of a model in the trash is 404.\n\n" +
              "This is the scripted download. The Open in Bambu Studio and Open in " +
              "OrcaSlicer buttons on a model page use short-lived slicer links instead, made " +
              "by the web app for a signed-in person; a token cannot make one.",
            tags: ["Files"],
            operationId: "getFileContent",
            params: { type: "object", properties: { id: FILE_ID_PARAM }, required: ["id"] },
            response: {
              // The content form names the bytes' media type for this answer
              // alone; a stream is never serialized, so it changes no answer.
              200: {
                description:
                  "The file. Content-Type is the file's own (model/3mf, model/stl, " +
                  "model/step, or text/plain; charset=utf-8 for .scad).",
                headers: {
                  "Content-Disposition": {
                    type: "string",
                    description: "attachment, with the file's name",
                  },
                  "Content-Length": { type: "integer", description: "The file's size in bytes" },
                },
                content: {
                  "application/octet-stream": {
                    schema: { type: "string", format: "binary" },
                  },
                },
              },
              404: NOT_FOUND_DOC,
              500: INTERNAL_DOC,
              503: {
                ...ERROR_DOC,
                description:
                  "The bytes cannot be read from storage right now (message says so), or the " +
                  "token could not be checked. Try again shortly.",
                examples: [{ error: "unavailable", message: FILE_UNAVAILABLE_MESSAGE }],
              },
              401: UNAUTHORIZED_DOC,
            },
          },
        },
        async (request, reply) => {
          // Fastify answers HEAD with this handler, and drains to its end any
          // stream a HEAD sends, so a HEAD never opens a GetObject: it reads
          // the file and its blob from the database, confirms the object with
          // a HeadObject (no body, so no bytes leave the bucket, and a store
          // outage, a missing object or an object of another size is the
          // same 503 the GET answers), and sends an empty stream, which keeps
          // the file's Content-Length (an empty body would make Fastify
          // answer 0). A GET's object must be its recorded size: checked
          // before any header, then counted as it streams (issue #164).
          const head = request.method === "HEAD";
          let content: FileHead | FileContent | undefined;
          try {
            content = head
              ? await library.fileHead(request.params.id)
              : await library.openFile(request.params.id);
            if (content !== undefined) checkObjectSize(content);
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
          const found = content;
          return reply
            .header("content-type", found.contentType)
            .header("content-length", String(found.size))
            .header("content-disposition", contentDisposition(found.name))
            .header("x-content-type-options", "nosniff")
            .header("cache-control", "private, no-store")
            .send(isContent(found) ? exactSize(found.stream, found.size) : Readable.from([]));
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

      const tagSchema = (summary: string, operationId: string, description: string) => ({
        summary,
        description,
        tags: ["Tags and collections"],
        operationId,
        params: {
          type: "object",
          properties: {
            id: MODEL_ID_PARAM,
            tag: pathParam(
              LABEL,
              "The tag, 1 to 100 characters, URL-encoded; matched ignoring case",
              "desk",
            ),
          },
          required: ["id", "tag"],
        },
        response: {
          204: NO_CONTENT,
          400: LABEL_BAD_REQUEST,
          404: NOT_FOUND_DOC,
          ...COMMON_ERRORS,
        },
      });
      scope.put<{ Params: TagParams }>(
        "/models/:id/tags/:tag",
        {
          schema: tagSchema(
            "Tag a model",
            "addTag",
            "Adds the tag to the model, making the tag if it is new. A tag the model " +
              "already has, in any case, is done all the same. A model in the trash is 404.",
          ),
        },
        async (request: FastifyRequest<{ Params: TagParams }>, reply) => {
          const { id, tag } = request.params;
          return change(reply, id, () => library.addTag(id, tag), false);
        },
      );
      scope.delete<{ Params: TagParams }>(
        "/models/:id/tags/:tag",
        {
          schema: tagSchema(
            "Untag a model",
            "removeTag",
            "Takes the tag off the model; the tag itself stays. A tag the model does not " +
              "have is done all the same. A model in the trash is 404.",
          ),
        },
        async (request, reply) => {
          const { id, tag } = request.params;
          return change(reply, id, () => library.removeTag(id, tag), true);
        },
      );

      const collectionSchema = (summary: string, operationId: string, description: string) => ({
        summary,
        description,
        tags: ["Tags and collections"],
        operationId,
        params: {
          type: "object",
          properties: {
            name: pathParam(
              LABEL,
              "The collection, 1 to 100 characters, URL-encoded; matched ignoring case",
              "Office",
            ),
            id: MODEL_ID_PARAM,
          },
          required: ["name", "id"],
        },
        response: {
          204: NO_CONTENT,
          400: {
            ...LABEL_BAD_REQUEST,
            examples: [{ error: "bad_request", message: 'params/name must match pattern "\\S"' }],
          },
          404: NOT_FOUND_DOC,
          ...COMMON_ERRORS,
        },
      });
      scope.put<{ Params: CollectionParams }>(
        "/collections/:name/models/:id",
        {
          schema: collectionSchema(
            "Put a model in a collection",
            "addToCollection",
            "Puts the model in the collection, making the collection if it is new. A model " +
              "can be in many collections. Doing it twice is done all the same. A model in " +
              "the trash is 404.",
          ),
        },
        async (request, reply) => {
          const { name, id } = request.params;
          return change(reply, id, () => library.addToCollection(id, name), false);
        },
      );
      scope.delete<{ Params: CollectionParams }>(
        "/collections/:name/models/:id",
        {
          schema: collectionSchema(
            "Take a model out of a collection",
            "removeFromCollection",
            "Takes the model out of the collection; the collection itself stays, even when " +
              "empty. A model that was not in it is done all the same. A model in the trash " +
              "is 404.",
          ),
        },
        async (request, reply) => {
          const { name, id } = request.params;
          return change(reply, id, () => library.removeFromCollection(id, name), true);
        },
      );
    },
    { prefix: API_PREFIX },
  );
}
