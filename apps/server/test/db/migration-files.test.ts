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

  test.each([
    ["no number", "init.sql"],
    ["a three-digit number", "001_init.sql"],
    ["a dash instead of an underscore", "0001-init.sql"],
    ["capital letters", "0001_Init.sql"],
    ["a space", "0001_in it.sql"],
    ["another extension", "0001_init.txt"],
    ["no extension", "0001_init"],
  ])("refuses a file with %s in its name", async (_why, name) => {
    await writeFile(join(dir, name), "select 1;\n");
    await expect(listMigrations(dir)).rejects.toThrow(MigrationError);
    await expect(listMigrations(dir)).rejects.toThrow(name);
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
