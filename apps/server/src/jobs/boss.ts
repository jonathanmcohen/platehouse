// The pg-boss instance: background jobs in
// the app's own Postgres, so there is no Redis. pg-boss owns the schema
// pgboss and creates and migrates it itself on
// start(); the app's migrations never touch it.
import { PgBoss } from "pg-boss";
import { POOL_CONNECT_TIMEOUT_MS } from "../db/kysely.js";

export const BOSS_SCHEMA = "pgboss";

function logBossError(error: Error): void {
  console.error(`pg-boss: ${error.message}`);
}

/**
 * A pg-boss instance on the app's database, not yet started. pg-boss emits
 * 'error' for failures in its own background work (polling, maintenance,
 * the cron pass); an EventEmitter 'error' with no listener ends the process,
 * so one is always attached: onError, or a line on stderr.
 */
export function createBoss(opts: {
  databaseUrl: string;
  onError?: (error: Error) => void;
}): PgBoss {
  // pg-boss has a pool of its own, so it gets the app pool's connect timeout:
  // a database that never answers fails its start instead of hanging it.
  const boss = new PgBoss({
    connectionString: opts.databaseUrl,
    schema: BOSS_SCHEMA,
    connectionTimeoutMillis: POOL_CONNECT_TIMEOUT_MS,
  });
  boss.on("error", opts.onError ?? logBossError);
  return boss;
}
