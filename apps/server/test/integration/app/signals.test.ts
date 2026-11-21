// Build plan Task 30: SIGTERM and SIGINT stop the server and the process
// exits within 30 s. These drive the handler with a stand-in for process and
// a fake clock; shutdown.test.ts sends a real SIGTERM to a real process.
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  installSignalHandlers,
  SHUTDOWN_DEADLINE_MS,
  type SignalTarget,
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

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("installSignalHandlers", () => {
  for (const signal of ["SIGTERM", "SIGINT"]) {
    test(`${signal} stops the server once and exits 0`, async () => {
      const { proc, exit } = fakeProcess();
      const stop = vi.fn(async () => {});
      installSignalHandlers(stop, proc, () => {});
      proc.emit(signal);
      await vi.advanceTimersByTimeAsync(0);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(0);
    });
  }

  test("a stop that fails exits 1", async () => {
    const { proc, exit } = fakeProcess();
    installSignalHandlers(
      async () => {
        throw new Error("boom");
      },
      proc,
      () => {},
    );
    proc.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("a stop that hangs exits 1 at 30 s, and not before", async () => {
    const { proc, exit } = fakeProcess();
    installSignalHandlers(
      () => new Promise(() => {}),
      proc,
      () => {},
    );
    proc.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(SHUTDOWN_DEADLINE_MS - 1);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(SHUTDOWN_DEADLINE_MS).toBe(30_000);
  });

  test("a second signal during the shutdown exits at once, and stop runs only once", async () => {
    const { proc, exit } = fakeProcess();
    const stop = vi.fn(() => new Promise<void>(() => {}));
    installSignalHandlers(stop, proc, () => {});
    proc.emit("SIGTERM");
    proc.emit("SIGINT");
    await vi.advanceTimersByTimeAsync(0);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
