// Tags on a model, which can be added and removed. The rows are written by the
// tags repository; this module refuses a model that is unknown or trashed,
// which the API answers with 404 (a trashed model is invisible to the API).
// Filtering the library by tag is search({ tag }) in search.ts.
//
// The web app's calls remove a tag no model has any more when its last
// model loses it (issue #312, dropUnusedTags); the public API's do not, as
// the API never deletes anything, so the tag itself stays there.
import type { Kysely } from "kysely";
import type { DB } from "../db/types.js";
import { tagsRepo } from "../repos/tags.js";
import { withLiveModel } from "./live.js";

export interface TagsOptions {
  /** Remove a tag when removeTag takes it off its last model, live or trashed. */
  dropUnusedTags?: boolean;
}

export function createTags(db: Kysely<DB>, options: TagsOptions = {}) {
  const dropUnused = options.dropUnusedTags === true;
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
     * Untags a live model. False when the model is unknown, malformed or
     * trashed, or did not have the tag. The tag itself stays, unless
     * dropUnusedTags is set and no model has it any more.
     */
    async removeTag(modelId: string, tag: string): Promise<boolean> {
      return withLiveModel(db, modelId, (trx) =>
        tagsRepo(trx).remove(modelId, tag, { dropUnused }),
      );
    },
  };
}
