// Duplicate files (approved for 0.1.0 by Jon, 2026-11-19): a file is a
// duplicate when a live model (neither in the trash nor being purged)
// already holds a file with the same SHA-256. Ingest records every file's
// SHA-256 (files.sha256, indexed by migration 0004), so the lookup is one
// indexed query. A file in a trashed model never counts: the trash is on its
// way out, and the API cannot see it at all (AC-063, AC-084).
import type { Kysely } from "kysely";
import type { DB } from "../db/types.js";

/** Whether ingest refuses a duplicate ("skip") or stores it anyway ("allow"). */
export type DuplicatePolicy = "skip" | "allow";

/** A live file that already holds the same bytes, and the model it is in. */
export interface DuplicateMatch {
  modelId: string;
  modelName: string;
  fileId: string;
  fileName: string;
}

/** The most matches a lookup returns; the oldest come first. */
export const MAX_DUPLICATES = 10;

/** The longest model name a message quotes before it is cut short with "...". */
const NAME_CHARS = 100;

/**
 * The live files whose SHA-256 is sha256, oldest first, at most
 * MAX_DUPLICATES. Runs on the database or inside a transaction.
 */
export async function findDuplicates(db: Kysely<DB>, sha256: Buffer): Promise<DuplicateMatch[]> {
  return db
    .selectFrom("files")
    .innerJoin("models", "models.id", "files.modelId")
    .select([
      "models.id as modelId",
      "models.name as modelName",
      "files.id as fileId",
      "files.name as fileName",
    ])
    .where("files.sha256", "=", sha256)
    .where("models.trashedAt", "is", null)
    .where("models.purgeStartedAt", "is", null)
    .orderBy("files.createdAt")
    .orderBy("files.id")
    .limit(MAX_DUPLICATES)
    .execute();
}

/** A model name as one short line: control characters and runs of space made one space. */
function oneLine(name: string): string {
  const text = name.replace(/[\s\p{Cc}]+/gu, " ").trim();
  return text.length > NAME_CHARS ? `${text.slice(0, NAME_CHARS)}...` : text;
}

/**
 * What a refused duplicate says: the first model that holds the file, by
 * name and id, and how many other models hold it. It is the upload's result
 * for the API and the inbox's reason file; the web dialog draws its own row
 * from the matches.
 */
export function duplicateMessage(matches: readonly DuplicateMatch[]): string {
  const first = matches[0];
  if (first === undefined) throw new TypeError("duplicateMessage needs at least one match");
  const others = new Set(matches.map((m) => m.modelId));
  others.delete(first.modelId);
  const more =
    others.size === 0 ? "" : ` and ${others.size} other model${others.size === 1 ? "" : "s"}`;
  return (
    `This file is already in the library, in the model "${oneLine(first.modelName)}" ` +
    `(id ${first.modelId})${more}, so it was skipped; nothing was saved`
  );
}

/** duplicateMessage's sentence, with or without the full stop the inbox's reason file adds. */
const DUPLICATE_SENTENCE =
  /^This file is already in the library, in the model "(.*)" \(id ([^\s()]+)\)(?: and (\d+) other models?)?, so it was skipped; nothing was saved\.?$/;

/**
 * duplicateMessage's sentence read back: the first model's name (as the
 * sentence quotes it) and id, and how many other models hold the file; or
 * undefined for any other text. The Activity page uses it to say an inbox
 * file refused as a duplicate in the page's language (inbox.reason.duplicate),
 * since the inbox's reason file keeps only the sentence.
 */
export function parseDuplicateMessage(
  text: string,
): { name: string; id: string; others: number } | undefined {
  const m = DUPLICATE_SENTENCE.exec(text);
  if (m === null) return undefined;
  return {
    name: m[1] as string,
    id: m[2] as string,
    others: m[3] === undefined ? 0 : Number(m[3]),
  };
}
