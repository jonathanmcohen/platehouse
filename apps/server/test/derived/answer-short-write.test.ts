// A file handle's write may write fewer bytes than it was given. postRender
// writes each chunk of a slicer answer until all of it is in the answer
// file, so a short write can never store a truncated answer. Here every
// write of the answer file writes at most 1000 bytes.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

const SHORT = 1000;
const writes = vi.hoisted(() => ({ calls: 0 }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  const open = async (...args: Parameters<typeof real.open>) => {
    const handle = await real.open(...args);
    return new Proxy(handle, {
      get(target, key) {
        if (key === "write") {
          return (buffer: Uint8Array, offset = 0, length?: number, position?: number | null) => {
            writes.calls += 1;
            const want = length ?? buffer.byteLength - offset;
            return target.write(buffer, offset, Math.min(want, SHORT), position);
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  return { ...real, open, default: { ...real, open } };
});

import { postRender } from "../../src/derived/client.js";

let dir = "";
let server: Server | undefined;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "answer-short-write-"));
});
afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await rm(dir, { recursive: true, force: true });
});

test("an answer written in short writes is still stored whole", async () => {
  const body = Buffer.alloc(300 * 1024 + 17);
  for (let i = 0; i < body.length; i++) body[i] = (i * 31 + 7) % 256;
  server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "model/gltf-binary" });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  const path = join(dir, "short.glb");
  const answer = await postRender(
    { baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 10_000, uploadTimeoutMs: 10_000 },
    {
      route: "/v1/step/glb",
      body: Buffer.from("ISO-10303-21;"),
      contentType: "application/octet-stream",
      accept: "model/gltf-binary",
      refusal: "convert",
      tooLarge: "too large",
      answer: { path, maxBytes: 1024 * 1024 },
    },
  );
  expect(answer).toEqual({ path, size: body.length });
  expect((await readFile(path)).equals(body)).toBe(true);
  // Each write wrote at most SHORT bytes, so it took many of them.
  expect(writes.calls).toBeGreaterThanOrEqual(Math.ceil(body.length / SHORT));
});
