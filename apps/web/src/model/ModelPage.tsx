// The model page at /models/:id (build plan Task 20; AC-030, AC-032 to
// AC-034 display, AC-040, AC-050, AC-051, AC-072).
//
// - The large viewer is on the left and the tabs Plates, Files and About on
//   the right (studio.css's .studio-model grid, which stacks below 900 px).
//   Plates is first, and shown only when the model has a .3mf. The tabs are
//   an ARIA tablist: the arrow keys, Home and End move between them, and
//   only the chosen tab is in the Tab order.
// - The viewer starts on the first .3mf, whose plate thumbnails show large
//   with a strip of plates (PlateViewer; never a 3D view). An STL, a STEP's
//   mesh or a SCAD's rendered STL shows in the 3D viewer (Viewer3d), which
//   loads three.js only then. View in the Files tab moves the viewer to
//   another file.
// - Everything comes from one request, GET /app/api/models/:id. While any
//   plate is estimating (isEstimating), the page asks again every POLL_MS
//   (5 s). Polling stops when nothing is estimating, when the page unmounts
//   and when it moves to another model: the timer is cleared and the
//   request in flight aborted, and an answer that comes back after that is
//   dropped, so no request is made after unmount and an earlier model's
//   answer never replaces the one navigated to.
// - A reload that fails while the model is on screen keeps the model shown
//   and says it could not refresh, with Try again. While a plate is
//   estimating it is also asked again in POLL_MS, and the next successful
//   load clears the notice; otherwise (a reload after an upload or a Retry)
//   it is not asked again. A 401 ends the asking either way and says the
//   user is signed out.
// - Retry on a failed plate posts to /app/api/estimates/:id/retry (the
//   gate's Origin check passes a same-origin fetch) and loads the model
//   again, which starts the polling while the plate estimates.
// - Files dropped on the page go to onFiles with this model's id; main.tsx
//   opens Task 19's upload dialog aimed at this model, where the Combine
//   switch is not shown. refreshKey changes when an upload round finishes,
//   and the page loads the model again.
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { DropZone } from "../upload/DropZone";
import "./model.css";
import { AboutTab } from "./AboutTab";
import { FilesTab, viewable } from "./FilesTab";
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
  tags: string[];
  collections: string[];
  printer: string;
  files: ModelFile[];
}

export interface ModelPageProps {
  /** three.js for the 3D viewer; the real one, imported on first use, when left out. */
  loadThree?: ThreeLoader;
  /** Goes to a slicer's protocol URL; window.location.assign when left out. */
  navigateTo?: (url: string) => void;
  /** Read from the browser when left out. */
  platform?: Platform;
  /** Files dropped on the page, with this model's id, for the upload dialog. */
  onFiles?: (files: File[], modelId: string) => void;
  /** Changes when an upload round finishes; the page loads the model again. */
  refreshKey?: number;
}

/** How often the page asks again while a plate is estimating. */
export const POLL_MS = 5000;

/**
 * Whether a plate is waiting on its estimate: it is estimating, or an older
 * estimate is shown while the new one is queued or slicing (stale with no
 * failure).
 */
export function isEstimating(numbers: PlateNumbers): boolean {
  const state = numbers.platehouse?.state;
  if (state === "estimating") return true;
  return state === "stale" && numbers.failure === undefined;
}

/** Whether any plate of the model is estimating. */
export function needsPolling(model: ModelView): boolean {
  return model.files.some((f) => f.plates.some((p) => isEstimating(p.numbers)));
}

type Load =
  | { id: string; status: "loading" }
  | { id: string; status: "ready"; model: ModelView }
  | { id: string; status: "missing" }
  | { id: string; status: "failed" };

type TabName = "plates" | "files" | "about";

const TAB_LABEL: Record<TabName, string> = { plates: "Plates", files: "Files", about: "About" };

export function ModelPage({
  loadThree,
  navigateTo,
  platform,
  onFiles,
  refreshKey = 0,
}: ModelPageProps) {
  const { id = "" } = useParams();
  const [load, setLoad] = useState<Load>({ id, status: "loading" });
  const [reload, setReload] = useState(0);
  /** The model id whose model is on screen, so a failed poll keeps it. */
  const shownFor = useRef<string | null>(null);
  /** Whether the model on screen has a plate estimating, so a failed poll is asked again. */
  const polling = useRef(false);
  /** Why the model on screen could not be refreshed, for that model's id. */
  const [notice, setNotice] = useState<{ id: string; kind: "failed" | "signed-out" } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload and refreshKey are triggers: a change of either loads the model again.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    /** A failed load; status is the answer's, undefined when no answer came. */
    function failed(status?: number) {
      // A failed first load says so, with Try again.
      if (shownFor.current !== id) {
        setLoad({ id, status: "failed" });
        return;
      }
      // A failed poll or reload keeps the model on screen. A 401 will not
      // change by asking again. Anything else says the model could not be
      // refreshed, and is asked again only while a plate is estimating; the
      // next successful load clears the notice.
      if (status === 401) {
        setNotice({ id, kind: "signed-out" });
        return;
      }
      setNotice({ id, kind: "failed" });
      if (polling.current) timer = setTimeout(fetchModel, POLL_MS);
    }

    async function fetchModel() {
      timer = undefined;
      try {
        const res = await fetch(`/app/api/models/${encodeURIComponent(id)}`, {
          credentials: "same-origin",
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
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
        shownFor.current = id;
        polling.current = needsPolling(model);
        setNotice(null);
        setLoad({ id, status: "ready", model });
        if (polling.current) timer = setTimeout(fetchModel, POLL_MS);
      } catch {
        if (cancelled) return;
        failed();
      }
    }

    void fetchModel();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [id, reload, refreshKey]);

  async function retry(estimateId: string): Promise<boolean> {
    const res = await fetch(`/app/api/estimates/${encodeURIComponent(estimateId)}/retry`, {
      method: "POST",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (res.status !== 202) return false;
    setReload((n) => n + 1);
    return true;
  }

  const current: Load = load.id === id ? load : { id, status: "loading" };

  if (current.status === "loading") {
    return <p className="studio-muted">Loading the model...</p>;
  }
  if (current.status === "missing") {
    return (
      <>
        <h1>Model not found</h1>
        <p>This model is not in the library. It may have been moved to the trash.</p>
        <p>
          <Link to="/">Back to the library</Link>
        </p>
      </>
    );
  }
  if (current.status === "failed") {
    return (
      <div role="alert" className="studio-alert studio-alert-alert">
        <p>The model could not be loaded right now.</p>
        <button type="button" className="studio-button" onClick={() => setReload((n) => n + 1)}>
          Try again
        </button>
      </div>
    );
  }

  const { model } = current;
  return (
    <DropZone onFiles={(files) => onFiles?.(files, model.id)}>
      {notice?.id !== model.id ? null : notice.kind === "signed-out" ? (
        <div role="alert" className="studio-alert studio-alert-alert">
          <p>You are signed out. Reload the page to sign in again.</p>
        </div>
      ) : (
        <div role="alert" className="studio-alert studio-alert-alert">
          <p>The model could not be refreshed right now.</p>
          <button type="button" className="studio-button" onClick={() => setReload((n) => n + 1)}>
            Try again
          </button>
        </div>
      )}
      <ModelDetail
        key={model.id}
        model={model}
        onRetry={retry}
        loadThree={loadThree}
        navigateTo={navigateTo}
        platform={platform}
      />
    </DropZone>
  );
}

interface ModelDetailProps {
  model: ModelView;
  onRetry(estimateId: string): Promise<boolean>;
  loadThree?: ThreeLoader | undefined;
  navigateTo?: ((url: string) => void) | undefined;
  platform?: Platform | undefined;
}

/** The first file the viewer shows: the first .3mf, else the first file it can show. */
function firstShown(model: ModelView): string | null {
  const first =
    model.files.find((f) => f.kind === "3mf") ?? model.files.find(viewable) ?? model.files[0];
  return first?.id ?? null;
}

function ModelDetail({ model, onRetry, loadThree, navigateTo, platform }: ModelDetailProps) {
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
          <Link to="/">Library</Link>
        </p>
        <h1>{model.name}</h1>
        {model.creator === null ? null : <p className="studio-byline">by {model.creator}</p>}
      </div>
      <div className="studio-model">
        <section className="studio-viewer" aria-label="Viewer">
          <ViewerArea
            file={shown}
            plateIndex={plateIndex}
            onPlate={setPlateIndex}
            loadThree={loadThree}
          />
        </section>
        <div className="studio-model-info">
          <div className="studio-tabs" role="tablist" aria-label="Model details">
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
                {TAB_LABEL[name]}
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
              hidden={tab !== name}
            >
              {name === "plates" ? (
                <PlatesTab
                  model={model}
                  onRetry={onRetry}
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
  if (file === null) {
    return (
      <div className="studio-viewer-frame">
        <p className="studio-placeholder">This model has no files.</p>
      </div>
    );
  }
  if (file.kind === "3mf") {
    return <PlateViewer file={file} selected={plateIndex} onSelect={onPlate} />;
  }
  if (file.view !== null) {
    return (
      <Viewer3d
        source={file.view}
        label={file.name}
        download={file.download}
        loadThree={loadThree}
      />
    );
  }
  return (
    <div className="studio-viewer-frame">
      {file.preview === null ? (
        <p className="studio-placeholder">
          {file.derivedMessage === null
            ? `No view of ${file.name} yet.`
            : `${file.name} could not be rendered.`}
        </p>
      ) : (
        <img className="studio-plate-large" src={file.preview} alt={`Preview of ${file.name}`} />
      )}
    </div>
  );
}
