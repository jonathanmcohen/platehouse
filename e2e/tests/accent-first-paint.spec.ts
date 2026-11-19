// The accent colour scheme on the first paint (Jon, 2026-11-19). The server
// writes the ph_accent cookie into the html element's data-accent before the
// page is sent, the same way it writes the theme, so the stylesheet already
// has the right scheme when the app first renders and nothing changes
// afterwards: no flash of the default colour. Each page is loaded fresh with
// both cookies set.
//
// Checked on the real stack: the HTML the server sent carries the scheme,
// and once the app has rendered, the logo and the top bar's Add button are
// drawn in that scheme's colours (the values are in apps/web/src/shell/
// accent.ts) and the attribute is still the one the server wrote. An
// unknown cookie gets the default scheme.
import { expect, test } from "@playwright/test";
import { ORIGIN } from "../support/env.js";

const CASES = [
  // Coral in light: logo #f0644a, fill #b25b46.
  { theme: "light", accent: "coral", brand: "rgb(240, 100, 74)", fill: "rgb(178, 91, 70)" },
  // Green in dark: logo and fill #00ae42. Not Blueprint indigo, the default,
  // which an ignored cookie would paint too.
  {
    theme: "dark",
    accent: "bambu-green",
    brand: "rgb(0, 174, 66)",
    fill: "rgb(0, 174, 66)",
  },
] as const;

for (const { theme, accent, brand, fill } of CASES) {
  test(`ph_accent=${accent} in ${theme} is in the first paint and stays`, async ({
    page,
    context,
  }) => {
    await context.addCookies([
      { name: "ph_theme", value: theme, url: ORIGIN },
      { name: "ph_accent", value: accent, url: ORIGIN },
    ]);
    const res = await page.goto(`${ORIGIN}/`, { waitUntil: "load" });
    expect(res?.status()).toBe(200);
    expect(await res?.text()).toContain(`data-theme="${theme}" data-accent="${accent}"`);
    // The sidebar logo draws in currentColor, so its color is the scheme's.
    const logo = page.locator(".studio-brand .studio-logo");
    await expect(logo).toBeVisible();
    await expect(logo).toHaveCSS("color", brand);
    await expect(page.locator(".studio-topbar .studio-button-primary")).toHaveCSS(
      "background-color",
      fill,
    );
    await expect(page.locator("html")).toHaveAttribute("data-accent", accent);
  });
}

test("an unknown ph_accent gets the default scheme", async ({ page, context }) => {
  await context.addCookies([
    { name: "ph_theme", value: "dark", url: ORIGIN },
    { name: "ph_accent", value: "sepia", url: ORIGIN },
  ]);
  const res = await page.goto(`${ORIGIN}/`, { waitUntil: "load" });
  expect(res?.status()).toBe(200);
  // Blueprint indigo, the default (Jon, 2026-11-19): #596eec in dark.
  expect(await res?.text()).toContain('data-accent="blueprint-indigo"');
  await expect(page.locator(".studio-brand .studio-logo")).toHaveCSS("color", "rgb(89, 110, 236)");
});
