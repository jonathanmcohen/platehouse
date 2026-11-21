// @vitest-environment jsdom
// The library's numbered pages and View all (the maintainer, 2026-11-19: replace Load
// more). Rendered in jsdom with React; the server is a stubbed fetch that
// answers GET /app/api/library's numbered pages the way the server does
// (apps/server/src/app-api/library.ts) and records every request.
//
// - 48 models a page, with Previous, Next and page numbers in a nav landmark
//   named "Library pages"; the current page is aria-current="page"; long
//   ranges are shortened with gaps so the control stays seven slots wide.
// - The page and View all are in the URL (?page=, ?view=all) beside ?q,
//   ?tag, ?creator and ?collection: a shared link opens the same page, Back
//   goes to the page before, and a new search or filter goes to page 1.
// - The total shows ("171 models", "12 of 171 models"); a page past the end
//   shows the last page and says so; a capped total says so.
// - View all loads every match in chunks of 200, keeps what it has when a
//   chunk fails and retries from that chunk, and stops at 1000 and says so.
// - After a page change from the pager, focus moves to the count above the
//   grid, so a keyboard or screen-reader user starts at the new page.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, type NavigateFunction, Route, Routes, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Filters } from "../src/library/Filters";
import { LibraryPage } from "../src/library/LibraryPage";
import type { LibraryCard } from "../src/library/ModelCard";
import { pagerItems } from "../src/library/Pager";
import { PAGE_MAX, PAGE_SIZE, VIEW_ALL_CHUNK, VIEW_ALL_MAX } from "../src/library/paging";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PRINTER = "Bambu Lab P1S 0.4 nozzle";

/** n synthetic cards named Model 001, Model 002, ..., the first `tagged` tagged PLA. */
function cards(n: number, tagged = 0): LibraryCard[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `0198f0c4-0000-7000-8000-${String(i + 1).padStart(12, "0")}`,
    name: `Model ${String(i + 1).padStart(3, "0")}`,
    creator: null,
    tags: i < tagged ? ["PLA"] : [],
    plateCount: 1,
    thumbnail: `/blobs/0198f0c4-0000-7000-9000-${String(i + 1).padStart(12, "0")}`,
    fileKind: "3mf" as const,
    timeSeconds: null,
    weightGrams: null,
    partial: false,
    numbersUnavailable: false,
  }));
}

let container: HTMLDivElement;
let root: Root;
/** Every URL the page fetched, in order. */
let requests: string[];
/** Library requests the stub fails, by their page number. */
let failPages: Set<number>;
/**
 * Most matches the stub counts: the server's PAGED_MATCH_CAP. Past it the
 * stub answers as the server does: total is the cap and totalCapped is true.
 */
let matchCap: number;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch that answers the library as the server does, from these cards. */
function stubServer(all: LibraryCard[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "https://platehouse.test");
      requests.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/app/api/library/tags") return json({ tags: ["PLA"] });
      if (url.pathname !== "/app/api/library") return new Response("no", { status: 404 });
      const asked = Number(url.searchParams.get("page"));
      // The server's querystring schema allows page 1 to 1,000,000 and answers 400 past it.
      if (asked > 1_000_000) return json({ error: "bad_request" }, 400);
      if (failPages.has(asked)) return new Response("busy", { status: 503 });
      const tag = url.searchParams.get("tag");
      const q = url.searchParams.get("q");
      const found = all.filter(
        (c) =>
          (tag === null || c.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) &&
          (q === null || c.name.toLowerCase().includes(q.toLowerCase())),
      );
      const matches = found.slice(0, matchCap);
      const pageSize = Number(url.searchParams.get("limit") ?? 48);
      const pageCount = Math.max(1, Math.ceil(matches.length / pageSize));
      const page = Math.min(Math.max(asked, 1), pageCount);
      return json({
        printer: PRINTER,
        printerName: "Bambu Lab P1S, 0.4 mm nozzle",
        printers: [{ id: PRINTER, name: "Bambu Lab P1S, 0.4 mm nozzle" }],
        models: matches.slice((page - 1) * pageSize, page * pageSize),
        nextCursor: null,
        page,
        pageSize,
        pageCount,
        total: matches.length,
        totalCapped: found.length > matchCap,
        libraryTotal: all.length,
      });
    }),
  );
}

async function render(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
  await settle();
}

async function settle() {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

let navigate: NavigateFunction = () => {};

function Probe() {
  navigate = useNavigate();
  return null;
}

function libraryAt(path: string) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Probe />
      <Routes>
        <Route path="/" element={<LibraryPage />} />
      </Routes>
    </MemoryRouter>
  );
}

function cardNames(): string[] {
  return [...container.querySelectorAll(".studio-grid .studio-card-title")].map(
    (el) => el.textContent ?? "",
  );
}

function libraryQueries(): URLSearchParams[] {
  return requests
    .filter((r) => /^\/app\/api\/library(?:\?|$)/.test(r))
    .map((r) => new URL(r, "https://platehouse.test").searchParams);
}

function lastLibraryQuery(): URLSearchParams {
  const last = libraryQueries().at(-1);
  if (last === undefined) throw new Error("the library was never asked for");
  return last;
}

function pager(): HTMLElement | null {
  return container.querySelector('nav[aria-label="Library pages"]');
}

function pagerLink(name: string): HTMLAnchorElement | undefined {
  return [...(pager()?.querySelectorAll("a") ?? [])].find(
    (a) => (a.getAttribute("aria-label") ?? a.textContent?.trim()) === name,
  );
}

function linkNamed(name: string): HTMLAnchorElement | undefined {
  return [...container.querySelectorAll("a")].find((a) => a.textContent?.trim() === name);
}

function countText(): string {
  return container.querySelector("#ph-library-count")?.textContent ?? "";
}

async function click(el: HTMLElement | undefined | null) {
  if (el === undefined || el === null) throw new Error("nothing to click");
  await act(async () => el.click());
  await settle();
}

beforeEach(() => {
  requests = [];
  failPages = new Set();
  matchCap = 1000;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("pagerItems shortens long ranges to seven slots", () => {
  test("seven pages or fewer are all shown", () => {
    expect(pagerItems(1, 1)).toEqual([1]);
    expect(pagerItems(2, 4)).toEqual([1, 2, 3, 4]);
    expect(pagerItems(7, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test("near the start: the first five, a gap and the last", () => {
    expect(pagerItems(1, 20)).toEqual([1, 2, 3, 4, 5, "gap", 20]);
    expect(pagerItems(4, 20)).toEqual([1, 2, 3, 4, 5, "gap", 20]);
  });

  test("in the middle: the first, a gap, the page and its neighbours, a gap and the last", () => {
    expect(pagerItems(5, 20)).toEqual([1, "gap", 4, 5, 6, "gap", 20]);
    expect(pagerItems(10, 20)).toEqual([1, "gap", 9, 10, 11, "gap", 20]);
  });

  test("near the end: the first, a gap and the last five", () => {
    expect(pagerItems(17, 20)).toEqual([1, "gap", 16, 17, 18, 19, 20]);
    expect(pagerItems(20, 20)).toEqual([1, "gap", 16, 17, 18, 19, 20]);
  });

  test("never more than seven slots, and always the current page", () => {
    for (let count = 1; count <= 40; count += 1) {
      for (let page = 1; page <= count; page += 1) {
        const items = pagerItems(page, count);
        expect(items.length, `${page} of ${count}`).toBeLessThanOrEqual(7);
        expect(items, `${page} of ${count}`).toContain(page);
        expect(items[0]).toBe(1);
        expect(items.at(-1)).toBe(count);
      }
    }
  });
});

describe("numbered pages", () => {
  test("171 models: page 1 holds 48, the total shows, and the pager is a named nav", async () => {
    stubServer(cards(171));
    await render(libraryAt("/"));
    expect(PAGE_SIZE).toBe(48);
    expect(lastLibraryQuery().toString()).toBe("page=1&limit=48");
    expect(cardNames()).toHaveLength(48);
    expect(cardNames()[0]).toBe("Model 001");
    expect(countText()).toBe("171 models, page 1 of 4");

    const nav = pager();
    expect(nav, "no Library pages nav").not.toBeNull();
    const current = nav?.querySelectorAll('[aria-current="page"]');
    expect(current?.length).toBe(1);
    expect(current?.[0]?.textContent).toBe("1");
    expect(pagerLink("Previous")).toBeUndefined();
    expect(pagerLink("Next")?.getAttribute("href")).toBe("/?page=2");
    expect(
      ["Page 1", "Page 2", "Page 3", "Page 4"].map((n) => pagerLink(n)?.getAttribute("href")),
    ).toEqual(["/", "/?page=2", "/?page=3", "/?page=4"]);
  });

  test("a page number asks for that page, marks it current and moves focus to the count", async () => {
    stubServer(cards(171));
    await render(libraryAt("/"));
    await click(pagerLink("Page 3"));
    expect(lastLibraryQuery().toString()).toBe("page=3&limit=48");
    expect(cardNames()[0]).toBe("Model 097");
    expect(cardNames()).toHaveLength(48);
    expect(pager()?.querySelector('[aria-current="page"]')?.textContent).toBe("3");
    expect(document.activeElement?.id).toBe("ph-library-count");
    expect(countText()).toBe("171 models, page 3 of 4");
    expect(pagerLink("Previous")?.getAttribute("href")).toBe("/?page=2");
  });

  test("following the current page's own link leaves focus for a later filter change alone", async () => {
    stubServer(cards(171, 60));
    await render(libraryAt("/"));
    await click(pagerLink("Page 1"));
    const pla = linkNamed("PLA");
    pla?.focus();
    await click(pla);
    expect(lastLibraryQuery().get("tag")).toBe("PLA");
    expect(document.activeElement?.id).not.toBe("ph-library-count");
  });

  test("a modifier click on a page link, for a new tab, leaves focus for a later filter change alone", async () => {
    stubServer(cards(171, 60));
    await render(libraryAt("/"));
    // jsdom cannot open a new tab; stop its own link navigation after React has seen the click.
    const stop = (event: Event) => event.preventDefault();
    document.addEventListener("click", stop);
    try {
      for (const keys of [
        { metaKey: true },
        { ctrlKey: true },
        { shiftKey: true },
        { altKey: true },
      ]) {
        const link = pagerLink("Page 3");
        if (link === undefined) throw new Error("no Page 3 link");
        await act(async () => {
          link.dispatchEvent(
            new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...keys }),
          );
        });
        await settle();
      }
    } finally {
      document.removeEventListener("click", stop);
    }
    expect(libraryQueries().map((q) => q.get("page"))).not.toContain("3");
    const pla = linkNamed("PLA");
    pla?.focus();
    await click(pla);
    expect(lastLibraryQuery().get("tag")).toBe("PLA");
    expect(document.activeElement?.id).not.toBe("ph-library-count");
  });

  test("Next and Previous step a page, and the last page has no Next", async () => {
    stubServer(cards(171));
    await render(libraryAt("/?page=3"));
    await click(pagerLink("Next"));
    expect(lastLibraryQuery().get("page")).toBe("4");
    expect(cardNames()).toHaveLength(27);
    expect(pagerLink("Next")).toBeUndefined();
    await click(pagerLink("Previous"));
    expect(lastLibraryQuery().get("page")).toBe("3");
  });

  test("a shared link to ?page=4 opens page 4", async () => {
    stubServer(cards(171));
    await render(libraryAt("/?page=4"));
    expect(lastLibraryQuery().get("page")).toBe("4");
    expect(cardNames()[0]).toBe("Model 145");
    expect(pager()?.querySelector('[aria-current="page"]')?.textContent).toBe("4");
  });

  test("Back returns to the page before, and Forward to the page after", async () => {
    stubServer(cards(171));
    await render(libraryAt("/"));
    await click(pagerLink("Page 2"));
    expect(cardNames()[0]).toBe("Model 049");
    await act(async () => navigate(-1));
    await settle();
    expect(lastLibraryQuery().get("page")).toBe("1");
    expect(cardNames()[0]).toBe("Model 001");
    await act(async () => navigate(1));
    await settle();
    expect(cardNames()[0]).toBe("Model 049");
  });

  test("a page that is not a whole number from 1 asks for page 1", async () => {
    stubServer(cards(171));
    for (const bad of ["abc", "0", "-2", "1.5x"]) {
      requests = [];
      await render(libraryAt(`/?page=${bad}`));
      expect(lastLibraryQuery().get("page"), bad).toBe("1");
      await act(async () => root.unmount());
      root = createRoot(container);
    }
  });

  test("a page past the server's most asks for its most and shows the last page", async () => {
    stubServer(cards(171));
    await render(libraryAt("/?page=2000000"));
    expect(lastLibraryQuery().get("page")).toBe(String(PAGE_MAX));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(cardNames()[0]).toBe("Model 145");
    // The note names the page the address asked for, not the clamped one (issue #241).
    expect(container.textContent).toContain(
      "There is no page 2000000. This is the last page, page 4.",
    );
  });

  test("a page past the end names the asked page as written, however long, without leading zeros", async () => {
    stubServer(cards(171));
    await render(libraryAt("/?page=0099999999999999999999"));
    expect(lastLibraryQuery().get("page")).toBe(String(PAGE_MAX));
    expect(container.textContent).toContain(
      "There is no page 99999999999999999999. This is the last page, page 4.",
    );
  });

  test("a page past the end shows the last page and says so", async () => {
    stubServer(cards(171));
    await render(libraryAt("/?page=9"));
    expect(cardNames()[0]).toBe("Model 145");
    expect(pager()?.querySelector('[aria-current="page"]')?.textContent).toBe("4");
    expect(container.textContent).toContain("There is no page 9. This is the last page, page 4.");
  });

  test("one page of models shows no pager and no View all choice", async () => {
    stubServer(cards(12));
    await render(libraryAt("/"));
    expect(cardNames()).toHaveLength(12);
    expect(countText()).toBe("12 models");
    expect(pager()).toBeNull();
    expect(linkNamed("View all")).toBeUndefined();
  });

  test("one model reads 1 model", async () => {
    stubServer(cards(1));
    await render(libraryAt("/"));
    expect(countText()).toBe("1 model");
  });

  test("a filtered library shows how many match of the whole library", async () => {
    stubServer(cards(171, 12));
    await render(libraryAt("/?tag=PLA"));
    expect(countText()).toBe("12 of 171 models");
    expect(cardNames()).toHaveLength(12);
  });

  test("a new search or tag goes back to page 1", async () => {
    stubServer(cards(171, 60));
    await render(libraryAt("/?page=3"));
    // The tag chips (Filters) link without ?page=.
    const pla = linkNamed("PLA");
    expect(pla?.getAttribute("href")).toBe("/?tag=PLA");
    await click(pla);
    expect(lastLibraryQuery().toString()).toBe("tag=PLA&page=1&limit=48");
    expect(pager()?.querySelector('[aria-current="page"]')?.textContent).toBe("1");

    // A search the way the top bar makes one: a new address with ?q= only.
    await act(async () => navigate("/?q=Model%2000"));
    await settle();
    expect(lastLibraryQuery().toString()).toBe("q=Model+00&page=1&limit=48");
  });

  test("a capped total says how far the pages reach", async () => {
    matchCap = 100;
    stubServer(cards(150));
    await render(libraryAt("/"));
    expect(countText()).toBe("100+ models, page 1 of 3");
    expect(container.textContent).toMatch(/only the first 100 matches can be shown/i);
  });

  test("an empty library and a search with no match still say so in words", async () => {
    stubServer([]);
    await render(libraryAt("/?page=3"));
    expect(container.querySelector(".studio-empty")?.textContent).toMatch(/no models yet/i);
    expect(pager()).toBeNull();
    expect(container.textContent).not.toContain("There is no page");

    await act(async () => root.unmount());
    root = createRoot(container);
    stubServer(cards(5));
    await render(libraryAt("/?q=nothing"));
    expect(container.querySelector(".studio-empty")?.textContent).toMatch(/no models match/i);
  });

  test("while a page loads it says so", async () => {
    let release: () => void = () => {};
    stubServer(cards(171));
    const real = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return real(input);
      }),
    );
    await act(async () => {
      root.render(libraryAt("/?page=2"));
    });
    expect(container.textContent).toContain("Loading the library");
    await act(async () => release());
    await settle();
  });
});

describe("View all", () => {
  test("shows every match on one page, in chunks of 200, with no pager", async () => {
    stubServer(cards(450));
    await render(libraryAt("/?view=all"));
    expect(VIEW_ALL_CHUNK).toBe(200);
    expect(libraryQueries().map((q) => q.toString())).toEqual([
      "page=1&limit=200",
      "page=2&limit=200",
      "page=3&limit=200",
    ]);
    expect(cardNames()).toHaveLength(450);
    expect(cardNames().at(-1)).toBe("Model 450");
    expect(pager()).toBeNull();
    expect(countText()).toBe("450 models, all shown");
  });

  test("every thumbnail loads lazily", async () => {
    stubServer(cards(250));
    await render(libraryAt("/?view=all"));
    const images = [...container.querySelectorAll(".studio-grid img")];
    expect(images).toHaveLength(250);
    for (const img of images) expect(img.getAttribute("loading")).toBe("lazy");
  });

  test("the View all and Pages choice keeps the search and filters and drops the page", async () => {
    stubServer(cards(171, 100));
    await render(libraryAt("/?tag=PLA&page=2"));
    const viewAll = linkNamed("View all");
    expect(viewAll?.getAttribute("href")).toBe("/?tag=PLA&view=all");
    expect(linkNamed("Pages")?.getAttribute("aria-current")).toBe("true");
    await click(viewAll);
    expect(cardNames()).toHaveLength(100);
    expect(linkNamed("View all")?.getAttribute("aria-current")).toBe("true");

    const pages = linkNamed("Pages");
    expect(pages?.getAttribute("href")).toBe("/?tag=PLA");
    await click(pages);
    expect(lastLibraryQuery().toString()).toBe("tag=PLA&page=1&limit=48");
    expect(cardNames()).toHaveLength(48);
  });

  test("a tag chip keeps View all", async () => {
    await render(
      <MemoryRouter initialEntries={["/?view=all&page=2"]}>
        <Filters tags={["PLA"]} />
      </MemoryRouter>,
    );
    const hrefs = [...container.querySelectorAll("a.studio-chip")].map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toEqual(["/?view=all", "/?view=all&tag=PLA"]);
  });

  test("a chunk that fails keeps the models shown and Try again goes on from that chunk", async () => {
    stubServer(cards(450));
    failPages = new Set([2]);
    await render(libraryAt("/?view=all"));
    expect(cardNames()).toHaveLength(200);
    // Not the page-wide failure, which would drop the models shown.
    expect(container.querySelector(".studio-alert")).toBeNull();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(/the rest of the library could not be loaded/i);
    expect(countText()).toBe("Showing 200 of 450 models");

    failPages = new Set();
    const before = requests.length;
    const retry = [...container.querySelectorAll("button")].find((b) =>
      /try again/i.test(b.textContent ?? ""),
    );
    await click(retry);
    expect(requests.slice(before)).toEqual([
      "/app/api/library?page=2&limit=200",
      "/app/api/library?page=3&limit=200",
    ]);
    expect(cardNames()).toHaveLength(450);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  test("View all stops at 1000 models and says how to see the rest", async () => {
    expect(VIEW_ALL_MAX).toBe(1000);
    stubServer(cards(1100));
    await render(libraryAt("/?view=all"));
    expect(libraryQueries()).toHaveLength(5);
    expect(cardNames()).toHaveLength(1000);
    expect(countText()).toBe("Showing 1000 of 1000+ models");
    expect(container.textContent).not.toMatch(/all shown/);
    expect(container.textContent).toMatch(/only the first 1000 matches can be shown/i);
  });

  test("a View all link opened on its own shows all, and with one page still offers Pages", async () => {
    stubServer(cards(12));
    await render(libraryAt("/?view=all"));
    expect(cardNames()).toHaveLength(12);
    expect(linkNamed("Pages")?.getAttribute("href")).toBe("/");
  });
});

describe("library.css", () => {
  // A path, not a URL: in jsdom the global URL is jsdom's, which node:fs refuses.
  const here = dirname(fileURLToPath(import.meta.url));
  const css = readFileSync(join(here, "../src/library/library.css"), "utf8");

  test("writes no colour of its own, so studio.css's checked palettes apply", () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\brgba?\(|\bhsla?\(/i);
  });

  test("draws the current page like the active chip and narrows the pager at phone width", () => {
    expect(css).toMatch(/\[aria-current="page"\][^{]*\{[^}]*var\(--chip-active-bg\)/);
    expect(css).toMatch(/@media \(max-width: 480px\)/);
  });
});
