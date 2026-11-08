// A dropped connection must not end the server. Postgres restarting, or the
// db container being recreated (Watchtower, a compose recreate), kills every
// connection: those the pool holds idle, where pg-pool emits 'error' on the
// pool, and one checked out for a transaction, where the client emits 'error'
// on itself. Either ends the process unless something listens; createDb
// attaches both listeners (see createPool). An uncaught 'error' here would
// show up as an unhandled error and fail the vitest run.
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

/** Ends a backend from a separate connection, as a Postgres shutdown would. */
async function terminateBackend(pid: number): Promise<void> {
  const admin = new pg.Client({ connectionString: pgc.container.getConnectionUri() });
  await admin.connect();
  try {
    await admin.query("select pg_terminate_backend($1)", [pid]);
  } finally {
    await admin.end();
  }
}

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
      await terminateBackend(pid as number);

      await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1), { timeout: 10_000 });
      expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);

      const after = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db);
      expect(after.rows[0]?.pid).toBeTypeOf("number");
      expect(after.rows[0]?.pid).not.toBe(pid);
    } finally {
      await db.destroy();
    }
  });

  test("a connection terminated inside a transaction goes to onError once, the transaction rejects and the pool carries on", async () => {
    const { url } = await pgc.freshDatabase();
    const onError = vi.fn();
    // One connection, so the query after the transaction needs a new client.
    const db = createDb(url, { max: 1, onError });
    try {
      let pid: number | undefined;
      const run = db.transaction().execute(async (trx) => {
        const inside = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx);
        pid = inside.rows[0]?.pid;
        expect(pid).toBeTypeOf("number");

        // The client is checked out and idle in transaction, so the FATAL
        // arrives with no query running and the client emits 'error' itself.
        await terminateBackend(pid as number);
        await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1), { timeout: 10_000 });

        await sql`select 1`.execute(trx);
      });

      await expect(run).rejects.toThrow();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);

      const after = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db);
      expect(after.rows[0]?.pid).toBeTypeOf("number");
      expect(after.rows[0]?.pid).not.toBe(pid);
      expect(onError).toHaveBeenCalledTimes(1);
    } finally {
      await db.destroy();
    }
  });
});
