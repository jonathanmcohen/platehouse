// @vitest-environment jsdom
// The API reference in Settings (the 0.1.0 API documentation): it describes
// what the API can and cannot do, and follows the app's look, themes, phone
// width, contrast and keyboard rules. It
// renders apps/web/src/api-docs/openapi.json, the document the server's
// test writes from the routes themselves (apps/server/test/api/
// openapi.test.ts checks that copy is current), so these tests read the
// real document rather than a fake one.
//
// The page is rendered into jsdom inside a memory router. The settings page
// around it talks to a small fake /app/api through the global fetch, which
// records every call, so a test can show the reference itself fetches
// nothing. Live checks in both themes and at 375 px are done by hand in a
// browser; here the stylesheet is checked to use only studio.css's tokens.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ApiReference } from "../src/api-docs/ApiReference";
import {
  type ApiDocument,
  examplesOf,
  fieldsOf,
  groupOperations,
  paragraphs,
  rulesOf,
  type Schema,
  typeLabel,
} from "../src/api-docs/model";
import raw from "../src/api-docs/openapi.json";
import { SettingsPage, type SettingsView } from "../src/settings/SettingsPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DOC = raw as unknown as ApiDocument;

const calls: string[] = [];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The /app/api calls the settings page makes on load, with empty answers. */
async function fakeApi(input: RequestInfo | URL): Promise<Response> {
  const url = new URL(String(input), "https://platehouse.test");
  calls.push(url.pathname);
  if (url.pathname === "/app/api/settings") {
    // The whole answer the server gives (My printers, #240), checked against
    // the page's own type so a new field cannot be missed here (#281).
    return json(200, {
      printerId: "Bambu Lab P1S 0.4 nozzle",
      printersVersion: 1,
      myPrinters: [
        {
          id: "Bambu Lab P1S 0.4 nozzle",
          name: "Bambu Lab P1S, 0.4 mm nozzle",
          offered: null,
          waiting: 0,
          through: 0,
        },
      ],
      printers: null,
      slicesPerMinute: 3,
      bucketVersioning: "enabled",
    } satisfies SettingsView);
  }
  if (url.pathname === "/app/api/tokens") return json(200, { tokens: [] });
  if (url.pathname === "/app/api/trash") {
    return json(200, { models: [], readAt: "2026-11-18T12:00:00.000Z" });
  }
  return json(404, { error: "not_found" });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal("fetch", vi.fn(fakeApi));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Waits until check passes, for the lazily loaded reference. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await settle();
  }
  throw new Error(`never: ${what}`);
}

async function showReference(): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/settings?view=api"]}>
        <Routes>
          <Route path="/settings" element={<ApiReference />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await settle();
}

async function showSettings(path: string): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await settle();
}

function link(name: string): HTMLAnchorElement {
  const found = [...document.querySelectorAll("a")].find((a) => a.textContent?.trim() === name);
  if (found === undefined) throw new Error(`no link named ${JSON.stringify(name)}`);
  return found;
}

function h1(): HTMLElement | null {
  return document.querySelector("h1");
}

describe("what the page reads from the document", () => {
  const groups = groupOperations(DOC);

  test("groups the operations by tag, in the document's tag order", () => {
    expect(groups.map((g) => g.name)).toEqual([
      "Models",
      "Files",
      "Tags and collections",
      "Uploads",
      "About the API",
    ]);
    for (const group of groups) {
      expect(group.description, group.name).not.toBe("");
      expect(group.id).toMatch(/^api-[a-z0-9-]+$/);
    }
  });

  test("lists every operation once, folding a HEAD that mirrors a GET into the GET", () => {
    const listed = groups.flatMap((g) => g.operations.map((op) => `${op.method} ${op.path}`));
    const expected: string[] = [];
    for (const [path, item] of Object.entries(DOC.paths)) {
      for (const method of Object.keys(item)) {
        if (method === "head" && item.get !== undefined) continue;
        expected.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect([...listed].sort()).toEqual([...expected].sort());
    expect(new Set(listed).size).toBe(listed.length);
    // The tus resume check is a HEAD of its own.
    expect(listed).toContain("HEAD /uploads/{id}");
    const search = groups[0]?.operations.find((op) => op.path === "/models" && op.method === "GET");
    expect(search?.alsoHead).toBe(true);
  });

  test("every operation it lists has a summary, a description and an error answer", () => {
    for (const op of groups.flatMap((g) => g.operations)) {
      const where = `${op.method} ${op.path}`;
      expect(op.summary, where).not.toBe("");
      expect(op.description, where).not.toBe("");
      expect(
        op.responses.some((r) => r.code.startsWith("4")),
        where,
      ).toBe(true);
    }
  });

  test("a model's fields are flattened with their nesting, types and rules", () => {
    const get = DOC.paths["/models/{id}"]?.get;
    const schema = get?.responses?.["200"]?.content?.["application/json"]?.schema;
    const fields = fieldsOf(schema);
    const named = (name: string, depth: number) =>
      fields.find((f) => f.name === name && f.depth === depth);
    expect(named("name", 0)).toMatchObject({ type: "string", required: true });
    expect(named("caption", 0)).toMatchObject({ nullable: true });
    expect(named("files", 0)?.type).toBe("array of object");
    expect(named("plates", 1)?.type).toBe("array of object");
    // files > plates > numbers > file > timeSeconds
    expect(named("numbers", 2)?.type).toBe("object");
    expect(named("timeSeconds", 4)).toMatchObject({ type: "number", nullable: true });
    expect(named("kind", 1)?.rules).toEqual(["one of: 3mf, stl, step, scad"]);
  });

  test("limits read as phrases", () => {
    const name: Schema = { type: "string", minLength: 1, maxLength: 500, pattern: "\\S" };
    expect(rulesOf(name)).toEqual(["1 to 500 characters", "not blank"]);
    expect(rulesOf({ type: "integer", minimum: 1, maximum: 200 })).toEqual(["1 to 200"]);
    expect(rulesOf({ type: "array", maxItems: 100 })).toEqual(["at most 100 items"]);
    expect(rulesOf({ type: "string", enum: ["1.0.0"] })).toEqual(["always 1.0.0"]);
    expect(typeLabel({ type: "string", format: "binary" })).toBe("binary");
    expect(typeLabel({ type: "string", format: "date-time" })).toBe("string (date-time)");
  });

  test("examples come from example or examples, JSON indented", () => {
    expect(examplesOf({ example: { a: 1 } })).toEqual([{ label: "", text: '{\n  "a": 1\n}' }]);
    expect(examplesOf({ examples: { done: { summary: "Imported", value: "x" } } })).toEqual([
      { label: "Imported", text: "x" },
    ]);
    expect(paragraphs("One.\n\nTwo.\n")).toEqual(["One.", "Two."]);
  });
});

describe("the API reference page", () => {
  test("shows every group and operation with its method, path and summary", async () => {
    await showReference();
    expect(h1()?.textContent).toBe("API reference");
    const sections = [...document.querySelectorAll("section")];
    expect(sections.map((s) => s.querySelector("h2")?.textContent)).toEqual(
      groupOperations(DOC).map((g) => g.name),
    );
    const ops = groupOperations(DOC).flatMap((g) => g.operations);
    const cards = [...document.querySelectorAll("details.ph-api-op")];
    expect(cards).toHaveLength(ops.length);
    for (const [i, op] of ops.entries()) {
      const heading = cards[i]?.querySelector("summary h3");
      expect(heading?.querySelector(".ph-api-method")?.textContent).toBe(op.method);
      expect(heading?.querySelector("code")?.textContent).toBe(op.path);
      expect(heading?.textContent).toContain(op.summary);
    }
  });

  test("the section links lead to headings on the page", async () => {
    await showReference();
    const nav = document.querySelector('nav[aria-label="API sections"]');
    const links = [...(nav?.querySelectorAll("a") ?? [])];
    expect(links.length).toBe(groupOperations(DOC).length);
    for (const a of links) {
      const id = a.getAttribute("href")?.slice(1) ?? "";
      expect(document.getElementById(id)?.tagName, id).toBe("H2");
    }
  });

  test("an operation shows its parameters, body, answers and examples", async () => {
    await showReference();
    const card = document.getElementById("createModel") as HTMLDetailsElement | null;
    expect(card).not.toBeNull();
    // A details element is opened by its summary, with Enter or Space too.
    expect(card?.querySelector("summary")).not.toBeNull();
    const text = card?.textContent ?? "";
    for (const part of ["Request body", "Responses", "application/json", "201", "409", "401"]) {
      expect(text).toContain(part);
    }
    expect(text).toContain("1 to 500 characters");
    const examples = [...(card?.querySelectorAll("pre") ?? [])];
    expect(examples.length).toBeGreaterThan(3);
    // Each example can be reached and scrolled by keyboard, and is named.
    for (const pre of examples) {
      expect(pre.getAttribute("tabindex")).toBe("0");
      expect(pre.closest("figure")?.querySelector("figcaption")?.textContent).toMatch(/^Example/);
    }

    const search = document.getElementById("searchModels");
    const params = search?.textContent ?? "";
    for (const name of ["q", "tag", "collection", "creator", "externalRef", "cursor", "limit"]) {
      expect(params).toContain(name);
    }
    expect(params).toContain("HEAD");
  });

  test("headings go in order: h1, sections h2, operations h3, parts h4, answers h5", async () => {
    await showReference();
    const levels = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((h) =>
      Number(h.tagName.slice(1)),
    );
    expect(levels[0]).toBe(1);
    for (let i = 1; i < levels.length; i += 1) {
      expect((levels[i] as number) - (levels[i - 1] as number)).toBeLessThanOrEqual(1);
    }
  });

  test("the base URL is this origin's /api/v1, and the token goes in Authorization", async () => {
    await showReference();
    const text = document.body.textContent ?? "";
    expect(text).toContain(`${window.location.origin}/api/v1`);
    expect(text).toContain("Authorization: Bearer <token>");
    expect(text).toContain(`GET ${window.location.origin}/api/v1/openapi.json`);
  });

  test("fetches nothing: the document is part of the build", async () => {
    await showReference();
    expect(calls).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("shows no token-shaped value", async () => {
    await showReference();
    for (const d of document.querySelectorAll("details")) d.open = true;
    expect(document.body.textContent).not.toMatch(/ph_[A-Za-z0-9_-]{43}/);
  });
});

describe("from Settings", () => {
  test("the API tokens section links to the reference, which takes focus", async () => {
    await showSettings("/settings");
    const to = link("API reference");
    expect(to.getAttribute("href")).toBe("/settings?view=api");
    // The tokens section is where the link is.
    expect(to.closest(".ph-section")?.querySelector("h2")?.textContent).toBe("API tokens");

    await act(async () => to.click());
    await until(() => h1()?.textContent === "API reference", "the reference shows");
    expect(document.activeElement).toBe(h1());

    await act(async () => link("Back to Settings").click());
    await until(() => h1()?.textContent === "Settings", "settings shows again");
    expect(document.activeElement).toBe(h1());
  });

  test("opened directly, the reference shows and leaves focus alone", async () => {
    await showSettings("/settings?view=api");
    await until(() => h1()?.textContent === "API reference", "the reference shows");
    expect(document.activeElement).not.toBe(h1());
    // The settings page's own calls are not made for the reference.
    expect(calls).toEqual([]);
  });
});

describe("the page's stylesheet", () => {
  test("api-docs.css writes no colour of its own, only studio.css's tokens", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(here, "../src/api-docs/api-docs.css"), "utf8");
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(rules).not.toMatch(/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i);
    expect(rules).not.toMatch(/\b(?:black|white)\b/i);
    // Every token it uses is one studio.css declares in its palettes.
    const studio = readFileSync(join(here, "../src/styles/studio.css"), "utf8");
    const used = new Set([...rules.matchAll(/var\((--[a-z-]+)\)/g)].map((m) => m[1] as string));
    expect(used.size).toBeGreaterThan(3);
    for (const token of used) expect(studio, token).toContain(`${token}:`);
  });

  test("loads nothing from another host", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(here, "../src/api-docs/api-docs.css"), "utf8");
    expect(css).not.toMatch(/url\(|@import/);
  });
});
