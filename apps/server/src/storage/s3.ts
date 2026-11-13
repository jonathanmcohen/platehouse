// The S3 blob store (build plan Task 5; AC-010, AC-012). Every byte Platehouse
// keeps lives in the bucket under the key layout in keys.ts, and reaches a
// browser or a slicer only through the app: there are no presigned URLs here
// or anywhere (decision 7, AC-011).
//
// Failures leave this module as StoreUnavailable (the store cannot be reached
// or timed out), BlobNotFound (only a 404 NoSuchKey on a read; any other 404,
// such as NoSuchBucket, is a StoreError) or StoreError (the store refused, or
// a stored object failed its size check); see errors.ts. None carries a
// secret.
import { createHash } from "node:crypto";
import { PassThrough, pipeline, Readable, Transform } from "node:stream";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
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
   * SizeMismatch is thrown; when the HEAD itself fails, the object is deleted
   * too. A failure of the source stream itself is rethrown as it is; a store
   * failure partway through a multipart upload is StoreUnavailable or
   * StoreError, never the stream teardown that follows it.
   */
  putBlob(
    stream: Readable,
    opts: { key: string; size: number; contentType: string },
  ): Promise<{ sha256: Buffer; size: number }>;
  /**
   * The object's bytes. BlobNotFound when the key does not exist (S3 404
   * NoSuchKey); any other 404, a missing bucket for one, is a StoreError.
   * A failure while the bytes are read (the connection dropped, or no data
   * moved for socketTimeoutMs) is the stream's error, mapped the same way:
   * StoreUnavailable for an outage, never the SDK's own error. The object's
   * size, as the store's Content-Length gave it, is objectSize(stream), so
   * a reader can refuse an object that is not the size it recorded before
   * it sends anything.
   */
  getBlobStream(key: string): Promise<Readable>;
  /**
   * Resolves when the object is in the bucket, asking with a HeadObject, which
   * sends no body. A HEAD reply carries no error code, so S3 answers a missing
   * key and a missing bucket with the same bare 404: that is a StoreError
   * (HeadObject, NotFound, 404), never BlobNotFound, so a broken storage setup
   * is never reported as a missing file. An outage is StoreUnavailable.
   */
  headBlob(key: string): Promise<void>;
  /** Deletes the keys; a key already gone is not an error, so a purge can be retried. */
  deleteBlobs(keys: readonly string[]): Promise<void>;
  /** Every object under prefix, following continuation tokens to the end. */
  listPrefix(prefix: string): Promise<Array<{ key: string; size: number }>>;
  /**
   * One page of the objects under prefix, at most maxKeys of them (the
   * store's own limit, 1000 on S3, when left out), each with the time it was
   * last written, and the token for the next page, or undefined on the last.
   */
  listPage(
    prefix: string,
    opts?: { token?: string | undefined; maxKeys?: number },
  ): Promise<{ objects: ListedObject[]; next: string | undefined }>;
  /** The bucket's versioning state (AC-013). */
  readVersioning(): Promise<VersioningState>;
  /**
   * Checks that the store takes a write: puts a few bytes at WRITE_CHECK_KEY,
   * then deletes them, by the version written when the store returns one
   * (see WRITE_CHECK_KEY). The key is fixed and outside models/, so neither the
   * reconciliation count nor the orphan sweep (both look only under models/)
   * ever sees it, and no caller can name a key outside the blob layout. A
   * failure is StoreUnavailable or StoreError, as for putBlob.
   */
  checkWrite(): Promise<void>;
  /** Closes the client's sockets. */
  destroy(): void;
}

/** An object as a listing returns it. */
export interface ListedObject {
  key: string;
  size: number;
  /** When the object was last written; undefined if the store did not say. */
  lastModified: Date | undefined;
}

/**
 * The one key outside the blob layout the store writes: checkWrite's, put
 * and deleted again at once. On a bucket with versioning on (AC-013) the
 * check deletes the exact version it wrote (the VersionId PutObject returns),
 * which removes it for good and leaves no delete marker, so the checks do not
 * pile up old versions for the retention period. On an unversioned bucket it
 * deletes by key, and a copy left by a delete that failed is overwritten by
 * the next check, so there is never more than one. A key that may not delete
 * a version (s3:DeleteObjectVersion), or a provider that refuses a delete by
 * version, gets a plain delete instead, which on a versioned bucket leaves
 * the check's version and a delete marker until the retention period ends;
 * the same goes for a delete that fails, whose version stays as a noncurrent
 * one once the next check writes over it.
 */
export const WRITE_CHECK_KEY = "checks/write-check";

const objectSizes = new WeakMap<Readable, number>();

/**
 * Records the object size the store reported for a stream it opened, and
 * returns the stream. getBlobStream calls it; a test's stand-in store may
 * too, to hand out a stream the way the real one does.
 */
export function reportObjectSize(stream: Readable, size: number | undefined): Readable {
  if (size !== undefined) objectSizes.set(stream, size);
  return stream;
}

/**
 * The size of the object a getBlobStream stream reads, as the store's
 * GetObject answer gave it (its Content-Length); undefined for a stream the
 * store did not open, or when the store sent no length. A restored older
 * version of an object, or a write to the bucket behind the app's back,
 * makes this differ from the size the database recorded (PR #156 security
 * review).
 */
export function objectSize(stream: Readable): number | undefined {
  return objectSizes.get(stream);
}

// DeleteObjects takes at most 1000 keys per request.
const DELETE_BATCH = 1000;

/**
 * The body of a GetObject, with a failure partway through it (a socket reset
 * or the idle timeout while a bucket restarts) mapped by toStoreError, as a
 * failure of the call itself is. Without this the SDK's raw stream error
 * reaches the reader, which cannot tell a store outage from anything else.
 * A body that closes before its end with no error is an outage too.
 * Destroying the returned stream destroys the body, closing its socket.
 */
function withStoreErrors(body: Readable, operation: string): Readable {
  const out = new PassThrough();
  body.on("error", (err) => out.destroy(toStoreError(err, operation)));
  body.on("close", () => {
    if (!body.readableEnded) out.destroy(new StoreUnavailable(operation, "PrematureClose"));
  });
  out.on("close", () => body.destroy());
  body.pipe(out);
  return out;
}

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
      const hasher = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          hash.update(chunk);
          read += chunk.length;
          done(null, chunk);
        },
      });
      // Only a failure the source raised itself counts. When the upload stops
      // reading partway (a part refused, an outage), lib-storage closes its
      // iterator over the hasher, which destroys the hasher, and pipeline()
      // then destroys the source with an error of its own (an AbortError or
      // ERR_STREAM_PREMATURE_CLOSE, by Node version). That error arrives after
      // the hasher is already destroyed; the upload's error is the real one.
      stream.once("error", (err) => {
        if (!hasher.destroyed) sourceError ??= err;
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
        // The upload went through, so an object may be in the bucket that no
        // caller will record; remove it as the size-mismatch path does.
        await deleteQuietly(key);
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
      let length: number | undefined;
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        body = out.Body;
        length = out.ContentLength;
      } catch (err) {
        throw toStoreError(err, "GetObject", { notFound: true });
      }
      if (!(body instanceof Readable)) throw new StoreError("GetObject", "NoBody");
      return reportObjectSize(withStoreErrors(body, "GetObject"), length);
    },

    async headBlob(key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      } catch (err) {
        throw toStoreError(err, "HeadObject");
      }
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

    async listPage(prefix, opts = {}) {
      try {
        const out = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: opts.token,
            MaxKeys: opts.maxKeys,
          }),
        );
        const objects: ListedObject[] = [];
        for (const o of out.Contents ?? []) {
          if (o.Key === undefined) continue;
          objects.push({ key: o.Key, size: o.Size ?? 0, lastModified: o.LastModified });
        }
        return { objects, next: out.IsTruncated ? out.NextContinuationToken : undefined };
      } catch (err) {
        throw toStoreError(err, "ListObjectsV2");
      }
    },

    readVersioning() {
      return readVersioning(client, bucket);
    },

    async checkWrite() {
      let versionId: string | undefined;
      try {
        const out = await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: WRITE_CHECK_KEY,
            Body: "platehouse write check\n",
            ContentType: "text/plain; charset=utf-8",
          }),
        );
        versionId = out.VersionId;
      } catch (err) {
        throw toStoreError(err, "PutObject");
      }
      if (versionId !== undefined && versionId !== "") {
        try {
          await client.send(
            new DeleteObjectCommand({ Bucket: bucket, Key: WRITE_CHECK_KEY, VersionId: versionId }),
          );
          return;
        } catch (err) {
          const mapped = toStoreError(err, "DeleteObject");
          // An outage fails the check. A refusal (a key without permission
          // to delete a version, a provider that does not implement it) falls
          // through to the plain delete below.
          if (mapped instanceof StoreUnavailable) throw mapped;
        }
      }
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: WRITE_CHECK_KEY }));
      } catch (err) {
        throw toStoreError(err, "DeleteObject");
      }
    },

    destroy() {
      client.destroy();
    },
  };
}
