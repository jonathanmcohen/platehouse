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
// The model page (Task 20) is at /models/:id. Files dropped on it open the
// same dialog aimed at that model (modelId), where the Combine switch is not
// shown (Jon, 2026-11-12); Add and a drop on the library aim it at new
// models again. When an upload round finishes, the model page reloads too.
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

/** The page at each section path other than / that has one (Task 21). */
const PAGES: Readonly<Record<string, ReactNode>> = {
  "/creators": <CreatorsPage />,
  "/collections": <CollectionsPage />,
  "/tags": <TagsPage />,
  "/trash": <TrashPage />,
  "/settings": <SettingsPage />,
};

function App() {
  const [uploadOpen, setUploadOpen] = useState(false);
  const [dropped, setDropped] = useState<File[]>([]);
  /** The model a model-page drop aims the dialog at; undefined for new models. */
  const [uploadModel, setUploadModel] = useState<string | undefined>(undefined);
  const [refreshKey, setRefreshKey] = useState(0);

  function openWith(files: File[], modelId?: string) {
    setUploadModel(modelId);
    setDropped(files);
    setUploadOpen(true);
  }

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
      <UploadDialog
        open={uploadOpen}
        files={dropped}
        {...(uploadModel === undefined ? {} : { modelId: uploadModel })}
        onClose={() => setUploadOpen(false)}
        onUploaded={() => setRefreshKey((n) => n + 1)}
      />
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
