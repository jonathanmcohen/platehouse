// Review of PR #409, follow-up: no slicer answer is ever held whole in the
// app's memory. postRender streams a 200 body to a temp file (the caller's
// answer path) and stops as soon as it passes the route's cap, removing the
// file; the job then stores the file. Error bodies are small JSON or text and
// are read into memory only up to ERROR_ANSWER_MAX_BYTES. The slicer here is
// a plain node:http server on 127.0.0.1 sending synthetic bytes.
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS } from "@platehouse/slicer-contract";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  ANSWER_LIMITS,
  AnswerTooLarge,
  DERIVED_MESSAGES,
  ERROR_ANSWER_MAX_BYTES,
  isRetryable,
  postRender,
  RenderFailed,
  type RenderRequest,
  SandboxOff,
  SlicerDown,
  SlicerFault,
  type SlicerTarget,
  SlicerUnreachable,
  sandboxMessage,
  TempFileError,
} from "../../src/derived/client.js";

const MiB = 1024 * 1024;

let server: Server | undefined;
let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "answer-test-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
afterEach(async () => {
  const s = server;
  server = undefined;
  if (s) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

/** A slicer whose every answer handle() writes; returns the target and how many body bytes it got out. */
async function slicer(
  handle: (res: ServerResponse, sent: (n: number) => void) => void,
  timeouts: Partial<SlicerTarget> = {},
): Promise<{ target: SlicerTarget; sent: () => number }> {
  let total = 0;
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => handle(res, (n) => (total += n)));
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    target: {
      baseUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 10_000,
      uploadTimeoutMs: 10_000,
      ...timeouts,
    },
    sent: () => total,
  };
}

/** Writes size bytes of a known pattern a chunk at a time, waiting for the socket to drain. */
function stream(res: ServerResponse, size: number, sent: (n: number) => void): void {
  const chunk = Buffer.alloc(256 * 1024, 7);
  let left = size;
  const pump = (): void => {
    while (left > 0) {
      const n = Math.min(chunk.length, left);
      left -= n;
      sent(n);
      const more = res.write(n === chunk.length ? chunk : chunk.subarray(0, n));
      if (!more) {
        res.once("drain", pump);
        return;
      }
    }
    res.end();
  };
  res.on("close", () => {
    left = 0;
  });
  pump();
}

/** Bytes of a known pattern. */
function pattern(size: number): Buffer {
  const b = Buffer.alloc(size);
  for (let i = 0; i < size; i++) b[i] = (i * 31 + 7) % 256;
  return b;
}

function request(path: string, maxBytes: number): RenderRequest {
  return {
    route: "/v1/step/glb",
    body: Buffer.from("ISO-10303-21;"),
    contentType: "application/octet-stream",
    accept: "model/gltf-binary",
    refusal: "convert",
    tooLarge: "too large",
    answer: { path, maxBytes },
  };
}

/** Closes the current slicer, for a test that starts several. */
async function afterEachClose(): Promise<void> {
  const s = server;
  server = undefined;
  if (s) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
}

const failure = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

describe("a slicer answer", () => {
  test("is written to the answer file byte for byte, and its size given back", async () => {
    const body = pattern(3 * MiB + 17);
    const { target } = await slicer((res) => {
      res.writeHead(200, { "content-type": "model/gltf-binary" });
      res.end(body);
    });
    const path = join(dir, "normal.glb");
    const answer = await postRender(target, request(path, 4 * MiB));
    expect(answer).toEqual({ path, size: body.length });
    expect((await readFile(path)).equals(body)).toBe(true);
    await rm(path);
  });

  test("of exactly its cap is kept", async () => {
    const body = pattern(MiB);
    const { target } = await slicer((res) => {
      res.writeHead(200, { "content-type": "model/gltf-binary" });
      res.end(body);
    });
    const path = join(dir, "at-cap.glb");
    expect(await postRender(target, request(path, MiB))).toEqual({ path, size: MiB });
    await rm(path);
  });

  test("one byte over its cap fails with AnswerTooLarge, and its file no longer exists", async () => {
    const body = pattern(MiB + 1);
    const { target } = await slicer((res) => {
      res.writeHead(200, { "content-type": "model/gltf-binary" });
      res.end(body);
    });
    const path = join(dir, "over-cap.glb");
    const error = await failure(postRender(target, request(path, MiB)));
    expect(error).toBeInstanceOf(AnswerTooLarge);
    // The job ends as for any refused render, never retried.
    expect(error).toBeInstanceOf(RenderFailed);
    expect(isRetryable(error)).toBe(false);
    expect(existsSync(path)).toBe(false);
  });

  test("over its cap is refused while it streams, never held whole, and leaves no file", async () => {
    const size = 256 * MiB;
    const { target, sent } = await slicer((res, count) => {
      res.writeHead(200, { "content-type": "model/gltf-binary" });
      stream(res, size, count);
    });
    const path = join(dir, "huge.glb");
    const before = process.memoryUsage().arrayBuffers;
    let peak = before;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().arrayBuffers);
    }, 2);
    let error: unknown;
    try {
      error = await failure(postRender(target, request(path, MiB)));
    } finally {
      clearInterval(sampler);
    }
    expect(error).toBeInstanceOf(AnswerTooLarge);
    expect(error).toBeInstanceOf(RenderFailed);
    expect((error as Error).message).toMatch(/1 MiB/);
    expect(existsSync(path)).toBe(false);
    // The app stopped reading soon after the cap: the slicer got out only
    // what the sockets buffer, never the whole answer, and the app's memory
    // never held more than a few chunks of it.
    expect(sent()).toBeLessThan(64 * MiB);
    expect(peak - before).toBeLessThan(64 * MiB);
  });

  test("that stops part way leaves no file, and is a lost connection a retry may cure", async () => {
    const { target } = await slicer(
      (res) => {
        res.writeHead(200, { "content-type": "model/gltf-binary" });
        res.write(pattern(MiB));
        // Never ends: the answer timer gives up.
      },
      { timeoutMs: 300 },
    );
    const path = join(dir, "stalled.glb");
    const error = await failure(postRender(target, request(path, 4 * MiB)));
    expect(error).toBeInstanceOf(SlicerUnreachable);
    expect(isRetryable(error)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  test("cut off by the slicer part way leaves no file, and is a lost connection a retry may cure", async () => {
    const { target } = await slicer((res) => {
      res.writeHead(200, {
        "content-type": "model/gltf-binary",
        "content-length": String(4 * MiB),
      });
      res.write(pattern(MiB), () => res.destroy());
    });
    const path = join(dir, "cut.glb");
    const error = await failure(postRender(target, request(path, 8 * MiB)));
    expect(error).toBeInstanceOf(SlicerUnreachable);
    expect(isRetryable(error)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  test("that is a refusal (422) is read as before and leaves no file", async () => {
    const { target } = await slicer((res) => {
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "convert_failed", message: "no shapes in the file" }));
    });
    const path = join(dir, "refused.glb");
    const error = await failure(postRender(target, request(path, MiB)));
    expect(error).toBeInstanceOf(RenderFailed);
    expect(error).not.toBeInstanceOf(AnswerTooLarge);
    expect((error as Error).message).toBe("no shapes in the file");
    expect(existsSync(path)).toBe(false);
  });

  test("an error body over ERROR_ANSWER_MAX_BYTES is the slicer's fault, never read whole", async () => {
    const { target, sent } = await slicer((res, count) => {
      res.writeHead(422, { "content-type": "application/json" });
      stream(res, 256 * MiB, count);
    });
    const path = join(dir, "long-error.glb");
    const error = await failure(postRender(target, request(path, MiB)));
    expect(error).toBeInstanceOf(SlicerFault);
    expect(sent()).toBeLessThan(64 * MiB);
    expect(existsSync(path)).toBe(false);
    expect(ERROR_ANSWER_MAX_BYTES).toBeLessThanOrEqual(MiB);
  });

  test("a 200 with nothing in it, or of the wrong type, is the slicer's fault and leaves no file", async () => {
    for (const [type, body] of [
      ["model/gltf-binary", Buffer.alloc(0)],
      ["text/html", Buffer.from("<html></html>")],
    ] as const) {
      const { target } = await slicer((res) => {
        res.writeHead(200, { "content-type": type });
        res.end(body);
      });
      const path = join(dir, "odd.glb");
      expect(await failure(postRender(target, request(path, MiB)))).toBeInstanceOf(SlicerFault);
      expect(existsSync(path)).toBe(false);
      const s = server;
      server = undefined;
      s?.closeAllConnections();
      await new Promise<void>((resolve) => (s ? s.close(() => resolve()) : resolve()));
    }
  });

  test("a temp file that cannot be written fails as a temp file problem with the file system's error, not as a lost slicer", async () => {
    const { target } = await slicer((res) => {
      res.writeHead(200, { "content-type": "model/gltf-binary" });
      res.end(pattern(1024));
    });
    const error = await failure(
      postRender(target, request(join(dir, "no-such-folder", "a.glb"), MiB)),
    );
    expect(error).not.toBeInstanceOf(SlicerUnreachable);
    expect(error).toBeInstanceOf(TempFileError);
    expect((error as TempFileError).cause.code).toBe("ENOENT");
  });
});

describe("the answer caps", () => {
  test("every render route has one, from the slicer contract", () => {
    expect(ANSWER_LIMITS).toEqual({
      "/v1/scad/stl": LIMITS.renderOutputBytes,
      "/v1/scad/png": LIMITS.renderOutputBytes,
      "/v1/stl/png": LIMITS.renderOutputBytes,
      "/v1/step/glb": LIMITS.stepOutputBytes,
    });
    expect(LIMITS.renderOutputBytes).toBe(256 * MiB);
    expect(LIMITS.stepOutputBytes).toBe(256 * MiB);
  });
});

describe("a slicer whose sandbox is off", () => {
  const sandboxOffBody = (reason: string) =>
    JSON.stringify({ error: "sandbox_off", reason, detail: "the sandbox check said so" });

  test("a 503 sandbox_off is SandboxOff with its reason, not retried and not an outage", async () => {
    for (const reason of ["old_kernel", "check_failed"] as const) {
      const { target } = await slicer((res) => {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(sandboxOffBody(reason));
      });
      const error = await failure(postRender(target, request(join(dir, "off.glb"), MiB)));
      expect(error).toBeInstanceOf(SandboxOff);
      expect((error as SandboxOff).reason).toBe(reason);
      expect(error).not.toBeInstanceOf(SlicerDown);
      expect(isRetryable(error)).toBe(false);
      expect(existsSync(join(dir, "off.glb"))).toBe(false);
      await afterEachClose();
    }
  });

  test("a 503 outside the contract is a SlicerFault", async () => {
    for (const body of ["gone", JSON.stringify({ error: "sandbox_off", reason: "other" })]) {
      const { target } = await slicer((res) => {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(body);
      });
      const error = await failure(postRender(target, request(join(dir, "odd.glb"), MiB)));
      expect(error).toBeInstanceOf(SlicerFault);
      await afterEachClose();
    }
  });

  test("a 422 render_failed is always RenderFailed, whatever its message", async () => {
    const message = "OpenSCAD renders are off: the sandbox self-test failed.";
    const { target } = await slicer((res) => {
      res.writeHead(422, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "render_failed", message }));
    });
    const error = await failure(
      postRender(target, { ...request(join(dir, "old.png"), MiB), refusal: "render" }),
    );
    expect(error).toBeInstanceOf(RenderFailed);
    expect(error).not.toBeInstanceOf(SlicerDown);
    expect((error as Error).message).toBe(message);
  });

  test("sandboxMessage picks the picture and render sentence, or the STEP preview one", () => {
    for (const kind of ["scad", "stl", "preview"] as const) {
      expect(sandboxMessage(kind, "old_kernel")).toBe(DERIVED_MESSAGES.sandboxOffKernel);
      expect(sandboxMessage(kind, "check_failed")).toBe(DERIVED_MESSAGES.sandboxOffCheck);
    }
    expect(sandboxMessage("step", "old_kernel")).toBe(DERIVED_MESSAGES.convertSandboxOffKernel);
    expect(sandboxMessage("step", "check_failed")).toBe(DERIVED_MESSAGES.convertSandboxOffCheck);
  });

  test("the four sentences are the ones users read", () => {
    expect(DERIVED_MESSAGES.sandboxOffKernel).toBe(
      "Pictures and OpenSCAD renders are off on this server: its kernel is older than Linux 6.12.",
    );
    expect(DERIVED_MESSAGES.sandboxOffCheck).toBe(
      "Pictures and OpenSCAD renders are off on this server: its sandbox check failed.",
    );
    expect(DERIVED_MESSAGES.convertSandboxOffKernel).toBe(
      "STEP previews are off on this server: its kernel is older than Linux 6.12.",
    );
    expect(DERIVED_MESSAGES.convertSandboxOffCheck).toBe(
      "STEP previews are off on this server: its sandbox check failed.",
    );
  });
});
