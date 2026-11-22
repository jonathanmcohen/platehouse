// The slicer's measured rate against simulated workloads (issue #375).
//
// The rule the rate must keep: it is the slicer's throughput while it was
// busy. Idle time between jobs never counts, however short or long, and a
// slow slice always counts, however slow.
//
// Each seed builds one workload for a single slicer that does one job at a
// time, as the app's slicer queue does (a singleton queue worked one job at a
// time, jobs/queues.ts): plates arrive in random bursts of hundreds (a printer
// added, a big upload) or one now and then, from seconds to hours apart; each
// slice takes from 2 seconds to 20 minutes; some fail, and some fail in a way
// that is retried later, going back to waiting while keeping the time they
// were first queued. The rows are recorded the way the app writes estimates:
// created_at when first queued, started_at when the attempt that finished
// began work, finished_at when it ended, and the status. The oldest rows of
// some workloads were written before started_at existed and have none.
//
// For every workload, whenever the rate is a number it is within 10% of the
// true busy throughput of the slices it is measured from (the newest
// RATE_SAMPLE successful slices that have a start time: how many there are
// over the time the slicer spent on them). With MIN_FINISHES_FOR_RATE or more
// of those it must give a number, and with fewer it must give null.
import { describe, expect, test } from "vitest";
import { MIN_FINISHES_FOR_RATE, RATE_SAMPLE, sliceRate } from "../../src/estimates/rate.js";

/** One estimate row as the app stores it, with the simulation's true slice time. */
interface SimRow {
  status: "pending" | "running" | "ok" | "failed";
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** The working time of the attempt that finished, in ms; what the slicer really spent. */
  trueMs: number;
}

/** A small seeded random source (mulberry32), so every run sees the same workloads. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A value spread evenly on a log scale between lo and hi. */
function logUniform(r: () => number, lo: number, hi: number): number {
  return Math.exp(Math.log(lo) + r() * (Math.log(hi) - Math.log(lo)));
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const MIN_SLICE = 2 * SECOND;
const MAX_SLICE = 20 * MINUTE;

/** One simulated workload: the rows the app would hold when the page asks. */
function workload(seed: number): SimRow[] {
  const r = random(seed);
  const start = Date.parse("2026-11-01T00:00:00Z");
  // How this host slices: one speed for most plates, with each plate varying
  // around it, or every plate anywhere from 2 seconds to 20 minutes.
  const base = logUniform(r, MIN_SLICE, 10 * MINUTE);
  const mixed = r() < 0.3;
  const sliceMs = () => {
    const ms = mixed ? logUniform(r, MIN_SLICE, MAX_SLICE) : base * logUniform(r, 0.5, 2);
    return Math.min(Math.max(ms, MIN_SLICE), MAX_SLICE);
  };
  // Arrivals: bursts of hundreds, a few plates, or one, from a second to six hours apart.
  const queued: number[] = [];
  let at = start;
  const events = 3 + Math.floor(r() * 40);
  for (let e = 0; e < events; e += 1) {
    at += logUniform(r, SECOND, 6 * HOUR);
    const kind = r();
    const n = kind < 0.15 ? 100 + Math.floor(r() * 400) : kind < 0.5 ? 1 + Math.floor(r() * 5) : 1;
    for (let i = 0; i < n; i += 1) queued.push(at);
  }
  const rows: SimRow[] = queued.map((t) => ({
    status: "pending",
    createdAt: new Date(t),
    startedAt: null,
    finishedAt: null,
    trueMs: 0,
  }));
  // One slicer, one job at a time, first queued first. A retried attempt
  // waits 10 seconds to 2 minutes and goes back in line by when it is ready.
  const ready = rows.map((row, i) => ({ i, at: row.createdAt.getTime(), attempts: 0 }));
  let free = start;
  // The page asks at some point: work not finished by then is still waiting or running.
  const asked = start + (at - start) * (0.5 + r() * 0.8) + logUniform(r, SECOND, 2 * HOUR);
  while (ready.length > 0) {
    ready.sort((a, b) => a.at - b.at || a.i - b.i);
    const job = ready.shift();
    if (job === undefined) break;
    const row = rows[job.i] as SimRow;
    // A little idle time between jobs: the queue's pickup.
    const begin = Math.max(job.at, free) + r() * 2 * SECOND;
    if (begin > asked) break;
    const ms = sliceMs();
    const end = begin + ms;
    job.attempts += 1;
    row.status = "running";
    row.startedAt = new Date(begin);
    if (end > asked) break;
    free = end;
    const outcome = r();
    if (outcome < 0.05 && job.attempts < 3) {
      // Retried: back to waiting, keeping created_at; finished_at stays empty.
      row.status = "pending";
      ready.push({
        i: job.i,
        at: end + logUniform(r, 10 * SECOND, 2 * MINUTE),
        attempts: job.attempts,
      });
      continue;
    }
    row.status = outcome < 0.1 ? "failed" : "ok";
    row.finishedAt = new Date(end);
    row.trueMs = ms;
  }
  // Rows written before started_at existed: the oldest finished ones, in some workloads.
  if (r() < 0.3) {
    const before = start + (at - start) * r();
    for (const row of rows) {
      if (row.finishedAt !== null && row.finishedAt.getTime() < before) row.startedAt = null;
    }
  }
  return rows;
}

/** The slices the rate is measured from: the newest RATE_SAMPLE successful ones with a start time. */
function measuredSlices(rows: readonly SimRow[]): SimRow[] {
  return rows
    .filter((row) => row.status === "ok" && row.startedAt !== null && row.finishedAt !== null)
    .sort((a, b) => (b.finishedAt?.getTime() ?? 0) - (a.finishedAt?.getTime() ?? 0))
    .slice(0, RATE_SAMPLE);
}

/** Plates a minute while busy, for those slices: how many over the time spent on them. */
function trueRate(slices: readonly SimRow[]): number {
  const busy = slices.reduce((sum, row) => sum + row.trueMs, 0);
  return (slices.length / busy) * MINUTE;
}

/**
 * The app's measured rate for these rows, from what the database holds: the
 * rows recentSliceRate (estimates/service.ts) selects, successful ones with a
 * start and a finish time, handed to sliceRate.
 */
function measure(rows: readonly SimRow[]): number | null {
  return sliceRate(
    rows.flatMap((row) =>
      row.status === "ok" && row.startedAt !== null && row.finishedAt !== null
        ? [{ startedAt: row.startedAt, finishedAt: row.finishedAt }]
        : [],
    ),
  );
}

const SEEDS = Array.from({ length: 400 }, (_, i) => i + 1);

describe("the measured slice rate on simulated workloads", () => {
  test("is within 10% of the slicer's busy throughput whenever there is enough data, and null otherwise", () => {
    const wrong: string[] = [];
    let measured = 0;
    let tooLittle = 0;
    for (const seed of SEEDS) {
      const rows = workload(seed);
      const slices = measuredSlices(rows);
      const got = measure(rows);
      if (slices.length < MIN_FINISHES_FOR_RATE) {
        tooLittle += 1;
        if (got !== null)
          wrong.push(`seed ${seed}: ${slices.length} slices, gave ${got}, not null`);
        continue;
      }
      const want = trueRate(slices);
      if (got === null) {
        wrong.push(`seed ${seed}: ${slices.length} slices at ${want.toFixed(3)}/min, gave null`);
        continue;
      }
      measured += 1;
      if (Math.abs(got - want) / want > 0.1) {
        wrong.push(`seed ${seed}: gave ${got}, true ${want.toFixed(3)}/min`);
      }
    }
    // The workloads reach both sides of the rule, so neither half passes empty.
    expect(measured).toBeGreaterThan(SEEDS.length / 2);
    expect(tooLittle).toBeGreaterThan(0);
    expect(
      wrong,
      `${wrong.length} of ${SEEDS.length} workloads wrong:\n${wrong.slice(0, 20).join("\n")}`,
    ).toEqual([]);
  });
});
