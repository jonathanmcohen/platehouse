import type { Kysely } from "kysely";
import { isUuid, uuidv7 } from "../db/ids.js";
import type { DB, Plate } from "../db/types.js";

export interface NewPlate {
  id?: string;
  fileId: string;
  /** The plate number, from 1, unique within the file. */
  index: number;
  name?: string | null;
  objectCount: number;
  thumbnailBlobId?: string | null;
}

export function platesRepo(db: Kysely<DB>) {
  return {
    async create(input: NewPlate): Promise<Plate> {
      return db
        .insertInto("plates")
        .values({
          id: input.id ?? uuidv7(),
          fileId: input.fileId,
          index: input.index,
          name: input.name ?? null,
          objectCount: input.objectCount,
          thumbnailBlobId: input.thumbnailBlobId ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    },

    /** A file's plates in plate order. */
    async listForFile(fileId: string): Promise<Plate[]> {
      if (!isUuid(fileId)) return [];
      return db
        .selectFrom("plates")
        .selectAll()
        .where("fileId", "=", fileId)
        .orderBy("index")
        .execute();
    },
  };
}

export type PlatesRepo = ReturnType<typeof platesRepo>;
