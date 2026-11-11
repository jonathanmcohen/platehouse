// OpenSCAD renders and STEP meshes in the app (build plan Task 13; AC-050,
// AC-052, AC-053). A .scad file gets an STL and a PNG preview, a STEP file a
// GLB mesh, all made by the slicer container (scad.ts, step.ts, client.ts)
// and stored as new blobs. Ingest never calls the slicer: once a .scad or
// STEP file's row commits, ingest's afterCommit (afterUpload here) sends a
// job to Task 8's singleton slicer queue, and runJob does the work there.
//
// The jobs are kinds on the slicer queue (DERIVED_KINDS): the queue's one
// worker hands each to its handler from derivedJobHandlers, beside Task 12's
// "slice" handler, so there is never a second worker on that queue.
//
// Retries (Tasks 12 and 13): every job is sent with SLICER_RETRY. When the
// slicer answers 409 busy or the connection is lost, runJob throws and
// pg-boss runs the job again with backoff; there is no retry loop here. On
// the last attempt runJob records slicer_error instead (DERIVED_MESSAGES)
// and the job completes, so the file does not wait on a render forever (a
// last attempt that dies first is settled by the render check below). The
// slicer message is kept for the slicer's own failures: any other error on
// the last attempt (a database error, a bug) is rethrown with nothing
// recorded, and the render check settles the file. A render or conversion
// error is the program's own answer: it is never retried, the source is
// kept, and the program's message goes into files.derived_message exactly as
// written (a replacement's after a sentence saying the replacement was
// rejected and the previous version kept). It is text, for the page to show
// as text, never HTML.
//
// A slicer that cannot render right now uses no retry (SlicerDown): one
// that takes no connection at all (stopped, restarting or being re-pulled,
// so it never saw the file), or one that answers that OpenSCAD renders are
// off because its sandbox self-test failed. Neither says anything about the
// file, so the job records nothing: it sends the same job again to start
// after a wait (retryDelay doubled on each wait, at most
// SLICER_DOWN_MAX_WAIT_SECONDS) and completes. The file stays 'pending', a
// replacement keeps the previous version until it renders, and the new job
// keeps the retries the old one had left, so a file that crashes the slicer
// (a connection lost mid-render) still runs out of retries and cannot loop
// through the restarts it causes. The wait has a limit, SLICER_DOWN_LIMIT_MS
// (2 hours), counted from the job's first SlicerDown answer. The deadline
// travels in the job's data (waitDeadline), so it holds across a restart.
// The first SlicerDown answer after it ends the render as any other final
// failure does: the file is marked failed with DERIVED_MESSAGES.slicerDown
// (replaceSlicerDown for a replacement, whose staged source is discarded
// and whose previous version is kept), no job is sent, and no retry is
// used. The job reads the deadline only when it runs, so the render ends on
// its first run after the deadline: one wait (at most 15 minutes) past it
// when the slicer queue is otherwise empty, and later when other jobs are
// queued ahead of it, since the queue runs one job at a time.
//
// A store that cannot be reached (StoreUnavailable, reading the source or
// storing the renders) is handled the same way, as Task 12 handles it: it
// says nothing about the file or the slicer, so the job uses no retry and
// waits for the store, on the same waits and the same deadline. Past the
// deadline the file is marked failed with DERIVED_MESSAGES.storeDown
// (replaceStoreDown for a replacement), never with a message that blames
// the slicer.
//
// A store that answers and refuses (StoreError: an HTTP 500, AccessDenied,
// NoSuchBucket, a body that failed with no network code) or a source object
// that is gone (BlobNotFound) is not an outage and not the slicer's doing
// either (issue #102), wherever it comes from: reading the source, a STEP
// body sent to the slicer, or storing the renders. The file is marked failed
// with DERIVED_MESSAGES.storeRefused (replaceStoreRefused for a replacement,
// whose staged source is discarded and whose previous version is kept). A
// 5xx, a failure with no HTTP status, or a throttled or timed-out request
// (408, 429, SlowDown, RequestTimeout) may pass, so it is left to pg-boss's
// retries and recorded on the last attempt; any other 4xx refusal or a
// missing object will not pass on a retry, so it is recorded on the attempt
// that meets it.
//
// Replacing a file (replaceFile) stores the new source as a blob of its own,
// next to the file's current one, and queues a job for it. The staged
// source's row, the file marked pending, and its job are written in one
// transaction, so a crash while staging cannot leave a staged row, or a file
// pending, with no job. Only when that job has stored the new renders does
// one transaction point the file at the new source and renders and delete
// the old rows; the old objects are deleted after that commit. So a failure
// at any point before it (a store outage, a slicer that stays away) leaves
// the previous version whole: its source, its renders and its rows. That
// holds for a replacement that OpenSCAD or the STEP converter rejects too:
// no new render is stored, so nothing is swapped in. The file keeps its
// previous source and renders, shows the program's message after
// DERIVED_MESSAGES.replaceRejectedScad or replaceRejectedStep, and the staged
// source is discarded. An object left with no row by a crash between steps
// is removed by the orphan sweep (ingest/orphans.ts). A replacement over the
// renderer's limit (a .scad over 1 MiB, a STEP file over 256 MiB) is
// refused by replaceFile before anything is stored, since it could never
// render.
//
// The render check (checkRenders, issues #90 and #91) repairs what a job or
// an upload that died part way leaves behind. It is a maintenance-queue job
// (CHECK_RENDERS_CRON, every 15 minutes; Task 30 registers the schedule),
// and it acts only on rows written more than RENDER_CHECK_GRACE_MS ago,
// twice a render job's 15-minute expiry. Each step re-checks, holding the
// row's lock, that no queued or active job owns what it changes:
// - If the database fails right after ingest commits, afterUpload cannot
//   queue the job or record queueFailed, and the .scad or STEP file is left
//   with derived_status null and no job. The check queues it.
// - If a job's last attempt ends before it records its outcome (the process
//   dies, pg-boss expires the job, or commitSlicerError's transaction fails
//   during a Postgres restart), pg-boss marks the job failed and the file
//   stays 'pending'. The check marks it failed ("The render did not
//   finish.") and does not queue it again, so a file that kills the slicer
//   cannot loop.
// - For a replacement in that case, the staged source's row (kind 'source',
//   state 'stored') and its object are left with no file pointing at them,
//   and the orphan sweep skips an object that has a row. The check deletes
//   them, object first, then row, so a run that fails part way is finished
//   by the next one.
//
// derived_status is 'pending' while a job is queued or running, then 'ok' or
// 'failed'; it stays null for kinds with nothing derived (.3mf, .stl). A job
// that finishes while a newer replacement of the file is still queued leaves
// the file 'pending' (newerQueued), so the file never reads as done, or as
// failed, before its last upload has rendered.
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { LIMITS } from "@platehouse/slicer-contract";
import { CompiledQuery, type Kysely, sql, type Transaction } from "kysely";
import type { PgBoss } from "pg-boss";
import { isUuid, uuidv7 } from "../db/ids.js";
import type { Blob, DB, FileKind, ModelFile } from "../db/types.js";
import { detectKind } from "../ingest/detect.js";
import {
  CONTENT_TYPES,
  readFirstBytes,
  STORAGE_UNAVAILABLE_MESSAGE,
  type StoredFile,
} from "../ingest/ingest.js";
import { QUEUE, SLICER_RETRY, type SlicerJobHandlers } from "../jobs/queues.js";
import { createRepos } from "../repos/index.js";
import { blobKey } from "../storage/keys.js";
import { BlobNotFound, type BlobStore, StoreError, StoreUnavailable } from "../storage/s3.js";
import {
  DERIVED_MESSAGES,
  isRetryable,
  RENDER_TIMEOUT_MS,
  RENDER_UPLOAD_TIMEOUT_MS,
  RenderFailed,
  type RenderOutput,
  SlicerDown,
  SlicerFault,
  type SlicerTarget,
} from "./client.js";
import { renderScadOutputs } from "./scad.js";
import { convertStepOutputs } from "./step.js";

export { DERIVED_MESSAGES } from "./client.js";

/** files.derived_status values. */
export type DerivedStatus = "pending" | "ok" | "failed";

/**
 * Task 13's job kinds on the slicer queue. The queue's one worker hands each
 * job to its kind's handler (slicerJobs in jobs/queues.ts); derivedJobHandlers
 * gives these two, beside Task 12's "slice".
 */
export const DERIVED_KINDS = {
  renderScad: "render-scad",
  convertStep: "convert-step",
} as const;

export type DerivedKind = (typeof DERIVED_KINDS)[keyof typeof DERIVED_KINDS];

/** pg-boss job states in which a job still owns its file and source: queued or running. */
const LIVE_STATES: ReadonlySet<string> = new Set(["created", "retry", "active"]);

/** A slicer queue job that makes a file's derived blobs; its kind picks the handler. */
export interface DerivedJob {
  kind: DerivedKind;
  fileId: string;
  /** The source blob to render: the file's own, or a replacement not yet swapped in. */
  sourceBlobId: string;
  /** How many times the job has been sent again to wait for a slicer or store that was down; 0 when left out. */
  waits?: number;
  /**
   * When the job stops waiting for a slicer or a store that is down: an ISO
   * time, SLICER_DOWN_LIMIT_MS after the job's first SlicerDown or
   * StoreUnavailable, carried by each job sent to wait. Left out until then.
   */
  waitDeadline?: string;
}

/** What a job ends with, kept by pg-boss as its output. */
export interface DerivedOutcome {
  /**
   * requeued: the slicer (slicer_down) or the store (store_down) was down,
   * and the same job was sent again to wait for it. failed with slicer_down
   * or store_down: it stayed down past SLICER_DOWN_LIMIT_MS, and the job
   * stopped waiting. failed with store_refused: the store answered and
   * refused, or the source object is gone (issue #102).
   */
  status: "ok" | "failed" | "skipped" | "requeued";
  reason?:
    | "render_failed"
    | "slicer_error"
    | "stale"
    | "slicer_down"
    | "store_down"
    | "store_refused";
}

export type DerivedErrorCode =
  | "not_found"
  | "not_derivable"
  | "wrong_type"
  | "too_large"
  | "storage_unavailable";

/** A call refused with a plain message for Jon. */
export class DerivedError extends Error {
  readonly code: DerivedErrorCode;

  constructor(code: DerivedErrorCode, message: string) {
    super(message);
    this.name = "DerivedError";
    this.code = code;
  }
}

const NOT_FOUND_MESSAGE = "That file does not exist or its model is in the trash";
const NOT_DERIVABLE_MESSAGE = "Only .scad and STEP files have renders";
const WRONG_TYPE_MESSAGE: Readonly<Record<"scad" | "step", string>> = {
  scad: "The replacement is not a .scad file; nothing was saved",
  step: "The replacement is not a STEP file; nothing was saved",
};
const TOO_LARGE_MESSAGE: Readonly<Record<"scad" | "step", string>> = {
  scad: "The replacement is larger than the 1 MiB the renderer takes; nothing was saved",
  step: "The replacement is larger than the 256 MiB the converter takes; nothing was saved",
};
/** The renderer's limit for each kind's source (the contract's, which scad.ts and step.ts enforce). */
const BODY_LIMIT: Readonly<Record<"scad" | "step", number>> = {
  scad: LIMITS.scadBodyBytes,
  step: LIMITS.stepBodyBytes,
};

export type DerivedStore = Pick<BlobStore, "putBlob" | "getBlobStream" | "deleteBlobs">;

export interface DerivedDeps {
  db: Kysely<DB>;
  store: DerivedStore;
  /** SLICER_URL. */
  slicerUrl: string;
  /** Sends the jobs, and finds a file's queued ones; the started pg-boss. */
  queue: Pick<PgBoss, "send" | "findJobs">;
  /** Seconds before the first retry; SLICER_RETRY's when left out. */
  retryDelaySeconds?: number;
  /** A render request's wait for its answer once sent; RENDER_TIMEOUT_MS when left out. */
  requestTimeoutMs?: number;
  /** The time a streamed body may take to send; RENDER_UPLOAD_TIMEOUT_MS when left out. */
  uploadTimeoutMs?: number;
  /** The clock the slicer-down deadline is set and read by; the system clock when left out. */
  now?: () => Date;
}

/**
 * How long a render job may run before pg-boss expires it: pg-boss's default
 * of 15 minutes, since neither the slicer queue (jobs/queues.ts) nor a render
 * job sets its own. A job that is still 'active' past this is failed, or
 * retried, by pg-boss itself.
 */
const RENDER_JOB_EXPIRY_MS = 15 * 60 * 1000;

/**
 * How long the render check (checkRenders) leaves a file or a staged source
 * alone after it was written: twice a render job's expiry, so a job that
 * died while active has been expired by pg-boss, and an upload's own
 * afterUpload has long since had its turn, before the check looks at it.
 */
export const RENDER_CHECK_GRACE_MS = 2 * RENDER_JOB_EXPIRY_MS;

/**
 * The render check's suggested cadence on the maintenance queue: every 15
 * minutes. Task 30 registers the schedule; checkRenders(now) is its handler.
 */
export const CHECK_RENDERS_CRON = "*/15 * * * *";

/**
 * The longest a render job waits for a slicer that is down before it asks
 * again: 15 minutes. The waits start at the retry delay and double.
 */
export const SLICER_DOWN_MAX_WAIT_SECONDS = 15 * 60;

/**
 * How long a render job waits for a slicer or a store that is down, from its
 * first SlicerDown or StoreUnavailable, before the render ends failed: 2 hours.
 */
export const SLICER_DOWN_LIMIT_MS = 2 * 60 * 60 * 1000;

/** What one run of the render check did. */
export interface RenderCheckResult {
  /** .scad and STEP files that had no status and no job, now queued (issue #91). */
  queued: string[];
  /** Pending files whose last job ended failed with no outcome, now failed (issue #90). */
  failed: string[];
  /** Staged replacement sources no file and no live job named, now deleted (issue #90). */
  discarded: string[];
}

/** The kinds that have derived blobs. */
export function hasDerived(kind: FileKind): kind is "scad" | "step" {
  return kind === "scad" || kind === "step";
}

const JOB_KIND_OF: Readonly<Record<"scad" | "step", DerivedKind>> = {
  scad: DERIVED_KINDS.renderScad,
  step: DERIVED_KINDS.convertStep,
};

/** The file columns that point at each kind's derived blobs. */
type DerivedColumn = "renderStlBlobId" | "renderPngBlobId" | "meshBlobId";

const COLUMN_OF: Readonly<Record<RenderOutput["kind"], DerivedColumn>> = {
  render_stl: "renderStlBlobId",
  render_png: "renderPngBlobId",
  mesh_glb: "meshBlobId",
};

const COLUMNS_OF_KIND: Readonly<Record<DerivedKind, readonly DerivedColumn[]>> = {
  [DERIVED_KINDS.renderScad]: ["renderStlBlobId", "renderPngBlobId"],
  [DERIVED_KINDS.convertStep]: ["meshBlobId"],
};

/** What a job waits out without using a retry: a slicer or a store that is down. */
type Outage = "slicer" | "store";

/** Each outage's outcome reason, and the messages a render shows once it stops waiting. */
const OUTAGES: Readonly<
  Record<Outage, { reason: "slicer_down" | "store_down"; message: string; replaceMessage: string }>
> = {
  slicer: {
    reason: "slicer_down",
    message: DERIVED_MESSAGES.slicerDown,
    replaceMessage: DERIVED_MESSAGES.replaceSlicerDown,
  },
  store: {
    reason: "store_down",
    message: DERIVED_MESSAGES.storeDown,
    replaceMessage: DERIVED_MESSAGES.replaceStoreDown,
  },
};

/** The outage an error is, or null: a SlicerDown answer or an unreachable store. */
function outageOf(error: unknown): Outage | null {
  if (error instanceof SlicerDown) return "slicer";
  if (error instanceof StoreUnavailable) return "store";
  return null;
}

/**
 * 4xx answers that a store gives for a request it may take on a retry:
 * 408 Request Timeout and 429 Too Many Requests, which several S3-compatible
 * stores send in place of a 503 when they throttle.
 */
const TRANSIENT_STORE_STATUS: ReadonlySet<number> = new Set([408, 429]);

/**
 * S3 error codes for the same, whatever status carries them: SlowDown
 * (throttling) and RequestTimeout (S3's 400 for an upload that was too slow).
 */
const TRANSIENT_STORE_CODES: ReadonlySet<string> = new Set(["SlowDown", "RequestTimeout"]);

/**
 * Whether an error is a store that answered and refused, or a source object
 * that is gone (issue #102), and if so whether a pg-boss retry may cure it:
 * "retry" for a 5xx, a failure with no HTTP status (a body that broke with
 * no network code, a failed size check), or a throttled or timed-out request
 * (408, 429, SlowDown, RequestTimeout); "final" for any other 4xx refusal
 * (AccessDenied, NoSuchBucket) or a missing object. null for anything else.
 * An unreachable store is StoreUnavailable, an outage, and never lands here.
 */
export function storeRefusalOf(error: unknown): "retry" | "final" | null {
  if (error instanceof BlobNotFound) return "final";
  if (error instanceof StoreError) {
    if (error.status === undefined || error.status >= 500) return "retry";
    if (TRANSIENT_STORE_STATUS.has(error.status) || TRANSIENT_STORE_CODES.has(error.code)) {
      return "retry";
    }
    return "final";
  }
  return null;
}

/** The job's view of the file changed under it: a newer source landed, or the file or model went. */
class Superseded extends Error {
  constructor() {
    super("The file changed while its render ran");
    this.name = "Superseded";
  }
}

interface PutOutput {
  id: string;
  key: string;
  kind: RenderOutput["kind"];
  contentType: string;
  size: number;
  sha256: Buffer;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * pg-boss's db option over a Kysely transaction, so a job is sent, or a
 * file's jobs are read, inside that transaction. Without plugins, so the
 * CamelCasePlugin leaves pg-boss's own SQL and rows alone.
 */
function bossDb(trx: Transaction<DB>) {
  const raw = trx.withoutPlugins();
  return {
    async executeSql(text: string, values: unknown[] = []) {
      const result = await raw.executeQuery(CompiledQuery.raw(text, values));
      return { rows: result.rows as unknown[] };
    },
  };
}

export function createDerived(deps: DerivedDeps) {
  const { db, store } = deps;
  const repos = createRepos(db);
  const target: SlicerTarget = {
    baseUrl: deps.slicerUrl,
    timeoutMs: deps.requestTimeoutMs ?? RENDER_TIMEOUT_MS,
    uploadTimeoutMs: deps.uploadTimeoutMs ?? RENDER_UPLOAD_TIMEOUT_MS,
  };
  const retry = {
    ...SLICER_RETRY,
    ...(deps.retryDelaySeconds === undefined ? {} : { retryDelay: deps.retryDelaySeconds }),
  };
  const clock = deps.now ?? (() => new Date());

  async function setStatus(
    fileId: string,
    status: DerivedStatus,
    message: string | null,
  ): Promise<void> {
    await db
      .updateTable("files")
      .set({ derivedStatus: status, derivedMessage: message, updatedAt: sql<Date>`now()` })
      .where("id", "=", fileId)
      .execute();
  }

  /** Deletes objects, best effort: one left behind has no row, and the orphan sweep removes it. */
  async function deleteQuietly(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    try {
      await store.deleteBlobs(keys);
    } catch (error) {
      console.error(
        `derived: ${keys.length} object(s) left for the orphan sweep: ${describe(error)}`,
      );
    }
  }

  /**
   * Removes a staged replacement source: its row, if no file points at it,
   * and then its object.
   */
  async function discardStaged(blobId: string): Promise<void> {
    const { rows } = await sql<{ key: string }>`
      delete from blobs b
       where b.id = ${blobId}
         and b.kind = 'source'
         and not exists (
           select 1 from files f
            where f.blob_id = b.id or f.render_stl_blob_id = b.id
               or f.render_png_blob_id = b.id or f.mesh_blob_id = b.id)
      returning b.key
    `.execute(db);
    await deleteQuietly(rows.map((r) => r.key));
  }

  /**
   * Queues a render or mesh of the file's current source and marks it
   * pending. The status and the job are written in one transaction, so a
   * crash cannot leave the file pending with no job.
   */
  async function queueFor(fileId: string, kind: "scad" | "step"): Promise<string> {
    const file = isUuid(fileId) ? await repos.files.get(fileId) : undefined;
    if (file === undefined || (await repos.models.get(file.modelId)) === undefined) {
      throw new DerivedError("not_found", NOT_FOUND_MESSAGE);
    }
    if (file.kind !== kind) throw new DerivedError("not_derivable", NOT_DERIVABLE_MESSAGE);
    const job: DerivedJob = { kind: JOB_KIND_OF[kind], fileId: file.id, sourceBlobId: file.blobId };
    try {
      return await db.transaction().execute(async (trx) => {
        await trx
          .updateTable("files")
          .set({ derivedStatus: "pending", derivedMessage: null, updatedAt: sql<Date>`now()` })
          .where("id", "=", file.id)
          .execute();
        const id = await deps.queue.send(QUEUE.slicer, job, { ...retry, db: bossDb(trx) });
        if (id === null) throw new Error("pg-boss created no job");
        return id;
      });
    } catch (error) {
      // The queueing error is the one rethrown. If the database is what
      // failed, this write fails too and the file keeps derived_status null
      // with no job; the render check (checkRenders) queues it later.
      await setStatus(file.id, "failed", DERIVED_MESSAGES.queueFailed).catch((statusError) => {
        console.error(
          `derived: file ${file.id} left for the render check: ${describe(statusError)}`,
        );
      });
      throw error;
    }
  }

  /** Queues the OpenSCAD render (STL and PNG) of a .scad file; returns the job id. */
  function renderScad(fileId: string): Promise<string> {
    return queueFor(fileId, "scad");
  }

  /** Queues the GLB mesh of a STEP file; returns the job id. */
  function convertStep(fileId: string): Promise<string> {
    return queueFor(fileId, "step");
  }

  /**
   * Ingest's afterCommit: queues the render of a .scad or the mesh of a STEP
   * file whose row has committed. It never throws: the upload is stored
   * whatever happens here, and a job that cannot be queued leaves the file
   * failed with DERIVED_MESSAGES.queueFailed, or, when the database cannot
   * take even that, with derived_status null for the render check to queue.
   */
  async function afterUpload(stored: StoredFile): Promise<void> {
    if (!hasDerived(stored.kind)) return;
    try {
      await queueFor(stored.fileId, stored.kind);
    } catch (error) {
      console.error(`derived: could not queue file ${stored.fileId}: ${describe(error)}`);
    }
  }

  /**
   * Replaces a .scad or STEP file's source with the file at tmpPath, which
   * must be of the same kind and within the renderer's limit, and queues its
   * render. The file keeps its previous source and renders until the new
   * renders are stored (runJob). The file at tmpPath is left for its owner
   * to delete.
   */
  async function replaceFile(
    fileId: string,
    tmpPath: string,
  ): Promise<{ fileId: string; sourceBlobId: string }> {
    const file = isUuid(fileId) ? await repos.files.get(fileId) : undefined;
    if (file === undefined || (await repos.models.get(file.modelId)) === undefined) {
      throw new DerivedError("not_found", NOT_FOUND_MESSAGE);
    }
    const kind = file.kind;
    if (!hasDerived(kind)) throw new DerivedError("not_derivable", NOT_DERIVABLE_MESSAGE);
    const { size } = await stat(tmpPath);
    if (detectKind(file.originalName, await readFirstBytes(tmpPath), size) !== kind) {
      throw new DerivedError("wrong_type", WRONG_TYPE_MESSAGE[kind]);
    }
    // One the renderer would refuse could never render, so it is refused
    // here, before anything is stored.
    if (size > BODY_LIMIT[kind]) throw new DerivedError("too_large", TOO_LARGE_MESSAGE[kind]);

    const blobId = uuidv7();
    const key = blobKey(file.modelId, blobId);
    const contentType = CONTENT_TYPES[kind];
    let stored: { sha256: Buffer; size: number };
    try {
      stored = await store.putBlob(createReadStream(tmpPath), { key, size, contentType });
    } catch (error) {
      if (error instanceof StoreUnavailable) {
        throw new DerivedError("storage_unavailable", STORAGE_UNAVAILABLE_MESSAGE);
      }
      throw error;
    }

    // The staged source's row, the file marked pending, and its job, in one
    // transaction.
    const stage = async (trx: Transaction<DB>): Promise<void> => {
      const live = await trx
        .selectFrom("models")
        .select("id")
        .where("id", "=", file.modelId)
        .where("trashedAt", "is", null)
        .where("purgeStartedAt", "is", null)
        .forShare()
        .executeTakeFirst();
      if (live === undefined) throw new DerivedError("not_found", NOT_FOUND_MESSAGE);
      const r = createRepos(trx);
      await r.blobs.insertPending({
        id: blobId,
        modelId: file.modelId,
        kind: "source",
        contentType,
        size,
      });
      await r.blobs.markStored(blobId, stored);
      await trx
        .updateTable("files")
        .set({ derivedStatus: "pending", derivedMessage: null, updatedAt: sql<Date>`now()` })
        .where("id", "=", file.id)
        .execute();
      const job: DerivedJob = { kind: JOB_KIND_OF[kind], fileId: file.id, sourceBlobId: blobId };
      const id = await deps.queue.send(QUEUE.slicer, job, { ...retry, db: bossDb(trx) });
      if (id === null) throw new Error("pg-boss created no job");
    };

    // Set when the transaction's own work threw, so it rolled back and
    // nothing in it committed.
    let rolledBack = false;
    try {
      await db.transaction().execute(async (trx) => {
        try {
          await stage(trx);
        } catch (error) {
          rolledBack = true;
          throw error;
        }
      });
    } catch (error) {
      // Refused or failed inside the transaction, so nothing committed and
      // the object can go. A failed commit may have committed: the object is
      // kept, and if no row points at it the orphan sweep removes it.
      if (rolledBack) await deleteQuietly([key]);
      throw error;
    }
    return { fileId: file.id, sourceBlobId: blobId };
  }

  /** The source's whole bytes; a .scad is at most 1 MiB by the time this runs. */
  async function readAll(key: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of await store.getBlobStream(key)) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  /**
   * The file row, locked, once the job is known to still apply to it. The
   * model row is locked first, the order a purge takes them in, so the two
   * never deadlock; a model whose purge has begun takes no new rows.
   */
  async function lockFor(
    trx: Transaction<DB>,
    file: ModelFile,
    source: Blob,
    replacing: boolean,
  ): Promise<ModelFile> {
    const open = await trx
      .selectFrom("models")
      .select("id")
      .where("id", "=", file.modelId)
      .where("purgeStartedAt", "is", null)
      .forShare()
      .executeTakeFirst();
    if (open === undefined) throw new Superseded();
    const row = await trx
      .selectFrom("files")
      .selectAll()
      .where("id", "=", file.id)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) throw new Superseded();
    // The source the job started from is still the file's, or, for a
    // replacement, the file still has the source it had then and the staged
    // one is still there.
    if (row.blobId !== (replacing ? file.blobId : source.id)) throw new Superseded();
    if (replacing) {
      const staged = await trx
        .selectFrom("blobs")
        .select("id")
        .where("id", "=", source.id)
        .forUpdate()
        .executeTakeFirst();
      if (staged === undefined) throw new Superseded();
    }
    return row;
  }

  /**
   * Whether a job queued for the file will render a source newer than
   * sourceId: a replacement staged after it. Read in trx once the file row
   * is locked, so a replaceFile that commits later sets 'pending' itself
   * after this job's write, and one that committed earlier is seen here
   * (replaceFile writes the staged row and its job in one transaction). The
   * slicer queue runs one job at a time, so any other job for the file is
   * queued, not running.
   */
  async function newerQueued(
    trx: Transaction<DB>,
    fileId: string,
    sourceId: string,
  ): Promise<boolean> {
    const queued = await deps.queue.findJobs<DerivedJob>(QUEUE.slicer, {
      data: { fileId },
      queued: true,
      db: bossDb(trx),
    });
    const others = queued
      .map((j) => j.data?.sourceBlobId)
      .filter((id): id is string => typeof id === "string" && id !== sourceId && isUuid(id));
    if (others.length === 0) return false;
    const { rows } = await sql<{ newer: boolean }>`
      select exists (
        select 1 from blobs s, blobs mine
         where mine.id = ${sourceId}
           and s.id in (${sql.join(others)})
           and s.kind = 'source' and s.state = 'stored'
           and s.created_at > mine.created_at
      ) as newer
    `.execute(trx);
    return rows[0]?.newer ?? false;
  }

  /** outcome, or 'pending' with no message while a newer replacement is queued. */
  async function settledOutcome(
    trx: Transaction<DB>,
    fileId: string,
    sourceId: string,
    outcome: { status: DerivedStatus; message: string | null },
  ): Promise<{ status: DerivedStatus; message: string | null }> {
    return (await newerQueued(trx, fileId, sourceId))
      ? { status: "pending", message: null }
      : outcome;
  }

  /**
   * Points the file at a replacement source (when replacing) and at new
   * derived blobs for the job kind, deletes the rows of the blobs that
   * replaces, and returns their keys for deleting after the commit.
   */
  async function swapIn(
    trx: Transaction<DB>,
    row: ModelFile,
    jobKind: DerivedKind,
    source: Blob,
    replacing: boolean,
    outputs: readonly PutOutput[],
    outcome: { status: DerivedStatus; message: string | null },
  ): Promise<string[]> {
    const r = createRepos(trx);
    for (const out of outputs) {
      await r.blobs.insertPending({
        id: out.id,
        modelId: row.modelId,
        kind: out.kind,
        contentType: out.contentType,
        size: out.size,
      });
      await r.blobs.markStored(out.id, { size: out.size, sha256: out.sha256 });
    }
    const columns = COLUMNS_OF_KIND[jobKind];
    const old = columns.map((c) => row[c]).filter((id): id is string => id !== null);
    if (replacing) old.push(row.blobId);
    const derived: Partial<Record<DerivedColumn, string | null>> = {};
    for (const c of columns) derived[c] = null;
    for (const out of outputs) derived[COLUMN_OF[out.kind]] = out.id;

    await trx
      .updateTable("files")
      .set({
        ...derived,
        ...(replacing
          ? { blobId: source.id, size: source.size ?? 0, sha256: source.sha256 ?? Buffer.alloc(0) }
          : {}),
        derivedStatus: outcome.status,
        derivedMessage: outcome.message,
        updatedAt: sql<Date>`now()`,
      })
      .where("id", "=", row.id)
      .execute();
    if (old.length === 0) return [];
    const deleted = await trx.deleteFrom("blobs").where("id", "in", old).returning("key").execute();
    return deleted.map((d) => d.key);
  }

  /** Stores new derived blobs and swaps them in; the old ones go after the commit. */
  async function commitOutputs(
    jobKind: DerivedKind,
    file: ModelFile,
    source: Blob,
    replacing: boolean,
    outputs: readonly RenderOutput[],
  ): Promise<void> {
    const put: PutOutput[] = [];
    try {
      for (const out of outputs) {
        const id = uuidv7();
        const key = blobKey(file.modelId, id);
        const stored = await store.putBlob(Readable.from([out.bytes]), {
          key,
          size: out.bytes.length,
          contentType: out.contentType,
        });
        put.push({ id, key, kind: out.kind, contentType: out.contentType, ...stored });
      }
    } catch (error) {
      // No row points at these yet.
      await deleteQuietly(put.map((p) => p.key));
      throw error;
    }

    let oldKeys: string[] = [];
    try {
      await db.transaction().execute(async (trx) => {
        const row = await lockFor(trx, file, source, replacing);
        const outcome = await settledOutcome(trx, file.id, source.id, {
          status: "ok",
          message: null,
        });
        oldKeys = await swapIn(trx, row, jobKind, source, replacing, put, outcome);
      });
    } catch (error) {
      // Superseded is decided inside the transaction, before any write, so
      // nothing committed. Any other error may have committed: the objects
      // are kept, and the orphan sweep removes any that no row points at.
      if (error instanceof Superseded) await deleteQuietly(put.map((p) => p.key));
      throw error;
    }
    await deleteQuietly(oldKeys);
  }

  /**
   * Records a render or conversion error with the program's message. A
   * replacement is never swapped in: no new render was stored, so the file
   * keeps its previous source and renders (build plan Task 13), and the
   * staged source is discarded after the commit. Its message starts with a
   * sentence saying so (replaceRejectedScad or replaceRejectedStep), since
   * the program's words are about a source the file no longer has.
   */
  async function commitRenderError(
    file: ModelFile,
    source: Blob,
    replacing: boolean,
    programMessage: string,
  ): Promise<void> {
    const message = replacing
      ? `${file.kind === "scad" ? DERIVED_MESSAGES.replaceRejectedScad : DERIVED_MESSAGES.replaceRejectedStep} ${programMessage}`
      : programMessage;
    await db.transaction().execute(async (trx) => {
      const row = await lockFor(trx, file, source, replacing);
      const outcome = await settledOutcome(trx, file.id, source.id, { status: "failed", message });
      await trx
        .updateTable("files")
        .set({
          derivedStatus: outcome.status,
          derivedMessage: outcome.message,
          updatedAt: sql<Date>`now()`,
        })
        .where("id", "=", row.id)
        .execute();
    });
    if (replacing) await discardStaged(source.id);
  }

  /**
   * Records a final failure that is the slicer's or the store's, not the
   * file's (slicer_error, store_refused, or slicer_down or store_down past
   * its limit), with
   * message, while the file still has the source the job started from; a
   * replacement is dropped and the previous version kept. A file that
   * already shows 'ok' for the job's own source (renders for it committed,
   * though the job did not see the commit's answer) is left as it is.
   */
  async function commitSlicerError(
    file: ModelFile,
    source: Blob,
    replacing: boolean,
    message: string,
  ): Promise<void> {
    await db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("files")
        .select(["id", "blobId", "derivedStatus"])
        .where("id", "=", file.id)
        .where("blobId", "=", file.blobId)
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) return;
      if (row.blobId === source.id && row.derivedStatus === "ok") return;
      const outcome = await settledOutcome(trx, file.id, source.id, { status: "failed", message });
      await trx
        .updateTable("files")
        .set({
          derivedStatus: outcome.status,
          derivedMessage: outcome.message,
          updatedAt: sql<Date>`now()`,
        })
        .where("id", "=", row.id)
        .execute();
    });
    if (replacing) await discardStaged(source.id);
  }

  /** Whether staged was stored after current (compared in Postgres, to the microsecond). */
  async function newerThan(staged: string, current: string): Promise<boolean> {
    const { rows } = await sql<{ newer: boolean | null }>`
      select (select created_at from blobs where id = ${staged})
           > (select created_at from blobs where id = ${current}) as newer
    `.execute(db);
    // With the current source's row gone, any staged source is newer.
    return rows[0]?.newer ?? true;
  }

  /** The job's slicer-down deadline in ms, or undefined when it has none (or none readable). */
  function deadlineOf(job: DerivedJob): number | undefined {
    const at = job.waitDeadline === undefined ? Number.NaN : Date.parse(job.waitDeadline);
    return Number.isFinite(at) ? at : undefined;
  }

  /** Whether the job has waited for a slicer that is down past its deadline. */
  function pastDeadline(job: DerivedJob): boolean {
    const deadline = deadlineOf(job);
    return deadline !== undefined && clock().getTime() > deadline;
  }

  /**
   * Sends the job again, to start after a wait, for a slicer (SlicerDown) or
   * a store (StoreUnavailable) that was down, and returns the outcome that
   * completes this one. The new job has the retries this one had left, so a
   * wait never hands a job a fresh set, and the same deadline (set now, on
   * the first wait).
   */
  async function waitOut(
    job: DerivedJob,
    attempt: { retryCount: number; retryLimit: number },
    outage: Outage,
    error: unknown,
  ): Promise<DerivedOutcome> {
    const waits = job.waits ?? 0;
    const startAfter = Math.min(retry.retryDelay * 2 ** waits, SLICER_DOWN_MAX_WAIT_SECONDS);
    const waitDeadline = new Date(
      deadlineOf(job) ?? clock().getTime() + SLICER_DOWN_LIMIT_MS,
    ).toISOString();
    const next: DerivedJob = { ...job, waits: waits + 1, waitDeadline };
    const id = await deps.queue.send(QUEUE.slicer, next, {
      ...retry,
      retryLimit: Math.max(0, attempt.retryLimit - attempt.retryCount),
      startAfter,
    });
    if (id === null) throw new Error("pg-boss created no job");
    console.warn(
      `derived: file ${job.fileId} waits for the ${outage}, asking again in ${startAfter} s: ${describe(error)}`,
    );
    return { status: "requeued", reason: OUTAGES[outage].reason };
  }

  /**
   * Runs one render or mesh job (the slicer queue's worker calls this).
   * Throws only to have pg-boss retry: before the last attempt, on a 409
   * busy, a lost connection or a store refusal that may pass (a 5xx, or a
   * throttled or timed-out request); or on an unexpected error, on any
   * attempt, with nothing recorded (the render check settles the file if
   * the last attempt fails that way). A slicer or a store that is down
   * sends the job again instead (waitOut).
   */
  async function runJob(
    job: DerivedJob,
    attempt: { retryCount: number; retryLimit: number },
  ): Promise<DerivedOutcome> {
    const stale: DerivedOutcome = { status: "skipped", reason: "stale" };
    const kind = job.kind === DERIVED_KINDS.renderScad ? "scad" : "step";
    const file = isUuid(job.fileId) ? await repos.files.get(job.fileId) : undefined;
    const source = isUuid(job.sourceBlobId) ? await repos.blobs.get(job.sourceBlobId) : undefined;
    if (file === undefined || file.kind !== kind) return stale;
    if (
      source === undefined ||
      source.kind !== "source" ||
      source.state !== "stored" ||
      source.modelId !== file.modelId
    ) {
      return stale;
    }
    const replacing = file.blobId !== source.id;
    // A replacement older than the file's current source was overtaken by a
    // newer one that has landed already.
    if (replacing && !(await newerThan(source.id, file.blobId))) {
      await discardStaged(source.id);
      return stale;
    }

    try {
      const size = source.size ?? 0;
      const outputs =
        kind === "scad"
          ? await renderScadOutputs(target, size, () => readAll(source.key))
          : await convertStepOutputs(target, () => store.getBlobStream(source.key), size);
      await commitOutputs(job.kind, file, source, replacing, outputs);
      return { status: "ok" };
    } catch (error) {
      if (error instanceof Superseded) {
        if (replacing) await discardStaged(source.id);
        return stale;
      }
      // A slicer or a store that is down: not the file's doing and not a
      // retry. Nothing is recorded, and the previous version of a
      // replacement stays until it renders, unless the outage has lasted
      // past the job's deadline, which ends the render.
      const outage = outageOf(error);
      if (outage !== null) {
        if (!pastDeadline(job)) return waitOut(job, attempt, outage, error);
        const { reason, message, replaceMessage } = OUTAGES[outage];
        await commitSlicerError(file, source, replacing, replacing ? replaceMessage : message);
        console.error(
          `derived: file ${file.id} stopped waiting for the ${outage} after its deadline ${job.waitDeadline}: ${describe(error)}`,
        );
        return { status: "failed", reason };
      }
      if (error instanceof RenderFailed) {
        try {
          await commitRenderError(file, source, replacing, error.message);
        } catch (recordError) {
          if (recordError instanceof Superseded) return stale;
          throw recordError;
        }
        return { status: "failed", reason: "render_failed" };
      }
      const last = attempt.retryCount >= attempt.retryLimit;
      // A store that answered and refused, or a source object that is gone:
      // the store's doing, never the slicer's, so it gets its own message.
      const refusal = storeRefusalOf(error);
      if (refusal !== null) {
        if (refusal === "retry" && !last) throw error;
        await commitSlicerError(
          file,
          source,
          replacing,
          replacing ? DERIVED_MESSAGES.replaceStoreRefused : DERIVED_MESSAGES.storeRefused,
        );
        console.error(`derived: file ${file.id} ended with store_refused: ${describe(error)}`);
        return { status: "failed", reason: "store_refused" };
      }
      // Only the slicer's own failures get the slicer message. Any other
      // error (a database error, a bug) says nothing about the slicer and
      // may even follow a commit that went through, so it is rethrown with
      // nothing recorded: pg-boss retries it, and once the last attempt has
      // failed the render check settles a file still pending as a render
      // that did not finish.
      if (!isRetryable(error) && !(error instanceof SlicerFault)) throw error;
      if (!last && !(error instanceof SlicerFault)) throw error;
      // The last attempt, or an answer a retry will not change: record
      // slicer_error so the file is never left waiting.
      await commitSlicerError(
        file,
        source,
        replacing,
        replacing ? DERIVED_MESSAGES.replaceFailed : DERIVED_MESSAGES.slicerError,
      );
      console.error(`derived: file ${file.id} ended with slicer_error: ${describe(error)}`);
      return { status: "failed", reason: "slicer_error" };
    }
  }

  /** The file's render and mesh jobs, oldest first, read in trx. */
  async function jobsOfFile(trx: Transaction<DB>, fileId: string) {
    return deps.queue.findJobs<DerivedJob>(QUEUE.slicer, { data: { fileId }, db: bossDb(trx) });
  }

  /**
   * Locks the model row for share when it has no purge begun (and, when
   * live, is not in the trash), the order lockFor and a purge take locks in.
   */
  async function lockModel(trx: Transaction<DB>, modelId: string, live: boolean) {
    let q = trx
      .selectFrom("models")
      .select("id")
      .where("id", "=", modelId)
      .where("purgeStartedAt", "is", null);
    if (live) q = q.where("trashedAt", "is", null);
    return (await q.forShare().executeTakeFirst()) !== undefined;
  }

  /**
   * Issue #91: queues a .scad or STEP file that still has derived_status null
   * and no queued or active job, with its status, in one transaction.
   * Returns whether it queued one.
   */
  async function queueUnqueued(fileId: string, modelId: string): Promise<boolean> {
    return db.transaction().execute(async (trx) => {
      if (!(await lockModel(trx, modelId, true))) return false;
      const row = await trx
        .selectFrom("files")
        .select(["id", "kind", "blobId"])
        .where("id", "=", fileId)
        .where("derivedStatus", "is", null)
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined || !hasDerived(row.kind)) return false;
      if ((await jobsOfFile(trx, row.id)).some((j) => LIVE_STATES.has(j.state))) return false;
      await trx
        .updateTable("files")
        .set({ derivedStatus: "pending", derivedMessage: null, updatedAt: sql<Date>`now()` })
        .where("id", "=", row.id)
        .execute();
      const job: DerivedJob = {
        kind: JOB_KIND_OF[row.kind],
        fileId: row.id,
        sourceBlobId: row.blobId,
      };
      const id = await deps.queue.send(QUEUE.slicer, job, { ...retry, db: bossDb(trx) });
      if (id === null) throw new Error("pg-boss created no job");
      return true;
    });
  }

  /**
   * Issue #90: a file still 'pending' with no queued or active job, whose
   * newest job ended failed: its last attempt died before it recorded an
   * outcome. The file is marked failed and not queued again, so a file that
   * kills the slicer cannot loop. Returns whether it marked one.
   */
  async function settleLost(fileId: string, modelId: string): Promise<boolean> {
    return db.transaction().execute(async (trx) => {
      if (!(await lockModel(trx, modelId, false))) return false;
      const row = await trx
        .selectFrom("files")
        .select(["id", "blobId"])
        .where("id", "=", fileId)
        .where("derivedStatus", "=", "pending")
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) return false;
      const jobs = await jobsOfFile(trx, row.id);
      if (jobs.some((j) => LIVE_STATES.has(j.state))) return false;
      const last = jobs.at(-1);
      if (last === undefined || last.state !== "failed") return false;
      const replacing = last.data?.sourceBlobId !== row.blobId;
      await trx
        .updateTable("files")
        .set({
          derivedStatus: "failed",
          derivedMessage: replacing ? DERIVED_MESSAGES.replaceLost : DERIVED_MESSAGES.renderLost,
          updatedAt: sql<Date>`now()`,
        })
        .where("id", "=", row.id)
        .execute();
      return true;
    });
  }

  /**
   * Issue #90: deletes a staged replacement source (kind 'source', state
   * 'stored') that no file points at and no queued or active job names: its
   * object first, then its row, with the row locked throughout. A store
   * that fails leaves the row, so the next run tries again; an object
   * already gone is not an error. Returns whether it deleted one.
   */
  async function discardLost(blobId: string, modelId: string): Promise<boolean> {
    return db.transaction().execute(async (trx) => {
      if (!(await lockModel(trx, modelId, false))) return false;
      const blob = await trx
        .selectFrom("blobs")
        .select(["id", "key"])
        .where("id", "=", blobId)
        .where("kind", "=", "source")
        .where("state", "=", "stored")
        .forUpdate()
        .executeTakeFirst();
      if (blob === undefined) return false;
      const { rows } = await sql<{ used: boolean }>`
        select exists (
          select 1 from files f
           where f.blob_id = ${blob.id} or f.render_stl_blob_id = ${blob.id}
              or f.render_png_blob_id = ${blob.id} or f.mesh_blob_id = ${blob.id}
        ) as used
      `.execute(trx);
      if (rows[0]?.used !== false) return false;
      const jobs = await deps.queue.findJobs<DerivedJob>(QUEUE.slicer, {
        data: { sourceBlobId: blob.id },
        db: bossDb(trx),
      });
      if (jobs.some((j) => LIVE_STATES.has(j.state))) return false;
      await store.deleteBlobs([blob.key]);
      await trx.deleteFrom("blobs").where("id", "=", blob.id).execute();
      return true;
    });
  }

  /**
   * The render check (issues #90 and #91), a maintenance-queue job run every
   * CHECK_RENDERS_CRON. It acts only on files and staged sources written
   * more than RENDER_CHECK_GRACE_MS before now, and each step re-checks, in
   * a transaction holding the row's lock, that no queued or active job owns
   * what it changes:
   * - a .scad or STEP file in a live model with derived_status null and no
   *   job is queued (a database failure right after ingest committed);
   * - a pending file whose newest job ended failed is marked failed with
   *   DERIVED_MESSAGES.renderLost (replaceLost for a replacement), and is
   *   not queued again;
   * - a staged replacement source no file points at and no live job names
   *   is deleted, object first, then row.
   * One item that fails is logged and left for the next run; the others go
   * on. A second run finds nothing to do.
   */
  async function checkRenders(now: Date): Promise<RenderCheckResult> {
    const cutoff = new Date(now.getTime() - RENDER_CHECK_GRACE_MS);
    const result: RenderCheckResult = { queued: [], failed: [], discarded: [] };
    const attempt = async (
      what: string,
      step: () => Promise<boolean>,
      into: string[],
      id: string,
    ) => {
      try {
        if (await step()) into.push(id);
      } catch (error) {
        console.error(`render check: ${what} ${id} left for the next run: ${describe(error)}`);
      }
    };

    const unqueued = await db
      .selectFrom("files as f")
      .innerJoin("models as m", "m.id", "f.modelId")
      .select(["f.id", "f.modelId"])
      .where("f.kind", "in", ["scad", "step"])
      .where("f.derivedStatus", "is", null)
      .where("f.createdAt", "<", cutoff)
      .where("m.trashedAt", "is", null)
      .where("m.purgeStartedAt", "is", null)
      .orderBy("f.createdAt")
      .execute();
    for (const f of unqueued) {
      await attempt("file", () => queueUnqueued(f.id, f.modelId), result.queued, f.id);
    }

    const pending = await db
      .selectFrom("files as f")
      .innerJoin("models as m", "m.id", "f.modelId")
      .select(["f.id", "f.modelId"])
      .where("f.derivedStatus", "=", "pending")
      .where("f.updatedAt", "<", cutoff)
      .where("m.purgeStartedAt", "is", null)
      .orderBy("f.updatedAt")
      .execute();
    for (const f of pending) {
      await attempt("file", () => settleLost(f.id, f.modelId), result.failed, f.id);
    }

    const { rows: staged } = await sql<{ id: string; modelId: string }>`
      select b.id, b.model_id as "modelId"
        from blobs b
        join models m on m.id = b.model_id
       where b.kind = 'source' and b.state = 'stored'
         and b.created_at < ${cutoff}
         and m.purge_started_at is null
         and not exists (
           select 1 from files f
            where f.blob_id = b.id or f.render_stl_blob_id = b.id
               or f.render_png_blob_id = b.id or f.mesh_blob_id = b.id)
       order by b.created_at
    `.execute(db.withoutPlugins());
    for (const b of staged) {
      await attempt("staged source", () => discardLost(b.id, b.modelId), result.discarded, b.id);
    }

    const { queued, failed, discarded } = result;
    if (queued.length + failed.length + discarded.length > 0) {
      console.info(
        `render check: queued ${queued.length} file(s) that had no render job, marked ` +
          `${failed.length} render(s) that did not finish failed, removed ` +
          `${discarded.length} staged source(s)`,
      );
    }
    return result;
  }

  return { renderScad, convertStep, replaceFile, afterUpload, runJob, checkRenders };
}

export type Derived = ReturnType<typeof createDerived>;

/**
 * Task 13's entries for the slicer queue's handler map (QueueDeps.slicerJobs):
 * the render and mesh kinds, each running runJob with the job's retry count
 * and limit, so the last attempt records slicer_error. Spread beside Task
 * 12's "slice" entry: { ...derivedJobHandlers(derived), slice: ... }.
 */
export function derivedJobHandlers(derived: Pick<Derived, "runJob">): SlicerJobHandlers {
  const handle: SlicerJobHandlers[string] = (job) =>
    derived.runJob(job.data as unknown as DerivedJob, {
      retryCount: job.retryCount,
      retryLimit: job.retryLimit,
    });
  return { [DERIVED_KINDS.renderScad]: handle, [DERIVED_KINDS.convertStep]: handle };
}
