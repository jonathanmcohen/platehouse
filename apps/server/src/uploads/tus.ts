// Resumable uploads (build plan Task 9; AC-020, AC-084). One tus 1.0.0
// handler, mounted twice: /app/uploads for the UI behind its session and
// /api/v1/uploads for the API behind a bearer token (Public API v1 contract).
// The auth hooks belong to Part C, so registerTus takes one as a parameter;
// it runs on every request before anything else, so a refused request stores
// nothing.
//
// The flow:
//   1. POST <prefix> creates an upload. Upload-Length is required and at most
//      MAX_UPLOAD_BYTES (512 MiB), so an open length cannot dodge the cap.
//      Upload-Metadata must carry filename, and may carry modelId (into an
//      existing model) or batch with combine (Task 8's batch target). A
//      refused creation (400, 413, 415) writes nothing.
//   2. PATCH <prefix>/<id> appends bytes at Upload-Offset; HEAD <prefix>/<id>
//      tells a client where to resume after a cut-off (a phone switching from
//      the LAN to Tailscale, a backgrounded tab). One PATCH may carry the
//      whole file (curl), or a client may send chunks.
//   3. When the last byte lands, the upload is queued for ingest on the
//      ingest queue (Task 8) under the upload's own id, and ingestFile runs
//      there. GET <prefix>/<id>/result answers pending, done (modelId,
//      fileId) or failed (a message for Jon).
//   4. The worker deletes the temp file after ingest, whether it succeeds or
//      fails (ingestUpload), and keeps the upload's info file for the sweep.
//      Until then HEAD answers an ingested upload as finished (Upload-Offset
//      equal to Upload-Length): a client whose last PATCH was answered after
//      it lost the connection retries with a HEAD, and on a 404 or 410 it
//      would create the upload again and a second model with it. An upload
//      left untouched for 24 hours, or 24 hours after its ingest, is deleted
//      by the hourly sweep on the maintenance queue (sweepStaleUploads); a
//      partial one never becomes a model (Review Focus 5).
//
// Partial uploads live in TMP_DIR/uploads, one data file and one .json info
// file per upload, both named by the upload id, a UUIDv7. The UI and API
// mounts share that folder and one lock per upload (createUploads).
//
// Responses carry no CORS headers (AC-085): @tus/server always sets
// Access-Control-* headers, so they are dropped here. Location is relative
// (<prefix>/<id>) and no forwarded or Host header is read, so no URL comes
// from the request (AC-091). There is no DELETE, GET or OPTIONS on an upload:
// the API deletes nothing (AC-084), and an abandoned upload is swept.
import { readdir, rm, stat, utimes } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { FileStore } from "@tus/file-store";
import { MemoryLocker, Server, type Upload } from "@tus/server";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PgBoss } from "pg-boss";
import { isUuid, uuidv7 } from "../db/ids.js";
import { kindFromName } from "../ingest/detect.js";
import {
  type IngestInput,
  type IngestResult,
  type IngestTarget,
  UNSUPPORTED_MESSAGE,
} from "../ingest/ingest.js";
import { QUEUE } from "../jobs/queues.js";

/** The largest upload Platehouse takes, in bytes (512 MiB, the slicer contract's cap). */
export const MAX_UPLOAD_BYTES = 536_870_912;

/** How long an upload may sit untouched before the hourly sweep deletes it. */
export const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;

/** The longest file name an upload may carry, in UTF-16 code units. */
export const MAX_FILENAME_LENGTH = 1024;

/** The longest batch id an upload may carry. */
export const MAX_BATCH_LENGTH = 200;

/**
 * What a failed ingest shows when its error is not one of ingest's own
 * messages. It promises nothing about what was stored: when the database
 * cannot say how a commit ended, ingest keeps what it stored and fails with
 * the database's own error, so the model may be in the library after all.
 */
export const UPLOAD_FAILED_MESSAGE =
  "The upload could not be confirmed in the library; check the library before sending it again";

const QUEUE_FAILED_MESSAGE = "The upload could not be queued; nothing was saved. Try again.";

const LENGTH_REQUIRED_MESSAGE =
  `Upload-Length is required: Platehouse takes uploads of a known size, ` +
  `at most ${MAX_UPLOAD_BYTES} bytes`;

/** An upload id: a lowercase hyphenated UUID, as uuidv7() makes. */
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A name in the uploads folder: an upload's data file or its .json info file. */
const UPLOAD_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.json)?$/;

/** Where partial uploads live: TMP_DIR/uploads. */
export function uploadsDir(tmpDir: string): string {
  return join(tmpDir, "uploads");
}

/**
 * A Fastify onRequest hook for one mount: the session check for /app/uploads,
 * the bearer check for /api/v1/uploads (Part C). It lets a request through by
 * returning, or answers it itself (401), and then nothing else runs.
 */
export type AuthHook = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** What GET <prefix>/:id/result answers (Public API v1 contract). */
export type UploadResult =
  | { status: "pending" }
  | { status: "done"; modelId: string; fileId: string }
  | { status: "failed"; error: string };

/** The ingest queue as the uploads see it. */
export interface UploadQueue {
  /** Queues ingest of a finished upload, keyed by the upload id. Safe to repeat. */
  enqueue(id: string, input: IngestInput): Promise<void>;
  /** The ingest's outcome, or undefined when nothing was queued under this id. */
  result(id: string): Promise<UploadResult | undefined>;
}

/** An upload refused before it is created, with the status and message to answer. */
export class UploadRefused extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "UploadRefused";
    this.status = status;
  }
}

/** The error shape @tus/server answers with: its status and body. */
class TusAnswer extends Error {
  readonly status_code: number;
  readonly body: string;

  constructor(status: number, message: string) {
    super(message);
    this.status_code = status;
    this.body = `${message}\n`;
  }
}

function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * The file name and ingest target an upload's metadata asks for, or
 * UploadRefused (400 for bad metadata, 415 for a type Platehouse does not
 * take). Keys it does not know are ignored, so a client may send more.
 */
export function parseUploadMetadata(metadata: Record<string, string | null> | undefined): {
  originalName: string;
  target: IngestTarget;
} {
  const name = metadata?.filename;
  if (typeof name !== "string" || name.trim() === "") {
    throw new UploadRefused(400, "Upload-Metadata must carry the file's name as filename");
  }
  if (name.length > MAX_FILENAME_LENGTH || hasControlCharacter(name)) {
    throw new UploadRefused(
      400,
      `filename must be at most ${MAX_FILENAME_LENGTH} characters with no control characters`,
    );
  }
  if (kindFromName(name) === null) throw new UploadRefused(415, UNSUPPORTED_MESSAGE);

  const has = (key: string) => metadata !== undefined && Object.hasOwn(metadata, key);
  if (has("modelId")) {
    const id = metadata?.modelId;
    if (has("batch") || has("combine")) {
      throw new UploadRefused(400, "Give modelId or batch, not both");
    }
    if (typeof id !== "string" || !isUuid(id)) {
      throw new UploadRefused(400, "modelId must be a model id (a UUID)");
    }
    return { originalName: name, target: { modelId: id.toLowerCase() } };
  }
  if (has("batch")) {
    const batch = metadata?.batch;
    if (typeof batch !== "string" || batch === "" || batch.length > MAX_BATCH_LENGTH) {
      throw new UploadRefused(400, `batch must be 1 to ${MAX_BATCH_LENGTH} characters`);
    }
    let combine = false;
    if (has("combine")) {
      const value = metadata?.combine;
      if (value === "1" || value === "true") combine = true;
      else if (value !== "0" && value !== "false") {
        throw new UploadRefused(400, "combine must be 1, 0, true or false");
      }
    }
    return { originalName: name, target: { batch, combine } };
  }
  if (has("combine")) throw new UploadRefused(400, "combine needs a batch");
  return { originalName: name, target: "new" };
}

/** How the ingest queue (pg-boss) reports an upload's ingest. */
export function bossUploadQueue(boss: Pick<PgBoss, "send" | "getJobById">): UploadQueue {
  return {
    async enqueue(id, input) {
      // A job with this id already there (a repeated finish) is left as it is.
      await boss.send(QUEUE.ingest, input, { id });
    },
    async result(id) {
      const job = await boss.getJobById(QUEUE.ingest, id);
      if (job === null || job === undefined) return undefined;
      const output = job.output as Record<string, unknown> | null | undefined;
      switch (job.state) {
        case "created":
        case "retry":
        case "active":
          return { status: "pending" };
        case "completed": {
          const modelId = output?.modelId;
          const fileId = output?.fileId;
          if (typeof modelId === "string" && typeof fileId === "string") {
            return { status: "done", modelId, fileId };
          }
          return { status: "failed", error: UPLOAD_FAILED_MESSAGE };
        }
        case "failed": {
          // Only ingest's own messages are written for Jon; anything else
          // (a database error, a stack) stays in the job and the logs.
          const message = output?.message;
          if (output?.name === "IngestError" && typeof message === "string") {
            return { status: "failed", error: message };
          }
          return { status: "failed", error: UPLOAD_FAILED_MESSAGE };
        }
        default:
          return { status: "failed", error: UPLOAD_FAILED_MESSAGE };
      }
    },
  };
}

export interface UploadSweepResult {
  /** Uploads found: ids with a data file, an info file or both. */
  listed: number;
  /** Uploads deleted: untouched for 24 hours with no ingest still queued. */
  deleted: number;
  /** Uploads kept: touched within 24 hours, or with an ingest still queued. */
  kept: number;
  /** Files in the folder that are not uploads, left alone. */
  skipped: number;
}

/** The upload store both mounts share. */
export interface Uploads {
  /** TMP_DIR/uploads. */
  readonly dir: string;
  readonly queue: UploadQueue;
  readonly datastore: FileStore;
  readonly locker: MemoryLocker;
  /**
   * ingestFile for the ingest queue's worker: runs it, then deletes the
   * upload's temp file whether it succeeded or failed. The info file is kept
   * and its time set to now, so HEAD answers the upload as finished until the
   * sweep deletes it a day later. A path outside TMP_DIR/uploads (an inbox
   * file) is never deleted here.
   */
  ingestUpload(
    ingestFile: (input: IngestInput) => Promise<IngestResult>,
  ): (input: IngestInput) => Promise<IngestResult>;
  /**
   * The hourly sweep: deletes uploads untouched for 24 hours before now,
   * an ingested upload's kept info file included.
   */
  sweepStaleUploads(now: Date): Promise<UploadSweepResult>;
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

/** Deletes an upload's data file and info file; a file already gone is fine. */
async function removeUpload(dir: string, id: string): Promise<void> {
  await rm(join(dir, id), { force: true });
  await rm(join(dir, `${id}.json`), { force: true });
}

export function createUploads(deps: {
  tmpDir: string;
  queue: UploadQueue;
  /** Where the sweep's line and cleanup errors go; console.info when left out. */
  log?: (line: string) => void;
}): Uploads {
  const dir = uploadsDir(deps.tmpDir);
  const { queue } = deps;
  const log = deps.log ?? ((line: string) => console.info(line));

  function ingestUpload(ingestFile: (input: IngestInput) => Promise<IngestResult>) {
    return async (input: IngestInput): Promise<IngestResult> => {
      try {
        return await ingestFile(input);
      } finally {
        const path = resolve(input.tmpPath);
        const id = basename(path);
        if (dirname(path) === resolve(dir) && UPLOAD_ID.test(id)) {
          try {
            await rm(join(dir, id), { force: true });
            const now = new Date();
            await utimes(join(dir, `${id}.json`), now, now).catch((error: unknown) => {
              if (errorCode(error) !== "ENOENT") throw error;
            });
          } catch (error) {
            // The ingest's own outcome is what matters; the sweep removes
            // the file once it is a day old.
            log(`uploads: could not tidy upload ${id} after ingest (${errorCode(error)})`);
          }
        }
      }
    };
  }

  async function sweepStaleUploads(now: Date): Promise<UploadSweepResult> {
    const result: UploadSweepResult = { listed: 0, deleted: 0, kept: 0, skipped: 0 };
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return result;
      throw error;
    }
    const byId = new Map<string, string[]>();
    for (const name of names) {
      const id = UPLOAD_FILE.exec(name)?.[1];
      if (id === undefined) {
        result.skipped += 1;
        continue;
      }
      byId.set(id, [...(byId.get(id) ?? []), name]);
    }
    const cutoff = now.getTime() - STALE_UPLOAD_MS;
    try {
      for (const [id, files] of byId) {
        result.listed += 1;
        // The last write to either file: a PATCH moves the data file's mtime.
        let touched = Number.NEGATIVE_INFINITY;
        for (const name of files) {
          try {
            touched = Math.max(touched, (await stat(join(dir, name))).mtimeMs);
          } catch (error) {
            if (errorCode(error) !== "ENOENT") throw error;
          }
        }
        if (touched >= cutoff || (await queue.result(id))?.status === "pending") {
          result.kept += 1;
          continue;
        }
        await removeUpload(dir, id);
        result.deleted += 1;
      }
    } catch (error) {
      log(`${sweepLine(result)}; stopped by an error, the next run finishes it`);
      throw error;
    }
    log(sweepLine(result));
    return result;
  }

  return {
    dir,
    queue,
    datastore: new FileStore({ directory: dir }),
    locker: new MemoryLocker(),
    ingestUpload,
    sweepStaleUploads,
  };
}

function sweepLine(r: UploadSweepResult): string {
  return (
    `upload sweep: found ${r.listed} uploads, deleted ${r.deleted} untouched for 24 hours, ` +
    `kept ${r.kept}, left ${r.skipped} other files alone`
  );
}

/**
 * The length of an upload that ingest has already taken (its data file is
 * gone, its info file is kept and an ingest job exists under its id), or
 * undefined for any other upload, which tus answers itself.
 */
async function ingestedLength(uploads: Uploads, id: string): Promise<number | undefined> {
  try {
    await stat(join(uploads.dir, id));
    return undefined;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") return undefined;
  }
  const size = (await uploads.datastore.configstore.get(id))?.size;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return undefined;
  if ((await uploads.queue.result(id)) === undefined) return undefined;
  return size;
}

/** A Web Request for @tus/server: the canonical path, no Host or forwarded headers. */
function tusRequest(request: FastifyRequest, path: string): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (name === "host" || name === "forwarded" || name.startsWith("x-forwarded-")) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  const init: RequestInit & { duplex?: "half" } = { method: request.method, headers };
  // Only a tus body is handed over; tus reads no other.
  if (
    (request.method === "POST" || request.method === "PATCH") &&
    headers.get("content-type") === "application/offset+octet-stream"
  ) {
    init.body = Readable.toWeb(request.raw) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  // The origin is never used: Location is relative and no URL is built from it.
  return new Request(new URL(path, "http://platehouse.invalid"), init);
}

/** How long a body tus answered early is read off before its connection is closed. */
const DRAIN_MS = 5000;

/**
 * When tus answered before reading the whole body (409 wrong offset, 413),
 * the rest is read off and dropped so the client can read the answer rather
 * than meet a reset, for at most DRAIN_MS, and the connection then closes.
 * Node cannot do this itself here: once Readable.toWeb has started reading a
 * request, Node no longer dumps its unread body when the response ends, and
 * the connection would stay busy for good.
 */
function releaseUnreadBody(request: FastifyRequest, reply: FastifyReply): void {
  const raw = request.raw;
  if (raw.complete || raw.destroyed) return;
  reply.header("connection", "close");
  raw.removeAllListeners("data");
  raw.on("data", () => {});
  const timer = setTimeout(() => raw.destroy(), DRAIN_MS);
  timer.unref();
  raw.once("end", () => clearTimeout(timer));
  raw.once("close", () => clearTimeout(timer));
  raw.resume();
}

/** Sends a tus Response through Fastify, without its CORS headers. */
async function sendTusResponse(reply: FastifyReply, response: Response): Promise<FastifyReply> {
  reply.code(response.status);
  for (const [name, value] of response.headers) {
    if (name.startsWith("access-control-") || name === "content-length" || name === "connection") {
      continue;
    }
    reply.header(name, value);
  }
  return reply.send(response.body === null ? "" : await response.text());
}

/**
 * Mounts the tus routes at prefix behind authHook: POST <prefix>,
 * HEAD and PATCH <prefix>/:id, and GET <prefix>/:id/result.
 */
export async function registerTus(
  app: FastifyInstance,
  opts: { prefix: string; authHook: AuthHook; uploads: Uploads },
): Promise<void> {
  const { authHook, uploads } = opts;
  const prefix = opts.prefix.replace(/\/+$/, "");

  const tus = new Server({
    path: prefix,
    datastore: uploads.datastore,
    locker: uploads.locker,
    maxSize: MAX_UPLOAD_BYTES,
    relativeLocation: true,
    respectForwardedHeaders: false,
    allowedOrigins: () => false,
    namingFunction: () => uuidv7(),
    onUploadCreate: async (_req, upload: Upload) => {
      try {
        parseUploadMetadata(upload.metadata);
      } catch (error) {
        if (error instanceof UploadRefused) throw new TusAnswer(error.status, error.message);
        throw error;
      }
      return {};
    },
    onUploadFinish: async (_req, upload: Upload) => {
      const { originalName, target } = parseUploadMetadata(upload.metadata);
      try {
        await uploads.queue.enqueue(upload.id, {
          tmpPath: join(uploads.dir, upload.id),
          originalName,
          target,
        });
      } catch {
        // Nothing will ingest it, so it is removed now rather than left for
        // the sweep, and the client is told to send it again.
        await removeUpload(uploads.dir, upload.id);
        throw new TusAnswer(503, QUEUE_FAILED_MESSAGE);
      }
      return {};
    },
  });

  await app.register(
    async (scope) => {
      // tus bodies are streamed to the file store, never parsed or buffered.
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser("*", (_request, _payload, done) => done(null));
      scope.addHook("onRequest", authHook);

      const uploadId = (request: FastifyRequest): string | undefined => {
        const id = (request.params as { id?: string }).id;
        return id !== undefined && UPLOAD_ID.test(id) ? id : undefined;
      };

      scope.post("/", async (request, reply) => {
        if (request.headers["upload-length"] === undefined) {
          return reply
            .code(400)
            .header("tus-resumable", "1.0.0")
            .send(`${LENGTH_REQUIRED_MESSAGE}\n`);
        }
        const response = await tus.handleWeb(tusRequest(request, prefix));
        releaseUnreadBody(request, reply);
        return sendTusResponse(reply, response);
      });

      const forwardToId = async (request: FastifyRequest, reply: FastifyReply) => {
        const id = uploadId(request);
        if (id === undefined) return reply.code(404).send("Not found\n");
        const response = await tus.handleWeb(tusRequest(request, `${prefix}/${id}`));
        releaseUnreadBody(request, reply);
        return sendTusResponse(reply, response);
      };
      scope.head("/:id", async (request, reply) => {
        const id = uploadId(request);
        const length = id === undefined ? undefined : await ingestedLength(uploads, id);
        if (length === undefined) return forwardToId(request, reply);
        // Already ingested: finished, so a resuming client sends nothing more.
        return reply
          .code(200)
          .header("tus-resumable", "1.0.0")
          .header("upload-offset", String(length))
          .header("upload-length", String(length))
          .header("cache-control", "no-store")
          .send("");
      });
      scope.patch("/:id", forwardToId);

      scope.get("/:id/result", async (request, reply) => {
        const id = uploadId(request);
        if (id === undefined) return reply.code(404).send({ error: "not_found" });
        const result = await uploads.queue.result(id);
        if (result !== undefined) return reply.send(result);
        // Still uploading: its info file is there and nothing is queued yet.
        try {
          await stat(join(uploads.dir, `${id}.json`));
          return reply.send({ status: "pending" } satisfies UploadResult);
        } catch {
          return reply.code(404).send({ error: "not_found" });
        }
      });
    },
    { prefix },
  );
}
