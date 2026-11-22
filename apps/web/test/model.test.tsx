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
// - a .3mf shows its plate pictures, and a plate's 3D view only once it is
//   opened (issue #358: Show in 3D or a click on the picture, a mesh the
//   server makes for that plate alone, closed again with Show picture; a
//   plate with no 3D view keeps its picture and says why)
// - the large plate image turns and flips on screen only (requested
//   2026-11-19): each button applies its transform, Reset clears it, and
//   another plate, another file or opening the model again clears it, with
//   nothing sent to the server and nothing stored in the browser
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
import {
  MeshLoadError,
  ThreeLoadError,
  type ThreeLoader,
  type ThreeSource,
} from "../src/model/Viewer3d";
import { PRINTER_CHOICE_KEY } from "../src/settings/PrinterSwitch";
import { UploadDialog } from "../src/upload/UploadDialog";
import type { StartUpload, UploadTarget } from "../src/upload/useTusUpload";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * For the app tests at the end, which load main.tsx itself: every React root
 * made, so a test can unmount the app's; what main.tsx rendered into #root,
 * so a later test can mount a fresh app (the module renders only when it is
 * first imported); and every tus upload started, with its metadata (the
 * target). The stand-in Upload sends nothing; no other test here starts a
 * real tus upload.
 */
const recorded = vi.hoisted(() => ({
  roots: [] as Array<{ unmount(): void }>,
  app: null as unknown,
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
      if ((args[0] as Element).id === "root") {
        const render = made.render.bind(made);
        made.render = (node) => {
          recorded.app = node;
          render(node);
        };
      }
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
/** Each printer in full, as the server names it. */
const P1S_NAME = "Bambu Lab P1S, 0.4 mm nozzle";
const X1C_NAME = "Bambu Lab X1 Carbon, 0.4 mm nozzle";

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
    printerName: P1S_NAME,
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
    printerName: P1S_NAME,
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
    printerName: P1S_NAME,
    printers: [{ id: P1S, name: P1S_NAME }],
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
/** While set, GET /app/api/models/:id waits for it before it answers. */
let modelHeld: Promise<void> | null;
/** What GET /app/api/plates/:id/mesh answers (issue #358). */
let meshAnswer: (plateId: string) => Response;
/** While set, GET /app/api/plates/:id/mesh waits for it before it answers. */
let meshHeld: Promise<void> | null;
/** The GLB address the stub server gives a plate. */
const meshUrl = (plateId: string) => `/blobs/mesh-${plateId}`;
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
      if (modelHeld !== null) await modelHeld;
      const answer = models.get(modelMatch[1] ?? "");
      if (answer === undefined) return json({ error: "not_found" }, 404);
      if (typeof answer === "number") return json({ error: "x" }, answer);
      return json(answer);
    }
    const meshMatch = /^\/app\/api\/plates\/([^/]+)\/mesh$/.exec(url.pathname);
    if (method === "GET" && meshMatch) {
      if (meshHeld !== null) await meshHeld;
      return meshAnswer(meshMatch[1] ?? "");
    }
    const mintMatch = /^\/app\/api\/files\/([^/]+)\/slicer-link$/.exec(url.pathname);
    if (method === "POST" && mintMatch) return mintAnswer(mintMatch[1] ?? "");
    if (method === "POST" && /^\/app\/api\/estimates\/[^/]+\/retry$/.test(url.pathname)) {
      if (retryStatus === 202) return json({ queued: true }, 202);
      // The route's own refusal (apps/server/src/app-api/model.ts); any
      // other status is a session that ended or a server that is down.
      return retryStatus === 409
        ? json({ error: "not_retryable" }, 409)
        : json({ error: "unavailable" }, retryStatus);
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

/** A plate's name heading, at whatever level the page outline gives it. */
function plateTitle(li: Element): Element | null {
  return li.querySelector(".ph-plate-title");
}

/** Every heading a person can reach, in order, as [level, text]; hidden tab panels left out. */
function outline(): Array<[number, string]> {
  return [...container.querySelectorAll("h1, h2, h3, h4, h5, h6")]
    .filter((h) => h.closest("[hidden]") === null)
    .map((h) => [Number(h.tagName.slice(1)), text(h)]);
}

/** Each heading is at most one level below the one before it, starting from the h1. */
function expectNoSkippedLevel(found: Array<[number, string]>) {
  expect(found[0]?.[0], "the outline does not start at the h1").toBe(1);
  for (let i = 1; i < found.length; i++) {
    const [level, name] = found[i] as [number, string];
    const before = (found[i - 1] as [number, string])[0];
    expect(level, `"${name}" (h${level}) skips a level after an h${before}`).toBeLessThanOrEqual(
      before + 1,
    );
  }
}

beforeEach(() => {
  requests = [];
  navigations = [];
  loads = [];
  retryStatus = 202;
  modelHeld = null;
  meshHeld = null;
  meshAnswer = (plateId) => json({ url: meshUrl(plateId) });
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
  localStorage.removeItem(PRINTER_CHOICE_KEY);
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

  test("a first load answered 401 says the user is signed out, with no Try again", async () => {
    // The session ended while the app was open, then a library card was clicked.
    models.set(MODEL_ID, 401);
    await render(pageAt(MODEL_ID));
    expect(text(container.querySelector('[role="alert"]'))).toBe(
      "You are signed out. Reload the page to sign in again.",
    );
    expect(() => button(/try again/i)).toThrow();
  });
});

describe("plates tab lists every plate in order with name or Plate N, swatches, grams, time and weight", () => {
  test("each plate in plate order, with its thumbnail, name or Plate N, filaments, time and weight", async () => {
    await render(pageAt(MODEL_ID));
    const items = plateItems();
    expect(items).toHaveLength(3);
    expect(items.map((li) => text(plateTitle(li)))).toEqual(["Base", "Plate 2", "Lid"]);
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
    expect(plateItems().map((li) => text(plateTitle(li)))).toEqual(["Only", "One", "Two"]);
  });

  test("a .3mf with no plate data says so in plain words", async () => {
    models.set(MODEL_ID, model([threeMf([], { parseStatus: "no_plate_data" })]));
    await render(pageAt(MODEL_ID));
    expect(text(panel())).toContain("No Bambu plate data in this file");
  });
});

// Issue #206: with one .3mf the page went from the h1 straight to the plate
// h3s, because the file's h2 shows only when there are several files, so
// axe's heading-order rule failed. The outline now follows the structure:
// with one file the plates are the panel's top headings (h2); with several,
// each file is an h2 and its plates h3. The Files tab's file names are h2.
describe("the heading outline never skips a level (issue #206)", () => {
  test("with one .3mf, the plate names are h2 under the model's h1", async () => {
    await render(pageAt(MODEL_ID));
    expect(outline()).toEqual([
      [1, "Cube set"],
      [2, "Base"],
      [2, "Plate 2"],
      [2, "Lid"],
    ]);
    expectNoSkippedLevel(outline());
  });

  test("with two .3mf files, each file name is an h2 and its plate names h3", async () => {
    const second = threeMf([plate(1, "One", { file: fileNumbers(1) })], {
      id: "0198f0c4-0000-7000-8000-00000000b009",
      name: "Second.3mf",
    });
    models.set(MODEL_ID, model([threeMf([plate(1, "Only", { file: fileNumbers(1) })]), second]));
    await render(pageAt(MODEL_ID));
    expect(outline()).toEqual([
      [1, "Cube set"],
      [2, "Cube set.3mf"],
      [3, "Only"],
      [2, "Second.3mf"],
      [3, "One"],
    ]);
    expectNoSkippedLevel(outline());
  });

  test("on the Files tab, each file name is an h2 under the model's h1", async () => {
    models.set(MODEL_ID, model([threeMf([plate(1, "Only", { file: fileNumbers(1) })]), STL_FILE]));
    await render(pageAt(MODEL_ID));
    await click(tab("Files"));
    expect(outline()).toEqual([
      [1, "Cube set"],
      [2, "Cube set.3mf"],
      [2, "Bracket.stl"],
    ]);
    expectNoSkippedLevel(outline());
  });

  test("a model with no .3mf opens on the Files tab with its file names as h2", async () => {
    models.set(MODEL_ID, model([STL_FILE, STEP_FILE]));
    await render(pageAt(MODEL_ID));
    expect(outline()).toEqual([
      [1, "Cube set"],
      [2, "Bracket.stl"],
      [2, "Housing.step"],
    ]);
    expectNoSkippedLevel(outline());
  });

  test("the level change does not change the look: plate and file names keep their size and weight", async () => {
    // Before the fix the plate names and the Files tab's file names were h3
    // (the browser's bold) and the Plates tab's file names h2 (studio.css's
    // 600), all at 1rem, which jsdom reports as 15px (studio.css sets the
    // html font size to 15px). jsdom applies loaded style sheets to
    // getComputedStyle, so this reads what a browser would draw.
    const read = (rel: string) =>
      readFileSync(fileURLToPath(new URL(rel, import.meta.url).href), "utf8");
    const sheets = ["../src/styles/studio.css", "../src/model/model.css"].map((rel) => {
      const style = document.createElement("style");
      style.textContent = read(rel);
      document.head.append(style);
      return style;
    });
    const look = (el: Element | null) => {
      if (el === null) throw new Error("no heading");
      const style = getComputedStyle(el);
      return [style.fontSize, style.fontWeight];
    };
    try {
      await render(pageAt(MODEL_ID));
      for (const li of plateItems()) expect(look(plateTitle(li))).toEqual(["15px", "700"]);

      const second = threeMf([plate(1, "One", { file: fileNumbers(1) })], {
        id: "0198f0c4-0000-7000-8000-00000000b009",
        name: "Second.3mf",
      });
      models.set(MODEL_ID, model([threeMf([plate(1, "Only", { file: fileNumbers(1) })]), second]));
      await act(async () => root.unmount());
      root = createRoot(container);
      await render(pageAt(MODEL_ID));
      for (const li of plateItems()) expect(look(plateTitle(li))).toEqual(["15px", "700"]);
      for (const h of panel().querySelectorAll(".ph-file-title")) {
        expect(look(h)).toEqual(["15px", "600"]);
      }

      await click(tab("Files"));
      const names = [...panel().querySelectorAll(".ph-file-title")];
      expect(names).toHaveLength(2);
      for (const h of names) expect(look(h)).toEqual(["15px", "700"]);
    } finally {
      for (const style of sheets) style.remove();
    }
  });
});

describe("each set of numbers says where it came from (AC-032 display)", () => {
  test("Bambu's own numbers are labelled as from the file, with the printer and process", async () => {
    await render(pageAt(MODEL_ID));
    const first = text(plateItems()[0]);
    expect(first).toContain("Bambu, in the file");
    expect(first).toContain(P1S_NAME);
    expect(first).toContain("0.20mm Standard @BBL P1P");
    expect(first).not.toMatch(/estimate/i);
  });

  test("a Platehouse estimate is marked as an estimate, with slicer, version, printer, process and filament profiles", async () => {
    await render(pageAt(MODEL_ID));
    const second = text(plateItems()[1]);
    expect(second).toContain("Platehouse estimate");
    expect(second).toContain("OrcaSlicer 2.5.0");
    expect(second).toContain(P1S_NAME);
    expect(second).toContain("0.20mm Standard @BBL X1C");
    expect(second).toContain("Bambu PLA Basic @BBL P1S");
  });

  test("a file sliced for another printer shows its numbers labelled with that printer beside the estimate", async () => {
    models.set(
      MODEL_ID,
      model([
        threeMf([
          plate(1, "Base", {
            file: { ...fileNumbers(1), printerId: X1C, printerLabel: X1C, printerName: X1C_NAME },
            platehouse: estimate("current"),
          }),
        ]),
      ]),
    );
    await render(pageAt(MODEL_ID));
    const only = text(plateItems()[0]);
    expect(only).toContain("Bambu, in the file");
    expect(only).toContain(X1C_NAME);
    expect(only).toContain("Platehouse estimate");
    expect(only).toContain(P1S_NAME);
  });

  test("an older estimate shown meanwhile is marked as for the previous printer", async () => {
    models.set(
      MODEL_ID,
      model([
        threeMf([
          plate(1, "Base", {
            platehouse: estimate("stale", {
              printerId: X1C,
              printerLabel: X1C,
              printerName: X1C_NAME,
              staleFor: X1C,
            }),
          }),
        ]),
      ]),
    );
    await render(pageAt(MODEL_ID));
    const only = text(plateItems()[0]);
    expect(only).toMatch(/previous printer/i);
    expect(only).toContain(X1C_NAME);
  });

  // The maintainer, 2026-11-19: the card read "Platehouse estimate Estimate".
  test("the estimate is labelled once, and a screen reader hears that label once", async () => {
    await render(pageAt(MODEL_ID));
    const second = plateItems()[1];
    const source = second?.querySelector(".ph-numbers-source");
    // What a screen reader reads for the label: its text, with nothing hidden
    // from it and no second badge.
    expect(text(source)).toBe("Platehouse estimate");
    expect(source?.querySelector("[aria-hidden]")).toBeNull();
    expect(second?.querySelector(".ph-estimate-mark")).toBeNull();
    expect(text(second).match(/estimate/gi)).toHaveLength(1);
    // The printer is named in full, never by its preset id.
    expect(text(second)).not.toContain(P1S);
  });

  test("an estimating plate and a failed one name the printer in full", async () => {
    models.set(
      MODEL_ID,
      model([
        threeMf([
          plate(1, "Base", { platehouse: estimate("estimating") }),
          plate(2, "Lid", {
            failure: {
              estimateId: EST_FAILED,
              reason: "bed_too_small",
              words: "The plate is too big for this printer's bed.",
              detail: null,
            },
          }),
        ]),
      ]),
    );
    await render(pageAt(MODEL_ID));
    expect(text(plateItems()[0])).toContain(`Estimating for ${P1S_NAME}.`);
    expect(text(plateItems()[1])).toContain(`Platehouse estimate for ${P1S_NAME}`);
  });
});

// The model page's printer switch (the maintainer, 2026-11-19): My printers in a small
// menu on the Plates tab. It asks for the model again with ?printer= and
// starts no slicing.
describe("the model page's printer switch", () => {
  function twoPrinters(shown: string): ModelView {
    return model([threeMf([plate(1, "Base", { file: fileNumbers(1) })])], {
      printer: shown,
      printerName: shown === X1C ? X1C_NAME : P1S_NAME,
      printers: [
        { id: P1S, name: P1S_NAME },
        { id: X1C, name: X1C_NAME },
      ],
    });
  }

  function printerSwitch(): HTMLSelectElement {
    const label = [...panel().querySelectorAll("label")].find(
      (l) => text(l) === "Times and weights for",
    );
    const select = label ? document.getElementById(label.getAttribute("for") ?? "") : null;
    if (!(select instanceof HTMLSelectElement)) throw new Error("no printer switch");
    return select;
  }

  test("with one printer there is no menu, and the Plates tab names the printer in full", async () => {
    await render(pageAt(MODEL_ID));
    expect(text(panel())).toContain(`Times and weights for ${P1S_NAME}`);
    expect(panel().querySelector("select")).toBeNull();
  });

  test("choosing another printer asks for its numbers only, and the choice is kept", async () => {
    models.set(MODEL_ID, twoPrinters(P1S));
    await render(pageAt(MODEL_ID));
    const select = printerSwitch();
    expect([...select.options].map((o) => o.textContent)).toEqual([P1S_NAME, X1C_NAME]);
    models.set(MODEL_ID, twoPrinters(X1C));
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(select, X1C);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(requests).toEqual([
      `GET /app/api/models/${MODEL_ID}`,
      `GET /app/api/models/${MODEL_ID}?printer=${encodeURIComponent(X1C)}`,
    ]);
    expect(printerSwitch().value).toBe(X1C);
    expect(localStorage.getItem(PRINTER_CHOICE_KEY)).toBe(X1C);
  });

  // Issue #255: the select is drawn from the model on screen, which still
  // names the old printer until the new answer lands. It must show the new
  // choice meanwhile, or React puts it back and arrow keys cannot get past
  // the next printer (on Windows each arrow press on a closed select chooses).
  const A1 = "Bambu Lab A1 0.4 nozzle";
  const A1_NAME = "Bambu Lab A1, 0.4 mm nozzle";

  function threePrinters(shown: string): ModelView {
    const names: Record<string, string> = { [P1S]: P1S_NAME, [X1C]: X1C_NAME, [A1]: A1_NAME };
    return model([threeMf([plate(1, "Base", { file: fileNumbers(1) })])], {
      printer: shown,
      printerName: names[shown] ?? shown,
      printers: [
        { id: P1S, name: P1S_NAME },
        { id: X1C, name: X1C_NAME },
        { id: A1, name: A1_NAME },
      ],
    });
  }

  /** A server whose ?printer= answers wait until the test releases them. */
  function holdChoices() {
    const answers = new Map<string, (r: Response) => void>();
    const fast = stubServer();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "https://platehouse.test");
        const asked = url.searchParams.get("printer");
        if (asked === null) return fast(input, init);
        requests.push(`GET ${url.pathname}${url.search}`);
        return new Promise<Response>((resolve) => answers.set(asked, resolve));
      }),
    );
    return answers;
  }

  async function step(select: HTMLSelectElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(select, value);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
  }

  test("while the new printer's numbers load, the switch shows the new choice and keeps focus", async () => {
    models.set(MODEL_ID, threePrinters(P1S));
    await render(pageAt(MODEL_ID));
    const answers = holdChoices();
    const select = printerSwitch();
    select.focus();

    // Two arrow presses before any answer: X1C, then A1.
    await step(select, X1C);
    expect(printerSwitch().value).toBe(X1C);
    expect(document.activeElement).toBe(printerSwitch());
    await step(printerSwitch(), A1);
    expect(printerSwitch().value).toBe(A1);
    expect(requests).toContain(`GET /app/api/models/${MODEL_ID}?printer=${encodeURIComponent(A1)}`);

    // The X1C answer, overtaken, never lands; the A1 one does.
    await act(async () => {
      answers.get(X1C)?.(json(threePrinters(X1C)));
      answers.get(A1)?.(json(threePrinters(A1)));
    });
    await settle();
    expect(printerSwitch().value).toBe(A1);
    expect(text(panel())).not.toContain(`Times and weights for ${X1C_NAME}`);
    expect(localStorage.getItem(PRINTER_CHOICE_KEY)).toBe(A1);
  });

  test("a load that fails keeps the new choice shown, matching what is stored, and Try again asks again", async () => {
    models.set(MODEL_ID, threePrinters(P1S));
    await render(pageAt(MODEL_ID));
    const answers = holdChoices();
    await step(printerSwitch(), X1C);
    await act(async () => {
      answers.get(X1C)?.(json({ error: "x" }, 503));
    });
    await settle();
    expect(container.textContent).toContain("The model could not be refreshed right now.");
    expect(printerSwitch().value).toBe(X1C);
    expect(localStorage.getItem(PRINTER_CHOICE_KEY)).toBe(X1C);

    const before = requests.length;
    const retry = [...container.querySelectorAll("button")].find((b) => text(b) === "Try again");
    await act(async () => retry?.click());
    await settle();
    expect(requests.slice(before)).toEqual([
      `GET /app/api/models/${MODEL_ID}?printer=${encodeURIComponent(X1C)}`,
    ]);
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
            {
              platehouse: estimate("stale", {
                printerId: X1C,
                printerLabel: X1C,
                printerName: X1C_NAME,
                staleFor: X1C,
              }),
            },
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
            {
              platehouse: estimate("stale", {
                printerId: X1C,
                printerLabel: X1C,
                printerName: X1C_NAME,
                staleFor: X1C,
              }),
            },
            true,
          ),
        ]),
      ]),
    );
    await render(pageAt(MODEL_ID));
    expect(text(plateItems()[0])).toContain(`A new estimate for ${P1S_NAME} is on its way.`);
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
            {
              platehouse: estimate("stale", {
                printerId: X1C,
                printerLabel: X1C,
                printerName: X1C_NAME,
                staleFor: X1C,
              }),
            },
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

  /** The model with plate 2 failed. */
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

  /** The page's one status region, where a refused Retry is said. */
  function pageStatus(): Element {
    const regions = container.querySelectorAll('[role="status"]');
    expect(regions).toHaveLength(1);
    return regions[0] as Element;
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

  test("a retry refused as not retryable says so, naming the plate, and reloads the model, and the words outlive the failure", async () => {
    // 409 not_retryable is final; the usual cause is that the estimate is no
    // longer failed (retried in another tab), so the reloaded model shows the
    // plate estimating and its failure, with its Retry, is gone.
    const alertSpy = vi.fn();
    vi.stubGlobal("alert", alertSpy);
    retryStatus = 409;
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
    const huge = plateItems()[1] as HTMLElement;
    expect(text(huge)).toMatch(/estimating/i);
    expect(() => button(/retry/i, huge)).toThrow();
    expect(text(pageStatus())).toBe(
      "Cube set.3mf, plate 2 (Huge) can no longer be retried. It is already being estimated again, or its printer or file has changed.",
    );
    expect(text(huge)).not.toMatch(/try again/i);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  const NOT_RETRYABLE =
    "Cube set.3mf, plate 2 (Huge) can no longer be retried. It is already being estimated again, or its printer or file has changed.";

  // The refusal's line is a one-shot notice (ModelPage.tsx): it is shown by
  // the answer the 409 asks for, whatever that answer holds, and ended by
  // the next one, whatever that holds. The answers below are what the
  // server gives in each case. It is the page's, not the plate's, so it
  // names the plate and stays when that answer no longer has the plate.

  /** Plate 2 estimating: retried elsewhere, so the poll keeps asking. */
  function estimatingModel(): ModelView {
    return model([
      threeMf([
        plate(1, "Base", { file: fileNumbers(1) }),
        plate(2, "Huge", { platehouse: estimate("estimating") }),
        plate(3, "Lid", { file: fileNumbers(3) }),
      ]),
    ]);
  }
  /** Plate 2's estimate finished: new numbers, no failure. */
  function finishedModel(): ModelView {
    return model([
      threeMf([
        plate(1, "Base", { file: fileNumbers(1) }),
        plate(2, "Huge", { platehouse: estimate("current") }),
        plate(3, "Lid", { file: fileNumbers(3) }),
      ]),
    ]);
  }
  test.each([
    ["the plate estimating", estimatingModel],
    ["the same failure", failedModel],
  ])("the answer the refusal asks for shows the line, whatever it holds: %s", async (_, next) => {
    retryStatus = 409;
    models.set(MODEL_ID, failedModel());
    await render(pageAt(MODEL_ID));
    models.set(MODEL_ID, next());
    await click(button(/retry/i, plateItems()[1] as HTMLElement));
    expect(requests).toEqual([
      `GET /app/api/models/${MODEL_ID}`,
      `POST /app/api/estimates/${EST_FAILED}/retry`,
      `GET /app/api/models/${MODEL_ID}`,
    ]);
    expect(text(pageStatus())).toBe(NOT_RETRYABLE);
  });

  test.each([
    ["the plate still estimating", estimatingModel],
    ["the plate finished, with new numbers", finishedModel],
    ["the estimate failed again", failedModel],
  ])("the next answer ends the line, whatever it holds: %s", async (_, next) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    retryStatus = 409;
    models.set(MODEL_ID, failedModel());
    await render(pageAt(MODEL_ID));
    models.set(MODEL_ID, estimatingModel());
    await click(button(/retry/i, plateItems()[1] as HTMLElement));
    expect(text(pageStatus())).toBe(NOT_RETRYABLE);

    models.set(MODEL_ID, next());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    await settle();
    expect(requests.filter((r) => r === `GET /app/api/models/${MODEL_ID}`)).toHaveLength(3);
    expect(text(pageStatus())).toBe("");
  });

  test("a screen reader hears the whole sentence: the polite status region is there, empty, before it", async () => {
    retryStatus = 409;
    models.set(MODEL_ID, failedModel());
    await render(pageAt(MODEL_ID));
    const region = pageStatus();
    expect(text(region)).toBe("");
    expect(region.getAttribute("aria-live")).not.toBe("off");
    models.set(MODEL_ID, estimatingModel());
    await click(button(/retry/i, plateItems()[1] as HTMLElement));
    // The same region, never replaced, now holds the sentence whole.
    expect(pageStatus()).toBe(region);
    expect(region.isConnected).toBe(true);
    expect(text(region)).toBe(NOT_RETRYABLE);
  });

  test("the not-retryable line goes when another printer is chosen", async () => {
    // The line was about the first printer's estimate; it says nothing
    // about another printer's numbers.
    const failedFor = (shown: string): ModelView =>
      model(
        [
          threeMf([
            plate(1, "Base", { file: fileNumbers(1) }),
            plate(
              2,
              "Huge",
              shown === P1S
                ? {
                    failure: {
                      estimateId: EST_FAILED,
                      reason: "bed_too_small",
                      words: WORDS,
                      detail: DETAIL,
                    },
                  }
                : { file: fileNumbers(2) },
            ),
            plate(3, "Lid", { file: fileNumbers(3) }),
          ]),
        ],
        {
          printer: shown,
          printerName: shown === X1C ? X1C_NAME : P1S_NAME,
          printers: [
            { id: P1S, name: P1S_NAME },
            { id: X1C, name: X1C_NAME },
          ],
        },
      );
    retryStatus = 409;
    models.set(MODEL_ID, failedFor(P1S));
    await render(pageAt(MODEL_ID));
    await click(button(/retry/i, plateItems()[1] as HTMLElement));
    expect(text(pageStatus())).toBe(NOT_RETRYABLE);

    // The other printer's answer is held: the switch alone ends the line,
    // before any answer lands.
    let release: () => void = () => {};
    modelHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    models.set(MODEL_ID, failedFor(X1C));
    const select = panel().querySelector("select");
    if (!(select instanceof HTMLSelectElement)) throw new Error("no printer switch");
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(select, X1C);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(requests).toContain(
      `GET /app/api/models/${MODEL_ID}?printer=${encodeURIComponent(X1C)}`,
    );
    // Still the first printer's numbers on screen, and the line is gone.
    expect(text(plateItems()[1])).toContain(WORDS);
    expect(text(pageStatus())).toBe("");

    modelHeld = null;
    release();
    await settle();
    expect(text(plateItems()[1])).not.toContain(WORDS);
    expect(text(pageStatus())).toBe("");
  });

  /**
   * The chosen printer (X1C) was taken out of My printers in another tab, so
   * a Retry is refused and the reload comes back as `next`, for the default
   * printer (the server's fallback). The page then forgets the choice and
   * asks again without it, which is answered with `next` too. Returns once
   * those four requests are made.
   */
  async function refusedAfterChoiceDropped(next: ModelView) {
    const failedOnX1C = model(
      [
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
      ],
      {
        printer: X1C,
        printerName: X1C_NAME,
        printers: [
          { id: P1S, name: P1S_NAME },
          { id: X1C, name: X1C_NAME },
        ],
      },
    );
    localStorage.setItem(PRINTER_CHOICE_KEY, X1C);
    retryStatus = 409;
    models.set(MODEL_ID, failedOnX1C);
    await render(pageAt(MODEL_ID));
    models.set(MODEL_ID, next);
    await click(button(/retry/i, plateItems()[1] as HTMLElement));
    expect(requests).toEqual([
      `GET /app/api/models/${MODEL_ID}?printer=${encodeURIComponent(X1C)}`,
      `POST /app/api/estimates/${EST_FAILED}/retry`,
      `GET /app/api/models/${MODEL_ID}?printer=${encodeURIComponent(X1C)}`,
      `GET /app/api/models/${MODEL_ID}`,
    ]);
    expect(localStorage.getItem(PRINTER_CHOICE_KEY)).toBeNull();
  }

  test("after the page forgets a dropped printer, the re-request keeps the line and the next answer ends it", async () => {
    // The re-request made without the forgotten choice only asks for the
    // same answer again, so it does not count. The poll after it is a new
    // answer and ends the line, so the page's forgetting does not outlive
    // that one re-request.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    await refusedAfterChoiceDropped(estimatingModel());
    expect(text(pageStatus())).toBe(NOT_RETRYABLE);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    await settle();
    expect(requests.filter((r) => r === `GET /app/api/models/${MODEL_ID}`)).toHaveLength(2);
    expect(text(pageStatus())).toBe("");
  });

  test("after the page forgets a dropped printer, the user's own printer choice ends the line", async () => {
    // My printers now holds P1S and A1. Choosing A1 on the switch is the
    // user's own choice, so it ends the line before its answer lands: the
    // answer is held, so only the choice can have ended it.
    const A1 = "Bambu Lab A1 0.4 nozzle";
    const A1_NAME = "Bambu Lab A1, 0.4 mm nozzle";
    const afterDrop = (shown: string): ModelView =>
      model(estimatingModel().files, {
        printer: shown,
        printerName: shown === A1 ? A1_NAME : P1S_NAME,
        printers: [
          { id: P1S, name: P1S_NAME },
          { id: A1, name: A1_NAME },
        ],
      });
    await refusedAfterChoiceDropped(afterDrop(P1S));
    expect(text(pageStatus())).toBe(NOT_RETRYABLE);

    let release: () => void = () => {};
    modelHeld = new Promise<void>((resolve) => {
      release = resolve;
    });
    models.set(MODEL_ID, afterDrop(A1));
    const select = panel().querySelector("select");
    if (!(select instanceof HTMLSelectElement)) throw new Error("no printer switch");
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(select, A1);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();
    expect(requests.at(-1)).toBe(
      `GET /app/api/models/${MODEL_ID}?printer=${encodeURIComponent(A1)}`,
    );
    // The switch shows A1 while its answer is held, and the line is gone.
    expect(panel().querySelector("select")?.value).toBe(A1);
    expect(text(pageStatus())).toBe("");

    modelHeld = null;
    release();
    await settle();
    expect(text(pageStatus())).toBe("");
  });

  test("the answer the refusal asks for shows the line when it no longer lists the chosen printer", async () => {
    // The chosen printer was taken out of My printers in another tab, so the
    // retry is refused and the reload comes back for the default printer
    // (the server's fallback). Nobody chose another printer: the line stays,
    // through the page forgetting the choice and asking again without it.
    const failedOnX1C = model(
      [
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
      ],
      {
        printer: X1C,
        printerName: X1C_NAME,
        printers: [
          { id: P1S, name: P1S_NAME },
          { id: X1C, name: X1C_NAME },
        ],
      },
    );
    localStorage.setItem(PRINTER_CHOICE_KEY, X1C);
    retryStatus = 409;
    models.set(MODEL_ID, failedOnX1C);
    await render(pageAt(MODEL_ID));
    models.set(MODEL_ID, finishedModel());
    await click(button(/retry/i, plateItems()[1] as HTMLElement));
    expect(requests).toEqual([
      `GET /app/api/models/${MODEL_ID}?printer=${encodeURIComponent(X1C)}`,
      `POST /app/api/estimates/${EST_FAILED}/retry`,
      `GET /app/api/models/${MODEL_ID}?printer=${encodeURIComponent(X1C)}`,
      `GET /app/api/models/${MODEL_ID}`,
    ]);
    expect(localStorage.getItem(PRINTER_CHOICE_KEY)).toBeNull();
    expect(text(pageStatus())).toBe(NOT_RETRYABLE);
  });

  test.each([
    [
      "the plate is gone from its file",
      () =>
        model([
          threeMf([
            plate(1, "Base", { file: fileNumbers(1) }),
            plate(3, "Lid", { file: fileNumbers(3) }),
          ]),
        ]),
    ],
    ["the file is gone, and with it the Plates tab", () => model([])],
  ])(
    "the answer the refusal asks for shows the line when it no longer has the plate: %s",
    async (_, next) => {
      retryStatus = 409;
      models.set(MODEL_ID, failedModel());
      await render(pageAt(MODEL_ID));
      models.set(MODEL_ID, next());
      await click(button(/retry/i, plateItems()[1] as HTMLElement));
      expect(requests).toEqual([
        `GET /app/api/models/${MODEL_ID}`,
        `POST /app/api/estimates/${EST_FAILED}/retry`,
        `GET /app/api/models/${MODEL_ID}`,
      ]);
      // No plate on the page is plate 2 any more; the page still says it.
      const titles = [...container.querySelectorAll(".ph-plate-title")].map((h) => text(h));
      expect(titles).not.toContain("Huge");
      expect(text(pageStatus())).toBe(NOT_RETRYABLE);
    },
  );

  test("a retry answered 401 says the user is signed out, beside the plate", async () => {
    retryStatus = 401;
    models.set(MODEL_ID, failedModel());
    await render(pageAt(MODEL_ID));
    await click(button(/retry/i, plateItems()[1] as HTMLElement));
    expect(text(plateItems()[1]?.querySelector('[role="alert"]'))).toBe(
      "You are signed out. Reload the page to sign in again.",
    );
    expect(requests.filter((r) => r.startsWith("GET "))).toHaveLength(1);
  });

  test("a retry that fails for another reason says what the server's answer means", async () => {
    retryStatus = 503;
    models.set(MODEL_ID, failedModel());
    await render(pageAt(MODEL_ID));
    await click(button(/retry/i, plateItems()[1] as HTMLElement));
    expect(text(plateItems()[1]?.querySelector('[role="alert"]'))).toBe(
      "This is unavailable right now. Try again in a moment.",
    );
    expect(requests.filter((r) => r.startsWith("GET "))).toHaveLength(1);
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

describe("a .3mf shows its plate pictures until a plate's 3D view is opened", () => {
  test("a .3mf shows its plate thumbnail large with a strip of 72 px plates, and three.js is not loaded until asked for", async () => {
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

describe("the large plate image can be rotated and flipped, on screen only", () => {
  const CONTROLS = [
    /^rotate left$/i,
    /^rotate right$/i,
    /^flip horizontal$/i,
    /^flip vertical$/i,
    /^reset$/i,
  ];

  /** The group of plate image buttons, so the 3D view's Rotate buttons never match. */
  function controls(): HTMLElement {
    const group = container.querySelector<HTMLElement>(".studio-viewer .ph-plate-controls");
    if (group === null) throw new Error("no plate image controls");
    return group;
  }

  function large(): HTMLImageElement {
    const img = container.querySelector<HTMLImageElement>(".studio-viewer img.studio-plate-large");
    if (img === null) throw new Error("no large plate image");
    return img;
  }

  async function press(label: RegExp) {
    await click(button(label, controls()));
  }

  /**
   * jsdom loads no images, so until this runs the picture has no size and a
   * quarter turn uses the safe 3/4. This gives the large image a natural
   * size and fires its load event, as a browser does once the picture is in.
   */
  async function loadPicture(width: number, height: number) {
    const img = large();
    Object.defineProperty(img, "naturalWidth", { configurable: true, value: width });
    Object.defineProperty(img, "naturalHeight", { configurable: true, value: height });
    await act(async () => {
      img.dispatchEvent(new Event("load"));
    });
  }

  test("five real buttons with names, in a labelled group under the image, all in the Tab order", async () => {
    await render(pageAt(MODEL_ID));
    const group = controls();
    expect(group.tagName).toBe("FIELDSET");
    expect(text(group.querySelector("legend"))).toBe("Plate image controls");
    const buttons = [...group.querySelectorAll("button")];
    expect(buttons.map((b) => text(b))).toEqual([
      "Rotate left",
      "Rotate right",
      "Flip horizontal",
      "Flip vertical",
      "Reset",
    ]);
    for (const b of buttons) {
      expect(b.getAttribute("type")).toBe("button");
      expect(b.classList.contains("studio-button")).toBe(true);
      expect(b.disabled).toBe(false);
      expect(b.tabIndex).toBe(0);
      b.focus();
      expect(document.activeElement).toBe(b);
    }
    for (const label of CONTROLS) expect(button(label, group)).toBeDefined();
  });

  test("the image starts with no transform", async () => {
    await render(pageAt(MODEL_ID));
    expect(large().style.transform).toBe("");
  });

  test.each([
    ["rotate left", /^rotate left$/i, "rotate(270deg) scale(0.75)"],
    ["rotate right", /^rotate right$/i, "rotate(90deg) scale(0.75)"],
    ["flip horizontal", /^flip horizontal$/i, "scaleX(-1)"],
    ["flip vertical", /^flip vertical$/i, "scaleY(-1)"],
  ])("%s applies its transform, and Reset clears it", async (_name, label, transform) => {
    await render(pageAt(MODEL_ID));
    await press(label);
    expect(large().style.transform).toBe(transform);
    await press(/^reset$/i);
    expect(large().style.transform).toBe("");
  });

  test.each([
    ["a square picture", 512, 512, "rotate(90deg)"],
    ["a tall picture", 400, 800, "rotate(90deg)"],
    ["a 5:4 picture", 1000, 800, "rotate(90deg) scale(0.8)"],
    ["a 4:3 picture", 800, 600, "rotate(90deg) scale(0.75)"],
    ["a 2:1 picture", 1024, 512, "rotate(90deg) scale(0.75)"],
  ])(
    "%s (%i x %i) is scaled only as much as it needs to fit after a quarter turn",
    async (_name, width, height, transform) => {
      await render(pageAt(MODEL_ID));
      await loadPicture(width, height);
      await press(/^rotate right$/i);
      expect(large().style.transform).toBe(transform);
      await press(/^rotate right$/i);
      expect(large().style.transform).toBe("rotate(180deg)");
    },
  );

  test("a picture that loads after a quarter turn takes its own scale then", async () => {
    await render(pageAt(MODEL_ID));
    await press(/^rotate left$/i);
    expect(large().style.transform).toBe("rotate(270deg) scale(0.75)");
    await loadPicture(512, 512);
    expect(large().style.transform).toBe("rotate(270deg)");
  });

  test("a quarter turn uses the safe 3/4 scale until the picture has loaded; a half turn needs none", async () => {
    await render(pageAt(MODEL_ID));
    await press(/^rotate right$/i);
    expect(large().style.transform).toContain("scale(0.75)");
    await press(/^rotate right$/i);
    expect(large().style.transform).toBe("rotate(180deg)");
    await press(/^rotate right$/i);
    expect(large().style.transform).toBe("rotate(270deg) scale(0.75)");
    await press(/^rotate right$/i);
    expect(large().style.transform).toBe("");
  });

  test("turns and flips combine as seen on screen: a flip after a turn still flips left to right", async () => {
    await render(pageAt(MODEL_ID));
    await press(/^rotate right$/i);
    await press(/^flip horizontal$/i);
    // Flipping left to right on screen after a quarter turn right is the
    // same picture as a mirror first, then a quarter turn left.
    expect(large().style.transform).toBe("rotate(270deg) scaleX(-1) scale(0.75)");
    await press(/^flip horizontal$/i);
    expect(large().style.transform).toBe("rotate(90deg) scale(0.75)");
    await press(/^rotate left$/i);
    await press(/^flip vertical$/i);
    await press(/^flip horizontal$/i);
    expect(large().style.transform).toBe("scaleX(-1) scaleY(-1)");
    await press(/^reset$/i);
    expect(large().style.transform).toBe("");
  });

  test("choosing another plate in the strip clears the transform, and going back shows the plate as it was stored", async () => {
    await render(pageAt(MODEL_ID));
    await press(/^rotate right$/i);
    await press(/^flip vertical$/i);
    expect(large().style.transform).not.toBe("");
    const strip = [...container.querySelectorAll<HTMLButtonElement>(".studio-plate-strip button")];
    await click(strip[1]);
    expect(large().getAttribute("src")).toBe(thumb(2));
    expect(large().style.transform).toBe("");
    await press(/^flip horizontal$/i);
    await click(strip[0]);
    expect(large().getAttribute("src")).toBe(thumb(1));
    expect(large().style.transform).toBe("");
  });

  test("viewing another .3mf from the Files tab clears the transform, even on the same plate number", async () => {
    const second = threeMf([plate(1, "One", { file: fileNumbers(1) })], {
      id: "0198f0c4-0000-7000-8000-00000000b009",
      name: "Second.3mf",
    });
    models.set(MODEL_ID, model([threeMf([plate(1, "Only", { file: fileNumbers(1) })]), second]));
    await render(pageAt(MODEL_ID));
    await press(/^rotate left$/i);
    expect(large().style.transform).not.toBe("");
    await click(tab("Files"));
    const row = [...panel().querySelectorAll("li")].find((li) => text(li).includes("Second.3mf"));
    await click(button(/^view/i, row as HTMLElement));
    expect(large().style.transform).toBe("");
  });

  test("opening the model again shows the plate untransformed", async () => {
    await render(pageAt(MODEL_ID));
    await press(/^rotate right$/i);
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(pageAt(MODEL_ID));
    expect(large().style.transform).toBe("");
  });

  test("nothing is sent to the server and nothing is stored in the browser", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const before = { local: localStorage.length, session: sessionStorage.length };
    await render(pageAt(MODEL_ID));
    const sent = requests.length;
    for (const label of CONTROLS) await press(label);
    await press(/^rotate right$/i);
    expect(requests.length).toBe(sent);
    expect(setItem).not.toHaveBeenCalled();
    expect({ local: localStorage.length, session: sessionStorage.length }).toEqual(before);
    setItem.mockRestore();
  });

  test("a plate with no thumbnail has no image to turn, so no controls", async () => {
    const bare = { ...plate(1, "Base", { file: fileNumbers(1) }), thumbnail: null };
    models.set(MODEL_ID, model([threeMf([bare])]));
    await render(pageAt(MODEL_ID));
    expect(container.querySelector(".ph-plate-controls")).toBeNull();
  });

  test("the 3D view keeps its own buttons and gets none of these", async () => {
    models.set(MODEL_ID, model([STL_FILE]));
    await render(pageAt(MODEL_ID));
    expect(container.querySelector(".ph-plate-controls")).toBeNull();
    expect(container.querySelector(".ph-viewer-controls")).not.toBeNull();
  });
});

describe("a .3mf plate's 3D view (issue #358)", () => {
  const PLATE_1 = "0198f0c4-0000-7000-8000-00000000d001";
  const PLATE_3 = "0198f0c4-0000-7000-8000-00000000d003";

  function toggle(): HTMLButtonElement {
    const found = container.querySelector<HTMLButtonElement>(
      ".studio-viewer .ph-plate-view-toggle",
    );
    if (found === null) throw new Error("no Show in 3D / Show picture button");
    return found;
  }

  function large(): HTMLImageElement | null {
    return container.querySelector<HTMLImageElement>(".studio-viewer img.studio-plate-large");
  }

  function alertText(): string {
    return text(container.querySelector('.studio-viewer [role="alert"]'));
  }

  const meshRequests = () => requests.filter((r) => r.includes("/mesh"));

  test("the picture has a Show in 3D button beside it: a real button in the Tab order, apart from the image controls", async () => {
    await render(pageAt(MODEL_ID));
    const open = toggle();
    expect(text(open)).toBe("Show in 3D");
    expect(open.tagName).toBe("BUTTON");
    expect(open.getAttribute("type")).toBe("button");
    expect(open.classList.contains("studio-button")).toBe(true);
    expect(open.tabIndex).toBe(0);
    expect(open.closest(".ph-plate-controls")).toBeNull();
    expect(meshRequests()).toEqual([]);
    expect(loadThree).not.toHaveBeenCalled();
  });

  test("Show in 3D asks the server for that plate's mesh alone and shows it in the 3D viewer with its controls", async () => {
    await render(pageAt(MODEL_ID));
    await click(toggle());
    expect(meshRequests()).toEqual([`GET /app/api/plates/${PLATE_1}/mesh`]);
    expect(loads).toEqual([{ kind: "glb", url: meshUrl(PLATE_1) }]);
    // Nothing but the mesh: never the .3mf's download.
    expect(requests.some((r) => r.includes("/download"))).toBe(false);
    const view = container.querySelector(".studio-viewer [data-viewer3d]");
    expect(view?.getAttribute("role")).toBe("img");
    expect(view?.getAttribute("aria-label")).toBe("3D view of Base");
    for (const label of [
      /^rotate left$/i,
      /^rotate right$/i,
      /^zoom in$/i,
      /^zoom out$/i,
      /^reset view$/i,
    ]) {
      expect(button(label, container.querySelector(".studio-viewer") as HTMLElement)).toBeDefined();
    }
    expect(large()).toBeNull();
    expect(text(toggle())).toBe("Show picture");
  });

  test("opening the view puts focus on Show picture, and closing it puts focus back on Show in 3D", async () => {
    await render(pageAt(MODEL_ID));
    await click(toggle());
    expect(document.activeElement).toBe(toggle());
    expect(text(document.activeElement)).toBe("Show picture");
    await click(toggle());
    expect(document.activeElement).toBe(toggle());
    expect(text(document.activeElement)).toBe("Show in 3D");
  });

  test("Show picture closes the view, frees it, and the picture's turn and flip buttons work again", async () => {
    const calls: string[] = [];
    const recording: ThreeLoader = async () => ({
      async show(_el, source) {
        loads.push(source);
        return {
          rotate: () => {},
          zoom: () => {},
          reset: () => {},
          dispose: () => calls.push("dispose"),
        };
      },
    });
    await render(pageAt(MODEL_ID, { loadThree: recording }));
    await click(toggle());
    await click(toggle());
    expect(calls).toEqual(["dispose"]);
    expect(container.querySelector("[data-viewer3d]")).toBeNull();
    expect(large()?.getAttribute("src")).toBe(thumb(1));
    const controls = container.querySelector<HTMLElement>(".studio-viewer .ph-plate-controls");
    await click(button(/^rotate right$/i, controls as HTMLElement));
    expect(large()?.style.transform).toBe("rotate(90deg) scale(0.75)");
  });

  test("clicking the picture opens the view; the picture's button is named but kept out of the Tab order", async () => {
    await render(pageAt(MODEL_ID));
    const picture = container.querySelector<HTMLButtonElement>(".studio-viewer .ph-plate-open");
    expect(picture?.tagName).toBe("BUTTON");
    expect(picture?.getAttribute("type")).toBe("button");
    expect(picture?.getAttribute("aria-label")).toBe("Show Base in 3D");
    expect(picture?.tabIndex).toBe(-1);
    await click(picture);
    expect(loads).toEqual([{ kind: "glb", url: meshUrl(PLATE_1) }]);
  });

  test("says the view is loading while the server makes the mesh", async () => {
    let release: () => void = () => {};
    meshHeld = new Promise((resolve) => {
      release = resolve;
    });
    await render(pageAt(MODEL_ID));
    await click(toggle());
    expect(text(container.querySelector(".studio-viewer .studio-viewer-frame"))).toBe(
      "Loading the 3D view...",
    );
    expect(loadThree).not.toHaveBeenCalled();
    release();
    await settle();
    expect(loads).toEqual([{ kind: "glb", url: meshUrl(PLATE_1) }]);
  });

  test("choosing another plate while the view is open shows that plate in 3D", async () => {
    await render(pageAt(MODEL_ID));
    await click(toggle());
    const strip = [...container.querySelectorAll<HTMLButtonElement>(".studio-plate-strip button")];
    await click(strip[2]);
    expect(meshRequests()).toEqual([
      `GET /app/api/plates/${PLATE_1}/mesh`,
      `GET /app/api/plates/${PLATE_3}/mesh`,
    ]);
    expect(loads.at(-1)).toEqual({ kind: "glb", url: meshUrl(PLATE_3) });
    expect(container.querySelector("[data-viewer3d]")?.getAttribute("aria-label")).toBe(
      "3D view of Lid",
    );
  });

  test("a plate with no thumbnail still offers its 3D view", async () => {
    const bare = { ...plate(1, "Base", { file: fileNumbers(1) }), thumbnail: null };
    models.set(MODEL_ID, model([threeMf([bare])]));
    await render(pageAt(MODEL_ID));
    expect(container.querySelector(".ph-plate-open")).toBeNull();
    await click(toggle());
    expect(loads).toEqual([{ kind: "glb", url: meshUrl(PLATE_1) }]);
  });

  test.each([
    ["no_plate", /Base has no 3D view: it is not in the file's plate list/],
    ["no_objects", /Base has no 3D view: there are no objects on it/],
    ["no_mesh", /Base has no 3D view: this file has no mesh Platehouse can read for its objects/],
    ["too_large", /Base has no 3D view: its objects are too large to show in the browser/],
    ["damaged", /Base has no 3D view: the file could not be read/],
  ])(
    "a plate whose 3D view cannot be made (%s) keeps its picture and says why",
    async (code, words) => {
      meshAnswer = () => json({ error: "no_mesh", code, message: "English from the server" }, 422);
      await render(pageAt(MODEL_ID));
      await click(toggle());
      expect(loadThree).not.toHaveBeenCalled();
      expect(large()?.getAttribute("src")).toBe(thumb(1));
      expect(alertText()).toMatch(words);
      expect(text(toggle())).toBe("Show in 3D");
      expect(document.activeElement).toBe(toggle());
    },
  );

  test("a file that cannot be read right now keeps the picture and says to try again later", async () => {
    meshAnswer = () => json({ error: "unavailable", message: "x" }, 503);
    await render(pageAt(MODEL_ID));
    await click(toggle());
    expect(large()).not.toBeNull();
    expect(alertText()).toMatch(/could not be read right now\. Try again later/);
  });

  test("a server error or an answer it cannot read keeps the picture and says so", async () => {
    for (const answer of [
      () => json({ error: "internal" }, 500),
      () => json({ url: "https://elsewhere.test/mesh.glb" }),
      () => new Response("not json", { status: 200 }),
    ]) {
      meshAnswer = answer;
      await render(pageAt(MODEL_ID));
      await click(toggle());
      expect(loadThree).not.toHaveBeenCalled();
      expect(large()).not.toBeNull();
      expect(alertText()).toMatch(/because of a server error/);
      await act(async () => root.unmount());
      root = createRoot(container);
      requests = [];
    }
  });

  test("a signed-out session keeps the picture and says the user is signed out", async () => {
    meshAnswer = () => json({ error: "unauthorized" }, 401);
    await render(pageAt(MODEL_ID));
    await click(toggle());
    expect(large()).not.toBeNull();
    expect(alertText()).toMatch(/You are signed out/);
  });

  test("a 3D view the browser cannot start keeps the picture and says so, without offering the whole .3mf", async () => {
    const failing: ThreeLoader = async () => {
      throw new Error("no WebGL");
    };
    await render(pageAt(MODEL_ID, { loadThree: failing }));
    await click(toggle());
    expect(large()?.getAttribute("src")).toBe(thumb(1));
    expect(alertText()).toMatch(/The 3D view of Base could not be shown in this browser/);
    expect(
      container.querySelector(`.studio-viewer a[href="/files/${FILE_3MF}/download"]`),
    ).toBeNull();
  });

  test("three.js failing to load (a dropped network, a page older than a redeploy) keeps the picture, never blaming the browser", async () => {
    const failing: ThreeLoader = async () => {
      throw new ThreeLoadError("three.js could not be loaded");
    };
    await render(pageAt(MODEL_ID, { loadThree: failing }));
    await click(toggle());
    expect(large()?.getAttribute("src")).toBe(thumb(1));
    expect(alertText()).toMatch(/because of a server error/);
    expect(alertText()).not.toMatch(/in this browser/);
  });

  test.each([
    [
      "the store cannot serve the mesh right now (503)",
      503,
      /could not be read right now\. Try again later/,
    ],
    ["the session ended before the mesh loaded (401)", 401, /You are signed out/],
    ["the mesh is missing from the store (404)", 404, /because of a server error/],
    ["no reply came, or the mesh could not be read", null, /because of a server error/],
  ])(
    "a mesh that fails to load when %s keeps the picture and says why, never blaming the browser",
    async (_case, status, words) => {
      const failing: ThreeLoader = async () => ({
        async show() {
          throw new MeshLoadError(status, "the mesh failed");
        },
      });
      await render(pageAt(MODEL_ID, { loadThree: failing }));
      await click(toggle());
      expect(large()?.getAttribute("src")).toBe(thumb(1));
      expect(alertText()).toMatch(words);
      expect(alertText()).not.toMatch(/in this browser/);
    },
  );

  test("the reason goes when the view is opened again or another plate is chosen", async () => {
    meshAnswer = () => json({ error: "no_mesh", code: "no_mesh", message: "x" }, 422);
    await render(pageAt(MODEL_ID));
    await click(toggle());
    expect(alertText()).not.toBe("");
    const strip = [...container.querySelectorAll<HTMLButtonElement>(".studio-plate-strip button")];
    await click(strip[1]);
    expect(container.querySelector('.studio-viewer [role="alert"]')).toBeNull();
    // Back on the first plate, the reason is not shown again until asked.
    await click(strip[0]);
    expect(container.querySelector('.studio-viewer [role="alert"]')).toBeNull();
    await click(toggle());
    expect(alertText()).toMatch(/Base has no 3D view/);
  });

  test("leaving the page while the mesh is being made asks for nothing more and loads nothing", async () => {
    let release: () => void = () => {};
    meshHeld = new Promise((resolve) => {
      release = resolve;
    });
    await render(pageAt(MODEL_ID));
    await click(toggle());
    await act(async () => root.unmount());
    root = createRoot(container);
    release();
    await settle();
    expect(loadThree).not.toHaveBeenCalled();
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
            description: "Already set by the user.",
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
    expect(text(container)).toContain("Already set by the user.");
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

  /**
   * Mounts the app from main.tsx into a new #root at the current URL, with
   * fresh state: the first time by importing main.tsx, after that by
   * rendering what it rendered then into a new root. Returns the root to
   * unmount and the element.
   */
  async function startApp(): Promise<{ appRoot: HTMLElement; unmount(): Promise<void> }> {
    const appRoot = document.createElement("div");
    appRoot.id = "root";
    document.body.append(appRoot);
    const rootsBefore = recorded.roots.length;
    if (recorded.app === null) {
      await act(async () => {
        await import("../src/main");
      });
    } else {
      const fresh = createRoot(appRoot);
      await act(async () => {
        fresh.render(recorded.app as ReactNode);
      });
    }
    await settle();
    const appReact = recorded.roots[rootsBefore];
    return {
      appRoot,
      async unmount() {
        await act(async () => appReact?.unmount());
        appRoot.remove();
      },
    };
  }

  test("files left unsent for a model never go to new models, and new-model files never join the model", async () => {
    models.set(MODEL_ID, model([STL_FILE]));
    recorded.uploads.length = 0;
    window.history.pushState({}, "", `/models/${MODEL_ID}`);
    const app = await startApp();
    const { appRoot } = app;
    try {
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
      await app.unmount();
      window.history.pushState({}, "", "/");
    }
  });

  test("files left unsent on a model page, then a drop on the library: Upload in each sends each file to its own target", async () => {
    // The case the upload dialog used to get wrong: one dialog whose target
    // was read when Upload was pressed sent the model page's unsent file to
    // new models after a drop on the library.
    models.set(MODEL_ID, model([STL_FILE]));
    recorded.uploads.length = 0;
    window.history.pushState({}, "", `/models/${MODEL_ID}`);
    const app = await startApp();
    const { appRoot } = app;
    try {
      const dropZone = () => appRoot.querySelector("[data-dropzone]");

      // On the model page: one.stl is sending; two.stl is added and left
      // unsent, and the dialog is hidden.
      await dropOn(dropZone(), [stl("one.stl")]);
      expect(text(dialog())).toContain("The files are added to this model.");
      await click(button(/^upload/i, dialog()));
      await dropOn(document.querySelector(".ph-dialog-backdrop"), [stl("two.stl")]);
      expect(listed()).toEqual(["one.stl", "two.stl"]);
      await click(button(/^hide$/i, dialog()));
      expect(document.querySelector('[role="dialog"]')).toBeNull();

      // On the library, by the sidebar: a drop opens the dialog for new
      // models with only the dropped file, and Upload sends only that file,
      // as a new model.
      const library = [...appRoot.querySelectorAll("a")].find((a) => text(a) === "Library");
      await click(library);
      expect(window.location.pathname).toBe("/");
      await dropOn(dropZone(), [stl("three.stl")]);
      expect(text(dialog())).toContain("Each file becomes its own model");
      expect(listed()).toEqual(["three.stl"]);
      await click(button(/^upload/i, dialog()));
      expect(sent()).toEqual([
        ["one.stl", MODEL_ID],
        ["three.stl", "new"],
      ]);
      await click(button(/^hide$/i, dialog()));

      // Back on the model page, Add files opens its dialog with two.stl
      // still waiting, and Upload sends it into the model.
      await act(async () => {
        window.history.pushState({}, "", `/models/${MODEL_ID}`);
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      await settle();
      await click(button(/^add files$/i, appRoot));
      expect(text(dialog())).toContain("The files are added to this model.");
      expect(listed()).toEqual(["one.stl", "two.stl"]);
      await click(button(/^upload/i, dialog()));
      expect(sent()).toEqual([
        ["one.stl", MODEL_ID],
        ["three.stl", "new"],
        ["two.stl", MODEL_ID],
      ]);
    } finally {
      await app.unmount();
      window.history.pushState({}, "", "/");
    }
  });
});
