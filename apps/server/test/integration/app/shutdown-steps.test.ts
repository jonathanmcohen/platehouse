// Issue #106: a shutdown step that fails or overruns must end the process
// with exit 1, not 0. runShutdown is the step runner start()'s stop() uses;
// these drive it, and installSignalHandlers on top of it, with stand-in steps
// and a fake clock. stopBoss is the pg-boss step: pg-boss's graceful stop
// resolves even when it cuts active jobs off at its timeout, so the step
// counts the job handlers still running to see that, judged at its timeout.
// trackJobs is how start() counts every handler it gives startQueues, and
// stopAfterFailedStart is how a failed start() cleans up without losing the
// startup error.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ServerQueueDeps } from "../../../src/jobs/queues.js";
import {
  BOSS_STOP_TIMEOUT_MS,
  installSignalHandlers,
  jobCounter,
  runShutdown,
  SHUTDOWN_DEADLINE_MS,
  type ShutdownStep,
  type SignalTarget,
  stopAfterFailedStart,
  stopBoss,
  trackJobs,
} from "../../../src/main.js";

function fakeProcess() {
  const emitter = new EventEmitter();
  const exit = vi.fn<(code: number) => void>();
  const proc: SignalTarget & { emit(signal: string): void } = {
    on: (event, listener) => emitter.on(event, listener),
    exit,
    emit: (signal) => {
      emitter.emit(signal, signal);
    },
  };
  return { proc, exit };
}

/** Steps that record the order they ran in; the one named by fault fails or hangs. */
function steps(fault: "none" | "fails" | "overruns"): { ran: string[]; list: ShutdownStep[] } {
  const ran: string[] = [];
  const list: ShutdownStep[] = ["the HTTP server", "pg-boss", "the database"].map((label) => ({
    label,
    ms: 1_000,
    run: async () => {
      ran.push(label);
      if (label !== "pg-boss") return;
      if (fault === "fails") throw new Error("connection refused");
      if (fault === "overruns") await new Promise(() => {});
    },
  }));
  return { ran, list };
}

let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  errors.mockRestore();
});

describe("runShutdown", () => {
  test("a clean stop runs every step in order and resolves", async () => {
    const { ran, list } = steps("none");
    await expect(runShutdown(list)).resolves.toBeUndefined();
    expect(ran).toEqual(["the HTTP server", "pg-boss", "the database"]);
  });

  test("a step that fails still lets the later steps run, then the stop rejects", async () => {
    const { ran, list } = steps("fails");
    const stopped = runShutdown(list);
    const outcome = stopped.then(
      () => "resolved",
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(ran).toEqual(["the HTTP server", "pg-boss", "the database"]);
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("stopping pg-boss failed: connection refused");
  });

  test("a step that overruns still lets the later steps run, then the stop rejects", async () => {
    const { ran, list } = steps("overruns");
    const outcome = runShutdown(list).then(
      () => "resolved",
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(ran).toEqual(["the HTTP server", "pg-boss"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(ran).toEqual(["the HTTP server", "pg-boss", "the database"]);
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("pg-boss did not stop within 1 s");
  });

  test("every step that went wrong is named, not only the first", async () => {
    const list: ShutdownStep[] = [
      { label: "pg-boss", ms: 1_000, run: () => Promise.reject(new Error("boom")) },
      { label: "the database", ms: 1_000, run: () => new Promise(() => {}) },
    ];
    const outcome = runShutdown(list).then(
      () => "resolved",
      (error: unknown) => String(error),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const message = await outcome;
    expect(message).toContain("stopping pg-boss failed: boom");
    expect(message).toContain("the database did not stop within 1 s");
  });
});

describe("the process exit code", () => {
  test("a clean stop exits 0", async () => {
    const { proc, exit } = fakeProcess();
    installSignalHandlers(
      () => runShutdown(steps("none").list),
      proc,
      () => {},
    );
    proc.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  test("a step that fails exits 1", async () => {
    const { proc, exit } = fakeProcess();
    installSignalHandlers(
      () => runShutdown(steps("fails").list),
      proc,
      () => {},
    );
    proc.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  test("a step that overruns exits 1 once the later steps ran, well inside 30 s", async () => {
    const { proc, exit } = fakeProcess();
    const { ran, list } = steps("overruns");
    installSignalHandlers(
      () => runShutdown(list),
      proc,
      () => {},
    );
    proc.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ran).toEqual(["the HTTP server", "pg-boss", "the database"]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe("stopBoss", () => {
  test("stops pg-boss gracefully with its timeout", async () => {
    const stop = vi.fn(async () => {});
    await stopBoss({ stop }, () => 0);
    expect(stop).toHaveBeenCalledExactlyOnceWith({ graceful: true, timeout: BOSS_STOP_TIMEOUT_MS });
  });

  test("a job still running when pg-boss has stopped was cut off, and the step fails", async () => {
    const jobs = jobCounter();
    const handler = jobs.track(() => new Promise<void>(() => {}));
    void handler();
    await expect(stopBoss({ stop: async () => {} }, jobs.running)).rejects.toThrow(
      /1 job was still running/,
    );
  });

  // pg-boss's failWip calls fail(), which follows the queue's retry rules, so
  // a slicer job with retries left goes back to retry, not failed. The
  // message once said every cut-off job was marked failed (#151).
  test.each([
    [
      1,
      "1 job was still running at the 10 s limit and was cut off: pg-boss failed it, or queued it again where it has retries left",
    ],
    [
      2,
      "2 jobs were still running at the 10 s limit and were cut off: pg-boss failed them, or queued them again where they have retries left",
    ],
  ])("the message for %i cut-off job(s) does not claim each one failed", async (n, message) => {
    const stop = stopBoss({ stop: async () => {} }, () => n);
    await expect(stop).rejects.toThrow(message);
    await expect(stop).rejects.not.toThrow(/marked (it|them) failed/);
  });

  test("a job that finished within the grace period is not counted", async () => {
    const jobs = jobCounter();
    const handler = jobs.track(async (n: number) => n * 2);
    await expect(handler(21)).resolves.toBe(42);
    await expect(stopBoss({ stop: async () => {} }, jobs.running)).resolves.toBeUndefined();
  });

  test("a job that threw is not counted either", async () => {
    const jobs = jobCounter();
    const handler = jobs.track(async () => {
      throw new Error("slicer down");
    });
    await expect(handler()).rejects.toThrow("slicer down");
    expect(jobs.running()).toBe(0);
  });
});

describe("stopBoss at pg-boss's timeout", () => {
  test("a job still running at the timeout that ends before pg-boss returns was cut off", async () => {
    const jobs = jobCounter();
    // pg-boss marks the job failed at its timeout, then the handler ends,
    // then pg-boss finishes its own shutdown and returns.
    const handler = jobs.track(
      () => new Promise<void>((resolve) => setTimeout(resolve, BOSS_STOP_TIMEOUT_MS + 20)),
    );
    void handler();
    const stop = () =>
      new Promise<void>((resolve) => setTimeout(resolve, BOSS_STOP_TIMEOUT_MS + 50));
    const outcome = stopBoss({ stop }, jobs.running).then(
      () => "resolved",
      (error: unknown) => String(error),
    );
    await vi.advanceTimersByTimeAsync(BOSS_STOP_TIMEOUT_MS + 50);
    expect(jobs.running()).toBe(0);
    expect(await outcome).toMatch(/1 job was still running/);
  });

  test("a job that ended before the timeout is not counted, however long pg-boss takes", async () => {
    const jobs = jobCounter();
    const handler = jobs.track(
      () => new Promise<void>((resolve) => setTimeout(resolve, BOSS_STOP_TIMEOUT_MS - 1)),
    );
    void handler();
    const stop = () =>
      new Promise<void>((resolve) => setTimeout(resolve, BOSS_STOP_TIMEOUT_MS + 50));
    const outcome = stopBoss({ stop }, jobs.running);
    await vi.advanceTimersByTimeAsync(BOSS_STOP_TIMEOUT_MS + 50);
    await expect(outcome).resolves.toBeUndefined();
  });

  test("a pg-boss stop that throws still fails the step and leaves no timer behind", async () => {
    const outcome = stopBoss({ stop: () => Promise.reject(new Error("pool gone")) }, () => 0);
    await expect(outcome).rejects.toThrow("pool gone");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("trackJobs", () => {
  /** A ServerQueueDeps whose every handler waits until released, recording its name. */
  function pendingDeps() {
    const release: Array<() => void> = [];
    const pending = () =>
      new Promise<never>((resolve) => {
        release.push(() => resolve(undefined as never));
      });
    const deps: ServerQueueDeps = {
      ingestFile: pending,
      purgeExpired: pending,
      sweepOrphans: pending,
      sweepUploads: pending,
      slicerJobs: { slice: pending, "render-scad": pending },
      pollOrca: pending,
      onIngested: pending,
      checkRenders: pending,
      purgeSessions: pending,
      timeZone: "UTC",
      pollingIntervalSeconds: 1,
    };
    return { deps, release };
  }

  test("every handler startQueues is given is counted while it runs", async () => {
    const jobs = jobCounter();
    const { deps, release } = pendingDeps();
    const tracked = trackJobs(jobs, deps);
    type Handler = () => Promise<unknown>;
    const handlers: Array<[string, Handler]> = [];
    for (const [key, value] of Object.entries(tracked)) {
      if (typeof value === "function") handlers.push([key, value as Handler]);
    }
    for (const [kind, value] of Object.entries(tracked.slicerJobs)) {
      handlers.push([`slicerJobs.${kind}`, value as unknown as Handler]);
    }
    expect(handlers.map(([key]) => key).sort()).toEqual(
      [
        "checkRenders",
        "ingestFile",
        "onIngested",
        "pollOrca",
        "purgeExpired",
        "purgeSessions",
        "slicerJobs.render-scad",
        "slicerJobs.slice",
        "sweepOrphans",
        "sweepUploads",
      ].sort(),
    );
    const runs: Promise<unknown>[] = [];
    for (const [key, handler] of handlers) {
      const before = jobs.running();
      runs.push(handler());
      expect(jobs.running(), key).toBe(before + 1);
    }
    for (const r of release) r();
    await Promise.all(runs);
    expect(jobs.running()).toBe(0);
  });

  test("a handler added to the deps later is counted without naming it", async () => {
    const jobs = jobCounter();
    const { deps } = pendingDeps();
    const extra = { ...deps, futureTask: () => new Promise<void>(() => {}) };
    const tracked = trackJobs(jobs, extra) as typeof extra;
    void tracked.futureTask();
    expect(jobs.running()).toBe(1);
  });

  test("settings that are not handlers are passed through unchanged", () => {
    const { deps } = pendingDeps();
    const tracked = trackJobs(jobCounter(), deps);
    expect(tracked.timeZone).toBe("UTC");
    expect(tracked.pollingIntervalSeconds).toBe(1);
  });
});

describe("stopAfterFailedStart", () => {
  test("the startup error surfaces when the cleanup also fails, and the cleanup is logged", async () => {
    const startup = Object.assign(
      new Error("listen EADDRINUSE: address already in use 0.0.0.0:8080"),
      {
        code: "EADDRINUSE",
      },
    );
    const stop = () =>
      Promise.reject(
        new Error(
          "the shutdown was not clean: stopping pg-boss failed: 1 job was still running at the 10 s limit",
        ),
      );
    await expect(stopAfterFailedStart(startup, stop)).rejects.toBe(startup);
    const logged = errors.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
    expect(logged).toContain("the shutdown was not clean");
  });

  test("the startup error surfaces after a clean cleanup", async () => {
    const startup = new Error("migration failed");
    const stop = vi.fn(async () => {});
    await expect(stopAfterFailedStart(startup, stop)).rejects.toBe(startup);
    expect(stop).toHaveBeenCalledOnce();
  });
});
