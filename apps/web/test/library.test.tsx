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
  failureMessage,
  fetchUploadResult,
  isSupportedFile,
  MAX_UPLOAD_BYTES,
  NOT_CONFIRMED_TEXT,
  SENT_SESSION_ENDED_TEXT,
  type StartUpload,
  UPLOAD_ENDPOINT,
  type UploadHandlers,
  type UploadTarget,
  uploadEndpoint,
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
    numbersUnavailable: false,
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
const UNAVAILABLE = makeCard({
  id: "0198f0c4-0000-7000-8000-000000000005",
  name: "Slicer away",
  plateCount: 2,
  thumbnail: "/blobs/0198f0c4-0000-7000-8000-0000000000a5",
  fileKind: "3mf",
  numbersUnavailable: true,
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

  test("a failed Load more keeps the loaded cards and offers a retry beside the button", async () => {
    let nextFails = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "https://platehouse.test");
        requests.push(`${url.pathname}${url.search}`);
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        if (url.pathname === "/app/api/library/tags") return json({ tags: [] });
        if (url.searchParams.get("cursor") === "c-1") {
          if (nextFails) return new Response("busy", { status: 503 });
          return json({ printer: PRINTER, models: [STL], nextCursor: null });
        }
        return json({ printer: PRINTER, models: [PLATED, PARTIAL], nextCursor: "c-1" });
      }),
    );
    await render(libraryAt("/"));
    expect(cardNames()).toEqual(["Plated box", "Half known"]);
    const pagerButton = () => container.querySelector<HTMLButtonElement>(".studio-pager button");
    expect(pagerButton()?.textContent).toBe("Load more");

    await act(async () => {
      pagerButton()?.click();
    });
    await settle();
    // The cards already loaded stay, and the page-wide failure is not shown.
    expect(cardNames()).toEqual(["Plated box", "Half known"]);
    expect(container.textContent).not.toMatch(/the library could not be loaded/i);
    const alert = container.querySelector('.studio-pager [role="alert"]');
    expect(alert?.textContent).toMatch(/more models could not be loaded/i);
    expect(pagerButton()?.textContent).toBe("Try again");

    // The retry asks for the same next page, not page 1.
    nextFails = false;
    const before = requests.length;
    await act(async () => {
      pagerButton()?.click();
    });
    await settle();
    expect(requests.slice(before)).toEqual(["/app/api/library?cursor=c-1"]);
    expect(cardNames()).toEqual(["Plated box", "Half known", "Bracket"]);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(pagerButton()).toBeNull();
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

  test("the printer menu could not be read: numbers unavailable, not partial", async () => {
    const li = await renderCard(UNAVAILABLE);
    const text = li.textContent ?? "";
    expect(text).toContain("2 plates");
    expect(text).toContain("numbers unavailable");
    expect(text).not.toMatch(/partial/i);
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

/** A drag event carrying these files, as a browser sends one. */
function fileDrag(type: "dragover" | "drop", files: File[], types = ["Files"]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types, files, dropEffect: "none" },
  });
  return event;
}

describe("dropping files on the open upload dialog", () => {
  const noUploads: StartUpload = () => ({ abort: () => {} });

  test("a file dropped on the dialog or its backdrop is added to the list", async () => {
    await render(<UploadDialog open files={[]} onClose={() => {}} start={noUploads} />);
    const dialog = container.querySelector('[role="dialog"]');
    const backdrop = container.querySelector(".ph-dialog-backdrop");
    expect(dialog).not.toBeNull();
    expect(backdrop).not.toBeNull();
    const one = new File(["solid x"], "one.stl");
    const two = new File(["solid y"], "two.stl");
    await act(async () => {
      const over = fileDrag("dragover", []);
      dialog?.dispatchEvent(over);
      expect(over.defaultPrevented).toBe(true);
      dialog?.dispatchEvent(fileDrag("drop", [one]));
    });
    await act(async () => {
      const over = fileDrag("dragover", []);
      backdrop?.dispatchEvent(over);
      expect(over.defaultPrevented).toBe(true);
      const drop = fileDrag("drop", [two]);
      backdrop?.dispatchEvent(drop);
      expect(drop.defaultPrevented).toBe(true);
    });
    expect(container.querySelector('[data-upload="one.stl"]')).not.toBeNull();
    expect(container.querySelector('[data-upload="two.stl"]')).not.toBeNull();
    expect(dialog?.textContent).not.toMatch(/drop them on the library/i);
  });

  test("a file dropped where nothing takes it never reaches the browser", async () => {
    await render(<UploadDialog open={false} files={[]} onClose={() => {}} start={noUploads} />);
    const elsewhere = document.createElement("nav");
    document.body.append(elsewhere);
    try {
      const over = fileDrag("dragover", []);
      elsewhere.dispatchEvent(over);
      expect(over.defaultPrevented).toBe(true);
      const drop = fileDrag("drop", [new File(["x"], "lost.3mf")]);
      elsewhere.dispatchEvent(drop);
      expect(drop.defaultPrevented).toBe(true);
      // Text or a link dragged over the page keeps the browser's own handling.
      const text = fileDrag("drop", [], ["text/plain"]);
      elsewhere.dispatchEvent(text);
      expect(text.defaultPrevented).toBe(false);
    } finally {
      elsewhere.remove();
    }
  });

  test("once the dialog is gone the page no longer stops file drops", async () => {
    await render(<UploadDialog open={false} files={[]} onClose={() => {}} start={noUploads} />);
    await act(async () => root.render(<p>nothing</p>));
    const drop = fileDrag("drop", [new File(["x"], "late.3mf")]);
    document.body.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(false);
  });
});

/** An error as tus-js-client gives one for an answer the server refused. */
/** The Content-Type the tus handler's own refusals carry. */
const TEXT = "text/plain; charset=utf-8";
/** The Content-Type of the session gate's answers (auth/gate.ts). */
const JSON_TYPE = "application/json; charset=utf-8";

function refusal(status: number, body: string, contentType?: string): Error {
  const error = new Error(
    `tus: unexpected response while creating upload, originated from request (method: POST, url: https://platehouse.test/app/uploads, response code: ${status}, response text: ${body}, request id: n/a)`,
  );
  return Object.assign(error, {
    originalRequest: {},
    originalResponse: {
      getStatus: () => status,
      getBody: () => body,
      getHeader: (name: string) =>
        name.toLowerCase() === "content-type" ? contentType : undefined,
    },
  });
}

describe("upload failures read as plain words", () => {
  test("a refusal shows the server's own reason, not tus-js-client's diagnostic", () => {
    const text = failureMessage(
      refusal(415, "Not a supported file type: use .3mf, .stl, .step, .stp or .scad\n", TEXT),
    );
    expect(text).toBe(
      "The upload was refused: Not a supported file type: use .3mf, .stl, .step, .stp or .scad",
    );
    expect(text).not.toMatch(/tus:|originated from|request id/);
  });

  test("413 says the file is too large, whatever the body", () => {
    for (const body of ["Maximum size exceeded\n", "<html><body>413</body></html>"]) {
      const text = failureMessage(refusal(413, body));
      expect(text).toMatch(/too large/i);
      expect(text).toContain("512 MiB");
      expect(text).not.toMatch(/tus:|<html>/);
    }
  });

  test("a body that is not a plain line (a proxy's page) gives a short line for the status", () => {
    expect(failureMessage(refusal(502, "<html><body>Bad Gateway</body></html>"))).toBe(
      "The server could not take the upload right now (HTTP 502). Try again shortly.",
    );
    expect(failureMessage(refusal(403, ""))).toBe("The server refused the upload (HTTP 403).");
  });

  test("a plain-text reason from the tus handler is shown for any 4xx it sends", () => {
    expect(
      failureMessage(
        refusal(400, "Upload-Metadata must carry the file's name as filename\n", TEXT),
      ),
    ).toBe("The upload was refused: Upload-Metadata must carry the file's name as filename");
  });

  test("the session gate's JSON answers never reach the row as JSON", () => {
    // 401: the session ended, or the user signed out in another tab.
    const ended = failureMessage(refusal(401, '{"error":"unauthorized"}', JSON_TYPE));
    expect(ended).toBe("Your session has ended. Sign in again, then add the file again.");
    // 403: the page's Origin is not PUBLIC_ORIGIN (opened by another address).
    expect(failureMessage(refusal(403, '{"error":"forbidden"}', JSON_TYPE))).toBe(
      "The server refused the upload (HTTP 403).",
    );
    // 503: the session store could not be read; a retry line, not a refusal.
    expect(failureMessage(refusal(503, '{"error":"unavailable"}', JSON_TYPE))).toBe(
      "The server could not take the upload right now (HTTP 503). Try again shortly.",
    );
    for (const [status, body] of [
      [401, '{"error":"unauthorized"}'],
      [403, '{"error":"forbidden"}'],
      [503, '{"error":"unavailable"}'],
    ] as const) {
      expect(failureMessage(refusal(status, body, JSON_TYPE))).not.toContain("{");
    }
  });

  test("a JSON body is never shown, whatever its Content-Type says", () => {
    for (const contentType of [JSON_TYPE, TEXT, undefined]) {
      expect(failureMessage(refusal(409, '{"error":"conflict"}', contentType))).toBe(
        "The server refused the upload (HTTP 409).",
      );
    }
  });

  test("a body that is not text/plain is never shown", () => {
    expect(failureMessage(refusal(400, "Bad request", "text/html; charset=utf-8"))).toBe(
      "The server refused the upload (HTTP 400).",
    );
  });

  test("a 5xx gives the retry line even when its body is a plain line", () => {
    expect(failureMessage(refusal(500, "Something went wrong\n", TEXT))).toBe(
      "The server could not take the upload right now (HTTP 500). Try again shortly.",
    );
  });

  test("a lost connection says so, without tus-js-client's diagnostic", () => {
    const lost = Object.assign(
      new Error("tus: failed to upload chunk at offset 0, caused by [object ProgressEvent]"),
      { originalRequest: {}, originalResponse: null },
    );
    expect(failureMessage(lost)).toBe("The upload failed: the connection was lost.");
  });

  test("any other error keeps its message", () => {
    expect(failureMessage(new Error("network down"))).toBe("The upload failed: network down.");
    expect(failureMessage(new Error(""))).toBe("The upload failed: the connection was lost.");
  });
});

describe("the result check after the last byte", () => {
  const UPLOAD = "https://platehouse.test/app/uploads/u-9";

  function answer(status: number, body: unknown) {
    const fetchStub = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchStub);
    return fetchStub;
  }

  test("asks GET <upload>/result and passes its answer on", async () => {
    const fetchStub = answer(200, { status: "done", modelId: STL.id, fileId: "f-1" });
    expect(await fetchUploadResult(UPLOAD)).toEqual({
      status: "done",
      modelId: STL.id,
      fileId: "f-1",
    });
    expect(String(fetchStub.mock.calls[0]?.[0])).toBe(`${UPLOAD}/result`);
  });

  test("503 (the database is busy) is still pending, so it is asked again", async () => {
    answer(503, { error: "unavailable", message: "try again" });
    expect(await fetchUploadResult(UPLOAD)).toEqual({ status: "pending" });
  });

  test("401 (the session ended during ingest) fails the row: the file was sent, sign in and check", async () => {
    answer(401, { error: "unauthorized" });
    expect(await fetchUploadResult(UPLOAD)).toEqual({
      status: "failed",
      error: SENT_SESSION_ENDED_TEXT,
    });
    expect(SENT_SESSION_ENDED_TEXT).toMatch(/sent/i);
    expect(SENT_SESSION_ENDED_TEXT).toMatch(/session has ended/i);
    expect(SENT_SESSION_ENDED_TEXT).toMatch(/sign in/i);
    expect(SENT_SESSION_ENDED_TEXT).toMatch(/check the library/i);
  });

  test("404 (an upload the server no longer knows) says it could not be confirmed, at once", async () => {
    answer(404, { error: "not_found" });
    expect(await fetchUploadResult(UPLOAD)).toEqual({
      status: "failed",
      error: NOT_CONFIRMED_TEXT,
    });
    expect(NOT_CONFIRMED_TEXT).toBe(
      "The upload could not be confirmed; check the library before sending it again.",
    );
  });

  test("any other refusal is not waited on either", async () => {
    for (const status of [400, 403, 500, 502]) {
      answer(status, { error: "x" });
      expect(await fetchUploadResult(UPLOAD), String(status)).toEqual({
        status: "failed",
        error: NOT_CONFIRMED_TEXT,
      });
    }
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
    expect(UPLOAD_ENDPOINT).toBe("/app/uploads");
    // Absolute on the page's own origin: tus-js-client resolves the upload's
    // Location with new URL(location, endpoint), which throws for a
    // relative endpoint.
    const endpoint = new URL(options.endpoint);
    expect(endpoint.origin).toBe(window.location.origin);
    expect(endpoint.pathname).toBe("/app/uploads");
    expect(endpoint.search).toBe("");
    expect(new URL("/app/uploads/0198f0c4", options.endpoint).pathname).toBe(
      "/app/uploads/0198f0c4",
    );
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
    const prints = targets.map((t) => uploadFingerprint(file, t, uploadEndpoint()));
    expect(new Set(prints).size).toBe(targets.length);
    // The same file to the same target resumes.
    expect(uploadFingerprint(file, { kind: "new" }, uploadEndpoint())).toBe(prints[0]);
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

  test("combine on: files added while a round is sending join the same batch", async () => {
    const { started, start, fetchResult } = stubUploads();
    const c = new File([new Uint8Array(300)], "c.step");
    const dialog = (files: File[]) => (
      <UploadDialog open files={files} onClose={() => {}} start={start} fetchResult={fetchResult} />
    );
    await render(dialog([a, b]));
    await act(async () => {
      switchInput()?.click();
    });
    await act(async () => {
      button(/^upload/i).click();
    });
    expect(started).toHaveLength(2);
    // The first round is still sending; a third file is added and sent.
    await render(dialog([c]));
    expect(switchInput()?.checked).toBe(true);
    await act(async () => {
      button(/^upload 1 file/i).click();
    });
    expect(started.map((s) => s.file.name)).toEqual(["a.3mf", "b.stl", "c.step"]);
    expect(started[0]?.target.kind).toBe("batch");
    for (const s of started) expect(s.target).toEqual(started[0]?.target);
  });

  test("combine on: closing the dialog ends the batch, so the next one is a new model", async () => {
    const { started, start, fetchResult } = stubUploads();
    const dialog = (open: boolean, files: File[]) => (
      <UploadDialog
        open={open}
        files={files}
        onClose={() => {}}
        start={start}
        fetchResult={fetchResult}
        resultDelayMs={0}
      />
    );
    const round1 = [a];
    await render(dialog(true, round1));
    await act(async () => {
      switchInput()?.click();
    });
    await act(async () => {
      button(/^upload/i).click();
    });
    await act(async () => {
      started[0]?.handlers.onSuccess("https://platehouse.test/app/uploads/u-4");
    });
    await settle();
    await act(async () => {
      button(/^close$/i).click();
    });
    await render(dialog(false, round1));
    await render(dialog(true, [b]));
    await act(async () => {
      switchInput()?.click();
    });
    await act(async () => {
      button(/^upload/i).click();
    });
    expect(started.map((s) => s.file.name)).toEqual(["a.3mf", "b.stl"]);
    expect(started[0]?.target.kind).toBe("batch");
    expect(started[1]?.target.kind).toBe("batch");
    expect(started[1]?.target).not.toEqual(started[0]?.target);
  });

  test("combine on: a round that finishes while the dialog is hidden ends the batch", async () => {
    const { started, start, fetchResult } = stubUploads();
    const dialog = (open: boolean, files: File[]) => (
      <UploadDialog
        open={open}
        files={files}
        onClose={() => {}}
        start={start}
        fetchResult={fetchResult}
        resultDelayMs={0}
      />
    );
    const round1 = [a];
    await render(dialog(true, round1));
    await act(async () => {
      switchInput()?.click();
    });
    await act(async () => {
      button(/^upload/i).click();
    });
    // Still sending: Hide only hides it.
    await act(async () => {
      button(/^hide$/i).click();
    });
    await render(dialog(false, round1));
    // The round finishes while the dialog is hidden.
    await act(async () => {
      started[0]?.handlers.onSuccess("https://platehouse.test/app/uploads/u-5");
    });
    await settle();
    // Opened again later with a new file: the switch is off and the old row is gone.
    await render(dialog(true, [b]));
    expect(switchInput()?.checked).toBe(false);
    expect(container.querySelector('[data-upload="a.3mf"]')).toBeNull();
    expect(container.querySelector('[data-upload="b.stl"]')).not.toBeNull();
    await act(async () => {
      button(/^upload/i).click();
    });
    expect(started.map((s) => s.file.name)).toEqual(["a.3mf", "b.stl"]);
    expect(started[1]?.target).toEqual({ kind: "new" });
  });

  test("combine on: a file that fails while the dialog is hidden keeps its row and reason", async () => {
    const { started, start, fetchResult } = stubUploads();
    const c = new File([new Uint8Array(300)], "c.step");
    const d = new File([new Uint8Array(400)], "d.scad");
    const dialog = (open: boolean, files: File[]) => (
      <UploadDialog
        open={open}
        files={files}
        onClose={() => {}}
        start={start}
        fetchResult={fetchResult}
        resultDelayMs={0}
      />
    );
    const round1 = [a, b];
    await render(dialog(true, round1));
    await act(async () => {
      switchInput()?.click();
    });
    await act(async () => {
      button(/^upload/i).click();
    });
    await act(async () => {
      button(/^hide$/i).click();
    });
    await render(dialog(false, round1));
    // A file added while hidden is listed and not sent.
    const added = [c];
    await render(dialog(false, added));
    // One file fails and one goes in while the dialog is hidden.
    await act(async () => {
      started[0]?.handlers.onError(new Error("network down"));
      started[1]?.handlers.onSuccess("https://platehouse.test/app/uploads/u-8");
    });
    await settle();
    // Opened again: the batch has ended, the failed row is there with its
    // reason, the unsent row is there, and the row that went in is gone.
    const round2 = [d];
    await render(dialog(true, round2));
    expect(switchInput()?.checked).toBe(false);
    expect(container.querySelector('[data-upload="a.3mf"]')?.textContent).toContain(
      "The upload failed: network down.",
    );
    expect(container.querySelector('[data-upload="b.stl"]')).toBeNull();
    expect(container.querySelector('[data-upload="c.step"]')?.textContent).toContain("Ready");
    expect(container.querySelector('[data-upload="d.scad"]')).not.toBeNull();
    await act(async () => {
      button(/^upload 2 files/i).click();
    });
    expect(started.map((s) => s.file.name)).toEqual(["a.3mf", "b.stl", "c.step", "d.scad"]);
    expect(started[2]?.target).toEqual({ kind: "new" });
    expect(started[3]?.target).toEqual({ kind: "new" });
    await act(async () => {
      started[2]?.handlers.onSuccess("https://platehouse.test/app/uploads/u-9");
      started[3]?.handlers.onSuccess("https://platehouse.test/app/uploads/u-10");
    });
    await settle();
    // Closed with nothing in flight: only now is the failed row cleared.
    await act(async () => {
      button(/^close$/i).click();
    });
    await render(dialog(false, round2));
    await render(dialog(true, round2));
    expect(container.querySelector('[data-upload="a.3mf"]')).toBeNull();
    expect(container.textContent).toContain("No files yet");
  });

  test("combine on: a round that finishes while the dialog is open keeps the batch until Close", async () => {
    const { started, start, fetchResult } = stubUploads();
    const c = new File([new Uint8Array(300)], "c.step");
    const dialog = (files: File[]) => (
      <UploadDialog
        open
        files={files}
        onClose={() => {}}
        start={start}
        fetchResult={fetchResult}
        resultDelayMs={0}
      />
    );
    await render(dialog([a]));
    await act(async () => {
      switchInput()?.click();
    });
    await act(async () => {
      button(/^upload/i).click();
    });
    await act(async () => {
      started[0]?.handlers.onSuccess("https://platehouse.test/app/uploads/u-6");
    });
    await settle();
    await render(dialog([c]));
    expect(switchInput()?.checked).toBe(true);
    await act(async () => {
      button(/^upload 1 file/i).click();
    });
    expect(started[1]?.target).toEqual(started[0]?.target);
  });

  describe("the row while the result is asked for", () => {
    const UPLOAD = "https://platehouse.test/app/uploads/u-7";

    /** A fetch that answers GET <upload>/result with these statuses in turn, then done. */
    function resultAnswers(statuses: number[]) {
      const queue = [...statuses];
      const fetchStub = vi.fn(async () => {
        const status = queue.shift();
        if (status === undefined) {
          return new Response(JSON.stringify({ status: "done", modelId: STL.id }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ error: "x" }), {
          status,
          headers: { "content-type": "application/json" },
        });
      });
      vi.stubGlobal("fetch", fetchStub);
      return fetchStub;
    }

    async function sendOne() {
      const { started, start } = stubUploads();
      await render(
        <UploadDialog open files={[a]} onClose={() => {}} start={start} resultDelayMs={0} />,
      );
      await act(async () => {
        button(/^upload/i).click();
      });
      await act(async () => {
        started[0]?.handlers.onSuccess(UPLOAD);
      });
      await settle();
      return container.querySelector('[data-upload="a.3mf"]')?.textContent ?? "";
    }

    test("an ended session says the file was sent and to sign in, not to wait", async () => {
      const fetchStub = resultAnswers([401]);
      expect(await sendOne()).toContain(SENT_SESSION_ENDED_TEXT);
      expect(fetchStub).toHaveBeenCalledTimes(1);
    });

    test("an upload the server no longer knows says it could not be confirmed, at once", async () => {
      const fetchStub = resultAnswers([404]);
      expect(await sendOne()).toContain(NOT_CONFIRMED_TEXT);
      expect(fetchStub).toHaveBeenCalledTimes(1);
    });

    test("a busy server (503) is asked again until the result comes", async () => {
      const fetchStub = resultAnswers([503, 503]);
      expect(await sendOne()).toMatch(/added/i);
      expect(fetchStub).toHaveBeenCalledTimes(3);
    });
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

  test("a refused upload shows the server's reason on its row", async () => {
    const { started, start, fetchResult } = stubUploads();
    await render(
      <UploadDialog open files={[a]} onClose={() => {}} start={start} fetchResult={fetchResult} />,
    );
    await act(async () => {
      button(/^upload/i).click();
    });
    await act(async () => {
      started[0]?.handlers.onError(refusal(400, "Give modelId or batch, not both\n"));
    });
    const row = container.querySelector('[data-upload="a.3mf"]')?.textContent ?? "";
    expect(row).toContain("The upload was refused: Give modelId or batch, not both");
    expect(row).not.toMatch(/tus:|originated from/);
  });

  test("a file over the server's 512 MiB limit is listed with the reason and never sent", async () => {
    const { started, start, fetchResult } = stubUploads();
    const huge = new File([new Uint8Array(1)], "huge.3mf");
    Object.defineProperty(huge, "size", { value: MAX_UPLOAD_BYTES + 1 });
    const limit = new File([new Uint8Array(1)], "limit.3mf");
    Object.defineProperty(limit, "size", { value: MAX_UPLOAD_BYTES });
    await render(
      <UploadDialog
        open
        files={[huge, limit]}
        onClose={() => {}}
        start={start}
        fetchResult={fetchResult}
      />,
    );
    expect(MAX_UPLOAD_BYTES).toBe(512 * 1024 * 1024);
    const row = container.querySelector('[data-upload="huge.3mf"]')?.textContent ?? "";
    expect(row).toMatch(/too large/i);
    expect(row).toContain("512 MiB");
    await act(async () => {
      button(/^upload/i).click();
    });
    expect(started.map((s) => s.file.name)).toEqual(["limit.3mf"]);
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

  describe("keyboard after a click on the backdrop", () => {
    /** A control behind the dialog, as the shell's sidebar and top bar are. */
    let behind: HTMLButtonElement;

    beforeEach(() => {
      behind = document.createElement("button");
      behind.textContent = "Sidebar link";
      document.body.append(behind);
    });

    afterEach(() => {
      behind.remove();
    });

    function dialogEl(): HTMLElement {
      const el = container.querySelector<HTMLElement>('[role="dialog"]');
      if (el === null) throw new Error("the dialog is not open");
      return el;
    }

    function press(target: EventTarget, key: string, shiftKey = false): KeyboardEvent {
      const event = new KeyboardEvent("keydown", {
        key,
        shiftKey,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(event);
      return event;
    }

    test("pressing the backdrop keeps focus in the dialog", async () => {
      const { start, fetchResult } = stubUploads();
      await render(
        <UploadDialog
          open
          files={[a]}
          onClose={() => {}}
          start={start}
          fetchResult={fetchResult}
        />,
      );
      const backdrop = container.querySelector<HTMLElement>(".ph-dialog-backdrop");
      if (backdrop === null) throw new Error("no backdrop");
      (document.activeElement as HTMLElement | null)?.blur();
      const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      await act(async () => {
        backdrop.dispatchEvent(down);
      });
      expect(down.defaultPrevented).toBe(true);
      expect(dialogEl().contains(document.activeElement)).toBe(true);
    });

    test("Escape closes it with focus outside the dialog", async () => {
      const { start, fetchResult } = stubUploads();
      const onClose = vi.fn();
      await render(
        <UploadDialog open files={[a]} onClose={onClose} start={start} fetchResult={fetchResult} />,
      );
      (document.activeElement as HTMLElement | null)?.blur();
      expect(dialogEl().contains(document.activeElement)).toBe(false);
      await act(async () => {
        press(document.body, "Escape");
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    test("Tab from behind the dialog goes back into it, never into the shell", async () => {
      const { start, fetchResult } = stubUploads();
      await render(
        <UploadDialog
          open
          files={[a]}
          onClose={() => {}}
          start={start}
          fetchResult={fetchResult}
        />,
      );
      behind.focus();
      let tab: KeyboardEvent | undefined;
      await act(async () => {
        tab = press(behind, "Tab");
      });
      expect(tab?.defaultPrevented).toBe(true);
      expect(dialogEl().contains(document.activeElement)).toBe(true);
      expect(document.activeElement).toBe(button(/choose files/i));

      behind.focus();
      await act(async () => {
        tab = press(behind, "Tab", true);
      });
      expect(tab?.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(button(/^upload/i));
    });

    test("closed, it leaves the page's keys alone", async () => {
      const { start, fetchResult } = stubUploads();
      const onClose = vi.fn();
      await render(
        <UploadDialog
          open={false}
          files={[a]}
          onClose={onClose}
          start={start}
          fetchResult={fetchResult}
        />,
      );
      behind.focus();
      let tab: KeyboardEvent | undefined;
      await act(async () => {
        press(document.body, "Escape");
        tab = press(behind, "Tab");
      });
      expect(onClose).not.toHaveBeenCalled();
      expect(tab?.defaultPrevented).toBe(false);
    });
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
