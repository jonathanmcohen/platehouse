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
// The tus upload and the result check are stubs, as in library.test.tsx.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { UploadDialog } from "../src/upload/UploadDialog";
import {
  type DuplicatePolicy,
  type FetchResult,
  type StartUpload,
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
  return { started, start, fetchResult, finish };
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

    await act(async () => button(/^import anyway$/i).click());
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
    expect(rowOf("Benchy (2).3mf").querySelector(".ph-upload-status-bad")?.textContent).toBe(
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
