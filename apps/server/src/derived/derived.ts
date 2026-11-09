// OpenSCAD renders and STEP meshes (build plan Task 13; AC-050, AC-052,
// AC-053). Interface only in this commit: the implementation follows.
import type { Kysely } from "kysely";
import type { PgBoss } from "pg-boss";
import type { DB, FileKind } from "../db/types.js";
import type { StoredFile } from "../ingest/ingest.js";
import type { BlobStore } from "../storage/s3.js";

/**
 * What files.derived_message holds when the slicer, not OpenSCAD or the STEP
 * converter, is why a file has no render. A render or conversion error
 * stores the program's own message instead.
 */
export const DERIVED_MESSAGES = {
  /** slicer_error: the slicer stayed busy or unreachable through every retry, or answered oddly. */
  slicerError: "The slicer could not render this file.",
  /** slicer_error on a replacement: the file keeps its previous source and renders. */
  replaceFailed: "The slicer could not render the replacement, so the previous version is kept.",
  /** The job could not be queued after the upload committed. */
  queueFailed: "The render could not be queued.",
  /** A .scad over the contract's 1 MiB limit is never sent. */
  scadTooLarge: "This .scad file is larger than the 1 MiB the renderer takes.",
  /** A STEP file over the contract's 256 MiB limit is never sent. */
  stepTooLarge: "This STEP file is larger than the 256 MiB the converter takes.",
} as const;

/** files.derived_status values. */
export type DerivedStatus = "pending" | "ok" | "failed";

export type DerivedTask = "render-scad" | "convert-step";

/** A slicer queue job that makes a file's derived blobs. */
export interface DerivedJob {
  task: DerivedTask;
  fileId: string;
  /** The source blob to render: the file's own, or a replacement not yet swapped in. */
  sourceBlobId: string;
}

export interface DerivedOutcome {
  status: "ok" | "failed" | "skipped";
  reason?: "render_failed" | "slicer_error" | "stale";
}

export type DerivedErrorCode = "not_found" | "not_derivable" | "wrong_type" | "storage_unavailable";

export class DerivedError extends Error {
  readonly code: DerivedErrorCode;

  constructor(code: DerivedErrorCode, message: string) {
    super(message);
    this.name = "DerivedError";
    this.code = code;
  }
}

export type DerivedStore = Pick<BlobStore, "putBlob" | "getBlobStream" | "deleteBlobs">;

export interface DerivedDeps {
  db: Kysely<DB>;
  store: DerivedStore;
  /** SLICER_URL. */
  slicerUrl: string;
  /** Sends the jobs; the started pg-boss. */
  queue: Pick<PgBoss, "send">;
  /** Seconds before the first retry; SLICER_RETRY's when left out. */
  retryDelaySeconds?: number;
}

export function createDerived(_deps: DerivedDeps) {
  const notYet = (): never => {
    throw new Error("derived: not implemented");
  };
  return {
    async renderScad(_fileId: string): Promise<string> {
      return notYet();
    },
    async convertStep(_fileId: string): Promise<string> {
      return notYet();
    },
    async replaceFile(
      _fileId: string,
      _tmpPath: string,
    ): Promise<{ fileId: string; sourceBlobId: string }> {
      return notYet();
    },
    async afterUpload(_stored: StoredFile): Promise<void> {
      return notYet();
    },
    async runJob(
      _job: DerivedJob,
      _attempt: { retryCount: number; retryLimit: number },
    ): Promise<DerivedOutcome> {
      return notYet();
    },
  };
}

export type Derived = ReturnType<typeof createDerived>;

/** The kinds that have derived blobs. */
export function hasDerived(kind: FileKind): boolean {
  return kind === "scad" || kind === "step";
}
