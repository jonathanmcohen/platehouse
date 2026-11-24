// Resumable uploads, shared by the UI and the API so a large file completes either way. One tus 1.0.0
// handler, mounted twice: /app/uploads for the UI behind its session and
// /api/v1/uploads for the API behind a bearer token.
// The auth hooks live in app.ts (requireSession for /app/uploads, apiUploadHook
// for /api/v1/uploads), so registerTus takes one as a parameter;
// it runs on every request before anything else, so a refused request stores
// nothing.
//
// The flow:
//   1. POST <prefix> creates an upload. Upload-Length is required and at most
//      MAX_UPLOAD_BYTES (512 MiB), so an open length cannot dodge the cap.
//      Upload-Metadata must carry filename, and may carry modelId (into an
//      existing model) or batch with combine (ingest's batch target), and
//      duplicates: skip or allow (approved for 0.1.0 by the maintainer, 2026-11-19).
//      Left out it is allow, so an API client that never sends it sees no
//      change; the web dialog sends skip unless the user chose Import anyway.
//      Upload-Length: 0 is refused (400), as no supported type is valid
//      empty. A creation is also refused when the uploads in TMP_DIR/uploads
//      would declare more than UPLOAD_TEMP_MAX_BYTES together, the folder
//      already holds 10,000 uploads in any state, or the disk would be left
//      with less than 1 GiB free beyond this one, counting the bytes other
//      unfinished uploads are still to receive, or fewer than 10,000 free
//      inodes (507), or when its session or API token already holds 20
//      unfinished uploads, or 2,000 uploads in any state (429); the checks
//      run one at a time
//      (Uploads.reserve). A refused creation (400, 413, 415, 429, 507)
//      writes nothing.
//   2. PATCH <prefix>/<id> appends bytes at Upload-Offset; HEAD <prefix>/<id>
//      tells a client where to resume after a cut-off (a phone switching from
//      the LAN to a VPN, a backgrounded tab). One PATCH may carry the
//      whole file (curl), or a client may send chunks.
//   3. When the last byte lands, the upload is queued for ingest on the
//      ingest queue under the upload's own id, and ingestFile runs
//      there. GET <prefix>/<id>/result answers pending, done (modelId,
//      fileId, and duplicates: the live files that already held the same
//      bytes, empty when none did) or failed (a message for the user; a duplicate
//      refused under skip adds code "duplicate" and the duplicates it
//      matched, so a client can link to the model or send it again with
//      allow). A refused duplicate is an IngestError, so HEAD answers it 410
//      like any other refusal: nothing was saved. tus queues it after letting
//      go of the upload's lock, so a process that stops in between leaves
//      every byte there and no job; the result route then queues it itself
//      (queueIfFinished), under the same id.
//   4. The worker deletes the temp file after ingest, whether it succeeds or
//      fails (ingestUpload), and keeps the upload's info file for the sweep
//      with the ingest's outcome written into it. A client whose last PATCH
//      was answered after it lost the connection retries with a HEAD, and on
//      a 4xx tus-js-client creates the upload again; so does a client that
//      kept its resume fingerprint (tus-js-client's default) and sends the
//      same file again. HEAD on an ingested upload therefore answers by what
//      the ingest did:
//      - it stored the file: finished (Upload-Offset equal to Upload-Length),
//        so nothing is sent again and no second model is made;
//      - it failed with an IngestError: 410, since nothing was saved and a
//        fresh send is safe. Ingest makes every failure that cannot have
//        committed an IngestError, a database that is down when it starts
//        included;
//      - it failed with IngestOutcomeUnknown, a commit whose outcome the
//        database could not report: finished, since ingest kept what it
//        stored and the model may be in the library, so a resend could make
//        a second one; the result route says the upload could not be
//        confirmed. Any other error, which ingest does not throw, is taken
//        the same way, on the side that makes no duplicate.
//      HEAD carries no metadata, so the finished answer is the same whatever
//      target the new send names. tus-js-client's fingerprint is the file and
//      the endpoint, not the metadata, so a client that keeps it after
//      success would resume a stored upload when the same file is later
//      dropped on another model or batch, and store nothing there. The web
//      client (apps/web) must therefore either put the target (modelId, batch,
//      combine) into its fingerprint or drop the fingerprint once an upload
//      succeeds.
//      The tidy-up runs under the upload's tus lock, which tus's HEAD and
//      PATCH take too, so a HEAD never sees the data file gone before the
//      outcome is written. An upload left untouched for 24 hours, or 24 hours
//      after its ingest, is deleted by the hourly sweep on the maintenance
//      queue (sweepStaleUploads); a partial one never becomes a model, even after a phone
//      upload was cut off by a network switch. An unfinished upload is also
//      deleted 24 hours after it was created, whatever it last received,
//      and one that has received no byte once it has sat untouched
//      for an hour. The sweep deletes an upload only while it holds the
//      upload's lock, which stops a PATCH still writing it first. A
//      refusal (429, 507) is logged with its owner, at most once a minute
//      for each owner and status; a 507 for the total names the three users
//      holding the most bytes, and one for the 10,000 uploads the three
//      holding the most uploads, as each info file records who made it
//      (holderOf).
//
// Partial uploads live in TMP_DIR/uploads, one data file and one .json info
// file per upload, both named by the upload id, a UUIDv7. The UI and API
// mounts share that folder and one lock per upload (createUploads).
//
// Responses carry no CORS headers, as the API never does: @tus/server always sets
// Access-Control-* headers, so they are dropped here. Location is relative
// (<prefix>/<id>) and no forwarded or Host header is read, so no URL comes
// from the request. There is no DELETE, GET or OPTIONS on an upload:
// the API deletes nothing, and an abandoned upload is swept.
import { mkdir, readdir, rm, stat, statfs } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { FileStore } from "@tus/file-store";
import { ERRORS, EVENTS, MemoryLocker, Server, Upload } from "@tus/server";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PgBoss } from "pg-boss";
import { isUuid, uuidv7 } from "../db/ids.js";
import { kindFromName } from "../ingest/detect.js";
import {
  type DuplicateMatch,
  type DuplicatePolicy,
  IngestError,
  type IngestInput,
  type IngestResult,
  type IngestTarget,
  UNSUPPORTED_MESSAGE,
} from "../ingest/ingest.js";
import { hasControlCharacter, stripFormatChars } from "../ingest/names.js";
import { QUEUE } from "../jobs/queues.js";

/** The largest upload Platehouse takes, in bytes (512 MiB, the slicer contract's cap). */
export const MAX_UPLOAD_BYTES = 536_870_912;

/** The slow link a whole upload must fit through in one request: 1 Mbit/s. */
export const SLOW_LINK_BYTES_PER_SECOND = 125_000;

/**
 * The HTTP request timeout (app.ts gives it to Fastify): a MAX_UPLOAD_BYTES
 * single PATCH at SLOW_LINK_BYTES_PER_SECOND, about 72 minutes. Fastify's own
 * default is no limit at all; this is the upper bound, sized for that one
 * upload. Kept here beside the cap it is sized from, so the API description
 * (api/openapi.ts) can state both without importing app.ts.
 */
export const REQUEST_TIMEOUT_MS = Math.ceil(MAX_UPLOAD_BYTES / SLOW_LINK_BYTES_PER_SECOND) * 1000;

/** How long an upload may sit untouched before the hourly sweep deletes it. */
export const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;

/**
 * How long an upload that has received no byte at all may sit untouched
 * before the hourly sweep deletes it.
 */
export const EMPTY_UPLOAD_MS = 60 * 60 * 1000;

/**
 * UPLOAD_TEMP_MAX_BYTES's default (config.ts): the most that unfinished
 * uploads, and finished ones waiting for ingest, may declare together, 4 GiB.
 */
export const DEFAULT_UPLOAD_TEMP_MAX_BYTES = 4_294_967_296;

/** The free space a new upload must leave on the uploads folder's disk beyond its own length: 1 GiB. */
export const FREE_SPACE_MARGIN_BYTES = 1_073_741_824;

/**
 * The most unfinished uploads (every byte not yet arrived, none at all
 * included) one session or API token may hold at once.
 */
export const MAX_UNFINISHED_PER_PRINCIPAL = 20;

/**
 * The most uploads one session or API token may have in the uploads folder at
 * once, in any state: unfinished, finished and waiting for ingest, or the
 * info file an ingested one keeps for a day. So no one sender can fill
 * MAX_UPLOADS_ON_DISK alone.
 */
export const MAX_UPLOADS_PER_PRINCIPAL = 2000;

/**
 * The most uploads the uploads folder may hold at once, in any state: an
 * unfinished one, a finished one waiting for ingest, or the info file an
 * ingested one keeps for a day. Each creation reads the whole folder, so this
 * also bounds that read.
 */
export const MAX_UPLOADS_ON_DISK = 10_000;

/** The fewest free inodes a new upload must leave on the uploads folder's disk. */
export const MIN_FREE_FILES = 10_000;

/** The longest file name an upload may carry, in UTF-16 code units. */
export const MAX_FILENAME_LENGTH = 1024;

/** The longest batch id an upload may carry. */
export const MAX_BATCH_LENGTH = 200;

/**
 * What a failed ingest shows when its error is not an IngestError. It
 * promises nothing about what was stored: when the database cannot say how a
 * commit ended, ingest keeps what it stored and fails with
 * IngestOutcomeUnknown, so the model may be in the library after all.
 */
export const UPLOAD_FAILED_MESSAGE =
  "The upload could not be confirmed in the library; check the library before sending it again";

export const QUEUE_FAILED_MESSAGE = "The upload could not be queued; nothing was saved. Try again.";

/**
 * What GET <prefix>/:id/result answers (503) when the ingest queue cannot be
 * read, for example while Postgres restarts. The cause goes to the log only.
 */
const RESULT_UNAVAILABLE_MESSAGE =
  "The upload's result cannot be read right now. Try again shortly.";

/** What a creation over UPLOAD_TEMP_MAX_BYTES answers (507). */
export const TEMP_TOTAL_MESSAGE =
  "Unfinished uploads already hold all the room this server keeps for them; nothing was " +
  "saved. Try again once some have finished.";

/** What a creation the disk has no room for answers (507). */
export const DISK_FULL_MESSAGE =
  "The server's disk does not have room for this upload; nothing was saved. Try again later.";

/** What a creation answers (507) when the uploads folder holds MAX_UPLOADS_ON_DISK uploads. */
export const TOO_MANY_UPLOADS_MESSAGE =
  "The server is holding as many uploads as it keeps at once; nothing was saved. Try again " +
  "later.";

/**
 * What a sender's creation past MAX_UPLOADS_PER_PRINCIPAL answers (429). The
 * web app tells it from TOO_MANY_UNFINISHED_MESSAGE by "uploads on the
 * server" (failureMessage in apps/web/src/upload/useTusUpload.ts), so keep
 * those words in it and out of the other.
 */
export const TOO_MANY_HELD_MESSAGE =
  `You already have ${MAX_UPLOADS_PER_PRINCIPAL} uploads on the server, finished ones ` +
  "included; nothing was saved. A finished upload is cleared a day after its import; try " +
  "again later.";

/** What a sender's creation past MAX_UNFINISHED_PER_PRINCIPAL answers (429). */
export const TOO_MANY_UNFINISHED_MESSAGE =
  `You already have ${MAX_UNFINISHED_PER_PRINCIPAL} unfinished uploads; nothing was saved. ` +
  "Finish or wait for one of them, then try again.";

/** What a creation with Upload-Length: 0 answers (400): no supported file type is valid empty. */
export const EMPTY_UPLOAD_MESSAGE = "Platehouse does not take empty files; nothing was saved.";

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
 * the bearer check for /api/v1/uploads (app.ts passes requireSession and
 * apiUploadHook). It lets a request through by
 * returning, or answers it itself (401), and then nothing else runs.
 */
export type AuthHook = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/**
 * What the ingest queue reports for an upload, and GET <prefix>/:id/result
 * answers. On /api/v1/uploads the answer is the one api/openapi.ts documents
 * for the Public API v1: a failure carries a code only when it is a skipped
 * duplicate (publicResult removes every other code). On /app/uploads, the
 * web app's own mount, a failure also carries the ingest's own code
 * (unsupported_type, model_not_found, storage_unavailable, ingest_failed,
 * upload_failed), so the page can say it in its language (the maintainer,
 * 2026-11-19).
 */
export type UploadResult =
  | { status: "pending" }
  | { status: "done"; modelId: string; fileId: string; duplicates: DuplicateMatch[] }
  | { status: "failed"; error: string }
  | { status: "failed"; error: string; code: string }
  | { status: "failed"; error: string; code: "duplicate"; duplicates: DuplicateMatch[] };

/**
 * A result as the Public API v1 answers it: a failed upload keeps its code
 * only when it is "duplicate" and carries the duplicates it matched, exactly
 * as the published OpenAPI document says; every other code, which only the
 * web app's mount sends, is removed, and so is a duplicate code with no
 * matches (an older or malformed job, PR 287 review).
 */
export function publicResult(result: UploadResult): UploadResult {
  if (result.status !== "failed" || !("code" in result)) return result;
  if (result.code === "duplicate" && "duplicates" in result && result.duplicates.length > 0) {
    return result;
  }
  return { status: "failed", error: result.error };
}

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

/**
 * The file name and ingest target an upload's metadata asks for, or
 * UploadRefused (400 for bad metadata, 415 for a type Platehouse does not
 * take). Keys it does not know are ignored, so a client may send more.
 */
export function parseUploadMetadata(metadata: Record<string, string | null> | undefined): {
  originalName: string;
  target: IngestTarget;
  duplicates: DuplicatePolicy;
} {
  return { ...parseTarget(metadata), duplicates: parseDuplicates(metadata) };
}

/** The duplicates key: skip or allow, allow when it is left out. */
function parseDuplicates(metadata: Record<string, string | null> | undefined): DuplicatePolicy {
  if (metadata === undefined || !Object.hasOwn(metadata, "duplicates")) return "allow";
  const value = metadata.duplicates;
  if (value === "skip" || value === "allow") return value;
  throw new UploadRefused(400, "duplicates must be skip or allow");
}

function parseTarget(metadata: Record<string, string | null> | undefined): {
  originalName: string;
  target: IngestTarget;
} {
  const sent = metadata?.filename;
  // Invisible format characters are dropped first, so a name made only of
  // them is an empty name.
  const name = typeof sent === "string" ? stripFormatChars(sent) : sent;
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

/** The entries of a stored duplicates list that are a file and its model; anything else is dropped. */
function duplicateList(value: unknown): DuplicateMatch[] {
  if (!Array.isArray(value)) return [];
  const out: DuplicateMatch[] = [];
  for (const item of value) {
    const m = item as Record<string, unknown> | null;
    if (
      typeof m?.modelId === "string" &&
      typeof m.modelName === "string" &&
      typeof m.fileId === "string" &&
      typeof m.fileName === "string"
    ) {
      out.push({
        modelId: m.modelId,
        modelName: m.modelName,
        fileId: m.fileId,
        fileName: m.fileName,
      });
    }
  }
  return out;
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
            // A job stored before duplicates were reported has none.
            return {
              status: "done",
              modelId,
              fileId,
              duplicates: duplicateList(output?.duplicates),
            };
          }
          return { status: "failed", error: UPLOAD_FAILED_MESSAGE, code: "upload_failed" };
        }
        case "failed": {
          // Only ingest's own messages are written for the user; anything else
          // (a database error, a stack) stays in the job and the logs.
          const message = output?.message;
          if (output?.name === "IngestError" && typeof message === "string") {
            const duplicates = duplicateList(output.duplicates);
            if (output.code === "duplicate" && duplicates.length > 0) {
              return { status: "failed", error: message, code: "duplicate", duplicates };
            }
            // The code (unsupported_type, model_not_found, ...) lets the page
            // say it in its language (the maintainer, 2026-11-19).
            return typeof output.code === "string"
              ? { status: "failed", error: message, code: output.code }
              : { status: "failed", error: message };
          }
          return { status: "failed", error: UPLOAD_FAILED_MESSAGE, code: "upload_failed" };
        }
        default:
          return { status: "failed", error: UPLOAD_FAILED_MESSAGE, code: "upload_failed" };
      }
    },
  };
}

export interface UploadSweepResult {
  /** Uploads found: ids with a data file, an info file or both. */
  listed: number;
  /**
   * Uploads deleted: untouched for 24 hours with no ingest still queued,
   * untouched for an hour having received no byte (deletedEmpty), or still
   * unfinished 24 hours after they were created (deletedExpired).
   */
  deleted: number;
  /** Of deleted, the uploads that received no byte and were untouched for an hour. */
  deletedEmpty: number;
  /** Of deleted, the uploads still unfinished 24 hours after they were created. */
  deletedExpired: number;
  /**
   * Uploads kept: touched within 24 hours (and, if unfinished, created
   * within 24 hours), or with an ingest still queued.
   */
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
   * ingestFile for the ingest queue's worker: runs it, then, holding the
   * upload's lock, writes the ingest's outcome into the upload's info file
   * and deletes its temp file, whether the ingest succeeded or failed. The
   * rewrite sets the info file's time to now, so HEAD answers by that outcome
   * until the sweep deletes it a day later. A path outside TMP_DIR/uploads
   * (an inbox file) is never deleted here.
   */
  ingestUpload(
    ingestFile: (input: IngestInput) => Promise<IngestResult>,
  ): (input: IngestInput) => Promise<IngestResult>;
  /**
   * The hourly sweep: deletes uploads untouched for 24 hours before now,
   * an ingested upload's kept info file included, uploads that have
   * received no byte and were untouched for an hour, and uploads still
   * unfinished 24 hours after they were created.
   */
  sweepStaleUploads(now: Date): Promise<UploadSweepResult>;
  /**
   * Called before an upload of size bytes is created, for owner (a session
   * or API token; undefined when the mount names none) and holder (the user
   * behind it, for the log; see registerTus's holderOf). Refuses it with
   * UploadRefused, 429 when owner already has MAX_UNFINISHED_PER_PRINCIPAL
   * unfinished uploads or MAX_UPLOADS_PER_PRINCIPAL uploads in any state,
   * 507 when the folder already holds
   * MAX_UPLOADS_ON_DISK uploads, or it would take the uploads over
   * maxTempBytes, leave the disk less than FREE_SPACE_MARGIN_BYTES free
   * (counting what unfinished uploads are still to receive) or leave fewer
   * than MIN_FREE_FILES free inodes;
   * otherwise holds its size until the returned release is called, once the
   * upload's files are written or its creation failed. Checks run one at a
   * time, so creations that arrive together cannot all pass.
   */
  reserve(size: number, owner: string | undefined, holder?: string): Promise<() => void>;
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

/**
 * What an upload's ingest did, written into its info file by ingestUpload:
 * stored the file, failed with an IngestError (nothing saved), or failed
 * with IngestOutcomeUnknown or any other error (the outcome is not known).
 */
type IngestOutcome = "stored" | "nothing_saved" | "unknown";

/**
 * The info file's contents: tus's own fields, the session or API token that
 * created it (owner, the key the cap on unfinished uploads counts by), the
 * user behind it (holder, for the log; see registerTus's holderOf), neither
 * ever in metadata, which HEAD answers, and the outcome once ingested.
 */
type UploadInfo = Upload & { owner?: string; holder?: string; ingest?: IngestOutcome };

/** How often a refusal for one sender is logged at most. */
export const REFUSAL_LOG_MS = 60_000;

/** How many of the uploads' holders a 507 for the total names. */
const HOLDERS_LOGGED = 3;

/** What the log calls the holder of an upload whose info file names nobody. */
const NO_HOLDER = "an upload with no owner recorded";

/** A declared length read back from an info file: a whole number of bytes, else undefined. */
function declaredSize(info: Upload | undefined): number | undefined {
  const size = info?.size;
  return typeof size === "number" && Number.isSafeInteger(size) && size >= 0 ? size : undefined;
}

/** The free space on dir's disk for an unprivileged writer, in bytes. */
async function diskFreeBytes(dir: string): Promise<number> {
  const s = await statfs(dir);
  return s.bavail * s.bsize;
}

/**
 * The free inodes on dir's disk. A filesystem that makes inodes as it needs
 * them (btrfs, some network filesystems) reports a total of 0, and has no
 * count to run out of.
 */
async function diskFreeFiles(dir: string): Promise<number> {
  const s = await statfs(dir);
  return s.files === 0 ? Number.POSITIVE_INFINITY : s.ffree;
}

/** The ingest outcome an info file records, if any. */
function ingestOutcome(info: Upload | undefined): IngestOutcome | undefined {
  const value = (info as UploadInfo | undefined)?.ingest;
  return value === "stored" || value === "nothing_saved" || value === "unknown" ? value : undefined;
}

/**
 * The store tus answers HEAD from (registerTus): the shared folder and info
 * files, read under the same lock. When an upload's data file is gone it
 * answers by the outcome ingest wrote: finished after "stored" or "unknown",
 * and tus's own 410 after "nothing_saved" or when no ingest wrote one (the
 * queue was down, or the sweep got there). Because tus reads this while it
 * holds the upload's lock, and ingestUpload writes the outcome and deletes
 * the data file while holding it too, the check and the answer cannot be
 * split by the tidy-up. The finished answer carries no Upload-Metadata, as
 * before. PATCH still uses the plain store, so a PATCH after ingest is 410.
 */
class HeadStore extends FileStore {
  override async getUpload(id: string): Promise<Upload> {
    try {
      return await super.getUpload(id);
    } catch (error) {
      if (error !== ERRORS.FILE_NO_LONGER_EXISTS) throw error;
      const info = await this.configstore.get(id);
      const outcome = ingestOutcome(info);
      const size = declaredSize(info);
      if (outcome !== "stored" && outcome !== "unknown") throw error;
      if (size === undefined) throw error;
      return new Upload({ id, size, offset: size });
    }
  }
}

/** Who the log names for an upload: its holder, else its owner, else NO_HOLDER. */
function holderName(info: UploadInfo | undefined): string {
  if (typeof info?.holder === "string") return info.holder;
  if (typeof info?.owner === "string") return info.owner;
  return NO_HOLDER;
}

/** Adds one upload of bytes to name's share in holders. */
function addHolder(
  holders: Map<string, { uploads: number; bytes: number }>,
  name: string,
  bytes: number,
): void {
  const h = holders.get(name) ?? { uploads: 0, bytes: 0 };
  h.uploads += 1;
  h.bytes += bytes;
  holders.set(name, h);
}

/** Deletes an upload's data file and info file; a file already gone is fine. */
async function removeUpload(dir: string, id: string): Promise<void> {
  await rm(join(dir, id), { force: true });
  await rm(join(dir, `${id}.json`), { force: true });
}

/**
 * Makes TMP_DIR/uploads and waits for it. tus's FileStore starts its own mkdir
 * in its constructor, with a callback nothing waits for that throws on any
 * error but EEXIST; once this has made the folder, that mkdir meets EEXIST and
 * does nothing. Call it before createUploads, so an unwritable TMP_DIR is an
 * error the caller can handle, not an uncaught exception.
 */
export async function prepareUploads(tmpDir: string): Promise<void> {
  await mkdir(uploadsDir(tmpDir), { recursive: true });
}

export function createUploads(deps: {
  tmpDir: string;
  queue: UploadQueue;
  /** Where the sweep's line and cleanup errors go; console.info when left out. */
  log?: (line: string) => void;
  /** UPLOAD_TEMP_MAX_BYTES; DEFAULT_UPLOAD_TEMP_MAX_BYTES when left out. */
  maxTempBytes?: number;
  /** The free bytes on a folder's disk; statfs when left out (tests give their own). */
  freeBytes?: (dir: string) => Promise<number>;
  /** The free inodes on a folder's disk; statfs when left out (tests give their own). */
  freeFiles?: (dir: string) => Promise<number>;
  /** The clock refusal lines are spaced by; Date.now when left out. */
  now?: () => number;
}): Uploads {
  const dir = uploadsDir(deps.tmpDir);
  const { queue } = deps;
  const log = deps.log ?? ((line: string) => console.info(line));
  const maxTempBytes = deps.maxTempBytes ?? DEFAULT_UPLOAD_TEMP_MAX_BYTES;
  const freeBytes = deps.freeBytes ?? diskFreeBytes;
  const freeFiles = deps.freeFiles ?? diskFreeFiles;
  const now = deps.now ?? Date.now;
  const datastore = new FileStore({ directory: dir });
  const locker = new MemoryLocker();

  /** Creations that passed reserve and whose files may not be written yet. */
  const reservations = new Set<{
    size: number;
    owner: string | undefined;
    holder: string | undefined;
  }>();
  /** The last reserve check: each waits for the one before, so they run one at a time. */
  let checking: Promise<unknown> = Promise.resolve();

  /**
   * What the uploads in the folder hold: how many there are (ids with a data
   * file, an info file or both) and each owner's, the declared length of
   * every upload whose data file is still there (unfinished, or finished and
   * waiting for ingest), the bytes they have yet to receive, each owner's
   * unfinished uploads, and what each holder (the user, else the owner)
   * holds: every upload, and its bytes. A data file with no readable info
   * file counts by its size; an info file whose data is gone (ingested)
   * counts as an upload holding no bytes.
   */
  async function heldUploads(): Promise<{
    uploads: number;
    declared: number;
    toCome: number;
    unfinished: Map<string, number>;
    onDisk: Map<string, number>;
    holders: Map<string, { uploads: number; bytes: number }>;
  }> {
    const held = {
      uploads: 0,
      declared: 0,
      toCome: 0,
      unfinished: new Map<string, number>(),
      onDisk: new Map<string, number>(),
      holders: new Map<string, { uploads: number; bytes: number }>(),
    };
    const ids = new Set<string>();
    for (const name of await readdir(dir)) {
      const id = UPLOAD_FILE.exec(name)?.[1];
      if (id !== undefined) ids.add(id);
    }
    held.uploads = ids.size;
    for (const id of ids) {
      let received: number | undefined;
      try {
        received = (await stat(join(dir, id))).size;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
      const info = (await datastore.configstore.get(id)) as UploadInfo | undefined;
      const owner = typeof info?.owner === "string" ? info.owner : undefined;
      if (owner !== undefined) held.onDisk.set(owner, (held.onDisk.get(owner) ?? 0) + 1);
      const size = declaredSize(info);
      // Only a data file holds bytes; an info file kept after ingest holds none.
      let bytes = 0;
      if (received !== undefined) {
        bytes = size === undefined ? received : Math.max(size, received);
        held.declared += bytes;
        if (size !== undefined) {
          held.toCome += Math.max(0, size - received);
          if (received < size && owner !== undefined) {
            held.unfinished.set(owner, (held.unfinished.get(owner) ?? 0) + 1);
          }
        }
      }
      addHolder(held.holders, holderName(info), bytes);
    }
    return held;
  }

  /** When each sender's refusal was last logged, and how many were not logged since. */
  const refusalsLogged = new Map<string, { at: number; quiet: number }>();

  /**
   * Refuses a creation, logging the status, the reason and the owner of the
   * creation refused (a session row id or an API token id, never a cookie or
   * a token), at most once every REFUSAL_LOG_MS for each owner and status;
   * the next line for them says how many were not logged. A 507 for the
   * total or for MAX_UPLOADS_ON_DISK also names the HOLDERS_LOGGED users
   * holding the most (holders, ranked by bytes or by uploads), so the log
   * points at who holds the room, not only at who was refused.
   */
  function refuse(
    status: 429 | 507,
    owner: string | undefined,
    why: string,
    message: string,
    holders?: { all: Map<string, { uploads: number; bytes: number }>; by: "bytes" | "uploads" },
  ) {
    const key = `${owner ?? ""}|${status}`;
    const at = now();
    const last = refusalsLogged.get(key);
    if (last !== undefined && at - last.at < REFUSAL_LOG_MS) {
      last.quiet += 1;
      return new UploadRefused(status, message);
    }
    if (refusalsLogged.size >= 1000) {
      for (const [k, v] of refusalsLogged)
        if (at - v.at >= REFUSAL_LOG_MS) refusalsLogged.delete(k);
    }
    refusalsLogged.set(key, { at, quiet: 0 });
    let line = `uploads: refused a new upload (${status}) for ${owner ?? "no owner"}: ${why}`;
    if (holders !== undefined && holders.all.size > 0) {
      const { by } = holders;
      const top = [...holders.all]
        .sort((a, b) => b[1][by] - a[1][by])
        .slice(0, HOLDERS_LOGGED)
        .map(([name, h]) => {
          const count = h.uploads === 1 ? "1 upload" : `${h.uploads} uploads`;
          return `${name} (${count}, ${h.bytes} bytes)`;
        });
      line += `; held most by ${top.join(", ")}`;
    }
    const quiet = last?.quiet ?? 0;
    if (quiet > 0) {
      line += ` (${quiet} more ${quiet === 1 ? "refusal" : "refusals"} for it were not logged)`;
    }
    log(line);
    return new UploadRefused(status, message);
  }

  async function check(
    size: number,
    owner: string | undefined,
    holder: string | undefined,
  ): Promise<() => void> {
    // The folder may not be there yet: tus's FileStore makes it in its
    // constructor without waiting for it, so a creation can arrive first
    // under load (main.ts waits for prepareUploads; a caller that does not
    // relies on that mkdir), and TMP_DIR can be emptied while the server
    // runs. Reading it then, or writing the upload's files, would fail.
    await mkdir(dir, { recursive: true });
    // Taken before the folder is read. A reservation is given back only once
    // its upload's files are written (POST_CREATE in registerTus), so one
    // given back after this point is already in the folder when it is read,
    // and none falls between the two counts. One in both counts twice, the
    // safe side.
    const pending = [...reservations];
    const held = await heldUploads();
    let declared = held.declared;
    let toCome = held.toCome;
    let mine = owner === undefined ? 0 : (held.unfinished.get(owner) ?? 0);
    let mineOnDisk = owner === undefined ? 0 : (held.onDisk.get(owner) ?? 0);
    for (const r of pending) {
      declared += r.size;
      toCome += r.size;
      if (owner !== undefined && r.owner === owner) {
        mine += 1;
        mineOnDisk += 1;
      }
      addHolder(held.holders, r.holder ?? r.owner ?? NO_HOLDER, r.size);
    }
    if (owner !== undefined && mine >= MAX_UNFINISHED_PER_PRINCIPAL) {
      const why = `it already has ${MAX_UNFINISHED_PER_PRINCIPAL} unfinished uploads`;
      throw refuse(429, owner, why, TOO_MANY_UNFINISHED_MESSAGE);
    }
    if (owner !== undefined && mineOnDisk >= MAX_UPLOADS_PER_PRINCIPAL) {
      const why = `it already has ${MAX_UPLOADS_PER_PRINCIPAL} uploads in the folder`;
      throw refuse(429, owner, why, TOO_MANY_HELD_MESSAGE);
    }
    if (held.uploads + pending.length >= MAX_UPLOADS_ON_DISK) {
      const why = `the uploads folder already holds ${MAX_UPLOADS_ON_DISK} uploads`;
      throw refuse(507, owner, why, TOO_MANY_UPLOADS_MESSAGE, {
        all: held.holders,
        by: "uploads",
      });
    }
    if (declared + size > maxTempBytes) {
      const why = `${size} bytes would take the uploads past UPLOAD_TEMP_MAX_BYTES`;
      throw refuse(507, owner, why, TEMP_TOTAL_MESSAGE, { all: held.holders, by: "bytes" });
    }
    // The bytes other uploads are still owed will land on the same disk.
    if ((await freeBytes(dir)) - toCome < size + FREE_SPACE_MARGIN_BYTES) {
      const why = `${size} bytes would leave the disk less than 1 GiB free`;
      throw refuse(507, owner, why, DISK_FULL_MESSAGE);
    }
    if ((await freeFiles(dir)) < MIN_FREE_FILES) {
      const why = `the disk has fewer than ${MIN_FREE_FILES} free inodes`;
      throw refuse(507, owner, why, DISK_FULL_MESSAGE);
    }
    const reservation = { size, owner, holder };
    reservations.add(reservation);
    return () => {
      reservations.delete(reservation);
    };
  }

  function reserve(size: number, owner: string | undefined, holder?: string): Promise<() => void> {
    const run = checking.then(() => check(size, owner, holder));
    checking = run.catch(() => {});
    return run;
  }

  /**
   * Writes the outcome into the info file, then deletes the data file, both
   * under the upload's lock (HeadStore). If the outcome cannot be written the
   * data file stays, so HEAD keeps answering finished by its bytes rather
   * than 410, and the sweep removes both a day later.
   */
  async function tidyUpload(id: string, outcome: IngestOutcome): Promise<void> {
    const lock = locker.newLock(id);
    try {
      // A HEAD or PATCH that wants the lock meanwhile waits; this is brief.
      await lock.lock(new AbortController().signal, async () => {});
    } catch {
      // Only a timeout gets here: a request held the lock for 30 seconds.
      log(`uploads: could not lock upload ${id} to tidy it after ingest; the sweep will`);
      return;
    }
    try {
      const info = await datastore.configstore.get(id);
      if (info !== undefined) {
        // Rewriting the file also sets its time to now, so the sweep keeps
        // it for a day after the ingest.
        await datastore.configstore.set(id, { ...info, ingest: outcome } as UploadInfo);
      }
      await rm(join(dir, id), { force: true });
    } catch (error) {
      // The ingest's own outcome is what matters; the sweep removes the
      // files once they are a day old.
      log(`uploads: could not tidy upload ${id} after ingest (${errorCode(error)})`);
    } finally {
      await lock.unlock();
    }
  }

  function ingestUpload(ingestFile: (input: IngestInput) => Promise<IngestResult>) {
    return async (input: IngestInput): Promise<IngestResult> => {
      let outcome: IngestOutcome = "unknown";
      try {
        const result = await ingestFile(input);
        outcome = "stored";
        return result;
      } catch (error) {
        // IngestError: nothing saved. IngestOutcomeUnknown, or anything
        // else, stays "unknown", the side that makes no duplicate.
        if (error instanceof IngestError) outcome = "nothing_saved";
        throw error;
      } finally {
        const path = resolve(input.tmpPath);
        const id = basename(path);
        if (dirname(path) === resolve(dir) && UPLOAD_ID.test(id)) await tidyUpload(id, outcome);
      }
    };
  }

  async function sweepStaleUploads(now: Date): Promise<UploadSweepResult> {
    const result: UploadSweepResult = {
      listed: 0,
      deleted: 0,
      deletedEmpty: 0,
      deletedExpired: 0,
      kept: 0,
      skipped: 0,
    };
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return result;
      throw error;
    }
    const ids = new Set<string>();
    for (const name of names) {
      const id = UPLOAD_FILE.exec(name)?.[1];
      if (id === undefined) {
        result.skipped += 1;
        continue;
      }
      ids.add(id);
    }
    const cutoff = now.getTime() - STALE_UPLOAD_MS;
    const emptyCutoff = now.getTime() - EMPTY_UPLOAD_MS;
    /**
     * An unfinished upload's received bytes and creation time (NaN when its
     * info file gives none); undefined when either file is missing, it was
     * ingested, or every byte has arrived. An unfinished upload has no ingest
     * queued, so the pending rule never keeps it.
     */
    const unfinished = async (
      id: string,
      files: string[],
    ): Promise<{ received: number; created: number } | undefined> => {
      if (!files.includes(id) || !files.includes(`${id}.json`)) return undefined;
      const info = await datastore.configstore.get(id);
      const size = declaredSize(info);
      if (size === undefined || ingestOutcome(info) !== undefined) return undefined;
      let received: number;
      try {
        received = (await stat(join(dir, id))).size;
      } catch (error) {
        if (errorCode(error) === "ENOENT") return undefined;
        throw error;
      }
      if (received >= size) return undefined;
      return { received, created: Date.parse(String(info?.creation_date)) };
    };
    /**
     * Which rule, if any, deletes the upload now: read from its files as
     * they are at this moment, so it can be asked again under the lock.
     */
    const verdict = async (id: string): Promise<"empty" | "expired" | "idle" | "keep"> => {
      // The last write to either file: a PATCH moves the data file's mtime.
      let touched = Number.NEGATIVE_INFINITY;
      const files: string[] = [];
      for (const name of [id, `${id}.json`]) {
        try {
          touched = Math.max(touched, (await stat(join(dir, name))).mtimeMs);
          files.push(name);
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
      }
      const open = await unfinished(id, files);
      if (open !== undefined && open.received === 0 && touched < emptyCutoff) return "empty";
      if (touched >= cutoff || (await queue.result(id))?.status === "pending") {
        // An unfinished upload is also removed a day after it was created,
        // whatever it last received.
        return open !== undefined && open.created < cutoff ? "expired" : "keep";
      }
      return "idle";
    };
    /**
     * Deletes the upload under its tus lock, as tidyUpload does. Asking for
     * the lock makes a PATCH that holds it stop (tus cancels it, and lets go
     * once its write stream has closed), so no byte lands in a file after it
     * is deleted, where no limit would count it. The rule is read again
     * under the lock, as the stopped PATCH may have finished the upload.
     */
    const removeLocked = async (id: string): Promise<"empty" | "expired" | "idle" | "keep"> => {
      const lock = locker.newLock(id);
      try {
        await lock.lock(new AbortController().signal, async () => {});
      } catch {
        // Only a timeout gets here: a request held the lock for 30 seconds.
        log(`uploads: could not lock upload ${id} to sweep it; the next sweep tries again`);
        return "keep";
      }
      try {
        const now = await verdict(id);
        if (now !== "keep") await removeUpload(dir, id);
        return now;
      } finally {
        await lock.unlock();
      }
    };
    try {
      for (const id of ids) {
        result.listed += 1;
        const rule = (await verdict(id)) === "keep" ? "keep" : await removeLocked(id);
        if (rule === "keep") {
          result.kept += 1;
          continue;
        }
        result.deleted += 1;
        if (rule === "empty") result.deletedEmpty += 1;
        if (rule === "expired") result.deletedExpired += 1;
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
    datastore,
    locker,
    ingestUpload,
    sweepStaleUploads,
    reserve,
  };
}

function sweepLine(r: UploadSweepResult): string {
  const idle = r.deleted - r.deletedEmpty - r.deletedExpired;
  return (
    `upload sweep: found ${r.listed} uploads, deleted ${idle} untouched for 24 hours, ` +
    `${r.deletedEmpty} that received nothing for an hour and ${r.deletedExpired} unfinished ` +
    `24 hours after it was created, kept ${r.kept}, left ${r.skipped} other files alone`
  );
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

/** How long a body answered early is read off before its connection is closed. */
export const DRAIN_MS = 5000;

/**
 * True when the request carries a body (HTTP/1.1, RFC 9112 section 6.3): a
 * Transfer-Encoding, or a Content-Length above zero.
 */
function declaresBody(request: FastifyRequest): boolean {
  if (request.headers["transfer-encoding"] !== undefined) return true;
  return Number(request.headers["content-length"] ?? 0) > 0;
}

/**
 * When a request is answered before its whole body is read - tus's early
 * answers (409 wrong offset, 413), the auth hook's 401, a 404 - the answer
 * goes out at once with Connection: close, and the rest of the body is read
 * off and dropped, for at most DRAIN_MS, before the connection closes.
 * Closing it any earlier resets a client that is still sending, and the
 * reset can cost it the answer (a lingering close, RFC 9112 section 9.6).
 * Node does neither itself here. Once Readable.toWeb has started reading a
 * request, Node no longer dumps its unread body when the response ends, so
 * the connection would stay busy for good; a body nothing has touched Node
 * does dump, but for as long as the server's request timeout allows, about
 * 72 minutes (REQUEST_TIMEOUT_MS above). And for a Connection: close
 * answer, Node destroys the socket (socket.destroySoon, from the response's
 * finish) as soon as the answer is written, with the body still arriving.
 * So for this request that call only ends the writing side, and the socket
 * is closed once the body has been read or DRAIN_MS has passed. A request
 * that declares no body is left alone, so its connection stays open; it may
 * not be marked complete yet when an onRequest hook answers it. The slicer
 * closes its early answers the same way (closeLingering in
 * apps/slicer/src/guard.ts).
 */
export function releaseUnreadBody(request: FastifyRequest, reply: FastifyReply): void {
  const raw = request.raw;
  // A body read to its end (complete on a real request; readableEnded also
  // on an injected one, which has no complete flag) has nothing to drain.
  if (raw.complete || raw.readableEnded || raw.destroyed || !declaresBody(request)) return;
  reply.header("connection", "close");
  const socket = raw.socket;
  const destroySoon = socket.destroySoon;
  let answered = false;
  socket.destroySoon = () => {
    // The answer is written: end it with a FIN, and keep reading.
    answered = true;
    socket.end();
  };
  const timer = setTimeout(() => socket.destroy(), DRAIN_MS);
  timer.unref();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    socket.destroySoon = destroySoon;
    // Answered already: close now. Otherwise Node closes it once it is.
    if (answered) socket.destroySoon();
  };
  raw.once("end", release);
  raw.once("close", release);
  raw.removeAllListeners("data");
  raw.on("data", () => {});
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

/** Whether an upload's data file holds every byte its info file declares, and no ingest has run. */
async function finishedUnqueued(dir: string, id: string, info: UploadInfo): Promise<boolean> {
  if (ingestOutcome(info) !== undefined) return false;
  const declared = declaredSize(info);
  if (declared === undefined) return false;
  try {
    return (await stat(join(dir, id))).size === declared;
  } catch {
    return false;
  }
}

/**
 * What GET <prefix>/:id/result answers for an upload the queue has no job
 * for: pending while its bytes are still arriving, not_found once it is gone.
 * When every byte arrived but nothing queued its ingest (the process stopped
 * between the last byte and onUploadFinish), it is queued now under its own
 * id with its own metadata, as onUploadFinish would have, and is pending; a
 * send with an id that exists adds nothing, so a repeat is harmless. An
 * upload whose ingest already ran is never queued again, and one whose
 * metadata no longer parses is unparsable.
 *
 * The upload's lock is taken only once the data file holds every declared
 * byte, since @tus/server's lock asks its holder to let go, which cancels a
 * PATCH still sending; tus takes no byte past the declared length, so by then
 * the most it can cancel is a HEAD, or a PATCH whose bytes have all landed
 * and that has not yet let go of the lock; its upload is queued here either
 * way, and the client's next HEAD finds it finished. Under the lock the files
 * are read again, as ingest's tidy-up takes the same lock. A failure to
 * queue is thrown for the route to answer 503; nothing is removed, so a
 * later call tries again.
 */
async function queueIfFinished(
  uploads: Uploads,
  id: string,
): Promise<"pending" | "not_found" | "unparsable"> {
  const info = (await uploads.datastore.configstore.get(id)) as UploadInfo | undefined;
  if (info === undefined) {
    // No readable info file: pending while one is there, as before.
    try {
      await stat(join(uploads.dir, `${id}.json`));
      return "pending";
    } catch {
      return "not_found";
    }
  }
  if (!(await finishedUnqueued(uploads.dir, id, info))) return "pending";
  let input: IngestInput;
  try {
    input = { tmpPath: join(uploads.dir, id), ...parseUploadMetadata(info.metadata) };
  } catch {
    return "unparsable";
  }
  const lock = uploads.locker.newLock(id);
  try {
    await lock.lock(new AbortController().signal, async () => {});
  } catch {
    // Only a timeout gets here: a request held the lock for 30 seconds.
    return "pending";
  }
  try {
    const current = (await uploads.datastore.configstore.get(id)) as UploadInfo | undefined;
    if (current === undefined) return "not_found";
    if (await finishedUnqueued(uploads.dir, id, current)) await uploads.queue.enqueue(id, input);
    return "pending";
  } finally {
    await lock.unlock();
  }
}

/**
 * Mounts the tus routes at prefix behind authHook: POST <prefix>,
 * HEAD and PATCH <prefix>/:id, and GET <prefix>/:id/result.
 */
export async function registerTus(
  app: FastifyInstance,
  opts: {
    prefix: string;
    authHook: AuthHook;
    uploads: Uploads;
    /**
     * "all": a failed result carries every ingest code (the web app's mount,
     * /app/uploads). "public", the default: only "duplicate", as the Public
     * API v1 document says (publicResult).
     */
    resultCodes?: "all" | "public";
    /**
     * Who is creating an upload, for the cap on unfinished uploads each may
     * hold (Uploads.reserve): app.ts gives session:<id> on /app/uploads and
     * token:<id> on /api/v1/uploads. Undefined, or left out, means no cap of
     * its own, though the upload still counts toward the total.
     */
    principalOf?: (request: FastifyRequest) => string | undefined;
    /**
     * The user behind a creation, as the log names them when uploads are
     * refused for want of room: app.ts gives user "<subject>" for a session
     * and token <id> made by user "<subject>" for an API token, never a
     * cookie or a token. Kept in the info file beside principalOf's key.
     */
    holderOf?: (request: FastifyRequest) => string | undefined;
  },
): Promise<void> {
  const { authHook, uploads } = opts;
  // onUploadCreate gets the Web Request tusRequest made, not the Fastify one
  // the auth hook marked, so the POST route hands the sender over by it, and
  // takes back the reservation to release once tus has answered.
  const creations = new WeakMap<
    Request,
    { owner: string | undefined; holder: string | undefined; release?: () => void }
  >();
  const allCodes = opts.resultCodes === "all";
  const prefix = opts.prefix.replace(/\/+$/, "");

  const shared = {
    path: prefix,
    locker: uploads.locker,
    maxSize: MAX_UPLOAD_BYTES,
    relativeLocation: true,
    respectForwardedHeaders: false,
    allowedOrigins: () => false,
  };
  // HEAD is answered from HeadStore, under the same lock (HeadStore).
  const tusHead = new Server({
    ...shared,
    datastore: new HeadStore({
      directory: uploads.dir,
      configstore: uploads.datastore.configstore,
    }),
  });
  const tus = new Server({
    ...shared,
    datastore: uploads.datastore,
    namingFunction: () => uuidv7(),
    onUploadCreate: async (req, upload: Upload) => {
      const creation = creations.get(req);
      // Only the POST route below calls tus to create an upload.
      if (creation === undefined) throw new Error("an upload creation came without its route");
      try {
        parseUploadMetadata(upload.metadata);
        // Upload-Length is required (the POST route), so size is set.
        creation.release = await uploads.reserve(upload.size ?? 0, creation.owner, creation.holder);
      } catch (error) {
        if (error instanceof UploadRefused) throw new TusAnswer(error.status, error.message);
        throw error;
      }
      // Written into the info file by tus's store.create, beside its own fields.
      if (creation.owner !== undefined) (upload as UploadInfo).owner = creation.owner;
      if (creation.holder !== undefined) (upload as UploadInfo).holder = creation.holder;
      return {};
    },
    onUploadFinish: async (_req, upload: Upload) => {
      const { originalName, target, duplicates } = parseUploadMetadata(upload.metadata);
      try {
        await uploads.queue.enqueue(upload.id, {
          tmpPath: join(uploads.dir, upload.id),
          originalName,
          target,
          duplicates,
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

  // tus emits POST_CREATE once store.create has written the upload's data
  // and info files, with the same Request onUploadCreate got. From then on
  // the folder counts the upload, so its reservation is given back there:
  // held to the end of the POST, a creation that carries its bytes would
  // count twice while they arrive. The POST route's finally gives it back
  // when creation fails; giving it back twice is harmless.
  tus.on(EVENTS.POST_CREATE, (req: Request) => {
    creations.get(req)?.release?.();
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
        // An empty upload would finish at creation and leave its info file
        // for a day, outside the count of unfinished uploads.
        if (request.headers["upload-length"] === "0") {
          releaseUnreadBody(request, reply);
          return reply.code(400).header("tus-resumable", "1.0.0").send(`${EMPTY_UPLOAD_MESSAGE}\n`);
        }
        const webRequest = tusRequest(request, prefix);
        const creation: {
          owner: string | undefined;
          holder: string | undefined;
          release?: () => void;
        } = {
          owner: opts.principalOf?.(request),
          holder: opts.holderOf?.(request),
        };
        creations.set(webRequest, creation);
        let response: Response;
        try {
          response = await tus.handleWeb(webRequest);
        } finally {
          // Normally given back at POST_CREATE; refused or failed, it holds nothing.
          creation.release?.();
        }
        releaseUnreadBody(request, reply);
        return sendTusResponse(reply, response);
      });

      const forwardToId =
        (server: Server) => async (request: FastifyRequest, reply: FastifyReply) => {
          const id = uploadId(request);
          if (id === undefined) return reply.code(404).send("Not found\n");
          const response = await server.handleWeb(tusRequest(request, `${prefix}/${id}`));
          releaseUnreadBody(request, reply);
          return sendTusResponse(reply, response);
        };
      // An ingested upload is answered by its ingest's outcome (step 4 at the
      // top of this file, and HeadStore).
      scope.head("/:id", forwardToId(tusHead));
      scope.patch("/:id", forwardToId(tus));

      scope.get("/:id/result", async (request, reply) => {
        const id = uploadId(request);
        if (id === undefined) return reply.code(404).send({ error: "not_found" });
        let result: UploadResult | undefined;
        try {
          result = await uploads.queue.result(id);
        } catch (error) {
          // A database error (its host, its port) never reaches the client.
          request.log.warn({ err: error, uploadId: id }, "uploads: could not read the result");
          return reply
            .code(503)
            .send({ error: "unavailable", message: RESULT_UNAVAILABLE_MESSAGE });
        }
        if (result !== undefined) return reply.send(allCodes ? result : publicResult(result));
        // Nothing queued: still uploading, or every byte arrived and the
        // ingest was never queued, which is queued now.
        let answer: Awaited<ReturnType<typeof queueIfFinished>>;
        try {
          answer = await queueIfFinished(uploads, id);
        } catch (error) {
          request.log.warn(
            { err: error, uploadId: id },
            "uploads: could not queue a finished upload",
          );
          return reply
            .code(503)
            .send({ error: "unavailable", message: RESULT_UNAVAILABLE_MESSAGE });
        }
        if (answer === "pending") return reply.send({ status: "pending" } satisfies UploadResult);
        if (answer === "unparsable") {
          request.log.warn(
            { uploadId: id },
            "uploads: a finished upload was not queued, as its metadata no longer parses",
          );
        }
        return reply.code(404).send({ error: "not_found" });
      });
    },
    { prefix },
  );
}
