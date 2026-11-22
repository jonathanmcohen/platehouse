// Build plan Task 4: migration 0001 and the forward-only migrator, against a
// real postgres:17-alpine.
import { appendFile, cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Kysely, sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createDb } from "../../../src/db/kysely.js";
import {
  listMigrations,
  MIGRATIONS_DIR,
  MigrationError,
  migrate,
  migrateFrom,
  PREVIOUS_CHECKSUMS,
} from "../../../src/db/migrate.js";
import type { DB } from "../../../src/db/types.js";
import { startTestPostgres, type TestPostgres } from "../support/db.js";

// Every table in the Database schema contract, plus the migrator's own record.
const TABLES = [
  "api_tokens",
  "blobs",
  "collection_models",
  "collections",
  "creators",
  "estimate_filaments",
  "estimates",
  "file_filaments",
  "files",
  "model_tags",
  "models",
  "plates",
  "schema_migrations",
  "sessions",
  "settings",
  "tags",
  "user_printers",
];

// The migrations shipped in src/db/migrations, in order, and the number the
// tests below give a migration they add to a copy of that folder.
const SHIPPED = [
  "0001_init.sql",
  "0002_purge_started.sql",
  "0003_estimate_filament_profiles.sql",
  "0004_files_sha256.sql",
  "0005_model_name_source.sql",
  "0006_model_name_source_user.sql",
  "0007_my_printers.sql",
  "0008_library_sort.sql",
  "0009_name_sort_prefix.sql",
  "0010_drop_unused_tags.sql",
  "0011_estimate_started_at.sql",
  "0012_plate_mesh.sql",
];
const NEXT = String(SHIPPED.length + 1).padStart(4, "0");

let pgc: TestPostgres;

beforeAll(async () => {
  pgc = await startTestPostgres();
});

afterAll(async () => {
  await pgc?.stop();
});

async function tableNames(db: Kysely<DB>): Promise<string[]> {
  const result = await sql<{ name: string }>`
    select table_name as name from information_schema.tables
    where table_schema = 'public' order by table_name`.execute(db);
  return result.rows.map((r) => r.name);
}

async function applied(db: Kysely<DB>) {
  return db
    .selectFrom("schemaMigrations")
    .select(["name", "checksum", "appliedAt"])
    .orderBy("name")
    .execute();
}

describe("migrate", () => {
  test("migration applies to an empty postgres 17", async () => {
    const { db } = await pgc.freshDatabase();
    expect(await tableNames(db)).toEqual([]);

    await migrate(db);

    expect(await tableNames(db)).toEqual(TABLES);
    const shipped = await listMigrations(MIGRATIONS_DIR);
    expect(shipped.map((f) => f.name)).toEqual(SHIPPED);
    expect((await applied(db)).map(({ name, checksum }) => ({ name, checksum }))).toEqual(
      shipped.map(({ name, checksum }) => ({ name, checksum })),
    );

    // SHOW cannot alias its column, and CamelCasePlugin renames
    // server_version_num, so read the setting through a select.
    const version = await sql<{
      v: string;
    }>`select current_setting('server_version_num') as v`.execute(db);
    expect(Math.floor(Number(version.rows[0]?.v) / 10000)).toBe(17);
  });

  test("0001 enables pg_trgm and puts trigram indexes on the four search columns", async () => {
    const { db } = await pgc.freshDatabase();
    await migrate(db);

    const ext = await sql<{ extname: string }>`
      select extname from pg_extension where extname = 'pg_trgm'`.execute(db);
    expect(ext.rows).toHaveLength(1);

    const trgm = await sql<{ table: string; column: string }>`
      select t.relname as "table", a.attname as "column"
      from pg_index x
      join pg_class i on i.oid = x.indexrelid
      join pg_class t on t.oid = x.indrelid
      join pg_am am on am.oid = i.relam
      join pg_opclass oc on oc.oid = x.indclass[0]
      join pg_attribute a on a.attrelid = t.oid and a.attnum = x.indkey[0]
      where am.amname = 'gin' and oc.opcname = 'gin_trgm_ops'
      order by 1, 2`.execute(db);
    expect(trgm.rows).toEqual([
      { table: "creators", column: "name" },
      { table: "models", column: "caption" },
      { table: "models", column: "name" },
      { table: "tags", column: "name" },
    ]);
  });

  test("0001 seeds the one settings row with the P1S 0.4 default", async () => {
    const { db } = await pgc.freshDatabase();
    await migrate(db);
    const rows = await db
      .selectFrom("settings")
      .select(["printerId", "lastOrcaVersion", "bucketVersioning"])
      .execute();
    expect(rows).toEqual([
      { printerId: "Bambu Lab P1S 0.4 nozzle", lastOrcaVersion: null, bucketVersioning: "unknown" },
    ]);
  });

  test("a second migrate applies nothing and changes nothing", async () => {
    const { db } = await pgc.freshDatabase();
    await migrate(db);
    const before = await applied(db);
    await migrate(db);
    expect(await applied(db)).toEqual(before);
  });

  test("two migrations started at once apply each file once", async () => {
    const { url } = await pgc.freshDatabase();
    const a = createDb(url);
    const b = createDb(url);
    try {
      await Promise.all([migrate(a), migrate(b)]);
      expect((await applied(a)).map((r) => r.name)).toEqual(SHIPPED);
    } finally {
      await Promise.all([a.destroy(), b.destroy()]);
    }
  });
});

describe("migrate with a changed migrations folder", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ph-migrations-"));
    await cp(MIGRATIONS_DIR, dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("editing an applied migration file stops migrate", async () => {
    const { db } = await pgc.freshDatabase();
    await migrateFrom(db, dir);
    const before = await applied(db);

    await appendFile(join(dir, "0001_init.sql"), "\n-- an edit after it was applied\n");
    // A new migration beside the edit must not be applied either.
    await writeFile(join(dir, `${NEXT}_more.sql`), "create table more_things (id int);\n");

    const run = migrateFrom(db, dir);
    await expect(run).rejects.toThrow(MigrationError);
    await expect(migrateFrom(db, dir)).rejects.toThrow(/0001_init\.sql.*checksum/);
    expect(await applied(db)).toEqual(before);
    expect(await tableNames(db)).not.toContain("more_things");
  });

  test("an applied migration file that has gone missing stops migrate", async () => {
    const { db } = await pgc.freshDatabase();
    await writeFile(join(dir, `${NEXT}_more.sql`), "create table more_things (id int);\n");
    await migrateFrom(db, dir);
    await rm(join(dir, `${NEXT}_more.sql`));

    await expect(migrateFrom(db, dir)).rejects.toThrow(new RegExp(`${NEXT}_more\\.sql.*missing`));
  });

  test("a new migration file is applied after the ones already applied", async () => {
    const { db } = await pgc.freshDatabase();
    await migrateFrom(db, dir);
    await writeFile(join(dir, `${NEXT}_more.sql`), "create table more_things (id int);\n");

    await migrateFrom(db, dir);

    expect((await applied(db)).map((r) => r.name)).toEqual([...SHIPPED, `${NEXT}_more.sql`]);
    expect(await tableNames(db)).toContain("more_things");
  });

  test("a migration that fails part way applies nothing and is not recorded", async () => {
    const { db } = await pgc.freshDatabase();
    await migrateFrom(db, dir);
    await writeFile(
      join(dir, `${NEXT}_broken.sql`),
      "create table half_made (id int);\nselect no_such_function();\n",
    );

    await expect(migrateFrom(db, dir)).rejects.toThrow(new RegExp(`${NEXT}_broken\\.sql`));

    expect((await applied(db)).map((r) => r.name)).toEqual(SHIPPED);
    expect(await tableNames(db)).not.toContain("half_made");
  });
});

// Four applied migrations had comments reworded after they shipped (PR #320).
// Only comments changed, so a database that applied the earlier bytes has the
// same schema as one that applied the current bytes; it differs only in the
// checksums schema_migrations recorded. These tests make such a database by
// migrating with the shipped files and then recording each listed file's
// previous checksum in place of its current one.
describe("migrations reworded after they shipped", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ph-migrations-"));
    await cp(MIGRATIONS_DIR, dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A database migrated with the earlier files: the listed rows hold the previous checksums. */
  async function migratedWithEarlierFiles(): Promise<Kysely<DB>> {
    const { db } = await pgc.freshDatabase();
    await migrate(db);
    for (const [name, { previous }] of PREVIOUS_CHECKSUMS) {
      await db
        .updateTable("schemaMigrations")
        .set({ checksum: previous })
        .where("name", "=", name)
        .execute();
    }
    return db;
  }

  test("a database migrated with the earlier files starts with the reworded ones and keeps its records", async () => {
    const db = await migratedWithEarlierFiles();
    const before = await applied(db);
    expect(
      before.filter((r) => r.checksum === PREVIOUS_CHECKSUMS.get(r.name)?.previous),
    ).toHaveLength(4);

    await migrate(db);
    // A new migration after them is still applied.
    await writeFile(join(dir, `${NEXT}_more.sql`), "create table more_things (id int);\n");
    await migrateFrom(db, dir);

    // The rows it had are not rewritten: the previous checksums stay recorded.
    expect((await applied(db)).slice(0, SHIPPED.length)).toEqual(before);
    expect(await tableNames(db)).toContain("more_things");
  });

  test("a recorded checksum that is neither the current nor the listed previous one still stops migrate", async () => {
    const db = await migratedWithEarlierFiles();
    await db
      .updateTable("schemaMigrations")
      .set({ checksum: "0".repeat(64) })
      .where("name", "=", "0001_init.sql")
      .execute();
    const before = await applied(db);

    await expect(migrate(db)).rejects.toThrow(MigrationError);
    await expect(migrate(db)).rejects.toThrow(/0001_init\.sql.*checksum/);
    expect(await applied(db)).toEqual(before);
  });

  test("the previous checksum stops migrate once the file has changed again", async () => {
    const db = await migratedWithEarlierFiles();
    await appendFile(join(dir, "0007_my_printers.sql"), "\n-- an edit after it was reworded\n");

    await expect(migrateFrom(db, dir)).rejects.toThrow(/0007_my_printers\.sql.*checksum/);
  });

  test("a database migrated with the current files also starts", async () => {
    const { db } = await pgc.freshDatabase();
    await migrate(db);
    const before = await applied(db);
    await migrate(db);
    expect(await applied(db)).toEqual(before);
  });
});

// Migration 0007 turns the one printer setting into My printers. It runs on
// an existing database, which has the schema before it, one selected printer and
// estimates keyed by printer_id; all of that must come through as it is.
describe("0007 My printers", () => {
  const P1S = "Bambu Lab P1S 0.4 nozzle";
  const A1_MINI = "Bambu Lab A1 mini 0.4 nozzle";
  const X1C = "Bambu Lab X1 Carbon 0.4 nozzle";
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ph-migrations-"));
    await cp(MIGRATIONS_DIR, dir, { recursive: true });
    // Every migration after 0006, not just 0007: the folder must stay
    // numbered without gaps, and later migrations (0008 library sort) follow.
    const later = (await readdir(dir)).filter(
      (name) => /^\d{4}_/.test(name) && Number(name.slice(0, 4)) > 6,
    );
    expect(later).toContain("0007_my_printers.sql");
    for (const name of later) await rm(join(dir, name));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /**
   * A database migrated up to 0006, as an existing install's will be: printerId selected, one plate, and two
   * finished estimates for it (one for printerId, one for the P1S on an older
   * Orca), as a printer change and an Orca update leave behind.
   */
  async function beforeMyPrinters(printerId: string): Promise<Kysely<DB>> {
    const { db } = await pgc.freshDatabase();
    await migrateFrom(db, dir);
    await sql`update settings set printer_id = ${printerId}`.execute(db);
    const modelId = "0190a0b0-0000-7000-8000-000000000001";
    const blobId = "0190a0b0-0000-7000-8000-000000000002";
    const fileId = "0190a0b0-0000-7000-8000-000000000003";
    const plateId = "0190a0b0-0000-7000-8000-000000000004";
    const sha = Buffer.alloc(32, 1);
    await sql`insert into models (id, name) values (${modelId}, 'Synthetic')`.execute(db);
    await sql`
      insert into blobs (id, model_id, key, kind, size, sha256, content_type, state)
      values (${blobId}, ${modelId}, ${`models/${modelId}/${blobId}`}, 'source', 10, ${sha},
              'model/3mf', 'stored')
    `.execute(db);
    await sql`
      insert into files (id, model_id, blob_id, name, original_name, kind, size, sha256)
      values (${fileId}, ${modelId}, ${blobId}, 'Synthetic.3mf', 'Synthetic.3mf', '3mf', 10, ${sha})
    `.execute(db);
    await sql`
      insert into plates (id, file_id, "index", object_count) values (${plateId}, ${fileId}, 1, 1)
    `.execute(db);
    await sql`
      insert into estimates (id, plate_id, source, printer_id, slicer, slicer_version, status,
                             time_seconds, weight_grams, finished_at)
      values ('0190a0b0-0000-7000-8000-000000000005', ${plateId}, 'platehouse', ${printerId},
              'OrcaSlicer', '2.5.0', 'ok', 600, 12.5, now()),
             ('0190a0b0-0000-7000-8000-000000000006', ${plateId}, 'platehouse', ${P1S},
              'OrcaSlicer', '2.4.2', 'ok', 610, 12.0, now())
    `.execute(db);
    return db;
  }

  async function estimateRows(db: Kysely<DB>): Promise<unknown[]> {
    return (await sql`select * from estimates order by id`.execute(db)).rows;
  }

  async function myPrinters(db: Kysely<DB>) {
    const { rows } = await sql<{ printerId: string; position: number }>`
      select printer_id as "printerId", position from user_printers order by position
    `.execute(db);
    return rows;
  }

  async function defaultPrinter(db: Kysely<DB>): Promise<string | undefined> {
    return (await db.selectFrom("settings").select("printerId").execute())[0]?.printerId;
  }

  test("the selected printer becomes the only entry in My printers and stays the default", async () => {
    const db = await beforeMyPrinters(A1_MINI);
    const before = await estimateRows(db);
    expect(before).toHaveLength(2);

    await migrate(db);

    expect(await myPrinters(db)).toEqual([{ printerId: A1_MINI, position: 1 }]);
    expect(await defaultPrinter(db)).toBe(A1_MINI);
    // The version My printers saves are checked against starts at 1.
    expect((await db.selectFrom("settings").select("printersVersion").execute())[0]).toEqual({
      printersVersion: 1,
    });
    // Every existing estimate is untouched: the same rows, printer ids and
    // numbers. Migrating to the latest also runs 0011, which adds started_at
    // and leaves it empty on rows that already existed.
    const after = (await estimateRows(db)) as Array<Record<string, unknown>>;
    expect(after.map((row) => row.startedAt)).toEqual([null, null]);
    expect(after.map(({ startedAt: _started, ...rest }) => rest)).toEqual(before);
  });

  test("a fresh database gets the P1S 0.4 default as its one printer", async () => {
    const { db } = await pgc.freshDatabase();
    await migrate(db);
    expect(await myPrinters(db)).toEqual([{ printerId: P1S, position: 1 }]);
    expect(await defaultPrinter(db)).toBe(P1S);
  });

  test("the default printer must be in My printers, so the list is never empty", async () => {
    const db = await beforeMyPrinters(P1S);
    await migrate(db);
    // Removing the default printer is refused at commit.
    await expect(
      sql`delete from user_printers where printer_id = ${P1S}`.execute(db),
    ).rejects.toMatchObject({ code: "23503" });
    // So is a default that is not in the list.
    await expect(
      sql`update settings set printer_id = ${A1_MINI}`.execute(db),
    ).rejects.toMatchObject({ code: "23503" });
    expect(await defaultPrinter(db)).toBe(P1S);
    // Adding a printer, making it the default and removing the old one in one
    // transaction works, because the check waits for the commit.
    await db.transaction().execute(async (trx) => {
      await sql`insert into user_printers (printer_id, position) values (${A1_MINI}, 2)`.execute(
        trx,
      );
      await sql`update settings set printer_id = ${A1_MINI}`.execute(trx);
      await sql`delete from user_printers where printer_id = ${P1S}`.execute(trx);
    });
    expect(await myPrinters(db)).toEqual([{ printerId: A1_MINI, position: 2 }]);
    expect(await defaultPrinter(db)).toBe(A1_MINI);
  });

  test("a printer is listed once, at a position of its own, and two can swap places", async () => {
    const db = await beforeMyPrinters(P1S);
    await migrate(db);
    await sql`insert into user_printers (printer_id, position) values (${A1_MINI}, 2)`.execute(db);
    await expect(
      sql`insert into user_printers (printer_id, position) values (${A1_MINI}, 3)`.execute(db),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      sql`insert into user_printers (printer_id, position) values (${X1C}, 2)`.execute(db),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      sql`insert into user_printers (printer_id, position) values (' ', 3)`.execute(db),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      sql`insert into user_printers (printer_id, position) values (${X1C}, 0)`.execute(db),
    ).rejects.toMatchObject({ code: "23514" });
    // The position check waits for the commit, so two printers can swap places.
    await db.transaction().execute(async (trx) => {
      await sql`update user_printers set position = 2 where printer_id = ${P1S}`.execute(trx);
      await sql`update user_printers set position = 1 where printer_id = ${A1_MINI}`.execute(trx);
    });
    expect((await myPrinters(db)).map((r) => r.printerId)).toEqual([A1_MINI, P1S]);
  });
});

// Migration 0009 makes the name sort index hold a 200-character prefix. It
// runs on an existing database at 0008, as a 0.1.0 release candidate leaves
// it, with live and trashed models; no row may change, and afterwards a name
// of 500 CJK characters, which 0008's index refused, can be stored.
describe("0009 name sort prefix", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ph-migrations-"));
    await cp(MIGRATIONS_DIR, dir, { recursive: true });
    const later = (await readdir(dir)).filter(
      (name) => /^\d{4}_/.test(name) && Number(name.slice(0, 4)) > 8,
    );
    expect(later).toContain("0009_name_sort_prefix.sql");
    for (const name of later) await rm(join(dir, name));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function nameIndex(db: Kysely<DB>): Promise<string | undefined> {
    const { rows } = await sql<{ indexdef: string }>`
      select indexdef from pg_indexes where indexname = 'models_live_name'
    `.execute(db);
    return rows[0]?.indexdef;
  }

  test("applies on a database at 0008 with models, changing no row", async () => {
    const { db } = await pgc.freshDatabase();
    await migrateFrom(db, dir);
    expect(await nameIndex(db)).toMatch(/lower\(name\), name, id/);
    await sql`
      insert into models (id, name, trashed_at)
      values ('0190a0b0-0000-7000-8000-000000000011', 'Synthetic live', null),
             ('0190a0b0-0000-7000-8000-000000000012', ${"Long ".repeat(100)}, null),
             ('0190a0b0-0000-7000-8000-000000000013', 'Synthetic trashed', now())
    `.execute(db);
    const before = (await sql`select * from models order by id`.execute(db)).rows;

    await migrate(db);

    expect((await sql`select * from models order by id`.execute(db)).rows).toEqual(before);
    const def = await nameIndex(db);
    expect(def).toMatch(/lower\("left"\(name, 200\)\), "left"\(name, 200\)/);
    expect(def).toMatch(/WHERE \(trashed_at IS NULL\)/);
    const cjk = Array.from({ length: 500 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join("");
    await sql`
      insert into models (id, name) values ('0190a0b0-0000-7000-8000-000000000014', ${cjk})
    `.execute(db);
    await sql`
      update models set name = ${cjk} where id = '0190a0b0-0000-7000-8000-000000000011'
    `.execute(db);
  });
});

// Migration 0010 (issue #312) removes the tags no model has, which 0.1.0 left
// behind whenever a tag came off its last model. A tag a trashed model has is
// kept, since a restore brings the model back with it, and so is every
// collection, empty or not, and every model and link.
describe("0010 drop unused tags", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ph-migrations-"));
    await cp(MIGRATIONS_DIR, dir, { recursive: true });
    const later = (await readdir(dir)).filter(
      (name) => /^\d{4}_/.test(name) && Number(name.slice(0, 4)) > 9,
    );
    expect(later).toContain("0010_drop_unused_tags.sql");
    for (const name of later) await rm(join(dir, name));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("on a database at 0009, removes only the tags no model has", async () => {
    const { db } = await pgc.freshDatabase();
    await migrateFrom(db, dir);
    await sql`
      insert into models (id, name, trashed_at)
      values ('0190a0b0-0000-7000-8000-000000000021', 'Synthetic live', null),
             ('0190a0b0-0000-7000-8000-000000000022', 'Synthetic trashed', now())
    `.execute(db);
    await sql`
      insert into tags (id, name)
      values ('0190a0b0-0000-7000-8000-000000000031', 'qa-unused'),
             ('0190a0b0-0000-7000-8000-000000000032', 'Live tag'),
             ('0190a0b0-0000-7000-8000-000000000033', 'Trashed tag'),
             ('0190a0b0-0000-7000-8000-000000000034', 'Another unused')
    `.execute(db);
    await sql`
      insert into model_tags (model_id, tag_id)
      values ('0190a0b0-0000-7000-8000-000000000021', '0190a0b0-0000-7000-8000-000000000032'),
             ('0190a0b0-0000-7000-8000-000000000022', '0190a0b0-0000-7000-8000-000000000033')
    `.execute(db);
    await sql`
      insert into collections (id, name)
      values ('0190a0b0-0000-7000-8000-000000000041', 'QA empty collection'),
             ('0190a0b0-0000-7000-8000-000000000042', 'Used collection')
    `.execute(db);
    await sql`
      insert into collection_models (collection_id, model_id)
      values ('0190a0b0-0000-7000-8000-000000000042', '0190a0b0-0000-7000-8000-000000000021')
    `.execute(db);
    const models = (await sql`select * from models order by id`.execute(db)).rows;
    const links = (await sql`select * from model_tags order by model_id, tag_id`.execute(db)).rows;
    const collections = (await sql`select * from collections order by id`.execute(db)).rows;
    const members = (await sql`select * from collection_models order by model_id`.execute(db)).rows;

    await migrate(db);

    const tags = await sql<{ name: string }>`select name from tags order by name`.execute(db);
    expect(tags.rows.map((r) => r.name)).toEqual(["Live tag", "Trashed tag"]);
    expect((await sql`select * from models order by id`.execute(db)).rows).toEqual(models);
    expect(
      (await sql`select * from model_tags order by model_id, tag_id`.execute(db)).rows,
    ).toEqual(links);
    expect((await sql`select * from collections order by id`.execute(db)).rows).toEqual(
      collections,
    );
    expect((await sql`select * from collection_models order by model_id`.execute(db)).rows).toEqual(
      members,
    );
  });
});

// Migration 0011 adds estimates.started_at, when a slice began work, for the
// settings page's measured rate (issues #317 and #375). It runs on a database
// at 0010; the column is nullable with no default, so no existing row changes
// and estimates finished before it have no start time.
describe("0011 estimate started_at", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ph-migrations-"));
    await cp(MIGRATIONS_DIR, dir, { recursive: true });
    const later = (await readdir(dir)).filter(
      (name) => /^\d{4}_/.test(name) && Number(name.slice(0, 4)) > 10,
    );
    expect(later).toContain("0011_estimate_started_at.sql");
    for (const name of later) await rm(join(dir, name));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("applies on a database at 0010 and adds a nullable timestamptz with no default", async () => {
    const { db } = await pgc.freshDatabase();
    await migrateFrom(db, dir);
    await sql`
      insert into models (id, name) values ('0190a0b0-0000-7000-8000-000000000051', 'Synthetic')
    `.execute(db);
    const before = (await sql`select * from models order by id`.execute(db)).rows;

    await migrate(db);

    expect((await sql`select * from models order by id`.execute(db)).rows).toEqual(before);
    const { rows } = await sql<{ dataType: string; nullable: string; def: string | null }>`
      select data_type as "dataType", is_nullable as nullable, column_default as def
        from information_schema.columns
       where table_name = 'estimates' and column_name = 'started_at'
    `.execute(db);
    expect(rows).toEqual([{ dataType: "timestamp with time zone", nullable: "YES", def: null }]);
  });
});

// Migration 0012 (issue #358) points each plate at the GLB of its 3D view,
// made the first time the plate is opened. It runs on a database at 0011
// with plates, changing no row: every plate starts with no mesh. The column
// is cleared when its blob goes, as a plate's thumbnail is, so deleting a
// model's blobs never trips over it.
describe("0012 plate mesh", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ph-migrations-"));
    await cp(MIGRATIONS_DIR, dir, { recursive: true });
    const later = (await readdir(dir)).filter(
      (name) => /^\d{4}_/.test(name) && Number(name.slice(0, 4)) > 11,
    );
    expect(later).toContain("0012_plate_mesh.sql");
    for (const name of later) await rm(join(dir, name));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("applies on a database at 0011 with plates, changing no row, and a mesh goes with its blob", async () => {
    const { db } = await pgc.freshDatabase();
    await migrateFrom(db, dir);
    const model = "0190a0b0-0000-7000-8000-000000000021";
    const source = "0190a0b0-0000-7000-8000-000000000022";
    const file = "0190a0b0-0000-7000-8000-000000000023";
    const plate = "0190a0b0-0000-7000-8000-000000000024";
    const mesh = "0190a0b0-0000-7000-8000-000000000025";
    await sql`insert into models (id, name) values (${model}, 'Synthetic plates')`.execute(db);
    await sql`
      insert into blobs (id, model_id, key, kind, content_type)
      values (${source}, ${model}, ${`models/${model}/${source}`}, 'source', 'model/3mf')
    `.execute(db);
    await sql`
      insert into files (id, model_id, blob_id, name, original_name, kind, size, sha256)
      values (${file}, ${model}, ${source}, 'a.3mf', 'a.3mf', '3mf', 1, ${Buffer.alloc(32)})
    `.execute(db);
    await sql`
      insert into plates (id, file_id, "index", object_count) values (${plate}, ${file}, 1, 1)
    `.execute(db);
    const before = (
      await sql<Record<string, unknown>>`select * from plates order by id`.execute(db)
    ).rows;

    await migrate(db);

    const after = (await sql<Record<string, unknown>>`select * from plates order by id`.execute(db))
      .rows;
    expect(after).toEqual(before.map((row) => ({ ...row, meshBlobId: null })));
    await sql`
      insert into blobs (id, model_id, key, kind, content_type)
      values (${mesh}, ${model}, ${`models/${model}/${mesh}`}, 'mesh_glb', 'model/gltf-binary')
    `.execute(db);
    await sql`update plates set mesh_blob_id = ${mesh} where id = ${plate}`.execute(db);
    await sql`delete from blobs where id = ${mesh}`.execute(db);
    const left = (
      await sql<{ meshBlobId: string | null }>`
        select mesh_blob_id from plates where id = ${plate}
      `.execute(db)
    ).rows;
    expect(left).toEqual([{ meshBlobId: null }]);
  });
});
