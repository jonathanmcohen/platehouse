// The library page (build plan Task 19; AC-020, AC-061, AC-064, AC-073) at /.
//
// - The search is the URL's ?q=, which the top bar's search box (Task 18)
//   sets; ?tag= is the tag filter (Filters). ?creator= and ?collection= are
//   the creator and collection filters, which the Creators and Collections
//   pages' Show in the library link sets (Task 21). Each change reloads the
//   grid from GET /app/api/library with all four.
// - Numbered pages (Jon, 2026-11-19, replacing Load more): 48 models a page
//   (PAGE_SIZE), the page in ?page= (paging.ts), with Previous, Next and the
//   page numbers below the grid (Pager). A new search or filter is a new
//   address without ?page=, so it starts at page 1; Back and Forward and a
//   shared link give the same page. A page past the end shows the last page,
//   which the server sends, and says so. After a page change from the pager,
//   focus moves to the count above the grid once the new page is in.
// - View all (?view=all) shows every match for the search and filters on one
//   page. It asks for VIEW_ALL_CHUNK models a request, one request after
//   another, showing each as it comes, so no request makes the server compute
//   more than 200 cards; it stops at VIEW_ALL_MAX, the server's paged match
//   cap, and says so. Thumbnails load lazily (ModelCard). A chunk that fails
//   keeps the models shown and says so beside a Try again that goes on from
//   that chunk. The Pages and View all choice shows when there is more than
//   one page, or in View all.
// - Sort (Jon, 2026-11-19): the Sort menu (SortControl) sets ?sort=, which
//   the request carries unless it is the default (best match while a search
//   is active, else newest), and which the server orders by. A new sort is a
//   new address at page 1; the pager, View all and the tag chips keep it.
// - Select mode (Jon, 2026-11-19): the Select button (aria-pressed) turns
//   the cards into checkboxes (ModelCard; a click or Space toggles one) and
//   shows the selection toolbar (SelectBar) with the count, the select-all
//   choices and the bulk actions. The selection is kept across pages and
//   filters until it is cleared or Select mode ends; Escape or Select again
//   ends it, clears the selection and puts focus back on Select. An action
//   that changes models reloads the grid in place: the cards shown stay,
//   with the scroll position and the toolbar's counts, until the new answer
//   is in (in View all, until every chunk is in again).
// - The count shows the total ("171 models") or, with a search or filter,
//   how many match of the whole library ("12 of 171 models"); with more
//   matches than the server counts, "1000+" and a note.
// - An active creator or collection filter is shown above the grid, each
//   with a Clear link (a studio.css chip, so Tab reaches it and the focus
//   ring draws on it) to the same address without that filter, at page 1.
// - The header says which printer the times and weights are for, in full.
//   With more than one of My printers it is a menu (PrinterSwitch) that
//   asks for the grid again with ?printer=; it reads only, and starts no
//   slicing. The choice is kept per browser. The switch stays on the page
//   while the grid reloads, drawn from the last answer's printers and showing
//   the new choice, so a keyboard user's focus stays on it (on Windows an
//   arrow key on a focused, closed select chooses at once).
// - The page asks the server for nothing but /app/api: the cards and the tag
//   list. The only images are the /blobs/<id> plate thumbnails the API names
//   (ModelCard), so rendering the library never downloads a model file.
// - The whole page is a drop zone: files dropped on it go to onFiles, which
//   opens the upload dialog. refreshKey reloads the grid (after an upload).
// - Loading, an empty library, no results and a failed load each say so in
//   words, and a failed load can be tried again.
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { type PrinterChoice, PrinterSwitch, usePrinterChoice } from "../settings/PrinterSwitch";
import { DropZone } from "../upload/DropZone";
import { Filters } from "./Filters";
import { type LibraryCard, ModelCard } from "./ModelCard";
import { Pager } from "./Pager";
import {
  defaultSort,
  isViewAll,
  libraryHref,
  PAGE_SIZE,
  pageFrom,
  pageHref,
  sortFrom,
  VIEW_ALL_CHUNK,
  VIEW_ALL_MAX,
} from "./paging";
import { SelectBar } from "./SelectBar";
import { SortControl } from "./SortControl";
import "./library.css";

export interface LibraryPageProps {
  /** Files dropped on the library; the app opens the upload dialog with them. */
  onFiles?: (files: File[]) => void;
  /** Change it to reload the grid, for example once an upload has finished. */
  refreshKey?: number;
}

/**
 * GET /app/api/library's answer. A numbered page carries the page fields; a
 * cursor page (an answer without them) is read as one page holding every
 * model it lists.
 */
interface LibraryAnswer {
  /** The printer the numbers are for. */
  printer: string;
  printerName: string;
  /** The printer switch's choices: My printers. */
  printers: PrinterChoice[];
  models: LibraryCard[];
  page?: number;
  pageCount?: number;
  total?: number;
  totalCapped?: boolean;
  libraryTotal?: number;
}

interface Answer {
  printer: string;
  printerName: string;
  printers: PrinterChoice[];
  models: LibraryCard[];
  page: number;
  pageCount: number;
  total: number;
  totalCapped: boolean;
  libraryTotal: number;
}

function read(answer: LibraryAnswer): Answer {
  const total = answer.total ?? answer.models.length;
  return {
    printer: answer.printer,
    printerName: answer.printerName,
    printers: answer.printers,
    models: answer.models,
    page: answer.page ?? 1,
    pageCount: answer.pageCount ?? 1,
    total,
    totalCapped: answer.totalCapped ?? false,
    libraryTotal: answer.libraryTotal ?? total,
  };
}

interface Ready extends Answer {
  state: "ready";
  /** View all: the next chunk to ask for, or null once every chunk is in. */
  nextChunk: number | null;
  /** View all: the last chunk failed; the models shown are kept. */
  restFailed: boolean;
}

type Load = { state: "loading" } | { state: "failed" } | Ready;

/** The header switch's fields from the last answer, kept while the grid reloads. */
type PrinterHeader = Pick<Answer, "printer" | "printerName" | "printers">;

/** The chunk after chunk, or null when that was the last or View all is full. */
function chunkAfter(chunk: number, answer: Answer, shown: number): number | null {
  if (answer.page < chunk) return null; // the server served an earlier, last chunk
  return chunk < answer.pageCount && shown < VIEW_ALL_MAX ? chunk + 1 : null;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return (await res.json()) as T;
}

function models(n: number): string {
  return n === 1 ? "model" : "models";
}

export function LibraryPage({ onFiles, refreshKey = 0 }: LibraryPageProps) {
  const [params] = useSearchParams();
  const q = params.get("q")?.trim() ?? "";
  const tag = params.get("tag")?.trim() ?? "";
  const creator = params.get("creator")?.trim() ?? "";
  const collection = params.get("collection")?.trim() ?? "";
  const viewAll = isViewAll(params);
  const page = viewAll ? 1 : pageFrom(params.get("page"));
  const sort = sortFrom(params, q);
  /** The sort the server is told: none for the default, which it applies itself. */
  const sentSort = sort === defaultSort(q) ? "" : sort;
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Map<string, string | null>>(() => new Map());
  const [dialogOpen, setDialogOpen] = useState(false);
  const selectButton = useRef<HTMLButtonElement>(null);
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [tags, setTags] = useState<string[]>([]);
  /** Bumped after a bulk action, which can change which tags live models carry. */
  const [tagsKey, setTagsKey] = useState(0);
  const [attempt, setAttempt] = useState(0);
  /** Bumped after a bulk action: the grid reloads in place, keeping the cards shown. */
  const [changedKey, setChangedKey] = useState(0);
  /** What the shown grid was asked for, so a reload for the same thing is told apart. */
  const loadedFor = useRef("");
  const generation = useRef(0);
  /** The current load's controller, so a View all retry is cancelled with it. */
  const loading = useRef<AbortController | null>(null);
  /** A pager link was followed: focus the count once the new page is in. */
  const focusCount = useRef(false);
  const count = useRef<HTMLParagraphElement>(null);
  /** The header's printer switch: whose times and weights the cards show. */
  const printer = usePrinterChoice();
  const { choice, settle: settlePrinter } = printer;
  const [header, setHeader] = useState<PrinterHeader | null>(null);

  /**
   * The search, filters, printer switch and sort, as the library's app API
   * takes them: the grid, View all's chunks and Select all matching alike,
   * so a time or weight order is for the printer the header shows.
   */
  const matching = useCallback(() => {
    const search = new URLSearchParams();
    if (q !== "") search.set("q", q);
    if (tag !== "") search.set("tag", tag);
    if (creator !== "") search.set("creator", creator);
    if (collection !== "") search.set("collection", collection);
    if (choice !== null) search.set("printer", choice);
    if (sentSort !== "") search.set("sort", sentSort);
    return search;
  }, [q, tag, creator, collection, choice, sentSort]);

  const query = useCallback(
    (at: number, limit: number) => {
      const search = matching();
      search.set("page", String(at));
      search.set("limit", String(limit));
      return `/app/api/library?${search}`;
    },
    [matching],
  );

  /** Leaves Select mode, clearing the selection, with focus back on Select. */
  const stopSelecting = useCallback(() => {
    setSelecting(false);
    setSelected(new Map());
    selectButton.current?.focus();
  }, []);

  // Escape leaves Select mode, unless a dialog is open: Escape is the dialog's then.
  useEffect(() => {
    if (!selecting || dialogOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !event.defaultPrevented) stopSelecting();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selecting, dialogOpen, stopSelecting]);

  function toggle(card: LibraryCard) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(card.id)) next.delete(card.id);
      else next.set(card.id, card.name);
      return next;
    });
  }

  /** The library's own address without one of its filters, at page 1. */
  function without(key: "creator" | "collection"): string {
    return libraryHref(params, (next) => {
      next.delete(key);
      next.delete("page");
    });
  }

  const active = [
    { key: "creator" as const, label: "Creator", value: creator },
    { key: "collection" as const, label: "Collection", value: collection },
  ].filter((f) => f.value !== "");
  const filtered = q !== "" || tag !== "" || active.length > 0;

  /**
   * View all's chunks from ready.nextChunk on, one request at a time. Quiet,
   * each is gathered and the whole is shown once the last is in, so the cards
   * already shown are not cut back to the first chunk meanwhile.
   */
  const loadRest = useCallback(
    async (from: Ready, mine: number, signal: AbortSignal, quiet = false) => {
      let shown = from;
      while (shown.nextChunk !== null) {
        const chunk = shown.nextChunk;
        try {
          const answer = read(await getJson<LibraryAnswer>(query(chunk, VIEW_ALL_CHUNK), signal));
          if (mine !== generation.current) return;
          // A model added between two requests can move another onto the next
          // chunk; it is shown once.
          const seen = new Set(shown.models.map((m) => m.id));
          const all = [...shown.models, ...answer.models.filter((m) => !seen.has(m.id))].slice(
            0,
            VIEW_ALL_MAX,
          );
          shown = {
            ...shown,
            ...answer,
            models: all,
            page: 1,
            nextChunk: chunkAfter(chunk, answer, all.length),
            restFailed: false,
          };
          if (!quiet || shown.nextChunk === null) setLoad(shown);
        } catch {
          if (!signal.aborted && mine === generation.current) {
            setLoad({ ...shown, restFailed: true });
          }
          return;
        }
      }
    },
    [query],
  );

  // The grid, again whenever the search, a filter, the page, View all, a
  // refresh or a retry changes, and in place after a bulk action (changedKey):
  // a reload of what is shown keeps the cards until the new answer is in.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey, attempt and changedKey only trigger a reload.
  useEffect(() => {
    const controller = new AbortController();
    loading.current = controller;
    const mine = ++generation.current;
    const first = viewAll ? 1 : page;
    const url = query(first, viewAll ? VIEW_ALL_CHUNK : PAGE_SIZE);
    const asked = `${viewAll}|${refreshKey}|${attempt}|${url}`;
    const quiet = asked === loadedFor.current;
    loadedFor.current = asked;
    if (!quiet) setLoad({ state: "loading" });
    else {
      // The shown cards stay, but not an earlier View all failure: its Try
      // again would start a second loader from the old cards beside this one.
      setLoad((shown) =>
        shown.state === "ready" && shown.restFailed ? { ...shown, restFailed: false } : shown,
      );
    }
    getJson<LibraryAnswer>(url, controller.signal)
      .then((raw) => {
        if (mine !== generation.current) return;
        const answer = read(raw);
        const ready: Ready = {
          state: "ready",
          ...answer,
          nextChunk: viewAll ? chunkAfter(1, answer, answer.models.length) : null,
          restFailed: false,
        };
        if (ready.nextChunk === null) setLoad(ready);
        else {
          if (!quiet) setLoad(ready);
          void loadRest(ready, mine, controller.signal, quiet);
        }
        setHeader({
          printer: answer.printer,
          printerName: answer.printerName,
          printers: answer.printers,
        });
        settlePrinter(answer.printer);
      })
      .catch(() => {
        if (!controller.signal.aborted && mine === generation.current) setLoad({ state: "failed" });
      });
    return () => controller.abort();
  }, [query, page, viewAll, loadRest, refreshKey, attempt, changedKey]);

  // The library's tags, again on a refresh or after a bulk action (tagsKey),
  // since adding, removing or trashing changes which tags live models carry:
  // the tag filter, Remove tag and Add tags all read this list.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey and tagsKey only trigger a reload.
  useEffect(() => {
    const controller = new AbortController();
    getJson<{ tags: string[] }>("/app/api/library/tags", controller.signal)
      .then((answer) => setTags(answer.tags))
      .catch(() => {
        // The filter is a convenience: without it the grid still works.
      });
    return () => controller.abort();
  }, [refreshKey, tagsKey]);

  // Focus follows a pager link to the new page's count, once it is in.
  useEffect(() => {
    if (load.state === "loading" || !focusCount.current) return;
    focusCount.current = false;
    if (load.state === "ready") count.current?.focus();
  }, [load]);

  function retryRest() {
    const controller = loading.current;
    if (load.state !== "ready" || controller === null) return;
    const from: Ready = { ...load, restFailed: false };
    setLoad(from);
    void loadRest(from, generation.current, controller.signal);
  }

  const heading = q === "" ? "Library" : `Results for "${q}"`;
  const ready = load.state === "ready" ? load : null;
  const totalLabel = ready === null ? "" : `${ready.total}${ready.totalCapped ? "+" : ""}`;
  const whole =
    ready === null
      ? ""
      : filtered
        ? `${totalLabel} of ${ready.libraryTotal} ${models(ready.libraryTotal)}`
        : `${totalLabel} ${ready.totalCapped ? "models" : models(ready.total)}`;
  let countText = whole;
  if (ready !== null && viewAll) {
    // A capped total means more matches than View all can reach, so never "all shown".
    countText =
      ready.models.length < ready.total || ready.totalCapped
        ? `Showing ${ready.models.length} of ${totalLabel} ${models(ready.total)}`
        : `${whole}, all shown`;
  } else if (ready !== null && ready.pageCount > 1) {
    countText = `${whole}, page ${ready.page} of ${ready.pageCount}`;
  }
  const pastEnd = ready !== null && !viewAll && ready.total > 0 && page > ready.page;
  const viewAllFull =
    ready !== null &&
    viewAll &&
    ready.nextChunk === null &&
    ready.models.length >= VIEW_ALL_MAX &&
    ready.total > ready.models.length;
  const capNote =
    ready !== null && (ready.totalCapped || viewAllFull)
      ? `Only the first ${ready.totalCapped ? ready.total : VIEW_ALL_MAX} matches can be shown. Narrow the search or pick a tag to find the rest.`
      : null;
  const showChoice = ready !== null && ready.total > 0 && (viewAll || ready.pageCount > 1);
  // While the grid reloads for a new choice, the switch already shows it.
  const chosen = load.state === "ready" ? undefined : header?.printers.find((p) => p.id === choice);
  const shownPrinter =
    header === null
      ? null
      : chosen === undefined
        ? header
        : { ...header, printer: chosen.id, printerName: chosen.name };

  return (
    <DropZone onFiles={(files) => onFiles?.(files)}>
      <div className="studio-page-head">
        <h1>{heading}</h1>
        {shownPrinter !== null && shownPrinter.printer !== "" ? (
          <PrinterSwitch
            printer={shownPrinter.printer}
            printerName={shownPrinter.printerName}
            printers={shownPrinter.printers}
            onChoose={printer.choose}
          />
        ) : null}
      </div>
      {active.length === 0 ? null : (
        <ul className="studio-chips" aria-label="Library filters">
          {active.map((f) => (
            <li key={f.key} className="studio-row">
              <span>
                {f.label}: <strong>{f.value}</strong>
              </span>
              <Link to={without(f.key)} className="studio-chip">
                Clear {f.key} filter
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Filters tags={tags} />
      <div className="ph-library-tools">
        <SortControl q={q} printer={shownPrinter?.printerName ?? ""} />
        <button
          ref={selectButton}
          type="button"
          className="studio-button ph-small"
          aria-pressed={selecting}
          onClick={() => (selecting ? stopSelecting() : setSelecting(true))}
        >
          Select
        </button>
      </div>
      {selecting ? (
        <SelectBar
          selected={selected}
          shown={ready?.models ?? []}
          total={ready?.total ?? 0}
          totalCapped={ready?.totalCapped ?? false}
          matching={matching()}
          tags={tags}
          onChange={setSelected}
          onChanged={() => {
            setChangedKey((n) => n + 1);
            setTagsKey((n) => n + 1);
          }}
          onDialog={setDialogOpen}
        />
      ) : null}
      <div aria-live="polite">
        {load.state === "loading" ? <p className="studio-muted">Loading the library</p> : null}
        {load.state === "failed" ? (
          <div className="studio-alert studio-alert-alert" role="alert">
            <p>The library could not be loaded.</p>
            <button
              type="button"
              className="studio-button"
              onClick={() => setAttempt((n) => n + 1)}
            >
              Try again
            </button>
          </div>
        ) : null}
        {ready !== null && ready.models.length === 0 ? (
          <p className="studio-empty">
            {!filtered
              ? "No models yet. Drop files here, or use Add."
              : "No models match. Try another search or tag."}
          </p>
        ) : null}
        {pastEnd ? (
          <p className="studio-muted">
            There is no page {page}. This is the last page, page {ready?.page}.
          </p>
        ) : null}
        {capNote === null ? null : <p className="studio-muted">{capNote}</p>}
      </div>
      {ready !== null && ready.models.length > 0 ? (
        <>
          <div className="ph-library-bar">
            <p id="ph-library-count" className="studio-muted" tabIndex={-1} ref={count}>
              {countText}
            </p>
            {showChoice ? (
              <ul className="studio-chips" aria-label="Library view">
                <li>
                  <Link
                    to={pageHref(params, 1)}
                    className="studio-chip"
                    {...(viewAll ? {} : { "aria-current": "true" as const })}
                  >
                    Pages
                  </Link>
                </li>
                <li>
                  <Link
                    to={libraryHref(params, (next) => {
                      next.delete("page");
                      next.set("view", "all");
                    })}
                    className="studio-chip"
                    {...(viewAll ? { "aria-current": "true" as const } : {})}
                  >
                    View all
                  </Link>
                </li>
              </ul>
            ) : null}
          </div>
          <ul className="studio-grid" aria-label="Models">
            {ready.models.map((card) =>
              selecting ? (
                <ModelCard
                  key={card.id}
                  card={card}
                  selection={{ selected: selected.has(card.id), onToggle: () => toggle(card) }}
                />
              ) : (
                <ModelCard key={card.id} card={card} />
              ),
            )}
          </ul>
          {!viewAll && ready.pageCount > 1 ? (
            <Pager
              page={ready.page}
              pageCount={ready.pageCount}
              hrefFor={(n) => pageHref(params, n)}
              onNavigate={() => {
                focusCount.current = true;
              }}
            />
          ) : null}
          {viewAll && ready.nextChunk !== null ? (
            <div className="studio-pager">
              {ready.restFailed ? (
                <>
                  <p className="studio-muted" role="alert">
                    The rest of the library could not be loaded.
                  </p>
                  <button type="button" className="studio-button" onClick={retryRest}>
                    Try again
                  </button>
                </>
              ) : (
                <p className="studio-muted">Loading the rest of the library</p>
              )}
            </div>
          ) : null}
        </>
      ) : null}
    </DropZone>
  );
}
