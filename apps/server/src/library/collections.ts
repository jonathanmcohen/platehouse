// Collections (build plan Task 14; AC-062, Q17). A model can sit in more than
// one collection. Collections are flat: the schema has no column through which
// a collection could hold another, and these calls only ever put a model in
// one. The rows are written by the collections repository; this module
// refuses a model that is unknown or trashed. Filtering the library by
// collection is search({ collection }) in search.ts.
import type { Kysely } from "kysely";
import type { DB } from "../db/types.js";
import { collectionsRepo } from "../repos/collections.js";
import { withLiveModel } from "./live.js";

export function createCollections(db: Kysely<DB>) {
  return {
    /**
     * Puts a live model in a collection, making the collection on first use;
     * twice is a no-op that still answers true. False when the model is
     * unknown, malformed or trashed; RangeError for an empty name.
     */
    async addToCollection(modelId: string, collection: string): Promise<boolean> {
      return withLiveModel(db, modelId, async (trx) => {
        await collectionsRepo(trx).add(modelId, collection);
        return true;
      });
    },

    /**
     * Takes a live model out of a collection; the collection itself stays.
     * False when the model is unknown, malformed or trashed, or was not in it.
     */
    async removeFromCollection(modelId: string, collection: string): Promise<boolean> {
      return withLiveModel(db, modelId, (trx) => collectionsRepo(trx).remove(modelId, collection));
    },
  };
}
