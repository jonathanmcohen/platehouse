// STUB for the failing-tests commit (build plan Task 5, step 1). The types
// and names are the interface; every operation fails until a later commit.
import type { Readable } from "node:stream";
import type { Config } from "../config.js";
import type { VersioningState } from "./versioning.js";

export class StoreUnavailable extends Error {}
export class BlobNotFound extends Error {}
export class StoreError extends Error {
  readonly code: string = "";
  readonly status: number | undefined;
}

export interface BlobStoreOptions {
  maxAttempts?: number;
  connectionTimeoutMs?: number;
  socketTimeoutMs?: number;
}

export interface BlobStore {
  putBlob(
    stream: Readable,
    opts: { key: string; size: number; contentType: string },
  ): Promise<{ sha256: Buffer; size: number }>;
  getBlobStream(key: string): Promise<Readable>;
  deleteBlobs(keys: readonly string[]): Promise<void>;
  listPrefix(prefix: string): Promise<Array<{ key: string; size: number }>>;
  readVersioning(): Promise<VersioningState>;
  destroy(): void;
}

export function createBlobStore(_s3: Config["s3"], _options?: BlobStoreOptions): BlobStore {
  const fail = () => Promise.reject(new Error("not implemented"));
  return {
    putBlob: fail,
    getBlobStream: fail,
    deleteBlobs: fail,
    listPrefix: fail,
    readVersioning: fail,
    destroy() {},
  };
}
