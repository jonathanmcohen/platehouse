// Accessibility (build plan Task 22; AC-075): axe-core finds zero violations
// on the library, model, settings and trash pages in the dark and the light
// theme. Each page is loaded fresh with the theme's cookie, so the palette
// is the one the server writes into the first paint, and checked once it has
// settled. Every rule axe enables by default runs; nothing is excluded.
//
// A clean axe run is required and is not proof of accessibility on its own
// (Verify a Change): keyboard.spec.ts walks the keyboard path.
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { ORIGIN } from "../support/env.js";
import { AXE_PAGES, openPage } from "../support/pages.js";

for (const theme of ["dark", "light"] as const) {
  for (const target of AXE_PAGES) {
    test(`axe: ${target.name} in ${theme} has no violations`, async ({ page, context }) => {
      await context.addCookies([{ name: "ph_theme", value: theme, url: ORIGIN }]);
      await openPage(page, target);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const results = await new AxeBuilder({ page }).analyze();
      const found = results.violations.map((v) => ({
        rule: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.slice(0, 5).map((n) => n.target.join(" ")),
      }));
      expect(found, JSON.stringify(found, null, 2)).toEqual([]);
    });
  }
}
