// @vitest-environment jsdom
// The library's sort control and Select mode (Jon, 2026-11-19). Rendered in
// jsdom with React; the server is a stubbed fetch that answers the library's
// app API the way the server does (apps/server/src/app-api/library.ts and
// organise.ts) and records every request.
//
// Sort:
// - A labelled Sort menu: best match (only while a search is active), date
//   added, name, print time and filament weight for the selected printer
//   (with a note that models without numbers come last), and plate count.
//   Best match is the default while a search is active, newest otherwise.
// - The sort is in the URL (?sort=) beside ?q, ?tag, ?creator, ?collection,
//   ?page and ?view: a default sort leaves it out, a change goes back to page
//   1 and keeps the rest, the pager and the tag chips keep it, and the
//   library request carries it. An unknown sort is the default.
//
// Select mode:
// - A Select button (aria-pressed) turns the cards into checkboxes named for
//   their model; a click or Space toggles one; the count is announced in a
//   status line. Select all on this page, Select all matching (every match's
//   id from /app/api/library/ids, capped as View all is, and it says so) and
//   Clear selection. Escape leaves Select mode and clears the selection,
//   unless another overlay that takes Escape is open: the upload dialog
//   (mounted beside the library) or the narrow-screen menu. Escape closes
//   that overlay only (PR #246 review).
// - With models selected: Add tags (type or pick), Remove tag, Add to
//   collection (existing or new) and Move to trash (the app's own confirm
//   dialog, with the count). Each is one request with the selected ids; the
//   result is shown, failures name the models and why, and the grid and the
//   library's tags (the tag filter, Remove tag's choices and Add tags'
//   suggestions) reload.
import { act, type ReactNode, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LibraryPage } from "../src/library/LibraryPage";
import type { LibraryCard } from "../src/library/ModelCard";
import { SORT_OPTIONS, sortFrom } from "../src/library/paging";
import { describeBulk, MAX_SELECTED, MAX_TAGS } from "../src/library/selection";
import { PRINTER_CHOICE_KEY } from "../src/settings/PrinterSwitch";
import { MenuButton } from "../src/shell/MenuButton";
import { UploadDialog } from "../src/upload/UploadDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PRINTER = "Bambu Lab P1S 0.4 nozzle";
const PRINTER_NAME = "Bambu Lab P1S, 0.4 mm nozzle";
const A1 = "Bambu Lab A1 0.4 nozzle";
const A1_NAME = "Bambu Lab A1, 0.4 mm nozzle";
/** My printers as the server answers them (PR #240): the default first. */
const MY_PRINTERS = [
  { id: PRINTER, name: PRINTER_NAME },
  { id: A1, name: A1_NAME },
];

function id(i: number): string {
  return `0198f0c4-0000-7000-8000-${String(i).padStart(12, "0")}`;
}

/** n synthetic cards named Model 001, Model 002, ..., the first `tagged` tagged PLA. */
function cards(n: number, tagged = 0): LibraryCard[] {
  return Array.from({ length: n }, (_, i) => ({
    id: id(i + 1),
    name: `Model ${String(i + 1).padStart(3, "0")}`,
    creator: null,
    tags: i < tagged ? ["PLA"] : [],
    plateCount: 1,
    thumbnail: null,
    fileKind: "3mf" as const,
    timeSeconds: null,
    weightGrams: null,
    partial: false,
    numbersUnavailable: false,
  }));
}

interface Posted {
  url: string;
  body: Record<string, unknown>;
}

let container: HTMLDivElement;
let root: Root;
let requests: string[];
let posted: Posted[];
let matchCap: number;
/** The tag names /app/api/library/tags answers with, as live models carry them. */
let serverTags: string[];
/** What each bulk route answers; by default every id changed. */
let bulkAnswer: (url: string, body: Record<string, unknown>) => Response;
let location = "";
/** Library requests for a page this says yes to wait until releaseHeld(). */
let holding: ((page: number) => boolean) | null;
let held: Array<() => void>;
/** Library requests for a page this says yes to answer 500. */
let failing: ((page: number) => boolean) | null;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubServer(all: LibraryCard[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "https://platehouse.test");
      requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
      if (url.pathname === "/app/api/library/tags") return json({ tags: serverTags });
      if (url.pathname === "/app/api/collections") {
        return json({ collections: [{ name: "Shelf", models: 3 }] });
      }
      if (url.pathname.startsWith("/app/api/bulk/")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        posted.push({ url: url.pathname, body });
        return bulkAnswer(url.pathname, body);
      }
      const tag = url.searchParams.get("tag");
      const found = all.filter(
        (c) => tag === null || c.tags.some((t) => t.toLowerCase() === tag.toLowerCase()),
      );
      const matches = found.slice(0, matchCap);
      if (url.pathname === "/app/api/library/ids") {
        return json({ ids: matches.map((c) => c.id), capped: found.length > matchCap });
      }
      if (url.pathname !== "/app/api/library") return new Response("no", { status: 404 });
      const asked = Number(url.searchParams.get("page"));
      if (holding?.(asked)) await new Promise<void>((resolve) => held.push(resolve));
      if (failing?.(asked)) return new Response("no", { status: 500 });
      const pageSize = Number(url.searchParams.get("limit") ?? 48);
      const pageCount = Math.max(1, Math.ceil(matches.length / pageSize));
      const page = Math.min(Math.max(asked, 1), pageCount);
      // The printer switch's choice when it is one of My printers, else the default.
      const shown =
        MY_PRINTERS.find((m) => m.id === url.searchParams.get("printer")) ?? MY_PRINTERS[0];
      return json({
        printer: shown?.id,
        printerName: shown?.name,
        printers: MY_PRINTERS,
        models: matches.slice((page - 1) * pageSize, page * pageSize),
        nextCursor: null,
        page,
        pageSize,
        pageCount,
        total: matches.length,
        totalCapped: found.length > matchCap,
        libraryTotal: all.length,
        sort: url.searchParams.get("sort") ?? (url.searchParams.get("q") ? "relevance" : "newest"),
      });
    }),
  );
}

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function LocationProbe() {
  const at = useLocation();
  location = `${at.pathname}${at.search}`;
  return null;
}

async function render(path: string) {
  const node: ReactNode = (
    <MemoryRouter initialEntries={[path]}>
      <LocationProbe />
      <Routes>
        <Route path="/" element={<LibraryPage />} />
      </Routes>
    </MemoryRouter>
  );
  await act(async () => root.render(node));
  await settle();
}

/** Opens the upload dialog WithOverlays renders. */
let openUpload: () => void = () => undefined;

/** The library with the shell's menu and the upload dialog beside it, as main.tsx mounts them. */
function WithOverlays() {
  const [open, setOpen] = useState(false);
  openUpload = () => setOpen(true);
  return (
    <>
      <MenuButton />
      <Routes>
        <Route path="/" element={<LibraryPage />} />
      </Routes>
      <UploadDialog open={open} files={[]} onClose={() => setOpen(false)} />
    </>
  );
}

async function renderWithOverlays() {
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/"]}>
        <WithOverlays />
      </MemoryRouter>,
    ),
  );
  await settle();
}

function libraryQueries(): URLSearchParams[] {
  return requests
    .filter((r) => /^GET \/app\/api\/library(?:\?|$)/.test(r))
    .map((r) => new URL(r.slice(4), "https://platehouse.test").searchParams);
}

function lastLibraryQuery(): URLSearchParams {
  const last = libraryQueries().at(-1);
  if (last === undefined) throw new Error("the library was never asked for");
  return last;
}

function sortMenu(): HTMLSelectElement {
  const label = [...container.querySelectorAll("label")].find(
    (l) => l.textContent?.trim() === "Sort",
  );
  const menu = label?.htmlFor ? document.getElementById(label.htmlFor) : null;
  if (!(menu instanceof HTMLSelectElement)) throw new Error("no select labelled Sort");
  return menu;
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await settle();
}

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name,
  );
  if (found === undefined) throw new Error(`no button ${name}`);
  return found;
}

async function click(el: HTMLElement | null | undefined) {
  if (el === null || el === undefined) throw new Error("nothing to click");
  await act(async () => el.click());
  await settle();
}

async function key(el: Element, k: string) {
  let event: KeyboardEvent | undefined;
  await act(async () => {
    event = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    el.dispatchEvent(event);
  });
  await settle();
  return event as KeyboardEvent;
}

function checkboxes(): HTMLInputElement[] {
  return [...container.querySelectorAll<HTMLInputElement>('.studio-grid input[type="checkbox"]')];
}

function checkbox(name: string): HTMLInputElement {
  const found = checkboxes().find((c) => c.getAttribute("aria-label") === name);
  if (found === undefined) throw new Error(`no card checkbox ${name}`);
  return found;
}

function statusText(): string {
  return container.querySelector("#ph-selection-count")?.textContent ?? "";
}

function dialog(): HTMLElement | null {
  return document.querySelector('[role="dialog"]');
}

function dialogButton(name: string): HTMLButtonElement {
  const found = [...(dialog()?.querySelectorAll("button") ?? [])].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === name,
  );
  if (found === undefined) throw new Error(`no dialog button ${name}`);
  return found;
}

async function type(input: HTMLInputElement, text: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(form: HTMLFormElement | null | undefined) {
  if (!form) throw new Error("no form");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle();
}

/** Lets every held library request answer. */
async function releaseHeld() {
  holding = null;
  const waiting = held;
  held = [];
  for (const go of waiting) go();
  await settle();
}

async function selectMode() {
  await click(button("Select"));
}

beforeEach(() => {
  requests = [];
  posted = [];
  holding = null;
  held = [];
  failing = null;
  matchCap = 1000;
  serverTags = ["Desk", "PLA"];
  bulkAnswer = (_url, body) =>
    json({
      changed: body.ids,
      unchanged: [],
      failed: [],
      ...(typeof body.tags === "object" ? { tags: body.tags } : {}),
      ...(typeof body.tag === "string" ? { tag: body.tag } : {}),
      ...(typeof body.collection === "string" ? { collection: body.collection } : {}),
    });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("the sort control", () => {
  test("offers every order, best match only with a search", () => {
    expect(SORT_OPTIONS.map((o) => o.value)).toEqual([
      "relevance",
      "newest",
      "oldest",
      "name-asc",
      "name-desc",
      "time-asc",
      "time-desc",
      "weight-asc",
      "weight-desc",
      "plates-desc",
      "plates-asc",
    ]);
    expect(sortFrom(new URLSearchParams(""), "")).toBe("newest");
    expect(sortFrom(new URLSearchParams(""), "hook")).toBe("relevance");
    expect(sortFrom(new URLSearchParams("sort=name-desc"), "")).toBe("name-desc");
    expect(sortFrom(new URLSearchParams("sort=price"), "")).toBe("newest");
    expect(sortFrom(new URLSearchParams("sort=relevance"), "")).toBe("newest");
    expect(sortFrom(new URLSearchParams("sort=relevance"), "hook")).toBe("relevance");
  });

  test("without a search: newest is chosen, best match is not offered, and no sort is sent", async () => {
    stubServer(cards(5));
    await render("/");
    const menu = sortMenu();
    expect(menu.value).toBe("newest");
    expect([...menu.options].map((o) => o.value)).not.toContain("relevance");
    expect(menu.selectedOptions[0]?.textContent).toBe("Date added: newest");
    expect(lastLibraryQuery().has("sort")).toBe(false);
  });

  test("with a search: best match is first and chosen", async () => {
    stubServer(cards(5));
    await render("/?q=Model");
    const menu = sortMenu();
    expect(menu.options[0]?.value).toBe("relevance");
    expect(menu.value).toBe("relevance");
  });

  test("a new sort goes in the URL, back to page 1, keeping the search, filters and view", async () => {
    stubServer(cards(171, 171));
    await render("/?tag=PLA&page=3");
    await choose(sortMenu(), "name-asc");
    expect(location).toBe("/?tag=PLA&sort=name-asc");
    expect(lastLibraryQuery().get("sort")).toBe("name-asc");
    expect(lastLibraryQuery().get("page")).toBe("1");
    expect(lastLibraryQuery().get("tag")).toBe("PLA");
  });

  test("a new sort in View all stays in View all", async () => {
    stubServer(cards(5));
    await render("/?view=all&collection=Shelf");
    await choose(sortMenu(), "plates-desc");
    expect(location).toBe("/?view=all&collection=Shelf&sort=plates-desc");
    expect(lastLibraryQuery().get("sort")).toBe("plates-desc");
    expect(lastLibraryQuery().get("limit")).toBe("200");
  });

  test("choosing the default sort takes ?sort= out of the URL", async () => {
    stubServer(cards(5));
    await render("/?sort=oldest");
    expect(sortMenu().value).toBe("oldest");
    await choose(sortMenu(), "newest");
    expect(location).toBe("/");
    expect(lastLibraryQuery().has("sort")).toBe(false);
  });

  test("an unknown sort is the default and is not sent", async () => {
    stubServer(cards(5));
    await render("/?sort=price");
    expect(sortMenu().value).toBe("newest");
    expect(lastLibraryQuery().has("sort")).toBe(false);
  });

  test("the pager and the tag chips keep the sort", async () => {
    stubServer(cards(171, 3));
    await render("/?sort=name-desc");
    const next = [...container.querySelectorAll('nav[aria-label="Library pages"] a')].find(
      (a) => (a.getAttribute("aria-label") ?? a.textContent?.trim()) === "Next",
    );
    expect(next?.getAttribute("href")).toBe("/?sort=name-desc&page=2");
    const pla = [...container.querySelectorAll('nav[aria-label="Filter by tag"] a')].find(
      (a) => a.textContent === "PLA",
    );
    expect(pla?.getAttribute("href")).toBe("/?sort=name-desc&tag=PLA");
  });

  test("time and weight say that models without numbers for the printer come last", async () => {
    stubServer(cards(5));
    await render("/?sort=time-asc");
    expect(container.textContent).toContain(
      `Models without a print time for ${PRINTER_NAME} are listed last.`,
    );
    await choose(sortMenu(), "weight-desc");
    expect(container.textContent).toContain(
      `Models without a filament weight for ${PRINTER_NAME} are listed last.`,
    );
    await choose(sortMenu(), "name-asc");
    expect(container.textContent).not.toContain("are listed last");
  });

  test("with another of My printers chosen, the time order and Select all matching are for it", async () => {
    localStorage.setItem(PRINTER_CHOICE_KEY, A1);
    stubServer(cards(5));
    await render("/?sort=time-desc");
    expect(lastLibraryQuery().get("printer")).toBe(A1);
    expect(lastLibraryQuery().get("sort")).toBe("time-desc");
    expect(container.textContent).toContain(
      `Models without a print time for ${A1_NAME} are listed last.`,
    );
    await selectMode();
    await click(button("Select all 5 matching"));
    const asked = requests.filter((r) => r.startsWith("GET /app/api/library/ids")).at(-1);
    const params = new URL(asked?.slice(4) ?? "", "https://platehouse.test").searchParams;
    expect(params.get("printer")).toBe(A1);
    expect(params.get("sort")).toBe("time-desc");
  });
});

describe("Select mode", () => {
  test("Select turns the cards into checkboxes named for their model; a click toggles one", async () => {
    stubServer(cards(5));
    await render("/");
    expect(checkboxes()).toHaveLength(0);
    await selectMode();
    expect(button("Select").getAttribute("aria-pressed")).toBe("true");
    expect(checkboxes()).toHaveLength(5);
    expect(container.querySelectorAll(".studio-grid a")).toHaveLength(0);
    expect(statusText()).toBe("No models selected");
    const first = checkbox("Model 001");
    expect(first.checked).toBe(false);
    await click(first);
    expect(checkbox("Model 001").checked).toBe(true);
    expect(statusText()).toBe("1 model selected");
    expect(container.querySelector("#ph-selection-count")?.getAttribute("role")).toBe("status");
    await click(checkbox("Model 001"));
    expect(statusText()).toBe("No models selected");
  });

  test("a click anywhere on the card toggles it, and a selected card is marked", async () => {
    stubServer(cards(3));
    await render("/");
    await selectMode();
    const title = [...container.querySelectorAll<HTMLElement>(".studio-card-title")].find(
      (t) => t.textContent === "Model 003",
    );
    await click(title);
    expect(checkbox("Model 003").checked).toBe(true);
    expect(checkbox("Model 003").closest("label")?.getAttribute("data-selected")).toBe("true");
  });

  test("Space toggles the focused card and does not scroll the page", async () => {
    stubServer(cards(3));
    await render("/");
    await selectMode();
    const card = checkbox("Model 002");
    expect(card.tabIndex).toBe(0);
    card.focus();
    const event = await key(card, " ");
    expect(event.defaultPrevented).toBe(true);
    expect(checkbox("Model 002").checked).toBe(true);
    await key(checkbox("Model 002"), " ");
    expect(checkbox("Model 002").checked).toBe(false);
  });

  test("Escape leaves Select mode, clears the selection and puts focus on Select", async () => {
    stubServer(cards(3));
    await render("/");
    await selectMode();
    await click(checkbox("Model 001"));
    await key(checkbox("Model 001"), "Escape");
    expect(button("Select").getAttribute("aria-pressed")).toBe("false");
    expect(checkboxes()).toHaveLength(0);
    expect(document.activeElement).toBe(button("Select"));
    await selectMode();
    expect(statusText()).toBe("No models selected");
  });

  describe("with another overlay open, Escape is that overlay's (PR #246 review)", () => {
    test("Escape in the upload dialog closes it only; Select mode and the selection stay", async () => {
      stubServer(cards(3));
      await renderWithOverlays();
      await selectMode();
      await click(checkbox("Model 001"));
      await act(async () => openUpload());
      await settle();
      const upload = dialog();
      expect(upload).not.toBeNull();
      await key(upload as HTMLElement, "Escape");
      expect(dialog()).toBeNull();
      expect(button("Select").getAttribute("aria-pressed")).toBe("true");
      expect(statusText()).toBe("1 model selected");
      // With the dialog closed, Escape is Select mode's again.
      await key(checkbox("Model 001"), "Escape");
      expect(button("Select").getAttribute("aria-pressed")).toBe("false");
    });

    test("Escape with the narrow-screen menu open closes the menu only; Select mode and the selection stay", async () => {
      stubServer(cards(3));
      await renderWithOverlays();
      await selectMode();
      await click(checkbox("Model 002"));
      await click(button("Menu"));
      expect(button("Menu").getAttribute("aria-expanded")).toBe("true");
      await key(button("Menu"), "Escape");
      expect(button("Menu").getAttribute("aria-expanded")).toBe("false");
      expect(button("Select").getAttribute("aria-pressed")).toBe("true");
      expect(statusText()).toBe("1 model selected");
      // With the menu closed, Escape is Select mode's again.
      await key(checkbox("Model 002"), "Escape");
      expect(button("Select").getAttribute("aria-pressed")).toBe("false");
    });

    test("with the menu opened before Select mode, Escape closes the menu and keeps the selection (issue #285)", async () => {
      // The menu's document listener is added first, so it runs before Select
      // mode's. In a browser the menu's close is rendered in the microtask
      // checkpoint between the two listeners, so Select mode then finds no
      // menu open (menuIsOpen) and would clear the selection; a test's
      // dispatchEvent runs no checkpoint there, so jsdom still shows the menu
      // open. What holds in both is that the menu marks the Escape it used
      // (preventDefault), which Select mode's guard reads whatever the order.
      // jsdom's click() sends no pointerdown, so the menu stays open through
      // the clicks below, as it does for a keyboard user.
      stubServer(cards(3));
      await renderWithOverlays();
      await click(button("Menu"));
      expect(button("Menu").getAttribute("aria-expanded")).toBe("true");
      await selectMode();
      await click(checkbox("Model 003"));
      expect(button("Menu").getAttribute("aria-expanded")).toBe("true");
      const pressed = await key(checkbox("Model 003"), "Escape");
      expect(pressed.defaultPrevented).toBe(true);
      expect(button("Menu").getAttribute("aria-expanded")).toBe("false");
      expect(button("Select").getAttribute("aria-pressed")).toBe("true");
      expect(statusText()).toBe("1 model selected");
      expect(checkbox("Model 003").checked).toBe(true);
    });
  });

  test("Select all on this page, then Clear selection", async () => {
    stubServer(cards(171));
    await render("/");
    await selectMode();
    await click(button("Select all on this page"));
    expect(statusText()).toBe("48 models selected");
    expect(checkboxes().every((c) => c.checked)).toBe(true);
    await click(button("Clear selection"));
    expect(statusText()).toBe("No models selected");
  });

  test("the selection stays across pages", async () => {
    stubServer(cards(60));
    await render("/");
    await selectMode();
    await click(checkbox("Model 001"));
    const next = [...container.querySelectorAll('nav[aria-label="Library pages"] a')].find(
      (a) => (a.getAttribute("aria-label") ?? a.textContent?.trim()) === "Next",
    );
    await click(next as HTMLElement);
    expect(location).toBe("/?page=2");
    await click(checkbox("Model 049"));
    expect(statusText()).toBe("2 models selected");
  });

  test("Select all matching names the count and selects every match for the search, filters and sort", async () => {
    stubServer(cards(171, 120));
    await render("/?tag=PLA&sort=name-asc");
    await selectMode();
    await click(button("Select all 120 matching"));
    const asked = requests.filter((r) => r.startsWith("GET /app/api/library/ids"));
    expect(asked).toHaveLength(1);
    const params = new URL(asked[0]?.slice(4) ?? "", "https://platehouse.test").searchParams;
    expect(params.get("tag")).toBe("PLA");
    expect(params.get("sort")).toBe("name-asc");
    expect(statusText()).toBe("120 models selected");
  });

  test("Select all matching stops at the cap and says so", async () => {
    stubServer(cards(1100));
    matchCap = 1000;
    await render("/");
    await selectMode();
    await click(button("Select the first 1000 matching"));
    expect(statusText()).toBe("1000 models selected");
    expect(container.textContent).toMatch(
      /Only the first 1000 matching models can be selected at once/,
    );
    expect(MAX_SELECTED).toBe(1000);
  });

  test("with nothing selected the actions do nothing", async () => {
    stubServer(cards(3));
    await render("/");
    await selectMode();
    for (const name of ["Add tags", "Remove tag", "Add to collection", "Move to trash"]) {
      expect(button(name).getAttribute("aria-disabled"), name).toBe("true");
      await click(button(name));
      expect(dialog(), name).toBeNull();
    }
    expect(posted).toEqual([]);
  });
});

describe("bulk actions", () => {
  async function twoSelected(n = 5, tagged = 0) {
    stubServer(cards(n, tagged));
    await render("/");
    await selectMode();
    await click(checkbox("Model 001"));
    await click(checkbox("Model 002"));
  }

  test("Add tags: type one, pick one, and add both to every selected model", async () => {
    await twoSelected();
    await click(button("Add tags"));
    expect(dialog()?.getAttribute("aria-modal")).toBe("true");
    expect(dialog()?.textContent).toContain("Add tags to 2 models");
    const input = dialog()?.querySelector("input") as HTMLInputElement;
    // The existing tags are offered to pick from.
    const list = document.getElementById(input.getAttribute("list") ?? "");
    expect([...(list?.querySelectorAll("option") ?? [])].map((o) => o.value)).toEqual([
      "Desk",
      "PLA",
    ]);
    await type(input, "PLA");
    await submit(input.form);
    await type(input, "Kitchen");
    await submit(input.form);
    const before = libraryQueries().length;
    await click(dialogButton("Add tags"));
    expect(posted).toEqual([
      { url: "/app/api/bulk/add-tags", body: { ids: [id(1), id(2)], tags: ["PLA", "Kitchen"] } },
    ]);
    expect(dialog()).toBeNull();
    expect(container.textContent).toContain("Added PLA and Kitchen to 2 models.");
    expect(libraryQueries().length).toBeGreaterThan(before);
  });

  test("after Add tags the new tag is in the tag filter, Remove tag and Add tags without a reload", async () => {
    serverTags = [];
    await twoSelected();
    await click(button("Remove tag"));
    expect(dialog()?.textContent).toContain("No model has a tag yet.");
    await click(dialogButton("Cancel"));
    await click(button("Add tags"));
    const input = dialog()?.querySelector("input") as HTMLInputElement;
    await type(input, "PLA");
    await submit(input.form);
    bulkAnswer = (_url, body) => {
      serverTags = ["PLA"];
      return json({ changed: body.ids, unchanged: [], failed: [], tags: body.tags });
    };
    await click(dialogButton("Add tags"));
    expect(
      [...container.querySelectorAll('nav[aria-label="Filter by tag"] a')].map(
        (a) => a.textContent,
      ),
    ).toContain("PLA");
    await click(button("Remove tag"));
    const menu = dialog()?.querySelector("select") as HTMLSelectElement;
    expect([...menu.options].map((o) => o.value)).toEqual(["PLA"]);
    await click(dialogButton("Cancel"));
    await click(button("Add tags"));
    const again = dialog()?.querySelector("input") as HTMLInputElement;
    const list = document.getElementById(again.getAttribute("list") ?? "");
    expect([...(list?.querySelectorAll("option") ?? [])].map((o) => o.value)).toEqual(["PLA"]);
  });

  test("after Move to trash takes the last model with a tag, its chip goes", async () => {
    serverTags = ["PLA"];
    await twoSelected(5, 2);
    const chips = () =>
      [...container.querySelectorAll('nav[aria-label="Filter by tag"] a')].map(
        (a) => a.textContent,
      );
    expect(chips()).toContain("PLA");
    bulkAnswer = (_url, body) => {
      serverTags = [];
      return json({ changed: body.ids, unchanged: [], failed: [] });
    };
    await click(button("Move to trash"));
    await click(dialogButton("Move to trash"));
    expect(chips()).not.toContain("PLA");
  });

  test("Add tags with no tag in the list sends nothing", async () => {
    await twoSelected();
    await click(button("Add tags"));
    expect(dialogButton("Add tags").getAttribute("aria-disabled")).toBe("true");
    await click(dialogButton("Add tags"));
    expect(posted).toEqual([]);
    expect(dialog()).not.toBeNull();
  });

  test("a tag typed but not yet added to the list is added too (issue #257)", async () => {
    await twoSelected();
    await click(button("Add tags"));
    const input = dialog()?.querySelector("input") as HTMLInputElement;
    await type(input, "PLA");
    expect(dialogButton("Add tags").getAttribute("aria-disabled")).toBe("false");
    await click(dialogButton("Add tags"));
    expect(posted).toEqual([
      { url: "/app/api/bulk/add-tags", body: { ids: [id(1), id(2)], tags: ["PLA"] } },
    ]);
    expect(dialog()).toBeNull();
    expect(container.textContent).toContain("Added PLA to 2 models.");
  });

  test("a typed tag joins the list once, ignoring capitals, and blank text is not a tag", async () => {
    await twoSelected();
    await click(button("Add tags"));
    const input = dialog()?.querySelector("input") as HTMLInputElement;
    await type(input, "Desk");
    await submit(input.form);
    // Typed again in other capitals and not added: it is already in the list.
    await type(input, "desk");
    await click(dialogButton("Add tags"));
    expect(posted.at(-1)?.body.tags).toEqual(["Desk"]);

    await click(button("Add tags"));
    const again = dialog()?.querySelector("input") as HTMLInputElement;
    await type(again, "   ");
    expect(dialogButton("Add tags").getAttribute("aria-disabled")).toBe("true");
    await click(dialogButton("Add tags"));
    expect(posted).toHaveLength(1);
  });

  test("Add tags takes at most MAX_TAGS tags, the server's limit, and says so in words", async () => {
    expect(MAX_TAGS).toBe(20);
    await twoSelected();
    await click(button("Add tags"));
    const input = dialog()?.querySelector("input") as HTMLInputElement;
    const chips = () => dialog()?.querySelectorAll(".ph-chip").length;
    for (let i = 1; i <= MAX_TAGS; i += 1) {
      await type(input, `Tag ${String(i).padStart(2, "0")}`);
      await submit(input.form);
    }
    expect(chips()).toBe(MAX_TAGS);
    expect(dialog()?.textContent).toContain(
      "One action adds at most 20 tags. Take one off the list to add another.",
    );
    // A 21st is not added to the list, stays typed, and says why.
    await type(input, "Tag 21");
    await submit(input.form);
    expect(chips()).toBe(MAX_TAGS);
    expect(input.value).toBe("Tag 21");
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe("The list is full.");
    // Typed but not listed, it would be the 21st sent, so Add tags sends nothing.
    expect(dialogButton("Add tags").getAttribute("aria-disabled")).toBe("true");
    await click(dialogButton("Add tags"));
    expect(posted).toEqual([]);
    expect(dialog()).not.toBeNull();
    // One off the list, and the typed tag goes with the other 19.
    await click(dialogButton("Take Tag 01 off the list"));
    expect(dialog()?.textContent).not.toContain("One action adds at most");
    expect(dialogButton("Add tags").getAttribute("aria-disabled")).toBe("false");
    await click(dialogButton("Add tags"));
    const sent = posted.at(-1)?.body.tags as string[];
    expect(sent).toHaveLength(MAX_TAGS);
    expect(sent).not.toContain("Tag 01");
    expect(sent.at(-1)).toBe("Tag 21");
  });

  test("after an action the grid reloads in place: the cards stay until the new answer is in", async () => {
    await twoSelected();
    const before = libraryQueries().length;
    holding = () => true;
    await click(button("Add to collection"));
    await type(dialog()?.querySelector("input") as HTMLInputElement, "Garage");
    await click(dialogButton("Add to collection"));
    expect(libraryQueries().length).toBeGreaterThan(before);
    expect(container.textContent).not.toContain("Loading the library");
    expect(checkboxes()).toHaveLength(5);
    expect(button("Select all 5 matching")).toBeDefined();
    await releaseHeld();
    expect(checkboxes()).toHaveLength(5);
    expect(statusText()).toBe("2 models selected");
  });

  test("in View all an action's reload keeps every card shown until every chunk is in again", async () => {
    stubServer(cards(450));
    await render("/?view=all");
    expect(checkboxes()).toHaveLength(0);
    await selectMode();
    expect(checkboxes()).toHaveLength(450);
    await click(checkbox("Model 001"));
    holding = (page) => page >= 2;
    await click(button("Add to collection"));
    await type(dialog()?.querySelector("input") as HTMLInputElement, "Garage");
    await click(dialogButton("Add to collection"));
    // The first chunk is back and the second is held: the grid is not cut to 200.
    expect(held.length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("Loading the library");
    expect(checkboxes()).toHaveLength(450);
    expect(button("Select all 450 matching")).toBeDefined();
    await releaseHeld();
    expect(checkboxes()).toHaveLength(450);
    expect(container.textContent).toContain("450 models, all shown");
  });

  test("an action's quiet reload hides View all's Try again, so a second loader cannot start", async () => {
    stubServer(cards(450));
    failing = (page) => page === 2;
    await render("/?view=all");
    expect(container.textContent).toContain("The rest of the library could not be loaded.");
    expect(button("Try again")).toBeDefined();
    await selectMode();
    expect(checkboxes()).toHaveLength(200);
    await click(checkbox("Model 001"));
    failing = null;
    holding = (page) => page >= 2;
    await click(button("Add to collection"));
    await type(dialog()?.querySelector("input") as HTMLInputElement, "Garage");
    await click(dialogButton("Add to collection"));
    // The reload is gathering the later chunks: the old failure and its
    // Try again are gone, so nothing can start a loader from the old cards.
    expect(held.length).toBeGreaterThan(0);
    expect(checkboxes()).toHaveLength(200);
    expect(container.textContent).not.toContain("could not be loaded");
    expect(() => button("Try again")).toThrow();
    expect(container.textContent).toContain("Loading the rest of the library");
    await releaseHeld();
    expect(checkboxes()).toHaveLength(450);
    expect(new Set(checkboxes().map((c) => c.getAttribute("aria-label"))).size).toBe(450);
    expect(container.textContent).toContain("450 models, all shown");
  });

  test("Remove tag: pick one of the library's tags", async () => {
    await twoSelected();
    await click(button("Remove tag"));
    const menu = dialog()?.querySelector("select") as HTMLSelectElement;
    expect([...menu.options].map((o) => o.value)).toEqual(["Desk", "PLA"]);
    await choose(menu, "PLA");
    await click(dialogButton("Remove tag"));
    expect(posted).toEqual([
      { url: "/app/api/bulk/remove-tag", body: { ids: [id(1), id(2)], tag: "PLA" } },
    ]);
    expect(container.textContent).toContain("Removed PLA from 2 models.");
  });

  test("Add to collection: an existing one is offered, a new one can be typed", async () => {
    await twoSelected();
    await click(button("Add to collection"));
    const input = dialog()?.querySelector("input") as HTMLInputElement;
    const list = document.getElementById(input.getAttribute("list") ?? "");
    expect([...(list?.querySelectorAll("option") ?? [])].map((o) => o.value)).toEqual(["Shelf"]);
    await type(input, "Garage");
    await click(dialogButton("Add to collection"));
    expect(posted).toEqual([
      {
        url: "/app/api/bulk/add-to-collection",
        body: { ids: [id(1), id(2)], collection: "Garage" },
      },
    ]);
    expect(container.textContent).toContain("Added 2 models to Garage.");
  });

  test("Move to trash asks in the app's own dialog with the count; Cancel sends nothing", async () => {
    await twoSelected();
    await click(button("Move to trash"));
    expect(dialog()?.textContent).toContain("Move 2 models to the trash?");
    expect(dialog()?.textContent).toMatch(/restored .*30 days/i);
    // The safe choice is focused first.
    expect(document.activeElement?.textContent).toBe("Cancel");
    await click(dialogButton("Cancel"));
    expect(dialog()).toBeNull();
    expect(posted).toEqual([]);
    expect(statusText()).toBe("2 models selected");
  });

  test("Move to trash: confirmed, the models go and leave the selection", async () => {
    await twoSelected();
    await click(button("Move to trash"));
    await click(dialogButton("Move to trash"));
    expect(posted).toEqual([{ url: "/app/api/bulk/trash", body: { ids: [id(1), id(2)] } }]);
    expect(dialog()).toBeNull();
    expect(container.textContent).toContain(
      "Moved 2 models to the trash. Restore them from the trash within 30 days.",
    );
    expect(statusText()).toBe("No models selected");
  });

  test("failures say which models failed and why", async () => {
    await twoSelected();
    await click(checkbox("Model 003"));
    bulkAnswer = () =>
      json({
        changed: [id(1)],
        unchanged: [],
        failed: [
          { id: id(2), reason: "in_trash" },
          { id: id(3), reason: "not_found" },
        ],
        tag: "PLA",
      });
    await click(button("Remove tag"));
    await choose(dialog()?.querySelector("select") as HTMLSelectElement, "PLA");
    await click(dialogButton("Remove tag"));
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("2 models could not be changed:");
    expect(alert?.textContent).toContain("Model 002 is in the trash");
    expect(alert?.textContent).toContain("Model 003 no longer exists");
    expect(container.textContent).toContain("Removed PLA from 1 model.");
    // Failed models leave the selection; they cannot be changed.
    expect(statusText()).toBe("1 model selected");
  });

  test("a request that fails keeps the dialog open and says so", async () => {
    await twoSelected();
    bulkAnswer = () => json({ error: "internal" }, 500);
    await click(button("Add to collection"));
    await type(dialog()?.querySelector("input") as HTMLInputElement, "Garage");
    await click(dialogButton("Add to collection"));
    expect(dialog()).not.toBeNull();
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(
      "Something went wrong. Try again.",
    );
  });

  test("Escape in a dialog closes the dialog only; Select mode stays", async () => {
    await twoSelected();
    await click(button("Add tags"));
    await key(dialog() as HTMLElement, "Escape");
    expect(dialog()).toBeNull();
    expect(button("Select").getAttribute("aria-pressed")).toBe("true");
    expect(statusText()).toBe("2 models selected");
  });
});

describe("View all while the library changes (issue #283)", () => {
  test("a model added ahead of the chunk boundary makes chunk 2 repeat chunk 1's last; it is shown once", async () => {
    // The server pages by offset (library-sort.test.ts pins it): with a model
    // added before the boundary between two requests, chunk 2 starts with the
    // model chunk 1 ended on. View all must not show it twice.
    const before = cards(250);
    const added = { ...before[0], id: id(999), name: "Model 000" } as LibraryCard;
    const after = [added, ...before];
    let asked = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "https://platehouse.test");
        requests.push(`GET ${url.pathname}${url.search}`);
        if (url.pathname === "/app/api/library/tags") return json({ tags: [] });
        if (url.pathname !== "/app/api/library") return new Response("no", { status: 404 });
        const page = Number(url.searchParams.get("page"));
        const size = Number(url.searchParams.get("limit"));
        // The first chunk is read before the model is added, the second after.
        const all = asked++ === 0 ? before : after;
        return json({
          printer: PRINTER,
          printerName: PRINTER_NAME,
          printers: MY_PRINTERS,
          models: all.slice((page - 1) * size, page * size),
          nextCursor: null,
          page,
          pageSize: size,
          pageCount: Math.ceil(all.length / size),
          total: all.length,
          totalCapped: false,
          libraryTotal: all.length,
          sort: "newest",
        });
      }),
    );
    await render("/?view=all");
    const names = [...container.querySelectorAll(".studio-grid .studio-card-title")].map(
      (el) => el.textContent,
    );
    expect(libraryQueries().map((p) => p.get("page"))).toEqual(["1", "2"]);
    // Chunk 2 began with Model 200, which chunk 1 already showed.
    expect(names.filter((n) => n === "Model 200")).toHaveLength(1);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toHaveLength(250);
  });
});

describe("describeBulk", () => {
  const names = new Map([
    [id(1), "Hook"],
    [id(2), "Clip"],
  ]);

  test("says what changed and what was already so", () => {
    expect(
      describeBulk(
        { action: "add-tags", tags: ["PLA"] },
        { changed: [id(1)], unchanged: [id(2)], failed: [], tags: ["PLA"] },
        names,
      ),
    ).toEqual({ done: "Added PLA to 1 model. 1 already had it.", failed: null });
    expect(
      describeBulk(
        { action: "remove-tag", tag: "pla" },
        { changed: [], unchanged: [id(1)], failed: [], tag: null },
        names,
      ).done,
    ).toBe("No model has the tag pla.");
    expect(
      describeBulk(
        { action: "add-to-collection", collection: "desk" },
        { changed: [id(1)], unchanged: [id(2)], failed: [], collection: "Desk" },
        names,
      ).done,
    ).toBe("Added 1 model to Desk. 1 was already in it.");
  });

  test("says so plainly when nothing changed because every model was already so (issue #256)", () => {
    const both = { changed: [] as string[], unchanged: [id(1), id(2)], failed: [] };
    expect(
      describeBulk({ action: "add-tags", tags: ["PLA"] }, { ...both, tags: ["PLA"] }, names).done,
    ).toBe("All 2 models already had PLA.");
    expect(
      describeBulk({ action: "remove-tag", tag: "pla" }, { ...both, tag: "PLA" }, names).done,
    ).toBe("None of the 2 models had PLA.");
    expect(
      describeBulk(
        { action: "add-to-collection", collection: "desk" },
        { ...both, collection: "Desk" },
        names,
      ).done,
    ).toBe("All 2 models were already in Desk.");
    const one = { changed: [] as string[], unchanged: [id(1)], failed: [] };
    expect(
      describeBulk(
        { action: "add-tags", tags: ["PLA", "PETG"] },
        { ...one, tags: ["PLA", "PETG"] },
        names,
      ).done,
    ).toBe("The model already had PLA and PETG.");
  });

  test("with some unchanged and some failed, counts instead of saying All or The model (issue #306)", () => {
    const mixed = {
      changed: [] as string[],
      unchanged: [id(1), id(2)],
      failed: [{ id: id(3), reason: "in_trash" as const }],
    };
    const many = new Map([...names, [id(3), "Peg"]]);
    const addTags = describeBulk(
      { action: "add-tags", tags: ["PLA"] },
      { ...mixed, tags: ["PLA"] },
      many,
    );
    expect(addTags.done).toBe("No model was changed. 2 already had it.");
    expect(addTags.failed).toBe("1 model could not be changed: Peg is in the trash.");
    expect(
      describeBulk({ action: "remove-tag", tag: "pla" }, { ...mixed, tag: "PLA" }, many).done,
    ).toBe("No model was changed. 2 did not have it.");
    expect(
      describeBulk(
        { action: "add-to-collection", collection: "desk" },
        { ...mixed, collection: "Desk" },
        many,
      ).done,
    ).toBe("No model was changed. 2 were already in it.");
    const one = { changed: [] as string[], unchanged: [id(1)], failed: mixed.failed };
    expect(
      describeBulk({ action: "add-tags", tags: ["PLA"] }, { ...one, tags: ["PLA"] }, many).done,
    ).toBe("No model was changed. 1 already had it.");
  });

  test("says no model was changed when every selected model failed", () => {
    const answer = {
      changed: [] as string[],
      unchanged: [] as string[],
      failed: [{ id: id(1), reason: "in_trash" as const }],
    };
    for (const action of [
      { action: "add-tags" as const, tags: ["PLA"] },
      { action: "remove-tag" as const, tag: "PLA" },
      { action: "add-to-collection" as const, collection: "Desk" },
    ]) {
      const text = describeBulk(
        action,
        { ...answer, tags: ["PLA"], tag: "PLA", collection: "Desk" },
        names,
      );
      expect(text.done, action.action).toBe("No model was changed.");
      expect(text.failed).toBe("1 model could not be changed: Hook is in the trash.");
    }
  });

  test("names at most five failed models, then how many more", () => {
    const failed = Array.from({ length: 7 }, (_, i) => ({
      id: id(10 + i),
      reason: "not_found" as const,
    }));
    const many = new Map(failed.map((f, i) => [f.id, `Part ${i + 1}`]));
    const text = describeBulk(
      { action: "trash" },
      { changed: [], unchanged: [], failed },
      many,
    ).failed;
    expect(text).toMatch(/^7 models could not be changed: Part 1 no longer exists; /);
    expect(text).toMatch(/Part 5 no longer exists, and 2 more\.$/);
  });

  test("models it has no name for are counted, not named", () => {
    const text = describeBulk(
      { action: "trash" },
      {
        changed: [],
        unchanged: [],
        failed: [
          { id: id(1), reason: "in_trash" },
          { id: id(20), reason: "in_trash" },
          { id: id(21), reason: "in_trash" },
          { id: id(22), reason: "not_found" },
        ],
      },
      names,
    ).failed;
    expect(text).toBe(
      "4 models could not be changed: Hook is in the trash; 2 other models are in the trash; 1 other model no longer exists.",
    );
  });
});
