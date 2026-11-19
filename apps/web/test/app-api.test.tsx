// @vitest-environment jsdom
// useAppApi's reload (apps/web/src/settings/api.tsx), issue #254: a page
// that reads the same route twice, such as My printers' waiting poll and the
// read after a save, must show the newest answer, never an older one that
// arrives later, and a caller must be able to wait for the read and know
// whether it landed. The server is a fetch stub whose answers the test
// releases in any order.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type Loaded, useAppApi } from "../src/settings/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
/** The hook's latest return, read by the test. */
let loaded: Loaded<{ n: number }>;
/** Answers not yet released, in request order. */
let pending: Array<(r: Response) => void>;

function Probe() {
  loaded = useAppApi<{ n: number }>("/probe");
  return <p>{loaded.data === undefined ? "none" : String(loaded.data.n)}</p>;
}

function answer(i: number, body: unknown, status = 200) {
  pending[i]?.(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeEach(async () => {
  pending = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          pending.push(resolve);
        }),
    ),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Probe />));
  answer(0, { n: 0 });
  await settle();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("useAppApi reload", () => {
  test("an older answer that arrives after a newer one is dropped", async () => {
    expect(container.textContent).toBe("0");
    let older: Promise<boolean> = Promise.resolve(false);
    let newer: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      older = loaded.reload(); // request 1, as a poll sent before a save
      newer = loaded.reload(); // request 2, as the read after the save
    });
    answer(2, { n: 2 });
    await settle();
    expect(container.textContent).toBe("2");
    answer(1, { n: 1 });
    await settle();
    expect(container.textContent).toBe("2");
    // Both say a list at least as new as theirs is on screen.
    expect(await newer).toBe(true);
    expect(await older).toBe(true);
  });

  test("answers that arrive in order are each shown", async () => {
    await act(async () => {
      void loaded.reload();
      void loaded.reload();
    });
    answer(1, { n: 1 });
    await settle();
    expect(container.textContent).toBe("1");
    answer(2, { n: 2 });
    await settle();
    expect(container.textContent).toBe("2");
  });

  test("reload resolves once its answer is shown, and false when it failed", async () => {
    let read: Promise<boolean> = Promise.resolve(true);
    await act(async () => {
      read = loaded.reload();
    });
    let done = false;
    void read.then(() => {
      done = true;
    });
    await settle();
    expect(done).toBe(false);
    answer(1, { error: "down" }, 503);
    await settle();
    expect(await read).toBe(false);
    expect(container.textContent).toBe("0");
    expect(loaded.error).toBe("This is unavailable right now. Try again in a moment.");
  });
});
