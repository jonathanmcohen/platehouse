// Stopping while start() is still running (#457): an abort is noticed between
// the start-up steps, and a signal that arrives during start-up stops the
// process at once instead of waiting for a step that may never finish.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { type Server, START_ABORT_WAIT_MS, start, stopWhileStarting } from "../src/main.js";

function config() {
  return loadConfig({
    PUBLIC_ORIGIN: "https://platehouse.test",
    // Nothing listens on port 1: reaching migrate would fail with a connection error.
    DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:1/none",
    S3_ENDPOINT: "http://127.0.0.1:1",
    S3_REGION: "test-1",
    S3_BUCKET: "test-bucket",
    S3_ACCESS_KEY_ID: "test-access",
    S3_SECRET_ACCESS_KEY: "test-secret-value",
    S3_FORCE_PATH_STYLE: "true",
    OIDC_ISSUER: "https://id.platehouse.test",
    OIDC_CLIENT_ID: "platehouse-test",
    OIDC_CLIENT_SECRET: "test-oidc-secret-value",
    LINK_SECRET: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  });
}

describe("start", () => {
  test("start stops at the next step when aborted", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(start(config(), { signal: abort.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("stopWhileStarting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("aborts, and waits for start() to unwind and stops what it started", async () => {
    const abort = new AbortController();
    const stop = vi.fn(async () => {});
    const starting = new Promise<Server>((resolve) => {
      abort.signal.addEventListener("abort", () => resolve({ stop } as unknown as Server));
    });
    const log = vi.fn();
    await stopWhileStarting(abort, starting, START_ABORT_WAIT_MS, log);
    expect(abort.signal.aborted).toBe(true);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  test("an aborted start-up that rejects is a clean stop", async () => {
    const abort = new AbortController();
    const starting = Promise.reject(new Error("aborted"));
    await expect(stopWhileStarting(abort, starting, 5_000, vi.fn())).resolves.toBeUndefined();
  });

  test("gives up on a start() that does not unwind, logging it, after the wait and not before", async () => {
    const abort = new AbortController();
    const starting = new Promise<Server>(() => {});
    const log = vi.fn();
    let done = false;
    void stopWhileStarting(abort, starting, START_ABORT_WAIT_MS, log).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(START_ABORT_WAIT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    expect(log).toHaveBeenCalledWith("platehouse: stopped during start-up");
  });

  test("a server that did start is stopped in full, however long the stop takes", async () => {
    const abort = new AbortController();
    let stopped = false;
    const stop = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, START_ABORT_WAIT_MS * 3));
      stopped = true;
    });
    const log = vi.fn();
    const done = stopWhileStarting(
      abort,
      Promise.resolve({ stop } as unknown as Server),
      5_000,
      log,
    );
    await vi.advanceTimersByTimeAsync(START_ABORT_WAIT_MS * 3);
    await done;
    expect(stopped).toBe(true);
    expect(log).not.toHaveBeenCalled();
  });

  test("waits 5 s for start() to unwind", () => {
    expect(START_ABORT_WAIT_MS).toBe(5_000);
  });
});
