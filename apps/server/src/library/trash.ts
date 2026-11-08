import type { Kysely } from "kysely";
import type { DB } from "../db/types.js";
import type { BlobStore } from "../storage/s3.js";

export const TRASH_RETENTION_DAYS = 30;

export type PurgeStore = Pick<BlobStore, "deleteBlobs" | "listPrefix">;

export interface PurgeResult {
  purged: string[];
}

export class PurgeIncomplete extends Error {
  readonly purged: string[];
  readonly failed: Array<{ modelId: string; error: unknown }>;

  constructor(purged: string[], failed: Array<{ modelId: string; error: unknown }>) {
    super("not implemented");
    this.name = "PurgeIncomplete";
    this.purged = purged;
    this.failed = failed;
  }
}

export function createTrash(_deps: { db: Kysely<DB>; store: PurgeStore }) {
  return {
    async trashModel(_id: string): Promise<boolean> {
      throw new Error("not implemented: trashModel");
    },
    async restoreModel(_id: string): Promise<boolean> {
      throw new Error("not implemented: restoreModel");
    },
    async emptyTrash(): Promise<PurgeResult> {
      throw new Error("not implemented: emptyTrash");
    },
    async purgeExpired(_now: Date): Promise<PurgeResult> {
      throw new Error("not implemented: purgeExpired");
    },
  };
}
