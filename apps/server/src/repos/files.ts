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

/** What findImported looks for: the id an inbox attempt chose for its file row. */
export interface ImportedQuery {
  fileId: string;
}

/** The row findImported found, and whether its model is live. */
export interface ImportedFile {
  modelId: string;
  fileId: string;
  /** False when the model is in the trash or being purged. */
  live: boolean;
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
     * The file row with this id, if any, with its model and whether that
     * model is live: how the inbox watcher (inbox/watch.ts) tells that its
     * own earlier attempt already made a model. The watcher chooses the id
     * before it calls ingest (inboxFileId), so only a row that attempt wrote
     * can match; an upload of the same name and bytes through the web UI or
     * the API has an id of its own and never does. A row whose model is in
     * the trash or being purged comes back with live false: an Empty trash or
     * the purge (library/trash.ts) deletes its stored bytes, so the watcher
     * does not stand it in for the inbox copy, and imports under another id.
     */
    async findImported(q: ImportedQuery): Promise<ImportedFile | undefined> {
      if (!isUuid(q.fileId)) return undefined;
      const row = await db
        .selectFrom("files")
        .innerJoin("models", "models.id", "files.modelId")
        .select([
          "files.modelId",
          "files.id as fileId",
          "models.trashedAt",
          "models.purgeStartedAt",
        ])
        .where("files.id", "=", q.fileId)
        .executeTakeFirst();
      if (row === undefined) return undefined;
      return {
        modelId: row.modelId,
        fileId: row.fileId,
        live: row.trashedAt === null && row.purgeStartedAt === null,
      };
    },
  };
}

export type FilesRepo = ReturnType<typeof filesRepo>;
