// The app API behind the settings, trash and organising
// pages: the bucket versioning warning, the printer menu, rename, tags, flat
// collections, the trash, and per-client API tokens. Every route is under /app/api and session-class: it needs a
// live session, and every state-changing one needs Origin to be
// PUBLIC_ORIGIN (the route-class gate), so the token routes here are for the web UI
// and separate from the bearer API.
//
// Everything is real but the login: a migrated Postgres 17 and a bucket on
// the S3 test server made without versioning, pg-boss with the ingest and
// slicer queues, estimates against the contract-faithful slicer
// stub, tokens in api_tokens, and the trash. The request
// log is captured from buildApp's logger stream, and the last test reads it:
// no token this file made appears in any line, with or without its prefix.
// Sessions are in the sessions table too, read through the login tests'
// support: a token is made in one transaction with a locked read of its
// maker's session row (issue #414). Every file is generated.
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createTokens,
  dbTokenStore,
  TOKEN_PATTERN,
  TOKEN_PREFIX,
  type Tokens,
} from "../../../src/api/tokens.js";
import { createApiLibrary } from "../../../src/api/v1.js";
import { buildApp } from "../../../src/app.js";
import { readDisplayContext } from "../../../src/app-api/library.js";
import { recordVersioning } from "../../../src/app-api/settings.js";
import {
  dbTokenList,
  type ListedToken,
  TOKEN_SIGN_IN_WINDOW_MS,
} from "../../../src/app-api/tokens.js";
import { patternClass } from "../../../src/auth/gate.js";
import { dbSessionStore, SESSION_COOKIE } from "../../../src/auth/sessions.js";
import { uuidv7 } from "../../../src/db/ids.js";
import { createSlicerClient } from "../../../src/estimates/client.js";
import { plateNumbersMany } from "../../../src/estimates/display.js";
import { FALLBACK_SLICES_PER_MINUTE, MIN_FINISHES_FOR_RATE } from "../../../src/estimates/rate.js";
import { createEstimates, type Estimates } from "../../../src/estimates/service.js";
import type { IngestInput, IngestResult } from "../../../src/ingest/ingest.js";
import { createBoss } from "../../../src/jobs/boss.js";
import {
  MAINTENANCE_TASKS,
  ON_DEMAND_TASKS,
  QUEUE,
  startQueues,
} from "../../../src/jobs/queues.js";
import { createTrash, type PurgeStore } from "../../../src/library/trash.js";
import { StoreUnavailable } from "../../../src/storage/s3.js";
import { createUploads } from "../../../src/uploads/tus.js";
import { NOT_BUILT } from "../../../src/web/shell.js";
import { type SlicerStub, STUB_PRINTERS, startSlicerStub } from "../../support/slicer-stub.js";
import { build3mf, type IngestEnv, startIngestEnv, writeUpload } from "../support/ingest.js";
import { labelStored, marker, rowCounts, seedStoredModel } from "../support/library.js";
import {
  concretePath,
  registeredRoutes,
  TEST_ORIGIN,
  type TestAuth,
  testAuth,
} from "../support/oidc-issuer.js";

const P1S = "Bambu Lab P1S 0.4 nozzle";
const X1C = "Bambu Lab X1 Carbon 0.4 nozzle";
const DAY_MS = 86_400_000;

let env: IngestEnv;
let stub: SlicerStub;
let boss: PgBoss;
let estimates: Estimates;
let tokens: Tokens;
let auth: TestAuth;
let app: FastifyInstance;
let session: string;
/**
 * The store the app's trash deletes through: the test bucket, unless a test
 * swaps in one that fails, and puts the bucket back when it is done.
 */
let purgeStore: PurgeStore;
/**
 * The token list the app's token routes read: the api_tokens table, unless a
 * test swaps in one that fails, and puts the table back when it is done.
 */
let tokenList: () => Promise<ListedToken[]>;
/** Every line the app logged. */
const lines: string[] = [];
/** Every token this file was given, for the log check. */
const madeTokens: string[] = [];

interface Answer {
  status: number;
  headers: Record<string, unknown>;
  text: string;
  json(): unknown;
}

/** One request to the app with a signed-in session and a same-origin Origin, unless told otherwise. */
async function call(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  opts: { json?: unknown; origin?: string | false; cookie?: string | false } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { accept: "application/json" };
  const origin = opts.origin ?? TEST_ORIGIN;
  if (origin !== false) headers.origin = origin;
  let payload: string | undefined;
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(opts.json);
  }
  const cookie = opts.cookie ?? session;
  const res = await app.inject({
    method,
    url,
    headers,
    ...(cookie === false ? {} : { cookies: { [SESSION_COOKIE]: cookie } }),
    ...(payload === undefined ? {} : { payload }),
  });
  return {
    status: res.statusCode,
    headers: res.headers,
    text: res.body,
    json: () => JSON.parse(res.body),
  };
}

/** GET /api/v1/models with this bearer credential: 200 while it is a live token. */
async function v1Status(auth: string): Promise<number> {
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/models",
    headers: { authorization: `Bearer ${auth}` },
  });
  return res.statusCode;
}

async function until<T>(read: () => Promise<T> | T, done: (v: T) => boolean, ms = 45_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error(`timed out; last value ${JSON.stringify(value)}`);
    await sleep(100);
  }
}

async function inFlight(): Promise<number> {
  const { rows } = await sql<{ n: number }>`
    select count(*)::int as n from estimates where status in ('pending', 'running')
  `.execute(env.db);
  return rows[0]?.n ?? -1;
}

async function drain(): Promise<void> {
  await until(inFlight, (n) => n === 0);
  await sleep(300);
  await until(inFlight, (n) => n === 0);
}

/** The printers version GET /app/api/settings answers, as a page reads it. */
async function version(): Promise<number> {
  const res = await call("GET", "/app/api/settings");
  expect(res.status, res.text).toBe(200);
  const answer = res.json() as { printersVersion?: unknown };
  expect(Number.isInteger(answer.printersVersion)).toBe(true);
  return answer.printersVersion as number;
}

/** Uploads a synthetic one-plate .3mf through the ingest queue; returns its plate's id. */
async function uploadPlate(): Promise<string> {
  const tmpPath = await writeUpload(env, build3mf({ plates: 1 }));
  const input: IngestInput = { tmpPath, originalName: "Synthetic.3mf", target: "new" };
  const id = await boss.send(QUEUE.ingest, input);
  if (id === null) throw new Error("ingest job not created");
  const job = await until(
    () => boss.getJobById<IngestInput>(QUEUE.ingest, id),
    (j) => j?.state === "completed" || j?.state === "failed",
  );
  if (job?.state !== "completed") throw new Error(`ingest failed: ${JSON.stringify(job?.output)}`);
  const result = job.output as IngestResult;
  const plates = await env.repos.plates.listForFile(result.fileId);
  const plate = plates[0];
  if (plate === undefined) throw new Error("no plate");
  return plate.id;
}

/** Makes a token through the settings route and remembers it for the log check. */
async function makeToken(name: string) {
  const res = await call("POST", "/app/api/tokens", { json: { name } });
  expect(res.status, res.text).toBe(201);
  const created = res.json() as {
    id: string;
    name: string;
    prefix: string;
    token: string;
    createdAt: string;
  };
  madeTokens.push(created.token);
  return { res, created };
}

beforeAll(async () => {
  env = await startIngestEnv();
  stub = await startSlicerStub();
  boss = createBoss({ databaseUrl: env.url });
  await boss.start();
  estimates = createEstimates({
    db: env.db,
    boss,
    slicer: createSlicerClient({ url: stub.url, plateSeconds: 5 }),
    store: env.store,
    jobOptions: { retryDelay: 1, retryDelayMax: 1 },
    slicerDown: { waitMs: 2_000, pollMs: 100, requeues: 3 },
    log: () => {},
  });
  purgeStore = env.store;
  // One trash for the app's routes and the maintenance queue's Empty trash job.
  const trash = createTrash({
    db: env.db,
    store: {
      listPrefix: (p) => purgeStore.listPrefix(p),
      deleteBlobs: (keys) => purgeStore.deleteBlobs(keys),
    },
  });
  await startQueues(boss, {
    ingestFile: (input) => env.ingest.ingestFile(input),
    purgeExpired: async () => ({ purged: [] }),
    sweepOrphans: async () => ({ listed: 0, deleted: 0, outsideLayout: 0 }),
    sweepUploads: async () => undefined,
    slicerJobs: estimates.slicerJobs,
    pollOrca: () => estimates.pollOrca(),
    onIngested: (result) => estimates.enqueueFile(result.fileId),
    emptyTrash: (signal) => trash.purgeMarked(signal),
    pollingIntervalSeconds: 0.5,
  });
  tokens = createTokens({ store: dbTokenStore(env.db) });
  tokenList = dbTokenList(env.db);
  auth = await testAuth({ store: dbSessionStore(env.db) });
  app = await buildApp({
    health: { database: async () => 1, queuesRunning: () => true },
    uploads: createUploads({
      tmpDir: env.dir,
      queue: { enqueue: async () => {}, result: async () => undefined },
      log: () => {},
    }),
    auth: auth.auth,
    api: {
      tokens,
      library: createApiLibrary({
        db: env.db,
        store: env.store,
        displayContext: () =>
          readDisplayContext({
            settings: () => env.repos.settings.get(),
            listPrinters: () => estimates.listPrinters(),
          }),
        plateNumbersMany: (ctx, ids) => plateNumbersMany(env.db, ctx, ids),
      }),
    },
    appApi: {
      settings: { settings: env.repos.settings, estimates },
      // The sign-in window is measured on the sessions' clock (issue #377).
      tokens: { tokens, list: () => tokenList(), now: () => auth.clock.now },
      organise: { db: env.db, trash, boss },
    },
    logger: { write: (line: string) => lines.push(line) },
    // A web folder that is never built, so a shell page answers NOT_BUILT
    // whatever is in apps/web/dist on the machine running this.
    web: { dir: join(env.dir, "no-web-build") },
  });
  await app.ready();
  session = (await auth.sessions.start("someone")).id;
});

afterAll(async () => {
  await app?.close();
  await auth?.issuer.stop();
  // Graceful, so a poll in flight ends before pg-boss closes (issue #490).
  await boss?.stop({ graceful: true, timeout: 20_000 });
  await stub?.stop();
  await env?.stop();
});

describe("the settings page", () => {
  beforeEach(async () => {
    stub.onSlice(() => ({ kind: "ok" }));
    await drain();
    const settings = await env.repos.settings.get();
    if (settings.printerId !== P1S || settings.myPrinters.join("|") !== P1S) {
      await estimates.setPrinter(P1S);
      await drain();
    }
  });

  test("versioning off shows the warning", async () => {
    // The bucket was made without versioning: the startup read records off,
    // and the settings answer says so, which is what the page warns on.
    expect(await recordVersioning({ store: env.store, settings: env.repos.settings })).toBe("off");
    const res = await call("GET", "/app/api/settings");
    expect(res.status, res.text).toBe(200);
    expect(res.json()).toMatchObject({ bucketVersioning: "off" });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("a store that cannot be reached at startup keeps the last state it reported", async () => {
    await recordVersioning({ store: env.store, settings: env.repos.settings });
    const logged: string[] = [];
    const down = {
      readVersioning: () => Promise.reject(new StoreUnavailable("GetBucketVersioning", "refused")),
    };
    expect(
      await recordVersioning({
        store: down,
        settings: env.repos.settings,
        log: (l) => logged.push(l),
      }),
    ).toBeUndefined();
    expect((await env.repos.settings.get()).bucketVersioning).toBe("off");
    expect(logged.join("\n")).toMatch(/versioning/i);
    const enabled = { readVersioning: async () => "enabled" as const };
    expect(await recordVersioning({ store: enabled, settings: env.repos.settings })).toBe(
      "enabled",
    );
    expect((await call("GET", "/app/api/settings")).json()).toMatchObject({
      bucketVersioning: "enabled",
    });
    await recordVersioning({ store: env.store, settings: env.repos.settings });
  });

  test("the printer menu is the slicer's printers, grouped by model, each named in full", async () => {
    const res = await call("GET", "/app/api/settings");
    expect(res.status, res.text).toBe(200);
    const body = res.json() as { printerId: string; printers: unknown };
    expect(body.printerId).toBe(P1S);
    const models = [...new Set(STUB_PRINTERS.map((p) => p.model))];
    expect(body.printers).toEqual(
      models.map((model) => ({
        model,
        printers: STUB_PRINTERS.filter((p) => p.model === model).map((p) => ({
          id: p.id,
          nozzle: p.nozzle,
          name: `${p.model}, ${p.nozzle} mm nozzle`,
        })),
      })),
    );
  });

  test("My printers are listed in order with their full names, the default and their waiting work", async () => {
    const res = await call("GET", "/app/api/settings");
    expect(res.json()).toMatchObject({
      printerId: P1S,
      myPrinters: [
        {
          id: P1S,
          name: "Bambu Lab P1S, 0.4 mm nozzle",
          offered: true,
          waiting: 0,
          through: 0,
        },
      ],
      // No slice has finished yet in this file, so the rate is the fallback.
      slicesPerMinute: FALLBACK_SLICES_PER_MINUTE,
    });
    expect(FALLBACK_SLICES_PER_MINUTE).toBe(6);
  });

  describe("the slicer's rate, measured from each slice's own working time (issues #317, #375)", () => {
    /**
     * Gives every successful Platehouse slice, oldest first, a working time of
     * sliceMs, with idleMs between one's finish and the next one's start
     * (idleAfter adds a longer idle stretch after the slice at that index);
     * the newest finishes a minute ago.
     */
    async function timeSlices(
      sliceMs: number,
      idleMs = 0,
      idleAfter?: { index: number; ms: number },
    ) {
      const rows = await env.db
        .selectFrom("estimates")
        .select("id")
        .where("source", "=", "platehouse")
        .where("status", "=", "ok")
        .orderBy("id")
        .execute();
      let at = Date.now() - 60_000 - rows.length * (sliceMs + idleMs) - (idleAfter?.ms ?? 0);
      for (const [i, row] of rows.entries()) {
        const startedAt = new Date(at);
        at += sliceMs;
        await env.db
          .updateTable("estimates")
          .set({ startedAt, finishedAt: new Date(at) })
          .where("id", "=", row.id)
          .execute();
        at += idleMs;
        if (idleAfter !== undefined && i === idleAfter.index) at += idleAfter.ms;
      }
      return rows.length;
    }

    async function slicesPerMinute(): Promise<unknown> {
      const res = await call("GET", "/app/api/settings");
      expect(res.status, res.text).toBe(200);
      return (res.json() as { slicesPerMinute: unknown }).slicesPerMinute;
    }

    test("a slice records when it began work and when it finished", async () => {
      const before = new Date(Date.now() - 1_000);
      await upload12();
      const rows = await env.db
        .selectFrom("estimates")
        .select(["startedAt", "finishedAt", "createdAt"])
        .where("source", "=", "platehouse")
        .where("status", "=", "ok")
        .where("finishedAt", ">=", before)
        .execute();
      expect(rows.length).toBeGreaterThanOrEqual(12);
      for (const row of rows) {
        expect(row.startedAt).toBeInstanceOf(Date);
        const started = row.startedAt?.getTime() ?? Number.NaN;
        expect(started).toBeGreaterThanOrEqual(row.createdAt.getTime());
        expect(started).toBeLessThanOrEqual(row.finishedAt?.getTime() ?? Number.NaN);
      }
    });

    test("with fewer timed slices than it needs, the page gets the fallback rate", async () => {
      // Slices finished before migration 0011 have no start time.
      await sql`update estimates set started_at = null where source = 'platehouse'`.execute(env.db);
      expect(await slicesPerMinute()).toBe(FALLBACK_SLICES_PER_MINUTE);
    });

    test("slices of 6.5 seconds read as about 9.2 plates a minute, not the fallback", async () => {
      await upload12();
      expect(await timeSlices(6_500)).toBeGreaterThanOrEqual(MIN_FINISHES_FOR_RATE);
      expect(await slicesPerMinute()).toBe(9.2);
    });

    test("an idle hour between two runs does not slow the rate", async () => {
      await upload12();
      await timeSlices(6_500, 0, { index: 5, ms: 3_600_000 });
      expect(await slicesPerMinute()).toBe(9.2);
    });

    test("slices 2 minutes apart, the idle time between them left out, still read 9.2", async () => {
      await upload12();
      await timeSlices(6_500, 2 * 60_000 - 6_500);
      expect(await slicesPerMinute()).toBe(9.2);
    });

    test("slices an hour apart give the slicer's own speed, not the fallback", async () => {
      await upload12();
      await timeSlices(6_500, 3_600_000);
      expect(await slicesPerMinute()).toBe(9.2);
    });

    test("slow slices of 6 minutes count", async () => {
      await upload12();
      await timeSlices(6 * 60_000);
      expect(await slicesPerMinute()).toBe(0.17);
    });

    /** Uploads a synthetic twelve-plate .3mf and lets every plate be sliced. */
    async function upload12() {
      const tmpPath = await writeUpload(env, build3mf({ plates: 12 }));
      const input: IngestInput = { tmpPath, originalName: "Twelve.3mf", target: "new" };
      const id = await boss.send(QUEUE.ingest, input);
      if (id === null) throw new Error("ingest job not created");
      await until(
        () => boss.getJobById<IngestInput>(QUEUE.ingest, id),
        (j) => j?.state === "completed" || j?.state === "failed",
      );
      await drain();
    }
  });

  test("adding a printer answers how many plates it will queue, before queueing them", async () => {
    await uploadPlate();
    await drain();
    const pollJobs = async () =>
      (await boss.findJobs(QUEUE.maintenance, { data: { task: MAINTENANCE_TASKS.pollOrca } }))
        .length;
    const pollsBefore = await pollJobs();
    const held = stub.hold();
    try {
      const res = await call("PUT", "/app/api/settings/printers", {
        json: { printers: [P1S, X1C], defaultId: P1S, version: await version() },
      });
      expect(res.status, res.text).toBe(200);
      const answer = res.json() as {
        added: Array<{ printerId: string; queued: number; through: number }>;
        removed: string[];
      };
      expect(answer.removed).toEqual([]);
      expect(answer.added).toHaveLength(1);
      expect(answer.added[0]?.printerId).toBe(X1C);
      const queued = answer.added[0]?.queued ?? 0;
      expect(queued).toBeGreaterThanOrEqual(1);
      // Nothing else was queued, so its plates are through after its own.
      expect(answer.added[0]?.through).toBe(queued);
      // The save sent a poll to queue them (a maintenance worker may have
      // taken it already, so the slicer queue is not asserted empty).
      expect(await pollJobs()).toBeGreaterThan(pollsBefore);
      // Running the poll queues one slice job per plate.
      await estimates.pollOrca();
      // Jobs in any state (a worker may have claimed or finished one, and
      // pg-boss writes a finished job's state late), by estimate: a poll the
      // maintenance worker runs at the same time may send a copy.
      const sliceJobs = await boss.findJobs<{ printerId: string; estimateId: string }>(
        QUEUE.slicer,
        {},
      );
      const forX1C = sliceJobs.filter((j) => j.data.printerId === X1C);
      expect(new Set(forX1C.map((j) => j.data.estimateId)).size).toBe(queued);
      // The settings answer shows that work waiting for the X1C.
      expect((await call("GET", "/app/api/settings")).json()).toMatchObject({
        printerId: P1S,
        myPrinters: [
          { id: P1S, waiting: 0, through: 0 },
          {
            id: X1C,
            name: "Bambu Lab X1 Carbon, 0.4 mm nozzle",
            offered: true,
            waiting: queued,
            through: queued,
          },
        ],
      });
    } finally {
      held.release();
    }
    await drain();
    expect((await call("GET", "/app/api/settings")).json()).toMatchObject({
      myPrinters: [
        { id: P1S, waiting: 0 },
        { id: X1C, waiting: 0 },
      ],
    });
  });

  test("with two printers' work queued, the second printer's time counts the first's plates", async () => {
    const A1 = "Bambu Lab A1 0.4 nozzle";
    await uploadPlate();
    await drain();
    const held = stub.hold();
    const before = stub.calls.length;
    try {
      const res = await call("PUT", "/app/api/settings/printers", {
        json: { printers: [P1S, X1C, A1], defaultId: P1S, version: await version() },
      });
      expect(res.status, res.text).toBe(200);
      const added = (res.json() as { added: Array<{ printerId: string; queued: number }> }).added;
      const forX1C = added.find((a) => a.printerId === X1C)?.queued ?? 0;
      const forA1 = added.find((a) => a.printerId === A1)?.queued ?? 0;
      expect(forX1C).toBeGreaterThanOrEqual(1);
      expect(forA1).toBeGreaterThanOrEqual(1);
      await estimates.pollOrca();
      // Once the first X1C slice is running, the figures are exact.
      await until(
        () => stub.calls.length,
        (n) => n > before,
      );
      await until(
        async () =>
          (
            await env.db
              .selectFrom("estimates")
              .select("id")
              .where("status", "=", "running")
              .execute()
          ).length,
        (n) => n === 1,
      );
      expect((await call("GET", "/app/api/settings")).json()).toMatchObject({
        myPrinters: [
          { id: P1S, waiting: 0, through: 0 },
          { id: X1C, waiting: forX1C, through: forX1C },
          { id: A1, waiting: forA1, through: forX1C + forA1 },
        ],
      });
    } finally {
      held.release();
    }
    await drain();
  });

  test("a new order or a new default is saved and queues nothing; a removal drops its work", async () => {
    await call("PUT", "/app/api/settings/printers", {
      json: { printers: [P1S, X1C], defaultId: P1S, version: await version() },
    });
    await estimates.pollOrca();
    await drain();
    const calls = stub.calls.length;
    const reorder = await call("PUT", "/app/api/settings/printers", {
      json: { printers: [X1C, P1S], defaultId: X1C, version: await version() },
    });
    expect(reorder.status, reorder.text).toBe(200);
    expect(reorder.json()).toEqual({ added: [], removed: [] });
    expect(await env.repos.settings.get()).toMatchObject({
      printerId: X1C,
      myPrinters: [X1C, P1S],
    });
    await sleep(500);
    expect(stub.calls.length).toBe(calls);

    const remove = await call("PUT", "/app/api/settings/printers", {
      json: { printers: [X1C], defaultId: X1C, version: await version() },
    });
    expect(remove.json()).toEqual({ added: [], removed: [P1S] });
    expect((await call("GET", "/app/api/settings")).json()).toMatchObject({
      printerId: X1C,
      myPrinters: [{ id: X1C }],
    });
  });

  test("a list that cannot be saved is refused with a sentence, and My printers stay", async () => {
    const refused: Array<[unknown, string]> = [
      [
        { printers: [P1S, "Bambu Lab Q9 0.4 nozzle"], defaultId: P1S, version: await version() },
        "unknown_printer",
      ],
      [{ printers: [P1S, P1S], defaultId: P1S, version: await version() }, "bad_request"],
      [{ printers: [P1S], defaultId: X1C, version: await version() }, "bad_request"],
      [{ printers: [], defaultId: P1S, version: await version() }, "bad_request"],
      [{ printers: [P1S], version: await version() }, "bad_request"],
      [{ printerId: P1S }, "bad_request"],
      [{ printers: [""], defaultId: "", version: await version() }, "bad_request"],
      // Without the version the page read, nothing says what the page saw.
      [{ printers: [P1S, X1C], defaultId: P1S }, "bad_request"],
      [{ printers: [P1S, X1C], defaultId: P1S, version: 0 }, "bad_request"],
      [{ printers: [P1S, X1C], defaultId: P1S, version: "one" }, "bad_request"],
    ];
    for (const [body, error] of refused) {
      const res = await call("PUT", "/app/api/settings/printers", { json: body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      const answer = res.json() as { error: string; message?: string };
      expect(answer.error, JSON.stringify(body)).toBe(error);
      expect(typeof answer.message, JSON.stringify(body)).toBe("string");
    }
    expect(await env.repos.settings.get()).toMatchObject({ printerId: P1S, myPrinters: [P1S] });
  });

  test("a list saved from an old read is refused with 409, and the printer added meanwhile stays", async () => {
    await uploadPlate();
    await drain();
    const held = stub.hold();
    try {
      // Window A reads the settings.
      const readByA = await version();
      // Window B adds the X1C; its plates are queued.
      const added = await call("PUT", "/app/api/settings/printers", {
        json: { printers: [P1S, X1C], defaultId: P1S, version: await version() },
      });
      expect(added.status, added.text).toBe(200);
      const queued = (added.json() as { added: Array<{ queued: number }> }).added[0]?.queued ?? 0;
      expect(queued).toBeGreaterThanOrEqual(1);
      // The poll the save sent queues its plates (run here, as in the other tests).
      await estimates.pollOrca();
      // Window A, still showing [P1S], saves [P1S]: refused, nothing dropped.
      const stale = await call("PUT", "/app/api/settings/printers", {
        json: { printers: [P1S], defaultId: P1S, version: readByA },
      });
      expect(stale.status, stale.text).toBe(409);
      const answer = stale.json() as { error: string; message?: string };
      expect(answer.error).toBe("printers_changed");
      expect(answer.message).toMatch(/changed/i);
      expect((await call("GET", "/app/api/settings")).json()).toMatchObject({
        myPrinters: [
          { id: P1S, waiting: 0 },
          { id: X1C, waiting: queued },
        ],
      });
    } finally {
      held.release();
    }
    await drain();
  });

  // Issue #272: one version covers the list and the default, so a page
  // that read before either changed cannot undo it, whatever it saves.
  test("after another window changes the default, an add or a move from the old read is refused", async () => {
    await call("PUT", "/app/api/settings/printers", {
      json: { printers: [P1S, X1C], defaultId: P1S, version: await version() },
    });
    await estimates.pollOrca();
    await drain();
    const A1 = "Bambu Lab A1 0.4 nozzle";
    const readByA = await version();
    // Window B makes the X1C the default; the list is the same.
    const madeDefault = await call("PUT", "/app/api/settings/printers", {
      json: { printers: [P1S, X1C], defaultId: X1C, version: readByA },
    });
    expect(madeDefault.status, madeDefault.text).toBe(200);
    const calls = stub.calls.length;
    // Window A, still showing P1S as the default, adds the A1, then moves the X1C up.
    for (const body of [
      { printers: [P1S, X1C, A1], defaultId: P1S, version: readByA },
      { printers: [X1C, P1S], defaultId: P1S, version: readByA },
    ]) {
      const res = await call("PUT", "/app/api/settings/printers", { json: body });
      expect(res.status, JSON.stringify(body)).toBe(409);
      expect((res.json() as { error: string }).error).toBe("printers_changed");
    }
    // Nothing changed: the default is still the X1C, no A1, nothing queued.
    expect(await env.repos.settings.get()).toMatchObject({
      printerId: X1C,
      myPrinters: [P1S, X1C],
    });
    await sleep(300);
    expect(stub.calls.length).toBe(calls);
    // A page that reads again saves.
    const fresh = await call("PUT", "/app/api/settings/printers", {
      json: { printers: [X1C, P1S], defaultId: X1C, version: await version() },
    });
    expect(fresh.status, fresh.text).toBe(200);
    expect(await env.repos.settings.get()).toMatchObject({
      printerId: X1C,
      myPrinters: [X1C, P1S],
    });
  });

  test("the settings answer carries the version, and only printer saves move it", async () => {
    const before = await version();
    await recordVersioning({ store: env.store, settings: env.repos.settings });
    expect(await version()).toBe(before);
    const res = await call("PUT", "/app/api/settings/printers", {
      json: { printers: [P1S], defaultId: P1S, version: before },
    });
    expect(res.status, res.text).toBe(200);
    expect(await version()).toBe(before + 1);
  });

  test("the old one-printer route is gone", async () => {
    const res = await call("PUT", "/app/api/settings/printer", { json: { printerId: X1C } });
    expect(res.status).toBe(404);
    expect((await env.repos.settings.get()).printerId).toBe(P1S);
  });
});

describe("API tokens", () => {
  // A new token needs a session signed in within TOKEN_SIGN_IN_WINDOW_MS
  // (issue #322). The sessions and the token route both read the test auth's
  // hand-moved clock (auth.clock, passed to the tokens module as now), so the
  // window does not depend on how long the tests above took (issue #377).
  // Each token test still signs in afresh, with a display name to record as
  // creator.
  beforeEach(async () => {
    session = (await auth.sessions.start("subject-settings", "Synthetic Settings User")).id;
  });

  test("the sign-in window is measured on the sessions' clock (issue #377)", async () => {
    // Signed in at the auth clock's time; that clock moves past the window,
    // while the real clock has hardly moved. A route reading another clock
    // than the sessions would let this through.
    auth.clock.advance(TOKEN_SIGN_IN_WINDOW_MS + 1000);
    const late = await call("POST", "/app/api/tokens", { json: { name: `late ${marker()}` } });
    expect(late.status, late.text).toBe(403);
    expect((late.json() as { error: string }).error).toBe("sign_in_required");
    expect(late.text).not.toContain(TOKEN_PREFIX);
    // A sign-in on the moved clock is fresh again.
    session = (await auth.sessions.start("subject-settings", "Synthetic Settings User")).id;
    await makeToken(`on time ${marker()}`);
  });

  test("new token is shown once and never again", async () => {
    const { res, created } = await makeToken("Upload script on a laptop");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(TOKEN_PATTERN.test(created.token)).toBe(true);
    expect(created.name).toBe("Upload script on a laptop");
    expect(created.prefix).toBe(created.token.slice(0, 8));

    // The list shows the prefix and last used, never the token.
    const list = await call("GET", "/app/api/tokens");
    expect(list.status, list.text).toBe(200);
    expect(list.text).not.toContain(created.token);
    expect(list.text).not.toContain(created.token.slice(TOKEN_PREFIX.length));
    const listed = (list.json() as { tokens: Array<Record<string, unknown>> }).tokens.find(
      (t) => t.id === created.id,
    );
    expect(listed).toEqual({
      id: created.id,
      name: "Upload script on a laptop",
      prefix: created.prefix,
      createdAt: created.createdAt,
      lastUsedAt: null,
      createdBy: { subject: "subject-settings", name: "Synthetic Settings User" },
    });

    // It is a working API token, and its use shows as last used.
    expect(await v1Status(created.token)).toBe(200);
    const after = (
      (await call("GET", "/app/api/tokens")).json() as {
        tokens: Array<{ id: string; lastUsedAt: string | null }>;
      }
    ).tokens.find((t) => t.id === created.id);
    expect(after?.lastUsedAt).not.toBeNull();
  });

  test("the api_tokens row records who made the token (issue #322)", async () => {
    const { created } = await makeToken(`creator ${marker()}`);
    const row = await env.db
      .selectFrom("apiTokens")
      .select(["createdBySubject", "createdByName"])
      .where("id", "=", created.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      createdBySubject: "subject-settings",
      createdByName: "Synthetic Settings User",
    });
  });

  test("revoking one token leaves the other working and drops it from the list", async () => {
    const keep = (await makeToken(`keep ${marker()}`)).created;
    const drop = (await makeToken(`drop ${marker()}`)).created;
    const revoked = await call("DELETE", `/app/api/tokens/${drop.id}`);
    expect(revoked.status, revoked.text).toBe(204);
    expect(await v1Status(drop.token)).toBe(401);
    expect(await v1Status(keep.token)).toBe(200);
    const ids = (
      (await call("GET", "/app/api/tokens")).json() as { tokens: Array<{ id: string }> }
    ).tokens.map((t) => t.id);
    expect(ids).toContain(keep.id);
    expect(ids).not.toContain(drop.id);
    expect((await call("DELETE", `/app/api/tokens/${drop.id}`)).status).toBe(404);
    expect((await call("DELETE", "/app/api/tokens/not-a-token")).status).toBe(404);
  });

  test("a new token whose answer cannot be built is revoked, not left live and unseen", async () => {
    // The token row is written, then the read that builds the answer fails
    // (a dropped connection) or comes back without it. The answer is 500 with
    // no token in it, so the token must not stay live: nobody has its value.
    const failures: Array<[string, () => Promise<ListedToken[]>]> = [
      ["read fails", async () => Promise.reject(new Error("Connection terminated unexpectedly"))],
      ["row missing", async () => []],
    ];
    for (const [what, failing] of failures) {
      const name = `unseen ${marker()}`;
      const liveBefore = (await dbTokenList(env.db)()).map((t) => t.id);
      tokenList = failing;
      try {
        const res = await call("POST", "/app/api/tokens", { json: { name } });
        expect(res.status, `${what}: ${res.text}`).toBe(500);
        expect(res.text).not.toContain(TOKEN_PREFIX);
      } finally {
        tokenList = dbTokenList(env.db);
      }
      expect(
        (await dbTokenList(env.db)()).map((t) => t.id),
        what,
      ).toEqual(liveBefore);
      const made = await env.db
        .selectFrom("apiTokens")
        .select(["revokedAt"])
        .where("name", "=", name)
        .execute();
      expect(made, what).toHaveLength(1);
      expect(made[0]?.revokedAt, what).not.toBeNull();
    }
  });

  test("a token needs a name of 1 to 100 characters", async () => {
    for (const json of [{}, { name: "" }, { name: "   " }, { name: "x".repeat(101) }]) {
      const res = await call("POST", "/app/api/tokens", { json });
      expect(res.status, JSON.stringify(json)).toBe(400);
      expect(res.text).not.toMatch(/ph_/);
    }
  });
});

describe("organising", () => {
  test("rename changes the display name and keeps the bucket key", async () => {
    const seeded = await seedStoredModel(env);
    const model = await call("PATCH", `/app/api/models/${seeded.model.id}`, {
      json: { name: "  Renamed model  " },
    });
    expect(model.status, model.text).toBe(204);
    expect((await env.repos.models.get(seeded.model.id))?.name).toBe("Renamed model");
    const file = await call("PATCH", `/app/api/files/${seeded.file.id}`, {
      json: { name: "Renamed part.3mf" },
    });
    expect(file.status, file.text).toBe(204);
    expect((await env.repos.files.get(seeded.file.id))?.name).toBe("Renamed part.3mf");
    const blob = await env.repos.blobs.get(seeded.source.id);
    expect(blob?.key).toBe(seeded.source.key);
    const blank = await call("PATCH", `/app/api/models/${seeded.model.id}`, {
      json: { name: " " },
    });
    expect(blank.status).toBe(400);
    expect((await call("PATCH", `/app/api/files/${seeded.file.id}`, { json: {} })).status).toBe(
      400,
    );
  });

  test("tags and collections are added and removed, and the lists count live models", async () => {
    const tag = `tag-${marker()}`;
    const shelf = `Shelf ${marker()}`;
    const desk = `Desk ${marker()}`;
    const creator = `Maker ${marker()}`;
    const a = await seedStoredModel(env, { creator });
    const b = await seedStoredModel(env, { creator });
    const tagPath = (id: string) => `/app/api/models/${id}/tags?name=${encodeURIComponent(tag)}`;
    const shelfPath = (name: string, id: string) =>
      `/app/api/models/${id}/collections?name=${encodeURIComponent(name)}`;

    for (const id of [a.model.id, b.model.id]) {
      const put = await call("PUT", tagPath(id));
      expect(put.status, put.text).toBe(200);
      expect(put.json()).toEqual({ name: tag });
    }
    for (const name of [shelf, desk]) {
      const put = await call("PUT", shelfPath(name, a.model.id));
      expect(put.status, put.text).toBe(200);
      expect(put.json()).toEqual({ name });
    }

    const tags = (await call("GET", "/app/api/tags")).json() as {
      tags: Array<{ name: string; models: number }>;
    };
    expect(tags.tags).toContainEqual({ name: tag, models: 2 });
    const collections = (await call("GET", "/app/api/collections")).json() as {
      collections: Array<{ name: string; models: number }>;
    };
    expect(collections.collections).toContainEqual({ name: shelf, models: 1 });
    expect(collections.collections).toContainEqual({ name: desk, models: 1 });
    const creators = (await call("GET", "/app/api/creators")).json() as {
      creators: Array<{ name: string; models: number }>;
    };
    expect(creators.creators).toContainEqual({ name: creator, models: 2 });

    // A model sits in two collections, and the rows carry its chips and files.
    const byTag = await call("GET", `/app/api/organise/models?tag=${encodeURIComponent(tag)}`);
    expect(byTag.status, byTag.text).toBe(200);
    const rows = (byTag.json() as { models: Array<Record<string, unknown>> }).models;
    expect(rows.map((m) => m.id).sort()).toEqual([a.model.id, b.model.id].sort());
    expect(rows.find((m) => m.id === a.model.id)).toMatchObject({
      name: a.model.name,
      creator,
      tags: [tag],
      collections: [desk, shelf].sort((x, y) => x.toLowerCase().localeCompare(y.toLowerCase())),
      files: [{ id: a.file.id, name: a.file.name, kind: "3mf" }],
    });

    const off = await call("DELETE", tagPath(b.model.id));
    expect(off.status, off.text).toBe(204);
    const out = await call("DELETE", shelfPath(shelf, a.model.id));
    expect(out.status, out.text).toBe(204);
    expect(await env.repos.tags.forModel(b.model.id)).toEqual([]);
    expect(await env.repos.collections.forModel(a.model.id)).toEqual([desk]);
    // Taking off what is not there is 404.
    expect((await call("DELETE", tagPath(b.model.id))).status).toBe(404);
  });

  test("a tag or collection added in other capitals answers the name already stored", async () => {
    // Tags and collections are one per name ignoring case, and the first
    // name written is kept, so the page shows the answer's name on the chip.
    const tag = `pla-${marker()}`;
    const shelf = `Shelf ${marker()}`;
    const a = await seedStoredModel(env);
    const b = await seedStoredModel(env);
    const tagPath = (id: string, name: string) =>
      `/app/api/models/${id}/tags?name=${encodeURIComponent(name)}`;
    const shelfPath = (name: string, id: string) =>
      `/app/api/models/${id}/collections?name=${encodeURIComponent(name)}`;
    expect((await call("PUT", tagPath(a.model.id, tag))).json()).toEqual({ name: tag });
    expect((await call("PUT", shelfPath(shelf, a.model.id))).json()).toEqual({ name: shelf });

    const upperTag = await call("PUT", tagPath(b.model.id, `  ${tag.toUpperCase()} `));
    expect(upperTag.status, upperTag.text).toBe(200);
    expect(upperTag.json()).toEqual({ name: tag });
    const upperShelf = await call("PUT", shelfPath(shelf.toUpperCase(), b.model.id));
    expect(upperShelf.status, upperShelf.text).toBe(200);
    expect(upperShelf.json()).toEqual({ name: shelf });
    expect(await env.repos.tags.forModel(b.model.id)).toEqual([tag]);
    expect(await env.repos.collections.forModel(b.model.id)).toEqual([shelf]);
  });

  test('a tag or collection named "." or ".." is added and removed through the query', async () => {
    // The name is never a path segment: a URL parser rewrites "." and ".."
    // (%2E too), so DELETE .../tags/.. would reach DELETE /app/api/models/:id.
    const seeded = await seedStoredModel(env);
    const id = seeded.model.id;
    for (const name of [".", ".."]) {
      const q = `?name=${encodeURIComponent(name)}`;
      const tagged = await call("PUT", `/app/api/models/${id}/tags${q}`);
      expect(tagged.status, tagged.text).toBe(200);
      expect(tagged.json()).toEqual({ name });
      const added = await call("PUT", `/app/api/models/${id}/collections${q}`);
      expect(added.status, added.text).toBe(200);
      expect(added.json()).toEqual({ name });
    }
    expect((await env.repos.tags.forModel(id)).sort()).toEqual([".", ".."]);
    expect((await env.repos.collections.forModel(id)).sort()).toEqual([".", ".."]);
    for (const name of [".", ".."]) {
      const q = `?name=${encodeURIComponent(name)}`;
      expect((await call("DELETE", `/app/api/models/${id}/tags${q}`)).status).toBe(204);
      expect((await call("DELETE", `/app/api/models/${id}/collections${q}`)).status).toBe(204);
    }
    expect(await env.repos.tags.forModel(id)).toEqual([]);
    expect(await env.repos.collections.forModel(id)).toEqual([]);
    // No name, or a blank one, is refused before anything changes.
    const refused = [
      await call("PUT", `/app/api/models/${id}/tags`),
      await call("PUT", `/app/api/models/${id}/tags?name=%20`),
      await call("DELETE", `/app/api/models/${id}/collections`),
    ];
    expect(refused.map((r) => r.status)).toEqual([400, 400, 400]);
  });

  test("a trashed model cannot be renamed, tagged or put in a collection", async () => {
    const seeded = await seedStoredModel(env);
    const id = seeded.model.id;
    expect((await call("POST", `/app/api/models/${id}/trash`)).status).toBe(204);
    const refused = [
      await call("PATCH", `/app/api/models/${id}`, { json: { name: "x" } }),
      await call("PATCH", `/app/api/files/${seeded.file.id}`, { json: { name: "x" } }),
      await call("PUT", `/app/api/models/${id}/tags?name=t`),
      await call("PUT", `/app/api/models/${id}/collections?name=c`),
      await call("POST", `/app/api/models/${id}/trash`),
    ];
    expect(refused.map((r) => r.status)).toEqual([404, 404, 404, 404, 404]);
  });
});

// Issue #312: a tag or collection can be deleted from the Tags and Collections
// pages. Deleting takes it off every model that has it, trashed ones included,
// and changes nothing else about any model. A tag no model has any more is
// removed when its last model loses it in the app; a model in the trash still
// has its tags (a restore brings them back), so it keeps the tag. Collections
// are never removed on their own.
describe("deleting tags and collections", () => {
  const q = (name: string) => `?name=${encodeURIComponent(name)}`;

  test("deleting a tag takes it off every model, and the models stay", async () => {
    const tag = `Doomed ${marker()}`;
    const other = `Other ${marker()}`;
    const a = await seedStoredModel(env);
    const b = await seedStoredModel(env);
    const trashed = await seedStoredModel(env);
    for (const m of [a, b, trashed]) {
      const put = await call("PUT", `/app/api/models/${m.model.id}/tags${q(tag)}`);
      expect(put.status, put.text).toBe(200);
    }
    expect((await call("PUT", `/app/api/models/${a.model.id}/tags${q(other)}`)).status).toBe(200);
    expect((await call("POST", `/app/api/models/${trashed.model.id}/trash`)).status).toBe(204);

    const gone = await call("DELETE", `/app/api/tags${q(tag.toUpperCase())}`);
    expect(gone.status, gone.text).toBe(204);
    expect(await labelStored(env.db, "tags", tag)).toBe(false);
    expect(await env.repos.tags.forModel(a.model.id)).toEqual([other]);
    expect(await env.repos.tags.forModel(b.model.id)).toEqual([]);
    expect(await env.repos.tags.forModel(trashed.model.id)).toEqual([]);
    for (const m of [a, b, trashed]) {
      expect(await rowCounts(env.db, m.model.id)).toMatchObject({ models: 1, files: 1 });
    }
    expect((await env.repos.models.get(trashed.model.id))?.trashedAt).not.toBeNull();
    const list = (await call("GET", "/app/api/tags")).json() as { tags: Array<{ name: string }> };
    expect(list.tags.map((t) => t.name)).not.toContain(tag);
    // A tag that is not there any more is 404.
    expect((await call("DELETE", `/app/api/tags${q(tag)}`)).status).toBe(404);
  });

  test("deleting a collection takes every model out of it, and the models stay", async () => {
    const shelf = `Doomed shelf ${marker()}`;
    const a = await seedStoredModel(env);
    const trashed = await seedStoredModel(env);
    for (const m of [a, trashed]) {
      const put = await call("PUT", `/app/api/models/${m.model.id}/collections${q(shelf)}`);
      expect(put.status, put.text).toBe(200);
    }
    expect((await call("POST", `/app/api/models/${trashed.model.id}/trash`)).status).toBe(204);

    const gone = await call("DELETE", `/app/api/collections${q(shelf.toLowerCase())}`);
    expect(gone.status, gone.text).toBe(204);
    expect(await labelStored(env.db, "collections", shelf)).toBe(false);
    expect(await env.repos.collections.forModel(a.model.id)).toEqual([]);
    expect(await env.repos.collections.forModel(trashed.model.id)).toEqual([]);
    for (const m of [a, trashed]) {
      expect(await rowCounts(env.db, m.model.id)).toMatchObject({ models: 1, files: 1 });
    }
    expect((await call("DELETE", `/app/api/collections${q(shelf)}`)).status).toBe(404);
  });

  test('a tag or collection named "." or ".." is deleted through the query', async () => {
    const seeded = await seedStoredModel(env);
    const id = seeded.model.id;
    for (const name of [".", ".."]) {
      expect((await call("PUT", `/app/api/models/${id}/tags${q(name)}`)).status).toBe(200);
      expect((await call("PUT", `/app/api/models/${id}/collections${q(name)}`)).status).toBe(200);
      expect((await call("DELETE", `/app/api/tags${q(name)}`)).status).toBe(204);
      expect((await call("DELETE", `/app/api/collections${q(name)}`)).status).toBe(204);
    }
    expect(await env.repos.tags.forModel(id)).toEqual([]);
    expect(await env.repos.collections.forModel(id)).toEqual([]);
    expect(await rowCounts(env.db, id)).toMatchObject({ models: 1 });
  });

  test("a delete with no name, or a blank one, is refused", async () => {
    const refused = [
      await call("DELETE", "/app/api/tags"),
      await call("DELETE", "/app/api/tags?name=%20"),
      await call("DELETE", "/app/api/collections"),
      await call("DELETE", "/app/api/collections?name=%20"),
    ];
    expect(refused.map((r) => r.status)).toEqual([400, 400, 400, 400]);
  });

  test("taking a tag off its last model removes the tag; a trashed model keeps it", async () => {
    const lonely = `Lonely ${marker()}`;
    const shared = `Shared ${marker()}`;
    const shelf = `Kept shelf ${marker()}`;
    const live = await seedStoredModel(env);
    const trashed = await seedStoredModel(env);
    const id = live.model.id;
    await call("PUT", `/app/api/models/${id}/tags${q(lonely)}`);
    await call("PUT", `/app/api/models/${id}/tags${q(shared)}`);
    await call("PUT", `/app/api/models/${trashed.model.id}/tags${q(shared)}`);
    await call("PUT", `/app/api/models/${id}/collections${q(shelf)}`);
    expect((await call("POST", `/app/api/models/${trashed.model.id}/trash`)).status).toBe(204);

    expect((await call("DELETE", `/app/api/models/${id}/tags${q(lonely)}`)).status).toBe(204);
    expect((await call("DELETE", `/app/api/models/${id}/tags${q(shared)}`)).status).toBe(204);
    expect((await call("DELETE", `/app/api/models/${id}/collections${q(shelf)}`)).status).toBe(204);
    expect(await labelStored(env.db, "tags", lonely)).toBe(false);
    expect(await labelStored(env.db, "tags", shared)).toBe(true);
    expect(await env.repos.tags.forModel(trashed.model.id)).toEqual([shared]);
    expect(await labelStored(env.db, "collections", shelf)).toBe(true);
    // Adding the removed tag again makes it again.
    const again = await call("PUT", `/app/api/models/${id}/tags${q(lonely)}`);
    expect(again.status, again.text).toBe(200);
    expect(await env.repos.tags.forModel(id)).toEqual([lonely]);
  });

  test("the lists show tags and collections no model uses, but not ones only trashed models use", async () => {
    const unusedTag = `Unused tag ${marker()}`;
    const emptyShelf = `Empty shelf ${marker()}`;
    const trashedTag = `Trashed tag ${marker()}`;
    const trashedShelf = `Trashed shelf ${marker()}`;
    // A tag no model has, as the public API's untag leaves one.
    await sql`insert into tags (id, name) values (${uuidv7()}, ${unusedTag})`.execute(env.db);
    const live = await seedStoredModel(env);
    const trashed = await seedStoredModel(env);
    await call("PUT", `/app/api/models/${live.model.id}/collections${q(emptyShelf)}`);
    await call("DELETE", `/app/api/models/${live.model.id}/collections${q(emptyShelf)}`);
    await call("PUT", `/app/api/models/${trashed.model.id}/tags${q(trashedTag)}`);
    await call("PUT", `/app/api/models/${trashed.model.id}/collections${q(trashedShelf)}`);
    await call("POST", `/app/api/models/${trashed.model.id}/trash`);

    const tags = (await call("GET", "/app/api/tags")).json() as {
      tags: Array<{ name: string; models: number }>;
    };
    expect(tags.tags).toContainEqual({ name: unusedTag, models: 0 });
    expect(tags.tags.map((t) => t.name)).not.toContain(trashedTag);
    const collections = (await call("GET", "/app/api/collections")).json() as {
      collections: Array<{ name: string; models: number }>;
    };
    expect(collections.collections).toContainEqual({ name: emptyShelf, models: 0 });
    expect(collections.collections.map((c) => c.name)).not.toContain(trashedShelf);

    // Both can be deleted from there.
    expect((await call("DELETE", `/app/api/tags${q(unusedTag)}`)).status).toBe(204);
    expect((await call("DELETE", `/app/api/collections${q(emptyShelf)}`)).status).toBe(204);
  });
});

/** What GET /app/api/trash answers now, as the trash page holds it: page 1 only. */
async function listedTrash(): Promise<{ ids: string[]; readAt: string }> {
  const res = await call("GET", "/app/api/trash");
  expect(res.status, res.text).toBe(200);
  const body = res.json() as { models: Array<{ id: string }>; readAt: string };
  return { ids: body.models.map((m) => m.id), readAt: body.readAt };
}

/**
 * Waits until the Empty trash job has deleted these models, and the check
 * holds (pg-boss polls every 0.5 s and runs one maintenance job at a time).
 */
async function untilPurged(modelIds: string[], check: () => Promise<void> = async () => {}) {
  await vi.waitFor(
    async () => {
      for (const id of modelIds) expect((await rowCounts(env.db, id)).models, id).toBe(0);
      await check();
    },
    { timeout: 20_000, interval: 100 },
  );
}

/** The state of the newest empty-trash job on the maintenance queue. */
async function newestEmptyTrashJob(): Promise<string | undefined> {
  const jobs = await boss.findJobs(QUEUE.maintenance, {
    data: { task: ON_DEMAND_TASKS.emptyTrash },
  });
  return jobs.at(-1)?.state;
}

/** Sets a trashed model's trash time exactly, to the microsecond. */
async function trashedAtExactly(modelId: string, at: string): Promise<void> {
  await sql`update models set trashed_at = ${at}::timestamptz where id = ${modelId}`.execute(
    env.db,
  );
}

describe("the trash", () => {
  test("lists each trashed model with its purge date, and restore brings it back", async () => {
    const tag = `kept-${marker()}`;
    const seeded = await seedStoredModel(env);
    await call("PUT", `/app/api/models/${seeded.model.id}/tags?name=${tag}`);
    expect((await call("POST", `/app/api/models/${seeded.model.id}/trash`)).status).toBe(204);

    const list = await call("GET", "/app/api/trash");
    expect(list.status, list.text).toBe(200);
    const row = (
      list.json() as {
        models: Array<{ id: string; name: string; trashedAt: string; purgeAt: string }>;
      }
    ).models.find((m) => m.id === seeded.model.id);
    expect(row?.name).toBe(seeded.model.name);
    const trashedAt = new Date(row?.trashedAt ?? "").getTime();
    expect(new Date(row?.purgeAt ?? "").getTime() - trashedAt).toBe(30 * DAY_MS);

    const restored = await call("POST", `/app/api/trash/${seeded.model.id}/restore`);
    expect(restored.status, restored.text).toBe(204);
    expect((await env.repos.models.get(seeded.model.id))?.trashedAt).toBeNull();
    expect(await env.repos.tags.forModel(seeded.model.id)).toEqual([tag]);
    expect((await call("POST", `/app/api/trash/${seeded.model.id}/restore`)).status).toBe(404);
  });

  test("a model whose purge began cannot be restored", async () => {
    const seeded = await seedStoredModel(env);
    await call("POST", `/app/api/models/${seeded.model.id}/trash`);
    await sql`update models set purge_started_at = now() where id = ${seeded.model.id}`.execute(
      env.db,
    );
    const res = await call("POST", `/app/api/trash/${seeded.model.id}/restore`);
    expect(res.status, res.text).toBe(409);
    expect((await call("GET", "/app/api/trash")).json()).toMatchObject({
      models: expect.arrayContaining([
        expect.objectContaining({ id: seeded.model.id, purgeStarted: true }),
      ]),
    });
  });

  test("the trash list says when the server read it", async () => {
    const before = Date.now();
    const { readAt } = await listedTrash();
    expect(readAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // The database's clock, which also stamps trashed_at; allow for a
    // little drift from this process's clock.
    expect(Math.abs(Date.parse(readAt) - before)).toBeLessThan(60_000);
  });

  test("empty trash purges the trashed models listed by then, their rows and their bucket objects", async () => {
    const a = await seedStoredModel(env);
    const b = await seedStoredModel(env);
    const live = await seedStoredModel(env);
    for (const m of [a, b]) await call("POST", `/app/api/models/${m.model.id}/trash`);
    const { ids, readAt } = await listedTrash();
    expect(ids).toEqual(expect.arrayContaining([a.model.id, b.model.id]));

    const res = await call("POST", "/app/api/trash/empty", { json: { cutoff: readAt } });
    expect(res.status, res.text).toBe(202);
    expect(res.json()).toEqual({ queued: ids.length, at: expect.any(String) });

    await untilPurged([a.model.id, b.model.id], async () => {
      expect((await listedTrash()).ids).toEqual([]);
    });
    for (const m of [a, b]) {
      expect(await env.store.listPrefix(`models/${m.model.id}/`)).toEqual([]);
    }
    expect((await rowCounts(env.db, live.model.id)).models).toBe(1);
  });

  test("an Empty trash job that fails on the bucket leaves that model listed, and a later job finishes it", async () => {
    const failing = await seedStoredModel(env);
    const done = await seedStoredModel(env);
    for (const m of [failing, done]) await call("POST", `/app/api/models/${m.model.id}/trash`);
    const failingPrefix = `models/${failing.model.id}/`;
    // The bucket drops the connection after deleting one of the failing
    // model's objects; every other delete goes through.
    purgeStore = {
      listPrefix: (p) => env.store.listPrefix(p),
      async deleteBlobs(keys) {
        if (!keys.some((k) => k.startsWith(failingPrefix))) return env.store.deleteBlobs(keys);
        await env.store.deleteBlobs(keys.slice(0, 1));
        throw new StoreUnavailable("DeleteObjects", "ECONNRESET");
      },
    };
    try {
      const res = await call("POST", "/app/api/trash/empty", {
        json: { cutoff: (await listedTrash()).readAt },
      });
      expect(res.status, res.text).toBe(202);
      expect(res.json()).toEqual({ queued: 2, at: expect.any(String) });

      // pg-boss retries the job and then marks it failed; the other model is gone.
      await untilPurged([done.model.id], async () => {
        expect(await newestEmptyTrashJob()).toBe("failed");
      });
      expect(await env.store.listPrefix(`models/${done.model.id}/`)).toEqual([]);
      expect((await call("GET", "/app/api/trash")).json()).toEqual({
        models: [expect.objectContaining({ id: failing.model.id, purgeStarted: true })],
        readAt: expect.any(String),
        page: 1,
        pageSize: 100,
        pageCount: 1,
        total: 1,
        emptying: false,
        purging: 1,
      });
    } finally {
      purgeStore = env.store;
    }

    // With the bucket back, a later job finishes it.
    const retry = await call("POST", "/app/api/trash/empty", {
      json: { cutoff: (await listedTrash()).readAt },
    });
    expect(retry.status, retry.text).toBe(202);
    expect(retry.json()).toEqual({ queued: 1, at: expect.any(String) });
    await untilPurged([failing.model.id], async () => {
      expect((await listedTrash()).ids).toEqual([]);
    });
    expect(await env.store.listPrefix(failingPrefix)).toEqual([]);
  });

  test("the trash says while Empty trash runs and how many models it is deleting", async () => {
    const a = await seedStoredModel(env);
    const b = await seedStoredModel(env);
    for (const m of [a, b]) await call("POST", `/app/api/models/${m.model.id}/trash`);
    const idle = (await call("GET", "/app/api/trash")).json();
    expect(idle).toMatchObject({ emptying: false, purging: 0 });
    // The job waits at its first delete until released, so the list is
    // read while it runs.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    purgeStore = {
      listPrefix: (p) => env.store.listPrefix(p),
      async deleteBlobs(keys) {
        await held;
        return env.store.deleteBlobs(keys);
      },
    };
    try {
      const res = await call("POST", "/app/api/trash/empty", {
        json: { cutoff: (await listedTrash()).readAt },
      });
      expect(res.status, res.text).toBe(202);
      expect(res.json()).toEqual({ queued: 2, at: expect.any(String) });

      const running = (await call("GET", "/app/api/trash")).json();
      expect(running).toMatchObject({ emptying: true, purging: 2, total: 2 });
      expect((running as { models: Array<{ purgeStarted: boolean }> }).models).toEqual([
        expect.objectContaining({ purgeStarted: true }),
        expect.objectContaining({ purgeStarted: true }),
      ]);
    } finally {
      release();
      purgeStore = env.store;
    }

    await untilPurged([a.model.id, b.model.id], async () => {
      expect((await call("GET", "/app/api/trash")).json()).toMatchObject({
        models: [],
        emptying: false,
        purging: 0,
        total: 0,
      });
    });
  });

  test("empty trash leaves a model trashed after the page read the list", async () => {
    const shown = await seedStoredModel(env);
    const unseen = await seedStoredModel(env);
    await call("POST", `/app/api/models/${shown.model.id}/trash`);
    const { ids, readAt } = await listedTrash();
    expect(ids).toEqual([shown.model.id]);
    // Another tab trashes a model after the page read the list. The cutoff
    // is to the millisecond, so trash it in a later millisecond than readAt.
    await sleep(5);
    await call("POST", `/app/api/models/${unseen.model.id}/trash`);

    const res = await call("POST", "/app/api/trash/empty", { json: { cutoff: readAt } });
    expect(res.status, res.text).toBe(202);
    expect(res.json()).toEqual({ queued: 1, at: expect.any(String) });
    await untilPurged([shown.model.id]);
    expect((await env.repos.models.get(unseen.model.id))?.trashedAt).not.toBeNull();
    expect(await env.store.listPrefix(`models/${unseen.model.id}/`)).not.toEqual([]);
    expect((await listedTrash()).ids).toEqual([unseen.model.id]);
    // It can still be restored.
    expect((await call("POST", `/app/api/trash/${unseen.model.id}/restore`)).status).toBe(204);
  });

  /** Trashes n models with distinct, ordered trash times, oldest first: row i is trashed at minute i. */
  async function seedTrashOf(n: number): Promise<string[]> {
    const emptied = await call("POST", "/app/api/trash/empty", {
      json: { cutoff: (await listedTrash()).readAt },
    });
    expect(emptied.status, emptied.text).toBe(202);
    await untilPurged([], async () => {
      expect((await listedTrash()).ids).toEqual([]);
    });
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const m = await seedStoredModel(env);
      await call("POST", `/app/api/models/${m.model.id}/trash`);
      const at = `2026-11-10T10:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`;
      await trashedAtExactly(m.model.id, at);
      ids.push(m.model.id);
    }
    return ids;
  }

  type TrashPageBody = {
    models: Array<{ id: string }>;
    readAt: string;
    page: number;
    pageSize: number;
    pageCount: number;
    total: number;
  };

  test("the trash answers 100 per page, newest first, with page counts", async () => {
    const ids = await seedTrashOf(101);
    const res = await call("GET", "/app/api/trash");
    expect(res.status, res.text).toBe(200);
    const body = res.json() as TrashPageBody;
    expect(body).toMatchObject({ page: 1, pageSize: 100, pageCount: 2, total: 101 });
    expect(body.models.map((m) => m.id)).toEqual([...ids].reverse().slice(0, 100));
  });

  test("page 2 continues where page 1 ended", async () => {
    const ids = await seedTrashOf(3);
    const first = (await call("GET", "/app/api/trash?limit=2")).json() as TrashPageBody;
    expect(first.models.map((m) => m.id)).toEqual([ids[2], ids[1]]);
    const res = await call("GET", "/app/api/trash?page=2&limit=2");
    expect(res.status, res.text).toBe(200);
    const body = res.json() as TrashPageBody;
    expect(body).toMatchObject({ page: 2, pageSize: 2, pageCount: 2, total: 3 });
    expect(body.models.map((m) => m.id)).toEqual([ids[0]]);
    // A page past the end is served as the last page.
    const past = (await call("GET", "/app/api/trash?page=9&limit=2")).json() as TrashPageBody;
    expect(past.page).toBe(2);
    expect(past.models.map((m) => m.id)).toEqual([ids[0]]);
  });

  test("an out-of-range page or limit is refused", async () => {
    for (const q of ["page=0", "page=1000001", "page=x", "limit=0", "limit=201"]) {
      const res = await call("GET", `/app/api/trash?${q}`);
      expect(res.status, q).toBe(400);
      expect(res.json()).toMatchObject({ error: "bad_request" });
    }
  });

  test("empty trash with page 1's readAt leaves a model trashed after it, with the trash paged", async () => {
    const seeded = await seedTrashOf(3);
    const first = (await call("GET", "/app/api/trash?limit=2")).json() as TrashPageBody;
    expect(first.pageCount).toBe(2);
    const unseen = await seedStoredModel(env);
    await sleep(5);
    await call("POST", `/app/api/models/${unseen.model.id}/trash`);

    const res = await call("POST", "/app/api/trash/empty", { json: { cutoff: first.readAt } });
    expect(res.status, res.text).toBe(202);
    expect(res.json()).toEqual({ queued: 3, at: expect.any(String) });
    await untilPurged(seeded, async () => {
      expect((await listedTrash()).ids).toEqual([unseen.model.id]);
    });
    expect((await call("POST", `/app/api/trash/${unseen.model.id}/restore`)).status).toBe(204);
  });

  test("empty trash with page 2's readAt leaves a model trashed after that read", async () => {
    const seeded = await seedTrashOf(3);
    const second = (await call("GET", "/app/api/trash?page=2&limit=2")).json() as TrashPageBody;
    expect(second.page).toBe(2);
    const unseen = await seedStoredModel(env);
    await sleep(5);
    await call("POST", `/app/api/models/${unseen.model.id}/trash`);

    const res = await call("POST", "/app/api/trash/empty", { json: { cutoff: second.readAt } });
    expect(res.status, res.text).toBe(202);
    expect(res.json()).toEqual({ queued: 3, at: expect.any(String) });
    await untilPurged(seeded, async () => {
      expect((await listedTrash()).ids).toEqual([unseen.model.id]);
    });
    expect((await call("POST", `/app/api/trash/${unseen.model.id}/restore`)).status).toBe(204);
  });

  test("the cutoff includes its whole millisecond and nothing after it", async () => {
    const inside = await seedStoredModel(env);
    const after = await seedStoredModel(env);
    for (const m of [inside, after]) await call("POST", `/app/api/models/${m.model.id}/trash`);
    // trashed_at keeps microseconds; the cutoff the page sends has
    // milliseconds, as readAt does.
    await trashedAtExactly(inside.model.id, "2026-11-10T10:00:00.123999Z");
    await trashedAtExactly(after.model.id, "2026-11-10T10:00:00.124000Z");

    const res = await call("POST", "/app/api/trash/empty", {
      json: { cutoff: "2026-11-10T10:00:00.123Z" },
    });
    expect(res.status, res.text).toBe(202);
    expect(res.json()).toEqual({ queued: 1, at: expect.any(String) });
    await untilPurged([inside.model.id], async () => {
      expect((await listedTrash()).ids).toEqual([after.model.id]);
    });
    expect((await call("POST", `/app/api/trash/${after.model.id}/restore`)).status).toBe(204);
  });

  test("empty trash without a valid cutoff is refused and changes nothing", async () => {
    const seeded = await seedStoredModel(env);
    await call("POST", `/app/api/models/${seeded.model.id}/trash`);
    const { readAt } = await listedTrash();
    const tomorrow = new Date(Date.parse(readAt) + DAY_MS).toISOString();
    for (const json of [
      undefined,
      {},
      { ids: [seeded.model.id] },
      { cutoff: 1794474000000 },
      { cutoff: "" },
      { cutoff: "yesterday" },
      { cutoff: "2026-11-12" },
      { cutoff: "2026-11-12T09:00:00+01:00" },
      { cutoff: "2026-02-30T00:00:00.000Z" },
      { cutoff: tomorrow },
    ]) {
      const res = await call("POST", "/app/api/trash/empty", { json });
      expect(res.status, `${JSON.stringify(json)}: ${res.text}`).toBe(400);
      expect((res.json() as { error: string }).error).toBe("bad_request");
    }
    expect((await rowCounts(env.db, seeded.model.id)).models).toBe(1);
    expect((await call("POST", `/app/api/trash/${seeded.model.id}/restore`)).status).toBe(204);
  });
});

describe("every /app/api route", () => {
  test("is session-class: no session is 401, and a state change from another origin is 403", async () => {
    const routes = registeredRoutes(app).filter((r) => r.path.startsWith("/app/api/"));
    expect(routes.length).toBeGreaterThanOrEqual(15);
    for (const route of routes) {
      expect(patternClass(route.path), route.path).toBe("session");
      for (const method of route.methods) {
        if (method === "HEAD") continue;
        const url = concretePath(route.path);
        const label = `${method} ${route.path}`;
        const anon = await call(method as "GET", url, { cookie: false });
        expect(anon.status, label).toBe(401);
        if (method !== "GET") {
          for (const origin of ["https://evil.test", false] as const) {
            const res = await call(method as "POST", url, { origin, json: { name: "x" } });
            expect(res.status, `${label} origin ${origin}`).toBe(403);
          }
        }
      }
    }
  });

  test("a refused empty trash changes nothing", async () => {
    const seeded = await seedStoredModel(env);
    await call("POST", `/app/api/models/${seeded.model.id}/trash`);
    const res = await call("POST", "/app/api/trash/empty", {
      origin: "https://evil.test",
      json: { cutoff: new Date().toISOString() },
    });
    expect(res.status).toBe(403);
    expect((await rowCounts(env.db, seeded.model.id)).models).toBe(1);
  });

  test("the trash and settings pages are shell pages", async () => {
    for (const url of ["/trash", "/settings"]) {
      const res = await app.inject({
        method: "GET",
        url,
        headers: { accept: "text/html" },
        cookies: { [SESSION_COOKIE]: session },
      });
      // No web build in this test: the shell answers its not-built sentence.
      expect(res.statusCode, url).toBe(503);
      expect(res.body, url).toBe(NOT_BUILT);
    }
  });

  test("no token made here appears in the request log", async () => {
    expect(madeTokens.length).toBeGreaterThanOrEqual(3);
    expect(lines.length).toBeGreaterThan(10);
    const log = lines.join("\n");
    for (const made of madeTokens) {
      expect(log).not.toContain(made);
      expect(log).not.toContain(made.slice(TOKEN_PREFIX.length));
    }
    // Tokens this test never saw, such as the ones made on the 500 path,
    // whose answer it does not read: nothing token-shaped is in the log.
    const tokenShaped = new RegExp(TOKEN_PATTERN.source.replace(/^\^|\$$/g, ""));
    expect(log).not.toMatch(tokenShaped);
  });
});
