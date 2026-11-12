// Issue #106: a shutdown step that fails or overruns must end the process
// with exit 1, not 0. runShutdown is the step runner start()'s stop() uses;
// these drive it, and installSignalHandlers on top of it, with stand-in steps
// and a fake clock. stopBoss is the pg-boss step: pg-boss's graceful stop
// resolves even when it cuts active jobs off at its timeout, so the step
// counts the job handlers still running to see that.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  BOSS_STOP_TIMEOUT_MS,
  installSignalHandlers,
  jobCounter,
  runShutdown,
  SHUTDOWN_DEADLINE_MS,
  type ShutdownStep,
  type SignalTarget,
  stopBoss,
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
