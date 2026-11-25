// A model can sit in more than one collection, and
// collections are flat: one cannot hold another.
import { setTimeout as sleep } from "node:timers/promises";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { uuidv7 } from "../../../src/db/ids.js";
import { createCollections } from "../../../src/library/collections.js";
import { createSearch } from "../../../src/library/search.js";
import { createTrash } from "../../../src/library/trash.js";
import { collectionsRepo } from "../../../src/repos/collections.js";
import {
  type LibraryEnv,
  labelStored,
  marker,
  seedStoredModel,
  startLibraryEnv,
} from "../support/library.js";

let env: LibraryEnv;

beforeAll(async () => {
  env = await startLibraryEnv();
});

afterAll(async () => {
  await env?.stop();
});

const ids = (page: { models: Array<{ id: string }> }) => page.models.map((m) => m.id).sort();

describe("addToCollection and removeFromCollection", () => {
  test("a model sits in two collections; a collection cannot contain a collection (no schema path)", async () => {
    const desk = `Desk ${marker()}`;
    const workshop = `Workshop ${marker()}`;
    const { model } = await seedStoredModel(env);
    const other = (await seedStoredModel(env)).model.id;
    const collections = createCollections(env.db);
    const search = createSearch(env.db);

    expect(await collections.addToCollection(model.id, desk)).toBe(true);
    expect(await collections.addToCollection(model.id, workshop)).toBe(true);
    expect(await collections.addToCollection(other, desk)).toBe(true);

    expect(await env.repos.collections.forModel(model.id)).toEqual([desk, workshop]);
    expect(ids(await search.search({ collection: desk }))).toEqual([model.id, other].sort());
    // Collection names match regardless of case, like tags.
    expect(ids(await search.search({ collection: workshop.toLowerCase() }))).toEqual([model.id]);

    // Taking it out of one collection leaves it in the other.
    expect(await collections.removeFromCollection(model.id, desk)).toBe(true);
    expect(await env.repos.collections.forModel(model.id)).toEqual([workshop]);
    expect(ids(await search.search({ collection: desk }))).toEqual([other]);

    // No schema path: the only foreign key that points at collections is
    // collection_models.collection_id, and collection_models holds a model on
    // its other side, never a collection.
    const { rows } = await sql<{ tbl: string; col: string; target: string }>`
      select c.conrelid::regclass::text as tbl, a.attname as col, c.confrelid::regclass::text as target
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
      where c.contype = 'f'
        and (c.confrelid = 'collections'::regclass or c.conrelid = 'collection_models'::regclass)
      order by 1, 2`.execute(env.db);
    expect(rows).toEqual([
      { tbl: "collection_models", col: "collection_id", target: "collections" },
      { tbl: "collection_models", col: "model_id", target: "models" },
    ]);
    // A single-word alias, because the CamelCasePlugin renames result columns.
    const columns = await sql<{ col: string }>`
      select column_name as col from information_schema.columns
      where table_schema = current_schema() and table_name = 'collections'
      order by ordinal_position`.execute(env.db);
    expect(columns.rows.map((r) => r.col)).toEqual(["id", "name"]);

    // And the function has no way to put a collection in a collection: a
    // collection's id is not a model, so nothing is added.
    const workshopRow = await env.db
      .selectFrom("collections")
      .select("id")
      .where(sql<boolean>`lower(name) = lower(${workshop})`)
      .executeTakeFirstOrThrow();
    expect(await collections.addToCollection(workshopRow.id, desk)).toBe(false);
    expect(ids(await search.search({ collection: desk }))).toEqual([other]);
  });

  test("adding twice is one membership, and removing a model that is not in it answers false", async () => {
    const { model } = await seedStoredModel(env);
    const collections = createCollections(env.db);
    const name = `Twice ${marker()}`;
    expect(await collections.addToCollection(model.id, name)).toBe(true);
    expect(await collections.addToCollection(model.id, name)).toBe(true);
    expect(await env.repos.collections.forModel(model.id)).toEqual([name]);
    expect(await collections.removeFromCollection(model.id, `Never ${marker()}`)).toBe(false);
  });

  test("an empty collection name is refused", async () => {
    const { model } = await seedStoredModel(env);
    await expect(createCollections(env.db).addToCollection(model.id, "")).rejects.toThrow(
      RangeError,
    );
  });

  test("an unknown, malformed or trashed model answers false and changes nothing", async () => {
    const collections = createCollections(env.db);
    expect(await collections.addToCollection(uuidv7(), "Ghosts")).toBe(false);
    expect(await collections.addToCollection("bad", "Ghosts")).toBe(false);

    const { model } = await seedStoredModel(env);
    const name = `Kept ${marker()}`;
    await collections.addToCollection(model.id, name);
    await createTrash({ db: env.db, store: env.store }).trashModel(model.id);
    expect(await collections.addToCollection(model.id, `Late ${marker()}`)).toBe(false);
    expect(await collections.removeFromCollection(model.id, name)).toBe(false);
    expect(await env.repos.collections.forModel(model.id)).toEqual([name]);
  });
});

// Issue #312: a collection can be deleted, but is never removed on its own.
describe("deleting a collection", () => {
  test("taking the last model out leaves the collection; a Delete removes it", async () => {
    const name = `Emptied ${marker()}`;
    const { model } = await seedStoredModel(env);
    const collections = createCollections(env.db);
    await collections.addToCollection(model.id, name);
    expect(await collections.removeFromCollection(model.id, name)).toBe(true);
    expect(await labelStored(env.db, "collections", name)).toBe(true);
    expect(await env.repos.collections.delete(name.toUpperCase())).toBe(name);
    expect(await labelStored(env.db, "collections", name)).toBe(false);
    expect(await env.repos.collections.delete(name)).toBeNull();
  });

  test("a model added while a Delete of its collection is uncommitted lands in a new one", async () => {
    const name = `Race shelf ${marker()}`;
    const a = (await seedStoredModel(env)).model.id;
    const b = (await seedStoredModel(env)).model.id;
    await createCollections(env.db).addToCollection(a, name);
    let deleted: () => void = () => {};
    const isDeleted = new Promise<void>((resolve) => {
      deleted = resolve;
    });
    let commit: () => void = () => {};
    const committed = new Promise<void>((resolve) => {
      commit = resolve;
    });
    const deleting = env.db.transaction().execute(async (trx) => {
      expect(await collectionsRepo(trx).delete(name)).toBe(name);
      deleted();
      await committed;
    });
    await isDeleted;
    const adding = createCollections(env.db).addToCollection(b, name);
    await sleep(300);
    commit();
    await deleting;
    expect(await adding).toBe(true);
    expect(await env.repos.collections.forModel(b)).toEqual([name]);
    expect(await env.repos.collections.forModel(a)).toEqual([]);
  });
});
