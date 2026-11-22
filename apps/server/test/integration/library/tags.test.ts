// Tags on a model, and the library filtered by tag.
import { setTimeout as sleep } from "node:timers/promises";
import { type KyselyPlugin, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { uuidv7 } from "../../../src/db/ids.js";
import { createSearch } from "../../../src/library/search.js";
import { createTags } from "../../../src/library/tags.js";
import { createTrash } from "../../../src/library/trash.js";
import { ensureLabels } from "../../../src/repos/labels.js";
import { tagsRepo } from "../../../src/repos/tags.js";
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

/** A gate a test opens: wait() resolves once open() is called. */
function gate() {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, wait: () => opened };
}

/** Whether p has settled after a short wait. */
async function settledSoon(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  void p.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  await sleep(300);
  return done;
}

// Issue #312: the app removes a tag its last model loses, and the public
// API's untag does not (the API never deletes anything).
describe("unused tags", () => {
  test("the API's removeTag keeps the tag; the app's removes it once no model has it", async () => {
    const tag = `Unused ${marker()}`;
    const { model } = await seedStoredModel(env);
    await createTags(env.db).addTag(model.id, tag);
    expect(await createTags(env.db).removeTag(model.id, tag)).toBe(true);
    expect(await labelStored(env.db, "tags", tag)).toBe(true);

    await createTags(env.db).addTag(model.id, tag);
    const app = createTags(env.db, { dropUnusedTags: true });
    expect(await app.removeTag(model.id, tag)).toBe(true);
    expect(await labelStored(env.db, "tags", tag)).toBe(false);
    expect(await app.removeTag(model.id, tag)).toBe(false);
  });

  test("a tag being added to another model while its last model loses it is kept", async () => {
    const tag = `Race keep ${marker()}`;
    const a = (await seedStoredModel(env)).model.id;
    const b = (await seedStoredModel(env)).model.id;
    await createTags(env.db).addTag(a, tag);
    const added = gate();
    const commit = gate();
    // Tags b and holds its transaction open, as a slow request would.
    const adding = env.db.transaction().execute(async (trx) => {
      await tagsRepo(trx).add(b, tag);
      added.open();
      await commit.wait();
    });
    await added.wait();
    const removing = createTags(env.db, { dropUnusedTags: true }).removeTag(a, tag);
    // The removal waits for the add to commit, so it sees b's link.
    expect(await settledSoon(removing)).toBe(false);
    commit.open();
    await adding;
    expect(await removing).toBe(true);
    expect(await labelStored(env.db, "tags", tag)).toBe(true);
    expect(await env.repos.tags.forModel(b)).toEqual([tag]);
    expect(await env.repos.tags.forModel(a)).toEqual([]);
  });

  test("a tag added while a removal of it is still uncommitted is made again", async () => {
    const tag = `Race remake ${marker()}`;
    const a = (await seedStoredModel(env)).model.id;
    const b = (await seedStoredModel(env)).model.id;
    await createTags(env.db).addTag(a, tag);
    const removed = gate();
    const commit = gate();
    const removing = env.db.transaction().execute(async (trx) => {
      expect(await tagsRepo(trx).remove(a, tag, { dropUnused: true })).toBe(true);
      removed.open();
      await commit.wait();
    });
    await removed.wait();
    const adding = createTags(env.db).addTag(b, tag);
    expect(await settledSoon(adding)).toBe(false);
    commit.open();
    await removing;
    expect(await adding).toBe(true);
    expect(await env.repos.tags.forModel(b)).toEqual([tag]);
    expect(await labelStored(env.db, "tags", tag)).toBe(true);
  });

  test("a tag Delete waits for a tagging in flight, then takes the tag off that model too", async () => {
    const tag = `Race delete ${marker()}`;
    const a = (await seedStoredModel(env)).model.id;
    const b = (await seedStoredModel(env)).model.id;
    await createTags(env.db).addTag(a, tag);
    const added = gate();
    const commit = gate();
    const adding = env.db.transaction().execute(async (trx) => {
      await tagsRepo(trx).add(b, tag);
      added.open();
      await commit.wait();
    });
    await added.wait();
    const deleting = env.repos.tags.delete(tag);
    expect(await settledSoon(deleting)).toBe(false);
    commit.open();
    await adding;
    expect(await deleting).toBe(tag);
    expect(await env.repos.tags.forModel(a)).toEqual([]);
    expect(await env.repos.tags.forModel(b)).toEqual([]);
    expect(await labelStored(env.db, "tags", tag)).toBe(false);
  });
});

/**
 * A plugin that runs a hook once after the first query of a kind returns,
 * before the caller sees the result, so a test can act between two
 * statements of one function: "insert" for an insert into tags, "lock" for
 * a raw statement that takes a key share lock.
 */
function afterFirst(hooks: { insert?: () => Promise<void>; lock?: () => Promise<void> }) {
  const kinds = new WeakMap<object, "insert" | "lock">();
  const fired = new Set<string>();
  const plugin: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      if (node.kind === "InsertQueryNode") kinds.set(queryId, "insert");
      if (node.kind === "RawNode" && node.sqlFragments.join(" ").includes("for key share")) {
        kinds.set(queryId, "lock");
      }
      return node;
    },
    async transformResult({ queryId, result }) {
      const kind = kinds.get(queryId);
      if (kind !== undefined && !fired.has(kind)) {
        fired.add(kind);
        await hooks[kind]?.();
      }
      return result;
    },
  };
  return plugin;
}

describe("ensureLabels", () => {
  // PR #367 review: a tag deleted while the lock waits on it, then made again
  // by a third request before the next statement, must not leave the name
  // out of the ids, or the caller links nothing (bulk Add tags) or fails.
  test("a name deleted while its lock waits, then made again, is still in the ids", async () => {
    const tag = `Race three ${marker()}`;
    const a = (await seedStoredModel(env)).model.id;
    const c = (await seedStoredModel(env)).model.id;
    await createTags(env.db).addTag(a, tag);
    const inserted = gate();
    const deleted = gate();
    const commitDelete = gate();
    let remade: string | undefined;
    const plugin = afterFirst({
      // After the insert, which found the tag and made nothing, a Delete
      // removes the tag and holds its transaction open.
      insert: async () => {
        inserted.open();
        await deleted.wait();
      },
      // The lock skipped the deleted row. Before ensureLabels goes on,
      // another request tags c, making the tag again, and commits.
      lock: async () => {
        await createTags(env.db).addTag(c, tag);
        const row = await env.db
          .selectFrom("tags")
          .select("id")
          .where(sql<boolean>`lower(name) = lower(${tag})`)
          .executeTakeFirstOrThrow();
        remade = row.id;
      },
    });
    const linking = env.db
      .transaction()
      .execute((trx) => ensureLabels(trx.withPlugin(plugin), "tags", [tag]));
    let deleting: Promise<unknown> = Promise.resolve();
    try {
      await inserted.wait();
      deleting = env.db.transaction().execute(async (trx) => {
        await trx.deleteFrom("tags").where(sql<boolean>`lower(name) = lower(${tag})`).execute();
        deleted.open();
        await commitDelete.wait();
      });
      const deadline = Date.now() + 10_000;
      for (;;) {
        const { rows } = await sql<{ waiting: number }>`
          select count(*)::int as waiting from pg_stat_activity
           where wait_event_type = 'Lock' and query ilike '%for key share%'
             and query not ilike '%pg_stat_activity%'
        `.execute(env.db);
        if ((rows[0]?.waiting ?? 0) > 0) break;
        if (Date.now() > deadline) throw new Error("ensureLabels never waited on the deleted tag");
        await sleep(20);
      }
      commitDelete.open();
      await deleting;
      const ids = await linking;
      expect(remade).toBeDefined();
      expect(ids).toEqual([remade]);
      expect(await env.repos.tags.forModel(c)).toEqual([tag]);
    } finally {
      deleted.open();
      commitDelete.open();
      await deleting.catch(() => {});
      await linking.catch(() => undefined);
    }
  });
});
