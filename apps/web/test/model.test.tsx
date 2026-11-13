// @vitest-environment jsdom
// Build plan Task 20 (AC-030, AC-032, AC-033 and AC-034 display, AC-040,
// AC-050, AC-051, AC-072): the model page. Rendered in jsdom with React; the
// server is a stubbed fetch that records every request, the slicer
// protocol navigation is a recording function, and three.js is replaced by
// a recording loader, since jsdom has no WebGL.
//
// The plan's tests:
// - plates tab lists every plate in order with name or Plate N, swatches,
//   grams, time and weight
// - estimating state renders and is replaced when numbers arrive (polling
//   every 5 s while any plate is estimating; it stops when none is, when the
//   page unmounts and on navigation to another model, with no request after);
//   the same poll runs while a STEP or SCAD file's mesh or render is pending,
//   so it shows without a reload, and a failed render shows its reason
// - failed plate shows the plain reason and a retry button
// - open in OrcaSlicer builds orcaslicer://open?file=<encoded link>
// - open in Bambu Studio on macOS builds bambustudioopen://<encoded link>
// - .3mf shows no 3D view
// Also: dropping files on the page hands them to Task 19's upload dialog with
// this model as the target, and the dialog then hides the Combine switch;
// the page's Add files button opens that dialog again with no files, so a
// row that failed or was left unsent while it was hidden is seen; the layout (viewer left, tabs Plates, Files and About, Plates first
// and only with a .3mf), each set of numbers labelled with where it came
// from, the About tab rendering Task 7's renderMarkdown with the licence
// note beside the licence, and the page CSS using only studio.css tokens.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { formatDuration, formatWeight } from "../src/library/ModelCard";
import { AboutTab } from "../src/model/AboutTab";
import {
  isDeriving,
  isEstimating,
  type ModelFile,
  ModelPage,
  type ModelPageProps,
  type ModelPlate,
  type ModelView,
  needsPolling,
  type PlateNumbers,
  POLL_MS,
} from "../src/model/ModelPage";
import { BAMBU_PROMPT_LINE, type SlicerLink } from "../src/model/OpenInSlicer";
import type { ThreeLoader, ThreeSource } from "../src/model/Viewer3d";
import { UploadDialog } from "../src/upload/UploadDialog";
import type { StartUpload, UploadTarget } from "../src/upload/useTusUpload";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * For the app test at the end, which loads main.tsx itself: every React root
 * made, so it can unmount the app's, and every tus upload started, with its
 * metadata (the target). The stand-in Upload sends nothing; no other test
 * here starts a real tus upload.
 */
const recorded = vi.hoisted(() => ({
  roots: [] as Array<{ unmount(): void }>,
  uploads: [] as Array<{
    name: string;
    metadata: Record<string, string>;
    /** Ends this upload as tus-js-client does when it gives up. */
    fail(error: Error): void;
  }>,
}));

vi.mock("react-dom/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom/client")>();
  return {
    ...actual,
    createRoot: (...args: Parameters<typeof actual.createRoot>) => {
      const made = actual.createRoot(...args);
      recorded.roots.push(made);
      return made;
    },
  };
});

vi.mock("tus-js-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("tus-js-client")>();
  class Upload {
    url: string | null = null;
    constructor(
      file: File,
      options: { metadata?: Record<string, string>; onError?: (error: Error) => void },
    ) {
      recorded.uploads.push({
        name: file.name,
        metadata: { ...options.metadata },
        fail: (error) => options.onError?.(error),
      });
    }
    findPreviousUploads() {
      return Promise.resolve([]);
    }
    resumeFromPreviousUpload() {}
    start() {}
    abort() {
      return Promise.resolve();
    }
  }
  return { ...actual, Upload };
});

const P1S = "Bambu Lab P1S 0.4 nozzle";
const X1C = "Bambu Lab X1 Carbon 0.4 nozzle";

const MODEL_ID = "0198f0c4-0000-7000-8000-00000000a001";
const OTHER_MODEL_ID = "0198f0c4-0000-7000-8000-00000000a002";
const FILE_3MF = "0198f0c4-0000-7000-8000-00000000b001";
const FILE_STL = "0198f0c4-0000-7000-8000-00000000b002";
const FILE_STEP = "0198f0c4-0000-7000-8000-00000000b003";
const FILE_SCAD = "0198f0c4-0000-7000-8000-00000000b004";
const EST_FAILED = "0198f0c4-0000-7000-8000-00000000e009";

const thumb = (n: number) => `/blobs/0198f0c4-0000-7000-8000-0000000000c${n}`;

/** Non-ASCII built from code points, so this file stays ASCII. */
const U_UMLAUT = String.fromCodePoint(0xfc);
const SNOWMAN = String.fromCodePoint(0x2603);
/** A name with spaces, a slash, quotes and non-ASCII characters. */
const HOSTILE_NAME = `Big "box" / v2 ${U_UMLAUT}ber ${SNOWMAN}.3mf`;

function fileNumbers(n: number) {
  return {
    source: "file" as const,
    estimateId: `0198f0c4-0000-7000-8000-00000000e00${n}`,
    printerId: P1S,
    printerLabel: P1S,
    slicer: null,
    slicerVersion: null,
    processProfile: "0.20mm Standard @BBL P1P",
    timeSeconds: 1000 * n + 25,
    weightGrams: 10 * n + 0.5,
    filaments: [
      { slot: 1, type: "PLA", color: "#00AE42", grams: 10 * n, profile: null, profileSource: null },
      { slot: 2, type: "PETG", color: "#FFFFFF", grams: 0.5, profile: null, profileSource: null },
    ],
  };
}

function estimate(
  state: "current" | "estimating" | "stale",
  overrides: Record<string, unknown> = {},
): NonNullable<PlateNumbers["platehouse"]> {
  return {
    source: "platehouse",
    estimateId: "0198f0c4-0000-7000-8000-00000000e100",
    printerId: P1S,
    printerLabel: P1S,
    slicer: "OrcaSlicer",
    slicerVersion: "2.5.0",
    processProfile: "0.20mm Standard @BBL X1C",
    timeSeconds: state === "estimating" ? null : 5025,
    weightGrams: state === "estimating" ? null : 41.37,
    filaments:
      state === "estimating"
        ? []
        : [
            {
              slot: 1,
              type: "PLA",
              color: "#000000",
              grams: 41.37,
              profile: "Bambu PLA Basic @BBL P1S",
              profileSource: "bambu",
            },
          ],
    state,
    ...overrides,
  } as NonNullable<PlateNumbers["platehouse"]>;
}

/**
 * A plate. estimatePending says whether an estimate for the selected printer
 * is queued or slicing; it defaults to true only for the estimating state,
 * which the server gives only then.
 */
function plate(
  index: number,
  name: string | null,
  numbers: PlateNumbers,
  estimatePending = numbers.platehouse?.state === "estimating",
): ModelPlate {
  return {
    id: `0198f0c4-0000-7000-8000-00000000d00${index}`,
    index,
    name,
    objectCount: 1,
    thumbnail: thumb(index),
    numbers,
    estimatePending,
  };
}

function threeMf(plates: ModelPlate[], overrides: Partial<ModelFile> = {}): ModelFile {
  return {
    id: FILE_3MF,
    name: "Cube set.3mf",
    kind: "3mf",
    size: 123456,
    parseStatus: "ok",
    derivedStatus: null,
    derivedMessage: null,
    download: `/files/${FILE_3MF}/download`,
    view: null,
    preview: null,
    filaments: [
      { slot: 1, type: "PLA", color: "#00AE42" },
      { slot: 2, type: "PETG", color: "#FFFFFF" },
    ],
    plates,
    ...overrides,
  };
}

const STL_FILE: ModelFile = {
  id: FILE_STL,
  name: "Bracket.stl",
  kind: "stl",
  size: 684,
  parseStatus: "ok",
  derivedStatus: null,
  derivedMessage: null,
  download: `/files/${FILE_STL}/download`,
  view: { kind: "stl", url: "/blobs/0198f0c4-0000-7000-8000-0000000000f1" },
  preview: null,
  filaments: [],
  plates: [],
};

const STEP_FILE: ModelFile = {
  id: FILE_STEP,
  name: "Housing.step",
  kind: "step",
  size: 2048,
  parseStatus: "ok",
  derivedStatus: null,
  derivedMessage: null,
  download: `/files/${FILE_STEP}/download`,
  view: { kind: "glb", url: "/blobs/0198f0c4-0000-7000-8000-0000000000f2" },
  preview: null,
  filaments: [],
  plates: [],
};

function model(files: ModelFile[], overrides: Partial<ModelView> = {}): ModelView {
  return {
    id: MODEL_ID,
    name: "Cube set",
    caption: "Three cubes for testing",
    description: null,
    creator: "Maker One",
    license: "CC-BY-4.0",
    licenseNote: null,
    tags: ["Gridfinity"],
    collections: ["Desk"],
    printer: P1S,
    files,
    ...overrides,
  };
}

/** Three plates: Bambu's numbers on 1 and 3, plate 2 with no name and no file numbers. */
function threePlates(): ModelView {
  return model([
    threeMf([
      plate(1, "Base", { file: fileNumbers(1) }),
      plate(2, null, { platehouse: estimate("current") }),
      plate(3, "Lid", { file: fileNumbers(3) }),
    ]),
  ]);
}

let container: HTMLDivElement;
let root: Root;
/** Every request the page made, "METHOD /path?query", in order. */
let requests: string[];
/** What GET /app/api/models/:id answers, per model id; swapped by a test. */
let models: Map<string, ModelView | number>;
/** What a POST to the slicer-link route answers. */
let mintAnswer: (fileId: string) => Response;
/** What a POST to the retry route answers. */
let retryStatus: number;
let navigations: string[];
let loads: ThreeSource[];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubServer() {
  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "https://platehouse.test");
    const method = (init?.method ?? "GET").toUpperCase();
    requests.push(`${method} ${url.pathname}${url.search}`);
    const modelMatch = /^\/app\/api\/models\/([^/]+)$/.exec(url.pathname);
    if (method === "GET" && modelMatch) {
      const answer = models.get(modelMatch[1] ?? "");
      if (answer === undefined) return json({ error: "not_found" }, 404);
      if (typeof answer === "number") return json({ error: "x" }, answer);
      return json(answer);
    }
    const mintMatch = /^\/app\/api\/files\/([^/]+)\/slicer-link$/.exec(url.pathname);
    if (method === "POST" && mintMatch) return mintAnswer(mintMatch[1] ?? "");
    if (method === "POST" && /^\/app\/api\/estimates\/[^/]+\/retry$/.test(url.pathname)) {
      return retryStatus === 202
        ? json({ queued: true }, 202)
        : json({ error: "not_retryable" }, retryStatus);
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

/** A recording stand-in for three.js: it shows nothing and records each source. */
const fakeThree: ThreeLoader = async () => ({
  async show(_el, source) {
    loads.push(source);
    return {
      rotate: () => {},
      zoom: () => {},
      reset: () => {},
      dispose: () => {},
    };
  },
});
const loadThree = vi.fn(fakeThree);

/** Lets fetches and the state updates after them finish (real or fake timers). */
async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
      else await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Waits, in real time, until the selector matches: the About tab imports its renderer on first use. */
async function until(selector: string, ms = 5_000) {
  const end = Date.now() + ms;
  while (container.querySelector(selector) === null) {
    if (Date.now() > end) throw new Error(`nothing matched ${selector} within ${ms} ms`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

async function render(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
  await settle();
}

/** The test's handle on the router, to navigate as a link would. */
let go: (to: string) => void = () => {};
function Navigator() {
  const navigate = useNavigate();
  go = (to) => {
    navigate(to);
  };
  return null;
}

function pageAt(id: string, props: Partial<ModelPageProps> = {}) {
  return (
    <MemoryRouter initialEntries={[`/models/${id}`]}>
      <Navigator />
      <Routes>
        <Route
          path="/models/:id"
          element={
            <ModelPage
              loadThree={loadThree}
              navigateTo={(url) => navigations.push(url)}
              platform="mac"
              {...props}
            />
          }
        />
        <Route path="/" element={<p>Library</p>} />
      </Routes>
    </MemoryRouter>
  );
}

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function tabs(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
}

function tab(label: string): HTMLElement {
  const found = tabs().find((t) => text(t) === label);
  if (found === undefined) throw new Error(`no ${label} tab`);
  return found;
}

/** The visible tab panel. */
function panel(): HTMLElement {
  const shown = [...container.querySelectorAll<HTMLElement>('[role="tabpanel"]')].filter(
    (p) => !p.hidden,
  );
  expect(shown).toHaveLength(1);
  return shown[0] as HTMLElement;
}

async function click(el: Element | null | undefined) {
  if (!el) throw new Error("nothing to click");
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}

function button(label: RegExp, scope: ParentNode = container): HTMLButtonElement {
  const found = [...scope.querySelectorAll("button")].find((b) => label.test(text(b)));
  if (found === undefined) throw new Error(`no button matching ${label}`);
  return found;
}

/** Plate items of the Plates tab, in order. */
function plateItems(): HTMLElement[] {
  return [...panel().querySelectorAll<HTMLElement>("[data-plate]")];
}

beforeEach(() => {
  requests = [];
  navigations = [];
  loads = [];
  retryStatus = 202;
  models = new Map<string, ModelView | number>([[MODEL_ID, threePlates()]]);
  mintAnswer = () => json({ error: "not_found" }, 404);
  loadThree.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  stubServer();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the model page layout (AC-072)", () => {
  test("the viewer is on the left and the tabs Plates, Files and About on the right, Plates first", async () => {
    await render(pageAt(MODEL_ID));
    expect(text(container.querySelector("h1"))).toBe("Cube set");
    const layout = container.querySelector(".studio-model");
    expect(layout, "no .studio-model layout").not.toBeNull();
    const [first, second] = [...(layout?.children ?? [])];
    expect(first?.classList.contains("studio-viewer")).toBe(true);
    expect(second?.classList.contains("studio-model-info")).toBe(true);
    expect(tabs().map(text)).toEqual(["Plates", "Files", "About"]);
    expect(tab("Plates").getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('[role="tablist"]')).not.toBeNull();
  });

  test("the page asks only the model's app API to render", async () => {
    await render(pageAt(MODEL_ID));
    expect(requests).toEqual([`GET /app/api/models/${MODEL_ID}`]);
  });

  test("with no .3mf there is no Plates tab, and Files is first", async () => {
    models.set(MODEL_ID, model([STL_FILE]));
    await render(pageAt(MODEL_ID));
    expect(tabs().map(text)).toEqual(["Files", "About"]);
    expect(tab("Files").getAttribute("aria-selected")).toBe("true");
  });

  test("the tabs work by keyboard: arrow keys move between them and only the chosen one is in the Tab order", async () => {
    await render(pageAt(MODEL_ID));
    const plates = tab("Plates");
    expect(plates.tabIndex).toBe(0);
    expect(tab("Files").tabIndex).toBe(-1);
    await act(async () => {
      plates.focus();
      plates.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(tab("Files").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Files"));
    expect(panel().getAttribute("aria-labelledby")).toBe(tab("Files").id);
    await act(async () => {
      tab("Files").dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(tab("About").getAttribute("aria-selected")).toBe("true");
    await act(async () => {
      tab("About").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(tab("Plates").getAttribute("aria-selected")).toBe("true");
  });

  test("a model that is not in the library says so and links back to it", async () => {
    await render(pageAt(OTHER_MODEL_ID));
    expect(text(container)).toMatch(/not in the library/i);
    expect(container.querySelector('a[href="/"]')).not.toBeNull();
  });

  test("a model the server cannot give shows a message and a way to try again", async () => {
    models.set(MODEL_ID, 503);
    await render(pageAt(MODEL_ID));
    expect(text(container.querySelector('[role="alert"]'))).toMatch(/could not be loaded/i);
    models.set(MODEL_ID, threePlates());
    await click(button(/try again/i));
    expect(text(container.querySelector("h1"))).toBe("Cube set");
  });
});

describe("plates tab lists every plate in order with name or Plate N, swatches, grams, time and weight", () => {
  test("each plate in plate order, with its thumbnail, name or Plate N, filaments, time and weight", async () => {
    await render(pageAt(MODEL_ID));
    const items = plateItems();
    expect(items).toHaveLength(3);
    expect(items.map((li) => text(li.querySelector("h3")))).toEqual(["Base", "Plate 2", "Lid"]);
    expect(items.map((li) => li.querySelector("img")?.getAttribute("src"))).toEqual([
      thumb(1),
      thumb(2),
      thumb(3),
    ]);

    const first = items[0] as HTMLElement;
    expect(text(first)).toContain(formatDuration(1025));
    expect(text(first)).toContain(formatWeight(10.5));
    const swatches = [...first.querySelectorAll<HTMLElement>(".studio-swatch")];
    expect(swatches.map((s) => s.style.backgroundColor)).toEqual([
      "rgb(0, 174, 66)",
      "rgb(255, 255, 255)",
    ]);
    expect(text(first)).toContain("PLA");
    expect(text(first)).toContain("PETG");
    expect(text(first)).toContain(formatWeight(10));
    expect(text(first)).toContain(formatWeight(0.5));

    const second = items[1] as HTMLElement;
    expect(text(second)).toContain(formatDuration(5025));
    expect(text(second)).toContain(formatWeight(41.37));
  });

  test("plates of two .3mf files are listed per file, each in its own plate order", async () => {
    const second = threeMf(
      [plate(2, "Two", { file: fileNumbers(2) }), plate(1, "One", { file: fileNumbers(1) })],
      { id: "0198f0c4-0000-7000-8000-00000000b009", name: "Second.3mf" },
    );
    models.set(MODEL_ID, model([threeMf([plate(1, "Only", { file: fileNumbers(1) })]), second]));
    await render(pageAt(MODEL_ID));
    expect(plateItems().map((li) => text(li.querySelector("h3")))).toEqual(["Only", "One", "Two"]);
  });

  test("a .3mf with no plate data says so in plain words", async () => {
    models.set(MODEL_ID, model([threeMf([], { parseStatus: "no_plate_data" })]));
    await render(pageAt(MODEL_ID));
    expect(text(panel())).toContain("No Bambu plate data in this file");
  });
});

describe("each set of numbers says where it came from (AC-032 display)", () => {
  test("Bambu's own numbers are labelled as from the file, with the printer and process", async () => {
    await render(pageAt(MODEL_ID));
    const first = text(plateItems()[0]);
    expect(first).toContain("Bambu, in the file");
    expect(first).toContain(P1S);
    expect(first).toContain("0.20mm Standard @BBL P1P");
    expect(first).not.toMatch(/estimate/i);
  });

  test("a Platehouse estimate is marked as an estimate, with slicer, version, printer, process and filament profiles", async () => {
    await render(pageAt(MODEL_ID));
    const second = text(plateItems()[1]);
    expect(second).toContain("Platehouse estimate");
    expect(second).toContain("OrcaSlicer 2.5.0");
    expect(second).toContain(P1S);
    expect(second).toContain("0.20mm Standard @BBL X1C");
    expect(second).toContain("Bambu PLA Basic @BBL P1S");
  });

  test("a file sliced for another printer shows its numbers labelled with that printer beside the estimate", async () => {
    models.set(
      MODEL_ID,
      model([
        threeMf([
          plate(1, "Base", {
            file: { ...fileNumbers(1), printerId: X1C, printerLabel: X1C },
            platehouse: estimate("current"),
          }),
        ]),
      ]),
    );
    await render(pageAt(MODEL_ID));
    const only = text(plateItems()[0]);
    expect(only).toContain("Bambu, in the file");
    expect(only).toContain(X1C);
    expect(only).toContain("Platehouse estimate");
    expect(only).toContain(P1S);
  });

  test("an older estimate shown meanwhile is marked as for the previous printer", async () => {
    models.set(
      MODEL_ID,
      model([
        threeMf([
          plate(1, "Base", {
            platehouse: estimate("stale", { printerId: X1C, printerLabel: X1C, staleFor: X1C }),
          }),
        ]),
      ]),
    );
    await render(pageAt(MODEL_ID));
    const only = text(plateItems()[0]);
    expect(only).toMatch(/previous printer/i);
    expect(only).toContain(X1C);
  });
});

describe("estimating state renders and is replaced when numbers arrive", () => {
  function estimatingModel(): ModelView {
    return model([
      threeMf([
        plate(1, "Base", { file: fileNumbers(1) }),
        plate(2, "Waiting", { platehouse: estimate("estimating") }),
      ]),
    ]);
  }

  function modelRequests(id = MODEL_ID): number {
    return requests.filter((r) => r === `GET /app/api/models/${id}`).length;
  }

  test("polls every 5 s while a plate is estimating, then stops once none is", async () => {
    expect(POLL_MS).toBe(5000);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    models.set(MODEL_ID, estimatingModel());
    await render(pageAt(MODEL_ID));
    expect(modelRequests()).toBe(1);
    expect(text(plateItems()[1])).toMatch(/estimating/i);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_900);
    });
    expect(modelRequests()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    await settle();
    expect(modelRequests()).toBe(2);
    expect(text(plateItems()[1])).toMatch(/estimating/i);

    // The estimate lands: the next poll replaces the estimating state.
    models.set(
      MODEL_ID,
      model([
        threeMf([
          plate(1, "Base", { file: fileNumbers(1) }),
          plate(2, "Waiting", { platehouse: estimate("current") }),
        ]),
      ]),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await settle();
    expect(modelRequests()).toBe(3);
    const second = text(plateItems()[1]);
    expect(second).not.toMatch(/estimating/i);
    expect(second).toContain(formatDuration(5025));

    // Nothing is estimating now, so nothing more is asked.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(modelRequests()).toBe(3);
  });

  test("a page with nothing estimating never polls", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    await render(pageAt(MODEL_ID));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(modelRequests()).toBe(1);
  });

  test("no request after the page unmounts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    models.set(MODEL_ID, estimatingModel());
    await render(pageAt(MODEL_ID));
    expect(modelRequests()).toBe(1);
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(requests).toEqual([`GET /app/api/models/${MODEL_ID}`]);
  });

  test("navigating to another model stops the first model's polling", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    models.set(MODEL_ID, estimatingModel());
    models.set(OTHER_MODEL_ID, model([STL_FILE], { id: OTHER_MODEL_ID, name: "Other" }));
    await render(pageAt(MODEL_ID));
    await act(async () => {
      go(`/models/${OTHER_MODEL_ID}`);
    });
    await settle();
    expect(text(container.querySelector("h1"))).toBe("Other");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(modelRequests(MODEL_ID)).toBe(1);
    expect(modelRequests(OTHER_MODEL_ID)).toBe(1);
  });

  test("a stale answer for the first model never replaces the model navigated to", async () => {
    let release: (r: Response) => void = () => {};
    const slow = new Promise<Response>((resolve) => {
      release = resolve;
    });
    models.set(OTHER_MODEL_ID, model([STL_FILE], { id: OTHER_MODEL_ID, name: "Other" }));
    const fast = stubServer();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes(MODEL_ID)) return slow;
        return fast(input, init);
      }),
    );
    await render(pageAt(MODEL_ID));
    await act(async () => {
      go(`/models/${OTHER_MODEL_ID}`);
    });
    await settle();
    expect(text(container.querySelector("h1"))).toBe("Other");
    await act(async () => {
      release(json(threePlates()));
    });
    await settle();
    expect(text(container.querySelector("h1"))).toBe("Other");
  });

  test("isEstimating and needsPolling: estimating, or an older estimate shown while the new one runs", () => {
    const STALE = estimate("stale", { staleFor: X1C });
    const FAILED = { estimateId: EST_FAILED, reason: "bed_too_small", words: "x", detail: null };
    expect(isEstimating(plate(1, null, { platehouse: estimate("estimating") }))).toBe(true);
    expect(isEstimating(plate(1, null, { platehouse: STALE }, true))).toBe(true);
    // An older estimate with nothing queued for the selected printer: nothing is coming.
    expect(isEstimating(plate(1, null, { platehouse: STALE }, false))).toBe(false);
    expect(isEstimating(plate(1, null, { platehouse: STALE, failure: FAILED }, false))).toBe(false);
    expect(isEstimating(plate(1, null, { platehouse: estimate("current") }))).toBe(false);
    expect(isEstimating(plate(1, null, { file: fileNumbers(1) }))).toBe(false);
    expect(isEstimating(plate(1, null, {}))).toBe(false);
    expect(needsPolling(threePlates())).toBe(false);
    expect(
      needsPolling(model([threeMf([plate(1, null, { platehouse: estimate("estimating") })])])),
    ).toBe(true);
  });

  test("an older estimate with nothing queued for the selected printer never polls and promises nothing", async () => {
    // The stored printer left the slicer's menu, or the menu could not be
    // read: the older estimate stays shown, but no new one was queued.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    models.set(
      MODEL_ID,
      model([
        threeMf([
          plate(
            1,
            "Base",
            { platehouse: estimate("stale", { printerId: X1C, printerLabel: X1C, staleFor: X1C }) },
            false,
          ),
        ]),
      ]),
    );
    await render(pageAt(MODEL_ID));
    const only = text(plateItems()[0]);
    expect(only).toMatch(/previous printer/i);
    expect(only).not.toMatch(/on its way/i);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(modelRequests()).toBe(1);
  });

  test("an older estimate shown while the new one is queued says it is on its way and polls", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    models.set(
      MODEL_ID,
      model([
        threeMf([
          plate(
            1,
            "Base",
            { platehouse: estimate("stale", { printerId: X1C, printerLabel: X1C, staleFor: X1C }) },
            true,
          ),
        ]),
      ]),
    );
    await render(pageAt(MODEL_ID));
    expect(text(plateItems()[0])).toContain(`A new estimate for ${P1S} is on its way.`);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    await settle();
    expect(modelRequests()).toBe(2);
  });

  test("stale answers with an estimate still pending keep the page polling until the estimate lands", async () => {
    // The server reads a plate's numbers and estimatePending together, so a
    // stale set beside estimatePending true means the new estimate is still
    // coming: every such answer asks again, and only the answer with the
    // finished estimate ends the polling.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const waiting = () =>
      model([
        threeMf([
          plate(
            1,
            "Base",
            { platehouse: estimate("stale", { printerId: X1C, printerLabel: X1C, staleFor: X1C }) },
            true,
          ),
        ]),
      ]);
    models.set(MODEL_ID, waiting());
    await render(pageAt(MODEL_ID));
    for (let poll = 2; poll <= 5; poll += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_MS);
      });
      await settle();
      expect(modelRequests()).toBe(poll);
      expect(text(plateItems()[0])).toMatch(/previous printer/i);
    }

    models.set(
      MODEL_ID,
      model([threeMf([plate(1, "Base", { platehouse: estimate("current") }, false)])]),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    await settle();
    expect(modelRequests()).toBe(6);
    expect(text(plateItems()[0])).not.toMatch(/previous printer/i);
    expect(text(plateItems()[0])).toContain(formatDuration(5025));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(modelRequests()).toBe(6);
  });
});

describe("failed plate shows the plain reason and a retry button", () => {
  const WORDS = "The plate is too big for this printer's bed.";
  const DETAIL = "Orca says: the object exceeds the plate boundary.";

  function failedModel(): ModelView {
    return model([
      threeMf([
        plate(1, "Base", { file: fileNumbers(1) }),
        plate(2, "Huge", {
          failure: {
            estimateId: EST_FAILED,
            reason: "bed_too_small",
            words: WORDS,
            detail: DETAIL,
          },
        }),
        plate(3, "Lid", { file: fileNumbers(3) }),
      ]),
    ]);
  }

  test("the reason in plain words, Orca's detail behind a Details toggle, and siblings keep their numbers", async () => {
    models.set(MODEL_ID, failedModel());
    await render(pageAt(MODEL_ID));
    const [first, failed, third] = plateItems();
    expect(text(failed)).toContain(WORDS);
    expect(text(first)).toContain(formatDuration(1025));
    expect(text(third)).toContain(formatDuration(3025));

    const details = button(/details/i, failed as HTMLElement);
    expect(details.getAttribute("aria-expanded")).toBe("false");
    expect(text(failed)).not.toContain(DETAIL);
    await click(details);
    expect(details.getAttribute("aria-expanded")).toBe("true");
    expect(text(plateItems()[1])).toContain(DETAIL);
  });

  test("Retry posts the estimate to the retry route and reloads the model", async () => {
    models.set(MODEL_ID, failedModel());
    await render(pageAt(MODEL_ID));
    const retry = button(/retry/i, plateItems()[1] as HTMLElement);
    models.set(
      MODEL_ID,
      model([
        threeMf([
          plate(1, "Base", { file: fileNumbers(1) }),
          plate(2, "Huge", { platehouse: estimate("estimating") }),
          plate(3, "Lid", { file: fileNumbers(3) }),
        ]),
      ]),
    );
    await click(retry);
    expect(requests).toEqual([
      `GET /app/api/models/${MODEL_ID}`,
      `POST /app/api/estimates/${EST_FAILED}/retry`,
      `GET /app/api/models/${MODEL_ID}`,
    ]);
    expect(text(plateItems()[1])).toMatch(/estimating/i);
  });

  test("a retry the server refuses says so beside the plate, with no browser dialog", async () => {
    const alertSpy = vi.fn();
    vi.stubGlobal("alert", alertSpy);
    retryStatus = 409;
    models.set(MODEL_ID, failedModel());
    await render(pageAt(MODEL_ID));
    await click(button(/retry/i, plateItems()[1] as HTMLElement));
    expect(text(plateItems()[1]?.querySelector('[role="alert"]'))).toMatch(/could not be retried/i);
    expect(alertSpy).not.toHaveBeenCalled();
  });
});

describe("open in a slicer (AC-040)", () => {
  const TOKEN = "AZjwxAAAcACAAAAAAACwAWX3Q9AAAAAAAAAAAAAAAAAAAAAA";

  /** The link and protocol URLs as Task 17's mint route answers them (Slicer link contract). */
  function minted(name: string): SlicerLink {
    const segment = encodeURIComponent(name.replace(/[/\\%?#;\p{Cc}\p{Cf}]/gu, "_"));
    const url = `https://platehouse.test/s/${TOKEN}/${segment}`;
    const enc = encodeURIComponent(url);
    return {
      url,
      expiresAt: "2026-11-13T10:10:00.000Z",
      open: {
        orca: `orcaslicer://open?file=${enc}`,
        bambuMac: `bambustudioopen://${enc}`,
        bambuOther: `bambustudio://open?file=${enc}`,
      },
    };
  }

  function hostileModel(): ModelView {
    return model([threeMf([plate(1, "Base", { file: fileNumbers(1) })], { name: HOSTILE_NAME })], {
      name: HOSTILE_NAME.replace(/\.3mf$/, ""),
    });
  }

  test("every .3mf has Open in Bambu Studio and Open in OrcaSlicer, with the line about Bambu Studio's prompt shown before any click", async () => {
    models.set(MODEL_ID, hostileModel());
    await render(pageAt(MODEL_ID));
    expect(BAMBU_PROMPT_LINE).toMatch(/not from a trusted site/);
    const plates = panel();
    expect(text(plates)).toContain(BAMBU_PROMPT_LINE);
    button(/open in bambu studio/i, plates);
    button(/open in orcaslicer/i, plates);
    await click(tab("Files"));
    expect(text(panel())).toContain(BAMBU_PROMPT_LINE);
    button(/open in bambu studio/i, panel());
    button(/open in orcaslicer/i, panel());
    expect(navigations).toEqual([]);
  });

  test("open in OrcaSlicer builds orcaslicer://open?file=<encoded link>", async () => {
    const link = minted(HOSTILE_NAME);
    mintAnswer = (fileId) => (fileId === FILE_3MF ? json(link) : json({ error: "x" }, 404));
    models.set(MODEL_ID, hostileModel());
    await render(pageAt(MODEL_ID));
    await click(button(/open in orcaslicer/i, panel()));

    expect(requests).toContain(`POST /app/api/files/${FILE_3MF}/slicer-link`);
    expect(navigations).toHaveLength(1);
    const target = navigations[0] as string;
    const prefix = "orcaslicer://open?file=";
    expect(target).toBe(`${prefix}${encodeURIComponent(link.url)}`);
    // Encoded exactly once: one decode gives the link back, whole.
    expect(decodeURIComponent(target.slice(prefix.length))).toBe(link.url);
    // The link's last segment is the file's name, its slash replaced.
    const segment = link.url.slice(link.url.lastIndexOf("/") + 1);
    expect(decodeURIComponent(segment)).toBe(HOSTILE_NAME.replace("/", "_"));
    expect(link.url).not.toContain("?");
  });

  test("open in Bambu Studio on macOS builds bambustudioopen://<encoded link>", async () => {
    const link = minted(HOSTILE_NAME);
    mintAnswer = () => json(link);
    models.set(MODEL_ID, hostileModel());
    await render(pageAt(MODEL_ID, { platform: "mac" }));
    await click(button(/open in bambu studio/i, panel()));
    const target = navigations[0] as string;
    const prefix = "bambustudioopen://";
    expect(target).toBe(`${prefix}${encodeURIComponent(link.url)}`);
    expect(decodeURIComponent(target.slice(prefix.length))).toBe(link.url);
  });

  test("open in Bambu Studio elsewhere builds bambustudio://open?file=<encoded link>", async () => {
    const link = minted(HOSTILE_NAME);
    mintAnswer = () => json(link);
    models.set(MODEL_ID, hostileModel());
    await render(pageAt(MODEL_ID, { platform: "other" }));
    await click(button(/open in bambu studio/i, panel()));
    expect(navigations).toEqual([`bambustudio://open?file=${encodeURIComponent(link.url)}`]);
  });

  test("a link that cannot be made says so in the page and navigates nowhere", async () => {
    const alertSpy = vi.fn();
    vi.stubGlobal("alert", alertSpy);
    mintAnswer = () => json({ error: "internal" }, 500);
    await render(pageAt(MODEL_ID));
    await click(button(/open in orcaslicer/i, panel()));
    expect(navigations).toEqual([]);
    expect(text(panel().querySelector('[role="alert"]'))).toMatch(/could not be made/i);
    expect(alertSpy).not.toHaveBeenCalled();
  });
});

describe(".3mf shows no 3D view", () => {
  test("a .3mf shows its plate thumbnail large with a strip of 72 px plates, and three.js is never loaded", async () => {
    await render(pageAt(MODEL_ID));
    expect(loadThree).not.toHaveBeenCalled();
    expect(container.querySelector("canvas")).toBeNull();
    expect(container.querySelector("[data-viewer3d]")).toBeNull();
    const large = container.querySelector<HTMLImageElement>(
      ".studio-viewer img.studio-plate-large",
    );
    expect(large?.getAttribute("src")).toBe(thumb(1));

    const strip = [...container.querySelectorAll<HTMLButtonElement>(".studio-plate-strip button")];
    expect(strip).toHaveLength(3);
    expect(strip[0]?.getAttribute("aria-pressed")).toBe("true");
    await click(strip[2]);
    expect(
      container.querySelector(".studio-viewer img.studio-plate-large")?.getAttribute("src"),
    ).toBe(thumb(3));
    expect(strip[2]?.getAttribute("aria-pressed")).toBe("true");
    expect(loadThree).not.toHaveBeenCalled();
  });

  test("an STL file shows in the 3D viewer, three.js loaded for it alone", async () => {
    models.set(MODEL_ID, model([STL_FILE]));
    await render(pageAt(MODEL_ID));
    expect(loadThree).toHaveBeenCalledTimes(1);
    expect(loads).toEqual([{ kind: "stl", url: STL_FILE.view?.url }]);
    expect(container.querySelector(".studio-viewer [data-viewer3d]")).not.toBeNull();
  });

  test("a STEP file shows its GLB mesh in the 3D viewer", async () => {
    models.set(MODEL_ID, model([STEP_FILE]));
    await render(pageAt(MODEL_ID));
    expect(loads).toEqual([{ kind: "glb", url: STEP_FILE.view?.url }]);
  });

  test("a model with a .3mf and an STL starts on the plates, and View in the Files tab moves the viewer to the STL", async () => {
    models.set(MODEL_ID, model([threeMf([plate(1, "Base", { file: fileNumbers(1) })]), STL_FILE]));
    await render(pageAt(MODEL_ID));
    expect(loadThree).not.toHaveBeenCalled();
    await click(tab("Files"));
    const stlRow = [...panel().querySelectorAll("li")].find((li) =>
      text(li).includes("Bracket.stl"),
    );
    await click(button(/^view/i, stlRow as HTMLElement));
    expect(loads).toEqual([{ kind: "stl", url: STL_FILE.view?.url }]);
    expect(container.querySelector(".studio-viewer img.studio-plate-large")).toBeNull();
  });

  test("the 3D view has buttons to rotate, zoom and reset, so it works by keyboard", async () => {
    const calls: string[] = [];
    const recording: ThreeLoader = async () => ({
      async show() {
        return {
          rotate: (d: number) => calls.push(`rotate ${d > 0 ? "right" : "left"}`),
          zoom: (f: number) => calls.push(`zoom ${f < 1 ? "in" : "out"}`),
          reset: () => calls.push("reset"),
          dispose: () => calls.push("dispose"),
        };
      },
    });
    models.set(MODEL_ID, model([STL_FILE]));
    await render(pageAt(MODEL_ID, { loadThree: recording }));
    await click(button(/rotate left/i));
    await click(button(/rotate right/i));
    await click(button(/zoom in/i));
    await click(button(/zoom out/i));
    await click(button(/reset view/i));
    expect(calls).toEqual(["rotate left", "rotate right", "zoom in", "zoom out", "reset"]);
    await act(async () => root.unmount());
    root = createRoot(container);
    expect(calls).toContain("dispose");
  });

  test("a 3D view that cannot start says so and offers the download", async () => {
    const failing: ThreeLoader = async () => {
      throw new Error("no WebGL");
    };
    models.set(MODEL_ID, model([STL_FILE]));
    await render(pageAt(MODEL_ID, { loadThree: failing }));
    expect(text(container.querySelector(".studio-viewer"))).toMatch(/3D view could not be shown/i);
    expect(
      container.querySelector(`.studio-viewer a[href="/files/${FILE_STL}/download"]`),
    ).not.toBeNull();
  });
});

describe("the About tab", () => {
  test("renders the description through renderMarkdown: Markdown becomes elements, raw HTML and scripts do not", async () => {
    const description =
      "Some **bold** text.\n\n<script>alert(1)</script> <img src=x onerror=alert(1)>";
    await render(
      <MemoryRouter>
        <AboutTab model={model([], { description })} />
      </MemoryRouter>,
    );
    await until(".studio-prose");
    const prose = container.querySelector(".studio-prose");
    expect(prose?.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
  });

  test("shows the licence note next to the licence, the creator, caption, tags and collections", async () => {
    await render(
      <MemoryRouter>
        <AboutTab
          model={model([], {
            license: null,
            licenseNote: "License on MakerWorld: Standard Digital File License",
            description: "Already set by Jon.",
          })}
        />
      </MemoryRouter>,
    );
    await until(".studio-prose");
    const licence = [...container.querySelectorAll("dt")].find((dt) =>
      /licen[cs]e/i.test(text(dt)),
    );
    expect(licence, "no licence row").toBeDefined();
    expect(text(licence?.nextElementSibling)).toContain("Standard Digital File License");
    expect(text(container)).toContain("Maker One");
    expect(text(container)).toContain("Three cubes for testing");
    expect(text(container)).toContain("Gridfinity");
    expect(text(container)).toContain("Desk");
    expect(text(container)).toContain("Already set by Jon.");
  });

  test("a licence and its note show together", async () => {
    await render(
      <MemoryRouter>
        <AboutTab
          model={model([], { license: "CC-BY-4.0", licenseNote: "Attribution required" })}
        />
      </MemoryRouter>,
    );
    const licence = [...container.querySelectorAll("dt")].find((dt) =>
      /licen[cs]e/i.test(text(dt)),
    );
    const value = text(licence?.nextElementSibling);
    expect(value).toContain("CC-BY-4.0");
    expect(value).toContain("Attribution required");
  });
});

describe("the page CSS", () => {
  test("uses only studio.css tokens: no colour of its own, ASCII only", () => {
    // jsdom replaces URL, so the paths go to node:fs as plain strings.
    const read = (rel: string) =>
      readFileSync(fileURLToPath(new URL(rel, import.meta.url).href), "utf8");
    const studio = read("../src/styles/studio.css");
    const page = read("../src/model/model.css");
    const tokens = new Set([...studio.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const used = [...page.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) expect(tokens.has(name), name).toBe(true);
    // No custom property of its own, and no colour literal.
    expect(page).not.toMatch(/^\s*--[a-z0-9-]+\s*:/m);
    expect(page).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(page).not.toMatch(/\b(rgb|rgba|hsl|hsla|oklch|color-mix)\(/i);
    expect([...page].findIndex((c) => c.charCodeAt(0) > 0x7f)).toBe(-1);
  });

  test("with the page's stylesheets loaded, only the chosen tab panel is drawn", async () => {
    // studio.css gives .studio-panel display: grid, and any author rule beats
    // the browser's own [hidden] { display: none }, so the hidden panels need
    // a rule of their own. jsdom applies loaded style sheets to
    // getComputedStyle, so this reads the display a browser would use.
    const read = (rel: string) =>
      readFileSync(fileURLToPath(new URL(rel, import.meta.url).href), "utf8");
    const sheets = ["../src/styles/studio.css", "../src/model/model.css"].map((rel) => {
      const style = document.createElement("style");
      style.textContent = read(rel);
      document.head.append(style);
      return style;
    });
    try {
      await render(pageAt(MODEL_ID));
      const displays = () =>
        [...container.querySelectorAll<HTMLElement>('[role="tabpanel"]')].map(
          (p) => getComputedStyle(p).display,
        );
      expect(displays()).toEqual(["grid", "none", "none"]);
      await click(tab("Files"));
      expect(displays()).toEqual(["none", "grid", "none"]);
    } finally {
      for (const style of sheets) style.remove();
    }
  });
});

describe("dropping files on the model page", () => {
  function fileDrop(files: File[]): Event {
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { types: ["Files"], files } });
    return drop;
  }

  test("hands the files and this model's id to onFiles, which opens the upload dialog", async () => {
    const onFiles = vi.fn();
    await render(pageAt(MODEL_ID, { onFiles }));
    const zone = container.querySelector("[data-dropzone]");
    expect(zone, "the model page is not a drop zone").not.toBeNull();
    const file = new File(["x"], "extra.stl");
    await act(async () => {
      zone?.dispatchEvent(fileDrop([file]));
    });
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles).toHaveBeenCalledWith([file], MODEL_ID);
  });

  test("Add files, a button on the page, hands no files and this model's id to onFiles, so its dialog opens from the keyboard too", async () => {
    const onFiles = vi.fn();
    await render(pageAt(MODEL_ID, { onFiles }));
    const add = button(/^add files$/i);
    expect(add.type).toBe("button");
    expect(add.disabled).toBe(false);
    await click(add);
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles).toHaveBeenCalledWith([], MODEL_ID);
  });

  test("the dialog for this model hides the Combine switch and uploads into the model", async () => {
    const started: Array<{ file: File; target: UploadTarget }> = [];
    const start: StartUpload = (file, target) => {
      started.push({ file, target });
      return { abort: () => {} };
    };
    const file = new File([new Uint8Array(10)], "extra.stl");
    await render(
      <UploadDialog
        open
        files={[file]}
        modelId={MODEL_ID}
        onClose={() => {}}
        start={start}
        fetchResult={async () => ({ status: "done", modelId: MODEL_ID, fileId: "f-1" })}
      />,
    );
    expect(container.querySelector('input[role="switch"]')).toBeNull();
    expect(text(container)).not.toMatch(/combine/i);
    await click(button(/^upload/i));
    expect(started.map((s) => s.target)).toEqual([{ kind: "model", modelId: MODEL_ID }]);
  });

  test("a finished upload into the model reloads the page (refreshKey)", async () => {
    await render(pageAt(MODEL_ID, { refreshKey: 0 }));
    expect(requests).toEqual([`GET /app/api/models/${MODEL_ID}`]);
    await render(pageAt(MODEL_ID, { refreshKey: 1 }));
    expect(requests).toEqual([
      `GET /app/api/models/${MODEL_ID}`,
      `GET /app/api/models/${MODEL_ID}`,
    ]);
  });

  test("the first upload into a model with no files shows that file in the viewer", async () => {
    models.set(MODEL_ID, model([]));
    await render(pageAt(MODEL_ID, { refreshKey: 0 }));
    const viewer = () => container.querySelector('[aria-label="Viewer"]');
    expect(text(viewer())).toContain("This model has no files.");
    models.set(MODEL_ID, model([STL_FILE]));
    await render(pageAt(MODEL_ID, { refreshKey: 1 }));
    expect(text(viewer())).not.toContain("This model has no files.");
    expect(loads).toEqual([STL_FILE.view]);
  });
});

describe("a reload that fails while the model is on screen", () => {
  function modelRequests(): number {
    return requests.filter((r) => r === `GET /app/api/models/${MODEL_ID}`).length;
  }

  function estimatingModel(): ModelView {
    return model([threeMf([plate(1, "Waiting", { platehouse: estimate("estimating") })])]);
  }

  function failedModel(): ModelView {
    return model([
      threeMf([
        plate(1, "Huge", {
          failure: { estimateId: EST_FAILED, reason: "bed_too_small", words: "x", detail: null },
        }),
      ]),
    ]);
  }

  test("a failed poll while a plate is estimating is asked again in 5 s, says it could not refresh, and clears that when a poll succeeds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    models.set(MODEL_ID, estimatingModel());
    await render(pageAt(MODEL_ID));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    models.set(MODEL_ID, 503);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await settle();
    expect(modelRequests()).toBe(2);
    expect(text(container.querySelector('[role="alert"]'))).toMatch(/could not be refreshed/i);
    models.set(MODEL_ID, estimatingModel());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await settle();
    expect(modelRequests()).toBe(3);
    expect(text(container.querySelector("h1"))).toBe("Cube set");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  test("polls that keep failing while a plate is estimating keep being asked, and the notice stays", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    models.set(MODEL_ID, estimatingModel());
    await render(pageAt(MODEL_ID));
    models.set(MODEL_ID, 500);
    for (let n = 2; n <= 4; n++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      await settle();
      expect(modelRequests()).toBe(n);
      expect(text(container.querySelector('[role="alert"]'))).toMatch(/could not be refreshed/i);
    }
    expect(text(container.querySelector("h1"))).toBe("Cube set");
  });

  test("a failed reload with nothing estimating is not asked again, and says so with Try again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    models.set(MODEL_ID, failedModel());
    await render(pageAt(MODEL_ID));
    retryStatus = 202;
    models.set(MODEL_ID, 500);
    await click(button(/retry/i, plateItems()[0] as HTMLElement));
    expect(modelRequests()).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(modelRequests()).toBe(2);
    expect(text(container.querySelector("h1"))).toBe("Cube set");
    const notice = container.querySelector('[role="alert"]');
    expect(text(notice)).toMatch(/could not be refreshed/i);
    models.set(MODEL_ID, estimatingModel());
    await click(button(/try again/i, notice as HTMLElement));
    expect(modelRequests()).toBe(3);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  test("a 401 ends the polling and asks the user to sign in again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    models.set(MODEL_ID, estimatingModel());
    await render(pageAt(MODEL_ID));
    models.set(MODEL_ID, 401);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    await settle();
    expect(modelRequests()).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(modelRequests()).toBe(2);
    expect(text(container.querySelector('[role="alert"]'))).toMatch(/signed out.*sign in again/i);
  });
});

describe("a STEP or SCAD render that lands while the page is open", () => {
  const MESH = { kind: "glb" as const, url: "/blobs/0198f0c4-0000-7000-8000-0000000000f2" };
  const OPENSCAD_SAYS = "ERROR: Parser error in file Knob.scad, line 3: syntax error";

  /** A STEP file just uploaded: its mesh is still being made. */
  const PENDING_STEP: ModelFile = { ...STEP_FILE, derivedStatus: "pending", view: null };
  /** The same file once its mesh is stored. */
  const MESHED_STEP: ModelFile = { ...STEP_FILE, derivedStatus: "ok", view: MESH };

  const PENDING_SCAD: ModelFile = {
    id: FILE_SCAD,
    name: "Knob.scad",
    kind: "scad",
    size: 312,
    parseStatus: "ok",
    derivedStatus: "pending",
    derivedMessage: null,
    download: `/files/${FILE_SCAD}/download`,
    view: null,
    preview: null,
    filaments: [],
    plates: [],
  };
  const FAILED_SCAD: ModelFile = {
    ...PENDING_SCAD,
    derivedStatus: "failed",
    derivedMessage: OPENSCAD_SAYS,
  };

  function modelRequests(): number {
    return requests.filter((r) => r === `GET /app/api/models/${MODEL_ID}`).length;
  }

  const viewer = () => container.querySelector('[aria-label="Viewer"]');

  function fileRow(name: string): HTMLElement {
    const row = [...container.querySelectorAll<HTMLElement>('[role="tabpanel"] li')].find((li) =>
      text(li).includes(name),
    );
    if (row === undefined) throw new Error(`no Files tab row for ${name}`);
    return row;
  }

  function hasView(name: string): boolean {
    return [...fileRow(name).querySelectorAll("button")].some((b) => /^view/i.test(text(b)));
  }

  async function poll() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    await settle();
  }

  test("a dropped STEP file says there is no view yet, then shows its mesh when a later poll has it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    models.set(MODEL_ID, model([]));
    await render(pageAt(MODEL_ID, { refreshKey: 0 }));
    // The upload finishes: the page loads again while the mesh is being made.
    models.set(MODEL_ID, model([PENDING_STEP]));
    await render(pageAt(MODEL_ID, { refreshKey: 1 }));
    expect(modelRequests()).toBe(2);
    expect(text(viewer())).toContain("No view of Housing.step yet.");
    expect(hasView("Housing.step")).toBe(false);
    expect(loads).toEqual([]);

    // Still being made at the next poll.
    await poll();
    expect(modelRequests()).toBe(3);
    expect(text(viewer())).toContain("No view of Housing.step yet.");

    // The mesh lands: the next poll shows it, with no reload.
    models.set(MODEL_ID, model([MESHED_STEP]));
    await poll();
    expect(modelRequests()).toBe(4);
    expect(loads).toEqual([MESH]);
    expect(container.querySelector(".studio-viewer [data-viewer3d]")).not.toBeNull();
    expect(text(viewer())).not.toContain("No view of");
    expect(hasView("Housing.step")).toBe(true);
  });

  test("polling stops once nothing is being rendered or estimating", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    models.set(MODEL_ID, model([PENDING_STEP]));
    await render(pageAt(MODEL_ID));
    expect(modelRequests()).toBe(1);
    models.set(MODEL_ID, model([MESHED_STEP]));
    await poll();
    expect(modelRequests()).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(modelRequests()).toBe(2);
  });

  test("a render and an estimate in flight together share one timer: one request every 5 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const estimating = threeMf([plate(1, "Waiting", { platehouse: estimate("estimating") })]);
    models.set(MODEL_ID, model([estimating, PENDING_STEP]));
    await render(pageAt(MODEL_ID));
    for (let n = 2; n <= 4; n++) {
      await poll();
      expect(modelRequests()).toBe(n);
    }
  });

  test("a failed render shows its reason in plain words and stops the polling", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    models.set(MODEL_ID, model([PENDING_SCAD]));
    await render(pageAt(MODEL_ID));
    expect(text(viewer())).toContain("No view of Knob.scad yet.");
    expect(text(fileRow("Knob.scad"))).toMatch(/still being rendered/i);

    models.set(MODEL_ID, model([FAILED_SCAD]));
    await poll();
    expect(modelRequests()).toBe(2);
    expect(text(viewer())).toContain("Knob.scad could not be rendered.");
    expect(text(viewer())).toContain(OPENSCAD_SAYS);
    expect(text(fileRow("Knob.scad"))).toMatch(/could not be rendered/i);
    expect(text(fileRow("Knob.scad"))).toContain(OPENSCAD_SAYS);
    expect(text(fileRow("Knob.scad"))).not.toMatch(/still being rendered/i);
    expect(hasView("Knob.scad")).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(modelRequests()).toBe(2);
  });

  test("no request after the page unmounts while a render is pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    models.set(MODEL_ID, model([PENDING_STEP]));
    await render(pageAt(MODEL_ID));
    expect(modelRequests()).toBe(1);
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(requests).toEqual([`GET /app/api/models/${MODEL_ID}`]);
  });

  test("a STEP render polled on one model stops when the page moves to another", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    models.set(MODEL_ID, model([PENDING_STEP]));
    models.set(OTHER_MODEL_ID, model([STL_FILE], { id: OTHER_MODEL_ID, name: "Other" }));
    await render(pageAt(MODEL_ID));
    await act(async () => {
      go(`/models/${OTHER_MODEL_ID}`);
    });
    await settle();
    expect(text(container.querySelector("h1"))).toBe("Other");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(modelRequests()).toBe(1);
  });

  test("isDeriving and needsPolling: a render or mesh still pending polls; done, failed or none does not", () => {
    expect(isDeriving(PENDING_STEP)).toBe(true);
    expect(isDeriving(PENDING_SCAD)).toBe(true);
    expect(isDeriving(MESHED_STEP)).toBe(false);
    expect(isDeriving(FAILED_SCAD)).toBe(false);
    expect(isDeriving(STL_FILE)).toBe(false);
    expect(needsPolling(model([PENDING_STEP]))).toBe(true);
    expect(needsPolling(model([STL_FILE, PENDING_SCAD]))).toBe(true);
    expect(needsPolling(model([MESHED_STEP, FAILED_SCAD, STL_FILE]))).toBe(false);
  });
});

describe("the app's upload dialog keeps each file's target from when it was added", () => {
  function fileDrop(files: File[]): Event {
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { types: ["Files"], files } });
    return drop;
  }

  function stl(name: string): File {
    return new File([new Uint8Array(10)], name);
  }

  function dialog(): HTMLElement {
    const open = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
    expect(open).toHaveLength(1);
    return open[0] as HTMLElement;
  }

  /** The file names listed in the open dialog. */
  function listed(): string[] {
    return [...dialog().querySelectorAll<HTMLElement>("[data-upload]")].map(
      (row) => row.dataset.upload ?? "",
    );
  }

  async function dropOn(el: Element | null, files: File[]) {
    if (el === null) throw new Error("nothing to drop on");
    await act(async () => {
      el.dispatchEvent(fileDrop(files));
    });
    await settle();
  }

  function sent(): Array<[string, string]> {
    return recorded.uploads.map(({ name, metadata }) => [name, metadata.modelId ?? "new"]);
  }

  test("files left unsent for a model never go to new models, and new-model files never join the model", async () => {
    models.set(MODEL_ID, model([STL_FILE]));
    recorded.uploads.length = 0;
    window.history.pushState({}, "", `/models/${MODEL_ID}`);
    const appRoot = document.createElement("div");
    appRoot.id = "root";
    document.body.append(appRoot);
    const rootsBefore = recorded.roots.length;
    try {
      await act(async () => {
        await import("../src/main");
      });
      await settle();
      const page = () => appRoot.querySelector("[data-dropzone]");
      const backdrop = () => document.querySelector(".ph-dialog-backdrop");

      // On the model page: a.stl goes in and is still sending; b.stl is
      // added to the dialog and left unsent; the dialog is hidden.
      await dropOn(page(), [stl("a.stl")]);
      expect(text(dialog())).toContain("The files are added to this model.");
      await click(button(/^upload/i, dialog()));
      await dropOn(backdrop(), [stl("b.stl")]);
      expect(listed()).toEqual(["a.stl", "b.stl"]);
      await click(button(/^hide$/i, dialog()));

      // Add opens the dialog for new models: b.stl is not in it, and
      // Upload sends only the file added there, as a new model. e.stl is
      // then added and left unsent.
      await click(button(/^\+?\s*add$/i, appRoot));
      expect(text(dialog())).toContain("Each file becomes its own model");
      expect(listed()).toEqual([]);
      await dropOn(backdrop(), [stl("c.stl")]);
      await click(button(/^upload/i, dialog()));
      expect(sent()).toEqual([
        ["a.stl", MODEL_ID],
        ["c.stl", "new"],
      ]);
      await dropOn(backdrop(), [stl("e.stl")]);
      await click(button(/^hide$/i, dialog()));

      // Back on the model page: its dialog still has b.stl and not e.stl,
      // and Upload sends b.stl and the new d.stl into the model.
      await dropOn(page(), [stl("d.stl")]);
      expect(text(dialog())).toContain("The files are added to this model.");
      expect(listed()).toEqual(["a.stl", "b.stl", "d.stl"]);
      await click(button(/^upload/i, dialog()));
      expect(sent()).toEqual([
        ["a.stl", MODEL_ID],
        ["c.stl", "new"],
        ["b.stl", MODEL_ID],
        ["d.stl", MODEL_ID],
      ]);

      // The model's uploads fail while its dialog is hidden. Add files on
      // the model page, with nothing dropped, opens that model's dialog
      // again, where the failed rows and their reason are; the top bar's
      // Add still opens the dialog for new models, without them.
      await click(button(/^hide$/i, dialog()));
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      await act(async () => {
        for (const upload of recorded.uploads) {
          if (upload.metadata.modelId === MODEL_ID) upload.fail(new Error("the server went away"));
        }
      });
      await settle();
      await click(button(/^add files$/i, appRoot));
      expect(text(dialog())).toContain("The files are added to this model.");
      expect(listed()).toEqual(["a.stl", "b.stl", "d.stl"]);
      expect(text(dialog())).toContain("The upload failed: the server went away.");
      await click(button(/^hide$|^close$/i, dialog()));
      await click(button(/^\+?\s*add$/i, appRoot));
      expect(text(dialog())).toContain("Each file becomes its own model");
      expect(listed()).toEqual(["c.stl", "e.stl"]);
    } finally {
      const appReact = recorded.roots[rootsBefore];
      await act(async () => appReact?.unmount());
      appRoot.remove();
      window.history.pushState({}, "", "/");
    }
  });
});
