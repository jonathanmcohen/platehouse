// Renaming (build plan Task 14; AC-060, Q16). A rename changes the display
// name only. The bucket key (models/<modelId>/<blobId>) holds no user text
// and is never renamed, and a file keeps its original_name.
import { type Kysely, sql } from "kysely";
import { isUuid } from "../db/ids.js";
import type { DB } from "../db/types.js";
import { withLiveModel } from "./live.js";

function displayName(name: string, what: "model" | "file"): string {
  const trimmed = name.trim();
  if (trimmed === "") throw new RangeError(`A ${what} name must not be empty`);
  return trimmed;
}

export function createRename(db: Kysely<DB>) {
  return {
    /**
     * Gives a live model a new display name, trimmed. False when the model is
     * unknown, malformed or trashed; RangeError for an empty name.
     */
    async renameModel(id: string, name: string): Promise<boolean> {
      const newName = displayName(name, "model");
      if (!isUuid(id)) return false;
      // One UPDATE, not withLiveModel: its FOR SHARE lock would have to be
      // upgraded for this UPDATE of the same row, and two renames of one
      // model, each holding the share lock, would deadlock (40P01). The
      // UPDATE takes the row lock itself, so concurrent renames queue, and a
      // purge holding the row FOR UPDATE makes it wait and then find no row.
      const result = await db
        .updateTable("models")
        .set({ name: newName, updatedAt: sql<Date>`now()` })
        .where("id", "=", id)
        .where("trashedAt", "is", null)
        .executeTakeFirst();
      return result.numUpdatedRows > 0n;
    },

    /**
     * Gives a file of a live model a new display name, trimmed. False when the
     * file is unknown or malformed or its model is trashed; RangeError for an
     * empty name.
     */
    async renameFile(id: string, name: string): Promise<boolean> {
      const newName = displayName(name, "file");
      if (!isUuid(id)) return false;
      const file = await db
        .selectFrom("files")
        .select("modelId")
        .where("id", "=", id)
        .executeTakeFirst();
      if (!file) return false;
      return withLiveModel(db, file.modelId, async (trx) => {
        const result = await trx
          .updateTable("files")
          .set({ name: newName, updatedAt: sql<Date>`now()` })
          .where("id", "=", id)
          .where("modelId", "=", file.modelId)
          .executeTakeFirst();
        return result.numUpdatedRows > 0n;
      });
    },
  };
}
