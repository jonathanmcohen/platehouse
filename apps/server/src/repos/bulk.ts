// The library's bulk actions (the maintainer, 2026-11-19): add tags to, remove a tag
// from, add to a collection, or move to the trash every selected model, in
// one request and one transaction.
//
// - The ids are read first (readIds): repeats are dropped ignoring case and
//   a malformed one is reported as not found without a query. At most
//   MAX_BULK_IDS a request (the routes' schema refuses more), the most View
//   all shows and Select all matching selects.
// - In the transaction, every selected model that exists is locked FOR NO
//   KEY UPDATE to change its tags or collections and FOR UPDATE to trash it
//   (as repos/models.ts trash does). Both conflict with the FOR SHARE lock
//   library/live.ts's withLiveModel takes on a single model (see the view
//   below). NO KEY UPDATE, unlike UPDATE, does not conflict with the key
//   share lock a new tag or collection link's foreign key check takes on its
//   model, so it does not hold up links made elsewhere for longer. A
//   model in the trash is not changed and is reported as in_trash, one that
//   does not exist as not_found; the others are changed together or, if a
//   statement fails, not at all.
// - Lock order (issue #286). Every row a bulk action locks, it locks in one
//   fixed order, whatever order the request listed the models in: the
//   models by id; Add tags' new tags by lower(name); the tag links an add
//   inserts and a removal deletes by model id, then tag id; the collection
//   links by model id; the trashed models by id. Two bulk requests therefore
//   wait on each other's rows in the same order and cannot deadlock each
//   other on them. That does not cover a deadlock with some other writer (a
//   single-model tag or collection change, an ingest, a purge) or an order
//   this file missed, so each action's transaction is tried again, up to
//   BULK_TRIES tries in all with a short jittered wait, when Postgres ends it
//   with a deadlock (40P01) or serialization failure (40001); a retry starts
//   the whole action again and nothing of the failed try is kept. If every
//   try fails, the request answers 500 and nothing changed. Run inside a
//   caller's transaction (inTransaction), an action is not retried, since
//   the failed statement has already aborted that transaction.
// - The view (the maintainer, 2026-11-20). Every action takes the library view the
//   selection was made in: its search and its tag, collection and creator
//   filters. After the selected models are locked, the action reads which
//   of the live ones that view holds now, with the models repository's
//   inView, the rule the library page lists by (viewQuery), and changes only
//   those. The others are answered in notInView and not touched, so Select
//   mode never acts on a model the search and filters hide, even one that
//   left the view after the page last checked. The view is read in the same
//   transaction as the change, after the row locks, and every action's lock
//   conflicts with the FOR SHARE lock a single-model tag or collection
//   change takes (library/live.ts) and with another bulk action's lock. So
//   a change that takes the model out of the view either commits before the
//   locks are granted, and the read (a new statement under Read Committed)
//   sees it, or waits for the bulk action to commit. Add tags, Remove tag
//   and Add to collection once locked FOR SHARE, which such a change does
//   not wait on, so one that committed between the read and the change was
//   not seen (PR #313 review).
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
import { type LibraryView, modelsRepo } from "./models.js";

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
  /**
   * Live models it left alone because the request's view (its search and
   * filters) no longer holds them, in the request's order.
   */
  notInView: string[];
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
 * Ids sorted as Postgres orders uuids: lowercase hex compared by code unit
 * is the uuid's byte order. A new list; the one given is left as it is.
 */
export function byId(ids: readonly string[]): string[] {
  return [...ids].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
}

/** Tries in all, the first included, before a deadlock or serialization failure is given up on. */
export const BULK_TRIES = 3;

/** Postgres SQLSTATEs that end a transaction which may well succeed when run again. */
const RETRYABLE = new Set(["40P01", "40001"]);

function isRetryable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && RETRYABLE.has(code);
}

/** How retryOnConflict waits; tests hand in their own. */
export interface RetryClock {
  sleep(ms: number): Promise<void>;
  /** A number from 0 up to 1, for the jitter. */
  random(): number;
}

const realClock: RetryClock = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
};

/**
 * Runs fn, and runs it again, up to BULK_TRIES times in all, while it fails
 * with a deadlock (40P01) or serialization failure (40001), waiting a short,
 * growing, jittered time between tries so two requests that met do not meet
 * again in step. Any other error, or the last try's, is thrown. Within the
 * caller's transaction (inCaller) fn runs once: a failed statement has
 * aborted that transaction, so only the caller can start again.
 */
export async function retryOnConflict<T>(
  inCaller: boolean,
  fn: () => Promise<T>,
  clock: RetryClock = realClock,
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (inCaller || attempt >= BULK_TRIES || !isRetryable(error)) throw error;
      await clock.sleep(Math.round(20 * attempt * (0.5 + clock.random())));
    }
  }
}

interface Selection {
  /**
   * Live models in the view, locked, in the request's order: the models the
   * action changes, and the order the answer lists them in.
   */
  live: string[];
  /** The same models sorted by id: the order every statement locks them in. */
  locked: string[];
  failed: BulkFailure[];
  /** Live models the view does not hold, in the request's order: left alone. */
  notInView: string[];
}

/**
 * Locks every selected model that exists, in id order, splits them into
 * live ones and failures, and keeps of the live ones only those the view
 * holds now (the rest go in notInView), each in the request's order. The
 * view is read after the locks, in the action's transaction.
 */
async function select(
  trx: Kysely<DB>,
  ids: readonly string[],
  lock: "noKeyUpdate" | "update",
  view: LibraryView,
): Promise<Selection> {
  const { valid } = readIds(ids);
  const found = new Map<string, boolean>();
  if (valid.length > 0) {
    let query = trx
      .selectFrom("models")
      .select(["id", "trashedAt"])
      .where("id", "in", valid)
      .orderBy("id");
    query = lock === "noKeyUpdate" ? query.forNoKeyUpdate() : query.forUpdate();
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
  const shown = new Set(await modelsRepo(trx).inView(view, live));
  const inView = live.filter((id) => shown.has(id));
  const notInView = live.filter((id) => !shown.has(id));
  return { live: inView, locked: byId(inView), failed, notInView };
}

/** An action's transaction, retried on a deadlock or serialization failure unless db is the caller's. */
function bulkTransaction<T>(db: Kysely<DB>, fn: (trx: Kysely<DB>) => Promise<T>): Promise<T> {
  return retryOnConflict(db.isTransaction, () => inTransaction(db, fn));
}

/** The result for these live models given the ones that changed. */
function result(selection: Selection, changedIds: Iterable<string>): BulkResult {
  const changed = new Set(changedIds);
  return {
    changed: selection.live.filter((id) => changed.has(id)),
    unchanged: selection.live.filter((id) => !changed.has(id)),
    failed: selection.failed,
    notInView: selection.notInView,
  };
}

/**
 * The stored names for these names, matched ignoring case, in the order given.
 * Matched in SQL with Postgres's lower() on both sides, the unique index's
 * rule, as repos/tags.ts does: JavaScript's toLowerCase does not always agree
 * with it (a word ending in a capital sigma lowers to a final sigma in
 * JavaScript and a medial one in Postgres), so a name lowered in JavaScript
 * could miss the row its insert made or found (PR #246 review).
 */
async function storedNames(
  trx: Kysely<DB>,
  table: "tags" | "collections",
  wanted: readonly string[],
): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`
    select t.name
    from unnest(cast(${wanted} as text[])) with ordinality as w(name, ord)
    join ${sql.table(table)} t on lower(t.name) = lower(w.name)
    group by t.name
    order by min(w.ord)
  `.execute(trx);
  return rows.map((r) => r.name);
}

export function bulkRepo(db: Kysely<DB>) {
  return {
    /**
     * Of the selected models, the live ones the view holds now, in the
     * request's order; a malformed, missing or trashed one is left out.
     * The rule every action keeps to (models.inView), with no sort and no
     * match cap, and nothing is locked or changed. The library page asks it
     * about selected models past the first 1000 matches that
     * GET /app/api/library/ids answers, so its view check does not take out
     * a model that still matches (PR #313 review).
     */
    async inView(ids: readonly string[], view: LibraryView): Promise<string[]> {
      return modelsRepo(db).inView(view, readIds(ids).valid);
    },

    /**
     * Adds every tag to every selected live model, making a tag on first use;
     * tags a model already has are kept, and a model that had them all is
     * unchanged. RangeError for a blank tag or none.
     */
    async addTags(ids: readonly string[], tags: readonly string[], view: LibraryView) {
      const wanted = names(tags, "tag");
      return bulkTransaction(db, async (trx) => {
        const selection = await select(trx, ids, "noKeyUpdate", view);
        // Made in lower(name) order, not the request's: a new tag's insert
        // waits on another transaction's uncommitted row of the same
        // lower(name), so two requests making the same tags in opposite
        // orders would deadlock (PR #246 review).
        for (const name of byLowerName(wanted)) {
          await trx
            .insertInto("tags")
            .values({ id: uuidv7(), name })
            .onConflict((oc) => oc.expression(sql`lower(name)`).doNothing())
            .execute();
        }
        let changed: string[] = [];
        if (selection.locked.length > 0) {
          // Links in (model id, tag id) order: an insert waits on another
          // transaction's uncommitted link with the same key (issue #286).
          // The tags are matched with lower() on both sides, as their insert's
          // conflict is, never with JavaScript's toLowerCase (see storedNames).
          const { rows } = await sql<{ id: string }>`
            insert into model_tags (model_id, tag_id)
            select m.id, t.id
            from unnest(cast(${selection.locked} as uuid[])) as m(id)
            cross join tags t
            where lower(t.name) in (select lower(w.name) from unnest(cast(${wanted} as text[])) as w(name))
            order by m.id, t.id
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
    async removeTag(ids: readonly string[], tag: string, view: LibraryView) {
      const [name] = names([tag], "tag") as [string];
      return bulkTransaction(db, async (trx) => {
        const selection = await select(trx, ids, "noKeyUpdate", view);
        let changed: string[] = [];
        if (selection.locked.length > 0) {
          // A DELETE takes no order, so the links are locked first, in
          // (model id, tag id) order, and then deleted (issue #286).
          const { rows } = await sql<{ id: string }>`
            delete from model_tags mt
            using (
              select l.model_id, l.tag_id
              from model_tags l
              where l.model_id = any(cast(${selection.locked} as uuid[]))
                and l.tag_id in (select id from tags where lower(name) = lower(${name}))
              order by l.model_id, l.tag_id
              for update
            ) gone
            where mt.model_id = gone.model_id and mt.tag_id = gone.tag_id
            returning mt.model_id as id
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
    async addToCollection(ids: readonly string[], collection: string, view: LibraryView) {
      const [name] = names([collection], "collection") as [string];
      return bulkTransaction(db, async (trx) => {
        const selection = await select(trx, ids, "noKeyUpdate", view);
        await trx
          .insertInto("collections")
          .values({ id: uuidv7(), name })
          .onConflict((oc) => oc.expression(sql`lower(name)`).doNothing())
          .execute();
        let changed: string[] = [];
        if (selection.locked.length > 0) {
          // Links in model id order, for the same reason as Add tags' links.
          const { rows } = await sql<{ id: string }>`
            insert into collection_models (collection_id, model_id)
            select c.id, m.id
            from unnest(cast(${selection.locked} as uuid[])) as m(id)
            cross join collections c
            where lower(c.name) = lower(${name})
            order by m.id
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
    async trash(ids: readonly string[], view: LibraryView): Promise<BulkResult> {
      return bulkTransaction(db, async (trx) => {
        const selection = await select(trx, ids, "update", view);
        let changed: string[] = [];
        if (selection.locked.length > 0) {
          // The rows are already locked FOR UPDATE, in id order, by select(),
          // so this takes no new lock, and the stamp is taken after any wait.
          const { rows } = await sql<{ id: string }>`
            update models set trashed_at = clock_timestamp()
            where id = any(cast(${selection.locked} as uuid[])) and trashed_at is null
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
