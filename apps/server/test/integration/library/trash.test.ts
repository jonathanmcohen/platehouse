// Build plan Task 14, AC-063: trash, restore, the 30-day purge and Empty trash.
// A purge deletes the bucket objects first, then the rows, and is safe to run
// again after it failed part way.
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { uuidv7 } from "../../../src/db/ids.js";
import { createCollections } from "../../../src/library/collections.js";
import { createRename } from "../../../src/library/rename.js";
import { createSearch } from "../../../src/library/search.js";
import { createTags } from "../../../src/library/tags.js";
import {
  createTrash,
  FilesMissing,
  PurgeIncomplete,
  type PurgeStore,
  TRASH_RETENTION_DAYS,
} from "../../../src/library/trash.js";
import { StoreUnavailable } from "../../../src/storage/s3.js";
import {
  type LibraryEnv,
  marker,
  rowCounts,
  seedStoredModel,
  startLibraryEnv,
  trashDaysAgo,
} from "../support/library.js";

let env: LibraryEnv;

beforeAll(async () => {
  env = await startLibraryEnv();
});

afterAll(async () => {
  await env?.stop();
});

const DAY_MS = 86_400_000;
const daysFromNow = (days: number) => new Date(Date.now() + days * DAY_MS);
const ids = (page: { models: Array<{ id: string }> }) => page.models.map((m) => m.id);
const prefix = (modelId: string) => `models/${modelId}/`;

function trashFor(store: PurgeStore = env.store) {
  return createTrash({ db: env.db, store });
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

  test("restore refuses a model a failed purge left with some of its objects gone", async () => {
    const { model, source, thumbnail } = await seedStoredModel(env);
    const trash = trashFor();
    expect(await trash.trashModel(model.id)).toBe(true);
    // What a purge that failed part way through DeleteObjects leaves: the
    // rows intact and stored, one of the two objects gone.
    await env.store.deleteBlobs([thumbnail.key]);

    const error = await trash.restoreModel(model.id).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FilesMissing);
    expect((error as FilesMissing).modelId).toBe(model.id);
    expect((error as FilesMissing).missing).toBe(1);
    expect(
      (await env.repos.models.get(model.id, { includeTrashed: true }))?.trashedAt,
    ).not.toBeNull();
    expect(await env.repos.models.get(model.id)).toBeUndefined();
    expect((await env.repos.blobs.get(source.id))?.state).toBe("stored");

    // The next purge finishes it.
    expect((await trash.emptyTrash()).purged).toContain(model.id);
    expect(await rowCounts(env.db, model.id)).toMatchObject({ models: 0, blobs: 0 });
  });

  test("restore fails, and the model stays in the trash, when the bucket cannot be listed", async () => {
    const { model } = await seedStoredModel(env);
    await trashFor().trashModel(model.id);
    const down: PurgeStore = {
      listPrefix: async () => {
        throw new StoreUnavailable("ListObjectsV2", "ECONNREFUSED");
      },
      deleteBlobs: async () => {
        throw new StoreUnavailable("DeleteObjects", "ECONNREFUSED");
      },
    };

    await expect(trashFor(down).restoreModel(model.id)).rejects.toBeInstanceOf(StoreUnavailable);
    expect(
      (await env.repos.models.get(model.id, { includeTrashed: true }))?.trashedAt,
    ).not.toBeNull();

    // With the store back, the restore goes through.
    expect(await trashFor().restoreModel(model.id)).toBe(true);
    expect((await env.repos.models.get(model.id))?.trashedAt).toBeNull();
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
    const watching: PurgeStore = {
      listPrefix: (p) => env.store.listPrefix(p),
      async deleteBlobs(keys) {
        seen.push(await rowCounts(env.db, model.id));
        await env.store.deleteBlobs(keys);
      },
    };

    expect((await trashFor(watching).purgeExpired(new Date())).purged).toContain(model.id);
    expect(seen[0]).toMatchObject({ models: 1, files: 1, blobs: 2 });
    expect(await rowCounts(env.db, model.id)).toMatchObject({ models: 0, blobs: 0 });
  });

  test("a purge that fails part way keeps the rows, and a retry finishes it", async () => {
    const { model } = await seedStoredModel(env);
    await trashFor().trashModel(model.id);
    await trashDaysAgo(env.db, model.id, 45);

    // The store is down: nothing is deleted at all.
    const down: PurgeStore = {
      listPrefix: async () => {
        throw new StoreUnavailable("ListObjectsV2", "ECONNREFUSED");
      },
      deleteBlobs: async () => {
        throw new StoreUnavailable("DeleteObjects", "ECONNREFUSED");
      },
    };
    const first = await trashFor(down)
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

    // A restore now would bring back a model with no bytes: it is refused,
    // and the model stays in the trash for the retry.
    await expect(trashFor().restoreModel(model.id)).rejects.toBeInstanceOf(FilesMissing);
    expect(
      (await env.repos.models.get(model.id, { includeTrashed: true }))?.trashedAt,
    ).not.toBeNull();

    // The retry finds the objects already gone and removes the rows.
    expect((await trashFor().purgeExpired(new Date())).purged).toContain(model.id);
    expect(await rowCounts(env.db, model.id)).toMatchObject({ models: 0, files: 0, blobs: 0 });

    // And once more changes nothing and does not fail.
    expect((await trashFor().purgeExpired(new Date())).purged).not.toContain(model.id);
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

  test("a restore during a purge waits for it, then finds no model", async () => {
    const { model } = await seedStoredModel(env);
    const trash = trashFor();
    await trash.trashModel(model.id);
    await trashDaysAgo(env.db, model.id, 31);
    let restore: Promise<boolean> | undefined;
    let stateDuringPurge: string | undefined;
    const racing: PurgeStore = {
      listPrefix: (p) => env.store.listPrefix(p),
      async deleteBlobs(keys) {
        restore = trash.restoreModel(model.id);
        stateDuringPurge = await Promise.race([
          restore.then(() => "settled"),
          sleep(500).then(() => "waiting"),
        ]);
        await env.store.deleteBlobs(keys);
      },
    };

    expect((await trashFor(racing).purgeExpired(new Date())).purged).toContain(model.id);
    expect(stateDuringPurge).toBe("waiting");
    expect(await restore).toBe(false);
    expect(await rowCounts(env.db, model.id)).toMatchObject({ models: 0 });
    expect(await env.store.listPrefix(prefix(model.id))).toEqual([]);
  });
});

describe("emptyTrash", () => {
  test("empty trash purges everything trashed", async () => {
    const justNow = await seedStoredModel(env);
    const lastWeek = await seedStoredModel(env);
    const live = await seedStoredModel(env);
    const trash = trashFor();
    await trash.trashModel(justNow.model.id);
    await trash.trashModel(lastWeek.model.id);
    await trashDaysAgo(env.db, lastWeek.model.id, 7);

    const result = await trash.emptyTrash();

    expect(result.purged).toEqual(expect.arrayContaining([justNow.model.id, lastWeek.model.id]));
    expect(result.purged).not.toContain(live.model.id);
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

    // Nothing is left in the trash.
    const left = await env.db
      .selectFrom("models")
      .select("id")
      .where("trashedAt", "is not", null)
      .execute();
    expect(left).toEqual([]);
    expect((await trash.emptyTrash()).purged).toEqual([]);
  });
});
