// plateNumbersMany reads the numbers of any number of plates in two queries
// (the plates' estimates, then those estimates' filaments), never two per
// plate (issue #456). Run against a database that only records the queries
// it is sent, built as the server builds its own (CamelCasePlugin); that each
// plate gets the numbers plateNumbers gives it is pinned against Postgres in
// test/integration/estimates/plate-numbers-many.test.ts.
import {
  CamelCasePlugin,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from "kysely";
import { describe, expect, test } from "vitest";
import type { DB } from "../../src/db/types.js";
import {
  type DisplayContext,
  plateNumbers,
  plateNumbersMany,
} from "../../src/estimates/display.js";

const CTX: DisplayContext = { printerId: "P1S", orcaVersion: "2.3.1", printers: [] };
const CREATED = new Date("2026-11-19T10:00:00Z");

function uuid(n: number): string {
  return `01900000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** A database that answers every estimates query with rows, and records each query's SQL. */
function recordingDb(estimateRows: unknown[]) {
  const sent: string[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      sent.push(query.sql);
      const rows = /from "estimates"/.test(query.sql) ? estimateRows : [];
      return { rows } as QueryResult<R>;
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
    async beginTransaction() {},
    async commitTransaction() {},
    async rollbackTransaction() {},
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
    plugins: [new CamelCasePlugin()],
  });
  return { db, sent };
}

function estimateRow(plateId: string, id: string, status: "ok" | "failed") {
  return {
    plate_id: plateId,
    id,
    source: "file",
    printer_id: "P1S",
    printer_model_id: null,
    nozzle: null,
    slicer: null,
    slicer_version: null,
    process_profile: null,
    status,
    time_seconds: status === "ok" ? 600 : null,
    weight_grams: status === "ok" ? 12 : null,
    failure_reason: null,
    failure_detail: null,
    created_at: CREATED,
    finished_at: CREATED,
  };
}

describe("plateNumbersMany", () => {
  test("runs two queries for any number of plates", async () => {
    const plates = [uuid(1), uuid(2), uuid(3)];
    const { db, sent } = recordingDb([estimateRow(plates[0] as string, uuid(11), "ok")]);
    const numbers = await plateNumbersMany(db, CTX, plates);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain('from "estimates"');
    expect(sent[1]).toContain('from "estimate_filaments"');
    expect([...numbers.keys()]).toEqual(plates);
  });

  test("runs one query when no plate has an estimate", async () => {
    const { db, sent } = recordingDb([]);
    const numbers = await plateNumbersMany(db, CTX, [uuid(1), uuid(2)]);
    expect(sent).toHaveLength(1);
    expect(numbers.get(uuid(1))).toEqual({});
    expect(numbers.get(uuid(2))).toEqual({});
  });

  test("runs no query for no plates or for ids that are not UUIDs", async () => {
    const { db, sent } = recordingDb([]);
    expect((await plateNumbersMany(db, CTX, [])).size).toBe(0);
    const numbers = await plateNumbersMany(db, CTX, ["nope", "1"]);
    expect(sent).toEqual([]);
    expect(numbers.get("nope")).toEqual({});
    expect(numbers.get("1")).toEqual({});
  });

  test("plateNumbers is the one plate's entry of plateNumbersMany", async () => {
    const { db } = recordingDb([estimateRow(uuid(1), uuid(11), "ok")]);
    const one = await plateNumbers(db, CTX, uuid(1));
    const many = await plateNumbersMany(db, CTX, [uuid(1), uuid(2)]);
    expect(one.file).toBeDefined();
    expect(many.get(uuid(1))).toEqual(one);
    expect(many.get(uuid(2))).toEqual({});
  });
});
