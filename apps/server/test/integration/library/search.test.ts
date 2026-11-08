// Build plan Task 14, AC-064: search over name, caption, creator and tag,
// ranked by pg_trgm similarity, with tag, collection and creator filters and
// a cursor for the next page.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createCollections } from "../../../src/library/collections.js";
import { createSearch, InvalidCursor } from "../../../src/library/search.js";
import { createTags } from "../../../src/library/tags.js";
import { type LibraryEnv, marker, startLibraryEnv } from "../support/library.js";

let env: LibraryEnv;

beforeAll(async () => {
  env = await startLibraryEnv();
});

afterAll(async () => {
  await env?.stop();
});

const ids = (page: { models: Array<{ id: string }> }) => page.models.map((m) => m.id);

describe("search", () => {
  test("search hits name, caption, creator and tag", async () => {
    const word = marker();
    const byName = (await env.repos.models.create({ name: `Benchy ${word}` })).id;
    const byCaption = (await env.repos.models.create({ name: "Cube", caption: `Fits ${word}` })).id;
    const byCreator = (await env.repos.models.create({ name: "Clip", creator: `Maker ${word}` }))
      .id;
    const byTag = (await env.repos.models.create({ name: "Bin" })).id;
    await createTags(env.db).addTag(byTag, `Grid ${word}`);
    const miss = (await env.repos.models.create({ name: `Unrelated ${marker()}` })).id;
    const search = createSearch(env.db);

    const all = ids(await search.search({ q: word }));
    expect([...all].sort()).toEqual([byName, byCaption, byCreator, byTag].sort());
    expect(all).not.toContain(miss);

    // Each field alone, ignoring case.
    expect(ids(await search.search({ q: `BENCHY ${word}` }))).toEqual([byName]);
    expect(ids(await search.search({ q: `fits ${word}` }))).toEqual([byCaption]);
    expect(ids(await search.search({ q: `maker ${word}` }))).toEqual([byCreator]);
    expect(ids(await search.search({ q: `gRiD ${word}` }))).toEqual([byTag]);
  });

  test("results rank by trigram similarity, a close tag match included", async () => {
    const word = marker();
    // q matches the tag exactly, and is only a small part of the other name.
    const q = `Hexagon ${word}`;
    const longName = (
      await env.repos.models.create({
        name: `A very long model name that happens to mention ${q} somewhere in the middle of it`,
      })
    ).id;
    const exactTag = (await env.repos.models.create({ name: "Holder" })).id;
    await createTags(env.db).addTag(exactTag, q);
    const exactName = (await env.repos.models.create({ name: q })).id;

    const order = ids(await createSearch(env.db).search({ q }));
    expect(order).toHaveLength(3);
    expect(order[2]).toBe(longName);
    expect(order.slice(0, 2).sort()).toEqual([exactName, exactTag].sort());
  });

  test("filter by creator, and by tag and collection together", async () => {
    const word = marker();
    const creator = `Studio ${word}`;
    const tag = `Wall ${word}`;
    const collection = `Garage ${word}`;
    const a = (await env.repos.models.create({ name: `Hook ${word}`, creator })).id;
    const b = (await env.repos.models.create({ name: `Rack ${word}`, creator })).id;
    const c = (await env.repos.models.create({ name: `Shelf ${word}` })).id;
    const tags = createTags(env.db);
    const collections = createCollections(env.db);
    await tags.addTag(a, tag);
    await tags.addTag(c, tag);
    await collections.addToCollection(a, collection);
    await collections.addToCollection(b, collection);
    const search = createSearch(env.db);

    expect([...ids(await search.search({ creator }))].sort()).toEqual([a, b].sort());
    expect(ids(await search.search({ creator: `Nobody ${word}` }))).toEqual([]);
    expect(ids(await search.search({ tag, collection }))).toEqual([a]);
    expect(ids(await search.search({ creator, tag }))).toEqual([a]);
    expect(ids(await search.search({ q: `Rack ${word}`, collection }))).toEqual([b]);
  });

  test("an empty query lists the live library in name order", async () => {
    const word = marker();
    const z = (await env.repos.models.create({ name: `zz last ${word}` })).id;
    const a = (await env.repos.models.create({ name: `aa first ${word}` })).id;
    const tag = `Order ${word}`;
    await createTags(env.db).addTag(z, tag);
    await createTags(env.db).addTag(a, tag);
    expect(ids(await createSearch(env.db).search({ tag }))).toEqual([a, z]);
    expect(ids(await createSearch(env.db).search({ q: "  ", tag }))).toEqual([a, z]);
  });

  test("the cursor walks every page once, and the last page has no cursor", async () => {
    const word = marker();
    const made: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      made.push((await env.repos.models.create({ name: `Paged ${i} ${word}` })).id);
    }
    // Two with the same name, so the order has to fall back to the id.
    made.push((await env.repos.models.create({ name: `Paged 2 ${word}` })).id);
    const search = createSearch(env.db);

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await search.search({ q: word, limit: 2, cursor });
      expect(page.models.length).toBeLessThanOrEqual(2);
      seen.push(...ids(page));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor !== undefined && pages < 10);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(6);
    expect([...seen].sort()).toEqual([...made].sort());
    // The pages together are the same order as one big page.
    expect(seen).toEqual(ids(await search.search({ q: word, limit: 50 })));
    expect((await search.search({ q: word, limit: 50 })).nextCursor).toBeNull();
  });

  test("limit is held between 1 and 200, 50 by default", async () => {
    const word = marker();
    for (let i = 0; i < 3; i += 1) await env.repos.models.create({ name: `Limit ${i} ${word}` });
    const search = createSearch(env.db);
    expect((await search.search({ q: word, limit: 0 })).models).toHaveLength(1);
    expect((await search.search({ q: word, limit: -5 })).models).toHaveLength(1);
    expect((await search.search({ q: word, limit: 1000 })).models).toHaveLength(3);
    expect((await search.search({ q: word })).models).toHaveLength(3);
  });

  test("a cursor that was not made by search is refused", async () => {
    const search = createSearch(env.db);
    for (const cursor of ["", "not-a-cursor", Buffer.from("[1,2,3]").toString("base64url")]) {
      await expect(search.search({ q: "x", cursor })).rejects.toBeInstanceOf(InvalidCursor);
    }
  });
});
