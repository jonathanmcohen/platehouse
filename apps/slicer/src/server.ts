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
//   close lingers (closeLingering, guard.ts): the server drains a body still
//   arriving for up to LINGER_MS before it drops the socket, so a client
//   sending a large file reads its 409 instead of a reset. The caller retries.
// - The server sets its own request and headers timeouts (requestTimeouts):
//   Node's default would cut a slow 512 MiB upload off with a 408.
// - Every request works in its own folder under WORK_DIR (/work, a tmpfs),
//   deleted afterwards, success or failure. A delete that fails is logged,
//   never changes the answer, and is tried again: job folders left behind
//   are swept at start-up, after every job, and by a health check that finds
//   WORK_DIR below the floor while no job runs. /v1/health answers 500 while
//   no job runs and WORK_DIR still has less free space than
//   WORK_MIN_FREE_MIB after that sweep, so Docker's health check sees a
//   /work that leftovers have filled.
// - Every external program runs in its own process group, killed whole at
//   its time cap (SLICE_TIMEOUT_SECONDS, default SLICE_PLATE_SECONDS + 60).
// - An error in a request costs that request, never the process (guard.ts):
//   it is answered 500, or its connection is closed, and its job is undone
//   (program killed, folder deleted, lock freed). The 500 closes with the
//   same lingering close as a refusal.
import { randomUUID } from "node:crypto";
import {
  createWriteStream,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statfsSync,
} from "node:fs";
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
import { closeLingering, guardRequests, installCrashGuard, whenRequestFails } from "./guard.js";
import { orcaArgs, SCRATCH_DIRS, scratchEnv, sliceOutcome } from "./orca.js";
import { loadProfiles } from "./profiles.js";
import { reapOrphans, runGroup, runsUnderTini } from "./sandbox.js";
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
  /** util-linux prlimit, which sets OpenSCAD's resource limits (sandbox.ts). */
  prlimitBin: string;
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
  /**
   * /v1/health fails while no job runs and WORK_DIR has less free space than
   * this (WORK_MIN_FREE_MIB).
   */
  workMinFreeBytes: number;
  limits: Limits;
  /**
   * Kill every process re-parented to PID 1 once a job is released
   * (reapOrphans in sandbox.ts, issue #153). loadConfig turns it on only
   * where the server runs under tini as in the image (runsUnderTini), never
   * on a host where PID 1 has children of its own.
   */
  reapOrphans?: boolean;
}

const seconds = (key: string) =>
  z
    .string()
    .regex(/^\d+$/, `${key} must be a whole number of seconds`)
    .transform(Number)
    .pipe(z.number().int().min(1, `${key} must be at least 1`));

/**
 * The default WORK_MIN_FREE_MIB: room for the largest job the contract
 * takes, a 512 MiB .3mf (LIMITS.sliceBodyBytes), plus 128 MiB for Orca's
 * output and scratch beside it. The 128 MiB is an allowance, not a
 * measurement. With no job running, less free space than this means the
 * next large slice would fail with ENOSPC. The image's /work is a 1g tmpfs,
 * so one leftover folder from a large upload is enough to trip it.
 */
const WORK_MIN_FREE_MIB = 640;
const MIB = 1024 * 1024;

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
  PRLIMIT_BIN: z.string().min(1).default("/usr/bin/prlimit"),
  SANDBOX_PROBE: z.string().min(1).default("/opt/platehouse/sandbox-probe.stl"),
  STEP_WORKER: z
    .string()
    .min(1)
    .default(fileURLToPath(new URL("./step.js", import.meta.url))),
  SLICE_PLATE_SECONDS: seconds("SLICE_PLATE_SECONDS").default(120),
  SLICE_TIMEOUT_SECONDS: seconds("SLICE_TIMEOUT_SECONDS").optional(),
  SCAD_TIMEOUT_SECONDS: seconds("SCAD_TIMEOUT_SECONDS").default(120),
  STEP_TIMEOUT_SECONDS: seconds("STEP_TIMEOUT_SECONDS").default(120),
  WORK_MIN_FREE_MIB: z
    .string()
    .regex(/^\d+$/, "WORK_MIN_FREE_MIB must be a whole number of MiB")
    .transform(Number)
    .default(WORK_MIN_FREE_MIB),
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
    prlimitBin: e.PRLIMIT_BIN,
    sandboxProbe: e.SANDBOX_PROBE,
    stepWorker: e.STEP_WORKER,
    slicePlateSeconds: e.SLICE_PLATE_SECONDS,
    sliceTimeoutSeconds: e.SLICE_TIMEOUT_SECONDS ?? e.SLICE_PLATE_SECONDS + 60,
    scadTimeoutSeconds: e.SCAD_TIMEOUT_SECONDS,
    stepTimeoutSeconds: e.STEP_TIMEOUT_SECONDS,
    orcaVersion: e.ORCA_VERSION,
    openscadVersion: e.OPENSCAD_VERSION,
    workMinFreeBytes: e.WORK_MIN_FREE_MIB * MIB,
    limits: LIMITS,
    reapOrphans: runsUnderTini(),
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
 * Refuses a request before reading its body (or once a body runs past its
 * limit): answers with Connection: close, then closes the connection so the
 * client stops sending, lingering so the answer is not lost (closeLingering).
 *
 * Node's server ends a Connection: close response by calling the socket's
 * destroySoon(), which destroys it as soon as the answer is flushed, unread
 * body or not: the reset closeLingering exists to prevent. So this
 * connection's destroySoon is replaced with closeLingering before the answer
 * is sent. The server tests post a 64 MiB body while busy to hold this.
 *
 * The connection is taken from res, before the answer is sent. req.socket is
 * no use here: once a body error has made stream.pipeline destroy the
 * request, Node has already set req.socket to null, and calling destroy() on
 * it threw in this callback, outside any try, and ended the process.
 */
function refuseEarly(res: ServerResponse, status: number, body: ErrorBody): void {
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

/** The name jobDir gives a job folder; the sweep removes nothing else. */
const JOB_DIR_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const ZIP_MAGIC = [Buffer.from("PK\x03\x04", "latin1"), Buffer.from("PK\x05\x06", "latin1")];

export interface Slicer {
  server: Server;
  /** Kills any running program and stops the server. */
  close(): Promise<void>;
}

/** The tracker a job hands to runGroup, and a way to kill what it tracks. */
type Tracker = ((kill: (() => void) | null) => void) & { killNow(): void };

/** The one heavy job running (a slice, a render or a STEP conversion). */
interface Job {
  /** Its own folder under WORK_DIR. */
  dir: string;
  /** Passed to every program the job runs, so release() can kill it. */
  track: Tracker;
  /**
   * Kills its program, deletes its folder and frees the lock. Safe to call
   * twice: the crash guard calls it again when the request fails, and it
   * never frees a lock that a later job holds.
   */
  release(): void;
}

export function createSlicer(config: SlicerConfig): Slicer {
  const profiles = loadProfiles(config.profilesDir);
  const menu = new Set(profiles.printers.map((p) => p.id));
  const running = new Set<() => void>();
  // The heavy-job lock: the job holding it, or null.
  let holder: Job | null = null;

  const track = (): Tracker => {
    let current: (() => void) | null = null;
    const set = (kill: (() => void) | null) => {
      if (current) running.delete(current);
      current = kill;
      if (kill) running.add(kill);
    };
    return Object.assign(set, {
      killNow: () => {
        current?.();
        set(null);
      },
    });
  };

  /**
   * Deletes a job folder, best effort: retries the ENOTEMPTY or EBUSY of a
   * killed program still finishing a write (Node's rmSync retries none by
   * default), then logs a delete that still fails and returns false. It
   * never throws, so it never changes a request's answer; the sweep tries
   * again after the next job.
   */
  const removeJobDir = (dir: string): boolean => {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return true;
    } catch (err) {
      log(
        `job folder ${dir} could not be deleted: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  };

  /**
   * Removes job folders left under WORK_DIR by a delete that failed. Called
   * at start-up, by a job's release() while that job still holds the lock,
   * and by a health check that finds WORK_DIR below the floor while no job
   * holds it: one heavy job runs at a time, so no other job owns a folder
   * then.
   * Only folders named the way jobDir names them are touched, since HOME is
   * /work in the image and other things can live there. `skip` is the
   * releasing job's own folder, which it has just tried to delete.
   */
  const sweepJobDirs = (skip: string | null): void => {
    let names: string[];
    try {
      names = readdirSync(config.workDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && JOB_DIR_NAME.test(e.name))
        .map((e) => e.name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      log(
        `job folders in ${config.workDir} could not be listed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    for (const name of names) {
      const dir = join(config.workDir, name);
      if (dir === skip) continue;
      if (removeJobDir(dir)) log(`removed leftover job folder ${dir}`);
    }
  };

  /** WORK_DIR's free space in bytes, or null if it cannot be read. */
  const workFreeBytes = (): number | null => {
    try {
      const fs = statfsSync(config.workDir);
      return fs.bavail * fs.bsize;
    } catch {
      return null;
    }
  };

  /**
   * Why /v1/health should fail, or null when it should not. Only checked
   * while no job runs: a running job's own files are not a leak, and its
   * release() sweeps any left behind. With no job running, low free space
   * means leftovers the last sweep could not delete are filling WORK_DIR,
   * so it sweeps again and measures again before failing: a folder that was
   * busy a moment ago often deletes now, and without this nothing would try
   * again until the next job, which a caller may not send to a slicer whose
   * health fails.
   */
  const workSpaceProblem = (): string | null => {
    if (holder) return null;
    let free = workFreeBytes();
    if (free !== null && free < config.workMinFreeBytes) {
      sweepJobDirs(null);
      free = workFreeBytes();
    }
    if (free === null) return `the free space of ${config.workDir} could not be read`;
    if (free >= config.workMinFreeBytes) return null;
    return `${config.workDir} has ${Math.floor(free / MIB)} MiB free, below the ${Math.floor(config.workMinFreeBytes / MIB)} MiB floor (WORK_MIN_FREE_MIB)`;
  };

  sweepJobDirs(null);

  const jobDir = (): string => {
    const dir = join(config.workDir, randomUUID());
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  /**
   * Takes the heavy-job lock and makes the job's folder, or returns null when
   * another job holds the lock. If the folder cannot be made (a full tmpfs,
   * say), the lock is freed again and the error goes to the request.
   */
  const takeJob = (): Job | null => {
    if (holder) return null;
    let dir: string | null = null;
    let released = false;
    const job: Job = {
      dir: "",
      track: track(),
      // The lock is freed whatever happens to the kill or the delete: a lock
      // left held would answer 409 busy to every later job while
      // /v1/health still reports the server up. A folder that cannot be
      // deleted (ENOTEMPTY or EBUSY while a killed program finishes a
      // write) is logged and left behind, and the job's answer stands.
      release: () => {
        if (released) return;
        released = true;
        try {
          job.track.killNow();
          // A program that called setsid() left the group killNow kills and
          // was re-parented to tini; nothing of the job may outlive it, or a
          // sleeping process holds /work files open until a restart.
          if (config.reapOrphans) {
            const reaped = reapOrphans();
            if (reaped.length > 0) {
              log(
                `killed ${reaped.length} process(es) left behind by the job: ${reaped.join(", ")}`,
              );
            }
          }
          if (dir) removeJobDir(dir);
          if (holder === job) sweepJobDirs(dir);
        } finally {
          if (holder === job) holder = null;
        }
      },
    };
    holder = job;
    whenRequestFails(job.release);
    try {
      dir = jobDir();
    } catch (err) {
      job.release();
      throw err;
    }
    job.dir = dir;
    return job;
  };

  // The sandbox self-test runs before the first render, and every render
  // waits for it. Only a pass is remembered: a failed or inconclusive check
  // refuses the renders waiting on it, and the next render checks again.
  // If the render's request fails while the check runs, the check is
  // forgotten too, so a check the guard cut short cannot hang later renders.
  let sandbox: Promise<SandboxCheck> | null = null;
  const sandboxReady = (job: Job): Promise<SandboxCheck> => {
    if (sandbox) return sandbox;
    const check = (async (): Promise<SandboxCheck> => {
      let dir: string | null = null;
      try {
        dir = jobDir();
        const result = await sandboxSelfTest(config, dir, config.sandboxProbe, job.track);
        log(`sandbox self-test: ${result.ok ? "ok" : "FAILED"}: ${result.detail}`);
        return result;
      } catch (err) {
        const detail = `the self-test could not run: ${err instanceof Error ? err.message : String(err)}`;
        log(`sandbox self-test: FAILED: ${detail}`);
        return { ok: false, detail };
      } finally {
        // Best effort, like every job folder delete: a folder that will not
        // go must not turn a passed check into a 500 for the render.
        if (dir) removeJobDir(dir);
      }
    })().then((result) => {
      if (!result.ok && sandbox === check) sandbox = null;
      return result;
    });
    sandbox = check;
    whenRequestFails(() => {
      if (sandbox === check) sandbox = null;
    });
    return check;
  };

  async function slice(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const query = slicerContract.sliceQuery.safeParse({
      printer: url.searchParams.get("printer") ?? undefined,
      plate: url.searchParams.get("plate") ?? undefined,
    });
    if (!query.success) {
      return refuseEarly(res, 400, {
        error: "bad_request",
        message: query.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
    }
    const { printer, plate } = query.data;
    const machineFile = menu.has(printer) ? profiles.machineFile(printer) : null;
    if (!machineFile) {
      return refuseEarly(res, 400, { error: "bad_request", message: "unknown printer" });
    }
    const declared = declaredLength(req);
    if (declared !== null && declared > config.limits.sliceBodyBytes) {
      return refuseEarly(res, 413, { error: "too_large" });
    }
    const job = takeJob();
    if (!job) return refuseEarly(res, 409, { error: "busy" });
    const dir = job.dir;
    try {
      for (const sub of SCRATCH_DIRS) mkdirSync(join(dir, sub), { recursive: true });
      const input = join(dir, "input.3mf");
      try {
        await saveBody(req, input, config.limits.sliceBodyBytes);
      } catch (err) {
        if (err instanceof TooLarge) return refuseEarly(res, 413, { error: "too_large" });
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
        track: job.track,
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
      job.release();
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
    work: (job: Job) => Promise<void>,
  ): Promise<void> {
    const declared = declaredLength(req);
    if (declared !== null && declared > limit) return refuseEarly(res, 413, { error: "too_large" });
    const job = takeJob();
    if (!job) return refuseEarly(res, 409, { error: "busy" });
    try {
      try {
        await saveBody(req, join(job.dir, input), limit);
      } catch (err) {
        if (err instanceof TooLarge) return refuseEarly(res, 413, { error: "too_large" });
        throw err;
      }
      await work(job);
    } finally {
      job.release();
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://slicer");
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case "GET /v1/health": {
        // A full /work fails every upload with ENOSPC, so health fails too.
        // The contract lets any route answer 500 with a plain-text body,
        // and the health schema itself is unchanged.
        const problem = workSpaceProblem();
        if (problem) {
          log(`health: ${problem}`);
          const text = `${problem}\n`;
          res.writeHead(500, {
            "content-type": "text/plain",
            "content-length": Buffer.byteLength(text),
          });
          res.end(text);
          return;
        }
        return send(res, 200, {
          contract: CONTRACT_VERSION,
          orca: config.orcaVersion,
          openscad: config.openscadVersion,
          busy: holder !== null,
        });
      }
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
        return withBody(req, res, config.limits.scadBodyBytes, SCAD_INPUT, async (job) => {
          const check = await sandboxReady(job);
          if (!check.ok) {
            return send(res, 422, {
              error: "render_failed",
              message: `OpenSCAD renders are off: the sandbox self-test failed (${check.detail}).`,
            });
          }
          const r = await renderScad(config, job.dir, kind, job.track);
          if (r.ok) return sendBytes(res, kind === "png" ? "image/png" : "model/stl", r.bytes);
          return send(res, 422, { error: "render_failed", message: r.message });
        });
      }
      case "POST /v1/step/glb":
        return withBody(req, res, config.limits.stepBodyBytes, STEP_INPUT, async (job) => {
          const r = await runStepWorker(
            { worker: config.stepWorker, timeoutSeconds: config.stepTimeoutSeconds },
            job.dir,
            job.track,
          );
          if (r.ok) return sendBytes(res, "model/gltf-binary", r.bytes);
          return send(res, 422, { error: "convert_failed", message: r.message });
        });
      default:
        return refuseEarly(res, 404, { error: "not_found" });
    }
  }

  // A handler that throws or rejects is answered 500, or its connection is
  // closed if the answer has started, and its job is undone (guard.ts).
  const server = createServer(requestTimeouts(config), guardRequests(handle, log));

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
  // Errors that escape a request's own code (a listener or callback that
  // throws, an unhandled rejection) fail that request, never the process.
  installCrashGuard(process, log);
  try {
    const config = loadConfig(process.env);
    const slicer = createSlicer(config);
    // The server's own errors (the port is taken, say) are fatal: with the
    // crash guard installed they would otherwise leave a process that
    // listens on nothing.
    slicer.server.on("error", (err) => {
      process.stderr.write(`slicer: ${err.message}\n`);
      process.exit(1);
    });
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
