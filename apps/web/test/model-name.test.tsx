// @vitest-environment jsdom
// The model page's name and source (0.1.0): the name in the page head is
// renamed in place with the collections pages' InlineRename, saved through
// PATCH /app/api/models/:id (the server's 500-character limit), and the
// model's MakerWorld page is linked from the About tab and beside the
// creator, opened in a new tab with rel="noopener noreferrer". Only an
// https://makerworld.com/models/<digits> address is ever linked; anything
// else shows no link. Rendered in jsdom with a stubbed fetch that records
// every request. Every name here is made up.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AboutTab, MakerWorldLink, makerWorldHref } from "../src/model/AboutTab";
import { ModelPage, type ModelView } from "../src/model/ModelPage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MODEL_ID = "0198f0c4-0000-7000-8000-00000000d001";
const MW = "https://makerworld.com/models/1234567";

function view(overrides: Partial<ModelView> = {}): ModelView {
  return {
    id: MODEL_ID,
    name: "Cable clip PETG",
    caption: "Cable Clip | Desk Edge",
    description: null,
    creator: "Maker One",
    license: null,
    licenseNote: null,
    makerWorldUrl: MW,
    tags: [],
    collections: [],
    printer: "Bambu Lab P1S 0.4 nozzle",
    files: [],
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
let requests: Array<{ method: string; path: string; body: unknown }>;
let current: ModelView;
let patchStatus: number;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  requests = [];
  current = view();
  patchStatus = 204;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "https://platehouse.test");
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      requests.push({ method, path: url.pathname, body });
      if (url.pathname === `/app/api/models/${MODEL_ID}`) {
        if (method === "GET") return json(current);
        if (method === "PATCH") {
          if (patchStatus !== 204) {
            return json({ error: "bad_request", message: "That name is too long." }, patchStatus);
          }
          current = { ...current, name: (body as { name: string }).name };
          return new Response(null, { status: 204 });
        }
      }
      return new Response("not found", { status: 404 });
    }),
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function showPage() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/models/${MODEL_ID}`]}>
        <Routes>
          <Route path="/models/:id" element={<ModelPage platform="mac" />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  await settle();
}

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (b) => (b.getAttribute("aria-label") ?? b.textContent) === name,
  );
  if (found === undefined) throw new Error(`no button ${name}`);
  return found;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
  await settle();
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("renaming the model from its page", () => {
  test("the page head shows the name as its heading with a Rename button", async () => {
    await showPage();
    expect(container.querySelector("h1")?.textContent).toBe("Cable clip PETG");
    expect(button("Rename Cable clip PETG")).toBeDefined();
  });

  test("Save sends the trimmed name through the app API and the heading shows it", async () => {
    await showPage();
    await click(button("Rename Cable clip PETG"));
    const input = container.querySelector<HTMLInputElement>("input");
    if (input === null) throw new Error("no input");
    expect(input.getAttribute("aria-label") ?? "").toBe("");
    expect(container.querySelector(`label[for="${input.id}"]`)?.textContent).toBe(
      "New name for Cable clip PETG",
    );
    expect(input.maxLength).toBe(500);
    await type(input, "  Desk cable clip  ");
    await act(async () => {
      input.form?.requestSubmit();
    });
    await settle();
    expect(requests.filter((r) => r.method === "PATCH")).toEqual([
      { method: "PATCH", path: `/app/api/models/${MODEL_ID}`, body: { name: "Desk cable clip" } },
    ]);
    expect(container.querySelector("h1")?.textContent).toBe("Desk cable clip");
    // The page asks the server again, so what it shows is what was stored.
    expect(requests.filter((r) => r.method === "GET").length).toBeGreaterThanOrEqual(2);
  });

  test("a refused save keeps the form open with the server's sentence", async () => {
    patchStatus = 400;
    await showPage();
    await click(button("Rename Cable clip PETG"));
    const input = container.querySelector<HTMLInputElement>("input");
    if (input === null) throw new Error("no input");
    await type(input, "Another name");
    await act(async () => {
      input.form?.requestSubmit();
    });
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("That name is too long.");
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector<HTMLInputElement>("input")?.value).toBe("Another name");
  });
});

describe("View on MakerWorld", () => {
  test("the page head links to MakerWorld beside the creator, in a new tab", async () => {
    await showPage();
    const head = container.querySelector(".studio-page-head");
    const link = head?.querySelector<HTMLAnchorElement>("a[target]");
    expect(link?.textContent).toBe("View on MakerWorld");
    expect(link?.getAttribute("href")).toBe(MW);
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(head?.querySelector(".studio-byline")?.textContent).toContain("by Maker One");
  });

  test("the About tab links to MakerWorld", async () => {
    await act(async () => {
      root.render(<AboutTab model={view()} />);
    });
    const link = container.querySelector<HTMLAnchorElement>("a[target]");
    expect(link?.getAttribute("href")).toBe(MW);
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link?.getAttribute("target")).toBe("_blank");
  });

  test("a model with no MakerWorld page shows no link anywhere", async () => {
    current = view({ makerWorldUrl: null, creator: null });
    await showPage();
    expect(container.querySelector("a[target]")).toBeNull();
    expect(container.textContent).not.toContain("MakerWorld");
    await act(async () => {
      // A model answered with no makerWorldUrl field at all.
      const { makerWorldUrl: _none, ...withoutField } = view();
      root.render(<AboutTab model={withoutField} />);
    });
    expect(container.querySelector("a[target]")).toBeNull();
  });

  test.each([
    ["another host", "https://evil.example/models/1"],
    ["a look-alike host", "https://makerworld.com.evil.example/models/1"],
    ["plain http", "http://makerworld.com/models/1"],
    ["a javascript URL", "javascript:alert(1)"],
    ["a path that is not a model", "https://makerworld.com/en/@someone"],
    ["extra path", "https://makerworld.com/models/1/../../x"],
    ["a query", "https://makerworld.com/models/1?next=https://evil.example"],
  ])("an address that is not a MakerWorld model page is not linked: %s", async (_label, url) => {
    expect(makerWorldHref(url)).toBeNull();
    await act(async () => {
      root.render(<MakerWorldLink url={url} />);
    });
    expect(container.querySelector("a")).toBeNull();
  });

  test("a MakerWorld model page is linked as given", () => {
    expect(makerWorldHref(MW)).toBe(MW);
    expect(makerWorldHref(null)).toBeNull();
    expect(makerWorldHref(undefined)).toBeNull();
  });
});
