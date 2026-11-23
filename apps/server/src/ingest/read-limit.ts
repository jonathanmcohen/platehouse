// How many .3mf reads ingest runs at once, for the whole process. The memory
// budget (test/compose-example.test.ts) counts INGEST_CONCURRENCY of them,
// each at most PROJECT_READ_PEAK_BYTES. The ingest queue works that many
// jobs at once (jobs/queues.ts), but the inbox watcher calls ingestFile
// directly, outside the queue (inbox/watch.ts), so the queue alone does not
// hold the count: every read goes through projectReads, one limit shared by
// the queue's jobs and the inbox together. A read past the limit waits, first
// come first served, until one ends; nothing is refused.

/** Ingest jobs worked at once, and .3mf reads run at once by ingest in all. */
export const INGEST_CONCURRENCY = 2;

export interface ReadLimit {
  /** Runs task once fewer than the limit are running, and hands back its result. */
  run<T>(task: () => Promise<T>): Promise<T>;
}

export function createReadLimit(max: number): ReadLimit {
  let running = 0;
  const waiting: Array<() => void> = [];

  const next = (): void => {
    const start = waiting.shift();
    if (start === undefined) running -= 1;
    else start();
  };

  return {
    async run<T>(task: () => Promise<T>): Promise<T> {
      // A place freed is handed straight to the first waiting task, so the
      // count never drops between them and no later caller can slip in.
      if (running < max) running += 1;
      else await new Promise<void>((resolve) => waiting.push(resolve));
      try {
        return await task();
      } finally {
        next();
      }
    },
  };
}

/** The process's one limit on ingest's .3mf reads. */
export const projectReads: ReadLimit = createReadLimit(INGEST_CONCURRENCY);
