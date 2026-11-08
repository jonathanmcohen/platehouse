// A throwaway Postgres 17 for the database tests, built on startPostgres().
// Each test file starts one container; freshDatabase() makes an empty
// database inside it, so tests that need a clean slate (the migration tests)
// do not pay for another container.
import { randomBytes } from "node:crypto";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { Kysely } from "kysely";
import pg from "pg";
import { createDb } from "../../../src/db/kysely.js";
import type { DB } from "../../../src/db/types.js";
import { startPostgres } from "./containers.js";

export interface TestDatabase {
  url: string;
  db: Kysely<DB>;
}

export interface TestPostgres {
  container: StartedPostgreSqlContainer;
  /** An empty database of its own; closed when stop() runs. */
  freshDatabase(): Promise<TestDatabase>;
  stop(): Promise<void>;
}

export async function startTestPostgres(): Promise<TestPostgres> {
  const container = await startPostgres();
  const opened: Kysely<DB>[] = [];
  return {
    container,
    async freshDatabase() {
      const name = `t_${randomBytes(6).toString("hex")}`;
      const admin = new pg.Client({ connectionString: container.getConnectionUri() });
      await admin.connect();
      try {
        await admin.query(`create database ${name}`);
      } finally {
        await admin.end();
      }
      const url = new URL(container.getConnectionUri());
      url.pathname = `/${name}`;
      const db = createDb(url.toString());
      opened.push(db);
      return { url: url.toString(), db };
    },
    async stop() {
      await Promise.all(opened.map((db) => db.destroy()));
      await container.stop();
    },
  };
}

/** The SQLSTATE of a rejected promise, for asserting on constraint errors. */
export async function sqlState(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  throw new Error("expected the statement to fail, and it succeeded");
}
