// The library's numbered pages (GET /app/api/library?page=), the arithmetic
// alone: which slice of the matches a page is, how many pages there are, and
// what a page past the end or a bad page size becomes; and, against a
// scripted database that records its SQL, which columns a numbered page's
// ranked read asks for. The database side (filters, trash, the total) is in
// test/integration/app-api/library.test.ts.
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
import {
  createAppLibrary,
  LIBRARY_PAGE_SIZE,
  MAX_PAGE_NUMBER,
  PAGED_MATCH_CAP,
  pageSizeFor,
  pageWindow,
} from "../../src/app-api/library.js";
import type { DB } from "../../src/db/types.js";
import { modelsRepo } from "../../src/repos/models.js";

/**
 * A database, built as the server builds its own (CamelCasePlugin), that
 * answers every query with no rows, or a count of 0, and records its SQL.
 */
function recordingDb(statements: string[]): Kysely<DB> {
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      statements.push(query.sql);
      const rows = /count\(\*\)/i.test(query.sql) ? [{ n: "0" }] : [];
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
  return new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    plugins: [new CamelCasePlugin()],
  });
}

describe("pageWindow", () => {
  test("page 1 of 171 models at 48 a page is the first 48, of 4 pages", () => {
    expect(pageWindow({ total: 171, pageSize: 48, page: 1 })).toEqual({
      page: 1,
      pageCount: 4,
      start: 0,
      end: 48,
    });
  });

  test("the last page holds the remainder", () => {
    expect(pageWindow({ total: 171, pageSize: 48, page: 4 })).toEqual({
      page: 4,
      pageCount: 4,
      start: 144,
      end: 171,
    });
  });

  test("a page past the end is the last page, never an empty one", () => {
    expect(pageWindow({ total: 171, pageSize: 48, page: 9 })).toEqual({
      page: 4,
      pageCount: 4,
      start: 144,
      end: 171,
    });
  });

  test("a total that fills its pages exactly has no extra empty page", () => {
    expect(pageWindow({ total: 96, pageSize: 48, page: 3 })).toEqual({
      page: 2,
      pageCount: 2,
      start: 48,
      end: 96,
    });
  });

  test("no matches is one empty page 1", () => {
    expect(pageWindow({ total: 0, pageSize: 48, page: 5 })).toEqual({
      page: 1,
      pageCount: 1,
      start: 0,
      end: 0,
    });
  });

  test("a page below 1 or not a whole number is page 1, or rounded down", () => {
    expect(pageWindow({ total: 171, pageSize: 48, page: 0 }).page).toBe(1);
    expect(pageWindow({ total: 171, pageSize: 48, page: -3 }).page).toBe(1);
    expect(pageWindow({ total: 171, pageSize: 48, page: 2.7 }).page).toBe(2);
    expect(pageWindow({ total: 171, pageSize: 48, page: Number.NaN }).page).toBe(1);
  });
});

describe("pageSizeFor", () => {
  test("defaults to the library's 48 and stays within 1 to 200", () => {
    expect(LIBRARY_PAGE_SIZE).toBe(48);
    expect(pageSizeFor(undefined)).toBe(48);
    expect(pageSizeFor(200)).toBe(200);
    expect(pageSizeFor(500)).toBe(200);
    expect(pageSizeFor(0)).toBe(1);
    expect(pageSizeFor(12.9)).toBe(12);
  });
});

test("the paged match cap is searchRanked's own most, 1000", () => {
  // One ranked query reads at most this many matches per request; the
  // library's numbered pages and View all stop there and say so.
  expect(PAGED_MATCH_CAP).toBe(1000);
});

test("the highest page the route accepts is 1,000,000, the web app's PAGE_MAX", () => {
  // apps/web/src/library/paging.ts asks for at most this page, so a hand-typed
  // ?page= past it shows the last page instead of a 400.
  expect(MAX_PAGE_NUMBER).toBe(1_000_000);
});

describe("a numbered page's ranked read", () => {
  const ctx = { printerId: "", orcaVersion: null, printers: [] };

  test("asks for id, name, creator and rank only, never the description", async () => {
    const statements: string[] = [];
    const library = createAppLibrary({
      db: recordingDb(statements),
      displayContext: async () => ctx,
      plateNumbersMany: async () => new Map(),
    });
    await library.list({ q: "benchy", page: 1 });
    const ranked = statements.filter((sql) => /similarity\(/.test(sql));
    expect(ranked).toHaveLength(1);
    const columns = ranked[0]?.slice(0, ranked[0].indexOf(` from "models"`)) ?? "";
    expect(columns).toMatch(/"models"\."id"/);
    expect(columns).toMatch(/"models"\."name"/);
    expect(columns).toMatch(/"creators"\."name" as "creator"/);
    expect(columns).toMatch(/as "rank"/);
    // The rank expression reads models.caption itself, unquoted; a selected column is quoted.
    expect(columns).not.toMatch(
      /"models"\."(?:description_md|caption|creator_id|license_spdx|license_note|external_ref|trashed_at|created_at|updated_at)"/,
    );
  });

  test("searchRanked, which the cursor pages read, still returns whole models", async () => {
    const statements: string[] = [];
    await modelsRepo(recordingDb(statements)).searchRanked({ q: "benchy", limit: 10 });
    expect(statements[0]).toMatch(/"models"\."description_md"/);
    expect(statements[0]).toMatch(/as "rank"/);
  });
});
