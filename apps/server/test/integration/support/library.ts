// A migrated Postgres 17 and a bucket on the S3 test server, for the library
// tests (build plan Task 14). Every model, file and byte here is synthetic.
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { CreateBucketCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { type Kysely, sql } from "kysely";
import { uuidv7 } from "../../../src/db/ids.js";
import { migrate } from "../../../src/db/migrate.js";
import type { BlobKind, DB } from "../../../src/db/types.js";
import { createRepos, type Repos } from "../../../src/repos/index.js";
import { type BlobStore, createBlobStore } from "../../../src/storage/s3.js";
import { type StartedS3, startS3 } from "./containers.js";
import { startTestPostgres, type TestPostgres } from "./db.js";

export interface LibraryEnv {
  /** The database's connection URL, for a pg-boss on the same database. */
  url: string;
  db: Kysely<DB>;
  repos: Repos;
  store: BlobStore;
  /**
   * Writes an object straight to the bucket, past the store's key check, as
   * something other than the app might.
   */
  putRaw(key: string, bytes: Buffer): Promise<void>;
  stop(): Promise<void>;
}

export async function startLibraryEnv(): Promise<LibraryEnv> {
  let pgc: TestPostgres | undefined;
  let s3: StartedS3 | undefined;
  let store: BlobStore | undefined;
  const stop = async () => {
    store?.destroy();
    await Promise.all([pgc?.stop(), s3?.stop()]);
  };
  try {
    [pgc, s3] = await Promise.all([startTestPostgres(), startS3()]);
    const t = await pgc.freshDatabase();
    await migrate(t.db);
    const bucket = `platehouse-t14-${randomBytes(4).toString("hex")}`;
    await s3.client.send(new CreateBucketCommand({ Bucket: bucket }));
    store = createBlobStore({
      endpoint: s3.endpoint,
      region: s3.region,
      bucket,
      accessKeyId: s3.accessKeyId,
      secretAccessKey: s3.secretAccessKey,
      forcePathStyle: true,
    });
    const client = s3.client;
    const putRaw = async (key: string, bytes: Buffer) => {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes }));
    };
    return { url: t.url, db: t.db, repos: createRepos(t.db), store, putRaw, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

let counter = 0;

/** A unique marker for names, so tests in one database do not see each other. */
export function marker(): string {
  return uuidv7().slice(-12);
}

/** Uploads bytes for a new blob of the model and records it stored. */
export async function storeBlob(
  env: LibraryEnv,
  modelId: string,
  kind: BlobKind,
  bytes: Buffer,
): Promise<{ id: string; key: string }> {
  const blob = await env.repos.blobs.insertPending({
    modelId,
    kind,
    contentType: "application/octet-stream",
    size: bytes.length,
  });
  const put = await env.store.putBlob(Readable.from([bytes]), {
    key: blob.key,
    size: bytes.length,
    contentType: "application/octet-stream",
  });
  await env.repos.blobs.markStored(blob.id, put);
  return { id: blob.id, key: blob.key };
}

/**
 * A model with one .3mf file whose bytes are in the bucket, plus a stored
 * thumbnail blob, so a purge has more than one object to remove.
 */
export async function seedStoredModel(
  env: LibraryEnv,
  input: { name?: string; caption?: string; creator?: string } = {},
) {
  counter += 1;
  const model = await env.repos.models.create({
    name: input.name ?? `Library model ${counter} ${marker()}`,
    ...(input.caption === undefined ? {} : { caption: input.caption }),
    ...(input.creator === undefined ? {} : { creator: input.creator }),
  });
  const bytes = Buffer.from(`synthetic 3mf bytes ${counter} ${randomBytes(8).toString("hex")}`);
  const source = await storeBlob(env, model.id, "source", bytes);
  const thumbnail = await storeBlob(env, model.id, "thumbnail", Buffer.from(`png ${counter}`));
  const file = await env.repos.files.create({
    modelId: model.id,
    blobId: source.id,
    name: `Part ${counter}.3mf`,
    originalName: `Part ${counter}.3mf`,
    kind: "3mf",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest(),
  });
  return { model, file, source, thumbnail, bytes };
}

/** Sets a model's trashed_at to the given number of days before now. */
export async function trashDaysAgo(db: Kysely<DB>, modelId: string, days: number): Promise<void> {
  await sql`update models set trashed_at = now() - make_interval(days => ${days})
            where id = ${modelId}`.execute(db);
}

/** How many rows of each of a model's own tables are left. */
export async function rowCounts(db: Kysely<DB>, modelId: string) {
  // Single-word aliases: the CamelCasePlugin renames result columns of raw
  // queries too (model_tags would come back as modelTags).
  const { rows } = await sql<{
    models: number;
    files: number;
    blobs: number;
    tags: number;
    collections: number;
  }>`select
       (select count(*)::int from models where id = ${modelId}) as models,
       (select count(*)::int from files where model_id = ${modelId}) as files,
       (select count(*)::int from blobs where model_id = ${modelId}) as blobs,
       (select count(*)::int from model_tags where model_id = ${modelId}) as tags,
       (select count(*)::int from collection_models where model_id = ${modelId})
         as collections`.execute(db);
  const row = rows[0];
  if (!row) throw new Error("count query returned no row");
  for (const [key, value] of Object.entries(row)) {
    if (typeof value !== "number") throw new Error(`count ${key} came back as ${typeof value}`);
  }
  return {
    models: row.models,
    files: row.files,
    blobs: row.blobs,
    modelTags: row.tags,
    collectionModels: row.collections,
  };
}
