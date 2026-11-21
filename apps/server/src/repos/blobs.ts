import type { Kysely } from "kysely";
import { isUuid, uuidv7 } from "../db/ids.js";
import type { Blob, BlobKind, DB } from "../db/types.js";

export interface NewBlob {
  id?: string;
  modelId: string;
  kind: BlobKind;
  contentType: string;
  /** The size, when it is known before the upload. */
  size?: number | null;
}

export function blobsRepo(db: Kysely<DB>) {
  return {
    /**
     * Records a blob before its bytes are uploaded, so an upload that fails
     * half way leaves a row to clean up rather than an orphan object. The key
     * is models/<modelId>/<blobId> (Bucket key layout); the schema refuses
     * any other.
     */
    async insertPending(input: NewBlob): Promise<Blob> {
      const id = (input.id ?? uuidv7()).toLowerCase();
      const modelId = input.modelId.toLowerCase();
      return db
        .insertInto("blobs")
        .values({
          id,
          modelId,
          key: `models/${modelId}/${id}`,
          kind: input.kind,
          contentType: input.contentType,
          size: input.size ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    },

    /**
     * Marks a pending blob stored once its upload is verified, with the size
     * and SHA-256 of what the store holds. undefined when the blob is unknown
     * or already stored.
     */
    async markStored(
      id: string,
      stored: { size: number; sha256: Buffer },
    ): Promise<Blob | undefined> {
      if (!isUuid(id)) return undefined;
      return db
        .updateTable("blobs")
        .set({ state: "stored", size: stored.size, sha256: stored.sha256 })
        .where("id", "=", id)
        .where("state", "=", "pending")
        .returningAll()
        .executeTakeFirst();
    },

    async get(id: string): Promise<Blob | undefined> {
      if (!isUuid(id)) return undefined;
      return db.selectFrom("blobs").selectAll().where("id", "=", id).executeTakeFirst();
    },
  };
}

export type BlobsRepo = ReturnType<typeof blobsRepo>;
