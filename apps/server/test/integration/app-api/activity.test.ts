// The Activity page's app API, GET /app/api/activity (the maintainer, 2026-11-19), run
// against a migrated Postgres 17 and a started pg-boss on the same database,
// so its queries read the real schema and pg-boss's real job table. The
// slicer is a fake health() (it is asked for nothing else), and the inbox's
// failed/ folder is a temporary folder. Sessions are in memory (the login
// tests' support). Every model, file and message here is synthetic.
//
// What it pins:
// - an empty library answers zeros, no events and nothing working;
// - the numbers count live and trashed models apart, files and plates on
//   live models only, and every stored blob (trashed models' too);
// - the estimate progress is for the selected printer and Orca version on
//   live models only, and its failures come back as events with the plain
//   words, the code and a scrubbed detail;
// - pg-boss's live jobs come back by queue and job kind, and each
//   scheduled task with its last run;
// - each new model says where it came from where that is recorded;
// - failed renders and conversions and failed inbox files are events;
// - the slicer's health, reachable or not, and a slicer that hangs does not
//   hold the answer up;
// - no path, address or token reaches the answer;
// - the route needs a session, and answers 503 when it is not set up.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Health } from "@platehouse/slicer-contract";
import type { FastifyInstance } from "fastify";
import { type Kysely, sql } from "kysely";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildApp } from "../../../src/app.js";
import {
  ACTIVITY_API_PATHS,
  type ActivityView,
  type AppActivity,
  createAppActivity,
} from "../../../src/app-api/activity.js";
import { patternClass } from "../../../src/auth/gate.js";
import { SESSION_COOKIE } from "../../../src/auth/sessions.js";
import { uuidv7 } from "../../../src/db/ids.js";
import { migrate } from "../../../src/db/migrate.js";
import type { DB, FileKind } from "../../../src/db/types.js";
import { REASON_WORDS } from "../../../src/estimates/reasons.js";
import { createBoss } from "../../../src/jobs/boss.js";
import {
  MAINTENANCE_TASKS,
  POLL_ORCA_CRON,
  PURGE_EXPIRED_CRON,
  QUEUE,
} from "../../../src/jobs/queues.js";
import { createUploads } from "../../../src/uploads/tus.js";
import { startTestPostgres, type TestPostgres } from "../support/db.js";
import { type TestAuth, testAuth } from "../support/oidc-issuer.js";

const P1S = "Bambu Lab P1S 0.4 nozzle";
const X1C = "Bambu Lab X1 Carbon 0.4 nozzle";
const ORCA = "2.5.0";
const OPENSCAD = "2026.10.01";

const HEALTHY: Health = {
  contract: 2,
  orca: ORCA,
  openscad: OPENSCAD,
  busy: false,
  sandbox: { state: "on", reason: null, detail: null, allowUnsandboxed: false },
  timeouts: { sliceSeconds: 180, scadSeconds: 120, stepSeconds: 120, uploadSeconds: 600 },
};

let pgc: TestPostgres;
let auth: TestAuth;
let session: string;
let tmp: string;

interface Env {
  db: Kysely<DB>;
  boss: PgBoss;
  inboxDir: string;
  app: FastifyInstance;
  activity: AppActivity;
}

const envs: Env[] = [];

/** A fresh migrated database with pg-boss started on it and the app's three queues made. */
async function startEnv(
  slicer: { health(): Promise<Health> } = { health: async () => HEALTHY },
  healthTimeoutMs?: number,
): Promise<Env> {
  const t = await pgc.freshDatabase();
  await migrate(t.db);
  const boss = createBoss({ databaseUrl: t.url, onError: () => {} });
  await boss.start();
  // retryLimit 0 everywhere, so a failed job is 'failed' at once.
  for (const name of [QUEUE.ingest, QUEUE.slicer, QUEUE.maintenance]) {
    await boss.createQueue(name, { policy: "standard", retryLimit: 0 });
  }
  const inboxDir = await mkdtemp(join(tmp, "inbox-"));
  const activity = createAppActivity({
    db: t.db,
    boss,
    slicer,
    inboxDir,
    ...(healthTimeoutMs === undefined ? {} : { healthTimeoutMs }),
  });
  const app = await buildApp({
    health: { database: async () => 1, queuesRunning: () => true },
    uploads: createUploads({
      tmpDir: tmp,
      queue: { enqueue: async () => {}, result: async () => undefined },
      log: () => {},
    }),
    auth: auth.auth,
    activity,
    web: { dir: join(tmp, "no-web-build") },
  });
  await app.ready();
  const env = { db: t.db, boss, inboxDir, app, activity };
  envs.push(env);
  return env;
}

async function getActivity(env: Env, cookie: string | false = session) {
  const res = await env.app.inject({
    method: "GET",
    url: "/app/api/activity",
    headers: { accept: "application/json" },
    ...(cookie === false ? {} : { cookies: { [SESSION_COOKIE]: cookie } }),
  });
  return { status: res.statusCode, headers: res.headers, text: res.body };
}

async function view(env: Env): Promise<ActivityView> {
  const res = await getActivity(env);
  expect(res.status, res.text).toBe(200);
  return JSON.parse(res.text) as ActivityView;
}

// ---- Seeding, straight into the tables ----

async function addModel(
  db: Kysely<DB>,
  opts: { name: string; trashed?: boolean; externalRef?: string; createdAt?: Date },
): Promise<string> {
  const id = uuidv7();
  await db
    .insertInto("models")
    .values({
      id,
      name: opts.name,
      externalRef: opts.externalRef ?? null,
      trashedAt: opts.trashed ? new Date() : null,
      ...(opts.createdAt === undefined ? {} : { createdAt: opts.createdAt }),
    })
    .execute();
  return id;
}

async function addBlob(
  db: Kysely<DB>,
  modelId: string,
  size: number,
  state: "stored" | "pending" = "stored",
): Promise<string> {
  const id = uuidv7();
  await db
    .insertInto("blobs")
    .values({
      id,
      modelId,
      key: `models/${modelId}/${id}`,
      kind: "source",
      contentType: "application/octet-stream",
      size: state === "stored" ? size : null,
      sha256: state === "stored" ? createHash("sha256").update(id).digest() : null,
      state,
    })
    .execute();
  return id;
}

async function addFile(
  db: Kysely<DB>,
  modelId: string,
  kind: FileKind,
  opts: {
    size?: number;
    derivedStatus?: string;
    derivedMessage?: string;
    previewStatus?: string;
    previewMessage?: string;
    name?: string;
  } = {},
): Promise<string> {
  const size = opts.size ?? 100;
  const blobId = await addBlob(db, modelId, size);
  const id = uuidv7();
  const name = opts.name ?? `Part.${kind}`;
  await db
    .insertInto("files")
    .values({
      id,
      modelId,
      blobId,
      name,
      originalName: name,
      kind,
      size,
      sha256: createHash("sha256").update(id).digest(),
      derivedStatus: opts.derivedStatus ?? null,
      derivedMessage: opts.derivedMessage ?? null,
      previewStatus: opts.previewStatus ?? null,
      previewMessage: opts.previewMessage ?? null,
    })
    .execute();
  return id;
}

async function addPlate(db: Kysely<DB>, fileId: string, index: number, name?: string) {
  const id = uuidv7();
  await db
    .insertInto("plates")
    .values({ id, fileId, index, name: name ?? null, objectCount: 1 })
    .execute();
  return id;
}

async function addEstimate(
  db: Kysely<DB>,
  plateId: string,
  opts: {
    status: "pending" | "running" | "ok" | "failed";
    printerId?: string;
    version?: string;
    source?: "file" | "platehouse";
    finishedAt?: Date;
    code?: number;
    reason?: string;
    detail?: string;
  },
): Promise<string> {
  const id = uuidv7();
  const ok = opts.status === "ok";
  const failed = opts.status === "failed";
  await db
    .insertInto("estimates")
    .values({
      id,
      plateId,
      source: opts.source ?? "platehouse",
      printerId: opts.printerId ?? P1S,
      slicerVersion: opts.version ?? ORCA,
      status: opts.status,
      timeSeconds: ok ? 600 : null,
      weightGrams: ok ? 12 : null,
      failureCode: failed ? (opts.code ?? null) : null,
      failureReason: failed ? (opts.reason ?? "slicer_error") : null,
      failureDetail: failed ? (opts.detail ?? null) : null,
      finishedAt: ok || failed ? (opts.finishedAt ?? new Date()) : null,
    })
    .execute();
  return id;
}

beforeAll(async () => {
  pgc = await startTestPostgres();
  tmp = await mkdtemp(join(tmpdir(), "ph-activity-int-"));
  auth = await testAuth();
  session = (await auth.sessions.start("someone")).id;
});

afterAll(async () => {
  for (const env of envs) {
    await env.app.close();
    await env.boss.stop({ graceful: false });
  }
  await auth?.issuer.stop();
  await pgc?.stop();
  if (tmp !== undefined) await rm(tmp, { recursive: true, force: true });
});

describe("the route", () => {
  test("is session-class and is the only Activity route", () => {
    expect([...ACTIVITY_API_PATHS]).toEqual(["/app/api/activity"]);
    for (const path of ACTIVITY_API_PATHS) expect(patternClass(path)).toBe("session");
  });

  test("refuses a request with no session, and never caches an answer", async () => {
    const env = await startEnv();
    const refused = await getActivity(env, false);
    expect(refused.status).toBe(401);
    const answered = await getActivity(env);
    expect(answered.status).toBe(200);
    expect(answered.headers["cache-control"]).toBe("no-store");
  });

  test("answers 503 when the app was built without it", async () => {
    const app = await buildApp({
      health: { database: async () => 1, queuesRunning: () => true },
      uploads: createUploads({
        tmpDir: tmp,
        queue: { enqueue: async () => {}, result: async () => undefined },
        log: () => {},
      }),
      auth: auth.auth,
      web: { dir: join(tmp, "no-web-build") },
    });
    try {
      const res = await app.inject({
        method: "GET",
        url: "/app/api/activity",
        cookies: { [SESSION_COOKIE]: session },
      });
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body)).toEqual({ error: "unavailable" });
    } finally {
      await app.close();
    }
  });
});

describe("an empty library", () => {
  test("answers zeros, no events and nothing working, with the slicer's versions", async () => {
    const env = await startEnv();
    const v = await view(env);
    expect(v.library).toEqual({
      models: { live: 0, trashed: 0 },
      files: { "3mf": 0, stl: 0, step: 0, scad: 0 },
      plates: 0,
      blobs: { count: 0, bytes: 0 },
      lastImportAt: null,
    });
    expect(v.estimates).toMatchObject({
      done: 0,
      pending: 0,
      running: 0,
      failed: 0,
      total: 0,
      perMinute: null,
      secondsLeft: null,
      printerId: P1S,
    });
    for (const row of v.queues) expect([row.waiting, row.active, row.failed]).toEqual([0, 0, 0]);
    expect(v.events.items).toEqual([]);
    expect(v.events.inboxReadable).toBe(true);
    expect(v.working).toBe(false);
    expect(v.slicer).toEqual({
      reachable: true,
      busy: false,
      orca: ORCA,
      openscad: OPENSCAD,
      printerId: P1S,
      printerName: "Bambu Lab P1S, 0.4 mm nozzle",
      sandbox: "on",
      sandboxReason: null,
      sandboxKernel: null,
      unsandboxed: false,
    });
  });
});

describe("a library with trash, estimates, jobs and failures", () => {
  let env: Env;
  let v: ActivityView;
  let liveModel: string;
  let failedEstimate: string;
  let sliceFailedPlate: string;
  let renderFile: string;
  let stepFile: string;
  let previewFile: string;
  let apiModel: string;
  let uploadedModel: string;
  let plainModel: string;

  beforeAll(async () => {
    env = await startEnv();
    const db = env.db;
    await sql`update settings set last_orca_version = ${ORCA}`.execute(db);

    // A live model with a .3mf of three plates, an STL, a failing SCAD and a failing STEP.
    liveModel = await addModel(db, { name: "Live Model" });
    const tmf = await addFile(db, liveModel, "3mf", { size: 1000 });
    const plateA = await addPlate(db, tmf, 1, "Base");
    const plateB = await addPlate(db, tmf, 2);
    sliceFailedPlate = await addPlate(db, tmf, 3, "Lid");
    // Issue #380: an STL whose picture failed, from its own column.
    previewFile = await addFile(db, liveModel, "stl", {
      size: 200,
      name: "Hook.stl",
      previewStatus: "failed",
      previewMessage: "The preview picture could not be rendered. OpenSCAD said: ERROR: bad facet",
    });
    renderFile = await addFile(db, liveModel, "scad", {
      size: 30,
      name: "Knob.scad",
      derivedStatus: "failed",
      derivedMessage: 'ERROR: Parser error in file "/tmp/render-q1/input.scad", line 3',
    });
    stepFile = await addFile(db, liveModel, "step", {
      size: 400,
      name: "Bracket.step",
      derivedStatus: "failed",
      derivedMessage: "The slicer could not render this file.",
    });
    // A pending blob is not stored yet, so it is not counted.
    await addBlob(db, liveModel, 0, "pending");

    // Estimates for the selected printer and Orca version: 1 ok, 1 pending, 1 failed.
    await addEstimate(db, plateA, { status: "ok" });
    await addEstimate(db, plateB, { status: "pending" });
    failedEstimate = await addEstimate(db, sliceFailedPlate, {
      status: "failed",
      code: -51,
      reason: "bed_too_small",
      detail:
        "plate 3 exceeds bed, see /opt/orca/work/plate_3.json and http://slicer:8080/v1/slice",
    });
    // Not counted: another printer, an older Orca version, the file's own numbers.
    await addEstimate(db, plateA, { status: "failed", printerId: X1C });
    await addEstimate(db, plateB, { status: "ok", version: "2.4.2" });
    await addEstimate(db, plateA, { status: "ok", source: "file" });

    // A trashed model: counted as trashed, its blobs stored, nothing else.
    const trashed = await addModel(db, { name: "Trashed Model", trashed: true });
    const trashedFile = await addFile(db, trashed, "3mf", { size: 5000 });
    const trashedPlate = await addPlate(db, trashedFile, 1);
    await addEstimate(db, trashedPlate, { status: "failed" });
    await addFile(db, trashed, "scad", { derivedStatus: "failed", derivedMessage: "hidden" });

    // Where models came from.
    apiModel = await addModel(db, { name: "From Manyfold", externalRef: "manyfold:42" });
    const ingest = await env.boss.send(QUEUE.ingest, { originalName: "Upload.3mf" });
    if (ingest === null) throw new Error("no ingest job");
    const [fetched] = await env.boss.fetch(QUEUE.ingest);
    expect(fetched?.id).toBe(ingest);
    uploadedModel = await addModel(db, { name: "Uploaded" });
    await env.boss.complete(QUEUE.ingest, ingest, { modelId: uploadedModel, fileId: uuidv7() });
    plainModel = await addModel(db, { name: "From the inbox, perhaps" });

    // Live jobs: 3 slices queued, 1 render queued, 2 conversions queued, 1 ingest queued.
    for (let i = 0; i < 3; i++) await env.boss.send(QUEUE.slicer, { kind: "slice", n: i });
    await env.boss.send(QUEUE.slicer, { kind: "render-scad" });
    await env.boss.send(QUEUE.slicer, { kind: "convert-step", n: 1 });
    await env.boss.send(QUEUE.slicer, { kind: "convert-step", n: 2 });
    await env.boss.send(QUEUE.ingest, { originalName: "Waiting.3mf" });
    // A maintenance run that completed, one that failed, and one running.
    const purge = await env.boss.send(QUEUE.maintenance, { task: MAINTENANCE_TASKS.purgeExpired });
    const poll = await env.boss.send(QUEUE.maintenance, { task: MAINTENANCE_TASKS.pollOrca });
    const sweep = await env.boss.send(QUEUE.maintenance, { task: MAINTENANCE_TASKS.sweepUploads });
    const running = await env.boss.fetch(QUEUE.maintenance, { batchSize: 3 });
    expect(running.map((j) => j.id).sort()).toEqual([purge, poll, sweep].sort());
    await env.boss.complete(QUEUE.maintenance, purge as string);
    await env.boss.fail(QUEUE.maintenance, poll as string, { message: "synthetic" });
    await env.boss.schedule(
      QUEUE.maintenance,
      PURGE_EXPIRED_CRON,
      { task: MAINTENANCE_TASKS.purgeExpired },
      {
        key: MAINTENANCE_TASKS.purgeExpired,
        tz: "UTC",
      },
    );
    await env.boss.schedule(
      QUEUE.maintenance,
      POLL_ORCA_CRON,
      { task: MAINTENANCE_TASKS.pollOrca },
      {
        key: MAINTENANCE_TASKS.pollOrca,
        tz: "UTC",
      },
    );

    // A failed inbox file, its reason naming a path.
    await mkdir(join(env.inboxDir, "failed"));
    await writeFile(join(env.inboxDir, "failed", "Broken.3mf"), "x");
    await writeFile(
      join(env.inboxDir, "failed", "Broken.3mf.reason.txt"),
      `This file could not be read: ENOENT ${join(env.inboxDir, "Broken.3mf")}`,
    );

    v = await view(env);
  });

  test("counts live and trashed models apart, and files and plates on live models only", () => {
    expect(v.library.models).toEqual({ live: 4, trashed: 1 });
    expect(v.library.files).toEqual({ "3mf": 1, stl: 1, step: 1, scad: 1 });
    expect(v.library.plates).toBe(3);
  });

  test("counts every stored blob and its bytes, trashed models' included, pending ones not", () => {
    // Live: 1000 + 200 + 30 + 400; trashed: 5000 + 100.
    expect(v.library.blobs).toEqual({ count: 6, bytes: 6730 });
    expect(v.library.lastImportAt).not.toBeNull();
  });

  test("shows estimate progress for the default printer, named in full, and Orca version on live models", () => {
    expect(v.estimates).toMatchObject({
      printerId: P1S,
      printerName: "Bambu Lab P1S, 0.4 mm nozzle",
      orcaVersion: ORCA,
      done: 1,
      pending: 1,
      running: 0,
      failed: 1,
      total: 3,
    });
    expect(v.working).toBe(true);
  });

  test("lists a failed estimate with its model, plate, code, plain reason and scrubbed detail", () => {
    const events = v.events.items.filter((e) => e.type === "estimate_failed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      estimateId: failedEstimate,
      model: { id: liveModel, name: "Live Model" },
      plate: { index: 3, name: "Lid" },
      code: -51,
      reason: REASON_WORDS.bed_too_small,
      detail: "plate 3 exceeds bed, see [path] and [address]",
    });
    expect(sliceFailedPlate).toBeTruthy();
  });

  test("lists failed renders and conversions on live models, with the message scrubbed", () => {
    const events = v.events.items.filter((e) => e.type === "render_failed");
    expect(events.map((e) => (e.type === "render_failed" ? e.file.id : "")).sort()).toEqual(
      [renderFile, stepFile, previewFile].sort(),
    );
    const preview = events.find((e) => e.type === "render_failed" && e.kind === "preview");
    expect(preview).toMatchObject({
      file: { id: previewFile, name: "Hook.stl" },
      message: "The preview picture could not be rendered. OpenSCAD said: ERROR: bad facet",
      messageCodes: ["previewRejected"],
    });
    const scad = events.find((e) => e.type === "render_failed" && e.kind === "scad");
    expect(scad).toMatchObject({
      model: { id: liveModel, name: "Live Model" },
      file: { id: renderFile, name: "Knob.scad" },
      message: 'ERROR: Parser error in file "[path]", line 3',
    });
    const step = events.find((e) => e.type === "render_failed" && e.kind === "step");
    expect(step).toMatchObject({ message: "The slicer could not render this file." });
  });

  test("says where each model came from where that is recorded, newest first", () => {
    const models = v.events.items.filter((e) => e.type === "model_imported");
    const by = Object.fromEntries(
      models.map((e) => (e.type === "model_imported" ? [e.model.id, e.source] : ["", ""])),
    );
    expect(by[apiModel]).toBe("api");
    expect(by[uploadedModel]).toBe("upload");
    expect(by[plainModel]).toBe("unknown");
    expect(by[liveModel]).toBe("unknown");
    const trashed = models.find((e) => e.type === "model_imported" && e.model.trashed);
    expect(trashed).toBeDefined();
    const times = v.events.items.map((e) => e.at);
    expect([...times].sort().reverse()).toEqual(times);
  });

  test("lists the failed inbox file by name with its reason, and no path", () => {
    const inbox = v.events.items.filter((e) => e.type === "inbox_failed");
    expect(inbox).toEqual([
      expect.objectContaining({
        name: "Broken.3mf",
        reason: "This file could not be read: ENOENT [path]",
        // An older reason file, with no code first.
        reasonCode: null,
      }),
    ]);
  });

  test("counts live jobs by queue and job kind", () => {
    const by = Object.fromEntries(v.queues.map((r) => [r.id, [r.waiting, r.active, r.failed]]));
    expect(by).toEqual({
      ingest: [1, 0, 0],
      estimates: [3, 0, 0],
      renders: [1, 0, 0],
      step: [2, 0, 0],
      scheduled: [0, 1, 1],
    });
  });

  test("lists each scheduled task with its schedule and last run", () => {
    const purge = v.schedules.find((s) => s.key === MAINTENANCE_TASKS.purgeExpired);
    expect(purge).toMatchObject({ schedule: "Daily at 03:30 (UTC)", lastState: "completed" });
    expect(purge?.lastRunAt).not.toBeNull();
    const poll = v.schedules.find((s) => s.key === MAINTENANCE_TASKS.pollOrca);
    expect(poll).toMatchObject({ schedule: "Every 10 minutes (UTC)", lastState: "failed" });
  });

  test("holds no path, address or credential anywhere in the answer", () => {
    const text = JSON.stringify(v);
    expect(text).not.toContain(env.inboxDir);
    expect(text).not.toContain(tmp);
    expect(text).not.toMatch(/\/tmp\/|\/opt\/|slicer:8080|https?:\/\//);
  });

  test("leaves trashed models' failures out of the events", () => {
    const text = JSON.stringify(v.events.items);
    expect(text).not.toContain("hidden");
    const estimateModels = v.events.items
      .filter((e) => e.type === "estimate_failed")
      .map((e) => (e.type === "estimate_failed" ? e.model.name : ""));
    expect(estimateModels).not.toContain("Trashed Model");
  });

  test("a second read of an unchanged library answers the same", async () => {
    const again = await view(env);
    expect(again.library).toEqual(v.library);
    expect(again.estimates.total).toBe(v.estimates.total);
  });
});

describe("the slicer's health", () => {
  test("says unreachable when /v1/health fails", async () => {
    const env = await startEnv({
      health: async () => {
        throw new Error("The slicer could not be reached (ECONNREFUSED)");
      },
    });
    const v = await view(env);
    expect(v.slicer).toEqual({
      reachable: false,
      busy: null,
      orca: null,
      openscad: null,
      printerId: P1S,
      printerName: "Bambu Lab P1S, 0.4 mm nozzle",
      sandbox: null,
      sandboxReason: null,
      sandboxKernel: null,
      unsandboxed: null,
    });
  });

  test("does not wait on a slicer that never answers", async () => {
    const env = await startEnv({ health: () => new Promise<Health>(() => {}) }, 200);
    const started = Date.now();
    const v = await view(env);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(v.slicer.reachable).toBe(false);
  });
});
