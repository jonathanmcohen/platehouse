// A slicer stub for the estimate tests (build plan Task 12), built on the
// slicer contract package so it cannot drift from contract v1: every answer
// it sends is parsed with the contract's own zod schema first, and a test
// that scripts an answer the contract does not allow fails right there. The
// query is read with the contract's sliceQuery, the body limit is the
// contract's, and a 409 busy is answered before the body is read and with the
// connection closed, as the real slicer does.
//
// Like the real slicer it reads the posted .3mf (packages/threemf) and
// reports, for each project filament slot in slot order, the default preset
// /v1/profiles lists for the printer and the slot's type, or null where none
// is listed and the file's own filament is kept.
//
// It also answers the three render routes Task 13 calls, POST /v1/scad/stl,
// /v1/scad/png and /v1/step/glb (the renders group below): by default with
// bytes made from the body it was sent, so a test can tell which source a
// stored render came from, or as a test scripts it.
//
// It listens on 127.0.0.1 only and holds nothing but synthetic data.
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTRACT_VERSION,
  type FilamentProfile,
  LIMITS,
  type Printer,
  type Reason,
  type SliceFilament,
  slicerContract,
} from "@platehouse/slicer-contract";
import { readProject } from "@platehouse/threemf";

/**
 * Three printers of the 56 Orca 2.5.0 ships, enough for the printer tests.
 * Their BBL model ids are the ones slice_info.config names them by.
 */
export const STUB_PRINTERS: Printer[] = [
  { id: "Bambu Lab P1S 0.4 nozzle", model: "Bambu Lab P1S", modelId: "C12", nozzle: 0.4 },
  {
    id: "Bambu Lab X1 Carbon 0.4 nozzle",
    model: "Bambu Lab X1 Carbon",
    modelId: "BL-P001",
    nozzle: 0.4,
  },
  { id: "Bambu Lab A1 0.4 nozzle", model: "Bambu Lab A1", modelId: "N2S", nozzle: 0.4 },
];

/**
 * Each printer's default filaments. PETG on the A1 has none here, so a slice
 * there keeps the file's own filament for that slot (filamentProfiles null).
 */
export const STUB_FILAMENTS: FilamentProfile[] = [
  { printer: "Bambu Lab A1 0.4 nozzle", type: "PLA", profile: "Generic PLA @BBL A1" },
  { printer: "Bambu Lab P1S 0.4 nozzle", type: "PETG", profile: "Generic PETG @BBL P1S" },
  { printer: "Bambu Lab P1S 0.4 nozzle", type: "PLA", profile: "Bambu PLA Basic @BBL P1S" },
  { printer: "Bambu Lab X1 Carbon 0.4 nozzle", type: "PETG", profile: "Bambu PETG HF @BBL X1C" },
  { printer: "Bambu Lab X1 Carbon 0.4 nozzle", type: "PLA", profile: "Bambu PLA Basic @BBL X1C" },
];

/** One POST /v1/slice the stub received. */
export interface StubCall {
  printer: string;
  plate: number;
  bytes: number;
}

/** What the stub does with one slice request. */
export type StubOutcome =
  /** 200 ok with numbers; time and weight default from the plate number. */
  | { kind: "ok"; timeSeconds?: number; weightGrams?: number }
  /** 200 failed with a contract reason. */
  | { kind: "failed"; code: number | null; reason: Reason; detail: string }
  /** 409 busy, before the body is read, connection closed. */
  | { kind: "busy" }
  /** The connection is cut once the body is in, as when the slicer restarts mid-slice. */
  | { kind: "drop" }
  /** Nothing is answered until the stub stops. */
  | { kind: "hang" };

/** A render route of contract v1 (Task 13). */
export type RenderRoute = "/v1/scad/stl" | "/v1/scad/png" | "/v1/step/glb";

const RENDER_ROUTES: readonly RenderRoute[] = ["/v1/scad/stl", "/v1/scad/png", "/v1/step/glb"];

/** What a render route answers to one request. */
export type RenderAnswer =
  /** 200 with renderedBytes for the body, in the route's content type. */
  | { kind: "render" }
  /** 422 render_failed (scad routes) or convert_failed (step) with this message. */
  | { kind: "failed"; message: string }
  /** 409 busy, before the body is read, connection closed. */
  | { kind: "busy" }
  /** The connection is cut once the body is in, as when the slicer restarts mid-render. */
  | { kind: "drop" };

/** One render request the stub received. */
export interface RenderCall {
  route: RenderRoute;
  contentType: string | undefined;
  /** The body that arrived (empty for a busy answer, which reads none). */
  body: Buffer;
  answer: RenderAnswer["kind"];
}

/** The render routes' calls and script. */
export interface RenderStub {
  calls: RenderCall[];
  /** Answers for a route's next requests, used in order before `always`. */
  queue(route: RenderRoute, ...answers: RenderAnswer[]): void;
  /** What a route answers once its queue is empty; render when never set. */
  always(route: RenderRoute, answer: RenderAnswer): void;
  /** Clears every script and the recorded calls. */
  reset(): void;
  callsTo(route: RenderRoute): RenderCall[];
}

const RENDER_CONTENT_TYPE: Readonly<Record<RenderRoute, string>> = {
  "/v1/scad/stl": "model/stl",
  "/v1/scad/png": "image/png",
  "/v1/step/glb": "model/gltf-binary",
};

const RENDER_LIMIT: Readonly<Record<RenderRoute, number>> = {
  "/v1/scad/stl": LIMITS.scadBodyBytes,
  "/v1/scad/png": LIMITS.scadBodyBytes,
  "/v1/step/glb": LIMITS.stepBodyBytes,
};

const RENDER_MAGIC: Readonly<Record<RenderRoute, Buffer>> = {
  "/v1/scad/stl": Buffer.from("solid stub\n", "latin1"),
  "/v1/scad/png": Buffer.from("\x89PNG\r\n\x1a\n", "latin1"),
  "/v1/step/glb": Buffer.from("glTF", "latin1"),
};

/** The bytes the stub renders for a body on a route: the route's magic and the body's SHA-256. */
export function renderedBytes(route: RenderRoute, body: Buffer | string): Buffer {
  const digest = createHash("sha256").update(body).digest("hex");
  return Buffer.concat([RENDER_MAGIC[route], Buffer.from(`${route} ${digest}\n`, "latin1")]);
}

export interface SlicerStub {
  url: string;
  /** The render routes (Task 13). */
  renders: RenderStub;
  /** Every slice request in arrival order, busy ones included. */
  calls: StubCall[];
  /** How many times GET /v1/profiles was asked. */
  readonly profileRequests: number;
  /** The Orca version /v1/health, /v1/profiles and every slice report. */
  setOrca(version: string): void;
  /** Decides each slice request's outcome; the default is ok. */
  onSlice(decide: (call: StubCall, n: number) => StubOutcome): void;
  /** Holds every slice answer until release() is called (ok answers keep their outcome). */
  hold(): { release(): void };
  /**
   * Stops listening and cuts every connection, as a slicer that is stopped
   * or restarting: every request is refused until up().
   */
  down(): Promise<void>;
  /** Listens again on the same port. */
  up(): Promise<void>;
  stop(): Promise<void>;
}

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * Half-closes after the answer and discards whatever body still arrives, so
 * the client reads the answer instead of a reset: the real slicer's
 * closeLingering (apps/slicer/src/guard.ts), for the same reason.
 */
function closeLingering(socket: Socket): void {
  if (socket.destroyed) return;
  const timer = setTimeout(() => socket.destroy(), 5_000);
  timer.unref();
  socket.once("close", () => clearTimeout(timer));
  socket.once("end", () => socket.destroy());
  socket.on("error", () => socket.destroy());
  socket.on("data", () => {});
  socket.resume();
  socket.end();
}

/**
 * A refusal answered before the body is read, with Connection: close, as the
 * real slicer's refuseEarly: Node's own destroySoon is replaced so the
 * connection is not reset under the answer.
 */
function refuseEarly(res: ServerResponse, status: number, body: unknown): void {
  const socket = res.socket;
  if (socket) socket.destroySoon = () => closeLingering(socket);
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    connection: "close",
  });
  res.end(text, () => {
    if (socket) closeLingering(socket);
  });
}

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > LIMITS.sliceBodyBytes) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export async function startSlicerStub(
  opts: { orca?: string; printers?: Printer[]; filaments?: FilamentProfile[] } = {},
): Promise<SlicerStub> {
  let orca = opts.orca ?? "2.5.0";
  const printers = opts.printers ?? STUB_PRINTERS;
  const filaments = opts.filaments ?? STUB_FILAMENTS;
  const calls: StubCall[] = [];
  let profileRequests = 0;
  let decide: (call: StubCall, n: number) => StubOutcome = () => ({ kind: "ok" });
  let gate: Promise<void> | null = null;
  const sockets = new Set<Socket>();
  const hung: ServerResponse[] = [];
  const dir = await mkdtemp(join(tmpdir(), "platehouse-slicer-stub-"));

  async function slice(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const query = slicerContract.sliceQuery.safeParse(Object.fromEntries(url.searchParams));
    if (!query.success || !printers.some((p) => p.id === query.data.printer)) {
      req.resume();
      return sendJson(
        res,
        400,
        slicerContract.error.parse({ error: "bad_request", message: "unknown printer or plate" }),
      );
    }
    const length = Number(req.headers["content-length"] ?? "0");
    const call: StubCall = { printer: query.data.printer, plate: query.data.plate, bytes: length };
    calls.push(call);
    const outcome = decide(call, calls.length);
    if (outcome.kind === "busy") {
      return refuseEarly(res, 409, slicerContract.error.parse({ error: "busy" }));
    }
    if (length > LIMITS.sliceBodyBytes) {
      return refuseEarly(res, 413, slicerContract.error.parse({ error: "too_large" }));
    }
    const body = await readBody(req);
    if (body === null) {
      return refuseEarly(res, 413, slicerContract.error.parse({ error: "too_large" }));
    }
    call.bytes = body.length;
    if (!body.subarray(0, 4).equals(ZIP_MAGIC)) {
      return sendJson(res, 422, slicerContract.error.parse({ error: "not_3mf" }));
    }
    const path = join(dir, `${randomBytes(8).toString("hex")}.3mf`);
    await writeFile(path, body);
    const project = await readProject(path);
    await rm(path, { force: true });
    if (project === null)
      return sendJson(res, 422, slicerContract.error.parse({ error: "not_3mf" }));

    if (gate) await gate;
    if (outcome.kind === "drop") {
      req.socket.destroy();
      return;
    }
    if (outcome.kind === "hang") {
      hung.push(res);
      return;
    }
    const head = { contract: CONTRACT_VERSION, orca, plate: call.plate };
    if (outcome.kind === "failed") {
      return sendJson(
        res,
        200,
        slicerContract.sliceResult.parse({
          ...head,
          status: "failed",
          code: outcome.code,
          reason: outcome.reason,
          detail: outcome.detail,
        }),
      );
    }
    const slots = [...project.projectFilaments].sort((a, b) => a.slot - b.slot);
    const filamentProfiles = slots.map(
      (f) =>
        filaments.find((p) => p.printer === call.printer && p.type === f.type)?.profile ?? null,
    );
    const weightGrams = outcome.weightGrams ?? 5 * call.plate + 0.25;
    const used = slots.slice(0, Math.max(1, Math.min(2, slots.length)));
    const sliced: SliceFilament[] =
      used.length === 0
        ? [{ slot: 1, type: "PLA", color: null, grams: weightGrams }]
        : used.map((f, i) => ({
            slot: f.slot,
            type: f.type,
            color: f.colour,
            grams: i === 0 ? weightGrams - 0.25 * (used.length - 1) : 0.25,
          }));
    return sendJson(
      res,
      200,
      slicerContract.sliceResult.parse({
        ...head,
        status: "ok",
        printer: call.printer,
        process: project.processName ?? null,
        filamentProfiles,
        timeSeconds: outcome.timeSeconds ?? 600 * call.plate,
        weightGrams,
        filaments: sliced,
        wallMs: 5,
        peakRssBytes: 1_000_000,
      }),
    );
  }

  const renderCalls: RenderCall[] = [];
  const renderQueue = new Map<RenderRoute, RenderAnswer[]>();
  const renderAlways = new Map<RenderRoute, RenderAnswer>();

  async function render(req: IncomingMessage, res: ServerResponse, route: RenderRoute) {
    const answer = renderQueue.get(route)?.shift() ?? renderAlways.get(route) ?? { kind: "render" };
    const contentType = req.headers["content-type"];
    if (answer.kind === "busy") {
      renderCalls.push({ route, contentType, body: Buffer.alloc(0), answer: answer.kind });
      return refuseEarly(res, 409, slicerContract.error.parse({ error: "busy" }));
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      total += (chunk as Buffer).length;
      if (total > RENDER_LIMIT[route]) {
        return refuseEarly(res, 413, slicerContract.error.parse({ error: "too_large" }));
      }
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks);
    renderCalls.push({ route, contentType, body, answer: answer.kind });
    switch (answer.kind) {
      case "render": {
        const bytes = renderedBytes(route, body);
        res.writeHead(200, {
          "content-type": RENDER_CONTENT_TYPE[route],
          "content-length": bytes.length,
        });
        res.end(bytes);
        return;
      }
      case "failed":
        return sendJson(
          res,
          422,
          route === "/v1/step/glb"
            ? slicerContract.convertError.parse({
                error: "convert_failed",
                message: answer.message,
              })
            : slicerContract.renderError.parse({ error: "render_failed", message: answer.message }),
        );
      case "drop":
        req.socket.destroy();
        return;
    }
  }

  const renders: RenderStub = {
    calls: renderCalls,
    queue(route, ...answers) {
      renderQueue.set(route, [...(renderQueue.get(route) ?? []), ...answers]);
    },
    always(route, answer) {
      renderAlways.set(route, answer);
    },
    reset() {
      renderQueue.clear();
      renderAlways.clear();
      renderCalls.length = 0;
    },
    callsTo(route) {
      return renderCalls.filter((c) => c.route === route);
    },
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const route = `${req.method} ${url.pathname}`;
    const handle = async () => {
      if (req.method === "POST" && (RENDER_ROUTES as readonly string[]).includes(url.pathname)) {
        return render(req, res, url.pathname as RenderRoute);
      }
      switch (route) {
        case "GET /v1/health":
          return sendJson(
            res,
            200,
            slicerContract.health.parse({
              contract: CONTRACT_VERSION,
              orca,
              openscad: "2026.11-RC0",
              busy: false,
            }),
          );
        case "GET /v1/profiles":
          profileRequests += 1;
          return sendJson(
            res,
            200,
            slicerContract.profiles.parse({
              contract: CONTRACT_VERSION,
              orca,
              printers,
              filaments,
            }),
          );
        case "POST /v1/slice":
          return slice(req, res, url);
        default:
          req.resume();
          return sendJson(res, 404, slicerContract.error.parse({ error: "not_found" }));
      }
    };
    handle().catch((error: unknown) => {
      // A scripted answer the contract refuses lands here: the test fails on
      // the 500 rather than the stub sending it.
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(`stub error: ${error instanceof Error ? error.message : String(error)}`);
      } else {
        res.destroy();
      }
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    renders,
    calls,
    get profileRequests() {
      return profileRequests;
    },
    setOrca(version) {
      orca = version;
    },
    onSlice(fn) {
      decide = fn;
    },
    hold() {
      let release: () => void = () => {};
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        release() {
          gate = null;
          release();
        },
      };
    },
    async down() {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const res of hung) res.destroy();
      for (const socket of sockets) socket.destroy();
      await closed;
    },
    async up() {
      await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
    },
    async stop() {
      for (const res of hung) res.destroy();
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
