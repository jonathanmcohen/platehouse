// The library's app API (build plan Task 19; AC-061, AC-064, AC-073), for the
// web app's library page:
//
//   GET /app/api/library?q&tag&collection&creator&cursor&limit&printer
//       { printer, printerName, printers, models: LibraryCard[], nextCursor }
//   GET /app/api/library?q&tag&collection&creator&page&limit&printer&sort
//       { printer, printerName, printers, models, nextCursor: null, page,
//         pageSize, pageCount, total, totalCapped, libraryTotal, sort }
//       numbered pages (the web app's)
//   GET /app/api/library/ids?q&tag&collection&creator&printer&sort
//       { ids: string[], capped }  every match's id, for Select all matching
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
// - printer= is the header's printer switch: one of My printers, whose
//   numbers the cards show instead of the default printer's. Anything else
//   (a printer removed since the browser stored its choice) shows the
//   default; printer and printerName say which printer the numbers are for,
//   and printers lists the switch's choices (My printers, named in full), so
//   the page needs no second request. Switching reads numbers only and never
//   queues a slice.
// - Time and weight are for that printer (settings.printer_id when no
//   switch is given; "the selected printer" below), from
//   Task 12's plateNumbers per plate: a plate has numbers for that printer
//   when the file's own numbers are for it or a current Platehouse estimate
//   is. A card has totals only when every plate does, else partial. While
//   the printer menu cannot be read (the slicer is down or slow), the file's
//   own numbers cannot be matched to the selected printer, which the menu
//   names by its id and the file by its BBL model id; a card without totals
//   then says numbersUnavailable, not partial, since nothing is known to be
//   missing. Current Platehouse estimates still count then. A model
//   with no plates (STL, STEP, SCAD) has neither; its card shows the
//   file-type icon for fileKind.
// - The display context (the settings row and the printer menu) is read once
//   per page by readDisplayContext and shared by every plate's lookup. The
//   menu is the estimates service's listPrinters, which asks the slicer's
//   /v1/profiles only until it has the answer cached, so a page asks the
//   slicer at most once, never once per plate, and waits for it at most
//   DISPLAY_MENU_TIMEOUT_MS, so a slicer that accepts connections but never
//   answers does not hold the page for the slicer client's 10 s request
//   timeout. Each plate's
//   lookup is two queries, and at most PLATE_NUMBERS_CONCURRENCY run at once
//   (mapLimit), so a page of many plates leaves most of the database pool to
//   the ingest and slicer workers.
// - Numbered pages: ?page= (from 1) asks for one page of limit cards, 48 when
//   limit is left out (LIBRARY_PAGE_SIZE), up to 200, instead of following a
//   cursor; the two cannot be mixed. The page is a slice of the same ranked
//   matches the cursor pages walk (the models repository's searchRanked, so
//   the same search, filters and order, and trashed models never appear),
//   read once per request and capped at PAGED_MATCH_CAP matches. total is the
//   number of matches for the search and filters, up to that cap;
//   totalCapped says there are more, which pages cannot reach. libraryTotal
//   is every live model, for "12 of 171". A page past the end is the last
//   page (its number is in the answer), never an empty one. Plate numbers
//   are looked up for the page's cards only, so a request computes numbers
//   for at most 200 models whatever the total.
// - Sorting (the maintainer, 2026-11-19): ?sort= orders a numbered page, in the
//   database (the models repository's LIBRARY_SORTS): best match, date added
//   (newest, oldest), name ignoring case (A to Z, Z to A), total print time
//   or weight for the selected printer (models without numbers for it last,
//   either way), and plate count. Left out, it is best match while a search
//   is active and newest otherwise (defaultSort), and the answer names the
//   sort served. Every order ends with the model's id, so it is total and
//   models that tie always come in the same order. Each numbered page or
//   View all chunk is its own request that re-runs the sort and slices by
//   offset, so pages hold together only while the order holds still: a
//   model whose time or weight total arrives while you page (its last
//   plate's estimate lands) moves out of the "no numbers" tail, and it or
//   a model on a page boundary can repeat or be skipped. Keyset paging for
//   the computed sorts would close that; it is not done. The matches are
//   read once per request, one row past the cap, so one query both slices
//   the page and says whether the total is capped. A time or
//   weight sort reads the display context first, for the selected printer,
//   and totals a model's plates by the cards' own rule (sortPrinterFor). A
//   cursor page has its own order, best match; any other sort with it is 400.
// - /app/api/library/ids answers every match's id in the sort's order, up to
//   the same cap View all stops at, and whether there are more: the library's
//   Select all matching. Which models a search and filters hold is viewOf's
//   and the models repository's rule (viewQuery), shared with the bulk
//   actions, which change only the posted models the view holds when they
//   run (app-api/organise.ts).
// - Answers are JSON and never cached; an invalid cursor is 400, and so is a
//   page with a cursor. Errors carry no detail from the database.
import type { Printer } from "@platehouse/slicer-contract";
import type { FastifyInstance } from "fastify";
import { type Kysely, sql } from "kysely";
import type { DB, FileKind } from "../db/types.js";
import {
  type DisplayContext,
  type Numbers,
  type PlateNumbers,
  printerForFile,
  printerName,
} from "../estimates/display.js";
import { createSearch, InvalidCursor, type LibrarySearch } from "../library/search.js";
import {
  defaultSort,
  LIBRARY_SORTS,
  type LibrarySort,
  type LibraryView,
  modelsRepo,
  type SortPrinter,
} from "../repos/models.js";

/** The library's routes, every one session-class (the Route classes contract). */
export const LIBRARY_API_PATHS: readonly string[] = Object.freeze([
  "/app/api/library",
  "/app/api/library/ids",
  "/app/api/library/tags",
]);

/** Cards on one numbered page when the request names no limit; the web app's page. */
export const LIBRARY_PAGE_SIZE = 48;

/** Most cards one request computes, numbered page or cursor page. */
const MAX_PAGE_SIZE = 200;

/**
 * Most matches a numbered page request reads, ranked, to slice its page from
 * and count its total: searchRanked's own most. Matches past it are not
 * counted, and the answer says the total is capped.
 */
export const PAGED_MATCH_CAP = 1000;

/**
 * Highest ?page= the route accepts (its querystring schema); past it the
 * answer is 400. The web app asks for at most this page (PAGE_MAX in
 * apps/web/src/library/paging.ts), which pageWindow serves as the last page.
 */
export const MAX_PAGE_NUMBER = 1_000_000;

/** A numbered page's size: LIBRARY_PAGE_SIZE when left out, else a whole 1 to 200. */
export function pageSizeFor(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return LIBRARY_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_SIZE);
}

/**
 * Which slice of total matches page is: the page actually served (a page
 * past the end is the last page, one below 1 is page 1), the page count
 * (at least 1, so no matches is page 1 of 1) and the slice's start and end.
 */
export function pageWindow({
  total,
  pageSize,
  page,
}: {
  total: number;
  pageSize: number;
  page: number;
}): { page: number; pageCount: number; start: number; end: number } {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const asked = Number.isFinite(page) ? Math.trunc(page) : 1;
  const served = Math.min(Math.max(asked, 1), pageCount);
  const start = (served - 1) * pageSize;
  return { page: served, pageCount, start, end: Math.min(start + pageSize, total) };
}

/** A request named both a page and a cursor. */
export class InvalidPageQuery extends Error {
  constructor() {
    super("Ask for a page or a cursor, not both");
    this.name = "InvalidPageQuery";
  }
}

/** A request named a sort other than best match without a numbered page. */
export class InvalidSortQuery extends Error {
  constructor() {
    super("Only numbered pages can be sorted; ask for a page");
    this.name = "InvalidSortQuery";
  }
}

/**
 * Whose numbers a time or weight sort totals: the selected printer, the
 * current Orca version and, for a file's own numbers, the selected printer's
 * BBL model id and nozzle, matched as the cards match them (numbersFor over
 * plateNumbers). The cards label a file's numbers with the first menu
 * printer of that model and nozzle (printerForFile), so they count only when
 * that first printer is the selected one; with the menu unread nothing
 * matches a file's numbers at all.
 */
export function sortPrinterFor(ctx: DisplayContext): SortPrinter {
  const selected = ctx.printers.find((p) => p.id === ctx.printerId);
  const first =
    selected === undefined
      ? undefined
      : printerForFile({ printerModelId: selected.modelId, nozzle: selected.nozzle }, ctx.printers);
  return {
    printerId: ctx.printerId,
    orcaVersion: ctx.orcaVersion,
    fileModelId: selected?.modelId ?? null,
    fileNozzle: selected?.nozzle ?? null,
    fileNumbersCount: selected !== undefined && first?.id === selected.id,
  };
}

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

/** What readDisplayContext reads; main.ts hands it the settings repo and the estimates service. */
export interface DisplayContextSources {
  /** The settings row and My printers (repos.settings.get). */
  settings(): Promise<{
    printerId: string;
    myPrinters?: readonly string[];
    lastOrcaVersion: string | null;
  }>;
  /** The printer menu (estimates.listPrinters), the cached /v1/profiles answer. */
  listPrinters(): Promise<readonly Printer[]>;
}

/**
 * Longest the library page waits for the printer menu. The slicer client's
 * own request timeout is 10 s (estimates/client.ts); a menu not read by then
 * is left empty for this page, and the request goes on, so its answer is
 * cached for the next page when it comes.
 */
export const DISPLAY_MENU_TIMEOUT_MS = 1_500;

/**
 * The selected printer, the Orca version and the printer menu, read the same
 * way the estimates service reads them for its own plateNumbers
 * (estimates/service.ts displayContext). While the slicer is down, or slower
 * than menuTimeoutMs, the menu is empty: a file's own numbers are then
 * labelled with its bare BBL model id, which never matches the selected
 * printer's id, so the cards say numbersUnavailable rather than partial. A
 * settings read that fails rejects.
 */
export async function readDisplayContext(
  src: DisplayContextSources,
  { menuTimeoutMs = DISPLAY_MENU_TIMEOUT_MS }: { menuTimeoutMs?: number } = {},
): Promise<DisplayContext> {
  const settings = await src.settings();
  let printers: readonly Printer[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = new Promise<readonly Printer[]>((resolve) => {
      timer = setTimeout(() => resolve([]), menuTimeoutMs);
    });
    printers = await Promise.race([src.listPrinters(), timedOut]);
  } catch {
    // The slicer is down; the menu stays empty.
  } finally {
    clearTimeout(timer);
  }
  return {
    printerId: settings.printerId,
    ...(settings.myPrinters === undefined ? {} : { myPrinters: settings.myPrinters }),
    orcaVersion: settings.lastOrcaVersion,
    printers,
  };
}

/**
 * The display context for the printer a page's switch asked for: that
 * printer when it is one of My printers, else the context as read, for the
 * default printer. The answer names the printer it used, so a page whose
 * stored choice was removed falls back without an error.
 */
export function forPrinter(ctx: DisplayContext, printerId: string | undefined): DisplayContext {
  if (printerId === undefined || !(ctx.myPrinters ?? []).includes(printerId)) return ctx;
  return { ...ctx, printerId };
}

/** One choice of a page's printer switch. */
export interface PrinterChoice {
  id: string;
  /** The printer in full, such as "Bambu Lab P1S, 0.4 mm nozzle". */
  name: string;
}

/**
 * The printer switch's choices: My printers in order, each named in full;
 * the shown printer alone when the context has no list.
 */
export function printerChoices(ctx: DisplayContext): PrinterChoice[] {
  const ids = ctx.myPrinters ?? [ctx.printerId];
  return ids.map((id) => ({ id, name: printerName(id, ctx.printers) }));
}

/** The printer fields of a library answer: the printer shown, its name and the choices. */
function printerFields(ctx: DisplayContext) {
  return {
    printer: ctx.printerId,
    printerName: printerName(ctx.printerId, ctx.printers),
    printers: printerChoices(ctx),
  };
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
  /**
   * True when the card has plates but no totals and the printer menu could
   * not be read, so the file's own numbers could not be matched to the
   * selected printer. Never true beside partial.
   */
  numbersUnavailable: boolean;
}

export interface AppLibraryPage {
  /** The printer the numbers are for: the default printer, or the switch's choice. */
  printer: string;
  /** That printer in full, such as "Bambu Lab P1S, 0.4 mm nozzle". */
  printerName: string;
  /** The printer switch's choices: My printers, in order. */
  printers: PrinterChoice[];
  models: LibraryCard[];
  nextCursor: string | null;
}

/** A numbered page (?page=). */
export interface AppLibraryPages extends AppLibraryPage {
  nextCursor: null;
  /** The page served, from 1: the last page when the one asked for is past the end. */
  page: number;
  pageSize: number;
  /** At least 1. */
  pageCount: number;
  /** Matches for the search and filters, up to PAGED_MATCH_CAP. */
  total: number;
  /** True when there are more matches than total counts. */
  totalCapped: boolean;
  /** Every live model, whatever the search and filters. */
  libraryTotal: number;
  /** The order served: the one asked for, else defaultSort(q). */
  sort: LibrarySort;
}

export interface AppLibraryQuery extends LibrarySearch {
  /** A numbered page, from 1, instead of a cursor. */
  page?: number | undefined;
  /** The printer switch's choice: one of My printers, else the default is shown. */
  printer?: string | undefined;
  /**
   * The order of a numbered page; defaultSort(q) when left out. A cursor
   * page takes only relevance, its own order.
   */
  sort?: LibrarySort | undefined;
}

/** Every match's id for Select all matching (GET /app/api/library/ids). */
export interface MatchingIds {
  /** The matches' ids in the sort's order, at most the paged match cap. */
  ids: string[];
  /** True when there are more matches than ids holds. */
  capped: boolean;
}

export interface AppLibrary {
  /**
   * A page of cards, for query.printer when it is one of My printers, else
   * for the default printer: a numbered page when query.page is set, else a
   * cursor page. InvalidCursor for a cursor search did not make,
   * InvalidPageQuery for a page and a cursor together.
   */
  list(query: AppLibraryQuery): Promise<AppLibraryPage | AppLibraryPages>;
  /**
   * The ids of every match for the search and filters, in the sort's order,
   * up to the paged match cap (the most View all shows), and whether there
   * are more. Cursor and page are ignored.
   */
  ids(query: AppLibraryQuery): Promise<MatchingIds>;
  /** Tag names live models carry, for the tag filter, alphabetical ignoring case. */
  tags(): Promise<string[]>;
}

export interface AppLibraryDeps {
  db: Kysely<DB>;
  /**
   * The selected printer, the Orca version and the printer menu
   * (readDisplayContext), read once per page.
   */
  displayContext(): Promise<DisplayContext>;
  /** Task 12's plateNumbers for one plate with that context (estimates/display.ts). */
  plateNumbers(ctx: DisplayContext, plateId: string): Promise<PlateNumbers>;
  /** Most matches a numbered page reads; PAGED_MATCH_CAP. Smaller in tests. */
  pagedMatchCap?: number;
}

// A blank filter, such as an empty tag= in a query string, is no filter, as
// in library/search.ts.
function filter(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/**
 * The view a library request's search and filters make, as the models
 * repository matches it: a blank search lists everything and a blank
 * filter is no filter. The pages, View all, Select all matching
 * (/app/api/library/ids) and the bulk actions (app-api/organise.ts) all
 * read it from here, so they agree on which models a view holds.
 */
export function viewOf(
  query: Pick<LibrarySearch, "q" | "tag" | "collection" | "creator">,
): LibraryView {
  return {
    q: query.q ?? "",
    tag: filter(query.tag),
    collection: filter(query.collection),
    creator: filter(query.creator),
  };
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
  const models = modelsRepo(db);
  const matchCap = deps.pagedMatchCap ?? PAGED_MATCH_CAP;

  async function liveModels(): Promise<number> {
    const row = await db
      .selectFrom("models")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("trashedAt", "is", null)
      .executeTakeFirstOrThrow();
    return Number(row.n);
  }

  /**
   * The matches for the search and filters in the sort's order, up to the
   * cap, and whether there are more: one query for one row past the cap.
   * A time or weight sort totals for the selected printer, so it needs the
   * display context first.
   */
  async function matches(query: AppLibraryQuery, sort: LibrarySort, ctx?: DisplayContext) {
    const where = viewOf(query);
    // Only id, name, creator and rank: up to matchCap rows are read to slice
    // one page and count it, and View all reads them once per chunk (up to
    // five times for 1000 models), so no row carries its description.
    const rows = await models.searchRankedCards({
      ...where,
      sort,
      printer: ctx === undefined ? undefined : sortPrinterFor(ctx),
      limit: matchCap + 1,
    });
    return { rows: rows.slice(0, matchCap), capped: rows.length > matchCap };
  }

  /** The sort a numbered page or the ids are served in. */
  function sortOf(query: AppLibraryQuery): LibrarySort {
    return query.sort ?? defaultSort(query.q);
  }

  /** The display context, read first only for a sort that totals numbers. */
  function needsContext(sort: LibrarySort): boolean {
    return sort.startsWith("time-") || sort.startsWith("weight-");
  }

  async function numbered(query: AppLibraryQuery & { page: number }): Promise<AppLibraryPages> {
    const pageSize = pageSizeFor(query.limit);
    const sort = sortOf(query);
    // A time or weight sort totals for the printer shown, so it reads the
    // display context (and the switch's choice) first.
    const first = needsContext(sort)
      ? forPrinter(await deps.displayContext(), query.printer)
      : undefined;
    const [found, read, libraryTotal] = await Promise.all([
      matches(query, sort, first),
      first ?? deps.displayContext(),
      liveModels(),
    ]);
    const ctx = forPrinter(read, query.printer);
    const total = found.rows.length;
    const window = pageWindow({ total, pageSize, page: query.page });
    return {
      ...printerFields(ctx),
      models: await cards(found.rows.slice(window.start, window.end), ctx),
      nextCursor: null,
      page: window.page,
      pageSize,
      pageCount: window.pageCount,
      total,
      totalCapped: found.capped,
      libraryTotal,
      sort,
    };
  }

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
      const unmatched = ownPlates.length > 0 && !known;
      const noMenu = ctx.printers.length === 0;
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
        partial: unmatched && !noMenu,
        numbersUnavailable: unmatched && noMenu,
      };
    });
  }

  return {
    async list(query) {
      if (query.page !== undefined) {
        if (query.cursor !== undefined) throw new InvalidPageQuery();
        return numbered({ ...query, page: query.page });
      }
      if (query.sort !== undefined && query.sort !== "relevance") throw new InvalidSortQuery();
      const { printer, page: _page, sort: _sort, ...searchQuery } = query;
      const [page, read] = await Promise.all([search.search(searchQuery), deps.displayContext()]);
      const ctx = forPrinter(read, printer);
      return {
        ...printerFields(ctx),
        models: await cards(page.models, ctx),
        nextCursor: page.nextCursor,
      };
    },

    async ids(query) {
      const sort = sortOf(query);
      const ctx = needsContext(sort)
        ? forPrinter(await deps.displayContext(), query.printer)
        : undefined;
      const found = await matches(query, sort, ctx);
      return { ids: found.rows.map((r) => r.id), capped: found.capped };
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
  list: async (query: AppLibraryQuery) =>
    query.page === undefined
      ? { printer: "", printerName: "", printers: [], models: [], nextCursor: null }
      : {
          printer: "",
          printerName: "",
          printers: [],
          models: [],
          nextCursor: null,
          page: 1,
          pageSize: pageSizeFor(query.limit),
          pageCount: 1,
          total: 0,
          totalCapped: false,
          libraryTotal: 0,
          sort: query.sort ?? defaultSort(query.q),
        },
  ids: async () => ({ ids: [], capped: false }),
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
    limit: { type: "integer", minimum: 1, maximum: MAX_PAGE_SIZE },
    page: { type: "integer", minimum: 1, maximum: MAX_PAGE_NUMBER },
    printer: { type: "string", maxLength: 200 },
    sort: { type: "string", enum: [...LIBRARY_SORTS] },
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
      if (
        err.validation !== undefined ||
        error instanceof InvalidCursor ||
        error instanceof InvalidPageQuery ||
        error instanceof InvalidSortQuery
      ) {
        return reply.code(400).send({ error: "bad_request", message: err.message });
      }
      // The cause (a database host) goes to the log only.
      request.log.error({ err: error }, "library: the request failed");
      return reply.code(500).send({ error: "internal" });
    });

    scope.get<{ Querystring: AppLibraryQuery }>(
      "/app/api/library",
      { schema: { querystring: SEARCH_QUERY } },
      async (request) => library.list(request.query),
    );

    scope.get<{ Querystring: AppLibraryQuery }>(
      "/app/api/library/ids",
      { schema: { querystring: SEARCH_QUERY } },
      async (request) => library.ids(request.query),
    );

    scope.get("/app/api/library/tags", async () => ({ tags: await library.tags() }));
  });
}
