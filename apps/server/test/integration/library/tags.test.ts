// Build plan Task 14, AC-061: tags on a model, and the library filtered by tag.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { uuidv7 } from "../../../src/db/ids.js";
import { createSearch } from "../../../src/library/search.js";
import { createTags } from "../../../src/library/tags.js";
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

describe("addTag and removeTag", () => {
  test("filter by tag", async () => {
    const tag = `Gridfinity ${marker()}`;
    const a = (await seedStoredModel(env)).model.id;
    const b = (await seedStoredModel(env)).model.id;
    const untagged = (await seedStoredModel(env)).model.id;
    const tags = createTags(env.db);
    const search = createSearch(env.db);

    expect(await tags.addTag(a, tag)).toBe(true);
    // Tags are one tag regardless of case.
    expect(await tags.addTag(b, tag.toLowerCase())).toBe(true);

    const filtered = await search.search({ tag: tag.toUpperCase() });
    expect(ids(filtered)).toEqual([a, b].sort());
    expect(ids(filtered)).not.toContain(untagged);

    expect(await tags.removeTag(a, tag)).toBe(true);
    expect(ids(await search.search({ tag }))).toEqual([b]);
    expect(await env.repos.tags.forModel(a)).toEqual([]);
  });

  test("a tag filter combines with the search text", async () => {
    const tag = `Desk ${marker()}`;
    const word = marker();
    const hit = (await seedStoredModel(env, { name: `Hook ${word}` })).model.id;
    const otherName = (await seedStoredModel(env)).model.id;
    const notTagged = (await seedStoredModel(env, { name: `Hook ${word} too` })).model.id;
    const tags = createTags(env.db);
    await tags.addTag(hit, tag);
    await tags.addTag(otherName, tag);

    const page = await createSearch(env.db).search({ q: word, tag });
    expect(ids(page)).toEqual([hit]);
    expect(ids(page)).not.toContain(notTagged);
  });

  test("tagging twice is one tag, and removing a tag the model lacks answers false", async () => {
    const { model } = await seedStoredModel(env);
    const tags = createTags(env.db);
    const tag = `Twice ${marker()}`;
    expect(await tags.addTag(model.id, tag)).toBe(true);
    expect(await tags.addTag(model.id, tag)).toBe(true);
    expect(await env.repos.tags.forModel(model.id)).toEqual([tag]);
    expect(await tags.removeTag(model.id, `Never added ${marker()}`)).toBe(false);
  });

  test("an empty tag is refused", async () => {
    const { model } = await seedStoredModel(env);
    await expect(createTags(env.db).addTag(model.id, "  ")).rejects.toThrow(RangeError);
  });

  test("tagging an unknown, malformed or trashed model answers false and tags nothing", async () => {
    const tags = createTags(env.db);
    expect(await tags.addTag(uuidv7(), "Ghost")).toBe(false);
    expect(await tags.addTag("not-a-uuid", "Ghost")).toBe(false);

    const { model } = await seedStoredModel(env);
    const tag = `Kept ${marker()}`;
    await tags.addTag(model.id, tag);
    await createTrash({ db: env.db, store: env.store }).trashModel(model.id);
    expect(await tags.addTag(model.id, `Late ${marker()}`)).toBe(false);
    expect(await tags.removeTag(model.id, tag)).toBe(false);
    expect(await env.repos.tags.forModel(model.id)).toEqual([tag]);
  });
});
