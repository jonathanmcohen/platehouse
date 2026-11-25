// The Activity page's app API, the parts that need no database (2026-11-19,
// the maintainer: one page that shows what Platehouse is doing and holds, so the user never
// has to read container logs). The queries themselves run against Postgres
// and pg-boss in test/integration/app-api/activity.test.ts.
//
// - scrubText, which cleans error text from Orca, OpenSCAD or the inbox
//   before it is shown, is shared with the model page and the API and is
//   tested in test/scrub.test.ts.
// - scheduleText: the maintenance schedules in plain words.
// - queueRows: pg-boss's live counts grouped into the page's rows, the
//   slicer queue split by job kind.
// - progressOf: the estimate counts, the progress and a rough time left
//   from the recent rate.
// - mergeEvents: newest first, capped.
// - readInboxFailures: the inbox's failed/ folder, newest first, with each
//   file's reason, never a path.
// - createAppActivity's failed renders (issue #273): a long OpenSCAD message
//   is shown whole, cleaned, with its ERROR line, the last line, kept. Run
//   against a scripted database built as the server builds its own
//   (CamelCasePlugin), which answers the settings row and the failed file
//   and no rows for every other read. Every id here is made up for the test.

import { spawnSync } from "node:child_process";
import { basename, sep } from "node:path";
import type { Health } from "@platehouse/slicer-contract";

// Every read made through a file handle opened on a reason file, as
// [path, bytes asked for], so a test can show how much of the file was read.
// fsSpy also records each stat of a reason file, each lstat of an entry in
// a failed/ folder, and each listing of a failed/ folder that asks for entry
// types (opendir, or readdir with withFileTypes), and beforeReasonOpen runs
// just before a reason file is opened: the last moment another writer can
// swap it. Every other open, and every other fs call, is the real one.
const reasonReads = vi.hoisted(() => [] as Array<[string, number]>);
const fsSpy = vi.hoisted(() => ({
  reasonStats: [] as string[],
  failedLstats: [] as string[],
  typedListings: 0,
  allListings: 0,
  beforeReasonOpen: undefined as ((path: string) => Promise<void>) | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const open: typeof real.open = async (...args) => {
    const path = String(args[0]);
    if (path.endsWith(".reason.txt")) await fsSpy.beforeReasonOpen?.(path);
    const handle = await real.open(...args);
    if (!path.endsWith(".reason.txt")) return handle;
    const read = handle.read.bind(handle);
    handle.read = ((...readArgs: unknown[]) => {
      const length = typeof readArgs[2] === "number" ? readArgs[2] : Number.POSITIVE_INFINITY;
      reasonReads.push([path, length]);
      return (read as (...a: unknown[]) => ReturnType<typeof handle.read>)(...readArgs);
    }) as typeof handle.read;
    return handle;
  };
  const stat = (async (...args: Parameters<typeof real.stat>) => {
    if (String(args[0]).endsWith(".reason.txt")) fsSpy.reasonStats.push(String(args[0]));
    return real.stat(...args);
  }) as typeof real.stat;
  const lstat = (async (...args: Parameters<typeof real.lstat>) => {
    const path = String(args[0]);
    if (path.includes(`${sep}failed${sep}`)) fsSpy.failedLstats.push(basename(path));
    return real.lstat(...args);
  }) as typeof real.lstat;
  const isFailed = (path: unknown) => String(path).endsWith(`${sep}failed`);
  const opendir: typeof real.opendir = async (...args) => {
    if (isFailed(args[0])) {
      fsSpy.typedListings += 1;
      fsSpy.allListings += 1;
    }
    return real.opendir(...args);
  };
  const readdir = (async (...args: Parameters<typeof real.readdir>) => {
    const options = args[1];
    if (isFailed(args[0])) fsSpy.allListings += 1;
    if (isFailed(args[0]) && typeof options === "object" && options?.withFileTypes === true) {
      fsSpy.typedListings += 1;
    }
    return real.readdir(...args);
  }) as typeof real.readdir;
  const hooked = { open, stat, lstat, opendir, readdir };
  return { ...real, default: { ...real, ...hooked }, ...hooked };
});

import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CamelCasePlugin,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from "kysely";
import type { Schedule } from "pg-boss";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type ActivityEvent,
  createAppActivity,
  EVENT_LIMIT,
  mergeEvents,
  progressOf,
  queueRows,
  REASON_BYTES,
  readInboxFailures,
  reconvertEvents,
  scheduleText,
} from "../../src/app-api/activity.js";
import type { DB } from "../../src/db/types.js";
import { DERIVED_MESSAGES, PREVIOUS_RENDERS_SENTENCE } from "../../src/derived/client.js";
import { reasonFileText } from "../../src/inbox/watch.js";
import { duplicateMessage } from "../../src/ingest/duplicates.js";
import { QUEUE, UPGRADE_TASKS } from "../../src/jobs/queues.js";
import { SCRUB_MAX_CHARS } from "../../src/scrub.js";

const DUP_MODEL = "0198f0c4-0000-7000-8000-00000000000a";
const DUP_OTHER = "0198f0c4-0000-7000-8000-00000000000b";

describe("scheduleText", () => {
  test("says each schedule the app uses in plain words", () => {
    expect(scheduleText("*/10 * * * *")).toBe("Every 10 minutes");
    expect(scheduleText("*/15 * * * *")).toBe("Every 15 minutes");
    expect(scheduleText("0 * * * *")).toBe("Every hour");
    expect(scheduleText("30 3 * * *")).toBe("Daily at 03:30");
    expect(scheduleText("35 4 * * *")).toBe("Daily at 04:35");
  });

  test("shows any other expression as it is", () => {
    expect(scheduleText("0 4 * * 1")).toBe("0 4 * * 1");
  });
});

describe("queueRows", () => {
  test("is every row at zero when nothing is queued", () => {
    const rows = queueRows([]);
    expect(rows.map((r) => r.id)).toEqual(["ingest", "estimates", "renders", "step", "scheduled"]);
    for (const row of rows) expect([row.waiting, row.active, row.failed]).toEqual([0, 0, 0]);
  });

  test("splits the slicer queue by job kind and counts created and retry as waiting", () => {
    const rows = queueRows([
      { queue: "ingest", kind: null, state: "created", n: 2 },
      { queue: "ingest", kind: null, state: "active", n: 1 },
      { queue: "slicer", kind: "slice", state: "created", n: 400 },
      { queue: "slicer", kind: "slice", state: "retry", n: 3 },
      { queue: "slicer", kind: "slice", state: "active", n: 1 },
      { queue: "slicer", kind: "render-scad", state: "failed", n: 2 },
      { queue: "slicer", kind: "convert-step", state: "created", n: 5 },
      { queue: "maintenance", kind: "purge-expired", state: "active", n: 1 },
      { queue: "maintenance", kind: "poll-orca", state: "failed", n: 4 },
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.id, [r.waiting, r.active, r.failed]]));
    expect(by).toEqual({
      ingest: [2, 1, 0],
      estimates: [403, 1, 0],
      renders: [0, 0, 2],
      step: [5, 0, 0],
      scheduled: [0, 1, 4],
    });
  });

  test("counts the upgrade queue in the scheduled row, with maintenance", () => {
    const rows = queueRows([
      { queue: QUEUE.maintenance, kind: null, state: "active", n: 1 },
      { queue: QUEUE.upgrade, kind: null, state: "created", n: 1 },
      { queue: QUEUE.upgrade, kind: null, state: "active", n: 1 },
      { queue: QUEUE.upgrade, kind: null, state: "failed", n: 2 },
    ]);
    expect(rows.find((r) => r.id === "scheduled")).toMatchObject({
      waiting: 1,
      active: 2,
      failed: 2,
    });
    expect(rows.map((r) => r.id)).toEqual(["ingest", "estimates", "renders", "step", "scheduled"]);
  });

  // Issue #316: an STL's preview and a STEP mesh's preview are OpenSCAD
  // renders too, so they count there, not as other slicer work.
  test("counts STL and STEP preview jobs as OpenSCAD renders", () => {
    const rows = queueRows([
      { queue: "slicer", kind: "render-stl", state: "created", n: 7 },
      { queue: "slicer", kind: "preview-step", state: "active", n: 1 },
    ]);
    const by = Object.fromEntries(rows.map((r) => [r.id, [r.waiting, r.active, r.failed]]));
    expect(by.renders).toEqual([7, 1, 0]);
    expect(by.other).toBeUndefined();
  });

  test("puts a slicer job of a kind it does not know in its own row", () => {
    const rows = queueRows([{ queue: "slicer", kind: "mystery", state: "created", n: 1 }]);
    const other = rows.find((r) => r.id === "other");
    expect(other).toMatchObject({ waiting: 1, active: 0, failed: 0 });
  });
});

describe("progressOf", () => {
  const now = new Date("2026-11-19T12:00:00Z");

  test("is empty and has no time left with no estimates at all", () => {
    expect(
      progressOf(
        { ok: 0, pending: 0, running: 0, failed: 0, recentFinished: 0, firstRecent: null },
        now,
      ),
    ).toEqual({
      done: 0,
      pending: 0,
      running: 0,
      failed: 0,
      total: 0,
      perMinute: null,
      secondsLeft: null,
    });
  });

  test("gives a rate and a time left from the recent finishes", () => {
    const firstRecent = new Date(now.getTime() - 10 * 60_000);
    const p = progressOf(
      { ok: 100, pending: 59, running: 1, failed: 2, recentFinished: 20, firstRecent },
      now,
    );
    expect(p.total).toBe(162);
    expect(p.perMinute).toBe(2);
    // 60 plates left at 2 a minute: 30 minutes.
    expect(p.secondsLeft).toBe(1800);
  });

  test("gives no time left when too few plates finished recently to tell", () => {
    const firstRecent = new Date(now.getTime() - 60_000);
    const p = progressOf(
      { ok: 1, pending: 10, running: 1, failed: 0, recentFinished: 2, firstRecent },
      now,
    );
    expect(p.perMinute).toBeNull();
    expect(p.secondsLeft).toBeNull();
  });

  test("gives no time left when nothing is waiting", () => {
    const firstRecent = new Date(now.getTime() - 10 * 60_000);
    const p = progressOf(
      { ok: 30, pending: 0, running: 0, failed: 0, recentFinished: 30, firstRecent },
      now,
    );
    expect(p.perMinute).toBe(3);
    expect(p.secondsLeft).toBeNull();
  });
});

describe("mergeEvents", () => {
  function inbox(at: string, name: string): ActivityEvent {
    return { type: "inbox_failed", at, name, reason: "x", reasonCode: null };
  }

  test("puts the newest first across every kind", () => {
    const merged = mergeEvents([
      [inbox("2026-11-19T10:00:00.000Z", "a")],
      [inbox("2026-11-19T12:00:00.000Z", "b"), inbox("2026-11-19T09:00:00.000Z", "c")],
    ]);
    expect(merged.map((e) => (e.type === "inbox_failed" ? e.name : ""))).toEqual(["b", "a", "c"]);
  });

  test("keeps at most EVENT_LIMIT", () => {
    const many = Array.from({ length: EVENT_LIMIT + 20 }, (_, i) =>
      inbox(new Date(Date.UTC(2026, 10, 19, 0, i)).toISOString(), `f${i}`),
    );
    const merged = mergeEvents([many]);
    expect(merged).toHaveLength(EVENT_LIMIT);
    expect(merged[0]).toMatchObject({ name: `f${EVENT_LIMIT + 19}` });
  });
});

describe("readInboxFailures", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ph-activity-"));
    fsSpy.reasonStats.length = 0;
    fsSpy.failedLstats.length = 0;
    fsSpy.typedListings = 0;
  });

  afterEach(async () => {
    fsSpy.beforeReasonOpen = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  test("is empty when there is no failed folder", async () => {
    expect(await readInboxFailures(dir, 10)).toEqual({ readable: true, items: [] });
  });

  test("shows a failed file's name without format characters (U+202E, U+200B)", async () => {
    const failed = join(dir, "failed");
    await mkdir(failed);
    const name = `a${String.fromCodePoint(0x202e)}b${String.fromCodePoint(0x200b)}c.stl`;
    await writeFile(join(failed, name), "x");
    await writeFile(join(failed, `${name}.reason.txt`), "Gone.");
    const { items } = await readInboxFailures(dir, 10);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: "abc.stl" });
  });

  test("keeps the joiners in a failed file's name (U+200C, U+200D)", async () => {
    const failed = join(dir, "failed");
    await mkdir(failed);
    const name = `a${String.fromCodePoint(0x200c)}b${String.fromCodePoint(0x200d)}c.stl`;
    await writeFile(join(failed, name), "x");
    await writeFile(join(failed, `${name}.reason.txt`), "Gone.");
    const { items } = await readInboxFailures(dir, 10);
    expect(items[0]).toMatchObject({ name });
  });

  test("a failed file named only with format characters and joiners has an empty name", async () => {
    const failed = join(dir, "failed");
    await mkdir(failed);
    const name = `${String.fromCodePoint(0x202e)}${String.fromCodePoint(0x200b)}${String.fromCodePoint(0x200c)}`;
    await writeFile(join(failed, name), "x");
    await writeFile(join(failed, `${name}.reason.txt`), "Gone.");
    const { items } = await readInboxFailures(dir, 10);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: "" });
  });

  test("lists each failed file's name and reason, newest first, with no path", async () => {
    const failed = join(dir, "failed");
    await mkdir(failed);
    await writeFile(join(failed, "old.3mf"), "x");
    await writeFile(join(failed, "old.3mf.reason.txt"), "This file is not a supported file.\n");
    await writeFile(join(failed, "new.stl"), "x");
    await writeFile(
      join(failed, "new.stl.reason.txt"),
      "The upload failed: EACCES: permission denied, open '/data/inbox/new.stl'",
    );
    await writeFile(join(failed, "gone.scad"), "x");
    await writeFile(join(failed, "gone.scad.reason.txt"), "Gone.");
    await utimes(join(failed, "old.3mf.reason.txt"), new Date(1_000_000), new Date(1_000_000));
    await utimes(join(failed, "gone.scad.reason.txt"), new Date(2_000_000), new Date(2_000_000));
    await utimes(join(failed, "new.stl.reason.txt"), new Date(3_000_000), new Date(3_000_000));

    const { readable, items } = await readInboxFailures(dir, 10);
    expect(readable).toBe(true);
    expect(items).toEqual([
      {
        type: "inbox_failed",
        at: new Date(3_000_000).toISOString(),
        name: "new.stl",
        reason: "The upload failed: EACCES: permission denied, open '[path]'",
        reasonCode: null,
      },
      {
        type: "inbox_failed",
        at: new Date(2_000_000).toISOString(),
        name: "gone.scad",
        reason: "Gone.",
        reasonCode: null,
      },
      {
        type: "inbox_failed",
        at: new Date(1_000_000).toISOString(),
        name: "old.3mf",
        reason: "This file is not a supported file.",
        reasonCode: null,
      },
    ]);
    for (const item of items) expect(JSON.stringify(item)).not.toContain(dir);
  });

  test("a duplicate's reason carries the matched model's name, id and others for the page's language", async () => {
    const failed = join(dir, "failed");
    await mkdir(failed);
    const sentence = `${duplicateMessage([
      { modelId: DUP_MODEL, modelName: "Clip", fileId: "f1", fileName: "Clip.stl" },
      { modelId: DUP_OTHER, modelName: "Other", fileId: "f2", fileName: "Clip.stl" },
    ])}.`;
    for (const name of ["a.stl", "b.stl", "c.stl"]) await writeFile(join(failed, name), "x");
    await writeFile(join(failed, "a.stl.reason.txt"), reasonFileText(sentence, "duplicate"));
    // Another code's reason, and an older duplicate file whose words do not parse: no detail.
    await writeFile(
      join(failed, "b.stl.reason.txt"),
      reasonFileText("This file is not a supported file.", "unsupported_type"),
    );
    await writeFile(join(failed, "c.stl.reason.txt"), "duplicate: Something else.\n");
    const { items } = await readInboxFailures(dir, 10);
    const byName = new Map(items.map((i) => [i.type === "inbox_failed" ? i.name : "", i]));
    expect(byName.get("a.stl")).toMatchObject({
      reason: sentence,
      reasonCode: "duplicate",
      duplicate: { name: "Clip", id: DUP_MODEL, others: 1 },
    });
    expect(byName.get("b.stl")).not.toHaveProperty("duplicate");
    expect(byName.get("c.stl")).toMatchObject({ reasonCode: "duplicate" });
    expect(byName.get("c.stl")).not.toHaveProperty("duplicate");
  });

  // Issue #329: a retry that moves everything in failed/ back to the inbox,
  // reason files included, must not leave a made-up failure on the page.
  // Issue #402: the watcher moves an entry it cannot put back (a FIFO, a
  // socket, a folder swapped in during an import) into failed/ as it is, so
  // any entry under the name keeps its reason listed. Only a name with
  // nothing under it, the file moved back out to retry, is hidden.
  test("counts a reason file while any entry is under its name, and hides one whose entry was moved out", async () => {
    const failed = join(dir, "failed");
    await mkdir(failed);
    await writeFile(join(failed, "kept.3mf"), "x");
    await writeFile(join(failed, "kept.3mf.reason.txt"), "Kept.");
    // The file was moved back to the inbox: only its reason file is left.
    await writeFile(join(failed, "retried.3mf.reason.txt"), "Old reason.");
    // A folder, a symlink and a FIFO under the name are entries the watcher moved there.
    await mkdir(join(failed, "folder.3mf"));
    await writeFile(join(failed, "folder.3mf.reason.txt"), "Folder.");
    await symlink(join(failed, "kept.3mf"), join(failed, "link.3mf"));
    await writeFile(join(failed, "link.3mf.reason.txt"), "Link.");
    const fifo = spawnSync("mkfifo", [join(failed, "pipe.3mf")]);
    expect(fifo.status, String(fifo.stderr)).toBe(0);
    await writeFile(join(failed, "pipe.3mf.reason.txt"), "Pipe.");
    const { items } = await readInboxFailures(dir, 10);
    expect(items.map((i) => (i.type === "inbox_failed" ? i.name : "")).sort()).toEqual([
      "folder.3mf",
      "kept.3mf",
      "link.3mf",
      "pipe.3mf",
    ]);
  });

  test("reads at most REASON_BYTES of a reason file", async () => {
    const failed = join(dir, "failed");
    await mkdir(failed);
    await writeFile(join(failed, "big.3mf"), "x");
    await writeFile(join(failed, "big.3mf.reason.txt"), "a".repeat(REASON_BYTES * 4));
    reasonReads.length = 0;
    const { items } = await readInboxFailures(dir, 10);
    const reason = items[0]?.type === "inbox_failed" ? items[0].reason : "";
    expect(reason.length).toBeGreaterThan(0);
    expect(reason.length).toBeLessThanOrEqual(REASON_BYTES);
    // The file was read through a handle, and the bytes asked for add up to
    // REASON_BYTES at most: nothing past it was read. (Reading the whole file
    // and cutting the text, as before, asks for none through a handle here.)
    const asked = reasonReads.filter(([path]) => path.endsWith("big.3mf.reason.txt"));
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.reduce((sum, [, length]) => sum + length, 0)).toBeLessThanOrEqual(REASON_BYTES);
  });

  test("keeps only the newest limit", async () => {
    const failed = join(dir, "failed");
    await mkdir(failed);
    for (let i = 0; i < 5; i++) {
      await writeFile(join(failed, `f${i}.3mf`), "x");
      const reason = join(failed, `f${i}.3mf.reason.txt`);
      await writeFile(reason, `reason ${i}`);
      await utimes(reason, new Date(1_000_000 * (i + 1)), new Date(1_000_000 * (i + 1)));
    }
    const { items } = await readInboxFailures(dir, 2);
    expect(items.map((i) => (i.type === "inbox_failed" ? i.name : ""))).toEqual([
      "f4.3mf",
      "f3.3mf",
    ]);
  });

  // Whoever can write the inbox can write failed/ too, and need not be a
  // member: a reason file is opened as the watcher opens a settled file
  // (inbox/watch.ts OPEN_SETTLED), never through a symlink and never
  // waiting on a FIFO, and only a regular file is read.
  test("a reason file swapped for a symlink after the listing is not followed", async () => {
    const failed = join(dir, "failed");
    await mkdir(failed);
    const other = join(dir, "other.txt");
    await writeFile(other, "OTHER FILE TEXT");
    for (const name of ["kept.3mf", "swapped.3mf"]) {
      await writeFile(join(failed, name), "x");
      await writeFile(join(failed, `${name}.reason.txt`), `Reason for ${name}.`);
    }
    const swapped = join(failed, "swapped.3mf.reason.txt");
    fsSpy.beforeReasonOpen = async (path) => {
      if (path !== swapped) return;
      fsSpy.beforeReasonOpen = undefined;
      await unlink(swapped);
      await symlink(other, swapped);
    };
    const { readable, items } = await readInboxFailures(dir, 10);
    expect(readable).toBe(true);
    expect(items.map((i) => (i.type === "inbox_failed" ? i.name : ""))).toEqual(["kept.3mf"]);
    expect(JSON.stringify(items)).not.toContain("OTHER FILE TEXT");
  });

  // The watcher writes each reason file new (flag wx), so a real one has one
  // link. A second name for a file outside failed/ is not read.
  test("a reason file hard-linked to a file outside failed is not read", async (ctx) => {
    const failed = join(dir, "failed");
    await mkdir(failed);
    const other = join(dir, "other.txt");
    await writeFile(other, "OTHER FILE TEXT");
    await writeFile(join(failed, "kept.3mf"), "x");
    await writeFile(join(failed, "kept.3mf.reason.txt"), "Kept.");
    await writeFile(join(failed, "linked.3mf"), "x");
    try {
      await link(other, join(failed, "linked.3mf.reason.txt"));
    } catch (error) {
      // Written reason for the skip: a filesystem that refuses hard links can
      // hold no such reason file to test.
      const code = (error as { code?: string }).code;
      if (code === "EPERM" || code === "ENOTSUP" || code === "EXDEV") return ctx.skip();
      throw error;
    }
    const { readable, items } = await readInboxFailures(dir, 10);
    expect(readable).toBe(true);
    expect(items.map((i) => (i.type === "inbox_failed" ? i.name : ""))).toEqual(["kept.3mf"]);
    expect(JSON.stringify(items)).not.toContain("OTHER FILE TEXT");
  });

  test("a reason file replaced by another file after it was dated is not read", async () => {
    const failed = join(dir, "failed");
    await mkdir(failed);
    for (const name of ["kept.3mf", "replaced.3mf"]) {
      await writeFile(join(failed, name), "x");
      await writeFile(join(failed, `${name}.reason.txt`), `Reason for ${name}.`);
    }
    const replaced = join(failed, "replaced.3mf.reason.txt");
    fsSpy.beforeReasonOpen = async (path) => {
      if (path !== replaced) return;
      fsSpy.beforeReasonOpen = undefined;
      const other = join(dir, "other.txt");
      await writeFile(other, "OTHER FILE TEXT");
      await rename(other, replaced);
    };
    const { items } = await readInboxFailures(dir, 10);
    expect(items.map((i) => (i.type === "inbox_failed" ? i.name : ""))).toEqual(["kept.3mf"]);
    expect(JSON.stringify(items)).not.toContain("OTHER FILE TEXT");
  });

  test("a reason file swapped for a FIFO after the listing does not block and is skipped", async () => {
    const failed = join(dir, "failed");
    await mkdir(failed);
    await writeFile(join(failed, "kept.3mf"), "x");
    await writeFile(join(failed, "kept.3mf.reason.txt"), "Kept.");
    await writeFile(join(failed, "pipe.3mf"), "x");
    const pipe = join(failed, "pipe.3mf.reason.txt");
    await writeFile(pipe, "Pipe.");
    fsSpy.beforeReasonOpen = async (path) => {
      if (path !== pipe) return;
      fsSpy.beforeReasonOpen = undefined;
      await unlink(pipe);
      const made = spawnSync("mkfifo", [pipe]);
      expect(made.status, String(made.stderr)).toBe(0);
    };
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"blocked">((resolve) => {
      timer = setTimeout(() => resolve("blocked"), 2_000);
    });
    try {
      const result = await Promise.race([readInboxFailures(dir, 10), late]);
      expect(result).not.toBe("blocked");
      if (result === "blocked") return;
      expect(result.items.map((i) => (i.type === "inbox_failed" ? i.name : ""))).toEqual([
        "kept.3mf",
      ]);
    } finally {
      clearTimeout(timer);
      // Frees a read left waiting on the FIFO, so the run can end: a writer's
      // open succeeds only while a reader waits, and fails with ENXIO if none does.
      await open(pipe, constants.O_WRONLY | constants.O_NONBLOCK).then(
        (h) => h.close(),
        () => undefined,
      );
    }
  });

  test("dates each reason from its lstat, never following a link", async () => {
    const failed = join(dir, "failed");
    await mkdir(failed);
    await writeFile(join(failed, "a.3mf"), "x");
    const reason = join(failed, "a.3mf.reason.txt");
    await writeFile(reason, "A.");
    await utimes(reason, new Date(4_000_000), new Date(4_000_000));
    const { items } = await readInboxFailures(dir, 10);
    expect(items).toMatchObject([{ name: "a.3mf", at: (await lstat(reason)).mtime.toISOString() }]);
    expect(fsSpy.reasonStats).toEqual([]);
  });

  test("answers unreadable when failed is a symlink to a folder", async () => {
    const elsewhere = join(dir, "elsewhere");
    await mkdir(elsewhere);
    await writeFile(join(elsewhere, "a.3mf"), "x");
    await writeFile(join(elsewhere, "a.3mf.reason.txt"), "From elsewhere.");
    await symlink(elsewhere, join(dir, "failed"));
    expect(await readInboxFailures(dir, 10)).toEqual({ readable: false, items: [] });
  });

  test("answers unreadable when failed is swapped for a symlink while it is read", async () => {
    const failed = join(dir, "failed");
    await mkdir(failed);
    await writeFile(join(failed, "a.3mf"), "x");
    await writeFile(join(failed, "a.3mf.reason.txt"), "A.");
    fsSpy.beforeReasonOpen = async () => {
      fsSpy.beforeReasonOpen = undefined;
      await rename(failed, join(dir, "moved"));
      await symlink(join(dir, "moved"), failed);
    };
    expect(await readInboxFailures(dir, 10)).toEqual({ readable: false, items: [] });
  });

  // Some filesystems (NFS, XFS without ftype, some FUSE) do not say what
  // type an entry is, and a typed listing then stats every entry, on Node's
  // main thread for opendir. failed/ is listed by name only, and only a
  // reason file's name is ever stat'ed.
  test("lists failed by name only and lstats nothing but reason files", async () => {
    const failed = join(dir, "failed");
    await mkdir(failed);
    await writeFile(join(failed, "a.3mf"), "x");
    await writeFile(join(failed, "a.3mf.reason.txt"), "A.");
    await mkdir(join(failed, "folder.3mf"));
    await writeFile(join(failed, "folder.3mf.reason.txt"), "Folder.");
    await writeFile(join(failed, "plain.stl"), "x");
    const { items } = await readInboxFailures(dir, 10);
    expect(items).toHaveLength(2);
    expect(fsSpy.typedListings).toBe(0);
    expect(fsSpy.failedLstats.sort()).toEqual(["a.3mf.reason.txt", "folder.3mf.reason.txt"]);
  });

  // 12,000 entries, 6,000 reason files each beside its file. Only the first
  // 10,000 names listed are looked at, and each of the 2,000 left out takes
  // at most one reason file with it (itself, or the file it belongs to), so
  // at most 5,000 are stat'ed; with no cut it would be all 6,000.
  test("looks at no more than 10,000 names of failed", { timeout: 60_000 }, async () => {
    const failed = join(dir, "failed");
    await mkdir(failed);
    const names = Array.from({ length: 6_000 }, (_, i) => `n${i}.stl`).flatMap((n) => [
      n,
      `${n}.reason.txt`,
    ]);
    for (let i = 0; i < names.length; i += 500) {
      await Promise.all(names.slice(i, i + 500).map((n) => writeFile(join(failed, n), "x")));
    }
    const { readable, items } = await readInboxFailures(dir, 10);
    expect(readable).toBe(true);
    expect(items).toHaveLength(10);
    expect(fsSpy.failedLstats.length).toBeGreaterThan(0);
    expect(fsSpy.failedLstats.length).toBeLessThanOrEqual(5_000);
    for (const name of fsSpy.failedLstats) expect(name.endsWith(".reason.txt")).toBe(true);
  });

  test("says the folder could not be read when failed is not a folder", async () => {
    await writeFile(join(dir, "failed"), "not a folder");
    expect(await readInboxFailures(dir, 10)).toEqual({ readable: false, items: [] });
  });

  test("is unreadable, not empty, when no inbox folder is set up", async () => {
    expect(await readInboxFailures(undefined, 10)).toEqual({ readable: false, items: [] });
  });
});

describe("a failed render on the Activity page", () => {
  const MODEL_ID = "01900000-0000-7000-8000-000000000101";
  const FILE_ID = "01900000-0000-7000-8000-000000000102";
  const FAILED_AT = new Date("2026-11-19T10:00:00Z");

  /**
   * A long OpenSCAD run as the slicer stores it: the last lines of its
   * output (the slicer keeps at most 20 lines and 2000 characters), its
   * ERROR line last, after the sentence derived.ts puts in front when the
   * file still shows an earlier version's renders. Cleaned, it is longer
   * than SCRUB_MAX_CHARS, so cutting it to its start loses the ERROR line.
   */
  const ECHO_LINES = Array.from(
    { length: 19 },
    (_, i) =>
      `ECHO: "part ${i + 1} placed from /tmp/render-a7/lib/parts.scad at offset ${i * 40}, width 40, depth 25 mm"`,
  );
  const ERROR_LINE =
    "ERROR: Assertion failed: gap must be positive in file /tmp/render-a7/input.scad, line 41";
  const ERROR_SHOWN = "ERROR: Assertion failed: gap must be positive in file [path], line 41";
  const OUTPUT = [...ECHO_LINES, ERROR_LINE].join("\n");
  const MESSAGE = `${PREVIOUS_RENDERS_SENTENCE.scad} OpenSCAD said: ${OUTPUT}`;
  const HIDDEN = ["/tmp/", "render-a7", "input.scad", "parts.scad"];

  /** The settings row and the failed files (one .scad by default); every other read answers no rows. */
  function scriptedDb(
    failed: Array<{ kind: string; message: string }> = [{ kind: "scad", message: MESSAGE }],
    previews: Array<{ kind: string; message: string }> = [],
  ): Kysely<DB> {
    const connection: DatabaseConnection = {
      async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
        let rows: unknown[] = [];
        if (/\bfrom "settings"/.test(query.sql)) {
          rows = [
            {
              printer_id: "P1S",
              last_orca_version: null,
              bucket_versioning: "unknown",
              updated_at: FAILED_AT,
            },
          ];
        } else if (/"f"\."preview_status"/.test(query.sql)) {
          // The pictures that failed, from their own column (issue #380).
          rows = previews.map((f) => ({
            file_id: FILE_ID,
            file_name: "bracket",
            kind: f.kind,
            model_id: MODEL_ID,
            model_name: "Bracket",
            message: f.message,
            at: FAILED_AT,
          }));
        } else if (/"f"\."derived_status"/.test(query.sql)) {
          rows = failed.map((f) => ({
            file_id: FILE_ID,
            file_name: "bracket",
            kind: f.kind,
            model_id: MODEL_ID,
            model_name: "Bracket",
            message: f.message,
            at: FAILED_AT,
          }));
        }
        return { rows } as QueryResult<R>;
      },
      streamQuery(): never {
        throw new Error("streamQuery is not scripted");
      },
    };
    const driver: Driver = {
      async init() {},
      async acquireConnection() {
        return connection;
      },
      async beginTransaction() {},
      async commitTransaction() {},
      async rollbackTransaction() {},
      async releaseConnection() {},
      async destroy() {},
    };
    return new Kysely<DB>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => driver,
        createIntrospector: (db) => new PostgresIntrospector(db),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
      plugins: [new CamelCasePlugin()],
    });
  }

  async function renderEvents(
    failed?: Array<{ kind: string; message: string }>,
    previews?: Array<{ kind: string; message: string }>,
  ) {
    const view = await createAppActivity({
      db: scriptedDb(failed, previews),
      boss: { getSchedules: async () => [] },
      slicer: {
        health: async () => {
          throw new Error("no slicer in this test");
        },
      },
      now: () => new Date("2026-11-19T12:00:00Z"),
    }).read();
    return view.events.items.filter((e) => e.type === "render_failed");
  }

  test("is long enough that cutting it to its start would lose the ERROR line", () => {
    expect(OUTPUT.length).toBeLessThanOrEqual(2000);
    expect(MESSAGE.replaceAll("/tmp/render-a7/lib/parts.scad", "[path]").length).toBeGreaterThan(
      SCRUB_MAX_CHARS,
    );
  });

  test("shows a long OpenSCAD message whole, its ERROR line last, with no path", async () => {
    const events = await renderEvents();
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event).toMatchObject({ kind: "scad", file: { id: FILE_ID }, model: { id: MODEL_ID } });
    const message = event?.type === "render_failed" ? event.message : undefined;
    expect(message?.startsWith(`${PREVIOUS_RENDERS_SENTENCE.scad} OpenSCAD said: `)).toBe(true);
    expect(message?.endsWith(ERROR_SHOWN)).toBe(true);
    expect(message).not.toContain("...");
    for (const hidden of HIDDEN) expect(JSON.stringify(event)).not.toContain(hidden);
  });

  // Issue #316: a failed preview picture is listed as one, for an STL and
  // for a STEP file whose mesh was made; a STEP conversion that failed is
  // still a conversion.
  // Issue #380: a picture's failure is read from its own column, whatever its
  // message says, so a slicer failure on a STEP file's picture is a preview
  // failure too, not a conversion failure.
  test("lists a failed STL or STEP picture as a preview, and a failed conversion as a conversion", async () => {
    const said = `${DERIVED_MESSAGES.previewRejected} ERROR: STL import failed`;
    const events = await renderEvents(
      [{ kind: "step", message: "STEP import failed: no shapes found" }],
      [
        { kind: "stl", message: said },
        { kind: "step", message: DERIVED_MESSAGES.slicerError },
      ],
    );
    expect(
      events.map((e) => (e.type === "render_failed" ? [e.kind, e.message] : null)).sort(),
    ).toEqual(
      [
        ["preview", said],
        ["preview", DERIVED_MESSAGES.slicerError],
        ["step", "STEP import failed: no shapes found"],
      ].sort(),
    );
    const stl = events.find((e) => e.type === "render_failed" && e.message === said);
    expect(stl?.type === "render_failed" ? stl.messageCodes : null).toEqual(["previewRejected"]);
  });

  describe("the inbox's failed folder, read for several polls at once", () => {
    let inbox: string;

    beforeEach(async () => {
      inbox = await mkdtemp(join(tmpdir(), "ph-activity-poll-"));
      await mkdir(join(inbox, "failed"));
      await writeFile(join(inbox, "failed", "broken.stl"), "x");
      fsSpy.allListings = 0;
    });

    afterEach(async () => {
      await rm(inbox, { recursive: true, force: true });
    });

    test("is listed once for polls that arrive together after the cache expired", async () => {
      let nowMs = Date.parse("2026-11-19T12:00:00Z");
      const activity = createAppActivity({
        db: scriptedDb([]),
        boss: { getSchedules: async () => [] },
        slicer: {
          health: async () => {
            throw new Error("no slicer in this test");
          },
        },
        inboxDir: inbox,
        now: () => new Date(nowMs),
      });
      const alone = await activity.read();
      const listingsForOneRead = fsSpy.allListings;
      expect(listingsForOneRead).toBeGreaterThan(0);

      nowMs += 10 * 60 * 1000;
      fsSpy.allListings = 0;
      const together = await Promise.all([activity.read(), activity.read(), activity.read()]);
      expect(fsSpy.allListings).toBe(listingsForOneRead);
      for (const view of together) expect(view.events.items).toEqual(alone.events.items);
    });
  });
});

// The description re-conversion on upgrade (#357) records what it did in
// upgrade_steps; the page shows each run as an event, so the count of
// descriptions changed is on the page and not only in the server log.
describe("reconvertEvents", () => {
  const AT = new Date("2026-11-21T09:30:00Z");

  test("makes one event per finished run, with its converter and counts", () => {
    expect(
      reconvertEvents([
        {
          name: "reconvert-descriptions-3",
          finishedAt: AT,
          result: { checked: 120, changed: 66, unchanged: 40, kept: 12, unreadable: 2 },
        },
      ]),
    ).toEqual([
      {
        type: "descriptions_reconverted",
        at: AT.toISOString(),
        converter: 3,
        checked: 120,
        changed: 66,
        unchanged: 40,
        kept: 12,
        unreadable: 2,
      },
    ] satisfies ActivityEvent[]);
  });

  test("reads a count that is missing or not a whole number as 0", () => {
    const [event] = reconvertEvents([
      {
        name: "reconvert-descriptions-4",
        finishedAt: AT,
        result: { checked: 3, changed: "7", kept: -1 },
      },
    ]);
    expect(event).toMatchObject({ converter: 4, checked: 3, changed: 0, kept: 0, unreadable: 0 });
  });

  // A new install, or a library with no description to convert, records the
  // step with nothing checked; the page shows no upgrade that never happened.
  test("leaves out a run that checked no description", () => {
    expect(
      reconvertEvents([
        {
          name: "reconvert-descriptions-3",
          finishedAt: AT,
          result: { checked: 0, changed: 0, unchanged: 0, kept: 0, unreadable: 0 },
        },
        { name: "reconvert-descriptions-4", finishedAt: AT, result: {} },
      ]),
    ).toEqual([]);
  });

  test("leaves out a step of any other name", () => {
    expect(
      reconvertEvents([
        { name: "another-step", finishedAt: AT, result: {} },
        { name: "reconvert-descriptions-x", finishedAt: AT, result: {} },
      ]),
    ).toEqual([]);
  });
});

describe("a description re-conversion on the Activity page", () => {
  const FINISHED_AT = new Date("2026-11-21T09:30:00Z");

  /** The settings row and one finished re-conversion; every other read answers no rows. */
  function scriptedDb(): Kysely<DB> {
    const connection: DatabaseConnection = {
      async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
        let rows: unknown[] = [];
        if (/\bfrom "settings"/.test(query.sql)) {
          rows = [
            {
              printer_id: "P1S",
              last_orca_version: null,
              bucket_versioning: "unknown",
              updated_at: FINISHED_AT,
            },
          ];
        } else if (/\bfrom "upgrade_steps"/.test(query.sql)) {
          rows = [
            {
              name: "reconvert-descriptions-3",
              finished_at: FINISHED_AT,
              result: { checked: 5, changed: 2, unchanged: 1, kept: 1, unreadable: 1 },
            },
          ];
        }
        return { rows } as QueryResult<R>;
      },
      streamQuery(): never {
        throw new Error("streamQuery is not scripted");
      },
    };
    const driver: Driver = {
      async init() {},
      async acquireConnection() {
        return connection;
      },
      async beginTransaction() {},
      async commitTransaction() {},
      async rollbackTransaction() {},
      async releaseConnection() {},
      async destroy() {},
    };
    return new Kysely<DB>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => driver,
        createIntrospector: (db) => new PostgresIntrospector(db),
        createQueryCompiler: () => new PostgresQueryCompiler(),
      },
      plugins: [new CamelCasePlugin()],
    });
  }

  test("lists the re-conversion's schedule, which pg-boss holds on the upgrade queue", async () => {
    const asked: string[] = [];
    const view = await createAppActivity({
      db: scriptedDb(),
      boss: {
        getSchedules: async (queue?: string) => {
          asked.push(String(queue));
          const reconvert = {
            name: QUEUE.upgrade,
            key: UPGRADE_TASKS.reconvertDescriptions,
            cron: "*/5 * * * *",
            timezone: "UTC",
          } as Schedule;
          return queue === QUEUE.upgrade ? [reconvert] : [];
        },
      },
      slicer: {
        health: async () => {
          throw new Error("no slicer in this test");
        },
      },
      now: () => new Date("2026-11-21T12:00:00Z"),
    }).read();
    expect(asked.sort()).toEqual([QUEUE.maintenance, QUEUE.upgrade].sort());
    expect(view.schedules.map((r) => r.key)).toEqual([UPGRADE_TASKS.reconvertDescriptions]);
    expect(view.schedules[0]).toMatchObject({
      label: "MakerWorld descriptions and licences (until they finish)",
    });
  });

  test("is an event with the number of descriptions it changed", async () => {
    const view = await createAppActivity({
      db: scriptedDb(),
      boss: { getSchedules: async () => [] },
      slicer: {
        health: async () => {
          throw new Error("no slicer in this test");
        },
      },
      now: () => new Date("2026-11-21T12:00:00Z"),
    }).read();
    expect(view.events.items.filter((e) => e.type === "descriptions_reconverted")).toEqual([
      {
        type: "descriptions_reconverted",
        at: FINISHED_AT.toISOString(),
        converter: 3,
        checked: 5,
        changed: 2,
        unchanged: 1,
        kept: 1,
        unreadable: 1,
      },
    ]);
  });

  describe("the slicer's sandbox on the Activity page", () => {
    type Sandbox = Health["sandbox"];

    async function slicerBlock(health: Health | null) {
      const view = await createAppActivity({
        db: scriptedDb(),
        boss: { getSchedules: async () => [] },
        slicer: {
          health: async () => {
            if (health === null) throw new Error("no slicer in this test");
            return health;
          },
        },
        now: () => new Date("2026-11-21T12:00:00Z"),
      }).read();
      return view.slicer;
    }

    function healthWith(sandbox: Sandbox): Health {
      return {
        contract: 2,
        orca: "2.5.0",
        openscad: "2026.10.01",
        busy: false,
        sandbox,
        timeouts: { sliceSeconds: 600, scadSeconds: 60, stepSeconds: 60, uploadSeconds: 300 },
      };
    }

    test("is on", async () => {
      const slicer = await slicerBlock(
        healthWith({ state: "on", reason: null, detail: null, allowUnsandboxed: false }),
      );
      expect(slicer).toMatchObject({ sandbox: "on", sandboxReason: null, unsandboxed: false });
    });

    test("is being checked", async () => {
      const slicer = await slicerBlock(
        healthWith({ state: "checking", reason: null, detail: null, allowUnsandboxed: true }),
      );
      expect(slicer).toMatchObject({
        sandbox: "checking",
        sandboxReason: null,
        unsandboxed: false,
      });
    });

    test("is off with an old kernel, and not allowed to run without it", async () => {
      const slicer = await slicerBlock(
        healthWith({ state: "off", reason: "old_kernel", detail: "x", allowUnsandboxed: false }),
      );
      expect(slicer).toMatchObject({
        sandbox: "off",
        sandboxReason: "old_kernel",
        unsandboxed: false,
      });
    });

    test("is off with a failed check, and allowed to run without it", async () => {
      const slicer = await slicerBlock(
        healthWith({ state: "off", reason: "check_failed", detail: "x", allowUnsandboxed: true }),
      );
      expect(slicer).toMatchObject({
        sandbox: "off",
        sandboxReason: "check_failed",
        unsandboxed: true,
      });
    });

    test("never carries the slicer's own detail", async () => {
      const slicer = await slicerBlock(
        healthWith({
          state: "off",
          reason: "check_failed",
          detail: "SECRET-DETAIL",
          allowUnsandboxed: true,
        }),
      );
      expect(JSON.stringify(slicer)).not.toContain("SECRET-DETAIL");
    });

    test("is null throughout when the slicer does not answer", async () => {
      const slicer = await slicerBlock(null);
      expect(slicer).toMatchObject({
        reachable: false,
        sandbox: null,
        sandboxReason: null,
        unsandboxed: null,
      });
    });
  });
});
