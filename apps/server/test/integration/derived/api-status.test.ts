// Issue #380 (the maintainer, 2026-11-22): the public API's derivedStatus
// keeps exactly its 0.1.0 meaning now that STL and STEP files get preview
// pictures. For a STEP file it is the mesh conversion alone, and for an STL
// it stays null; a preview picture never changes it. The picture is reported
// on its own, as previewStatus and previewMessage, null for every kind but
// STL and STEP. These tests run the real render jobs against the slicer stub
// and read the file back through the public API's own library (api/v1.ts),
// so they pin what an API client sees.
import { randomBytes } from "node:crypto";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { type ApiFile, createApiLibrary } from "../../../src/api/v1.js";
import {
  createDerived,
  DERIVED_KINDS,
  type DerivedDeps,
  type DerivedJob,
} from "../../../src/derived/derived.js";
import { QUEUE, SLICER_RETRY } from "../../../src/jobs/queues.js";
import { type DerivedEnv, settledFile, startDerivedEnv } from "../support/derived.js";
import { SCAD_TEXT, STEP_TEXT, writeUpload } from "../support/ingest.js";

let env: DerivedEnv;

beforeAll(async () => {
  env = await startDerivedEnv();
});

afterAll(async () => {
  await env?.stop();
});

beforeEach(() => {
  env.stub.renders.reset();
});

/** A file as GET /api/v1/files/:id answers it. */
async function apiFile(fileId: string): Promise<ApiFile> {
  const library = createApiLibrary({
    db: env.db,
    store: env.store,
    displayContext: async () => {
      throw new Error("these files have no plates");
    },
    plateNumbersMany: async () => new Map(),
  });
  const file = await library.getFile(fileId);
  if (!file) throw new Error(`file ${fileId} is not live`);
  return file;
}

const unique = (label: string) => `${label} ${randomBytes(6).toString("hex")}`;

function stlText(label: string): string {
  const name = unique(label).replace(/\W+/g, "_");
  return (
    `solid ${name}\n facet normal 0 0 1\n  outer loop\n   vertex 0 0 0\n   vertex 1 0 0\n` +
    `   vertex 0 1 0\n  endloop\n endfacet\nendsolid ${name}\n`
  );
}

function stepText(label: string): string {
  return STEP_TEXT.replace("HEADER;\n", `HEADER;\n/* ${unique(label)} */\n`);
}

async function upload(text: string, originalName: string) {
  return env.ingestDerived.ingestFile({
    tmpPath: await writeUpload(env, text),
    originalName,
    target: "new",
  });
}

const PREVIEW_REJECTED = "The preview picture could not be rendered. OpenSCAD said:";

describe("derivedStatus keeps its 0.1.0 meaning beside previewStatus (issue #380)", () => {
  test("a STEP file whose preview failed answers derivedStatus ok, with the failure in previewStatus", async () => {
    const message = "ERROR: STL import: too many facets";
    env.stub.renders.queue("/v1/stl/png", { kind: "failed", message });
    const { fileId } = await upload(stepText("preview failed"), "Housing.step");
    await settledFile(env, fileId);
    expect(await apiFile(fileId)).toMatchObject({
      kind: "step",
      derivedStatus: "ok",
      derivedMessage: null,
      previewStatus: "failed",
      previewMessage: `${PREVIEW_REJECTED} ${message}`,
    });
  });

  test("a STEP file converted and previewed answers ok for both", async () => {
    const { fileId } = await upload(stepText("both ok"), "Housing.step");
    await settledFile(env, fileId);
    expect(await apiFile(fileId)).toMatchObject({
      derivedStatus: "ok",
      derivedMessage: null,
      previewStatus: "ok",
      previewMessage: null,
    });
  });

  test("a STEP file whose mesh is stored and whose preview is still waiting answers derivedStatus ok", async () => {
    const stored = await env.ingest.ingestFile({
      tmpPath: await writeUpload(env, stepText("preview waiting")),
      originalName: "Housing.step",
      target: "new",
    });
    // The preview job this conversion queues is held an hour.
    const send: PgBoss["send"] = async (...args: unknown[]) => {
      const [name, data, options] = args as [string, object, Record<string, unknown>];
      return (env.boss.send as (...a: unknown[]) => Promise<string | null>)(name, data, {
        ...options,
        startAfter: 3600,
      });
    };
    const queue: DerivedDeps["queue"] = { send, findJobs: env.boss.findJobs.bind(env.boss) };
    const holding = createDerived({
      db: env.db,
      store: env.store,
      slicerUrl: env.stub.url,
      queue,
      retryDelaySeconds: 1,
    });
    const file = await env.repos.files.get(stored.fileId);
    if (!file) throw new Error("no file");
    const job: DerivedJob = {
      kind: DERIVED_KINDS.convertStep,
      fileId: file.id,
      sourceBlobId: file.blobId,
    };
    expect(
      await holding.runJob(job, { retryCount: 0, retryLimit: SLICER_RETRY.retryLimit }),
    ).toEqual({ status: "ok" });
    expect(await apiFile(file.id)).toMatchObject({
      derivedStatus: "ok",
      derivedMessage: null,
      previewStatus: "pending",
      previewMessage: null,
    });
    const held = (await env.boss.findJobs<DerivedJob>(QUEUE.slicer, { data: { fileId: file.id } }))
      .filter((j) => j.state === "created")
      .map((j) => j.data.kind);
    expect(held).toEqual([DERIVED_KINDS.previewStep]);
    for (const j of await env.boss.findJobs(QUEUE.slicer, { data: { fileId: file.id } })) {
      if (j.state === "created") await env.boss.cancel(QUEUE.slicer, j.id);
    }
  });

  test("a STEP file whose conversion failed answers derivedStatus failed and no preview", async () => {
    const message = "STEP import failed: no shapes found";
    env.stub.renders.queue("/v1/step/glb", { kind: "failed", message });
    const { fileId } = await upload(stepText("conversion failed"), "Housing.step");
    await settledFile(env, fileId);
    expect(await apiFile(fileId)).toMatchObject({
      derivedStatus: "failed",
      derivedMessage: message,
      previewStatus: null,
      previewMessage: null,
    });
  });

  test("an STL answers derivedStatus null as in 0.1.0, with its picture in previewStatus", async () => {
    const ok = await upload(stlText("stl ok"), "Bracket.stl");
    await settledFile(env, ok.fileId);
    expect(await apiFile(ok.fileId)).toMatchObject({
      kind: "stl",
      derivedStatus: null,
      derivedMessage: null,
      previewStatus: "ok",
      previewMessage: null,
    });

    const message = "ERROR: STL import: unexpected end of file";
    env.stub.renders.queue("/v1/stl/png", { kind: "failed", message });
    const failed = await upload(stlText("stl failed"), "Bracket.stl");
    await settledFile(env, failed.fileId);
    expect(await apiFile(failed.fileId)).toMatchObject({
      derivedStatus: null,
      derivedMessage: null,
      previewStatus: "failed",
      previewMessage: `${PREVIEW_REJECTED} ${message}`,
    });
  });

  test("a .scad file answers previewStatus null, its render in derivedStatus as before", async () => {
    const { fileId } = await upload(`${SCAD_TEXT}// ${unique("scad")}\n`, "Part.scad");
    await settledFile(env, fileId);
    expect(await apiFile(fileId)).toMatchObject({
      kind: "scad",
      derivedStatus: "ok",
      previewStatus: null,
      previewMessage: null,
    });
  });
});
