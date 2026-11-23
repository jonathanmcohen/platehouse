// Issue #316: the two ways a preview picture is asked for. An STL's own bytes
// are streamed to /v1/stl/png; a STEP file's stored GLB mesh is read back,
// turned into an STL (derived/mesh.ts) and sent the same way. What the file
// shows when that fails starts with Platehouse's own sentence, so the page
// can say it in its language, and anything over the contract's 256 MiB is
// refused before a byte is sent. The slicer here is a plain node:http server
// on 127.0.0.1, holding nothing but synthetic bytes.
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { LIMITS } from "@platehouse/slicer-contract";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  DERIVED_MESSAGES,
  RenderFailed,
  SLICER_NOT_AN_STL,
  type SlicerTarget,
} from "../../src/derived/client.js";
import {
  type MeshPreviewInput,
  meshPreviewOutputs,
  PREVIEW_MESH_MAX_BYTES,
  stlPreviewOutputs,
} from "../../src/derived/preview.js";
import { memoryGate } from "../../src/memory/gate.js";
import { STEP_PREVIEW_PEAK_MB } from "../../src/memory/peaks.js";
import { stubGlb } from "../support/slicer-stub.js";

let server: Server | undefined;

afterEach(async () => {
  const s = server;
  server = undefined;
  if (s) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

/**
 * A slicer that answers every request with status and body, recording what
 * it got. onRequest is called as each request's body ends; the answer waits
 * for answerAfter when it is given.
 */
async function slicer(
  status: number,
  body: Buffer | object,
  opts: { onRequest?: () => void; answerAfter?: Promise<void> } = {},
): Promise<{ target: SlicerTarget; got: { path: string; type: string; body: Buffer }[] }> {
  const got: { path: string; type: string; body: Buffer }[] = [];
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      got.push({
        path: req.url ?? "",
        type: req.headers["content-type"] ?? "",
        body: Buffer.concat(chunks),
      });
      opts.onRequest?.();
      await opts.answerAfter;
      if (Buffer.isBuffer(body)) {
        res.writeHead(status, { "content-type": "image/png" });
        res.end(body);
      } else {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      }
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    target: { baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 5_000, uploadTimeoutMs: 5_000 },
    got,
  };
}

/** A target nothing should ever reach: a test that sends to it fails on SlicerDown. */
const NOWHERE: SlicerTarget = {
  baseUrl: "http://127.0.0.1:9",
  timeoutMs: 1_000,
  uploadTimeoutMs: 1_000,
};

const failure = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

const PNG = Buffer.from("\x89PNG\r\n\x1a\nsynthetic", "latin1");
const STL = Buffer.from("solid x\nendsolid x\n");

describe("an STL's preview", () => {
  test("streams the STL to /v1/stl/png and gives back one render_png", async () => {
    const { target, got } = await slicer(200, PNG);
    const outputs = await stlPreviewOutputs(target, async () => Readable.from([STL]), STL.length);
    expect(outputs).toEqual([{ kind: "render_png", contentType: "image/png", bytes: PNG }]);
    expect(got).toEqual([{ path: "/v1/stl/png", type: "application/octet-stream", body: STL }]);
  });

  test("an STL over 256 MiB is refused with its own sentence and never opened or sent", async () => {
    let opened = false;
    const error = await failure(
      stlPreviewOutputs(
        NOWHERE,
        async () => {
          opened = true;
          return Readable.from([STL]);
        },
        LIMITS.stlBodyBytes + 1,
      ),
    );
    expect(error).toBeInstanceOf(RenderFailed);
    expect((error as Error).message).toBe(DERIVED_MESSAGES.stlTooLarge);
    expect(opened).toBe(false);
  });

  test("OpenSCAD's refusal is shown after the preview sentence", async () => {
    const message = "ERROR: STL import: unexpected end of file";
    const { target } = await slicer(422, { error: "render_failed", message });
    const error = await failure(
      stlPreviewOutputs(target, async () => Readable.from([STL]), STL.length),
    );
    expect(error).toBeInstanceOf(RenderFailed);
    expect((error as Error).message).toBe(`${DERIVED_MESSAGES.previewRejected} ${message}`);
  });

  // Issue #379: the slicer refuses an STL with no triangles itself, before
  // OpenSCAD runs, so its sentence follows the preview sentence alone, never
  // "OpenSCAD said:".
  test("the slicer's own refusal of an STL with no triangles is not put in OpenSCAD's mouth", async () => {
    const { target } = await slicer(422, { error: "render_failed", message: SLICER_NOT_AN_STL });
    const error = await failure(
      stlPreviewOutputs(target, async () => Readable.from([STL]), STL.length),
    );
    expect(error).toBeInstanceOf(RenderFailed);
    expect((error as Error).message).toBe(`${DERIVED_MESSAGES.previewFailed} ${SLICER_NOT_AN_STL}`);
  });

  test("the not-an-STL sentence is the one the slicer writes in apps/slicer/src/scad.ts", async () => {
    const scad = await readFile(
      fileURLToPath(new URL("../../../slicer/src/scad.ts", import.meta.url)),
      "utf8",
    );
    expect(scad.replace(/\s+/g, " ")).toContain(`"${SLICER_NOT_AN_STL}"`);
  });

  test("a 413 from the slicer says the STL is too large", async () => {
    const { target } = await slicer(413, { error: "too_large" });
    const error = await failure(
      stlPreviewOutputs(target, async () => Readable.from([STL]), STL.length),
    );
    expect((error as Error).message).toBe(DERIVED_MESSAGES.stlTooLarge);
  });
});

let tmp = "";
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "preview-test-"));
});
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** A STEP preview's input: glb as the stored mesh, with a gate that lets everything through. */
function mesh(glb: Buffer, more: Partial<MeshPreviewInput> = {}): MeshPreviewInput {
  return {
    size: glb.length,
    read: async () => glb,
    hold: (task) => task(),
    tmpDir: tmp,
    ...more,
  };
}

describe("a STEP file's preview, from its stored mesh", () => {
  test("sends the mesh as a binary STL and gives back one render_png", async () => {
    const { target, got } = await slicer(200, PNG);
    const outputs = await meshPreviewOutputs(target, mesh(stubGlb("mesh")));
    expect(outputs).toEqual([{ kind: "render_png", contentType: "image/png", bytes: PNG }]);
    expect(got).toHaveLength(1);
    expect(got[0]?.path).toBe("/v1/stl/png");
    expect(got[0]?.type).toBe("application/octet-stream");
    // One triangle: 84 bytes of header and count, then one 50-byte facet.
    expect(got[0]?.body.length).toBe(134);
    expect(got[0]?.body.readUInt32LE(80)).toBe(1);
  });

  test("a mesh that cannot be read fails with the preview sentence, and nothing is sent", async () => {
    const error = await failure(meshPreviewOutputs(NOWHERE, mesh(Buffer.from("not a glb"))));
    expect(error).toBeInstanceOf(RenderFailed);
    expect((error as Error).message.startsWith(`${DERIVED_MESSAGES.previewFailed} `)).toBe(true);
  });

  test("a mesh whose STL would be over the limit fails with the preview sentence, and nothing is sent", async () => {
    const error = await failure(meshPreviewOutputs(NOWHERE, mesh(stubGlb("mesh"), { limit: 100 })));
    expect(error).toBeInstanceOf(RenderFailed);
    const message = (error as Error).message;
    expect(message.startsWith(`${DERIVED_MESSAGES.previewFailed} `)).toBe(true);
    expect(message).toMatch(/too large/i);
  });

  test("OpenSCAD's refusal is shown after the preview sentence", async () => {
    const message = "ERROR: CGAL error";
    const { target } = await slicer(422, { error: "render_failed", message });
    const error = await failure(meshPreviewOutputs(target, mesh(stubGlb("mesh"))));
    expect((error as Error).message).toBe(`${DERIVED_MESSAGES.previewRejected} ${message}`);
  });

  // The 0.1.1 memory budget: the mesh is read whole into memory, so a mesh
  // stored larger than PREVIEW_MESH_MAX_BYTES (its size from its blob row)
  // is refused before it is read, and what the read can hold at its peak is
  // what the budget counts (STEP_PREVIEW_PEAK_MB).
  test("a mesh stored over PREVIEW_MESH_MAX_BYTES is refused before it is read or the gate is taken", async () => {
    let read = false;
    let held = false;
    const error = await failure(
      meshPreviewOutputs(
        NOWHERE,
        mesh(stubGlb("mesh"), {
          size: PREVIEW_MESH_MAX_BYTES + 1,
          read: async () => {
            read = true;
            return stubGlb("mesh");
          },
          hold: (task) => {
            held = true;
            return task();
          },
        }),
      ),
    );
    expect(error).toBeInstanceOf(RenderFailed);
    const message = (error as Error).message;
    expect(message.startsWith(`${DERIVED_MESSAGES.previewFailed} `)).toBe(true);
    expect(message).toMatch(/too large/i);
    expect(read).toBe(false);
    expect(held).toBe(false);
  });

  test("a mesh whose blob row has no size is refused, and is never read or held", async () => {
    let read = false;
    let held = false;
    const error = await failure(
      meshPreviewOutputs(
        NOWHERE,
        mesh(stubGlb("mesh"), {
          size: null,
          read: async () => {
            read = true;
            return stubGlb("mesh");
          },
          hold: (task) => {
            held = true;
            return task();
          },
        }),
      ),
    );
    expect(error).toBeInstanceOf(RenderFailed);
    const message = (error as Error).message;
    expect(message.startsWith(`${DERIVED_MESSAGES.previewFailed} `)).toBe(true);
    expect(message).toMatch(/size/i);
    expect(read).toBe(false);
    expect(held).toBe(false);
  });

  test("its peak is the mesh's chunks and their joined copy: twice PREVIEW_MESH_MAX_BYTES", () => {
    expect(PREVIEW_MESH_MAX_BYTES).toBe(LIMITS.stlBodyBytes);
    expect(STEP_PREVIEW_PEAK_MB).toBe((2 * PREVIEW_MESH_MAX_BYTES) / (1024 * 1024));
  });
});

/** A wait long enough for the gate, the temp file and a local request to move on. */
const settleLong = () => new Promise((resolve) => setTimeout(resolve, 50));

// The 0.1.1 memory gate (review of PR #409): a STEP preview's mesh read and
// the plate mesh builds share one gate (memory/gate.ts, memoryGate), so
// at most one of them holds its memory at a time. The preview holds the gate
// only while it reads the mesh and writes the STL to a temp file, never
// while it sends it, so it never holds the slicer while it waits for the
// gate, and a plate build never waits for the slicer.
describe("a STEP file's preview and the memory gate", () => {
  test("reads the mesh and writes its STL only inside the gate, and sends it after letting go", async () => {
    let inside = false;
    const seen: string[] = [];
    const { target, got } = await slicer(200, PNG, {
      onRequest: () => seen.push(inside ? "sent inside the gate" : "sent outside the gate"),
    });
    const outputs = await meshPreviewOutputs(
      target,
      mesh(stubGlb("mesh"), {
        read: async () => {
          seen.push(inside ? "read inside the gate" : "read outside the gate");
          return stubGlb("mesh");
        },
        hold: async (task) => {
          inside = true;
          try {
            return await task();
          } finally {
            inside = false;
          }
        },
      }),
    );
    expect(outputs).toHaveLength(1);
    expect(seen).toEqual(["read inside the gate", "sent outside the gate"]);
    expect(got[0]?.body.length).toBe(134);
  });

  test("leaves no temp folder behind, sent or failed", async () => {
    const { target } = await slicer(200, PNG);
    await meshPreviewOutputs(target, mesh(stubGlb("mesh")));
    await failure(meshPreviewOutputs(NOWHERE, mesh(stubGlb("mesh"))));
    await failure(meshPreviewOutputs(NOWHERE, mesh(Buffer.from("not a glb"))));
    expect(await readdir(tmp)).toEqual([]);
  });

  test("a preview started while a plate build runs reads and sends nothing until the build ends", async () => {
    const order: string[] = [];
    const { target, got } = await slicer(200, PNG, { onRequest: () => order.push("preview sent") });
    let finishBuild!: () => void;
    const build = memoryGate.run(
      "plate-a",
      () =>
        new Promise<string>((resolve) => {
          order.push("build holds its memory");
          finishBuild = () => {
            order.push("build lets go");
            resolve("mesh");
          };
        }),
      new AbortController().signal,
    );
    const preview = meshPreviewOutputs(
      target,
      mesh(stubGlb("mesh"), {
        read: async () => {
          order.push("preview reads its mesh");
          return stubGlb("mesh");
        },
        hold: (task) =>
          memoryGate.run("step-preview:file-1", task, new AbortController().signal, {
            first: true,
          }),
      }),
    );
    await settleLong();
    expect(order).toEqual(["build holds its memory"]);
    expect(got).toHaveLength(0);
    finishBuild();
    await build;
    await preview;
    expect(order).toEqual([
      "build holds its memory",
      "build lets go",
      "preview reads its mesh",
      "preview sent",
    ]);
  });

  test("a plate build started while a preview holds the gate runs once the STL is written, before the slicer answers", async () => {
    const order: string[] = [];
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const { target } = await slicer(200, PNG, {
      onRequest: () => order.push("preview sent"),
      answerAfter: answered,
    });
    let releaseRead!: () => void;
    const reading = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const preview = meshPreviewOutputs(
      target,
      mesh(stubGlb("mesh"), {
        read: async () => {
          order.push("preview reads its mesh");
          await reading;
          return stubGlb("mesh");
        },
        hold: (task) =>
          memoryGate.run("step-preview:file-2", task, new AbortController().signal, {
            first: true,
          }),
      }),
    );
    await settleLong();
    const build = memoryGate.run(
      "plate-b",
      async () => {
        order.push("build holds its memory");
        return "mesh";
      },
      new AbortController().signal,
    );
    await settleLong();
    // The build waits while the preview holds its memory...
    expect(order).toEqual(["preview reads its mesh"]);
    releaseRead();
    // ...and runs once the STL is on disk, while the slicer has not answered.
    await build;
    await settleLong();
    expect(order).toEqual(["preview reads its mesh", "build holds its memory", "preview sent"]);
    answer();
    await expect(preview).resolves.toHaveLength(1);
  });

  test("neither starves: a preview waits only for the build running, and the builds waiting run after it", async () => {
    const order: string[] = [];
    const { target } = await slicer(200, PNG);
    const holds: Array<() => void> = [];
    const plate = (name: string) =>
      memoryGate.run(
        name,
        () =>
          new Promise<string>((resolve) => {
            order.push(name);
            holds.push(() => resolve(name));
          }),
        new AbortController().signal,
      );
    const builds = [plate("plate-1"), plate("plate-2"), plate("plate-3")];
    const preview = meshPreviewOutputs(
      target,
      mesh(stubGlb("mesh"), {
        read: async () => {
          order.push("preview");
          return stubGlb("mesh");
        },
        hold: (task) =>
          memoryGate.run("step-preview:file-3", task, new AbortController().signal, {
            first: true,
          }),
      }),
    );
    await settleLong();
    expect(order).toEqual(["plate-1"]);
    holds.shift()?.();
    await preview;
    await settleLong();
    expect(order).toEqual(["plate-1", "preview", "plate-2"]);
    holds.shift()?.();
    await settleLong();
    holds.shift()?.();
    await Promise.all(builds);
    expect(order).toEqual(["plate-1", "preview", "plate-2", "plate-3"]);
  });
});
