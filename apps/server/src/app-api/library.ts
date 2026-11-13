// The library's app API (build plan Task 19; AC-061, AC-064, AC-073), for the
// web app's library page:
//
//   GET /app/api/library?q&tag&collection&creator&cursor&limit
//       { printer, models: LibraryCard[], nextCursor }
//   GET /app/api/library/tags
//       { tags: string[] }      the tag names live models carry
//
// - Both routes are session-class (the Route classes contract: /app/api is
//   unlisted, so session). The gate (auth/gate.ts) refuses a request without
//   a session before these handlers run. Neither route changes anything, so
//   the gate's Origin check has nothing to check here.
// - The page is Task 14's search (library/search.ts): name, caption, creator
//   and tag, best match first, the tag, collection and creator filters, and
//   its cursor; trashed models never appear.
// - A card is read from the database alone. Its image is plate 1's thumbnail
//   blob of the model's first .3mf, named as /blobs/<id> (Task 17's route),
//   and only a stored blob of kind thumbnail is ever named, so rendering the
//   library never fetches a model file (AC-073). This module is given no
//   store at all.
// - Time and weight are for the selected printer (settings.printer_id), from
//   Task 12's plateNumbers per plate: a plate has numbers for that printer
//   when the file's own numbers are for it or a current Platehouse estimate
//   is. A card has totals only when every plate does, else partial. A model
//   with no plates (STL, STEP, SCAD) has neither; its card shows the
//   file-type icon for fileKind.
// - The display context (the settings row and the printer menu) is read once
//   per page and shared by every plate's lookup. The menu comes from the
//   slicer's /v1/profiles until the estimates service has it cached, so a
//   page asks the slicer at most once, never once per plate. Each plate's
//   lookup is two queries, and at most PLATE_NUMBERS_CONCURRENCY run at once
//   (mapLimit), so a page of many plates leaves most of the database pool to
//   the ingest and slicer workers.
// - Answers are JSON and never cached; an invalid cursor is 400. Errors carry
//   no detail from the database.
import type { FastifyInstance } from "fastify";
import { type Kysely, sql } from "kysely";
import type { DB, FileKind } from "../db/types.js";
import type { DisplayContext, Numbers, PlateNumbers } from "../estimates/display.js";
import { createSearch, InvalidCursor, type LibrarySearch } from "../library/search.js";

/** The library's routes, every one session-class (the Route classes contract). */
export const LIBRARY_API_PATHS: readonly string[] = Object.freeze([
  "/app/api/library",
  "/app/api/library/tags",
]);

/** Most plate number lookups one page runs at once; the pool holds 10 connections. */
export const PLATE_NUMBERS_CONCURRENCY = 4;

/**
 * fn over every item, at most limit calls in flight, the results in the
 * items' order. The first failure rejects the whole map.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i] as T);
    }
  }
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return out;
}

/** Where Task 17 serves a blob's bytes; the card names its thumbnail by it. */
export const BLOB_PREFIX = "/blobs/";

/** One card in the library grid. */
export interface LibraryCard {
  id: string;
  name: string;
  creator: string | null;
  tags: string[];
  /** Plates across the model's .3mf files. */
  plateCount: number;
  /** /blobs/<id> of plate 1's thumbnail in the model's first .3mf; null when there is none. */
  thumbnail: string | null;
  /** The kind of the file the card stands for, for the file-type icon; null for a model with no files. */
  fileKind: FileKind | null;
  /** Total print time for the selected printer, when every plate has numbers for it. */
  timeSeconds: number | null;
  /** Total weight for the selected printer, when every plate has numbers for it. */
  weightGrams: number | null;
  /** True when some plate has no numbers for the selected printer. */
  partial: boolean;
}

export interface AppLibraryPage {
  /** The selected printer the numbers are for. */
  printer: string;
  models: LibraryCard[];
  nextCursor: string | null;
}

export interface AppLibrary {
  /** A page of cards; InvalidCursor for a cursor search did not make. */
  list(query: LibrarySearch): Promise<AppLibraryPage>;
  /** Tag names live models carry, for the tag filter, alphabetical ignoring case. */
  tags(): Promise<string[]>;
}

export interface AppLibraryDeps {
  db: Kysely<DB>;
  /**
   * The selected printer, the Orca version and the printer menu
   * (estimates.displayContext), read once per page.
   */
  displayContext(): Promise<DisplayContext>;
  /** Task 12's plateNumbers for one plate with that context (estimates/display.ts). */
  plateNumbers(ctx: DisplayContext, plateId: string): Promise<PlateNumbers>;
}

/** The numbers a plate has for the selected printer, if any: time and weight both known. */
export function numbersFor(
  numbers: PlateNumbers,
  printerId: string,
): { timeSeconds: number; weightGrams: number } | undefined {
  const known = (n: Numbers | undefined) =>
    n !== undefined && n.timeSeconds !== null && n.weightGrams !== null
      ? { timeSeconds: n.timeSeconds, weightGrams: n.weightGrams }
      : undefined;
  if (numbers.file?.printerId === printerId) {
    const own = known(numbers.file);
    if (own !== undefined) return own;
  }
  const estimate = numbers.platehouse;
  if (estimate?.state === "current" && estimate.printerId === printerId) return known(estimate);
  return undefined;
}

export function createAppLibrary(deps: AppLibraryDeps): AppLibrary {
  const { db } = deps;
  const search = createSearch(db);

  async function cards(
    models: Array<{ id: string; name: string; creator: string | null }>,
    ctx: DisplayContext,
  ): Promise<LibraryCard[]> {
    const { printerId } = ctx;
    const ids = models.map((m) => m.id);
    if (ids.length === 0) return [];
    const [files, plates, tagRows] = await Promise.all([
      db
        .selectFrom("files")
        .select(["id", "modelId", "kind"])
        .where("modelId", "in", ids)
        .orderBy("createdAt")
        .orderBy("id")
        .execute(),
      // Every plate of the page's models, with its thumbnail only when that is
      // a stored thumbnail blob of the same model: never a source blob.
      db
        .selectFrom("plates")
        .innerJoin("files", "files.id", "plates.fileId")
        .leftJoin("blobs", (join) =>
          join
            .onRef("blobs.id", "=", "plates.thumbnailBlobId")
            .onRef("blobs.modelId", "=", "files.modelId")
            .on("blobs.kind", "=", "thumbnail")
            .on("blobs.state", "=", "stored"),
        )
        .select([
          "plates.id as plateId",
          "plates.fileId",
          "plates.index",
          "files.modelId",
          "blobs.id as thumbnailId",
        ])
        .where("files.modelId", "in", ids)
        .where("files.kind", "=", "3mf")
        .orderBy("plates.index")
        .execute(),
      db
        .selectFrom("modelTags")
        .innerJoin("tags", "tags.id", "modelTags.tagId")
        .select(["modelTags.modelId", "tags.name"])
        .where("modelTags.modelId", "in", ids)
        .orderBy(sql`lower(tags.name)`)
        .orderBy("tags.name")
        .execute(),
    ]);

    const numbers = new Map(
      await mapLimit(
        plates,
        PLATE_NUMBERS_CONCURRENCY,
        async (p) =>
          [p.plateId, numbersFor(await deps.plateNumbers(ctx, p.plateId), printerId)] as const,
      ),
    );

    return models.map((model) => {
      const own = files.filter((f) => f.modelId === model.id);
      const first3mf = own.find((f) => f.kind === "3mf");
      const ownPlates = plates.filter((p) => p.modelId === model.id);
      const plate1 = ownPlates.find((p) => p.fileId === first3mf?.id && p.index === 1);
      const thumbnail = plate1?.thumbnailId ?? null;
      let timeSeconds: number | null = 0;
      let weightGrams: number | null = 0;
      for (const plate of ownPlates) {
        const n = numbers.get(plate.plateId);
        if (n === undefined || timeSeconds === null || weightGrams === null) {
          timeSeconds = null;
          weightGrams = null;
          break;
        }
        timeSeconds += n.timeSeconds;
        weightGrams += n.weightGrams;
      }
      const known = ownPlates.length > 0 && timeSeconds !== null;
      return {
        id: model.id,
        name: model.name,
        creator: model.creator,
        tags: tagRows.filter((t) => t.modelId === model.id).map((t) => t.name),
        plateCount: ownPlates.length,
        thumbnail: thumbnail === null ? null : `${BLOB_PREFIX}${thumbnail}`,
        fileKind: (first3mf ?? own[0])?.kind ?? null,
        timeSeconds: known ? timeSeconds : null,
        weightGrams: known ? weightGrams : null,
        partial: ownPlates.length > 0 && !known,
      };
    });
  }

  return {
    async list(query) {
      const [page, ctx] = await Promise.all([search.search(query), deps.displayContext()]);
      return {
        printer: ctx.printerId,
        models: await cards(page.models, ctx),
        nextCursor: page.nextCursor,
      };
    },

    async tags() {
      const rows = await db
        .selectFrom("tags")
        .select("tags.name")
        .where(({ exists, selectFrom }) =>
          exists(
            selectFrom("modelTags")
              .innerJoin("models", "models.id", "modelTags.modelId")
              .select("modelTags.tagId")
              .whereRef("modelTags.tagId", "=", "tags.id")
              .where("models.trashedAt", "is", null),
          ),
        )
        .orderBy(sql`lower(tags.name)`)
        .orderBy("tags.name")
        .execute();
      return rows.map((r) => r.name);
    },
  };
}

/** The library when the server is given none: empty, so the routes still answer. */
export const emptyAppLibrary: AppLibrary = Object.freeze({
  list: async () => ({ printer: "", models: [], nextCursor: null }),
  tags: async () => [],
});

const SEARCH_QUERY = {
  type: "object",
  properties: {
    q: { type: "string", maxLength: 200 },
    tag: { type: "string", maxLength: 100 },
    collection: { type: "string", maxLength: 100 },
    creator: { type: "string", maxLength: 300 },
    cursor: { type: "string", maxLength: 2000 },
    limit: { type: "integer", minimum: 1, maximum: 200 },
  },
} as const;

/** Registers the library's routes on the root app, after the gate. */
export async function registerLibraryApi(app: FastifyInstance, library: AppLibrary): Promise<void> {
  await app.register(async (scope) => {
    scope.addHook("onSend", async (_request, reply, payload) => {
      reply.header("cache-control", "no-store");
      return payload;
    });
    scope.setErrorHandler(async (error, request, reply) => {
      const err = error as Error & { validation?: unknown };
      if (err.validation !== undefined || error instanceof InvalidCursor) {
        return reply.code(400).send({ error: "bad_request", message: err.message });
      }
      // The cause (a database host) goes to the log only.
      request.log.error({ err: error }, "library: the request failed");
      return reply.code(500).send({ error: "internal" });
    });

    scope.get<{ Querystring: LibrarySearch }>(
      "/app/api/library",
      { schema: { querystring: SEARCH_QUERY } },
      async (request) => library.list(request.query),
    );

    scope.get("/app/api/library/tags", async () => ({ tags: await library.tags() }));
  });
}
