import type pg from "pg";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createPool } from "../../src/db/kysely.js";

// pg-pool emits 'error' on the pool when an idle client it holds loses its
// connection (Postgres restarted, or the db container was recreated). An
// 'error' event with no listener is an uncaught error in Node and ends the
// process, so createPool must always attach one. Building a pg.Pool opens no
// connection, so this needs no database; the real dropped connection is
// tested under test/integration/db/pool.test.ts.

// Nothing listens on port 1; the pool never connects in these tests.
const URL_NO_SERVER = "postgres://platehouse@127.0.0.1:1/platehouse";

let pool: pg.Pool | undefined;

afterEach(async () => {
  await pool?.end();
  pool = undefined;
  vi.restoreAllMocks();
});

describe("createPool", () => {
  test("hands an idle client's error to onError and does not throw", () => {
    const onError = vi.fn();
    pool = createPool(URL_NO_SERVER, { onError });
    const error = new Error("terminating connection due to administrator command");

    expect(() => pool?.emit("error", error, {} as pg.PoolClient)).not.toThrow();
    expect(onError).toHaveBeenCalledWith(error);
  });

  test("with no onError, logs the error to stderr instead of crashing", () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    pool = createPool(URL_NO_SERVER);
    const error = new Error("Connection terminated unexpectedly");

    expect(() => pool?.emit("error", error, {} as pg.PoolClient)).not.toThrow();
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(String(stderr.mock.calls[0]?.[0])).toContain("Connection terminated unexpectedly");
  });

  test("attaches exactly one error listener", () => {
    pool = createPool(URL_NO_SERVER);
    expect(pool.listenerCount("error")).toBe(1);
  });
});
