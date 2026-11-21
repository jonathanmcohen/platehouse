// How a failed ingest reports what it saved (build plan Tasks 8 and 9). The
// upload's HEAD answers by it (uploads/tus.ts): an IngestError means nothing
// was saved, so HEAD answers 410 and the same file can be sent again;
// IngestOutcomeUnknown means the commit may have landed, so HEAD answers
// finished and a resend makes no second model. Every failure where ingest
// knows nothing was committed must therefore be an IngestError, a database
// that cannot be reached when ingest starts included, and only a commit whose
// outcome the database cannot report may be IngestOutcomeUnknown.
//
// Kysely runs the transaction's callback and only then sends COMMIT; a
// callback that throws is rolled back. So a failure that arrives before the
// callback has finished cannot have committed, whatever the status lookup
// says, and only a failure after it finished (at COMMIT) can leave the
// outcome unknown (#76). The objects behind a COMMIT that may still land are
// never deleted (#57).
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
 * to throw), given the statement and its parameters, or, with answer null,
 * one that refuses every connection. With failCommit, every query succeeds
 * as answered but COMMIT loses the connection.
 */
function scriptedDb(
  answer: ((sql: string, parameters: readonly unknown[]) => QueryResult<unknown> | Error) | null,
  { failCommit = false } = {},
): Kysely<DB> {
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      const result = answer?.(query.sql, query.parameters) ?? new Error("no answer");
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
    async commitTransaction() {
      if (failCommit) throw new Error("Connection terminated unexpectedly");
    },
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

/** The status lookup's answer: status, or a failure when status is undefined. */
function statusAnswer(status: string | null | undefined): QueryResult<unknown> | Error {
  return status === undefined ? new Error("Connection refused") : { rows: [{ status }] };
}

/**
 * A transaction that gets its id and then loses its connection on its next
 * query, inside the callback and so before any COMMIT: the read of the id is
 * answered, every later query fails, and the status lookup gets status (or
 * fails too, with status undefined).
 */
function lostAfterXid(status?: string | null) {
  return scriptedDb((sql) => {
    if (/pg_current_xact_id/.test(sql)) return { rows: [{ xid: "4242" }] };
    if (/pg_xact_status/.test(sql)) return statusAnswer(status);
    return new Error("Connection terminated unexpectedly");
  });
}

/**
 * A transaction that writes its first rows and loses its connection at the
 * query matching failAt, still inside the callback. Every other query gets
 * one empty row, and the status lookup gets status (or fails, with status
 * undefined).
 */
function lostAt(failAt: RegExp, status?: string | null) {
  return scriptedDb((sql) => {
    if (/pg_current_xact_id/.test(sql)) return { rows: [{ xid: "4242" }] };
    if (/pg_xact_status/.test(sql)) return statusAnswer(status);
    if (failAt.test(sql)) return new Error("Connection terminated unexpectedly");
    return { rows: [{}] };
  });
}

/**
 * A transaction whose callback finishes, every row written, and whose COMMIT
 * then loses the connection: the status lookup gets status (or fails, with
 * status undefined).
 */
function lostAtCommit(status?: string | null) {
  return scriptedDb(
    (sql) => {
      if (/pg_current_xact_id/.test(sql)) return { rows: [{ xid: "4242" }] };
      if (/pg_xact_status/.test(sql)) return statusAnswer(status);
      return { rows: [{}] };
    },
    { failCommit: true },
  );
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

describe("a failure before the transaction's callback finished saved nothing, whatever the lookup says", () => {
  // Postgres restarting mid-insert, say: the query fails, and the lookup
  // cannot answer either, or answers "in progress" because the server has
  // not yet noticed the dropped socket. No COMMIT was sent, so the objects
  // go and HEAD answers 410 (#76).
  const statuses = [
    ["cannot be read", undefined],
    ["is still in progress", "in progress"],
    ["is null", null],
    ["says committed", "committed"],
  ] as const;

  test.each(statuses)(
    "a connection lost on the first row, when the status %s",
    async (_label, status) => {
      const { store, held } = memoryStore();
      const error = await failure(
        createIngest({ db: lostAfterXid(status), store }).ingestFile({
          tmpPath: await upload(ASCII_STL),
          originalName: "Lost on the first row.stl",
          target: "new",
        }),
      );
      expectNothingSaved(error, "Connection terminated unexpectedly");
      expect(held.size).toBe(0);
    },
  );

  test.each(statuses)(
    "a connection lost on the file row, the callback's last query, when the status %s",
    async (_label, status) => {
      const { store, held } = memoryStore();
      const error = await failure(
        createIngest({ db: lostAt(/insert into "files"/, status), store }).ingestFile({
          tmpPath: await upload(ASCII_STL),
          originalName: "Lost on the file row.stl",
          target: "new",
        }),
      );
      expectNothingSaved(error, "Connection terminated unexpectedly");
      expect(held.size).toBe(0);
    },
  );

  test("a model trashed while the bytes were uploading, when the status cannot be read", async () => {
    // The check inside the transaction finds no live model and ingest's
    // own IngestError stops the callback.
    const { store, held } = memoryStore();
    const db = scriptedDb((sql) => {
      if (/pg_current_xact_id/.test(sql)) return { rows: [{ xid: "4242" }] };
      if (/pg_xact_status/.test(sql)) return new Error("Connection refused");
      if (/for update/.test(sql)) return { rows: [] };
      return { rows: [{}] };
    });
    const error = await failure(
      createIngest({ db, store }).ingestFile({
        tmpPath: await upload(ASCII_STL),
        originalName: "Trashed meanwhile.stl",
        target: { modelId: uuidv7() },
      }),
    );
    expect(error).toBeInstanceOf(IngestError);
    expect((error as IngestError).code).toBe("model_not_found");
    expect(held.size).toBe(0);
  });
});

describe("only a commit whose outcome is not known is IngestOutcomeUnknown", () => {
  // The callback finished (here through its early return, as for every file
  // with no plate data) and the error came at COMMIT, so the status lookup
  // decides. The .3mf path through the callback's last line is covered
  // against a real Postgres in test/integration/ingest/ingest.test.ts.
  test.each([
    ["cannot be read", undefined],
    ["is still in progress", "in progress"],
    ["is null", null],
  ])("a COMMIT whose status %s keeps its objects", async (_label, status) => {
    const { store, held } = memoryStore();
    const error = await failure(
      createIngest({ db: lostAtCommit(status), store }).ingestFile({
        tmpPath: await upload(ASCII_STL),
        originalName: "Unknown.stl",
        target: "new",
      }),
    );
    expect(error).toBeInstanceOf(IngestOutcomeUnknown);
    expect(error).not.toBeInstanceOf(IngestError);
    expect(((error as Error).cause as Error).message).toBe("Connection terminated unexpectedly");
    // Kept: the commit may have landed or may still land, and the orphan
    // sweep removes them if no row ever points at them (#57).
    expect(held.size).toBe(1);
  });

  test("a COMMIT Postgres reports as committed is the stored upload", async () => {
    const { store, held } = memoryStore();
    const result = await createIngest({ db: lostAtCommit("committed"), store }).ingestFile({
      tmpPath: await upload(ASCII_STL),
      originalName: "Committed.stl",
      target: "new",
    });
    expect(result.modelId).toMatch(/^[0-9a-f-]{36}$/);
    expect(held.size).toBe(1);
  });

  test("a COMMIT Postgres reports as aborted saved nothing", async () => {
    const { store, held } = memoryStore();
    const error = await failure(
      createIngest({ db: lostAtCommit("aborted"), store }).ingestFile({
        tmpPath: await upload(ASCII_STL),
        originalName: "Commit aborted.stl",
        target: "new",
      }),
    );
    expectNothingSaved(error, "Connection terminated unexpectedly");
    expect(held.size).toBe(0);
  });
});

describe("a file id the caller chooses", () => {
  // The inbox watcher (inbox/watch.ts) chooses the id so that, after a lost
  // answer, it can look up its own row and no other.
  test("is the file row's id and the id ingest answers with", async () => {
    const chosen = uuidv7();
    const inserts: unknown[][] = [];
    const db = scriptedDb((sql, parameters) => {
      if (/pg_current_xact_id/.test(sql)) return { rows: [{ xid: "4242" }] };
      if (/insert into "files"/.test(sql)) inserts.push([...parameters]);
      return { rows: [{}] };
    });
    const { store } = memoryStore();
    const result = await createIngest({ db, store }).ingestFile({
      tmpPath: await upload(ASCII_STL),
      originalName: "Chosen.stl",
      target: "new",
      fileId: chosen,
    });
    expect(result.fileId).toBe(chosen);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.[0]).toBe(chosen);
  });

  test("is the id answered when the commit's answer was lost but it committed", async () => {
    const chosen = uuidv7();
    const { store } = memoryStore();
    const result = await createIngest({ db: lostAtCommit("committed"), store }).ingestFile({
      tmpPath: await upload(ASCII_STL),
      originalName: "Chosen committed.stl",
      target: "new",
      fileId: chosen,
    });
    expect(result.fileId).toBe(chosen);
  });

  test("that is not a UUID is refused before anything is stored", async () => {
    const { store, held } = memoryStore();
    const error = await failure(
      createIngest({ db: lostAtCommit("committed"), store }).ingestFile({
        tmpPath: await upload(ASCII_STL),
        originalName: "Bad id.stl",
        target: "new",
        fileId: "not-a-uuid",
      }),
    );
    expect(error).toBeInstanceOf(IngestError);
    expect((error as IngestError).code).toBe("ingest_failed");
    expect((error as IngestError).cause).toBeInstanceOf(TypeError);
    expect(held.size).toBe(0);
  });
});
