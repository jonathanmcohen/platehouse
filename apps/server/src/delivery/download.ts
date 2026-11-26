// File delivery. Downloads work wherever the app works, and a store outage
// shows a file as unavailable rather than lost. Every byte reaches a
// browser or a slicer through the app, streamed from the bucket, never
// through a presigned URL, so no bucket credential reaches a browser or a slicer and no bucket host, key, access
// key or signature is ever in an answer:
//
//   GET /files/:id/download   session   the file as an attachment
//   GET /blobs/:id            session   a blob (thumbnail, render, mesh, or
//                                       a file's source); thumbnails and PNG
//                                       renders are cached for a year, the
//                                       rest are checked with the server on
//                                       each view (ETag, 304)
//   GET /s/<token>/<name>     link      the file of a slicer link (links.ts)
//
// - All three answer a single byte range (Range: bytes=..., delivery/
//   range.ts), so a cut download resumes: 206 with Content-Range and the
//   range's Content-Length, and otherwise the 200's headers. A range that
//   starts at or past the end is 416 with Content-Range "bytes */" and the
//   size, no-store and an empty body, decided from the database record
//   alone, with no store call. Several ranges, another unit or a header the
//   parser cannot read are the whole file with a 200; Range is never a 400
//   or a 500. A HEAD ignores Range. Every 200 and 206 sends Accept-Ranges:
//   bytes. If-Range is compared, strongly, with the ETag only: a file's and
//   a slicer link's is its current blob's id, quoted, and a revalidated
//   blob's its own id (blobEtag); a thumbnail or PNG render has none, so
//   any If-Range gives it the whole picture. Range is read only after the
//   session or the link's token has been checked and the file or blob found
//   live, so a refused request never learns a size from a 416. On a blob
//   the If-None-Match 304 comes first, as RFC 9110 orders it. The reader
//   (readStored) and the header writer (writeContent) live in api/v1.ts,
//   beside the file reader, so one parser, one reader and one writer serve
//   every route that sends a file.
// - A file is read through the Public API's library (api/v1.ts createApiLibrary:
//   openFile and fileHead), so the download, the slicer link and the API's
//   own content route find a live file, its stored blob and its headers the
//   same way. A blob is read here (createDeliveryLibrary) by the same rules:
//   its model must be live and its row stored.
// - The bytes are the store's stream, piped as it arrives; nothing holds a
//   whole file. A range is read with a ranged GetObject (getBlobRange),
//   refused as a 503 before any header when the store did not honour it.
//   Content-Length comes from the database (for a range, the range's
//   length), and the object must be exactly the recorded size (PR #156
//   security review): Node does not hold a response to its Content-Length,
//   so a longer object would put its extra bytes on the keep-alive socket,
//   where a proxy reusing the connection reads them as the next answer, and
//   a shorter one would leave the client waiting. So an object whose size,
//   as the store reports it (objectSize; for a range, the total its
//   Content-Range gives), differs from the record is 503 before any header
//   (checkObjectSize), and the bytes are counted as they go (exactSize): a
//   stream that runs past the record, or the range, or ends short of it
//   destroys the response, so the client sees an aborted answer, never a
//   clean end. res.strictContentLength is not used: on a short stream it
//   throws from res.end() and ends the process. A HEAD never opens a
//   GetObject: it confirms the object exists with a HeadObject (no body),
//   compares the size the HeadObject reports with the record (fileHead in
//   api/v1.ts, blobHead here; issue #164), and sends the headers, so it
//   fails where the GET would for an unknown, trashed or missing object, an
//   object of another size or a store outage. checkObjectSize, exactSize
//   and the HEAD size check live in api/v1.ts, so the public API's file
//   content route uses the same code.
// - A file or blob that is unknown, malformed or in the trash is 404. When
//   the store cannot give the bytes (an outage, a missing object, a refusal)
//   the answer is 503 "This file is unavailable right now", and nothing is
//   written anywhere: no row, no status, so an outage never marks a file
//   missing or damaged. Any other failure is logged and answered
//   500 with no detail. No error answer, 416 included, carries a header
//   of the file's: no Content-Type of its own, Content-Disposition,
//   Content-Range, Accept-Ranges or ETag (dropContentHeaders).
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
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import {
  type ApiLibrary,
  checkHeadSize,
  checkObjectSize,
  dropContentHeaders,
  FILE_CACHE_CONTROL,
  FILE_UNAVAILABLE_MESSAGE,
  type FileContent,
  type FileHead,
  linkFileName,
  type RangeNotSatisfiable,
  readStored,
  writeContent,
} from "../api/v1.js";
import type { BlobKind, DB, FileKind } from "../db/types.js";
import { createRepos } from "../repos/index.js";
import { BlobNotFound, type BlobStore, StoreError, StoreUnavailable } from "../storage/s3.js";
import { type PickRange, rangePicker } from "./range.js";

// linkFileName, checkObjectSize and FILE_CACHE_CONTROL live in api/v1.ts,
// which reads and writes every file the delivery routes send; they are
// exported here as before.
export { checkObjectSize, FILE_CACHE_CONTROL, linkFileName };

/**
 * What GET /blobs/:id answers in Cache-Control for a thumbnail or a PNG
 * render: the bytes never change and show no more than the page does.
 */
export const BLOB_CACHE_CONTROL = "private, max-age=31536000, immutable";

/**
 * What GET /blobs/:id answers for a source file, a mesh, an STL render and
 * any kind not listed in LONG_CACHED_KINDS: the browser is asked to check
 * with the server before each use, so a signed-out browser or a trashed
 * model's file is never served from its copy. The browser may still keep a
 * copy on disk. Sign-out asks it to clear its cache (Clear-Site-Data,
 * auth/routes.ts), which browsers that support the "cache" directive do; an
 * expired session, or one ended from another device, sends no such request.
 */
export const REVALIDATE_CACHE_CONTROL = "private, no-cache";

/**
 * The blob kinds cached for a year: images that never change. Every other
 * kind, a future one included, is revalidated with the blob id as ETag.
 */
const LONG_CACHED_KINDS: ReadonlySet<BlobKind> = new Set(["thumbnail", "render_png"]);

/**
 * A blob's ETag, its quoted id, for every kind but the long-cached ones,
 * which are never revalidated and send none. The blob route's 304 and its
 * content (storedBlob) both read it, so the two never disagree.
 */
export function blobEtag(id: string, kind: BlobKind): string | undefined {
  return LONG_CACHED_KINDS.has(kind) ? undefined : `"${id}"`;
}

/**
 * True when an If-None-Match header names the blob's tag: "*", or any tag
 * of its comma-separated list once a W/ prefix is dropped (weak comparison).
 */
export function matchesEtag(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return header.split(",").some((part) => {
    const tag = part.trim().replace(/^W\//, "");
    return tag === "*" || tag === etag;
  });
}

/** A live file, as a slicer link names it. */
export interface LinkFile {
  id: string;
  name: string;
  originalName: string;
  kind: FileKind;
}

/** What delivery reads beyond the Public API's file content: blobs, and a file for its link. */
export interface DeliveryLibrary {
  /**
   * The kind of a stored blob of a live model, read from the database
   * alone; undefined when unknown, malformed or its model is trashed.
   * BlobNotFound when the row is not stored.
   */
  blobKind(id: string): Promise<BlobKind | undefined>;
  /** A live file; undefined when unknown, malformed or its model is trashed. */
  linkFile(id: string): Promise<LinkFile | undefined>;
  /**
   * A stored blob of a live model, confirmed with a HeadObject at its
   * recorded size, with its ETag (blobEtag); undefined when unknown,
   * malformed or its model is trashed. BlobNotFound when the row is not
   * stored; StoreUnavailable or StoreError from the store, or StoreError
   * (SizeMismatch) when the store reports another size.
   */
  blobHead(id: string): Promise<FileHead | undefined>;
  /**
   * A stored blob of a live model and its bytes, the part pickRange chooses
   * or all of them (readStored), or RangeNotSatisfiable with no store call;
   * errors as blobHead, StoreError (RangeIgnored) when the store did not
   * honour the range, and StoreError (SizeMismatch) when the object is
   * shorter than the range.
   */
  openBlob(
    id: string,
    pickRange?: PickRange,
  ): Promise<FileContent | RangeNotSatisfiable | undefined>;
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
  store: Pick<BlobStore, "getBlobStream" | "getBlobRange" | "headBlob">;
}): DeliveryLibrary {
  const { store } = deps;
  const repos = createRepos(deps.db);

  async function liveModel(modelId: string): Promise<boolean> {
    return (await repos.models.get(modelId)) !== undefined;
  }

  /** A blob of a live model with its key; BlobNotFound when its row is not stored. */
  async function storedBlob(
    id: string,
  ): Promise<{ head: FileHead; key: string; kind: BlobKind } | undefined> {
    const blob = await repos.blobs.get(id);
    if (blob === undefined || !(await liveModel(blob.modelId))) return undefined;
    if (blob.state !== "stored" || blob.size === null) throw new BlobNotFound("GetObject");
    const head: FileHead = {
      name: blob.id,
      contentType: blob.contentType,
      size: Number(blob.size),
    };
    const etag = blobEtag(blob.id, blob.kind);
    return {
      head: etag === undefined ? head : { ...head, etag },
      key: blob.key,
      kind: blob.kind,
    };
  }

  return {
    async linkFile(id) {
      const file = await repos.files.get(id);
      if (file === undefined || !(await liveModel(file.modelId))) return undefined;
      return { id: file.id, name: file.name, originalName: file.originalName, kind: file.kind };
    },

    async blobKind(id) {
      return (await storedBlob(id))?.kind;
    },

    async blobHead(id) {
      const found = await storedBlob(id);
      if (found === undefined) return undefined;
      checkHeadSize(await store.headBlob(found.key), found.head.size);
      return found.head;
    },

    async openBlob(id, pickRange) {
      const found = await storedBlob(id);
      if (found === undefined) return undefined;
      return readStored(store, found.key, found.head, pickRange);
    },
  };
}

/**
 * Sends a file's or blob's answer with api/v1.ts writeContent: a 416 for an
 * unsatisfiable range, else its headers (its own ETag among them, when it
 * has one) and, for a GET, its stream, the whole record or the range, held
 * to that length (exactSize). Cache-Control is FILE_CACHE_CONTROL unless the
 * route gives another. An attachment is named with the content's name, a
 * file's linkFileName (api/v1.ts).
 */
export function sendContent(
  reply: FastifyReply,
  content: FileHead | FileContent | RangeNotSatisfiable,
  opts: { attachment: boolean; cacheControl?: string },
) {
  return writeContent(reply, content, {
    attachment: opts.attachment,
    cacheControl: opts.cacheControl ?? FILE_CACHE_CONTROL,
  });
}

/** True for an error from the blob store: an outage, a missing object or a refusal. */
export function isStoreOutage(error: unknown): boolean {
  return (
    error instanceof StoreUnavailable ||
    error instanceof BlobNotFound ||
    error instanceof StoreError
  );
}

/**
 * The answer when the store cannot give the bytes: 503 "This file is
 * unavailable right now", the cause in the log only, with no content
 * header of the file's (dropContentHeaders). Undefined for any other
 * error, which the caller rethrows.
 */
export function unavailable(error: unknown, request: FastifyRequest, reply: FastifyReply) {
  if (isStoreOutage(error)) {
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

    /**
     * Reads the content, a HEAD's from head() and a GET's from open() with
     * the request's Range (rangePicker, undefined for a HEAD or no Range),
     * and sends it. Every check of the route has run before this, so a
     * Range is only read for a request allowed the file.
     */
    async function serve(
      request: FastifyRequest,
      reply: FastifyReply,
      read: {
        head: () => Promise<FileHead | undefined>;
        open: (
          pick: PickRange | undefined,
        ) => Promise<FileContent | RangeNotSatisfiable | undefined>;
      },
      opts: { attachment: boolean; cacheControl: string },
    ) {
      let content: FileHead | FileContent | RangeNotSatisfiable | undefined;
      try {
        content =
          request.method === "HEAD"
            ? await read.head()
            : await read.open(rangePicker(request.headers, request.method));
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
        { head: () => deps.files.fileHead(id), open: (pick) => deps.files.openFile(id, pick) },
        { attachment: true, cacheControl: FILE_CACHE_CONTROL },
      );
    });

    scope.get<IdParams>("/blobs/:id", async (request, reply) => {
      const { id } = request.params;
      let kind: BlobKind | undefined;
      try {
        // The live-model and stored checks come first, from the database
        // alone, so a conditional request for a gone blob is 404 and no
        // answer, 304 included, reaches a store that has not been asked.
        kind = await deps.library.blobKind(id);
      } catch (error) {
        const answered = unavailable(error, request, reply);
        if (answered !== undefined) return answered;
        throw error;
      }
      if (kind === undefined) return notFound(reply);
      const read = {
        head: () => deps.library.blobHead(id),
        open: (pick: PickRange | undefined) => deps.library.openBlob(id, pick),
      };
      const etag = blobEtag(id, kind);
      if (etag === undefined) {
        return serve(request, reply, read, { attachment: false, cacheControl: BLOB_CACHE_CONTROL });
      }
      // If-None-Match is answered before Range, as RFC 9110 orders the
      // preconditions: a browser's own copy is still good, so no part of it
      // is sent.
      if (matchesEtag(request.headers["if-none-match"], etag)) {
        return reply
          .code(304)
          .header("etag", etag)
          .header("cache-control", REVALIDATE_CACHE_CONTROL)
          .header("x-content-type-options", "nosniff")
          .send();
      }
      return serve(request, reply, read, {
        attachment: false,
        cacheControl: REVALIDATE_CACHE_CONTROL,
      });
    });
  });
}
