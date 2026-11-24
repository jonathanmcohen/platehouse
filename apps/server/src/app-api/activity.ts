// The Activity page's app API (the maintainer, 2026-11-19: one page that shows what
// Platehouse is doing and holds, so the user never has to read container logs).
//
//   GET /app/api/activity   ActivityView: the library's numbers, estimate
//                           progress for the selected printer, the pg-boss
//                           queues and scheduled jobs, the slicer's health,
//                           and the newest events (a description
//                           re-conversion on upgrade among them, #357)
//
// - Session-class like every /app/api route (the route classes table in
//   auth/gate.ts: /app/api is unlisted), so the gate refuses a request without a live
//   session before this handler runs. It changes nothing. Nothing is added
//   under /api/v1.
// - Built only from what the database, pg-boss and the inbox's failed/
//   folder already record (repos/activity.ts); no log line is read or
//   shown. Error text the app stored (Orca's detail, OpenSCAD's message, an
//   inbox reason) goes through scrubText (src/scrub.ts, shared with the
//   model page and the Public API v1) first, so no file system path,
//   address, host name, signed URL or token reaches the page. A failed
//   render's or conversion's message goes through scrubDerivedMessage, as
//   on the model page, so a long one keeps its end, where OpenSCAD's ERROR
//   line is (issue #273).
// - The database is read in one read-only REPEATABLE READ transaction, one
//   query after another on its one connection, so the numbers come from one
//   snapshot and a poll never holds more than one pooled connection. The
//   slicer's /v1/health is asked beside it, with SLICER_HEALTH_TIMEOUT_MS,
//   so a slicer that is down makes the page say so rather than hang. The
//   inbox's failed/ folder is read at most once every INBOX_CACHE_MS.
// - Events are capped at EVENT_LIMIT, newest first, across every kind.
import type { BigIntStats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Health } from "@platehouse/slicer-contract";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import type { PgBoss } from "pg-boss";
import type { DB, FileKind } from "../db/types.js";
import { derivedParts } from "../derived/client.js";
import { printerName } from "../estimates/display.js";
import { isReason, reasonWords } from "../estimates/reasons.js";
import { nothingToShow, stripFormatChars } from "../format-chars.js";
import {
  FAILED_DIR,
  INBOX_PASS_LIMIT,
  OPEN_SETTLED,
  parseReasonFile,
  REASON_SUFFIX,
} from "../inbox/watch.js";
import { parseDuplicateMessage } from "../ingest/duplicates.js";
import { MAINTENANCE_TASKS, QUEUE, UPGRADE_TASKS } from "../jobs/queues.js";
import { activityRepo, type FailedDerived, type QueueCount } from "../repos/activity.js";
import { descriptionsRepo } from "../repos/descriptions.js";
import { settingsRepo } from "../repos/settings.js";
import { scrubDerivedMessage, scrubDetail, scrubText } from "../scrub.js";
import { appApiScope, need } from "./settings.js";

/** A render event's message split into codes and detail (derived/client.ts). */
function renderParts(message: string | null): {
  messageCodes: string[];
  messageDetail: string | null;
} {
  const { derivedCodes, derivedDetail } = derivedParts(message);
  return { messageCodes: derivedCodes, messageDetail: derivedDetail };
}

/** The Activity page's route, session-class (the route classes table in auth/gate.ts). */
export const ACTIVITY_API_PATHS: readonly string[] = Object.freeze(["/app/api/activity"]);

/** Most events the page is sent, across every kind. */
export const EVENT_LIMIT = 50;

/** How far back the estimate rate looks. */
export const RATE_WINDOW_MS = 30 * 60_000;

/** Fewer recent finishes than this give no rate: too few to tell. */
export const MIN_RECENT_FOR_RATE = 3;

/** How long the page waits for the slicer's /v1/health before calling it unreachable. */
export const SLICER_HEALTH_TIMEOUT_MS = 3_000;

/** How long one read of the inbox's failed/ folder is reused. */
export const INBOX_CACHE_MS = 15_000;

/** How much of a reason file is read: only this many bytes are ever read from it. */
export const REASON_BYTES = 4_096;

// ---- What the page is sent ----

export type QueueRowId = "ingest" | "estimates" | "renders" | "step" | "scheduled" | "other";

export interface QueueRow {
  id: QueueRowId;
  label: string;
  /** Queued, or waiting to retry. */
  waiting: number;
  active: number;
  /** Failed jobs pg-boss still keeps (it deletes them 7 days after they end). */
  failed: number;
}

export interface ScheduleRow {
  key: string;
  label: string;
  /** The schedule in plain words, with its time zone. */
  schedule: string;
  /** When the newest run pg-boss still keeps finished; null when it keeps none. */
  lastRunAt: string | null;
  lastState: "completed" | "failed" | null;
}

export interface EstimateProgress {
  done: number;
  pending: number;
  running: number;
  failed: number;
  total: number;
  /** Plates finished a minute, over the last RATE_WINDOW_MS; null with too few to tell. */
  perMinute: number | null;
  /** A rough time left at that rate; null when nothing waits or there is no rate. */
  secondsLeft: number | null;
}

export type ModelSource = "api" | "upload" | "unknown";

export type ActivityEvent =
  | {
      type: "model_imported";
      at: string;
      model: { id: string; name: string; trashed: boolean };
      /**
       * api: made through the public API with an external reference (the
       * Manyfold import); upload: a web or API upload pg-boss still has a
       * record of; unknown: neither is recorded (an inbox import, or an
       * upload more than 7 days ago).
       */
      source: ModelSource;
    }
  | {
      type: "inbox_failed";
      at: string;
      name: string;
      /** The reason in plain words, without the code the reason file starts with. */
      reason: string;
      /** That code (changed, too_large, ...; inbox/watch.ts reasonCode), or null for a file with none. */
      reasonCode: string | null;
      /**
       * For a duplicate, the model the reason names and how many others
       * hold the file, read back from the sentence (ingest/duplicates.ts
       * parseDuplicateMessage) for the page to say it in its language; absent
       * for any other reason, or a sentence that cannot be read back.
       */
      duplicate?: { name: string; id: string; others: number };
    }
  | {
      type: "estimate_failed";
      at: string;
      estimateId: string;
      model: { id: string; name: string };
      plate: { index: number; name: string | null };
      /** Orca's return code, when the slicer reported one. */
      code: number | null;
      /** The reason in plain words (estimates/reasons.ts). */
      reason: string;
      /** The contract's reason it stands for, for the page to say in its language. */
      reasonCode: string;
      /** The slicer's own detail, scrubbed; null with none. */
      detail: string | null;
    }
  | DescriptionsReconvertedEvent
  | {
      type: "render_failed";
      at: string;
      /**
       * scad: an OpenSCAD render; step: a STEP conversion; preview: an STL's
       * preview picture, or a STEP file's made from its mesh (issue #316).
       */
      kind: "scad" | "step" | "preview";
      model: { id: string; name: string };
      file: { id: string; name: string };
      /** The renderer's message as the app stored it, scrubbed; null with none. */
      message: string | null;
      /** Platehouse's own sentences at the start of message, by code (derived/client.ts). */
      messageCodes: string[];
      /** What message holds after those sentences, or null. */
      messageDetail: string | null;
    };

/** One finished description re-conversion (#357): what it did, from upgrade_steps. */
export interface DescriptionsReconvertedEvent {
  type: "descriptions_reconverted";
  at: string;
  /** The converter version it converted with (packages/makerworld CONVERTER_VERSION). */
  converter: number;
  checked: number;
  /** Written again with the new converter's text. */
  changed: number;
  /** Already what the new converter writes. */
  unchanged: number;
  /** Left as they were: edited, or not written by the converter. */
  kept: number;
  /** Left as they were because their .3mf could not be read. */
  unreadable: number;
}

export interface ActivityView {
  /** The server's clock when the answer was read. */
  generatedAt: string;
  library: {
    models: { live: number; trashed: number };
    files: Record<FileKind, number>;
    plates: number;
    blobs: { count: number; bytes: number };
    lastImportAt: string | null;
  };
  /** printerId is the default printer; printerName is it in full ("Bambu Lab P1S, 0.4 mm nozzle"). */
  estimates: EstimateProgress & {
    printerId: string;
    printerName: string;
    orcaVersion: string | null;
  };
  queues: QueueRow[];
  schedules: ScheduleRow[];
  slicer: {
    reachable: boolean;
    busy: boolean | null;
    orca: string | null;
    openscad: string | null;
    /** The slicer's sandbox; null when it did not answer. Its own detail is never sent. */
    sandbox: "checking" | "on" | "off" | null;
    sandboxReason: "old_kernel" | "check_failed" | null;
    /** True when the sandbox is off and the slicer is set to run estimates and STEP previews without it. */
    unsandboxed: boolean | null;
    /** The default printer (My printers), and its full name. */
    printerId: string;
    printerName: string;
  };
  events: {
    items: ActivityEvent[];
    limit: number;
    /** False when the inbox's failed/ folder could not be read, so its failures may be missing. */
    inboxReadable: boolean;
  };
  /** True while anything is queued or running: the page polls faster then. */
  working: boolean;
}

// ---- Pure parts, tested without a database ----

/** A cron expression the app schedules, in plain words; any other is shown as it is. */
export function scheduleText(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];
  if (dom !== "*" || month !== "*" || dow !== "*") return cron;
  const every = /^\*\/(\d+)$/.exec(minute);
  if (every && hour === "*") return `Every ${every[1]} minutes`;
  if (minute === "0" && hour === "*") return "Every hour";
  if (/^\d{1,2}$/.test(minute) && /^\d{1,2}$/.test(hour)) {
    return `Daily at ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  }
  return cron;
}

export const ROW_LABELS: Readonly<Record<QueueRowId, string>> = {
  ingest: "Ingest (new files)",
  estimates: "Estimates (slicing)",
  renders: "OpenSCAD renders",
  step: "STEP conversion",
  scheduled: "Scheduled jobs",
  other: "Other slicer work",
};

/** The slicer queue's job kinds (estimates/service.ts, derived/derived.ts) and their rows. */
const SLICER_KIND_ROWS: Readonly<Record<string, QueueRowId>> = {
  slice: "estimates",
  "render-scad": "renders",
  "convert-step": "step",
  // Preview pictures (issue #316) are OpenSCAD renders as well.
  "render-stl": "renders",
  "preview-step": "renders",
};

/** pg-boss's live counts as the page's rows; "other" only when a slicer job of an unknown kind is live. */
export function queueRows(counts: readonly QueueCount[]): QueueRow[] {
  const rows = new Map<QueueRowId, QueueRow>();
  for (const id of ["ingest", "estimates", "renders", "step", "scheduled"] as const) {
    rows.set(id, { id, label: ROW_LABELS[id], waiting: 0, active: 0, failed: 0 });
  }
  for (const c of counts) {
    let id: QueueRowId;
    if (c.queue === QUEUE.ingest) id = "ingest";
    else if (c.queue === QUEUE.maintenance || c.queue === QUEUE.upgrade) id = "scheduled";
    else if (c.queue === QUEUE.slicer) {
      id =
        (c.kind !== null && Object.hasOwn(SLICER_KIND_ROWS, c.kind) && SLICER_KIND_ROWS[c.kind]) ||
        "other";
    } else continue;
    let row = rows.get(id);
    if (row === undefined) {
      row = { id, label: ROW_LABELS[id], waiting: 0, active: 0, failed: 0 };
      rows.set(id, row);
    }
    if (c.state === "created" || c.state === "retry") row.waiting += c.n;
    else if (c.state === "active") row.active += c.n;
    else if (c.state === "failed") row.failed += c.n;
  }
  return [...rows.values()];
}

/** The estimate counts as progress, with a rate and a rough time left from the recent finishes. */
export function progressOf(
  counts: {
    ok: number;
    pending: number;
    running: number;
    failed: number;
    recentFinished: number;
    firstRecent: Date | null;
  },
  now: Date,
): EstimateProgress {
  const { ok, pending, running, failed, recentFinished, firstRecent } = counts;
  let perMinute: number | null = null;
  if (recentFinished >= MIN_RECENT_FOR_RATE && firstRecent !== null) {
    const minutes = Math.max((now.getTime() - firstRecent.getTime()) / 60_000, 1);
    perMinute = Math.round((recentFinished / minutes) * 100) / 100;
  }
  const left = pending + running;
  const secondsLeft =
    perMinute !== null && perMinute > 0 && left > 0 ? Math.round((left / perMinute) * 60) : null;
  return {
    done: ok,
    pending,
    running,
    failed,
    total: ok + pending + running + failed,
    perMinute,
    secondsLeft,
  };
}

/** The upgrade_steps name prefix of the description re-conversion runs. */
const RECONVERT_STEP_PREFIX = "reconvert-descriptions-";

/**
 * The finished description re-conversions as events (#357), one per run,
 * from their upgrade_steps rows. A count that is missing or not a whole
 * number of 0 or more reads as 0, and a row of any other name is left out.
 * So is a run that checked no description: a new install, or a library with
 * nothing to convert, still records the step so it is not run again, but
 * there was no upgrade to show.
 */
export function reconvertEvents(
  steps: ReadonlyArray<{ name: string; finishedAt: Date; result: unknown }>,
): DescriptionsReconvertedEvent[] {
  const count = (result: unknown, key: string): number => {
    const v = (result as Record<string, unknown> | null)?.[key];
    return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
  };
  return steps.flatMap((step) => {
    if (!step.name.startsWith(RECONVERT_STEP_PREFIX)) return [];
    const version = step.name.slice(RECONVERT_STEP_PREFIX.length);
    if (!/^[1-9][0-9]{0,8}$/.test(version)) return [];
    const r = typeof step.result === "object" ? step.result : null;
    const checked = count(r, "checked");
    if (checked === 0) return [];
    return [
      {
        type: "descriptions_reconverted",
        at: step.finishedAt.toISOString(),
        converter: Number(version),
        checked,
        changed: count(r, "changed"),
        unchanged: count(r, "unchanged"),
        kept: count(r, "kept"),
        unreadable: count(r, "unreadable"),
      },
    ];
  });
}

/** Every kind's events in one list, newest first, at most EVENT_LIMIT. */
export function mergeEvents(lists: ReadonlyArray<readonly ActivityEvent[]>): ActivityEvent[] {
  return lists
    .flat()
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, EVENT_LIMIT);
}

/** A regular file with no other name: what the watcher writes a reason file as. */
function isOwnFile(st: BigIntStats): boolean {
  return st.isFile() && st.nlink === 1n;
}

/** Which file a reason file was when it was dated: its device and inode. */
interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

/**
 * The first bytes of the file at path, at most limit of them; nothing past
 * limit is read. undefined unless what is opened is the very file expected
 * (same device and inode), a regular file with one link: not a symlink
 * (O_NOFOLLOW fails with ELOOP; where a platform lacks O_NOFOLLOW, the
 * inode check refuses the file a link led to), not a FIFO, socket or other
 * entry put there after the listing (O_NONBLOCK, so opening a FIFO never
 * waits for a writer), not another file renamed over the name, and not a
 * second name for a file elsewhere (a hard link).
 */
async function readStart(
  path: string,
  limit: number,
  expected: FileIdentity,
): Promise<Buffer | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, OPEN_SETTLED);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") return undefined;
    throw error;
  }
  try {
    const st = await handle.stat({ bigint: true });
    if (!isOwnFile(st) || st.dev !== expected.dev || st.ino !== expected.ino) return undefined;
    const buffer = Buffer.alloc(limit);
    let filled = 0;
    while (filled < limit) {
      const { bytesRead } = await handle.read(buffer, filled, limit - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  } finally {
    await handle.close();
  }
}

/**
 * A failed file's name as shown: its format characters dropped (joiners
 * stay), and empty when nothing is left to show, so the page picks its own
 * placeholder in its own language (issue #473).
 */
function shownName(name: string): string {
  const clean = stripFormatChars(name);
  return nothingToShow(clean) ? "" : clean;
}

/**
 * The inbox's failed files (inbox/watch.ts moves each to failed/<name> with
 * <name>.reason.txt beside it), newest reason file first, at most limit.
 * A reason file counts only while something is under <name> beside it in
 * failed/, of any type: a regular file, a folder, a FIFO, a socket or a
 * symlink (the watcher moves an entry it cannot put back, such as a FIFO
 * swapped in during an import, into failed/ as it is, issue #402). With
 * nothing under <name>, someone retried by moving the entry back into the
 * inbox, reason file included, and the page would otherwise show a failure
 * for a file that may since have been imported, with an old reason.
 * Each is the file's name and its scrubbed reason; no path is returned.
 * readable is false when no inbox is set up or failed/ cannot be listed,
 * so the page can say its failures may be missing; a failed/ that does not
 * exist yet simply has none.
 *
 * Whoever can write the inbox can write failed/, and need not be a member,
 * so nothing in it is trusted. failed/ must be a real folder, not a symlink,
 * when the read starts, and still be when it ends, or readable is false
 * (Node cannot open a file relative to an open folder, so this does not
 * confine the read by itself; the device and inode checks below do).
 * failed/ is listed by name only: a listing that asks for each entry's type
 * stats every entry on a filesystem that does not say (NFS, XFS without
 * ftype, some FUSE). Only the first INBOX_PASS_LIMIT names are looked at,
 * as the watcher looks at no more than that in one pass, and only a reason
 * file's name is stat'ed. Each is dated by its lstat and counts only as a
 * regular file with one link on failed/'s device (the watcher writes each
 * new, so a real one has one link). It is then opened as the watcher opens
 * a settled file (OPEN_SETTLED) and read only if the open file is that same
 * one (readStart): anything else is skipped, not followed or waited on.
 */
export async function readInboxFailures(
  inboxDir: string | undefined,
  limit: number,
): Promise<{ readable: boolean; items: ActivityEvent[] }> {
  if (inboxDir === undefined) return { readable: false, items: [] };
  const dir = join(inboxDir, FAILED_DIR);
  let folder: BigIntStats;
  let listed: string[];
  try {
    folder = await lstat(dir, { bigint: true });
    if (!folder.isDirectory()) return { readable: false, items: [] };
    const all = await readdir(dir);
    listed = all.length > INBOX_PASS_LIMIT ? all.slice(0, INBOX_PASS_LIMIT) : all;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { readable: true, items: [] };
    return { readable: false, items: [] };
  }
  // Every name looked at, whatever its type: presence is the test.
  const present = new Set(listed);
  const names = listed.filter(
    (name) =>
      name.endsWith(REASON_SUFFIX) &&
      name.length > REASON_SUFFIX.length &&
      present.has(name.slice(0, -REASON_SUFFIX.length)),
  );
  const dated: Array<FileIdentity & { name: string; mtime: number }> = [];
  for (const name of names) {
    try {
      const st = await lstat(join(dir, name), { bigint: true });
      if (isOwnFile(st) && st.dev === folder.dev) {
        dated.push({ name, mtime: st.mtime.getTime(), dev: st.dev, ino: st.ino });
      }
    } catch {
      // Gone since the listing: nothing to show.
    }
  }
  dated.sort((a, b) => b.mtime - a.mtime || (a.name < b.name ? -1 : 1));
  const items: ActivityEvent[] = [];
  for (const { name, mtime, dev, ino } of dated.slice(0, limit)) {
    let reason = "";
    try {
      const bytes = await readStart(join(dir, name), REASON_BYTES, { dev, ino });
      // Not the file that was dated: swapped since, so skipped.
      if (bytes === undefined) continue;
      reason = bytes.toString("utf8");
    } catch {
      reason = "";
    }
    // A reason file starts with its code (inbox/watch.ts reasonFileText); an
    // older one holds the sentence alone.
    const parsed = parseReasonFile(reason);
    const shown = scrubText(parsed.reason) || "No reason was recorded.";
    // Read back from the scrubbed sentence, so the page's words name the
    // model exactly as the English sentence it replaces does.
    const duplicate = parsed.code === "duplicate" ? parseDuplicateMessage(shown) : undefined;
    items.push({
      type: "inbox_failed",
      at: new Date(mtime).toISOString(),
      name: shownName(name.slice(0, -REASON_SUFFIX.length)),
      reason: shown,
      reasonCode: parsed.code,
      ...(duplicate === undefined ? {} : { duplicate }),
    });
  }
  // failed/ swapped for a symlink or another folder and left so: what was
  // read may have come from somewhere else, so none of it is shown.
  try {
    const after = await lstat(dir, { bigint: true });
    if (!after.isDirectory() || after.ino !== folder.ino || after.dev !== folder.dev) {
      return { readable: false, items: [] };
    }
  } catch {
    return { readable: false, items: [] };
  }
  return { readable: true, items };
}

// ---- The service ----

export const SCHEDULE_LABELS: Readonly<Record<string, string>> = {
  [MAINTENANCE_TASKS.purgeExpired]: "Trash purge (models trashed over 30 days ago)",
  [MAINTENANCE_TASKS.sweepOrphans]: "Sweep of stored objects with no record",
  [MAINTENANCE_TASKS.purgeSessions]: "Expired login cleanup",
  [MAINTENANCE_TASKS.sweepUploads]: "Sweep of unfinished uploads",
  [MAINTENANCE_TASKS.pollOrca]: "Slicer version check",
  [MAINTENANCE_TASKS.checkRenders]: "Render check",
  [MAINTENANCE_TASKS.backfillPreviews]: "Preview pictures for older STL and STEP files",
  // Listed only while the step is pending (#382), so an unfinished
  // re-conversion shows on the page, not only in the server log.
  [UPGRADE_TASKS.reconvertDescriptions]: "MakerWorld descriptions and licences (until they finish)",
};

const SCHEDULE_ORDER: readonly string[] = [
  MAINTENANCE_TASKS.purgeExpired,
  MAINTENANCE_TASKS.sweepOrphans,
  MAINTENANCE_TASKS.purgeSessions,
  MAINTENANCE_TASKS.sweepUploads,
  MAINTENANCE_TASKS.checkRenders,
  MAINTENANCE_TASKS.backfillPreviews,
  MAINTENANCE_TASKS.pollOrca,
  UPGRADE_TASKS.reconvertDescriptions,
];

export interface AppActivity {
  read(): Promise<ActivityView>;
}

export interface AppActivityDeps {
  db: Kysely<DB>;
  boss: Pick<PgBoss, "getSchedules">;
  slicer: { health(): Promise<Health> };
  /** INBOX_DIR; its failed/ folder holds the inbox's failures. */
  inboxDir?: string;
  /** The clock; the real one when left out. */
  now?: () => Date;
  /** SLICER_HEALTH_TIMEOUT_MS when left out. */
  healthTimeoutMs?: number;
}

/** A health answer, or null when the slicer did not answer in time or at all. */
async function healthWithin(slicer: AppActivityDeps["slicer"], ms: number): Promise<Health | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([slicer.health(), late]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function createAppActivity(deps: AppActivityDeps): AppActivity {
  const clock = deps.now ?? (() => new Date());
  const healthMs = deps.healthTimeoutMs ?? SLICER_HEALTH_TIMEOUT_MS;
  type InboxFailures = { readable: boolean; items: ActivityEvent[] };
  let inboxCache: { at: number; value: InboxFailures } | null = null;
  /** The read in progress, shared by polls that arrive while it runs. */
  let inboxReading: Promise<InboxFailures> | null = null;

  async function inboxFailures(): Promise<InboxFailures> {
    const nowMs = clock().getTime();
    if (inboxCache !== null && nowMs - inboxCache.at < INBOX_CACHE_MS) return inboxCache.value;
    if (inboxReading !== null) return inboxReading;
    inboxReading = readInboxFailures(deps.inboxDir, EVENT_LIMIT)
      .then((value) => {
        inboxCache = { at: nowMs, value };
        return value;
      })
      .finally(() => {
        inboxReading = null;
      });
    return inboxReading;
  }

  async function readDatabase(now: Date) {
    return deps.db
      .transaction()
      .setIsolationLevel("repeatable read")
      .setAccessMode("read only")
      .execute(async (trx) => {
        const repo = activityRepo(trx);
        const settings = await settingsRepo(trx).get();
        const version = settings.lastOrcaVersion;
        const library = await repo.libraryCounts();
        const counts = await repo.estimateCounts(
          settings.printerId,
          version,
          new Date(now.getTime() - RATE_WINDOW_MS),
        );
        const queues = await repo.queueCounts([
          QUEUE.ingest,
          QUEUE.slicer,
          QUEUE.maintenance,
          QUEUE.upgrade,
        ]);
        const lastRuns = await repo.lastRuns([QUEUE.maintenance, QUEUE.upgrade]);
        const models = await repo.recentModels(QUEUE.ingest, EVENT_LIMIT);
        const estimates = await repo.failedEstimates(settings.printerId, version, EVENT_LIMIT);
        const derived = await repo.failedDerived(EVENT_LIMIT);
        const previews = await repo.failedPreviews(EVENT_LIMIT);
        const upgrades = await descriptionsRepo(trx).finishedSteps(
          RECONVERT_STEP_PREFIX,
          EVENT_LIMIT,
        );
        return {
          settings,
          library,
          counts,
          queues,
          lastRuns,
          models,
          estimates,
          derived,
          previews,
          upgrades,
        };
      });
  }

  return {
    async read(): Promise<ActivityView> {
      const now = clock();
      const [data, health, inbox, maintenanceSchedules, upgradeSchedules] = await Promise.all([
        readDatabase(now),
        healthWithin(deps.slicer, healthMs),
        inboxFailures(),
        deps.boss.getSchedules(QUEUE.maintenance),
        deps.boss.getSchedules(QUEUE.upgrade),
      ]);
      const schedules = [...maintenanceSchedules, ...upgradeSchedules];
      const {
        settings,
        library,
        counts,
        queues,
        lastRuns,
        models,
        estimates,
        derived,
        previews,
        upgrades,
      } = data;

      const progress = progressOf(counts, now);
      const rows = queueRows(queues);
      const runs = new Map(lastRuns.map((r) => [r.task, r]));
      const scheduleRows: ScheduleRow[] = [...schedules]
        .sort((a, b) => {
          const ia = SCHEDULE_ORDER.indexOf(a.key);
          const ib = SCHEDULE_ORDER.indexOf(b.key);
          return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || (a.key < b.key ? -1 : 1);
        })
        .map((s) => {
          const run = runs.get(s.key);
          return {
            key: s.key,
            label: SCHEDULE_LABELS[s.key] ?? s.key,
            schedule: `${scheduleText(s.cron)} (${s.timezone})`,
            lastRunAt: run === undefined ? null : run.at.toISOString(),
            lastState: run === undefined ? null : run.state,
          };
        });

      const modelEvents: ActivityEvent[] = models.map((m) => ({
        type: "model_imported",
        at: m.createdAt.toISOString(),
        model: { id: m.id, name: m.name, trashed: m.trashed },
        source: m.apiRef ? "api" : m.uploaded ? "upload" : "unknown",
      }));
      const estimateEvents: ActivityEvent[] = estimates.map((e) => ({
        type: "estimate_failed",
        at: e.finishedAt.toISOString(),
        estimateId: e.id,
        model: { id: e.modelId, name: e.modelName },
        plate: { index: e.plateIndex, name: e.plateName },
        code: e.failureCode,
        reason: reasonWords(e.failureReason),
        reasonCode: isReason(e.failureReason) ? e.failureReason : "slicer_error",
        detail: scrubDetail(e.failureDetail),
      }));
      const renderEvent = (d: FailedDerived, kind: "scad" | "step" | "preview"): ActivityEvent => {
        const message = scrubDerivedMessage(d.message);
        return {
          type: "render_failed",
          at: d.at.toISOString(),
          kind,
          model: { id: d.modelId, name: d.modelName },
          file: { id: d.fileId, name: d.fileName },
          message,
          ...renderParts(message),
        };
      };
      // A .scad's render or a STEP file's conversion from derived_status,
      // and an STL's or STEP file's picture from its own preview_status
      // (issue #380), whatever its message says.
      const renderEvents: ActivityEvent[] = [
        ...derived
          .filter((d) => d.kind === "scad" || d.kind === "step")
          .map((d) => renderEvent(d, d.kind === "scad" ? "scad" : "step")),
        ...previews
          .filter((d) => d.kind === "stl" || d.kind === "step")
          .map((d) => renderEvent(d, "preview")),
      ];

      const working =
        progress.pending + progress.running > 0 || rows.some((r) => r.waiting + r.active > 0);

      return {
        generatedAt: now.toISOString(),
        library: {
          models: library.models,
          files: library.files,
          plates: library.plates,
          blobs: library.blobs,
          lastImportAt: library.lastImportAt?.toISOString() ?? null,
        },
        estimates: {
          ...progress,
          printerId: settings.printerId,
          printerName: printerName(settings.printerId, []),
          orcaVersion: settings.lastOrcaVersion,
        },
        queues: rows,
        schedules: scheduleRows,
        slicer: {
          reachable: health !== null,
          busy: health?.busy ?? null,
          orca: health?.orca ?? null,
          openscad: health?.openscad ?? null,
          sandbox: health?.sandbox.state ?? null,
          sandboxReason: health?.sandbox.reason ?? null,
          unsandboxed: health
            ? health.sandbox.state === "off" && health.sandbox.allowUnsandboxed
            : null,
          printerId: settings.printerId,
          printerName: printerName(settings.printerId, []),
        },
        events: {
          items: mergeEvents([
            modelEvents,
            estimateEvents,
            renderEvents,
            inbox.items,
            reconvertEvents(upgrades),
          ]),
          limit: EVENT_LIMIT,
          inboxReadable: inbox.readable,
        },
        working,
      };
    },
  };
}

/** Registers GET /app/api/activity; without an AppActivity it answers 503. */
export async function registerActivityApi(
  app: FastifyInstance,
  activity: AppActivity | undefined,
): Promise<void> {
  await appApiScope(app, (scope) => {
    scope.get("/activity", async (): Promise<ActivityView> => need(activity).read());
  });
}
