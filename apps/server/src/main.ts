// The server process (build plan Task 30; AC-021, AC-033, AC-093 app side).
// Run as the entry module it reads the configuration from the environment
// (loadConfig, which names a missing key and never prints a value), starts
// the server and stops it on SIGTERM or SIGINT. start(config) is the whole
// server, for the tests as for the process:
//
//   1. the database: a pool, then migrate() (forward only, under an advisory
//      lock, so two starting servers apply each migration once);
//   2. pg-boss, started on the same database;
//   3. the services, each built once and shared: the slicer client and
//      estimates (Task 12), the render jobs (Task 13), ingest with
//      derived.afterUpload as its afterCommit, so a .scad or STEP file queues
//      its render once its row commits however it arrived, the tus upload
//      store (Task 9), the trash (Task 14) and the orphan sweep (Task 8);
//   4. the queues (startQueues) with a ServerQueueDeps, so every queue has
//      its worker and every maintenance task its schedule: the slicer
//      worker dispatches by job kind to estimates' "slice" and the render
//      and mesh kinds, an ingested file's plates are queued at once
//      (onIngested), and the Orca poll also runs once at startup;
//   5. the inbox watcher (Task 10), wired exactly as its own comment and the
//      #59 changelog line ask, then started;
//   6. the Fastify app (app.ts), listening on PORT on every interface, with
//      login (Task 15): sessions in the sessions table, the OIDC client for
//      OIDC_ISSUER with redirect_uri absoluteUrl('/auth/callback'), and the
//      login cookie's key derived from LINK_SECRET (loginCookieKey). Pocket
//      ID is not contacted at startup, only at the first login, so the
//      server starts while it is down. The Public API v1 (Task 16) gets
//      tokens from the api_tokens table and reads the library through the
//      same database, store and estimates.plateNumbers; it never touches
//      Pocket ID, so API tokens keep working while it is down (AC-081).
//      File delivery and slicer links (Task 17) read files through that
//      same library and blobs through the same database and store, and
//      sign links with a key links.ts derives from LINK_SECRET.
//
// stop() undoes it in the order Task 30 sets: no new HTTP requests (requests
// in flight get HTTP_CLOSE_GRACE_MS, then their connections are closed), the
// inbox watcher, pg-boss (gracefully: active jobs get BOSS_STOP_TIMEOUT_MS,
// then pg-boss fails them by their queue's retry rules; a slicer job then
// runs again on its retries, an ingest job, never retried, fails visibly),
// then the database and the storage client. Each step
// has its own time limit and a step that fails or overruns is logged and the
// next one runs, so the whole stop fits well inside SHUTDOWN_DEADLINE_MS.
// Once the last step has run, stop() rejects if any step failed or overran,
// or if pg-boss cut a job off at its timeout, so the process exits 1 and only
// a clean stop exits 0 (#106). When start() itself fails, the same stop runs,
// but a failed cleanup is only logged and the startup error is what start()
// throws. The signal handler adds that deadline as a last resort: past 30 s
// the process exits 1 whatever is still running.
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import type { PgBoss } from "pg-boss";
import { createTokens, dbTokenStore } from "./api/tokens.js";
import { createApiLibrary } from "./api/v1.js";
import { buildApp } from "./app.js";
import { createOidc } from "./auth/oidc.js";
import { loginCookieKey } from "./auth/routes.js";
import { createSessions, dbSessionStore } from "./auth/sessions.js";
import { type Config, ConfigError, loadConfig } from "./config.js";
import { createDb } from "./db/kysely.js";
import { migrate } from "./db/migrate.js";
import { createDeliveryLibrary } from "./delivery/download.js";
import { createDerived, derivedJobHandlers } from "./derived/derived.js";
import { createSlicerClient, sliceTimeoutMs } from "./estimates/client.js";
import { createEstimates } from "./estimates/service.js";
import { createInboxWatcher, type InboxWatcher, inboxProbes } from "./inbox/watch.js";
import { createIngest, type IngestResult } from "./ingest/ingest.js";
import { createOrphanSweep } from "./ingest/orphans.js";
import { createBoss } from "./jobs/boss.js";
import { type ServerQueueDeps, startQueues } from "./jobs/queues.js";
import { createTrash } from "./library/trash.js";
import { createRepos } from "./repos/index.js";
import { createBlobStore } from "./storage/s3.js";
import { bossUploadQueue, createUploads } from "./uploads/tus.js";

/** The longest a shutdown may take before the process exits anyway. */
export const SHUTDOWN_DEADLINE_MS = 30_000;

/** How long requests in flight get once the server stops taking new ones. */
export const HTTP_CLOSE_GRACE_MS = 5_000;

/** How long the inbox watcher's pass in flight gets to finish. */
export const WATCHER_STOP_MS = 5_000;

/**
 * How long active jobs get to finish before pg-boss cuts them off: it fails
 * each one by its queue's retry rules, so a job with retries left is queued
 * again.
 */
export const BOSS_STOP_TIMEOUT_MS = 10_000;

/** How long closing the database pool may take. */
export const DB_CLOSE_MS = 3_000;

export interface Server {
  app: FastifyInstance;
  /**
   * Stops the HTTP server, the inbox watcher, pg-boss, the database and the
   * storage client, in that order, each within its own time limit. Every step
   * runs even when one before it failed; then it rejects, naming each step
   * that failed or overran and any job pg-boss cut off at its timeout, so
   * only a clean stop resolves (#106, #151).
   */
  stop(): Promise<void>;
}

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/** One step of a shutdown: what it stops, its time limit, and how. */
export interface ShutdownStep {
  label: string;
  ms: number;
  run(): Promise<unknown>;
}

/**
 * Runs one shutdown step. It never throws: a step that fails or takes longer
 * than its limit is logged, and what went wrong is returned so the shutdown
 * can go on to the next step and still report it at the end.
 */
async function step({ label, ms, run }: ShutdownStep): Promise<string | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), ms);
  });
  try {
    const outcome = await Promise.race([run().then(() => "done" as const), late]);
    if (outcome === "done") return undefined;
    const problem = `${label} did not stop within ${ms / 1000} s`;
    console.error(`shutdown: ${problem}; going on`);
    return problem;
  } catch (error) {
    const problem = `stopping ${label} failed: ${describe(error)}`;
    console.error(`shutdown: ${problem}`);
    return problem;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs the steps in order. Every step runs even when an earlier one failed
 * or overran; once the last has run, the shutdown rejects if any of them
 * went wrong, naming each, so the process exits 1 rather than 0 (#106).
 */
export async function runShutdown(steps: readonly ShutdownStep[]): Promise<void> {
  const problems: string[] = [];
  for (const s of steps) {
    const problem = await step(s);
    if (problem !== undefined) problems.push(problem);
  }
  if (problems.length > 0) throw new Error(`the shutdown was not clean: ${problems.join("; ")}`);
}

/**
 * Counts the job handlers that are running. pg-boss's graceful stop resolves
 * the same way whether every active job finished or some were still running
 * at its timeout (it marks those failed and stops waiting for them), so this
 * count is how the shutdown tells the two apart.
 */
export function jobCounter() {
  let running = 0;
  return {
    track<A extends unknown[], R>(handler: (...args: A) => Promise<R>) {
      return async (...args: A): Promise<R> => {
        running += 1;
        try {
          return await handler(...args);
        } finally {
          running -= 1;
        }
      };
    },
    running: (): number => running,
  };
}

export type JobCounter = ReturnType<typeof jobCounter>;

/**
 * The queue dependencies with every handler counted (jobs): each top-level
 * function and each slicer job kind. It wraps whatever handlers it is given
 * rather than a list of names, so a handler added to ServerQueueDeps later is
 * counted without anyone remembering to; settings that are not functions
 * pass through unchanged.
 */
export function trackJobs<D extends ServerQueueDeps>(jobs: JobCounter, deps: D): D {
  const tracked: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(deps)) {
    if (key === "slicerJobs" && typeof value === "object" && value !== null) {
      tracked[key] = Object.fromEntries(
        Object.entries(value as Record<string, (...args: unknown[]) => Promise<unknown>>).map(
          ([kind, handler]) => [kind, jobs.track(handler)],
        ),
      );
    } else if (typeof value === "function") {
      tracked[key] = jobs.track(value as (...args: unknown[]) => Promise<unknown>);
    } else {
      tracked[key] = value;
    }
  }
  return tracked as D;
}

/**
 * The pg-boss step: a graceful stop, which gives active jobs
 * BOSS_STOP_TIMEOUT_MS. It fails when a job handler is still running at that
 * limit, since pg-boss then cuts that job off and marks it failed. The count
 * is taken when the limit passes, not when pg-boss returns: after its
 * timeout pg-boss still fails the active jobs, drains, stops its registrar
 * and closes its pool, and a handler that ends in that window has already
 * been marked failed, though the count would read 0 by then. pg-boss starts
 * its own timer only after stopping its notifier and other parts, so this
 * one fires at or a little before pg-boss's; a handler that ends in that gap
 * is counted as cut off too, which errs towards exit 1, never towards a
 * false clean stop.
 */
export async function stopBoss(boss: Pick<PgBoss, "stop">, running: () => number): Promise<void> {
  let atLimit = 0;
  const limit = setTimeout(() => {
    atLimit = running();
  }, BOSS_STOP_TIMEOUT_MS);
  try {
    await boss.stop({ graceful: true, timeout: BOSS_STOP_TIMEOUT_MS });
  } finally {
    clearTimeout(limit);
  }
  const cut = Math.max(atLimit, running());
  if (cut > 0) {
    // pg-boss fails a cut-off job by the queue's retry rules, so a slicer job
    // with retries left is queued again, not failed (#151).
    const one = cut === 1;
    throw new Error(
      `${cut} ${one ? "job was" : "jobs were"} still running at the ` +
        `${BOSS_STOP_TIMEOUT_MS / 1000} s limit and ${one ? "was" : "were"} cut off: ` +
        `pg-boss failed ${one ? "it" : "them"}, or queued ${one ? "it" : "them"} again where ` +
        `${one ? "it has" : "they have"} retries left`,
    );
  }
}

/**
 * The cleanup after start() failed part way: stops what had started, then
 * rethrows the startup error. A cleanup that fails as well (a step that
 * overran, a job cut off) is logged and never replaces the startup error,
 * which is the cause the operator needs to see.
 */
export async function stopAfterFailedStart(
  error: unknown,
  stop: () => Promise<void>,
): Promise<never> {
  try {
    await stop();
  } catch (cleanup) {
    console.error(`platehouse: cleaning up after the failed start: ${describe(cleanup)}`);
  }
  throw error;
}

/** Stops taking requests, gives those in flight graceMs, then closes their connections. */
async function closeHttp(app: FastifyInstance, graceMs: number): Promise<void> {
  const timer = setTimeout(() => app.server.closeAllConnections(), graceMs);
  try {
    await app.close();
  } finally {
    clearTimeout(timer);
  }
}

export async function start(config: Config): Promise<Server> {
  const db = createDb(config.databaseUrl);
  const store = createBlobStore(config.s3);
  let boss: PgBoss | undefined;
  let watcher: InboxWatcher | undefined;
  let app: FastifyInstance | undefined;
  let queuesRunning = false;
  let stopping: Promise<void> | undefined;
  const jobs = jobCounter();

  async function shutdown(): Promise<void> {
    queuesRunning = false;
    const steps: ShutdownStep[] = [];
    const http = app;
    if (http !== undefined) {
      steps.push({
        label: "the HTTP server",
        ms: HTTP_CLOSE_GRACE_MS + 2_000,
        run: () => closeHttp(http, HTTP_CLOSE_GRACE_MS),
      });
    }
    const inbox = watcher;
    if (inbox !== undefined) {
      steps.push({ label: "the inbox watcher", ms: WATCHER_STOP_MS, run: () => inbox.stop() });
    }
    const queues = boss;
    if (queues !== undefined) {
      steps.push({
        label: "pg-boss",
        ms: BOSS_STOP_TIMEOUT_MS + 2_000,
        run: () => stopBoss(queues, jobs.running),
      });
    }
    steps.push({ label: "the database", ms: DB_CLOSE_MS, run: () => db.destroy() });
    steps.push({ label: "the storage client", ms: 1_000, run: async () => store.destroy() });
    await runShutdown(steps);
  }

  const stop = (): Promise<void> => {
    stopping ??= shutdown();
    return stopping;
  };

  try {
    await migrate(db);

    const startedBoss = createBoss({ databaseUrl: config.databaseUrl });
    boss = startedBoss;
    startedBoss.on("stopped", () => {
      queuesRunning = false;
    });
    await startedBoss.start();

    const repos = createRepos(db);
    const slicer = createSlicerClient({
      url: config.slicer.url,
      plateSeconds: config.slicer.plateSeconds,
    });
    const estimates = createEstimates({
      db,
      boss: startedBoss,
      slicer,
      store,
      sliceTimeoutMs: sliceTimeoutMs(config.slicer.plateSeconds),
    });
    const derived = createDerived({ db, store, slicerUrl: config.slicer.url, queue: startedBoss });
    // Two hooks on purpose, afterCommit here and onIngested below (Jon,
    // 2026-11-11): afterCommit runs inside ingestFile, only for the attempt
    // whose rows committed, while onIngested also runs on the inbox
    // watcher's lost-answer path (inbox/watch.ts, earlierImport), where an
    // earlier attempt's import is found and ingestFile is not called again.
    // Folding the render into onIngested would change when renders are
    // queued; a render that path misses is picked up by checkRenders.
    const ingest = createIngest({
      db,
      store,
      afterCommit: (stored) => derived.afterUpload(stored),
    });
    const uploads = createUploads({ tmpDir: config.tmpDir, queue: bossUploadQueue(startedBoss) });
    const trash = createTrash({ db, store });
    const orphans = createOrphanSweep({ db, store });
    const onIngested = (result: IngestResult) => estimates.enqueueFile(result.fileId);

    // Every handler a pg-boss worker runs is counted (jobs), so stopping
    // pg-boss can tell a job cut off at its timeout from a clean stop. The
    // inbox watcher's onIngested is not a job and stays uncounted.
    const queueDeps = trackJobs(jobs, {
      ingestFile: uploads.ingestUpload((input) => ingest.ingestFile(input)),
      purgeExpired: (now: Date) => trash.purgeExpired(now),
      sweepOrphans: (now: Date) => orphans.sweepOrphans(now),
      sweepUploads: (now: Date) => uploads.sweepStaleUploads(now),
      slicerJobs: { ...derivedJobHandlers(derived), ...estimates.slicerJobs },
      pollOrca: () => estimates.pollOrca(),
      onIngested,
      checkRenders: (now: Date) => derived.checkRenders(now),
      purgeSessions: (now: Date) => repos.sessions.deleteExpired(now),
    } satisfies ServerQueueDeps);
    await startQueues(startedBoss, queueDeps);
    queuesRunning = true;

    const startedWatcher = createInboxWatcher({
      dir: config.inbox.dir,
      settleSeconds: config.inbox.settleSeconds,
      tmpDir: config.tmpDir,
      ingest,
      storedFile: (id) => repos.files.get(id),
      findImported: (q) => repos.files.findImported(q),
      onIngested,
      probes: inboxProbes({ db, store, tmpDir: config.tmpDir }),
    });
    watcher = startedWatcher;
    startedWatcher.start();

    // One library for the API's content route and the file deliveries, so
    // both find a live file and its stored blob the same way.
    const apiLibrary = createApiLibrary({
      db,
      store,
      plateNumbers: (plateId) => estimates.plateNumbers(plateId),
    });
    const startedApp = await buildApp({
      health: {
        database: () => sql`select 1`.execute(db),
        queuesRunning: () => queuesRunning,
      },
      uploads,
      auth: {
        oidc: createOidc({
          issuer: config.oidc.issuer,
          clientId: config.oidc.clientId,
          clientSecret: config.oidc.clientSecret,
          redirectUri: config.absoluteUrl("/auth/callback"),
          group: config.oidc.group,
        }),
        sessions: createSessions({ store: dbSessionStore(db) }),
        publicOrigin: config.publicOrigin,
        absoluteUrl: (path) => config.absoluteUrl(path),
        group: config.oidc.group,
        cookieSecret: loginCookieKey(config.linkSecret),
      },
      api: { tokens: createTokens({ store: dbTokenStore(db) }), library: apiLibrary },
      delivery: {
        files: apiLibrary,
        library: createDeliveryLibrary({ db, store }),
        linkSecret: config.linkSecret,
      },
      logger: true,
    });
    app = startedApp;
    await startedApp.listen({ port: config.port, host: "0.0.0.0" });
    return { app: startedApp, stop };
  } catch (error) {
    return stopAfterFailedStart(error, stop);
  }
}

/** The part of process the signal handling uses. */
export interface SignalTarget {
  on(event: "SIGTERM" | "SIGINT", listener: (signal: NodeJS.Signals) => void): unknown;
  exit(code: number): void;
}

/**
 * On the first SIGTERM or SIGINT: stop the server, then exit 0, or 1 when the
 * stop failed or is still running at SHUTDOWN_DEADLINE_MS. A second signal
 * during the shutdown exits 1 at once.
 */
export function installSignalHandlers(
  stop: () => Promise<void>,
  proc: SignalTarget = process,
  log: (line: string) => void = console.info,
): void {
  let stopping = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping) {
      log(`platehouse: ${signal} again during the shutdown; exiting now`);
      proc.exit(1);
      return;
    }
    stopping = true;
    log(`platehouse: ${signal}; shutting down`);
    const deadline = setTimeout(() => {
      log(`platehouse: the shutdown took longer than ${SHUTDOWN_DEADLINE_MS / 1000} s; exiting`);
      proc.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    deadline.unref();
    stop().then(
      () => {
        clearTimeout(deadline);
        log("platehouse: stopped");
        proc.exit(0);
      },
      (error: unknown) => {
        clearTimeout(deadline);
        log(`platehouse: the shutdown failed: ${describe(error)}`);
        proc.exit(1);
      },
    );
  };
  proc.on("SIGTERM", onSignal);
  proc.on("SIGINT", onSignal);
}

/** The process: configuration from the environment, the server, the signals. */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let config: Config;
  try {
    config = loadConfig(env);
  } catch (error) {
    // A ConfigError names the keys and never a value.
    if (error instanceof ConfigError) {
      console.error(`platehouse: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
  const server = await start(config);
  installSignalHandlers(server.stop);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`platehouse: could not start: ${describe(error)}`);
    process.exit(1);
  });
}
