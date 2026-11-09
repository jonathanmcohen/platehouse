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

/** What findImported looks for. */
export interface ImportedQuery {
  originalName: string;
  size: number;
  sha256: Buffer;
  since: Date;
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

    /**
     * The earliest file row with this original name, size and SHA-256 created
     * at or after since, if any: how the inbox watcher (inbox/watch.ts) tells
     * that a file already made a model. It matches original_name, the name as
     * it arrived, never name, which ingest rewrites; and only rows created
     * since, so an earlier import of the same file does not count.
     */
    async findImported(q: ImportedQuery): Promise<{ modelId: string; fileId: string } | undefined> {
      return db
        .selectFrom("files")
        .select(["modelId", "id as fileId"])
        .where("originalName", "=", q.originalName)
        .where("size", "=", q.size)
        .where("sha256", "=", q.sha256)
        .where("createdAt", ">=", q.since)
        .orderBy("createdAt")
        .orderBy("id")
        .executeTakeFirst();
    },
  };
}

export type FilesRepo = ReturnType<typeof filesRepo>;
