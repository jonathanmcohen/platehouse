// File delivery. Downloads work wherever the app works, and a store outage
// shows a file as unavailable rather than lost. Every byte reaches a
// browser or a slicer through the app, streamed from the bucket, never
// through a presigned URL, so no bucket credential reaches a browser or a slicer and no bucket host, key, access
// key or signature is ever in an answer:
//
//   GET /files/:id/download   session   the file as an attachment
//   GET /blobs/:id            session   a blob (thumbnail, render, mesh, or
//                                       a file's source), immutable
//   GET /s/<token>/<name>     link      the file of a slicer link (links.ts)
//
// - A file is read through the Public API's library (api/v1.ts createApiLibrary:
//   openFile and fileHead), so the download, the slicer link and the API's
//   own content route find a live file, its stored blob and its headers the
//   same way. A blob is read here (createDeliveryLibrary) by the same rules:
//   its model must be live and its row stored.
// - The bytes are the store's stream, piped as it arrives; nothing holds a
//   whole file. Content-Length comes from the database, and the object must
//   be exactly that size (PR #156 security review): Node does not hold a
//   response to its Content-Length, so a longer object would put its extra
//   bytes on the keep-alive socket, where a proxy reusing the connection
//   reads them as the next answer, and a shorter one would leave the client
//   waiting. So an object whose size, as the store reports it (objectSize),
//   differs from the record is 503 before any header (checkObjectSize), and
//   the bytes are counted as they go (exactSize): a stream that runs past
//   the record or ends short of it destroys the response, so the client
//   sees an aborted answer, never a clean end. res.strictContentLength is
//   not used: on a short stream it throws from res.end() and ends the
//   process. A HEAD never opens a GetObject: it confirms the object exists
//   with a HeadObject (no body), compares the size the HeadObject reports
//   with the record (fileHead in api/v1.ts, blobHead here; issue #164), and
//   sends the headers, so it fails where the GET would for an unknown,
//   trashed or missing object, an object of another size or a store outage.
//   checkObjectSize, exactSize and the HEAD size check live in api/v1.ts,
//   so the public API's file content route uses the same code.
// - A file or blob that is unknown, malformed or in the trash is 404. When
//   the store cannot give the bytes (an outage, a missing object, a refusal)
//   the answer is 503 "This file is unavailable right now", and nothing is
//   written anywhere: no row, no status, so an outage never marks a file
//   missing or damaged. Any other failure is logged and answered
//   500 with no detail.
// - A file goes out as an attachment with its name in an ASCII fallback and
//   in filename*=UTF-8'' (api/v1.ts contentDisposition), so a name with
//   spaces, accents, slashes, quotes or line breaks never breaks the header.
//   The name is linkFileName's (api/v1.ts), set where the file is read
//   (createApiLibrary), so the download, the slicer link and the API's own
//   content route all name it the same way (issue #164): a rename may have
//   left the stored name without its extension, and a browser saves the
//   download under this name, so the file's real extension is added when it
//   is missing. Only a slicer link's URL name segment has unsafe characters
//   replaced (linkSegment). Every answer carries X-Content-Type-Options:
//   nosniff.
import { Readable } from "node:stream";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import {
  type ApiLibrary,
  checkHeadSize,
  checkObjectSize,
  contentDisposition,
  dropContentHeaders,
  exactSize,
  FILE_UNAVAILABLE_MESSAGE,
  type FileContent,
  type FileHead,
  linkFileName,
} from "../api/v1.js";
import type { DB, FileKind } from "../db/types.js";
import { createRepos } from "../repos/index.js";
import { BlobNotFound, type BlobStore, StoreError, StoreUnavailable } from "../storage/s3.js";

// linkFileName and checkObjectSize live in api/v1.ts, which reads every
// file the delivery routes send; they are exported here as before.
export { checkObjectSize, linkFileName };

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

/** What delivery reads beyond the Public API's file content: blobs, and a file for its link. */
export interface DeliveryLibrary {
  /** A live file; undefined when unknown, malformed or its model is trashed. */
  linkFile(id: string): Promise<LinkFile | undefined>;
  /**
   * A stored blob of a live model, confirmed with a HeadObject at its
   * recorded size; undefined when unknown, malformed or its model is
   * trashed. BlobNotFound when the row is not stored; StoreUnavailable or
   * StoreError from the store, or StoreError (SizeMismatch) when the store
   * reports another size.
   */
  blobHead(id: string): Promise<FileHead | undefined>;
  /** A stored blob of a live model and its bytes; errors as blobHead. */
  openBlob(id: string): Promise<FileContent | undefined>;
}

export interface DeliveryDeps {
  /** The Public API's library (createApiLibrary): a live file's bytes and headers. */
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
      checkHeadSize(await store.headBlob(found.key), found.head.size);
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
 * Sends a file's or blob's headers and, for a GET, its stream, held to the
 * recorded size (exactSize). A HEAD gets an empty stream, which keeps the
 * Content-Length (an empty body would make Fastify answer 0). An attachment
 * is named with the content's name, a file's linkFileName (api/v1.ts).
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
  if (opts.attachment) {
    reply.header("content-disposition", contentDisposition(content.name));
  }
  return reply.send(
    "stream" in content ? exactSize(content.stream, content.size) : Readable.from([]),
  );
}

/**
 * The answer when the store cannot give the bytes: 503 "This file is
 * unavailable right now", the cause in the log only, with no content
 * header of the file's (dropContentHeaders). Undefined for any other
 * error, which the caller rethrows.
 */
export function unavailable(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (
    error instanceof StoreUnavailable ||
    error instanceof BlobNotFound ||
    error instanceof StoreError
  ) {
    request.log.warn({ err: error }, "delivery: the bytes could not be read");
    dropContentHeaders(reply);
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
 * port, a query never reaches the answer) and, as unavailable(), with no
 * content header of the file's.
 */
export function fileRouteErrors(logMessage: string) {
  return async (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const answered = unavailable(error, request, reply);
    if (answered !== undefined) return answered;
    request.log.error({ err: error }, logMessage);
    dropContentHeaders(reply);
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
        if (content !== undefined) checkObjectSize(content);
      } catch (error) {
        const answered = unavailable(error, request, reply);
        if (answered !== undefined) return answered;
        throw error;
      }
      if (content === undefined) return notFound(reply);
      return sendContent(reply, content, opts);
    }

    function notFound(reply: FastifyReply) {
      return reply.code(404).header("cache-control", "no-store").send({ error: "not_found" });
    }

    scope.get<IdParams>("/files/:id/download", async (request, reply) => {
      const { id } = request.params;
      // The file's name, with its real extension, comes with its content
      // (linkFileName in api/v1.ts createApiLibrary).
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
