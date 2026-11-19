// Issue #260: a file's render or conversion message (files.derived_message)
// is OpenSCAD's or the STEP converter's own text, stored as the slicer sent
// it, so it can hold the slicer container's temp paths. Every response that
// carries it shows it cleaned by scrubDetail (src/scrub.ts), as the Activity
// page already did:
//
//   GET /app/api/models/:id   the model page's Files tab (createAppModel.get)
//   GET /api/v1/files/:id     the Public API v1 (createApiLibrary.getFile)
//   GET /api/v1/models/:id    the Public API v1 (createApiLibrary.getModel)
//
// Run against a scripted database built as the server builds its own
// (CamelCasePlugin), answering each table's read with snake_case rows as
// Postgres would. Every id here is made up for the test.
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
import { createAppModel } from "../../src/app-api/model.js";
import type { DB } from "../../src/db/types.js";

const MODEL_ID = "01900000-0000-7000-8000-000000000001";
const SCAD_ID = "01900000-0000-7000-8000-000000000002";
const STEP_ID = "01900000-0000-7000-8000-000000000003";
const OK_ID = "01900000-0000-7000-8000-000000000004";
const BLOB_ID = "01900000-0000-7000-8000-000000000005";

/** OpenSCAD's message as the slicer stores it. */
const SCAD_MESSAGE =
  'ERROR: Parser error in file "/tmp/render-x1/input.scad", line 3: syntax error';
/** What every response shows for it. */
const SCAD_SHOWN = 'ERROR: Parser error in file "[path]", line 3: syntax error';

/** The STEP converter's message (its worker's stderr) as the slicer stores it. */
const STEP_MESSAGE = "Error: EACCES: permission denied, open '/tmp/convert-k7/input.stp'";
const STEP_SHOWN = "Error: EACCES: permission denied, open '[path]'";

/** No response may carry any of these. */
const HIDDEN = ["/tmp/", "render-x1", "convert-k7", "input.scad", "input.stp"];

const CREATED = new Date("2026-11-19T10:00:00Z");

function fileRow(id: string, kind: string, status: string | null, message: string | null) {
  return {
    id,
    model_id: MODEL_ID,
    blob_id: BLOB_ID,
    name: `${kind} part`,
    original_name: `part.${kind}`,
    kind,
    size: "1024",
    sha256: Buffer.alloc(32, 7),
    external_ref: null,
    parse_status: "ok",
    derived_status: status,
    derived_message: message,
    mesh_blob_id: null,
    render_stl_blob_id: null,
    render_png_blob_id: null,
    created_at: CREATED,
    updated_at: CREATED,
  };
}

const FILES = [
  fileRow(SCAD_ID, "scad", "failed", SCAD_MESSAGE),
  fileRow(STEP_ID, "step", "failed", STEP_MESSAGE),
  fileRow(OK_ID, "stl", null, null),
];

const MODEL_ROW = {
  id: MODEL_ID,
  name: "Bracket",
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

/** A database that answers the model, its files, and nothing else (no tags, plates, blobs). */
function scriptedDb(): Kysely<DB> {
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      const from = /\bfrom "([a-z_]+)"/.exec(query.sql)?.[1];
      let rows: unknown[] = [];
      if (from === "models") rows = [MODEL_ROW];
      else if (from === "files") {
        const byId = /"files"\."id" = \$1|"id" = \$1/.test(query.sql);
        rows = byId ? FILES.filter((f) => f.id === query.parameters[0]) : FILES;
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

function expectNothingHidden(answer: unknown) {
  const body = JSON.stringify(answer);
  for (const hidden of HIDDEN) expect(body).not.toContain(hidden);
}

const unusedStore = {
  getBlobStream: async () => {
    throw new Error("not used");
  },
  headBlob: async () => {
    throw new Error("not used");
  },
};

function apiLibrary() {
  return createApiLibrary({
    db: scriptedDb(),
    store: unusedStore,
    plateNumbers: async () => ({}),
  });
}

describe("a file's render or conversion message", () => {
  test("the model page's Files tab shows it cleaned, keeping the words", async () => {
    const view = await createAppModel({
      db: scriptedDb(),
      displayContext: async () => ({ printerId: "P1S", orcaVersion: null, printers: [] }),
      retryEstimate: async () => false,
    }).get(MODEL_ID);
    expect(view?.files.map((f) => [f.id, f.derivedStatus, f.derivedMessage])).toEqual([
      [SCAD_ID, "failed", SCAD_SHOWN],
      [STEP_ID, "failed", STEP_SHOWN],
      [OK_ID, null, null],
    ]);
    expectNothingHidden(view);
  });

  test("the Public API v1 file shows it cleaned, keeping the words", async () => {
    const file = await apiLibrary().getFile(SCAD_ID);
    expect(file?.derivedStatus).toBe("failed");
    expect(file?.derivedMessage).toBe(SCAD_SHOWN);
    expectNothingHidden(file);
  });

  test("the Public API v1 model shows each file's message cleaned", async () => {
    const model = await apiLibrary().getModel(MODEL_ID);
    expect(model?.files.map((f) => [f.id, f.derivedMessage])).toEqual([
      [SCAD_ID, SCAD_SHOWN],
      [STEP_ID, STEP_SHOWN],
      [OK_ID, null],
    ]);
    expectNothingHidden(model);
  });
});
