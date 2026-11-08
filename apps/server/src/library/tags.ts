// Tags on a model (build plan Task 14; AC-061). The rows are written by the
// tags repository; this module refuses a model that is unknown or trashed,
// which the API answers with 404 (AC-084: a trashed model is invisible).
// Filtering the library by tag is search({ tag }) in search.ts.
import type { Kysely } from "kysely";
import type { DB } from "../db/types.js";
import { tagsRepo } from "../repos/tags.js";
import { withLiveModel } from "./live.js";

export function createTags(db: Kysely<DB>) {
  return {
    /**
     * Tags a live model, making the tag on first use; tagging twice is a
     * no-op that still answers true. False when the model is unknown,
     * malformed or trashed; RangeError for an empty tag.
     */
    async addTag(modelId: string, tag: string): Promise<boolean> {
      return withLiveModel(db, modelId, async (trx) => {
        await tagsRepo(trx).add(modelId, tag);
        return true;
      });
    },

    /**
     * Untags a live model; the tag itself stays. False when the model is
     * unknown, malformed or trashed, or did not have the tag.
     */
    async removeTag(modelId: string, tag: string): Promise<boolean> {
      return withLiveModel(db, modelId, (trx) => tagsRepo(trx).remove(modelId, tag));
    },
  };
}
