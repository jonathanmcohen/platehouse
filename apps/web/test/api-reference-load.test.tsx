// @vitest-environment jsdom
// The API reference in Settings loads its own chunk only when it is opened
// (SettingsPage.tsx). When that chunk cannot be fetched, such as a tab
// opened before a new image replaced the hashed assets, or a dropped
// connection, the page says so and keeps the rest of the app on screen
// instead of the whole app going blank.
//
// The module is replaced here by one that fails to load, which is what the
// browser's import() of a missing chunk does. A file of its own, because
// api-docs.test.tsx renders the real reference.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SettingsPage } from "../src/settings/SettingsPage";

vi.mock("../src/api-docs/ApiReference", () => {
  throw new TypeError("Failed to fetch dynamically imported module");
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  // React reports an error a boundary caught on console.error; the test
  // reads the page, not the console.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("the API reference, when its code cannot be loaded", () => {
  test("says so, offers the way back, and leaves the rest of the app on screen", async () => {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/settings?view=api"]}>
          <p>Rest of the app</p>
          <Routes>
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </MemoryRouter>,
      );
    });
    await settle();

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(
      "The API reference could not be loaded. Reload the page to try again.",
    );
    const back = [...container.querySelectorAll("a")].find(
      (a) => a.textContent === "Back to Settings",
    );
    expect(back?.getAttribute("href")).toBe("/settings");
    expect(container.textContent).toContain("Rest of the app");
  });
});
