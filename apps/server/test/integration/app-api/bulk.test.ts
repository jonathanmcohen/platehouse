// The library's bulk actions (Jon, 2026-11-19) against Postgres 17 and the
// S3 test server: add tags, remove a tag, add to a collection and move to
// the trash, each for many models in one request and one transaction. Each
// is tried with live, trashed, missing and malformed ids: the live ones
// change, the others are reported with their reason and left alone, and the
// answer says what changed and what was left as it was. Trash is the soft
// delete: the model, its files, blobs, tags and collections stay, and it can
// be restored. The routes are the real ones (registerOrganiseApi); the
// session gate in front of them is tested with every /app/api route in
// settings.test.ts. Every model and byte is synthetic.
import Fastify, { type FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { registerOrganiseApi } from "../../../src/app-api/organise.js";
import { uuidv7 } from "../../../src/db/ids.js";
import { createCollections } from "../../../src/library/collections.js";
import { createTags } from "../../../src/library/tags.js";
import { createTrash } from "../../../src/library/trash.js";
import { type BulkResult, bulkRepo, MAX_BULK_IDS } from "../../../src/repos/bulk.js";
import {
  type LibraryEnv,
  marker,
  rowCounts,
  seedStoredModel,
  startLibraryEnv,
} from "../support/library.js";

const MISSING = "0198f0c4-0000-7000-8000-0000000000ff";

let env: LibraryEnv;
let app: FastifyInstance;

async function post<T = BulkResult>(
  url: string,
  body: unknown,
): Promise<{ status: number; body: T }> {
  const res = await app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", accept: "application/json" },
    payload: JSON.stringify(body),
  });
  return { status: res.statusCode, body: res.json() as T };
}

/** Three live models, one trashed, with the trashed one's id. */
async function selection() {
  const word = marker();
  const live = [];
  for (let i = 0; i < 3; i += 1)
    live.push((await seedStoredModel(env, { name: `Bulk ${i} ${word}` })).model.id);
  const trashed = (await seedStoredModel(env, { name: `Bulk trashed ${word}` })).model.id;
  expect(await env.repos.models.trash(trashed)).toBe(true);
  return { word, live: live as [string, string, string], trashed };
}

async function tagsOf(id: string) {
  return env.repos.tags.forModel(id);
}

beforeAll(async () => {
  env = await startLibraryEnv();
  app = Fastify({ logger: false });
  await registerOrganiseApi(app, {
    db: env.db,
    trash: createTrash({ db: env.db, store: env.store }),
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await env?.stop();
});

describe("add tags", () => {
  test("adds every tag to every live model, keeps their tags, and reports the trashed and missing ones", async () => {
    const { live, trashed } = await selection();
    const [a, b, c] = live;
    await createTags(env.db).addTag(a, "Old");
    await createTags(env.db).addTag(b, "PLA");
    const res = await post("/app/api/bulk/add-tags", {
      ids: [a, b, c, trashed, MISSING, "not-an-id"],
      tags: ["PLA", "Desk"],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      changed: [a, b, c],
      unchanged: [],
      failed: [
        { id: trashed, reason: "in_trash" },
        { id: MISSING, reason: "not_found" },
        { id: "not-an-id", reason: "not_found" },
      ],
      tags: ["PLA", "Desk"],
    });
    expect(await tagsOf(a)).toEqual(["Desk", "Old", "PLA"]);
    expect(await tagsOf(b)).toEqual(["Desk", "PLA"]);
    expect(await tagsOf(c)).toEqual(["Desk", "PLA"]);
    expect(await tagsOf(trashed)).toEqual([]);
  });

  test("a model that already has every tag is unchanged, and the stored capitals are kept", async () => {
    const { live } = await selection();
    const [a, b] = live;
    const tag = `Shelf ${marker()}`;
    await createTags(env.db).addTag(a, tag);
    const res = await post("/app/api/bulk/add-tags", { ids: [a, b], tags: [tag.toUpperCase()] });
    expect(res.body).toMatchObject({ changed: [b], unchanged: [a], failed: [], tags: [tag] });
    expect(await tagsOf(b)).toEqual([tag]);
  });

  // Tags are matched with Postgres's lower() on both sides, the unique
  // index's rule, never JavaScript's toLowerCase (PR #246 review). A word
  // ending in a capital sigma is where they part: JavaScript lowers it to a
  // final sigma (\u03c2), Postgres to a medial one (\u03c3), so a match made
  // with the JavaScript form found no tag and every model was "unchanged".
  test("a tag ending in a capital sigma is added and named as stored", async () => {
    const { live } = await selection();
    const [a, b] = live;
    const tag = `Bulk ${marker()} \u0391\u03a3`;
    expect(tag.toLowerCase().endsWith("\u03c2")).toBe(true);
    const res = await post("/app/api/bulk/add-tags", { ids: [a, b], tags: [tag] });
    expect(res.body).toMatchObject({ changed: [a, b], unchanged: [], failed: [], tags: [tag] });
    expect(await tagsOf(a)).toEqual([tag]);
    expect(await tagsOf(b)).toEqual([tag]);
  });

  test("the same id twice, in any case, counts once", async () => {
    const { live } = await selection();
    const [a] = live;
    const res = await post("/app/api/bulk/add-tags", { ids: [a, a.toUpperCase()], tags: ["Once"] });
    expect(res.body).toMatchObject({ changed: [a], unchanged: [], failed: [] });
  });

  // Two requests making the same new tags, listed in opposite orders, must
  // not deadlock (PR #246 review). A new tag's insert waits on another
  // transaction's uncommitted row with the same lower(name), so the tags are
  // made in lower(name) order. Here a transaction makes the first tag by that
  // order and holds it; Add tags, asked for both in reverse, waits on it; then
  // the holder makes the second tag and commits. Made in the request's order,
  // Add tags would already hold the second tag and the two would deadlock.
  test("two requests making the same new tags in opposite orders do not deadlock", async () => {
    const { live } = await selection();
    const [a] = live;
    const word = marker();
    const first = `Alpha ${word}`;
    const second = `Beta ${word}`;
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let made: () => void = () => {};
    const firstMade = new Promise<void>((resolve) => {
      made = resolve;
    });
    const holder = env.db.transaction().execute(async (trx) => {
      const insert = (name: string) =>
        trx
          .insertInto("tags")
          .values({ id: uuidv7(), name })
          .onConflict((oc) => oc.expression(sql`lower(name)`).doNothing())
          .execute();
      await insert(first);
      made();
      await released;
      await insert(second);
    });
    await firstMade;
    const adding = bulkRepo(env.db).addTags([a], [second, first]);
    try {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const { rows } = await sql<{ waiting: number }>`
          select count(*)::int as waiting from pg_stat_activity
           where wait_event_type = 'Lock' and query ilike 'insert into "tags"%'
        `.execute(env.db);
        if ((rows[0]?.waiting ?? 0) > 0) break;
        if (Date.now() > deadline) throw new Error("Add tags never waited on the held tag");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      release();
      await holder;
      expect(await adding).toMatchObject({ changed: [a], tags: [second, first] });
      expect(await tagsOf(a)).toEqual([first, second]);
    } finally {
      release();
      await holder.catch(() => {});
      await adding.catch(() => undefined);
    }
  });
});

describe("remove a tag", () => {
  test("takes it off the live models that have it; the tag itself stays", async () => {
    const { live, trashed } = await selection();
    const [a, b, c] = live;
    const tag = `Gone ${marker()}`;
    for (const id of [a, b, trashed]) {
      if (id === trashed) {
        // Tagged before it was trashed: restore it, tag it, trash it again.
        await env.repos.models.restore(id);
        await createTags(env.db).addTag(id, tag);
        await env.repos.models.trash(id);
      } else {
        await createTags(env.db).addTag(id, tag);
      }
    }
    await createTags(env.db).addTag(b, "Keep");
    const res = await post("/app/api/bulk/remove-tag", {
      ids: [a, b, c, trashed, MISSING],
      tag: tag.toLowerCase(),
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      changed: [a, b],
      unchanged: [c],
      failed: [
        { id: trashed, reason: "in_trash" },
        { id: MISSING, reason: "not_found" },
      ],
      tag,
    });
    expect(await tagsOf(a)).toEqual([]);
    expect(await tagsOf(b)).toEqual(["Keep"]);
    // The trashed model keeps its tag, so a restore brings it back with it.
    expect(await tagsOf(trashed)).toEqual([tag]);
    const kept = await env.db
      .selectFrom("tags")
      .select("name")
      .where("name", "=", tag)
      .executeTakeFirst();
    expect(kept?.name).toBe(tag);
  });

  test("a tag ending in a capital sigma is taken off and named as stored", async () => {
    const { live } = await selection();
    const [a, b] = live;
    const tag = `Gone ${marker()} \u0391\u03a3`;
    await createTags(env.db).addTag(a, tag);
    const res = await post("/app/api/bulk/remove-tag", { ids: [a, b], tag });
    expect(res.body).toEqual({ changed: [a], unchanged: [b], failed: [], tag });
    expect(await tagsOf(a)).toEqual([]);
  });

  test("a tag no model has: every live model unchanged, and no stored name", async () => {
    const { live } = await selection();
    const res = await post("/app/api/bulk/remove-tag", { ids: live, tag: `Never ${marker()}` });
    expect(res.body).toEqual({ changed: [], unchanged: live, failed: [], tag: null });
  });
});

describe("add to a collection", () => {
  test("a new collection is made; live models go in, trashed and missing ones are reported", async () => {
    const { live, trashed } = await selection();
    const [a, b, c] = live;
    const name = `New shelf ${marker()}`;
    const res = await post("/app/api/bulk/add-to-collection", {
      ids: [a, b, c, trashed, MISSING],
      collection: name,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      changed: [a, b, c],
      unchanged: [],
      failed: [
        { id: trashed, reason: "in_trash" },
        { id: MISSING, reason: "not_found" },
      ],
      collection: name,
    });
    for (const id of live) expect(await env.repos.collections.forModel(id)).toEqual([name]);
    expect(await env.repos.collections.forModel(trashed)).toEqual([]);
  });

  test("an existing collection, named in other capitals: models already in it are unchanged", async () => {
    const { live } = await selection();
    const [a, b] = live;
    const name = `Existing shelf ${marker()}`;
    await createCollections(env.db).addToCollection(a, name);
    const res = await post("/app/api/bulk/add-to-collection", {
      ids: [a, b],
      collection: name.toLowerCase(),
    });
    expect(res.body).toMatchObject({ changed: [b], unchanged: [a], collection: name });
  });

  test("an existing collection ending in a capital sigma, named in other capitals, is named as stored", async () => {
    const { live } = await selection();
    const [a, b] = live;
    const name = `Shelf ${marker()} \u0391\u03a3`;
    await createCollections(env.db).addToCollection(a, name);
    const res = await post("/app/api/bulk/add-to-collection", {
      ids: [a, b],
      collection: name.toUpperCase(),
    });
    expect(res.body).toMatchObject({ changed: [b], unchanged: [a], collection: name });
  });
});

describe("move to the trash", () => {
  test("trashes the live models only; the trashed and missing ones are reported", async () => {
    const { live, trashed } = await selection();
    const [a, b, c] = live;
    const res = await post("/app/api/bulk/trash", { ids: [a, b, trashed, MISSING] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      changed: [a, b],
      unchanged: [],
      failed: [
        { id: trashed, reason: "in_trash" },
        { id: MISSING, reason: "not_found" },
      ],
    });
    expect(await env.repos.models.get(a)).toBeUndefined();
    expect(await env.repos.models.get(b)).toBeUndefined();
    expect((await env.repos.models.get(c))?.id).toBe(c);
  });

  test("is the soft delete: nothing is removed, and each can be restored", async () => {
    const { live } = await selection();
    const [a] = live;
    await createTags(env.db).addTag(a, "Stays");
    const before = await rowCounts(env.db, a);
    await post("/app/api/bulk/trash", { ids: [a] });
    const trashedRow = await env.repos.models.get(a, { includeTrashed: true });
    expect(trashedRow?.trashedAt).toBeInstanceOf(Date);
    expect(await rowCounts(env.db, a)).toEqual(before);
    expect(await env.repos.models.restore(a)).toBe(true);
    expect(await tagsOf(a)).toEqual(["Stays"]);
  });
});

describe("the cap", () => {
  test("1000 ids in one request are answered; the live ones change and the rest are reported", async () => {
    const { live } = await selection();
    const filler = Array.from(
      { length: MAX_BULK_IDS - live.length },
      (_, i) => `0198f0c4-0000-7000-9000-${String(i).padStart(12, "0")}`,
    );
    const res = await post("/app/api/bulk/add-tags", { ids: [...live, ...filler], tags: ["Many"] });
    expect(res.status).toBe(200);
    expect(res.body.changed).toEqual(live);
    expect(res.body.failed).toHaveLength(filler.length);
    expect(res.body.failed.every((f) => f.reason === "not_found")).toBe(true);
  });

  test("1001 ids are refused and nothing changes", async () => {
    const { live } = await selection();
    const filler = Array.from(
      { length: MAX_BULK_IDS + 1 - live.length },
      (_, i) => `0198f0c4-0000-7000-9000-${String(i).padStart(12, "0")}`,
    );
    const tag = `Refused ${marker()}`;
    const res = await post<{ error: string }>("/app/api/bulk/add-tags", {
      ids: [...live, ...filler],
      tags: [tag],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad_request");
    for (const id of live) expect(await tagsOf(id)).toEqual([]);
  });
});

describe("two bulk requests at once, with the models in opposite orders (issue #286)", () => {
  // Each round runs two actions on the same two models at the same time, one
  // listing them a then b and the other b then a, on two pool connections.
  // Links are written in (model id, tag id) order whatever the request's
  // order, and a deadlock or serialization failure is retried, so neither
  // request fails. Ten rounds, so the two meet mid-statement in some.
  const ROUNDS = 10;

  test("Add tags: both succeed every round and both models get every tag", async () => {
    const repo = bulkRepo(env.db);
    for (let round = 0; round < ROUNDS; round += 1) {
      const { live } = await selection();
      const [a, b] = live;
      const tags = [`Race ${round} one ${marker()}`, `Race ${round} two ${marker()}`];
      const answers = await Promise.allSettled([
        repo.addTags([a, b], tags),
        repo.addTags([b, a], [...tags].reverse()),
      ]);
      expect(
        answers.map((x) => x.status),
        `round ${round}`,
      ).toEqual(["fulfilled", "fulfilled"]);
      const changed = answers.flatMap((x) => (x.status === "fulfilled" ? x.value.changed : []));
      expect(new Set(changed), `round ${round}`).toEqual(new Set([a, b]));
      for (const id of [a, b]) {
        expect((await tagsOf(id)).sort(), `round ${round}`).toEqual([...tags].sort());
      }
    }
  });

  test("Add to collection: both succeed every round and both models are in it", async () => {
    const repo = bulkRepo(env.db);
    for (let round = 0; round < ROUNDS; round += 1) {
      const { live } = await selection();
      const [a, b] = live;
      const name = `Race shelf ${round} ${marker()}`;
      const answers = await Promise.allSettled([
        repo.addToCollection([a, b], name),
        repo.addToCollection([b, a], name),
      ]);
      expect(
        answers.map((x) => x.status),
        `round ${round}`,
      ).toEqual(["fulfilled", "fulfilled"]);
      for (const id of [a, b]) {
        expect(await env.repos.collections.forModel(id), `round ${round}`).toEqual([name]);
      }
    }
  });

  test("Remove tag: both succeed and the tag is off both models", async () => {
    const repo = bulkRepo(env.db);
    for (let round = 0; round < ROUNDS; round += 1) {
      const { live } = await selection();
      const [a, b] = live;
      const tag = `Race off ${round} ${marker()}`;
      await repo.addTags([a, b], [tag]);
      const answers = await Promise.allSettled([
        repo.removeTag([a, b], tag),
        repo.removeTag([b, a], tag),
      ]);
      expect(
        answers.map((x) => x.status),
        `round ${round}`,
      ).toEqual(["fulfilled", "fulfilled"]);
      for (const id of [a, b]) expect(await tagsOf(id), `round ${round}`).toEqual([]);
    }
  });
});

describe("one transaction", () => {
  test("inside a transaction that rolls back, a bulk change leaves nothing behind", async () => {
    const { live } = await selection();
    const tag = `Rolled back ${marker()}`;
    await expect(
      env.db.transaction().execute(async (trx) => {
        const done = await bulkRepo(trx).addTags(live, [tag]);
        expect(done.changed).toEqual(live);
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
    for (const id of live) expect(await tagsOf(id)).toEqual([]);
    const made = await env.db.selectFrom("tags").select("id").where("name", "=", tag).execute();
    expect(made).toEqual([]);
  });
});
