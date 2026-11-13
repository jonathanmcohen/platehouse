// The web app's entry (build plan Task 18). React Router in library mode;
// the shell wraps every page. The library (Task 19) is the page at /, and
// Task 21's pages (creators, collections, tags, trash and settings) are
// routed at their sections; a section without a page would show its
// heading. The theme starts from what the server wrote into the html
// element, so the first paint is already right.
//
// The upload dialog (Task 19) lives here, above the routes, so the top bar's
// Add opens it on every page, files dropped on the library open it with
// those files, and uploads keep going while it is hidden. When an upload
// round finishes, the library reloads.
//
// The model page (Task 20) is at /models/:id. Files dropped on it open a
// dialog aimed at that model (modelId), where the Combine switch is not
// shown (Jon, 2026-11-12); Add and a drop on the library open the dialog for
// new models. There is one dialog per target, never one dialog whose target
// changes: the dialog for new models, and one for each model files were
// dropped on, each mounted from its first use for as long as the app runs.
// The dialog sends every unsent row to its target when Upload is pressed
// and keeps unsent rows while a round is still sending, so a shared dialog
// would send files dropped on a model, and left unsent, to new models after
// a drop on the library (and the reverse). With a dialog per target, a row
// goes where it was added, and uploads in a hidden dialog keep going. When
// an upload round finishes, the model page reloads too.
import { type ReactNode, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import "./styles/studio.css";
import { CollectionsPage } from "./collections/CollectionsPage";
import { CreatorsPage } from "./creators/CreatorsPage";
import { LibraryPage } from "./library/LibraryPage";
import { ModelPage } from "./model/ModelPage";
import { SettingsPage } from "./settings/SettingsPage";
import { Shell } from "./shell/Shell";
import { SECTIONS } from "./shell/Sidebar";
import { readTheme } from "./shell/theme";
import { TagsPage } from "./tags/TagsPage";
import { TrashPage } from "./trash/TrashPage";
import { UploadDialog } from "./upload/UploadDialog";

function Section({ title }: { title: string }) {
  return (
    <>
      <h1>{title}</h1>
      <p className="studio-empty">Nothing here yet.</p>
    </>
  );
}

/** The upload dialog for new models (Add and a library drop), by its key. */
const NEW_MODELS = "";

/** A dialog with nothing dropped for it yet. */
const NO_FILES: File[] = [];

/** The page at each section path other than / that has one (Task 21). */
const PAGES: Readonly<Record<string, ReactNode>> = {
  "/creators": <CreatorsPage />,
  "/collections": <CollectionsPage />,
  "/tags": <TagsPage />,
  "/trash": <TrashPage />,
  "/settings": <SettingsPage />,
};

function App() {
  /** The open dialog's key: NEW_MODELS or a model id; null when none is open. */
  const [openFor, setOpenFor] = useState<string | null>(null);
  /**
   * The files last dropped for each dialog, by its key (each new array is
   * added to that dialog once). A model id is here from its first drop, so
   * its dialog, with its rows and uploads, stays mounted.
   */
  const [dropped, setDropped] = useState<Readonly<Record<string, File[]>>>({});
  const [refreshKey, setRefreshKey] = useState(0);

  function openWith(files: File[], modelId?: string) {
    const key = modelId ?? NEW_MODELS;
    setDropped((all) => ({ ...all, [key]: files }));
    setOpenFor(key);
  }

  const targets = [NEW_MODELS, ...Object.keys(dropped).filter((key) => key !== NEW_MODELS)];

  return (
    <Shell initialTheme={readTheme(document)} onAdd={() => openWith([])}>
      <Routes>
        <Route
          path="/"
          element={<LibraryPage onFiles={(files) => openWith(files)} refreshKey={refreshKey} />}
        />
        <Route
          path="/models/:id"
          element={<ModelPage onFiles={openWith} refreshKey={refreshKey} />}
        />
        {SECTIONS.filter(({ to }) => to !== "/").map(({ label, to }) => (
          <Route key={to} path={to} element={PAGES[to] ?? <Section title={label} />} />
        ))}
        <Route path="*" element={<Section title="Page not found" />} />
      </Routes>
      {targets.map((key) => (
        <UploadDialog
          key={key === NEW_MODELS ? "new" : `model:${key}`}
          open={openFor === key}
          files={dropped[key] ?? NO_FILES}
          {...(key === NEW_MODELS ? {} : { modelId: key })}
          onClose={() => setOpenFor(null)}
          onUploaded={() => setRefreshKey((n) => n + 1)}
        />
      ))}
    </Shell>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
