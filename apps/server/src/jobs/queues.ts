// The pg-boss queues (build plan Task 8, decision 6). Background work runs in
// the same Postgres, so there is no Redis:
// - ingest: an uploaded file through the ingest pipeline, two at once, never
//   retried, so a failed upload fails visibly (AC-012);
// - slicer: the singleton queue for slicer work, one job at a time, matching
//   the slicer's own one-job lock (Jon, 2026-11-08, PR #49: there is no
//   SLICER_CONCURRENCY, since the singleton policy made it a no-op). Task 12
//   adds its slice jobs and Task 13 its render and mesh jobs; the slicer
//   answers 409 busy while any heavy job runs, and those jobs retry on 409
//   through the queue's own retry settings (SLICER_RETRY). Each job names
//   its kind, and the worker hands it to that kind's handler (slicerJobs);
// - after an ingest job stores a file, onIngested queues its estimates
//   (Task 12), outside the ingest transaction;
// - maintenance: the cron jobs, one at a time. Task 14's purgeExpired(now)
//   runs daily at 03:30 local time (issue #38), the orphan sweep
//   (ingest/orphans.ts) daily at 04:00 local time, Task 9's sweep of
//   partial uploads untouched for 24 hours (uploads/tus.ts) every hour,
//   Task 12's Orca-version poll every 10 minutes, and Task 13's render check
//   (derived/derived.ts's checkRenders) every 15 minutes (CHECK_RENDERS_CRON).
// The server (main.ts, Task 30) passes a ServerQueueDeps, which requires
// every dependency that is optional here, so it cannot leave a queue without
// its worker or a schedule without its handler.
import type { JobWithMetadata, PgBoss } from "pg-boss";
import { CHECK_RENDERS_CRON } from "../derived/derived.js";
import type { IngestInput, IngestResult } from "../ingest/ingest.js";

export const QUEUE = {
  ingest: "ingest",
  slicer: "slicer",
  maintenance: "maintenance",
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

/** Ingest jobs worked at once (Task 8 Interfaces). */
export const INGEST_CONCURRENCY = 2;

/**
 * How a slicer job is retried when the slicer answers 409 busy or the
 * connection to it is lost (build plan Task 12; Task 13's render and mesh
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

export interface QueueSetting {
  name: QueueName;
  /** createQueue options. */
  queue: {
    policy: "standard" | "singleton";
    retryLimit?: number;
    retryBackoff?: boolean;
    retryDelay?: number;
    retryDelayMax?: number;
  };
  /** work options. */
  work: { localConcurrency: number };
}

/** How each queue is created and worked. Task 12 works the slicer queue with its setting. */
export function queueSettings(): Record<keyof typeof QUEUE, QueueSetting> {
  return {
    ingest: {
      name: QUEUE.ingest,
      queue: { policy: "standard", retryLimit: 0 },
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
  };
}

/** The maintenance queue's tasks, each a job { task } and its schedule key. */
export const MAINTENANCE_TASKS = {
  purgeExpired: "purge-expired",
  sweepOrphans: "sweep-orphans",
  pollOrca: "poll-orca",
  sweepUploads: "sweep-uploads",
  checkRenders: "check-renders",
} as const;

/**
 * Every 10 minutes (Task 12 decision): the Orca-version poll, which also runs
 * once at startup.
 */
export const POLL_ORCA_CRON = "*/10 * * * *";

/** A job on the slicer queue names its kind; each kind has one handler. */
export interface SlicerJob {
  kind: string;
}

/**
 * The slicer queue's handlers by job kind: Task 12's "slice", and Task 13's
 * render and mesh kinds. A handler gets the job with its retry count and
 * limit, so it can tell the last attempt.
 */
export type SlicerJobHandlers = Readonly<
  Record<string, (job: JobWithMetadata<SlicerJob>) => Promise<unknown>>
>;

/** Daily at 03:30, in the time zone the schedule names (Task 14 decision). */
export const PURGE_EXPIRED_CRON = "30 3 * * *";

/**
 * Daily at 04:00 local time, after the purge. Any hour works: the sweep only
 * deletes objects older than 24 hours.
 */
export const SWEEP_ORPHANS_CRON = "0 4 * * *";

/** Hourly, on the hour (Task 9): the sweep of partial uploads untouched for 24 hours. */
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
  /** Task 14's purgeExpired (library/trash.ts). */
  purgeExpired(now: Date): Promise<unknown>;
  /** The orphan sweep (ingest/orphans.ts's sweepOrphans). */
  sweepOrphans(now: Date): Promise<unknown>;
  /**
   * The slicer queue's handlers by job kind (Task 12, Task 13). With none,
   * the slicer queue is created but not worked.
   */
  slicerJobs?: SlicerJobHandlers;
  /**
   * Task 12's Orca-version poll, when given: scheduled every 10 minutes and
   * run once at startup by startQueues itself.
   */
  pollOrca?(): Promise<unknown>;
  /**
   * Runs after a file is ingested, outside the ingest transaction: Task 12
   * queues the file's estimates here. A failure is logged, never thrown,
   * since the file is already stored.
   */
  onIngested?(result: IngestResult): Promise<unknown>;
  /** Task 9's sweep of stale partial uploads (uploads/tus.ts's sweepStaleUploads). */
  sweepUploads(now: Date): Promise<unknown>;
  /**
   * Task 13's render check (derived/derived.ts's checkRenders), when given:
   * scheduled every 15 minutes (CHECK_RENDERS_CRON).
   */
  checkRenders?(now: Date): Promise<unknown>;
  /** The zone the cron schedules run in; localTimeZone() when left out. */
  timeZone?: string;
  /** How often idle workers poll; pg-boss's default when left out. */
  pollingIntervalSeconds?: number;
}

/**
 * QueueDeps with every optional dependency required: what the server passes
 * (build plan Task 30). With it, a server that leaves the slicer queue
 * without its worker, the Orca poll or the render check without its
 * schedule, or an ingested file without its estimates fails to compile.
 */
export type ServerQueueDeps = QueueDeps &
  Required<Pick<QueueDeps, "slicerJobs" | "pollOrca" | "onIngested" | "checkRenders">>;

interface MaintenanceJob {
  task: string;
}

/**
 * Creates the three queues, registers the maintenance schedules and starts
 * the ingest and maintenance workers on a started boss. Safe on every start:
 * a queue that exists keeps its policy (the slicer queue's retry settings are
 * applied again), and a schedule is keyed, so it is replaced rather than
 * added again. The slicer queue is worked, one job at a time, only when
 * slicerJobs is given; the Orca poll is scheduled, and run once before this
 * returns, only when pollOrca is; the render check is scheduled only when
 * checkRenders is.
 */
export async function startQueues(boss: PgBoss, deps: QueueDeps): Promise<void> {
  const settings = queueSettings();
  for (const setting of [settings.ingest, settings.slicer, settings.maintenance]) {
    await boss.createQueue(setting.name, setting.queue);
  }
  // createQueue leaves a queue that exists as it is, so the slicer's retry
  // settings are applied to one made before they existed too.
  await boss.updateQueue(QUEUE.slicer, { ...SLICER_RETRY });

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
        default:
          throw new Error(`Unknown maintenance task: ${String(job.data.task).slice(0, 64)}`);
      }
    },
  );

  // The Orca poll's startup run (Task 12 decision: at startup and every 10
  // minutes), here beside its schedule. It runs after the workers start, so
  // the slices it queues are worked at once. A failure, such as a slicer that
  // is not up yet, is logged and never stops the app: the next scheduled poll
  // does the same work.
  if (deps.pollOrca) {
    try {
      await deps.pollOrca();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`queues: startup Orca poll: ${message.slice(0, 200)}`);
    }
  }
}
