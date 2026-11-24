// A drag-and-drop upload through Traefik (#452): a small STL is dropped on the
// library's drop zone, the upload dialog opens with it ready, and sending it
// runs the tus upload (POST then PATCH on /app/uploads) through the proxy and
// the ingest. The model then shows in the library. The drop is made the way a
// browser makes it: dragenter, dragover and drop events that carry a
// DataTransfer holding the file. The STL is generated here with a name and a
// body that are new each run, so the server never skips it as a duplicate.
// The model is moved to the trash afterwards, as the setup trashes its own
// (the Public API never deletes), so the library the other specs read is as it was.
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { ORIGIN } from "../support/env.js";
import { ALL_PAGES, openPage } from "../support/pages.js";
import { readSeed } from "../support/seed.js";

const LIBRARY = ALL_PAGES[0];

let uploadedName: string | undefined;

test.afterEach(async ({ page }) => {
  if (uploadedName === undefined) return;
  const name = uploadedName;
  uploadedName = undefined;
  const found = await page.request.get(`/api/v1/models?q=${encodeURIComponent(name)}`, {
    headers: { authorization: `Bearer ${readSeed().token}` },
  });
  if (!found.ok()) return;
  const { models } = (await found.json()) as { models: { id: string; name: string }[] };
  for (const model of models) {
    await page.request.post(`/app/api/models/${model.id}/trash`, { headers: { origin: ORIGIN } });
  }
});

/** A one-triangle ASCII STL; the solid's name makes the bytes differ per run. */
function stl(name: string): string {
  return [
    `solid ${name}`,
    "  facet normal 0 0 1",
    "    outer loop",
    "      vertex 0 0 0",
    "      vertex 10 0 0",
    "      vertex 0 10 0",
    "    endloop",
    "  endfacet",
    `endsolid ${name}`,
    "",
  ].join("\n");
}

test("dropping an STL on the library uploads it and the model appears", async ({ page }) => {
  if (LIBRARY === undefined) throw new Error("no library page");
  const id = randomUUID().slice(0, 8);
  const name = `drop ${id}`;
  uploadedName = id;
  await openPage(page, LIBRARY);

  const transfer = await page.evaluateHandle(
    ({ fileName, body }) => {
      const data = new DataTransfer();
      data.items.add(new File([body], fileName, { type: "model/stl" }));
      return data;
    },
    { fileName: `${name}.stl`, body: stl(name) },
  );
  const zone = page.locator("[data-dropzone]").first();
  await zone.dispatchEvent("dragenter", { dataTransfer: transfer });
  await zone.dispatchEvent("dragover", { dataTransfer: transfer });
  await zone.dispatchEvent("drop", { dataTransfer: transfer });

  const dialog = page.getByRole("dialog", { name: "Add files" });
  await expect(dialog.locator(`[data-upload="${name}.stl"]`)).toBeVisible();

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
  await expect(dialog.locator(".ph-upload-status").filter({ hasText: /Added$/ })).toBeVisible({
    timeout: 60_000,
  });

  // The model exists: the API finds it by name, with the run's token.
  const found = await page.request.get(`/api/v1/models?q=${encodeURIComponent(name)}`, {
    headers: { authorization: `Bearer ${readSeed().token}` },
  });
  expect(found.status()).toBe(200);
  const { models } = (await found.json()) as { models: { name: string }[] };
  expect(models.map((m) => m.name.toLowerCase()).some((n) => n.includes(id))).toBe(true);
});
