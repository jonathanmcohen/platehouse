// Build plan Task 4: migration 0001 and the forward-only migrator, against a
// real postgres:17-alpine.
import { appendFile, cp, mkdtemp, rm, writeFile } from "node:fs/promises";
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
];

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
    const [shipped] = await listMigrations(MIGRATIONS_DIR);
    expect(shipped?.name).toBe("0001_init.sql");
    expect((await applied(db)).map(({ name, checksum }) => ({ name, checksum }))).toEqual([
      { name: "0001_init.sql", checksum: shipped?.checksum },
    ]);

    const version = await sql<{ v: string }>`show server_version_num`.execute(db);
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
      expect((await applied(a)).map((r) => r.name)).toEqual(["0001_init.sql"]);
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
    await writeFile(join(dir, "0002_more.sql"), "create table more_things (id int);\n");

    const run = migrateFrom(db, dir);
    await expect(run).rejects.toThrow(MigrationError);
    await expect(migrateFrom(db, dir)).rejects.toThrow(/0001_init\.sql.*checksum/);
    expect(await applied(db)).toEqual(before);
    expect(await tableNames(db)).not.toContain("more_things");
  });

  test("an applied migration file that has gone missing stops migrate", async () => {
    const { db } = await pgc.freshDatabase();
    await writeFile(join(dir, "0002_more.sql"), "create table more_things (id int);\n");
    await migrateFrom(db, dir);
    await rm(join(dir, "0002_more.sql"));

    await expect(migrateFrom(db, dir)).rejects.toThrow(/0002_more\.sql.*missing/);
  });

  test("a new migration file is applied after the ones already applied", async () => {
    const { db } = await pgc.freshDatabase();
    await migrateFrom(db, dir);
    await writeFile(join(dir, "0002_more.sql"), "create table more_things (id int);\n");

    await migrateFrom(db, dir);

    expect((await applied(db)).map((r) => r.name)).toEqual(["0001_init.sql", "0002_more.sql"]);
    expect(await tableNames(db)).toContain("more_things");
  });

  test("a migration that fails part way applies nothing and is not recorded", async () => {
    const { db } = await pgc.freshDatabase();
    await migrateFrom(db, dir);
    await writeFile(
      join(dir, "0002_broken.sql"),
      "create table half_made (id int);\nselect no_such_function();\n",
    );

    await expect(migrateFrom(db, dir)).rejects.toThrow(/0002_broken\.sql/);

    expect((await applied(db)).map((r) => r.name)).toEqual(["0001_init.sql"]);
    expect(await tableNames(db)).not.toContain("half_made");
  });
});
