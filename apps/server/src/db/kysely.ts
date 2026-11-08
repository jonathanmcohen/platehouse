import type { Kysely } from "kysely";
import type { DB } from "./types.js";

export interface DbOptions {
  /** Most connections the pool opens. */
  max?: number;
}

export function createDb(_connectionString: string, _options: DbOptions = {}): Kysely<DB> {
  throw new Error("not implemented: createDb");
}
