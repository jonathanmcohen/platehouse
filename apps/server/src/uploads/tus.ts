// Resumable uploads (build plan Task 9; AC-020, AC-084). STUB: the interface
// only, so the failing tests compile. The implementation follows.
import { join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PgBoss } from "pg-boss";
import type { IngestInput, IngestResult, IngestTarget } from "../ingest/ingest.js";

/** The largest upload Platehouse takes, in bytes (512 MiB). */
export const MAX_UPLOAD_BYTES = 536_870_912;

/** How long a partial upload may sit untouched before the hourly sweep deletes it. */
export const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;

/** Where partial uploads live: TMP_DIR/uploads. */
export function uploadsDir(tmpDir: string): string {
  return join(tmpDir, "uploads");
}

/** A Fastify onRequest hook that lets a request through or answers it (401) itself. */
export type AuthHook = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/** What GET <prefix>/:id/result answers. */
export type UploadResult =
  | { status: "pending" }
  | { status: "done"; modelId: string; fileId: string }
  | { status: "failed"; error: string };

/** The ingest queue as the uploads see it. */
export interface UploadQueue {
  enqueue(id: string, input: IngestInput): Promise<void>;
  result(id: string): Promise<UploadResult | undefined>;
}

export function bossUploadQueue(_boss: PgBoss): UploadQueue {
  return {
    enqueue: async () => {},
    result: async () => undefined,
  };
}

export interface UploadSweepResult {
  listed: number;
  deleted: number;
  kept: number;
  skipped: number;
}

export interface Uploads {
  readonly dir: string;
  ingestUpload(
    ingestFile: (input: IngestInput) => Promise<IngestResult>,
  ): (input: IngestInput) => Promise<IngestResult>;
  sweepStaleUploads(now: Date): Promise<UploadSweepResult>;
}

export function createUploads(deps: {
  tmpDir: string;
  queue: UploadQueue;
  log?: (line: string) => void;
}): Uploads {
  return {
    dir: uploadsDir(deps.tmpDir),
    ingestUpload: (ingestFile) => ingestFile,
    sweepStaleUploads: async () => ({ listed: 0, deleted: 0, kept: 0, skipped: 0 }),
  };
}

export function parseUploadMetadata(_metadata: Record<string, string | null> | undefined): {
  originalName: string;
  target: IngestTarget;
} {
  throw new Error("not implemented");
}

export async function registerTus(
  _app: FastifyInstance,
  _opts: { prefix: string; authHook: AuthHook; uploads: Uploads },
): Promise<void> {}
