import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { listMigrations, MigrationError } from "../../src/db/migrate.js";

// listMigrations reads the migrations folder that migrate() applies. It needs
// no database, so it is tested here; migrate() itself is tested against a real
// Postgres 17 under test/integration/db.

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ph-migrations-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("listMigrations", () => {
  test("lists the files in number order with the SHA-256 of their bytes", async () => {
    await writeFile(join(dir, "0002_second.sql"), "select 2;\n");
    await writeFile(join(dir, "0001_init.sql"), "select 1;\n");
    await writeFile(join(dir, "0010_tenth.sql"), "select 10;\n");
    for (let n = 3; n <= 9; n++) {
      await writeFile(join(dir, `000${n}_step.sql`), `select ${n};\n`);
    }
    const files = await listMigrations(dir);
    expect(files.map((f) => f.name)).toEqual([
      "0001_init.sql",
      "0002_second.sql",
      "0003_step.sql",
      "0004_step.sql",
      "0005_step.sql",
      "0006_step.sql",
      "0007_step.sql",
      "0008_step.sql",
      "0009_step.sql",
      "0010_tenth.sql",
    ]);
    expect(files[0]).toEqual({
      name: "0001_init.sql",
      sql: "select 1;\n",
      checksum: sha256("select 1;\n"),
    });
  });

  test("an empty folder lists nothing", async () => {
    expect(await listMigrations(dir)).toEqual([]);
  });

  // A .sql file that is not named NNNN_name.sql is a migration named wrong,
  // so it stops migrate(). The extension is matched in any case here, so
  // 0001_init.SQL is refused rather than skipped.
  test.each([
    ["no number", "init.sql"],
    ["a three-digit number", "001_init.sql"],
    ["a dash instead of an underscore", "0001-init.sql"],
    ["capital letters", "0001_Init.sql"],
    ["a space", "0001_in it.sql"],
    ["an upper-case extension", "0001_init.SQL"],
  ])("refuses a .sql file with %s in its name", async (_why, name) => {
    await writeFile(join(dir, name), "select 1;\n");
    await expect(listMigrations(dir)).rejects.toThrow(MigrationError);
    await expect(listMigrations(dir)).rejects.toThrow(name);
  });

  // Issue #30: a file the folder picks up on a Mac or from an editor is not a
  // migration and must not stop the server. Names that start with "." or do
  // not end in .sql are skipped before the name check.
  test.each([
    ["a Finder .DS_Store", ".DS_Store"],
    ["a macOS AppleDouble file", "._0001_init.sql"],
    ["a vim swap file", ".0001_init.sql.swp"],
    ["an editor backup ending in ~", "0001_init.sql~"],
    ["a .bak copy", "0001_init.sql.bak"],
    ["another extension", "0001_init.txt"],
    ["no extension", "0001_init"],
  ])("skips %s beside the migrations", async (_why, name) => {
    await writeFile(join(dir, "0001_init.sql"), "select 1;\n");
    await writeFile(join(dir, name), "not a migration\n");
    const files = await listMigrations(dir);
    expect(files.map((f) => f.name)).toEqual(["0001_init.sql"]);
  });

  test("a folder holding only a .DS_Store lists nothing", async () => {
    await writeFile(join(dir, ".DS_Store"), "\x00\x00\x00\x01Bud1");
    expect(await listMigrations(dir)).toEqual([]);
  });

  test("a skipped file does not count in the numbering", async () => {
    await writeFile(join(dir, ".DS_Store"), "\x00\x00\x00\x01Bud1");
    await writeFile(join(dir, "0001_init.sql"), "select 1;\n");
    await writeFile(join(dir, "0001_init.sql~"), "select 0;\n");
    await writeFile(join(dir, "0002_second.sql"), "select 2;\n");
    const files = await listMigrations(dir);
    expect(files.map((f) => f.name)).toEqual(["0001_init.sql", "0002_second.sql"]);
  });

  test("refuses two files with the same number", async () => {
    await writeFile(join(dir, "0001_init.sql"), "select 1;\n");
    await writeFile(join(dir, "0001_again.sql"), "select 1;\n");
    await expect(listMigrations(dir)).rejects.toThrow(/0001/);
  });

  test("refuses a gap in the numbers", async () => {
    await writeFile(join(dir, "0001_init.sql"), "select 1;\n");
    await writeFile(join(dir, "0003_third.sql"), "select 3;\n");
    await expect(listMigrations(dir)).rejects.toThrow(/0002/);
  });

  test("refuses numbering that does not start at 0001", async () => {
    await writeFile(join(dir, "0002_second.sql"), "select 2;\n");
    await expect(listMigrations(dir)).rejects.toThrow(/0001/);
  });

  test("a missing folder is an error, not an empty list", async () => {
    await expect(listMigrations(join(dir, "nope"))).rejects.toThrow();
  });
});
