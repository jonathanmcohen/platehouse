// Issue #358: a .3mf plate's 3D view, against Postgres 17 and the S3 test
// server. Files come in through ingest from generated .3mf files (no
// designer file). GET /app/api/plates/:id/mesh makes the plate's GLB the
// first time a plate is opened, stores it as a mesh_glb blob of the model
// and records it on the plate (plates.mesh_blob_id, migration 0011); every
// later open answers the same blob. The browser then loads the GLB from
// /blobs/<id>, never the whole .3mf.
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { buildSliceable } from "@platehouse/threemf/test/sliceable";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { registerPlateMeshApi } from "../../../src/app-api/plate-mesh.js";
import {
  createPlateMeshes,
  PLATE_MESH_BUILDS,
  type PlateMeshStore,
} from "../../../src/plate-mesh/plate-mesh.js";
import { StoreUnavailable } from "../../../src/storage/s3.js";
import { build3mf, type IngestEnv, startIngestEnv, writeUpload } from "../support/ingest.js";
import { trashDaysAgo } from "../support/library.js";

let env: IngestEnv;
let tmpDir: string;
let app: FastifyInstance;
/** How many times the service opened a source .3mf from the store. */
let sourceReads = 0;
/** While true, the store's reads fail as an unreachable store does. */
let storeDown = false;
/** While set, every source read waits for it; readsHeld counts the reads waiting. */
let readGate: Promise<void> | null = null;
let readsHeld = 0;

async function ingest(name: string, bytes: Buffer) {
  const tmpPath = await writeUpload(env, bytes);
  return env.ingest.ingestFile({ tmpPath, originalName: name, target: "new" });
}

async function platesOf(fileId: string) {
  return env.db
    .selectFrom("plates")
    .select(["id", "index", "meshBlobId", "thumbnailBlobId"])
    .where("fileId", "=", fileId)
    .orderBy("index")
    .execute();
}

async function meshOf(plateId: string) {
  return app.inject({ method: "GET", url: `/app/api/plates/${plateId}/mesh` });
}

async function bytesOf(key: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of await env.store.getBlobStream(key)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function gltfJson(glb: Buffer) {
  expect(glb.readUInt32LE(0)).toBe(0x46546c67);
  const length = glb.readUInt32LE(12);
  return JSON.parse(glb.subarray(20, 20 + length).toString("utf8")) as {
    nodes: Array<{ children?: number[]; matrix?: number[] }>;
    materials: Array<{ pbrMetallicRoughness: { baseColorFactor: number[] } }>;
  };
}

beforeAll(async () => {
  env = await startIngestEnv();
  tmpDir = await mkdtemp(join(tmpdir(), "platehouse-plate-mesh-"));
  const store: PlateMeshStore = {
    putBlob: (stream, opts) => env.store.putBlob(stream, opts),
    deleteBlobs: (keys) => env.store.deleteBlobs(keys),
    async getBlobStream(key): Promise<Readable> {
      sourceReads += 1;
      if (storeDown) throw new StoreUnavailable("GetObject", "ECONNREFUSED");
      if (readGate !== null) {
        readsHeld += 1;
        await readGate;
        readsHeld -= 1;
      }
      return env.store.getBlobStream(key);
    },
  };
  app = Fastify();
  await registerPlateMeshApi(app, createPlateMeshes({ db: env.db, store, tmpDir }));
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await rm(tmpDir, { recursive: true, force: true });
  await env?.stop();
});

beforeEach(() => {
  sourceReads = 0;
  storeDown = false;
});

describe("GET /app/api/plates/:id/mesh", () => {
  test("makes the plate's GLB from its objects, stores it as a blob of the model and names it", async () => {
    const stored = await ingest("Cubes.3mf", buildSliceable({ plates: 3, filaments: 2 }));
    const plates = await platesOf(stored.fileId);
    const plate2 = plates[1];
    if (plate2 === undefined) throw new Error("no plate 2");

    const res = await meshOf(plate2.id);
    expect(res.statusCode, res.body).toBe(200);
    const { url } = res.json() as { url: string };
    const blobId = url.replace(/^\/blobs\//, "");
    expect(url).toBe(`/blobs/${blobId}`);

    const blob = await env.repos.blobs.get(blobId);
    expect(blob).toMatchObject({
      modelId: stored.modelId,
      kind: "mesh_glb",
      contentType: "model/gltf-binary",
      state: "stored",
    });
    expect((await platesOf(stored.fileId))[1]?.meshBlobId).toBe(blobId);

    // Plate 2's two cubes, white and near-black (the sliceable file's colours).
    const json = gltfJson(await bytesOf(blob?.key ?? ""));
    expect(json.nodes[0]?.children).toHaveLength(2);
    expect(json.materials.map((m) => m.pbrMetallicRoughness.baseColorFactor[0])).toEqual([
      1,
      expect.closeTo(0.0137, 3),
    ]);
  });

  test("answers the same blob on every later open, without reading the .3mf again", async () => {
    const stored = await ingest("Again.3mf", buildSliceable({ plates: 2, filaments: 1 }));
    const [plate1] = await platesOf(stored.fileId);
    if (plate1 === undefined) throw new Error("no plate 1");
    const first = (await meshOf(plate1.id)).json() as { url: string };
    const reads = sourceReads;
    const blobsBefore = await env.db.selectFrom("blobs").select("id").execute();
    const second = await meshOf(plate1.id);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first);
    expect(sourceReads).toBe(reads);
    expect(await env.db.selectFrom("blobs").select("id").execute()).toHaveLength(
      blobsBefore.length,
    );
  });

  test("two opens at once store one mesh, and no object is left without a row", async () => {
    const stored = await ingest("Twice.3mf", buildSliceable({ plates: 1, filaments: 3 }));
    const [plate] = await platesOf(stored.fileId);
    if (plate === undefined) throw new Error("no plate");
    const [a, b] = await Promise.all([meshOf(plate.id), meshOf(plate.id)]);
    expect(a.statusCode).toBe(200);
    expect(b.json()).toEqual(a.json());
    const meshes = await env.db
      .selectFrom("blobs")
      .select("key")
      .where("modelId", "=", stored.modelId)
      .where("kind", "=", "mesh_glb")
      .execute();
    expect(meshes).toHaveLength(1);
    const objects = await env.store.listPrefix(`models/${stored.modelId}/`);
    const rows = await env.db
      .selectFrom("blobs")
      .select("key")
      .where("modelId", "=", stored.modelId)
      .execute();
    expect(objects.map((o) => o.key).sort()).toEqual(rows.map((r) => r.key).sort());
  });

  test("a file with no readable mesh says why with 422, keeps its pictures and stores nothing", async () => {
    const stored = await ingest("Pictures only.3mf", build3mf({ plates: 2, nonce: "no-mesh" }));
    const before = await platesOf(stored.fileId);
    const plate = before[0];
    if (plate === undefined) throw new Error("no plate");
    expect(plate.thumbnailBlobId).not.toBeNull();

    const res = await meshOf(plate.id);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "no_mesh", code: "no_mesh" });
    expect(await platesOf(stored.fileId)).toEqual(before);
    const meshes = await env.db
      .selectFrom("blobs")
      .select("id")
      .where("modelId", "=", stored.modelId)
      .where("kind", "=", "mesh_glb")
      .execute();
    expect(meshes).toEqual([]);

    // The answer is remembered: the file is not read again for it.
    const reads = sourceReads;
    expect((await meshOf(plate.id)).statusCode).toBe(422);
    expect(sourceReads).toBe(reads);
  });

  test("a store that is down is 503, records nothing, and the next open after it is back works", async () => {
    const stored = await ingest("Outage.3mf", buildSliceable({ plates: 1, filaments: 2 }));
    const [plate] = await platesOf(stored.fileId);
    if (plate === undefined) throw new Error("no plate");
    storeDown = true;
    const down = await meshOf(plate.id);
    expect(down.statusCode).toBe(503);
    expect((await platesOf(stored.fileId))[0]?.meshBlobId).toBeNull();
    storeDown = false;
    const up = await meshOf(plate.id);
    expect(up.statusCode).toBe(200);
  });

  test("a plate of a model in the trash, or an unknown plate, is 404", async () => {
    const stored = await ingest("Binned.3mf", buildSliceable({ plates: 1, filaments: 1 }));
    const [plate] = await platesOf(stored.fileId);
    if (plate === undefined) throw new Error("no plate");
    await trashDaysAgo(env.db, stored.modelId, 0);
    expect((await meshOf(plate.id)).statusCode).toBe(404);
    expect((await meshOf("01900000-0000-7000-8000-00000000dead")).statusCode).toBe(404);
  });

  test("makes at most PLATE_MESH_BUILDS plates' meshes at once, and the others wait their turn", async () => {
    const stored = await ingest("Many plates.3mf", buildSliceable({ plates: 4, filaments: 1 }));
    const plates = await platesOf(stored.fileId);
    expect(plates.length).toBeGreaterThan(PLATE_MESH_BUILDS);
    let release: () => void = () => undefined;
    readGate = new Promise((resolve) => {
      release = resolve;
    });
    try {
      const opens = plates.map((p) => meshOf(p.id));
      await vi.waitFor(() => expect(readsHeld).toBe(PLATE_MESH_BUILDS));
      // Time for a run past the limit to reach the store, if one could.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(readsHeld).toBe(PLATE_MESH_BUILDS);
      expect(await readdir(tmpDir)).toHaveLength(PLATE_MESH_BUILDS);
      release();
      const answers = await Promise.all(opens);
      expect(answers.map((a) => a.statusCode)).toEqual(plates.map(() => 200));
    } finally {
      release();
      readGate = null;
    }
  });

  test("leaves no temp file behind", async () => {
    expect(await readdir(tmpDir)).toEqual([]);
  });
});
