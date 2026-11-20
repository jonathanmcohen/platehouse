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
//   choices and the bulk actions. The selection holds only models the search
//   and filters show (0.1.0-rc.2 live check): it is kept across pages, View
//   all and a new sort, but a new search or filter, or an action that takes
//   a model out of the view, takes the models the view no longer shows out
//   of it, and the toolbar says how many. Escape or Select again
//   ends it, clears the selection and puts focus back on Select. Escape is
//   left alone while another overlay that takes it is open (otherOverlayOpen):
//   a modal dialog, the upload dialog among them, or the narrow-screen menu,
//   so closing one never throws the selection away. An action
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
import { useI18n } from "../i18n/I18n";
import { type PrinterChoice, PrinterSwitch, usePrinterChoice } from "../settings/PrinterSwitch";
import { menuIsOpen } from "../shell/MenuButton";
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
import { keepShown } from "./selection";
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
  /**
   * The changedKey these cards were asked for: behind changedKey while the
   * grid's quiet reload after an action is still on its way.
   */
  changed: number;
}

type Load = { state: "loading" } | { state: "failed" } | Ready;

/**
 * Where the check of the selection against the view stands: nothing to
 * check, asking, failed, or done with the ids the view can show.
 */
type ViewCheck =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "failed" }
  | { state: "done"; shown: ReadonlySet<string> };

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

export function LibraryPage({ onFiles, refreshKey = 0 }: LibraryPageProps) {
  const { t, rich, fmt } = useI18n();
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

  /** The search, filters, printer and sort as one string: a new one is a new set of matches. */
  const matchKey = matching().toString();
  const [check, setCheck] = useState<ViewCheck>({ state: "idle" });
  const [checkAttempt, setCheckAttempt] = useState(0);
  /** How many selected models the last check took out of the selection. */
  const [left, setLeft] = useState(0);
  const selectedNow = useRef(selected);
  selectedNow.current = selected;
  /** The changedKey the last check ran for, so a check after an action is told apart. */
  const checkedAfter = useRef(changedKey);
  /**
   * The cards on screen were drawn before the last action: the grid's reload
   * after it is not in yet, so a card can show a model the view no longer has.
   */
  const staleCards = load.state === "ready" && load.changed !== changedKey;
  /**
   * The latest view check and stale-card state, for selection writes that
   * land after the render that started them (refused reads these, never a
   * render's own copy, issue #315).
   */
  const checkNow = useRef(check);
  checkNow.current = check;
  const staleNow = useRef(staleCards);
  staleNow.current = staleCards;
  /**
   * Which view a late selection write was asked for in: the count moves on
   * whenever Select mode starts or ends, the search, filters, sort or
   * printer change, or an action finishes. Select all matching passes the
   * count it was asked in, and an answer from an earlier one is dropped:
   * its ids are another view's, or predate an action that may have taken
   * some of them out of the view.
   */
  const viewTurn = `${selecting}|${matchKey}|${changedKey}`;
  const era = useRef({ turn: viewTurn, n: 0 });
  if (era.current.turn !== viewTurn) era.current = { turn: viewTurn, n: era.current.n + 1 };

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
    setLeft(0);
    selectButton.current?.focus();
  }, []);

  // The selection against the view (0.1.0-rc.2 live check): the selection
  // only ever holds models the search and filters show, so an action never
  // acts on one the user cannot see. After the search, a filter, the sort or
  // the printer changes (matchKey), after an action (changedKey), after an
  // upload (refreshKey) and on Try again, the page asks for the ids the view
  // can show and the selection keeps only those; the toolbar says how many
  // left. An empty selection has nothing to check, except after an action,
  // whose cards stay shown until the grid's reload is in: the answer then
  // stops one of them being selected (refused). That holds for as long as
  // those cards are shown (staleCards), so leaving Select mode and entering
  // it again before the reload is in checks again rather than going idle.
  // Until the answer is in the actions wait, and a failed check keeps them
  // waiting until Try again works.
  // biome-ignore lint/correctness/useExhaustiveDependencies: changedKey, refreshKey and checkAttempt only trigger a check; staleCards is read when one runs, and the reload that ends it needs no check.
  useEffect(() => {
    const afterAction = checkedAfter.current !== changedKey || staleCards;
    checkedAfter.current = changedKey;
    if (!selecting || (selectedNow.current.size === 0 && !afterAction)) {
      setCheck({ state: "idle" });
      return;
    }
    const controller = new AbortController();
    setCheck({ state: "checking" });
    getJson<{ ids: string[] }>(`/app/api/library/ids?${matchKey}`, controller.signal)
      .then((answer) => {
        if (controller.signal.aborted) return;
        const shown = new Set(answer.ids);
        setLeft(keepShown(selectedNow.current, shown).left);
        setSelected((now) => keepShown(now, shown).kept);
        setCheck({ state: "done", shown });
      })
      .catch(() => {
        if (!controller.signal.aborted) setCheck({ state: "failed" });
      });
    return () => controller.abort();
  }, [selecting, matchKey, changedKey, refreshKey, checkAttempt]);

  /**
   * A card drawn before the last action whose model the check after it says
   * the view no longer shows. Only while the grid's reload after the action
   * is on its way: once it is in, every card is the view's own, so a model
   * added since the check (from another tab, say) can be selected. Read
   * from the latest check, so a write that lands late sees it.
   */
  function refused(id: string): boolean {
    const latest = checkNow.current;
    return staleNow.current && latest.state === "done" && !latest.shown.has(id);
  }

  // Every selection write goes through these, as an update of the selection
  // as it is when the write lands, never a copy taken when it started: a
  // view check that took a model out meanwhile is kept (issue #315). Since
  // the server refuses to act on a model the view hides (each bulk request
  // names its view), these keep the count true; they are not the guard.

  /**
   * Adds models (a name, or null when the page never showed the card),
   * leaving out cards refused. asked is the era the write was started in;
   * a write from an earlier one is dropped. Answers whether it was taken.
   */
  function addToSelection(entries: Array<[string, string | null]>, asked: number): boolean {
    if (asked !== era.current.n) return false;
    setSelected((now) => {
      const next = new Map(now);
      for (const [id, name] of entries) {
        if (refused(id)) continue;
        if (!next.has(id) || (next.get(id) === null && name !== null)) next.set(id, name);
      }
      return next;
    });
    return true;
  }

  /** Takes models out of the selection: ones an action trashed, failed on or left alone. */
  function removeFromSelection(ids: Iterable<string>) {
    const gone = new Set(ids);
    setSelected((now) => new Map([...now].filter(([id]) => !gone.has(id))));
  }

  /**
   * Clear selection. Emptied, it has nothing left to check or to report;
   * but a failed check after an action stays failed while that action's old
   * cards are shown, so the actions stay off for one of them selected again
   * until Try again gets an answer.
   */
  function clearSelection() {
    setSelected(new Map());
    setLeft(0);
    if (check.state === "failed" && !staleCards) setCheck({ state: "idle" });
  }

  // Escape leaves Select mode, unless a dialog is open: Escape is the dialog's then.
  // Select mode's own dialogs remove this listener (dialogOpen); any other
  // overlay is asked about on each key (otherOverlayOpen), since its document
  // listener is added later and so runs after this one.
  useEffect(() => {
    if (!selecting || dialogOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (otherOverlayOpen(event)) return;
      stopSelecting();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [selecting, dialogOpen, stopSelecting]);

  function toggle(card: LibraryCard) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(card.id)) next.delete(card.id);
      // A card the view no longer shows (still drawn while the grid reloads
      // after an action) is not added.
      else if (!refused(card.id)) next.set(card.id, card.name);
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
    {
      key: "creator" as const,
      label: t("library.filter.creator"),
      clear: t("library.filter.clearCreator"),
      value: creator,
    },
    {
      key: "collection" as const,
      label: t("library.filter.collection"),
      clear: t("library.filter.clearCollection"),
      value: collection,
    },
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
          changed: changedKey,
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

  const heading = q === "" ? t("library.title") : t("library.results", { q });
  const ready = load.state === "ready" ? load : null;
  const totalLabel =
    ready === null
      ? ""
      : ready.totalCapped
        ? t("library.count.atLeast", { count: ready.total })
        : fmt.decimal(ready.total, 0);
  const whole =
    ready === null
      ? ""
      : filtered
        ? t("library.count.matchesOf", { matches: totalLabel, total: ready.libraryTotal })
        : ready.totalCapped
          ? t("library.count.modelsCapped", { count: ready.total })
          : t("library.count.models", { count: ready.total });
  let countText = whole;
  if (ready !== null && viewAll) {
    // A capped total means more matches than View all can reach, so never "all shown".
    countText =
      ready.models.length < ready.total || ready.totalCapped
        ? t("library.count.showing", {
            shown: ready.models.length,
            matches: totalLabel,
            total: ready.total,
          })
        : t("library.count.allShown", { whole });
  } else if (ready !== null && ready.pageCount > 1) {
    countText = t("library.count.page", { whole, page: ready.page, pages: ready.pageCount });
  }
  const pastEnd = ready !== null && !viewAll && ready.total > 0 && page > ready.page;
  /**
   * The page the address asked for, as the past-the-end note names it: page
   * is clamped to PAGE_MAX for the request, so the note reads ?page= itself
   * (issue #241), as a number while one holds it exactly, else as its digits.
   */
  const askedDigits = (params.get("page") ?? "").replace(/^0+(?=[0-9])/, "");
  const askedPage = Number.isSafeInteger(Number(askedDigits)) ? Number(askedDigits) : askedDigits;
  const viewAllFull =
    ready !== null &&
    viewAll &&
    ready.nextChunk === null &&
    ready.models.length >= VIEW_ALL_MAX &&
    ready.total > ready.models.length;
  const capNote =
    ready !== null && (ready.totalCapped || viewAllFull)
      ? t("library.cap", { count: ready.totalCapped ? ready.total : VIEW_ALL_MAX })
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
        <ul className="studio-chips" aria-label={t("library.filters.label")}>
          {active.map((f) => (
            <li key={f.key} className="studio-row">
              <span>
                {rich(
                  "library.filter.value",
                  { label: f.label, value: f.value },
                  {
                    strong: (children) => <strong>{children}</strong>,
                  },
                )}
              </span>
              <Link to={without(f.key)} className="studio-chip">
                {f.clear}
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
          {t("library.selectMode")}
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
          check={check.state === "checking" || check.state === "failed" ? check.state : null}
          left={left}
          onCheckAgain={() => setCheckAttempt((n) => n + 1)}
          era={() => era.current.n}
          onAdd={addToSelection}
          onRemove={removeFromSelection}
          onClear={clearSelection}
          onChanged={() => {
            setChangedKey((n) => n + 1);
            setTagsKey((n) => n + 1);
          }}
          onDialog={setDialogOpen}
        />
      ) : null}
      <div aria-live="polite">
        {load.state === "loading" ? <p className="studio-muted">{t("library.loading")}</p> : null}
        {load.state === "failed" ? (
          <div className="studio-alert studio-alert-alert" role="alert">
            <p>{t("library.failed")}</p>
            <button
              type="button"
              className="studio-button"
              onClick={() => setAttempt((n) => n + 1)}
            >
              {t("common.tryAgain")}
            </button>
          </div>
        ) : null}
        {ready !== null && ready.models.length === 0 ? (
          <p className="studio-empty">
            {!filtered ? t("library.empty.none") : t("library.empty.noMatch")}
          </p>
        ) : null}
        {pastEnd ? (
          <p className="studio-muted">
            {t("library.pastEnd", { page: askedPage, last: ready?.page ?? 1 })}
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
              <ul className="studio-chips" aria-label={t("library.view.label")}>
                <li>
                  <Link
                    to={pageHref(params, 1)}
                    className="studio-chip"
                    {...(viewAll ? {} : { "aria-current": "true" as const })}
                  >
                    {t("library.view.pages")}
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
                    {t("library.view.all")}
                  </Link>
                </li>
              </ul>
            ) : null}
          </div>
          <ul className="studio-grid" aria-label={t("library.models.label")}>
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
                    {t("library.rest.failed")}
                  </p>
                  <button type="button" className="studio-button" onClick={retryRest}>
                    {t("common.tryAgain")}
                  </button>
                </>
              ) : (
                <p className="studio-muted">{t("library.rest.loading")}</p>
              )}
            </div>
          ) : null}
        </>
      ) : null}
    </DropZone>
  );
}

/**
 * Another overlay that takes Escape for itself is open: a modal dialog (the
 * upload dialog, mounted beside the library, opens from the top bar's Add or
 * a drop on the library), the key came from inside a dialog, or the
 * narrow-screen menu is open. Their document listeners are added after Select
 * mode's, so their preventDefault comes too late for Select mode to see.
 */
function otherOverlayOpen(event: KeyboardEvent): boolean {
  if (document.querySelector('[aria-modal="true"]') !== null) return true;
  if (event.target instanceof Element && event.target.closest('[role="dialog"]') !== null) {
    return true;
  }
  return menuIsOpen();
}
