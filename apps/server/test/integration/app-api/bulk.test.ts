// The library's bulk actions (the maintainer, 2026-11-19) against Postgres 17 and the
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
import { withLiveModel } from "../../../src/library/live.js";
import { createTags } from "../../../src/library/tags.js";
import { createTrash } from "../../../src/library/trash.js";
import { type BulkResult, bulkRepo, MAX_BULK_IDS } from "../../../src/repos/bulk.js";
import type { LibraryView } from "../../../src/repos/models.js";
import { tagsRepo } from "../../../src/repos/tags.js";
import {
  type LibraryEnv,
  labelStored,
  marker,
  rowCounts,
  seedStoredModel,
  startLibraryEnv,
} from "../support/library.js";

const MISSING = "0198f0c4-0000-7000-8000-0000000000ff";

let env: LibraryEnv;
let app: FastifyInstance;

/** The whole library as a view: no search and no filter, so every live model is in it. */
const WHOLE_LIBRARY: LibraryView = { q: "" };

/** Posts body, in the whole library's view unless body names one. */
async function post<T = BulkResult>(
  url: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: T }> {
  const res = await app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/json", accept: "application/json" },
    payload: JSON.stringify({ view: {}, ...body }),
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
    // No Empty trash here, so no job is ever queued.
    boss: {
      send: async () => {
        throw new Error("Empty trash is not in these tests");
      },
      findJobs: async () => {
        throw new Error("Empty trash is not in these tests");
      },
    },
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
      notInView: [],
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

  // Issue #312: no tag is left that no model has, so Add tags that reaches
  // no live model in the view makes no tag; the answer names the tags all the
  // same, a stored one as stored.
  test("Add tags that reaches no live model makes no tag, and names the tags", async () => {
    const { live, trashed } = await selection();
    const fresh = `Fresh ${marker()}`;
    const stored = `Stored ${marker()}`;
    await createTags(env.db).addTag(live[0], stored);
    const res = await post("/app/api/bulk/add-tags", {
      ids: [trashed, MISSING],
      tags: [fresh, stored.toUpperCase()],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      changed: [],
      unchanged: [],
      failed: [
        { id: trashed, reason: "in_trash" },
        { id: MISSING, reason: "not_found" },
      ],
      notInView: [],
      tags: [fresh, stored],
    });
    expect(await labelStored(env.db, "tags", fresh)).toBe(false);
    expect(await tagsOf(trashed)).toEqual([]);
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
  //
  // Add tags runs inside this test's own transaction, where bulkRepo never
  // retries (retryOnConflict's inCaller; issue #286 added the retry). Run on
  // env.db, a deadlock would be retried once Postgres broke it, the retry
  // would succeed, and this test would pass with the ordering gone.
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
    const adding = env.db
      .transaction()
      .execute((trx) => bulkRepo(trx).addTags([a], [second, first], WHOLE_LIBRARY));
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
      notInView: [],
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
    expect(res.body).toEqual({ changed: [a], unchanged: [b], failed: [], notInView: [], tag });
    expect(await tagsOf(a)).toEqual([]);
  });

  // Issue #312: a tag no model has any more is removed, and the answer still
  // names it as it was stored.
  test("taking a tag off its last models removes the tag, and the answer names it", async () => {
    const { live } = await selection();
    const [a, b, c] = live;
    const tag = `Last ${marker()}`;
    const kept = `Kept ${marker()}`;
    await createTags(env.db).addTag(a, tag);
    await createTags(env.db).addTag(b, tag);
    await createTags(env.db).addTag(c, kept);
    const res = await post("/app/api/bulk/remove-tag", { ids: [a, b, c], tag: tag.toUpperCase() });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ changed: [a, b], unchanged: [c], failed: [], notInView: [], tag });
    expect(await labelStored(env.db, "tags", tag)).toBe(false);
    expect(await labelStored(env.db, "tags", kept)).toBe(true);
    expect(await tagsOf(c)).toEqual([kept]);
  });

  test("a tag that a model outside the selection still has is kept", async () => {
    const { live } = await selection();
    const [a, b] = live;
    const tag = `Elsewhere ${marker()}`;
    await createTags(env.db).addTag(a, tag);
    await createTags(env.db).addTag(b, tag);
    const res = await post("/app/api/bulk/remove-tag", { ids: [a], tag });
    expect(res.body).toMatchObject({ changed: [a] });
    expect(await labelStored(env.db, "tags", tag)).toBe(true);
    expect(await tagsOf(b)).toEqual([tag]);
  });

  test("a tag no model has: every live model unchanged, and no stored name", async () => {
    const { live } = await selection();
    const res = await post("/app/api/bulk/remove-tag", { ids: live, tag: `Never ${marker()}` });
    expect(res.body).toEqual({
      changed: [],
      unchanged: live,
      failed: [],
      notInView: [],
      tag: null,
    });
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
      notInView: [],
      collection: name,
    });
    for (const id of live) expect(await env.repos.collections.forModel(id)).toEqual([name]);
    expect(await env.repos.collections.forModel(trashed)).toEqual([]);
  });

  // Issue #312: the Collections page lists empty collections so they can be
  // deleted, so an Add to collection that changes nothing makes none.
  test("Add to collection that reaches no live model makes no collection", async () => {
    const { trashed } = await selection();
    const name = `Never made ${marker()}`;
    const res = await post("/app/api/bulk/add-to-collection", {
      ids: [trashed, MISSING],
      collection: name,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: [], unchanged: [], collection: name });
    expect(await labelStored(env.db, "collections", name)).toBe(false);
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
      notInView: [],
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
        repo.addTags([a, b], tags, WHOLE_LIBRARY),
        repo.addTags([b, a], [...tags].reverse(), WHOLE_LIBRARY),
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
        repo.addToCollection([a, b], name, WHOLE_LIBRARY),
        repo.addToCollection([b, a], name, WHOLE_LIBRARY),
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
      await repo.addTags([a, b], [tag], WHOLE_LIBRARY);
      const answers = await Promise.allSettled([
        repo.removeTag([a, b], tag, WHOLE_LIBRARY),
        repo.removeTag([b, a], tag, WHOLE_LIBRARY),
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
        const done = await bulkRepo(trx).addTags(live, [tag], WHOLE_LIBRARY);
        expect(done.changed).toEqual(live);
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
    for (const id of live) expect(await tagsOf(id)).toEqual([]);
    const made = await env.db.selectFrom("tags").select("id").where("name", "=", tag).execute();
    expect(made).toEqual([]);
  });
});

// The server keeps Select mode to the models the user can see (the maintainer,
// 2026-11-20). Each request names the search and filters it was made in;
// the server works out, in the action's own transaction, which of the
// posted models that view matches now, changes only those, and answers the
// rest in notInView, untouched. That includes a model that matched when the
// browser last checked and has left the view since (here its tag is taken
// off between the check and the request).
describe("the view a bulk request is made in", () => {
  /** Two models with a fresh tag (in the view tag=it) and one without, with that tag. */
  async function tagView() {
    const { live } = await selection();
    const [a, b, c] = live;
    const tag = `View ${marker()}`;
    await createTags(env.db).addTag(a, tag);
    await createTags(env.db).addTag(b, tag);
    return { a, b, c, tag, view: { tag } };
  }

  test("add tags: a model outside the view is left alone and answered in notInView", async () => {
    const { a, c, view } = await tagView();
    const res = await post("/app/api/bulk/add-tags", { ids: [a, c], tags: ["Added"], view });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: [a], unchanged: [], failed: [], notInView: [c] });
    expect(await tagsOf(a)).toContain("Added");
    expect(await tagsOf(c)).toEqual([]);
  });

  test("add tags: a model that left the view after the browser's check is left alone", async () => {
    const { a, b, tag, view } = await tagView();
    await createTags(env.db).removeTag(b, tag);
    const res = await post("/app/api/bulk/add-tags", { ids: [a, b], tags: ["Late"], view });
    expect(res.body).toMatchObject({ changed: [a], notInView: [b] });
    expect(await tagsOf(b)).toEqual([]);
  });

  test("remove a tag: a model outside the view keeps the tag and is answered in notInView", async () => {
    const { a, c, view } = await tagView();
    const other = `Other ${marker()}`;
    await createTags(env.db).addTag(a, other);
    await createTags(env.db).addTag(c, other);
    const res = await post("/app/api/bulk/remove-tag", { ids: [a, c], tag: other, view });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      changed: [a],
      unchanged: [],
      failed: [],
      notInView: [c],
      tag: other,
    });
    expect(await tagsOf(c)).toEqual([other]);
  });

  test("remove a tag: a model that left the view after the browser's check keeps its tags", async () => {
    const { a, b, tag, view } = await tagView();
    const other = `Other ${marker()}`;
    await createTags(env.db).addTag(b, other);
    await createTags(env.db).removeTag(b, tag);
    const res = await post("/app/api/bulk/remove-tag", { ids: [a, b], tag: other, view });
    expect(res.body).toMatchObject({ changed: [], unchanged: [a], notInView: [b] });
    expect(await tagsOf(b)).toEqual([other]);
  });

  test("add to a collection: a model outside the view stays out and is answered in notInView", async () => {
    const { a, c, view } = await tagView();
    const name = `View shelf ${marker()}`;
    const res = await post("/app/api/bulk/add-to-collection", {
      ids: [a, c],
      collection: name,
      view,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: [a], notInView: [c], collection: name });
    expect(await env.repos.collections.forModel(a)).toEqual([name]);
    expect(await env.repos.collections.forModel(c)).toEqual([]);
  });

  test("add to a collection: a model that left the view after the browser's check stays out", async () => {
    const { a, b, tag, view } = await tagView();
    await createTags(env.db).removeTag(b, tag);
    const name = `Late shelf ${marker()}`;
    const res = await post("/app/api/bulk/add-to-collection", {
      ids: [a, b],
      collection: name,
      view,
    });
    expect(res.body).toMatchObject({ changed: [a], notInView: [b] });
    expect(await env.repos.collections.forModel(b)).toEqual([]);
  });

  test("move to the trash: a model outside the view is not trashed and is answered in notInView", async () => {
    const { a, c, view } = await tagView();
    const res = await post("/app/api/bulk/trash", { ids: [a, c], view });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ changed: [a], unchanged: [], failed: [], notInView: [c] });
    expect(await env.repos.models.get(a)).toBeUndefined();
    expect((await env.repos.models.get(c))?.id).toBe(c);
  });

  test("move to the trash: a model that left the view after the browser's check is not trashed", async () => {
    // The rc.2 live case: the filtered tag was taken off a selected model.
    const { a, b, tag, view } = await tagView();
    await createTags(env.db).removeTag(b, tag);
    const res = await post("/app/api/bulk/trash", { ids: [a, b], view });
    expect(res.body).toEqual({ changed: [a], unchanged: [], failed: [], notInView: [b] });
    expect((await env.repos.models.get(b))?.id).toBe(b);
  });

  // The library page's view check asks this about selected models past the
  // first 1000 matches GET /app/api/library/ids answers (PR #313 review):
  // the same rule as the actions, with no sort and no cap, changing nothing.
  test("in-view: answers the posted models the view holds, in the request's order, and changes nothing", async () => {
    const { a, b, c, tag, view } = await tagView();
    const { trashed } = await selection();
    const res = await post<{ ids: string[] }>("/app/api/bulk/in-view", {
      ids: [b, c, trashed, MISSING, "not-an-id", a, a.toUpperCase()],
      view,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ids: [b, a] });
    const whole = await post<{ ids: string[] }>("/app/api/bulk/in-view", { ids: [trashed, c] });
    expect(whole.body).toEqual({ ids: [c] });
    expect(await tagsOf(a)).toEqual([tag]);
    expect(await tagsOf(b)).toEqual([tag]);
    expect(await tagsOf(c)).toEqual([]);
  });

  // The race in the PR #313 review: another tab takes the filtered tag off a
  // selected model while the bulk action runs. That change (withLiveModel)
  // holds the model FOR SHARE until it commits. Every bulk action now locks
  // the selected models FOR NO KEY UPDATE or FOR UPDATE, which wait on it, so
  // the view is read after the change commits and the model is answered in
  // notInView, untouched. Locked FOR SHARE, as these three actions once were,
  // the action did not wait, read the view before the change committed and
  // changed the model anyway; here that shows as the action never waiting.
  const actions: [string, (ids: string[], view: LibraryView) => Promise<BulkResult>][] = [
    ["add tags", (ids, view) => bulkRepo(env.db).addTags(ids, [`Raced ${marker()}`], view)],
    ["remove a tag", (ids, view) => bulkRepo(env.db).removeTag(ids, "Raced other", view)],
    [
      "add to a collection",
      (ids, view) => bulkRepo(env.db).addToCollection(ids, `Raced ${marker()}`, view),
    ],
    ["move to the trash", (ids, view) => bulkRepo(env.db).trash(ids, view)],
  ];
  for (const [name, act] of actions) {
    test(`${name}: a model taken out of the view while the action runs is left alone`, async () => {
      const { a, b, tag } = await tagView();
      await createTags(env.db).addTag(b, "Raced other");
      let release: () => void = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let taken: () => void = () => {};
      const tagTaken = new Promise<void>((resolve) => {
        taken = resolve;
      });
      const other = withLiveModel(env.db, b, async (trx) => {
        expect(await tagsRepo(trx).remove(b, tag)).toBe(true);
        taken();
        await released;
        return true;
      });
      await tagTaken;
      const acting = act([a, b], { q: "", tag });
      try {
        const deadline = Date.now() + 10_000;
        for (;;) {
          const { rows } = await sql<{ waiting: number }>`
            select count(*)::int as waiting from pg_stat_activity
             where wait_event_type = 'Lock' and query ilike 'select %from "models"%for %update%'
          `.execute(env.db);
          if ((rows[0]?.waiting ?? 0) > 0) break;
          if (Date.now() > deadline)
            throw new Error(`${name} never waited on the share-locked model`);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        release();
        expect(await other).toBe(true);
        const done = await acting;
        expect(done.notInView).toEqual([b]);
        expect(done.changed).not.toContain(b);
        expect(await tagsOf(b)).toEqual(["Raced other"]);
        expect(await env.repos.collections.forModel(b)).toEqual([]);
        expect((await env.repos.models.get(b))?.id).toBe(b);
      } finally {
        release();
        await other.catch(() => false);
        await acting.catch(() => undefined);
      }
    });
  }

  test("the search counts as the library page's does: name, caption, creator and tag", async () => {
    const word = marker();
    const named = (await seedStoredModel(env, { name: `Searched ${word}` })).model.id;
    const byCreator = (await seedStoredModel(env, { creator: `Maker ${word}` })).model.id;
    const tagged = (await seedStoredModel(env)).model.id;
    await createTags(env.db).addTag(tagged, `Tag ${word}`);
    const other = (await seedStoredModel(env)).model.id;
    const res = await post("/app/api/bulk/add-tags", {
      ids: [named, byCreator, tagged, other],
      tags: ["Found"],
      view: { q: word.toUpperCase() },
    });
    expect(res.body).toMatchObject({ changed: [named, byCreator, tagged], notInView: [other] });
  });

  test("the collection and creator filters, and a blank filter that is no filter", async () => {
    const { live } = await selection();
    const [a, b, c] = live;
    const shelf = `Filter shelf ${marker()}`;
    await createCollections(env.db).addToCollection(a, shelf);
    await createCollections(env.db).addToCollection(b, shelf);
    const inShelf = await post("/app/api/bulk/add-tags", {
      ids: [a, b, c],
      tags: ["Shelved"],
      view: { collection: shelf.toLowerCase(), tag: "  " },
    });
    expect(inShelf.body).toMatchObject({ changed: [a, b], notInView: [c] });
    const maker = `Filter maker ${marker()}`;
    const made = (await seedStoredModel(env, { creator: maker })).model.id;
    const byMaker = await post("/app/api/bulk/add-tags", {
      ids: [made, c],
      tags: ["Made"],
      view: { creator: maker },
    });
    expect(byMaker.body).toMatchObject({ changed: [made], notInView: [c] });
  });

  test("a model in the trash is still reported as in the trash, not as outside the view", async () => {
    const { trashed } = await selection();
    const res = await post("/app/api/bulk/add-tags", {
      ids: [trashed],
      tags: ["Never"],
      view: { tag: `Nothing ${marker()}` },
    });
    expect(res.body).toMatchObject({
      changed: [],
      failed: [{ id: trashed, reason: "in_trash" }],
      notInView: [],
    });
  });
});
