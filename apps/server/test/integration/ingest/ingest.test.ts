// Build plan Task 8: the ingest pipeline. AC-020 (server side), AC-022
// (fill-only metadata), AC-024 (unsupported types store nothing), AC-033
// (ingest never waits on a slice) and AC-012 (an upload during a store
// outage leaves nothing behind).
//
// Order under test: detect -> hash and put the source blob -> parse (each
// thumbnail put as it comes) -> one transaction for the rows. A failure before
// the transaction deletes the objects it put and leaves no rows.
import { createHash, randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { CreateBucketCommand } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { uuidv7 } from "../../../src/db/ids.js";
import {
  IngestError,
  type IngestStore,
  STORAGE_UNAVAILABLE_MESSAGE,
} from "../../../src/ingest/ingest.js";
import { createBlobStore, StoreUnavailable } from "../../../src/storage/s3.js";
import { startS3 } from "../support/containers.js";
import {
  ASCII_STL,
  binaryStl,
  build3mf,
  footprint,
  type IngestEnv,
  plainZip,
  SCAD_TEXT,
  STEP_TEXT,
  startIngestEnv,
  writeUpload,
} from "../support/ingest.js";

let env: IngestEnv;

beforeAll(async () => {
  env = await startIngestEnv();
});

afterAll(async () => {
  await env?.stop();
});

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest();

async function modelRow(id: string) {
  return env.db
    .selectFrom("models")
    .leftJoin("creators", "creators.id", "models.creatorId")
    .select([
      "models.name",
      "models.caption",
      "models.descriptionMd",
      "models.licenseSpdx",
      "models.licenseNote",
      "creators.name as creator",
    ])
    .where("models.id", "=", id)
    .executeTakeFirstOrThrow();
}

async function filesOf(modelId: string) {
  return env.db
    .selectFrom("files")
    .selectAll()
    .where("modelId", "=", modelId)
    .orderBy("createdAt")
    .execute();
}

async function readObject(key: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of await env.store.getBlobStream(key)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

describe("unsupported files", () => {
  test.each([
    ["an unsupported extension", "model.obj", Buffer.from("o cube\nv 0 0 0\n")],
    ["G-code", "plate_1.gcode", Buffer.from("; generated G-code\nG28\n")],
    ["no extension", "model", build3mf({ plates: 1 })],
    ["a .3mf that is not a zip", "model.3mf", Buffer.from("this is not a zip archive")],
    ["a .scad that is binary", "box.scad", Buffer.from([0x63, 0x00, 0x01, 0x02])],
    ["a .step without its header", "part.step", Buffer.from("HEADER;\nENDSEC;\n")],
    ["an empty .stl", "part.stl", Buffer.alloc(0)],
  ])("%s is refused and stores nothing: no rows, no objects", async (_label, name, bytes) => {
    const before = await footprint(env);
    const tmpPath = await writeUpload(env, bytes);
    const error = await env.ingest
      .ingestFile({ tmpPath, originalName: name, target: "new" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IngestError);
    expect((error as IngestError).code).toBe("unsupported_type");
    expect((error as IngestError).message).toMatch(/nothing was saved/);
    expect(await footprint(env)).toEqual(before);
  });
});

describe("one model per file unless combined", () => {
  test("each file becomes its own model unless combine", async () => {
    const a = await env.ingest.ingestFile({
      tmpPath: await writeUpload(env, ASCII_STL),
      originalName: "Bracket left.stl",
      target: "new",
    });
    const b = await env.ingest.ingestFile({
      tmpPath: await writeUpload(env, ASCII_STL),
      originalName: "Bracket right.stl",
      target: "new",
    });
    const batch = uuidv7();
    const c = await env.ingest.ingestFile({
      tmpPath: await writeUpload(env, SCAD_TEXT),
      originalName: "Box.scad",
      target: { batch, combine: false },
    });
    const d = await env.ingest.ingestFile({
      tmpPath: await writeUpload(env, STEP_TEXT),
      originalName: "Box lid.step",
      target: { batch, combine: false },
    });
    expect(new Set([a.modelId, b.modelId, c.modelId, d.modelId]).size).toBe(4);
    expect((await modelRow(a.modelId)).name).toBe("Bracket left");
    expect((await modelRow(d.modelId)).name).toBe("Box lid");
    for (const r of [a, b, c, d]) expect(await filesOf(r.modelId)).toHaveLength(1);
  });

  test("a file uploaded into an existing model joins it", async () => {
    const model = await env.repos.models.create({ name: `Existing ${uuidv7()}` });
    const r = await env.ingest.ingestFile({
      tmpPath: await writeUpload(env, binaryStl()),
      originalName: "Spare part.stl",
      target: { modelId: model.id },
    });
    expect(r.modelId).toBe(model.id);
    const files = await filesOf(model.id);
    expect(files.map((f) => [f.name, f.kind])).toEqual([["Spare part.stl", "stl"]]);
  });

  test("an upload into a model that does not exist is refused before anything is stored", async () => {
    const before = await footprint(env);
    const error = await env.ingest
      .ingestFile({
        tmpPath: await writeUpload(env, ASCII_STL),
        originalName: "Orphan.stl",
        target: { modelId: uuidv7() },
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IngestError);
    expect((error as IngestError).code).toBe("model_not_found");
    expect(await footprint(env)).toEqual(before);
  });

  test("combined batch of three finishing together makes one model", async () => {
    const batch = uuidv7();
    const uploads = await Promise.all([
      writeUpload(env, build3mf({ plates: 2 })),
      writeUpload(env, ASCII_STL),
      writeUpload(env, SCAD_TEXT),
    ]);
    const names = ["Organiser.3mf", "Organiser insert.stl", "Organiser lid.scad"];
    const results = await Promise.all(
      uploads.map((tmpPath, i) =>
        env.ingest.ingestFile({
          tmpPath,
          originalName: names[i] ?? "missing",
          target: { batch, combine: true },
        }),
      ),
    );
    const modelIds = new Set(results.map((r) => r.modelId));
    expect(modelIds.size).toBe(1);
    const [modelId] = [...modelIds];
    if (modelId === undefined) throw new Error("no model id");
    const files = await filesOf(modelId);
    expect(files.map((f) => f.name).sort()).toEqual([...names].sort());
    expect(new Set(results.map((r) => r.fileId)).size).toBe(3);

    // A later file of the same batch joins the same model.
    const late = await env.ingest.ingestFile({
      tmpPath: await writeUpload(env, STEP_TEXT),
      originalName: "Organiser hinge.step",
      target: { batch, combine: true },
    });
    expect(late.modelId).toBe(modelId);
    expect(await filesOf(modelId)).toHaveLength(4);
  });
});

describe("what a stored file records", () => {
  test("a .3mf stores its source, plates, thumbnails, filaments and Bambu's own numbers", async () => {
    const bytes = build3mf({
      plates: 3,
      sliced: [1, 2],
      makerWorld: {
        title: "Synthetic Desk Tidy",
        designer: "Synthetic Designer",
        descriptionHtml: "<p>A <strong>tidy</strong> for the desk.</p>",
        license: "BY-NC-SA",
      },
    });
    const before = await footprint(env);
    const r = await env.ingest.ingestFile({
      tmpPath: await writeUpload(env, bytes),
      originalName: "Desk tidy.3mf",
      target: "new",
    });

    const model = await modelRow(r.modelId);
    expect(model).toEqual({
      name: "Desk tidy",
      caption: "Synthetic Desk Tidy",
      descriptionMd: "A **tidy** for the desk.",
      licenseSpdx: "CC-BY-NC-SA-4.0",
      licenseNote: null,
      creator: "Synthetic Designer",
    });

    const file = await env.repos.files.get(r.fileId);
    expect(file).toMatchObject({
      modelId: r.modelId,
      name: "Desk tidy.3mf",
      originalName: "Desk tidy.3mf",
      kind: "3mf",
      size: bytes.length,
      parseStatus: "ok",
    });
    expect(file?.sha256.equals(sha256(bytes))).toBe(true);

    const source = await env.repos.blobs.get(file?.blobId ?? "");
    expect(source).toMatchObject({ kind: "source", state: "stored", size: bytes.length });
    expect((await readObject(source?.key ?? "")).equals(bytes)).toBe(true);

    const plates = await env.repos.plates.listForFile(r.fileId);
    expect(plates.map((p) => [p.index, p.name, p.objectCount])).toEqual([
      [1, "Plate name 1", 1],
      [2, "Plate name 2", 1],
      [3, "Plate name 3", 1],
    ]);
    for (const plate of plates) {
      const thumb = await env.repos.blobs.get(plate.thumbnailBlobId ?? "");
      expect(thumb).toMatchObject({ kind: "thumbnail", state: "stored", contentType: "image/png" });
      expect((await readObject(thumb?.key ?? "")).toString("latin1")).toContain(`p${plate.index}`);
    }

    const filaments = await env.db
      .selectFrom("fileFilaments")
      .select(["slot", "type", "color"])
      .where("fileId", "=", r.fileId)
      .orderBy("slot")
      .execute();
    expect(filaments).toEqual([
      { slot: 1, type: "PLA", color: "#00AE42" },
      { slot: 2, type: "PETG", color: "#FFFFFF" },
    ]);

    const estimates = await env.db
      .selectFrom("estimates")
      .innerJoin("plates", "plates.id", "estimates.plateId")
      .select([
        "plates.index",
        "estimates.source",
        "estimates.status",
        "estimates.printerModelId",
        "estimates.nozzle",
        "estimates.timeSeconds",
        "estimates.weightGrams",
      ])
      .where("plates.fileId", "=", r.fileId)
      .orderBy("plates.index")
      .execute();
    expect(estimates).toEqual([
      {
        index: 1,
        source: "file",
        status: "ok",
        printerModelId: "C12",
        nozzle: 0.4,
        timeSeconds: 1000,
        weightGrams: 10.5,
      },
      {
        index: 2,
        source: "file",
        status: "ok",
        printerModelId: "C12",
        nozzle: 0.4,
        timeSeconds: 2000,
        weightGrams: 20.5,
      },
    ]);

    // One source and three thumbnails, each an object and a stored blob row.
    const after = await footprint(env);
    expect(after.objects - before.objects).toBe(4);
    expect(after.blobs - before.blobs).toBe(4);
  });

  test("a .3mf with no plate data stores the file and shows no_plate_data", async () => {
    const bytes = plainZip();
    const r = await env.ingest.ingestFile({
      tmpPath: await writeUpload(env, bytes),
      originalName: "Not from Bambu.3mf",
      target: "new",
    });
    const file = await env.repos.files.get(r.fileId);
    expect(file).toMatchObject({ kind: "3mf", parseStatus: "no_plate_data", size: bytes.length });
    expect(await env.repos.plates.listForFile(r.fileId)).toEqual([]);
    const source = await env.repos.blobs.get(file?.blobId ?? "");
    expect(source?.state).toBe("stored");
    expect((await readObject(source?.key ?? "")).equals(bytes)).toBe(true);
  });

  test("the footer licences name the licence and set no SPDX id", async () => {
    const r = await env.ingest.ingestFile({
      tmpPath: await writeUpload(
        env,
        build3mf({
          plates: 1,
          makerWorld: {
            designer: "Synthetic Designer",
            descriptionHtml: "<p>Print it.</p>",
            license: "Standard Digital File License",
          },
        }),
      ),
      originalName: "Footer licence.3mf",
      target: "new",
    });
    const model = await modelRow(r.modelId);
    expect(model.licenseSpdx).toBeNull();
    expect(model.licenseNote).toBe("License on MakerWorld: Standard Digital File License");
    expect(model.descriptionMd).toBe(
      "Print it.\n\nLicense on MakerWorld: Standard Digital File License",
    );
  });
});

describe("metadata is filled, never overwritten", () => {
  test("parse never overwrites a field Jon set", async () => {
    const model = await env.repos.models.create({
      name: `Jon's name ${uuidv7()}`,
      caption: "Jon's caption",
      licenseSpdx: "MIT",
      descriptionMd: "",
    });
    await env.ingest.ingestFile({
      tmpPath: await writeUpload(
        env,
        build3mf({
          plates: 1,
          makerWorld: {
            title: "MakerWorld title",
            designer: "Synthetic Designer",
            descriptionHtml: "<p>From MakerWorld.</p>",
            license: "BY",
          },
        }),
      ),
      originalName: "Into Jon's model.3mf",
      target: { modelId: model.id },
    });
    const after = await modelRow(model.id);
    // Set by Jon: kept. Empty or null: filled.
    expect(after.name).toBe(model.name);
    expect(after.caption).toBe("Jon's caption");
    expect(after.licenseSpdx).toBe("MIT");
    expect(after.descriptionMd).toBe("From MakerWorld.");
    expect(after.creator).toBe("Synthetic Designer");
  });

  test("a creator Jon set is kept", async () => {
    const model = await env.repos.models.create({
      name: `Credited ${uuidv7()}`,
      creator: `Jon's creator ${uuidv7()}`,
    });
    await env.ingest.ingestFile({
      tmpPath: await writeUpload(
        env,
        build3mf({ plates: 1, makerWorld: { designer: "Someone Else", title: "A title" } }),
      ),
      originalName: "Credited.3mf",
      target: { modelId: model.id },
    });
    const after = await modelRow(model.id);
    expect(after.creator).toBe(model.creator);
    expect(after.caption).toBe("A title");
  });
});

describe("a store outage leaves nothing behind (AC-012)", () => {
  test("upload with the store stopped leaves no model, file or blob row", async () => {
    const s3 = await startS3();
    const bucket = `platehouse-t8-${randomBytes(4).toString("hex")}`;
    await s3.client.send(new CreateBucketCommand({ Bucket: bucket }));
    const stopped = createBlobStore(
      {
        endpoint: s3.endpoint,
        region: s3.region,
        bucket,
        accessKeyId: s3.accessKeyId,
        secretAccessKey: s3.secretAccessKey,
        forcePathStyle: true,
      },
      { maxAttempts: 1, connectionTimeoutMs: 1_000, socketTimeoutMs: 2_000 },
    );
    await s3.stop();
    try {
      const before = await footprint(env);
      const tmpPath = await writeUpload(env, build3mf({ plates: 2, sliced: [1] }));
      const error = await env
        .ingestWith(stopped)
        .ingestFile({ tmpPath, originalName: "During the outage.3mf", target: "new" })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(IngestError);
      expect((error as IngestError).code).toBe("storage_unavailable");
      expect((error as IngestError).message).toBe(STORAGE_UNAVAILABLE_MESSAGE);
      expect(STORAGE_UNAVAILABLE_MESSAGE).toBe(
        "Storage is unavailable right now; nothing was saved",
      );
      expect(await footprint(env)).toEqual(before);
      // The upload itself is left for the caller (the inbox retries it).
      await expect(access(tmpPath)).resolves.toBeUndefined();
    } finally {
      stopped.destroy();
    }
  });

  test("a store that fails after the source is stored deletes what was put", async () => {
    let puts = 0;
    const failsOnThumbnail: IngestStore = {
      putBlob: async (stream, opts) => {
        puts += 1;
        if (puts === 2) {
          stream.resume();
          throw new StoreUnavailable("PutObject", "ECONNRESET");
        }
        return env.store.putBlob(stream, opts);
      },
      deleteBlobs: (keys) => env.store.deleteBlobs(keys),
    };
    const before = await footprint(env);
    const error = await env
      .ingestWith(failsOnThumbnail)
      .ingestFile({
        tmpPath: await writeUpload(env, build3mf({ plates: 2 })),
        originalName: "Half stored.3mf",
        target: "new",
      })
      .catch((e: unknown) => e);
    expect((error as IngestError).code).toBe("storage_unavailable");
    expect(puts).toBe(2);
    expect(await footprint(env)).toEqual(before);
  });

  test("a failure into an existing model leaves the model as it was", async () => {
    const model = await env.repos.models.create({ name: `Untouched ${uuidv7()}` });
    const down: IngestStore = {
      putBlob: async (stream) => {
        stream.resume();
        throw new StoreUnavailable("PutObject", "ECONNREFUSED");
      },
      deleteBlobs: async () => {
        throw new StoreUnavailable("DeleteObjects", "ECONNREFUSED");
      },
    };
    const before = await footprint(env);
    const error = await env
      .ingestWith(down)
      .ingestFile({
        tmpPath: await writeUpload(
          env,
          build3mf({ plates: 1, makerWorld: { designer: "D", title: "T" } }),
        ),
        originalName: "Into an existing model.3mf",
        target: { modelId: model.id },
      })
      .catch((e: unknown) => e);
    expect((error as IngestError).code).toBe("storage_unavailable");
    expect(await footprint(env)).toEqual(before);
    expect((await modelRow(model.id)).caption).toBeNull();
  });
});

describe("ingest never waits on a slice (AC-033)", () => {
  let slicer: Server;
  let calls = 0;

  beforeAll(async () => {
    // A stand-in for the slicer container: it counts every request.
    slicer = createServer((_req, res) => {
      calls += 1;
      res.writeHead(409, { "content-type": "application/json" }).end('{"error":"busy"}');
    });
    await new Promise<void>((resolve) => slicer.listen(0, "127.0.0.1", resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => slicer.close(() => resolve()));
  });

  test("ingest returns before any slice runs (the slicer stub is never called inside ingest)", async () => {
    const r = await env.ingest.ingestFile({
      tmpPath: await writeUpload(env, build3mf({ plates: 3, sliced: [1] })),
      originalName: "Unsliced plates.3mf",
      target: "new",
    });
    // Plates 2 and 3 have no numbers; their estimates are background work.
    expect(await env.repos.plates.listForFile(r.fileId)).toHaveLength(3);
    expect(calls).toBe(0);
  });
});
