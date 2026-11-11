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
//      server starts while it is down.
//
// stop() undoes it in the order Task 30 sets: no new HTTP requests (requests
// in flight get HTTP_CLOSE_GRACE_MS, then their connections are closed), the
// inbox watcher, pg-boss (gracefully: active jobs get BOSS_STOP_TIMEOUT_MS,
// then pg-boss marks them failed; a slicer job then runs again on its
// retries, an ingest job, never retried, fails visibly), then the database. Each step
// has its own time limit and a step that fails or overruns is logged and the
// next one runs, so the whole stop fits well inside SHUTDOWN_DEADLINE_MS. The
// signal handler adds that deadline as a last resort: past 30 s the process
// exits 1 whatever is still running.
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import type { PgBoss } from "pg-boss";
import { buildApp } from "./app.js";
import { createOidc } from "./auth/oidc.js";
import { loginCookieKey } from "./auth/routes.js";
import { createSessions, dbSessionStore } from "./auth/sessions.js";
import { type Config, ConfigError, loadConfig } from "./config.js";
import { createDb } from "./db/kysely.js";
import { migrate } from "./db/migrate.js";
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

/** How long active jobs get to finish before pg-boss marks them failed. */
export const BOSS_STOP_TIMEOUT_MS = 10_000;

/** How long closing the database pool may take. */
export const DB_CLOSE_MS = 3_000;

export interface Server {
  app: FastifyInstance;
  /** Stops the HTTP server, the inbox watcher, pg-boss and the database, in that order. */
  stop(): Promise<void>;
}

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/**
 * Runs one shutdown step. It never throws: a step that fails or takes longer
 * than ms is logged and the shutdown goes on to the next one.
 */
async function step(label: string, ms: number, run: () => Promise<unknown>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), ms);
  });
  try {
    const outcome = await Promise.race([run().then(() => "done" as const), late]);
    if (outcome === "late") {
      console.error(`shutdown: ${label} did not stop within ${ms / 1000} s; going on`);
    }
  } catch (error) {
    console.error(`shutdown: stopping ${label} failed: ${describe(error)}`);
  } finally {
    clearTimeout(timer);
  }
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

  async function shutdown(): Promise<void> {
    queuesRunning = false;
    const http = app;
    if (http !== undefined) {
      await step("the HTTP server", HTTP_CLOSE_GRACE_MS + 2_000, () =>
        closeHttp(http, HTTP_CLOSE_GRACE_MS),
      );
    }
    const inbox = watcher;
    if (inbox !== undefined) await step("the inbox watcher", WATCHER_STOP_MS, () => inbox.stop());
    const queues = boss;
    if (queues !== undefined) {
      await step("pg-boss", BOSS_STOP_TIMEOUT_MS + 2_000, () =>
        queues.stop({ graceful: true, timeout: BOSS_STOP_TIMEOUT_MS }),
      );
    }
    await step("the database", DB_CLOSE_MS, () => db.destroy());
    store.destroy();
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
    const ingest = createIngest({
      db,
      store,
      afterCommit: (stored) => derived.afterUpload(stored),
    });
    const uploads = createUploads({ tmpDir: config.tmpDir, queue: bossUploadQueue(startedBoss) });
    const trash = createTrash({ db, store });
    const orphans = createOrphanSweep({ db, store });
    const onIngested = (result: IngestResult) => estimates.enqueueFile(result.fileId);

    const queueDeps: ServerQueueDeps = {
      ingestFile: uploads.ingestUpload((input) => ingest.ingestFile(input)),
      purgeExpired: (now) => trash.purgeExpired(now),
      sweepOrphans: (now) => orphans.sweepOrphans(now),
      sweepUploads: (now) => uploads.sweepStaleUploads(now),
      slicerJobs: { ...derivedJobHandlers(derived), ...estimates.slicerJobs },
      pollOrca: () => estimates.pollOrca(),
      onIngested,
      checkRenders: (now) => derived.checkRenders(now),
      purgeSessions: (now) => repos.sessions.deleteExpired(now),
    };
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
      logger: true,
    });
    app = startedApp;
    await startedApp.listen({ port: config.port, host: "0.0.0.0" });
    return { app: startedApp, stop };
  } catch (error) {
    await stop();
    throw error;
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
