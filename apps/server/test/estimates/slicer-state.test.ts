// The app follows the slicer's own time limits, read from its health answer
// and kept for a minute. When health has not answered, or answers in a
// contract the app does not read, the defaults stand in and the sandbox is
// unknown.
import type { Health } from "@platehouse/slicer-contract";
import { describe, expect, test, vi } from "vitest";
import { SlicerRefused, SlicerUnreachable } from "../../src/estimates/client.js";
import {
  convertExpireSeconds,
  createSlicerState,
  defaultTimeouts,
  estimateExpireSeconds,
  SLICER_MARGIN_SECONDS,
} from "../../src/estimates/slicer-state.js";

function health(over: Partial<Health["timeouts"]> = {}): Health {
  return {
    contract: 2,
    orca: "2.5.0",
    openscad: "2026.11-RC0",
    busy: false,
    sandbox: { state: "on", reason: null, detail: null, allowUnsandboxed: false },
    timeouts: {
      sliceSeconds: 400,
      scadSeconds: 600,
      stepSeconds: 300,
      uploadSeconds: 900,
      ...over,
    },
  };
}

const DEFAULTS = { sliceSeconds: 180, scadSeconds: 120, stepSeconds: 120, uploadSeconds: 600 };

describe("defaults", () => {
  test("the slice limit is the plate time plus 60 s", () => {
    expect(defaultTimeouts(120)).toEqual(DEFAULTS);
    expect(defaultTimeouts(300).sliceSeconds).toBe(360);
  });

  test("the margin over a slicer cap is 30 s", () => {
    expect(SLICER_MARGIN_SECONDS).toBe(30);
  });

  test("a conversion expires at upload + step + 30 + 300 s", () => {
    expect(convertExpireSeconds(defaultTimeouts(120))).toBe(1050);
    expect(convertExpireSeconds(health().timeouts)).toBe(900 + 300 + 30 + 300);
  });

  test("an estimate expires at upload + slice + 30 + 60 s", () => {
    expect(estimateExpireSeconds(defaultTimeouts(120))).toBe(870);
    expect(estimateExpireSeconds(health().timeouts)).toBe(900 + 400 + 30 + 60);
  });
});

describe("createSlicerState", () => {
  test("a contract 2 health gives its timeouts and sandbox", async () => {
    const state = createSlicerState({ health: async () => health(), plateSeconds: 120 });
    const snapshot = await state.current();
    expect(snapshot.timeouts).toEqual({
      sliceSeconds: 400,
      scadSeconds: 600,
      stepSeconds: 300,
      uploadSeconds: 900,
    });
    expect(snapshot.sandbox).toMatchObject({ state: "on" });
  });

  test("a second call within 60 s does not ask health again", async () => {
    let now = 1_000;
    const ask = vi.fn(async () => health());
    const state = createSlicerState({ health: ask, plateSeconds: 120, now: () => now });
    await state.current();
    now += 59_000;
    await state.current();
    expect(ask).toHaveBeenCalledTimes(1);
    now += 2_000;
    await state.current();
    expect(ask).toHaveBeenCalledTimes(2);
  });

  test("calls made together share one health request", async () => {
    const ask = vi.fn(async () => health());
    const state = createSlicerState({ health: ask, plateSeconds: 120 });
    await Promise.all([state.current(), state.current(), state.current()]);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  test("a rejecting health gives the defaults and no sandbox state", async () => {
    const state = createSlicerState({
      health: async () => {
        throw new SlicerUnreachable("ECONNREFUSED");
      },
      plateSeconds: 120,
    });
    expect(await state.current()).toEqual({ timeouts: DEFAULTS, sandbox: null });
  });

  test("a contract 1 health body, which the client refuses, gives the defaults and no sandbox state", async () => {
    const state = createSlicerState({
      health: async () => {
        throw new SlicerRefused(200, "The slicer's answer is not one slicer contract v2 allows");
      },
      plateSeconds: 120,
    });
    expect(await state.current()).toEqual({ timeouts: DEFAULTS, sandbox: null });
  });

  test("the defaults follow the plate time", async () => {
    const state = createSlicerState({
      health: async () => {
        throw new Error("down");
      },
      plateSeconds: 300,
    });
    expect((await state.current()).timeouts.sliceSeconds).toBe(360);
  });

  test("a failed health after a good one gives the last good snapshot", async () => {
    let now = 0;
    let fail = false;
    const state = createSlicerState({
      health: async () => {
        if (fail) throw new SlicerUnreachable("ECONNREFUSED");
        return health();
      },
      plateSeconds: 120,
      now: () => now,
    });
    const good = await state.current();
    fail = true;
    now += 120_000;
    expect(await state.current()).toEqual(good);
  });
});
