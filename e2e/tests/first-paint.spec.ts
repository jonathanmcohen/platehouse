// The theme on the first paint (build plan Task 22; AC-070, lesson 6). A
// System theme with prefers-color-scheme light must paint light on the first
// frame, with no flash of the dark default. Parchment's System-theme bug
// showed only on a fresh load and vanished after a toggle, so this loads
// fresh every time and never toggles.
//
// The page is loaded with JavaScript off: what paints is only what the
// server sent, the html element's data-theme, the color-scheme meta and the
// render-blocking stylesheet, so the screenshot is the first frame the
// browser can show. The background pixel must be the light palette's bg,
// #f6f7f9. The dark-scheme control checks the same probe can see the other
// palette, so the light assertion is not true by accident.
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { ORIGIN, STATE_PATH } from "../support/env.js";
import { pixelAt } from "../support/png.js";

type StorageState = Awaited<ReturnType<import("@playwright/test").BrowserContext["storageState"]>>;

const LIGHT_BG = "#f6f7f9";
const DARK_BG = "#121418";

for (const [scheme, want] of [
  ["light", LIGHT_BG],
  ["dark", DARK_BG],
] as const) {
  test(`System theme with prefers-color-scheme ${scheme} paints ${want} on the first frame`, async ({
    browser,
  }) => {
    // The global setup's signed-in state, with the theme cookie set to System.
    const state = JSON.parse(readFileSync(STATE_PATH, "utf8")) as StorageState;
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      javaScriptEnabled: false,
      colorScheme: scheme,
      viewport: { width: 1280, height: 800 },
      storageState: {
        cookies: [
          ...state.cookies.filter((c) => c.name !== "ph_theme"),
          {
            name: "ph_theme",
            value: "system",
            domain: new URL(ORIGIN).hostname,
            path: "/",
            expires: -1,
            httpOnly: false,
            secure: true,
            sameSite: "Lax",
          },
        ],
        origins: [],
      },
    });
    try {
      const page = await context.newPage();
      const res = await page.goto(`${ORIGIN}/`, { waitUntil: "load" });
      expect(res?.status()).toBe(200);
      expect(new URL(page.url()).pathname).toBe("/");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "system");
      await expect(page.locator('meta[name="color-scheme"]')).toHaveAttribute(
        "content",
        "light dark",
      );
      const shot = await page.screenshot({ type: "png" });
      for (const [x, y] of [
        [5, 5],
        [640, 400],
        [1274, 794],
      ] as const) {
        expect(pixelAt(shot, x, y), `pixel at ${x},${y}`).toBe(want);
      }
    } finally {
      await context.close();
    }
  });
}
