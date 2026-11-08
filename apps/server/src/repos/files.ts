import type { Kysely } from "kysely";
import { isUuid, uuidv7 } from "../db/ids.js";
import type { DB, FileKind, ModelFile, ParseStatus } from "../db/types.js";

export interface NewFile {
  id?: string;
  modelId: string;
  blobId: string;
  name: string;
  originalName: string;
  kind: FileKind;
  size: number;
  sha256: Buffer;
  externalRef?: string | null;
  parseStatus?: ParseStatus;
}

export function filesRepo(db: Kysely<DB>) {
  return {
    async create(input: NewFile): Promise<ModelFile> {
      return db
        .insertInto("files")
        .values({
          id: input.id ?? uuidv7(),
          modelId: input.modelId,
          blobId: input.blobId,
          name: input.name,
          originalName: input.originalName,
          kind: input.kind,
          size: input.size,
          sha256: input.sha256,
          externalRef: input.externalRef ?? null,
          ...(input.parseStatus === undefined ? {} : { parseStatus: input.parseStatus }),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    },

    async get(id: string): Promise<ModelFile | undefined> {
      if (!isUuid(id)) return undefined;
      return db.selectFrom("files").selectAll().where("id", "=", id).executeTakeFirst();
    },
  };
}

export type FilesRepo = ReturnType<typeof filesRepo>;
