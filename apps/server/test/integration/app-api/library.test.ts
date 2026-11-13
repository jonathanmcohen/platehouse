// Build plan Task 19 (AC-061, AC-064 and AC-073, UI side): the library's app
// API, GET /app/api/library and GET /app/api/library/tags, against Postgres
// 17 and the S3 test server. Models come in through ingest from generated
// files (no designer file), and plate numbers are Task 12's plateNumbers for
// a selected printer, the P1S with a 0.4 mm nozzle.
//
// - The library is rendered from the database alone. The test plays the
//   browser loading the library: the shell page, the two app API answers,
//   then every image those answers point at. The server's request log then
//   holds only /app/api requests and /blobs/<id> requests for plate
//   thumbnails: no /files/ request and no source blob. createAppLibrary is
//   given the database and plateNumbers and no store, so it has no way to
//   read a model file at all.
// - A card has time and weight for the selected printer only when every
//   plate has numbers for it; otherwise it says partial.
// - The tag filter narrows the grid; search finds name, caption, creator and
//   tag; a trashed model is never listed.
// - Every route is session-class: no session, 401 JSON.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Printer } from "@platehouse/slicer-contract";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildApp } from "../../../src/app.js";
import {
  type AppLibraryPage,
  createAppLibrary,
  LIBRARY_API_PATHS,
  type LibraryCard,
} from "../../../src/app-api/library.js";
import { SESSION_COOKIE } from "../../../src/auth/sessions.js";
import { type DisplayContext, plateNumbers } from "../../../src/estimates/display.js";
import { createTags } from "../../../src/library/tags.js";
import { createUploads } from "../../../src/uploads/tus.js";
import {
  ASCII_STL,
  build3mf,
  type IngestEnv,
  STEP_TEXT,
  startIngestEnv,
  writeUpload,
} from "../support/ingest.js";
import { marker } from "../support/library.js";
import { type TestAuth, testAuth } from "../support/oidc-issuer.js";

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

/** The selected printer is the P1S; the menu also has the X1C. */
const CONTEXT: DisplayContext = {
  printerId: P1S.id,
  orcaVersion: "2.5.0",
  printers: [P1S, X1C],
};

const HTML = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const INDEX = [
  "<!doctype html>",
  '<html lang="en" data-theme="dark">',
  '  <head><meta name="color-scheme" content="dark" /></head>',
  '  <body><div id="root"></div></body>',
  "</html>",
  "",
].join("\n");

let env: IngestEnv;
let auth: TestAuth;
let app: FastifyInstance;
let session: string;
let dist: string;
let uploadsDir: string;
/** Every line the app logged. */
const lines: string[] = [];

async function ingest(name: string, bytes: Buffer | string) {
  const tmpPath = await writeUpload(env, bytes);
  return env.ingest.ingestFile({ tmpPath, originalName: name, target: "new" });
}

async function get(url: string, cookie: string | undefined = session) {
  return app.inject({
    method: "GET",
    url,
    headers: { accept: "application/json" },
    ...(cookie === undefined ? {} : { cookies: { [SESSION_COOKIE]: cookie } }),
  });
}

async function library(query = ""): Promise<AppLibraryPage> {
  const res = await get(`/app/api/library${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as AppLibraryPage;
}

function card(page: AppLibraryPage, id: string): LibraryCard {
  const found = page.models.find((m) => m.id === id);
  if (found === undefined) throw new Error(`model ${id} is not in the page`);
  return found;
}

/** The request urls the app logged since line `from`, in order. */
function loggedUrls(from: number): string[] {
  const urls: string[] = [];
  for (const line of lines.slice(from)) {
    const entry = JSON.parse(line) as { req?: { url?: string } };
    if (entry.req?.url !== undefined) urls.push(entry.req.url);
  }
  return urls;
}

beforeAll(async () => {
  env = await startIngestEnv();
  auth = await testAuth();
  dist = await mkdtemp(join(tmpdir(), "platehouse-t19-dist-"));
  await mkdir(join(dist, "assets"));
  await writeFile(join(dist, "index.html"), INDEX);
  uploadsDir = await mkdtemp(join(tmpdir(), "platehouse-t19-uploads-"));
  app = await buildApp({
    health: { database: async () => 1, queuesRunning: () => true },
    uploads: createUploads({
      tmpDir: uploadsDir,
      queue: { enqueue: async () => {}, result: async () => undefined },
      log: () => {},
    }),
    auth: auth.auth,
    web: { dir: dist },
    library: createAppLibrary({
      db: env.db,
      plateNumbers: (plateId) => plateNumbers(env.db, CONTEXT, plateId),
      selectedPrinter: async () => CONTEXT.printerId,
    }),
    logger: { write: (line: string) => lines.push(line) },
  });
  await app.ready();
  session = (await auth.sessions.start("jon")).id;
});

afterAll(async () => {
  await app?.close();
  await auth?.issuer.stop();
  await env?.stop();
  if (dist !== undefined) await rm(dist, { recursive: true, force: true });
  if (uploadsDir !== undefined) await rm(uploadsDir, { recursive: true, force: true });
});

describe("the library's routes", () => {
  test("are session-class: without a session every one is 401 JSON, never a model", async () => {
    expect(LIBRARY_API_PATHS.length).toBeGreaterThan(0);
    for (const path of LIBRARY_API_PATHS) {
      expect(path.startsWith("/app/api/"), path).toBe(true);
      const res = await get(path, undefined);
      expect(res.statusCode, path).toBe(401);
      expect(res.json(), path).toEqual({ error: "unauthorized" });
    }
  });

  test("answer JSON that is never cached", async () => {
    for (const path of LIBRARY_API_PATHS) {
      const res = await get(path);
      expect(res.statusCode, path).toBe(200);
      expect(res.headers["content-type"], path).toMatch(/^application\/json/);
      expect(res.headers["cache-control"], path).toBe("no-store");
    }
  });

  test("a cursor the library did not make is 400", async () => {
    const res = await get("/app/api/library?cursor=not-a-cursor");
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe("bad_request");
  });
});

describe("library render requests no model file", () => {
  test("the server request log has only /app/api and /blobs thumbnail requests", async () => {
    const word = marker();
    const threeMf = await ingest(`Plated ${word}.3mf`, build3mf({ plates: 3, sliced: [1, 2, 3] }));
    const stl = await ingest(`Bracket ${word}.stl`, ASCII_STL);
    const step = await ingest(`Housing ${word}.step`, STEP_TEXT);
    const from = lines.length;

    // What the browser asks for when it opens the library at ?q=<word>.
    const shell = await app.inject({
      method: "GET",
      url: `/?q=${word}`,
      headers: { accept: HTML },
      cookies: { [SESSION_COOKIE]: session },
    });
    expect(shell.statusCode).toBe(200);
    const page = await library(`?q=${word}`);
    const tags = await get("/app/api/library/tags");
    expect(tags.statusCode).toBe(200);

    expect(page.models.map((m) => m.id).sort()).toEqual(
      [threeMf.modelId, stl.modelId, step.modelId].sort(),
    );
    const images = page.models.flatMap((m) => (m.thumbnail === null ? [] : [m.thumbnail]));
    expect(images).toHaveLength(1);
    for (const url of images) {
      await app.inject({ method: "GET", url, cookies: { [SESSION_COOKIE]: session } });
    }

    // The 3MF card's image is plate 1's thumbnail blob, nothing else.
    const plate1 = await env.db
      .selectFrom("plates")
      .innerJoin("blobs", "blobs.id", "plates.thumbnailBlobId")
      .select(["blobs.id", "blobs.kind"])
      .where("plates.fileId", "=", threeMf.fileId)
      .where("plates.index", "=", 1)
      .executeTakeFirstOrThrow();
    expect(plate1.kind).toBe("thumbnail");
    expect(card(page, threeMf.modelId).thumbnail).toBe(`/blobs/${plate1.id}`);

    const sources = await env.db
      .selectFrom("blobs")
      .select("id")
      .where("kind", "=", "source")
      .where("modelId", "in", [threeMf.modelId, stl.modelId, step.modelId])
      .execute();
    expect(sources).toHaveLength(3);
    const fileIds = [threeMf.fileId, stl.fileId, step.fileId];

    const urls = loggedUrls(from);
    expect(urls).toEqual(["/", "/app/api/library", "/app/api/library/tags", `/blobs/${plate1.id}`]);
    for (const url of urls) {
      expect(url === "/" || url.startsWith("/app/api/") || url.startsWith("/blobs/"), url).toBe(
        true,
      );
      expect(url, url).not.toMatch(/^\/files\//);
      for (const { id } of sources) expect(url, url).not.toContain(id);
      for (const id of fileIds) expect(url, url).not.toContain(id);
    }
    // Nor does any answer point at a model file.
    const text = JSON.stringify(page);
    expect(text).not.toContain("/files/");
    for (const { id } of sources) expect(text).not.toContain(id);
    for (const id of fileIds) expect(text).not.toContain(id);
  });

  test("STL and STEP cards have no thumbnail and name their file type for the icon", async () => {
    const word = marker();
    const stl = await ingest(`Hook ${word}.stl`, ASCII_STL);
    const step = await ingest(`Gear ${word}.stp`, STEP_TEXT);
    const page = await library(`?q=${word}`);
    expect(card(page, stl.modelId)).toMatchObject({ thumbnail: null, fileKind: "stl" });
    expect(card(page, step.modelId)).toMatchObject({ thumbnail: null, fileKind: "step" });
    for (const id of [stl.modelId, step.modelId]) {
      expect(card(page, id)).toMatchObject({
        plateCount: 0,
        timeSeconds: null,
        weightGrams: null,
        partial: false,
      });
    }
  });
});

describe("card shows time and weight only when every plate is known", () => {
  test("every plate sliced for the selected printer: the totals, not partial", async () => {
    const word = marker();
    const done = await ingest(`All known ${word}.3mf`, build3mf({ plates: 2, sliced: [1, 2] }));
    const page = await library(`?q=${word}`);
    expect(page.printer).toBe(P1S.id);
    const shown = card(page, done.modelId);
    // build3mf gives plate n 1000 * n seconds and 10 * n + 0.5 grams.
    expect(shown).toMatchObject({
      name: `All known ${word}`,
      plateCount: 2,
      fileKind: "3mf",
      timeSeconds: 3000,
      partial: false,
    });
    expect(shown.weightGrams).toBeCloseTo(31, 5);
  });

  test("one plate without numbers: partial, and no time or weight", async () => {
    const word = marker();
    const some = await ingest(`Some known ${word}.3mf`, build3mf({ plates: 3, sliced: [1, 3] }));
    const shown = card(await library(`?q=${word}`), some.modelId);
    expect(shown).toMatchObject({
      plateCount: 3,
      timeSeconds: null,
      weightGrams: null,
      partial: true,
    });
  });

  test("numbers for another printer only: partial for the selected printer", async () => {
    const word = marker();
    const other = await ingest(
      `Other printer ${word}.3mf`,
      build3mf({ plates: 2, sliced: [1, 2], printerModelId: X1C.modelId }),
    );
    const shown = card(await library(`?q=${word}`), other.modelId);
    expect(shown).toMatchObject({ timeSeconds: null, weightGrams: null, partial: true });
  });

  test("a current Platehouse estimate for the selected printer counts as known", async () => {
    const word = marker();
    const other = await ingest(
      `Estimated ${word}.3mf`,
      build3mf({ plates: 2, sliced: [1, 2], printerModelId: X1C.modelId }),
    );
    const plates = await env.db
      .selectFrom("plates")
      .select("id")
      .where("fileId", "=", other.fileId)
      .orderBy("index")
      .execute();
    for (const [i, plate] of plates.entries()) {
      const pending = await env.repos.estimates.upsertPending({
        plateId: plate.id,
        printerId: P1S.id,
        printerModelId: P1S.modelId,
        nozzle: P1S.nozzle,
        slicer: "OrcaSlicer",
        slicerVersion: "2.5.0",
      });
      await env.db
        .updateTable("estimates")
        .set({
          status: "ok",
          timeSeconds: 600 * (i + 1),
          weightGrams: 5 * (i + 1),
          finishedAt: new Date(),
        })
        .where("id", "=", pending.id)
        .execute();
    }
    const shown = card(await library(`?q=${word}`), other.modelId);
    expect(shown).toMatchObject({ timeSeconds: 1800, partial: false });
    expect(shown.weightGrams).toBeCloseTo(15, 5);
  });
});

describe("tag filter narrows the grid", () => {
  test("?tag= lists only the models with that tag, ignoring case", async () => {
    const word = marker();
    const tagged = await ingest(`Tagged ${word}.stl`, ASCII_STL);
    const untagged = await ingest(`Untagged ${word}.stl`, ASCII_STL);
    const tag = `Gridfinity ${word}`;
    await createTags(env.db).addTag(tagged.modelId, tag);

    const all = await library(`?q=${word}`);
    expect(all.models.map((m) => m.id).sort()).toEqual([tagged.modelId, untagged.modelId].sort());
    expect(card(all, tagged.modelId).tags).toEqual([tag]);
    expect(card(all, untagged.modelId).tags).toEqual([]);

    const narrowed = await library(`?tag=${encodeURIComponent(tag.toUpperCase())}`);
    expect(narrowed.models.map((m) => m.id)).toEqual([tagged.modelId]);

    const tags = (await get("/app/api/library/tags")).json() as { tags: string[] };
    expect(tags.tags).toContain(tag);
  });

  test("a tag only trashed models carry is not offered, and trashed models are not listed", async () => {
    const word = marker();
    const gone = await ingest(`Gone ${word}.stl`, ASCII_STL);
    const tag = `Trashed only ${word}`;
    await createTags(env.db).addTag(gone.modelId, tag);
    expect(await env.repos.models.trash(gone.modelId)).toBe(true);
    expect((await library(`?q=${word}`)).models).toEqual([]);
    expect((await library(`?tag=${encodeURIComponent(tag)}`)).models).toEqual([]);
    const tags = (await get("/app/api/library/tags")).json() as { tags: string[] };
    expect(tags.tags).not.toContain(tag);
  });
});

describe("search", () => {
  test("search matches name, caption, creator and tag", async () => {
    const word = marker();
    const byName = await env.repos.models.create({ name: `Benchy ${word}` });
    const byCaption = await env.repos.models.create({ name: "Cube", caption: `Fits ${word}` });
    const byCreator = await env.repos.models.create({ name: "Clip", creator: `Maker ${word}` });
    const byTag = await env.repos.models.create({ name: "Bin" });
    await createTags(env.db).addTag(byTag.id, `Grid ${word}`);
    await env.repos.models.create({ name: `Unrelated ${marker()}` });

    const page = await library(`?q=${encodeURIComponent(word.toUpperCase())}`);
    expect(page.models.map((m) => m.id).sort()).toEqual(
      [byName.id, byCaption.id, byCreator.id, byTag.id].sort(),
    );
    expect(card(page, byCreator.id).creator).toBe(`Maker ${word}`);
  });

  test("pages follow nextCursor to the end", async () => {
    const word = marker();
    const made = [];
    for (let i = 0; i < 3; i += 1) {
      made.push((await env.repos.models.create({ name: `Paged ${i} ${word}` })).id);
    }
    const first = await library(`?q=${word}&limit=2`);
    expect(first.models).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await library(
      `?q=${word}&limit=2&cursor=${encodeURIComponent(first.nextCursor as string)}`,
    );
    expect(second.nextCursor).toBeNull();
    expect([...first.models, ...second.models].map((m) => m.id).sort()).toEqual(made.sort());
  });
});
