// How a failed ingest reports what it saved (build plan Tasks 8 and 9). The
// upload's HEAD answers by it (uploads/tus.ts): an IngestError means nothing
// was saved, so HEAD answers 410 and the same file can be sent again;
// IngestOutcomeUnknown means the commit may have landed, so HEAD answers
// finished and a resend makes no second model. Every failure where ingest
// knows nothing was committed must therefore be an IngestError, a database
// that cannot be reached when ingest starts included, and only a commit whose
// outcome the database cannot report may be IngestOutcomeUnknown.
//
// These run without Docker: the database is a Kysely whose driver answers
// from a script, and the store is held in memory. The same cases against a
// real Postgres and S3 are in test/integration/ingest/ingest.test.ts.
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
import { uuidv7 } from "../../src/db/ids.js";
import type { DB } from "../../src/db/types.js";
import {
  createIngest,
  INGEST_FAILED_MESSAGE,
  IngestError,
  IngestOutcomeUnknown,
  type IngestStore,
} from "../../src/ingest/ingest.js";

const ASCII_STL =
  "solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "platehouse-ingest-outcome-"));
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

/** A store held in memory: the keys it holds, and every key deleted. */
function memoryStore() {
  const held = new Set<string>();
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
      return { sha256: hash.digest(), size };
    },
    async deleteBlobs(keys) {
      for (const key of keys) held.delete(key);
    },
  };
  return { store, held };
}

/**
 * A database whose every query is answered by answer (a result, or an error
 * to throw), or, with answer null, one that refuses every connection.
 */
function scriptedDb(answer: ((sql: string) => QueryResult<unknown> | Error) | null): Kysely<DB> {
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      const result = answer?.(query.sql) ?? new Error("no answer");
      if (result instanceof Error) throw result;
      return result as QueryResult<R>;
    },
    streamQuery(): never {
      throw new Error("streamQuery is not scripted");
    },
  };
  const driver: Driver = {
    async init() {},
    async acquireConnection() {
      if (answer === null) throw new Error("Connection refused");
      return connection;
    },
    async beginTransaction() {},
    async commitTransaction() {},
    async rollbackTransaction() {},
    async releaseConnection() {},
    async destroy() {},
  };
  return new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

/**
 * A transaction that gets its id and then loses its connection: the read of
 * the id is answered, every later query fails, and the status lookup gets
 * status (or fails too, with status undefined).
 */
function lostAfterXid(status?: string | null) {
  return scriptedDb((sql) => {
    if (/pg_current_xact_id/.test(sql)) return { rows: [{ xid: "4242" }] };
    if (/pg_xact_status/.test(sql) && status !== undefined) return { rows: [{ status }] };
    return new Error("Connection terminated unexpectedly");
  });
}

async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("ingest succeeded");
    },
    (e: unknown) => e,
  );
}

function expectNothingSaved(error: unknown, cause: string): void {
  expect(error).toBeInstanceOf(IngestError);
  expect((error as IngestError).code).toBe("ingest_failed");
  expect((error as IngestError).message).toBe(INGEST_FAILED_MESSAGE);
  expect(((error as IngestError).cause as Error).message).toBe(cause);
}

describe("a failure ingest knows saved nothing is an IngestError", () => {
  test("a database that cannot be reached when ingest starts", async () => {
    // The target model's check is the first query, before any byte is put
    // (postgres restarting under Watchtower, say).
    const { store, held } = memoryStore();
    const error = await failure(
      createIngest({ db: scriptedDb(null), store }).ingestFile({
        tmpPath: await upload(ASCII_STL),
        originalName: "Down at start.stl",
        target: { modelId: uuidv7() },
      }),
    );
    expectNothingSaved(error, "Connection refused");
    expect(held.size).toBe(0);
  });

  test("a database that cannot be reached at BEGIN, after the bytes were put", async () => {
    const { store, held } = memoryStore();
    const error = await failure(
      createIngest({ db: scriptedDb(null), store }).ingestFile({
        tmpPath: await upload(ASCII_STL),
        originalName: "Down at begin.stl",
        target: "new",
      }),
    );
    expectNothingSaved(error, "Connection refused");
    // The source object was put and then deleted.
    expect(held.size).toBe(0);
  });

  test("a transaction Postgres reports as aborted", async () => {
    const { store, held } = memoryStore();
    const error = await failure(
      createIngest({ db: lostAfterXid("aborted"), store }).ingestFile({
        tmpPath: await upload(ASCII_STL),
        originalName: "Aborted.stl",
        target: "new",
      }),
    );
    expectNothingSaved(error, "Connection terminated unexpectedly");
    expect(held.size).toBe(0);
  });

  test("an upload whose temp file cannot be read", async () => {
    const { store, held } = memoryStore();
    const error = await failure(
      createIngest({ db: scriptedDb(null), store }).ingestFile({
        tmpPath: join(dir, "missing.tmp"),
        originalName: "Missing.stl",
        target: "new",
      }),
    );
    expect(error).toBeInstanceOf(IngestError);
    expect((error as IngestError).code).toBe("ingest_failed");
    expect(((error as IngestError).cause as { code?: string }).code).toBe("ENOENT");
    expect(held.size).toBe(0);
  });

  test("its message promises nothing was saved and names no internal detail", () => {
    expect(INGEST_FAILED_MESSAGE).toMatch(/nothing was saved/);
    expect(INGEST_FAILED_MESSAGE).not.toMatch(/connection|postgres|database|ENOENT/i);
  });
});

describe("only a commit whose outcome is not known is IngestOutcomeUnknown", () => {
  test.each([
    ["cannot be read", undefined],
    ["is still in progress", "in progress"],
    ["is null", null],
  ])("a transaction whose status %s keeps its objects", async (_label, status) => {
    const { store, held } = memoryStore();
    const error = await failure(
      createIngest({ db: lostAfterXid(status), store }).ingestFile({
        tmpPath: await upload(ASCII_STL),
        originalName: "Unknown.stl",
        target: "new",
      }),
    );
    expect(error).toBeInstanceOf(IngestOutcomeUnknown);
    expect(error).not.toBeInstanceOf(IngestError);
    expect(((error as Error).cause as Error).message).toBe("Connection terminated unexpectedly");
    // Kept: the commit may have landed, and the orphan sweep removes them
    // if no row ever points at them.
    expect(held.size).toBe(1);
  });
});
