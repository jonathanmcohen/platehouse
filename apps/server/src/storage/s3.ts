// The S3 blob store (build plan Task 5; AC-010, AC-012). Every byte Platehouse
// keeps lives in the bucket under the key layout in keys.ts, and reaches a
// browser or a slicer only through the app: there are no presigned URLs here
// or anywhere (decision 7, AC-011).
//
// Failures leave this module as StoreUnavailable (the store cannot be reached
// or timed out), BlobNotFound (404) or StoreError (the store refused, or a
// stored object failed its size check); see errors.ts. None carries a secret.
import { createHash } from "node:crypto";
import { pipeline, Readable, Transform } from "node:stream";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Config } from "../config.js";
import { BlobNotFound, StoreError, StoreUnavailable, s3Code, toStoreError } from "./errors.js";
import { isBlobKey } from "./keys.js";
import { readVersioning, type VersioningState } from "./versioning.js";

export type { VersioningState };
export { BlobNotFound, StoreError, StoreUnavailable };

export interface BlobStoreOptions {
  /** Attempts per S3 call, the first included; the SDK backs off between. Default 3. */
  maxAttempts?: number;
  /** Time allowed to open a connection to the store. Default 5000 ms. */
  connectionTimeoutMs?: number;
  /**
   * Time a request may go without any data moving on its socket. Default
   * 60000 ms. There is no limit on a whole request: a large part on a slow
   * link may take long while it keeps moving.
   */
  socketTimeoutMs?: number;
}

export interface BlobStore {
  /**
   * Uploads a stream to key, hashing it as it goes (lib-storage, multipart for
   * large bodies). Then HEADs the object: when its size or the bytes read
   * differ from size, the object is deleted and a StoreError with code
   * SizeMismatch is thrown. A failure of the source stream itself is rethrown
   * as it is.
   */
  putBlob(
    stream: Readable,
    opts: { key: string; size: number; contentType: string },
  ): Promise<{ sha256: Buffer; size: number }>;
  /** The object's bytes. BlobNotFound when the key does not exist. */
  getBlobStream(key: string): Promise<Readable>;
  /** Deletes the keys; a key already gone is not an error, so a purge can be retried. */
  deleteBlobs(keys: readonly string[]): Promise<void>;
  /** Every object under prefix, following continuation tokens to the end. */
  listPrefix(prefix: string): Promise<Array<{ key: string; size: number }>>;
  /** The bucket's versioning state (AC-013). */
  readVersioning(): Promise<VersioningState>;
  /** Closes the client's sockets. */
  destroy(): void;
}

// DeleteObjects takes at most 1000 keys per request.
const DELETE_BATCH = 1000;

function assertBlobKey(key: string, fn: string): void {
  if (!isBlobKey(key)) {
    throw new TypeError(`${fn}: key is not in the models/<modelId>/<blobId> layout`);
  }
}

export function createBlobStore(s3: Config["s3"], options: BlobStoreOptions = {}): BlobStore {
  const bucket = s3.bucket;
  const client = new S3Client({
    endpoint: s3.endpoint,
    region: s3.region,
    forcePathStyle: s3.forcePathStyle,
    credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
    maxAttempts: options.maxAttempts ?? 3,
    // socketTimeout is the idle timeout. requestTimeout in this SDK is a timer
    // on the whole request that only logs a warning unless asked to throw, so
    // it is left unset (read in @smithy/node-http-handler 4.14.2).
    requestHandler: {
      connectionTimeout: options.connectionTimeoutMs ?? 5_000,
      socketTimeout: options.socketTimeoutMs ?? 60_000,
    },
    // Checksums only where the S3 API requires one. The SDK's default adds
    // CRC checksums to every upload, which not every S3-compatible store
    // accepts; the sha256 Platehouse records is computed here instead.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

  async function deleteQuietly(key: string): Promise<void> {
    try {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    } catch {
      // The caller is already failing with the reason that matters; a key
      // left behind here is found by reconciliation (AC-010).
    }
  }

  return {
    async putBlob(stream, { key, size, contentType }) {
      assertBlobKey(key, "putBlob");
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new TypeError("putBlob: size must be a whole number of bytes, 0 or more");
      }
      if (contentType === "") throw new TypeError("putBlob: contentType must not be empty");

      const hash = createHash("sha256");
      let read = 0;
      let sourceError: unknown;
      stream.once("error", (err) => {
        sourceError ??= err;
      });
      const hasher = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          hash.update(chunk);
          read += chunk.length;
          done(null, chunk);
        },
      });
      pipeline(stream, hasher, () => {
        // Errors are taken from the source's own listener above and from the
        // upload; this callback only keeps pipeline from throwing.
      });

      const upload = new Upload({
        client,
        params: { Bucket: bucket, Key: key, Body: hasher, ContentType: contentType },
        leavePartsOnError: false,
      });
      try {
        await upload.done();
      } catch (err) {
        hasher.destroy();
        if (sourceError !== undefined) throw sourceError;
        throw toStoreError(err, "PutObject");
      }
      if (sourceError !== undefined) {
        await deleteQuietly(key);
        throw sourceError;
      }

      let stored: number | undefined;
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        stored = head.ContentLength;
      } catch (err) {
        throw toStoreError(err, "HeadObject");
      }
      if (stored !== size || read !== size) {
        await deleteQuietly(key);
        throw new StoreError("PutObject", "SizeMismatch");
      }
      return { sha256: hash.digest(), size: read };
    },

    async getBlobStream(key) {
      let body: unknown;
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        body = out.Body;
      } catch (err) {
        throw toStoreError(err, "GetObject", { notFound: true });
      }
      if (!(body instanceof Readable)) throw new StoreError("GetObject", "NoBody");
      return body;
    },

    async deleteBlobs(keys) {
      for (const key of keys) assertBlobKey(key, "deleteBlobs");
      for (let i = 0; i < keys.length; i += DELETE_BATCH) {
        const batch = keys.slice(i, i + DELETE_BATCH);
        let errors: Array<{ Code?: string | undefined }> | undefined;
        try {
          const out = await client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
            }),
          );
          errors = out.Errors;
        } catch (err) {
          throw toStoreError(err, "DeleteObjects");
        }
        const first = errors?.[0];
        if (first) throw new StoreError("DeleteObjects", s3Code({ Code: first.Code }));
      }
    },

    async listPrefix(prefix) {
      const objects: Array<{ key: string; size: number }> = [];
      let token: string | undefined;
      do {
        try {
          const out = await client.send(
            new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
          );
          for (const o of out.Contents ?? []) {
            if (o.Key !== undefined) objects.push({ key: o.Key, size: o.Size ?? 0 });
          }
          token = out.IsTruncated ? out.NextContinuationToken : undefined;
        } catch (err) {
          throw toStoreError(err, "ListObjectsV2");
        }
      } while (token !== undefined);
      return objects;
    },

    readVersioning() {
      return readVersioning(client, bucket);
    },

    destroy() {
      client.destroy();
    },
  };
}
