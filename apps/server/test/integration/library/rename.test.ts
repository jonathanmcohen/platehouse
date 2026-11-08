// Build plan Task 14, AC-060: a rename changes the display name only; the
// object in the bucket keeps its key and its bytes.
import { buffer } from "node:stream/consumers";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { uuidv7 } from "../../../src/db/ids.js";
import { createRename } from "../../../src/library/rename.js";
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

describe("renameModel", () => {
  test("rename changes the display name and keeps the bucket key", async () => {
    const { model, source, thumbnail, bytes } = await seedStoredModel(env);
    const before = await env.store.listPrefix(`models/${model.id}/`);
    const newName = `Renamed model ${marker()}`;

    expect(await createRename(env.db).renameModel(model.id, newName)).toBe(true);

    expect((await env.repos.models.get(model.id))?.name).toBe(newName);
    expect((await env.repos.blobs.get(source.id))?.key).toBe(source.key);
    expect((await env.repos.blobs.get(thumbnail.id))?.key).toBe(thumbnail.key);
    expect(await env.store.listPrefix(`models/${model.id}/`)).toEqual(before);
    expect(await buffer(await env.store.getBlobStream(source.key))).toEqual(bytes);
  });

  test("search finds a renamed model by its new name and not its old one", async () => {
    const old = `Old name ${marker()}`;
    const { model } = await seedStoredModel(env, { name: old });
    const fresh = `New name ${marker()}`;
    await createRename(env.db).renameModel(model.id, fresh);

    const search = createSearch(env.db);
    expect((await search.search({ q: fresh })).models.map((m) => m.id)).toEqual([model.id]);
    expect((await search.search({ q: old })).models).toEqual([]);
  });

  test("the new name is trimmed, and an empty name is refused without a change", async () => {
    const { model } = await seedStoredModel(env);
    const rename = createRename(env.db);
    const name = `Trimmed ${marker()}`;
    expect(await rename.renameModel(model.id, `  ${name}  `)).toBe(true);
    expect((await env.repos.models.get(model.id))?.name).toBe(name);

    await expect(rename.renameModel(model.id, "   ")).rejects.toThrow(RangeError);
    expect((await env.repos.models.get(model.id))?.name).toBe(name);
  });

  test("renaming an unknown, malformed or trashed model answers false", async () => {
    const rename = createRename(env.db);
    expect(await rename.renameModel(uuidv7(), "Nobody")).toBe(false);
    expect(await rename.renameModel("not-a-uuid", "Nobody")).toBe(false);

    const { model } = await seedStoredModel(env);
    await createTrash({ db: env.db, store: env.store }).trashModel(model.id);
    expect(await rename.renameModel(model.id, "Hidden")).toBe(false);
    expect((await env.repos.models.get(model.id, { includeTrashed: true }))?.name).toBe(model.name);
  });
});

describe("renameFile", () => {
  test("rename changes the file's display name and keeps the bucket key", async () => {
    const { model, file, source, bytes } = await seedStoredModel(env);
    const before = await env.store.listPrefix(`models/${model.id}/`);

    expect(await createRename(env.db).renameFile(file.id, "Lid, final v2.3mf")).toBe(true);

    const after = await env.repos.files.get(file.id);
    expect(after?.name).toBe("Lid, final v2.3mf");
    expect(after?.originalName).toBe(file.originalName);
    expect(after?.blobId).toBe(source.id);
    expect((await env.repos.blobs.get(source.id))?.key).toBe(source.key);
    expect(await env.store.listPrefix(`models/${model.id}/`)).toEqual(before);
    expect(await buffer(await env.store.getBlobStream(source.key))).toEqual(bytes);
  });

  test("an empty file name is refused without a change", async () => {
    const { file } = await seedStoredModel(env);
    await expect(createRename(env.db).renameFile(file.id, "")).rejects.toThrow(RangeError);
    expect((await env.repos.files.get(file.id))?.name).toBe(file.name);
  });

  test("renaming an unknown file, or a file of a trashed model, answers false", async () => {
    const rename = createRename(env.db);
    expect(await rename.renameFile(uuidv7(), "x.3mf")).toBe(false);
    expect(await rename.renameFile("nope", "x.3mf")).toBe(false);

    const { model, file } = await seedStoredModel(env);
    await createTrash({ db: env.db, store: env.store }).trashModel(model.id);
    expect(await rename.renameFile(file.id, "hidden.3mf")).toBe(false);
    expect((await env.repos.files.get(file.id))?.name).toBe(file.name);
  });
});
