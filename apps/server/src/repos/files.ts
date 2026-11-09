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
     * since, so an earlier import of the same file does not count. A file
     * whose model is in the trash or being purged does not count either: an
     * Empty trash or the purge (library/trash.ts) deletes its stored bytes, so
     * standing it in for the inbox copy would leave that copy no model of its
     * own once the copy is deleted.
     */
    async findImported(q: ImportedQuery): Promise<{ modelId: string; fileId: string } | undefined> {
      return db
        .selectFrom("files")
        .innerJoin("models", "models.id", "files.modelId")
        .select(["files.modelId", "files.id as fileId"])
        .where("files.originalName", "=", q.originalName)
        .where("files.size", "=", q.size)
        .where("files.sha256", "=", q.sha256)
        .where("files.createdAt", ">=", q.since)
        .where("models.trashedAt", "is", null)
        .where("models.purgeStartedAt", "is", null)
        .orderBy("files.createdAt")
        .orderBy("files.id")
        .executeTakeFirst();
    },
  };
}

export type FilesRepo = ReturnType<typeof filesRepo>;
