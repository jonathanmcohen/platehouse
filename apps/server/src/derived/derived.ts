// OpenSCAD renders and STEP meshes in the app, so STL and STEP files can be
// viewed in 3D, and replacing a .scad file renders it again. A .scad file gets an STL and a PNG preview, a STEP file a
// GLB mesh, all made by the slicer container (scad.ts, step.ts, client.ts)
// and stored as new blobs. Ingest never calls the slicer: once a .scad, STEP
// or STL file's row commits, ingest's afterCommit (afterUpload here) sends a
// job to the singleton slicer queue (jobs/queues.ts), and runJob does the work there.
//
// Preview pictures for STL and STEP files (issue #316), shown on the library
// card and the model page in place of the file-type icon (preview.ts):
// - an STL gets a render-stl job, which streams its source to the slicer's
//   /v1/stl/png and stores the PNG as render_png. It is a file kind with a
//   derived blob like the others: replaceFile, the waits, the retries and
//   the render check all apply to it as they do to a .scad.
// - a STEP file's convert-step job, once its mesh is stored, queues a
//   preview-step job in the same transaction, while derived_status says the
//   mesh is ok. That job reads the stored GLB back and sends it as an STL,
//   so the STEP file is never converted twice. A preview that fails leaves
//   the mesh, its derived_status and the 3D view as they are (issue #380).
// - A picture's status is never written by a job (issue #389). Each
//   transaction that changes a fact about it (the picture and the source it
//   was made from, a failed attempt and its source, a picture job queued or
//   finished, the file's source) writes only that fact, then calls
//   recomputePreview, which stores what picture.ts's previewState works out
//   from all of them: ok for a picture of the current source, pending while
//   a picture job for it is live, failed with the newest attempt's reason,
//   else none. A replacement that is not saved changes no fact about the
//   current source, so it never changes the picture's status.
// - A preview picture is only ever of the file's current source. Unlike a
//   .scad's STL and PNG, or a STEP file's mesh, it is not kept as "the
//   previous version's" when a later render fails (issue #103's rule): the
//   card cannot say a picture is of an earlier version, so a render or
//   conversion the program rejects deletes the earlier preview, and the card
//   shows the icon until a render succeeds (KEPT_ON_FAILURE).
// - Files stored before previews existed get one from backfillPreviews, a
//   maintenance task that queues one batch at a time. It also queues again
//   a preview that failed because the slicer or the store stayed down, or
//   its job could not be queued (PREVIEW_RETRIED), so an outage or an old
//   slicer image does not leave a file with no picture for good.
//
// The jobs are kinds on the slicer queue (DERIVED_KINDS): the queue's one
// worker hands each to its handler from derivedJobHandlers, beside the estimates module's
// "slice" handler, so there is never a second worker on that queue.
//
// Retries (shared with the estimate jobs): every job is sent with SLICER_RETRY. When the
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
// written (after a sentence saying the renders shown are the previous
// version's, when they are; see replaceFile below), or, for a preview
// picture, into files.preview_failure_message, from which recomputePreview
// fills preview_message. It is text, for the page to show as text, never
// HTML.
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
// storing the renders) is handled the same way, as the estimate jobs handle it: it
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
// the previous version whole: its source, its renders and its rows.
//
// A replacement that OpenSCAD or the STEP converter rejects itself is the
// exception (the maintainer, issue #103): it is the file the user uploaded, so it becomes
// the file's source as uploaded and the file shows the program's message.
// The previous version's STL and PNG, or GLB, stay attached until a later
// render succeeds, which replaces and deletes them as any render does; only
// the old source is deleted, its row in the transaction that makes the
// replacement the source and its object after that commit. The kept renders
// are marked as the previous version's with the existing columns, so no
// migration: the message starts with DERIVED_MESSAGES.previousRendersScad
// or previousRendersStep, and each derived blob row's created_at is set to
// its source blob row's created_at when it is stored, not the time it was
// written, so a derived row with a created_at older than the file's source
// row was rendered from an earlier source. The write time could not say
// that: a render of the old source can commit after a replacement was
// staged, and its rows would then look newer than the replacement's. When
// the replacement itself is rejected, every render still attached is the
// previous version's, since a render of the replacement can only be
// attached by the swap that makes it the source. A
// slicer that stays down, a store that stays down or refuses, or a slicer
// error is not the file's doing, so for those the replacement is still
// discarded and the previous version kept, as above. An object left with
// no row by a crash between steps
// is removed by the orphan sweep (ingest/orphans.ts). A replacement over the
// renderer's limit (a .scad over 1 MiB, a STEP file over 256 MiB) is
// refused by replaceFile before anything is stored, since it could never
// render.
//
// Until a render succeeds, every later message for that file keeps saying
// the renders shown are the previous version's (issue #104): a final
// failure that is the slicer's or the store's, for a render of the rejected
// source or for a further replacement, a render that could not be queued
// (queueFailed), and a render the render check finds dead, all put the
// sentence (previousRendersScad or previousRendersStep
// without its "said:" lead-in, PREVIOUS_RENDERS_SENTENCE) before their own
// message whenever an attached render is older than the file's source. A
// file that is pending meanwhile (a render queued again, a further
// replacement, or a job that settled while a newer replacement is queued)
// carries the sentence alone as its message, rather than none (issue #146).
//
// The render check (checkRenders, issues #90 and #91) repairs what a job or
// an upload that died part way leaves behind. It is a maintenance-queue job
// (CHECK_RENDERS_CRON, every 15 minutes; main.ts registers the schedule),
// and it acts only on rows written more than RENDER_CHECK_GRACE_MS ago,
// twice pg-boss's default 15-minute job expiry, and longer than a STEP
// conversion's own (CONVERT_EXPIRE_SECONDS, 1050 s). Each step re-checks,
// holding the row's lock, that no queued or active job owns what it changes:
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
// - A preview picture can be left 'pending' with no job behind it: one
//   committed while a newer replacement was queued, whose conversion then
//   died, or a preview job that found the file changed under it and did
//   nothing. With no job of the file queued or running, the check settles
//   it: 'ok' when the picture is of the file's current source, else none,
//   for the preview backfill to queue again. A replacement's conversion
//   that ends with a final failure (commitSlicerError) settles it at once.
//
// derived_status is 'pending' while a .scad's render or a STEP file's mesh
// conversion is queued or running, then 'ok' or 'failed'; it stays null for
// a .3mf and an STL, which have neither. preview_status (migration 0012,
// issue #380) is the same for an STL's or STEP file's preview picture, and
// null until one is queued. No job writes it: the preview kinds write only
// the fact columns, and recomputePreview works preview_status out from them
// (STATUS_OF), so derived_status, which the public API answers as
// derivedStatus, keeps its 0.1.0 meaning: a STEP file whose mesh is stored
// is 'ok' whatever becomes of its picture. A job that finishes while a newer
// replacement of the file is still queued leaves its status 'pending'
// (newerQueued), so the file never reads as done, or as failed, before its
// last upload has rendered.
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS, type SlicerTimeouts } from "@platehouse/slicer-contract";
import { CompiledQuery, type Kysely, sql, type Transaction } from "kysely";
import type { PgBoss } from "pg-boss";
import { isUuid, uuidv7 } from "../db/ids.js";
import type { Blob, DB, FileKind, ModelFile } from "../db/types.js";
import {
  convertExpireSeconds,
  SLICER_MARGIN_SECONDS,
  type SlicerState,
} from "../estimates/slicer-state.js";
import { detectKind } from "../ingest/detect.js";
import {
  CONTENT_TYPES,
  readFirstBytes,
  STORAGE_UNAVAILABLE_MESSAGE,
  type StoredFile,
} from "../ingest/ingest.js";
import { QUEUE, SLICER_RETRY, type SlicerJobHandlers } from "../jobs/queues.js";
import { type BuildQueue, memoryGate } from "../memory/gate.js";
import { createRepos } from "../repos/index.js";
import { blobKey } from "../storage/keys.js";
import { BlobNotFound, type BlobStore, StoreError, StoreUnavailable } from "../storage/s3.js";
import {
  CONVERT_EXPIRE_SECONDS,
  DERIVED_MESSAGES,
  isRetryable,
  PREVIOUS_RENDERS_SENTENCE,
  RENDER_TIMEOUT_MS,
  RENDER_UPLOAD_TIMEOUT_MS,
  RenderFailed,
  type RenderOutput,
  SandboxOff,
  SlicerDown,
  SlicerFault,
  type SlicerTarget,
  sandboxMessage,
  TempFileError,
} from "./client.js";
import { PREVIEW_RETRIED, PREVIEW_SANDBOX_OFF, previewState } from "./picture.js";
import { meshPreviewOutputs, stlPreviewOutputs } from "./preview.js";
import { renderScadOutputs } from "./scad.js";
import { convertStepOutputs } from "./step.js";

export { DERIVED_MESSAGES } from "./client.js";

/** files.derived_status values. */
export type DerivedStatus = "pending" | "ok" | "failed";

/**
 * The render and mesh job kinds on the slicer queue, and issue #316's two preview
 * kinds. The queue's one worker hands each job to its kind's handler
 * (slicerJobs in jobs/queues.ts); derivedJobHandlers gives these, beside
 * the estimates module's "slice".
 */
export const DERIVED_KINDS = {
  renderScad: "render-scad",
  convertStep: "convert-step",
  /** An STL's preview picture, from its source. */
  renderStl: "render-stl",
  /** A STEP file's preview picture, from its stored mesh. */
  previewStep: "preview-step",
} as const;

export type DerivedKind = (typeof DERIVED_KINDS)[keyof typeof DERIVED_KINDS];

/**
 * The send options for a job of this kind on the slicer queue: a STEP
 * conversion also gets its expiry (CONVERT_EXPIRE_SECONDS), which covers
 * storing its mesh; every other kind is sent with options unchanged.
 */
export function slicerSendOptions<T extends object>(
  kind: DerivedKind,
  options: T,
  convertExpire: number = CONVERT_EXPIRE_SECONDS,
): T | (T & { expireInSeconds: number }) {
  return kind === DERIVED_KINDS.convertStep
    ? { ...options, expireInSeconds: convertExpire }
    : options;
}

/**
 * The expiry of a conversion job from the slicer's limits, or
 * CONVERT_EXPIRE_SECONDS before any are known. Only a STEP conversion is
 * sent with an expiry, so any other kind answers at once, without asking the
 * slicer's health.
 */
export async function convertExpiryFor(
  kind: DerivedKind,
  slicerState: SlicerState | undefined,
): Promise<number> {
  if (kind !== DERIVED_KINDS.convertStep || slicerState === undefined) {
    return CONVERT_EXPIRE_SECONDS;
  }
  return convertExpireSeconds((await slicerState.current()).timeouts);
}

/**
 * The timers of a request to the slicer for a job of this kind, from the
 * slicer's own limits: the answer wait is its time cap for the route plus
 * the app's margin (a STEP conversion has its own cap, a render and a
 * picture share the OpenSCAD one), and a streamed body gets its upload
 * allowance. A timer the deps set stays as set.
 */
export function renderTarget(
  baseUrl: string,
  kind: DerivedKind,
  timeouts: SlicerTimeouts,
  fixed: { timeoutMs?: number | undefined; uploadTimeoutMs?: number | undefined } = {},
): SlicerTarget {
  const capSeconds =
    kind === DERIVED_KINDS.convertStep ? timeouts.stepSeconds : timeouts.scadSeconds;
  return {
    baseUrl,
    timeoutMs: fixed.timeoutMs ?? (capSeconds + SLICER_MARGIN_SECONDS) * 1000,
    uploadTimeoutMs: fixed.uploadTimeoutMs ?? timeouts.uploadSeconds * 1000,
  };
}

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
  /**
   * True on a preview queued by backfillPreviews (issue #316), so the next
   * run can tell that its batch is still waiting. Kept on a job sent again
   * to wait for the slicer or the store.
   */
  backfill?: boolean;
}

/** What a job ends with, kept by pg-boss as its output. */
export interface DerivedOutcome {
  /**
   * requeued: the slicer (slicer_down) or the store (store_down) was down,
   * and the same job was sent again to wait for it. failed with slicer_down
   * or store_down: it stayed down past SLICER_DOWN_LIMIT_MS, and the job
   * stopped waiting. failed with store_refused: the store answered and
   * refused, or the source object is gone (issue #102). failed with
   * temp_failed: a preview picture's last attempt could not write in its
   * own temp folder (issue #415). failed with sandbox_off: the slicer's
   * sandbox is off, so it refused the job; the file shows why and is
   * queued again once the sandbox is on.
   */
  status: "ok" | "failed" | "skipped" | "requeued";
  reason?:
    | "render_failed"
    | "slicer_error"
    | "stale"
    | "slicer_down"
    | "store_down"
    | "store_refused"
    | "temp_failed"
    | "sandbox_off";
}

export type DerivedErrorCode =
  | "not_found"
  | "not_derivable"
  | "wrong_type"
  | "too_large"
  | "storage_unavailable";

/** A call refused with a plain message for the user. */
export class DerivedError extends Error {
  readonly code: DerivedErrorCode;

  constructor(code: DerivedErrorCode, message: string) {
    super(message);
    this.name = "DerivedError";
    this.code = code;
  }
}

const NOT_FOUND_MESSAGE = "That file does not exist or its model is in the trash";
const NOT_DERIVABLE_MESSAGE = "Only .scad, STEP and STL files have renders";

/** The file kinds that have derived blobs. */
type DerivableKind = "scad" | "step" | "stl";

const WRONG_TYPE_MESSAGE: Readonly<Record<DerivableKind, string>> = {
  scad: "The replacement is not a .scad file; nothing was saved",
  step: "The replacement is not a STEP file; nothing was saved",
  stl: "The replacement is not an STL file; nothing was saved",
};
const TOO_LARGE_MESSAGE: Readonly<Record<"scad" | "step", string>> = {
  scad: "The replacement is larger than the 1 MiB the renderer takes; nothing was saved",
  step: "The replacement is larger than the 256 MiB the converter takes; nothing was saved",
};
/**
 * The renderer's limit for each kind's source (the contract's, which scad.ts
 * and step.ts enforce). An STL has none here: one over the preview limit is
 * still a whole STL with a 3D view, so a replacement over it is taken and
 * only its preview fails (DERIVED_MESSAGES.stlTooLarge).
 */
const BODY_LIMIT: Readonly<Partial<Record<DerivableKind, number>>> = {
  scad: LIMITS.scadBodyBytes,
  step: LIMITS.stepBodyBytes,
};

/**
 * How many previews one backfill run queues at most (issue #316). A run
 * queues a batch only when none of the last one is still waiting, so at most
 * this many backfill jobs ever sit ahead of an upload or a slice.
 */
export const BACKFILL_BATCH = 10;

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
  /**
   * The slicer's own limits, from its health answer: the render timers and
   * a conversion's expiry follow them. RENDER_TIMEOUT_MS,
   * RENDER_UPLOAD_TIMEOUT_MS and CONVERT_EXPIRE_SECONDS, the defaults of an
   * unconfigured slicer, stand in when left out.
   */
  slicerState?: SlicerState;
  /** A render request's wait for its answer once sent; the slicer's limit plus 30 s when left out. */
  requestTimeoutMs?: number;
  /** The time a streamed body may take to send; the slicer's upload limit when left out. */
  uploadTimeoutMs?: number;
  /** The clock the slicer-down deadline is set and read by; the system clock when left out. */
  now?: () => Date;
  /** How many previews one backfill run queues at most (issue #316). */
  backfillBatch?: number;
  /**
   * The queue a STEP preview's mesh read runs through; the process's
   * memoryGate (memory/gate.ts), shared with the plate mesh builds,
   * when left out.
   */
  memoryGate?: BuildQueue;
  /**
   * TMP_DIR: each job's own folder is made here for the slicer's answers,
   * streamed to disk and stored from there, and a STEP preview's STL; the
   * OS's when left out.
   */
  tmpDir?: string;
}

/** What one run of the preview backfill did (issue #316). */
export interface BackfillResult {
  /** The STL and STEP files it queued a preview for. */
  queued: string[];
}

/**
 * How long a render job may run before pg-boss expires it: pg-boss's default
 * of 15 minutes, since the slicer queue (jobs/queues.ts) sets none. Only a
 * STEP conversion is sent with its own, CONVERT_EXPIRE_SECONDS (1050 s,
 * slicerSendOptions), which is longer but still under twice this. A job that
 * is still 'active' past its expiry is failed, or retried, by pg-boss itself.
 */
const RENDER_JOB_EXPIRY_MS = 15 * 60 * 1000;

/**
 * How long the render check (checkRenders) leaves a file or a staged source
 * alone after it was written: twice a render job's expiry, longer than a
 * STEP conversion's too, so a job that died while active has been expired
 * by pg-boss, and an upload's own afterUpload has long since had its turn,
 * before the check looks at it.
 */
export const RENDER_CHECK_GRACE_MS = 2 * RENDER_JOB_EXPIRY_MS;

/**
 * The render check's suggested cadence on the maintenance queue: every 15
 * minutes. main.ts registers the schedule; checkRenders(now) is its handler.
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

/** The kinds that have derived blobs: a .scad's renders, a STEP's mesh, and STL and STEP previews. */
export function hasDerived(kind: FileKind): kind is DerivableKind {
  return kind === "scad" || kind === "step" || kind === "stl";
}

/** The job a file of each kind starts with: its render, its conversion or its preview. */
const JOB_KIND_OF: Readonly<Record<DerivableKind, DerivedKind>> = {
  scad: DERIVED_KINDS.renderScad,
  step: DERIVED_KINDS.convertStep,
  stl: DERIVED_KINDS.renderStl,
};

/** The file kind each job is for. */
const FILE_KIND_OF: Readonly<Record<DerivedKind, DerivableKind>> = {
  [DERIVED_KINDS.renderScad]: "scad",
  [DERIVED_KINDS.convertStep]: "step",
  [DERIVED_KINDS.renderStl]: "stl",
  [DERIVED_KINDS.previewStep]: "step",
};

/** The file columns that point at each kind's derived blobs. */
type DerivedColumn = "renderStlBlobId" | "renderPngBlobId" | "meshBlobId";

const COLUMN_OF: Readonly<Record<RenderOutput["kind"], DerivedColumn>> = {
  render_stl: "renderStlBlobId",
  render_png: "renderPngBlobId",
  mesh_glb: "meshBlobId",
};

/**
 * The columns a job's renders replace: a successful job points them at its
 * new blobs (null where it made none) and deletes what they pointed at. A
 * STEP conversion makes a new mesh, so the old mesh's preview goes with it;
 * the preview-step job it queues makes the new one.
 */
const COLUMNS_OF_KIND: Readonly<Record<DerivedKind, readonly DerivedColumn[]>> = {
  [DERIVED_KINDS.renderScad]: ["renderStlBlobId", "renderPngBlobId"],
  [DERIVED_KINDS.convertStep]: ["meshBlobId", "renderPngBlobId"],
  [DERIVED_KINDS.renderStl]: ["renderPngBlobId"],
  [DERIVED_KINDS.previewStep]: ["renderPngBlobId"],
};

/** A pair of file columns that hold a job's state: its status and its message. */
interface StatusColumns {
  status: "derivedStatus" | "previewStatus";
  message: "derivedMessage" | "previewMessage";
}

const DERIVED_STATE: StatusColumns = { status: "derivedStatus", message: "derivedMessage" };
const PREVIEW_STATE: StatusColumns = { status: "previewStatus", message: "previewMessage" };

/**
 * Where each job kind keeps its state (issue #380): a .scad's render and a
 * STEP file's mesh in derived_status and derived_message, as in 0.1.0, which
 * those jobs write; and an STL's or STEP file's preview picture in
 * preview_status and preview_message, which no job writes: the picture jobs
 * write the facts, and recomputePreview works the status out from them
 * (picture.ts, issue #389).
 */
const STATUS_OF: Readonly<Record<DerivedKind, StatusColumns>> = {
  [DERIVED_KINDS.renderScad]: DERIVED_STATE,
  [DERIVED_KINDS.convertStep]: DERIVED_STATE,
  [DERIVED_KINDS.renderStl]: PREVIEW_STATE,
  [DERIVED_KINDS.previewStep]: PREVIEW_STATE,
};

/** Whether a job kind makes a preview picture (render-stl, preview-step). */
function isPreviewKind(kind: unknown): boolean {
  return kind === DERIVED_KINDS.renderStl || kind === DERIVED_KINDS.previewStep;
}

/** A set() for one pair of status columns. */
function stateSet(
  cols: StatusColumns,
  status: DerivedStatus | null,
  message: string | null,
): Partial<Record<StatusColumns["status"] | StatusColumns["message"], string | null>> {
  return { [cols.status]: status, [cols.message]: message };
}

/**
 * The columns a job leaves as they are when the program rejects the file's
 * source, to be shown as the previous version's (issue #103). The rest of
 * COLUMNS_OF_KIND, a preview picture, is deleted then (issue #316), since a
 * card cannot say a picture is of an earlier version. Only these columns
 * can hold renders older than the file's source (rendersPredate).
 */
const KEPT_ON_FAILURE: Readonly<Record<DerivedKind, readonly DerivedColumn[]>> = {
  [DERIVED_KINDS.renderScad]: ["renderStlBlobId", "renderPngBlobId"],
  [DERIVED_KINDS.convertStep]: ["meshBlobId"],
  [DERIVED_KINDS.renderStl]: [],
  [DERIVED_KINDS.previewStep]: [],
};

/**
 * What goes before a render error when the renders the file shows are from
 * an earlier source; null for the preview kinds, which keep none.
 */
const PREVIOUS_RENDERS: Readonly<Record<DerivedKind, string | null>> = {
  [DERIVED_KINDS.renderScad]: DERIVED_MESSAGES.previousRendersScad,
  [DERIVED_KINDS.convertStep]: DERIVED_MESSAGES.previousRendersStep,
  [DERIVED_KINDS.renderStl]: null,
  [DERIVED_KINDS.previewStep]: null,
};

/**
 * The same sentence without its lead-in to the program's words ("OpenSCAD
 * said:", "The converter said:"), PREVIOUS_RENDERS_SENTENCE from client.ts:
 * what goes before a later final failure that is the slicer's or the
 * store's, a render that could not be queued, or a render the render check
 * found dead, while the renders the file shows are still from an earlier
 * source (issue #104). The lead-in would put the slicer's or the store's
 * message in the program's mouth. Renders older than the file's source only
 * stay attached after the program rejected that source (commitRenderError),
 * so the sentence is still true when it is used.
 */
const PREVIOUS_RENDERS_SENTENCE_OF: Readonly<Record<DerivedKind, string | null>> = {
  [DERIVED_KINDS.renderScad]: PREVIOUS_RENDERS_SENTENCE.scad,
  [DERIVED_KINDS.convertStep]: PREVIOUS_RENDERS_SENTENCE.step,
  [DERIVED_KINDS.renderStl]: null,
  [DERIVED_KINDS.previewStep]: null,
};

/** The kind sandboxMessage takes for each job kind. */
const SANDBOX_KIND: Readonly<Record<DerivedKind, "scad" | "step" | "stl" | "preview">> = {
  [DERIVED_KINDS.renderScad]: "scad",
  [DERIVED_KINDS.convertStep]: "step",
  [DERIVED_KINDS.renderStl]: "stl",
  [DERIVED_KINDS.previewStep]: "preview",
};

/** What a job waits out without using a retry: a slicer or a store that is down. */
type Outage = "slicer" | "store";

/** Each outage's outcome reason, and the messages a render shows once it stops waiting. */
const OUTAGES: Readonly<
  Record<
    Outage,
    {
      reason: "slicer_down" | "store_down";
      message: string;
      replaceMessage: string;
      previewMessage: string;
    }
  >
> = {
  slicer: {
    reason: "slicer_down",
    message: DERIVED_MESSAGES.slicerDown,
    replaceMessage: DERIVED_MESSAGES.replaceSlicerDown,
    // A picture's outage is tried again by the preview backfill, so it says
    // so (issue #379), and a replacement's picture records nothing at all.
    previewMessage: DERIVED_MESSAGES.previewSlicerDown,
  },
  store: {
    reason: "store_down",
    message: DERIVED_MESSAGES.storeDown,
    replaceMessage: DERIVED_MESSAGES.replaceStoreDown,
    previewMessage: DERIVED_MESSAGES.previewStoreDown,
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
  /** The slicer's limits now, or the fallbacks before health has answered. */
  const limits = async (): Promise<SlicerTimeouts | null> =>
    deps.slicerState ? (await deps.slicerState.current()).timeouts : null;
  const targetFor = async (kind: DerivedKind): Promise<SlicerTarget> => {
    const timeouts = await limits();
    const fixed = { timeoutMs: deps.requestTimeoutMs, uploadTimeoutMs: deps.uploadTimeoutMs };
    if (timeouts === null) {
      return {
        baseUrl: deps.slicerUrl,
        timeoutMs: fixed.timeoutMs ?? RENDER_TIMEOUT_MS,
        uploadTimeoutMs: fixed.uploadTimeoutMs ?? RENDER_UPLOAD_TIMEOUT_MS,
      };
    }
    return renderTarget(deps.slicerUrl, kind, timeouts, fixed);
  };
  const convertExpiry = (kind: DerivedKind): Promise<number> =>
    convertExpiryFor(kind, deps.slicerState);
  const retry = {
    ...SLICER_RETRY,
    ...(deps.retryDelaySeconds === undefined ? {} : { retryDelay: deps.retryDelaySeconds }),
  };
  const clock = deps.now ?? (() => new Date());
  const gate = deps.memoryGate ?? memoryGate;
  const tmpDir = deps.tmpDir ?? tmpdir();
  /** A STEP preview always wants its turn at the gate: a signal that never aborts. */
  const staying = new AbortController().signal;

  /**
   * Marks the file failed with DERIVED_MESSAGES.queueFailed. When the
   * renders it keeps are from an earlier source than its own (a replacement
   * the program rejected), the message starts with the sentence saying so
   * (keepingPrevious; issue #104). For a picture job, it records the failed
   * attempt for the current source instead, with the sentence that says the
   * backfill tries it again, and the picture's status is worked out from
   * that (issue #389). The row is read and written in one transaction,
   * holding its lock.
   */
  async function commitQueueFailed(fileId: string, jobKind: DerivedKind): Promise<void> {
    await db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("files")
        .select(["id", "blobId", "renderStlBlobId", "renderPngBlobId", "meshBlobId"])
        .where("id", "=", fileId)
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) return;
      await trx
        .updateTable("files")
        .set({
          ...(isPreviewKind(jobKind)
            ? pictureFailure(row.blobId, DERIVED_MESSAGES.previewQueueFailed)
            : stateSet(
                STATUS_OF[jobKind],
                "failed",
                await keepingPrevious(trx, row, jobKind, DERIVED_MESSAGES.queueFailed),
              )),
          updatedAt: sql<Date>`now()`,
        })
        .where("id", "=", row.id)
        .execute();
      await recomputePreview(trx, row.id);
    });
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
  async function queueFor(fileId: string, kind: DerivableKind): Promise<string> {
    const file = isUuid(fileId) ? await repos.files.get(fileId) : undefined;
    if (file === undefined || (await repos.models.get(file.modelId)) === undefined) {
      throw new DerivedError("not_found", NOT_FOUND_MESSAGE);
    }
    if (file.kind !== kind) throw new DerivedError("not_derivable", NOT_DERIVABLE_MESSAGE);
    const job: DerivedJob = { kind: JOB_KIND_OF[kind], fileId: file.id, sourceBlobId: file.blobId };
    const expiry = await convertExpiry(job.kind);
    try {
      return await db.transaction().execute(async (trx) => {
        // A file that still shows renders of an earlier source keeps saying
        // so while it is pending (issue #146).
        const row = await lockedRenders(trx, file.id);
        const message = row === undefined ? null : await previousSentence(trx, row, job.kind);
        // A render or a mesh is marked pending here; a picture's status
        // follows from the job just queued (recomputePreview).
        await trx
          .updateTable("files")
          .set({
            ...(isPreviewKind(job.kind) ? {} : stateSet(STATUS_OF[job.kind], "pending", message)),
            updatedAt: sql<Date>`now()`,
          })
          .where("id", "=", file.id)
          .execute();
        const id = await deps.queue.send(
          QUEUE.slicer,
          job,
          slicerSendOptions(job.kind, { ...retry, db: bossDb(trx) }, expiry),
        );
        if (id === null) throw new Error("pg-boss created no job");
        await recomputePreview(trx, file.id);
        return id;
      });
    } catch (error) {
      // The queueing error is the one rethrown. If the database is what
      // failed, this write fails too and the file keeps derived_status null
      // with no job; the render check (checkRenders) queues it later.
      await commitQueueFailed(file.id, job.kind).catch((statusError) => {
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

  /** Queues the preview picture of an STL file (issue #316); returns the job id. */
  function renderStl(fileId: string): Promise<string> {
    return queueFor(fileId, "stl");
  }

  /**
   * Ingest's afterCommit: queues the render of a .scad, the mesh of a STEP
   * file or the preview of an STL whose row has committed. It never throws:
   * the upload is stored whatever happens here, and a job that cannot be
   * queued leaves the file failed with DERIVED_MESSAGES.queueFailed, or,
   * when the database cannot take even that, with derived_status null for
   * the render check (a .scad or STEP file) or the preview backfill (an
   * STL) to queue.
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
   * Replaces a .scad, STEP or STL file's source with the file at tmpPath,
   * which must be of the same kind and, for a .scad or STEP file, within the
   * renderer's limit, and queues its render. The file keeps its previous
   * source and renders until the new renders are stored (runJob). The file
   * at tmpPath is left for its owner to delete.
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
    // here, before anything is stored. An STL has no such limit (BODY_LIMIT).
    const limit = BODY_LIMIT[kind];
    if (limit !== undefined && size > limit && kind !== "stl") {
      throw new DerivedError("too_large", TOO_LARGE_MESSAGE[kind]);
    }

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
    const expiry = await convertExpiry(JOB_KIND_OF[kind]);
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
      const job: DerivedJob = { kind: JOB_KIND_OF[kind], fileId: file.id, sourceBlobId: blobId };
      // The file keeps its source and renders until the replacement renders,
      // so renders of an earlier source keep their sentence (issue #146).
      const row = await lockedRenders(trx, file.id);
      const message = row === undefined ? null : await previousSentence(trx, row, job.kind);
      // A replacement not yet saved changes nothing about the current
      // source's picture (issue #389), so a picture job marks nothing here;
      // a render or a mesh is marked pending as before.
      await trx
        .updateTable("files")
        .set({
          ...(isPreviewKind(job.kind) ? {} : stateSet(STATUS_OF[job.kind], "pending", message)),
          updatedAt: sql<Date>`now()`,
        })
        .where("id", "=", file.id)
        .execute();
      const id = await deps.queue.send(
        QUEUE.slicer,
        job,
        slicerSendOptions(job.kind, { ...retry, db: bossDb(trx) }, expiry),
      );
      if (id === null) throw new Error("pg-boss created no job");
      await recomputePreview(trx, file.id);
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

  /**
   * An object's whole bytes, in the app's memory: a .scad source (at most
   * 1 MiB by the time this runs), or a STEP file's stored GLB mesh for its
   * preview picture (preview-step). The chunks and the joined copy are both
   * held while Buffer.concat runs, so a mesh briefly takes about twice its
   * size. A mesh is read only under the process's memory gate, shared with
   * the plate mesh builds, and only when its recorded size is at most
   * PREVIEW_MESH_MAX_BYTES (preview.ts), so the read's peak is
   * STEP_PREVIEW_PEAK_MB (memory/peaks.ts), which the app's memory budget
   * counts (2g in the example Compose file; test/compose-example.test.ts).
   * The STL made from it is written to a temp file a chunk at a time
   * (mesh.ts), never held.
   */
  async function readAll(key: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of await store.getBlobStream(key)) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  /**
   * The file row, locked, once the job is known to still apply to it. The
   * model row is locked first, the order a purge takes them in, so the two
   * never deadlock; a model whose purge has begun takes no new rows. A
   * preview made from a STEP file's mesh also needs the file to still have
   * that mesh (meshId).
   */
  async function lockFor(
    trx: Transaction<DB>,
    file: ModelFile,
    source: Blob,
    replacing: boolean,
    meshId?: string,
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
    if (meshId !== undefined && row.meshBlobId !== meshId) throw new Superseded();
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

  /**
   * outcome, or 'pending' while a newer replacement is queued, with
   * pendingMessage: PREVIOUS_RENDERS_SENTENCE when the renders the file
   * shows after this write are from an earlier source than its own, else
   * null (issue #146).
   */
  async function settledOutcome(
    trx: Transaction<DB>,
    fileId: string,
    sourceId: string,
    outcome: { status: DerivedStatus; message: string | null },
    pendingMessage: string | null,
  ): Promise<{ status: DerivedStatus; message: string | null }> {
    return (await newerQueued(trx, fileId, sourceId))
      ? { status: "pending", message: pendingMessage }
      : outcome;
  }

  /**
   * Points the file at a replacement source (when replacing) and at new
   * derived blobs for the job kind, deletes the rows of the blobs that
   * replaces, and returns their keys for deleting after the commit. Each new
   * derived row's created_at is set to its source's (copied in Postgres, so
   * to the microsecond), not the time it was written, so the row says which
   * source it was rendered from (see rendersPredate).
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
    if (outputs.length > 0) {
      await sql`
        update blobs
           set created_at = (select s.created_at from blobs s where s.id = ${source.id})
         where id in (${sql.join(outputs.map((o) => o.id))})
      `.execute(trx);
    }
    const columns = COLUMNS_OF_KIND[jobKind];
    const old = columns.map((c) => row[c]).filter((id): id is string => id !== null);
    if (replacing) old.push(row.blobId);
    const derived: Partial<Record<DerivedColumn, string | null>> = {};
    for (const c of columns) derived[c] = null;
    for (const out of outputs) derived[COLUMN_OF[out.kind]] = out.id;
    // The source a new picture was made from, stored with it, so "a picture
    // of the current source" is a fact (issue #389); a job that clears the
    // picture (a STEP conversion's new mesh) clears it too. A picture job
    // that succeeds also clears its source's failed attempt.
    const pictureFacts = columns.includes("renderPngBlobId")
      ? {
          previewSourceBlobId: derived.renderPngBlobId ? source.id : null,
          ...(isPreviewKind(jobKind)
            ? { previewFailureSourceBlobId: null, previewFailureMessage: null }
            : {}),
        }
      : {};

    await trx
      .updateTable("files")
      .set({
        ...derived,
        ...pictureFacts,
        ...(replacing
          ? { blobId: source.id, size: source.size ?? 0, sha256: source.sha256 ?? Buffer.alloc(0) }
          : {}),
        // A render or a mesh writes its own status; a picture's follows from
        // the facts (recomputePreview, called by every caller of swapIn).
        ...(isPreviewKind(jobKind)
          ? {}
          : stateSet(STATUS_OF[jobKind], outcome.status, outcome.message)),
        updatedAt: sql<Date>`now()`,
      })
      .where("id", "=", row.id)
      .execute();
    if (old.length === 0) return [];
    const deleted = await trx.deleteFrom("blobs").where("id", "in", old).returning("key").execute();
    return deleted.map((d) => d.key);
  }

  /**
   * Stores new derived blobs and swaps them in; the old ones go after the
   * commit. A STEP file's new mesh is followed by its preview (issue #316):
   * the preview-step job is sent in the same transaction and preview_status
   * is 'pending' until it is done, while derived_status says the mesh is ok
   * (issue #380), unless a newer replacement is queued, whose own conversion
   * will queue the preview of its mesh.
   */
  async function commitOutputs(
    jobKind: DerivedKind,
    file: ModelFile,
    source: Blob,
    replacing: boolean,
    outputs: readonly RenderOutput[],
    meshId?: string,
    selfJobId?: string,
  ): Promise<void> {
    const put: PutOutput[] = [];
    try {
      for (const out of outputs) {
        const id = uuidv7();
        const key = blobKey(file.modelId, id);
        // Streamed from the answer's file in the job's folder (runJob).
        const stored = await store.putBlob(createReadStream(out.path), {
          key,
          size: out.size,
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
        const row = await lockFor(trx, file, source, replacing, meshId);
        // The new renders are of the source the file has after the swap, so
        // a pending file has nothing earlier to explain.
        const outcome = await settledOutcome(
          trx,
          file.id,
          source.id,
          { status: "ok", message: null },
          null,
        );
        // A STEP file's new mesh replaces its old picture (swapIn clears
        // render_png_blob_id). The mesh's own status is ok, as in 0.1.0
        // (issue #380), and its picture's job is queued here, unless a newer
        // replacement is queued, whose own conversion will queue it.
        const previewNext = jobKind === DERIVED_KINDS.convertStep && outcome.status === "ok";
        oldKeys = await swapIn(trx, row, jobKind, source, replacing, put, outcome);
        if (previewNext) {
          const preview: DerivedJob = {
            kind: DERIVED_KINDS.previewStep,
            fileId: file.id,
            sourceBlobId: source.id,
          };
          const id = await deps.queue.send(QUEUE.slicer, preview, { ...retry, db: bossDb(trx) });
          if (id === null) throw new Error("pg-boss created no job");
        }
        await recomputePreview(trx, file.id, selfJobId);
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
   * Whether any of the job kind's derived blobs that row points at are
   * renders of a source earlier than sourceId. When replacing, every render
   * still attached is: a render of the staged source can only be attached
   * by the swap that makes it the file's source, so none can exist yet.
   * Otherwise each render row carries its own source's created_at (swapIn
   * stamps it), and one older than sourceId's row is from an earlier source.
   * The time a render row was written says nothing here: a render of an old
   * source can commit after a replacement was staged.
   */
  async function rendersPredate(
    trx: Transaction<DB>,
    row: Pick<ModelFile, DerivedColumn>,
    jobKind: DerivedKind,
    sourceId: string,
    replacing: boolean,
  ): Promise<boolean> {
    // Only the renders a failure keeps can be older than the source: a
    // preview of an earlier source is deleted when its render fails.
    const ids = KEPT_ON_FAILURE[jobKind]
      .map((c) => row[c])
      .filter((id): id is string => id !== null);
    if (ids.length === 0) return false;
    if (replacing) return true;
    const { rows } = await sql<{ older: boolean }>`
      select exists (
        select 1 from blobs d, blobs s
         where s.id = ${sourceId}
           and d.id in (${sql.join(ids)})
           and d.created_at < s.created_at
      ) as older
    `.execute(trx);
    return rows[0]?.older ?? false;
  }

  /**
   * message, after PREVIOUS_RENDERS_SENTENCE when any of the job kind's
   * renders the row points at are from a source earlier than the file's own
   * (row.blobId), so a later failure does not drop what the file shows
   * (issue #104). Read in trx with the file row locked.
   */
  async function keepingPrevious(
    trx: Transaction<DB>,
    row: Pick<ModelFile, "blobId" | DerivedColumn>,
    jobKind: DerivedKind,
    message: string,
  ): Promise<string> {
    const sentence = await previousSentence(trx, row, jobKind);
    return sentence === null ? message : `${sentence} ${message}`;
  }

  /**
   * PREVIOUS_RENDERS_SENTENCE when any of the job kind's renders the row
   * points at are from a source earlier than the file's own (row.blobId),
   * else null. It is the message a pending file carries (issue #146): while
   * a job is queued or running the file still shows those renders, so the
   * sentence stays until the job settles, instead of the message being
   * cleared. Read in trx with the file row locked.
   */
  async function previousSentence(
    trx: Transaction<DB>,
    row: Pick<ModelFile, "blobId" | DerivedColumn>,
    jobKind: DerivedKind,
  ): Promise<string | null> {
    return (await rendersPredate(trx, row, jobKind, row.blobId, false))
      ? PREVIOUS_RENDERS_SENTENCE_OF[jobKind]
      : null;
  }

  /**
   * The ids of the job kind's preview pictures (the columns a failure does
   * not keep) that row points at and that are of an earlier source than
   * sourceId: every one when replacing, else those whose row is older than
   * the source's (swapIn stamps a render row with its source's created_at).
   */
  async function earlierPreviews(
    trx: Transaction<DB>,
    row: Pick<ModelFile, DerivedColumn>,
    jobKind: DerivedKind,
    sourceId: string,
    replacing: boolean,
  ): Promise<{ columns: DerivedColumn[]; ids: string[] }> {
    const kept = KEPT_ON_FAILURE[jobKind];
    const columns = COLUMNS_OF_KIND[jobKind].filter((c) => !kept.includes(c) && row[c] !== null);
    if (columns.length === 0) return { columns: [], ids: [] };
    const ids = columns.map((c) => row[c] as string);
    if (replacing) return { columns, ids };
    const { rows } = await sql<{ id: string }>`
      select d.id from blobs d, blobs s
       where s.id = ${sourceId}
         and d.id in (${sql.join(ids)})
         and d.created_at < s.created_at
    `.execute(trx);
    const older = new Set(rows.map((r) => r.id));
    return {
      columns: columns.filter((c) => older.has(row[c] as string)),
      ids: ids.filter((id) => older.has(id)),
    };
  }

  /**
   * Stores the picture's status and message as previewState works them out
   * from the stored facts (issue #389): the file's source, the source its
   * stored picture was made from (counted only while render_png_blob_id
   * names a stored render_png blob of the same model), whether a picture
   * job for the current source is queued or running, and the newest failed
   * attempt. Every transaction that changes one of those facts calls this
   * before it commits, so the stored status is never a guess. selfJobId is
   * the job whose own transaction this is: pg-boss still holds it active
   * until the handler returns, but it is finishing, so it does not count as
   * live. Read and written with the file row locked.
   */
  async function recomputePreview(
    trx: Transaction<DB>,
    fileId: string,
    selfJobId?: string,
  ): Promise<void> {
    const row = await trx
      .selectFrom("files")
      .select([
        "id",
        "modelId",
        "kind",
        "blobId",
        "renderPngBlobId",
        "previewSourceBlobId",
        "previewFailureSourceBlobId",
        "previewFailureMessage",
      ])
      .where("id", "=", fileId)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) return;
    let pictureSourceBlobId: string | null = null;
    if (row.renderPngBlobId !== null && row.previewSourceBlobId !== null) {
      const png = await trx
        .selectFrom("blobs")
        .select("id")
        .where("id", "=", row.renderPngBlobId)
        .where("modelId", "=", row.modelId)
        .where("kind", "=", "render_png")
        .where("state", "=", "stored")
        .executeTakeFirst();
      if (png !== undefined) pictureSourceBlobId = row.previewSourceBlobId;
    }
    const previewJobLive = (await jobsOfFile(trx, row.id)).some(
      (j) =>
        j.id !== selfJobId &&
        LIVE_STATES.has(j.state) &&
        isPreviewKind(j.data?.kind) &&
        j.data?.sourceBlobId === row.blobId,
    );
    const state = previewState({
      kind: row.kind,
      sourceBlobId: row.blobId,
      pictureSourceBlobId,
      previewJobLive,
      failureSourceBlobId: row.previewFailureSourceBlobId,
      failureMessage: row.previewFailureMessage,
    });
    await trx
      .updateTable("files")
      .set({ previewStatus: state.status, previewMessage: state.message })
      .where("id", "=", row.id)
      .execute();
  }

  /** The set() that records a failed picture attempt for a source (a fact; issue #389). */
  function pictureFailure(sourceBlobId: string, message: string) {
    return { previewFailureSourceBlobId: sourceBlobId, previewFailureMessage: message };
  }

  /** The file row's source and render columns, locked for the pending write that follows. */
  async function lockedRenders(
    trx: Transaction<DB>,
    fileId: string,
  ): Promise<Pick<ModelFile, "blobId" | DerivedColumn> | undefined> {
    return trx
      .selectFrom("files")
      .select(["blobId", "renderStlBlobId", "renderPngBlobId", "meshBlobId"])
      .where("id", "=", fileId)
      .forUpdate()
      .executeTakeFirst();
  }

  /**
   * Records a render or conversion error with the program's message. A
   * replacement the program rejects still becomes the file's source as
   * uploaded (the maintainer, issue #103): the file is pointed at it and the old
   * source's row deleted in one transaction, and the old source's object
   * after the commit. A .scad's STL and PNG and a STEP file's mesh are left
   * as they are, so the file keeps showing the previous version's renders
   * until a render succeeds. When the renders it shows are from an earlier
   * source, the message starts with a sentence saying so
   * (previousRendersScad or previousRendersStep), then gives the program's
   * own words. A preview picture of an earlier source (an STL's, or the one
   * made from a STEP file's previous mesh) is deleted instead, row in the
   * transaction and object after it (issue #316), so the card shows the
   * file-type icon rather than a picture of another file.
   */
  async function commitRenderError(
    jobKind: DerivedKind,
    file: ModelFile,
    source: Blob,
    replacing: boolean,
    programMessage: string,
    meshId?: string,
    selfJobId?: string,
  ): Promise<void> {
    let oldKeys: string[] = [];
    await db.transaction().execute(async (trx) => {
      const row = await lockFor(trx, file, source, replacing, meshId);
      // After this write the file's source is source (the rejected one), and
      // its kept renders stay as they are.
      const predate = await rendersPredate(trx, row, jobKind, source.id, replacing);
      const lead = PREVIOUS_RENDERS[jobKind];
      const message = predate && lead !== null ? `${lead} ${programMessage}` : programMessage;
      const dropped = await earlierPreviews(trx, row, jobKind, source.id, replacing);
      const outcome = await settledOutcome(
        trx,
        file.id,
        source.id,
        { status: "failed", message },
        predate ? PREVIOUS_RENDERS_SENTENCE_OF[jobKind] : null,
      );
      const cleared: Partial<Record<DerivedColumn, null>> = {};
      for (const c of dropped.columns) cleared[c] = null;
      await trx
        .updateTable("files")
        .set({
          ...(replacing
            ? {
                blobId: source.id,
                size: source.size ?? 0,
                sha256: source.sha256 ?? Buffer.alloc(0),
              }
            : {}),
          ...cleared,
          // An earlier picture that is dropped takes its source with it.
          ...(dropped.columns.includes("renderPngBlobId") ? { previewSourceBlobId: null } : {}),
          // A picture job records its failed attempt for the source (now the
          // file's, when it was a replacement) and its status follows from
          // that (issue #389); a render or a mesh writes its own status.
          ...(isPreviewKind(jobKind)
            ? pictureFailure(source.id, message)
            : stateSet(STATUS_OF[jobKind], outcome.status, outcome.message)),
          updatedAt: sql<Date>`now()`,
        })
        .where("id", "=", row.id)
        .execute();
      await recomputePreview(trx, row.id, selfJobId);
      const gone = [...(replacing ? [row.blobId] : []), ...dropped.ids];
      if (gone.length > 0) {
        const deleted = await trx
          .deleteFrom("blobs")
          .where("id", "in", gone)
          .returning("key")
          .execute();
        oldKeys = deleted.map((d) => d.key);
      }
    });
    await deleteQuietly(oldKeys);
  }

  /**
   * Records a final failure that is the slicer's or the store's, not the
   * file's (slicer_error, store_refused, temp_failed, or slicer_down or
   * store_down past its limit), with
   * message, while the file still has the source the job started from; a
   * replacement is dropped and the previous version kept. A file that
   * already shows 'ok' for the job's own source (renders for it committed,
   * though the job did not see the commit's answer) is left as it is. When
   * the renders the file keeps are from an earlier source than its own (a
   * replacement the program rejected), the message starts with the sentence
   * saying so (keepingPrevious; issue #104). For a picture job it records
   * the failed attempt instead, and only when the source was the file's
   * own; the picture's status then follows from the facts (issue #389).
   */
  async function commitSlicerError(
    jobKind: DerivedKind,
    file: ModelFile,
    source: Blob,
    replacing: boolean,
    message: string,
    selfJobId?: string,
  ): Promise<void> {
    await db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("files")
        .select([
          "id",
          "blobId",
          "derivedStatus",
          "renderStlBlobId",
          "renderPngBlobId",
          "meshBlobId",
        ])
        .where("id", "=", file.id)
        .where("blobId", "=", file.blobId)
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) return;
      if (isPreviewKind(jobKind)) {
        // A picture job records its failed attempt only for the file's own
        // source: a replacement that is not saved changes nothing about the
        // current source, so it never changes the picture's status (issue
        // #389). A picture of the current source stays ok either way.
        if (!replacing) {
          await trx
            .updateTable("files")
            .set({ ...pictureFailure(source.id, message), updatedAt: sql<Date>`now()` })
            .where("id", "=", row.id)
            .execute();
        }
        await recomputePreview(trx, row.id, selfJobId);
        return;
      }
      if (row.blobId === source.id && row.derivedStatus === "ok") return;
      // The file keeps its source and renders, so the sentence, when it
      // applies, goes before the failure or stands alone while pending.
      const sentence = await previousSentence(trx, row, jobKind);
      const outcome = await settledOutcome(
        trx,
        file.id,
        source.id,
        { status: "failed", message: sentence === null ? message : `${sentence} ${message}` },
        sentence,
      );
      await trx
        .updateTable("files")
        .set({
          ...stateSet(STATUS_OF[jobKind], outcome.status, outcome.message),
          updatedAt: sql<Date>`now()`,
        })
        .where("id", "=", row.id)
        .execute();
      await recomputePreview(trx, row.id, selfJobId);
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
    const id = await deps.queue.send(
      QUEUE.slicer,
      next,
      slicerSendOptions(
        next.kind,
        {
          ...retry,
          retryLimit: Math.max(0, attempt.retryLimit - attempt.retryCount),
          startAfter,
        },
        await convertExpiry(next.kind),
      ),
    );
    if (id === null) throw new Error("pg-boss created no job");
    console.warn(
      `derived: file ${job.fileId} waits for the ${outage}, asking again in ${startAfter} s: ${describe(error)}`,
    );
    return { status: "requeued", reason: OUTAGES[outage].reason };
  }

  /**
   * Runs one render or mesh job (the slicer queue's worker calls this).
   * Throws only to have pg-boss retry: before the last attempt, on a 409
   * busy, a lost connection, a store refusal that may pass (a 5xx, or a
   * throttled or timed-out request) or a preview picture's temp folder
   * that could not be written (TempFileError); or on an unexpected error
   * (a render's or a conversion's TempFileError among them), on any
   * attempt, with nothing recorded (the render check settles the file if
   * the last attempt fails that way). A slicer or a store that is down
   * sends the job again instead (waitOut).
   */
  async function runJob(
    job: DerivedJob,
    attempt: { retryCount: number; retryLimit: number; jobId?: string },
  ): Promise<DerivedOutcome> {
    const selfJobId = attempt.jobId;
    const kind = Object.hasOwn(FILE_KIND_OF, job.kind) ? FILE_KIND_OF[job.kind] : undefined;
    const file = isUuid(job.fileId) ? await repos.files.get(job.fileId) : undefined;
    const source = isUuid(job.sourceBlobId) ? await repos.blobs.get(job.sourceBlobId) : undefined;
    if (kind === undefined || file === undefined || file.kind !== kind) {
      return { status: "skipped", reason: "stale" };
    }
    // A picture job with nothing to do still finishes: its file's picture
    // status is worked out again without it, so a job for the current
    // source that found its mesh gone never leaves 'pending' behind.
    const staleOut = async (): Promise<DerivedOutcome> => {
      if (isPreviewKind(job.kind)) {
        await db.transaction().execute((trx) => recomputePreview(trx, file.id, selfJobId));
      }
      return { status: "skipped", reason: "stale" };
    };
    if (
      source === undefined ||
      source.kind !== "source" ||
      source.state !== "stored" ||
      source.modelId !== file.modelId
    ) {
      return staleOut();
    }
    // A STEP file's preview is made from the mesh stored for the source it
    // names, which must still be the file's: a replacement converted since
    // queues the preview of its own mesh, and this job has nothing to do.
    let mesh: Blob | undefined;
    if (job.kind === DERIVED_KINDS.previewStep) {
      if (file.blobId !== source.id || file.meshBlobId === null) return staleOut();
      mesh = await repos.blobs.get(file.meshBlobId);
      if (
        mesh === undefined ||
        mesh.kind !== "mesh_glb" ||
        mesh.state !== "stored" ||
        mesh.modelId !== file.modelId ||
        mesh.createdAt.getTime() < source.createdAt.getTime()
      ) {
        return staleOut();
      }
    }
    const meshId = mesh?.id;
    const replacing = file.blobId !== source.id;
    // A replacement older than the file's current source was overtaken by a
    // newer one that has landed already.
    if (replacing && !(await newerThan(source.id, file.blobId))) {
      await discardStaged(source.id);
      return staleOut();
    }

    // The job's own temp folder: every slicer answer is streamed to a file
    // here under its cap (client.ts, postRender) and stored from it, so no
    // answer is held in memory. It is removed when the job ends, however it
    // ends. One that cannot be made is a TempFileError (issue #415), which
    // the catch below decides like any other failure of the job.
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpDir, "render-")).catch((error: unknown) => {
        throw new TempFileError(error);
      });
      const size = source.size ?? 0;
      const target = await targetFor(job.kind);
      let outputs: RenderOutput[];
      switch (job.kind) {
        case DERIVED_KINDS.renderScad:
          outputs = await renderScadOutputs(target, size, () => readAll(source.key), dir);
          break;
        case DERIVED_KINDS.convertStep:
          outputs = await convertStepOutputs(
            target,
            () => store.getBlobStream(source.key),
            size,
            dir,
          );
          break;
        case DERIVED_KINDS.renderStl:
          outputs = await stlPreviewOutputs(
            target,
            () => store.getBlobStream(source.key),
            size,
            dir,
          );
          break;
        case DERIVED_KINDS.previewStep: {
          // The mesh is read only under the memory gate, shared with the
          // plate mesh builds (memory/gate.ts), run first so it waits
          // for the one job running and no more. The gate is asked for
          // before anything is sent to the slicer and let go before the STL
          // is sent (preview.ts), so the preview never holds the slicer
          // while it waits. The file may have changed while it waited, so
          // the mesh is checked again inside the gate: a mesh that is no
          // longer the file's is Superseded and the job has nothing to do.
          const meshKey = mesh?.key ?? "";
          outputs = await meshPreviewOutputs(target, {
            size: mesh?.size ?? null,
            read: () => readAll(meshKey),
            hold: (task) =>
              gate.run(
                `step-preview:${selfJobId ?? uuidv7()}`,
                async () => {
                  const now = await repos.files.get(file.id);
                  if (now === undefined || now.blobId !== source.id || now.meshBlobId !== meshId) {
                    throw new Superseded();
                  }
                  return task();
                },
                staying,
                { first: true },
              ),
            dir,
          });
          break;
        }
      }
      await commitOutputs(job.kind, file, source, replacing, outputs, meshId, selfJobId);
      return { status: "ok" };
    } catch (error) {
      if (error instanceof Superseded) {
        if (replacing) await discardStaged(source.id);
        return staleOut();
      }
      // A slicer or a store that is down: not the file's doing and not a
      // retry. Nothing is recorded, and the previous version of a
      // replacement stays until it renders, unless the outage has lasted
      // past the job's deadline, which ends the render.
      // The slicer's sandbox is off: recorded once with its real reason, no
      // wait and no retry. requeueSandboxOff and the preview backfill pick
      // the file up again when the slicer says the sandbox is on.
      if (error instanceof SandboxOff) {
        await commitSlicerError(
          job.kind,
          file,
          source,
          replacing,
          sandboxMessage(SANDBOX_KIND[job.kind], error.reason),
          selfJobId,
        );
        console.error(`derived: file ${file.id} ended with sandbox_off: ${describe(error)}`);
        return { status: "failed", reason: "sandbox_off" };
      }
      const outage = outageOf(error);
      if (outage !== null) {
        if (!pastDeadline(job)) return waitOut(job, attempt, outage, error);
        const { reason, message, replaceMessage, previewMessage } = OUTAGES[outage];
        await commitSlicerError(
          job.kind,
          file,
          source,
          replacing,
          isPreviewKind(job.kind) ? previewMessage : replacing ? replaceMessage : message,
          selfJobId,
        );
        console.error(
          `derived: file ${file.id} stopped waiting for the ${outage} after its deadline ${job.waitDeadline}: ${describe(error)}`,
        );
        return { status: "failed", reason };
      }
      if (error instanceof RenderFailed) {
        try {
          await commitRenderError(
            job.kind,
            file,
            source,
            replacing,
            error.message,
            meshId,
            selfJobId,
          );
        } catch (recordError) {
          // Decided before any write, so nothing committed: the staged
          // source goes, as when renders are overtaken (above).
          if (recordError instanceof Superseded) {
            if (replacing) await discardStaged(source.id);
            return staleOut();
          }
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
          job.kind,
          file,
          source,
          replacing,
          replacing ? DERIVED_MESSAGES.replaceStoreRefused : DERIVED_MESSAGES.storeRefused,
          selfJobId,
        );
        console.error(`derived: file ${file.id} ended with store_refused: ${describe(error)}`);
        return { status: "failed", reason: "store_refused" };
      }
      // The job could not write in its own temp folder: a full disk, or a
      // read-only or missing TMP_DIR, which says nothing about the file or
      // the slicer (issue #415). pg-boss retries it; once the last attempt
      // has failed, a preview picture records a sentence the backfill tries
      // again, where it would otherwise end as a render that did not finish,
      // which is never tried again. A .scad render or a STEP conversion has
      // no backfill, so for them it goes on below as before.
      if (error instanceof TempFileError && isPreviewKind(job.kind)) {
        if (!last) throw error;
        await commitSlicerError(
          job.kind,
          file,
          source,
          replacing,
          DERIVED_MESSAGES.previewTempFailed,
          selfJobId,
        );
        console.error(`derived: file ${file.id} ended with temp_failed: ${describe(error)}`);
        return { status: "failed", reason: "temp_failed" };
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
        job.kind,
        file,
        source,
        replacing,
        replacing ? DERIVED_MESSAGES.replaceFailed : DERIVED_MESSAGES.slicerError,
        selfJobId,
      );
      console.error(`derived: file ${file.id} ended with slicer_error: ${describe(error)}`);
      return { status: "failed", reason: "slicer_error" };
    } finally {
      // The slicer's answers and the preview's STL, stored or not.
      if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
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
    // Only a STEP file's job carries an expiry, so only it waits on health.
    const known = await repos.files.get(fileId);
    const expiry = await convertExpiry(
      known !== undefined && hasDerived(known.kind)
        ? JOB_KIND_OF[known.kind]
        : DERIVED_KINDS.renderScad,
    );
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
      const id = await deps.queue.send(
        QUEUE.slicer,
        job,
        slicerSendOptions(job.kind, { ...retry, db: bossDb(trx) }, expiry),
      );
      if (id === null) throw new Error("pg-boss created no job");
      return true;
    });
  }

  /**
   * Issue #90: a file whose render or mesh is still 'pending' with no queued
   * or active job of the kinds that write derived_status, and whose newest
   * such job ended failed: its last attempt died before it recorded an
   * outcome. It is marked failed and not queued again, so a file that kills
   * the slicer cannot loop. When the renders it keeps are from an earlier
   * source than its own, the message starts with the sentence saying so
   * (keepingPrevious; issue #104). A picture is settleLostPicture's. Returns
   * whether it marked one.
   */
  async function settleLost(fileId: string, modelId: string): Promise<boolean> {
    return db.transaction().execute(async (trx) => {
      if (!(await lockModel(trx, modelId, false))) return false;
      const row = await trx
        .selectFrom("files")
        .select(["id", "blobId", "kind", "renderStlBlobId", "renderPngBlobId", "meshBlobId"])
        .where("id", "=", fileId)
        .where("derivedStatus", "=", "pending")
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) return false;
      // Only the jobs that write derived_status (issue #380): a STEP file's
      // picture job says nothing about its mesh.
      const jobs = (await jobsOfFile(trx, row.id)).filter((j) => {
        const kind = j.data?.kind;
        return Object.hasOwn(STATUS_OF, kind) && STATUS_OF[kind] === DERIVED_STATE;
      });
      if (jobs.some((j) => LIVE_STATES.has(j.state))) return false;
      const last = jobs.at(-1);
      if (last === undefined || last.state !== "failed") return false;
      const replacing = last.data?.sourceBlobId !== row.blobId;
      const lost = replacing ? DERIVED_MESSAGES.replaceLost : DERIVED_MESSAGES.renderLost;
      await trx
        .updateTable("files")
        .set({
          ...stateSet(
            DERIVED_STATE,
            "failed",
            await keepingPrevious(trx, row, last.data.kind, lost),
          ),
          updatedAt: sql<Date>`now()`,
        })
        .where("id", "=", row.id)
        .execute();
      await recomputePreview(trx, row.id);
      return true;
    });
  }

  /**
   * Issue #389: a picture still 'pending' when no picture job for the file's
   * current source is queued or running. Its status is worked out again
   * from the facts (recomputePreview), after one more fact is recorded when
   * the newest picture job for the current source ended failed: its last
   * attempt died before it recorded an outcome, which is how a file that
   * crashes or hangs the slicer ends, so it is a failed attempt with
   * DERIVED_MESSAGES.renderLost, which the backfill does not queue again
   * (issue #90). A picture job for a replacement that is not saved says
   * nothing about the current source, so it records nothing. Returns
   * whether the status changed.
   */
  async function settleLostPicture(fileId: string, modelId: string): Promise<boolean> {
    return db.transaction().execute(async (trx) => {
      if (!(await lockModel(trx, modelId, false))) return false;
      const row = await trx
        .selectFrom("files")
        .select(["id", "blobId"])
        .where("id", "=", fileId)
        .where("previewStatus", "=", "pending")
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) return false;
      const ofSource = (await jobsOfFile(trx, row.id)).filter(
        (j) => isPreviewKind(j.data?.kind) && j.data?.sourceBlobId === row.blobId,
      );
      if (ofSource.some((j) => LIVE_STATES.has(j.state))) return false;
      if (ofSource.at(-1)?.state === "failed") {
        await trx
          .updateTable("files")
          .set({
            ...pictureFailure(row.blobId, DERIVED_MESSAGES.renderLost),
            updatedAt: sql<Date>`now()`,
          })
          .where("id", "=", row.id)
          .execute();
      }
      await recomputePreview(trx, row.id);
      const after = await trx
        .selectFrom("files")
        .select("previewStatus")
        .where("id", "=", row.id)
        .executeTakeFirstOrThrow();
      return after.previewStatus !== "pending";
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
   * - a pending render or mesh whose newest job ended failed is marked
   *   failed with DERIVED_MESSAGES.renderLost (replaceLost for a
   *   replacement), and is not queued again;
   * - a pending picture with no picture job for the current source queued
   *   or running is worked out again from the facts, with a died job for
   *   the current source recorded as a failed attempt (settleLostPicture);
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

    // Not an STL: one with no status is the preview backfill's, which
    // queues it in batches (backfillPreviews), since every STL stored before
    // previews existed has no status either.
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

    // A render or a mesh left pending by a job that died (issue #90), and a
    // picture left pending with no live job for its current source (each
    // pair of status columns on its own, issues #380 and #389).
    const pendingOn = (status: "derivedStatus" | "previewStatus") =>
      db
        .selectFrom("files as f")
        .innerJoin("models as m", "m.id", "f.modelId")
        .select(["f.id", "f.modelId"])
        .where(`f.${status}`, "=", "pending")
        .where("f.updatedAt", "<", cutoff)
        .where("m.purgeStartedAt", "is", null)
        .orderBy("f.updatedAt")
        .execute();
    for (const f of await pendingOn("derivedStatus")) {
      await attempt("file", () => settleLost(f.id, f.modelId), result.failed, f.id);
    }
    const pictures: string[] = [];
    for (const f of await pendingOn("previewStatus")) {
      await attempt("picture", () => settleLostPicture(f.id, f.modelId), pictures, f.id);
    }
    if (pictures.length > 0) {
      console.info(
        `render check: settled ${pictures.length} preview picture(s) left pending with no live job`,
      );
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

  /**
   * The files the preview backfill takes, oldest first: an STL with no render
   * status (stored before previews existed, or one whose upload could not
   * queue its preview), and a STEP file whose mesh is stored and of its
   * current source, which has no preview, and whose conversion is settled:
   * ok, or failed once a replacement was dropped (PR #363 review: a mesh
   * that committed while a newer replacement was queued queues no picture,
   * and when that replacement then ends in commitSlicerError the file keeps
   * that mesh, derived_status 'failed' and no picture, and nothing else
   * would queue it). Never while pending: a conversion is queued or
   * running, whose own commit queues the picture, and queueBackfill would
   * refuse the file for its live job anyway. Each in a
   * live model, written before cutoff (so an upload's own afterUpload has had
   * its turn). An STL or such a STEP file whose preview failed with one of
   * the PREVIEW_RETRIED sentences (a slicer or a store that stayed down, or a
   * job that could not be queued) is taken again too, once that failure was
   * written before cutoff, so an outage, or a slicer image older than the
   * app, does not leave it with no picture for good. A picture the slicer
   * refused because its sandbox is off (PREVIEW_SANDBOX_OFF) is taken the
   * same way, but only while sandboxOn says the slicer reports its sandbox
   * on, so nothing is queued to be refused again. The same test is made
   * again, holding the row's lock, before a file is queued, and the two must
   * agree, or a file the second test refuses would be picked every run and
   * hold a batch's place.
   */
  function backfillCandidates(cutoff: Date, sandboxOn: boolean) {
    // The picture's own status (issues #380 and #389): none, which is
    // exactly "no picture of the current source and nothing pending or
    // failed", or a failure that is tried again. A STEP file's mesh must be
    // stored and of its current source, and its conversion settled (ok, or
    // failed after a dropped replacement); the EXISTS test, not the status,
    // is what says the mesh is of the current source.
    const retried = sql`(f.preview_status = 'failed'
           and f.preview_message in (${sql.join(sandboxOn ? [...PREVIEW_RETRIED, ...PREVIEW_SANDBOX_OFF] : PREVIEW_RETRIED)})
           and f.updated_at < ${cutoff})`;
    const noPicture = sql`(f.preview_status is null or ${retried})`;
    return sql`
      select f.id, f.model_id as "modelId", f.kind, f.blob_id as "blobId",
             f.created_at as "createdAt"
        from files f
        join models m on m.id = f.model_id
       where m.trashed_at is null and m.purge_started_at is null
         and f.created_at < ${cutoff}
         and (
           (f.kind = 'stl' and ${noPicture})
           or (f.kind = 'step' and f.derived_status in ('ok', 'failed') and ${noPicture}
               and exists (
                 select 1 from blobs mb, blobs sb
                  where mb.id = f.mesh_blob_id and mb.kind = 'mesh_glb'
                    and mb.state = 'stored' and mb.model_id = f.model_id
                    and sb.id = f.blob_id and mb.created_at >= sb.created_at))
         )
    `;
  }

  /**
   * Queues one file's preview for the backfill, with its status, in one
   * transaction, once its row (locked) still passes backfillCandidates and
   * no job of the file is queued or running. Returns whether it queued one.
   */
  async function queueBackfill(
    fileId: string,
    modelId: string,
    cutoff: Date,
    sandboxOn: boolean,
  ): Promise<boolean> {
    return db.transaction().execute(async (trx) => {
      if (!(await lockModel(trx, modelId, true))) return false;
      const locked = await trx
        .selectFrom("files")
        .select("id")
        .where("id", "=", fileId)
        .forUpdate()
        .executeTakeFirst();
      if (locked === undefined) return false;
      const { rows } = await sql<{ id: string; kind: FileKind; blobId: string }>`
        select c.id, c.kind, c."blobId" from (${backfillCandidates(cutoff, sandboxOn)}) c
         where c.id = ${fileId}
      `.execute(trx.withoutPlugins());
      const row = rows[0];
      if (row === undefined) return false;
      if ((await jobsOfFile(trx, row.id)).some((j) => LIVE_STATES.has(j.state))) return false;
      const job: DerivedJob = {
        kind: row.kind === "stl" ? DERIVED_KINDS.renderStl : DERIVED_KINDS.previewStep,
        fileId: row.id,
        sourceBlobId: row.blobId,
        backfill: true,
      };
      const id = await deps.queue.send(QUEUE.slicer, job, { ...retry, db: bossDb(trx) });
      if (id === null) throw new Error("pg-boss created no job");
      // Pending from now on, because of the job just queued.
      await trx
        .updateTable("files")
        .set({ updatedAt: sql<Date>`now()` })
        .where("id", "=", row.id)
        .execute();
      await recomputePreview(trx, row.id);
      return true;
    });
  }

  /**
   * The preview backfill (issue #316), a maintenance task run at startup and
   * every BACKFILL_PREVIEWS_CRON (jobs/queues.ts): STL and STEP files stored
   * before previews existed get one. A STEP file's preview is made from its
   * stored mesh, never by converting it again. It respects the slicer's one
   * job at a time: it queues at most one batch (backfillBatch, BACKFILL_BATCH
   * by default) of preview jobs on the singleton slicer queue, and nothing
   * while any job of an earlier batch is still waiting, so an upload or a
   * slice waits behind at most one batch. It is safe to run twice, at once
   * or later: each file is queued in a transaction holding its row, only
   * while it has no status (an STL) or no preview (a STEP file), or a
   * preview that failed with a PREVIEW_RETRIED sentence, and no job, and a
   * queued file is 'pending' from then on. Once every file has a preview or
   * a failure that is not retried, a run finds nothing and queues nothing.
   * A file that fails is logged and left for the next run; the others go on.
   */
  async function backfillPreviews(now: Date): Promise<BackfillResult> {
    const result: BackfillResult = { queued: [] };
    const waiting = await deps.queue.findJobs<DerivedJob>(QUEUE.slicer, {
      data: { backfill: true },
      queued: true,
    });
    if (waiting.length > 0) return result;
    const cutoff = new Date(now.getTime() - RENDER_CHECK_GRACE_MS);
    const limit = deps.backfillBatch ?? BACKFILL_BATCH;
    const sandboxOn = (await deps.slicerState?.current())?.sandbox?.state === "on";
    const { rows } = await sql<{ id: string; modelId: string }>`
      select c.id, c."modelId" from (${backfillCandidates(cutoff, sandboxOn)}) c
       order by c."createdAt", c.id
       limit ${limit}
    `.execute(db.withoutPlugins());
    for (const f of rows) {
      try {
        if (await queueBackfill(f.id, f.modelId, cutoff, sandboxOn)) result.queued.push(f.id);
      } catch (error) {
        console.error(`preview backfill: file ${f.id} left for the next run: ${describe(error)}`);
      }
    }
    if (result.queued.length > 0) {
      console.info(`preview backfill: queued ${result.queued.length} preview(s)`);
    }
    return result;
  }

  /**
   * Queues again the renders and STEP conversions the slicer refused because
   * its sandbox was off, once its health says they can run: .scad files only
   * when the sandbox is on, STEP files also when it is off but the slicer
   * allows conversions without it. A slicer whose sandbox state is unknown
   * (no health answer, an older contract) or still being checked queues
   * nothing. At most one batch (backfillBatch, BACKFILL_BATCH by default) per
   * run, oldest first, each through queueFor, which marks the file pending,
   * so a second run finds nothing until a job is refused again. Pictures
   * are the preview backfill's (backfillPreviews). Returns how many it queued.
   */
  async function requeueSandboxOff(_now: Date): Promise<number> {
    const sandbox = (await deps.slicerState?.current())?.sandbox ?? null;
    if (sandbox === null) return 0;
    const scad = sandbox.state === "on";
    const step = scad || (sandbox.state === "off" && sandbox.allowUnsandboxed);
    if (!scad && !step) return 0;
    const ends = (messages: readonly string[]) =>
      sql.join(
        messages.map((m) => sql`right(f.derived_message, ${m.length}) = ${m}`),
        sql` or `,
      );
    const kinds = [
      ...(scad
        ? [
            sql`(f.kind = 'scad' and (${ends([DERIVED_MESSAGES.sandboxOffKernel, DERIVED_MESSAGES.sandboxOffCheck])}))`,
          ]
        : []),
      ...(step
        ? [
            sql`(f.kind = 'step' and (${ends([DERIVED_MESSAGES.convertSandboxOffKernel, DERIVED_MESSAGES.convertSandboxOffCheck])}))`,
          ]
        : []),
    ];
    const { rows } = await sql<{ id: string; kind: DerivableKind }>`
      select f.id, f.kind
        from files f
        join models m on m.id = f.model_id
       where m.trashed_at is null and m.purge_started_at is null
         and f.derived_status = 'failed'
         and (${sql.join(kinds, sql` or `)})
       order by f.created_at, f.id
       limit ${deps.backfillBatch ?? BACKFILL_BATCH}
    `.execute(db.withoutPlugins());
    let queued = 0;
    for (const f of rows) {
      try {
        await queueFor(f.id, f.kind);
        queued += 1;
      } catch (error) {
        console.error(`sandbox requeue: file ${f.id} left for the next run: ${describe(error)}`);
      }
    }
    if (queued > 0) console.info(`sandbox requeue: queued ${queued} file(s)`);
    return queued;
  }

  return {
    renderScad,
    convertStep,
    renderStl,
    replaceFile,
    afterUpload,
    runJob,
    checkRenders,
    backfillPreviews,
    requeueSandboxOff,
  };
}

export type Derived = ReturnType<typeof createDerived>;

/**
 * The render and mesh entries for the slicer queue's handler map (QueueDeps.slicerJobs):
 * the render and mesh kinds, each running runJob with the job's retry count
 * and limit, so the last attempt records slicer_error. Spread beside the
 * estimates module's "slice" entry: { ...derivedJobHandlers(derived), slice: ... }.
 */
export function derivedJobHandlers(derived: Pick<Derived, "runJob">): SlicerJobHandlers {
  const handle: SlicerJobHandlers[string] = (job) =>
    derived.runJob(job.data as unknown as DerivedJob, {
      retryCount: job.retryCount,
      retryLimit: job.retryLimit,
      jobId: job.id,
    });
  return {
    [DERIVED_KINDS.renderScad]: handle,
    [DERIVED_KINDS.convertStep]: handle,
    [DERIVED_KINDS.renderStl]: handle,
    [DERIVED_KINDS.previewStep]: handle,
  };
}
