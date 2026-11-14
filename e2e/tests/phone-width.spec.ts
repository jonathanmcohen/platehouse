// Phone width (build plan Task 22; AC-074): at 375 px the sidebar collapses
// behind the menu button and every page is usable. "Usable" is measured, not
// eyeballed: the page does not scroll sideways, its heading, search box and
// menu button are on screen, and the menu opens and reaches every section.
import { expect, type Page, test } from "@playwright/test";
import { ALL_PAGES, openPage } from "../support/pages.js";

test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

const WIDTH = 375;

/** How far the document reaches past the viewport sideways, in CSS px. */
async function sidewaysOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

function insideWidth(what: string, box: { x: number; width: number } | null): void {
  expect(box, `${what} has a box`).not.toBeNull();
  if (box === null) return;
  expect(box.x, `${what} left edge`).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, `${what} right edge`).toBeLessThanOrEqual(WIDTH + 0.5);
}

for (const target of ALL_PAGES) {
  test(`375 px: ${target.name} collapses the sidebar and stays usable`, async ({ page }) => {
    await openPage(page, target);
    await expect(page.locator(".studio-sidebar")).toBeHidden();
    const menu = page.getByRole("button", { name: "Menu" });
    await expect(menu).toBeVisible();
    insideWidth("menu button", await menu.boundingBox());
    insideWidth(
      "heading",
      await page.getByRole("heading", { level: 1, name: target.heading }).boundingBox(),
    );
    const search = page.getByRole("searchbox");
    await expect(search).toBeVisible();
    insideWidth("search box", await search.boundingBox());
    expect(await sidewaysOverflow(page), "sideways overflow in px").toBeLessThanOrEqual(0);

    // The menu opens over the page and lists every section.
    await menu.click();
    await expect(menu).toHaveAttribute("aria-expanded", "true");
    const panel = page.locator("#ph-menu");
    await expect(panel).toBeVisible();
    for (const label of ["Library", "Creators", "Collections", "Tags", "Trash", "Settings"]) {
      const link = panel.getByRole("link", { name: label, exact: true });
      await expect(link).toBeVisible();
      insideWidth(`menu link ${label}`, await link.boundingBox());
    }
    expect(
      await sidewaysOverflow(page),
      "sideways overflow with the menu open",
    ).toBeLessThanOrEqual(0);
  });
}

test("375 px: the menu reaches every section and puts focus on the page", async ({ page }) => {
  await openPage(page, ALL_PAGES[0] as (typeof ALL_PAGES)[number]);
  for (const target of ALL_PAGES.filter((p) => p.name !== "model")) {
    const menu = page.getByRole("button", { name: "Menu" });
    await menu.click();
    await page.locator("#ph-menu").getByRole("link", { name: target.heading, exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: target.heading })).toBeVisible();
    await expect(page.locator("#ph-menu")).toBeHidden();
    await expect(page.locator("main")).toBeFocused();
  }
});
