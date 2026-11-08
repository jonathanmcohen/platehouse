import type { Kysely } from "kysely";
import type { Blob, BlobKind, DB } from "../db/types.js";

export interface NewBlob {
  id?: string;
  modelId: string;
  kind: BlobKind;
  contentType: string;
  size?: number | null;
}

export function blobsRepo(_db: Kysely<DB>) {
  return {
    async insertPending(_input: NewBlob): Promise<Blob> {
      throw new Error("not implemented: blobs.insertPending");
    },
    async markStored(
      _id: string,
      _stored: { size: number; sha256: Buffer },
    ): Promise<Blob | undefined> {
      throw new Error("not implemented: blobs.markStored");
    },
    async get(_id: string): Promise<Blob | undefined> {
      throw new Error("not implemented: blobs.get");
    },
  };
}

export type BlobsRepo = ReturnType<typeof blobsRepo>;
