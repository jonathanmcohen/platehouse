// @vitest-environment jsdom
// Duplicate files in the upload dialog (approved for 0.1.0 by the maintainer,
// 2026-11-19). Every file is sent with duplicates skip, so the server
// refuses a file whose SHA-256 a live model already holds and stores
// nothing. The dialog says up front that such a file is skipped; a skipped
// row names the model that holds it with a link to it, and offers Import
// anyway, which sends that one file again, to the same target, with
// duplicates allow. A file only a trashed model holds is not a duplicate:
// the server stores it and the row reads Added (the server side of that is
// tested in apps/server/test/integration/uploads/tus.test.ts).
//
// Many files, slow imports and failures: three files are sent at a time,
// the rest wait their turn (and are only created on the server when it
// comes); a finished file's result is asked for patiently, backing off, and
// only repeated errors give up; tus-js-client does not resend a refusal that
// will not change (507, 429) or while the browser is offline; a failed row
// offers Retry, rows that lost the connection start again when it comes
// back, and leaving the page while files are sending asks first.
//
// The tus upload and the result check are stubs, as in library.test.tsx.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import type { HttpResponse } from "tus-js-client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { UploadDialog } from "../src/upload/UploadDialog";
import {
  type DuplicatePolicy,
  type FetchResult,
  makeFetchUploadResult,
  RESULT_BACKOFF_MS,
  resultWaitMs,
  type StartUpload,
  UPLOAD_POOL,
  type UploadHandlers,
  type UploadResult,
  type UploadTarget,
  uploadEndpoint,
  uploadFingerprint,
  uploadMetadata,
  uploadOptions,
} from "../src/upload/useTusUpload";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HOLDER = {
  modelId: "0198f0c4-0000-7000-8000-00000000000a",
  modelName: "Benchy",
  fileId: "0198f0c4-0000-7000-8000-0000000000fa",
  fileName: "Benchy.3mf",
};
const NEW_MODEL = "0198f0c4-0000-7000-8000-00000000000b";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(node: ReactNode) {
  await act(async () => {
    root.render(node);
  });
  await settle();
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

interface Started {
  file: File;
  target: UploadTarget;
  handlers: UploadHandlers;
  duplicates: DuplicatePolicy | undefined;
}

/**
 * A tus stub that records each start, and a result check that answers from
 * answer (by the policy the upload was sent with). finish() reports the last
 * byte of a started upload.
 */
function stubUploads(answer: (s: Started) => UploadResult) {
  const started: Started[] = [];
  const byUrl = new Map<string, Started>();
  const start: StartUpload = (file, target, handlers, duplicates) => {
    started.push({ file, target, handlers, duplicates });
    return { abort: () => {} };
  };
  const fetchResult = vi.fn<FetchResult>(async (url) => {
    const s = byUrl.get(url);
    if (s === undefined) throw new Error(`no upload at ${url}`);
    return answer(s);
  });
  async function finish(index: number) {
    const s = started[index];
    if (s === undefined) throw new Error(`upload ${index} was not started`);
    const url = `https://platehouse.test/app/uploads/u${index}`;
    byUrl.set(url, s);
    await act(async () => {
      s.handlers.onProgress(s.file.size, s.file.size);
      s.handlers.onSuccess(url);
    });
    await settle();
  }
  /** Reports a started upload's failure, as tus-js-client's onError does. */
  async function fail(index: number, error: Error) {
    const s = started[index];
    if (s === undefined) throw new Error(`upload ${index} was not started`);
    await act(async () => s.handlers.onError(error));
    await settle();
  }
  return { started, start, fetchResult, finish, fail };
}

/** An answer as tus-js-client hands it over (its HttpResponse). */
function answered(status: number, body = ""): HttpResponse {
  return {
    getStatus: () => status,
    getHeader: () => undefined,
    getBody: () => body,
    getUnderlyingObject: () => null,
  };
}

/** tus-js-client's DetailedError for a request the server answered with status. */
function refusedWith(status: number): Error {
  return Object.assign(new Error(`tus: unexpected response, status ${status}`), {
    originalRequest: {},
    originalResponse: answered(status),
  });
}

/** tus-js-client's DetailedError for a request that got no answer. */
function connectionLost(): Error {
  return Object.assign(new Error("tus: failed to upload chunk"), {
    originalRequest: {},
    originalResponse: null,
  });
}

/** Settles until check() holds, or fails after many rounds. */
async function until(check: () => boolean) {
  for (let i = 0; i < 400; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error("the condition never held");
}

/** The server's answers: the duplicate refused under skip, stored under allow. */
const duplicateUnlessAllowed = (s: Started): UploadResult =>
  s.duplicates === "allow"
    ? { status: "done", modelId: NEW_MODEL, fileId: "f-new", duplicates: [HOLDER] }
    : {
        status: "failed",
        error: `This file is already in the library, in the model "Benchy" (id ${HOLDER.modelId}), so it was skipped; nothing was saved`,
        code: "duplicate",
        duplicates: [HOLDER],
      };

function button(label: RegExp): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((el) =>
    label.test(el.textContent ?? ""),
  );
  if (found === undefined) throw new Error(`no button ${label}`);
  return found;
}

const hasButton = (label: RegExp) =>
  [...container.querySelectorAll("button")].some((el) => label.test(el.textContent ?? ""));

/** A row's status as it is drawn: without the file name that is only there for a screen reader. */
function visibleStatus(el: Element | null): string | undefined {
  if (el === null) return undefined;
  const copy = el.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll(".studio-visually-hidden")) hidden.remove();
  return copy.textContent ?? "";
}

function rowOf(name: string): HTMLElement {
  const row = container.querySelector<HTMLElement>(`[data-upload="${name}"]`);
  if (row === null) throw new Error(`no row for ${name}`);
  return row;
}

/** Shows the path the router is at, so a test can see a link was followed. */
function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

function inRouter(node: ReactNode) {
  return (
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="*" element={<Where />} />
      </Routes>
      {node}
    </MemoryRouter>
  );
}

const benchy = new File([new Uint8Array(100)], "Benchy (2).3mf");
const fresh = new File([new Uint8Array(50)], "Fresh.stl");

describe("the tus options carry the duplicates choice", () => {
  const file = new File([new Uint8Array(10)], "Air Dry - AMS.3mf", { lastModified: 1_700_000 });

  test("skip unless asked otherwise, for every target", () => {
    expect(uploadMetadata(file, { kind: "new" })).toEqual({
      filename: file.name,
      duplicates: "skip",
    });
    expect(uploadMetadata(file, { kind: "batch", batch: "b-1" }, "allow")).toEqual({
      filename: file.name,
      batch: "b-1",
      combine: "1",
      duplicates: "allow",
    });
    const handlers: UploadHandlers = { onProgress() {}, onSuccess() {}, onError() {} };
    expect(uploadOptions(file, { kind: "new" }, handlers).metadata?.duplicates).toBe("skip");
    expect(
      uploadOptions(file, { kind: "new" }, handlers, () => null, "allow").metadata?.duplicates,
    ).toBe("allow");
  });

  test("Import anyway never resumes the skipped upload: its fingerprint differs", async () => {
    const skip = uploadFingerprint(file, { kind: "new" }, uploadEndpoint());
    const allow = uploadFingerprint(file, { kind: "new" }, uploadEndpoint(), "allow");
    expect(allow).not.toBe(skip);
    const handlers: UploadHandlers = { onProgress() {}, onSuccess() {}, onError() {} };
    const options = uploadOptions(file, { kind: "new" }, handlers, () => null, "allow");
    expect(await options.fingerprint?.(file, options)).toBe(allow);
  });
});

describe("the upload dialog and duplicates", () => {
  test("it says plainly that a file already in the library is skipped", async () => {
    const { start, fetchResult } = stubUploads(duplicateUnlessAllowed);
    await render(
      inRouter(
        <UploadDialog open files={[]} onClose={() => {}} start={start} fetchResult={fetchResult} />,
      ),
    );
    const text = container.querySelector('[role="dialog"]')?.textContent ?? "";
    expect(text).toMatch(/already in the library is skipped/i);
    expect(text).toMatch(/Import anyway/);
  });

  test("every file is sent with duplicates skip", async () => {
    const { started, start, fetchResult } = stubUploads(duplicateUnlessAllowed);
    await render(
      inRouter(
        <UploadDialog
          open
          files={[benchy, fresh]}
          onClose={() => {}}
          start={start}
          fetchResult={fetchResult}
        />,
      ),
    );
    await act(async () => button(/^upload 2 files/i).click());
    expect(started.map((s) => s.duplicates)).toEqual(["skip", "skip"]);
  });

  test("a duplicate is flagged: the model is named and linked, and Import anyway is offered", async () => {
    const { start, fetchResult, finish } = stubUploads(duplicateUnlessAllowed);
    await render(
      inRouter(
        <UploadDialog
          open
          files={[benchy]}
          onClose={() => {}}
          start={start}
          fetchResult={fetchResult}
        />,
      ),
    );
    await act(async () => button(/^upload 1 file/i).click());
    await finish(0);

    const row = rowOf("Benchy (2).3mf");
    expect(row.textContent).toMatch(/Skipped/);
    expect(row.textContent).toMatch(/already in the library/i);
    const link = row.querySelector<HTMLAnchorElement>("a");
    expect(link?.textContent).toBe("Benchy");
    expect(link?.getAttribute("href")).toBe(`/models/${HOLDER.modelId}`);
    expect(hasButton(/^import anyway$/i)).toBe(true);
    // Its name says which file, as a list of skipped rows needs.
    expect(button(/^import anyway$/i).getAttribute("aria-label")).toBe(
      "Import anyway: Benchy (2).3mf",
    );
    // Not drawn as an error: nothing went wrong.
    expect(row.querySelector(".ph-upload-status-bad")).toBeNull();
  });

  test("the link opens the model page in the app and hides the dialog", async () => {
    const { start, fetchResult, finish } = stubUploads(duplicateUnlessAllowed);
    const onClose = vi.fn();
    await render(
      inRouter(
        <UploadDialog
          open
          files={[benchy]}
          onClose={onClose}
          start={start}
          fetchResult={fetchResult}
        />,
      ),
    );
    await act(async () => button(/^upload 1 file/i).click());
    await finish(0);
    await act(async () => rowOf("Benchy (2).3mf").querySelector("a")?.click());
    expect(container.querySelector('[data-testid="where"]')?.textContent).toBe(
      `/models/${HOLDER.modelId}`,
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("following the link closes the dialog as Close does: the rows clear and the combined batch ends", async () => {
    const answer = (s: Started): UploadResult =>
      s.file === benchy
        ? duplicateUnlessAllowed(s)
        : { status: "done", modelId: NEW_MODEL, fileId: "f-new", duplicates: [] };
    const { started, start, fetchResult, finish } = stubUploads(answer);
    const later = new File([new Uint8Array(30)], "Later.stl");
    const dialog = (open: boolean, files: File[]) =>
      inRouter(
        <UploadDialog
          open={open}
          files={files}
          onClose={() => {}}
          start={start}
          fetchResult={fetchResult}
        />,
      );
    const round1 = [benchy, fresh];
    await render(dialog(true, round1));
    await act(async () => {
      (container.querySelector('input[role="switch"]') as HTMLInputElement).click();
    });
    await act(async () => button(/^upload 2 files/i).click());
    await finish(0);
    await finish(1);
    expect(rowOf("Benchy (2).3mf").textContent).toMatch(/Skipped/);
    expect(started[0]?.target.kind).toBe("batch");

    await act(async () => rowOf("Benchy (2).3mf").querySelector("a")?.click());
    await render(dialog(false, round1));
    await render(dialog(true, [later]));

    // Opened again: only the new file is listed and the switch is off, so
    // the new file is not put into the previous round's combined model.
    expect(container.querySelector('[data-upload="Benchy (2).3mf"]')).toBeNull();
    expect(container.querySelector('[data-upload="Fresh.stl"]')).toBeNull();
    expect(rowOf("Later.stl")).toBeTruthy();
    expect((container.querySelector('input[role="switch"]') as HTMLInputElement).checked).toBe(
      false,
    );
    await act(async () => button(/^upload 1 file/i).click());
    expect(started).toHaveLength(3);
    expect(started[2]?.file).toBe(later);
    expect(started[2]?.target).toEqual({ kind: "new" });
  });

  test("more than one model holds it: the first is linked and the others counted", async () => {
    const other = { ...HOLDER, modelId: NEW_MODEL, modelName: "Other", fileId: "f-2" };
    const { start, fetchResult, finish } = stubUploads(() => ({
      status: "failed",
      error: "already",
      code: "duplicate",
      duplicates: [HOLDER, { ...HOLDER, fileId: "f-3" }, other],
    }));
    await render(
      inRouter(
        <UploadDialog
          open
          files={[benchy]}
          onClose={() => {}}
          start={start}
          fetchResult={fetchResult}
        />,
      ),
    );
    await act(async () => button(/^upload 1 file/i).click());
    await finish(0);
    const row = rowOf("Benchy (2).3mf");
    expect(row.querySelectorAll("a")).toHaveLength(1);
    expect(row.textContent).toMatch(/and 1 other model/);
  });

  test("Import anyway sends that file again, to the same target, with duplicates allow", async () => {
    const { started, start, fetchResult, finish } = stubUploads(duplicateUnlessAllowed);
    const onUploaded = vi.fn();
    await render(
      inRouter(
        <UploadDialog
          open
          files={[benchy, fresh]}
          onClose={() => {}}
          onUploaded={onUploaded}
          start={start}
          fetchResult={fetchResult}
        />,
      ),
    );
    await act(async () => {
      (container.querySelector('input[role="switch"]') as HTMLInputElement).click();
    });
    await act(async () => button(/^upload 2 files/i).click());
    await finish(0);
    // fresh is still sending; its own answer is not a duplicate.
    expect(started[1]?.file.name).toBe("Fresh.stl");

    const importAnyway = button(/^import anyway$/i);
    importAnyway.focus();
    await act(async () => importAnyway.click());
    // The button is gone with the skipped state; focus stays on the row's status.
    expect(document.activeElement).toBe(rowOf("Benchy (2).3mf").querySelector(".ph-upload-status"));
    expect(started).toHaveLength(3);
    expect(started[2]?.file).toBe(benchy);
    expect(started[2]?.duplicates).toBe("allow");
    expect(started[2]?.target).toEqual(started[0]?.target);
    expect(started[2]?.target.kind).toBe("batch");
    expect(rowOf("Benchy (2).3mf").textContent).not.toMatch(/Skipped/);

    await finish(2);
    expect(rowOf("Benchy (2).3mf").textContent).toMatch(/Added/);
    expect(hasButton(/^import anyway$/i)).toBe(false);
    expect(onUploaded).not.toHaveBeenCalled();
    await finish(1);
    expect(onUploaded).toHaveBeenCalledTimes(1);
  });

  test("a skipped file counts as finished, so the page is told the round is over", async () => {
    const { start, fetchResult, finish } = stubUploads(duplicateUnlessAllowed);
    const onUploaded = vi.fn();
    await render(
      inRouter(
        <UploadDialog
          open
          files={[benchy]}
          onClose={() => {}}
          onUploaded={onUploaded}
          start={start}
          fetchResult={fetchResult}
        />,
      ),
    );
    await act(async () => button(/^upload 1 file/i).click());
    await finish(0);
    expect(onUploaded).toHaveBeenCalledTimes(1);
    expect(button(/^close$/i)).toBeDefined();
  });

  test("a file only a trashed model held is stored: the row reads Added, with nothing to choose", async () => {
    // The server does not count a trashed copy, so it answers done.
    const { start, fetchResult, finish } = stubUploads(() => ({
      status: "done",
      modelId: NEW_MODEL,
      fileId: "f-new",
      duplicates: [],
    }));
    await render(
      inRouter(
        <UploadDialog
          open
          files={[benchy]}
          onClose={() => {}}
          start={start}
          fetchResult={fetchResult}
        />,
      ),
    );
    await act(async () => button(/^upload 1 file/i).click());
    await finish(0);
    expect(rowOf("Benchy (2).3mf").textContent).toMatch(/Added/);
    expect(rowOf("Benchy (2).3mf").textContent).not.toMatch(/Skipped/);
    expect(hasButton(/^import anyway$/i)).toBe(false);
  });

  test("a failure that is not a duplicate is still an error, with no Import anyway", async () => {
    const { start, fetchResult, finish } = stubUploads(() => ({
      status: "failed",
      error: "Storage is unavailable right now; nothing was saved",
    }));
    await render(
      inRouter(
        <UploadDialog
          open
          files={[benchy]}
          onClose={() => {}}
          start={start}
          fetchResult={fetchResult}
        />,
      ),
    );
    await act(async () => button(/^upload 1 file/i).click());
    await finish(0);
    expect(visibleStatus(rowOf("Benchy (2).3mf").querySelector(".ph-upload-status-bad"))).toBe(
      "Storage is unavailable right now; nothing was saved",
    );
    expect(hasButton(/^import anyway$/i)).toBe(false);
  });

  test("outside a router the model link is a plain link to the same page", async () => {
    const { start, fetchResult, finish } = stubUploads(duplicateUnlessAllowed);
    await render(
      <UploadDialog
        open
        files={[benchy]}
        onClose={() => {}}
        start={start}
        fetchResult={fetchResult}
      />,
    );
    await act(async () => button(/^upload 1 file/i).click());
    await finish(0);
    expect(rowOf("Benchy (2).3mf").querySelector("a")?.getAttribute("href")).toBe(
      `/models/${HOLDER.modelId}`,
    );
  });
});

describe("many files, slow imports and failures", () => {
  const files = (count: number) =>
    Array.from(
      { length: count },
      (_, i) => new File([new Uint8Array(10 + i)], `Part ${i + 1}.stl`),
    );
  const added = (): UploadResult => ({ status: "done", modelId: NEW_MODEL, fileId: "f-new" });

  test("dropping 5 files starts 3; the 4th starts when one succeeds; the round ends when all 5 settle", async () => {
    expect(UPLOAD_POOL).toBe(3);
    const five = files(5);
    const { started, start, fetchResult, finish } = stubUploads(added);
    const onUploaded = vi.fn();
    await render(
      inRouter(
        <UploadDialog
          open
          files={five}
          onClose={() => {}}
          onUploaded={onUploaded}
          start={start}
          fetchResult={fetchResult}
        />,
      ),
    );
    await act(async () => button(/^upload 5 files/i).click());
    expect(started.map((s) => s.file.name)).toEqual(["Part 1.stl", "Part 2.stl", "Part 3.stl"]);
    // The two still to go wait their turn, and say so.
    expect(rowOf("Part 4.stl").textContent).toMatch(/Waiting/);
    expect(rowOf("Part 5.stl").textContent).toMatch(/Waiting/);
    expect(rowOf("Part 1.stl").textContent).not.toMatch(/Waiting/);

    await finish(0);
    expect(started.map((s) => s.file.name)).toEqual([
      "Part 1.stl",
      "Part 2.stl",
      "Part 3.stl",
      "Part 4.stl",
    ]);
    expect(rowOf("Part 4.stl").textContent).not.toMatch(/Waiting/);
    expect(rowOf("Part 5.stl").textContent).toMatch(/Waiting/);

    await finish(1);
    expect(started).toHaveLength(5);
    await finish(2);
    await finish(3);
    expect(onUploaded).not.toHaveBeenCalled();
    await finish(4);
    expect(onUploaded).toHaveBeenCalledTimes(1);
    for (const file of five) expect(rowOf(file.name).textContent).toMatch(/Added/);
  });

  test("an import that stays pending is waited for: 30 pending answers, a minute apart, then done", async () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let checks = 0;
    const { start, fetchResult, finish } = stubUploads(() => {
      checks += 1;
      now += 60_000;
      return checks <= 30 ? { status: "pending" } : added();
    });
    await render(
      inRouter(
        <UploadDialog
          open
          files={[fresh]}
          onClose={() => {}}
          start={start}
          fetchResult={fetchResult}
          resultDelayMs={0}
        />,
      ),
    );
    await act(async () => button(/^upload 1 file/i).click());
    await finish(0);
    await until(() => /Added|could not be confirmed/.test(rowOf("Fresh.stl").textContent ?? ""));
    expect(rowOf("Fresh.stl").textContent).toMatch(/Added/);
    expect(checks).toBe(31);
  });

  test("the result is asked for after 1 s, 5 s, then every 15 s, unless a test sets the wait", () => {
    expect(RESULT_BACKOFF_MS).toEqual([1000, 5000, 15000]);
    expect([0, 1, 2, 3, 4, 20].map((attempt) => resultWaitMs(attempt))).toEqual([
      1000, 5000, 15000, 15000, 15000, 15000,
    ]);
    expect([0, 1, 5].map((attempt) => resultWaitMs(attempt, 7))).toEqual([7, 7, 7]);
  });

  async function sendOne(fetchResult: FetchResult) {
    const stub = stubUploads(added);
    await render(
      inRouter(
        <UploadDialog
          open
          files={[fresh]}
          onClose={() => {}}
          start={stub.start}
          fetchResult={fetchResult}
          resultDelayMs={0}
        />,
      ),
    );
    await act(async () => button(/^upload 1 file/i).click());
    await stub.finish(0);
    await until(() => /Added|could not be confirmed/.test(rowOf("Fresh.stl").textContent ?? ""));
    return rowOf("Fresh.stl").textContent ?? "";
  }

  test("5 thrown errors in a row give up as not confirmed", async () => {
    let calls = 0;
    const text = await sendOne(async () => {
      calls += 1;
      if (calls <= 5) throw new TypeError("Failed to fetch");
      return added();
    });
    expect(text).toMatch(/could not be confirmed/);
    expect(calls).toBe(5);
  });

  test("4 thrown errors, a pending answer and 4 more errors are not 5 in a row", async () => {
    let calls = 0;
    const text = await sendOne(async () => {
      calls += 1;
      if (calls === 5) return { status: "pending" };
      if (calls <= 9) throw new TypeError("Failed to fetch");
      return added();
    });
    expect(text).toMatch(/Added/);
    expect(calls).toBe(10);
  });

  test("answers of 502, 504 and 429 are errors to ask again, and 5 in a row give up", async () => {
    const statuses = [502, 504, 429, 502, 504];
    const fetchMock = vi.fn(async () => {
      const status = statuses[fetchMock.mock.calls.length - 1];
      if (status === undefined) return Response.json(added());
      return new Response("Bad gateway", { status });
    });
    vi.stubGlobal("fetch", fetchMock);
    const text = await sendOne(makeFetchUploadResult());
    expect(text).toMatch(/could not be confirmed/);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  test("4 answers of 502 then done is done", async () => {
    const fetchMock = vi.fn(async () =>
      fetchMock.mock.calls.length <= 4
        ? new Response("Bad gateway", { status: 502 })
        : Response.json(added()),
    );
    vi.stubGlobal("fetch", fetchMock);
    const text = await sendOne(makeFetchUploadResult());
    expect(text).toMatch(/Added/);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  test("a 404 is final at once", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const text = await sendOne(makeFetchUploadResult());
    expect(text).toMatch(/could not be confirmed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe("the stored resume fingerprint after a final refusal", () => {
    const target: UploadTarget = { kind: "new" };
    const handlers: UploadHandlers = { onProgress() {}, onSuccess() {}, onError() {} };
    const storedKey = () => `tus::${uploadFingerprint(fresh, target, uploadEndpoint())}::42`;
    const other = "tus::another-upload::7";

    beforeEach(() => {
      localStorage.clear();
      localStorage.setItem(storedKey(), '{"uploadUrl":"https://platehouse.test/app/uploads/x"}');
      localStorage.setItem(other, "{}");
    });
    afterEach(() => localStorage.clear());

    test("a refusal that will not change (413, 415) removes this file's fingerprint and no other", () => {
      for (const status of [413, 415]) {
        localStorage.setItem(storedKey(), "{}");
        const errors: Error[] = [];
        const options = uploadOptions(fresh, target, {
          ...handlers,
          onError: (e) => errors.push(e),
        });
        options.onError?.(refusedWith(status) as never);
        expect(localStorage.getItem(storedKey())).toBeNull();
        expect(localStorage.getItem(other)).toBe("{}");
        expect(errors).toHaveLength(1);
      }
    });

    test("a lost connection, a 429, a 507 and a 503 keep it, so the upload can resume", () => {
      for (const error of [
        connectionLost(),
        refusedWith(429),
        refusedWith(507),
        refusedWith(503),
      ]) {
        const options = uploadOptions(fresh, target, handlers);
        options.onError?.(error as never);
        expect(localStorage.getItem(storedKey())).not.toBeNull();
      }
    });
  });

  describe("onShouldRetry", () => {
    const handlers: UploadHandlers = { onProgress() {}, onSuccess() {}, onError() {} };
    const options = uploadOptions(fresh, { kind: "new" }, handlers);
    const retry = (error: Error) =>
      options.onShouldRetry?.(
        error as Parameters<NonNullable<typeof options.onShouldRetry>>[0],
        0,
        options,
      );

    test("a 507 (no room) and a 429 (too many unfinished) are not sent again", () => {
      expect(retry(refusedWith(507))).toBe(false);
      expect(retry(refusedWith(429))).toBe(false);
    });

    test("a 503 is sent again while the browser is online", () => {
      expect(retry(refusedWith(503))).toBe(true);
      expect(retry(connectionLost())).toBe(true);
    });

    test("nothing is sent again while the browser is offline", () => {
      vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
      expect(retry(refusedWith(503))).toBe(false);
      expect(retry(connectionLost())).toBe(false);
    });
  });

  test("a failed row offers Retry, named for the file, which sends it again to the same target", async () => {
    const { started, start, fetchResult, fail } = stubUploads(added);
    await render(
      inRouter(
        <UploadDialog
          open
          files={[benchy]}
          modelId={NEW_MODEL}
          onClose={() => {}}
          start={start}
          fetchResult={fetchResult}
        />,
      ),
    );
    expect(hasButton(/^retry$/i)).toBe(false);
    await act(async () => button(/^upload 1 file/i).click());
    expect(hasButton(/^retry$/i)).toBe(false);
    await fail(0, refusedWith(500));

    const retry = button(/^retry$/i);
    expect(rowOf("Benchy (2).3mf").contains(retry)).toBe(true);
    // Its name says which file, as a list of failed rows needs.
    expect(retry.getAttribute("aria-label")).toBe("Retry: Benchy (2).3mf");
    // A real button, reachable with the keyboard.
    expect(retry.type).toBe("button");
    expect(retry.disabled).toBe(false);
    expect(retry.tabIndex).toBe(0);
    retry.focus();
    expect(document.activeElement).toBe(retry);

    await act(async () => retry.click());
    // The button is gone with the failed state; focus stays on the row's status.
    const status = rowOf("Benchy (2).3mf").querySelector<HTMLElement>(".ph-upload-status");
    expect(document.activeElement).toBe(status);
    expect(status?.tabIndex).toBe(-1);
    expect(started).toHaveLength(2);
    expect(started[1]?.file).toBe(benchy);
    expect(started[1]?.target).toEqual({ kind: "model", modelId: NEW_MODEL });
    expect(started[1]?.duplicates).toBe("skip");
    expect(hasButton(/^retry$/i)).toBe(false);
  });

  test("coming back online restarts each row that lost the connection exactly once", async () => {
    const three = files(3);
    const { started, start, fetchResult, fail } = stubUploads(added);
    await render(
      inRouter(
        <UploadDialog
          open
          files={three}
          onClose={() => {}}
          start={start}
          fetchResult={fetchResult}
        />,
      ),
    );
    await act(async () => button(/^upload 3 files/i).click());
    expect(started).toHaveLength(3);
    await fail(0, connectionLost());
    await fail(1, refusedWith(507));
    await fail(2, connectionLost());

    await act(async () => {
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("online"));
    });
    await settle();
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await settle();
    expect(started.slice(3).map((s) => s.file.name)).toEqual(["Part 1.stl", "Part 3.stl"]);
    // A refusal for room is not a lost connection: it waits for Retry.
    expect(rowOf("Part 2.stl").textContent).toMatch(/out of room/);
    expect(rowOf("Part 2.stl").textContent).toMatch(/Ask whoever runs Platehouse/);
  });

  test("leaving the page asks first while files are sending, and not once none are", async () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const unloadAdds = () => add.mock.calls.filter(([type]) => type === "beforeunload");
    const { start, fetchResult, finish } = stubUploads(added);
    await render(
      inRouter(
        <UploadDialog
          open
          files={[fresh]}
          onClose={() => {}}
          start={start}
          fetchResult={fetchResult}
        />,
      ),
    );
    expect(unloadAdds()).toHaveLength(0);
    await act(async () => button(/^upload 1 file/i).click());
    expect(unloadAdds()).toHaveLength(1);
    const listener = unloadAdds()[0]?.[1] as EventListener;
    const leaving = new Event("beforeunload", { cancelable: true });
    listener(leaving);
    expect(leaving.defaultPrevented).toBe(true);

    await finish(0);
    expect(rowOf("Fresh.stl").textContent).toMatch(/Added/);
    expect(remove.mock.calls.some(([type, fn]) => type === "beforeunload" && fn === listener)).toBe(
      true,
    );
    expect(unloadAdds()).toHaveLength(1);
  });

  test("a 507 says the server is out of room and who can fix it; a 429 says to let some finish, then Retry", async () => {
    const { start, fetchResult, fail } = stubUploads(added);
    await render(
      inRouter(
        <UploadDialog
          open
          files={[benchy, fresh]}
          onClose={() => {}}
          start={start}
          fetchResult={fetchResult}
        />,
      ),
    );
    await act(async () => button(/^upload 2 files/i).click());
    await fail(0, refusedWith(507));
    await fail(1, refusedWith(429));
    expect(visibleStatus(rowOf("Benchy (2).3mf").querySelector(".ph-upload-status-bad"))).toBe(
      "The server is out of room for uploads; nothing was saved. Ask whoever runs Platehouse to free space, then try again.",
    );
    expect(visibleStatus(rowOf("Fresh.stl").querySelector(".ph-upload-status-bad"))).toBe(
      "Too many of your uploads are unfinished; nothing was saved. Let some finish, then use Retry.",
    );
  });

  test("a failure and a success are each announced once in the dialog's live region", async () => {
    const { start, fetchResult, finish, fail } = stubUploads(added);
    await render(
      inRouter(
        <UploadDialog
          open
          files={[benchy, fresh]}
          onClose={() => {}}
          start={start}
          fetchResult={fetchResult}
        />,
      ),
    );
    const region = container.querySelector<HTMLElement>('[role="dialog"] [role="status"]');
    expect(region).not.toBeNull();
    expect(region?.getAttribute("aria-live")).toBe("polite");
    const said = () => [...(region?.children ?? [])].map((el) => el.textContent);
    await act(async () => button(/^upload 2 files/i).click());
    // Starting to send and its percentages are not announced.
    expect(said()).toEqual([]);

    await fail(0, refusedWith(507));
    expect(said()).toEqual([
      "Benchy (2).3mf: The server is out of room for uploads; nothing was saved. Ask whoever runs Platehouse to free space, then try again.",
    ]);
    await finish(1);
    expect(said()).toEqual([
      "Benchy (2).3mf: The server is out of room for uploads; nothing was saved. Ask whoever runs Platehouse to free space, then try again.",
      "Fresh.stl: Added",
      "1 file added, 1 file failed",
    ]);
    // Later renders do not say either again.
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await settle();
    expect(said()).toHaveLength(3);
  });

  test("a start that throws fails that row and frees its place", async () => {
    const four = files(4);
    const { started, start: record, fetchResult, finish } = stubUploads(added);
    const start: StartUpload = (file, target, handlers, duplicates) => {
      if (file.name === "Part 1.stl") throw new Error("could not start");
      return record(file, target, handlers, duplicates);
    };
    await render(
      inRouter(
        <UploadDialog
          open
          files={four}
          onClose={() => {}}
          start={start}
          fetchResult={fetchResult}
        />,
      ),
    );
    await act(async () => button(/^upload 4 files/i).click());
    expect(visibleStatus(rowOf("Part 1.stl").querySelector(".ph-upload-status-bad"))).toBe(
      "The upload failed: could not start.",
    );
    // Its place went to the next file: three are sending.
    expect(started.map((s) => s.file.name)).toEqual(["Part 2.stl", "Part 3.stl", "Part 4.stl"]);
    await finish(0);
    expect(rowOf("Part 2.stl").textContent).toMatch(/Added/);
  });

  test("a start that throws for the next file still lets the finished file be confirmed", async () => {
    const four = files(4);
    const { started, start: record, fetchResult, finish } = stubUploads(added);
    const start: StartUpload = (file, target, handlers, duplicates) => {
      if (file.name === "Part 4.stl") throw new Error("could not start");
      return record(file, target, handlers, duplicates);
    };
    const onUploaded = vi.fn();
    await render(
      inRouter(
        <UploadDialog
          open
          files={four}
          onClose={() => {}}
          onUploaded={onUploaded}
          start={start}
          fetchResult={fetchResult}
        />,
      ),
    );
    await act(async () => button(/^upload 4 files/i).click());
    expect(started).toHaveLength(3);
    await finish(0);
    expect(rowOf("Part 1.stl").textContent).toMatch(/Added/);
    expect(visibleStatus(rowOf("Part 4.stl").querySelector(".ph-upload-status-bad"))).toBe(
      "The upload failed: could not start.",
    );
    await finish(1);
    await finish(2);
    expect(onUploaded).toHaveBeenCalledTimes(1);
  });

  test("while the browser is offline, waiting rows wait, and start when it is back online", async () => {
    const five = files(5);
    let online = true;
    vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
    const { started, start, fetchResult, fail } = stubUploads(added);
    await render(
      inRouter(
        <UploadDialog
          open
          files={five}
          onClose={() => {}}
          start={start}
          fetchResult={fetchResult}
        />,
      ),
    );
    await act(async () => button(/^upload 5 files/i).click());
    expect(started).toHaveLength(3);
    online = false;
    await fail(0, connectionLost());
    await fail(1, connectionLost());
    await fail(2, connectionLost());
    // Nothing more is started into a dead connection.
    expect(started).toHaveLength(3);
    expect(rowOf("Part 4.stl").textContent).toMatch(/Waiting/);
    expect(rowOf("Part 5.stl").textContent).toMatch(/Waiting/);

    online = true;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await settle();
    // First sent first: the two that waited, then the first that lost the connection.
    expect(started.slice(3).map((s) => s.file.name)).toEqual([
      "Part 4.stl",
      "Part 5.stl",
      "Part 1.stl",
    ]);
    expect(rowOf("Part 2.stl").textContent).toMatch(/Waiting/);
  });

  const dialogRegion = () =>
    container.querySelector<HTMLElement>('[role="dialog"] [role="status"]') as HTMLElement;

  test("a finished batch is announced as one summary", async () => {
    const answer = (s: Started): UploadResult =>
      s.file.name.startsWith("Dup") && s.duplicates !== "allow"
        ? {
            status: "failed",
            error: "already in the library",
            code: "duplicate",
            duplicates: [HOLDER],
          }
        : added();
    const { start, fetchResult, finish, fail } = stubUploads(answer);
    const batch = ["A.stl", "B.stl", "C.stl", "Dup.stl", "Bad.stl"].map(
      (name) => new File([new Uint8Array(10)], name),
    );
    await render(
      inRouter(
        <UploadDialog
          open
          files={batch}
          onClose={() => {}}
          start={start}
          fetchResult={fetchResult}
        />,
      ),
    );
    await act(async () => button(/^upload 5 files/i).click());
    await finish(0);
    await finish(1);
    await finish(2);
    await finish(3);
    const lines = () => [...dialogRegion().children].map((el) => el.textContent ?? "");
    expect(lines().some((l) => / added, /.test(l))).toBe(false);
    await fail(4, refusedWith(507));
    const last = lines().at(-1);
    expect(last).toBe("3 files added, 1 file skipped, 1 file failed");
    expect(lines().filter((l) => l === last)).toHaveLength(1);
    expect(dialogRegion().textContent).not.toMatch(/%/);
  });

  test("Upload keeps focus when pressed", async () => {
    const { start, fetchResult } = stubUploads(added);
    await render(
      inRouter(
        <UploadDialog
          open
          files={[fresh]}
          onClose={() => {}}
          start={start}
          fetchResult={fetchResult}
        />,
      ),
    );
    const upload = button(/^upload 1 file/i);
    upload.focus();
    await act(async () => upload.click());
    const after = button(/^upload 0 files/i);
    expect(document.activeElement).toBe(after);
    expect(after.getAttribute("aria-disabled")).toBe("true");
    expect(after.hasAttribute("disabled")).toBe(false);
  });

  test("the switch is aria-disabled while busy, keeps focus, and ignores changes", async () => {
    const { started, start, fetchResult } = stubUploads(added);
    await render(
      inRouter(
        <UploadDialog
          open
          files={[fresh]}
          onClose={() => {}}
          start={start}
          fetchResult={fetchResult}
        />,
      ),
    );
    const toggle = container.querySelector<HTMLInputElement>('input[role="switch"]');
    if (toggle === null) throw new Error("no switch");
    expect(toggle.getAttribute("aria-disabled")).not.toBe("true");
    await act(async () => button(/^upload 1 file/i).click());
    expect(started).toHaveLength(1);
    toggle.focus();
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    expect(toggle.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(toggle);
    await act(async () => toggle.click());
    expect(toggle.checked).toBe(false);
    expect(document.activeElement).toBe(toggle);
  });

  test("after Import anyway, focus is on that row's status", async () => {
    const { start, fetchResult, finish } = stubUploads(duplicateUnlessAllowed);
    await render(
      inRouter(
        <UploadDialog
          open
          files={[benchy]}
          onClose={() => {}}
          start={start}
          fetchResult={fetchResult}
        />,
      ),
    );
    await act(async () => button(/^upload 1 file/i).click());
    await finish(0);
    const importButton = button(/^import anyway$/i);
    importButton.focus();
    await act(async () => importButton.click());
    await settle();
    expect(hasButton(/^import anyway$/i)).toBe(false);
    expect(document.activeElement).toBe(rowOf("Benchy (2).3mf").querySelector(".ph-upload-status"));
  });

  test("pressing Upload with nothing ready starts nothing and says nothing", async () => {
    const { started, start, fetchResult } = stubUploads(added);
    await render(
      inRouter(
        <UploadDialog open files={[]} onClose={() => {}} start={start} fetchResult={fetchResult} />,
      ),
    );
    await act(async () => button(/^upload 0 files/i).click());
    await settle();
    expect(started).toHaveLength(0);
    expect(fetchResult).not.toHaveBeenCalled();
    expect(dialogRegion().textContent).toBe("");
  });

  test("a Retry after the first batch is summarised on its own", async () => {
    const { start, fetchResult, finish, fail } = stubUploads(added);
    await render(
      inRouter(
        <UploadDialog
          open
          files={[fresh]}
          onClose={() => {}}
          start={start}
          fetchResult={fetchResult}
        />,
      ),
    );
    await act(async () => button(/^upload 1 file/i).click());
    await fail(0, refusedWith(507));
    const lines = () => [...dialogRegion().children].map((el) => el.textContent ?? "");
    expect(lines().at(-1)).toBe("1 file failed");
    await act(async () => button(/^retry$/i).click());
    await finish(1);
    expect(lines().at(-1)).toBe("1 file added");
  });

  test("an Import anyway after the first batch is summarised on its own", async () => {
    const { start, fetchResult, finish } = stubUploads(duplicateUnlessAllowed);
    await render(
      inRouter(
        <UploadDialog
          open
          files={[benchy]}
          onClose={() => {}}
          start={start}
          fetchResult={fetchResult}
        />,
      ),
    );
    await act(async () => button(/^upload 1 file/i).click());
    await finish(0);
    const lines = () => [...dialogRegion().children].map((el) => el.textContent ?? "");
    expect(lines().at(-1)).toBe("1 file skipped");
    await act(async () => button(/^import anyway$/i).click());
    await finish(1);
    expect(lines().at(-1)).toBe("1 file added");
  });

  test("a batch that finishes while the dialog is hidden is not announced on reopening", async () => {
    const { start, fetchResult, finish } = stubUploads(added);
    const node = (open: boolean) =>
      inRouter(
        <UploadDialog
          open={open}
          files={[fresh]}
          onClose={() => {}}
          start={start}
          fetchResult={fetchResult}
        />,
      );
    await render(node(true));
    await act(async () => button(/^upload 1 file/i).click());
    await render(node(false));
    await finish(0);
    await render(node(true));
    expect(dialogRegion().textContent).toBe("");
  });

  test("a row's status names its file for a screen reader, and the live region keeps appending", async () => {
    const { start, fetchResult, fail } = stubUploads(added);
    await render(
      inRouter(
        <UploadDialog
          open
          files={[fresh]}
          onClose={() => {}}
          start={start}
          fetchResult={fetchResult}
        />,
      ),
    );
    await act(async () => button(/^upload 1 file/i).click());
    await fail(0, refusedWith(507));
    const status = rowOf("Fresh.stl").querySelector(".ph-upload-status");
    expect(status?.querySelector(".studio-visually-hidden")?.textContent).toBe("Fresh.stl: ");
    expect(dialogRegion().getAttribute("aria-atomic")).toBe("false");
    expect(dialogRegion().getAttribute("aria-relevant")).toBe("additions");
    // The line the live region says is not changed by the hidden name.
    expect([...dialogRegion().children][0]?.textContent).toMatch(/^Fresh\.stl: The server is out/);
  });
});

describe("the upload dialog isolates the page", () => {
  test("the upload dialog makes the page inert while open, and clears it when closed", async () => {
    const page = document.createElement("div");
    document.body.prepend(page);
    const { start, fetchResult } = stubUploads(duplicateUnlessAllowed);
    const show = (open: boolean) =>
      render(
        inRouter(
          <UploadDialog
            open={open}
            files={[]}
            onClose={() => {}}
            start={start}
            fetchResult={fetchResult}
          />,
        ),
      );
    await show(true);
    expect(page.hasAttribute("inert")).toBe(true);
    expect(container.querySelector('[role="dialog"]')?.closest("[inert]")).toBeNull();
    await show(false);
    expect(document.querySelectorAll("[inert]")).toHaveLength(0);
    page.remove();
  });

  test("Escape on the dialog closes it", async () => {
    const { start, fetchResult } = stubUploads(duplicateUnlessAllowed);
    const onClose = vi.fn();
    await render(
      inRouter(
        <UploadDialog open files={[]} onClose={onClose} start={start} fetchResult={fetchResult} />,
      ),
    );
    const box = container.querySelector('[role="dialog"]') as HTMLElement;
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
  });
});
