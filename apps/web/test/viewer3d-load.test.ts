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
import { afterEach, describe, expect, test, vi } from "vitest";
import { defaultLoadThree, MeshLoadError } from "../src/model/Viewer3d";

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
