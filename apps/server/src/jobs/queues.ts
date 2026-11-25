// The pg-boss queues. Background work runs in
// the same Postgres, so there is no Redis:
// - ingest: an uploaded file through the ingest pipeline, two at once, never
//   retried, so a failed upload fails visibly and leaves no half-made model,
//   and expired only after an hour (INGEST_EXPIRE_SECONDS);
// - slicer: the singleton queue for slicer work, one job at a time, matching
//   the slicer's own one-job lock (the maintainer, 2026-11-08, PR #49: there is no
//   SLICER_CONCURRENCY, since the singleton policy made it a no-op). The estimates
//   module adds its slice jobs and derived/ its render and mesh jobs; the slicer
//   answers 409 busy while any heavy job runs, and those jobs retry on 409
//   through the queue's own retry settings (SLICER_RETRY). Each job names
//   its kind, and the worker hands it to that kind's handler (slicerJobs);
// - after an ingest job stores a file, onIngested queues its estimates
//   (estimates/), outside the ingest transaction;
// - maintenance: the cron jobs, one at a time. The trash's purgeExpired(now)
//   runs daily at 03:30 local time (issue #38), the orphan sweep
//   (ingest/orphans.ts) daily at 04:00 local time, the upload handler's sweep of
//   partial uploads untouched for 24 hours (uploads/tus.ts) every hour,
//   the estimates module's Orca-version poll every 10 minutes, the render check
//   (derived/derived.ts's checkRenders) every 15 minutes (CHECK_RENDERS_CRON),
//   the delete of login sessions past either expiry daily at 04:35 local
//   time (PURGE_SESSIONS_CRON), and issue #316's preview backfill every 5
//   minutes (BACKFILL_PREVIEWS_CRON), which also runs once at startup and is
//   the backstop: a new batch is also sent as soon as one finishes (#417).
//   The three daily tasks run at 03:30, 04:00 and 04:35, so none shares a
//   minute with another, and minute 35 is on no hourly, 10-minute or
//   15-minute schedule either. The 5-minute backfill does share minutes
//   with all of them; the worker runs one maintenance job at a time in any
//   case, and a backfill run is a quick query when there is nothing to do;
// - upgrade: the one-time upgrade steps (UPGRADE_TASKS), the description
//   re-conversion and then the licence fill today, on a stately queue of
//   their own, one job at a time, so duplicate jobs collapse and maintenance
//   tasks never wait behind it.
// The server (main.ts) passes a ServerQueueDeps, which requires
// slicerJobs, pollOrca, onIngested, checkRenders and backfillPreviews, so it
// cannot leave a queue without its worker or those schedules without their handlers. The
// session delete (purgeSessions) is optional in both; the server
// test checks that the running server schedules and runs every maintenance
// task, that one included.
import type { JobWithMetadata, PgBoss } from "pg-boss";
import { CHECK_RENDERS_CRON } from "../derived/derived.js";
import type { IngestInput, IngestResult } from "../ingest/ingest.js";
import { INGEST_CONCURRENCY } from "../ingest/read-limit.js";
import { RECONVERT_PAUSED } from "../library/reconvert.js";

export const QUEUE = {
  ingest: "ingest",
  slicer: "slicer",
  maintenance: "maintenance",
  upgrade: "upgrade",
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

/**
 * Ingest jobs worked at once. The .3mf reads themselves are held to the same
 * number across the queue and the inbox watcher (ingest/read-limit.ts).
 */
export { INGEST_CONCURRENCY };

/**
 * How a slicer job is retried when the slicer answers 409 busy or the
 * connection to it is lost (the estimate jobs, and the render and mesh
 * jobs too): three retries with exponential backoff from 10 s, capped at 2
 * minutes, so a slicer that is restarting has time to come back. pg-boss
 * runs them itself, except that a slice job retries a lost connection as a
 * new job with the same backoff, so that its job data can count the lost
 * connections (estimates/service.ts). The handler records the failure once
 * the last retry is used.
 */
export const SLICER_RETRY = Object.freeze({
  retryLimit: 3,
  retryBackoff: true,
  retryDelay: 10,
  retryDelayMax: 120,
});

/**
 * How long an ingest job may run before pg-boss expires it: an hour. Under
 * pg-boss's default, 15 minutes, a long import (a 512 MiB .3mf hashed and
 * put to a cloud bucket over a home uplink, two at a time) was marked failed
 * while it carried on and stored the model, so the upload's result said it
 * could not be confirmed. Set on the queue, not on each send, and applied
 * again on every start (startQueues).
 */
export const INGEST_EXPIRE_SECONDS = 3600;

export interface QueueSetting {
  name: QueueName;
  /** createQueue options. */
  queue: {
    policy: "standard" | "singleton" | "stately";
    retryLimit?: number;
    retryBackoff?: boolean;
    retryDelay?: number;
    retryDelayMax?: number;
    expireInSeconds?: number;
  };
  /** work options. */
  work: { localConcurrency: number };
}

/** How each queue is created and worked. The slicer queue is worked with its own setting. */
export function queueSettings(): Record<keyof typeof QUEUE, QueueSetting> {
  return {
    ingest: {
      name: QUEUE.ingest,
      queue: { policy: "standard", retryLimit: 0, expireInSeconds: INGEST_EXPIRE_SECONDS },
      work: { localConcurrency: INGEST_CONCURRENCY },
    },
    slicer: {
      name: QUEUE.slicer,
      queue: { policy: "singleton", ...SLICER_RETRY },
      work: { localConcurrency: 1 },
    },
    maintenance: {
      name: QUEUE.maintenance,
      queue: { policy: "standard" },
      work: { localConcurrency: 1 },
    },
    upgrade: {
      name: QUEUE.upgrade,
      queue: { policy: "stately", retryLimit: 0 },
      work: { localConcurrency: 1 },
    },
  };
}

/** The maintenance queue's tasks, each a job { task } and its schedule key. */
export const MAINTENANCE_TASKS = {
  purgeExpired: "purge-expired",
  sweepOrphans: "sweep-orphans",
  pollOrca: "poll-orca",
  sweepUploads: "sweep-uploads",
  checkRenders: "check-renders",
  purgeSessions: "purge-sessions",
  backfillPreviews: "backfill-previews",
} as const;

/**
 * The upgrade queue's one-time steps: the description re-conversion (#357,
 * library/reconvert.ts) and then the licence fill (#445,
 * library/licence-fill.ts), as one task that runs them in that order and is
 * pending until both have finished. Its lifecycle is built so that whatever
 * happens to the process or what it depends on, a stop is clean, no description is
 * written wrongly or twice, and the step finishes once things are healthy,
 * without anyone restarting the server (#381, #382):
 *
 * - Driven three ways, each only while the step is pending: a job sent at
 *   start-up, a schedule every RECONVERT_CRON (made at start-up, removed when
 *   the step finishes, and listed on the Activity page meanwhile), and the
 *   next job sent after a slice that paused. So a failed or lost job, or an
 *   outage, only delays it.
 * - Never two runs at once: the upgrade queue is stately and worked one job
 *   at a time, so at most one job waits and one runs, and the run itself
 *   holds a lease row that it renews while it goes (repos/descriptions.ts
 *   exclusive), so a second server does nothing while it is held. A run that
 *   can no longer show it holds the lease stops after the model it is on,
 *   and a server that dies leaves a lease that runs out within a minute.
 *   The step has its own queue (#412): on the maintenance queue the
 *   schedule and each paused slice added a job, about two for every one
 *   finished, and the other maintenance tasks waited behind them.
 * - Each job is sent with no pg-boss retry, and its handler never throws for
 *   an outage. A run that fails (the object store or the database down)
 *   backs off instead: the jobs that come within RECONVERT_BACKOFF_MS of the
 *   failure, doubling with each failure in a row up to an hour, do nothing,
 *   so a store that is down is asked once in that time, not hammered.
 * - The server's shutdown signal (QueueDeps.shutdown, aborted as soon as
 *   stop() begins, before pg-boss is stopped) ends the run before its next
 *   model and abandons any read in flight, so the job returns well inside
 *   pg-boss's 10 s graceful stop and nothing is cut off. pg-boss's own
 *   job.signal, which it aborts only after that wait, is honoured too.
 * - A server that ran 0.1.1-rc.1 or rc.2 may have the step's schedule and
 *   jobs on the maintenance queue. Start-up removes that schedule, and a job
 *   of the step that arrives there ends at once, sending one job to the
 *   upgrade queue if the step is still pending.
 */
export const UPGRADE_TASKS = {
  reconvertDescriptions: "reconvert-descriptions",
} as const;

/** Every 5 minutes, while the description re-conversion is pending (#382). */
export const RECONVERT_CRON = "*/5 * * * *";

/**
 * How long the description re-conversion waits after a run that failed on an
 * outage: 5 minutes, doubling with each failure in a row, at most an hour.
 */
export function reconvertBackoffMs(failures: number): number {
  const minutes = 5 * 2 ** Math.max(0, Math.min(failures - 1, 4));
  return Math.min(minutes, 60) * 60_000;
}

/**
 * How long one upgrade job runs the description re-conversion before it
 * stops and sends the next job (#357), at most a third of the job's expiry
 * (15 minutes on the upgrade queue, pg-boss's default). pg-boss fails a
 * job that outlasts its expiry while the handler carries on, so a run in
 * slices never has its job failed. The run has its own queue, so the
 * maintenance tasks never wait for a slice. The run also stops when pg-boss
 * aborts the job's signal.
 */
export const RECONVERT_SLICE_SECONDS = 300;

/** The re-conversion's slice of a job with this expiry, in milliseconds. */
function reconvertSliceMs(expireInSeconds: number): number {
  const expiry = Number.isFinite(expireInSeconds) && expireInSeconds > 0 ? expireInSeconds : 900;
  return Math.min(RECONVERT_SLICE_SECONDS, expiry / 3) * 1000;
}

/**
 * Every 5 minutes (issue #316): the preview backfill (derived/derived.ts's
 * backfillPreviews), which queues one batch of STL and STEP previews when
 * none of the last is still waiting, and does nothing once every file has
 * one. It also runs once at startup. It is the backstop: a new batch is also
 * sent as soon as one finishes (derived/derived.ts's nextBackfillBatch, #417),
 * so this schedule only starts the backfill and restarts it if that chain breaks.
 */
export const BACKFILL_PREVIEWS_CRON = "*/5 * * * *";

/**
 * Every 10 minutes: the Orca-version poll, which also runs
 * once at startup.
 */
export const POLL_ORCA_CRON = "*/10 * * * *";

/** A job on the slicer queue names its kind; each kind has one handler. */
export interface SlicerJob {
  kind: string;
}

/**
 * The slicer queue's handlers by job kind: the estimates module's "slice", and the
 * render and mesh kinds (derived/). A handler gets the job with its retry count and
 * limit, so it can tell the last attempt.
 */
export type SlicerJobHandlers = Readonly<
  Record<string, (job: JobWithMetadata<SlicerJob>) => Promise<unknown>>
>;

/** Daily at 03:30, in the time zone the schedule names. */
export const PURGE_EXPIRED_CRON = "30 3 * * *";

/**
 * Daily at 04:00 local time, after the purge. Any hour works: the sweep only
 * deletes objects older than 24 hours.
 */
export const SWEEP_ORPHANS_CRON = "0 4 * * *";

/**
 * Daily at 04:35 local time (the maintainer, 2026-11-11): the delete of sessions
 * past their idle or absolute expiry. Expired rows already let nobody in, so
 * the hour only bounds how long they are kept; 04:35 is after the 03:30
 * purge and the 04:00 orphan sweep, and clear of every other schedule.
 */
export const PURGE_SESSIONS_CRON = "35 4 * * *";

/** Hourly, on the hour: the sweep of partial uploads untouched for 24 hours. */
export const SWEEP_UPLOADS_CRON = "0 * * * *";

/**
 * The process's local time zone, the one "03:30 local time" means: the
 * container's TZ, or UTC when none is set.
 */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export interface QueueDeps {
  /** Runs one ingest job: ingest.ts's ingestFile. */
  ingestFile(input: IngestInput): Promise<IngestResult>;
  /** The trash's purgeExpired (library/trash.ts). */
  purgeExpired(now: Date): Promise<unknown>;
  /** The orphan sweep (ingest/orphans.ts's sweepOrphans). */
  sweepOrphans(now: Date): Promise<unknown>;
  /**
   * The slicer queue's handlers by job kind (estimates, renders and meshes). With none,
   * the slicer queue is created but not worked.
   */
  slicerJobs?: SlicerJobHandlers;
  /**
   * The estimates module's Orca-version poll, when given: scheduled every 10 minutes and
   * run once at startup by startQueues itself.
   */
  pollOrca?(): Promise<unknown>;
  /**
   * Runs after a file is ingested, outside the ingest transaction: the estimates
   * module queues the file's estimates here. A failure is logged, never thrown,
   * since the file is already stored.
   */
  onIngested?(result: IngestResult): Promise<unknown>;
  /** The sweep of stale partial uploads (uploads/tus.ts's sweepStaleUploads). */
  sweepUploads(now: Date): Promise<unknown>;
  /**
   * The render check (derived/derived.ts's checkRenders), when given:
   * scheduled every 15 minutes (CHECK_RENDERS_CRON).
   */
  checkRenders?(now: Date): Promise<unknown>;
  /**
   * The delete of login sessions past either expiry (the sessions
   * repository's deleteExpired), when given: scheduled daily at 04:35
   * (PURGE_SESSIONS_CRON). Optional here so the tests that start the queues
   * for other work need not pass it; the server passes it, and the
   * server test fails if any maintenance task is left unscheduled.
   */
  purgeSessions?(now: Date): Promise<unknown>;
  /**
   * The upgrade task (UPGRADE_TASKS): the description re-conversion (#357,
   * library/reconvert.ts's run) and then the licence fill (#445), when
   * given with reconvertPending: driven while reconvertPending says it has
   * not finished (UPGRADE_TASKS says how). It stops after a model once stop
   * says true (its slice used) and at once when signal aborts (the server
   * stopping, or pg-boss failing the job), and resolves to RECONVERT_PAUSED
   * when it did. It rejects on an outage.
   */
  reconvertDescriptions?(stop: () => boolean, signal: AbortSignal): Promise<unknown>;
  /** True while the description re-conversion for the current converter has not finished. */
  reconvertPending?(): Promise<boolean>;
  /**
   * Aborted by the server as soon as its stop() begins, before pg-boss is
   * stopped, so work in hand ends at once (the description re-conversion).
   */
  shutdown?: AbortSignal;
  /**
   * The preview backfill (derived/derived.ts's backfillPreviews, issue
   * #316), when given: scheduled every 5 minutes (BACKFILL_PREVIEWS_CRON)
   * and run once at startup by startQueues itself.
   */
  backfillPreviews?(now: Date): Promise<unknown>;
  /**
   * Queues again the files a slicer with its sandbox off refused (derived/
   * derived.ts's requeueSandboxOff), when given: run right after each
   * preview backfill, on the same schedule and at startup.
   */
  requeueSandboxOff?(now: Date): Promise<unknown>;
  /** The zone the cron schedules run in; localTimeZone() when left out. */
  timeZone?: string;
  /** How often idle workers poll; pg-boss's default when left out. */
  pollingIntervalSeconds?: number;
}

/**
 * QueueDeps with the slicer, poll, ingest and render dependencies required:
 * what the server (main.ts) passes. With it, a server that leaves
 * the slicer queue without its worker, the Orca poll or the render check
 * without its schedule, or an ingested file without its estimates fails to
 * compile.
 */
export type ServerQueueDeps = QueueDeps &
  Required<
    Pick<
      QueueDeps,
      | "slicerJobs"
      | "pollOrca"
      | "onIngested"
      | "checkRenders"
      | "reconvertDescriptions"
      | "reconvertPending"
      | "backfillPreviews"
    >
  >;

interface MaintenanceJob {
  task: string;
}

/**
 * Creates the four queues, registers the maintenance schedules and starts
 * the ingest, maintenance and upgrade workers on a started boss. Safe on every start:
 * a queue that exists keeps its policy (the slicer queue's retry settings and
 * the ingest queue's expiry are applied again), and a schedule is keyed, so it is replaced rather than
 * added again. The re-conversion's schedule on the maintenance queue, left by
 * 0.1.1-rc.1 and rc.2, is removed (an error for one that is absent is
 * ignored). The slicer queue is worked, one job at a time, only when
 * slicerJobs is given; the Orca poll is scheduled, and run once before this
 * returns, only when pollOrca is; the render check is scheduled only when
 * checkRenders is, and the session delete only when purgeSessions is.
 */
export async function startQueues(boss: PgBoss, deps: QueueDeps): Promise<void> {
  const settings = queueSettings();
  for (const setting of [
    settings.ingest,
    settings.slicer,
    settings.maintenance,
    settings.upgrade,
  ]) {
    await boss.createQueue(setting.name, setting.queue);
  }
  // createQueue leaves a queue that exists as it is, so the slicer's retry
  // settings and the ingest expiry are applied to one made before they
  // existed too. The slicer queue keeps pg-boss's default expiry; its slice
  // and STEP conversion jobs set their own when sent.
  await boss.updateQueue(QUEUE.slicer, { ...SLICER_RETRY });
  await boss.updateQueue(QUEUE.ingest, { expireInSeconds: INGEST_EXPIRE_SECONDS });

  // missed: 'once' runs a job the app was down for when it comes back,
  // rather than waiting a day.
  const tz = deps.timeZone ?? localTimeZone();
  await boss.schedule(
    QUEUE.maintenance,
    PURGE_EXPIRED_CRON,
    { task: MAINTENANCE_TASKS.purgeExpired },
    { tz, key: MAINTENANCE_TASKS.purgeExpired, missed: "once" },
  );
  await boss.schedule(
    QUEUE.maintenance,
    SWEEP_ORPHANS_CRON,
    { task: MAINTENANCE_TASKS.sweepOrphans },
    { tz, key: MAINTENANCE_TASKS.sweepOrphans, missed: "once" },
  );
  if (deps.pollOrca) {
    await boss.schedule(
      QUEUE.maintenance,
      POLL_ORCA_CRON,
      { task: MAINTENANCE_TASKS.pollOrca },
      { tz, key: MAINTENANCE_TASKS.pollOrca },
    );
  }
  await boss.schedule(
    QUEUE.maintenance,
    SWEEP_UPLOADS_CRON,
    { task: MAINTENANCE_TASKS.sweepUploads },
    { tz, key: MAINTENANCE_TASKS.sweepUploads, missed: "once" },
  );
  if (deps.checkRenders) {
    await boss.schedule(
      QUEUE.maintenance,
      CHECK_RENDERS_CRON,
      { task: MAINTENANCE_TASKS.checkRenders },
      { tz, key: MAINTENANCE_TASKS.checkRenders },
    );
  }
  if (deps.purgeSessions) {
    await boss.schedule(
      QUEUE.maintenance,
      PURGE_SESSIONS_CRON,
      { task: MAINTENANCE_TASKS.purgeSessions },
      { tz, key: MAINTENANCE_TASKS.purgeSessions, missed: "once" },
    );
  }
  if (deps.backfillPreviews) {
    await boss.schedule(
      QUEUE.maintenance,
      BACKFILL_PREVIEWS_CRON,
      { task: MAINTENANCE_TASKS.backfillPreviews },
      { tz, key: MAINTENANCE_TASKS.backfillPreviews },
    );
  }

  // The description re-conversion ran on the maintenance queue in 0.1.1-rc.1
  // and rc.2 (#412): drop the schedule it left there, so it stops adding jobs.
  await boss
    .unschedule(QUEUE.maintenance, UPGRADE_TASKS.reconvertDescriptions)
    .catch(() => undefined);

  // The description re-conversion's job (UPGRADE_TASKS). Its back-off lives
  // in this process: a restart tries again at once.
  let reconvertFailures = 0;
  let reconvertRetryAt = 0;
  const sendReconvert = () =>
    boss.send(QUEUE.upgrade, { task: UPGRADE_TASKS.reconvertDescriptions }, { retryLimit: 0 });
  const unscheduleReconvert = () =>
    boss.unschedule(QUEUE.upgrade, UPGRADE_TASKS.reconvertDescriptions);
  const reconvertJob = async (job: { signal: AbortSignal; expireInSeconds: number }) => {
    const run = deps.reconvertDescriptions;
    const pending = deps.reconvertPending;
    if (!run || !pending) throw new Error("No description re-conversion is registered");
    if (deps.shutdown?.aborted || job.signal.aborted) return;
    if (Date.now() < reconvertRetryAt) return;
    const failed = (error: unknown) => {
      reconvertFailures += 1;
      const wait = reconvertBackoffMs(reconvertFailures);
      reconvertRetryAt = Date.now() + wait;
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `queues: the MakerWorld upgrade work stopped (${message.slice(0, 200)}); ` +
          `it goes on in ${wait / 60_000} minutes or at the next start`,
      );
    };
    let isPending: boolean;
    try {
      isPending = await pending();
    } catch (error) {
      failed(error);
      return;
    }
    if (!isPending) {
      await unscheduleReconvert().catch(() => undefined);
      return;
    }
    const stopping = new AbortController();
    const abort = () => stopping.abort();
    deps.shutdown?.addEventListener("abort", abort, { once: true });
    job.signal.addEventListener("abort", abort, { once: true });
    if (deps.shutdown?.aborted || job.signal.aborted) abort();
    const stopAt = Date.now() + reconvertSliceMs(job.expireInSeconds);
    let result: unknown;
    try {
      result = await run(() => Date.now() >= stopAt, stopping.signal);
    } catch (error) {
      // An error after the stop began is the stop's doing, not an outage.
      if (!stopping.signal.aborted) failed(error);
      return;
    } finally {
      deps.shutdown?.removeEventListener("abort", abort);
      job.signal.removeEventListener("abort", abort);
    }
    reconvertFailures = 0;
    reconvertRetryAt = 0;
    if (result === RECONVERT_PAUSED) {
      // Not while stopping: the next start, or the schedule, goes on.
      if (stopping.signal.aborted) return;
      await sendReconvert().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`queues: sending the next re-conversion job: ${message.slice(0, 200)}`);
      });
    } else if (result !== null) {
      await unscheduleReconvert().catch(() => undefined);
    }
  };

  // A re-conversion job found on the maintenance queue (#412): sends one job
  // to the upgrade queue if the step is still pending, and never throws.
  const handOverReconvert = async () => {
    try {
      if (deps.reconvertPending && (await deps.reconvertPending())) await sendReconvert();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`queues: moving the re-conversion job to upgrade: ${message.slice(0, 200)}`);
    }
  };

  const polling =
    deps.pollingIntervalSeconds === undefined
      ? {}
      : { pollingIntervalSeconds: deps.pollingIntervalSeconds };

  await boss.work<IngestInput, IngestResult>(
    QUEUE.ingest,
    { ...settings.ingest.work, ...polling },
    async ([job]) => {
      if (job === undefined) throw new Error("ingest worker was handed no job");
      const result = await deps.ingestFile(job.data);
      if (deps.onIngested) {
        try {
          await deps.onIngested(result);
        } catch (error) {
          // The file is stored; the Orca poll queues what was missed here.
          const message = error instanceof Error ? error.message : String(error);
          console.error(`queues: after ingesting file ${result.fileId}: ${message.slice(0, 200)}`);
        }
      }
      return result;
    },
  );

  const handlers = deps.slicerJobs;
  if (handlers) {
    // With metadata, so a handler sees its retry count and limit.
    const slicerWork = { ...settings.slicer.work, ...polling, includeMetadata: true as const };
    await boss.work<SlicerJob, unknown, typeof slicerWork>(
      QUEUE.slicer,
      slicerWork,
      async ([job]) => {
        if (job === undefined) throw new Error("slicer worker was handed no job");
        const kind = job.data?.kind;
        const handler =
          typeof kind === "string" && Object.hasOwn(handlers, kind) ? handlers[kind] : undefined;
        if (handler === undefined) {
          throw new Error(`Unknown slicer job kind: ${String(kind).slice(0, 64)}`);
        }
        return handler(job);
      },
    );
  }

  await boss.work<MaintenanceJob>(
    QUEUE.maintenance,
    { ...settings.maintenance.work, ...polling },
    async ([job]) => {
      if (job === undefined) throw new Error("maintenance worker was handed no job");
      switch (job.data.task) {
        case MAINTENANCE_TASKS.purgeExpired:
          await deps.purgeExpired(new Date());
          return;
        case MAINTENANCE_TASKS.sweepOrphans:
          await deps.sweepOrphans(new Date());
          return;
        case MAINTENANCE_TASKS.pollOrca:
          if (!deps.pollOrca) throw new Error("No Orca poll is registered");
          await deps.pollOrca();
          return;
        case MAINTENANCE_TASKS.sweepUploads:
          await deps.sweepUploads(new Date());
          return;
        case MAINTENANCE_TASKS.checkRenders:
          if (!deps.checkRenders) throw new Error("No render check is registered");
          await deps.checkRenders(new Date());
          return;
        case MAINTENANCE_TASKS.purgeSessions:
          if (!deps.purgeSessions) throw new Error("No session delete is registered");
          await deps.purgeSessions(new Date());
          return;
        case UPGRADE_TASKS.reconvertDescriptions:
          // Left on this queue by 0.1.1-rc.1 or rc.2: run no slice here; the
          // run goes on from the upgrade queue while the step is pending.
          await handOverReconvert();
          return;
        case MAINTENANCE_TASKS.backfillPreviews:
          if (!deps.backfillPreviews) throw new Error("No preview backfill is registered");
          await deps.backfillPreviews(new Date());
          await deps.requeueSandboxOff?.(new Date());
          return;
        default:
          throw new Error(`Unknown maintenance task: ${String(job.data.task).slice(0, 64)}`);
      }
    },
  );

  await boss.work<MaintenanceJob>(
    QUEUE.upgrade,
    { ...settings.upgrade.work, ...polling },
    async ([job]) => {
      if (job === undefined) throw new Error("upgrade worker was handed no job");
      if (job.data.task !== UPGRADE_TASKS.reconvertDescriptions) {
        throw new Error(`Unknown upgrade task: ${String(job.data.task).slice(0, 64)}`);
      }
      await reconvertJob(job);
    },
  );

  // The description re-conversion on upgrade (#357): while it is pending, its
  // schedule and a job now; once it has finished, no schedule. A failure here
  // is logged and never stops the app; the schedule, or the next start, goes on.
  if (deps.reconvertDescriptions && deps.reconvertPending) {
    try {
      if (await deps.reconvertPending()) {
        await boss.schedule(
          QUEUE.upgrade,
          RECONVERT_CRON,
          { task: UPGRADE_TASKS.reconvertDescriptions },
          { tz, key: UPGRADE_TASKS.reconvertDescriptions, retryLimit: 0 },
        );
        await sendReconvert();
      } else {
        await unscheduleReconvert();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`queues: queueing the description re-conversion: ${message.slice(0, 200)}`);
    }
  }

  // The Orca poll's startup run (it runs at startup and every 10 minutes) is
  // one job on the maintenance queue, so start-up does not wait while a whole
  // library is queued after an Orca upgrade (#461). The worker above takes it
  // at once. A failure to send it is logged and never stops the app: the next
  // scheduled poll does the same work.
  if (deps.pollOrca) {
    try {
      await boss.send(QUEUE.maintenance, { task: MAINTENANCE_TASKS.pollOrca }, { retryLimit: 0 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`queues: startup Orca poll: ${message.slice(0, 200)}`);
    }
  }

  // The preview backfill's startup run (issue #316), so the first batch
  // after an upgrade starts at once rather than at the next 5 minutes. A
  // failure is logged and never stops the app; the scheduled run tries again.
  if (deps.backfillPreviews) {
    try {
      await deps.backfillPreviews(new Date());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`queues: startup preview backfill: ${message.slice(0, 200)}`);
    }
    try {
      await deps.requeueSandboxOff?.(new Date());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`queues: startup sandbox requeue: ${message.slice(0, 200)}`);
    }
  }
}
