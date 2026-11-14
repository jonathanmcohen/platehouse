// The pages the end-to-end specs walk (build plan Task 22) and how a spec
// waits for one to settle. The lists are fixed so a spec file declares its
// tests without the run's seed (Playwright lists tests before the global
// setup runs); a page's path is read from the seed inside the test.
import { expect, type Page } from "@playwright/test";
import { readSeed } from "./seed.js";

export interface AppPage {
  name: string;
  /** The page's h1 once it has loaded. */
  heading: string;
  /** The page's path; the model page's comes from the seed. */
  path(): string;
}

const page = (name: string, path: string, heading: string): AppPage => ({
  name,
  heading,
  path: () => path,
});

const MODEL: AppPage = {
  name: "model",
  heading: "Calibration cubes",
  path: () => `/models/${readSeed().calibration.modelId}`,
};

/** The four pages the axe spec checks (Task 22: library, model, settings, trash). */
export const AXE_PAGES: readonly AppPage[] = [
  page("library", "/", "Library"),
  MODEL,
  page("settings", "/settings", "Settings"),
  page("trash", "/trash", "Trash"),
];

/** Every page the app has: the six sections of the sidebar and the model page. */
export const ALL_PAGES: readonly AppPage[] = [
  page("library", "/", "Library"),
  page("creators", "/creators", "Creators"),
  page("collections", "/collections", "Collections"),
  page("tags", "/tags", "Tags"),
  page("trash", "/trash", "Trash"),
  page("settings", "/settings", "Settings"),
  MODEL,
];

/**
 * Opens a page and waits until it has loaded: its h1 is shown, no
 * "Loading ..." line is left in the main area and the network is quiet.
 */
export async function openPage(p: Page, target: AppPage): Promise<void> {
  const res = await p.goto(target.path());
  expect(res?.status(), `${target.path()} answered`).toBe(200);
  await settle(p, target);
}

export async function settle(p: Page, target: AppPage): Promise<void> {
  await expect(p.getByRole("heading", { level: 1, name: target.heading })).toBeVisible();
  await expect(p.locator("main").getByText(/^Loading/)).toHaveCount(0);
  await p.waitForLoadState("networkidle");
}
