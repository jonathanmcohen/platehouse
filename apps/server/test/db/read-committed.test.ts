// Issue #414: token creation from Settings and Sign out everywhere wait for
// each other only because, under READ COMMITTED, each statement in Sign out
// everywhere takes a fresh snapshot, so its revoke sees a token committed
// while its delete waited. Under a stricter database default the revoke could
// miss that token, so both transactions ask for READ COMMITTED themselves.
//
// These run without Docker: the database is a Kysely whose driver records
// each transaction's settings and answers every query with no rows. The race
// itself is tested against a real Postgres in
// test/integration/auth/sessions-db.test.ts.
import {
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
  type TransactionSettings,
} from "kysely";
import { describe, expect, test } from "vitest";
import type { DB } from "../../src/db/types.js";
import { sessionsRepo } from "../../src/repos/sessions.js";
import { tokensRepo } from "../../src/repos/tokens.js";

/** A database that answers every query with no rows, and the settings of each transaction begun on it. */
function recordingDb(): { db: Kysely<DB>; begun: TransactionSettings[] } {
  const begun: TransactionSettings[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(_query: CompiledQuery): Promise<QueryResult<R>> {
      return { rows: [], numAffectedRows: 0n };
    },
    streamQuery(): never {
      throw new Error("streamQuery is not scripted");
    },
  };
  const driver: Driver = {
    async init() {},
    async acquireConnection() {
      return connection;
    },
    async beginTransaction(_connection, settings) {
      begun.push(settings);
    },
    async commitTransaction() {},
    async rollbackTransaction() {},
    async releaseConnection() {},
    async destroy() {},
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, begun };
}

describe("the transactions that serialise token creation and Sign out everywhere", () => {
  test("token creation for a session asks for READ COMMITTED", async () => {
    const { db, begun } = recordingDb();
    const token = { name: "laptop", prefix: "abcdefgh", tokenHash: Buffer.alloc(32) };

    await tokensRepo(db).createForSession("session-id", token, () => true);

    expect(begun).toEqual([{ isolationLevel: "read committed" }]);
  });

  test("Sign out everywhere asks for READ COMMITTED", async () => {
    const { db, begun } = recordingDb();

    await sessionsRepo(db).signOutEverywhere("subject-a", true);

    expect(begun).toEqual([{ isolationLevel: "read committed" }]);
  });
});
