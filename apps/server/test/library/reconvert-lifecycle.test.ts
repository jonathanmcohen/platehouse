// The description re-conversion's lifecycle (#357, issues #381 and #382),
// checked by a seeded simulation rather than case by case. Three review
// rounds each found one more way a stop, an outage or a lost job left the
// step unfinished or the process exiting 1. This drives the real code, the
// upgrade worker in startQueues, createDescriptionReconvert and
// storeTextReader, against fakes with the behaviour that matters:
//
// - a pg-boss whose jobs and schedules outlive a process, that retries a
//   failed job up to the retryLimit its send gives (the upgrade queue and
//   every send use retryLimit 0, so in practice it never retries; the fake
//   models a standard, non-collapsing queue, where the real upgrade queue
//   is stately and collapses a send while a job waits), fires its crons,
//   and stops gracefully as pg-boss 12 does: it waits 10 s for the job in
//   hand, and only then aborts the job's signal;
// - a database holding the models, the progress and the lock, that can go
//   down for any length of time and drops a dead process's lock;
// - an object store serving real .3mf bytes with a latency, where a file can
//   be damaged or missing and the store can refuse every request or hang
//   until its 60 s timeout, for any length of time.
//
// Each seed builds a library (edited, untouched, damaged and missing files,
// models with no file), then for three simulated hours stops and starts the
// server, crashes it, takes the store and the database down, loses queued
// jobs and edits descriptions by hand, all at random. Then everything is
// healthy for six hours with no restart. For every seed:
//   (a) every stop finishes within the 10 s shutdown limit, with no job cut off;
//   (b) no description is written twice or wrongly, and a description edited
//       by hand is never written over;
//   (c) the step finishes without a restart once things are healthy, every
//       model counted once with the outcome it should have, and the Activity
//       page lists it.
import { Readable } from "node:stream";
import type { PgBoss } from "pg-boss";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type QueueDeps, startQueues } from "../../src/jobs/queues.js";
import { descriptionSha256 } from "../../src/library/description-hash.js";
import {
  createDescriptionReconvert,
  type Outcome,
  RECONVERT_STEP,
  type ReconvertResult,
  type ReconvertStore,
  type SourceFile,
  type StoredDescription,
  storeTextReader,
} from "../../src/library/reconvert.js";
import { BlobNotFound, StoreUnavailable } from "../../src/storage/s3.js";
import { build3mf } from "../integration/support/ingest.js";

// ---- The library ----

const HTML =
  "<p><b>Note:</b>Use</p><boostme><boosttitle>Boost Me</boosttitle><boostcontent>Hi</boostcontent></boostme>";
const BY_RC = "**Note:**Use\n\nBoost MeHi";
const BY_010 = "Note:Use\n\nBoost MeHi";
const NOW = "Note:Use\n\nBoost Me\n\nHi";

type Kind =
  | "rc" // stored by rc.1 to rc.3, no record: converted again
  | "hashed" // recorded by ingest with converter 2: converted again
  | "second" // no record, its second .3mf is the source: converted again
  | "same" // already what the converter writes: marked, text unchanged
  | "edited" // recorded, then changed: left alone
  | "hand" // no record, not a conversion: left alone
  | "damaged" // its only .3mf is damaged: could not be read
  | "missing" // its only .3mf's object is gone: could not be read
  | "nofile"; // no .3mf at all: could not be read

const KINDS: readonly Kind[] = [
  "rc",
  "hashed",
  "second",
  "same",
  "edited",
  "hand",
  "damaged",
  "missing",
  "nofile",
];

const EXPECTED: Record<Kind, Outcome> = {
  rc: "changed",
  hashed: "changed",
  second: "changed",
  same: "unchanged",
  edited: "kept",
  hand: "kept",
  damaged: "unreadable",
  missing: "unreadable",
  nofile: "unreadable",
};

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Stored, not deflated: an inflate runs on libuv's thread pool in real time,
// which the fake clock cannot see, so on a slow machine a read would take
// more simulated time than on a fast one, and a stop could pass its 10 s in
// simulated time while the real inflate was still running. With no inflate
// every step is on the fake clock, and a seed runs the same on any machine.
const designer = { designer: "Synthetic Designer", title: "Synthetic Title" };
const GOOD = build3mf({
  plates: 1,
  stored: true,
  makerWorld: { ...designer, descriptionHtml: HTML },
});
const PLAIN = build3mf({
  plates: 1,
  stored: true,
  nonce: "plain",
  makerWorld: { ...designer, descriptionHtml: "<p>Plain</p>" },
});
const OTHER = build3mf({
  plates: 1,
  stored: true,
  nonce: "other",
  makerWorld: { ...designer, descriptionHtml: "<p>Another design</p>" },
});

/** The three ways a stored .3mf is damaged that review rounds found. */
function damaged(variant: number, next: () => number): Buffer {
  if (variant === 0) return GOOD.subarray(0, Math.floor(GOOD.length / 2)); // cut short
  if (variant === 1) {
    // Not a zip at all.
    return Buffer.from(Array.from({ length: 4096 }, () => Math.floor(next() * 256)));
  }
  // Its end record points the central directory past the end (round 1).
  const out = Buffer.from(GOOD);
  out.writeUInt32LE(out.length + 100, out.length - 22 + 16);
  return out;
}

interface ModelRow {
  description: string;
  sha256: string | null;
  converter: number | null;
  fileId: string | null;
}

interface Library {
  models: Map<string, ModelRow>;
  files: Map<string, SourceFile[]>;
  objects: Map<string, Buffer>;
  kinds: Map<string, Kind>;
}

const id = (prefix: string, n: number) =>
  `0190f5a8-${prefix}-7000-8000-${String(n).padStart(12, "0")}`;

function buildLibrary(next: () => number, size: number): Library {
  const lib: Library = {
    models: new Map(),
    files: new Map(),
    objects: new Map(),
    kinds: new Map(),
  };
  for (let n = 1; n <= size; n++) {
    const kind = KINDS[Math.floor(next() * KINDS.length)] as Kind;
    const modelId = id("0001", n);
    const file = (k: number, bytes: Buffer | null): SourceFile => {
      const fileId = id("0002", n * 10 + k);
      const key = `models/${modelId}/${fileId}`;
      if (bytes !== null) lib.objects.set(key, bytes);
      return { fileId, key, size: bytes?.length ?? GOOD.length };
    };
    let row: ModelRow = { description: BY_RC, sha256: null, converter: null, fileId: null };
    let files: SourceFile[] = [];
    if (kind === "rc" || kind === "hand" || kind === "hashed" || kind === "edited") {
      files = [file(1, GOOD)];
    }
    if (kind === "hashed" || kind === "edited") {
      row = {
        description: kind === "hashed" ? BY_010 : `${BY_010} and my own notes`,
        sha256: descriptionSha256(BY_010),
        converter: 2,
        fileId: (files[0] as SourceFile).fileId,
      };
    } else if (kind === "second") files = [file(1, OTHER), file(2, GOOD)];
    else if (kind === "same") {
      row = { ...row, description: "Plain" };
      files = [file(1, PLAIN)];
    } else if (kind === "hand") row = { ...row, description: "Written by hand" };
    else if (kind === "damaged") files = [file(1, damaged(Math.floor(next() * 3), next))];
    else if (kind === "missing") files = [file(1, null)];
    else if (kind === "nofile") files = [];
    lib.models.set(modelId, row);
    lib.files.set(modelId, files);
    lib.kinds.set(modelId, kind);
  }
  return lib;
}

// ---- The world: database, store, pg-boss, processes ----

class ProcessGone extends Error {}

interface Job {
  id: number;
  data: { task: string };
  retryLimit: number;
  retries: number;
}

interface Schedule {
  cron: string;
  data: { task: string };
  options: { retryLimit?: number } & Record<string, unknown>;
}

function cronDue(cron: string, minute: number): boolean {
  const [m, h] = cron.trim().split(/\s+/);
  const everyM = /^\*\/(\d+)$/.exec(m ?? "");
  const mm = minute % 60;
  const hh = Math.floor(minute / 60) % 24;
  const minuteOk = everyM ? mm % Number(everyM[1]) === 0 : m === "*" || Number(m) === mm;
  const hourOk = h === "*" || Number(h) === hh;
  return minuteOk && hourOk;
}

interface Violation {
  rule: "a" | "b" | "c";
  what: string;
}

class World {
  readonly lib: Library;
  readonly next: () => number;
  violations: Violation[] = [];
  // The database.
  dbDownUntil = 0;
  progress: (ReconvertResult & { after: string | null }) | null = null;
  steps = new Map<string, ReconvertResult & { finishedAt: number }>();
  lockOwner: number | null = null;
  writes = new Map<string, string[]>();
  counted = new Map<string, Outcome[]>();
  handEdited = new Map<string, string>();
  // The object store.
  storeDownUntil = 0;
  storeHangs = false;
  // pg-boss, as stored in the database.
  queue: Job[] = [];
  schedules = new Map<string, Schedule>();
  jobIds = 0;
  // Processes.
  epoch = 0;
  alive = new Set<number>();
  active: { epoch: number; job: Job; done: boolean; signal: AbortController } | null = null;
  stoppingEpoch: number | null = null;
  shutdowns = new Map<number, AbortController>();
  stops = 0;
  crashes = 0;
  outages = 0;
  /** Stops, crashes and outages that came while the step had not finished. */
  stressWhilePending = 0;

  constructor(seed: number, size: number) {
    this.next = rng(seed);
    this.lib = buildLibrary(this.next, size);
  }

  now(): number {
    return Date.now();
  }

  // -- the database, as one process sees it --
  private async db(epoch: number): Promise<void> {
    await Promise.resolve();
    if (!this.alive.has(epoch)) throw new ProcessGone("the process is gone");
    if (this.now() < this.dbDownUntil) throw new Error("connect ECONNREFUSED (database)");
  }

  private addCount(modelId: string, outcome: Outcome): void {
    const p = this.progress ?? {
      checked: 0,
      changed: 0,
      unchanged: 0,
      kept: 0,
      unreadable: 0,
      after: null,
    };
    p.checked += 1;
    p[outcome] += 1;
    p.after = modelId;
    this.progress = p;
    this.counted.set(modelId, [...(this.counted.get(modelId) ?? []), outcome]);
  }

  storeFor(epoch: number): ReconvertStore {
    const w = this;
    return {
      async stepFinished(name) {
        await w.db(epoch);
        return w.steps.has(name);
      },
      async exclusive(_name, fn) {
        await w.db(epoch);
        if (w.lockOwner !== null && w.alive.has(w.lockOwner)) return null;
        w.lockOwner = epoch;
        try {
          return await fn(new AbortController().signal);
        } finally {
          if (w.lockOwner === epoch) w.lockOwner = null;
        }
      },
      async resumeAfter() {
        await w.db(epoch);
        return w.progress?.after ?? null;
      },
      async count(_name, modelId, outcome) {
        await w.db(epoch);
        w.addCount(modelId, outcome);
      },
      async finishStep(name) {
        await w.db(epoch);
        const p = w.progress ?? {
          checked: 0,
          changed: 0,
          unchanged: 0,
          kept: 0,
          unreadable: 0,
          after: null,
        };
        const totals = {
          checked: p.checked,
          changed: p.changed,
          unchanged: p.unchanged,
          kept: p.kept,
          unreadable: p.unreadable,
        };
        if (!w.steps.has(name)) w.steps.set(name, { ...totals, finishedAt: w.now() });
        w.progress = null;
        return totals;
      },
      async candidates(after, limit) {
        await w.db(epoch);
        return [...w.lib.models.entries()]
          .filter(([, r]) => r.description !== "" && (r.converter ?? 0) < 3)
          .filter(([mid]) => after === null || mid > after)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .slice(0, limit)
          .map(
            ([modelId, r]): StoredDescription => ({
              modelId,
              description: r.description,
              sha256: r.sha256,
              converter: r.converter,
              fileId: r.fileId,
            }),
          );
      },
      async sourceFiles(modelId) {
        await w.db(epoch);
        return w.lib.files.get(modelId) ?? [];
      },
      async write(row, nextValue, count) {
        await w.db(epoch);
        const r = w.lib.models.get(row.modelId);
        if (r === undefined || r.description !== row.description || r.sha256 !== row.sha256) {
          return false;
        }
        r.description = nextValue.description;
        r.sha256 = descriptionSha256(nextValue.description);
        r.converter = 3;
        r.fileId = nextValue.fileId;
        w.writes.set(row.modelId, [...(w.writes.get(row.modelId) ?? []), nextValue.description]);
        w.addCount(row.modelId, count.outcome);
        return true;
      },
    };
  }

  // -- the object store, as one process sees it --
  blobStoreFor(epoch: number) {
    const w = this;
    return {
      getBlobRange(
        key: string,
        start: number,
        end: number,
        opts?: { signal?: AbortSignal },
      ): Promise<Readable> {
        return new Promise((resolve, reject) => {
          if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start < 0 ||
            end <= start
          ) {
            reject(new RangeError("getBlobRange: bad range"));
            return;
          }
          const signal = opts?.signal;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const onAbort = () => {
            clearTimeout(timer);
            const e = new Error("The operation was aborted");
            e.name = "AbortError";
            reject(e);
          };
          if (signal?.aborted) {
            onAbort();
            return;
          }
          signal?.addEventListener("abort", onAbort, { once: true });
          const settle = (fn: () => void) => {
            signal?.removeEventListener("abort", onAbort);
            if (!w.alive.has(epoch)) reject(new ProcessGone("the process is gone"));
            else fn();
          };
          if (w.now() < w.storeDownUntil) {
            // Refused at once, or no answer until the socket timeout.
            timer = setTimeout(
              () => settle(() => reject(new StoreUnavailable("GetObject", "ETIMEDOUT"))),
              w.storeHangs ? 60_000 : 50,
            );
            return;
          }
          timer = setTimeout(
            () =>
              settle(() => {
                const bytes = w.lib.objects.get(key);
                if (bytes === undefined) reject(new BlobNotFound("GetObject"));
                else resolve(Readable.from([bytes.subarray(start, Math.min(end, bytes.length))]));
              }),
            1000 + Math.floor(w.next() * 4000),
          );
        });
      },
    };
  }

  // -- pg-boss, as one process sees it --
  bossFor(epoch: number): { boss: PgBoss; handler: () => ((jobs: unknown[]) => unknown) | null } {
    let handler: ((jobs: unknown[]) => unknown) | null = null;
    const boss = {
      createQueue: async () => {},
      updateQueue: async () => {},
      schedule: async (
        name: string,
        cron: string,
        data: { task: string },
        options: Schedule["options"],
      ) => {
        if (!this.alive.has(epoch)) throw new ProcessGone("the process is gone");
        this.schedules.set(`${name}/${String(options?.key ?? data.task)}`, {
          cron,
          data,
          options: options ?? {},
        });
      },
      unschedule: async (name: string, key: string) => {
        if (!this.alive.has(epoch)) throw new ProcessGone("the process is gone");
        this.schedules.delete(`${name}/${key}`);
      },
      send: async (_n: string, data: { task: string }, options?: { retryLimit?: number }) => {
        await Promise.resolve();
        if (!this.alive.has(epoch)) throw new ProcessGone("the process is gone");
        if (this.now() < this.dbDownUntil) throw new Error("connect ECONNREFUSED (pg-boss)");
        this.jobIds += 1;
        this.queue.push({
          id: this.jobIds,
          data,
          retryLimit: options?.retryLimit ?? 2,
          retries: 0,
        });
        return String(this.jobIds);
      },
      work: async (name: string, _opts: unknown, h: (jobs: unknown[]) => unknown) => {
        if (name === "upgrade") handler = h;
        return name;
      },
      getSchedules: async () => [],
    };
    return { boss: boss as unknown as PgBoss, handler: () => handler };
  }

  /** pg-boss's worker: hands the next job to the live process, one at a time. */
  pump(epoch: number, handler: ((jobs: unknown[]) => unknown) | null): void {
    if (handler === null || this.active !== null || this.stoppingEpoch === epoch) return;
    if (!this.alive.has(epoch) || this.now() < this.dbDownUntil) return;
    const job = this.queue.shift();
    if (job === undefined) return;
    const signal = new AbortController();
    const active = { epoch, job, done: false, signal };
    this.active = active;
    const finish = (failed: boolean) => {
      active.done = true;
      if (this.active === active) this.active = null;
      if (failed && job.retries < job.retryLimit)
        this.queue.push({ ...job, retries: job.retries + 1 });
    };
    Promise.resolve()
      .then(() =>
        handler([
          { id: String(job.id), data: job.data, signal: signal.signal, expireInSeconds: 900 },
        ]),
      )
      .then(
        () => finish(false),
        () => finish(true),
      );
  }
}

// ---- One process ----

interface Proc {
  epoch: number;
  handler: () => ((jobs: unknown[]) => unknown) | null;
}

async function startProcess(w: World): Promise<Proc> {
  w.epoch += 1;
  const epoch = w.epoch;
  w.alive.add(epoch);
  const shutdown = new AbortController();
  w.shutdowns.set(epoch, shutdown);
  const { boss, handler } = w.bossFor(epoch);
  const reconvert = createDescriptionReconvert({
    store: w.storeFor(epoch),
    readText: storeTextReader(w.blobStoreFor(epoch)),
    log: () => {},
  });
  const noop = async () => undefined;
  const deps = {
    ingestFile: async () => {
      throw new Error("not in this simulation");
    },
    purgeExpired: noop,
    sweepOrphans: noop,
    sweepUploads: noop,
    reconvertDescriptions: (stop: () => boolean, signal?: AbortSignal) =>
      (reconvert.run as (s: () => boolean, g?: AbortSignal) => Promise<unknown>)(stop, signal),
    reconvertPending: () => reconvert.pending(),
    shutdown: shutdown.signal,
    timeZone: "UTC",
  } as QueueDeps;
  await startQueues(boss, deps).catch(() => undefined);
  return { epoch, handler };
}

/** Advances the clock in steps, running pg-boss's worker and crons as it goes. */
async function advance(w: World, procs: () => Proc | null, ms: number, step = 1000): Promise<void> {
  for (let t = 0; t < ms; t += step) {
    const before = Math.floor(w.now() / 60_000);
    await vi.advanceTimersByTimeAsync(step);
    const after = Math.floor(w.now() / 60_000);
    const p = procs();
    if (p !== null && after !== before && w.now() >= w.dbDownUntil && w.alive.has(p.epoch)) {
      for (const s of w.schedules.values()) {
        if (cronDue(s.cron, after)) {
          w.jobIds += 1;
          w.queue.push({
            id: w.jobIds,
            data: s.data,
            retryLimit: s.options.retryLimit ?? 2,
            retries: 0,
          });
        }
      }
    }
    if (p !== null) w.pump(p.epoch, p.handler());
  }
}

/** A graceful stop: the server's stop() flag, then pg-boss's 10 s wait, then exit. */
async function stopProcess(w: World, p: Proc): Promise<void> {
  w.stops += 1;
  w.shutdowns.get(p.epoch)?.abort();
  w.stoppingEpoch = p.epoch;
  const started = w.now();
  const inHand = w.active !== null && w.active.epoch === p.epoch ? w.active : null;
  while (inHand !== null && !inHand.done && w.now() - started < 10_000) {
    await vi.advanceTimersByTimeAsync(100);
  }
  if (inHand !== null && !inHand.done) {
    w.violations.push({
      rule: "a",
      what: `stop at ${new Date(started).toISOString()}: job ${inHand.job.id} still running at the 10 s limit`,
    });
    // pg-boss fails the job (it may be retried) and only now aborts its signal.
    inHand.signal.abort();
    if (w.active === inHand) w.active = null;
    if (inHand.job.retries < inHand.job.retryLimit) {
      w.queue.push({ ...inHand.job, retries: inHand.job.retries + 1 });
    }
  }
  w.stoppingEpoch = null;
  w.alive.delete(p.epoch);
  if (w.lockOwner === p.epoch) w.lockOwner = null;
}

/** A crash: the process is gone at once; its job is retried as pg-boss expires it. */
function crashProcess(w: World, p: Proc): void {
  w.crashes += 1;
  w.alive.delete(p.epoch);
  if (w.lockOwner === p.epoch) w.lockOwner = null;
  if (w.active !== null && w.active.epoch === p.epoch) {
    const { job } = w.active;
    w.active = null;
    if (job.retries < job.retryLimit) w.queue.push({ ...job, retries: job.retries + 1 });
  }
}

// ---- One seed ----

interface SeedReport {
  violations: Violation[];
  stops: number;
  crashes: number;
  outages: number;
  stressWhilePending: number;
}

async function simulate(seed: number): Promise<SeedReport> {
  const w = new World(seed, 80);
  const initial = new Map([...w.lib.models.entries()].map(([k, v]) => [k, { ...v }]));
  let proc: Proc | null = await startProcess(w);
  const current = () => proc;

  // Chaos: three hours of stops, crashes, outages, lost jobs and hand edits.
  const CHAOS_MS = 3 * 60 * 60_000;
  const chaosEnd = w.now() + CHAOS_MS;
  // Besides the random events, every seed gets a store outage early on, and a
  // stop while a re-conversion job is in hand, so none finishes unstressed.
  const forcedOutageAt = w.now() + 30_000 + Math.floor(w.next() * 150_000);
  let forcedOutage = false;
  let forcedStop = false;
  while (w.now() < chaosEnd) {
    await advance(w, current, 5_000);
    if (!forcedOutage && w.now() >= forcedOutageAt) {
      forcedOutage = true;
      w.outages += 1;
      if (!w.steps.has(RECONVERT_STEP)) w.stressWhilePending += 1;
      w.storeHangs = w.next() < 0.5;
      w.storeDownUntil = Math.max(
        w.storeDownUntil,
        w.now() + 10_000 + Math.floor(w.next() * 600_000),
      );
    }
    if (
      !forcedStop &&
      proc !== null &&
      w.active?.epoch === proc.epoch &&
      w.active.job.data.task === "reconvert-descriptions" &&
      w.next() < 0.3
    ) {
      forcedStop = true;
      w.stressWhilePending += 1;
      await stopProcess(w, proc);
      proc = await startProcess(w);
      continue;
    }
    const r = w.next();
    if (r < 0.016 && !w.steps.has(RECONVERT_STEP)) w.stressWhilePending += 1;
    if (r < 0.002 && proc !== null) {
      await stopProcess(w, proc);
      proc = await startProcess(w);
    } else if (r < 0.003 && proc !== null) {
      crashProcess(w, proc);
      proc = await startProcess(w);
    } else if (r < 0.01) {
      w.outages += 1;
      w.storeHangs = w.next() < 0.5;
      // From a few seconds to an hour.
      w.storeDownUntil = Math.max(
        w.storeDownUntil,
        w.now() + Math.floor(w.next() ** 3 * 3_600_000),
      );
    } else if (r < 0.014) {
      w.outages += 1;
      w.dbDownUntil = Math.max(w.dbDownUntil, w.now() + Math.floor(w.next() ** 3 * 1_800_000));
    } else if (r < 0.016 && w.queue.length > 0) {
      w.queue.splice(Math.floor(w.next() * w.queue.length), 1); // a lost job
    } else if (r < 0.019) {
      const ids = [...w.lib.models.keys()];
      const mid = ids[Math.floor(w.next() * ids.length)] as string;
      const row = w.lib.models.get(mid) as ModelRow;
      const text = `Edited by hand at ${w.now()}`;
      row.description = text; // the hash is left as it was, as a direct edit leaves it
      w.handEdited.set(mid, text);
    }
  }

  // Healthy: every outage over, no restart, six hours.
  w.storeDownUntil = 0;
  w.dbDownUntil = 0;
  const healthyEnd = w.now() + 6 * 60 * 60_000;
  while (w.now() < healthyEnd && !w.steps.has(RECONVERT_STEP)) {
    await advance(w, current, 60_000, 5_000);
  }
  // Let a run in hand finish so a stop can be checked after it too.
  if (proc !== null) await stopProcess(w, proc);

  // (b) no description written twice or wrongly; a hand edit never written over.
  for (const [mid, writes] of w.writes) {
    if (writes.length > 1)
      w.violations.push({ rule: "b", what: `${mid} written ${writes.length} times` });
    const kind = w.lib.kinds.get(mid) as Kind;
    const right = kind === "same" ? "Plain" : NOW;
    for (const value of writes) {
      if (value !== right)
        w.violations.push({
          rule: "b",
          what: `${mid} (${kind}) written as ${JSON.stringify(value)}`,
        });
    }
  }
  for (const [mid, row] of w.lib.models) {
    const kind = w.lib.kinds.get(mid) as Kind;
    const edit = w.handEdited.get(mid);
    const start = initial.get(mid) as ModelRow;
    let right: string;
    if (edit !== undefined) right = edit;
    else if (EXPECTED[kind] === "changed") right = NOW;
    else right = start.description;
    if (row.description !== right) {
      w.violations.push({
        rule: "b",
        what: `${mid} (${kind}) ends as ${JSON.stringify(row.description)}, not ${JSON.stringify(right)}`,
      });
    }
  }

  // (c) finished without a restart, every model counted once as it should be.
  const step = w.steps.get(RECONVERT_STEP);
  if (step === undefined) {
    w.violations.push({ rule: "c", what: "the step did not finish in six healthy hours" });
  } else {
    if (step.checked !== w.lib.models.size) {
      w.violations.push({ rule: "c", what: `${step.checked} checked of ${w.lib.models.size}` });
    }
    const sum = step.changed + step.unchanged + step.kept + step.unreadable;
    if (sum !== step.checked)
      w.violations.push({ rule: "c", what: `outcomes add to ${sum}, not ${step.checked}` });
    for (const mid of w.lib.models.keys()) {
      const outcomes = w.counted.get(mid) ?? [];
      const kind = w.lib.kinds.get(mid) as Kind;
      if (outcomes.length !== 1) {
        w.violations.push({ rule: "c", what: `${mid} (${kind}) counted ${outcomes.length} times` });
        continue;
      }
      // A hand edit can make any model "kept"; otherwise the outcome is the kind's.
      const ok = w.handEdited.has(mid)
        ? [EXPECTED[kind], "kept"].includes(outcomes[0] as Outcome)
        : outcomes[0] === EXPECTED[kind];
      if (!ok) {
        w.violations.push({
          rule: "c",
          what: `${mid} (${kind}) counted ${outcomes[0]}, not ${EXPECTED[kind]}`,
        });
      }
    }
  }
  return {
    violations: w.violations,
    stops: w.stops,
    crashes: w.crashes,
    outages: w.outages,
    stressWhilePending: w.stressWhilePending,
  };
}

// ---- The seeds ----

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-11-21T00:00:00Z") });
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const SEEDS = Array.from({ length: 32 }, (_, i) => 1001 + i);

describe("the re-conversion holds its invariant under random stops, crashes, outages and lost jobs", () => {
  test.each(SEEDS)(
    "seed %i",
    async (seed) => {
      const report = await simulate(seed);
      // Every seed must have been stressed while the step was still going, or it proves nothing.
      expect(report.stressWhilePending).toBeGreaterThan(0);
      expect(report.violations).toEqual([]);
    },
    120_000,
  );
});
