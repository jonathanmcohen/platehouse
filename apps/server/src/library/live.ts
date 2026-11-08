// Shared by the organising calls (build plan Task 14): every change to a model
// first takes a share lock on its row and checks it is live. A trashed model
// is invisible (AC-063), and the lock makes a purge of the same model, which
// holds the row FOR UPDATE while it deletes objects, wait for the change or
// the change wait for the purge, so neither sees half of the other.
import type { Kysely } from "kysely";
import { isUuid } from "../db/ids.js";
import { inTransaction } from "../db/kysely.js";
import type { DB } from "../db/types.js";

/**
 * Runs fn in a transaction once the model is found live and share-locked;
 * false, without running fn, when it is unknown, malformed or trashed.
 */
export async function withLiveModel(
  db: Kysely<DB>,
  modelId: string,
  fn: (trx: Kysely<DB>) => Promise<boolean | undefined>,
): Promise<boolean> {
  if (!isUuid(modelId)) return false;
  return inTransaction(db, async (trx) => {
    const live = await trx
      .selectFrom("models")
      .select("id")
      .where("id", "=", modelId)
      .where("trashedAt", "is", null)
      .forShare()
      .executeTakeFirst();
    if (live === undefined) return false;
    return (await fn(trx)) ?? true;
  });
}
