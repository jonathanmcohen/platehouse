// The library's sort (Jon, 2026-11-19), the parts that need no database:
// the sort names and their default, which printer the time and weight sorts
// total for, what the numbered page's read orders by (against a scripted
// database that records its SQL), and what the route refuses. The database
// side (ties across pages, models without numbers last, the totals matching
// the cards) is in test/integration/app-api/library-sort.test.ts.
import type { Printer } from "@platehouse/slicer-contract";
import Fastify from "fastify";
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
  type AppLibrary,
  type AppLibraryPages,
  createAppLibrary,
  emptyAppLibrary,
  InvalidSortQuery,
  registerLibraryApi,
  sortPrinterFor,
} from "../../src/app-api/library.js";
import type { DB } from "../../src/db/types.js";
import { defaultSort, LIBRARY_SORTS, modelsRepo } from "../../src/repos/models.js";

/** A database that answers every query with no rows, or a count of 0, and records its SQL. */
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

const P1S: Printer = {
  id: "Bambu Lab P1S 0.4 nozzle",
  model: "Bambu Lab P1S",
  modelId: "C12",
  nozzle: 0.4,
};
const X1C: Printer = {
  id: "Bambu Lab X1 Carbon 0.4 nozzle",
  model: "Bambu Lab X1 Carbon",
  modelId: "BL-P001",
  nozzle: 0.4,
};

/**
 * The top-level ORDER BY of the one ranked read in statements: the part after
 * the "order by" outside every parenthesis (the time, weight and plate count
 * sorts order by subqueries that have their own).
 */
function orderOf(statements: string[]): string {
  const ranked = statements.filter((s) => /similarity\(/.test(s));
  expect(ranked).toHaveLength(1);
  const sql = ranked[0] ?? "";
  let depth = 0;
  let at = -1;
  for (let i = 0; i < sql.length; i += 1) {
    if (sql[i] === "(") depth += 1;
    else if (sql[i] === ")") depth -= 1;
    else if (depth === 0 && sql.startsWith(" order by ", i)) at = i;
  }
  expect(at, sql).toBeGreaterThan(-1);
  return sql.slice(at + " order by ".length).replace(/\s+/g, " ");
}

describe("the sort names", () => {
  test("are the eleven the library offers, best match first", () => {
    expect(LIBRARY_SORTS).toEqual([
      "relevance",
      "newest",
      "oldest",
      "name-asc",
      "name-desc",
      "time-asc",
      "time-desc",
      "weight-asc",
      "weight-desc",
      "plates-desc",
      "plates-asc",
    ]);
  });

  test("the default is best match while a search is active, else newest", () => {
    expect(defaultSort("benchy")).toBe("relevance");
    expect(defaultSort("  hook ")).toBe("relevance");
    expect(defaultSort("")).toBe("newest");
    expect(defaultSort("   ")).toBe("newest");
    expect(defaultSort(undefined)).toBe("newest");
  });
});

describe("sortPrinterFor: which numbers a time or weight sort totals", () => {
  test("the selected printer's id and Orca version, and its BBL model id and nozzle for file numbers", () => {
    expect(
      sortPrinterFor({ printerId: P1S.id, orcaVersion: "2.5.0", printers: [P1S, X1C] }),
    ).toEqual({
      printerId: P1S.id,
      orcaVersion: "2.5.0",
      fileModelId: "C12",
      fileNozzle: 0.4,
      fileNumbersCount: true,
    });
  });

  test("with the menu unread the file's own numbers cannot match, as on the cards", () => {
    expect(sortPrinterFor({ printerId: P1S.id, orcaVersion: null, printers: [] })).toEqual({
      printerId: P1S.id,
      orcaVersion: null,
      fileModelId: null,
      fileNozzle: null,
      fileNumbersCount: false,
    });
  });

  test("a selected printer the menu names after another with the same model and nozzle gets no file numbers", () => {
    // The cards label a file's numbers with the first menu printer of that
    // model and nozzle, so a second one never gets them (numbersFor), and
    // plateNumbers still returns early for them, so no estimate stands in.
    const twin: Printer = { ...P1S, id: "Bambu Lab P1S 0.4 nozzle (copy)" };
    expect(
      sortPrinterFor({ printerId: twin.id, orcaVersion: "2.5.0", printers: [P1S, twin] }),
    ).toMatchObject({ fileModelId: "C12", fileNozzle: 0.4, fileNumbersCount: false });
  });
});

describe("a numbered page's read is ordered in the database", () => {
  const ctx = { printerId: P1S.id, orcaVersion: "2.5.0", printers: [P1S, X1C] };

  async function order(query: Parameters<AppLibrary["list"]>[0]) {
    const statements: string[] = [];
    const library = createAppLibrary({
      db: recordingDb(statements),
      displayContext: async () => ctx,
      plateNumbers: async () => ({}),
    });
    const answer = (await library.list(query)) as AppLibraryPages;
    return { order: orderOf(statements), answer, statements };
  }

  test("no search and no sort: newest first, the id breaking ties", async () => {
    const { order: by, answer } = await order({ page: 1 });
    expect(by).toMatch(/^"models"\."created_at" desc, "models"\."id" desc limit/);
    expect(answer.sort).toBe("newest");
  });

  test("a search and no sort: best match first, as before", async () => {
    const { order: by, answer } = await order({ q: "benchy", page: 1 });
    expect(by).toMatch(/desc, "models"\."name", "models"\."id" limit/);
    expect(answer.sort).toBe("relevance");
  });

  test("oldest, and name A to Z and Z to A ignoring case, each with the id last", async () => {
    expect((await order({ page: 1, sort: "oldest" })).order).toMatch(
      /^"models"\."created_at" asc, "models"\."id" asc limit/,
    );
    expect((await order({ page: 1, sort: "name-asc" })).order).toMatch(
      /^lower\(models\.name\) asc, "models"\."name" asc, "models"\."id" asc limit/,
    );
    expect((await order({ page: 1, sort: "name-desc" })).order).toMatch(
      /^lower\(models\.name\) desc, "models"\."name" desc, "models"\."id" desc limit/,
    );
  });

  test("a sort the page names wins over the search's best match", async () => {
    const { order: by, answer } = await order({ q: "benchy", page: 1, sort: "name-asc" });
    expect(by).toMatch(/^lower\(models\.name\)/);
    expect(answer.sort).toBe("name-asc");
  });

  test("time and weight total the plates for the selected printer, models without numbers last", async () => {
    for (const [sort, column, dir] of [
      ["time-asc", "time_seconds", "asc"],
      ["time-desc", "time_seconds", "desc"],
      ["weight-asc", "weight_grams", "asc"],
      ["weight-desc", "weight_grams", "desc"],
    ] as const) {
      const { order: by, statements } = await order({ page: 1, sort });
      expect(by, sort).toContain(`${dir} nulls last`);
      expect(by, sort).toContain(column);
      expect(by, sort).toMatch(/lower\(models\.name\) asc, "models"\."id" asc limit/);
      // Both sources of a plate's numbers are read: the file's own and Platehouse's.
      expect(by, sort).toContain("'file'");
      expect(by, sort).toContain("'platehouse'");
      expect(statements.join("\n"), sort).not.toMatch(/insert|update|delete/i);
    }
  });

  test("plate count, most or fewest first, ties by name and id", async () => {
    const most = (await order({ page: 1, sort: "plates-desc" })).order;
    expect(most).toContain("count(*)");
    expect(most).toMatch(/desc, lower\(models\.name\) asc, "models"\."id" asc limit/);
    const fewest = (await order({ page: 1, sort: "plates-asc" })).order;
    expect(fewest).toMatch(/asc, lower\(models\.name\) asc, "models"\."id" asc limit/);
  });

  test("one read per page, whatever the sort", async () => {
    for (const sort of LIBRARY_SORTS) {
      const { statements } = await order({ page: 1, sort });
      expect(
        statements.filter((s) => /similarity\(/.test(s)),
        sort,
      ).toHaveLength(1);
    }
  });

  test("a sort other than best match is for numbered pages only", async () => {
    const library = createAppLibrary({
      db: recordingDb([]),
      displayContext: async () => ctx,
      plateNumbers: async () => ({}),
    });
    await expect(library.list({ sort: "name-asc" })).rejects.toBeInstanceOf(InvalidSortQuery);
    await expect(library.list({ sort: "relevance" })).resolves.toMatchObject({ models: [] });
  });

  test("searchRanked, which the cursor pages and the API read, refuses any other sort with a cursor", async () => {
    const repo = modelsRepo(recordingDb([]));
    await expect(
      repo.searchRankedCards({
        q: "",
        sort: "newest",
        after: { rank: 0, name: "a", id: "0198f0c4-0000-7000-8000-000000000001" },
        limit: 5,
      }),
    ).rejects.toThrow(RangeError);
  });

  test("a time or weight sort without the printer is refused, never ordered by nothing", async () => {
    const repo = modelsRepo(recordingDb([]));
    await expect(repo.searchRankedCards({ q: "", sort: "time-asc", limit: 5 })).rejects.toThrow(
      RangeError,
    );
  });

  test("the cards read takes up to 1001 rows, one past the cap; searchRanked still stops at 1000", async () => {
    const repo = modelsRepo(recordingDb([]));
    await expect(repo.searchRankedCards({ q: "", limit: 1001 })).resolves.toEqual([]);
    await expect(repo.searchRankedCards({ q: "", limit: 1002 })).rejects.toThrow(RangeError);
    await expect(repo.searchRanked({ q: "", limit: 1001 })).rejects.toThrow(RangeError);
  });
});

describe("the route", () => {
  async function app(library: AppLibrary = emptyAppLibrary) {
    const server = Fastify({ logger: false });
    await registerLibraryApi(server, library);
    await server.ready();
    return server;
  }

  test("refuses a sort it does not know with 400", async () => {
    const server = await app();
    const res = await server.inject({ url: "/app/api/library?page=1&sort=price" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "bad_request" });
  });

  test("passes a known sort through, and the answer names the sort served", async () => {
    let seen: unknown;
    const server = await app({
      ...emptyAppLibrary,
      list: async (query) => {
        seen = query.sort;
        return emptyAppLibrary.list(query);
      },
    });
    for (const sort of LIBRARY_SORTS) {
      const res = await server.inject({ url: `/app/api/library?page=1&sort=${sort}` });
      expect(res.statusCode, sort).toBe(200);
      expect(seen, sort).toBe(sort);
    }
  });

  test("a sort with a cursor page is 400", async () => {
    const server = await app({
      ...emptyAppLibrary,
      list: async () => {
        throw new InvalidSortQuery();
      },
    });
    const res = await server.inject({ url: "/app/api/library?sort=newest" });
    expect(res.statusCode).toBe(400);
  });

  test("an empty library's numbered page names the default sort", async () => {
    const server = await app();
    expect((await server.inject({ url: "/app/api/library?page=1" })).json()).toMatchObject({
      sort: "newest",
    });
    expect((await server.inject({ url: "/app/api/library?page=1&q=hook" })).json()).toMatchObject({
      sort: "relevance",
    });
  });
});
