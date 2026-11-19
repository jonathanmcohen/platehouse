// @vitest-environment jsdom
// The Settings page's one-off "Use file titles" action (0.1.0): it renames
// the models nobody has renamed from their file's title. The button first
// asks the server for a preview (GET /app/api/models/title-names), then asks
// in the app's own dialog with the count, a few examples and what is left
// alone; only Rename in that dialog sends POST. Nothing runs on its own.
// Rendered in jsdom with a stubbed fetch that records every request; the
// tests spy on window.confirm, alert and prompt and expect none to be
// called. Every name here is made up.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TitleNames } from "../src/settings/TitleNames";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Plan {
  planId: string;
  renames: Array<{ id: string; from: string; to: string }>;
  skipped: {
    renamedByUser: number;
    namedFromTitle: number;
    noTitle: number;
    sameName: number;
    nameNotFromFile: number;
    imported: number;
  };
}

const id = (n: number) => `0198f0c4-0000-7000-8000-${String(n).padStart(12, "0")}`;

const SKIPPED = {
  renamedByUser: 2,
  namedFromTitle: 1,
  noTitle: 4,
  sameName: 0,
  nameNotFromFile: 3,
  imported: 5,
};

const PLAN_ID = "ab".repeat(32);

function plan(renames: number): Plan {
  return {
    planId: PLAN_ID,
    renames: Array.from({ length: renames }, (_, i) => ({
      id: id(i + 1),
      from: `File_name_${i + 1}`,
      to: `Title ${i + 1}`,
    })),
    skipped: SKIPPED,
  };
}

let container: HTMLDivElement;
let root: Root;
let requests: string[];
let posted: unknown[];
let preview: Plan | number;
let applyStatus: number;
let applyBody: unknown;
let applied: number;
const native = { confirm: vi.fn(), alert: vi.fn(), prompt: vi.fn() };

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
  posted = [];
  preview = plan(3);
  applyStatus = 200;
  applyBody = { error: "x" };
  applied = 3;
  for (const fn of Object.values(native)) fn.mockReset();
  vi.stubGlobal("confirm", native.confirm);
  vi.stubGlobal("alert", native.alert);
  vi.stubGlobal("prompt", native.prompt);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "https://platehouse.test");
      const method = (init?.method ?? "GET").toUpperCase();
      requests.push(`${method} ${url.pathname}`);
      if (url.pathname === "/app/api/models/title-names") {
        if (method === "GET") {
          return typeof preview === "number" ? json({ error: "x" }, preview) : json(preview);
        }
        if (method === "POST") {
          posted.push(typeof init?.body === "string" ? JSON.parse(init.body) : init?.body);
          return applyStatus === 200 ? json({ renamed: applied }) : json(applyBody, applyStatus);
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
  for (const fn of Object.values(native)) expect(fn).not.toHaveBeenCalled();
});

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function show() {
  await act(async () => {
    root.render(<TitleNames />);
  });
  await settle();
}

function button(name: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((b) => b.textContent === name);
  if (found === undefined) throw new Error(`no button ${name}`);
  return found;
}

async function click(el: HTMLElement) {
  await act(async () => {
    el.click();
  });
  await settle();
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

describe("Use file titles", () => {
  test("the section explains the action and asks the server for nothing until pressed", async () => {
    await show();
    expect(container.querySelector("h2")?.textContent).toBe("Model names");
    expect(button("Use file titles")).toBeDefined();
    expect(requests).toEqual([]);
  });

  test("pressing it previews first: the dialog says how many, gives examples and what is skipped", async () => {
    await show();
    await click(button("Use file titles"));
    expect(requests).toEqual(["GET /app/api/models/title-names"]);
    const box = dialog();
    expect(box?.getAttribute("aria-modal")).toBe("true");
    const text = box?.textContent ?? "";
    expect(text).toContain("3 models will be renamed from their file's title.");
    expect(text).toContain('"File_name_1" becomes "Title 1"');
    expect(text).toContain("15 are left as they are");
    expect(text).toContain("2 renamed by you");
    expect(text).toContain("3 whose name is not a file name");
    expect(text).toContain("4 with no title");
    expect(text).toContain("1 already named from a title");
    expect(text).toContain("5 imported from another library");
    // Safe choice first.
    expect(document.activeElement?.textContent).toBe("Cancel");
  });

  test("Cancel closes the dialog and renames nothing", async () => {
    await show();
    await click(button("Use file titles"));
    await click(button("Cancel"));
    expect(dialog()).toBeNull();
    expect(requests).toEqual(["GET /app/api/models/title-names"]);
  });

  test("Rename in the dialog runs it and says how many were renamed", async () => {
    await show();
    await click(button("Use file titles"));
    await click(button("Rename 3 models"));
    expect(requests).toEqual([
      "GET /app/api/models/title-names",
      "POST /app/api/models/title-names",
    ]);
    // It sends the preview's plan id, so only the list shown is applied.
    expect(posted).toEqual([{ planId: PLAN_ID }]);
    expect(dialog()).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Renamed 3 models.");
  });

  test("one model is said in the singular", async () => {
    preview = plan(1);
    applied = 1;
    await show();
    await click(button("Use file titles"));
    expect(dialog()?.textContent).toContain("1 model will be renamed from its file's title.");
    await click(button("Rename 1 model"));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Renamed 1 model.");
  });

  test("with nothing to rename it says so, with no dialog and nothing sent", async () => {
    preview = plan(0);
    await show();
    await click(button("Use file titles"));
    expect(dialog()).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "No model needs a new name. 15 are left as they are.",
    );
    expect(requests).toEqual(["GET /app/api/models/title-names"]);
  });

  test("a preview that fails says so and opens no dialog", async () => {
    preview = 500;
    await show();
    await click(button("Use file titles"));
    expect(dialog()).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Something went wrong. Try again.",
    );
  });

  test("a run that fails keeps the dialog open with the reason", async () => {
    applyStatus = 503;
    await show();
    await click(button("Use file titles"));
    await click(button("Rename 3 models"));
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(
      "This is unavailable right now. Try again in a moment.",
    );
  });

  test("a preview the library has moved past keeps the dialog open and says nothing was renamed", async () => {
    applyStatus = 409;
    applyBody = {
      error: "plan_changed",
      message: "The library changed after this preview, so nothing was renamed.",
    };
    await show();
    await click(button("Use file titles"));
    await click(button("Rename 3 models"));
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(
      "The library changed after this preview, so nothing was renamed.",
    );
    expect(container.querySelector('[role="status"]')?.textContent).toBe("");
  });

  test("the examples are at most five", async () => {
    preview = plan(12);
    await show();
    await click(button("Use file titles"));
    const text = dialog()?.textContent ?? "";
    expect(text).toContain('"File_name_5" becomes "Title 5"');
    expect(text).not.toContain('"File_name_6"');
    expect(text).toContain("and 7 more");
  });
});
