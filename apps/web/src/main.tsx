// The web app's entry (build plan Task 18). React Router in library mode;
// the shell wraps every page. Task 21's pages (creators, collections, tags,
// trash and settings) are routed here; a section whose page has not arrived
// yet (the library, Task 19) shows its heading. The theme starts from what
// the server wrote into the html element, so the first paint is already
// right.
import { type ReactNode, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import "./styles/studio.css";
import { CollectionsPage } from "./collections/CollectionsPage";
import { CreatorsPage } from "./creators/CreatorsPage";
import { SettingsPage } from "./settings/SettingsPage";
import { Shell } from "./shell/Shell";
import { SECTIONS } from "./shell/Sidebar";
import { readTheme } from "./shell/theme";
import { TagsPage } from "./tags/TagsPage";
import { TrashPage } from "./trash/TrashPage";

function Section({ title }: { title: string }) {
  return (
    <>
      <h1>{title}</h1>
      <p className="studio-empty">Nothing here yet.</p>
    </>
  );
}

/** The page at each section path that has one (Task 21). */
const PAGES: Readonly<Record<string, ReactNode>> = {
  "/creators": <CreatorsPage />,
  "/collections": <CollectionsPage />,
  "/tags": <TagsPage />,
  "/trash": <TrashPage />,
  "/settings": <SettingsPage />,
};

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <Shell initialTheme={readTheme(document)}>
        <Routes>
          {SECTIONS.map(({ label, to }) => (
            <Route key={to} path={to} element={PAGES[to] ?? <Section title={label} />} />
          ))}
          <Route path="*" element={<Section title="Page not found" />} />
        </Routes>
      </Shell>
    </BrowserRouter>
  </StrictMode>,
);
