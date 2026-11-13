// The web app's entry (build plan Task 18). React Router in library mode;
// the shell wraps every page. The library (Task 19) is the page at /; the
// other sections arrive with Tasks 20 and 21 (model, creators, collections,
// tags, trash and settings) and until then show their heading. The theme
// starts from what the server wrote into the html element, so the first
// paint is already right.
//
// The upload dialog (Task 19) lives here, above the routes, so the top bar's
// Add opens it on every page, files dropped on the library open it with
// those files, and uploads keep going while it is hidden. When an upload
// round finishes, the library reloads.
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import "./styles/studio.css";
import { LibraryPage } from "./library/LibraryPage";
import { Shell } from "./shell/Shell";
import { SECTIONS } from "./shell/Sidebar";
import { readTheme } from "./shell/theme";
import { UploadDialog } from "./upload/UploadDialog";

function Section({ title }: { title: string }) {
  return (
    <>
      <h1>{title}</h1>
      <p className="studio-empty">Nothing here yet.</p>
    </>
  );
}

function App() {
  const [uploadOpen, setUploadOpen] = useState(false);
  const [dropped, setDropped] = useState<File[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  function openWith(files: File[]) {
    setDropped(files);
    setUploadOpen(true);
  }

  return (
    <Shell initialTheme={readTheme(document)} onAdd={() => openWith([])}>
      <Routes>
        <Route path="/" element={<LibraryPage onFiles={openWith} refreshKey={refreshKey} />} />
        {SECTIONS.filter(({ to }) => to !== "/").map(({ label, to }) => (
          <Route key={to} path={to} element={<Section title={label} />} />
        ))}
        <Route path="*" element={<Section title="Page not found" />} />
      </Routes>
      <UploadDialog
        open={uploadOpen}
        files={dropped}
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
