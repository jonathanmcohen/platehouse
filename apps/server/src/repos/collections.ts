import type { Kysely } from "kysely";
import type { DB } from "../db/types.js";

export function collectionsRepo(_db: Kysely<DB>) {
  return {
    async add(_modelId: string, _name: string): Promise<void> {
      throw new Error("not implemented: collections.add");
    },
    async remove(_modelId: string, _name: string): Promise<boolean> {
      throw new Error("not implemented: collections.remove");
    },
    async forModel(_modelId: string): Promise<string[]> {
      throw new Error("not implemented: collections.forModel");
    },
  };
}

export type CollectionsRepo = ReturnType<typeof collectionsRepo>;
