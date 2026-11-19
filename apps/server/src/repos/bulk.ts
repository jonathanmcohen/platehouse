// The library's bulk actions (Jon, 2026-11-19): add tags to, remove a tag
// from, add to a collection, or move to the trash every selected model, in
// one request and one transaction.
//
// - The ids are read first (readIds): repeats are dropped ignoring case and
//   a malformed one is reported as not found without a query. At most
//   MAX_BULK_IDS a request (the routes' schema refuses more), the most View
//   all shows and Select all matching selects.
// - In the transaction, every selected model that exists is locked, in id
//   order so two bulk requests cannot deadlock, FOR SHARE to change its tags
//   or collections (as library/live.ts's withLiveModel locks one) and FOR
//   UPDATE to trash it (as repos/models.ts trash does). A model in the trash
//   is not changed and is reported as in_trash, one that does not exist as
//   not_found; the others are changed together or, if a statement fails, not
//   at all (the request answers 500).
// - The answer says which models changed, which were left as they were
//   (they already had the tags, did not have the tag, or were already in the
//   collection) and which failed and why. Tags and collections are one per
//   name ignoring case, made on first use, and the first name written is the
//   one kept, so the answer also names them as stored.
// - Trash is the soft delete: trashed_at is set and nothing else changes, so
//   a model can be restored from the trash for 30 days. trashed_at is the
//   time the row is written once its lock is held (issue #193). Nothing here
//   deletes a model.
import { type Kysely, sql } from "kysely";
import { isUuid, uuidv7 } from "../db/ids.js";
import { inTransaction } from "../db/kysely.js";
import type { DB } from "../db/types.js";

/** Most models one bulk request changes: View all's and Select all matching's most. */
export const MAX_BULK_IDS = 1000;

/** Most tags one Add tags request adds. */
export const MAX_BULK_TAGS = 20;

/** Why a selected model was not changed. */
export type BulkFailureReason = "not_found" | "in_trash";

export interface BulkFailure {
  /** The id as the request gave it (lowercased when it is a well-formed id). */
  id: string;
  reason: BulkFailureReason;
}

export interface BulkResult {
  /** Models the action changed, in the request's order. */
  changed: string[];
  /** Live models it left as they were, in the request's order. */
  unchanged: string[];
  /** Models it could not change, in the request's order. */
  failed: BulkFailure[];
}

/** The request's ids: well-formed ones lowercased, repeats dropped, order kept. */
export function readIds(ids: readonly string[]): { valid: string[]; malformed: string[] } {
  const valid: string[] = [];
  const malformed: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = raw.trim().toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    if (isUuid(id)) valid.push(id);
    else malformed.push(raw);
  }
  return { valid, malformed };
}

/** Names trimmed, blank ones refused, repeats ignoring case dropped. */
function names(values: readonly string[], what: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const name = value.trim();
    if (name === "") throw new RangeError(`A ${what} name must not be empty`);
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  if (out.length === 0) throw new RangeError(`Name at least one ${what}`);
  return out;
}

interface Selection {
  /** Live models, locked, in the request's order. */
  live: string[];
  failed: BulkFailure[];
}

/**
 * Locks every selected model that exists, in id order, and splits them into
 * live ones and failures, each in the request's order.
 */
async function select(
  trx: Kysely<DB>,
  ids: readonly string[],
  lock: "share" | "update",
): Promise<Selection> {
  const { valid } = readIds(ids);
  const found = new Map<string, boolean>();
  if (valid.length > 0) {
    let query = trx
      .selectFrom("models")
      .select(["id", "trashedAt"])
      .where("id", "in", valid)
      .orderBy("id");
    query = lock === "share" ? query.forShare() : query.forUpdate();
    for (const row of await query.execute()) found.set(row.id, row.trashedAt === null);
  }
  const live: string[] = [];
  const failed: BulkFailure[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = raw.trim().toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    if (!isUuid(id)) {
      failed.push({ id: raw, reason: "not_found" });
      continue;
    }
    const isLive = found.get(id);
    if (isLive === undefined) failed.push({ id, reason: "not_found" });
    else if (isLive) live.push(id);
    else failed.push({ id, reason: "in_trash" });
  }
  return { live, failed };
}

/** The result for these live models given the ones that changed. */
function result(selection: Selection, changedIds: Iterable<string>): BulkResult {
  const changed = new Set(changedIds);
  return {
    changed: selection.live.filter((id) => changed.has(id)),
    unchanged: selection.live.filter((id) => !changed.has(id)),
    failed: selection.failed,
  };
}

/** The stored names for these names, matched ignoring case, in the order given. */
async function storedNames(
  trx: Kysely<DB>,
  table: "tags" | "collections",
  wanted: readonly string[],
): Promise<string[]> {
  const rows = await trx
    .selectFrom(table)
    .select("name")
    .where(sql<boolean>`lower(name) = any(cast(${wanted.map((n) => n.toLowerCase())} as text[]))`)
    .execute();
  const byKey = new Map(rows.map((r) => [r.name.toLowerCase(), r.name]));
  return wanted.map((n) => byKey.get(n.toLowerCase())).filter((n): n is string => n !== undefined);
}

export function bulkRepo(db: Kysely<DB>) {
  return {
    /**
     * Adds every tag to every selected live model, making a tag on first use;
     * tags a model already has are kept, and a model that had them all is
     * unchanged. RangeError for a blank tag or none.
     */
    async addTags(ids: readonly string[], tags: readonly string[]) {
      const wanted = names(tags, "tag");
      return inTransaction(db, async (trx) => {
        const selection = await select(trx, ids, "share");
        for (const name of wanted) {
          await trx
            .insertInto("tags")
            .values({ id: uuidv7(), name })
            .onConflict((oc) => oc.expression(sql`lower(name)`).doNothing())
            .execute();
        }
        let changed: string[] = [];
        if (selection.live.length > 0) {
          const { rows } = await sql<{ id: string }>`
            insert into model_tags (model_id, tag_id)
            select m.id, t.id
            from unnest(cast(${selection.live} as uuid[])) as m(id)
            cross join tags t
            where lower(t.name) = any(cast(${wanted.map((n) => n.toLowerCase())} as text[]))
            on conflict (model_id, tag_id) do nothing
            returning model_id as id
          `.execute(trx);
          changed = rows.map((r) => r.id);
        }
        return { ...result(selection, changed), tags: await storedNames(trx, "tags", wanted) };
      });
    },

    /**
     * Takes the tag off every selected live model; the tag itself stays. A
     * model without it is unchanged. tag is the stored name, or null when no
     * tag has that name.
     */
    async removeTag(ids: readonly string[], tag: string) {
      const [name] = names([tag], "tag") as [string];
      return inTransaction(db, async (trx) => {
        const selection = await select(trx, ids, "share");
        let changed: string[] = [];
        if (selection.live.length > 0) {
          const { rows } = await sql<{ id: string }>`
            delete from model_tags
            where model_id = any(cast(${selection.live} as uuid[]))
              and tag_id in (select id from tags where lower(name) = lower(${name}))
            returning model_id as id
          `.execute(trx);
          changed = rows.map((r) => r.id);
        }
        const [stored] = await storedNames(trx, "tags", [name]);
        return { ...result(selection, changed), tag: stored ?? null };
      });
    },

    /**
     * Puts every selected live model in the collection, making it on first
     * use; a model already in it is unchanged. Collections are flat.
     */
    async addToCollection(ids: readonly string[], collection: string) {
      const [name] = names([collection], "collection") as [string];
      return inTransaction(db, async (trx) => {
        const selection = await select(trx, ids, "share");
        await trx
          .insertInto("collections")
          .values({ id: uuidv7(), name })
          .onConflict((oc) => oc.expression(sql`lower(name)`).doNothing())
          .execute();
        let changed: string[] = [];
        if (selection.live.length > 0) {
          const { rows } = await sql<{ id: string }>`
            insert into collection_models (collection_id, model_id)
            select c.id, m.id
            from unnest(cast(${selection.live} as uuid[])) as m(id)
            cross join collections c
            where lower(c.name) = lower(${name})
            on conflict (collection_id, model_id) do nothing
            returning model_id as id
          `.execute(trx);
          changed = rows.map((r) => r.id);
        }
        const [stored] = await storedNames(trx, "collections", [name]);
        return { ...result(selection, changed), collection: stored ?? name };
      });
    },

    /**
     * Moves every selected live model to the trash (the soft delete: only
     * trashed_at is set, so each can be restored for 30 days). A model
     * already in the trash is reported as in_trash. Never deletes anything.
     */
    async trash(ids: readonly string[]): Promise<BulkResult> {
      return inTransaction(db, async (trx) => {
        const selection = await select(trx, ids, "update");
        let changed: string[] = [];
        if (selection.live.length > 0) {
          // The rows are locked above, so the stamp is taken after any wait.
          const { rows } = await sql<{ id: string }>`
            update models set trashed_at = clock_timestamp()
            where id = any(cast(${selection.live} as uuid[])) and trashed_at is null
            returning id
          `.execute(trx);
          changed = rows.map((r) => r.id);
        }
        return result(selection, changed);
      });
    },
  };
}

export type BulkRepo = ReturnType<typeof bulkRepo>;
