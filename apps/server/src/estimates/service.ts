// Estimates, the printer setting and re-estimation (build plan Task 12;
// AC-031 to AC-034, AC-036; Review Focus 2 and 3).
//
// - The printer menu is /v1/profiles' printer list, read once per Orca
//   version (listPrinters). The selected printer is settings.printer_id,
//   P1S 0.4 by default.
// - A Platehouse estimate is queued for a plate only when its file has no
//   numbers of its own for the selected printer: the file's
//   slicedFor.printerModelId and nozzle matched against the menu printer's
//   modelId and nozzle (enqueuePlate).
// - Each estimate is one job on the singleton slicer queue (Task 8), so one
//   slice runs at a time. A 409 busy or a lost connection is retried by
//   pg-boss's own retry settings (SLICER_RETRY: 3 retries with backoff); once
//   the last retry is used the estimate fails with slicer_error. Any other
//   answer that is not a result fails it at once with slicer_error. A result
//   is recorded as it came: numbers, or the slicer's own reason (Orca codes
//   the slicer reports as slicer_error stay slicer_error).
// - On a printer change the queued slice jobs of other printers are
//   cancelled and their waiting estimates deleted; a slice already running
//   finishes and is kept, labelled with its printer. A job that starts after
//   its printer stopped being selected drops itself. Then every live plate is
//   queued for the new printer, and until its estimate lands the plate shows
//   its newest older estimate, marked as made for the previous printer
//   (display.ts).
// - The Orca-version poll runs at startup and every 10 minutes (a pg-boss
//   cron job, Task 8's maintenance queue). When /v1/health.orca differs from
//   settings.last_orca_version it stores the new version and re-estimates
//   every live plate. Every poll also finds slices that were lost (a job gone
//   while its estimate still says pending or running, as after the app itself
//   stopped mid-slice): a running one fails with slicer_error, a pending one
//   is queued again. Then it queues any live plate that still has no
//   estimate, so a plate whose queueing failed at upload is not left out.
// - Each slice records the Orca version that produced it (AC-036) and, for
//   each filament, the preset the slicer used and where it came from:
//   Bambu's own, Generic, or the file's own filament (PR #55).
import type { Printer, Profiles, SliceOk } from "@platehouse/slicer-contract";
import { type Kysely, sql } from "kysely";
import type { JobWithMetadata, PgBoss } from "pg-boss";
import { isUuid } from "../db/ids.js";
import { inTransaction } from "../db/kysely.js";
import type { DB } from "../db/types.js";
import { QUEUE, SLICER_RETRY, type SlicerJob, type SlicerJobHandlers } from "../jobs/queues.js";
import type { Estimate } from "../repos/estimates.js";
import { createRepos, type Repos } from "../repos/index.js";
import { type BlobStore, StoreUnavailable } from "../storage/s3.js";
import {
  SlicerBusy,
  type SlicerClient,
  SlicerRefused,
  SlicerUnreachable,
  sliceTimeoutMs,
} from "./client.js";
import {
  type DisplayContext,
  PLATEHOUSE_SLICER,
  type PlateNumbers,
  plateNumbers,
  platesWithoutNumbers,
  printerForFile,
  profileSourceOf,
} from "./display.js";

export const SLICE_JOB_KIND = "slice";

/** A slice job's data: the estimate it fills, and the printer, for cancelling. */
export interface SliceJobData {
  kind: typeof SLICE_JOB_KIND;
  estimateId: string;
  printerId: string;
}

/** Why every live plate is being looked at: logged, nothing else. */
export type ReestimateReason = "printer" | "orca" | "startup" | "poll";

export class UnknownPrinter extends Error {
  constructor() {
    super("That printer is not in the slicer's printer list");
    this.name = "UnknownPrinter";
  }
}

/**
 * Per-job overrides of the slicer queue's retry delay. The app leaves these
 * out and uses the queue's own (SLICER_RETRY); the tests shorten the delay.
 */
export interface SliceJobOptions {
  retryDelay?: number;
  retryDelayMax?: number;
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
  log?: (line: string) => void;
}

export interface Estimates {
  /** The printer menu: every printer /v1/profiles lists. */
  listPrinters(): Promise<Printer[]>;
  /** Selects a printer from the menu and re-estimates the library for it. */
  setPrinter(printerId: string): Promise<void>;
  /**
   * Makes sure a Platehouse estimate exists and is queued for the plate,
   * printer and Orca version; null when the file's own numbers are for that
   * printer or the plate is not on a live model.
   */
  enqueuePlate(plateId: string, printerId: string, orcaVersion: string): Promise<Estimate | null>;
  /** Queues a newly ingested file's plates; returns how many were queued. */
  enqueueFile(fileId: string): Promise<number>;
  /** Queues every live plate that has no estimate for the selected printer and Orca version. */
  reestimateAll(reason: ReestimateReason): Promise<number>;
  /** Queues a failed estimate again, from the stored file: no re-upload. */
  retryEstimate(estimateId: string): Promise<boolean>;
  /** The Orca-version poll (startup and every 10 minutes). */
  pollOrca(): Promise<{ orca: string; changed: boolean }>;
  plateNumbers(plateId: string): Promise<PlateNumbers>;
  /** The AC-032 query (display.ts). */
  platesWithoutNumbers(): Promise<string[]>;
  /** The slice job's handler. */
  runSliceJob(job: JobWithMetadata<SliceJobData>): Promise<void>;
  /** The slicer queue handlers to hand to startQueues. */
  slicerJobs: SlicerJobHandlers;
}

/** A failed estimate's detail is cut to the contract's length. */
const DETAIL_CHARS = 2000;

/** Most jobs read back when looking through the slicer queue. */
const JOB_PAGE = 100_000;

function errorDetail(error: unknown): string {
  if (error instanceof SlicerBusy) return "The slicer stayed busy with other work.";
  if (error instanceof SlicerUnreachable)
    return `The slicer could not be reached: ${error.reason}.`;
  if (error instanceof SlicerRefused) return error.message;
  if (error instanceof StoreUnavailable) return "The file could not be read from storage.";
  return "The slice could not be run.";
}

/** Busy, a lost connection or a store outage: worth another try. */
function isRetryable(error: unknown): boolean {
  return (
    error instanceof SlicerBusy ||
    error instanceof SlicerUnreachable ||
    error instanceof StoreUnavailable
  );
}

function isSliceJob(data: unknown): data is SliceJobData {
  const d = data as Partial<SliceJobData> | null;
  return (
    d !== null &&
    typeof d === "object" &&
    d.kind === SLICE_JOB_KIND &&
    typeof d.estimateId === "string" &&
    isUuid(d.estimateId) &&
    typeof d.printerId === "string"
  );
}

export function createEstimates(deps: EstimatesDeps): Estimates {
  const { db, boss, slicer, store } = deps;
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

  async function sendSlice(estimate: Estimate): Promise<void> {
    const data: SliceJobData = {
      kind: SLICE_JOB_KIND,
      estimateId: estimate.id,
      printerId: estimate.printerId,
    };
    await boss.send(QUEUE.slicer, data, { expireInSeconds, ...retryOverrides });
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

  async function enqueue(
    plateId: string,
    printer: Printer,
    orcaVersion: string,
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
    if (existing) return { estimate: existing, queued: false };
    const estimate = await repos.estimates.upsertPending({
      plateId,
      printerId: printer.id,
      printerModelId: printer.modelId,
      nozzle: printer.nozzle,
      slicer: PLATEHOUSE_SLICER,
      slicerVersion: orcaVersion,
    });
    if (estimate.status !== "pending") return { estimate, queued: false };
    await sendSlice(estimate);
    return { estimate, queued: true };
  }

  async function selectedPrinter(): Promise<Printer> {
    const { printerId } = await repos.settings.get();
    const printer = (await listPrinters()).find((p) => p.id === printerId);
    if (!printer) throw new UnknownPrinter();
    return printer;
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
    const printer = await selectedPrinter();
    const orca = await currentOrca();
    let queued = 0;
    for (const plate of await repos.plates.listForFile(fileId)) {
      if ((await enqueue(plate.id, printer, orca)).queued) queued += 1;
    }
    return queued;
  }

  async function reestimateAll(reason: ReestimateReason): Promise<number> {
    const printer = await selectedPrinter();
    const orca = await currentOrca();
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
      order by f.created_at, f.id, p.index
    `.execute(db);
    let queued = 0;
    for (const row of rows) {
      if ((await enqueue(row.id, printer, orca)).queued) queued += 1;
    }
    if (queued > 0) log(`queued ${queued} estimate(s) for ${printer.id} (${reason})`);
    return queued;
  }

  /** Cancels queued slice jobs of other printers and deletes their waiting estimates. */
  async function supersede(printerId: string): Promise<void> {
    const queued = await boss.findJobs<SliceJobData>(QUEUE.slicer, {
      queued: true,
      data: { kind: SLICE_JOB_KIND },
      limit: JOB_PAGE,
    });
    const stale = queued.filter((job) => job.data.printerId !== printerId).map((job) => job.id);
    if (stale.length > 0) await boss.cancel(QUEUE.slicer, stale);
    await db
      .deleteFrom("estimates")
      .where("source", "=", "platehouse")
      .where("status", "=", "pending")
      .where("printerId", "!=", printerId)
      .execute();
  }

  async function setPrinter(printerId: string): Promise<void> {
    if (!(await listPrinters()).some((p) => p.id === printerId)) throw new UnknownPrinter();
    await repos.settings.update({ printerId });
    await supersede(printerId);
    await reestimateAll("printer");
  }

  async function retryEstimate(estimateId: string): Promise<boolean> {
    if (!isUuid(estimateId)) return false;
    const row = await db
      .selectFrom("estimates")
      .selectAll()
      .where("id", "=", estimateId)
      .executeTakeFirst();
    if (row?.source !== "platehouse" || row.status !== "failed" || !row.slicerVersion) {
      return false;
    }
    if (row.printerId !== (await repos.settings.get()).printerId) return false;
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
    await sendSlice(estimate);
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
    const { printerId } = await repos.settings.get();
    const target = await liveTarget(estimate.plateId);
    if (estimate.printerId !== printerId || target === undefined) {
      // Its printer is no longer selected, or its model went to the trash.
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
    } catch (error) {
      if (isRetryable(error) && job.retryCount < job.retryLimit) {
        await db
          .updateTable("estimates")
          .set({ status: "pending" })
          .where("id", "=", estimate.id)
          .where("status", "=", "running")
          .execute();
        throw error;
      }
      await recordFailed(estimate.id, {
        code: null,
        reason: "slicer_error",
        detail: errorDetail(error),
      });
    }
  }

  /**
   * Estimates that say pending or running while no job of theirs is queued
   * or active: a running one fails with slicer_error, a pending one is
   * queued again.
   */
  async function recoverLost(): Promise<void> {
    const waiting = await db
      .selectFrom("estimates")
      .selectAll()
      .where("source", "=", "platehouse")
      .where("status", "in", ["pending", "running"])
      .execute();
    if (waiting.length === 0) return;
    const jobs = await boss.findJobs<SliceJobData>(QUEUE.slicer, {
      data: { kind: SLICE_JOB_KIND },
      limit: JOB_PAGE,
    });
    const live = new Set(
      jobs
        .filter((j) => j.state === "created" || j.state === "retry" || j.state === "active")
        .map((j) => j.data.estimateId),
    );
    for (const row of waiting) {
      if (live.has(row.id)) continue;
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
        await sendSlice({ ...row, filaments: [] });
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
    await reestimateAll(changed ? "orca" : "poll");
    return { orca, changed };
  }

  async function displayContext(): Promise<DisplayContext> {
    const settings = await repos.settings.get();
    let printers: Printer[] = [];
    try {
      printers = await listPrinters();
    } catch {
      // A page still shows its numbers while the slicer is down; printers
      // are then labelled by their stored names.
    }
    return { printerId: settings.printerId, orcaVersion: settings.lastOrcaVersion, printers };
  }

  return {
    listPrinters,
    setPrinter,
    enqueuePlate,
    enqueueFile,
    reestimateAll,
    retryEstimate,
    pollOrca,
    plateNumbers: async (plateId) => plateNumbers(db, await displayContext(), plateId),
    platesWithoutNumbers: async () => platesWithoutNumbers(db, await displayContext()),
    runSliceJob,
    slicerJobs: Object.freeze({
      [SLICE_JOB_KIND]: (job: JobWithMetadata<SlicerJob>) =>
        runSliceJob(job as JobWithMetadata<unknown> as JobWithMetadata<SliceJobData>),
    }),
  };
}
