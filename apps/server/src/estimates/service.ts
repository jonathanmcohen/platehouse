// Estimates, the printer setting and re-estimation (build plan Task 12;
// AC-031 to AC-034, AC-036; Review Focus 2 and 3).
//
// - The printer menu is /v1/profiles' printer list, read once per Orca
//   version (listPrinters). My printers (migration 0007) are the printers
//   the user owns, picked from that menu, in their order; one of them is the
//   default (settings.printer_id, P1S 0.4 on a fresh database). Every
//   estimate is made for each of My printers, not just the default.
// - A Platehouse estimate is queued for a plate and printer only when its
//   file has no numbers of its own for that printer: the file's
//   slicedFor.printerModelId and nozzle matched against the menu printer's
//   modelId and nozzle (enqueuePlate). A new file's plates are queued for
//   every printer, the default first, ahead of library-wide work
//   (SLICE_PRIORITY). Library-wide work also goes behind the render and mesh
//   jobs (derived.ts) that share the slicer queue.
// - Adding a printer (savePrinters) queues every live plate for it, behind
//   any upload. The slicer does one plate at a time, so on a large library
//   this is hours of work. Removing a printer cancels its queued slice jobs
//   and deletes its waiting estimates; its finished estimates stay, so a
//   plate can show them as made for a printer no longer listed until the
//   new default's land (display.ts). Reordering, or a new default, slices
//   nothing, and neither does reading numbers for another printer
//   (plateNumbers with a printerId: the pages' printer switch).
// - Each estimate is one job on the singleton slicer queue (Task 8), so one
//   slice runs at a time. A 409 busy or a lost connection uses one of 3
//   retries (SLICER_RETRY), with backoff; once the last retry is used the
//   estimate fails with slicer_error. A busy answer is retried by pg-boss
//   itself. A lost connection is retried as a new job, after the same
//   backoff, so that its job data can count the connections lost: pg-boss
//   keeps a job's data unchanged over its own retries. The retries and lost
//   connections an estimate used are carried in its job data, an outage's
//   requeue included, so a new job never starts a fresh count. Any other
//   answer that is not a result fails it at once with slicer_error. A result
//   is recorded as it came: numbers, or the slicer's own reason (Orca codes
//   the slicer reports as slicer_error stay slicer_error).
// - An outage uses no retry: a slicer that takes no connection at all (down
//   or restarting, so it never saw the plate), or a store that cannot be
//   reached or that drops the read while the file is being sent. The job waits for it, holding the queue's one slot so the plates
//   behind it do not spend their retries on the same outage, then slices
//   again. When it is still down after the wait, the plate goes back on the
//   queue as a new job, at most 3 times (SLICER_DOWN_WAIT.requeues), and each
//   requeue is logged. After that the plate fails with slicer_error, so it
//   never shows "estimating" forever, and the Orca poll queues it again once
//   /v1/health answers (and, for a store outage, once the store answers). A
//   connection that was made and then lost still uses a retry, since a plate
//   that crashes the slicer looks like that, and such a plate must end failed
//   rather than loop: one that had lost a connection before a slicer outage
//   fails with a detail the poll does not queue again. Only lost connections
//   count for that; a busy answer or an expired job does not (issue #75).
// - When a printer leaves My printers its queued slice jobs are cancelled
//   and its waiting estimates deleted; a slice already running finishes and
//   is kept, labelled with its printer. A job that starts after its printer
//   left the list drops itself. setPrinter, the one-printer case, swaps the
//   whole list for one printer, as the single printer setting did: every
//   live plate is queued for it, and until its estimate lands the plate
//   shows its newest older estimate, marked as made for the previous
//   printer (display.ts).
// - The Orca-version poll runs at startup and every 10 minutes (a pg-boss
//   cron job, Task 8's maintenance queue). When /v1/health.orca differs from
//   settings.last_orca_version it stores the new version and re-estimates
//   every live plate. Every poll also finds slices that were lost (a job gone
//   while its estimate still says pending or running, as after the app itself
//   stopped mid-slice): a running one fails with slicer_error, a pending one
//   is queued again. It queues again the plates an outage failed (above).
//   Then it queues any live plate that still has no estimate, so a plate
//   whose queueing failed at upload is not left out. A plate whose file
//   carries its own numbers for a printer is never fetched for that printer
//   (libraryPlatesFor), so a library of files sliced for My printers costs
//   the poll one query per printer, not two per plate.
// - Each slice records the Orca version that produced it (AC-036) and, for
//   each filament, the preset the slicer used and where it came from:
//   Bambu's own, Generic, or the file's own filament (PR #55).
import { setTimeout as sleep } from "node:timers/promises";
import type { Printer, Profiles, SliceOk } from "@platehouse/slicer-contract";
import { type Kysely, sql } from "kysely";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import { isUuid } from "../db/ids.js";
import { inTransaction } from "../db/kysely.js";
import type { DB } from "../db/types.js";
import { QUEUE, SLICER_RETRY, type SlicerJob, type SlicerJobHandlers } from "../jobs/queues.js";
import type { Estimate } from "../repos/estimates.js";
import { createRepos, type Repos } from "../repos/index.js";
import { PrintersChanged } from "../repos/settings.js";
import { type BlobStore, StoreUnavailable } from "../storage/s3.js";
import {
  SliceBodyUnreadable,
  SlicerBusy,
  type SlicerClient,
  SlicerRefused,
  SlicerUnreachable,
  sliceTimeoutMs,
} from "./client.js";
import {
  type DisplayContext,
  NOZZLE_TOLERANCE,
  PLATEHOUSE_SLICER,
  type PlateNumbers,
  plateNumbers,
  platesWithoutNumbers,
  printerForFile,
  profileSourceOf,
} from "./display.js";
import { RATE_SAMPLE, sliceRate } from "./rate.js";

export const SLICE_JOB_KIND = "slice";

/** A slice job's data: the estimate it fills, and the printer, for cancelling. */
export interface SliceJobData {
  kind: typeof SLICE_JOB_KIND;
  estimateId: string;
  printerId: string;
  /** Retries the estimate's earlier jobs used, carried over a requeue. */
  retriesUsed?: number;
  /** How many times an outage has put the estimate back on the queue. */
  requeues?: number;
  /**
   * Connections the slicer accepted and then lost, in the estimate's earlier
   * jobs: a SlicerUnreachable that is not neverConnected. Only this count,
   * never retriesUsed, makes a slicer outage fail with DOWN_AFTER_LOST_DETAIL.
   */
  lostConnections?: number;
}

/** What a slice job carries over to the next job of the same estimate. */
type Carried = Required<Pick<SliceJobData, "retriesUsed" | "requeues" | "lostConnections">>;

/** Why every live plate is being looked at: logged, nothing else. */
export type ReestimateReason = "printer" | "orca" | "startup" | "poll";

export class UnknownPrinter extends Error {
  constructor() {
    super("That printer is not in the slicer's printer list");
    this.name = "UnknownPrinter";
  }
}

/** Most printers My printers holds: far more than anyone owns, and a bound on the work. */
export const MAX_MY_PRINTERS = 20;

export { PrintersChanged };

/** Why a new My printers list was refused; message is a sentence for the page. */
export class PrinterListRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrinterListRefused";
  }
}

/**
 * Slice job priorities. pg-boss starts the queued job with the highest
 * priority first, then the oldest. A plate someone is waiting on (a new
 * upload, or a Retry pressed on the page) goes ahead of library-wide work
 * (a printer just added, an Orca update, the poll's catch-up), so an upload
 * still gets its numbers in minutes while hours of re-estimation queue.
 * Library work is below 0, pg-boss's default, because the render and mesh
 * jobs (derived.ts) share the slicer queue and are sent with that default:
 * a new .scad or STEP file's STL, preview or mesh then runs ahead of a
 * backfill too, not after it (PR #240 review).
 */
export const SLICE_PRIORITY = Object.freeze({ waiting: 1, library: -1 });

/**
 * A job waiting in the slicer queue: a slice carries its printer and
 * estimate, a render or mesh job (derived.ts) neither.
 */
export interface QueuedWork {
  id: string;
  printerId?: string;
  estimateId?: string;
  priority: number;
  createdOn: Date;
}

/**
 * For each printer with slices queued, how many slices run up to and
 * including its last one: the slices already running (ahead of everything),
 * then the queued slices in the order pg-boss starts them, highest priority
 * first, then oldest. There is one slicer queue and it runs one slice at a
 * time for every printer, so this, not a printer's own count, is what its
 * waiting plates take. A render or mesh job on the same queue (no printerId)
 * takes its place like a slice but gives no printer a figure. Jobs waiting
 * out a retry delay are counted where they sit; a page's figure is "about".
 * An estimate with more than one job (an urgent copy of a library job, see
 * enqueue) is sliced once, by the first of them to run, so it counts once,
 * there.
 */
export function slicesThrough(
  jobs: ReadonlyArray<QueuedWork>,
  running: number,
): Map<string, number> {
  const order = [...jobs].sort(
    (a, b) =>
      b.priority - a.priority ||
      a.createdOn.getTime() - b.createdOn.getTime() ||
      a.id.localeCompare(b.id),
  );
  const through = new Map<string, number>();
  const seen = new Set<string>();
  let position = running;
  for (const job of order) {
    if (job.estimateId !== undefined) {
      if (seen.has(job.estimateId)) continue;
      seen.add(job.estimateId);
    }
    position += 1;
    if (job.printerId !== undefined) through.set(job.printerId, position);
  }
  return through;
}

/** One of My printers' place in the slicer queue. */
export interface PrinterQueue {
  /** Its plate estimates still queued or slicing, at the current Orca version. */
  waiting: number;
  /**
   * Slicer jobs that run up to and including its last waiting slice, across
   * every printer, renders and meshes included (slicesThrough); at least
   * waiting.
   */
  through: number;
}

/** What saving a new My printers list did. */
export interface SavedPrinters {
  /**
   * The printers added, each with how many plate estimates were queued for
   * it and how many slicer jobs run up to and including its last one
   * (through), the work already queued for other printers and the renders
   * ahead of it included.
   */
  added: Array<{ printerId: string; queued: number; through: number }>;
  /** The printers removed; their queued and waiting estimates were dropped. */
  removed: string[];
}

/**
 * Per-job overrides of the slicer queue's retry delay. The app leaves these
 * out and uses the queue's own (SLICER_RETRY); the tests shorten the delay.
 */
export interface SliceJobOptions {
  retryDelay?: number;
  retryDelayMax?: number;
}

/** How a slice job waits out an outage: a slicer that took no connection, or the store. */
export interface SlicerDownWait {
  /** Longest wait in one job before the plate goes back on the queue. */
  waitMs: number;
  /** How often /v1/health (or the store) is asked meanwhile. */
  pollMs: number;
  /** How many times the plate goes back on the queue before it fails. */
  requeues: number;
}

export interface EstimatesDeps {
  db: Kysely<DB>;
  boss: PgBoss;
  slicer: SlicerClient;
  store: Pick<BlobStore, "getBlobStream">;
  /**
   * The client's slice timeout (sliceTimeoutMs(SLICE_PLATE_SECONDS)); a job
   * may stay active this long plus a minute. 120 s plates when left out.
   */
  sliceTimeoutMs?: number;
  jobOptions?: SliceJobOptions;
  /** SLICER_DOWN_WAIT when left out; the tests shorten it. */
  slicerDown?: SlicerDownWait;
  log?: (line: string) => void;
}

export interface Estimates {
  /** The printer menu: every printer /v1/profiles lists. */
  listPrinters(): Promise<Printer[]>;
  /**
   * Replaces My printers with a new list and default (add, remove, reorder,
   * or a new default, in one call). Each added printer must be in the menu,
   * and every live plate is queued for it; each removed printer's queued
   * slices are cancelled and its waiting estimates deleted, while a slice of
   * it already running finishes and is kept. A reorder or a new default
   * starts no slicing. PrinterListRefused for a list that is empty, too
   * long, names a printer twice or leaves out the default; UnknownPrinter
   * for an added printer the menu lacks. version is the printersVersion the
   * caller built the save from (the Settings page sends the one it last
   * read): PrintersChanged, and nothing changes, when it is no longer the
   * stored one, because the list or the default changed since, so a page
   * open in another window cannot undo either. Without version the save is
   * still checked against the version read here, so two saves at once
   * cannot both act on the same old read.
   */
  savePrinters(patch: {
    printers: readonly string[];
    defaultId: string;
    version?: number;
  }): Promise<SavedPrinters>;
  /**
   * Makes printerId the only printer in My printers, and the default: the
   * one-printer case of savePrinters, as the printer setting was before My
   * printers.
   */
  setPrinter(printerId: string): Promise<void>;
  /**
   * Makes sure a Platehouse estimate exists and is queued for the plate,
   * printer and Orca version; null when the file's own numbers are for that
   * printer or the plate is not on a live model.
   */
  enqueuePlate(plateId: string, printerId: string, orcaVersion: string): Promise<Estimate | null>;
  /** Queues a newly ingested file's plates for each of My printers; returns how many were queued. */
  enqueueFile(fileId: string): Promise<number>;
  /**
   * Queues every live plate that has no estimate for one of My printers and
   * the current Orca version; returns how many were queued.
   */
  reestimateAll(reason: ReestimateReason): Promise<number>;
  /** Queues a failed estimate again, from the stored file: no re-upload. */
  retryEstimate(estimateId: string): Promise<boolean>;
  /** The Orca-version poll (startup and every 10 minutes). */
  pollOrca(): Promise<{ orca: string; changed: boolean }>;
  /**
   * Each of My printers' place in the slicer queue: its plate estimates
   * still queued or slicing for the current Orca version, and how many
   * slicer jobs run up to and including its last one, every printer's work
   * and the queued renders and meshes counted (one queue, one job at a
   * time). A printer with nothing waiting is left out.
   */
  queueByPrinter(): Promise<Map<string, PrinterQueue>>;
  /**
   * Plates the slicer finishes a minute, measured from the newest finished
   * Platehouse slices of any printer and Orca version (rate.ts sliceRate);
   * null while too few have finished (issue #317).
   */
  sliceRate(): Promise<number | null>;
  /**
   * A plate's numbers for printerId, or for the default printer when it is
   * left out. Reading numbers never queues a slice.
   */
  plateNumbers(plateId: string, printerId?: string): Promise<PlateNumbers>;
  /** The AC-032 query (display.ts), for printerId or the default printer. */
  platesWithoutNumbers(printerId?: string): Promise<string[]>;
  /** The slice job's handler. */
  runSliceJob(job: JobWithMetadata<SliceJobData>): Promise<void>;
  /** The slicer queue handlers to hand to startQueues. */
  slicerJobs: SlicerJobHandlers;
}

/** A failed estimate's detail is cut to the contract's length. */
const DETAIL_CHARS = 2000;

/** Most jobs read back when looking through the slicer queue. */
const JOB_PAGE = 100_000;

/**
 * Waiting out an outage: 30 s at most in one job, asking every 5 s, and the
 * plate back on the queue 3 times (the slicer queue's retry limit) before it
 * fails, so about 2 minutes of waits. A job may stay active for its slice
 * timeout plus 60 s, so the wait, a health check that times out (10 s) and a
 * full slice after it all fit.
 */
export const SLICER_DOWN_WAIT: SlicerDownWait = Object.freeze({
  waitMs: 30_000,
  pollMs: 5_000,
  requeues: SLICER_RETRY.retryLimit,
});

/**
 * The detail of a plate failed because the slicer took no connection all
 * the while it waited. The Orca poll queues such a plate again.
 */
export const SLICER_DOWN_DETAIL = "The slicer was not running all the while this plate waited.";

/**
 * The detail of a plate failed because its file could not be read from the
 * store. The Orca poll queues such a plate again once the store answers.
 */
export const STORE_DOWN_DETAIL = "The file could not be read from storage.";

/**
 * The detail of a plate failed by a slicer outage after it had already lost
 * a connection mid-slice (SliceJobData.lostConnections > 0). It is left out
 * of OUTAGE_DETAILS on purpose: a slicer that dies mid-slice may be dying on
 * this very plate, and queueing it again on every 10-minute Orca poll could
 * crash the slicer in a loop. The retry button still queues it.
 */
const DOWN_AFTER_LOST_DETAIL =
  "The slicer stopped during a slice of this plate and was not back in time.";

/** The failure details the Orca poll queues again once the outage is over. */
const OUTAGE_DETAILS = [SLICER_DOWN_DETAIL, STORE_DOWN_DETAIL];

function errorDetail(error: unknown): string {
  if (error instanceof SlicerBusy) return "The slicer stayed busy with other work.";
  if (error instanceof SlicerUnreachable)
    return `The slicer could not be reached: ${error.reason}.`;
  if (error instanceof SlicerRefused) return error.message;
  if (error instanceof StoreUnavailable || error instanceof SliceBodyUnreadable) {
    return STORE_DOWN_DETAIL;
  }
  return "The slice could not be run.";
}

/** Busy, or a connection made and then lost: worth another try, using a retry. */
function isRetryable(error: unknown): boolean {
  return error instanceof SlicerBusy || error instanceof SlicerUnreachable;
}

/** A connection the slicer accepted and then lost (or that timed out). */
function isLostConnection(error: unknown): boolean {
  return error instanceof SlicerUnreachable && !error.neverConnected;
}

/**
 * Whole seconds before a retry sent as a new job starts: the backoff pg-boss
 * itself uses for the job's retry settings (a doubling delay with jitter,
 * capped at retryDelayMax), for the retry numbered retry (1 for the first).
 */
function retryDelaySeconds(
  settings: Pick<JobWithMetadata, "retryDelay" | "retryBackoff" | "retryDelayMax">,
  retry: number,
): number {
  if (!settings.retryBackoff) return Math.max(settings.retryDelay, 1);
  const step = 2 ** Math.min(16, retry) / 2;
  const delay = Math.max(settings.retryDelay, 1) * (step + step * Math.random());
  return Math.ceil(Math.min(settings.retryDelayMax ?? delay, delay));
}

type Outage = "slicer" | "store";

/**
 * A slicer that took no connection, or a store that cannot be reached or
 * dropped the read mid-file: no retry is used, and a store fault is never
 * counted as a lost slicer connection.
 */
function outageOf(error: unknown): Outage | null {
  if (error instanceof SlicerUnreachable && error.neverConnected) return "slicer";
  if (error instanceof StoreUnavailable || error instanceof SliceBodyUnreadable) return "store";
  return null;
}

function isCount(value: unknown): boolean {
  return value === undefined || (Number.isInteger(value) && (value as number) >= 0);
}

function isSliceJob(data: unknown): data is SliceJobData {
  const d = data as Partial<SliceJobData> | null;
  return (
    d !== null &&
    typeof d === "object" &&
    d.kind === SLICE_JOB_KIND &&
    typeof d.estimateId === "string" &&
    isUuid(d.estimateId) &&
    typeof d.printerId === "string" &&
    isCount(d.retriesUsed) &&
    isCount(d.requeues) &&
    isCount(d.lostConnections)
  );
}

/**
 * The live plates the library re-estimate queues for printer and orca, in
 * file and plate order: those with no Platehouse estimate for them yet, and
 * whose file does not carry its own numbers for the printer's BBL model and
 * nozzle (the clause platesWithoutNumbers uses, matching printerForFile).
 * Such a plate never gets a Platehouse estimate for that printer, so
 * fetching it would only have enqueue skip it again on every Orca poll.
 */
export async function libraryPlatesFor(
  db: Kysely<DB>,
  printer: Printer,
  orca: string,
): Promise<string[]> {
  const { rows } = await sql<{ id: string }>`
    select p.id
    from plates p
    join files f on f.id = p.file_id
    join models m on m.id = f.model_id
    where m.trashed_at is null
      and not exists (
        select 1 from estimates e
        where e.plate_id = p.id and e.source = 'platehouse'
          and e.printer_id = ${printer.id} and e.slicer_version = ${orca}
      )
      and not exists (
        select 1 from estimates e
        where e.plate_id = p.id and e.source = 'file' and e.status = 'ok'
          and e.printer_model_id = ${printer.modelId}
          and abs(e.nozzle - ${printer.nozzle}::double precision) < ${NOZZLE_TOLERANCE}
      )
    order by f.created_at, f.id, p.index
  `.execute(db);
  return rows.map((r) => r.id);
}

export function createEstimates(deps: EstimatesDeps): Estimates {
  const { db, boss, slicer, store } = deps;
  const slicerDown = deps.slicerDown ?? SLICER_DOWN_WAIT;
  const log = deps.log ?? ((line: string) => console.error(`estimates: ${line}`));
  const repos: Repos = createRepos(db);
  const expireInSeconds = Math.ceil((deps.sliceTimeoutMs ?? sliceTimeoutMs(120)) / 1000) + 60;
  // pg-boss takes retryDelayMax on a job only beside retryBackoff: true, so
  // an override of the delay restates the queue's backoff (SLICER_RETRY).
  const retryOverrides =
    deps.jobOptions && Object.keys(deps.jobOptions).length > 0
      ? { ...deps.jobOptions, retryBackoff: SLICER_RETRY.retryBackoff }
      : {};

  // The /v1/profiles answer, kept until the poll sees another Orca version.
  let profilesCache: Profiles | null = null;

  async function profiles(): Promise<Profiles> {
    profilesCache ??= await slicer.profiles();
    return profilesCache;
  }

  async function listPrinters(): Promise<Printer[]> {
    return [...(await profiles()).printers];
  }

  /** settings.last_orca_version, or the slicer's version stored now if none is yet. */
  async function currentOrca(): Promise<string> {
    const stored = (await repos.settings.get()).lastOrcaVersion;
    if (stored !== null) return stored;
    const { orca } = await slicer.health();
    await repos.settings.update({ lastOrcaVersion: orca });
    return orca;
  }

  async function sendSlice(
    estimate: Estimate,
    priority: number,
    carried: Carried | null = null,
    startAfterSeconds?: number,
  ): Promise<void> {
    const data: SliceJobData = {
      kind: SLICE_JOB_KIND,
      estimateId: estimate.id,
      printerId: estimate.printerId,
      ...(carried ?? {}),
    };
    await boss.send(QUEUE.slicer, data, {
      expireInSeconds,
      priority,
      ...retryOverrides,
      ...(startAfterSeconds === undefined ? {} : { startAfter: startAfterSeconds }),
    });
  }

  /** The plate's file and blob, when its model is live. */
  async function liveTarget(plateId: string) {
    return db
      .selectFrom("plates")
      .innerJoin("files", "files.id", "plates.fileId")
      .innerJoin("models", "models.id", "files.modelId")
      .innerJoin("blobs", "blobs.id", "files.blobId")
      .select(["plates.index", "files.id as fileId", "files.size", "blobs.key"])
      .where("plates.id", "=", plateId)
      .where("models.trashedAt", "is", null)
      .executeTakeFirst();
  }

  /** Whether the estimate has a job waiting in the queue at priority or higher. */
  async function queuedAtLeast(estimateId: string, priority: number): Promise<boolean> {
    const jobs = await boss.findJobs<SliceJobData>(QUEUE.slicer, {
      queued: true,
      data: { kind: SLICE_JOB_KIND, estimateId },
      limit: JOB_PAGE,
    });
    return jobs.some((job) => job.priority >= priority);
  }

  async function enqueue(
    plateId: string,
    printer: Printer,
    orcaVersion: string,
    priority: number = SLICE_PRIORITY.library,
  ): Promise<{ estimate: Estimate | null; queued: boolean }> {
    if (!isUuid(plateId) || (await liveTarget(plateId)) === undefined) {
      return { estimate: null, queued: false };
    }
    const own = await db
      .selectFrom("estimates")
      .select(["printerModelId", "nozzle"])
      .where("plateId", "=", plateId)
      .where("source", "=", "file")
      .where("status", "=", "ok")
      .execute();
    if (own.some((row) => printerForFile(row, [printer]) !== undefined)) {
      return { estimate: null, queued: false };
    }
    const existing = await repos.estimates.current(plateId, printer.id, orcaVersion);
    if (existing) {
      // Already waiting, but perhaps only as library work: the Orca poll can
      // queue a new file's plates in the moment between ingest storing them
      // and the upload queueing them. A plate someone is waiting on then gets
      // an urgent copy of its job, so it does not wait behind a backfill. The
      // copy that runs second finds the estimate finished and ends at once,
      // and the queue's figures count the estimate once (slicesThrough).
      if (
        existing.status === "pending" &&
        priority > SLICE_PRIORITY.library &&
        !(await queuedAtLeast(existing.id, priority))
      ) {
        await sendSlice(existing, priority);
        return { estimate: existing, queued: true };
      }
      return { estimate: existing, queued: false };
    }
    const estimate = await repos.estimates.upsertPending({
      plateId,
      printerId: printer.id,
      printerModelId: printer.modelId,
      nozzle: printer.nozzle,
      slicer: PLATEHOUSE_SLICER,
      slicerVersion: orcaVersion,
    });
    if (estimate.status !== "pending") return { estimate, queued: false };
    await sendSlice(estimate, priority);
    return { estimate, queued: true };
  }

  /**
   * My printers that the slicer can estimate for, the default first and the
   * rest in list order. A listed printer the menu no longer has (an Orca
   * update renamed its preset) is left out, and logged: nothing can be
   * sliced for it until the user replaces it. UnknownPrinter when that leaves
   * none, as for the one printer before My printers.
   */
  async function slicedPrinters(): Promise<Printer[]> {
    const { printerId, myPrinters } = await repos.settings.get();
    const menu = await listPrinters();
    const order = [printerId, ...myPrinters.filter((id) => id !== printerId)];
    const out: Printer[] = [];
    for (const id of order) {
      const printer = menu.find((p) => p.id === id);
      if (printer === undefined) log(`${id} is in My printers but not in the slicer's menu`);
      else out.push(printer);
    }
    if (out.length === 0) throw new UnknownPrinter();
    return out;
  }

  /** Whether printerId is one of My printers now. */
  async function isListed(printerId: string): Promise<boolean> {
    return (await repos.settings.get()).myPrinters.includes(printerId);
  }

  /** Queues every live plate that has no estimate for printer and orca; returns how many. */
  async function queueLibraryFor(printer: Printer, orca: string): Promise<number> {
    let queued = 0;
    for (const id of await libraryPlatesFor(db, printer, orca)) {
      if ((await enqueue(id, printer, orca)).queued) queued += 1;
    }
    return queued;
  }

  async function enqueuePlate(
    plateId: string,
    printerId: string,
    orcaVersion: string,
  ): Promise<Estimate | null> {
    const printer = (await listPrinters()).find((p) => p.id === printerId);
    if (!printer) throw new UnknownPrinter();
    return (await enqueue(plateId, printer, orcaVersion)).estimate;
  }

  async function enqueueFile(fileId: string): Promise<number> {
    if (!isUuid(fileId)) return 0;
    const printers = await slicedPrinters();
    const orca = await currentOrca();
    const plates = await repos.plates.listForFile(fileId);
    let queued = 0;
    // Printer by printer: every plate of the file for the default printer,
    // then for each other printer in list order, so the default lands first.
    for (const printer of printers) {
      for (const plate of plates) {
        if ((await enqueue(plate.id, printer, orca, SLICE_PRIORITY.waiting)).queued) queued += 1;
      }
    }
    return queued;
  }

  async function reestimateAll(reason: ReestimateReason): Promise<number> {
    const printers = await slicedPrinters();
    const orca = await currentOrca();
    let total = 0;
    for (const printer of printers) {
      const queued = await queueLibraryFor(printer, orca);
      if (queued > 0) log(`queued ${queued} estimate(s) for ${printer.id} (${reason})`);
      total += queued;
    }
    return total;
  }

  /**
   * Cancels the queued slice jobs of printers no longer in My printers and
   * deletes their waiting estimates. A slice of one that is running now
   * finishes and is kept; one that starts later drops itself (runSliceJob).
   */
  async function dropUnlisted(myPrinters: readonly string[]): Promise<void> {
    const ids = await queuedSliceJobs((job) => !myPrinters.includes(job.data.printerId));
    if (ids.length > 0) await boss.cancel(QUEUE.slicer, ids);
    await db
      .deleteFrom("estimates")
      .where("source", "=", "platehouse")
      .where("status", "=", "pending")
      .where("printerId", "not in", [...myPrinters])
      .execute();
  }

  async function savePrinters(patch: {
    printers: readonly string[];
    defaultId: string;
    version?: number;
  }): Promise<SavedPrinters> {
    const printers = [...patch.printers];
    if (printers.length === 0) {
      throw new PrinterListRefused("My printers needs at least one printer.");
    }
    if (printers.length > MAX_MY_PRINTERS) {
      throw new PrinterListRefused(`My printers holds at most ${MAX_MY_PRINTERS} printers.`);
    }
    if (new Set(printers).size !== printers.length) {
      throw new PrinterListRefused("Each printer can be in My printers only once.");
    }
    if (!printers.includes(patch.defaultId)) {
      throw new PrinterListRefused("The default printer must be one of My printers.");
    }
    const read = await repos.settings.get();
    if (patch.version !== undefined && read.printersVersion !== patch.version) {
      throw new PrintersChanged();
    }
    const before = read.myPrinters;
    const addedIds = printers.filter((id) => !before.includes(id));
    const removed = before.filter((id) => !printers.includes(id));
    // Only an added printer must be in the menu: one already listed stays
    // even after the slicer stops offering it, so the page can show it.
    const menu = addedIds.length === 0 ? [] : await listPrinters();
    const added = addedIds.map((id) => {
      const printer = menu.find((p) => p.id === id);
      if (printer === undefined) throw new UnknownPrinter();
      return printer;
    });
    // Saved only while the version is still the one read here, which added
    // and removed were worked out from (the repo checks it under a lock).
    await repos.settings.savePrinters({
      printers,
      defaultId: patch.defaultId,
      version: read.printersVersion,
    });
    if (removed.length > 0) {
      await dropUnlisted(printers);
      log(`removed ${removed.join(", ")} from My printers; its waiting estimates were dropped`);
    }
    const out: SavedPrinters = { added: [], removed };
    if (added.length > 0) {
      const orca = await currentOrca();
      const queuedFor: Array<{ printerId: string; queued: number }> = [];
      for (const printer of added) {
        const queued = await queueLibraryFor(printer, orca);
        log(`added ${printer.id} to My printers; queued ${queued} estimate(s)`);
        queuedFor.push({ printerId: printer.id, queued });
      }
      // Read once all of it is queued: an added printer's plates wait behind
      // whatever was queued before them, other printers' and earlier added ones.
      const queue = await queueByPrinter();
      for (const { printerId, queued } of queuedFor) {
        out.added.push({ printerId, queued, through: queue.get(printerId)?.through ?? queued });
      }
    }
    return out;
  }

  async function setPrinter(printerId: string): Promise<void> {
    await savePrinters({ printers: [printerId], defaultId: printerId });
  }

  /**
   * Queues a failed estimate of one of My printers again. A Retry pressed on
   * the page goes ahead of library-wide work; the poll's requeue of outage
   * failures does not.
   */
  async function retryEstimate(
    estimateId: string,
    priority: number = SLICE_PRIORITY.waiting,
  ): Promise<boolean> {
    if (!isUuid(estimateId)) return false;
    const row = await db
      .selectFrom("estimates")
      .selectAll()
      .where("id", "=", estimateId)
      .executeTakeFirst();
    if (row?.source !== "platehouse" || row.status !== "failed" || !row.slicerVersion) {
      return false;
    }
    if (!(await isListed(row.printerId))) return false;
    if ((await liveTarget(row.plateId)) === undefined) return false;
    const estimate = await repos.estimates.upsertPending({
      plateId: row.plateId,
      printerId: row.printerId,
      printerModelId: row.printerModelId,
      nozzle: row.nozzle,
      slicer: row.slicer ?? PLATEHOUSE_SLICER,
      slicerVersion: row.slicerVersion,
    });
    if (estimate.status !== "pending") return false;
    await sendSlice(estimate, priority);
    return true;
  }

  async function recordFailed(
    estimateId: string,
    failure: { code: number | null; reason: string; detail: string },
  ): Promise<void> {
    await db
      .updateTable("estimates")
      .set({
        status: "failed",
        timeSeconds: null,
        weightGrams: null,
        failureCode: failure.code,
        failureReason: failure.reason,
        failureDetail: failure.detail.slice(0, DETAIL_CHARS),
        finishedAt: sql`now()`,
      })
      .where("id", "=", estimateId)
      .where("status", "in", ["pending", "running"])
      .execute();
  }

  async function recordOk(estimate: Estimate, fileId: string, result: SliceOk): Promise<void> {
    // The slicer may have been upgraded since the estimate was queued: the
    // numbers are recorded under the version that produced them, unless an
    // estimate for that version already exists.
    if (result.orca !== estimate.slicerVersion) {
      const other = await repos.estimates.current(
        estimate.plateId,
        estimate.printerId,
        result.orca,
      );
      if (other) {
        await db.deleteFrom("estimates").where("id", "=", estimate.id).execute();
        return;
      }
    }
    // filamentProfiles names a preset per project slot, in slot order. The
    // file's filament list (file_filaments) is that slot list, read by the
    // same parser; when the two do not line up, no preset is claimed.
    const slots = await db
      .selectFrom("fileFilaments")
      .select("slot")
      .where("fileId", "=", fileId)
      .orderBy("slot")
      .execute();
    const presets = new Map<number, string | null>();
    if (slots.length === result.filamentProfiles.length) {
      slots.forEach(({ slot }, i) => {
        presets.set(slot, result.filamentProfiles[i] ?? null);
      });
    }
    await inTransaction(db, async (trx) => {
      const updated = await trx
        .updateTable("estimates")
        .set({
          status: "ok",
          slicerVersion: result.orca,
          processProfile: result.process,
          filamentProfiles: result.filamentProfiles,
          timeSeconds: Math.round(result.timeSeconds),
          weightGrams: result.weightGrams,
          failureCode: null,
          failureReason: null,
          failureDetail: null,
          finishedAt: sql`now()`,
        })
        .where("id", "=", estimate.id)
        .where("status", "=", "running")
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) === 0) return;
      await trx.deleteFrom("estimateFilaments").where("estimateId", "=", estimate.id).execute();
      if (result.filaments.length === 0) return;
      await trx
        .insertInto("estimateFilaments")
        .values(
          result.filaments.map((f) => {
            const known = presets.has(f.slot);
            const profile = known ? (presets.get(f.slot) ?? null) : null;
            return {
              estimateId: estimate.id,
              slot: f.slot,
              type: f.type,
              color: f.color,
              grams: f.grams,
              profile,
              profileSource: known ? profileSourceOf(profile) : null,
            };
          }),
        )
        .execute();
    });
  }

  async function runSliceJob(job: JobWithMetadata<SliceJobData>): Promise<void> {
    if (!isSliceJob(job.data)) throw new Error("slice job without a valid estimate id");
    const estimate = await db
      .selectFrom("estimates")
      .selectAll()
      .where("id", "=", job.data.estimateId)
      .executeTakeFirst();
    // Gone (superseded), finished already (a duplicate job), or failed and
    // not retried: nothing to do.
    if (
      estimate?.source !== "platehouse" ||
      (estimate.status !== "pending" && estimate.status !== "running")
    ) {
      return;
    }
    const target = await liveTarget(estimate.plateId);
    if (!(await isListed(estimate.printerId)) || target === undefined) {
      // Its printer left My printers, or its model went to the trash.
      await db
        .deleteFrom("estimates")
        .where("id", "=", estimate.id)
        .where("status", "in", ["pending", "running"])
        .execute();
      return;
    }
    await db
      .updateTable("estimates")
      .set({ status: "running", attempts: sql`attempts + 1` })
      .where("id", "=", estimate.id)
      .execute();
    const full: Estimate = { ...estimate, filaments: [] };
    // Retries this estimate has used so far, and the connections it lost,
    // its earlier jobs' included.
    const carried: Carried = {
      retriesUsed: (job.data.retriesUsed ?? 0) + job.retryCount,
      requeues: job.data.requeues ?? 0,
      lostConnections: job.data.lostConnections ?? 0,
    };
    const waitUntil = Date.now() + slicerDown.waitMs;
    for (;;) {
      try {
        const body = await store.getBlobStream(target.key);
        const result = await slicer.slice({
          printerId: estimate.printerId,
          plate: target.index,
          body,
          size: target.size,
        });
        if (result.status === "ok") {
          await recordOk(full, target.fileId, result);
        } else {
          await recordFailed(estimate.id, result);
        }
        return;
      } catch (error) {
        const outage = outageOf(error);
        if (outage !== null) {
          // The slicer never saw this plate, or its file could not be read
          // (at the start or partway through): no retry is used.
          if (await outageOver(outage, waitUntil)) continue;
          await requeue(full, job.priority, carried, outage);
          return;
        }
        if (isRetryable(error) && carried.retriesUsed < job.retryLimit) {
          await backToPending(estimate.id);
          if (isLostConnection(error)) {
            // pg-boss would retry this job with its data unchanged, so the
            // retry goes out as a new job that counts the lost connection.
            const retry = carried.retriesUsed + 1;
            await sendSlice(
              full,
              job.priority,
              { ...carried, retriesUsed: retry, lostConnections: carried.lostConnections + 1 },
              retryDelaySeconds(job, retry),
            );
            return;
          }
          throw error;
        }
        await recordFailed(estimate.id, {
          code: null,
          reason: "slicer_error",
          detail: errorDetail(error),
        });
        return;
      }
    }
  }

  async function backToPending(estimateId: string): Promise<void> {
    await db
      .updateTable("estimates")
      .set({ status: "pending" })
      .where("id", "=", estimateId)
      .where("status", "=", "running")
      .execute();
  }

  /**
   * Waits until /v1/health answers or the time is up; true when it answered.
   * The job holds the singleton queue's one slot meanwhile, so no other slice
   * starts and fails against the same outage.
   */
  async function slicerBack(until: number): Promise<boolean> {
    for (;;) {
      const left = until - Date.now();
      if (left <= 0) return false;
      await sleep(Math.min(slicerDown.pollMs, left));
      try {
        await slicer.health();
        return true;
      } catch {
        // Still down.
      }
    }
  }

  /**
   * Waits out an outage until the time is up; true when it is worth trying
   * again. The store has no health check of its own here, so for a store
   * outage the next read is the check.
   */
  async function outageOver(outage: Outage, until: number): Promise<boolean> {
    if (outage === "slicer") return slicerBack(until);
    const left = until - Date.now();
    if (left <= 0) return false;
    await sleep(Math.min(slicerDown.pollMs, left));
    return true;
  }

  /**
   * Still down after the wait: the plate goes back on the queue as a new job
   * carrying the retries and lost connections it used, and this job ends, so
   * a short outage is waited out a job at a time rather than failing the
   * plate. Once it has gone back slicerDown.requeues times, the plate fails
   * with slicer_error. A slicer outage after a lost connection fails with
   * DOWN_AFTER_LOST_DETAIL, which the poll leaves alone (see there); after
   * anything else, a busy answer included, with SLICER_DOWN_DETAIL, which
   * the poll queues again.
   */
  async function requeue(
    estimate: Estimate,
    priority: number,
    carried: Carried,
    outage: Outage,
  ): Promise<void> {
    const { requeues } = carried;
    if (requeues >= slicerDown.requeues) {
      const detail =
        outage === "store"
          ? STORE_DOWN_DETAIL
          : carried.lostConnections > 0
            ? DOWN_AFTER_LOST_DETAIL
            : SLICER_DOWN_DETAIL;
      await recordFailed(estimate.id, { code: null, reason: "slicer_error", detail });
      log(
        `estimate ${estimate.id}: the ${outage} is still down after ${requeues} requeue(s); failed`,
      );
      return;
    }
    await backToPending(estimate.id);
    await sendSlice(estimate, priority, { ...carried, requeues: requeues + 1 });
    log(
      `estimate ${estimate.id}: the ${outage} is down; back on the queue (${requeues + 1} of ${slicerDown.requeues})`,
    );
  }

  /** Whether the store answers a read of key; only a store outage counts as no. */
  async function storeAnswers(key: string): Promise<boolean> {
    try {
      (await store.getBlobStream(key)).destroy();
      return true;
    } catch (error) {
      return !(error instanceof StoreUnavailable);
    }
  }

  /**
   * Queues again the estimates an outage failed (SLICER_DOWN_DETAIL and
   * STORE_DOWN_DETAIL) for My printers and this Orca version. The
   * poll calls it only once /v1/health has answered. Store failures are
   * queued only when the store answers a read, and one read per poll stands
   * for the whole store: the file of the first store-failed plate that is
   * still live is read, and that answer decides every store failure in the
   * same poll (the store is one bucket).
   */
  async function requeueOutageFailures(orca: string): Promise<void> {
    const { myPrinters } = await repos.settings.get();
    const failed = await db
      .selectFrom("estimates")
      .select(["id", "plateId", "failureDetail"])
      .where("source", "=", "platehouse")
      .where("status", "=", "failed")
      .where("failureCode", "is", null)
      .where("failureReason", "=", "slicer_error")
      .where("failureDetail", "in", OUTAGE_DETAILS)
      .where("printerId", "in", myPrinters)
      .where("slicerVersion", "=", orca)
      .orderBy("createdAt")
      .execute();
    let storeUp: boolean | undefined;
    let queued = 0;
    for (const row of failed) {
      if (row.failureDetail === STORE_DOWN_DETAIL) {
        const target = await liveTarget(row.plateId);
        if (target === undefined) continue;
        storeUp ??= await storeAnswers(target.key);
        if (!storeUp) continue;
      }
      if (await retryEstimate(row.id, SLICE_PRIORITY.library)) queued += 1;
    }
    if (queued > 0) log(`queued ${queued} estimate(s) again that an outage had failed`);
  }

  /**
   * Every slice job waiting in the queue (created, or waiting for a retry),
   * read a page at a time. Only queued jobs are read, so the finished jobs
   * pg-boss keeps never crowd out a live one.
   */
  async function queuedSlices(): Promise<
    Array<{ id: string; data: SliceJobData; priority: number; createdOn: Date }>
  > {
    const jobs: Array<{ id: string; data: SliceJobData; priority: number; createdOn: Date }> = [];
    let after: string | undefined;
    for (;;) {
      const page = await boss.findJobs<SliceJobData>(QUEUE.slicer, {
        queued: true,
        data: { kind: SLICE_JOB_KIND },
        limit: JOB_PAGE,
        ...(after === undefined ? {} : { after }),
      });
      for (const job of page) {
        jobs.push({
          id: job.id,
          data: job.data,
          priority: job.priority,
          createdOn: new Date(job.createdOn),
        });
      }
      const last = page.at(-1);
      if (page.length < JOB_PAGE || last === undefined) return jobs;
      after = last.id;
    }
  }

  /**
   * Every job waiting in the slicer queue, of any kind: the slices, and the
   * render and mesh jobs (derived.ts) that run on the same one-at-a-time
   * queue. A slice job carries its printer and estimate; the others carry
   * neither. Read a page at a time, queued jobs only, as queuedSlices.
   */
  async function queuedSlicerWork(): Promise<QueuedWork[]> {
    const jobs: QueuedWork[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await boss.findJobs<Partial<SliceJobData>>(QUEUE.slicer, {
        queued: true,
        limit: JOB_PAGE,
        ...(after === undefined ? {} : { after }),
      });
      for (const job of page) {
        const slice = job.data?.kind === SLICE_JOB_KIND;
        jobs.push({
          id: job.id,
          ...(slice && typeof job.data.printerId === "string"
            ? { printerId: job.data.printerId }
            : {}),
          ...(slice && typeof job.data.estimateId === "string"
            ? { estimateId: job.data.estimateId }
            : {}),
          priority: job.priority,
          createdOn: new Date(job.createdOn),
        });
      }
      const last = page.at(-1);
      if (page.length < JOB_PAGE || last === undefined) return jobs;
      after = last.id;
    }
  }

  /** The ids of the queued slice jobs that match. */
  async function queuedSliceJobs(
    match: (job: { data: SliceJobData }) => boolean,
  ): Promise<string[]> {
    return (await queuedSlices()).filter(match).map((job) => job.id);
  }

  /** The estimate ids of every slice job waiting in the queue. */
  async function queuedSliceEstimates(): Promise<Set<string>> {
    return new Set((await queuedSlices()).map((job) => job.data.estimateId));
  }

  /** Whether the estimate has a job queued or active now: its own jobs only. */
  async function hasLiveJob(estimateId: string): Promise<boolean> {
    const jobs = await boss.findJobs<SliceJobData>(QUEUE.slicer, {
      data: { kind: SLICE_JOB_KIND, estimateId },
      limit: JOB_PAGE,
    });
    return jobs.some((j) => j.state === "created" || j.state === "retry" || j.state === "active");
  }

  /**
   * Estimates that say pending or running while no job of theirs is queued
   * or active: a running one fails with slicer_error, a pending one is
   * queued again. pg-boss cannot list active jobs alone, so an estimate with
   * no queued job has its own jobs read; that is the one slicing now, and
   * any that were lost.
   */
  async function recoverLost(): Promise<void> {
    const waiting = await db
      .selectFrom("estimates")
      .selectAll()
      .where("source", "=", "platehouse")
      .where("status", "in", ["pending", "running"])
      .execute();
    if (waiting.length === 0) return;
    const queued = await queuedSliceEstimates();
    for (const row of waiting) {
      if (queued.has(row.id) || (await hasLiveJob(row.id))) continue;
      if (row.status === "running") {
        await db
          .updateTable("estimates")
          .set({
            status: "failed",
            failureCode: null,
            failureReason: "slicer_error",
            failureDetail: "The slice was lost before it finished.",
            finishedAt: sql`now()`,
          })
          .where("id", "=", row.id)
          .where("status", "=", "running")
          .execute();
      } else {
        await sendSlice({ ...row, filaments: [] }, SLICE_PRIORITY.library);
      }
    }
  }

  async function pollOrca(): Promise<{ orca: string; changed: boolean }> {
    const { orca } = await slicer.health();
    const stored = (await repos.settings.get()).lastOrcaVersion;
    const changed = orca !== stored;
    if (profilesCache !== null && profilesCache.orca !== orca) profilesCache = null;
    if (changed) {
      await repos.settings.update({ lastOrcaVersion: orca });
      log(`slicer reports Orca ${orca} (was ${stored ?? "unknown"})`);
    }
    await recoverLost();
    await requeueOutageFailures(orca);
    await reestimateAll(changed ? "orca" : "poll");
    return { orca, changed };
  }

  async function queueByPrinter(): Promise<Map<string, PrinterQueue>> {
    const { myPrinters, lastOrcaVersion } = await repos.settings.get();
    const [rows, running, jobs] = await Promise.all([
      db
        .selectFrom("estimates")
        .select(["printerId", sql<number>`count(*)::int`.as("n")])
        .where("source", "=", "platehouse")
        .where("status", "in", ["pending", "running"])
        .where("printerId", "in", myPrinters)
        .where((eb) =>
          lastOrcaVersion === null
            ? eb("slicerVersion", "is", null)
            : eb("slicerVersion", "=", lastOrcaVersion),
        )
        .groupBy("printerId")
        .execute(),
      // A slice running now, for any printer, runs before anything queued.
      db
        .selectFrom("estimates")
        .select(sql<number>`count(*)::int`.as("n"))
        .where("source", "=", "platehouse")
        .where("status", "=", "running")
        .executeTakeFirstOrThrow(),
      // Render and mesh jobs too: they share the queue, and the ones ahead
      // of a printer's slices are part of its wait.
      queuedSlicerWork(),
    ]);
    const through = slicesThrough(jobs, running.n);
    return new Map(
      rows.map((r) => [
        r.printerId,
        // A printer whose only work is the slice running now is through at
        // the running count; an estimate whose job was lost (the poll queues
        // it again) still counts as its own waiting plate.
        { waiting: r.n, through: Math.max(through.get(r.printerId) ?? running.n, r.n) },
      ]),
    );
  }

  async function recentSliceRate(): Promise<number | null> {
    // Successful slices only: a burst of quick failures (the store down, say)
    // would read as a fast slicer.
    const rows = await db
      .selectFrom("estimates")
      .select("finishedAt")
      .where("source", "=", "platehouse")
      .where("status", "=", "ok")
      .where("finishedAt", "is not", null)
      .orderBy("finishedAt", "desc")
      .limit(RATE_SAMPLE)
      .execute();
    return sliceRate(rows.flatMap((r) => (r.finishedAt === null ? [] : [r.finishedAt])));
  }

  /** The display context for printerId, or for the default printer when it is left out. */
  async function displayContext(printerId?: string): Promise<DisplayContext> {
    const settings = await repos.settings.get();
    let printers: Printer[] = [];
    try {
      printers = await listPrinters();
    } catch {
      // A page still shows its numbers while the slicer is down; printers
      // are then labelled by their stored names.
    }
    return {
      printerId: printerId ?? settings.printerId,
      myPrinters: settings.myPrinters,
      orcaVersion: settings.lastOrcaVersion,
      printers,
    };
  }

  return {
    listPrinters,
    savePrinters,
    setPrinter,
    enqueuePlate,
    enqueueFile,
    reestimateAll,
    retryEstimate: (estimateId) => retryEstimate(estimateId),
    pollOrca,
    queueByPrinter,
    sliceRate: recentSliceRate,
    plateNumbers: async (plateId, printerId) =>
      plateNumbers(db, await displayContext(printerId), plateId),
    platesWithoutNumbers: async (printerId) =>
      platesWithoutNumbers(db, await displayContext(printerId)),
    runSliceJob,
    slicerJobs: Object.freeze({
      [SLICE_JOB_KIND]: (job: JobWithMetadata<SlicerJob>) =>
        runSliceJob(job as JobWithMetadata<unknown> as JobWithMetadata<SliceJobData>),
    }),
  };
}
