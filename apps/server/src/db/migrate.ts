import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Kysely, sql } from "kysely";
import type { DB } from "./types.js";

// Forward-only migrations from hand-written SQL files (build plan decision 4,
// lesson 14: nothing generates DDL, and a reviewer reads every statement).
//
// A migration is a file NNNN_name.sql in migrations/, numbered from 0001 with
// no gaps. Names that start with "." or do not end in .sql are skipped; a .sql
// file named any other way stops migrate(). migrate() applies the ones not
// yet recorded in schema_migrations, in number order, and records each with
// the SHA-256 of its bytes. It refuses to run, and applies nothing, when an
// applied file's checksum has changed or an applied file is missing: an
// applied migration is never edited, a change goes in a new file. The one
// exception is PREVIOUS_CHECKSUMS below: four files whose comments were
// reworded after they shipped.

// The migrations folder is found next to this module. Run from source that is
// src/db/migrations. tsc -b compiles this file to dist/src/db/migrate.js and
// copies no .sql files, so a built server looks in dist/src/db/migrations and
// migrate() fails with ENOENT unless the build copies src/db/migrations there.
// The app image does: docker/app.Dockerfile copies src/db/migrations next to
// the built migrate.js, as dist/src/db/migrations, and checks the copy file for
// file (issue #31). A plain tsc -b still copies nothing.
export const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

const NAME = /^([0-9]{4})_[a-z0-9_]+\.sql$/;

export interface PreviousChecksum {
  /** The SHA-256 the file had before its comments were reworded. */
  previous: string;
  /** The SHA-256 of the file as shipped now. */
  current: string;
}

/**
 * Applied migrations whose comments were reworded after they shipped, to take
 * a personal name out of the public source (PR #320). Only comments changed,
 * never a statement, so a database that applied the earlier bytes has the
 * same schema; it just recorded a different checksum. For each file listed
 * here, a recorded previous checksum counts as the same file while the file
 * is still exactly current, and the row keeps the checksum it recorded. Any
 * other mismatch still stops migrate(). Nothing else may be added here: a
 * change to a migration goes in a new file.
 *
 * Each previous digest was computed with
 * git show d268f23:apps/server/src/db/migrations/<name> | shasum -a 256.
 */
export const PREVIOUS_CHECKSUMS: ReadonlyMap<string, PreviousChecksum> = new Map([
  [
    "0001_init.sql",
    {
      previous: "438a41b92fdee7448af0fbfd296f81e00cdb4516849e80d3643705a60e1dc2bb",
      current: "3d6ca3d3d57e2d9c29fa29fb03a7a559b4ce0bbf0ce190f390a68ba52962bbf1",
    },
  ],
  [
    "0004_files_sha256.sql",
    {
      previous: "a8c5fb155cbc3a8ca7f053e13cba19708bd7da3177623bff7023d8583b003626",
      current: "b8b09c173e5b5a20eb278a454d299963387603dbdd5012a92c089d11593560a2",
    },
  ],
  [
    "0007_my_printers.sql",
    {
      previous: "b3edabeef0ec9c6a2cea1a1b64f45dda14f5b548976408285cbad82b8a437720",
      current: "351e661b978d9d4762c318634e44d49ea99bc82310b7f20ab9af09e36bcd7a2e",
    },
  ],
  [
    "0008_library_sort.sql",
    {
      previous: "f3211d19f8eab30a0867e4925b8b483afee2f290e370d667e7b2b7fa0c6632a5",
      current: "588ed7b8cd458ea8786166d98ba07db40db4404994708594b71a9e7ac2858185",
    },
  ],
]);

/**
 * Whether an applied migration's recorded checksum matches its file: the same
 * digest, or, for a file in PREVIOUS_CHECKSUMS that is still exactly as
 * shipped, its one listed previous digest.
 */
export function isSameMigration(name: string, recorded: string, current: string): boolean {
  if (recorded === current) return true;
  const known = PREVIOUS_CHECKSUMS.get(name);
  return known !== undefined && known.previous === recorded && known.current === current;
}

/**
 * Whether a folder entry is meant as a migration at all. A name that starts
 * with "." (a Finder .DS_Store, a macOS ._ file, a vim swap file) or does not
 * end in .sql (an editor backup such as 0002_x.sql~) is not, and is skipped
 * so it cannot stop the server (issue #30). The extension is matched in any
 * case, so 0001_init.SQL still reaches the name check and is refused.
 */
function isMigrationCandidate(name: string): boolean {
  return !name.startsWith(".") && name.toLowerCase().endsWith(".sql");
}

export class MigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MigrationError";
  }
}

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export async function listMigrations(dir: string): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter(isMigrationCandidate).sort();
  const files: MigrationFile[] = [];
  for (const [i, name] of entries.entries()) {
    const number = NAME.exec(name)?.[1];
    if (number === undefined) {
      throw new MigrationError(
        `Migration file ${name} is not named NNNN_name.sql (lowercase letters, digits, _)`,
      );
    }
    const expected = String(i + 1).padStart(4, "0");
    if (number !== expected) {
      throw new MigrationError(
        `Migration ${name} is out of sequence: expected number ${expected} next (no gaps, no repeats, starting at 0001)`,
      );
    }
    const bytes = await readFile(join(dir, name));
    files.push({
      name,
      sql: bytes.toString("utf8"),
      checksum: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return files;
}

/** Applies the shipped migrations, from MIGRATIONS_DIR. */
export async function migrate(db: Kysely<DB>): Promise<void> {
  await migrateFrom(db, MIGRATIONS_DIR);
}

/**
 * Applies the migrations in dir. The whole run is one transaction under an
 * advisory lock, so two servers starting at once apply each file once, and a
 * failure anywhere applies nothing. migrate() is this with the shipped
 * folder; tests point it at a copy they change.
 */
export async function migrateFrom(db: Kysely<DB>, dir: string): Promise<void> {
  const files = await listMigrations(dir);
  await db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtext('platehouse.migrate'))`.execute(trx);
    await sql`
      create table if not exists schema_migrations (
        name       text primary key,
        checksum   text not null,
        applied_at timestamptz not null default now()
      )`.execute(trx);
    const applied = await trx
      .selectFrom("schemaMigrations")
      .select(["name", "checksum"])
      .orderBy("name")
      .execute();

    for (const [i, row] of applied.entries()) {
      const file = files.find((f) => f.name === row.name);
      if (file === undefined) {
        throw new MigrationError(
          `Applied migration ${row.name} is missing from the migrations folder; refusing to migrate`,
        );
      }
      if (!isSameMigration(row.name, row.checksum, file.checksum)) {
        throw new MigrationError(
          `Applied migration ${row.name} has changed since it was applied (checksum ${row.checksum} recorded, ${file.checksum} now); refusing to migrate. Put the change in a new migration file.`,
        );
      }
      if (files[i]?.name !== row.name) {
        throw new MigrationError(
          `Applied migration ${row.name} is out of order with the migrations folder; refusing to migrate`,
        );
      }
    }

    for (const file of files.slice(applied.length)) {
      try {
        await sql.raw(file.sql).execute(trx);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new MigrationError(`Migration ${file.name} failed: ${reason}`, { cause: error });
      }
      await trx
        .insertInto("schemaMigrations")
        .values({ name: file.name, checksum: file.checksum })
        .execute();
    }
  });
}
