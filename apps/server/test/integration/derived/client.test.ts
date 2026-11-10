// The render client's timers (build plan Task 13, PR #60 review). A render
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
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  isRetryable,
  postRender,
  RENDER_TIMEOUT_MS,
  RENDER_UPLOAD_TIMEOUT_MS,
  RenderFailed,
  SANDBOX_OFF_PREFIX,
  SlicerDown,
  SlicerUnreachable,
} from "../../../src/derived/client.js";

const GLB = "model/gltf-binary";

let server: Server | undefined;

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
  };
}

describe("render request timers", () => {
  test("the program's time starts once the body is sent, so a slow body still gets its answer", async () => {
    const baseUrl = await slicer();
    // The body takes about 600 ms to arrive, three times the program budget.
    const bytes = await postRender(
      { baseUrl, timeoutMs: 200, uploadTimeoutMs: 5_000 },
      stepRequest(trickle(6, 100)),
    );
    expect(bytes.toString("utf8")).toBe("glb:chunk1;chunk2;chunk3;chunk4;chunk5;chunk6;");
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

  test("a 422 saying OpenSCAD renders are off is the slicer's fault, not the file's", async () => {
    const message = `${SANDBOX_OFF_PREFIX} the sandbox self-test failed (the probe was readable).`;
    const baseUrl = await answering(422, { error: "render_failed", message });
    const error = await failure(postRender(target(baseUrl), scadRequest()));
    expect(error).toBeInstanceOf(SlicerDown);
    expect(error).not.toBeInstanceOf(RenderFailed);
    expect((error as Error).message).toContain(message);
    expect(isRetryable(error)).toBe(false);
  });

  test("OpenSCAD's own render error is still the file's: RenderFailed with its message", async () => {
    const message = 'ERROR: Parser error in file "input.scad", line 3: syntax error';
    const baseUrl = await answering(422, { error: "render_failed", message });
    const error = await failure(postRender(target(baseUrl), scadRequest()));
    expect(error).toBeInstanceOf(RenderFailed);
    expect((error as Error).message).toBe(message);
  });

  test("the sandbox-off prefix is the one the slicer writes in apps/slicer/src/server.ts", async () => {
    const slicerServer = await readFile(
      fileURLToPath(new URL("../../../../slicer/src/server.ts", import.meta.url)),
      "utf8",
    );
    expect(slicerServer).toContain(`message: \`${SANDBOX_OFF_PREFIX} `);
  });
});
