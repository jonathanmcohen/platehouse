// A slicer stub for the derived-file tests (build plan Task 13), built on
// packages/slicer-contract: every JSON body it sends is parsed with the
// contract's own zod schema first, its body limits are the contract's LIMITS,
// and its success answers carry the contract's content types. It answers the
// three render routes (POST /v1/scad/stl, /v1/scad/png, /v1/step/glb) and
// GET /v1/health; anything else is 404 not_found, as the real slicer answers.
//
// A test scripts what a route answers next (queue) or from now on (always);
// with nothing scripted a route renders: it answers 200 with bytes made from
// the body it was sent, so a test can tell which source a stored render came
// from. Every request is recorded with the body that arrived.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { CONTRACT_VERSION, LIMITS, slicerContract } from "@platehouse/slicer-contract";

export type RenderRoute = "/v1/scad/stl" | "/v1/scad/png" | "/v1/step/glb";

export const RENDER_ROUTES: readonly RenderRoute[] = [
  "/v1/scad/stl",
  "/v1/scad/png",
  "/v1/step/glb",
];

/** What a route answers to one request. */
export type StubAnswer =
  /** 200 with the stub's own bytes for the body (renderedBytes). */
  | { kind: "render" }
  /** 422 render_failed (scad routes) or convert_failed (step) with this message. */
  | { kind: "failed"; message: string }
  /** 409 busy, answered before the body is read, as the slicer's lock does. */
  | { kind: "busy" }
  /** The body is read, then the connection is dropped with no answer: a slicer restart. */
  | { kind: "drop" }
  /** 500 with a plain-text body, the contract's answer to an unexpected error. */
  | { kind: "error" };

export interface StubCall {
  route: string;
  contentType: string | undefined;
  body: Buffer;
  answer: StubAnswer["kind"];
}

export interface SlicerStub {
  url: string;
  calls: StubCall[];
  /** Answers for the next requests to a route, used in order before `always`. */
  queue(route: RenderRoute, ...answers: StubAnswer[]): void;
  /** What a route answers once its queue is empty. */
  always(route: RenderRoute, answer: StubAnswer): void;
  /** Clears every script and the recorded calls. */
  reset(): void;
  /** Calls to one route so far. */
  callsTo(route: RenderRoute): StubCall[];
  close(): Promise<void>;
}

const CONTENT_TYPE: Readonly<Record<RenderRoute, string>> = {
  "/v1/scad/stl": "model/stl",
  "/v1/scad/png": "image/png",
  "/v1/step/glb": "model/gltf-binary",
};

const BODY_LIMIT: Readonly<Record<RenderRoute, number>> = {
  "/v1/scad/stl": LIMITS.scadBodyBytes,
  "/v1/scad/png": LIMITS.scadBodyBytes,
  "/v1/step/glb": LIMITS.stepBodyBytes,
};

const MAGIC: Readonly<Record<RenderRoute, Buffer>> = {
  "/v1/scad/stl": Buffer.from("solid stub\n", "latin1"),
  "/v1/scad/png": Buffer.from("\x89PNG\r\n\x1a\n", "latin1"),
  "/v1/step/glb": Buffer.from("glTF", "latin1"),
};

/** The bytes the stub renders for a body on a route: the route's magic and the body's SHA-256. */
export function renderedBytes(route: RenderRoute, body: Buffer | string): Buffer {
  const digest = createHash("sha256").update(body).digest("hex");
  return Buffer.concat([MAGIC[route], Buffer.from(`${route} ${digest}\n`, "latin1")]);
}

function isRenderRoute(path: string): path is RenderRoute {
  return (RENDER_ROUTES as readonly string[]).includes(path);
}

function sendJson(res: ServerResponse, status: number, body: unknown, close = false): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    ...(close ? { connection: "close" } : {}),
  });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export async function startSlicerStub(): Promise<SlicerStub> {
  const calls: StubCall[] = [];
  const queued = new Map<RenderRoute, StubAnswer[]>();
  const standing = new Map<RenderRoute, StubAnswer>();

  const next = (route: RenderRoute): StubAnswer =>
    queued.get(route)?.shift() ?? standing.get(route) ?? { kind: "render" };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? "/", "http://stub").pathname;
    if (req.method === "GET" && path === "/v1/health") {
      return sendJson(
        res,
        200,
        slicerContract.health.parse({
          contract: CONTRACT_VERSION,
          orca: "2.5.0",
          openscad: "2026.11-RC0",
          busy: false,
        }),
      );
    }
    if (req.method !== "POST" || !isRenderRoute(path)) {
      return sendJson(res, 404, slicerContract.error.parse({ error: "not_found" }), true);
    }
    const answer = next(path);
    const contentType = req.headers["content-type"];
    if (answer.kind === "busy") {
      calls.push({ route: path, contentType, body: Buffer.alloc(0), answer: answer.kind });
      req.resume();
      return sendJson(res, 409, slicerContract.error.parse({ error: "busy" }), true);
    }
    const body = await readBody(req);
    calls.push({ route: path, contentType, body, answer: answer.kind });
    if (body.length > BODY_LIMIT[path]) {
      return sendJson(res, 413, slicerContract.error.parse({ error: "too_large" }));
    }
    switch (answer.kind) {
      case "render": {
        const bytes = renderedBytes(path, body);
        res.writeHead(200, { "content-type": CONTENT_TYPE[path], "content-length": bytes.length });
        res.end(bytes);
        return;
      }
      case "failed":
        return sendJson(
          res,
          422,
          path === "/v1/step/glb"
            ? slicerContract.convertError.parse({
                error: "convert_failed",
                message: answer.message,
              })
            : slicerContract.renderError.parse({ error: "render_failed", message: answer.message }),
        );
      case "drop":
        req.socket.destroy();
        return;
      case "error": {
        const text = "stub: unexpected error\n";
        res.writeHead(500, {
          "content-type": "text/plain",
          "content-length": Buffer.byteLength(text),
        });
        res.end(text);
        return;
      }
    }
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    queue(route, ...answers) {
      queued.set(route, [...(queued.get(route) ?? []), ...answers]);
    },
    always(route, answer) {
      standing.set(route, answer);
    },
    reset() {
      queued.clear();
      standing.clear();
      calls.length = 0;
    },
    callsTo(route) {
      return calls.filter((c) => c.route === route);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
