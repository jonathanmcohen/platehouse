// Playwright for the end-to-end suite (build plan Task 22). Run it against
// the stack e2e/up.sh starts:
//
//   pnpm exec playwright test -c e2e
//
// Every spec goes through Traefik at https://platehouse.e2e.test. The
// certificate is the run's own throwaway, so TLS errors are ignored; the
// specs check origins and paths themselves. The global setup signs in once
// and fills the library (global-setup.ts); specs start signed in unless they
// clear the state to test the cookieless routes.
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { E2E_DIR, ORIGIN, STATE_PATH } from "./support/env.js";

const CI = process.env.CI === "true";

export default defineConfig({
  testDir: "./tests",
  outputDir: join(E2E_DIR, "test-results"),
  globalSetup: "./global-setup.ts",
  forbidOnly: CI,
  retries: 0,
  workers: 2,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ["list"],
    ["json", { outputFile: join(E2E_DIR, "report.json") }],
    ["html", { outputFolder: join(E2E_DIR, "playwright-report"), open: "never" }],
  ],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: ORIGIN,
    ignoreHTTPSErrors: true,
    storageState: STATE_PATH,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium" }],
});
