// The render client's timers (PR #60 review). A render
// request has two budgets: the time to send its body, which for a STEP file
// streamed from the bucket can be long, and the slicer's own time cap for the
// program plus 30 s, which starts once the body is sent. A slow body must not
// eat the program's time, and a body that stalls must still be given up on.
// These need no containers: the slicer is a plain node:http server on
// 127.0.0.1 that holds nothing but synthetic bytes.
//
// It also pins how the client tells a slicer that cannot render right now (it
// takes no connection, or its OpenSCAD sandbox self-test failed) from a lost
// connection and from OpenSCAD's own verdict on the file.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  isRetryable,
  postRender,
  RENDER_TIMEOUT_MS,
  RENDER_UPLOAD_TIMEOUT_MS,
  RenderFailed,
  SandboxOff,
  SlicerDown,
  SlicerUnreachable,
} from "../../../src/derived/client.js";
import { StoreUnavailable } from "../../../src/storage/s3.js";

const GLB = "model/gltf-binary";

let server: Server | undefined;

/** Where each request's answer is streamed, as a job's temp folder would hold it. */
let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "render-client-"));
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

/** A slicer that reads the whole body, waits answerAfterMs, and answers a GLB. */
async function slicer(answerAfterMs = 0): Promise<string> {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": GLB });
        res.end(Buffer.concat([Buffer.from("glb:"), Buffer.concat(chunks)]));
      }, answerAfterMs);
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** A body that sends count chunks, one every everyMs, and then ends; or never ends. */
function trickle(count: number, everyMs: number, end = true): Readable {
  let sent = 0;
  return new Readable({
    read() {
      if (sent === count) {
        if (end) this.push(null);
        return;
      }
      sent += 1;
      setTimeout(() => this.push(Buffer.from(`chunk${sent};`)), everyMs);
    },
  });
}

function stepRequest(body: Readable) {
  return {
    route: "/v1/step/glb" as const,
    body,
    contentType: "application/octet-stream",
    accept: GLB,
    refusal: "convert" as const,
    tooLarge: "too large",
    answer: { path: join(dir, "mesh.glb") },
  };
}

describe("render request timers", () => {
  test("the program's time starts once the body is sent, so a slow body still gets its answer", async () => {
    const baseUrl = await slicer();
    // The body takes about 600 ms to arrive, three times the program budget.
    const answer = await postRender(
      { baseUrl, timeoutMs: 200, uploadTimeoutMs: 5_000 },
      stepRequest(trickle(6, 100)),
    );
    expect((await readFile(answer.path)).toString("utf8")).toBe(
      "glb:chunk1;chunk2;chunk3;chunk4;chunk5;chunk6;",
    );
  });

  test("a program that runs past its time after the body is sent is given up on", async () => {
    const baseUrl = await slicer(800);
    const error = await postRender(
      { baseUrl, timeoutMs: 200, uploadTimeoutMs: 5_000 },
      stepRequest(trickle(2, 10)),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SlicerUnreachable);
  });

  test("a body that stalls is given up on at the upload allowance, not the program's time", async () => {
    const baseUrl = await slicer();
    const started = Date.now();
    const error = await postRender(
      { baseUrl, timeoutMs: 10_000, uploadTimeoutMs: 300 },
      stepRequest(trickle(1, 10, false)),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SlicerUnreachable);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("the defaults: the slicer's 600 s upload allowance, and its 120 s cap plus 30 s", () => {
    expect(RENDER_UPLOAD_TIMEOUT_MS).toBe(600_000);
    expect(RENDER_TIMEOUT_MS).toBe(150_000);
    // Both together fit inside pg-boss's default 15-minute job expiry.
    expect(RENDER_UPLOAD_TIMEOUT_MS + RENDER_TIMEOUT_MS).toBeLessThan(15 * 60 * 1000);
  });
});

/** A body that sends count chunks and then fails with error, as a store going away would. */
function failingAfter(count: number, error: Error): Readable {
  let sent = 0;
  return new Readable({
    read() {
      if (sent === count) {
        setTimeout(() => this.destroy(error), 10);
        return;
      }
      sent += 1;
      setTimeout(() => this.push(Buffer.from(`chunk${sent};`)), 10);
    },
  });
}

// PR #60 review: a STEP body is read from the bucket as it is sent. When the
// body itself fails partway (the store went away), that is the body's error,
// passed on as it is, never a lost slicer connection: a StoreUnavailable
// must reach the job as one so the job waits for the store.
describe("a body that fails partway through the send", () => {
  test("rejects with the body's own error, not SlicerUnreachable", async () => {
    const baseUrl = await slicer();
    const outage = new StoreUnavailable("GetObject", "ECONNRESET");
    const error = await postRender(
      { baseUrl, timeoutMs: 5_000, uploadTimeoutMs: 5_000 },
      stepRequest(failingAfter(3, outage)),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBe(outage);
    expect(isRetryable(error)).toBe(false);
  });

  test("a slicer that drops the connection while the body is sent is still SlicerUnreachable", async () => {
    server = createServer((req: IncomingMessage) => {
      req.once("data", () => req.socket.destroy());
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    const error = await postRender(
      { baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 5_000, uploadTimeoutMs: 5_000 },
      stepRequest(trickle(50, 10)),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SlicerUnreachable);
  });
});

/** A slicer that answers every request with status and a JSON body. */
async function answering(status: number, body: unknown): Promise<string> {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

/** A URL on 127.0.0.1 where nothing listens, so a connection is refused. */
async function nothingListening(): Promise<string> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", () => resolve()));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

function scadRequest() {
  return {
    route: "/v1/scad/stl" as const,
    body: Buffer.from("cube([10, 10, 10]);\n"),
    contentType: "text/plain; charset=utf-8",
    accept: "model/stl",
    refusal: "render" as const,
    tooLarge: "too large",
    answer: { path: join(dir, "render.stl") },
  };
}

const failure = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

const target = (baseUrl: string) => ({ baseUrl, timeoutMs: 5_000, uploadTimeoutMs: 5_000 });

describe("a slicer that cannot render right now", () => {
  test("a slicer that takes no connection is down, not a lost connection, and uses no retry", async () => {
    const error = await failure(postRender(target(await nothingListening()), scadRequest()));
    expect(error).toBeInstanceOf(SlicerDown);
    expect(isRetryable(error)).toBe(false);
  });

  test("a STEP body sent to a slicer that takes no connection is down too", async () => {
    const baseUrl = await nothingListening();
    const error = await failure(postRender(target(baseUrl), stepRequest(trickle(2, 10))));
    expect(error).toBeInstanceOf(SlicerDown);
  });

  test("a connection the slicer took and then lost is still a lost connection", async () => {
    server = createServer((req: IncomingMessage) => {
      req.resume();
      req.on("end", () => req.socket.destroy());
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    const error = await failure(postRender(target(`http://127.0.0.1:${port}`), scadRequest()));
    expect(error).toBeInstanceOf(SlicerUnreachable);
    expect(isRetryable(error)).toBe(true);
  });

  test("a 503 sandbox_off is the slicer's sandbox, not the file's: SandboxOff with its reason", async () => {
    const baseUrl = await answering(503, {
      error: "sandbox_off",
      reason: "old_kernel",
      detail: "the kernel is too old",
    });
    const error = await failure(postRender(target(baseUrl), scadRequest()));
    expect(error).toBeInstanceOf(SandboxOff);
    expect((error as SandboxOff).reason).toBe("old_kernel");
    expect(error).not.toBeInstanceOf(SlicerDown);
    expect(error).not.toBeInstanceOf(RenderFailed);
    expect(isRetryable(error)).toBe(false);
  });

  test("a 422 that starts with the old sandbox sentence is OpenSCAD's verdict now: RenderFailed", async () => {
    const message =
      "OpenSCAD renders are off: the sandbox self-test failed (the probe was readable).";
    const baseUrl = await answering(422, { error: "render_failed", message });
    const error = await failure(postRender(target(baseUrl), scadRequest()));
    expect(error).toBeInstanceOf(RenderFailed);
    expect(error).not.toBeInstanceOf(SlicerDown);
    expect((error as Error).message).toBe(message);
  });

  test("OpenSCAD's own render error is still the file's: RenderFailed with its message", async () => {
    const message = 'ERROR: Parser error in file "input.scad", line 3: syntax error';
    const baseUrl = await answering(422, { error: "render_failed", message });
    const error = await failure(postRender(target(baseUrl), scadRequest()));
    expect(error).toBeInstanceOf(RenderFailed);
    expect((error as Error).message).toBe(message);
  });

  // Issue #316: /v1/stl/png is new in this release. A slicer image older
  // than the app answers it 404 not_found. That says nothing about the file,
  // so the job waits for the slicer, as for one that is down, instead of
  // marking every STL failed until it is uploaded again.
  test("a 404 from a render route is a slicer older than the app: down, not the file's fault", async () => {
    const baseUrl = await answering(404, { error: "not_found" });
    const error = await failure(
      postRender(target(baseUrl), {
        route: "/v1/stl/png",
        body: Buffer.from("solid x\nendsolid x\n"),
        contentType: "application/octet-stream",
        accept: "image/png",
        refusal: "render",
        tooLarge: "too large",
        answer: { path: join(dir, "preview.png") },
      }),
    );
    expect(error).toBeInstanceOf(SlicerDown);
    expect((error as Error).message).toContain("/v1/stl/png");
    expect(isRetryable(error)).toBe(false);
  });

  test("the slicer answers sandbox_off in apps/slicer/src/server.ts", async () => {
    const slicerServer = await readFile(
      fileURLToPath(new URL("../../../../slicer/src/server.ts", import.meta.url)),
      "utf8",
    );
    expect(slicerServer).toContain('error: "sandbox_off"');
    expect(slicerServer).not.toContain("OpenSCAD renders are off:");
  });
});
