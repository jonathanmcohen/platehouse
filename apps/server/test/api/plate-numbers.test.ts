// GET /api/v1/models/:id and GET /api/v1/files/:id carry every plate's
// numbers. Like the library page (app-api/library.ts), the API reads the
// display context (the settings row and the printer menu) once per request,
// never once per plate, and reads every plate's numbers in one call
// (plateNumbersMany), so a model with many plates neither sends the slicer
// one /v1/profiles request per plate nor queues a burst of queries on the
// pool, and every plate in one answer is shown for the same printer.
//
// Run against a scripted database built as the server builds its own
// (CamelCasePlugin), answering the model, its files and their plates with
// snake_case rows as Postgres would. Every id here is made up for the test.
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
import { createApiLibrary } from "../../src/api/v1.js";
import type { DB } from "../../src/db/types.js";
import type { DisplayContext, PlateNumbers } from "../../src/estimates/display.js";

const MODEL_ID = "01900000-0000-7000-8000-0000000000a1";
const BLOB_ID = "01900000-0000-7000-8000-0000000000a2";
const CREATED = new Date("2026-11-19T10:00:00Z");
const FILE_COUNT = 3;
const PLATES_PER_FILE = 6;

function uuid(n: number): string {
  return `01900000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
}

const FILES = Array.from({ length: FILE_COUNT }, (_, i) => ({
  id: uuid(0x100 + i),
  model_id: MODEL_ID,
  blob_id: BLOB_ID,
  name: `Part ${i + 1}`,
  original_name: `part-${i + 1}.3mf`,
  kind: "3mf",
  size: "1024",
  sha256: Buffer.alloc(32, 7),
  external_ref: null,
  parse_status: "ok",
  derived_status: null,
  derived_message: null,
  preview_status: null,
  preview_message: null,
  mesh_blob_id: null,
  render_stl_blob_id: null,
  render_png_blob_id: null,
  created_at: CREATED,
  updated_at: CREATED,
}));

const PLATES = FILES.flatMap((f, i) =>
  Array.from({ length: PLATES_PER_FILE }, (_, j) => ({
    id: uuid(0x1000 + i * 100 + j),
    file_id: f.id,
    index: j + 1,
    name: null,
    object_count: 1,
    thumbnail_blob_id: null,
  })),
);

const MODEL_ROW = {
  id: MODEL_ID,
  name: "Organiser",
  caption: null,
  description_md: null,
  creator_id: null,
  creator: null,
  license_spdx: null,
  license_note: null,
  external_ref: null,
  trashed_at: null,
  created_at: CREATED,
  updated_at: CREATED,
};

/**
 * A database that answers the model, its files and their plates (PLATES
 * unless given); no tags or collections.
 */
function scriptedDb(plates: readonly (typeof PLATES)[number][] = PLATES): Kysely<DB> {
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      const from = /\bfrom "([a-z_]+)"/.exec(query.sql)?.[1];
      let rows: unknown[] = [];
      if (from === "models") rows = [MODEL_ROW];
      else if (from === "files") {
        const byId = /"id" = \$1/.test(query.sql);
        rows = byId ? FILES.filter((f) => f.id === query.parameters[0]) : FILES;
      } else if (from === "plates") {
        rows = plates.filter((p) => query.parameters.includes(p.file_id));
      }
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

const unusedStore = {
  getBlobStream: async () => {
    throw new Error("not used");
  },
  headBlob: async () => {
    throw new Error("not used");
  },
};

/** An API library whose context and plate lookups are counted; its files have PLATES unless given. */
function countedLibrary(plates: readonly (typeof PLATES)[number][] = PLATES) {
  const seen = {
    contexts: 0,
    calls: [] as string[][],
    printers: new Set<string>(),
  };
  let reads = 0;
  const library = createApiLibrary({
    db: scriptedDb(plates),
    store: unusedStore,
    async displayContext(): Promise<DisplayContext> {
      seen.contexts += 1;
      reads += 1;
      // A second read would see the default printer changed meanwhile.
      return { printerId: reads === 1 ? "P1S" : "X1C", orcaVersion: "2.3.1", printers: [] };
    },
    async plateNumbersMany(
      ctx: DisplayContext,
      plateIds: readonly string[],
    ): Promise<Map<string, PlateNumbers>> {
      seen.calls.push([...plateIds]);
      seen.printers.add(ctx.printerId);
      return new Map(
        plateIds.map((plateId) => [
          plateId,
          { [ctx.printerId]: { plateId } } as unknown as PlateNumbers,
        ]),
      );
    },
  });
  return { library, seen };
}

describe("the Public API v1's plate numbers", () => {
  test("a model reads the display context once and looks up its plates in one call", async () => {
    const { library, seen } = countedLibrary();
    const model = await library.getModel(MODEL_ID);
    expect(model?.files).toHaveLength(FILE_COUNT);
    expect(seen.calls).toEqual([PLATES.map((p) => p.id)]);
    expect(seen.contexts).toBe(1);
    expect([...seen.printers]).toEqual(["P1S"]);
  });

  test("each plate keeps its own numbers, in plate order", async () => {
    const { library } = countedLibrary();
    const model = await library.getModel(MODEL_ID);
    for (const file of model?.files ?? []) {
      expect(file.plates.map((p) => p.index)).toEqual(
        Array.from({ length: PLATES_PER_FILE }, (_, j) => j + 1),
      );
      for (const plate of file.plates) {
        expect(plate.numbers).toEqual({ P1S: { plateId: plate.id } });
      }
    }
  });

  test("a file reads the display context once and looks up its plates in one call", async () => {
    const { library, seen } = countedLibrary();
    const file = await library.getFile(FILES[0]?.id ?? "");
    expect(file?.plates).toHaveLength(PLATES_PER_FILE);
    expect(seen.calls).toEqual([PLATES.filter((p) => p.file_id === FILES[0]?.id).map((p) => p.id)]);
    expect(seen.contexts).toBe(1);
  });

  // An STL, STEP or SCAD file, or a .3mf with no plate data, has no plate
  // numbers to show, so its answer never waits on the printer menu (and
  // through it on the slicer).
  test("a model or file with no plates never reads the display context", async () => {
    const { library, seen } = countedLibrary([]);
    const model = await library.getModel(MODEL_ID);
    expect(model?.files).toHaveLength(FILE_COUNT);
    for (const file of model?.files ?? []) expect(file.plates).toEqual([]);
    const file = await library.getFile(FILES[0]?.id ?? "");
    expect(file?.plates).toEqual([]);
    expect(seen.contexts).toBe(0);
    expect(seen.calls).toEqual([]);
  });
});
