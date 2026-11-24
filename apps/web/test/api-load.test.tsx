// @vitest-environment jsdom
// useAppApi (settings/api.tsx): what a page shows while a read is in flight,
// when an older read fails after a newer one succeeded, and a change made
// before the first answer lands. Each test renders a small page that prints
// the hook's state, with a fetch the test answers by hand.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useAppApi } from "../src/settings/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Answer {
  resolve(res: Response): void;
}

let container: HTMLDivElement;
let root: Root;
let answers: Answer[];
let loaded: ReturnType<typeof useAppApi<{ items: string[] }>> | undefined;

function Page() {
  const list = useAppApi<{ items: string[] }>("/things");
  loaded = list;
  return (
    <div>
      <p data-data>{list.data === undefined ? "none" : list.data.items.join(",")}</p>
      <p data-error>{list.error ?? ""}</p>
    </div>
  );
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const shown = (what: "data" | "error") =>
  container.querySelector(`[data-${what}]`)?.textContent ?? "";

beforeEach(() => {
  answers = [];
  loaded = undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          answers.push({ resolve });
        }),
    ),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => root.render(<Page />));
}

async function answer(index: number, res: Response) {
  await act(async () => {
    answers[index]?.resolve(res);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("useAppApi", () => {
  test("a change made before the first answer is merged into it", async () => {
    await render();
    await act(async () => {
      loaded?.set((prev) => ({ items: ["new", ...prev.items] }));
    });
    await answer(0, json({ items: ["old"] }));
    expect(shown("data")).toBe("new,old");
  });

  test("an older read that fails after a newer one succeeded shows data and no error", async () => {
    await render();
    let reloaded: Promise<boolean> | undefined;
    await act(async () => {
      reloaded = loaded?.reload();
    });
    await answer(1, json({ items: ["fresh"] }));
    await reloaded;
    await answer(0, json({ error: "unavailable" }, 503));
    expect(shown("data")).toBe("fresh");
    expect(shown("error")).toBe("");
  });

  test("a failed refresh keeps the last data and says it could not refresh", async () => {
    await render();
    await answer(0, json({ items: ["kept"] }));
    let reloaded: Promise<boolean> | undefined;
    await act(async () => {
      reloaded = loaded?.reload();
    });
    await answer(1, json({ error: "unavailable" }, 503));
    expect(await reloaded).toBe(false);
    expect(shown("data")).toBe("kept");
    expect(shown("error")).toMatch(/^Could not refresh\. This is the last list that loaded\. /);
    expect(shown("error")).toContain("unavailable right now");
  });

  test("a first load that fails with nothing to show keeps the plain error", async () => {
    await render();
    await answer(0, json({ error: "unavailable" }, 503));
    expect(shown("data")).toBe("none");
    expect(shown("error")).toBe("This is unavailable right now. Try again in a moment.");
  });

  test("a later success clears an earlier failure's error", async () => {
    await render();
    await answer(0, json({ error: "unavailable" }, 503));
    expect(shown("error")).not.toBe("");
    let reloaded: Promise<boolean> | undefined;
    await act(async () => {
      reloaded = loaded?.reload();
    });
    await answer(1, json({ items: ["ok"] }));
    await reloaded;
    expect(shown("data")).toBe("ok");
    expect(shown("error")).toBe("");
  });
});
