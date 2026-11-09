// The pg-boss queues (build plan Task 8, decision 6). Background work runs in
// the same Postgres, so there is no Redis:
// - ingest: an uploaded file through the ingest pipeline, two at once, never
//   retried, so a failed upload fails visibly (AC-012);
// - slicer: the singleton queue for slicer work, worked at SLICER_CONCURRENCY
//   (default 1). Task 12 adds its slice jobs and Task 13 its render and mesh
//   jobs; the slicer answers 409 busy while any heavy job runs, and those
//   jobs retry on 409. Nothing here sends to it or works it;
// - maintenance: the cron jobs, one at a time. Task 14's purgeExpired(now)
//   runs daily at 03:30 local time (issue #38).
import type { PgBoss } from "pg-boss";
import type { IngestInput, IngestResult } from "../ingest/ingest.js";

export const QUEUE = {
  ingest: "ingest",
  slicer: "slicer",
  maintenance: "maintenance",
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

/** Ingest jobs worked at once (Task 8 Interfaces). */
export const INGEST_CONCURRENCY = 2;

export interface QueueSetting {
  name: QueueName;
  /** createQueue options. */
  queue: { policy: "standard" | "singleton"; retryLimit?: number };
  /** work options. */
  work: { localConcurrency: number };
}

/** How each queue is created and worked. Task 12 works the slicer queue with its setting. */
export function queueSettings(opts: {
  slicerConcurrency: number;
}): Record<keyof typeof QUEUE, QueueSetting> {
  const n = opts.slicerConcurrency;
  if (!Number.isSafeInteger(n) || n < 1) {
    throw new RangeError("slicerConcurrency must be a whole number of 1 or more");
  }
  return {
    ingest: {
      name: QUEUE.ingest,
      queue: { policy: "standard", retryLimit: 0 },
      work: { localConcurrency: INGEST_CONCURRENCY },
    },
    slicer: {
      name: QUEUE.slicer,
      queue: { policy: "singleton" },
      work: { localConcurrency: n },
    },
    maintenance: {
      name: QUEUE.maintenance,
      queue: { policy: "standard" },
      work: { localConcurrency: 1 },
    },
  };
}

/**
 * The maintenance queue's tasks, each a job { task } and its schedule key.
 * Task 9 adds the hourly sweep of stale partial uploads here.
 */
export const MAINTENANCE_TASKS = {
  purgeExpired: "purge-expired",
  sweepOrphans: "sweep-orphans",
} as const;

/** Daily at 03:30, in the time zone the schedule names (Task 14 decision). */
export const PURGE_EXPIRED_CRON = "30 3 * * *";

/** Daily at 04:00 local time, after the purge. */
export const SWEEP_ORPHANS_CRON = "0 4 * * *";

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
  /** The orphan sweep (ingest/orphans.ts). */
  sweepOrphans(now: Date): Promise<unknown>;
  /** SLICER_CONCURRENCY. */
  slicerConcurrency: number;
  /** The zone the cron schedules run in; localTimeZone() when left out. */
  timeZone?: string;
  /** How often idle workers poll; pg-boss's default when left out. */
  pollingIntervalSeconds?: number;
}

interface MaintenanceJob {
  task: string;
}

/**
 * Creates the three queues, registers the maintenance schedules and starts
 * the ingest and maintenance workers on a started boss. Safe on every start:
 * a queue that exists is left as it is, and a schedule is keyed, so it is
 * replaced rather than added again. The slicer queue gets no worker here;
 * Task 12 works it with queueSettings().slicer.work.
 */
export async function startQueues(boss: PgBoss, deps: QueueDeps): Promise<void> {
  const settings = queueSettings({ slicerConcurrency: deps.slicerConcurrency });
  for (const setting of [settings.ingest, settings.slicer, settings.maintenance]) {
    await boss.createQueue(setting.name, setting.queue);
  }

  // missed: 'once' runs a purge the app was down for when it comes back,
  // rather than waiting a day.
  await boss.schedule(
    QUEUE.maintenance,
    PURGE_EXPIRED_CRON,
    { task: MAINTENANCE_TASKS.purgeExpired },
    { tz: deps.timeZone ?? localTimeZone(), key: MAINTENANCE_TASKS.purgeExpired, missed: "once" },
  );

  const polling =
    deps.pollingIntervalSeconds === undefined
      ? {}
      : { pollingIntervalSeconds: deps.pollingIntervalSeconds };

  await boss.work<IngestInput, IngestResult>(
    QUEUE.ingest,
    { ...settings.ingest.work, ...polling },
    async ([job]) => {
      if (job === undefined) throw new Error("ingest worker was handed no job");
      return deps.ingestFile(job.data);
    },
  );

  await boss.work<MaintenanceJob>(
    QUEUE.maintenance,
    { ...settings.maintenance.work, ...polling },
    async ([job]) => {
      if (job === undefined) throw new Error("maintenance worker was handed no job");
      switch (job.data.task) {
        case MAINTENANCE_TASKS.purgeExpired:
          await deps.purgeExpired(new Date());
          return;
        default:
          throw new Error(`Unknown maintenance task: ${String(job.data.task).slice(0, 64)}`);
      }
    },
  );
}
