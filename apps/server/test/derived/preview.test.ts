// Issue #316: the two ways a preview picture is asked for. An STL's own bytes
// are streamed to /v1/stl/png; a STEP file's stored GLB mesh is read back,
// turned into an STL (derived/mesh.ts) and sent the same way. What the file
// shows when that fails starts with Platehouse's own sentence, so the page
// can say it in its language, and anything over the contract's 256 MiB is
// refused before a byte is sent. The slicer here is a plain node:http server
// on 127.0.0.1, holding nothing but synthetic bytes.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { LIMITS } from "@platehouse/slicer-contract";
import { afterEach, describe, expect, test } from "vitest";
import { DERIVED_MESSAGES, RenderFailed, type SlicerTarget } from "../../src/derived/client.js";
import { meshPreviewOutputs, stlPreviewOutputs } from "../../src/derived/preview.js";
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

/** A slicer that answers every request with status and body, recording what it got. */
async function slicer(
  status: number,
  body: Buffer | object,
): Promise<{ target: SlicerTarget; got: { path: string; type: string; body: Buffer }[] }> {
  const got: { path: string; type: string; body: Buffer }[] = [];
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      got.push({
        path: req.url ?? "",
        type: req.headers["content-type"] ?? "",
        body: Buffer.concat(chunks),
      });
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

  test("a 413 from the slicer says the STL is too large", async () => {
    const { target } = await slicer(413, { error: "too_large" });
    const error = await failure(
      stlPreviewOutputs(target, async () => Readable.from([STL]), STL.length),
    );
    expect((error as Error).message).toBe(DERIVED_MESSAGES.stlTooLarge);
  });
});

describe("a STEP file's preview, from its stored mesh", () => {
  test("sends the mesh as a binary STL and gives back one render_png", async () => {
    const { target, got } = await slicer(200, PNG);
    const outputs = await meshPreviewOutputs(target, async () => stubGlb("mesh"));
    expect(outputs).toEqual([{ kind: "render_png", contentType: "image/png", bytes: PNG }]);
    expect(got).toHaveLength(1);
    expect(got[0]?.path).toBe("/v1/stl/png");
    expect(got[0]?.type).toBe("application/octet-stream");
    // One triangle: 84 bytes of header and count, then one 50-byte facet.
    expect(got[0]?.body.length).toBe(134);
    expect(got[0]?.body.readUInt32LE(80)).toBe(1);
  });

  test("a mesh that cannot be read fails with the preview sentence, and nothing is sent", async () => {
    const error = await failure(meshPreviewOutputs(NOWHERE, async () => Buffer.from("not a glb")));
    expect(error).toBeInstanceOf(RenderFailed);
    expect((error as Error).message.startsWith(`${DERIVED_MESSAGES.previewFailed} `)).toBe(true);
  });

  test("a mesh whose STL would be over the limit fails with the preview sentence, and nothing is sent", async () => {
    const error = await failure(meshPreviewOutputs(NOWHERE, async () => stubGlb("mesh"), 100));
    expect(error).toBeInstanceOf(RenderFailed);
    const message = (error as Error).message;
    expect(message.startsWith(`${DERIVED_MESSAGES.previewFailed} `)).toBe(true);
    expect(message).toMatch(/too large/i);
  });

  test("OpenSCAD's refusal is shown after the preview sentence", async () => {
    const message = "ERROR: CGAL error";
    const { target } = await slicer(422, { error: "render_failed", message });
    const error = await failure(meshPreviewOutputs(target, async () => stubGlb("mesh")));
    expect((error as Error).message).toBe(`${DERIVED_MESSAGES.previewRejected} ${message}`);
  });
});
