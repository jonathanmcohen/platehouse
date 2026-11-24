// The re-conversion lease (#423) without Docker: the database is a Kysely
// whose driver answers the take and delete queries and lets a test decide
// what a renewal does. The lease against a real Postgres is tested in
// test/integration/library/reconvert.test.ts.
import {
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from "kysely";
import { describe, expect, test } from "vitest";
import type { DB } from "../../src/db/types.js";
import { descriptionsRepo } from "../../src/repos/descriptions.js";

function leaseDb(renewal: () => Promise<QueryResult<unknown>>): Kysely<DB> {
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      const text = query.sql.trim();
      if (text.startsWith("update")) return (await renewal()) as QueryResult<R>;
      if (text.startsWith("insert")) {
        return { rows: [{ holder: "h" }] as R[], numAffectedRows: 1n };
      }
      return { rows: [], numAffectedRows: 1n };
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
    async beginTransaction() {},
    async commitTransaction() {},
    async rollbackTransaction() {},
    async releaseConnection() {},
    async destroy() {},
  };
  return new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

/** Resolves when the signal aborts, or rejects after a real second. */
function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("never aborted")), 1_000);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

describe("the lease's renewal", () => {
  test("a renewal that never answers still loses the lease before it runs out", async () => {
    const repo = descriptionsRepo(leaseDb(() => new Promise(() => {})));
    const out = await repo.exclusive(
      "step",
      async (lost) => {
        await aborted(lost);
        return "stopped";
      },
      { renewMs: 10, leaseMs: 100 },
    );
    expect(out).toBe("stopped");
  });

  test("a renewal that answers keeps the lease", async () => {
    const repo = descriptionsRepo(
      leaseDb(async () => ({ rows: [{ holder: "h" }], numAffectedRows: 1n })),
    );
    const out = await repo.exclusive(
      "step",
      async (lost) => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        return lost.aborted;
      },
      { renewMs: 10, leaseMs: 100 },
    );
    expect(out).toBe(false);
  });

  test("one renewal that fails, followed by one that works, keeps the lease", async () => {
    let calls = 0;
    const repo = descriptionsRepo(
      leaseDb(async () => {
        calls += 1;
        if (calls === 1) throw new Error("connection reset");
        return { rows: [{ holder: "h" }], numAffectedRows: 1n };
      }),
    );
    // The first renewal fails at 50 ms, when 50 ms of the 100 ms lease has
    // passed since the take: the lease's safe margin is already reached, but
    // the failed renewal returned, so only a hung one may give the lease up.
    const out = await repo.exclusive(
      "step",
      async (lost) => {
        await new Promise((resolve) => setTimeout(resolve, 280));
        return lost.aborted;
      },
      { renewMs: 50, leaseMs: 100 },
    );
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(out).toBe(false);
  });

  test("two renewals in a row that fail lose the lease", async () => {
    const repo = descriptionsRepo(
      leaseDb(async () => {
        throw new Error("connection reset");
      }),
    );
    const out = await repo.exclusive(
      "step",
      async (lost) => {
        await aborted(lost);
        return "stopped";
      },
      { renewMs: 10, leaseMs: 1_000 },
    );
    expect(out).toBe("stopped");
  });

  test("a renewal that finds no row loses the lease", async () => {
    const repo = descriptionsRepo(leaseDb(async () => ({ rows: [], numAffectedRows: 0n })));
    const out = await repo.exclusive(
      "step",
      async (lost) => {
        await aborted(lost);
        return "stopped";
      },
      { renewMs: 10, leaseMs: 1_000 },
    );
    expect(out).toBe("stopped");
  });
});
