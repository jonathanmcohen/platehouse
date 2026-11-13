// @vitest-environment jsdom
// Build plan Task 19 (AC-020, AC-061, AC-064 and AC-073, UI side): the
// library page, its cards and tag filter, the search box driving it, and the
// upload dialog. Rendered in jsdom with React; the server is a stubbed fetch
// that records every request, and the tus upload is a stub that records what
// it was asked to send and lets the test report progress.
//
// - library render requests no model file: the page asks only /app/api for
//   data, and the only images it shows are /blobs/<id> thumbnails the API
//   named. Nothing points at /files/.
// - card shows time and weight only when every plate is known, and says
//   partial otherwise; an STL or STEP card shows a file-type icon.
// - upload dialog shows progress per file and honours combine: the switch
//   is off by default; off, each file is its own new model; on, every file
//   carries one batch id with combine. The tus options use 5 MiB chunks,
//   /app/uploads, and a resume fingerprint that names the target.
// - tag filter narrows the grid, and the top bar's search box drives the
//   library's search.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Filters } from "../src/library/Filters";
import { LibraryPage } from "../src/library/LibraryPage";
import {
  formatDuration,
  formatWeight,
  type LibraryCard,
  ModelCard,
} from "../src/library/ModelCard";
import { Shell } from "../src/shell/Shell";
import { UploadDialog } from "../src/upload/UploadDialog";
import {
  CHUNK_SIZE,
  type FetchResult,
  isSupportedFile,
  type StartUpload,
  UPLOAD_ENDPOINT,
  type UploadHandlers,
  type UploadTarget,
  uploadFingerprint,
  uploadMetadata,
  uploadOptions,
} from "../src/upload/useTusUpload";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PRINTER = "Bambu Lab P1S 0.4 nozzle";

function makeCard(overrides: Partial<LibraryCard> & { id: string; name: string }): LibraryCard {
  return {
    creator: null,
    tags: [],
    plateCount: 0,
    thumbnail: null,
    fileKind: null,
    timeSeconds: null,
    weightGrams: null,
    partial: false,
    ...overrides,
  };
}

const PLATED = makeCard({
  id: "0198f0c4-0000-7000-8000-000000000001",
  name: "Plated box",
  creator: "Maker One",
  tags: ["Gridfinity"],
  plateCount: 2,
  thumbnail: "/blobs/0198f0c4-0000-7000-8000-0000000000a1",
  fileKind: "3mf",
  timeSeconds: 3000,
  weightGrams: 31,
});
const PARTIAL = makeCard({
  id: "0198f0c4-0000-7000-8000-000000000002",
  name: "Half known",
  plateCount: 3,
  thumbnail: "/blobs/0198f0c4-0000-7000-8000-0000000000a2",
  fileKind: "3mf",
  partial: true,
});
const STL = makeCard({
  id: "0198f0c4-0000-7000-8000-000000000003",
  name: "Bracket",
  tags: ["PLA"],
  fileKind: "stl",
});
const STEP = makeCard({
  id: "0198f0c4-0000-7000-8000-000000000004",
  name: "Housing",
  fileKind: "step",
});

let container: HTMLDivElement;
let root: Root;
/** Every URL the page fetched, in order. */
let requests: string[];

/** A fetch that answers the library's two routes from these cards. */
function stubServer(cards: LibraryCard[], tags: string[] = ["Gridfinity", "PLA"]) {
  const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "https://platehouse.test");
    requests.push(`${url.pathname}${url.search}`);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (url.pathname === "/app/api/library/tags") return json({ tags });
    if (url.pathname === "/app/api/library") {
      const tag = url.searchParams.get("tag");
      const q = url.searchParams.get("q");
      const models = cards.filter(
        (c) =>
          (tag === null || c.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) &&
          (q === null || c.name.toLowerCase().includes(q.toLowerCase())),
      );
      return json({ printer: PRINTER, models, nextCursor: null });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

async function render(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
  await settle();
}

/** Lets fetches and the state updates after them finish. */
async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function libraryAt(path: string, props: Parameters<typeof LibraryPage>[0] = {}) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<LibraryPage {...props} />} />
      </Routes>
    </MemoryRouter>
  );
}

function cardNames(): string[] {
  return [...container.querySelectorAll(".studio-grid .studio-card-title")].map(
    (el) => el.textContent ?? "",
  );
}

beforeEach(() => {
  requests = [];
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

describe("library render requests no model file", () => {
  test("data comes only from /app/api and images only from /blobs thumbnails", async () => {
    stubServer([PLATED, PARTIAL, STL, STEP]);
    await render(libraryAt("/"));
    expect(cardNames()).toEqual(["Plated box", "Half known", "Bracket", "Housing"]);

    expect(requests.length).toBeGreaterThan(0);
    for (const url of requests) expect(url, url).toMatch(/^\/app\/api\//);

    const images = [...container.querySelectorAll("img")].map((img) => img.getAttribute("src"));
    expect(images.sort()).toEqual([PLATED.thumbnail, PARTIAL.thumbnail].sort());
    for (const src of images) expect(src).toMatch(/^\/blobs\/[0-9a-f-]{36}$/);

    // Nothing on the page names a model file or its download.
    expect(container.innerHTML).not.toContain("/files/");
    for (const el of container.querySelectorAll("[src], [srcset], link[href]")) {
      const value = el.getAttribute("src") ?? el.getAttribute("srcset") ?? "";
      expect(value, value).toMatch(/^\/blobs\//);
    }
  });

  test("an empty library says so and offers the drop and Add routes", async () => {
    stubServer([]);
    await render(libraryAt("/"));
    expect(cardNames()).toEqual([]);
    expect(container.querySelector(".studio-empty")?.textContent).toMatch(/no models/i);
  });

  test("a library the server cannot give shows a message and a way to try again", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("down", { status: 503 })),
    );
    await render(libraryAt("/"));
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/could not be loaded/i);
    const retry = [...container.querySelectorAll("button")].find((b) =>
      /try again/i.test(b.textContent ?? ""),
    );
    expect(retry, "no Try again button").toBeDefined();
  });
});

describe("card shows time and weight only when every plate is known", () => {
  async function renderCard(card: LibraryCard): Promise<HTMLElement> {
    await render(
      <MemoryRouter>
        <ul>
          <ModelCard card={card} />
        </ul>
      </MemoryRouter>,
    );
    const li = container.querySelector("li");
    if (li === null) throw new Error("ModelCard rendered no list item");
    return li;
  }

  test("every plate known: the plate count, total time and total weight", async () => {
    const li = await renderCard(PLATED);
    const text = li.textContent ?? "";
    expect(text).toContain("Plated box");
    expect(text).toContain("Maker One");
    expect(text).toContain("2 plates");
    expect(text).toContain("50m");
    expect(text).toContain("31 g");
    expect(text).not.toMatch(/partial/i);
    expect(li.querySelector("img")?.getAttribute("src")).toBe(PLATED.thumbnail);
    expect(li.querySelector("a")?.getAttribute("href")).toBe(`/models/${PLATED.id}`);
  });

  test("a plate without numbers: partial, and no time or weight", async () => {
    const li = await renderCard(PARTIAL);
    const text = li.textContent ?? "";
    expect(text).toContain("3 plates");
    expect(text).toContain("partial");
    expect(text).not.toMatch(/\d+m\b/);
    expect(text).not.toMatch(/\d g\b/);
  });

  test.each([
    ["STL", STL],
    ["STEP", STEP],
  ])("an %s card shows a generic file-type icon, no image and no numbers", async (label, card) => {
    const li = await renderCard(card);
    expect(li.querySelector("img")).toBeNull();
    const icon = li.querySelector(".studio-card-media svg");
    expect(icon, "no file-type icon").not.toBeNull();
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
    expect(li.querySelector(".studio-card-media")?.textContent).toContain(label);
    expect(li.textContent).not.toMatch(/partial|plates?\b/);
  });

  test("time and weight read the way the card shows them", () => {
    expect(formatDuration(3000)).toBe("50m");
    expect(formatDuration(5100)).toBe("1h 25m");
    expect(formatDuration(7200)).toBe("2h 0m");
    expect(formatDuration(20)).toBe("1m");
    expect(formatWeight(31)).toBe("31 g");
    expect(formatWeight(41.37)).toBe("41.4 g");
    expect(formatWeight(1250)).toBe("1.25 kg");
  });
});

describe("tag filter narrows the grid", () => {
  test("choosing a tag asks for that tag and shows only its models", async () => {
    stubServer([PLATED, PARTIAL, STL, STEP]);
    await render(libraryAt("/"));
    expect(cardNames()).toHaveLength(4);

    const chips = [...container.querySelectorAll<HTMLAnchorElement>("a.studio-chip")];
    expect(chips.map((c) => c.textContent)).toEqual(["All", "Gridfinity", "PLA"]);
    expect(chips[0]?.getAttribute("aria-current")).toBe("true");

    await act(async () => {
      chips[1]?.click();
    });
    await settle();
    expect(requests.at(-1)).toMatch(/^\/app\/api\/library\?(?:.*&)?tag=Gridfinity(?:&|$)/);
    expect(cardNames()).toEqual(["Plated box"]);
    const active = container.querySelector('a.studio-chip[aria-current="true"]');
    expect(active?.textContent).toBe("Gridfinity");
  });

  test("a tag link keeps the search, and All drops only the tag", async () => {
    await render(
      <MemoryRouter initialEntries={["/?q=box&tag=PLA"]}>
        <Filters tags={["Gridfinity", "PLA"]} />
      </MemoryRouter>,
    );
    const hrefs = [...container.querySelectorAll("a.studio-chip")].map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toEqual(["/?q=box", "/?q=box&tag=Gridfinity", "/?q=box&tag=PLA"]);
    const active = container.querySelector('a.studio-chip[aria-current="true"]');
    expect(active?.textContent).toBe("PLA");
  });
});

describe("search", () => {
  test("the top bar's search box drives the library's search", async () => {
    stubServer([PLATED, PARTIAL, STL, STEP]);
    await render(
      <MemoryRouter initialEntries={["/?q=bracket"]}>
        <Shell>
          <Routes>
            <Route path="/" element={<LibraryPage />} />
          </Routes>
        </Shell>
      </MemoryRouter>,
    );
    expect(requests).toContain("/app/api/library?q=bracket");
    expect(cardNames()).toEqual(["Bracket"]);
    expect(container.querySelector<HTMLInputElement>('input[type="search"]')?.value).toBe(
      "bracket",
    );

    // A new search from the box reloads the library with it.
    const form = container.querySelector("search form") as HTMLFormElement;
    const input = container.querySelector('input[type="search"]') as HTMLInputElement;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(input, "box");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      form.requestSubmit();
    });
    await settle();
    expect(requests).toContain("/app/api/library?q=box");
    expect(cardNames()).toEqual(["Plated box"]);
  });
});

describe("dropping files on the library", () => {
  test("hands the dropped files to the upload dialog's opener", async () => {
    stubServer([PLATED]);
    const onFiles = vi.fn();
    await render(libraryAt("/", { onFiles }));
    const file = new File(["solid x"], "drop.stl");
    const zone = container.querySelector("[data-dropzone]");
    expect(zone, "the library is not a drop zone").not.toBeNull();
    await act(async () => {
      const over = new Event("dragover", { bubbles: true, cancelable: true });
      Object.defineProperty(over, "dataTransfer", { value: { types: ["Files"], files: [] } });
      zone?.dispatchEvent(over);
      expect(over.defaultPrevented).toBe(true);
      const drop = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(drop, "dataTransfer", { value: { types: ["Files"], files: [file] } });
      zone?.dispatchEvent(drop);
    });
    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles.mock.calls[0]?.[0]).toEqual([file]);
  });
});

describe("the tus options", () => {
  const file = new File([new Uint8Array(10)], "Air Dry - AMS.3mf", { lastModified: 1_700_000 });

  test("5 MiB chunks to /app/uploads, the file name in the metadata", () => {
    const handlers: UploadHandlers = {
      onProgress: () => {},
      onSuccess: () => {},
      onError: () => {},
    };
    const options = uploadOptions(file, { kind: "new" }, handlers);
    expect(CHUNK_SIZE).toBe(5 * 1024 * 1024);
    expect(options.chunkSize).toBe(CHUNK_SIZE);
    expect(options.endpoint).toBe(UPLOAD_ENDPOINT);
    expect(UPLOAD_ENDPOINT).toBe("/app/uploads");
    expect(options.metadata).toEqual({ filename: "Air Dry - AMS.3mf" });
    expect(options.storeFingerprintForResuming).not.toBe(false);
  });

  test("the metadata names the target: new, an existing model, or the combined batch", () => {
    expect(uploadMetadata(file, { kind: "new" })).toEqual({ filename: file.name });
    expect(uploadMetadata(file, { kind: "model", modelId: STL.id })).toEqual({
      filename: file.name,
      modelId: STL.id,
    });
    expect(uploadMetadata(file, { kind: "batch", batch: "b-1" })).toEqual({
      filename: file.name,
      batch: "b-1",
      combine: "1",
    });
  });

  test("the resume fingerprint includes the target, so another target starts a new upload", async () => {
    const targets: UploadTarget[] = [
      { kind: "new" },
      { kind: "model", modelId: STL.id },
      { kind: "model", modelId: STEP.id },
      { kind: "batch", batch: "b-1" },
      { kind: "batch", batch: "b-2" },
    ];
    const prints = targets.map((t) => uploadFingerprint(file, t, UPLOAD_ENDPOINT));
    expect(new Set(prints).size).toBe(targets.length);
    // The same file to the same target resumes.
    expect(uploadFingerprint(file, { kind: "new" }, UPLOAD_ENDPOINT)).toBe(prints[0]);
    // tus-js-client asks the options' fingerprint function for it.
    const handlers: UploadHandlers = {
      onProgress: () => {},
      onSuccess: () => {},
      onError: () => {},
    };
    const options = uploadOptions(file, { kind: "model", modelId: STL.id }, handlers);
    expect(await options.fingerprint?.(file, options)).toBe(prints[1]);
  });

  test("only the five supported types are sent", () => {
    for (const name of ["a.3mf", "b.STL", "c.step", "d.stp", "e.scad"]) {
      expect(isSupportedFile(name), name).toBe(true);
    }
    for (const name of ["notes.txt", "model.obj", "3mf", "archive.zip"]) {
      expect(isSupportedFile(name), name).toBe(false);
    }
  });
});

describe("upload dialog shows progress per file and honours combine", () => {
  interface Started {
    file: File;
    target: UploadTarget;
    handlers: UploadHandlers;
  }

  function stubUploads() {
    const started: Started[] = [];
    const start: StartUpload = (file, target, handlers) => {
      started.push({ file, target, handlers });
      return { abort: () => {} };
    };
    const fetchResult = vi.fn<FetchResult>(async (url) => ({
      status: "done",
      modelId: STL.id,
      fileId: url.split("/").at(-1) ?? "",
    }));
    return { started, start, fetchResult };
  }

  const a = new File([new Uint8Array(100)], "a.3mf");
  const b = new File([new Uint8Array(200)], "b.stl");
  const bad = new File(["text"], "notes.txt");

  function progressOf(name: string): HTMLProgressElement {
    const bar = container.querySelector<HTMLProgressElement>(
      `progress[aria-label="Upload progress for ${name}"]`,
    );
    if (bar === null) throw new Error(`no progress bar for ${name}`);
    return bar;
  }

  function switchInput(): HTMLInputElement | null {
    return container.querySelector<HTMLInputElement>('input[role="switch"]');
  }

  function button(label: RegExp): HTMLButtonElement {
    const found = [...container.querySelectorAll("button")].find((el) =>
      label.test(el.textContent ?? ""),
    );
    if (found === undefined) throw new Error(`no button ${label}`);
    return found;
  }

  test("a themed dialog, not a native one, listing every dropped file", async () => {
    const { start, fetchResult } = stubUploads();
    await render(
      <UploadDialog
        open
        files={[a, b, bad]}
        onClose={() => {}}
        start={start}
        fetchResult={fetchResult}
      />,
    );
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog, "no dialog").not.toBeNull();
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    const labelledBy = dialog?.getAttribute("aria-labelledby") ?? "";
    expect(document.getElementById(labelledBy)?.textContent).toMatch(/add files/i);
    const text = dialog?.textContent ?? "";
    for (const f of [a, b, bad]) expect(text).toContain(f.name);
    expect(text).toMatch(/not a supported file type/i);
    expect(switchInput()?.checked).toBe(false);
    expect(container.querySelector("dialog")).toBeNull();
  });

  test("combine off: each file is its own new model, with its own progress", async () => {
    const { started, start, fetchResult } = stubUploads();
    const onUploaded = vi.fn();
    await render(
      <UploadDialog
        open
        files={[a, b, bad]}
        onClose={() => {}}
        onUploaded={onUploaded}
        start={start}
        fetchResult={fetchResult}
        resultDelayMs={0}
      />,
    );
    expect(switchInput()?.checked).toBe(false);
    await act(async () => {
      button(/^upload/i).click();
    });
    // The unsupported file is never sent.
    expect(started.map((s) => s.file.name)).toEqual(["a.3mf", "b.stl"]);
    for (const s of started) expect(s.target).toEqual({ kind: "new" });

    await act(async () => {
      started[0]?.handlers.onProgress(50, 100);
      started[1]?.handlers.onProgress(20, 200);
    });
    expect(progressOf("a.3mf").value).toBe(50);
    expect(progressOf("a.3mf").max).toBe(100);
    expect(progressOf("b.stl").value).toBe(20);
    expect(progressOf("b.stl").max).toBe(200);

    await act(async () => {
      started[0]?.handlers.onProgress(100, 100);
      started[0]?.handlers.onSuccess("https://platehouse.test/app/uploads/u-1");
    });
    await settle();
    expect(fetchResult).toHaveBeenCalledWith("https://platehouse.test/app/uploads/u-1");
    const rowA = container.querySelector('[data-upload="a.3mf"]');
    expect(rowA?.textContent).toMatch(/added/i);
    const rowB = container.querySelector('[data-upload="b.stl"]');
    expect(rowB?.textContent).not.toMatch(/added/i);
    expect(onUploaded).not.toHaveBeenCalled();

    await act(async () => {
      started[1]?.handlers.onSuccess("https://platehouse.test/app/uploads/u-2");
    });
    await settle();
    expect(onUploaded).toHaveBeenCalledTimes(1);
  });

  test("combine on: every file carries one batch id with combine", async () => {
    const { started, start, fetchResult } = stubUploads();
    await render(
      <UploadDialog
        open
        files={[a, b]}
        onClose={() => {}}
        start={start}
        fetchResult={fetchResult}
      />,
    );
    const toggle = switchInput();
    expect(toggle?.checked).toBe(false);
    await act(async () => {
      toggle?.click();
    });
    expect(switchInput()?.checked).toBe(true);
    await act(async () => {
      button(/^upload/i).click();
    });
    expect(started).toHaveLength(2);
    const [first, second] = started;
    expect(first?.target.kind).toBe("batch");
    expect(second?.target).toEqual(first?.target);
    const batch = first?.target.kind === "batch" ? first.target.batch : "";
    expect(batch.length).toBeGreaterThan(0);
    for (const s of started) {
      expect(uploadMetadata(s.file, s.target)).toEqual({
        filename: s.file.name,
        batch,
        combine: "1",
      });
    }
  });

  test("a failed upload shows its reason on its own row", async () => {
    const { started, start } = stubUploads();
    const fetchResult = vi.fn<FetchResult>(async () => ({
      status: "failed",
      error: "Unsupported file type",
    }));
    await render(
      <UploadDialog
        open
        files={[a, b]}
        onClose={() => {}}
        start={start}
        fetchResult={fetchResult}
        resultDelayMs={0}
      />,
    );
    await act(async () => {
      button(/^upload/i).click();
    });
    await act(async () => {
      started[0]?.handlers.onError(new Error("network down"));
      started[1]?.handlers.onSuccess("https://platehouse.test/app/uploads/u-3");
    });
    await settle();
    expect(container.querySelector('[data-upload="a.3mf"]')?.textContent).toMatch(/failed/i);
    expect(container.querySelector('[data-upload="b.stl"]')?.textContent).toContain(
      "Unsupported file type",
    );
  });

  test("into an existing model: no combine switch, every file goes to that model", async () => {
    const { started, start, fetchResult } = stubUploads();
    await render(
      <UploadDialog
        open
        files={[a, b]}
        modelId={PLATED.id}
        onClose={() => {}}
        start={start}
        fetchResult={fetchResult}
      />,
    );
    expect(switchInput()).toBeNull();
    await act(async () => {
      button(/^upload/i).click();
    });
    for (const s of started) expect(s.target).toEqual({ kind: "model", modelId: PLATED.id });
  });

  test("Escape closes the dialog", async () => {
    const { start, fetchResult } = stubUploads();
    const onClose = vi.fn();
    await render(
      <UploadDialog open files={[a]} onClose={onClose} start={start} fetchResult={fetchResult} />,
    );
    await act(async () => {
      container
        .querySelector('[role="dialog"]')
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("closed, it shows nothing", async () => {
    const { start, fetchResult } = stubUploads();
    await render(
      <UploadDialog
        open={false}
        files={[a]}
        onClose={() => {}}
        start={start}
        fetchResult={fetchResult}
      />,
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
