// Build plan Task 14, AC-062: a model can sit in more than one collection, and
// collections are flat (Q17).
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { uuidv7 } from "../../../src/db/ids.js";
import { createCollections } from "../../../src/library/collections.js";
import { createSearch } from "../../../src/library/search.js";
import { createTrash } from "../../../src/library/trash.js";
import { type LibraryEnv, marker, seedStoredModel, startLibraryEnv } from "../support/library.js";

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
    const columns = await sql<{ column_name: string }>`
      select column_name from information_schema.columns
      where table_schema = current_schema() and table_name = 'collections'
      order by ordinal_position`.execute(env.db);
    expect(columns.rows.map((r) => r.column_name)).toEqual(["id", "name"]);

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
