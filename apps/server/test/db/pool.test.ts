import { EventEmitter } from "node:events";
import type pg from "pg";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createPool } from "../../src/db/kysely.js";

// pg-pool emits 'error' on the pool when an idle client it holds loses its
// connection (Postgres restarted, or the db container was recreated). A client
// that is checked out, as it is for a whole transaction, has no pool listener:
// pg-pool removes it on checkout and puts it back on release, so that client
// emits 'error' on itself. An 'error' event with no listener is an uncaught
// error in Node and ends the process, so createPool must listen in both
// places. Building a pg.Pool opens no connection, so this needs no database;
// the real dropped connections are tested under
// test/integration/db/pool.test.ts.

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

  test("gives every new client a listener of its own, so a checked-out client's error goes to onError", () => {
    const onError = vi.fn();
    pool = createPool(URL_NO_SERVER, { onError });
    // pg-pool emits 'connect' once per new client, before handing it out.
    const client = new EventEmitter() as unknown as pg.PoolClient;
    pool.emit("connect", client);
    expect(client.listenerCount("error")).toBe(1);

    const error = new Error("terminating connection due to administrator command");
    expect(() => client.emit("error", error)).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error);
  });

  test("reports a failed client once, though its errors reach both the client and the pool", () => {
    const onError = vi.fn();
    pool = createPool(URL_NO_SERVER, { onError });
    const idle = new EventEmitter() as unknown as pg.PoolClient;
    const checkedOut = new EventEmitter() as unknown as pg.PoolClient;
    pool.emit("connect", idle);
    pool.emit("connect", checkedOut);

    // An idle client: pg-pool's own listener runs first and re-emits on the
    // pool, then the client's listener sees the same error; then the socket
    // closes and the client emits a second error.
    const fatal = new Error("terminating connection due to administrator command");
    pool.emit("error", fatal, idle);
    idle.emit("error", fatal);
    idle.emit("error", new Error("Connection terminated unexpectedly"));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenLastCalledWith(fatal);

    // A checked-out client: only its own listener hears it, twice.
    const fatal2 = new Error("terminating connection due to administrator command");
    checkedOut.emit("error", fatal2);
    checkedOut.emit("error", new Error("Connection terminated unexpectedly"));
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenLastCalledWith(fatal2);
  });
});
