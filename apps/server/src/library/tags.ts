import type { Kysely } from "kysely";
import type { DB } from "../db/types.js";

export function createTags(_db: Kysely<DB>) {
  return {
    async addTag(_modelId: string, _tag: string): Promise<boolean> {
      throw new Error("not implemented: addTag");
    },
    async removeTag(_modelId: string, _tag: string): Promise<boolean> {
      throw new Error("not implemented: removeTag");
    },
  };
}
