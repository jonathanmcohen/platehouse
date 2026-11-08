// The slicer server (build plan Task 11): Slicer HTTP contract v1 on port
// 8080, inside the slicer container. It sits on the internal network only,
// has no auth and holds no secrets (AC-035): the app sends it a file and gets
// numbers, a render or a mesh back. Plain node:http, no web framework: the
// surface is five routes, and the container opens untrusted files, so it
// carries as little as it can.
//
// - One heavy job at a time: a slice, an OpenSCAD render or a STEP
//   conversion. The container's 4g is sized from a single slice, so a
//   request for any of them while one runs is 409 busy, answered before its
//   body is read and with the connection closed, so no socket waits. The
//   caller retries.
// - The server sets its own request and headers timeouts (requestTimeouts):
//   Node's default would cut a slow 512 MiB upload off with a 408.
// - Every request works in its own folder under WORK_DIR (/work, a tmpfs),
//   deleted afterwards, success or failure.
// - Every external program runs in its own process group, killed whole at
//   its time cap (SLICE_TIMEOUT_SECONDS, default SLICE_PLATE_SECONDS + 60).
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, realpathSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  CONTRACT_VERSION,
  type ErrorBody,
  LIMITS,
  type Limits,
  slicerContract,
} from "@platehouse/slicer-contract";
import { readProject } from "@platehouse/threemf";
import { z } from "zod";
import { orcaArgs, SCRATCH_DIRS, scratchEnv, sliceOutcome } from "./orca.js";
import { loadProfiles } from "./profiles.js";
import { runGroup } from "./sandbox.js";
import { renderScad, type SandboxCheck, SCAD_INPUT, sandboxSelfTest } from "./scad.js";
import { runStepWorker, STEP_INPUT } from "./step.js";

export interface SlicerConfig {
  port: number;
  workDir: string;
  profilesDir: string;
  orcaBin: string;
  /** GNU time, which reports Orca's peak RSS (time -v). */
  timeBin: string;
  openscadBin: string;
  openscadDir: string;
  landrunBin: string;
  /** A file outside every job folder that the sandbox self-test imports. */
  sandboxProbe: string;
  /** The STEP worker module, run with this Node (normally dist/src/step.js). */
  stepWorker: string;
  /** Orca's own per-plate cap, --mstpp. */
  slicePlateSeconds: number;
  /** When the server kills a plate's process group. */
  sliceTimeoutSeconds: number;
  scadTimeoutSeconds: number;
  stepTimeoutSeconds: number;
  orcaVersion: string;
  openscadVersion: string;
  limits: Limits;
}

const seconds = (key: string) =>
  z
    .string()
    .regex(/^\d+$/, `${key} must be a whole number of seconds`)
    .transform(Number)
    .pipe(z.number().int().min(1, `${key} must be at least 1`));

const envSchema = z.object({
  PORT: z
    .string()
    .regex(/^\d+$/, "PORT must be a port number")
    .transform(Number)
    .pipe(z.number().int().min(1).max(65535))
    .default(8080),
  WORK_DIR: z.string().min(1).default("/work"),
  PROFILES_DIR: z.string().min(1).default("/opt/platehouse/profiles"),
  ORCA_BIN: z.string().min(1).default("/opt/orca/AppRun"),
  TIME_BIN: z.string().min(1).default("/usr/bin/time"),
  OPENSCAD_BIN: z.string().min(1).default("/opt/openscad/AppRun"),
  OPENSCAD_DIR: z.string().min(1).default("/opt/openscad"),
  LANDRUN_BIN: z.string().min(1).default("/usr/local/bin/landrun"),
  SANDBOX_PROBE: z.string().min(1).default("/opt/platehouse/sandbox-probe.stl"),
  STEP_WORKER: z
    .string()
    .min(1)
    .default(fileURLToPath(new URL("./step.js", import.meta.url))),
  SLICE_PLATE_SECONDS: seconds("SLICE_PLATE_SECONDS").default(120),
  SLICE_TIMEOUT_SECONDS: seconds("SLICE_TIMEOUT_SECONDS").optional(),
  SCAD_TIMEOUT_SECONDS: seconds("SCAD_TIMEOUT_SECONDS").default(120),
  STEP_TIMEOUT_SECONDS: seconds("STEP_TIMEOUT_SECONDS").default(120),
  ORCA_VERSION: z.string({ error: "ORCA_VERSION is required" }).min(1, "ORCA_VERSION is required"),
  OPENSCAD_VERSION: z
    .string({ error: "OPENSCAD_VERSION is required" })
    .min(1, "OPENSCAD_VERSION is required"),
});

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Reads the slicer's configuration from the environment; names a bad key, never a value. */
export function loadConfig(env: NodeJS.ProcessEnv): SlicerConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    throw new ConfigError(`invalid slicer configuration: ${issues.join("; ")}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    workDir: e.WORK_DIR,
    profilesDir: e.PROFILES_DIR,
    orcaBin: e.ORCA_BIN,
    timeBin: e.TIME_BIN,
    openscadBin: e.OPENSCAD_BIN,
    openscadDir: e.OPENSCAD_DIR,
    landrunBin: e.LANDRUN_BIN,
    sandboxProbe: e.SANDBOX_PROBE,
    stepWorker: e.STEP_WORKER,
    slicePlateSeconds: e.SLICE_PLATE_SECONDS,
    sliceTimeoutSeconds: e.SLICE_TIMEOUT_SECONDS ?? e.SLICE_PLATE_SECONDS + 60,
    scadTimeoutSeconds: e.SCAD_TIMEOUT_SECONDS,
    stepTimeoutSeconds: e.STEP_TIMEOUT_SECONDS,
    orcaVersion: e.ORCA_VERSION,
    openscadVersion: e.OPENSCAD_VERSION,
    limits: LIMITS,
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, body: ErrorBody): void {
  send(res, status, body);
}

function sendBytes(res: ServerResponse, contentType: string, bytes: Buffer): void {
  res.writeHead(200, { "content-type": contentType, "content-length": bytes.length });
  res.end(bytes);
}

/**
 * Refuses a request before reading its body: answers, then drops the
 * connection so the client stops sending.
 */
function refuseEarly(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  body: ErrorBody,
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    connection: "close",
  });
  res.end(text, () => req.socket.destroy());
}

class TooLarge extends Error {}

/** Streams the body to a file, counting bytes; throws TooLarge past the limit. */
async function saveBody(req: IncomingMessage, file: string, limit: number): Promise<number> {
  let bytes = 0;
  await pipeline(
    req,
    async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        bytes += chunk.length;
        if (bytes > limit) throw new TooLarge();
        yield chunk;
      }
    },
    createWriteStream(file),
  );
  return bytes;
}

function declaredLength(req: IncomingMessage): number | null {
  const v = req.headers["content-length"];
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Node's requestTimeout counts from a request's first byte until its whole
 * body has arrived (work after that does not count), and answers 408 past
 * it. The largest legitimate body is the 512 MiB .3mf: this allows it
 * UPLOAD_SECONDS (a little under 1 MiB/s), plus the longest time cap and a
 * margin. The headers of a legitimate request arrive in well under a second,
 * so the headers timeout stays at Node's 60 s, set here so it is explicit; it
 * must not exceed the request timeout.
 */
const UPLOAD_SECONDS = 600;
const MARGIN_SECONDS = 60;
const HEADERS_TIMEOUT_MS = 60_000;

export function requestTimeouts(config: SlicerConfig): {
  requestTimeout: number;
  headersTimeout: number;
} {
  const longestCap = Math.max(
    config.sliceTimeoutSeconds,
    config.scadTimeoutSeconds,
    config.stepTimeoutSeconds,
  );
  return {
    requestTimeout: (UPLOAD_SECONDS + longestCap + MARGIN_SECONDS) * 1000,
    headersTimeout: HEADERS_TIMEOUT_MS,
  };
}

const ZIP_MAGIC = [Buffer.from("PK\x03\x04", "latin1"), Buffer.from("PK\x05\x06", "latin1")];

export interface Slicer {
  server: Server;
  /** Kills any running program and stops the server. */
  close(): Promise<void>;
}

export function createSlicer(config: SlicerConfig): Slicer {
  const profiles = loadProfiles(config.profilesDir);
  const menu = new Set(profiles.printers.map((p) => p.id));
  const running = new Set<() => void>();
  // Held by the one heavy job running: a slice, a render or a STEP conversion.
  let busy = false;

  const track = () => {
    let current: (() => void) | null = null;
    return (kill: (() => void) | null) => {
      if (current) running.delete(current);
      current = kill;
      if (kill) running.add(kill);
    };
  };

  const jobDir = (): string => {
    const dir = join(config.workDir, randomUUID());
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  // The sandbox self-test runs before the first render, and every render
  // waits for it. Only a pass is remembered: a failed or inconclusive check
  // refuses the renders waiting on it, and the next render checks again.
  let sandbox: Promise<SandboxCheck> | null = null;
  const sandboxReady = (): Promise<SandboxCheck> => {
    sandbox ??= (async (): Promise<SandboxCheck> => {
      const dir = jobDir();
      try {
        const check = await sandboxSelfTest(config, dir, config.sandboxProbe);
        log(`sandbox self-test: ${check.ok ? "ok" : "FAILED"}: ${check.detail}`);
        return check;
      } catch (err) {
        const detail = `the self-test could not run: ${err instanceof Error ? err.message : String(err)}`;
        log(`sandbox self-test: FAILED: ${detail}`);
        return { ok: false, detail };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    })().then((check) => {
      if (!check.ok) sandbox = null;
      return check;
    });
    return sandbox;
  };

  async function slice(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const query = slicerContract.sliceQuery.safeParse({
      printer: url.searchParams.get("printer") ?? undefined,
      plate: url.searchParams.get("plate") ?? undefined,
    });
    if (!query.success) {
      return refuseEarly(req, res, 400, {
        error: "bad_request",
        message: query.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
    }
    const { printer, plate } = query.data;
    const machineFile = menu.has(printer) ? profiles.machineFile(printer) : null;
    if (!machineFile) {
      return refuseEarly(req, res, 400, { error: "bad_request", message: "unknown printer" });
    }
    const declared = declaredLength(req);
    if (declared !== null && declared > config.limits.sliceBodyBytes) {
      return refuseEarly(req, res, 413, { error: "too_large" });
    }
    if (busy) return refuseEarly(req, res, 409, { error: "busy" });
    busy = true;
    const dir = jobDir();
    try {
      for (const sub of SCRATCH_DIRS) mkdirSync(join(dir, sub), { recursive: true });
      const input = join(dir, "input.3mf");
      try {
        await saveBody(req, input, config.limits.sliceBodyBytes);
      } catch (err) {
        if (err instanceof TooLarge) return refuseEarly(req, res, 413, { error: "too_large" });
        throw err;
      }
      const head = Buffer.alloc(4);
      const fd = await open(input, "r");
      try {
        await fd.read(head, 0, 4, 0);
      } finally {
        await fd.close();
      }
      if (!ZIP_MAGIC.some((m) => head.equals(m))) return sendError(res, 422, { error: "not_3mf" });
      const project = await readProject(input);
      if (!project) return sendError(res, 422, { error: "not_3mf" });

      const slots = [...project.projectFilaments].sort((a, b) => a.slot - b.slot);
      const picks = slots.map((f) => profiles.filamentFor(printer, f.type));
      const outDir = join(dir, "out");
      const timeFile = join(dir, "time.txt");
      const args = orcaArgs({
        plate,
        mstpp: config.slicePlateSeconds,
        dataDir: join(dir, "data"),
        outDir,
        machineFile,
        filamentFiles: picks.map((p) => p?.file ?? ""),
        input,
      });
      const run = await runGroup(config.timeBin, ["-v", "-o", timeFile, config.orcaBin, ...args], {
        cwd: dir,
        env: scratchEnv(dir),
        timeoutMs: config.sliceTimeoutSeconds * 1000,
        track: track(),
      });
      const result = sliceOutcome(
        {
          orcaVersion: config.orcaVersion,
          plate,
          printer,
          process: project.processName ?? null,
          filamentProfiles: picks.map((p) => p?.profile ?? null),
          projectFilaments: slots.map((f) => ({ slot: f.slot, type: f.type, colour: f.colour })),
          timeoutSeconds: config.sliceTimeoutSeconds,
        },
        run,
        { outDir, timeFile },
      );
      log(
        `slice plate ${plate} on ${printer}: ${result.status === "ok" ? `ok ${result.timeSeconds} s ${result.weightGrams} g` : `${result.reason} (${result.code})`} in ${run.wallMs} ms`,
      );
      return send(res, 200, result);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      busy = false;
    }
  }

  /**
   * Takes the heavy-job lock (or answers 409 busy before reading the body),
   * saves the body as dir/<input> in a fresh job folder and hands the folder
   * to `work`, which runs its program on that file. The body is never read
   * into the server's memory.
   */
  async function withBody(
    req: IncomingMessage,
    res: ServerResponse,
    limit: number,
    input: string,
    work: (dir: string) => Promise<void>,
  ): Promise<void> {
    const declared = declaredLength(req);
    if (declared !== null && declared > limit)
      return refuseEarly(req, res, 413, { error: "too_large" });
    if (busy) return refuseEarly(req, res, 409, { error: "busy" });
    busy = true;
    try {
      const dir = jobDir();
      try {
        try {
          await saveBody(req, join(dir, input), limit);
        } catch (err) {
          if (err instanceof TooLarge) return refuseEarly(req, res, 413, { error: "too_large" });
          throw err;
        }
        await work(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      busy = false;
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://slicer");
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case "GET /v1/health":
        return send(res, 200, {
          contract: CONTRACT_VERSION,
          orca: config.orcaVersion,
          openscad: config.openscadVersion,
          busy,
        });
      case "GET /v1/profiles":
        return send(res, 200, {
          contract: CONTRACT_VERSION,
          orca: config.orcaVersion,
          printers: profiles.printers,
          filaments: profiles.filaments,
        });
      case "POST /v1/slice":
        return slice(req, res, url);
      case "POST /v1/scad/stl":
      case "POST /v1/scad/png": {
        const kind = url.pathname.endsWith("png") ? "png" : "stl";
        return withBody(req, res, config.limits.scadBodyBytes, SCAD_INPUT, async (dir) => {
          const check = await sandboxReady();
          if (!check.ok) {
            return send(res, 422, {
              error: "render_failed",
              message: `OpenSCAD renders are off: the sandbox self-test failed (${check.detail}).`,
            });
          }
          const r = await renderScad(config, dir, kind, track());
          if (r.ok) return sendBytes(res, kind === "png" ? "image/png" : "model/stl", r.bytes);
          return send(res, 422, { error: "render_failed", message: r.message });
        });
      }
      case "POST /v1/step/glb":
        return withBody(req, res, config.limits.stepBodyBytes, STEP_INPUT, async (dir) => {
          const r = await runStepWorker(
            { worker: config.stepWorker, timeoutSeconds: config.stepTimeoutSeconds },
            dir,
            track(),
          );
          if (r.ok) return sendBytes(res, "model/gltf-binary", r.bytes);
          return send(res, 422, { error: "convert_failed", message: r.message });
        });
      default:
        return refuseEarly(req, res, 404, { error: "not_found" });
    }
  }

  const server = createServer(requestTimeouts(config), (req, res) => {
    handle(req, res).catch((err: unknown) => {
      log(`request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain", connection: "close" });
        res.end("internal error\n");
      } else {
        res.destroy();
      }
    });
  });

  return {
    server,
    close: async () => {
      for (const kill of running) kill();
      running.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

function log(line: string): void {
  process.stdout.write(`${new Date().toISOString()} ${line}\n`);
}

function isMain(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    const config = loadConfig(process.env);
    const slicer = createSlicer(config);
    slicer.server.listen(config.port, "0.0.0.0", () => {
      log(
        `slicer contract ${CONTRACT_VERSION} listening on ${config.port}: orca ${config.orcaVersion}, openscad ${config.openscadVersion}, --mstpp ${config.slicePlateSeconds} s, kill at ${config.sliceTimeoutSeconds} s`,
      );
    });
    const stop = () => {
      slicer.close().then(() => process.exit(0));
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  } catch (err) {
    process.stderr.write(`slicer: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
