// The pg-boss instance: background jobs in
// the app's own Postgres, so there is no Redis. pg-boss owns the schema
// pgboss and creates and migrates it itself on
// start(); the app's migrations never touch it.
import { CompiledQuery, type Transaction } from "kysely";
import { PgBoss } from "pg-boss";
import { POOL_CONNECT_TIMEOUT_MS } from "../db/kysely.js";
import type { DB } from "../db/types.js";

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

/**
 * pg-boss's db option over a Kysely transaction, so a job is sent, or a
 * file's jobs are read, inside that transaction. Without plugins, so the
 * CamelCasePlugin leaves pg-boss's own SQL and rows alone.
 */
export function bossDb(trx: Transaction<DB>) {
  const raw = trx.withoutPlugins();
  return {
    async executeSql(text: string, values: unknown[] = []) {
      const result = await raw.executeQuery(CompiledQuery.raw(text, values));
      return { rows: result.rows as unknown[] };
    },
  };
}
