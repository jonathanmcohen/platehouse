// The orphan sweep (PR #49 review). An object under models/ with no blob row
// is left behind when the process dies between an upload and its commit, or
// when the cleanup delete fails during a store outage; no purge ever reaches
// it. The sweep deletes such objects once they are older than 24 hours,
// listing the bucket a page at a time, and is safe to run again. The bucket is
// the only copy of the bytes, so the sweep deletes nothing when the blobs
// table holds no stored rows (a database that has lost its rows) or when a
// run would delete more than its limit (PR #49 review, round 1).
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { uuidv7 } from "../../../src/db/ids.js";
import {
  createOrphanSweep,
  ORPHAN_DELETE_FLOOR,
  ORPHAN_MIN_AGE_MS,
  type OrphanStore,
} from "../../../src/ingest/orphans.js";
import { blobKey } from "../../../src/storage/keys.js";
import { type LibraryEnv, startLibraryEnv, storeBlob } from "../support/library.js";

let env: LibraryEnv;
const lines: string[] = [];

beforeAll(async () => {
  env = await startLibraryEnv();
});

afterAll(async () => {
  await env?.stop();
});

/** A time just past the 24 hours, as seen from an object written now. */
const dayLater = () => new Date(Date.now() + ORPHAN_MIN_AGE_MS + 60_000);

function sweeper(store: OrphanStore = env.store, pageSize?: number) {
  return createOrphanSweep({
    db: env.db,
    store,
    log: (line) => lines.push(line),
    ...(pageSize === undefined ? {} : { pageSize }),
  });
}

/** An object in the blob layout with no blob row, as a crashed ingest leaves. */
async function putOrphan(): Promise<string> {
  const key = blobKey(uuidv7(), uuidv7());
  const bytes = randomBytes(16);
  await env.store.putBlob(Readable.from([bytes]), {
    key,
    size: bytes.length,
    contentType: "application/octet-stream",
  });
  return key;
}

async function exists(key: string): Promise<boolean> {
  return (await env.store.listPrefix(key)).some((o) => o.key === key);
}

// Runs first, while the migrated database still holds no blob rows: the state
// an empty Postgres volume, a wrong DATABASE_URL or a second instance on the
// same bucket would leave.
describe("the orphan sweep against an empty migrated database", () => {
  test("deletes nothing from a populated bucket, and logs why", async () => {
    const rows = await env.db.selectFrom("blobs").select("id").execute();
    expect(rows).toHaveLength(0);
    const library = await Promise.all([1, 2, 3, 4, 5].map(() => putOrphan()));
    lines.length = 0;
    const result = await sweeper().sweepOrphans(dayLater());
    for (const key of library) expect(await exists(key)).toBe(true);
    expect(result.deleted).toBe(0);
    expect(result.orphans).toBe(library.length);
    expect(result.refused).toContain("no stored rows");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("deleted nothing");
    expect(lines[0]).toContain("no stored rows");
    await env.store.deleteBlobs(library);
  });
});

describe("the orphan sweep", () => {
  beforeAll(async () => {
    // A library with a stored blob, as every library that has ingested one has.
    const model = await env.repos.models.create({ name: `Library ${uuidv7()}` });
    await storeBlob(env, model.id, "source", randomBytes(24));
  });

  test("ORPHAN_MIN_AGE_MS is 24 hours", () => {
    expect(ORPHAN_MIN_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });

  test("deletes an object with no blob row once it is older than 24 hours", async () => {
    const orphan = await putOrphan();
    const result = await sweeper().sweepOrphans(dayLater());
    expect(await exists(orphan)).toBe(false);
    expect(result.deleted).toBeGreaterThanOrEqual(1);
  });

  test("keeps an object with no blob row younger than 24 hours, so an upload in progress is never touched", async () => {
    const orphan = await putOrphan();
    await sweeper().sweepOrphans(new Date());
    await sweeper().sweepOrphans(new Date(Date.now() + ORPHAN_MIN_AGE_MS - 60_000));
    expect(await exists(orphan)).toBe(true);
  });

  test("keeps every object that has a blob row, stored or pending", async () => {
    const model = await env.repos.models.create({ name: `Kept ${uuidv7()}` });
    const stored = await storeBlob(env, model.id, "source", randomBytes(20));
    const pending = await env.repos.blobs.insertPending({
      modelId: model.id,
      kind: "thumbnail",
      contentType: "image/png",
    });
    const bytes = randomBytes(12);
    await env.store.putBlob(Readable.from([bytes]), {
      key: pending.key,
      size: bytes.length,
      contentType: "image/png",
    });
    await sweeper().sweepOrphans(dayLater());
    expect(await exists(stored.key)).toBe(true);
    expect(await exists(pending.key)).toBe(true);
  });

  test("leaves a key outside the blob layout alone and counts it", async () => {
    const odd = `models/not-a-model-id/${uuidv7()}.txt`;
    await env.putRaw(odd, Buffer.from("put here by something other than the app"));
    const result = await sweeper().sweepOrphans(dayLater());
    expect(await exists(odd)).toBe(true);
    expect(result.outsideLayout).toBeGreaterThanOrEqual(1);
  });

  test("lists the bucket a page at a time and still reaches every orphan", async () => {
    const orphans = await Promise.all([1, 2, 3, 4, 5].map(() => putOrphan()));
    const pages: Array<number | undefined> = [];
    const counting: OrphanStore = {
      listPage: async (prefix, opts) => {
        pages.push(opts?.maxKeys);
        return env.store.listPage(prefix, opts);
      },
      deleteBlobs: (keys) => env.store.deleteBlobs(keys),
    };
    await sweeper(counting, 2).sweepOrphans(dayLater());
    for (const key of orphans) expect(await exists(key)).toBe(false);
    expect(pages.length).toBeGreaterThanOrEqual(3);
    expect(pages.every((n) => n === 2)).toBe(true);
  });

  test("running it again deletes nothing and does not fail", async () => {
    await putOrphan();
    await sweeper().sweepOrphans(dayLater());
    const again = await sweeper().sweepOrphans(dayLater());
    expect(again.deleted).toBe(0);
    expect(again.listed).toBeGreaterThan(0);
  });

  test("logs what each run listed, deleted and left alone", async () => {
    lines.length = 0;
    await putOrphan();
    const result = await sweeper().sweepOrphans(dayLater());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`listed ${result.listed}`);
    expect(lines[0]).toContain(`deleted ${result.deleted}`);
    expect(lines[0]).toContain(`left ${result.outsideLayout} outside the key layout`);
    expect(result.deleted).toBe(1);
  });

  test("deletes nothing when a run would delete more than its limit, and logs why", async () => {
    const many = await Promise.all(
      Array.from({ length: ORPHAN_DELETE_FLOOR + 1 }, () => putOrphan()),
    );
    lines.length = 0;
    const result = await sweeper().sweepOrphans(dayLater());
    for (const key of many) expect(await exists(key)).toBe(true);
    expect(result.deleted).toBe(0);
    expect(result.orphans).toBe(many.length);
    expect(result.refused).toContain(`limit of ${ORPHAN_DELETE_FLOOR}`);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("deleted nothing");
    await env.store.deleteBlobs(many);
  });

  test("deletes a run's orphans when they are exactly at the limit", async () => {
    const atLimit = await Promise.all(
      Array.from({ length: ORPHAN_DELETE_FLOOR }, () => putOrphan()),
    );
    const result = await sweeper().sweepOrphans(dayLater());
    for (const key of atLimit) expect(await exists(key)).toBe(false);
    expect(result.refused).toBeUndefined();
    expect(result.deleted).toBe(atLimit.length);
  });
});
