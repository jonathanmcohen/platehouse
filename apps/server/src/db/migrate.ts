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
// no gaps. migrate() applies the ones not yet recorded in schema_migrations,
// in number order, and records each with the SHA-256 of its bytes. It refuses
// to run, and applies nothing, when an applied file's checksum has changed or
// an applied file is missing: an applied migration is never edited, a change
// goes in a new file.

export const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

const NAME = /^([0-9]{4})_[a-z0-9_]+\.sql$/;

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
  const entries = (await readdir(dir)).sort();
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

/** Applies the shipped migrations (src/db/migrations). */
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
      if (file.checksum !== row.checksum) {
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
