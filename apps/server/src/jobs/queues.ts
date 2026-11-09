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

// Stub below: the interface only, so the failing tests compile; the
// implementation follows in the next commit.

export const MAINTENANCE_TASKS = { purgeExpired: "purge-expired" } as const;

export const PURGE_EXPIRED_CRON = "30 3 * * *";

export function localTimeZone(): string {
  throw new Error("localTimeZone is not implemented yet");
}

export interface QueueDeps {
  ingestFile(input: IngestInput): Promise<IngestResult>;
  purgeExpired(now: Date): Promise<unknown>;
  slicerConcurrency: number;
  timeZone?: string;
  pollingIntervalSeconds?: number;
}

export async function startQueues(_boss: PgBoss, _deps: QueueDeps): Promise<void> {
  throw new Error("startQueues is not implemented yet");
}
