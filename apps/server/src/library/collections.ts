import type { Kysely } from "kysely";
import type { DB } from "../db/types.js";

export function createCollections(_db: Kysely<DB>) {
  return {
    async addToCollection(_modelId: string, _collection: string): Promise<boolean> {
      throw new Error("not implemented: addToCollection");
    },
    async removeFromCollection(_modelId: string, _collection: string): Promise<boolean> {
      throw new Error("not implemented: removeFromCollection");
    },
  };
}
