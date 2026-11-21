import { CamelCasePlugin, Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { DB } from "./types.js";

// The one Kysely instance the server builds over a pg pool. CamelCasePlugin
// maps the camelCase names in types.ts to the snake_case names in the SQL.

export interface DbOptions {
  /** Most connections the pool opens. */
  max?: number;
  /**
   * Called once for each pooled connection that fails, for example when
   * Postgres restarts or the db container is recreated. That covers an idle
   * connection and one checked out for a query or a transaction; in the
   * second case the query or transaction also rejects. pg-pool drops the
   * failed client (an idle one at once, a checked-out one when it is
   * released) and opens a new one on the next query. With no handler the
   * error is written to stderr. Either way the process carries on.
   */
  onError?: (error: Error) => void;
}

const INT8_OID = 20;

// bigint (int8) arrives from pg as text, because it can exceed what a JS
// number holds exactly. Platehouse's bigints are byte counts and count(*)
// results, far below 2^53, so they are read as numbers; a value past
// Number.MAX_SAFE_INTEGER throws rather than lose precision silently.
function parseInt8(text: string): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`bigint ${text} is beyond Number.MAX_SAFE_INTEGER`);
  }
  return value;
}

const types: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: "text" | "binary") =>
    oid === INT8_OID && format !== "binary"
      ? parseInt8
      : pg.types.getTypeParser(oid, format ?? "text")) as pg.CustomTypesConfig["getTypeParser"],
};

/**
 * Runs fn in a transaction: the caller's, when db already is one (Kysely
 * cannot nest them), or a new one. Repository calls that write more than one
 * statement use this, so they are all-or-nothing either way.
 */
export function inTransaction<T>(db: Kysely<DB>, fn: (trx: Kysely<DB>) => Promise<T>): Promise<T> {
  return db.isTransaction ? fn(db) : db.transaction().execute(fn);
}

function logPoolError(error: Error): void {
  console.error(`postgres: a pooled connection failed and was dropped: ${error.message}`);
}

/**
 * The pg pool under createDb. An 'error' event nobody listens to ends the
 * Node process, and a lost connection raises one in two places:
 * - an idle client: pg-pool's own listener on the client re-emits the error
 *   on the pool, so the pool gets a listener;
 * - a checked-out client, as one is for a whole transaction: pg-pool removes
 *   its listener on checkout and puts it back only on release, and Kysely
 *   adds none, so the client emits 'error' on itself. Every new client gets
 *   a listener of its own for its whole life, added on the pool's 'connect'.
 * A failing client can emit more than one error (Postgres sends a FATAL, then
 * the socket closes), and an idle one reaches both listeners, so onError
 * hears about each client once.
 */
export function createPool(connectionString: string, options: DbOptions = {}): pg.Pool {
  const pool = new pg.Pool({ connectionString, types, max: options.max ?? 10 });
  const onError = options.onError ?? logPoolError;
  const reported = new WeakSet<pg.PoolClient>();
  const report = (error: Error, client: pg.PoolClient): void => {
    if (reported.has(client)) return;
    reported.add(client);
    onError(error);
  };
  pool.on("error", (error, client) => report(error, client));
  pool.on("connect", (client) => {
    client.on("error", (error) => report(error, client));
  });
  return pool;
}

export function createDb(connectionString: string, options: DbOptions = {}): Kysely<DB> {
  const pool = createPool(connectionString, options);
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new CamelCasePlugin()],
  });
}
