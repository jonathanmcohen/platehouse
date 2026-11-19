// Duplicate files (approved for 0.1.0 by Jon, 2026-11-19): a file whose
// SHA-256 matches a file already in a live model. With duplicates "skip"
// ingest refuses it before any byte reaches the bucket, names the model that
// holds it, and stores nothing. With "allow", the default, it is stored as
// before and the result lists the live models that already hold it. A file
// in a trashed model never counts.
import { createHash, randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { DuplicateFile, duplicateMessage, IngestError } from "../../../src/ingest/ingest.js";
import { createRepos } from "../../../src/repos/index.js";
import { footprint, type IngestEnv, startIngestEnv, writeUpload } from "../support/ingest.js";

let env: IngestEnv;

beforeAll(async () => {
  env = await startIngestEnv();
});

afterAll(async () => {
  await env?.stop();
});

/** An ASCII STL no other test writes, so its SHA-256 is its own. */
function uniqueStl(): string {
  const name = `dup-${randomUUID()}`;
  return (
    `solid ${name}\n facet normal 0 0 1\n  outer loop\n   vertex 0 0 0\n   vertex 1 0 0\n` +
    `   vertex 0 1 0\n  endloop\n endfacet\nendsolid ${name}\n`
  );
}

async function store(bytes: string, originalName: string) {
  return env.ingest.ingestFile({
    tmpPath: await writeUpload(env, bytes),
    originalName,
    target: "new",
  });
}

describe("duplicates: skip", () => {
  test("a file a live model holds is refused, named, and nothing is stored", async () => {
    const bytes = uniqueStl();
    const first = await store(bytes, "Clip.stl");
    const before = await footprint(env);

    const error = await env.ingest
      .ingestFile({
        tmpPath: await writeUpload(env, bytes),
        originalName: "Clip (2).stl",
        target: "new",
        duplicates: "skip",
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DuplicateFile);
    expect(error).toBeInstanceOf(IngestError);
    const dup = error as DuplicateFile;
    expect(dup.code).toBe("duplicate");
    expect(dup.duplicates).toEqual([
      { modelId: first.modelId, modelName: "Clip", fileId: first.fileId, fileName: "Clip.stl" },
    ]);
    expect(dup.message).toBe(duplicateMessage(dup.duplicates));
    expect(dup.message).toContain('"Clip"');
    expect(dup.message).toContain(first.modelId);
    expect(dup.message).toMatch(/nothing was saved/);
    expect(await footprint(env)).toEqual(before);
  });

  test("a file only a trashed model holds is not a duplicate", async () => {
    const bytes = uniqueStl();
    const first = await store(bytes, "Hook.stl");
    expect(await createRepos(env.db).models.trash(first.modelId)).toBe(true);

    const again = await env.ingest.ingestFile({
      tmpPath: await writeUpload(env, bytes),
      originalName: "Hook.stl",
      target: "new",
      duplicates: "skip",
    });

    expect(again.modelId).not.toBe(first.modelId);
    expect(again.duplicates).toEqual([]);
  });

  test("a live copy still counts when a trashed model also holds the file", async () => {
    const bytes = uniqueStl();
    const trashed = await store(bytes, "Peg.stl");
    const live = await store(bytes, "Peg live.stl");
    await createRepos(env.db).models.trash(trashed.modelId);

    const error = await env.ingest
      .ingestFile({
        tmpPath: await writeUpload(env, bytes),
        originalName: "Peg.stl",
        target: "new",
        duplicates: "skip",
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DuplicateFile);
    expect((error as DuplicateFile).duplicates.map((d) => d.modelId)).toEqual([live.modelId]);
  });

  test("a new file is stored, with no duplicates listed", async () => {
    const r = await env.ingest.ingestFile({
      tmpPath: await writeUpload(env, uniqueStl()),
      originalName: "Fresh.stl",
      target: "new",
      duplicates: "skip",
    });
    expect(r.duplicates).toEqual([]);
    const row = await createRepos(env.db).files.get(r.fileId);
    expect(row?.modelId).toBe(r.modelId);
  });

  test("into an existing model that already holds the file, it is refused too", async () => {
    const bytes = uniqueStl();
    const first = await store(bytes, "Lid.stl");
    const error = await env.ingest
      .ingestFile({
        tmpPath: await writeUpload(env, bytes),
        originalName: "Lid.stl",
        target: { modelId: first.modelId },
        duplicates: "skip",
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DuplicateFile);
    const files = await env.db
      .selectFrom("files")
      .select("id")
      .where("modelId", "=", first.modelId)
      .execute();
    expect(files).toHaveLength(1);
  });

  test("two copies sent at once: one is stored, the other is refused naming it", async () => {
    const bytes = uniqueStl();
    const send = async () =>
      env.ingest
        .ingestFile({
          tmpPath: await writeUpload(env, bytes),
          originalName: "Twin.stl",
          target: "new",
          duplicates: "skip",
        })
        .then(
          (r) => ({ ok: r }) as const,
          (e: unknown) => ({ error: e }) as const,
        );
    const outcomes = await Promise.all([send(), send(), send()]);
    const stored = outcomes.flatMap((o) => ("ok" in o ? [o.ok] : []));
    const refused = outcomes.flatMap((o) => ("error" in o ? [o.error] : []));
    expect(stored).toHaveLength(1);
    expect(refused).toHaveLength(2);
    for (const e of refused) {
      expect(e).toBeInstanceOf(DuplicateFile);
      expect((e as DuplicateFile).duplicates[0]?.fileId).toBe(stored[0]?.fileId);
    }
    const sha = createHash("sha256").update(bytes).digest();
    const rows = await env.db.selectFrom("files").select("id").where("sha256", "=", sha).execute();
    expect(rows).toHaveLength(1);
  });
});

describe("duplicates: allow (the default)", () => {
  test("a duplicate is stored as before, and the result names the live copies", async () => {
    const bytes = uniqueStl();
    const first = await store(bytes, "Gear.stl");
    const second = await store(bytes, "Gear copy.stl");

    expect(second.modelId).not.toBe(first.modelId);
    expect(second.duplicates).toEqual([
      { modelId: first.modelId, modelName: "Gear", fileId: first.fileId, fileName: "Gear.stl" },
    ]);
    const explicit = await env.ingest.ingestFile({
      tmpPath: await writeUpload(env, bytes),
      originalName: "Gear third.stl",
      target: "new",
      duplicates: "allow",
    });
    expect(explicit.duplicates?.map((d) => d.fileId)).toEqual([first.fileId, second.fileId]);
  });

  test("a copy in a trashed model is not listed", async () => {
    const bytes = uniqueStl();
    const first = await store(bytes, "Knob.stl");
    await createRepos(env.db).models.trash(first.modelId);
    const second = await store(bytes, "Knob.stl");
    expect(second.duplicates).toEqual([]);
  });
});

describe("the SHA-256 lookup has an index", () => {
  test("files.sha256 is indexed (migration 0004)", async () => {
    const { rows } = await sql<{ indexdef: string }>`
      select indexdef from pg_indexes where tablename = 'files' and indexname = 'files_sha256'
    `.execute(env.db);
    expect(rows[0]?.indexdef).toMatch(/\(sha256\)/);
  });
});
