// Tags and collections, the two kinds of name a model is filed under: one
// row per name ignoring case (the unique index on lower(name)), made on
// first use. Since issue #312 either can be deleted, and a tag no model has
// is removed, so a row found by name can be gone a moment later. Every link
// to one is therefore made through ensureLabels, which finds or makes the
// rows and holds a key share lock on each to the end of the transaction:
//
// - A delete (a Delete on the Tags or Collections page, or an unused tag's
//   removal) locks the row FOR UPDATE, which waits for that key share lock.
//   So a link being made commits first, and the removal of an unused tag,
//   which checks for links in a later statement, sees it and keeps the tag.
// - A link made after a delete committed finds no row, so the name is made
//   again and linked to the new row; the model never ends up silently
//   without the tag or collection it was given.
//
// Key share locks do not conflict with each other, so two requests linking
// the same names never wait on each other's locks; they are taken in id
// order all the same, as every FOR UPDATE on these rows is (repos/tags.ts),
// so a request locking several cannot deadlock with a purge locking several.
import { type Kysely, sql } from "kysely";
import { uuidv7 } from "../db/ids.js";
import type { DB } from "../db/types.js";

export type LabelTable = "tags" | "collections";

/** Tries ensureLabels makes when a delete keeps removing a row it just found or made. */
export const LABEL_TRIES = 3;

/**
 * The names sorted by their lowercase form, compared by code unit so every
 * request puts the same names in the same order.
 */
export function byLowerName(values: readonly string[]): string[] {
  return values
    .map((name) => ({ name, key: name.toLowerCase() }))
    .sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
    .map((entry) => entry.name);
}

/**
 * The ids of the rows for these names (trimmed, not blank), made if new and
 * key share locked until the transaction ends, in id order. trx must be a
 * transaction, or the locks would end with the statement. New rows are made
 * in lower(name) order: an insert waits on another transaction's uncommitted
 * row of the same lower(name), so two requests making the same names in
 * opposite orders would deadlock (PR #246 review). Names are matched with
 * Postgres's lower() on both sides, the unique index's rule.
 */
export async function ensureLabels(
  trx: Kysely<DB>,
  table: LabelTable,
  names: readonly string[],
): Promise<string[]> {
  if (!trx.isTransaction) throw new Error("ensureLabels needs a transaction");
  for (let attempt = 1; ; attempt += 1) {
    for (const name of byLowerName(names)) {
      await trx
        .insertInto(table)
        .values({ id: uuidv7(), name })
        .onConflict((oc) => oc.expression(sql`lower(name)`).doNothing())
        .execute();
    }
    // A row whose delete commits while the lock waits on it is skipped by
    // the lock. What is missing is therefore worked out from the rows this
    // statement actually locked, in the same statement: a later statement
    // takes a new snapshot, and would miss a name deleted here and made
    // again by a third request in between (PR #367 review). One row per
    // name, with a null id where no row was locked.
    const { rows } = await sql<{ id: string | null }>`
      with wanted as (
        select distinct lower(w.name) as key
        from unnest(cast(${names} as text[])) as w(name)
      ),
      locked as materialized (
        select t.id, lower(t.name) as key
        from ${sql.table(table)} t
        where lower(t.name) in (select key from wanted)
        order by t.id
        for key share of t
      )
      select l.id
      from wanted w
      left join locked l on l.key = w.key
      order by l.id
    `.execute(trx);
    const ids = rows.flatMap((r) => (r.id === null ? [] : [r.id]));
    if (ids.length === rows.length) return ids;
    if (attempt >= LABEL_TRIES) {
      throw new Error(
        `${table}: a name was deleted ${LABEL_TRIES} times while it was being linked`,
      );
    }
  }
}

/**
 * Deletes the tag or collection of this name, matched ignoring case: every
 * link to it goes with it (on delete cascade), and no model changes
 * otherwise. Answers the name as it was stored, or null when there was none.
 */
export async function deleteLabel(
  db: Kysely<DB>,
  table: LabelTable,
  name: string,
): Promise<string | null> {
  const trimmed = name.trim();
  if (trimmed === "") return null;
  const row = await db
    .deleteFrom(table)
    .where(sql<boolean>`lower(name) = lower(${trimmed})`)
    .returning("name")
    .executeTakeFirst();
  return row?.name ?? null;
}
