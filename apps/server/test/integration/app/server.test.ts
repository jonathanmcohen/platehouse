// Build plan Task 30: start(config) boots the whole server against Postgres
// 17, the S3 test server and the contract-faithful slicer stub, and every
// part is wired:
// - every queue the app creates has a worker, and every slicer job kind and
//   maintenance task reaches its handler;
// - every cron is registered: purgeExpired 03:30, the orphan sweep 04:00, the
//   stale-upload sweep hourly, the Orca poll every 10 minutes (and once at
//   startup) and the render check every 15 minutes;
// - a .3mf dropped in the inbox becomes a model and its plates are queued for
//   estimates at once (the watcher's onIngested), a .scad dropped there gets
//   its render (ingest's afterCommit is derived.afterUpload);
// - an upload finished through the ingest queue, as tus queues it, is
//   ingested, its temp file deleted, its plates queued at once (the queue's
//   onIngested) and a .scad rendered;
// - an upload with no credentials gets 401 and stores nothing.
// The HTTP side of /healthz is here too; healthz.test.ts stops the database.
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "kysely";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { UPLOAD_PREFIXES } from "../../../src/app.js";
import { uuidv7 } from "../../../src/db/ids.js";
import { CHECK_RENDERS_CRON, DERIVED_KINDS } from "../../../src/derived/derived.js";
import { SLICE_JOB_KIND } from "../../../src/estimates/service.js";
import { createBoss } from "../../../src/jobs/boss.js";
import {
  localTimeZone,
  MAINTENANCE_TASKS,
  POLL_ORCA_CRON,
  PURGE_EXPIRED_CRON,
  QUEUE,
  SWEEP_ORPHANS_CRON,
  SWEEP_UPLOADS_CRON,
} from "../../../src/jobs/queues.js";
import { type Server, start } from "../../../src/main.js";
import { bossUploadQueue, uploadsDir } from "../../../src/uploads/tus.js";
import { build3mf, SCAD_TEXT } from "../support/ingest.js";
import {
  dropInInbox,
  healthStatus,
  type ServerEnv,
  startServerEnv,
  until,
} from "../support/server.js";

let env: ServerEnv;
let server: Server | undefined;
/** A second pg-boss on the same database: it sends and reads jobs and works none. */
let probe: PgBoss | undefined;

beforeAll(async () => {
  env = await startServerEnv();
  server = await start(env.config);
  probe = createBoss({ databaseUrl: env.dbUrl });
  await probe.start();
});

afterAll(async () => {
  await server?.stop();
  await probe?.stop({ graceful: false });
  await env?.stop();
});

function boss(): PgBoss {
  if (probe === undefined) throw new Error("the probe boss did not start");
  return probe;
}

/** Sends a job and waits until a worker has taken it and finished, either way. */
async function settled(queue: string, data: object) {
  const id = await boss().send(queue, data, { retryLimit: 0 });
  if (id === null) throw new Error("job not created");
  const job = await until(
    () => boss().getJobById(queue, id),
    (j) => j?.state === "completed" || j?.state === "failed",
    30_000,
  );
  if (!job) throw new Error("job vanished");
  return job;
}

async function fileNamed(originalName: string) {
  return env.db
    .selectFrom("files")
    .selectAll()
    .where("originalName", "=", originalName)
    .executeTakeFirst();
}

async function platehouseEstimates(fileId: string) {
  return env.db
    .selectFrom("estimates as e")
    .innerJoin("plates as p", "p.id", "e.plateId")
    .select(["e.id", "e.status", "e.createdAt", "p.index"])
    .where("p.fileId", "=", fileId)
    .where("e.source", "=", "platehouse")
    .orderBy("p.index")
    .execute();
}

/** The library's rows and objects, and the uploads folder. */
async function footprint() {
  const { rows } = await sql<{ models: number; files: number; blobs: number }>`select
      (select count(*)::int from models) as models,
      (select count(*)::int from files) as files,
      (select count(*)::int from blobs) as blobs`.execute(env.db);
  let uploads: string[] = [];
  try {
    uploads = await readdir(uploadsDir(env.tmpDir));
  } catch {
    uploads = [];
  }
  return { ...rows[0], uploads: uploads.sort() };
}

describe("health", () => {
  test("/healthz answers 200 once the server has started", async () => {
    expect(await healthStatus(env)).toBe(200);
  });

  test("the Orca poll ran at startup", async () => {
    expect((await env.repos.settings.get()).lastOrcaVersion).toBe("2.5.0");
  });
});

describe("queues and workers", () => {
  test("the app creates the ingest, slicer and maintenance queues", async () => {
    const names = (await boss().getQueues())
      .map((q) => q.name)
      .filter((name) => !name.startsWith("__pgboss__"))
      .sort();
    expect(names).toEqual(Object.values(QUEUE).sort());
  });

  test("every queue the app creates has a worker", async () => {
    const names = (await boss().getQueues())
      .map((q) => q.name)
      .filter((name) => !name.startsWith("__pgboss__"));
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      // A job no handler knows: a worker takes it and fails it; with no
      // worker it would wait in 'created' until the test times out.
      const job = await settled(name, { kind: "no-such-kind", task: "no-such-task" });
      expect(job.state, name).toBe("failed");
    }
  });

  test("every slicer job kind reaches its own handler", async () => {
    for (const kind of [SLICE_JOB_KIND, DERIVED_KINDS.renderScad, DERIVED_KINDS.convertStep]) {
      const job = await settled(QUEUE.slicer, {
        kind,
        estimateId: uuidv7(),
        printerId: "Bambu Lab P1S 0.4 nozzle",
        fileId: uuidv7(),
        sourceBlobId: uuidv7(),
      });
      expect(JSON.stringify(job.output ?? null), kind).not.toMatch(/Unknown slicer job kind/);
    }
  });

  test("every maintenance task runs to completion", async () => {
    for (const task of Object.values(MAINTENANCE_TASKS)) {
      const job = await settled(QUEUE.maintenance, { task });
      expect(job.state, `${task}: ${JSON.stringify(job.output ?? null)}`).toBe("completed");
    }
  });
});

describe("schedules", () => {
  test("every maintenance task is scheduled, at its time", async () => {
    const schedules = await boss().getSchedules(QUEUE.maintenance);
    const byKey = new Map(schedules.map((s) => [s.key, s]));
    expect([...byKey.keys()].sort()).toEqual(Object.values(MAINTENANCE_TASKS).sort());
    const expected: Record<string, string> = {
      [MAINTENANCE_TASKS.purgeExpired]: "30 3 * * *",
      [MAINTENANCE_TASKS.sweepOrphans]: "0 4 * * *",
      [MAINTENANCE_TASKS.sweepUploads]: "0 * * * *",
      [MAINTENANCE_TASKS.pollOrca]: "*/10 * * * *",
      [MAINTENANCE_TASKS.checkRenders]: "*/15 * * * *",
    };
    for (const [key, cron] of Object.entries(expected)) {
      expect(byKey.get(key)).toMatchObject({
        name: QUEUE.maintenance,
        key,
        cron,
        timezone: localTimeZone(),
        data: { task: key },
      });
    }
    expect([
      PURGE_EXPIRED_CRON,
      SWEEP_ORPHANS_CRON,
      SWEEP_UPLOADS_CRON,
      POLL_ORCA_CRON,
      CHECK_RENDERS_CRON,
    ]).toEqual(["30 3 * * *", "0 4 * * *", "0 * * * *", "*/10 * * * *", "*/15 * * * *"]);
  });
});

describe("the inbox", () => {
  test("a .3mf dropped in the inbox becomes a model, its plates queued at once", async () => {
    const name = `Inbox cube ${uuidv7().slice(-8)}.3mf`;
    const path = await dropInInbox(env, name, build3mf({ plates: 2 }));
    const file = await until(
      () => fileNamed(name),
      (f) => f !== undefined,
    );
    if (!file) throw new Error("no file row");
    await until(
      () =>
        stat(path).then(
          () => true,
          () => false,
        ),
      (exists) => !exists,
    );
    const queued = await until(
      () => platehouseEstimates(file.id),
      (rows) => rows.length === 2,
    );
    // Queued by onIngested as the file was stored, not by a later Orca poll.
    for (const row of queued) {
      expect(row.createdAt.getTime() - file.createdAt.getTime()).toBeLessThan(5_000);
    }
    const done = await until(
      () => platehouseEstimates(file.id),
      (rows) => rows.every((r) => r.status === "ok"),
    );
    expect(done.map((r) => r.index)).toEqual([1, 2]);
  });

  test("a .scad dropped in the inbox gets its STL and preview", async () => {
    const name = `Inbox part ${uuidv7().slice(-8)}.scad`;
    await dropInInbox(env, name, SCAD_TEXT);
    const file = await until(
      () => fileNamed(name),
      (f) => f?.derivedStatus === "ok",
    );
    expect(file?.renderStlBlobId).not.toBeNull();
    expect(file?.renderPngBlobId).not.toBeNull();
  });
});

describe("uploads finished through the ingest queue", () => {
  /** Puts bytes where tus leaves a finished upload and queues it as tus does. */
  async function finishUpload(originalName: string, bytes: Buffer | string) {
    const id = uuidv7();
    const dir = uploadsDir(env.tmpDir);
    await mkdir(dir, { recursive: true });
    const tmpPath = join(dir, id);
    await writeFile(tmpPath, bytes);
    const queue = bossUploadQueue(boss());
    await queue.enqueue(id, { tmpPath, originalName, target: "new" });
    const result = await until(
      () => queue.result(id),
      (r) => r?.status === "done" || r?.status === "failed",
    );
    return { id, tmpPath, result };
  }

  test("a .3mf is ingested, its temp file deleted and its plates queued at once", async () => {
    const name = `Uploaded cube ${uuidv7().slice(-8)}.3mf`;
    const { tmpPath, result } = await finishUpload(name, build3mf({ plates: 1 }));
    expect(result?.status).toBe("done");
    await expect(stat(tmpPath)).rejects.toMatchObject({ code: "ENOENT" });
    const file = await fileNamed(name);
    if (!file) throw new Error("no file row");
    const queued = await until(
      () => platehouseEstimates(file.id),
      (rows) => rows.length === 1,
    );
    expect(queued[0]?.createdAt.getTime() ?? Number.NaN).toBeLessThan(
      file.createdAt.getTime() + 5_000,
    );
  });

  test("a .scad is rendered once its row commits", async () => {
    const name = `Uploaded part ${uuidv7().slice(-8)}.scad`;
    const { result } = await finishUpload(name, SCAD_TEXT);
    expect(result?.status).toBe("done");
    const file = await until(
      () => fileNamed(name),
      (f) => f?.derivedStatus === "ok",
    );
    expect(file?.renderStlBlobId).not.toBeNull();
  });
});

describe("the upload routes", () => {
  test("an upload with no credentials gets 401 and stores nothing", async () => {
    const before = await footprint();
    for (const prefix of [UPLOAD_PREFIXES.api, UPLOAD_PREFIXES.app]) {
      const res = await fetch(`${env.baseUrl}${prefix}`, {
        method: "POST",
        headers: {
          "tus-resumable": "1.0.0",
          "upload-length": "11",
          "upload-metadata": `filename ${Buffer.from("cube.stl").toString("base64")}`,
        },
      });
      await res.arrayBuffer();
      expect(res.status, prefix).toBe(401);
    }
    expect(await footprint()).toEqual(before);
  });
});
