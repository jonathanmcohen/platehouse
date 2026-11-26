// Trash, restore, the 30-day purge and Empty trash.
// A purge deletes the bucket objects first, then the rows, and is safe to run
// again after it failed part way.
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import Fastify from "fastify";
import { sql } from "kysely";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { registerOrganiseApi } from "../../../src/app-api/organise.js";
import { uuidv7 } from "../../../src/db/ids.js";
import { createBoss } from "../../../src/jobs/boss.js";
import { ON_DEMAND_TASKS, QUEUE, queueSettings } from "../../../src/jobs/queues.js";
import { createCollections } from "../../../src/library/collections.js";
import { createRename } from "../../../src/library/rename.js";
import { createSearch } from "../../../src/library/search.js";
import { createTags } from "../../../src/library/tags.js";
import {
  createTrash,
  ObjectsRemain,
  PurgeIncomplete,
  PurgeStarted,
  type PurgeStore,
  TRASH_RETENTION_DAYS,
} from "../../../src/library/trash.js";
import { BOSS_JOB } from "../../../src/repos/activity.js";
import { modelsRepo } from "../../../src/repos/models.js";
import { StoreUnavailable } from "../../../src/storage/s3.js";
import {
  type LibraryEnv,
  labelStored,
  marker,
  rowCounts,
  seedStoredModel,
  startLibraryEnv,
  trashDaysAgo,
} from "../support/library.js";

let env: LibraryEnv;
// pg-boss with the maintenance queue made and no worker, so an Empty trash
// job stays 'created' and a test runs its work itself (runJob).
let boss: PgBoss;

beforeAll(async () => {
  env = await startLibraryEnv();
  boss = createBoss({ databaseUrl: env.url });
  await boss.start();
  await boss.createQueue(QUEUE.maintenance, queueSettings().maintenance.queue);
});

afterAll(async () => {
  await boss?.stop({ graceful: true, timeout: 20_000 });
  await env?.stop();
});

const DAY_MS = 86_400_000;
const daysFromNow = (days: number) => new Date(Date.now() + days * DAY_MS);
const ids = (page: { models: Array<{ id: string }> }) => page.models.map((m) => m.id);
const prefix = (modelId: string) => `models/${modelId}/`;
const storeDown: PurgeStore = {
  listPrefix: async () => {
    throw new StoreUnavailable("ListObjectsV2", "ECONNREFUSED");
  },
  deleteBlobs: async () => {
    throw new StoreUnavailable("DeleteObjects", "ECONNREFUSED");
  },
};

/** The model's purge marker, read outside any purge transaction. */
async function purgeStartedAt(modelId: string): Promise<Date | null | undefined> {
  const row = await env.db
    .selectFrom("models")
    .select("purgeStartedAt")
    .where("id", "=", modelId)
    .executeTakeFirst();
  return row?.purgeStartedAt;
}

function trashFor(store: PurgeStore = env.store) {
  return createTrash({ db: env.db, store });
}

/** The database's clock now, in readAt's form, past the millisecond a model trashed just before was stamped in. */
async function databaseCutoff(): Promise<string> {
  await sleep(5);
  const { rows } = await sql<{ cutoff: string }>`
    select to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as cutoff`.execute(
    env.db,
  );
  const cutoff = rows[0]?.cutoff;
  if (cutoff === undefined) throw new Error("select now() answered no row");
  return cutoff;
}

/** The organising routes over this file's database and boss, with the given trash. */
async function organiseApp(trash: ReturnType<typeof trashFor>) {
  const app = Fastify({ logger: false });
  await registerOrganiseApi(app, { db: env.db, trash, boss });
  await app.ready();
  return app;
}

/**
 * Empty trash as the page does it: POST /app/api/trash/empty with a cutoff
 * read from the database's clock (or the one given), which marks every
 * model trashed up to then and queues one empty-trash job. No worker runs in
 * this file, so the job stays 'created'; runJob does its work with the same
 * trash: purgeMarked, which rejects with PurgeIncomplete when a model fails.
 */
async function emptyTrash(
  trash: ReturnType<typeof trashFor>,
  options: { cutoff?: string } = {},
): Promise<{
  status: number;
  body: { queued: number };
  runJob: () => Promise<{ purged: string[] }>;
}> {
  const app = await organiseApp(trash);
  try {
    const cutoff = options.cutoff ?? (await databaseCutoff());
    const res = await app.inject({
      method: "POST",
      url: "/app/api/trash/empty",
      payload: { cutoff },
    });
    return { status: res.statusCode, body: res.json(), runJob: () => trash.purgeMarked() };
  } finally {
    await app.close();
  }
}

/** POST /app/api/trash/:id/restore with a working store; its status. */
async function restoreThroughApi(modelId: string): Promise<number> {
  const app = await organiseApp(trashFor());
  try {
    const res = await app.inject({ method: "POST", url: `/app/api/trash/${modelId}/restore` });
    return res.statusCode;
  } finally {
    await app.close();
  }
}

/** The empty-trash jobs waiting in pg-boss's job table ('created'). */
async function createdEmptyTrashJobs(): Promise<number> {
  const { rows } = await sql<{ n: number }>`
    select count(*)::int as n from ${BOSS_JOB}
     where name = ${QUEUE.maintenance}
       and data->>'task' = ${ON_DEMAND_TASKS.emptyTrash}
       and state = 'created'`.execute(env.db);
  return rows[0]?.n ?? 0;
}

/** The ids of the empty-trash jobs waiting in pg-boss ('created'), oldest first. */
async function createdEmptyTrashJobIds(): Promise<string[]> {
  const jobs = await boss.findJobs(QUEUE.maintenance, {
    data: { task: ON_DEMAND_TASKS.emptyTrash },
    queued: true,
  });
  return jobs.filter((j) => j.state === "created").map((j) => j.id);
}

/** Deletes the empty-trash jobs left waiting by earlier tests, so the next Empty trash sends one. */
async function clearCreatedEmptyTrashJobs(): Promise<void> {
  const ids = await createdEmptyTrashJobIds();
  if (ids.length > 0) await boss.deleteJob(QUEUE.maintenance, ids);
  expect(await createdEmptyTrashJobs()).toBe(0);
}

/** How many trashed models carry the purge marker, in the whole database. */
async function markedCount(): Promise<number> {
  const row = await env.db
    .selectFrom("models")
    .select(sql<number>`count(*)::int`.as("n"))
    .where("trashedAt", "is not", null)
    .where("purgeStartedAt", "is not", null)
    .executeTakeFirstOrThrow();
  return row.n;
}

describe("trashModel and restoreModel", () => {
  test("the retention is 30 days", () => {
    expect(TRASH_RETENTION_DAYS).toBe(30);
  });

  test("trashed model disappears from library, search and API results", async () => {
    const word = marker();
    const creator = `Maker ${word}`;
    const tag = `Tag ${word}`;
    const collection = `Shelf ${word}`;
    const { model, file } = await seedStoredModel(env, {
      name: `Trashable ${word}`,
      caption: `Caption ${word}`,
      creator,
    });
    await createTags(env.db).addTag(model.id, tag);
    await createCollections(env.db).addToCollection(model.id, collection);
    const search = createSearch(env.db);

    // Visible everywhere first, so the checks below can fail.
    expect(ids(await search.search({ q: word }))).toEqual([model.id]);
    expect(ids(await search.search({}))).toContain(model.id);

    expect(await trashFor().trashModel(model.id)).toBe(true);

    // The library listing (search with no text), search by each field, and each filter.
    expect(ids(await search.search({}))).not.toContain(model.id);
    expect(ids(await search.search({ q: word }))).toEqual([]);
    expect(ids(await search.search({ q: `Caption ${word}` }))).toEqual([]);
    expect(ids(await search.search({ q: creator }))).toEqual([]);
    expect(ids(await search.search({ q: tag }))).toEqual([]);
    expect(ids(await search.search({ tag }))).toEqual([]);
    expect(ids(await search.search({ collection }))).toEqual([]);
    expect(ids(await search.search({ creator }))).toEqual([]);
    // What the API reads and writes through: the model lookup it answers 404
    // from, and the organising calls, which find no model.
    expect(await env.repos.models.get(model.id)).toBeUndefined();
    expect(await createTags(env.db).addTag(model.id, `Other ${word}`)).toBe(false);
    expect(await createCollections(env.db).addToCollection(model.id, `Other ${word}`)).toBe(false);
    expect(await createRename(env.db).renameModel(model.id, "Hidden")).toBe(false);
    expect(await createRename(env.db).renameFile(file.id, "hidden.3mf")).toBe(false);
  });

  test("restore brings back files, tags and collections", async () => {
    const word = marker();
    const tag = `Back ${word}`;
    const collection = `Return ${word}`;
    const { model, file, source, thumbnail } = await seedStoredModel(env, {
      name: `Restorable ${word}`,
    });
    await createTags(env.db).addTag(model.id, tag);
    await createCollections(env.db).addToCollection(model.id, collection);
    const objects = await env.store.listPrefix(prefix(model.id));
    expect(objects).toHaveLength(2);
    const trash = trashFor();

    expect(await trash.trashModel(model.id)).toBe(true);
    expect(await trash.restoreModel(model.id)).toBe(true);

    expect((await env.repos.models.get(model.id))?.trashedAt).toBeNull();
    expect((await env.repos.files.get(file.id))?.modelId).toBe(model.id);
    expect((await env.repos.blobs.get(source.id))?.state).toBe("stored");
    expect((await env.repos.blobs.get(thumbnail.id))?.state).toBe("stored");
    expect(await env.repos.tags.forModel(model.id)).toEqual([tag]);
    expect(await env.repos.collections.forModel(model.id)).toEqual([collection]);
    expect(await env.store.listPrefix(prefix(model.id))).toEqual(objects);

    const search = createSearch(env.db);
    expect(ids(await search.search({ q: word }))).toEqual([model.id]);
    expect(ids(await search.search({ tag }))).toEqual([model.id]);
    expect(ids(await search.search({ collection }))).toEqual([model.id]);
  });

  test("restore accepts the id in uppercase and still finds the model's lowercase keys", async () => {
    const { model, source, thumbnail } = await seedStoredModel(env);
    const trash = trashFor();
    expect(await trash.trashModel(model.id)).toBe(true);
    // The stored keys are lowercase, so the uppercase id below differs from them.
    expect(model.id).toBe(model.id.toLowerCase());
    expect(await env.store.listPrefix(prefix(model.id))).toHaveLength(2);

    expect(await trash.restoreModel(model.id.toUpperCase())).toBe(true);

    expect((await env.repos.models.get(model.id))?.trashedAt).toBeNull();
    expect((await env.repos.blobs.get(source.id))?.state).toBe("stored");
    expect((await env.repos.blobs.get(thumbnail.id))?.state).toBe("stored");
  });

  test("restore brings back a model that lost an object with no purge begun", async () => {
    const { model, source, thumbnail } = await seedStoredModel(env);
    const trash = trashFor();
    expect(await trash.trashModel(model.id)).toBe(true);
    // An object lost some other way than a purge (reconciling the bucket
    // against the rows exists for this): the rows say stored, the bucket has no thumbnail.
    await env.store.deleteBlobs([thumbnail.key]);
    expect(await purgeStartedAt(model.id)).toBeNull();

    expect(await trash.restoreModel(model.id)).toBe(true);

    expect((await env.repos.models.get(model.id))?.trashedAt).toBeNull();
    // The rows are untouched; the lost object shows as unavailable on
    // download (getBlobStream's BlobNotFound), not as a refused restore.
    expect((await env.repos.blobs.get(source.id))?.state).toBe("stored");
    expect((await env.repos.blobs.get(thumbnail.id))?.state).toBe("stored");
    expect((await env.store.listPrefix(prefix(model.id))).map((o) => o.key)).toEqual([source.key]);
  });

  test("a purge that fails before it deletes anything leaves no marker, and restore still works", async () => {
    const { model, source, thumbnail } = await seedStoredModel(env);
    const trash = trashFor();
    expect(await trash.trashModel(model.id)).toBe(true);
    await trashDaysAgo(env.db, model.id, 31);
    // The store is unreachable at the purge's first listPrefix, so not one
    // object is deleted: a daily purge during an outage must not make the
    // model unrestorable. (Empty trash marks its models when it is
    // confirmed, so this is the daily purge's case.)
    let deletes = 0;
    const listFails: PurgeStore = {
      listPrefix: async () => {
        throw new StoreUnavailable("ListObjectsV2", "ECONNREFUSED");
      },
      async deleteBlobs(keys) {
        deletes += 1;
        await env.store.deleteBlobs(keys);
      },
    };

    const failed = await trashFor(listFails)
      .purgeExpired(new Date())
      .catch((e: unknown) => e);

    expect(failed).toBeInstanceOf(PurgeIncomplete);
    expect((failed as PurgeIncomplete).failed.map((f) => f.modelId)).toContain(model.id);
    expect(deletes).toBe(0);
    expect(await purgeStartedAt(model.id)).toBeNull();
    expect(await env.store.listPrefix(prefix(model.id))).toHaveLength(2);

    expect(await trash.restoreModel(model.id)).toBe(true);

    expect((await env.repos.models.get(model.id))?.trashedAt).toBeNull();
    expect((await env.repos.blobs.get(source.id))?.state).toBe("stored");
    expect((await env.repos.blobs.get(thumbnail.id))?.state).toBe("stored");
  });

  test("a purge that fails once it has begun deleting keeps the marker, and restore is refused", async () => {
    const { model, source, thumbnail } = await seedStoredModel(env);
    const trash = trashFor();
    expect(await trash.trashModel(model.id)).toBe(true);
    await trashDaysAgo(env.db, model.id, 31);
    // The first DeleteObjects removes one object, then the connection drops.
    const dropsMidDelete: PurgeStore = {
      listPrefix: (p) => env.store.listPrefix(p),
      async deleteBlobs(keys) {
        await env.store.deleteBlobs(keys.slice(0, 1));
        throw new StoreUnavailable("DeleteObjects", "ECONNRESET");
      },
    };

    await expect(trashFor(dropsMidDelete).purgeExpired(new Date())).rejects.toBeInstanceOf(
      PurgeIncomplete,
    );
    expect(await purgeStartedAt(model.id)).toBeInstanceOf(Date);
    expect(await env.store.listPrefix(prefix(model.id))).toHaveLength(1);

    const error = await trash.restoreModel(model.id).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PurgeStarted);
    expect((error as PurgeStarted).modelId).toBe(model.id);
    expect((error as PurgeStarted).purgeStartedAt).toEqual(await purgeStartedAt(model.id));
    expect(
      (await env.repos.models.get(model.id, { includeTrashed: true }))?.trashedAt,
    ).not.toBeNull();
    expect(await env.repos.models.get(model.id)).toBeUndefined();
    expect((await env.repos.blobs.get(source.id))?.state).toBe("stored");
    expect((await env.repos.blobs.get(thumbnail.id))?.state).toBe("stored");

    // The next purge finishes it.
    expect((await trash.purgeExpired(new Date())).purged).toContain(model.id);
    expect(await rowCounts(env.db, model.id)).toMatchObject({ models: 0, blobs: 0 });
    expect(await env.store.listPrefix(prefix(model.id))).toEqual([]);
  });

  test("restore does not need the bucket", async () => {
    const { model } = await seedStoredModel(env);
    await trashFor().trashModel(model.id);

    expect(await trashFor(storeDown).restoreModel(model.id)).toBe(true);
    expect((await env.repos.models.get(model.id))?.trashedAt).toBeNull();
  });

  test("only a trashed model can carry the purge marker", async () => {
    const { model } = await seedStoredModel(env);
    await expect(
      env.db
        .updateTable("models")
        .set({ purgeStartedAt: new Date() })
        .where("id", "=", model.id)
        .execute(),
    ).rejects.toThrow(/models_purge_only_trashed/);
    expect(await purgeStartedAt(model.id)).toBeNull();
  });

  test("trash and restore answer false for an unknown, malformed or wrong-state model", async () => {
    const trash = trashFor();
    expect(await trash.trashModel(uuidv7())).toBe(false);
    expect(await trash.trashModel("x")).toBe(false);
    expect(await trash.restoreModel(uuidv7())).toBe(false);
    expect(await trash.restoreModel("x")).toBe(false);

    const { model } = await seedStoredModel(env);
    expect(await trash.restoreModel(model.id)).toBe(false);
    expect(await trash.trashModel(model.id)).toBe(true);
    expect(await trash.trashModel(model.id)).toBe(false);
  });
});

describe("purgeExpired", () => {
  test("purgeExpired removes models trashed over 30 days ago and their objects; listPrefix is empty", async () => {
    const tag = `Purge tag ${marker()}`;
    const collection = `Purge shelf ${marker()}`;
    const old = await seedStoredModel(env);
    const recent = await seedStoredModel(env);
    const live = await seedStoredModel(env);
    for (const m of [old, recent, live]) {
      await createTags(env.db).addTag(m.model.id, tag);
      await createCollections(env.db).addToCollection(m.model.id, collection);
    }
    // An object under the model's prefix with no stored row: a pending blob
    // whose upload landed. The purge lists the prefix, so it goes too.
    const orphan = await env.repos.blobs.insertPending({
      modelId: old.model.id,
      kind: "render_png",
      contentType: "image/png",
    });
    await env.store.putBlob(Readable.from([Buffer.from("orphan")]), {
      key: orphan.key,
      size: 6,
      contentType: "image/png",
    });
    const trash = trashFor();
    await trash.trashModel(old.model.id);
    await trash.trashModel(recent.model.id);
    await trashDaysAgo(env.db, old.model.id, 31);
    await trashDaysAgo(env.db, recent.model.id, 29);
    expect(await env.store.listPrefix(prefix(old.model.id))).toHaveLength(3);

    const result = await trash.purgeExpired(new Date());

    expect(result.purged).toEqual([old.model.id]);
    expect(await env.store.listPrefix(prefix(old.model.id))).toEqual([]);
    expect(await rowCounts(env.db, old.model.id)).toEqual({
      models: 0,
      files: 0,
      blobs: 0,
      modelTags: 0,
      collectionModels: 0,
    });
    // The other two keep their objects and rows; the shared tag and
    // collection stay for them.
    for (const kept of [recent, live]) {
      expect(await env.store.listPrefix(prefix(kept.model.id))).toHaveLength(2);
      expect(await rowCounts(env.db, kept.model.id)).toEqual({
        models: 1,
        files: 1,
        blobs: 2,
        modelTags: 1,
        collectionModels: 1,
      });
    }
    expect(
      (await env.repos.models.get(recent.model.id, { includeTrashed: true }))?.trashedAt,
    ).not.toBeNull();
  });

  // Issue #312: deleting a model for good takes its tags with it when no
  // other model, live or in the trash, has them. Collections stay, empty.
  test("a purge removes the tags only the purged model had, and keeps its collections", async () => {
    const own = `Own tag ${marker()}`;
    const sharedLive = `Shared live ${marker()}`;
    const sharedTrashed = `Shared trashed ${marker()}`;
    const shelf = `Own shelf ${marker()}`;
    const old = await seedStoredModel(env);
    const live = await seedStoredModel(env);
    const recent = await seedStoredModel(env);
    const tags = createTags(env.db);
    for (const tag of [own, sharedLive, sharedTrashed]) await tags.addTag(old.model.id, tag);
    await tags.addTag(live.model.id, sharedLive);
    await tags.addTag(recent.model.id, sharedTrashed);
    await createCollections(env.db).addToCollection(old.model.id, shelf);
    const trash = trashFor();
    await trash.trashModel(old.model.id);
    await trash.trashModel(recent.model.id);
    await trashDaysAgo(env.db, old.model.id, 31);

    expect((await trash.purgeExpired(new Date())).purged).toContain(old.model.id);

    expect(await labelStored(env.db, "tags", own)).toBe(false);
    expect(await labelStored(env.db, "tags", sharedLive)).toBe(true);
    expect(await labelStored(env.db, "tags", sharedTrashed)).toBe(true);
    expect(await env.repos.tags.forModel(live.model.id)).toEqual([sharedLive]);
    expect(await env.repos.tags.forModel(recent.model.id)).toEqual([sharedTrashed]);
    expect(await labelStored(env.db, "collections", shelf)).toBe(true);
  });

  test("Empty trash removes the tags only the purged models had", async () => {
    const own = `Emptied tag ${marker()}`;
    const a = await seedStoredModel(env);
    const b = await seedStoredModel(env);
    for (const m of [a, b]) await createTags(env.db).addTag(m.model.id, own);
    const trash = trashFor();
    await trash.trashModel(a.model.id);
    await trash.trashModel(b.model.id);

    // Other trashed models in the file may be marked too; these two are.
    const emptied = await emptyTrash(trash);
    expect(emptied.status).toBe(202);
    expect(emptied.body.queued).toBeGreaterThanOrEqual(2);
    expect((await emptied.runJob()).purged).toEqual(
      expect.arrayContaining([a.model.id, b.model.id]),
    );
    expect(await rowCounts(env.db, a.model.id)).toMatchObject({ models: 0 });
    expect(await rowCounts(env.db, b.model.id)).toMatchObject({ models: 0 });
    expect(await labelStored(env.db, "tags", own)).toBe(false);
  });

  test("the cutoff is 30 days before the given time", async () => {
    const { model } = await seedStoredModel(env);
    const trash = trashFor();
    await trash.trashModel(model.id);

    expect((await trash.purgeExpired(daysFromNow(29))).purged).not.toContain(model.id);
    expect(await rowCounts(env.db, model.id)).toMatchObject({ models: 1 });

    expect((await trash.purgeExpired(daysFromNow(31))).purged).toContain(model.id);
    expect(await rowCounts(env.db, model.id)).toMatchObject({ models: 0 });
    expect(await env.store.listPrefix(prefix(model.id))).toEqual([]);
  });

  test("a live model is never purged, however old", async () => {
    const { model } = await seedStoredModel(env);
    const result = await trashFor().purgeExpired(daysFromNow(3650));
    expect(result.purged).not.toContain(model.id);
    expect(await rowCounts(env.db, model.id)).toMatchObject({ models: 1, blobs: 2 });
    expect(await env.store.listPrefix(prefix(model.id))).toHaveLength(2);
  });

  test("objects go first: the rows are still there while the objects are deleted", async () => {
    const { model } = await seedStoredModel(env);
    await trashFor().trashModel(model.id);
    await trashDaysAgo(env.db, model.id, 40);
    const seen: Array<Awaited<ReturnType<typeof rowCounts>>> = [];
    const markers: Array<Date | null | undefined> = [];
    const watching: PurgeStore = {
      listPrefix: (p) => env.store.listPrefix(p),
      async deleteBlobs(keys) {
        seen.push(await rowCounts(env.db, model.id));
        // Read on another connection: the marker is committed, not just
        // written inside the purge's own transaction.
        markers.push(await purgeStartedAt(model.id));
        await env.store.deleteBlobs(keys);
      },
    };

    expect((await trashFor(watching).purgeExpired(new Date())).purged).toContain(model.id);
    expect(seen[0]).toMatchObject({ models: 1, files: 1, blobs: 2 });
    expect(markers[0]).toBeInstanceOf(Date);
    expect(await rowCounts(env.db, model.id)).toMatchObject({ models: 0, blobs: 0 });
  });

  test("a purge that fails part way keeps the rows, and a retry finishes it", async () => {
    const { model } = await seedStoredModel(env);
    await trashFor().trashModel(model.id);
    await trashDaysAgo(env.db, model.id, 45);

    // The store is down: nothing is deleted at all.
    const first = await trashFor(storeDown)
      .purgeExpired(new Date())
      .catch((e: unknown) => e);
    expect(first).toBeInstanceOf(PurgeIncomplete);
    expect((first as PurgeIncomplete).failed.map((f) => f.modelId)).toContain(model.id);
    expect(
      (first as PurgeIncomplete).failed.find((f) => f.modelId === model.id)?.error,
    ).toBeInstanceOf(StoreUnavailable);
    expect(await rowCounts(env.db, model.id)).toMatchObject({ models: 1, files: 1, blobs: 2 });
    expect(await env.store.listPrefix(prefix(model.id))).toHaveLength(2);

    // The objects are deleted, then the connection drops before the purge
    // can check the prefix: the rows stay, the model stays in the trash.
    let lists = 0;
    const dropsAfterDelete: PurgeStore = {
      async listPrefix(p) {
        lists += 1;
        if (lists > 1) throw new StoreUnavailable("ListObjectsV2", "ECONNRESET");
        return env.store.listPrefix(p);
      },
      deleteBlobs: (keys) => env.store.deleteBlobs(keys),
    };
    await expect(trashFor(dropsAfterDelete).purgeExpired(new Date())).rejects.toBeInstanceOf(
      PurgeIncomplete,
    );
    expect(await env.store.listPrefix(prefix(model.id))).toEqual([]);
    expect(await rowCounts(env.db, model.id)).toMatchObject({ models: 1, files: 1, blobs: 2 });
    expect(
      (await env.repos.models.get(model.id, { includeTrashed: true }))?.trashedAt,
    ).not.toBeNull();

    // A restore now would bring back a model with no bytes: its purge has
    // begun, so it is refused, and the model stays in the trash for the retry.
    await expect(trashFor().restoreModel(model.id)).rejects.toBeInstanceOf(PurgeStarted);
    expect(
      (await env.repos.models.get(model.id, { includeTrashed: true }))?.trashedAt,
    ).not.toBeNull();

    // The retry finds the objects already gone and removes the rows.
    expect((await trashFor().purgeExpired(new Date())).purged).toContain(model.id);
    expect(await rowCounts(env.db, model.id)).toMatchObject({ models: 0, files: 0, blobs: 0 });

    // And once more changes nothing and does not fail.
    expect((await trashFor().purgeExpired(new Date())).purged).not.toContain(model.id);
  });

  test("an Empty trash that fails mid-delete on a model trashed today is finished by the next run", async () => {
    const { model } = await seedStoredModel(env);
    const recent = await seedStoredModel(env);
    const trash = trashFor();
    expect(await trash.trashModel(model.id)).toBe(true);
    // For this model, the first DeleteObjects removes one object, then the
    // connection drops. Other trashed models in the file are purged normally.
    const dropsMidDelete: PurgeStore = {
      listPrefix: (p) => env.store.listPrefix(p),
      async deleteBlobs(keys) {
        if (!keys.some((k) => k.startsWith(prefix(model.id)))) return env.store.deleteBlobs(keys);
        await env.store.deleteBlobs(keys.slice(0, 1));
        throw new StoreUnavailable("DeleteObjects", "ECONNRESET");
      },
    };
    const emptied = await emptyTrash(trashFor(dropsMidDelete));
    expect(emptied.status).toBe(202);
    await expect(emptied.runJob()).rejects.toBeInstanceOf(PurgeIncomplete);
    expect(await purgeStartedAt(model.id)).toBeInstanceOf(Date);
    expect(await env.store.listPrefix(prefix(model.id))).toHaveLength(1);
    // An unmarked model trashed today, which the daily run must leave alone.
    expect(await trash.trashModel(recent.model.id)).toBe(true);

    // The daily run picks up the marked model, trashed today, and finishes it.
    const result = await trash.purgeExpired(new Date());

    expect(result.purged).toContain(model.id);
    expect(await rowCounts(env.db, model.id)).toMatchObject({ models: 0, files: 0, blobs: 0 });
    expect(await env.store.listPrefix(prefix(model.id))).toEqual([]);
    expect(result.purged).not.toContain(recent.model.id);
    expect(await rowCounts(env.db, recent.model.id)).toMatchObject({ models: 1, blobs: 2 });
    expect(await env.store.listPrefix(prefix(recent.model.id))).toHaveLength(2);
    expect(await purgeStartedAt(recent.model.id)).toBeNull();

    // Clean up so later purges in this file are not affected.
    expect(await trash.restoreModel(recent.model.id)).toBe(true);
  });

  test("an object outside the blob layout is never deleted, and the purge names it", async () => {
    const { model, source, thumbnail } = await seedStoredModel(env);
    await trashFor().trashModel(model.id);
    await trashDaysAgo(env.db, model.id, 50);
    // A folder marker an S3 console makes: listed under the prefix, but not
    // in the models/<modelId>/<blobId> layout, so the store will not delete it.
    const stray = prefix(model.id);
    const deleted: string[] = [];
    const withStray: PurgeStore = {
      async listPrefix(p) {
        const listed = await env.store.listPrefix(p);
        return p === stray ? [...listed, { key: stray, size: 0 }] : listed;
      },
      async deleteBlobs(keys) {
        deleted.push(...keys.filter((k) => k.startsWith(stray)));
        await env.store.deleteBlobs(keys);
      },
    };

    const error = await trashFor(withStray)
      .purgeExpired(new Date())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PurgeIncomplete);
    const remain = (error as PurgeIncomplete).failed.find((f) => f.modelId === model.id)?.error;
    expect(remain).toBeInstanceOf(ObjectsRemain);
    expect((remain as ObjectsRemain).count).toBe(1);
    expect((remain as ObjectsRemain).keys).toEqual([stray]);
    expect((remain as ObjectsRemain).message).toContain(stray);
    expect(deleted.sort()).toEqual([source.key, thumbnail.key].sort());
    expect(await rowCounts(env.db, model.id)).toMatchObject({ models: 1, blobs: 2 });

    // With the stray object removed by hand (here: a store without it), the
    // next run finishes the purge.
    expect((await trashFor().purgeExpired(new Date())).purged).toContain(model.id);
    expect(await rowCounts(env.db, model.id)).toMatchObject({ models: 0 });
  });

  test("ObjectsRemain names at most the first ten leftover keys", () => {
    const keys = Array.from({ length: 12 }, (_, i) => `models/m/stray-${i}`);
    const error = new ObjectsRemain("m", keys);
    expect(error.count).toBe(12);
    expect(error.keys).toEqual(keys.slice(0, 10));
    expect(error.message).toContain("stray-9");
    expect(error.message).not.toContain("stray-10");
  });

  test("one model failing does not stop the others being purged", async () => {
    const stuck = await seedStoredModel(env);
    const fine = await seedStoredModel(env);
    const trash = trashFor();
    for (const m of [stuck, fine]) {
      await trash.trashModel(m.model.id);
      await trashDaysAgo(env.db, m.model.id, 60);
    }
    const failsForOne: PurgeStore = {
      listPrefix: (p) => env.store.listPrefix(p),
      async deleteBlobs(keys) {
        if (keys.some((k) => k.startsWith(prefix(stuck.model.id)))) {
          throw new StoreUnavailable("DeleteObjects", "ETIMEDOUT");
        }
        await env.store.deleteBlobs(keys);
      },
    };

    const error = await trashFor(failsForOne)
      .purgeExpired(new Date())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PurgeIncomplete);
    expect((error as PurgeIncomplete).purged).toContain(fine.model.id);
    expect((error as PurgeIncomplete).failed.map((f) => f.modelId)).toEqual([stuck.model.id]);
    expect(await rowCounts(env.db, fine.model.id)).toMatchObject({ models: 0 });
    expect(await rowCounts(env.db, stuck.model.id)).toMatchObject({ models: 1, blobs: 2 });
    expect(await env.store.listPrefix(prefix(stuck.model.id))).toHaveLength(2);

    // Clean up so later purges in this file are not affected.
    expect((await trash.purgeExpired(new Date())).purged).toContain(stuck.model.id);
  });

  test("a restore while a purge deletes objects is refused at once, and the purge finishes", async () => {
    const { model } = await seedStoredModel(env);
    const trash = trashFor();
    await trash.trashModel(model.id);
    await trashDaysAgo(env.db, model.id, 31);
    let restore: Promise<unknown> | undefined;
    let stateDuringPurge: string | undefined;
    const racing: PurgeStore = {
      listPrefix: (p) => env.store.listPrefix(p),
      async deleteBlobs(keys) {
        restore = trash.restoreModel(model.id).catch((e: unknown) => e);
        stateDuringPurge = await Promise.race([
          restore.then(() => "settled"),
          sleep(500).then(() => "waiting"),
        ]);
        await env.store.deleteBlobs(keys);
      },
    };

    expect((await trashFor(racing).purgeExpired(new Date())).purged).toContain(model.id);
    // The marker is committed before the first delete, so the restore does
    // not wait for the purge: it is refused straight away.
    expect(stateDuringPurge).toBe("settled");
    expect(await restore).toBeInstanceOf(PurgeStarted);
    expect(await rowCounts(env.db, model.id)).toMatchObject({ models: 0 });
    expect(await env.store.listPrefix(prefix(model.id))).toEqual([]);
  });

  test("a restore that holds the row makes a purge wait, and the purge then finds no trashed model", async () => {
    const { model } = await seedStoredModel(env);
    const trash = trashFor();
    await trash.trashModel(model.id);
    await trashDaysAgo(env.db, model.id, 31);
    let purge: Promise<unknown> | undefined;
    let stateDuringRestore: string | undefined;
    let deletes = 0;
    const counting: PurgeStore = {
      listPrefix: (p) => env.store.listPrefix(p),
      async deleteBlobs(keys) {
        // Other tests' trashed models may be purged by the same run.
        if (keys.some((k) => k.startsWith(prefix(model.id)))) deletes += 1;
        await env.store.deleteBlobs(keys);
      },
    };

    // Hold the row the way restoreModel does, start the purge, then restore.
    await env.db.transaction().execute(async (trx) => {
      await trx
        .selectFrom("models")
        .select("id")
        .where("id", "=", model.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      purge = trashFor(counting).purgeExpired(new Date());
      stateDuringRestore = await Promise.race([
        purge.then(() => "settled"),
        sleep(500).then(() => "waiting"),
      ]);
      await trx.updateTable("models").set({ trashedAt: null }).where("id", "=", model.id).execute();
    });

    expect(stateDuringRestore).toBe("waiting");
    expect(((await purge) as { purged: string[] }).purged).not.toContain(model.id);
    expect(deletes).toBe(0);
    expect(await purgeStartedAt(model.id)).toBeNull();
    expect((await env.repos.models.get(model.id))?.trashedAt).toBeNull();
    expect(await env.store.listPrefix(prefix(model.id))).toHaveLength(2);
  });
});

describe("Empty trash (POST /app/api/trash/empty)", () => {
  test("empty trash marks everything trashed and queues one job, which purges it", async () => {
    const justNow = await seedStoredModel(env);
    const lastWeek = await seedStoredModel(env);
    const live = await seedStoredModel(env);
    const trash = trashFor();
    await trash.trashModel(justNow.model.id);
    await trash.trashModel(lastWeek.model.id);
    await trashDaysAgo(env.db, lastWeek.model.id, 7);

    const result = await emptyTrash(trash);

    // The answer comes at once: the models are marked, not yet deleted.
    expect(result.status).toBe(202);
    expect(result.body.queued).toBeGreaterThanOrEqual(2);
    for (const m of [justNow, lastWeek]) {
      expect(await purgeStartedAt(m.model.id)).toBeInstanceOf(Date);
      expect(await rowCounts(env.db, m.model.id)).toMatchObject({ models: 1, blobs: 2 });
      expect(await env.store.listPrefix(prefix(m.model.id))).toHaveLength(2);
    }
    // No worker runs in this file, so the one job queued stays 'created'.
    expect(await createdEmptyTrashJobs()).toBe(1);

    expect((await result.runJob()).purged).toEqual(
      expect.arrayContaining([justNow.model.id, lastWeek.model.id]),
    );

    for (const gone of [justNow, lastWeek]) {
      expect(await env.store.listPrefix(prefix(gone.model.id))).toEqual([]);
      expect(await rowCounts(env.db, gone.model.id)).toEqual({
        models: 0,
        files: 0,
        blobs: 0,
        modelTags: 0,
        collectionModels: 0,
      });
    }
    expect(await env.store.listPrefix(prefix(live.model.id))).toHaveLength(2);
    expect(await rowCounts(env.db, live.model.id)).toMatchObject({ models: 1, blobs: 2 });
    expect(await purgeStartedAt(live.model.id)).toBeNull();

    // Nothing is left in the trash, so a second Empty trash marks nothing.
    const left = await env.db
      .selectFrom("models")
      .select("id")
      .where("trashedAt", "is not", null)
      .execute();
    expect(left).toEqual([]);
    const again = await emptyTrash(trash);
    expect({ status: again.status, body: again.body }).toEqual({
      status: 202,
      body: { queued: 0 },
    });
    expect(await createdEmptyTrashJobs()).toBe(1);
  });

  test("a model trashed after the cutoff is not marked, and can be restored", async () => {
    const shown = await seedStoredModel(env);
    const unseen = await seedStoredModel(env);
    const trash = trashFor();
    await trash.trashModel(shown.model.id);
    const cutoff = await databaseCutoff();
    await sleep(5);
    await trash.trashModel(unseen.model.id);

    const result = await emptyTrash(trash, { cutoff });

    expect(result.status).toBe(202);
    expect(await purgeStartedAt(shown.model.id)).toBeInstanceOf(Date);
    expect(await purgeStartedAt(unseen.model.id)).toBeNull();
    expect(await restoreThroughApi(unseen.model.id)).toBe(204);
    expect((await env.repos.models.get(unseen.model.id))?.trashedAt).toBeNull();

    await result.runJob();
    expect(await rowCounts(env.db, shown.model.id)).toMatchObject({ models: 0 });
    expect(await rowCounts(env.db, unseen.model.id)).toMatchObject({ models: 1, blobs: 2 });
    expect(await env.store.listPrefix(prefix(unseen.model.id))).toHaveLength(2);
  });

  test("a restore that holds the row wins: the model is live and unmarked, and the job leaves it", async () => {
    const { model } = await seedStoredModel(env);
    const trash = trashFor();
    await trash.trashModel(model.id);
    let posted: ReturnType<typeof emptyTrash> | undefined;

    // Hold the row the way restoreModel does, send Empty trash, then restore
    // through the same transaction and commit.
    await env.db.transaction().execute(async (trx) => {
      await trx
        .selectFrom("models")
        .select("id")
        .where("id", "=", model.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      posted = emptyTrash(trash);
      await sleep(200);
      // The marking statement is waiting on this row's lock.
      await vi.waitFor(
        async () => {
          const { rows } = await sql<{ n: number }>`
            select count(*)::int as n from pg_stat_activity
             where datname = current_database()
               and wait_event_type = 'Lock'
               and query ilike '%update models set purge_started_at%'`.execute(env.db);
          expect(rows[0]?.n).toBeGreaterThan(0);
        },
        { timeout: 10_000, interval: 50 },
      );
      expect(await modelsRepo(trx).restore(model.id)).toBe(true);
    });
    const result = await (posted as ReturnType<typeof emptyTrash>);

    // Assert on the model, not on queued: other models may be in the trash.
    expect(result.status).toBe(202);
    expect((await env.repos.models.get(model.id))?.trashedAt).toBeNull();
    expect(await purgeStartedAt(model.id)).toBeNull();
    await result.runJob();
    expect(await rowCounts(env.db, model.id)).toMatchObject({ models: 1, blobs: 2 });
    expect(await env.store.listPrefix(prefix(model.id))).toHaveLength(2);
  });

  test("a restore after Empty trash was confirmed is refused with PurgeStarted", async () => {
    const { model } = await seedStoredModel(env);
    const trash = trashFor();
    await trash.trashModel(model.id);

    const result = await emptyTrash(trash);
    expect(result.status).toBe(202);

    const error = await trash.restoreModel(model.id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PurgeStarted);
    expect((error as PurgeStarted).modelId).toBe(model.id);
    expect(await restoreThroughApi(model.id)).toBe(409);
    expect(
      (await env.repos.models.get(model.id, { includeTrashed: true }))?.trashedAt,
    ).not.toBeNull();

    // The job finishes it.
    expect((await result.runJob()).purged).toContain(model.id);
    expect(await rowCounts(env.db, model.id)).toMatchObject({ models: 0 });
  });

  test("two Empty trash requests with the same cutoff answer the same, and one job is queued", async () => {
    const { model } = await seedStoredModel(env);
    const trash = trashFor();
    await trash.trashModel(model.id);
    const cutoff = await databaseCutoff();
    // No job waiting, so one of the two at once must send it, and only one may.
    await clearCreatedEmptyTrashJobs();

    const [first, second] = await Promise.all([
      emptyTrash(trash, { cutoff }),
      emptyTrash(trash, { cutoff }),
    ]);

    expect([first.status, second.status]).toEqual([202, 202]);
    expect(first.body.queued).toBeGreaterThanOrEqual(1);
    expect(second.body.queued).toBe(first.body.queued);
    // At most one queued job: no worker runs here, so it is still 'created'.
    expect(await createdEmptyTrashJobs()).toBe(1);

    // And one after the other.
    const third = await emptyTrash(trash, { cutoff });
    expect(third.body.queued).toBe(first.body.queued);
    expect(await createdEmptyTrashJobs()).toBe(1);

    expect((await first.runJob()).purged).toContain(model.id);
  });

  test("a job a worker claims while Empty trash checks it is not relied on: a new job is sent", async () => {
    const first = await seedStoredModel(env);
    const second = await seedStoredModel(env);
    const trash = trashFor();
    await clearCreatedEmptyTrashJobs();
    await trash.trashModel(first.model.id);
    expect((await emptyTrash(trash)).status).toBe(202);
    const [claimed] = await createdEmptyTrashJobIds();
    if (claimed === undefined) throw new Error("Empty trash queued no job");
    await trash.trashModel(second.model.id);
    let posted: ReturnType<typeof emptyTrash> | undefined;

    // A worker claims the job as pg-boss's fetch does (its row locked and
    // made active) while a second Empty trash checks for a queued job. The
    // check waits for the claim; once it commits, the job is active, and a
    // job that already listed the marked models cannot be relied on.
    await env.db.transaction().execute(async (trx) => {
      await sql`update ${BOSS_JOB} set state = 'active', started_on = now()
                 where name = ${QUEUE.maintenance} and id = ${claimed}`.execute(trx);
      posted = emptyTrash(trash);
      await vi.waitFor(
        async () => {
          const { rows } = await sql<{ n: number }>`
            select count(*)::int as n from pg_stat_activity
             where datname = current_database()
               and wait_event_type = 'Lock'
               and query ilike '%for share%'`.execute(env.db);
          expect(rows[0]?.n).toBeGreaterThan(0);
        },
        { timeout: 10_000, interval: 50 },
      );
    });
    const result = await (posted as ReturnType<typeof emptyTrash>);

    expect(result.status).toBe(202);
    expect(result.body.queued).toBeGreaterThanOrEqual(2);
    const waiting = await createdEmptyTrashJobIds();
    expect(waiting).toHaveLength(1);
    expect(waiting).not.toContain(claimed);

    // Tidy up: the claimed job ends, and the new one's work is done here.
    await boss.complete(QUEUE.maintenance, claimed);
    expect((await result.runJob()).purged).toEqual(
      expect.arrayContaining([first.model.id, second.model.id]),
    );
  });

  test("a job that fails on the store keeps the models marked, and a later run finishes them", async () => {
    const a = await seedStoredModel(env);
    const b = await seedStoredModel(env);
    const trash = trashFor();
    for (const m of [a, b]) await trash.trashModel(m.model.id);

    const result = await emptyTrash(trashFor(storeDown));
    expect(result.status).toBe(202);
    await expect(result.runJob()).rejects.toBeInstanceOf(PurgeIncomplete);

    for (const m of [a, b]) {
      expect(await purgeStartedAt(m.model.id)).toBeInstanceOf(Date);
      expect(
        (await env.repos.models.get(m.model.id, { includeTrashed: true }))?.trashedAt,
      ).not.toBeNull();
      expect(await rowCounts(env.db, m.model.id)).toMatchObject({ models: 1, blobs: 2 });
    }

    // With the store back, the next run finishes them.
    expect((await trash.purgeMarked()).purged).toEqual(
      expect.arrayContaining([a.model.id, b.model.id]),
    );
    for (const m of [a, b]) {
      expect(await rowCounts(env.db, m.model.id)).toMatchObject({ models: 0, blobs: 0 });
      expect(await env.store.listPrefix(prefix(m.model.id))).toEqual([]);
    }
  });

  test("an aborted run stops between models, and the next run purges the rest", async () => {
    const a = await seedStoredModel(env);
    const b = await seedStoredModel(env);
    const trash = trashFor();
    for (const m of [a, b]) await trash.trashModel(m.model.id);
    const result = await emptyTrash(trash);
    expect(result.status).toBe(202);
    const marked = await markedCount();
    expect(marked).toBeGreaterThanOrEqual(2);

    // The job is stopped (the server stopping) while the first model's
    // objects are deleted: that model is finished, and no other is begun.
    const stop = new AbortController();
    const aborting: PurgeStore = {
      listPrefix: (p) => env.store.listPrefix(p),
      async deleteBlobs(keys) {
        await env.store.deleteBlobs(keys);
        stop.abort();
      },
    };

    await expect(trashFor(aborting).purgeMarked(stop.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(await markedCount()).toBe(marked - 1);

    expect((await trash.purgeMarked()).purged).toHaveLength(marked - 1);
    expect(await markedCount()).toBe(0);
    for (const m of [a, b]) {
      expect(await rowCounts(env.db, m.model.id)).toMatchObject({ models: 0, blobs: 0 });
    }
  });

  test("the cutoff includes its whole millisecond and nothing after it", async () => {
    const inside = await seedStoredModel(env);
    const after = await seedStoredModel(env);
    const trash = trashFor();
    for (const m of [inside, after]) await trash.trashModel(m.model.id);
    const cutoff = await databaseCutoff();
    // trashed_at keeps microseconds; the cutoff has milliseconds, as readAt does.
    await sql`update models set trashed_at = ${cutoff}::timestamptz + interval '500 microseconds'
               where id = ${inside.model.id}`.execute(env.db);
    await sql`update models set trashed_at = ${cutoff}::timestamptz + interval '1 millisecond'
               where id = ${after.model.id}`.execute(env.db);

    const result = await emptyTrash(trash, { cutoff });

    expect(result.status).toBe(202);
    expect(await purgeStartedAt(inside.model.id)).toBeInstanceOf(Date);
    expect(await purgeStartedAt(after.model.id)).toBeNull();
    await result.runJob();
    expect(await rowCounts(env.db, inside.model.id)).toMatchObject({ models: 0 });
    expect(await trash.restoreModel(after.model.id)).toBe(true);
  });
});
