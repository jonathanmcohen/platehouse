// Build plan Task 4: blobs, files, plates, tags, collections, tokens, sessions
// and settings repositories against a migrated Postgres 17.
import { createHash, randomBytes } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { uuidv7 } from "../../../src/db/ids.js";
import { migrate } from "../../../src/db/migrate.js";
import { createRepos, type Repos } from "../../../src/repos/index.js";
import {
  sqlState,
  startTestPostgres,
  type TestDatabase,
  type TestPostgres,
} from "../support/db.js";
import { seedFile, sha256Of } from "../support/fixtures.js";

let pgc: TestPostgres;
let t: TestDatabase;
let repos: Repos;

beforeAll(async () => {
  pgc = await startTestPostgres();
  t = await pgc.freshDatabase();
  await migrate(t.db);
  repos = createRepos(t.db);
});

afterAll(async () => {
  await pgc?.stop();
});

describe("blobs", () => {
  test("insertPending makes a pending row keyed models/<modelId>/<blobId>", async () => {
    const model = await repos.models.create({ name: "Blob owner" });
    const blob = await repos.blobs.insertPending({
      modelId: model.id,
      kind: "source",
      contentType: "model/3mf",
    });
    expect(blob.key).toBe(`models/${model.id}/${blob.id}`);
    expect(blob).toMatchObject({ state: "pending", size: null, sha256: null, kind: "source" });
    expect(await repos.blobs.get(blob.id)).toEqual(blob);
  });

  test("markStored records the size and SHA-256, and a bigint size reads back as a number", async () => {
    const model = await repos.models.create({ name: "Big blob owner" });
    const blob = await repos.blobs.insertPending({
      modelId: model.id,
      kind: "source",
      contentType: "model/3mf",
      size: 5_000_000_000,
    });
    expect(blob.size).toBe(5_000_000_000);
    const sha256 = sha256Of("five gigabytes, notionally");
    const stored = await repos.blobs.markStored(blob.id, { size: 5_000_000_001, sha256 });
    expect(stored).toMatchObject({ state: "stored", size: 5_000_000_001 });
    expect(stored?.sha256?.equals(sha256)).toBe(true);
  });

  test("markStored on a blob that is already stored or unknown answers undefined", async () => {
    const model = await repos.models.create({ name: "Stored twice" });
    const blob = await repos.blobs.insertPending({
      modelId: model.id,
      kind: "thumbnail",
      contentType: "image/png",
    });
    const sha256 = sha256Of("png");
    expect(await repos.blobs.markStored(blob.id, { size: 3, sha256 })).toBeDefined();
    expect(await repos.blobs.markStored(blob.id, { size: 3, sha256 })).toBeUndefined();
    expect(await repos.blobs.markStored(uuidv7(), { size: 3, sha256 })).toBeUndefined();
  });

  test("the schema refuses a key that is not models/<modelId>/<blobId>", async () => {
    const model = await repos.models.create({ name: "Key owner" });
    const id = uuidv7();
    expect(
      await sqlState(
        t.db
          .insertInto("blobs")
          .values({
            id,
            modelId: model.id,
            key: `models/${model.id}/My Print.3mf`,
            kind: "source",
            contentType: "model/3mf",
          })
          .execute(),
      ),
    ).toBe("23514");
  });

  test("the schema refuses a stored blob without a size and SHA-256, and a wrong-length hash", async () => {
    const model = await repos.models.create({ name: "Half stored" });
    const blob = await repos.blobs.insertPending({
      modelId: model.id,
      kind: "source",
      contentType: "model/3mf",
    });
    expect(
      await sqlState(
        t.db.updateTable("blobs").set({ state: "stored" }).where("id", "=", blob.id).execute(),
      ),
    ).toBe("23514");
    expect(
      await sqlState(repos.blobs.markStored(blob.id, { size: 1, sha256: Buffer.alloc(31) })),
    ).toBe("23514");
  });

  test("the schema refuses an unknown blob kind", async () => {
    const model = await repos.models.create({ name: "Odd kind" });
    expect(
      await sqlState(
        repos.blobs.insertPending({
          modelId: model.id,
          // biome-ignore lint/suspicious/noExplicitAny: writing a value the type forbids, on purpose
          kind: "gcode" as any,
          contentType: "text/plain",
        }),
      ),
    ).toBe("23514");
  });
});

describe("files and plates", () => {
  test("files.create stores a file that files.get reads back", async () => {
    const { file, blob, modelId } = await seedFile(repos);
    expect(await repos.files.get(file.id)).toEqual(file);
    expect(file).toMatchObject({ modelId, blobId: blob.id, kind: "3mf", parseStatus: "pending" });
    expect(await repos.files.get("not-a-uuid")).toBeUndefined();
  });

  test("plates are listed in plate order", async () => {
    const { file } = await seedFile(repos);
    await repos.plates.create({ fileId: file.id, index: 2, objectCount: 1, name: "Lid" });
    await repos.plates.create({ fileId: file.id, index: 1, objectCount: 3 });
    const plates = await repos.plates.listForFile(file.id);
    expect(plates.map((p) => [p.index, p.name, p.objectCount])).toEqual([
      [1, null, 3],
      [2, "Lid", 1],
    ]);
  });

  test("a plate number is unique within its file and starts at 1", async () => {
    const { file } = await seedFile(repos);
    await repos.plates.create({ fileId: file.id, index: 1, objectCount: 1 });
    expect(await sqlState(repos.plates.create({ fileId: file.id, index: 1, objectCount: 1 }))).toBe(
      "23505",
    );
    expect(await sqlState(repos.plates.create({ fileId: file.id, index: 0, objectCount: 1 }))).toBe(
      "23514",
    );
  });

  test("the schema refuses an unsupported file kind or parse status", async () => {
    const { file } = await seedFile(repos);
    expect(
      await sqlState(
        t.db
          .updateTable("files")
          // biome-ignore lint/suspicious/noExplicitAny: writing a value the type forbids, on purpose
          .set({ kind: "obj" as any })
          .where("id", "=", file.id)
          .execute(),
      ),
    ).toBe("23514");
    expect(
      await sqlState(
        t.db
          .updateTable("files")
          // biome-ignore lint/suspicious/noExplicitAny: writing a value the type forbids, on purpose
          .set({ parseStatus: "broken" as any })
          .where("id", "=", file.id)
          .execute(),
      ),
    ).toBe("23514");
  });
});

describe("tags and collections", () => {
  test("a tag added twice in different case is one tag and one link", async () => {
    const model = await repos.models.create({ name: "Tagged" });
    const name = `Gridfinity ${uuidv7()}`;
    await repos.tags.add(model.id, name);
    await repos.tags.add(model.id, name.toUpperCase());
    expect(await repos.tags.forModel(model.id)).toEqual([name]);
    const rows = await t.db
      .selectFrom("tags")
      .select("id")
      .where(sql<boolean>`lower(name) = lower(${name})`)
      .execute();
    expect(rows).toHaveLength(1);
  });

  test("tags.remove unlinks the tag from that model only", async () => {
    const a = await repos.models.create({ name: "A" });
    const b = await repos.models.create({ name: "B" });
    const name = `Shared ${uuidv7()}`;
    await repos.tags.add(a.id, name);
    await repos.tags.add(b.id, name);
    expect(await repos.tags.remove(a.id, name.toLowerCase())).toBe(true);
    expect(await repos.tags.remove(a.id, name)).toBe(false);
    expect(await repos.tags.forModel(a.id)).toEqual([]);
    expect(await repos.tags.forModel(b.id)).toEqual([name]);
  });

  test("a blank tag name is refused", async () => {
    const model = await repos.models.create({ name: "Blank tag" });
    await expect(repos.tags.add(model.id, "   ")).rejects.toThrow(/empty/);
  });

  test("a model sits in two collections, and leaving one keeps the other", async () => {
    const model = await repos.models.create({ name: "Collected" });
    const one = `Desk ${uuidv7()}`;
    const two = `Garage ${uuidv7()}`;
    await repos.collections.add(model.id, one);
    await repos.collections.add(model.id, two);
    await repos.collections.add(model.id, one.toLowerCase());
    expect(await repos.collections.forModel(model.id)).toEqual([one, two]);
    expect(await repos.collections.remove(model.id, one)).toBe(true);
    expect(await repos.collections.forModel(model.id)).toEqual([two]);
  });
});

describe("tokens", () => {
  const hashOf = (raw: Buffer) => createHash("sha256").update(raw).digest();
  const prefixOf = (raw: Buffer) => raw.toString("base64url").slice(0, 8);

  test("findByHash finds a live token and not a revoked one; revoking one keeps the others", async () => {
    const firstRaw = randomBytes(32);
    const secondRaw = randomBytes(32);
    const first = await repos.tokens.create({
      name: "Claude Code on mini01",
      prefix: prefixOf(firstRaw),
      tokenHash: hashOf(firstRaw),
    });
    const second = await repos.tokens.create({
      name: "Claude Code on mba",
      prefix: prefixOf(secondRaw),
      tokenHash: hashOf(secondRaw),
    });
    expect((await repos.tokens.findByHash(hashOf(firstRaw)))?.id).toBe(first.id);

    expect(await repos.tokens.revoke(first.id)).toBe(true);
    expect(await repos.tokens.revoke(first.id)).toBe(false);

    expect(await repos.tokens.findByHash(hashOf(firstRaw))).toBeUndefined();
    expect((await repos.tokens.findByHash(hashOf(secondRaw)))?.id).toBe(second.id);
    expect(await repos.tokens.findByHash(hashOf(randomBytes(32)))).toBeUndefined();
  });

  test("the schema refuses a hash that is not 32 bytes and a prefix that is not 8 characters", async () => {
    const raw = randomBytes(32);
    expect(
      await sqlState(
        repos.tokens.create({ name: "short", prefix: prefixOf(raw), tokenHash: Buffer.alloc(16) }),
      ),
    ).toBe("23514");
    expect(
      await sqlState(
        repos.tokens.create({ name: "prefix", prefix: "abc", tokenHash: hashOf(raw) }),
      ),
    ).toBe("23514");
  });
});

describe("sessions", () => {
  const newId = () => randomBytes(32).toString("base64url");

  test("a live session is found, and delete removes it", async () => {
    const id = newId();
    const now = new Date();
    await repos.sessions.create({
      id,
      subject: "pocket-id-subject",
      expiresAt: new Date(now.getTime() + 3600_000),
      idleExpiresAt: new Date(now.getTime() + 600_000),
    });
    expect((await repos.sessions.get(id, now))?.subject).toBe("pocket-id-subject");
    expect(await repos.sessions.delete(id)).toBe(true);
    expect(await repos.sessions.get(id, now)).toBeUndefined();
    expect(await repos.sessions.delete(id)).toBe(false);
  });

  test("a session past its absolute or its idle expiry is not found", async () => {
    const now = new Date();
    const absolute = newId();
    const idle = newId();
    await repos.sessions.create({
      id: absolute,
      subject: "s",
      expiresAt: new Date(now.getTime() - 1),
      idleExpiresAt: new Date(now.getTime() + 600_000),
    });
    await repos.sessions.create({
      id: idle,
      subject: "s",
      expiresAt: new Date(now.getTime() + 3600_000),
      idleExpiresAt: new Date(now.getTime() - 1),
    });
    expect(await repos.sessions.get(absolute, now)).toBeUndefined();
    expect(await repos.sessions.get(idle, now)).toBeUndefined();
  });

  test("the schema refuses an id that is not 32 bytes of base64url", async () => {
    const at = new Date(Date.now() + 1000);
    expect(
      await sqlState(
        repos.sessions.create({ id: "short", subject: "s", expiresAt: at, idleExpiresAt: at }),
      ),
    ).toBe("23514");
  });
});

describe("settings", () => {
  test("settings.get reads the defaults and settings.update changes only what it names", async () => {
    const before = await repos.settings.get();
    expect(before).toMatchObject({
      printerId: "Bambu Lab P1S 0.4 nozzle",
      lastOrcaVersion: null,
      bucketVersioning: "unknown",
    });

    const after = await repos.settings.update({ printerId: "Bambu Lab A1 0.4 nozzle" });
    expect(after).toMatchObject({
      printerId: "Bambu Lab A1 0.4 nozzle",
      lastOrcaVersion: null,
      bucketVersioning: "unknown",
    });
    expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());

    await repos.settings.update({ lastOrcaVersion: "2.5.0", bucketVersioning: "off" });
    expect(await repos.settings.get()).toMatchObject({
      printerId: "Bambu Lab A1 0.4 nozzle",
      lastOrcaVersion: "2.5.0",
      bucketVersioning: "off",
    });
  });

  test("an unknown versioning state is refused", async () => {
    expect(
      // biome-ignore lint/suspicious/noExplicitAny: writing a value the type forbids, on purpose
      await sqlState(repos.settings.update({ bucketVersioning: "maybe" as any })),
    ).toBe("23514");
  });

  test("there is only ever one settings row", async () => {
    expect(await sqlState(t.db.insertInto("settings").defaultValues().execute())).toBe("23505");
    expect(await sqlState(t.db.insertInto("settings").values({ id: false }).execute())).toBe(
      "23514",
    );
  });
});
