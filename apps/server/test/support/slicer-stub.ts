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
// It listens on 127.0.0.1 only and holds nothing but synthetic data.
import { randomBytes } from "node:crypto";
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

export interface SlicerStub {
  url: string;
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
  stop(): Promise<void>;
}

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

function sendJson(res: ServerResponse, status: number, body: unknown, close = false): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    ...(close ? { connection: "close" } : {}),
  });
  res.end(text);
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
      // As the real slicer: answered before the body is read, then closed.
      sendJson(res, 409, slicerContract.error.parse({ error: "busy" }), true);
      req.resume();
      return;
    }
    if (length > LIMITS.sliceBodyBytes) {
      req.resume();
      return sendJson(res, 413, slicerContract.error.parse({ error: "too_large" }), true);
    }
    const body = await readBody(req);
    if (body === null)
      return sendJson(res, 413, slicerContract.error.parse({ error: "too_large" }));
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

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const route = `${req.method} ${url.pathname}`;
    const handle = async () => {
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
    async stop() {
      for (const res of hung) res.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
