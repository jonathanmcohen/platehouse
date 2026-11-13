// Build plan Task 20 (AC-030, AC-032 to AC-034 display, AC-040, AC-050,
// AC-051, AC-072): the model page's app API, against Postgres 17 and the S3
// test server. Models come in through ingest from generated files (no
// designer file); plate numbers are Task 12's plateNumbers for a selected
// printer, the P1S with a 0.4 mm nozzle.
//
//   GET  /app/api/models/:id            the model page's data
//   POST /app/api/estimates/:id/retry   queue a failed estimate again
//
// - Both routes are session-class; the retry changes state, so it also needs
//   Origin to be PUBLIC_ORIGIN (Task 15's gate).
// - A model's files come with their plates in plate order, each plate's
//   thumbnail as /blobs/<id> of a stored thumbnail blob of the model, and
//   its numbers: Bambu's own, labelled with the printer the file was sliced
//   for, a Platehouse estimate for the selected printer (estimating while it
//   runs), or the failure and its plain words.
// - An STL is viewed from its own source blob, a STEP from its GLB mesh, a
//   SCAD from its rendered STL (with its PNG preview); a .3mf has no 3D view.
//   Only a stored blob of the model and of the right kind is ever named.
// - A trashed, unknown or malformed model id is 404.
// - The page's Open buttons mint a link at Task 17's POST
//   /app/api/files/:id/slicer-link; for a file whose name has spaces, a
//   slash, quotes and non-ASCII characters, the protocol URLs carry the link
//   encoded exactly once, and the link itself opens the file without a
//   session.
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Printer } from "@platehouse/slicer-contract";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApiLibrary } from "../../../src/api/v1.js";
import { buildApp } from "../../../src/app.js";
import { createAppModel, MODEL_API_PATHS, type ModelView } from "../../../src/app-api/model.js";
import { SESSION_COOKIE } from "../../../src/auth/sessions.js";
import { createDeliveryLibrary } from "../../../src/delivery/download.js";
import { type DisplayContext, plateNumbers } from "../../../src/estimates/display.js";
import { REASON_WORDS } from "../../../src/estimates/reasons.js";
import { createUploads } from "../../../src/uploads/tus.js";
import {
  ASCII_STL,
  build3mf,
  type IngestEnv,
  plainZip,
  SCAD_TEXT,
  STEP_TEXT,
  startIngestEnv,
  writeUpload,
} from "../support/ingest.js";
import { marker, storeBlob, trashDaysAgo } from "../support/library.js";
import { TEST_ORIGIN, type TestAuth, testAuth } from "../support/oidc-issuer.js";

const P1S: Printer = {
  id: "Bambu Lab P1S 0.4 nozzle",
  model: "Bambu Lab P1S",
  modelId: "C12",
  nozzle: 0.4,
};
const X1C: Printer = {
  id: "Bambu Lab X1 Carbon 0.4 nozzle",
  model: "Bambu Lab X1 Carbon",
  modelId: "BL-P001",
  nozzle: 0.4,
};

const CONTEXT: DisplayContext = { printerId: P1S.id, orcaVersion: "2.5.0", printers: [P1S, X1C] };

/** Non-ASCII from code points, so this file stays ASCII. */
const U_UMLAUT = String.fromCodePoint(0xfc);
const SNOWMAN = String.fromCodePoint(0x2603);

let env: IngestEnv;
let auth: TestAuth;
let app: FastifyInstance;
let session: string;
let dist: string;
let uploadsDir: string;
/** Estimate ids the retry route was asked to queue, and what it answers. */
const retried: string[] = [];
let retryAnswer = true;

async function ingest(name: string, bytes: Buffer | string) {
  const tmpPath = await writeUpload(env, bytes);
  return env.ingest.ingestFile({ tmpPath, originalName: name, target: "new" });
}

async function into(modelId: string, name: string, bytes: Buffer | string) {
  const tmpPath = await writeUpload(env, bytes);
  return env.ingest.ingestFile({ tmpPath, originalName: name, target: { modelId } });
}

async function get(url: string, cookie: string | null = session) {
  return app.inject({
    method: "GET",
    url,
    headers: { accept: "application/json" },
    ...(cookie === null ? {} : { cookies: { [SESSION_COOKIE]: cookie } }),
  });
}

async function post(url: string, opts: { cookie?: string | null; origin?: string | null } = {}) {
  const cookie = opts.cookie === undefined ? session : opts.cookie;
  const origin = opts.origin === undefined ? TEST_ORIGIN : opts.origin;
  return app.inject({
    method: "POST",
    url,
    headers: { accept: "application/json", ...(origin === null ? {} : { origin }) },
    ...(cookie === null ? {} : { cookies: { [SESSION_COOKIE]: cookie } }),
  });
}

async function modelView(id: string): Promise<ModelView> {
  const res = await get(`/app/api/models/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as ModelView;
}

async function platesOf(fileId: string) {
  return env.db
    .selectFrom("plates")
    .select(["id", "index", "thumbnailBlobId"])
    .where("fileId", "=", fileId)
    .orderBy("index")
    .execute();
}

/** A Platehouse estimate for the selected printer, in the given state. */
async function platehouseEstimate(
  plateId: string,
  state: "pending" | "ok" | "failed",
  extra: { timeSeconds?: number; weightGrams?: number; reason?: string; detail?: string } = {},
) {
  const pending = await env.repos.estimates.upsertPending({
    plateId,
    printerId: P1S.id,
    printerModelId: P1S.modelId,
    nozzle: P1S.nozzle,
    slicer: "OrcaSlicer",
    slicerVersion: "2.5.0",
  });
  if (state === "pending") return pending.id;
  await env.db
    .updateTable("estimates")
    .set(
      state === "ok"
        ? {
            status: "ok",
            timeSeconds: extra.timeSeconds ?? 600,
            weightGrams: extra.weightGrams ?? 5,
            processProfile: "0.20mm Standard @BBL X1C",
            finishedAt: new Date(),
          }
        : {
            status: "failed",
            failureReason: extra.reason ?? "bed_too_small",
            failureDetail: extra.detail ?? "the object exceeds the plate",
            finishedAt: new Date(),
          },
    )
    .where("id", "=", pending.id)
    .execute();
  return pending.id;
}

beforeAll(async () => {
  env = await startIngestEnv();
  auth = await testAuth();
  dist = await mkdtemp(join(tmpdir(), "platehouse-t20-dist-"));
  await mkdir(join(dist, "assets"));
  await writeFile(
    join(dist, "index.html"),
    [
      "<!doctype html>",
      '<html lang="en" data-theme="dark">',
      '  <head><meta name="color-scheme" content="dark" /></head>',
      '  <body><div id="root"></div></body>',
      "</html>",
      "",
    ].join("\n"),
  );
  uploadsDir = await mkdtemp(join(tmpdir(), "platehouse-t20-uploads-"));
  const files = createApiLibrary({
    db: env.db,
    store: env.store,
    plateNumbers: (plateId) => plateNumbers(env.db, CONTEXT, plateId),
  });
  app = await buildApp({
    health: { database: async () => 1, queuesRunning: () => true },
    uploads: createUploads({
      tmpDir: uploadsDir,
      queue: { enqueue: async () => {}, result: async () => undefined },
      log: () => {},
    }),
    auth: auth.auth,
    web: { dir: dist },
    delivery: {
      files,
      library: createDeliveryLibrary({ db: env.db, store: env.store }),
      linkSecret: randomBytes(32).toString("hex"),
    },
    model: createAppModel({
      db: env.db,
      displayContext: async () => CONTEXT,
      plateNumbers: (ctx, plateId) => plateNumbers(env.db, ctx, plateId),
      retryEstimate: async (estimateId) => {
        retried.push(estimateId);
        return retryAnswer;
      },
    }),
  });
  await app.ready();
  session = (await auth.sessions.start("jon")).id;
});

afterAll(async () => {
  await app?.close();
  await auth?.issuer.stop();
  await env?.stop();
  if (dist !== undefined) await rm(dist, { recursive: true, force: true });
  if (uploadsDir !== undefined) await rm(uploadsDir, { recursive: true, force: true });
});

describe("the model page's routes", () => {
  test("are session-class: without a session the model is 401 JSON", async () => {
    expect(MODEL_API_PATHS).toEqual(["/app/api/models/:id", "/app/api/estimates/:id/retry"]);
    const { modelId } = await ingest(`Gate ${marker()}.stl`, ASCII_STL);
    const res = await get(`/app/api/models/${modelId}`, null);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: "unauthorized" });
    expect(res.body).not.toContain("Gate");
  });

  test("the retry needs the same origin: cross-origin or no Origin is 403, no session is 401", async () => {
    const id = "0198f0c4-0000-7000-8000-00000000e001";
    const url = `/app/api/estimates/${id}/retry`;
    expect((await post(url, { origin: "https://evil.test" })).statusCode).toBe(403);
    expect((await post(url, { origin: null })).statusCode).toBe(403);
    expect((await post(url, { cookie: null })).statusCode).toBe(401);
    expect(retried).not.toContain(id);
  });

  test("the model page itself is a shell page behind the session", async () => {
    const { modelId } = await ingest(`Shell ${marker()}.stl`, ASCII_STL);
    const html = "text/html,application/xhtml+xml";
    const page = await app.inject({
      method: "GET",
      url: `/models/${modelId}`,
      headers: { accept: html },
      cookies: { [SESSION_COOKIE]: session },
    });
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toMatch(/^text\/html/);
    const anonymous = await app.inject({
      method: "GET",
      url: `/models/${modelId}`,
      headers: { accept: html },
    });
    expect(anonymous.statusCode).toBe(302);
    expect(anonymous.headers.location).toContain("/auth/login");
  });

  test("answers JSON that is never cached", async () => {
    const { modelId } = await ingest(`Cache ${marker()}.stl`, ASCII_STL);
    const res = await get(`/app/api/models/${modelId}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("a trashed, unknown or malformed model is 404 and names nothing", async () => {
    const { modelId } = await ingest(`Trashed ${marker()}.stl`, ASCII_STL);
    await trashDaysAgo(env.db, modelId, 1);
    for (const id of [modelId, "0198f0c4-0000-7000-8000-0000000fffff", "not-a-uuid"]) {
      const res = await get(`/app/api/models/${id}`);
      expect(res.statusCode, id).toBe(404);
      expect(res.json(), id).toEqual({ error: "not_found" });
    }
  });
});

describe("a .3mf's plates (AC-030, AC-051)", () => {
  test("every plate in order with its name, thumbnail, numbers and the project filaments", async () => {
    const word = marker();
    const { modelId, fileId } = await ingest(
      `Plates ${word}.3mf`,
      build3mf({ plates: 3, sliced: [1, 3] }),
    );
    const view = await modelView(modelId);
    expect(view).toMatchObject({ id: modelId, name: `Plates ${word}`, printer: P1S.id });
    expect(view.files).toHaveLength(1);
    const file = view.files[0];
    expect(file).toMatchObject({
      id: fileId,
      kind: "3mf",
      parseStatus: "ok",
      view: null,
      preview: null,
      download: `/files/${fileId}/download`,
    });
    expect(file?.filaments).toEqual([
      { slot: 1, type: "PLA", color: "#00AE42" },
      { slot: 2, type: "PETG", color: "#FFFFFF" },
    ]);

    const rows = await platesOf(fileId);
    expect(file?.plates.map((p) => p.index)).toEqual([1, 2, 3]);
    expect(file?.plates.map((p) => p.name)).toEqual([
      "Plate name 1",
      "Plate name 2",
      "Plate name 3",
    ]);
    expect(file?.plates.map((p) => p.id)).toEqual(rows.map((r) => r.id));
    expect(file?.plates.map((p) => p.thumbnail)).toEqual(
      rows.map((r) => `/blobs/${r.thumbnailBlobId}`),
    );

    // Bambu's numbers on plates 1 and 3, labelled with the P1S they were sliced for.
    const [one, two, three] = file?.plates ?? [];
    expect(one?.numbers.file).toMatchObject({
      source: "file",
      printerId: P1S.id,
      timeSeconds: 1000,
    });
    expect(one?.numbers.file?.filaments[0]).toMatchObject({ type: "PLA", color: "#00AE42" });
    expect(two?.numbers).toEqual({});
    expect(three?.numbers.file).toMatchObject({ timeSeconds: 3000 });
    expect(file?.plates.map((p) => p.estimatePending)).toEqual([false, false, false]);
  });

  test("a thumbnail that is not a stored thumbnail blob of the model is never named", async () => {
    const { modelId, fileId } = await ingest(`Thumbs ${marker()}.3mf`, build3mf({ plates: 2 }));
    const [first, second] = await platesOf(fileId);
    const file = await env.repos.files.get(fileId);
    const pending = await env.repos.blobs.insertPending({
      modelId,
      kind: "thumbnail",
      contentType: "image/png",
      size: 1,
    });
    // Plate 1 now points at the file's source blob, plate 2 at a pending blob.
    await env.db
      .updateTable("plates")
      .set({ thumbnailBlobId: file?.blobId ?? null })
      .where("id", "=", first?.id ?? "")
      .execute();
    await env.db
      .updateTable("plates")
      .set({ thumbnailBlobId: pending.id })
      .where("id", "=", second?.id ?? "")
      .execute();
    const view = await modelView(modelId);
    expect(view.files[0]?.plates.map((p) => p.thumbnail)).toEqual([null, null]);
    expect(JSON.stringify(view)).not.toContain(file?.blobId ?? "never");
  });

  test("a .3mf with no plate data says so and has no plates", async () => {
    const { modelId } = await ingest(`Broken ${marker()}.3mf`, plainZip());
    const view = await modelView(modelId);
    expect(view.files[0]?.parseStatus).toBe("no_plate_data");
    expect(view.files[0]?.plates).toEqual([]);
  });
});

describe("numbers and where they came from (AC-032 to AC-034 display)", () => {
  test("a file sliced for the X1C shows Bambu's numbers labelled X1C beside the P1S estimate", async () => {
    const { modelId, fileId } = await ingest(
      `Foreign ${marker()}.3mf`,
      build3mf({ plates: 1, sliced: [1], printerModelId: X1C.modelId }),
    );
    const [only] = await platesOf(fileId);
    await platehouseEstimate(only?.id ?? "", "ok", { timeSeconds: 5025, weightGrams: 41.37 });
    const numbers = (await modelView(modelId)).files[0]?.plates[0]?.numbers;
    expect(numbers?.file).toMatchObject({ source: "file", printerId: X1C.id });
    expect(numbers?.platehouse).toMatchObject({
      source: "platehouse",
      state: "current",
      printerId: P1S.id,
      slicer: "OrcaSlicer",
      slicerVersion: "2.5.0",
      processProfile: "0.20mm Standard @BBL X1C",
      timeSeconds: 5025,
    });
  });

  test("a plate waiting on its estimate is estimating, and shows its numbers once they land", async () => {
    const { modelId, fileId } = await ingest(`Waiting ${marker()}.3mf`, build3mf({ plates: 2 }));
    const [one] = await platesOf(fileId);
    const id = await platehouseEstimate(one?.id ?? "", "pending");
    expect((await modelView(modelId)).files[0]?.plates[0]?.numbers.platehouse?.state).toBe(
      "estimating",
    );
    expect((await modelView(modelId)).files[0]?.plates[0]?.estimatePending).toBe(true);
    await env.db
      .updateTable("estimates")
      .set({ status: "ok", timeSeconds: 900, weightGrams: 7, finishedAt: new Date() })
      .where("id", "=", id)
      .execute();
    const landed = (await modelView(modelId)).files[0]?.plates[0]?.numbers.platehouse;
    expect(landed).toMatchObject({ state: "current", timeSeconds: 900, weightGrams: 7 });
  });

  test("estimatePending says whether an estimate for the selected printer and Orca version is queued or slicing", async () => {
    const { modelId, fileId } = await ingest(`Pending ${marker()}.3mf`, build3mf({ plates: 1 }));
    const [only] = await platesOf(fileId);
    const plateId = only?.id ?? "";
    const plate = async () => (await modelView(modelId)).files[0]?.plates[0];

    // An older finished estimate for the X1C, and nothing queued for the
    // P1S (as when the stored printer left the menu): stale, nothing pending.
    const older = await env.repos.estimates.upsertPending({
      plateId,
      printerId: X1C.id,
      printerModelId: X1C.modelId,
      nozzle: X1C.nozzle,
      slicer: "OrcaSlicer",
      slicerVersion: "2.5.0",
    });
    await env.db
      .updateTable("estimates")
      .set({ status: "ok", timeSeconds: 700, weightGrams: 6, finishedAt: new Date() })
      .where("id", "=", older.id)
      .execute();
    expect((await plate())?.numbers.platehouse?.state).toBe("stale");
    expect((await plate())?.estimatePending).toBe(false);

    // A pending estimate for the P1S with an older Orca version is not the one wanted.
    await env.repos.estimates.upsertPending({
      plateId,
      printerId: P1S.id,
      printerModelId: P1S.modelId,
      nozzle: P1S.nozzle,
      slicer: "OrcaSlicer",
      slicerVersion: "2.4.0",
    });
    expect((await plate())?.estimatePending).toBe(false);

    // Queued, then slicing, for the P1S and the current version: pending.
    const id = await platehouseEstimate(plateId, "pending");
    expect((await plate())?.numbers.platehouse?.state).toBe("stale");
    expect((await plate())?.estimatePending).toBe(true);
    await env.db.updateTable("estimates").set({ status: "running" }).where("id", "=", id).execute();
    expect((await plate())?.estimatePending).toBe(true);

    // It lands: nothing pending any more.
    await env.db
      .updateTable("estimates")
      .set({ status: "ok", timeSeconds: 900, weightGrams: 7, finishedAt: new Date() })
      .where("id", "=", id)
      .execute();
    expect((await plate())?.numbers.platehouse?.state).toBe("current");
    expect((await plate())?.estimatePending).toBe(false);
  });

  test("a failed plate shows the reason in plain words; its siblings keep their numbers", async () => {
    const { modelId, fileId } = await ingest(
      `Failed ${marker()}.3mf`,
      build3mf({ plates: 3, sliced: [1, 3], printerModelId: X1C.modelId }),
    );
    const [, two] = await platesOf(fileId);
    const failedId = await platehouseEstimate(two?.id ?? "", "failed", {
      reason: "bed_too_small",
      detail: "Orca: the object exceeds the plate",
    });
    const plates = (await modelView(modelId)).files[0]?.plates ?? [];
    expect(plates[1]?.numbers.failure).toEqual({
      estimateId: failedId,
      reason: "bed_too_small",
      words: REASON_WORDS.bed_too_small,
      detail: "Orca: the object exceeds the plate",
    });
    expect(plates[0]?.numbers.file?.timeSeconds).toBe(1000);
    expect(plates[2]?.numbers.file?.timeSeconds).toBe(3000);
  });
});

describe("POST /app/api/estimates/:id/retry", () => {
  test("queues the failed estimate again (202) through the estimates service", async () => {
    const id = "0198f0c4-0000-7000-8000-00000000e0aa";
    retryAnswer = true;
    const res = await post(`/app/api/estimates/${id}/retry`);
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toEqual({ queued: true });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(retried.at(-1)).toBe(id);
  });

  test("an estimate the service will not queue is 409", async () => {
    retryAnswer = false;
    try {
      const res = await post("/app/api/estimates/0198f0c4-0000-7000-8000-00000000e0ab/retry");
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: "not_retryable" });
    } finally {
      retryAnswer = true;
    }
  });

  test("a malformed id is 404 and never reaches the service", async () => {
    const before = retried.length;
    const res = await post("/app/api/estimates/not-a-uuid/retry");
    expect(res.statusCode).toBe(404);
    expect(retried.length).toBe(before);
  });
});

describe("the 3D view's sources (AC-050, AC-051)", () => {
  test("an STL is viewed from its own stored source blob", async () => {
    const { modelId, fileId } = await ingest(`View ${marker()}.stl`, ASCII_STL);
    const file = await env.repos.files.get(fileId);
    const view = (await modelView(modelId)).files[0];
    expect(view).toMatchObject({ kind: "stl", plates: [], preview: null });
    expect(view?.view).toEqual({ kind: "stl", url: `/blobs/${file?.blobId}` });
  });

  test("a STEP is viewed from its GLB mesh, and has no view until the mesh is stored", async () => {
    const { modelId, fileId } = await ingest(`Housing ${marker()}.step`, STEP_TEXT);
    expect((await modelView(modelId)).files[0]?.view).toBeNull();
    const mesh = await storeBlob(env, modelId, "mesh_glb", Buffer.from("glTF synthetic"));
    await env.db
      .updateTable("files")
      .set({ meshBlobId: mesh.id })
      .where("id", "=", fileId)
      .execute();
    expect((await modelView(modelId)).files[0]?.view).toEqual({
      kind: "glb",
      url: `/blobs/${mesh.id}`,
    });
  });

  test("a SCAD is viewed from its rendered STL, with its PNG preview", async () => {
    const { modelId, fileId } = await ingest(`Part ${marker()}.scad`, SCAD_TEXT);
    const stl = await storeBlob(env, modelId, "render_stl", Buffer.from(ASCII_STL));
    const png = await storeBlob(env, modelId, "render_png", Buffer.from("png"));
    await env.db
      .updateTable("files")
      .set({ renderStlBlobId: stl.id, renderPngBlobId: png.id })
      .where("id", "=", fileId)
      .execute();
    const view = (await modelView(modelId)).files[0];
    expect(view?.view).toEqual({ kind: "stl", url: `/blobs/${stl.id}` });
    expect(view?.preview).toBe(`/blobs/${png.id}`);
  });

  test("a blob of the wrong kind or of another model is never named as a view", async () => {
    const other = await ingest(`Other ${marker()}.stl`, ASCII_STL);
    const { modelId, fileId } = await ingest(`Wrong ${marker()}.step`, STEP_TEXT);
    const foreign = await storeBlob(env, other.modelId, "mesh_glb", Buffer.from("glTF other"));
    await env.db
      .updateTable("files")
      .set({ meshBlobId: foreign.id })
      .where("id", "=", fileId)
      .execute();
    expect((await modelView(modelId)).files[0]?.view).toBeNull();
    const thumbnail = await storeBlob(env, modelId, "thumbnail", Buffer.from("png"));
    await env.db
      .updateTable("files")
      .set({ meshBlobId: thumbnail.id })
      .where("id", "=", fileId)
      .execute();
    expect((await modelView(modelId)).files[0]?.view).toBeNull();
  });

  test("a model's files come in upload order, a .3mf beside an STL", async () => {
    const first = await ingest(`Mixed ${marker()}.3mf`, build3mf({ plates: 1 }));
    const second = await into(first.modelId, "Extra bracket.stl", ASCII_STL);
    const view = await modelView(first.modelId);
    expect(view.files.map((f) => [f.id, f.kind])).toEqual([
      [first.fileId, "3mf"],
      [second.fileId, "stl"],
    ]);
  });
});

describe("the model's details (About)", () => {
  test("caption, description, creator, licence, licence note, tags and collections", async () => {
    const { modelId } = await ingest(`About ${marker()}.stl`, ASCII_STL);
    await env.db
      .updateTable("models")
      .set({
        caption: "A caption",
        descriptionMd: "Some **bold** text",
        licenseSpdx: null,
        licenseNote: "License on MakerWorld: Standard Digital File License",
      })
      .where("id", "=", modelId)
      .execute();
    await env.repos.tags.add(modelId, "Gridfinity");
    await env.repos.collections.add(modelId, "Desk");
    const view = await modelView(modelId);
    expect(view).toMatchObject({
      caption: "A caption",
      description: "Some **bold** text",
      license: null,
      licenseNote: "License on MakerWorld: Standard Digital File License",
      tags: ["Gridfinity"],
      collections: ["Desk"],
    });
  });
});

describe("opening a file in a slicer from the model page (AC-040)", () => {
  test("a name with spaces, a slash, quotes and non-ASCII: the link is encoded exactly once and opens the file", async () => {
    const bytes = build3mf({ plates: 1, sliced: [1] });
    const { modelId, fileId } = await ingest(`Plain ${marker()}.3mf`, bytes);
    // A rename (AC-060) can give a file and a model any name, a slash included.
    const hostile = `Big "box" / v2 ${U_UMLAUT}ber ${SNOWMAN}`;
    await env.db
      .updateTable("files")
      .set({ name: `${hostile}.3mf` })
      .where("id", "=", fileId)
      .execute();
    await env.db.updateTable("models").set({ name: hostile }).where("id", "=", modelId).execute();

    const view = await modelView(modelId);
    expect(view.name).toBe(hostile);
    const file = view.files[0];
    expect(file?.name).toBe(`${hostile}.3mf`);

    const res = await post(`/app/api/files/${file?.id}/slicer-link`);
    expect(res.statusCode, res.body).toBe(200);
    const link = res.json() as { url: string; open: { orca: string; bambuMac: string } };
    expect(link.url.startsWith(`${TEST_ORIGIN}/s/`)).toBe(true);
    expect(link.url).not.toContain("?");
    const segment = link.url.slice(link.url.lastIndexOf("/") + 1);
    expect(decodeURIComponent(segment)).toBe(`${hostile.replace("/", "_")}.3mf`);

    const orca = "orcaslicer://open?file=";
    const mac = "bambustudioopen://";
    expect(link.open.orca).toBe(`${orca}${encodeURIComponent(link.url)}`);
    expect(link.open.bambuMac).toBe(`${mac}${encodeURIComponent(link.url)}`);
    expect(decodeURIComponent(link.open.orca.slice(orca.length))).toBe(link.url);
    expect(decodeURIComponent(link.open.bambuMac.slice(mac.length))).toBe(link.url);

    // The slicer fetches the link with no session and gets the file's bytes.
    const fetched = await app.inject({ method: "GET", url: link.url.slice(TEST_ORIGIN.length) });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.rawPayload.equals(bytes)).toBe(true);
  });
});
