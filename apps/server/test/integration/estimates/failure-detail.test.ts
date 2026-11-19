// Issue #239: a failed estimate's detail is Orca's own text, stored as the
// slicer sent it, so it can hold the job's work path, a host path, the
// slicer's URL, an address or a token. Every place that shows it to a user
// shows it cleaned the same way (src/scrub.ts), and the rows stay as stored:
//
//   GET /app/api/models/:id   the model page (plate numbers, failure.detail)
//   GET /app/api/activity     the Activity page (estimate_failed events)
//   GET /api/v1/files/:id     the Public API v1 (plate numbers, failure.detail)
//   GET /api/v1/models/:id    the Public API v1 (the same, under each file)
//
// Run against Postgres 17, the S3 test server and a started pg-boss on the
// same database. Every model, file and token here is made by the run.
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Health, Printer } from "@platehouse/slicer-contract";
import type { FastifyInstance } from "fastify";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createTokens, dbTokenStore } from "../../../src/api/tokens.js";
import { createApiLibrary } from "../../../src/api/v1.js";
import { buildApp } from "../../../src/app.js";
import { type ActivityView, createAppActivity } from "../../../src/app-api/activity.js";
import { createAppModel, type ModelView } from "../../../src/app-api/model.js";
import { SESSION_COOKIE } from "../../../src/auth/sessions.js";
import {
  type DisplayContext,
  type PlateFailure,
  plateNumbers,
} from "../../../src/estimates/display.js";
import { REASON_WORDS } from "../../../src/estimates/reasons.js";
import { createBoss } from "../../../src/jobs/boss.js";
import { QUEUE } from "../../../src/jobs/queues.js";
import { createUploads } from "../../../src/uploads/tus.js";
import { build3mf, type IngestEnv, startIngestEnv, writeUpload } from "../support/ingest.js";
import { marker } from "../support/library.js";
import { type TestAuth, testAuth } from "../support/oidc-issuer.js";

const P1S: Printer = {
  id: "Bambu Lab P1S 0.4 nozzle",
  model: "Bambu Lab P1S",
  modelId: "C12",
  nozzle: 0.4,
};
const ORCA = "2.5.0";
const CONTEXT: DisplayContext = { printerId: P1S.id, orcaVersion: ORCA, printers: [P1S] };
const HEALTHY = { contract: 1, orca: ORCA, openscad: "2026.10.01", busy: false } as Health;

/** A token shaped like the app's own: ph_ and 43 base64url characters, made by the run. */
const TOKEN_IN_DETAIL = ["ph", randomBytes(43).toString("base64url").slice(0, 43)].join("_");

/** Orca's detail as the slicer could send it. */
const DIRTY_DETAIL =
  "Orca exited with -3 slicing /work/job-0198f0c4-7a1e/input.3mf " +
  "(profiles under /srv/platehouse/orca/BBL) via http://slicer:8080/v1/slice " +
  `at 10.1.50.105 with token ${TOKEN_IN_DETAIL}: the object exceeds the plate`;

/** What every surface shows for it. */
const CLEAN_DETAIL =
  "Orca exited with -3 slicing [path] (profiles under [path]) via [address] " +
  "at [address] with token [redacted]: the object exceeds the plate";

/** No surface may show any of these. */
const HIDDEN = [
  "/work/",
  "job-0198f0c4",
  "input.3mf",
  "/srv/",
  "http://",
  "slicer:8080",
  "10.1.50.105",
  TOKEN_IN_DETAIL,
  TOKEN_IN_DETAIL.slice(3),
];

let env: IngestEnv;
let auth: TestAuth;
let boss: PgBoss;
let app: FastifyInstance;
let tmp: string;
let session: string;
let bearer: string;
let modelId: string;
let fileId: string;
let estimateId: string;

beforeAll(async () => {
  env = await startIngestEnv();
  auth = await testAuth();
  tmp = await mkdtemp(join(tmpdir(), "ph-239-"));
  boss = createBoss({ databaseUrl: env.url, onError: () => {} });
  await boss.start();
  for (const name of [QUEUE.ingest, QUEUE.slicer, QUEUE.maintenance]) {
    await boss.createQueue(name, { policy: "standard", retryLimit: 0 });
  }
  const tokens = createTokens({ store: dbTokenStore(env.db) });
  app = await buildApp({
    health: { database: async () => 1, queuesRunning: () => true },
    uploads: createUploads({
      tmpDir: tmp,
      queue: { enqueue: async () => {}, result: async () => undefined },
      log: () => {},
    }),
    auth: auth.auth,
    web: { dir: join(tmp, "no-web-build") },
    api: {
      tokens,
      library: createApiLibrary({
        db: env.db,
        store: env.store,
        plateNumbers: (plateId) => plateNumbers(env.db, CONTEXT, plateId),
      }),
    },
    model: createAppModel({
      db: env.db,
      displayContext: async () => CONTEXT,
      retryEstimate: async () => true,
    }),
    activity: createAppActivity({ db: env.db, boss, slicer: { health: async () => HEALTHY } }),
  });
  await app.ready();
  session = (await auth.sessions.start("jon")).id;
  bearer = (await tokens.createToken(`issue 239 ${marker()}`)).token;

  // One .3mf with one plate and no numbers of its own, whose Platehouse
  // estimate for the selected printer and Orca version failed.
  const tmpPath = await writeUpload(env, build3mf({ plates: 1 }));
  const ingested = await env.ingest.ingestFile({
    tmpPath,
    originalName: `Leaky ${marker()}.3mf`,
    target: "new",
  });
  modelId = ingested.modelId;
  fileId = ingested.fileId;
  const plate = await env.db
    .selectFrom("plates")
    .select("id")
    .where("fileId", "=", fileId)
    .executeTakeFirstOrThrow();
  const pending = await env.repos.estimates.upsertPending({
    plateId: plate.id,
    printerId: P1S.id,
    printerModelId: P1S.modelId,
    nozzle: P1S.nozzle,
    slicer: "OrcaSlicer",
    slicerVersion: ORCA,
  });
  estimateId = pending.id;
  await env.db
    .updateTable("estimates")
    .set({
      status: "failed",
      failureCode: -3,
      failureReason: "bed_too_small",
      failureDetail: DIRTY_DETAIL,
      finishedAt: new Date(),
    })
    .where("id", "=", estimateId)
    .execute();
});

afterAll(async () => {
  await app?.close();
  await boss?.stop({ graceful: false });
  await auth?.issuer.stop();
  await env?.stop();
  if (tmp !== undefined) await rm(tmp, { recursive: true, force: true });
});

async function getJson(url: string, as: "session" | "bearer") {
  const res = await app.inject({
    method: "GET",
    url,
    headers: {
      accept: "application/json",
      ...(as === "bearer" ? { authorization: `Bearer ${bearer}` } : {}),
    },
    ...(as === "session" ? { cookies: { [SESSION_COOKIE]: session } } : {}),
  });
  expect(res.statusCode, res.body).toBe(200);
  return { body: res.body, json: res.json() as unknown };
}

function expectNothingHidden(body: string) {
  for (const hidden of HIDDEN) expect(body).not.toContain(hidden);
}

/** The failure the model page and the API show, unchanged in shape. */
const EXPECTED_FAILURE = (): PlateFailure => ({
  estimateId,
  reason: "bed_too_small",
  words: REASON_WORDS.bed_too_small,
  detail: CLEAN_DETAIL,
});

describe("a failed estimate's detail", () => {
  test("the model page shows it cleaned", async () => {
    const { body, json } = await getJson(`/app/api/models/${modelId}`, "session");
    const view = json as ModelView;
    expect(view.files[0]?.plates[0]?.numbers.failure).toEqual(EXPECTED_FAILURE());
    expectNothingHidden(body);
  });

  test("the Activity page shows it cleaned", async () => {
    const { body, json } = await getJson("/app/api/activity", "session");
    const view = json as ActivityView;
    const event = view.events.items.find(
      (e) => e.type === "estimate_failed" && e.estimateId === estimateId,
    );
    expect(event).toMatchObject({ type: "estimate_failed", code: -3, detail: CLEAN_DETAIL });
    expectNothingHidden(body);
  });

  test("the Public API v1 shows it cleaned, in the same shape as before", async () => {
    const file = await getJson(`/api/v1/files/${fileId}`, "bearer");
    const plates = (file.json as { plates: { numbers: { failure?: unknown } }[] }).plates;
    expect(plates[0]?.numbers.failure).toEqual(EXPECTED_FAILURE());
    expect(Object.keys(plates[0]?.numbers.failure ?? {}).sort()).toEqual([
      "detail",
      "estimateId",
      "reason",
      "words",
    ]);
    expectNothingHidden(file.body);

    const model = await getJson(`/api/v1/models/${modelId}`, "bearer");
    const files = (model.json as { files: { plates: { numbers: { failure?: unknown } }[] }[] })
      .files;
    expect(files[0]?.plates[0]?.numbers.failure).toEqual(EXPECTED_FAILURE());
    expectNothingHidden(model.body);
  });

  test("the row keeps the detail as the slicer sent it; only what is shown is cleaned", async () => {
    const row = await env.db
      .selectFrom("estimates")
      .select("failureDetail")
      .where("id", "=", estimateId)
      .executeTakeFirstOrThrow();
    expect(row.failureDetail).toBe(DIRTY_DETAIL);
  });
});
