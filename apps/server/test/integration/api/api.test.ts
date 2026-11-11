// Build plan Task 16: per-client tokens and the Public API v1, against
// Postgres 17 and the S3 test server (AC-081 token half, AC-082 app side,
// AC-083, AC-084, AC-085, AC-091 for the API description).
//
// Everything is real but the login: tokens in api_tokens, the library over
// the database and the bucket, the tus upload handler on pg-boss's ingest
// queue with ingestFile behind it, and the request log, which this file
// captures from buildApp's logger stream for every request it makes. The
// last test reads that log: no token this file used, live, revoked or made
// up, appears in any line, with or without its ph_ prefix. The issuer is
// Task 15's local mock, stopped for the AC-081 test.
//
// Every token is made by the run and every file is generated; nothing here
// is a real secret or a designer file.
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  createTokens,
  dbTokenStore,
  TOKEN_BODY_LENGTH,
  TOKEN_PREFIX,
  type Tokens,
} from "../../../src/api/tokens.js";
import { createApiLibrary } from "../../../src/api/v1.js";
import { SESSION_COOKIE } from "../../../src/auth/sessions.js";
import { type DisplayContext, plateNumbers } from "../../../src/estimates/display.js";
import { createBoss } from "../../../src/jobs/boss.js";
import { startQueues } from "../../../src/jobs/queues.js";
import { bossUploadQueue, createUploads, type Uploads } from "../../../src/uploads/tus.js";
import { meta, OCTET, TUS } from "../../uploads/support/http.js";
import { ASCII_STL, build3mf, type IngestEnv, startIngestEnv } from "../support/ingest.js";
import { marker } from "../support/library.js";
import {
  type AuthTestApp,
  authTestApp,
  registeredRoutes,
  TEST_ORIGIN,
} from "../support/oidc-issuer.js";

/** What plateNumbers is given: the default printer, no slicer menu. */
const CONTEXT: DisplayContext = {
  printerId: "Bambu Lab P1S 0.4 nozzle",
  orcaVersion: null,
  printers: [],
};

let env: IngestEnv;
let boss: PgBoss;
let uploads: Uploads;
let tokens: Tokens;
let t: AuthTestApp;
let base: string;
/** Every line the app logged. */
const lines: string[] = [];
/** Every token value this file sent, so the log check can look for each. */
const sentTokens: string[] = [];
let token: string;

interface Answer {
  status: number;
  headers: Headers;
  text: string;
  json(): unknown;
}

/** One request to the listening app; auth is a token, or false for none. */
async function call(
  method: string,
  path: string,
  opts: { auth?: string | false; json?: unknown; headers?: Record<string, string> } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { ...opts.headers };
  const auth = opts.auth ?? token;
  if (auth !== false) headers.authorization = `Bearer ${auth}`;
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json);
  }
  const res = await fetch(`${base}${path}`, { method, headers, ...(body ? { body } : {}) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: () => JSON.parse(text) };
}

/** A token of this suite's own, remembered for the log check. */
async function newToken(name: string) {
  const created = await tokens.createToken(name);
  sentTokens.push(created.token);
  return created;
}

interface UploadOutcome {
  status: string;
  modelId?: string;
  fileId?: string;
  error?: string;
}

/** A whole tus upload through /api/v1/uploads: create, one PATCH, then the result. */
async function upload(
  name: string,
  bytes: Buffer | string,
  fields: Record<string, string> = {},
): Promise<UploadOutcome> {
  const body = Buffer.from(bytes);
  const created = await call("POST", "/api/v1/uploads", {
    headers: {
      ...TUS,
      "upload-length": String(body.length),
      "upload-metadata": meta({ filename: name, ...fields }),
    },
  });
  expect(created.status, created.text).toBe(201);
  const location = created.headers.get("location");
  expect(location).toMatch(/^\/api\/v1\/uploads\/[0-9a-f-]{36}$/);
  const patch = await fetch(`${base}${location}`, {
    method: "PATCH",
    headers: {
      ...TUS,
      authorization: `Bearer ${token}`,
      "upload-offset": "0",
      "content-type": OCTET,
    },
    body,
  });
  expect(patch.status).toBe(204);
  await patch.arrayBuffer();
  const end = Date.now() + 60_000;
  for (;;) {
    const res = await call("GET", `${location}/result`);
    expect(res.status).toBe(200);
    const outcome = res.json() as UploadOutcome;
    if (outcome.status !== "pending") return outcome;
    if (Date.now() > end) throw new Error("the upload's ingest did not finish");
    await sleep(200);
  }
}

async function createModel(fields: Record<string, unknown>) {
  const res = await call("POST", "/api/v1/models", { json: fields });
  expect(res.status, res.text).toBe(201);
  return (res.json() as { model: { id: string; name: string } }).model;
}

async function uploadFiles(): Promise<string[]> {
  try {
    return await readdir(uploads.dir);
  } catch {
    return [];
  }
}

beforeAll(async () => {
  env = await startIngestEnv();
  boss = createBoss({ databaseUrl: env.url });
  await boss.start();
  uploads = createUploads({
    tmpDir: join(env.dir, "tmp"),
    queue: bossUploadQueue(boss),
    log: () => {},
  });
  await startQueues(boss, {
    ingestFile: uploads.ingestUpload(env.ingest.ingestFile),
    purgeExpired: async () => ({}),
    sweepOrphans: async () => ({}),
    sweepUploads: (now: Date) => uploads.sweepStaleUploads(now),
    pollingIntervalSeconds: 0.5,
  });
  tokens = createTokens({ store: dbTokenStore(env.db) });
  const library = createApiLibrary({
    db: env.db,
    store: env.store,
    plateNumbers: (id) => plateNumbers(env.db, CONTEXT, id),
  });
  t = await authTestApp({
    api: { tokens, library },
    uploads,
    logger: {
      write(line: string) {
        lines.push(line);
      },
    },
  });
  await t.app.listen({ port: 0, host: "127.0.0.1" });
  const address = t.app.server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  base = `http://127.0.0.1:${address.port}`;
  token = (await newToken("api suite")).token;
});

afterAll(async () => {
  await t?.close();
  await boss?.stop({ graceful: false });
  await env?.stop();
});

describe("the bearer check", () => {
  test("missing or bad token is 401 JSON", async () => {
    const revoked = await newToken("revoked");
    expect(await tokens.revokeToken(revoked.id)).toBe(true);
    const madeUp = `${TOKEN_PREFIX}${"k".repeat(TOKEN_BODY_LENGTH)}`;
    sentTokens.push(madeUp);
    const bad: Array<[string, Record<string, string>]> = [
      ["no header", {}],
      ["an empty header", { authorization: "" }],
      ["the scheme alone", { authorization: "Bearer" }],
      ["another scheme", { authorization: `Basic ${token}` }],
      ["no scheme", { authorization: token }],
      ["a token nobody issued", { authorization: `Bearer ${madeUp}` }],
      ["a revoked token", { authorization: `Bearer ${revoked.token}` }],
      ["a token cut short", { authorization: `Bearer ${token.slice(0, -1)}` }],
      ["a token without its prefix", { authorization: `Bearer ${token.slice(3)}` }],
    ];
    for (const [label, headers] of bad) {
      for (const [method, path] of [
        ["GET", "/api/v1/models"],
        ["GET", "/api/v1/openapi.json"],
        ["POST", "/api/v1/models"],
        ["POST", "/api/v1/uploads"],
      ] as const) {
        const res = await call(method, path, { auth: false, headers: { ...TUS, ...headers } });
        const what = `${method} ${path} with ${label}`;
        expect(res.status, what).toBe(401);
        expect(res.headers.get("content-type"), what).toMatch(/^application\/json/);
        expect(res.json(), what).toEqual({ error: "unauthorized" });
        expect(res.headers.get("www-authenticate"), what).toBe("Bearer");
      }
    }
  });

  test("a cookie alone does not authenticate the API", async () => {
    const session = await t.sessions.start("jon");
    const cookie = `${SESSION_COOKIE}=${session.id}; ph_token=${token}`;
    const alone = await call("GET", "/api/v1/models", { auth: false, headers: { cookie } });
    expect(alone.status).toBe(401);
    expect(alone.json()).toEqual({ error: "unauthorized" });
    const withToken = await call("GET", "/api/v1/models", { headers: { cookie } });
    expect(withToken.status).toBe(200);
  });

  test("revoking one token leaves the other working", async () => {
    const keep = await newToken("keep");
    const drop = await newToken("drop");
    for (const created of [keep, drop]) {
      expect((await call("GET", "/api/v1/models", { auth: created.token })).status).toBe(200);
    }
    expect(await tokens.revokeToken(drop.id)).toBe(true);
    expect((await call("GET", "/api/v1/models", { auth: drop.token })).status).toBe(401);
    expect((await call("GET", "/api/v1/models", { auth: keep.token })).status).toBe(200);
    const rows = await env.db.selectFrom("apiTokens").selectAll().execute();
    const dropRow = rows.find((r) => r.id === drop.id);
    expect(dropRow?.revokedAt).toBeInstanceOf(Date);
    expect(rows.find((r) => r.id === keep.id)?.revokedAt).toBeNull();
    expect(rows.find((r) => r.id === keep.id)?.lastUsedAt).toBeInstanceOf(Date);
    const table = JSON.stringify(rows, (_key, value) =>
      value?.type === "Buffer" ? Buffer.from(value.data).toString("hex") : value,
    );
    for (const created of [keep, drop]) {
      expect(table).not.toContain(created.token);
      expect(table).not.toContain(created.token.slice(TOKEN_PREFIX.length));
      const row = rows.find((r) => r.id === created.id);
      expect(row?.prefix).toBe(created.token.slice(0, 8));
      expect(row?.tokenHash.equals(createHash("sha256").update(created.token).digest())).toBe(true);
    }
  });
});

describe("the operations", () => {
  test("upload new: a file sent without a model becomes a model of its own", async () => {
    const name = `Bracket ${marker()}.stl`;
    const outcome = await upload(name, ASCII_STL);
    expect(outcome.status, outcome.error).toBe("done");
    const res = await call("GET", `/api/v1/models/${outcome.modelId}`);
    expect(res.status).toBe(200);
    const model = res.json() as { id: string; files: Array<{ id: string; originalName: string }> };
    expect(model.id).toBe(outcome.modelId);
    expect(model.files.map((f) => f.originalName)).toEqual([name]);
    expect(model.files[0]?.id).toBe(outcome.fileId);
  });

  test("upload into existing: modelId adds the file to that model", async () => {
    const model = await createModel({ name: `Into existing ${marker()}` });
    const first = await upload("part-a.stl", ASCII_STL, { modelId: model.id });
    const second = await upload("part-b.stl", ASCII_STL, { modelId: model.id });
    for (const outcome of [first, second]) {
      expect(outcome.status, outcome.error).toBe("done");
      expect(outcome.modelId).toBe(model.id);
    }
    const res = await call("GET", `/api/v1/models/${model.id}`);
    const files = (res.json() as { files: Array<{ originalName: string }> }).files;
    expect(files.map((f) => f.originalName).sort()).toEqual(["part-a.stl", "part-b.stl"]);
  });

  test("upload into a trashed model is 404 and stores nothing", async () => {
    const model = await createModel({ name: `Trashed target ${marker()}` });
    expect(await env.repos.models.trash(model.id)).toBe(true);
    const before = await uploadFiles();
    for (const modelId of [model.id, "0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8e9f"]) {
      const res = await call("POST", "/api/v1/uploads", {
        headers: {
          ...TUS,
          "upload-length": String(ASCII_STL.length),
          "upload-metadata": meta({ filename: "late.stl", modelId }),
        },
      });
      expect(res.status, modelId).toBe(404);
      expect(res.json(), modelId).toEqual({ error: "not_found" });
    }
    expect(await uploadFiles()).toEqual(before);
    const files = await env.db
      .selectFrom("files")
      .select("id")
      .where("modelId", "=", model.id)
      .execute();
    expect(files).toEqual([]);
  });

  test("search: q, tag, collection, creator and externalRef, paged, trashed excluded", async () => {
    const m = marker();
    const a = await createModel({
      name: `Search alpha ${m}`,
      creator: `Maker ${m}`,
      tags: [`tag-${m}`],
      collections: [`Shelf ${m}`],
      externalRef: `manyfold:a${m}`,
    });
    const b = await createModel({ name: `Search beta ${m}`, tags: [`tag-${m}`] });
    const gone = await createModel({ name: `Search gamma ${m}`, tags: [`tag-${m}`] });
    expect(await env.repos.models.trash(gone.id)).toBe(true);

    const ids = async (query: string) => {
      const res = await call("GET", `/api/v1/models?${query}`);
      expect(res.status, query).toBe(200);
      return (res.json() as { models: Array<{ id: string }> }).models.map((x) => x.id).sort();
    };
    const q = encodeURIComponent;
    expect(await ids(`q=${q(m)}`)).toEqual([a.id, b.id].sort());
    expect(await ids(`tag=${q(`TAG-${m}`)}`)).toEqual([a.id, b.id].sort());
    expect(await ids(`collection=${q(`shelf ${m}`)}`)).toEqual([a.id]);
    expect(await ids(`creator=${q(`Maker ${m}`)}`)).toEqual([a.id]);
    expect(await ids(`externalRef=${q(`manyfold:a${m}`)}`)).toEqual([a.id]);
    expect(await ids(`externalRef=${q(`manyfold:none${m}`)}`)).toEqual([]);

    const page1 = await call("GET", `/api/v1/models?q=${q(m)}&limit=1`);
    const p1 = page1.json() as { models: Array<{ id: string }>; nextCursor: string | null };
    expect(p1.models).toHaveLength(1);
    expect(p1.nextCursor).toEqual(expect.any(String));
    const page2 = await call(
      "GET",
      `/api/v1/models?q=${q(m)}&limit=1&cursor=${q(p1.nextCursor ?? "")}`,
    );
    const p2 = page2.json() as { models: Array<{ id: string }>; nextCursor: string | null };
    expect(p2.models).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    expect([p1.models[0]?.id, p2.models[0]?.id].sort()).toEqual([a.id, b.id].sort());

    const listed = (await call("GET", `/api/v1/models?q=${q(m)}`)).json() as {
      models: Array<Record<string, unknown>>;
    };
    expect(listed.models.find((x) => x.id === a.id)).toMatchObject({
      name: `Search alpha ${m}`,
      creator: `Maker ${m}`,
      tags: [`tag-${m}`],
      collections: [`Shelf ${m}`],
      externalRef: `manyfold:a${m}`,
    });

    for (const bad of [
      "cursor=not-a-cursor",
      "limit=0",
      "limit=201",
      "limit=x",
      `externalRef=${q("manyfold:1")}&q=x`,
    ]) {
      const res = await call("GET", `/api/v1/models?${bad}`);
      expect(res.status, bad).toBe(400);
    }
  });

  test("read model with plates and estimates, its file and the file's bytes", async () => {
    const bytes = build3mf({ plates: 2, sliced: [1] });
    const outcome = await upload(`Plates ${marker()}.3mf`, bytes);
    expect(outcome.status, outcome.error).toBe("done");
    const res = await call("GET", `/api/v1/models/${outcome.modelId}`);
    expect(res.status).toBe(200);
    const model = res.json() as {
      files: Array<{
        id: string;
        kind: string;
        size: number;
        sha256: string;
        parseStatus: string;
        plates: Array<{
          index: number;
          objectCount: number;
          numbers: { file?: { timeSeconds: number | null; weightGrams: number | null } };
        }>;
      }>;
    };
    const file = model.files[0];
    expect(file?.kind).toBe("3mf");
    expect(file?.parseStatus).toBe("ok");
    expect(file?.size).toBe(bytes.length);
    expect(file?.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(file?.plates.map((p) => p.index)).toEqual([1, 2]);
    expect(file?.plates[0]?.numbers.file?.timeSeconds).toBeGreaterThan(0);
    expect(file?.plates[0]?.numbers.file?.weightGrams).toBeGreaterThan(0);
    expect(file?.plates[1]?.numbers.file).toBeUndefined();

    const meta1 = await call("GET", `/api/v1/files/${file?.id}`);
    expect(meta1.status).toBe(200);
    expect(meta1.json()).toMatchObject({ id: file?.id, modelId: outcome.modelId, kind: "3mf" });

    const content = await fetch(`${base}/api/v1/files/${file?.id}/content`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(content.status).toBe(200);
    expect(content.headers.get("content-disposition")).toMatch(/^attachment; filename="/);
    expect(content.headers.get("content-type")).toBe("model/3mf");
    const got = Buffer.from(await content.arrayBuffer());
    expect(got.equals(bytes)).toBe(true);

    expect(await env.repos.models.trash(outcome.modelId ?? "")).toBe(true);
    for (const path of [
      `/api/v1/models/${outcome.modelId}`,
      `/api/v1/files/${file?.id}`,
      `/api/v1/files/${file?.id}/content`,
    ]) {
      const gone = await call("GET", path);
      expect(gone.status, path).toBe(404);
      expect(gone.json(), path).toEqual({ error: "not_found" });
    }
  });

  test("add and remove tag", async () => {
    const model = await createModel({ name: `Tagged ${marker()}` });
    const tag = "Big things/Shelf 2";
    const path = `/api/v1/models/${model.id}/tags/${encodeURIComponent(tag)}`;
    const tagsOf = async () =>
      ((await call("GET", `/api/v1/models/${model.id}`)).json() as { tags: string[] }).tags;

    const put = await call("PUT", path);
    expect(put.status).toBe(204);
    expect(put.text).toBe("");
    expect((await call("PUT", path)).status).toBe(204);
    expect(await tagsOf()).toEqual([tag]);
    expect((await call("DELETE", path)).status).toBe(204);
    expect(await tagsOf()).toEqual([]);
    expect((await call("DELETE", path)).status).toBe(204);

    const unknown = "/api/v1/models/0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8e9f/tags/x";
    for (const method of ["PUT", "DELETE"]) {
      expect((await call(method, unknown)).status, method).toBe(404);
    }
    expect(await env.repos.models.trash(model.id)).toBe(true);
    for (const method of ["PUT", "DELETE"]) {
      expect((await call(method, path)).status, method).toBe(404);
    }
  });

  test("add and remove collection membership", async () => {
    const model = await createModel({ name: `Collected ${marker()}` });
    const collection = `Garage ${marker()}`;
    const path = `/api/v1/collections/${encodeURIComponent(collection)}/models/${model.id}`;
    const collectionsOf = async () =>
      ((await call("GET", `/api/v1/models/${model.id}`)).json() as { collections: string[] })
        .collections;

    expect((await call("PUT", path)).status).toBe(204);
    expect(await collectionsOf()).toEqual([collection]);
    expect((await call("PUT", path)).status).toBe(204);
    expect((await call("DELETE", path)).status).toBe(204);
    expect(await collectionsOf()).toEqual([]);
    expect((await call("DELETE", path)).status).toBe(204);

    const unknown = "/api/v1/collections/x/models/0198f0c4-6a1b-7c2d-8e3f-4a5b6c7d8e9f";
    for (const method of ["PUT", "DELETE"]) {
      expect((await call(method, unknown)).status, method).toBe(404);
    }
    expect(await env.repos.models.trash(model.id)).toBe(true);
    for (const method of ["PUT", "DELETE"]) {
      expect((await call(method, path)).status, method).toBe(404);
    }
  });

  test("create sets every field, and a taken externalRef is 409 with the trashed flag", async () => {
    const m = marker();
    const ref = `manyfold:${m}`;
    const created = await call("POST", "/api/v1/models", {
      json: {
        name: `Imported ${m}`,
        caption: "A caption",
        description: "Some **Markdown**",
        creator: `Designer ${m}`,
        license: "CC-BY-4.0",
        externalRef: ref,
        tags: ["imported", "print later"],
        collections: [`From Manyfold ${m}`],
      },
    });
    expect(created.status, created.text).toBe(201);
    const model = (created.json() as { model: Record<string, unknown> }).model;
    expect(model).toMatchObject({
      name: `Imported ${m}`,
      caption: "A caption",
      description: "Some **Markdown**",
      creator: `Designer ${m}`,
      license: "CC-BY-4.0",
      externalRef: ref,
      collections: [`From Manyfold ${m}`],
    });
    expect([...(model.tags as string[])].sort()).toEqual(["imported", "print later"]);

    const again = await call("POST", "/api/v1/models", {
      json: { name: "Again", externalRef: ref },
    });
    expect(again.status).toBe(409);
    expect(again.json()).toEqual({ error: "exists", trashed: false });

    expect(await env.repos.models.trash(String(model.id))).toBe(true);
    const trashed = await call("POST", "/api/v1/models", {
      json: { name: "Again", externalRef: ref },
    });
    expect(trashed.status).toBe(409);
    expect(trashed.json()).toEqual({ error: "exists", trashed: true });

    for (const body of [{}, { name: "" }, { name: "x", tags: "one" }, { name: "x", nope: 1 }]) {
      const res = await call("POST", "/api/v1/models", { json: body });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const notJson = await call("POST", "/api/v1/models", {
      headers: { "content-type": "text/plain" },
    });
    expect(notJson.status).toBe(415);
  });

  test("there is no delete, trash or purge route under /api/v1", async () => {
    const model = await createModel({ name: `Undeletable ${marker()}` });
    const outcome = await upload("keep.stl", ASCII_STL, { modelId: model.id });
    expect(outcome.status, outcome.error).toBe("done");
    for (const [method, path] of [
      ["DELETE", `/api/v1/models/${model.id}`],
      ["POST", `/api/v1/models/${model.id}/trash`],
      ["POST", `/api/v1/models/${model.id}/purge`],
      ["DELETE", `/api/v1/files/${outcome.fileId}`],
      ["DELETE", "/api/v1/trash"],
      ["POST", "/api/v1/trash/empty"],
    ] as const) {
      const res = await call(method, path);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    const still = await call("GET", `/api/v1/models/${model.id}`);
    expect(still.status).toBe(200);
    expect((still.json() as { files: unknown[] }).files).toHaveLength(1);
  });
});

describe("the OpenAPI document", () => {
  test("openapi describes every v1 route and uses PUBLIC_ORIGIN", async () => {
    // inject, so the spoofed Host reaches the app exactly as written.
    const res = await t.app.inject({
      method: "GET",
      url: "/api/v1/openapi.json",
      headers: {
        authorization: `Bearer ${token}`,
        host: "attacker.example",
        "x-forwarded-host": "attacker.example",
        forwarded: "host=attacker.example;proto=http",
      },
    });
    expect(res.statusCode).toBe(200);
    const doc = res.json() as {
      openapi: string;
      servers: Array<{ url: string }>;
      paths: Record<string, Record<string, { responses?: Record<string, unknown> }>>;
      components: { securitySchemes?: Record<string, { type: string; scheme?: string }> };
    };
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.servers[0]?.url).toBe(`${TEST_ORIGIN}/api/v1`);
    expect(res.body).not.toContain("attacker.example");
    expect(doc.components.securitySchemes?.bearer).toMatchObject({
      type: "http",
      scheme: "bearer",
    });

    const documented = (path: string) =>
      path
        .slice("/api/v1".length)
        .replace(/\/$/, "")
        .replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    const routes = registeredRoutes(t.app).filter((r) => r.path.startsWith("/api/v1/"));
    expect(routes.length).toBeGreaterThan(10);
    for (const route of routes) {
      for (const method of route.methods) {
        const op = doc.paths[documented(route.path)]?.[method.toLowerCase()];
        expect(op, `${method} ${route.path}`).toBeDefined();
        expect(Object.keys(op?.responses ?? {}), `${method} ${route.path}`).toContain("401");
      }
    }
    const registered = new Set(routes.map((r) => documented(r.path)));
    for (const path of Object.keys(doc.paths)) {
      expect(registered.has(path), path).toBe(true);
    }
  });
});

describe("AC-081: with the issuer down", () => {
  test("login is unavailable and a token request still works", async () => {
    const before = await fetch(`${base}/auth/login`, { redirect: "manual" });
    await before.arrayBuffer();
    expect(before.status).toBe(302);
    await t.issuer.stop();

    const login = await fetch(`${base}/auth/login`, { redirect: "manual" });
    expect(login.status).toBe(503);
    expect(await login.text()).toContain("Login is unavailable right now");

    const listed = await call("GET", "/api/v1/models");
    expect(listed.status).toBe(200);
    const outcome = await upload(`During outage ${marker()}.stl`, ASCII_STL);
    expect(outcome.status, outcome.error).toBe("done");
  });
});

describe("the request log", () => {
  test("token appears in no log line, a 401 with a bad token included", () => {
    // The detector works: the log holds this file's requests.
    expect(lines.length).toBeGreaterThan(50);
    expect(lines.some((line) => line.includes("/api/v1/models"))).toBe(true);
    expect(lines.some((line) => line.includes('"statusCode":401'))).toBe(true);
    expect(sentTokens.length).toBeGreaterThanOrEqual(6);
    for (const sent of sentTokens) {
      const body = sent.slice(TOKEN_PREFIX.length);
      expect(body).toHaveLength(TOKEN_BODY_LENGTH);
      const leaked = lines.filter((line) => line.includes(sent) || line.includes(body));
      expect(leaked, `${sent.slice(0, 8)}...`).toEqual([]);
    }
  });

  test("Authorization and Cookie are redacted, and Upload-Metadata is logged by key names only", () => {
    expect(lines.some((line) => line.includes('"authorization":"[Redacted]"'))).toBe(true);
    expect(lines.some((line) => line.includes('"cookie":"[Redacted]"'))).toBe(true);
    expect(lines.some((line) => line.includes('"upload-metadata":"filename,modelId"'))).toBe(true);
    const encoded = Buffer.from("part-a.stl", "utf8").toString("base64");
    expect(lines.filter((line) => line.includes(encoded))).toEqual([]);
    expect(lines.filter((line) => line.includes(SESSION_COOKIE))).toEqual([]);
  });
});
