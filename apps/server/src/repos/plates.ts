import type { Kysely } from "kysely";
import type { DB, Plate } from "../db/types.js";

export interface NewPlate {
  id?: string;
  fileId: string;
  index: number;
  name?: string | null;
  objectCount: number;
  thumbnailBlobId?: string | null;
}

export function platesRepo(_db: Kysely<DB>) {
  return {
    async create(_input: NewPlate): Promise<Plate> {
      throw new Error("not implemented: plates.create");
    },
    async listForFile(_fileId: string): Promise<Plate[]> {
      throw new Error("not implemented: plates.listForFile");
    },
  };
}

export type PlatesRepo = ReturnType<typeof platesRepo>;
