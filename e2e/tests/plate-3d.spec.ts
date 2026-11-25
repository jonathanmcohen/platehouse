// A .3mf plate's 3D view (issue #358), through Traefik with the real server
// and a real browser. The seeded "Calibration cubes" model is a generated
// three-plate .3mf (buildSliceable) whose plates carry meshes but no
// thumbnails, so each plate shows its placeholder and the Show in 3D button.
//
// What must hold:
// - Show in 3D asks the server for that plate's mesh, which answers a
//   /blobs/ address, and the browser loads that GLB (model/gltf-binary)
//   and nothing else of the file: no download of the whole .3mf;
// - the view is drawn (a canvas in the 3D view, named for the plate), with
//   the 3D view's Rotate, Zoom and Reset view buttons, and focus is on Show
//   picture;
// - axe finds no violations with the view open, dark and light;
// - choosing another plate in the strip shows that plate in 3D;
// - Show picture goes back to the plate and puts focus on Show in 3D.
//
// The app's own Content-Security-Policy (issue #449; Traefik here adds no
// headers, so the browser enforces the app's alone): the page answers with
// it, and the browser reports no violation while the 3D view is drawn, nor
// around a tus upload through the page's upload dialog. The file uploaded is
// the seeded Calibration cubes file byte for byte, so the server skips it as
// a duplicate and the library the other specs see does not change.
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type Response, test } from "@playwright/test";
import { buildSliceable } from "../../packages/threemf/test/support/sliceable.js";
import { ORIGIN } from "../support/env.js";
import { AXE_PAGES, openPage } from "../support/pages.js";
import { readSeed, sha256 } from "../support/seed.js";

const MODEL = AXE_PAGES.find((p) => p.name === "model");
const LIBRARY = AXE_PAGES.find((p) => p.name === "library");
const MESH_PATH = /^\/app\/api\/plates\/[0-9a-f-]+\/mesh$/;

/** The policy apps/server/src/web/security-headers.ts sends. */
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/**
 * Records every CSP violation the page reports from its next navigation on:
 * securitypolicyviolation events and the console's CSP errors. Call it
 * before opening the page; the returned function lists what was seen, and
 * fails if the page's own answer did not carry the app's policy.
 */
async function watchCsp(page: Page): Promise<() => Promise<string[]>> {
  const seen: string[] = [];
  const documents: (string | undefined)[] = [];
  page.on("console", (msg) => {
    if (/content security policy/i.test(msg.text())) seen.push(`console: ${msg.text()}`);
  });
  page.on("response", (res) => {
    if (res.request().isNavigationRequest() && res.request().frame() === page.mainFrame()) {
      documents.push(res.headers()["content-security-policy"]);
    }
  });
  await page.addInitScript(() => {
    const list: string[] = [];
    (window as unknown as { cspViolations: string[] }).cspViolations = list;
    document.addEventListener("securitypolicyviolation", (event) => {
      list.push(`${event.effectiveDirective} blocked ${event.blockedURI || "inline"}`);
    });
  });
  return async () => {
    expect(documents.length, "the page was opened").toBeGreaterThan(0);
    for (const header of documents) expect(header).toBe(CSP);
    const reported = await page.evaluate(
      () => (window as unknown as { cspViolations?: string[] }).cspViolations ?? [],
    );
    return [...seen, ...reported];
  };
}

function isMesh(res: Response): boolean {
  return MESH_PATH.test(new URL(res.url()).pathname);
}

/** Opens the model page and records the path of every request it makes from here on. */
async function openModel(page: Page): Promise<string[]> {
  if (MODEL === undefined) throw new Error("no model page");
  await openPage(page, MODEL);
  const paths: string[] = [];
  page.on("request", (req) => paths.push(new URL(req.url()).pathname));
  return paths;
}

test("plate 3D view: Show in 3D loads that plate's mesh alone and draws it, and Show picture goes back", async ({
  page,
}) => {
  const violations = await watchCsp(page);
  const paths = await openModel(page);
  const viewer = page.locator(".studio-viewer");
  await expect(viewer.getByText("No thumbnail for Plate 1.")).toBeVisible();

  const meshAnswer = page.waitForResponse(isMesh);
  const glbAnswer = page.waitForResponse((res) =>
    new URL(res.url()).pathname.startsWith("/blobs/"),
  );
  await viewer.getByRole("button", { name: "Show in 3D" }).click();

  const mesh = await meshAnswer;
  expect(mesh.status()).toBe(200);
  const { url } = (await mesh.json()) as { url: string };
  expect(url).toMatch(/^\/blobs\/[0-9a-f-]+$/);
  const glb = await glbAnswer;
  expect(new URL(glb.url()).pathname).toBe(url);
  expect(glb.status()).toBe(200);
  expect(glb.headers()["content-type"]).toBe("model/gltf-binary");

  const view = viewer.getByRole("img", { name: "3D view of Plate 1" });
  await expect(view).toBeVisible();
  await expect(view.locator("canvas")).toHaveCount(1);
  await expect(viewer.getByRole("alert")).toHaveCount(0);
  for (const name of ["Rotate left", "Rotate right", "Zoom in", "Zoom out", "Reset view"]) {
    await expect(viewer.getByRole("button", { name })).toBeVisible();
  }
  await expect(viewer.getByRole("button", { name: "Show picture" })).toBeFocused();
  expect(paths.filter((p) => p.endsWith("/download") || p.startsWith("/s/"))).toEqual([]);
  // The app's CSP lets the 3D view load and draw (issue #449).
  expect(await violations()).toEqual([]);

  // Another plate while the view is open: that plate in 3D.
  const second = page.waitForResponse(isMesh);
  await viewer.getByRole("button", { name: "Show plate 2: Plate 2" }).click();
  expect((await second).status()).toBe(200);
  await expect(viewer.getByRole("img", { name: "3D view of Plate 2" })).toBeVisible();

  await viewer.getByRole("button", { name: "Show picture" }).click();
  await expect(viewer.locator("canvas")).toHaveCount(0);
  await expect(viewer.getByText("No thumbnail for Plate 2.")).toBeVisible();
  await expect(viewer.getByRole("button", { name: "Show in 3D" })).toBeFocused();
});

test("the app's CSP: a tus upload through the upload dialog reports no violation (#449)", async ({
  page,
}) => {
  if (LIBRARY === undefined) throw new Error("no library page");
  const bytes = buildSliceable({ plates: 3, filaments: 2 });
  // The seeded file again, so the server skips it and stores nothing.
  expect(sha256(bytes)).toBe(readSeed().calibration.sha256);
  const violations = await watchCsp(page);
  await openPage(page, LIBRARY);

  await page.locator("header").getByRole("button", { name: "Add", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add files" });
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "Calibration cubes.3mf",
    mimeType: "application/octet-stream",
    buffer: bytes,
  });
  const created = page.waitForResponse(
    (res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/app/uploads",
  );
  const sent = page.waitForResponse(
    (res) =>
      res.request().method() === "PATCH" && new URL(res.url()).pathname.startsWith("/app/uploads/"),
  );
  await dialog.getByRole("button", { name: "Upload 1 file" }).click();
  expect((await created).status()).toBe(201);
  expect((await sent).status()).toBe(204);
  // The status also carries the file name for a screen reader, so match the visible end of it.
  await expect(dialog.locator(".ph-upload-status").filter({ hasText: /Skipped$/ })).toBeVisible();

  expect(await violations()).toEqual([]);
});

for (const theme of ["dark", "light"] as const) {
  test(`plate 3D view: axe finds no violations with the view open in ${theme}`, async ({
    page,
    context,
  }) => {
    await context.addCookies([{ name: "ph_theme", value: theme, url: ORIGIN }]);
    await openModel(page);
    const viewer = page.locator(".studio-viewer");
    await viewer.getByRole("button", { name: "Show in 3D" }).click();
    await expect(
      viewer.getByRole("img", { name: "3D view of Plate 1" }).locator("canvas"),
    ).toHaveCount(1);
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
