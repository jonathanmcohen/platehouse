// Duplicate files, without Docker (approved for 0.1.0 by the maintainer, 2026-11-19).
// The message a refused duplicate carries, and where ingest checks: with
// duplicates "skip" it looks for the file's SHA-256 among live models before
// any byte is put, and again inside the transaction under a lock on the hash,
// so two copies sent at once cannot both land. The database is a Kysely whose
// driver answers from a script, as in outcome.test.ts; the same cases against
// a real Postgres and S3 are in test/integration/ingest/duplicates.test.ts.
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import {
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from "kysely";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { DB } from "../../src/db/types.js";
import { parseDuplicateMessage } from "../../src/ingest/duplicates.js";
import {
  createIngest,
  DuplicateFile,
  type DuplicateMatch,
  duplicateMessage,
  INGEST_LOCK_NAMESPACE,
  type IngestStore,
} from "../../src/ingest/ingest.js";

const ASCII_STL =
  "solid d\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid d\n";

const MODEL_A = "0198f0c4-0000-7000-8000-00000000000a";
const MODEL_B = "0198f0c4-0000-7000-8000-00000000000b";
const FILE_A = "0198f0c4-0000-7000-8000-0000000000fa";
const FILE_B = "0198f0c4-0000-7000-8000-0000000000fb";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "platehouse-ingest-duplicates-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

let counter = 0;
async function upload(bytes: string): Promise<string> {
  counter += 1;
  const path = join(dir, `upload-${counter}.tmp`);
  await writeFile(path, bytes);
  return path;
}

function memoryStore() {
  const held = new Set<string>();
  let puts = 0;
  const store: IngestStore = {
    async putBlob(stream: Readable, { key }) {
      const hash = createHash("sha256");
      let size = 0;
      for await (const chunk of stream) {
        const bytes = Buffer.from(chunk as Uint8Array);
        hash.update(bytes);
        size += bytes.length;
      }
      held.add(key);
      puts += 1;
      return { sha256: hash.digest(), size };
    },
    async deleteBlobs(keys) {
      for (const key of keys) held.delete(key);
    },
  };
  return { store, held, puts: () => puts };
}

/** Every statement the database was sent, in order, and a Kysely answering them. */
function scriptedDb(answer: (sql: string, parameters: readonly unknown[]) => QueryResult<unknown>) {
  const sent: string[] = [];
  const params: Array<readonly unknown[]> = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      sent.push(query.sql);
      params.push(query.parameters);
      return answer(query.sql, query.parameters) as QueryResult<R>;
    },
    streamQuery(): never {
      throw new Error("streamQuery is not scripted");
    },
  };
  const driver: Driver = {
    async init() {},
    async acquireConnection() {
      return connection;
    },
    async beginTransaction() {
      sent.push("begin");
      params.push([]);
    },
    async commitTransaction() {
      sent.push("commit");
      params.push([]);
    },
    async rollbackTransaction() {
      sent.push("rollback");
      params.push([]);
    },
    async releaseConnection() {},
    async destroy() {},
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (k) => new PostgresIntrospector(k),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, sent, params };
}

/** Whether a statement is the duplicate lookup: files by SHA-256, joined to live models. */
const isLookup = (sql: string) => /"files"\."sha256" = /.test(sql) && /"models"/.test(sql);

const LIVE_ROW = { modelId: MODEL_A, modelName: "Clip", fileId: FILE_A, fileName: "Clip.stl" };

describe("duplicateMessage", () => {
  const match = (over: Partial<DuplicateMatch> = {}): DuplicateMatch => ({ ...LIVE_ROW, ...over });

  test("one model: named in quotes with its id, and nothing saved", () => {
    expect(duplicateMessage([match()])).toBe(
      `This file is already in the library, in the model "Clip" (id ${MODEL_A}), so it was ` +
        "skipped; nothing was saved",
    );
  });

  test("more models: the first is named and the others counted, each model once", () => {
    const text = duplicateMessage([
      match(),
      match({ fileId: FILE_B, fileName: "Clip again.stl" }),
      match({ modelId: MODEL_B, modelName: "Other", fileId: FILE_B }),
    ]);
    expect(text).toBe(
      `This file is already in the library, in the model "Clip" (id ${MODEL_A}) and 1 other ` +
        "model, so it was skipped; nothing was saved",
    );
    const three = duplicateMessage([
      match(),
      match({ modelId: MODEL_B }),
      match({ modelId: "0198f0c4-0000-7000-8000-00000000000c" }),
    ]);
    expect(three).toContain("and 2 other models,");
  });

  test("a model name with line breaks or control characters reads as one line", () => {
    const text = duplicateMessage([match({ modelName: "Two\nlines\u0007 here" })]);
    expect(text).toContain('"Two lines here"');
    expect(/\p{Cc}/u.test(text)).toBe(false);
  });

  test("a very long model name is cut short", () => {
    const text = duplicateMessage([match({ modelName: "x".repeat(500) })]);
    expect(text).toContain(`"${"x".repeat(100)}..."`);
  });
});

describe("parseDuplicateMessage", () => {
  const match = (over: Partial<DuplicateMatch> = {}): DuplicateMatch => ({ ...LIVE_ROW, ...over });

  test("reads back the first model's name and id and the others counted, with or without a full stop", () => {
    const one = duplicateMessage([match()]);
    expect(parseDuplicateMessage(one)).toEqual({ name: "Clip", id: MODEL_A, others: 0 });
    expect(parseDuplicateMessage(`${one}.`)).toEqual({ name: "Clip", id: MODEL_A, others: 0 });
    const two = duplicateMessage([match(), match({ modelId: MODEL_B, modelName: "Other" })]);
    expect(parseDuplicateMessage(`${two}.`)).toEqual({ name: "Clip", id: MODEL_A, others: 1 });
    const three = duplicateMessage([
      match(),
      match({ modelId: MODEL_B }),
      match({ modelId: "0198f0c4-0000-7000-8000-00000000000c" }),
    ]);
    expect(parseDuplicateMessage(`${three}.`)).toEqual({ name: "Clip", id: MODEL_A, others: 2 });
  });

  test('a name with quotes or "(id ...)" in it is read back whole', () => {
    const name = 'The "Best" clip (id 1) and 2 other models';
    expect(parseDuplicateMessage(`${duplicateMessage([match({ modelName: name })])}.`)).toEqual({
      name,
      id: MODEL_A,
      others: 0,
    });
  });

  test("any other sentence is not read as a duplicate", () => {
    expect(parseDuplicateMessage("This file is not a supported file.")).toBeUndefined();
    expect(parseDuplicateMessage("")).toBeUndefined();
  });
});

describe("where ingest checks for a duplicate", () => {
  test("skip: a live copy found before the upload refuses it with nothing put", async () => {
    const { db, sent } = scriptedDb((sql) => (isLookup(sql) ? { rows: [LIVE_ROW] } : { rows: [] }));
    const mem = memoryStore();
    const error = await createIngest({ db, store: mem.store })
      .ingestFile({
        tmpPath: await upload(ASCII_STL),
        originalName: "Clip.stl",
        target: "new",
        duplicates: "skip",
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DuplicateFile);
    expect((error as DuplicateFile).duplicates).toEqual([LIVE_ROW]);
    expect(mem.puts()).toBe(0);
    expect(sent).not.toContain("begin");
    // The lookup asks for the upload's own SHA-256.
    expect(sent.filter(isLookup)).toHaveLength(1);
  });

  test("skip: a copy that landed during the upload is caught in the transaction, and its objects deleted", async () => {
    let lookups = 0;
    const { db, sent } = scriptedDb((sql) => {
      if (/pg_current_xact_id/.test(sql)) return { rows: [{ xid: "4242" }] };
      if (isLookup(sql)) {
        lookups += 1;
        return { rows: lookups === 1 ? [] : [LIVE_ROW] };
      }
      return { rows: [] };
    });
    const mem = memoryStore();
    const error = await createIngest({ db, store: mem.store })
      .ingestFile({
        tmpPath: await upload(ASCII_STL),
        originalName: "Clip.stl",
        target: "new",
        duplicates: "skip",
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DuplicateFile);
    expect(mem.puts()).toBe(1);
    expect(mem.held.size).toBe(0);
    // Under a lock on the hash, taken before the second lookup.
    const lock = sent.findIndex((s) => /pg_advisory_xact_lock/.test(s) && /sha256/.test(s));
    const second = sent.findIndex((s, i) => i > lock && isLookup(s));
    expect(lock).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(lock);
    expect(sent).toContain("rollback");
    expect(sent).not.toContain("commit");
  });

  test("allow: nothing is looked up before the upload, and the copies found are returned", async () => {
    const { db, sent } = scriptedDb((sql) => {
      if (/pg_current_xact_id/.test(sql)) return { rows: [{ xid: "4242" }] };
      if (isLookup(sql)) return { rows: [LIVE_ROW] };
      return { rows: [{}] };
    });
    const mem = memoryStore();
    const result = await createIngest({ db, store: mem.store }).ingestFile({
      tmpPath: await upload(ASCII_STL),
      originalName: "Clip.stl",
      target: "new",
    });
    expect(result.duplicates).toEqual([LIVE_ROW]);
    expect(sent.indexOf("begin")).toBeLessThan(sent.findIndex(isLookup));
    expect(sent.some((s) => /pg_advisory_xact_lock/.test(s) && /sha256/.test(s))).toBe(false);
    expect(sent).toContain("commit");
  });
});

describe("ingest's advisory locks and names", () => {
  const lockOf = (sent: string[], params: Array<readonly unknown[]>, like: RegExp) => {
    const at = sent.findIndex((s) => /pg_advisory_xact_lock/.test(s) && like.test(s));
    return { sql: sent[at], params: params[at] };
  };

  test("the hash lock is the two-argument form, with the namespace first", async () => {
    const { db, sent, params } = scriptedDb((sql) => {
      if (/pg_current_xact_id/.test(sql)) return { rows: [{ xid: "4242" }] };
      return { rows: [] };
    });
    await createIngest({ db, store: memoryStore().store })
      .ingestFile({
        tmpPath: await upload(ASCII_STL),
        originalName: "Clip.stl",
        target: "new",
        duplicates: "skip",
      })
      .catch(() => undefined);
    const lock = lockOf(sent, params, /sha256/);
    expect(lock.sql).toMatch(/pg_advisory_xact_lock\(\$\d+::int, hashtext\(/);
    expect(lock.params?.[0]).toBe(INGEST_LOCK_NAMESPACE);
  });

  test("the batch lock is the two-argument form, with the namespace first", async () => {
    const { db, sent, params } = scriptedDb((sql) => {
      if (/pg_current_xact_id/.test(sql)) return { rows: [{ xid: "4242" }] };
      return { rows: [{}] };
    });
    await createIngest({ db, store: memoryStore().store })
      .ingestFile({
        tmpPath: await upload(ASCII_STL),
        originalName: "Clip.stl",
        target: { batch: "b-1", combine: true },
      })
      .catch(() => undefined);
    const lock = lockOf(sent, params, /hashtext\(\$\d+\)/);
    expect(lock.sql).toMatch(/pg_advisory_xact_lock\(\$\d+::int, hashtext\(/);
    expect(lock.params?.[0]).toBe(INGEST_LOCK_NAMESPACE);
  });

  test("a name with format characters is stored without them (U+202E, U+200B), joiners kept", async () => {
    const rlo = String.fromCodePoint(0x202e);
    const zwsp = String.fromCodePoint(0x200b);
    const zwnj = String.fromCodePoint(0x200c);
    const { db, params } = scriptedDb((sql) => {
      if (/pg_current_xact_id/.test(sql)) return { rows: [{ xid: "4242" }] };
      return { rows: [{}] };
    });
    await createIngest({ db, store: memoryStore().store }).ingestFile({
      tmpPath: await upload(ASCII_STL),
      originalName: `Cl${rlo}ip${zwsp}${zwnj}x.stl`,
      target: "new",
    });
    const sentText = params.flat().filter((p): p is string => typeof p === "string");
    expect(sentText).toContain(`Clip${zwnj}x.stl`);
    expect(sentText.some((p) => p.includes(rlo) || p.includes(zwsp))).toBe(false);
  });
});
