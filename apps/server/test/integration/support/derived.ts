// The derived-file tests' environment (build plan Task 13): the ingest env (a
// migrated Postgres 17, a bucket on the S3 test server, a temp folder) plus a
// started pg-boss on the same database working Task 8's queues, the
// contract-faithful slicer stub, and createDerived wired to all three. Ingest
// gets Task 13's afterUpload as its afterCommit, as the app wires it.
import { setTimeout as sleep } from "node:timers/promises";
import type { PgBoss } from "pg-boss";
import type { ModelFile } from "../../../src/db/types.js";
import { createDerived, type Derived, derivedJobHandlers } from "../../../src/derived/derived.js";
import { createIngest, type Ingest } from "../../../src/ingest/ingest.js";
import { createBoss } from "../../../src/jobs/boss.js";
import { startQueues } from "../../../src/jobs/queues.js";
import { type IngestEnv, startIngestEnv } from "./ingest.js";
import { type SlicerStub, startSlicerStub } from "./slicer-stub.js";

export interface DerivedEnv extends IngestEnv {
  boss: PgBoss;
  stub: SlicerStub;
  derived: Derived;
  /** An ingest whose afterCommit is derived.afterUpload. */
  ingestDerived: Ingest;
}

/**
 * retryDelaySeconds is the only setting the tests change from SLICER_RETRY,
 * so three retries fit in a test's time; the limit and backoff stay.
 */
export async function startDerivedEnv(
  opts: { retryDelaySeconds?: number } = {},
): Promise<DerivedEnv> {
  const env = await startIngestEnv();
  let boss: PgBoss | undefined;
  let stub: SlicerStub | undefined;
  try {
    stub = await startSlicerStub();
    boss = createBoss({ databaseUrl: env.url });
    await boss.start();
    const derived = createDerived({
      db: env.db,
      store: env.store,
      slicerUrl: stub.url,
      queue: boss,
      retryDelaySeconds: opts.retryDelaySeconds ?? 1,
    });
    await startQueues(boss, {
      ingestFile: async () => {
        throw new Error("the derived tests send no ingest jobs");
      },
      purgeExpired: async () => ({}),
      sweepOrphans: async () => ({}),
      slicerJobs: derivedJobHandlers(derived),
      pollingIntervalSeconds: 0.5,
    });
    const startedBoss = boss;
    const startedStub = stub;
    return {
      ...env,
      boss: startedBoss,
      stub: startedStub,
      derived,
      ingestDerived: createIngest({
        db: env.db,
        store: env.store,
        afterCommit: (stored) => derived.afterUpload(stored),
      }),
      async stop() {
        await startedBoss.stop({ graceful: false });
        await startedStub.close();
        await env.stop();
      },
    };
  } catch (error) {
    await boss?.stop({ graceful: false });
    await stub?.close();
    await env.stop();
    throw error;
  }
}

/** Polls read() until done(value) holds, or fails after ms. */
export async function until<T>(
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
  ms = 45_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > end) throw new Error(`timed out waiting; last value ${JSON.stringify(value)}`);
    await sleep(200);
  }
}

/** The file row once its render or mesh has finished, ok or failed. */
export async function settledFile(
  env: DerivedEnv,
  fileId: string,
  ms?: number,
): Promise<ModelFile> {
  const file = await until(
    () => env.repos.files.get(fileId),
    (f) => f?.derivedStatus === "ok" || f?.derivedStatus === "failed",
    ms,
  );
  if (!file) throw new Error("file vanished");
  return file;
}

/** An object's bytes, read back from the bucket. */
export async function readObject(env: DerivedEnv, key: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of await env.store.getBlobStream(key)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Every key under a model's prefix in the bucket, sorted. */
export async function keysOf(env: DerivedEnv, modelId: string): Promise<string[]> {
  return (await env.store.listPrefix(`models/${modelId}/`)).map((o) => o.key).sort();
}

/** The model's blob rows, oldest first. */
export async function blobsOf(env: DerivedEnv, modelId: string) {
  return env.db
    .selectFrom("blobs")
    .selectAll()
    .where("modelId", "=", modelId)
    .orderBy("createdAt")
    .orderBy("id")
    .execute();
}
