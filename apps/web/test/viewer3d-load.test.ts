// @vitest-environment jsdom
// The 3D viewer's own loader (Viewer3d.tsx, defaultLoadThree) tells a mesh
// that could not be fetched or read apart from a viewer that cannot start:
// a failed /blobs/<id> fetch carries its HTTP status in a MeshLoadError, so
// a plate's 3D view can say the file could not be read right now (503) or
// that the user is signed out (401) rather than blaming the browser (issue
// #358). These checks fail before WebGL is reached, which jsdom lacks.
// three.js itself failing to load (the network dropped, or a page older
// than a redeploy asking for a chunk the new build no longer serves) is a
// ThreeLoadError, so it is not blamed on the browser either.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createRenderScheduler,
  defaultLoadThree,
  MeshLoadError,
  Viewer3d,
} from "../src/model/Viewer3d";

const SOURCE = { kind: "glb", url: "/blobs/01900000-0000-7000-8000-000000000001" } as const;

async function failureOf(fetchStub: typeof fetch, signal?: AbortSignal): Promise<unknown> {
  vi.stubGlobal("fetch", fetchStub);
  const viewer = await defaultLoadThree();
  try {
    await viewer.show(document.createElement("div"), SOURCE, signal);
  } catch (error) {
    return error;
  }
  throw new Error("expected the load to fail");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("three/addons/controls/OrbitControls.js");
  vi.doUnmock("three");
  vi.resetModules();
});

describe("defaultLoadThree", () => {
  test.each([401, 404, 503])(
    "rejects a mesh the server answers %i to with that status",
    async (status) => {
      const error = await failureOf(async () => new Response("no", { status }));
      expect(error).toBeInstanceOf(MeshLoadError);
      expect((error as MeshLoadError).status).toBe(status);
    },
  );

  test("rejects with no status when no reply comes", async () => {
    const error = await failureOf(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(error).toBeInstanceOf(MeshLoadError);
    expect((error as MeshLoadError).status).toBeNull();
  });

  test("rejects with no status when the mesh cannot be read", async () => {
    const error = await failureOf(async () => new Response("not a GLB", { status: 200 }));
    expect(error).toBeInstanceOf(MeshLoadError);
    expect((error as MeshLoadError).status).toBeNull();
  });

  test("passes an abort on as it is, never as a mesh failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await failureOf(async (_url, init) => {
      init?.signal?.throwIfAborted();
      return new Response("no", { status: 503 });
    }, controller.signal);
    expect(error).not.toBeInstanceOf(MeshLoadError);
  });

  test("rejects with a ThreeLoadError when three.js cannot be loaded, never as a viewer that cannot start", async () => {
    // A failed dynamic import of one of three.js's chunks, as a dropped
    // network or a chunk gone after a redeploy makes it.
    vi.doMock("three/addons/controls/OrbitControls.js", () => {
      throw new TypeError("Failed to fetch dynamically imported module");
    });
    vi.resetModules();
    const fresh = await import("../src/model/Viewer3d");
    const error = await fresh.defaultLoadThree().then(
      () => {
        throw new Error("expected three.js to fail to load");
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(fresh.ThreeLoadError);
    expect(error).not.toBeInstanceOf(fresh.MeshLoadError);
  });
});

const STL = `solid t
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 1 0 0
vertex 0 1 0
endloop
endfacet
endsolid t
`;

describe("the viewer's renderer", () => {
  test("loses its WebGL context before it is disposed, when the view is dropped", async () => {
    const calls: string[] = [];
    vi.doMock("three", async (importOriginal) => {
      const actual = await importOriginal<typeof import("three")>();
      class StubRenderer {
        domElement = document.createElement("canvas");
        setPixelRatio() {}
        setSize() {}
        setAnimationLoop() {}
        render() {}
        forceContextLoss() {
          calls.push("forceContextLoss");
        }
        dispose() {
          calls.push("dispose");
        }
      }
      return { ...actual, WebGLRenderer: StubRenderer };
    });
    vi.resetModules();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal("fetch", async () => new Response(STL, { status: 200 }));
    const fresh = await import("../src/model/Viewer3d");
    const viewer = await fresh.defaultLoadThree();
    const handle = await viewer.show(document.createElement("div"), {
      kind: "stl",
      url: SOURCE.url,
    });
    handle.dispose();
    expect(calls).toEqual(["forceContextLoss", "dispose"]);
  });
});

describe("Viewer3d while the view loads", () => {
  test("announces the loading placeholder as a status", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(createElement(Viewer3d, { source: null, label: "a.stl", download: "/d" }));
    });
    const placeholder = host.querySelector(".studio-placeholder");
    expect(placeholder?.getAttribute("role")).toBe("status");
    await act(async () => root.unmount());
    host.remove();
  });
});

// Issue #469: the view draws only when something moves.
describe("createRenderScheduler", () => {
  function setup(opts: { damping: boolean; updates?: boolean[] }) {
    const frames = new Map<number, () => void>();
    let next = 1;
    let renders = 0;
    let updates = 0;
    const queue = opts.updates ?? [];
    const scheduler = createRenderScheduler({
      render: () => {
        renders += 1;
      },
      update: () => {
        updates += 1;
        return queue.shift() ?? false;
      },
      damping: opts.damping,
      requestFrame: (run) => {
        frames.set(next, run);
        return next++;
      },
      cancelFrame: (id) => {
        frames.delete(id);
      },
    });
    /** Runs the one pending frame, if any; false when none was pending. */
    function frame(): boolean {
      const [first] = [...frames.entries()];
      if (first === undefined) return false;
      frames.delete(first[0]);
      first[1]();
      return true;
    }
    return {
      scheduler,
      frame,
      pending: () => frames.size,
      renders: () => renders,
      updates: () => updates,
    };
  }

  test("renders once after a request, and not again while idle", () => {
    const t = setup({ damping: true });
    t.scheduler.request();
    expect(t.renders()).toBe(0);
    expect(t.frame()).toBe(true);
    expect(t.renders()).toBe(1);
    expect(t.frame()).toBe(false);
    expect(t.renders()).toBe(1);
  });

  test("asks for one frame however many requests come before it", () => {
    const t = setup({ damping: false });
    t.scheduler.request();
    t.scheduler.request();
    t.scheduler.request();
    expect(t.pending()).toBe(1);
    t.frame();
    expect(t.renders()).toBe(1);
  });

  test("a request after a render draws again", () => {
    const t = setup({ damping: false });
    t.scheduler.request();
    t.frame();
    t.scheduler.request();
    t.frame();
    expect(t.renders()).toBe(2);
  });

  test("with damping it loops only while update() reports a change, then stops", () => {
    const t = setup({ damping: true, updates: [true, true, false] });
    t.scheduler.request();
    let frames = 0;
    while (t.frame()) frames += 1;
    expect(frames).toBe(3);
    expect(t.updates()).toBe(3);
    expect(t.renders()).toBe(3);
    expect(t.pending()).toBe(0);
  });

  test("without damping (reduced motion) it never calls update() and never loops", () => {
    const t = setup({ damping: false, updates: [true, true] });
    t.scheduler.request();
    expect(t.frame()).toBe(true);
    expect(t.frame()).toBe(false);
    expect(t.updates()).toBe(0);
    expect(t.renders()).toBe(1);
  });

  test("dispose cancels a pending frame and later requests do nothing", () => {
    const t = setup({ damping: true });
    t.scheduler.request();
    t.scheduler.dispose();
    expect(t.pending()).toBe(0);
    t.scheduler.request();
    expect(t.pending()).toBe(0);
    expect(t.renders()).toBe(0);
  });
});
