// What the app knows of the slicer's own limits and sandbox: read from its
// health answer, kept for a minute. The app's timers and job expiries follow
// the slicer's limits, so only the slicer needs the time settings. Until
// health has answered, or when it answers in a contract this app does not
// read, the defaults of an unconfigured slicer stand in and the sandbox is
// unknown (null): a slicer that cannot be read is never recorded as
// sandboxed-off.
import type { Health, SandboxState, SlicerTimeouts } from "@platehouse/slicer-contract";

/** The app's margin over a slicer cap, in seconds. */
export const SLICER_MARGIN_SECONDS = 30;

/** How long a health answer is reused, in milliseconds. */
const MAX_AGE_MS = 60_000;

/** How long a failed ask is remembered, in milliseconds. */
const FAILURE_MEMORY_MS = 10_000;

/** Seconds a conversion's mesh may take to be stored after the slicer's answer. */
const STORE_SECONDS = 300;

/** Seconds an estimate job may take to store its result after the slicer's answer. */
const ESTIMATE_STORE_SECONDS = 60;

/** The limits of a slicer left at its defaults, for SLICE_PLATE_SECONDS plates. */
export function defaultTimeouts(plateSeconds: number): SlicerTimeouts {
  return {
    sliceSeconds: plateSeconds + 60,
    scadSeconds: 120,
    stepSeconds: 120,
    uploadSeconds: 600,
  };
}

export interface SlicerSnapshot {
  timeouts: SlicerTimeouts;
  /** The slicer's sandbox state, or null when health has never answered in contract 2. */
  sandbox: SandboxState | null;
}

export interface SlicerState {
  current(): Promise<SlicerSnapshot>;
}

export interface SlicerStateOptions {
  health: () => Promise<Health>;
  /** SLICE_PLATE_SECONDS, for the defaults. */
  plateSeconds: number;
  /** How long an answer is reused; 60 000 when left out. */
  maxAgeMs?: number;
  /** The clock, in milliseconds; Date.now when left out. */
  now?: () => number;
}

export function createSlicerState(opts: SlicerStateOptions): SlicerState {
  const maxAgeMs = opts.maxAgeMs ?? MAX_AGE_MS;
  const now = opts.now ?? Date.now;
  let good: { at: number; snapshot: SlicerSnapshot } | null = null;
  let failedAt: number | null = null;
  let asking: Promise<SlicerSnapshot> | null = null;

  /**
   * When the latest ask failed: the last good limits, or the defaults, and
   * never a sandbox state, so an unreadable slicer is unknown, not stale.
   */
  const unknown = (): SlicerSnapshot => ({
    timeouts: good?.snapshot.timeouts ?? defaultTimeouts(opts.plateSeconds),
    sandbox: null,
  });

  async function ask(): Promise<SlicerSnapshot> {
    try {
      const health = await opts.health();
      const snapshot: SlicerSnapshot = { timeouts: health.timeouts, sandbox: health.sandbox };
      good = { at: now(), snapshot };
      failedAt = null;
      return snapshot;
    } catch {
      // Unreachable, or an answer outside contract 2. Remembered briefly, so
      // callers do not each wait on a slicer that is down.
      failedAt = now();
      return unknown();
    }
  }

  return {
    async current() {
      if (good && failedAt === null && now() - good.at < maxAgeMs) return good.snapshot;
      if (failedAt !== null && now() - failedAt < FAILURE_MEMORY_MS) return unknown();
      asking ??= ask().finally(() => {
        asking = null;
      });
      return asking;
    },
  };
}

/** How long a STEP conversion job may run before pg-boss expires it, in seconds. */
export function convertExpireSeconds(t: SlicerTimeouts): number {
  return t.uploadSeconds + t.stepSeconds + SLICER_MARGIN_SECONDS + STORE_SECONDS;
}

/** How long an estimate job may run before pg-boss expires it, in seconds. */
export function estimateExpireSeconds(t: SlicerTimeouts): number {
  return t.uploadSeconds + t.sliceSeconds + SLICER_MARGIN_SECONDS + ESTIMATE_STORE_SECONDS;
}
