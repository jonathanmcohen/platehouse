import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Kysely } from "kysely";
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
  constructor(message: string) {
    super(message);
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

export async function migrate(db: Kysely<DB>): Promise<void> {
  await migrateFrom(db, MIGRATIONS_DIR);
}

export async function migrateFrom(_db: Kysely<DB>, _dir: string): Promise<void> {
  throw new Error("not implemented: migrateFrom");
}
