// The model page at /models/:id: a large viewer on the left and the tabs
// Plates, Files and About on the right, Plates first.
//
// - The large viewer is on the left and the tabs Plates, Files and About on
//   the right (studio.css's .studio-model grid, which stacks below 900 px).
//   Plates is first, and shown only when the model has a .3mf. The tabs are
//   an ARIA tablist: the arrow keys, Home and End move between them, and
//   only the chosen tab is in the Tab order.
// - The viewer starts on the first .3mf, whose plate thumbnails show large
//   with a strip of plates (PlateViewer). Show in 3D, or a click on the
//   picture, shows that plate's objects in the 3D viewer (issue #358). An
//   STL, a STEP's mesh or a SCAD's rendered STL shows in the 3D viewer
//   (Viewer3d) at once. three.js is loaded only when a 3D view is shown.
//   View in the Files tab moves the viewer to another file.
// - Everything comes from one request, GET /app/api/models/:id. While any
//   plate is estimating (isEstimating) or any STEP, SCAD or STL file is still
//   having its mesh, render or preview made (isDeriving: derivedStatus or
//   previewStatus 'pending'), the page asks again every POLL_MS (5 s), on one
//   timer for both
//   (needsPolling). So a render that lands after an upload shows in the
//   viewer, with View in the Files tab, without a reload, and a render that
//   fails shows its reason. Polling stops when nothing is estimating or
//   being rendered, when the page unmounts and when it moves to another
//   model: the timer is cleared and the request in flight aborted, and an
//   answer that comes back after that is dropped, so no request is made
//   after unmount and an earlier model's answer never replaces the one
//   navigated to.
// - A reload that fails while the model is on screen keeps the model shown
//   and says it could not refresh, with Try again. While the page is
//   polling it is also asked again in POLL_MS, and the next successful
//   load clears the notice; otherwise (a reload after an upload or a Retry)
//   it is not asked again. A 401 ends the asking either way and says the
//   user is signed out; so does a 401 on the first load, with no Try
//   again, since asking again cannot help.
// - The Plates tab's printer switch (PrinterSwitch) picks which of My
//   printers' numbers the plates show: the page asks for the model again
//   with ?printer=, and only reads; no slicing starts. The choice is kept
//   per browser, shared with the library. While the new answer loads (or
//   after it failed), the switch shows the new choice, not the printer the
//   numbers on screen are for (PlatesTab's switchPrinter, #255).
// - Retry on a failed plate posts to /app/api/estimates/:id/retry (the
//   gate's Origin check passes a same-origin fetch) and loads the model
//   again, which starts the polling while the plate estimates. A refusal
//   reaches the plate as the server's AppApiError (Numbers.tsx puts it in
//   words), except a 409 not_retryable: that loads the model again and is
//   said by the page, in a status line that names the file and plate,
//   because the answer it asks for often no longer has the plate (its file
//   was removed) or the printer (taken out of My printers). Its lifetime is
//   set out at Refused below.
// - Files dropped on the page go to onFiles with this model's id; main.tsx
//   opens the upload dialog aimed at this model, where the Combine
//   switch is not shown. refreshKey changes when an upload round finishes,
//   and the page loads the model again.
// - The page head's name is renamed in place with the collections pages'
//   InlineRename, saved through PATCH /app/api/models/:id (the same route
//   and 500-character limit), shown at once and then read back from the
//   server. A rename makes the name the user's, so no title from a later
//   upload replaces it. Beside the creator, View on MakerWorld opens the
//   model's MakerWorld page in a new tab, only when the server named one
//   and it is a makerworld.com model page (AboutTab's MakerWorldLink).
// - Add files, a button in the page head, calls onFiles with no files and
//   this model's id, which opens the same dialog with the rows it already
//   has. It is the keyboard route to this model's dialog (the top bar's Add
//   opens the dialog for new models), and the way back to it after it was
//   hidden: a row that failed, with its reason, or was left unsent, and
//   the progress of a hidden upload, are there without dropping a file.
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { InlineRename } from "../collections/InlineRename";
import { type I18n, type MessageKey, useI18n } from "../i18n/I18n";
import { AppApiError, appApi } from "../settings/api";
import { type PrinterChoice, printerQuery, usePrinterChoice } from "../settings/PrinterSwitch";
import { DropZone } from "../upload/DropZone";
import { isHidden } from "../visibility";
import "./model.css";
import { AboutTab, MakerWorldLink, makerWorldHref } from "./AboutTab";
import { derivedMessageIn, FilesTab, formatSize, previewStatusWords, viewable } from "./FilesTab";
import type { Platform } from "./OpenInSlicer";
import { PlatesTab } from "./PlatesTab";
import { PlateViewer } from "./PlateViewer";
import { type ThreeLoader, Viewer3d } from "./Viewer3d";

export type FileKind = "3mf" | "stl" | "step" | "scad";

export type ParseStatus = "pending" | "ok" | "no_plate_data" | "unavailable";

export interface FilamentNumbers {
  slot: number;
  type: string;
  color: string | null;
  grams: number | null;
  profile: string | null;
  profileSource: "bambu" | "generic" | "file" | null;
}

export interface Numbers {
  source: "file" | "platehouse";
  estimateId: string;
  printerId: string;
  printerLabel: string;
  /** The printer in full, such as "Bambu Lab P1S, 0.4 mm nozzle". */
  printerName: string;
  slicer: string | null;
  slicerVersion: string | null;
  processProfile: string | null;
  timeSeconds: number | null;
  weightGrams: number | null;
  filaments: FilamentNumbers[];
}

export interface PlatehouseNumbers extends Numbers {
  state: "current" | "estimating" | "stale";
  staleFor?: string;
}

export interface PlateFailure {
  estimateId: string;
  reason: string;
  words: string;
  detail: string | null;
}

export interface PlateNumbers {
  file?: Numbers;
  platehouse?: PlatehouseNumbers;
  failure?: PlateFailure;
}

export interface ModelPlate {
  id: string;
  index: number;
  name: string | null;
  objectCount: number;
  thumbnail: string | null;
  numbers: PlateNumbers;
  /** Whether an estimate for the selected printer is queued or slicing now. */
  estimatePending: boolean;
}

export interface ProjectFilament {
  slot: number;
  type: string;
  color: string | null;
}

/** One file as GET /app/api/models/:id answers it (apps/server/src/app-api/model.ts). */
export interface ModelFile {
  id: string;
  name: string;
  kind: FileKind;
  size: number;
  parseStatus: ParseStatus;
  derivedStatus: string | null;
  derivedMessage: string | null;
  /**
   * The sentences of derivedMessage that Platehouse wrote, by code, for the
   * page to show in its language (app API only); absent from an older answer.
   */
  derivedCodes?: string[];
  /** What derivedMessage holds after those sentences: the program's own words. */
  derivedDetail?: string | null;
  /**
   * An STL's or STEP file's preview picture (issue #380): null, pending, ok
   * or failed, apart from derivedStatus; absent from an older answer.
   */
  previewStatus?: string | null;
  /** Why the picture failed, as the server wrote it; null with none. */
  previewMessage?: string | null;
  /** Platehouse's own sentences at the start of previewMessage, by code. */
  previewCodes?: string[];
  /** What previewMessage holds after those sentences. */
  previewDetail?: string | null;
  download: string;
  view: { kind: "stl" | "glb"; url: string } | null;
  preview: string | null;
  filaments: ProjectFilament[];
  plates: ModelPlate[];
}

/** What GET /app/api/models/:id answers. */
export interface ModelView {
  id: string;
  name: string;
  caption: string | null;
  description: string | null;
  creator: string | null;
  license: string | null;
  licenseNote: string | null;
  /** The design's MakerWorld page, or null; only a makerworld.com model page is linked. */
  makerWorldUrl?: string | null;
  tags: string[];
  collections: string[];
  /** The printer the numbers are for: the default printer, or the switch's choice. */
  printer: string;
  /** That printer in full. */
  printerName: string;
  /** The printer switch's choices: My printers. */
  printers: PrinterChoice[];
  files: ModelFile[];
}

export interface ModelPageProps {
  /** three.js for the 3D viewer; the real one, imported on first use, when left out. */
  loadThree?: ThreeLoader;
  /** Goes to a slicer's protocol URL; window.location.assign when left out. */
  navigateTo?: (url: string) => void;
  /** Read from the browser when left out. */
  platform?: Platform;
  /**
   * Files dropped on the page, with this model's id, for the upload dialog;
   * Add files calls it with none, to open that dialog as it is.
   */
  onFiles?: (files: File[], modelId: string) => void;
  /** Changes when an upload round finishes; the page loads the model again. */
  refreshKey?: number;
}

/** How often the page asks again while a plate is estimating or a file is being rendered. */
export const POLL_MS = 5000;

/** An STL over this many bytes opens on its picture, and in 3D only when asked (issue #469). */
export const STL_3D_THRESHOLD_BYTES = 50 * 1024 * 1024;

/**
 * Whether a plate is waiting on its estimate: it is estimating, or an older
 * estimate is shown while the new one is queued or slicing (stale, with the
 * server saying an estimate for the selected printer is pending). A stale
 * set alone is not enough: an older estimate also stays shown when no new
 * one was ever queued, such as when the stored printer is no longer in the
 * slicer's menu or the menu could not be read, and then nothing is coming.
 */
export function isEstimating(plate: Pick<ModelPlate, "numbers" | "estimatePending">): boolean {
  const { numbers, estimatePending } = plate;
  const state = numbers.platehouse?.state;
  if (state === "estimating") return true;
  return state === "stale" && estimatePending && numbers.failure === undefined;
}

/**
 * Whether a STEP's mesh, a SCAD's render or an STL's or STEP's preview
 * picture is still being made: derivedStatus (the mesh or render) or
 * previewStatus (the picture, issue #380) is 'pending' while its job is
 * queued or running, then 'ok' or 'failed'. derivedStatus is null for a
 * .3mf and an STL; previewStatus is null for every kind but STL and STEP,
 * and before a picture is queued.
 */
export function isDeriving(file: ModelFile): boolean {
  return file.derivedStatus === "pending" || file.previewStatus === "pending";
}

/** Whether the page should ask again: a plate is estimating or a file is being rendered. */
export function needsPolling(model: ModelView): boolean {
  return model.files.some((f) => isDeriving(f) || f.plates.some((p) => isEstimating(p)));
}

type Load =
  | { id: string; status: "loading" }
  | { id: string; status: "ready"; model: ModelView }
  | { id: string; status: "missing" }
  | { id: string; status: "failed" }
  | { id: string; status: "signed-out" };

type TabName = "plates" | "files" | "about";

/** The plate a Retry is for, so a refusal can name it after the plate has left the page. */
export interface RetryTarget {
  fileName: string;
  plate: Pick<ModelPlate, "index" | "name">;
  /** Whether the model has more than one .3mf, so a message names the file. */
  inFile: boolean;
}

/**
 * A Retry refused as not retryable (409), on the model with this id: the
 * plate it was for, and how many answers have landed since.
 *
 * The notice's lifetime: a 409 not_retryable is a one-shot notice, never
 * state to be proven stale. It is shown until the answer after the one the
 * 409 asked for lands, whatever that answer shows, or until another Retry
 * is pressed, the user chooses another printer or the page is left,
 * whichever comes first. After that the plates show only what the answer
 * says. It is the page's, not the plate's, so it stays when the answer no
 * longer has the plate (its file was removed). Of printer changes, only
 * the user's own choice on the switch ends it: an answer for another
 * printer than the one chosen (the chosen one was taken out of My
 * printers, so the server fell back to the default) is not a switch, and
 * the request the page then makes without the forgotten choice (settle)
 * asks for that same answer again, so it is not counted as the next one.
 */
interface Refused {
  id: string;
  target: RetryTarget;
  answers: number;
}

/** A plate in words for a message: "plate 2" or "plate 2 Huge". */
function plateWords(target: RetryTarget, t: I18n["t"]): string {
  return target.plate.name === null
    ? t("activity.plate", { index: target.plate.index })
    : t("activity.plateNamed", { index: target.plate.index, name: target.plate.name });
}

const TAB_LABEL: Record<TabName, MessageKey> = {
  plates: "model.tab.plates",
  files: "model.tab.files",
  about: "model.tab.about",
};

export function ModelPage({
  loadThree,
  navigateTo,
  platform,
  onFiles,
  refreshKey = 0,
}: ModelPageProps) {
  const { t } = useI18n();
  const { id = "" } = useParams();
  const [load, setLoad] = useState<Load>({ id, status: "loading" });
  const [reload, setReload] = useState(0);
  /** The model id whose model is on screen, so a failed poll keeps it. */
  const shownFor = useRef<string | null>(null);
  /** When the last answer arrived (ms), so showing the tab again within POLL_MS asks nothing. */
  const answeredAt = useRef(0);
  /** Whether the model on screen needs polling (needsPolling), so a failed poll is asked again. */
  const polling = useRef(false);
  /** Why the model on screen could not be refreshed, for that model's id. */
  const [notice, setNotice] = useState<{ id: string; kind: "failed" | "signed-out" } | null>(null);
  /** The printer switch's choice: whose numbers the plates show. */
  const printer = usePrinterChoice();
  const { choice, settle: settlePrinter } = printer;
  const [refused, setRefused] = useState<Refused | null>(null);
  /** What a successful Retry says, for that model's id; the latest of this and the refusal wins. */
  const [queued, setQueued] = useState<{ id: string; words: string } | null>(null);
  /** Whether the last answer made the page forget its printer choice, so the next request only asks for it again. */
  const forgetting = useRef(false);
  if (refused !== null && refused.id !== id) setRefused(null);
  if (queued !== null && queued.id !== id) setQueued(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload and refreshKey are triggers: a change of either loads the model again.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    let inFlight = false;

    /** Asks again in POLL_MS, unless the tab is hidden: it asks once when it is shown (onVisibility). */
    function askLater() {
      if (timer !== undefined) clearTimeout(timer);
      timer = isHidden() ? undefined : setTimeout(fetchModel, POLL_MS);
    }

    /** A failed load; status is the answer's, undefined when no answer came. */
    function failed(status?: number) {
      // A 401 will not change by asking again, first load or not: it says
      // the user is signed out and offers no Try again.
      forgetting.current = false;
      const first = shownFor.current !== id;
      if (status === 401) {
        if (first) setLoad({ id, status: "signed-out" });
        else setNotice({ id, kind: "signed-out" });
        return;
      }
      // Any other failed first load says so, with Try again.
      if (first) {
        setLoad({ id, status: "failed" });
        return;
      }
      // A failed poll or reload keeps the model on screen, says it could not
      // be refreshed, and is asked again only while the page is polling; the
      // next successful load clears the notice.
      setNotice({ id, kind: "failed" });
      if (polling.current) askLater();
    }

    async function fetchModel() {
      timer = undefined;
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await fetch(
          `/app/api/models/${encodeURIComponent(id)}${printerQuery(choice)}`,
          {
            credentials: "same-origin",
            headers: { accept: "application/json" },
            signal: controller.signal,
          },
        );
        if (cancelled) return;
        if (res.status === 404) {
          setLoad({ id, status: "missing" });
          return;
        }
        if (!res.ok) {
          failed(res.status);
          return;
        }
        const model = (await res.json()) as ModelView;
        if (cancelled) return;
        // An answer landed for the refusal's notice (Refused), unless it
        // only asked again for the last one without a forgotten choice.
        if (!forgetting.current) {
          setRefused((was) =>
            was === null ? null : was.answers === 0 ? { ...was, answers: 1 } : null,
          );
        }
        forgetting.current = choice !== null && model.printer !== "" && model.printer !== choice;
        shownFor.current = id;
        polling.current = needsPolling(model);
        answeredAt.current = Date.now();
        setNotice(null);
        setLoad({ id, status: "ready", model });
        settlePrinter(model.printer);
        if (polling.current) askLater();
      } catch {
        if (cancelled) return;
        failed();
      } finally {
        inFlight = false;
      }
    }

    function onVisibility() {
      if (isHidden()) {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
      } else if (polling.current && !inFlight) {
        if (timer !== undefined) clearTimeout(timer);
        const wait = POLL_MS - (Date.now() - answeredAt.current);
        if (wait > 0) timer = setTimeout(fetchModel, wait);
        else void fetchModel();
      }
    }

    document.addEventListener("visibilitychange", onVisibility);
    void fetchModel();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [id, reload, refreshKey, choice]);

  /**
   * Queues a failed estimate again and loads the model again. A refusal
   * rejects with the server's AppApiError for the plate to put in words; a
   * 409 not_retryable is said here instead (Refused), naming the plate, and
   * loads the model again, since the estimate has moved on (it is usually
   * no longer failed).
   */
  async function retry(estimateId: string, target: RetryTarget): Promise<void> {
    setRefused(null);
    setQueued(null);
    try {
      await appApi("POST", `/estimates/${encodeURIComponent(estimateId)}/retry`);
    } catch (failure) {
      if (failure instanceof AppApiError && failure.status === 409) {
        setRefused({ id, target, answers: 0 });
        setReload((n) => n + 1);
      }
      throw failure;
    }
    const plate = plateWords(target, t);
    setQueued({
      id,
      words: target.inFile
        ? t("model.numbers.queuedIn", { plate, file: target.fileName })
        : t("model.numbers.queued", { plate }),
    });
    setReload((n) => n + 1);
  }

  /** The user's own choice on the printer switch, which ends a refusal's notice. */
  function choosePrinter(printerId: string) {
    setRefused(null);
    setQueued(null);
    printer.choose(printerId);
  }

  /**
   * Saves a new name through the app API (PATCH /app/api/models/:id, the
   * collections pages' route and limits) and shows it at once; the model is
   * then asked for again, so the page shows what was stored. Rejects with
   * the server's sentence, which the rename form shows.
   */
  async function rename(name: string): Promise<void> {
    await appApi("PATCH", `/models/${encodeURIComponent(id)}`, { name });
    setLoad((was) =>
      was.id === id && was.status === "ready" ? { ...was, model: { ...was.model, name } } : was,
    );
    setReload((n) => n + 1);
  }

  const current: Load = load.id === id ? load : { id, status: "loading" };

  if (current.status === "loading") {
    return <p className="studio-muted">{t("model.loading")}</p>;
  }
  if (current.status === "missing") {
    return (
      <>
        <h1>{t("model.missing.title")}</h1>
        <p>{t("model.missing.text")}</p>
        <p>
          <Link to="/">{t("model.missing.back")}</Link>
        </p>
      </>
    );
  }
  if (current.status === "signed-out") {
    return (
      <div role="alert" className="studio-alert studio-alert-alert">
        <p>{t("common.signedOut")}</p>
      </div>
    );
  }
  if (current.status === "failed") {
    return (
      <div role="alert" className="studio-alert studio-alert-alert">
        <p>{t("model.loadFailed")}</p>
        <button type="button" className="studio-button" onClick={() => setReload((n) => n + 1)}>
          {t("common.tryAgain")}
        </button>
      </div>
    );
  }

  const { model } = current;
  return (
    <DropZone onFiles={(files) => onFiles?.(files, model.id)}>
      {notice?.id !== model.id ? null : notice.kind === "signed-out" ? (
        <div role="alert" className="studio-alert studio-alert-alert">
          <p>{t("common.signedOut")}</p>
        </div>
      ) : (
        <div role="alert" className="studio-alert studio-alert-alert">
          <p>{t("model.refreshFailed")}</p>
          <button type="button" className="studio-button" onClick={() => setReload((n) => n + 1)}>
            {t("common.tryAgain")}
          </button>
        </div>
      )}
      {/* Always in the page, so a screen reader hears what is put in it. */}
      <div role="status">
        {refused === null ? null : (
          <p className="studio-alert studio-alert-alert">
            {t("model.numbers.notRetryable", {
              file: refused.target.fileName,
              plate: plateWords(refused.target, t),
            })}
          </p>
        )}
        {queued === null ? null : <p className="studio-muted">{queued.words}</p>}
      </div>
      <ModelDetail
        key={model.id}
        model={model}
        onRetry={retry}
        onChoosePrinter={choosePrinter}
        chosenPrinter={choice}
        onRename={rename}
        loadThree={loadThree}
        navigateTo={navigateTo}
        platform={platform}
        {...(onFiles === undefined ? {} : { onAddFiles: () => onFiles([], model.id) })}
      />
    </DropZone>
  );
}

interface ModelDetailProps {
  model: ModelView;
  /** Queues a failed estimate again; rejects with the server's AppApiError when refused. */
  onRetry(estimateId: string, target: RetryTarget): Promise<void>;
  /** The printer switch: shows another printer's numbers. */
  onChoosePrinter(printerId: string): void;
  /** The switch's stored choice, which may still be loading. */
  chosenPrinter: string | null;
  /** Saves a new model name; rejects with what went wrong. */
  onRename(name: string): Promise<void>;
  loadThree?: ThreeLoader | undefined;
  navigateTo?: ((url: string) => void) | undefined;
  platform?: Platform | undefined;
  /** Opens this model's upload dialog with no new files (Add files). */
  onAddFiles?: () => void;
}

/** The first file the viewer shows: the first .3mf, else the first file it can show. */
function firstShown(model: ModelView): string | null {
  const first =
    model.files.find((f) => f.kind === "3mf") ?? model.files.find(viewable) ?? model.files[0];
  return first?.id ?? null;
}

function ModelDetail({
  model,
  onRetry,
  onChoosePrinter,
  chosenPrinter,
  onRename,
  loadThree,
  navigateTo,
  platform,
  onAddFiles,
}: ModelDetailProps) {
  const { t } = useI18n();
  const base = useId();
  const has3mf = model.files.some((f) => f.kind === "3mf");
  const tabNames: TabName[] = has3mf ? ["plates", "files", "about"] : ["files", "about"];
  const [tab, setTab] = useState<TabName>(tabNames[0] ?? "files");
  const [shownId, setShownId] = useState<string | null>(() => firstShown(model));
  const [plateIndex, setPlateIndex] = useState(1);
  const tabRefs = useRef(new Map<TabName, HTMLButtonElement>());

  const shown = model.files.find((f) => f.id === shownId) ?? null;
  // A reload of the same model keeps this component's state, so when the
  // viewer names no file of the model (it had none, or the one shown has
  // gone), pick the first file again: the first upload into an empty model
  // shows in the viewer.
  if (shown === null) {
    const next = firstShown(model);
    if (next !== shownId) {
      setShownId(next);
      setPlateIndex(1);
    }
  }

  function choose(next: TabName, focus: boolean) {
    setTab(next);
    if (focus) tabRefs.current.get(next)?.focus();
  }

  function onTabKey(event: KeyboardEvent<HTMLButtonElement>, at: number) {
    const last = tabNames.length - 1;
    const to =
      event.key === "ArrowRight"
        ? at === last
          ? 0
          : at + 1
        : event.key === "ArrowLeft"
          ? at === 0
            ? last
            : at - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : undefined;
    if (to === undefined) return;
    event.preventDefault();
    const next = tabNames[to];
    if (next !== undefined) choose(next, true);
  }

  function view(fileId: string) {
    setShownId(fileId);
    setPlateIndex(1);
  }

  return (
    <article>
      <div className="studio-page-head">
        <p className="studio-breadcrumb">
          <Link to="/">{t("library.title")}</Link>
        </p>
        <InlineRename
          heading
          value={model.name}
          buttonLabel={t("common.renameLabel", { name: model.name })}
          inputLabel={t("common.newNameLabel", { name: model.name })}
          onSave={onRename}
        />
        {model.creator === null && makerWorldHref(model.makerWorldUrl) === null ? null : (
          <p className="studio-byline">
            {model.creator === null ? null : t("model.byline", { creator: model.creator })}
            {model.creator === null || makerWorldHref(model.makerWorldUrl) === null ? null : " - "}
            <MakerWorldLink url={model.makerWorldUrl} />
          </p>
        )}
        {onAddFiles === undefined ? null : (
          <button type="button" className="studio-button" onClick={onAddFiles}>
            {t("model.addFiles")}
          </button>
        )}
      </div>
      <div className="studio-model">
        <section className="studio-viewer" aria-label={t("model.viewer")}>
          <ViewerArea
            file={shown}
            plateIndex={plateIndex}
            onPlate={setPlateIndex}
            loadThree={loadThree}
          />
        </section>
        <div className="studio-model-info">
          <div className="studio-tabs" role="tablist" aria-label={t("model.details")}>
            {tabNames.map((name, at) => (
              <button
                key={name}
                ref={(el) => {
                  if (el === null) tabRefs.current.delete(name);
                  else tabRefs.current.set(name, el);
                }}
                type="button"
                role="tab"
                id={`${base}-tab-${name}`}
                aria-selected={tab === name}
                aria-controls={`${base}-panel-${name}`}
                tabIndex={tab === name ? 0 : -1}
                onClick={() => choose(name, false)}
                onKeyDown={(event) => onTabKey(event, at)}
              >
                {t(TAB_LABEL[name])}
              </button>
            ))}
          </div>
          {tabNames.map((name) => (
            <div
              key={name}
              role="tabpanel"
              id={`${base}-panel-${name}`}
              aria-labelledby={`${base}-tab-${name}`}
              className="studio-panel"
              // A panel can hold nothing a keyboard reaches yet still scroll or be read; it
              // is a tab stop so the keyboard can reach its content (APG tabs).
              // biome-ignore lint/a11y/noNoninteractiveTabindex: the APG tabs pattern gives a panel tabindex 0 when it may hold no focusable control.
              tabIndex={0}
              hidden={tab !== name}
            >
              {name === "plates" ? (
                <PlatesTab
                  model={model}
                  onRetry={onRetry}
                  onChoosePrinter={onChoosePrinter}
                  chosenPrinter={chosenPrinter}
                  navigateTo={navigateTo}
                  platform={platform}
                />
              ) : name === "files" ? (
                <FilesTab
                  files={model.files}
                  shown={shownId}
                  onView={view}
                  navigateTo={navigateTo}
                  platform={platform}
                />
              ) : (
                <AboutTab model={model} />
              )}
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}

interface ViewerAreaProps {
  file: ModelFile | null;
  plateIndex: number;
  onPlate(index: number): void;
  loadThree?: ThreeLoader | undefined;
}

function ViewerArea({ file, plateIndex, onPlate, loadThree }: ViewerAreaProps) {
  const i18n = useI18n();
  const { t } = i18n;
  /** The large STL the person asked to see in 3D, by file id. */
  const [asked, setAsked] = useState<string | null>(null);
  const derived = file === null ? null : derivedMessageIn(i18n, file);
  // Another file shown forgets the ask: coming back to a large STL asks again.
  if (asked !== null && asked !== (file?.id ?? null)) setAsked(null);
  if (file === null) {
    return (
      <div className="studio-viewer-frame">
        <p className="studio-placeholder">{t("model.noFiles")}</p>
      </div>
    );
  }
  const showIn3d = (
    <button type="button" className="studio-button" onClick={() => setAsked(file.id)}>
      {t("model.showIn3d", { size: formatSize(file.size, i18n.fmt) })}
    </button>
  );
  if (file.kind === "3mf") {
    return (
      <PlateViewer
        key={file.id}
        file={file}
        selected={plateIndex}
        onSelect={onPlate}
        loadThree={loadThree}
      />
    );
  }
  // A large STL is held back by its size alone, picture or not: fetching and
  // parsing it is the work asked of the person first.
  const holdBack = file.kind === "stl" && file.size > STL_3D_THRESHOLD_BYTES && asked !== file.id;
  if (file.view !== null && !holdBack) {
    return (
      <Viewer3d
        key={file.id}
        focusOnShow={asked === file.id}
        source={file.view}
        label={file.name}
        download={file.download}
        loadThree={loadThree}
      />
    );
  }
  if (file.preview !== null) {
    return (
      <div className="studio-viewer-frame">
        <img
          className="studio-plate-large"
          src={file.preview}
          alt={t("model.previewOf", { name: file.name })}
        />
        {file.view !== null ? showIn3d : null}
      </div>
    );
  }
  if (holdBack && file.view !== null) {
    return (
      <div className="studio-viewer-frame">
        <p className="studio-placeholder">
          {previewStatusWords(file, i18n) ?? t("model.noViewYet", { name: file.name })}
        </p>
        {showIn3d}
      </div>
    );
  }
  // A render that failed says so, with the reason the server gave (a
  // sentence of its own, or the program's message, as text).
  if (file.derivedStatus === "failed") {
    return (
      <div className="studio-viewer-frame">
        <div className="studio-placeholder ph-viewer-failed">
          <p>{t("model.renderFailed", { name: file.name })}</p>
          {derived === null ? null : <pre className="ph-detail">{derived}</pre>}
        </div>
      </div>
    );
  }
  return (
    <div className="studio-viewer-frame">
      <p className="studio-placeholder">{t("model.noViewYet", { name: file.name })}</p>
    </div>
  );
}
