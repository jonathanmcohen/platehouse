// The ingest pipeline (build plan Task 8). Stub: the interface only, so the
// failing tests compile; the implementation follows in the next commit.
import type { Kysely } from "kysely";
import type { DB } from "../db/types.js";
import type { BlobStore } from "../storage/s3.js";

export const STORAGE_UNAVAILABLE_MESSAGE = "Storage is unavailable right now; nothing was saved";

export type IngestErrorCode = "unsupported_type" | "storage_unavailable" | "model_not_found";

export class IngestError extends Error {
  readonly code: IngestErrorCode;

  constructor(code: IngestErrorCode, message: string) {
    super(message);
    this.name = "IngestError";
    this.code = code;
  }
}

export type IngestTarget = { modelId: string } | { batch: string; combine: boolean } | "new";

export interface IngestInput {
  tmpPath: string;
  originalName: string;
  target: IngestTarget;
}

export interface IngestResult {
  modelId: string;
  fileId: string;
}

export type IngestStore = Pick<BlobStore, "putBlob" | "deleteBlobs">;

export function createIngest(_deps: { db: Kysely<DB>; store: IngestStore }) {
  return {
    async ingestFile(_input: IngestInput): Promise<IngestResult> {
      throw new Error("ingestFile is not implemented yet");
    },
  };
}
