// File delivery (build plan Task 17; AC-011, AC-012). Every byte reaches a
// browser or a slicer through the app, streamed from the bucket, never
// through a presigned URL (plan decision 7), so no bucket host, key, access
// key or signature is ever in an answer:
//
//   GET /files/:id/download   session   the file as an attachment
//   GET /blobs/:id            session   a blob (thumbnail, render, mesh, or
//                                       a file's source), immutable
//   GET /s/<token>/<name>     link      the file of a slicer link (links.ts)
//
// - A file is read through Task 16's library (api/v1.ts createApiLibrary:
//   openFile and fileHead), so the download, the slicer link and the API's
//   own content route find a live file, its stored blob and its headers the
//   same way. A blob is read here (createDeliveryLibrary) by the same rules:
//   its model must be live and its row stored.
// - The bytes are the store's stream, piped as it arrives; nothing holds a
//   whole file. Content-Length comes from the database. A HEAD never opens a
//   GetObject: it confirms the object with a HeadObject (no body) and sends
//   the headers, so it fails where the GET would.
// - A file or blob that is unknown, malformed or in the trash is 404. When
//   the store cannot give the bytes (an outage, a missing object, a refusal)
//   the answer is 503 "This file is unavailable right now", and nothing is
//   written anywhere: no row, no status, so an outage never marks a file
//   missing or damaged (AC-012). Any other failure is logged and answered
//   500 with no detail.
// - A file goes out as an attachment with the stored name in an ASCII
//   fallback and in filename*=UTF-8'' (api/v1.ts contentDisposition), so a
//   name with spaces, accents, slashes, quotes or line breaks never breaks
//   the header. Every answer carries X-Content-Type-Options: nosniff.
import { Readable } from "node:stream";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import {
  type ApiLibrary,
  contentDisposition,
  FILE_UNAVAILABLE_MESSAGE,
  type FileContent,
  type FileHead,
} from "../api/v1.js";
import type { DB, FileKind } from "../db/types.js";
import { createRepos } from "../repos/index.js";
import { BlobNotFound, type BlobStore, StoreError, StoreUnavailable } from "../storage/s3.js";

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
  /**
   * A stored blob of a live model, confirmed with a HeadObject; undefined
   * when unknown, malformed or its model is trashed. BlobNotFound when the
   * row is not stored; StoreUnavailable or StoreError from the store.
   */
  blobHead(id: string): Promise<FileHead | undefined>;
  /** A stored blob of a live model and its bytes; errors as blobHead. */
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

export function createDeliveryLibrary(deps: {
  db: Kysely<DB>;
  store: Pick<BlobStore, "getBlobStream" | "headBlob">;
}): DeliveryLibrary {
  const { store } = deps;
  const repos = createRepos(deps.db);

  async function liveModel(modelId: string): Promise<boolean> {
    return (await repos.models.get(modelId)) !== undefined;
  }

  /** A blob of a live model with its key; BlobNotFound when its row is not stored. */
  async function storedBlob(id: string): Promise<{ head: FileHead; key: string } | undefined> {
    const blob = await repos.blobs.get(id);
    if (blob === undefined || !(await liveModel(blob.modelId))) return undefined;
    if (blob.state !== "stored" || blob.size === null) throw new BlobNotFound("GetObject");
    return {
      head: { name: blob.id, contentType: blob.contentType, size: Number(blob.size) },
      key: blob.key,
    };
  }

  return {
    async linkFile(id) {
      const file = await repos.files.get(id);
      if (file === undefined || !(await liveModel(file.modelId))) return undefined;
      return { id: file.id, name: file.name, originalName: file.originalName, kind: file.kind };
    },

    async blobHead(id) {
      const found = await storedBlob(id);
      if (found === undefined) return undefined;
      await store.headBlob(found.key);
      return found.head;
    },

    async openBlob(id) {
      const found = await storedBlob(id);
      if (found === undefined) return undefined;
      return { ...found.head, stream: await store.getBlobStream(found.key) };
    },
  };
}

/**
 * Sends a file's or blob's headers and, for a GET, its stream. A HEAD gets an
 * empty stream, which keeps the Content-Length (an empty body would make
 * Fastify answer 0).
 */
export function sendContent(
  reply: FastifyReply,
  content: FileHead | FileContent,
  opts: { attachment: boolean; cacheControl?: string },
) {
  reply
    .header("content-type", content.contentType)
    .header("content-length", String(content.size))
    .header("x-content-type-options", "nosniff")
    .header("cache-control", opts.cacheControl ?? FILE_CACHE_CONTROL);
  if (opts.attachment) reply.header("content-disposition", contentDisposition(content.name));
  return reply.send("stream" in content ? content.stream : Readable.from([]));
}

/**
 * The answer when the store cannot give the bytes: 503 "This file is
 * unavailable right now", the cause in the log only. Undefined for any
 * other error, which the caller rethrows.
 */
export function unavailable(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (
    error instanceof StoreUnavailable ||
    error instanceof BlobNotFound ||
    error instanceof StoreError
  ) {
    request.log.warn({ err: error }, "delivery: the bytes could not be read");
    return reply
      .code(503)
      .header("cache-control", "no-store")
      .send({ error: "unavailable", message: FILE_UNAVAILABLE_MESSAGE });
  }
  return undefined;
}

/**
 * The delivery scopes' error handler: a store error is unavailable(), any
 * other is logged and answered 500 with no detail (a database host, a
 * port, a query never reaches the answer).
 */
export function fileRouteErrors(logMessage: string) {
  return async (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const answered = unavailable(error, request, reply);
    if (answered !== undefined) return answered;
    request.log.error({ err: error }, logMessage);
    return reply.code(500).header("cache-control", "no-store").send({ error: "internal" });
  };
}

type IdParams = { Params: { id: string } };

/** Registers GET /files/:id/download and GET /blobs/:id (with their HEADs). */
export async function registerDownloads(app: FastifyInstance, deps: DeliveryDeps): Promise<void> {
  await app.register(async (scope) => {
    scope.setErrorHandler(fileRouteErrors("delivery: a download failed"));

    async function serve(
      request: FastifyRequest,
      reply: FastifyReply,
      read: (head: boolean) => Promise<FileHead | FileContent | undefined>,
      opts: { attachment: boolean; cacheControl: string },
    ) {
      let content: FileHead | FileContent | undefined;
      try {
        content = await read(request.method === "HEAD");
      } catch (error) {
        const answered = unavailable(error, request, reply);
        if (answered !== undefined) return answered;
        throw error;
      }
      if (content === undefined) {
        return reply.code(404).header("cache-control", "no-store").send({ error: "not_found" });
      }
      return sendContent(reply, content, opts);
    }

    scope.get<IdParams>("/files/:id/download", async (request, reply) => {
      const { id } = request.params;
      return serve(
        request,
        reply,
        (head) => (head ? deps.files.fileHead(id) : deps.files.openFile(id)),
        { attachment: true, cacheControl: FILE_CACHE_CONTROL },
      );
    });

    scope.get<IdParams>("/blobs/:id", async (request, reply) => {
      const { id } = request.params;
      return serve(
        request,
        reply,
        (head) => (head ? deps.library.blobHead(id) : deps.library.openBlob(id)),
        { attachment: false, cacheControl: BLOB_CACHE_CONTROL },
      );
    });
  });
}
