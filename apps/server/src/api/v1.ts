// The Public API v1 (build plan Task 16; AC-082, AC-084, AC-085). Interface
// only: the routes land with the tests' fix.
import type { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { DB, FileKind, ParseStatus } from "../db/types.js";
import type { PlateNumbers } from "../estimates/display.js";
import type { LibrarySearch } from "../library/search.js";
import type { BlobStore } from "../storage/s3.js";
import type { AuthHook } from "../uploads/tus.js";
import type { Tokens } from "./tokens.js";

/** Where the API is mounted. */
export const API_PREFIX = "/api/v1";

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

export interface FileContent {
  name: string;
  contentType: string;
  size: number;
  stream: Readable;
}

/** What the API reads and changes; createApiLibrary over the database and store. */
export interface ApiLibrary {
  listModels(query: LibrarySearch & { externalRef?: string | undefined }): Promise<ApiModelPage>;
  createModel(input: NewApiModel): Promise<CreateOutcome>;
  getModel(id: string): Promise<ApiModelDetail | undefined>;
  getFile(id: string): Promise<ApiFile | undefined>;
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

export function createApiLibrary(_deps: {
  db: Kysely<DB>;
  store: Pick<BlobStore, "getBlobStream">;
  plateNumbers(plateId: string): Promise<PlateNumbers>;
}): ApiLibrary {
  return {
    listModels: async () => ({ models: [], nextCursor: null }),
    createModel: async () => ({ exists: true, trashed: false }),
    getModel: async () => undefined,
    getFile: async () => undefined,
    openFile: async () => undefined,
    modelIsLive: async () => false,
    addTag: async () => false,
    removeTag: async () => false,
    addToCollection: async () => false,
    removeFromCollection: async () => false,
  };
}

/** The upload mount's hook: the bearer check, then the upload's target model must be live. */
export function apiUploadHook(_deps: ApiDeps): AuthHook {
  return async (_request, reply) => reply.code(401).send({ error: "unauthorized" });
}

export async function registerV1(
  _app: FastifyInstance,
  _deps: ApiDeps & { serverUrl: string },
): Promise<void> {}
