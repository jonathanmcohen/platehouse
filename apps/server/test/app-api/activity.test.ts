// The Activity page's app API, the parts that need no database (2026-11-19,
// Jon: one page that shows what Platehouse is doing and holds, so he never
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
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
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
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  type ActivityEvent,
  createAppActivity,
  EVENT_LIMIT,
  mergeEvents,
  progressOf,
  queueRows,
  readInboxFailures,
  scheduleText,
} from "../../src/app-api/activity.js";
import type { DB } from "../../src/db/types.js";
import { PREVIOUS_RENDERS_SENTENCE } from "../../src/derived/client.js";
import { SCRUB_MAX_CHARS } from "../../src/scrub.js";

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
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("is empty when there is no failed folder", async () => {
    expect(await readInboxFailures(dir, 10)).toEqual({ readable: true, items: [] });
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
    // A reason file with no file beside it still counts: the reason is the record.
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

  test("keeps only the newest limit", async () => {
    const failed = join(dir, "failed");
    await mkdir(failed);
    for (let i = 0; i < 5; i++) {
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

  /** The settings row and one failed .scad file; every other read answers no rows. */
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
              updated_at: FAILED_AT,
            },
          ];
        } else if (/"f"\."derived_status"/.test(query.sql)) {
          rows = [
            {
              file_id: FILE_ID,
              file_name: "bracket",
              kind: "scad",
              model_id: MODEL_ID,
              model_name: "Bracket",
              message: MESSAGE,
              at: FAILED_AT,
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

  async function renderEvents() {
    const view = await createAppActivity({
      db: scriptedDb(),
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
});
