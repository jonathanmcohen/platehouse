// Build plan Task 4: the models repository against a migrated Postgres 17.
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { uuidv7 } from "../../../src/db/ids.js";
import { migrate } from "../../../src/db/migrate.js";
import { createRepos, type Repos } from "../../../src/repos/index.js";
import {
  sqlState,
  startTestPostgres,
  type TestDatabase,
  type TestPostgres,
} from "../support/db.js";
import { seedPlate, sha256Of } from "../support/fixtures.js";

let pgc: TestPostgres;
let t: TestDatabase;
let repos: Repos;

beforeAll(async () => {
  pgc = await startTestPostgres();
  t = await pgc.freshDatabase();
  await migrate(t.db);
  repos = createRepos(t.db);
});

afterAll(async () => {
  await pgc?.stop();
});

const unique = (label: string) => `${label} ${uuidv7()}`;

describe("models.create and models.get", () => {
  test("create stores the fields and get reads them back with the creator's name", async () => {
    const creator = unique("Creator");
    const made = await repos.models.create({
      name: "Air Dry - AMS",
      caption: "A drying box",
      descriptionMd: "**bold**",
      creator,
      licenseSpdx: "CC-BY-4.0",
      licenseNote: null,
      externalRef: unique("manyfold:"),
    });
    expect(made.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(made.trashedAt).toBeNull();
    expect(await repos.models.get(made.id)).toEqual(made);
    expect(made).toMatchObject({
      name: "Air Dry - AMS",
      caption: "A drying box",
      descriptionMd: "**bold**",
      creator,
      licenseSpdx: "CC-BY-4.0",
    });
  });

  test("two models by the same creator share one creator row", async () => {
    const creator = unique("Shared creator");
    const a = await repos.models.create({ name: "A", creator });
    const b = await repos.models.create({ name: "B", creator });
    expect(a.creatorId).not.toBeNull();
    expect(b.creatorId).toBe(a.creatorId);
  });

  test("a model with no creator has creator null", async () => {
    const made = await repos.models.create({ name: "Lonely" });
    expect(made.creatorId).toBeNull();
    expect(made.creator).toBeNull();
  });

  test("get answers undefined for an unknown id and for text that is not a uuid", async () => {
    expect(await repos.models.get(uuidv7())).toBeUndefined();
    expect(await repos.models.get("not-a-uuid")).toBeUndefined();
    expect(await repos.models.get("../etc/passwd")).toBeUndefined();
  });

  test("an empty name is refused by the schema", async () => {
    expect(await sqlState(repos.models.create({ name: "" }))).toBe("23514");
  });
});

describe("models.external_ref", () => {
  test("models.external_ref is unique across trashed and live models: the second insert raises 23505", async () => {
    const externalRef = unique("manyfold:");
    const first = await repos.models.create({ name: "First", externalRef });
    expect(await sqlState(repos.models.create({ name: "Live twin", externalRef }))).toBe("23505");

    expect(await repos.models.trash(first.id)).toBe(true);
    expect(await sqlState(repos.models.create({ name: "Trashed twin", externalRef }))).toBe(
      "23505",
    );
  });

  test("many models may have no external ref", async () => {
    await repos.models.create({ name: "No ref 1" });
    await repos.models.create({ name: "No ref 2", externalRef: null });
  });
});

describe("models.search", () => {
  let benchy: string;
  let cube: string;
  let byMaster: string;
  let tagged: string;
  const marker = uuidv7().slice(-12);

  beforeAll(async () => {
    benchy = (await repos.models.create({ name: `Benchy Boat ${marker}` })).id;
    cube = (await repos.models.create({ name: "Thing one", caption: `Calibration CUBE ${marker}` }))
      .id;
    byMaster = (await repos.models.create({ name: "Thing two", creator: `PrintMaster ${marker}` }))
      .id;
    tagged = (await repos.models.create({ name: "Thing three" })).id;
    await repos.tags.add(tagged, `Gridfinity ${marker}`);
  });

  test.each([
    ["name", () => `benchy boat ${marker}`, () => benchy],
    ["caption", () => `calibration cube ${marker}`, () => cube],
    ["creator", () => `PRINTMASTER ${marker}`, () => byMaster],
    ["tag", () => `gRiDfInItY ${marker}`, () => tagged],
  ])("search matches %s case-insensitively", async (_field, q, expected) => {
    const hits = await repos.models.search({ q: q() });
    expect(hits.map((m) => m.id)).toEqual([expected()]);
  });

  test("search matches part of a word", async () => {
    const hits = await repos.models.search({ q: `finity ${marker}` });
    expect(hits.map((m) => m.id)).toEqual([tagged]);
  });

  test("search matches name, caption, creator and tag together", async () => {
    const hits = await repos.models.search({ q: marker });
    expect(hits.map((m) => m.id).sort()).toEqual([benchy, cube, byMaster, tagged].sort());
  });

  test("a % or _ in the query matches only itself", async () => {
    const pct = (await repos.models.create({ name: `100% infill ${marker}` })).id;
    expect((await repos.models.search({ q: `% infill ${marker}` })).map((m) => m.id)).toEqual([
      pct,
    ]);
    // Only that model has a % anywhere; an unescaped % would match every model.
    expect((await repos.models.search({ q: "%" })).map((m) => m.id)).toEqual([pct]);
    // No text holds "_<marker>"; an unescaped _ would match " <marker>" in all of them.
    expect(await repos.models.search({ q: `_${marker}` })).toEqual([]);
  });

  test("search honours its limit", async () => {
    const hits = await repos.models.search({ q: marker, limit: 2 });
    expect(hits).toHaveLength(2);
  });
});

describe("trash and restore", () => {
  test("trashed models are excluded unless includeTrashed", async () => {
    const name = unique("Trash me");
    const made = await repos.models.create({ name });
    expect((await repos.models.search({ q: name })).map((m) => m.id)).toEqual([made.id]);

    expect(await repos.models.trash(made.id)).toBe(true);

    expect(await repos.models.get(made.id)).toBeUndefined();
    const trashed = await repos.models.get(made.id, { includeTrashed: true });
    expect(trashed?.trashedAt).toBeInstanceOf(Date);
    expect(await repos.models.get(made.id, { includeTrashed: false })).toBeUndefined();
    expect(await repos.models.search({ q: name })).toEqual([]);

    expect(await repos.models.restore(made.id)).toBe(true);
    expect((await repos.models.get(made.id))?.trashedAt).toBeNull();
    expect((await repos.models.search({ q: name })).map((m) => m.id)).toEqual([made.id]);
  });

  test("trashing a trashed model and restoring a live one change nothing", async () => {
    const made = await repos.models.create({ name: "Twice" });
    expect(await repos.models.restore(made.id)).toBe(false);
    expect(await repos.models.trash(made.id)).toBe(true);
    const first = (await repos.models.get(made.id, { includeTrashed: true }))?.trashedAt;
    expect(await repos.models.trash(made.id)).toBe(false);
    expect((await repos.models.get(made.id, { includeTrashed: true }))?.trashedAt).toEqual(first);
  });

  test("trash and restore answer false for an unknown or malformed id", async () => {
    expect(await repos.models.trash(uuidv7())).toBe(false);
    expect(await repos.models.restore("nope")).toBe(false);
  });

  test("purgeable lists models trashed before the given time, oldest first", async () => {
    const old = await repos.models.create({ name: "Old" });
    const recent = await repos.models.create({ name: "Recent" });
    const live = await repos.models.create({ name: "Live" });
    await repos.models.trash(old.id);
    await repos.models.trash(recent.id);
    await sql`update models set trashed_at = now() - interval '31 days' where id = ${old.id}`.execute(
      t.db,
    );

    const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const ids = (await repos.models.purgeable(cutoff)).map((m) => m.id);
    expect(ids).toContain(old.id);
    expect(ids).not.toContain(recent.id);
    expect(ids).not.toContain(live.id);

    const all = (await repos.models.purgeable(new Date(Date.now() + 1000))).map((m) => m.id);
    expect(all.indexOf(old.id)).toBeLessThan(all.indexOf(recent.id));
    expect(all).not.toContain(live.id);
  });
});

describe("deleting a model row", () => {
  test("removes its files, plates, estimates, blobs and tag links, and keeps the tag", async () => {
    const { modelId, plate, file } = await seedPlate(repos);
    const tag = unique("Kept tag");
    await repos.tags.add(modelId, tag);
    await repos.estimates.upsertPending({
      plateId: plate.id,
      printerId: "Bambu Lab P1S 0.4 nozzle",
      slicer: "OrcaSlicer",
      slicerVersion: "2.5.0",
    });
    // Derived blobs pointed at from the plate and the file: the cascade must
    // not trip over these references while it deletes the blobs.
    const derived = async (kind: "thumbnail" | "mesh_glb") => {
      const blob = await repos.blobs.insertPending({ modelId, kind, contentType: "image/png" });
      await repos.blobs.markStored(blob.id, { size: 1, sha256: sha256Of(kind) });
      return blob.id;
    };
    await t.db
      .updateTable("plates")
      .set({ thumbnailBlobId: await derived("thumbnail") })
      .where("id", "=", plate.id)
      .execute();
    await t.db
      .updateTable("files")
      .set({ meshBlobId: await derived("mesh_glb") })
      .where("id", "=", file.id)
      .execute();

    await t.db.deleteFrom("models").where("id", "=", modelId).execute();

    expect(await repos.files.get(file.id)).toBeUndefined();
    expect(await repos.plates.listForFile(file.id)).toEqual([]);
    const left = await t.db
      .selectFrom("blobs")
      .select("id")
      .where("modelId", "=", modelId)
      .execute();
    expect(left).toEqual([]);
    const tagRow = await t.db
      .selectFrom("tags")
      .select("name")
      .where("name", "=", tag)
      .executeTakeFirst();
    expect(tagRow?.name).toBe(tag);
    const links = await t.db
      .selectFrom("modelTags")
      .select("tagId")
      .where("modelId", "=", modelId)
      .execute();
    expect(links).toEqual([]);
    const estimates = await t.db
      .selectFrom("estimates")
      .select("id")
      .where("plateId", "=", plate.id)
      .execute();
    expect(estimates).toEqual([]);
  });
});
