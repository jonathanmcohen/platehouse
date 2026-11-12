// File delivery (build plan Task 17; AC-011, AC-012). Interface only: the
// implementation lands in the next commit, after the failing tests.
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { ApiLibrary, FileContent, FileHead } from "../api/v1.js";
import type { DB, FileKind } from "../db/types.js";
import type { BlobStore } from "../storage/s3.js";

/** What GET /blobs/:id answers in Cache-Control: a blob's bytes never change. */
export const BLOB_CACHE_CONTROL = "private, max-age=31536000, immutable";

/** What the file routes answer in Cache-Control. */
export const FILE_CACHE_CONTROL = "private, no-store";

/** A live file, as a slicer link names it. */
export interface LinkFile {
  id: string;
  name: string;
  originalName: string;
  kind: FileKind;
}

/** What delivery reads beyond Task 16's file content: blobs, and a file for its link. */
export interface DeliveryLibrary {
  /** A live file; undefined when unknown, malformed or its model is trashed. */
  linkFile(id: string): Promise<LinkFile | undefined>;
  /** A stored blob of a live model, confirmed with a HeadObject. */
  blobHead(id: string): Promise<FileHead | undefined>;
  /** A stored blob of a live model and its bytes. */
  openBlob(id: string): Promise<FileContent | undefined>;
}

export interface DeliveryDeps {
  /** Task 16's library (createApiLibrary): a live file's bytes and headers. */
  files: Pick<ApiLibrary, "openFile" | "fileHead">;
  library: DeliveryLibrary;
  /** LINK_SECRET; links.ts derives its own key from it. */
  linkSecret: string;
  /** The clock links are minted and checked against; the real one when left out. */
  now?: () => Date;
}

export function createDeliveryLibrary(_deps: {
  db: Kysely<DB>;
  store: Pick<BlobStore, "getBlobStream" | "headBlob">;
}): DeliveryLibrary {
  throw new Error("not implemented");
}

export async function registerDownloads(
  _app: FastifyInstance,
  _deps: DeliveryDeps,
): Promise<void> {}
