// Build plan Task 21: the app API behind the settings, trash and organising
// pages (AC-013 warning, AC-031 menu, AC-060, AC-061, AC-062, AC-063 UI,
// AC-083 UI). Every route is under /app/api and session-class: it needs a
// live session, and every state-changing one needs Origin to be
// PUBLIC_ORIGIN (Task 15's gate), so the token routes here are for Jon's UI
// and separate from the bearer API.
//
// Everything is real but the login: a migrated Postgres 17 and a bucket on
// the S3 test server made without versioning, pg-boss with the ingest and
// slicer queues, estimates (Task 12) against the contract-faithful slicer
// stub, tokens in api_tokens (Task 16), and the trash (Task 14). The request
// log is captured from buildApp's logger stream, and the last test reads it:
// no token this file made appears in any line, with or without its prefix.
// Sessions are in memory (Task 15's test support). Every file is generated.
import { setTimeout as sleep } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  createTokens,
  dbTokenStore,
  TOKEN_PATTERN,
  TOKEN_PREFIX,
  type Tokens,
} from "../../../src/api/tokens.js";
import { createApiLibrary } from "../../../src/api/v1.js";
import { buildApp } from "../../../src/app.js";
import { recordVersioning } from "../../../src/app-api/settings.js";
import { dbTokenList } from "../../../src/app-api/tokens.js";
import { patternClass } from "../../../src/auth/gate.js";
import { SESSION_COOKIE } from "../../../src/auth/sessions.js";
import { createSlicerClient } from "../../../src/estimates/client.js";
import { createEstimates, type Estimates } from "../../../src/estimates/service.js";
import type { IngestInput, IngestResult } from "../../../src/ingest/ingest.js";
import { createBoss } from "../../../src/jobs/boss.js";
import { QUEUE, startQueues } from "../../../src/jobs/queues.js";
import { createTrash } from "../../../src/library/trash.js";
import { StoreUnavailable } from "../../../src/storage/s3.js";
import { createUploads } from "../../../src/uploads/tus.js";
import { NOT_BUILT } from "../../../src/web/shell.js";
import { type SlicerStub, STUB_PRINTERS, startSlicerStub } from "../../support/slicer-stub.js";
import { build3mf, type IngestEnv, startIngestEnv, writeUpload } from "../support/ingest.js";
import { marker, rowCounts, seedStoredModel } from "../support/library.js";
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

/** One request to the app with Jon's session and a same-origin Origin, unless told otherwise. */
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
  await startQueues(boss, {
    ingestFile: (input) => env.ingest.ingestFile(input),
    purgeExpired: async () => ({ purged: [] }),
    sweepOrphans: async () => ({ listed: 0, deleted: 0, outsideLayout: 0 }),
    sweepUploads: async () => undefined,
    slicerJobs: estimates.slicerJobs,
    pollOrca: () => estimates.pollOrca(),
    onIngested: (result) => estimates.enqueueFile(result.fileId),
    pollingIntervalSeconds: 0.5,
  });
  tokens = createTokens({ store: dbTokenStore(env.db) });
  auth = await testAuth();
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
        plateNumbers: (id) => estimates.plateNumbers(id),
      }),
    },
    appApi: {
      settings: { settings: env.repos.settings, estimates },
      tokens: { tokens, list: dbTokenList(env.db) },
      organise: { db: env.db, trash: createTrash({ db: env.db, store: env.store }) },
    },
    logger: { write: (line: string) => lines.push(line) },
  });
  await app.ready();
  session = (await auth.sessions.start("jon")).id;
});

afterAll(async () => {
  await app?.close();
  await auth?.issuer.stop();
  await boss?.stop({ graceful: false });
  await stub?.stop();
  await env?.stop();
});

describe("the settings page", () => {
  beforeEach(async () => {
    stub.onSlice(() => ({ kind: "ok" }));
    await drain();
    if ((await env.repos.settings.get()).printerId !== P1S) {
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

  test("the printer menu is the slicer's printers, grouped by model with nozzle choices", async () => {
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
        })),
      })),
    );
  });

  test("changing printer queues re-estimation and the old numbers stay marked", async () => {
    const plateId = await uploadPlate();
    await drain();
    expect((await estimates.plateNumbers(plateId)).platehouse).toMatchObject({
      state: "current",
      printerId: P1S,
    });

    const held = stub.hold();
    try {
      const res = await call("PUT", "/app/api/settings/printer", { json: { printerId: X1C } });
      expect(res.status, res.text).toBe(204);
      expect((await env.repos.settings.get()).printerId).toBe(X1C);
      expect((await call("GET", "/app/api/settings")).json()).toMatchObject({ printerId: X1C });
      // Re-estimation is queued: the plate has an X1C estimate waiting.
      await until(
        async () =>
          (
            await env.db
              .selectFrom("estimates")
              .select("printerId")
              .where("plateId", "=", plateId)
              .where("source", "=", "platehouse")
              .execute()
          ).some((r) => r.printerId === X1C),
        (v) => v,
      );
      // The old numbers stay visible, marked as for the previous printer.
      expect((await estimates.plateNumbers(plateId)).platehouse).toMatchObject({
        state: "stale",
        staleFor: P1S,
        printerId: P1S,
      });
    } finally {
      held.release();
    }
    await drain();
    expect((await estimates.plateNumbers(plateId)).platehouse).toMatchObject({
      state: "current",
      printerId: X1C,
    });
  });

  test("a printer that is not in the menu is refused and the setting stays", async () => {
    for (const body of [{ printerId: "Bambu Lab Q9 0.4 nozzle" }, { printerId: "" }, {}]) {
      const res = await call("PUT", "/app/api/settings/printer", { json: body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await env.repos.settings.get()).printerId).toBe(P1S);
  });
});

describe("API tokens", () => {
  test("new token is shown once and never again", async () => {
    const { res, created } = await makeToken("Claude Code on mini01");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(TOKEN_PATTERN.test(created.token)).toBe(true);
    expect(created.name).toBe("Claude Code on mini01");
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
      name: "Claude Code on mini01",
      prefix: created.prefix,
      createdAt: created.createdAt,
      lastUsedAt: null,
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
    const tagPath = (id: string) => `/app/api/models/${id}/tags/${encodeURIComponent(tag)}`;
    const shelfPath = (name: string, id: string) =>
      `/app/api/collections/${encodeURIComponent(name)}/models/${id}`;

    for (const id of [a.model.id, b.model.id]) {
      const put = await call("PUT", tagPath(id));
      expect(put.status, put.text).toBe(204);
    }
    for (const name of [shelf, desk]) {
      const put = await call("PUT", shelfPath(name, a.model.id));
      expect(put.status, put.text).toBe(204);
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

  test("a trashed model cannot be renamed, tagged or put in a collection", async () => {
    const seeded = await seedStoredModel(env);
    const id = seeded.model.id;
    expect((await call("POST", `/app/api/models/${id}/trash`)).status).toBe(204);
    const refused = [
      await call("PATCH", `/app/api/models/${id}`, { json: { name: "x" } }),
      await call("PATCH", `/app/api/files/${seeded.file.id}`, { json: { name: "x" } }),
      await call("PUT", `/app/api/models/${id}/tags/t`),
      await call("PUT", `/app/api/collections/c/models/${id}`),
      await call("POST", `/app/api/models/${id}/trash`),
    ];
    expect(refused.map((r) => r.status)).toEqual([404, 404, 404, 404, 404]);
  });
});

describe("the trash", () => {
  test("lists each trashed model with its purge date, and restore brings it back", async () => {
    const tag = `kept-${marker()}`;
    const seeded = await seedStoredModel(env);
    await call("PUT", `/app/api/models/${seeded.model.id}/tags/${tag}`);
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

  test("empty trash purges every trashed model, its rows and its bucket objects", async () => {
    const a = await seedStoredModel(env);
    const b = await seedStoredModel(env);
    const live = await seedStoredModel(env);
    for (const m of [a, b]) await call("POST", `/app/api/models/${m.model.id}/trash`);

    const res = await call("POST", "/app/api/trash/empty");
    expect(res.status, res.text).toBe(200);
    expect((res.json() as { purged: number }).purged).toBeGreaterThanOrEqual(2);
    for (const m of [a, b]) {
      expect(await env.store.listPrefix(`models/${m.model.id}/`)).toEqual([]);
      expect((await rowCounts(env.db, m.model.id)).models).toBe(0);
    }
    expect((await rowCounts(env.db, live.model.id)).models).toBe(1);
    expect((await call("GET", "/app/api/trash")).json()).toEqual({ models: [] });
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
    const res = await call("POST", "/app/api/trash/empty", { origin: "https://evil.test" });
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
  });
});
