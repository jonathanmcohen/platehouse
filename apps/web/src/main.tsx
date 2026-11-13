// The web app's entry (build plan Task 18). React Router in library mode;
// the shell wraps every page. The pages themselves arrive with Tasks 19 to
// 21 (library, model, creators, collections, tags, trash and settings);
// until then each section shows its heading. The theme starts from what the
// server wrote into the html element, so the first paint is already right.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import "./styles/studio.css";
import { Shell } from "./shell/Shell";
import { SECTIONS } from "./shell/Sidebar";
import { readTheme } from "./shell/theme";

function Section({ title }: { title: string }) {
  return (
    <>
      <h1>{title}</h1>
      <p className="studio-empty">Nothing here yet.</p>
    </>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <Shell initialTheme={readTheme(document)}>
        <Routes>
          {SECTIONS.map(({ label, to }) => (
            <Route key={to} path={to} element={<Section title={label} />} />
          ))}
          <Route path="*" element={<Section title="Page not found" />} />
        </Routes>
      </Shell>
    </BrowserRouter>
  </StrictMode>,
);
