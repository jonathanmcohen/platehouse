import type { Kysely } from "kysely";
import type { DB } from "../db/types.js";

export function createRename(_db: Kysely<DB>) {
  return {
    async renameModel(_id: string, _name: string): Promise<boolean> {
      throw new Error("not implemented: renameModel");
    },
    async renameFile(_id: string, _name: string): Promise<boolean> {
      throw new Error("not implemented: renameFile");
    },
  };
}
