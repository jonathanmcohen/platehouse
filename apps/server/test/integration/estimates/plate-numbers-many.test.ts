// plateNumbersMany gives every plate the numbers plateNumbers gives it (issue
// #456), against Postgres 17: a plate with the file's own numbers and a stale
// Platehouse estimate for an older Orca, a plate whose estimate failed, and a
// plate with no estimate at all. The query count is pinned without a database
// in test/estimates/plate-numbers-many.test.ts.
import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { uuidv7 } from "../../../src/db/ids.js";
import { migrate } from "../../../src/db/migrate.js";
import type { DB } from "../../../src/db/types.js";
import {
  type DisplayContext,
  plateNumbers,
  plateNumbersMany,
} from "../../../src/estimates/display.js";
import { startTestPostgres, type TestPostgres } from "../support/db.js";

const CTX: DisplayContext = { printerId: "P1S", orcaVersion: "2.3.1", printers: [] };

let pgc: TestPostgres;
let db: Kysely<DB>;

async function addPlate(index: number): Promise<string> {
  const modelId = uuidv7();
  await db
    .insertInto("models")
    .values({ id: modelId, name: `Model ${index}` })
    .execute();
  const blobId = uuidv7();
  await db
    .insertInto("blobs")
    .values({
      id: blobId,
      modelId,
      key: `models/${modelId}/${blobId}`,
      kind: "source",
      contentType: "application/octet-stream",
      size: 10,
      sha256: createHash("sha256").update(blobId).digest(),
      state: "stored",
    })
    .execute();
  const fileId = uuidv7();
  await db
    .insertInto("files")
    .values({
      id: fileId,
      modelId,
      blobId,
      name: "Part.3mf",
      originalName: "Part.3mf",
      kind: "3mf",
      size: 10,
      sha256: createHash("sha256").update(fileId).digest(),
    })
    .execute();
  const plateId = uuidv7();
  await db.insertInto("plates").values({ id: plateId, fileId, index: 1, objectCount: 1 }).execute();
  return plateId;
}

async function addEstimate(
  plateId: string,
  opts: { source: "file" | "platehouse"; status: "ok" | "failed"; version: string | null },
): Promise<string> {
  const id = uuidv7();
  const ok = opts.status === "ok";
  await db
    .insertInto("estimates")
    .values({
      id,
      plateId,
      source: opts.source,
      printerId: "P1S",
      slicerVersion: opts.version,
      status: opts.status,
      timeSeconds: ok ? 600 : null,
      weightGrams: ok ? 12 : null,
      failureReason: ok ? null : "slicer_error",
      failureDetail: ok ? null : "orca said no",
      finishedAt: new Date(),
    })
    .execute();
  await db
    .insertInto("estimateFilaments")
    .values({ estimateId: id, slot: 1, type: "PLA", color: "#ffffff", grams: 12 })
    .execute();
  return id;
}

beforeAll(async () => {
  pgc = await startTestPostgres();
  const t = await pgc.freshDatabase();
  await migrate(t.db);
  db = t.db;
});

afterAll(async () => {
  await pgc?.stop();
});

describe("plateNumbersMany", () => {
  test("gives each plate the same numbers plateNumbers gives it", async () => {
    const withFile = await addPlate(1);
    await addEstimate(withFile, { source: "file", status: "ok", version: null });
    await addEstimate(withFile, { source: "platehouse", status: "ok", version: "2.2.0" });
    const failed = await addPlate(2);
    await addEstimate(failed, { source: "platehouse", status: "failed", version: "2.3.1" });
    const empty = await addPlate(3);

    const many = await plateNumbersMany(db, CTX, [withFile, failed, empty, "not-a-uuid"]);

    for (const id of [withFile, failed, empty, "not-a-uuid"]) {
      expect(many.get(id), id).toEqual(await plateNumbers(db, CTX, id));
    }
    expect(many.get(withFile)?.file).toBeDefined();
    expect(many.get(failed)?.failure).toBeDefined();
    expect(many.get(empty)).toEqual({});
  });
});
