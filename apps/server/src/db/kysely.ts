import { CamelCasePlugin, Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { DB } from "./types.js";

// The one Kysely instance the server builds over a pg pool. CamelCasePlugin
// maps the camelCase names in types.ts to the snake_case names in the SQL.

export interface DbOptions {
  /** Most connections the pool opens. */
  max?: number;
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

export function createDb(connectionString: string, options: DbOptions = {}): Kysely<DB> {
  const pool = new pg.Pool({ connectionString, types, max: options.max ?? 10 });
  return new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
    plugins: [new CamelCasePlugin()],
  });
}
