// A dropped idle connection must not end the server. Postgres restarting, or
// the db container being recreated (Watchtower, a compose recreate), kills the
// connections the pool holds idle; pg-pool then emits 'error' on the pool,
// which ends the process unless something listens. createDb attaches that
// listener (see createPool).
import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createDb } from "../../../src/db/kysely.js";
import { startTestPostgres, type TestPostgres } from "../support/db.js";

let pgc: TestPostgres;

beforeAll(async () => {
  pgc = await startTestPostgres();
});

afterAll(async () => {
  await pgc?.stop();
});

describe("createDb pool", () => {
  test("an idle connection terminated by Postgres goes to onError and the pool carries on", async () => {
    const { url } = await pgc.freshDatabase();
    const onError = vi.fn();
    // One connection, so the second query has to come from a new client.
    const db = createDb(url, { max: 1, onError });
    try {
      const before = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db);
      const pid = before.rows[0]?.pid;
      expect(pid).toBeTypeOf("number");

      // The client is back in the pool, idle. End its backend from outside.
      const admin = new pg.Client({ connectionString: pgc.container.getConnectionUri() });
      await admin.connect();
      try {
        await admin.query("select pg_terminate_backend($1)", [pid]);
      } finally {
        await admin.end();
      }

      await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1), { timeout: 10_000 });
      expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);

      const after = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db);
      expect(after.rows[0]?.pid).toBeTypeOf("number");
      expect(after.rows[0]?.pid).not.toBe(pid);
    } finally {
      await db.destroy();
    }
  });
});
