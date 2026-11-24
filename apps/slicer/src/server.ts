// The slicer server: Slicer HTTP contract v2 on port
// 8080, inside the slicer container. It sits on the internal network only,
// has no auth and holds no secrets, because it opens untrusted files: the app sends it a file and gets
// numbers, a render or a mesh back. Plain node:http, no web framework: the
// surface is seven routes, and the container opens untrusted files, so it
// carries as little as it can.
//
// - One heavy job at a time: a slice, an OpenSCAD render (a .scad's, or an
//   STL's preview picture) or a STEP conversion. The container's 4g is sized from a single slice, so a
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
// - The sandbox self-test runs once at start-up, holding the heavy-job lock
//   like a job (so health shows busy and a request is 409 busy meanwhile),
//   and health reports where it stands (health.sandbox). A job never runs it.
//   A check that fails for any reason but an old kernel runs again after a
//   back-off (SANDBOX_RETRY), never while a job holds the lock; an old
//   kernel is final until restart. While the sandbox is off, a heavy route
//   answers 503 sandbox_off before reading its body, except that a slice or a
//   STEP conversion runs without the sandbox when SLICER_ALLOW_UNSANDBOXED
//   is set (sandboxGate).
// - Every external program runs in its own process group, killed whole at
//   its time cap (SLICE_TIMEOUT_SECONDS, default SLICE_PLATE_SECONDS + 60).
//   OpenSCAD, OrcaSlicer and the STEP worker each run under prlimit and
//   landrun with their own rules (sandbox.ts); a slice or conversion that
//   SLICER_ALLOW_UNSANDBOXED lets run while the sandbox is off runs under
//   prlimit alone.
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
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  CONTRACT_VERSION,
  type ErrorBody,
  LIMITS,
  type Limits,
  type SandboxOffBody,
  type SandboxState,
  slicerContract,
} from "@platehouse/slicer-contract";
import { readProject } from "@platehouse/threemf";
import { z } from "zod";
import { closeLingering, guardRequests, installCrashGuard, whenRequestFails } from "./guard.js";
import { orcaArgs, SCRATCH_DIRS, sliceOutcome } from "./orca.js";
import { loadProfiles } from "./profiles.js";
import {
  prlimitCommand,
  reapLeftovers,
  runGroup,
  runsUnderTini,
  sandboxPaths,
  sandboxRules,
} from "./sandbox.js";
import {
  renderScad,
  type SandboxCheck,
  SCAD_INPUT,
  STL_INPUT,
  sandboxSelfTest,
  stlProblem,
  writeStlImport,
} from "./scad.js";
import { runStepWorker, STEP_INPUT } from "./step.js";

export interface SlicerConfig {
  port: number;
  workDir: string;
  profilesDir: string;
  /**
   * OrcaSlicer's own binary, bin/orca-slicer in its AppImage tree, run with
   * its launcher's environment (launcherEnv in orca.ts), not AppRun.
   */
  orcaBin: string;
  /** OrcaSlicer's extracted AppImage tree, which its sandbox may run code from. */
  orcaDir: string;
  /** GNU time, which reports Orca's peak RSS (time -v). */
  timeBin: string;
  openscadBin: string;
  openscadDir: string;
  landrunBin: string;
  /** util-linux prlimit, which sets each sandboxed program's resource limits (sandbox.ts). */
  prlimitBin: string;
  /** A file outside every job folder that the sandbox self-test imports. */
  sandboxProbe: string;
  /** The STEP worker module, run with this Node (normally dist/src/step.js). */
  stepWorker: string;
  /** This Node's folder (bin/node inside it), which the STEP worker's sandbox may run code from. */
  nodeDir: string;
  /** The built app, which the STEP worker's sandbox may read (step.js, occt-import-js). */
  appDir: string;
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
   * SLICER_ALLOW_UNSANDBOXED: while the sandbox is off, a slice or a STEP
   * conversion still runs (without the sandbox); renders never do.
   */
  allowUnsandboxed: boolean;
  /** The start-up check's retry delays; tests shorten them. Default SANDBOX_RETRY. */
  sandboxRetry?: SandboxRetry;
  /**
   * Kill every leftover process once a job is released
   * (reapLeftovers in sandbox.ts, issue #153). loadConfig turns it on only
   * where the server runs under tini as in the image (runsUnderTini), never
   * on a host where PID 1 has children of its own.
   */
  reapOrphans?: boolean;
  /**
   * What release() runs to clean up leftover processes; tests pass a spy.
   * Default: reapLeftovers when reapOrphans is on, nothing otherwise.
   */
  reap?: () => number[];
}

/** The delays of the start-up sandbox check's retries, in milliseconds. */
export interface SandboxRetry {
  /** The wait after the first check_failed; it doubles after each one. */
  initialMs: number;
  /** The longest wait. */
  maxMs: number;
  /** The wait when a retry is due but a job holds the lock. */
  busyMs: number;
}

export const SANDBOX_RETRY: SandboxRetry = Object.freeze({
  initialMs: 60_000,
  maxMs: 900_000,
  busyMs: 5_000,
});

/** The wait before the retry that follows the `failures`-th check_failed (1 for the first). */
export function retryDelayMs(failures: number, retry: SandboxRetry = SANDBOX_RETRY): number {
  return Math.min(retry.initialMs * 2 ** Math.max(0, failures - 1), retry.maxMs);
}

/**
 * What a heavy route does while it holds the lock: "run" in the sandbox,
 * "unsandboxed" (a slice or STEP conversion with SLICER_ALLOW_UNSANDBOXED,
 * the program run under prlimit alone, without landrun), or the 503 body to
 * answer.
 */
export type SandboxGate = "run" | "unsandboxed" | SandboxOffBody;

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
  ORCA_BIN: z.string().min(1).default("/opt/orca/bin/orca-slicer"),
  ORCA_DIR: z.string().min(1).default("/opt/orca"),
  APP_DIR: z.string().min(1).default("/opt/platehouse/app"),
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
  SLICER_ALLOW_UNSANDBOXED: z
    .enum(["true", "false"], { error: "SLICER_ALLOW_UNSANDBOXED must be true or false" })
    .default("false"),
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
    orcaDir: e.ORCA_DIR,
    timeBin: e.TIME_BIN,
    openscadBin: e.OPENSCAD_BIN,
    openscadDir: e.OPENSCAD_DIR,
    landrunBin: e.LANDRUN_BIN,
    prlimitBin: e.PRLIMIT_BIN,
    sandboxProbe: e.SANDBOX_PROBE,
    stepWorker: e.STEP_WORKER,
    // The Node running this server runs the worker too (process.execPath,
    // /opt/node/bin/node in the image).
    nodeDir: dirname(dirname(process.execPath)),
    appDir: e.APP_DIR,
    slicePlateSeconds: e.SLICE_PLATE_SECONDS,
    sliceTimeoutSeconds: e.SLICE_TIMEOUT_SECONDS ?? e.SLICE_PLATE_SECONDS + 60,
    scadTimeoutSeconds: e.SCAD_TIMEOUT_SECONDS,
    stepTimeoutSeconds: e.STEP_TIMEOUT_SECONDS,
    orcaVersion: e.ORCA_VERSION,
    openscadVersion: e.OPENSCAD_VERSION,
    workMinFreeBytes: e.WORK_MIN_FREE_MIB * MIB,
    allowUnsandboxed: e.SLICER_ALLOW_UNSANDBOXED === "true",
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
function refuseEarly(res: ServerResponse, status: number, body: ErrorBody | SandboxOffBody): void {
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
  /**
   * Kills any running program, cancels a pending sandbox check and stops the
   * server.
   */
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
    // Once killNow has run, the job is over: a program registered after it
    // is killed at once, so nothing starts outside the lock.
    let over = false;
    const set = (kill: (() => void) | null) => {
      if (current) running.delete(current);
      current = null;
      if (!kill) return;
      if (over) {
        kill();
        return;
      }
      current = kill;
      running.add(kill);
    };
    return Object.assign(set, {
      killNow: () => {
        over = true;
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
          const reap = config.reap ?? (config.reapOrphans ? reapLeftovers : null);
          if (reap) {
            const reaped = reap();
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

  /**
   * Stops the job when its client goes away: if the response is destroyed
   * before it finished, the job is released at once, which kills its program
   * and deletes its folder, instead of running on to its time cap while every
   * later request answers 409 busy. After a normal finish this does nothing,
   * and a release that already ran is not repeated (see takeJob).
   */
  const releaseWhenClientGoes = (res: ServerResponse, job: Job): void => {
    res.on("close", () => {
      if (!res.writableFinished) job.release();
    });
  };

  // The sandbox self-test runs at start-up and holds the heavy-job lock while
  // it does, like a job: health shows busy, and a request is 409 busy, never
  // a sandbox answer. The state it records is what every heavy route checks
  // (sandboxGate). A job never runs the check, so a client going away cannot
  // cut it short.
  let sandbox: SandboxState = {
    state: "checking",
    reason: null,
    detail: null,
    allowUnsandboxed: config.allowUnsandboxed,
  };
  const retry = config.sandboxRetry ?? SANDBOX_RETRY;
  let closed = false;
  let retryTimer: NodeJS.Timeout | null = null;
  let checkFailures = 0;
  let sandboxCheck: Promise<void> = Promise.resolve();

  const sandboxState = (): SandboxState => ({ ...sandbox });

  const sandboxOff = (): SandboxOffBody => ({
    error: "sandbox_off",
    reason: sandbox.reason ?? "check_failed",
    detail: sandbox.detail ?? "the sandbox check has not finished",
  });

  const sandboxGate = (kind: "render" | "program"): SandboxGate => {
    if (sandbox.state === "on") return "run";
    if (sandbox.state === "off" && kind === "program" && config.allowUnsandboxed) {
      return "unsandboxed";
    }
    return sandboxOff();
  };

  /**
   * Runs for a job that holds the lock, before it reads its body: answers 503
   * and returns null while the sandbox is off, else the gate's answer. An
   * unsandboxed run is logged once, here.
   */
  const passSandboxGate = (
    res: ServerResponse,
    kind: "render" | "program",
    what: string,
  ): "run" | "unsandboxed" | null => {
    const gate = sandboxGate(kind);
    if (typeof gate === "object") {
      refuseEarly(res, 503, gate);
      return null;
    }
    if (gate === "unsandboxed") {
      log(`${what} runs without the sandbox: it is off and SLICER_ALLOW_UNSANDBOXED is set`);
    }
    return gate;
  };

  const failedCheck = (detail: string): SandboxCheck => ({
    ok: false,
    reason: "check_failed",
    detail,
  });

  const scheduleSandboxCheck = (delayMs: number): void => {
    if (closed) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      startSandboxCheck();
    }, delayMs);
    retryTimer.unref();
  };

  const recordSandboxCheck = (result: SandboxCheck): void => {
    log(`sandbox self-test: ${result.ok ? "ok" : "FAILED"}: ${result.detail}`);
    if (result.ok) {
      sandbox = { ...sandbox, state: "on", reason: null, detail: null };
      return;
    }
    sandbox = {
      ...sandbox,
      state: "off",
      reason: result.reason ?? "check_failed",
      detail: result.detail,
    };
    // An old kernel stays old until a restart; anything else may pass later.
    if (result.reason !== "old_kernel") {
      checkFailures += 1;
      scheduleSandboxCheck(retryDelayMs(checkFailures, retry));
    }
  };

  const runSandboxCheck = async (): Promise<void> => {
    if (closed) return;
    let job: Job | null = null;
    let result: SandboxCheck | null = null;
    try {
      job = takeJob();
    } catch (err) {
      result = failedCheck(
        `the self-test could not start: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!result) {
      // A retry that falls due while a job runs waits for it, shortly.
      if (!job) return scheduleSandboxCheck(retry.busyMs);
      try {
        result = await sandboxSelfTest(config, job.dir, config.sandboxProbe, job.track);
      } catch (err) {
        result = failedCheck(
          `the self-test could not run: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    try {
      // A check cut short by close() says nothing about the sandbox.
      if (!closed) recordSandboxCheck(result);
    } finally {
      job?.release();
    }
  };

  const startSandboxCheck = (): void => {
    sandboxCheck = runSandboxCheck().catch((err) => {
      log(
        `sandbox self-test: could not finish: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
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
      const gate = passSandboxGate(res, "program", "a slice");
      if (!gate) return;
      for (const sub of SCRATCH_DIRS) mkdirSync(join(dir, sub), { recursive: true });
      const input = join(dir, "input.3mf");
      try {
        await saveBody(req, input, config.limits.sliceBodyBytes);
      } catch (err) {
        if (err instanceof TooLarge) return refuseEarly(res, 413, { error: "too_large" });
        throw err;
      }
      releaseWhenClientGoes(res, job);
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
      // The client may have gone while the project was read; its job is
      // already released, so there is nothing to run and nobody to answer.
      if (res.destroyed) return;

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
      // prlimit, then GNU time, outside the sandbox so it can write its
      // report to the job folder, then landrun with Orca's rules, then Orca
      // (prlimitCommand). Unsandboxed, landrun is left out. Orca's
      // environment (its rules' env: scratchEnv plus its launcher's) is
      // what landrun passes it, and what it inherits without landrun.
      // prlimit and GNU time see its LD_LIBRARY_PATH too: both link glibc,
      // which the AppImage never bundles (Orca's appimage_lib_policy.sh),
      // and prlimit also util-linux's libsmartcols; landrun is static.
      const rules = sandboxRules("orca", sandboxPaths(config, dir));
      const command = prlimitCommand({
        program: "orca",
        timeoutSeconds: config.sliceTimeoutSeconds,
        outside: [config.timeBin, "-v", "-o", timeFile],
        landrun: gate === "run" ? { bin: config.landrunBin, rules } : null,
        command: [config.orcaBin, ...args],
      });
      const run = await runGroup(config.prlimitBin, command, {
        cwd: dir,
        env: rules.env,
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
   * answers 503 sandbox_off, also before reading it, while the sandbox is off
   * (sandboxGate), saves the body as dir/<input> in a fresh job folder and hands the folder
   * to `work`, which runs its program on that file, sandboxed unless the gate
   * said "unsandboxed" (only ever for kind "program"). The body is never read
   * into the server's memory.
   */
  async function withBody(
    req: IncomingMessage,
    res: ServerResponse,
    limit: number,
    input: string,
    kind: "render" | "program",
    what: string,
    work: (job: Job, gate: "run" | "unsandboxed") => Promise<void>,
  ): Promise<void> {
    const declared = declaredLength(req);
    if (declared !== null && declared > limit) return refuseEarly(res, 413, { error: "too_large" });
    const job = takeJob();
    if (!job) return refuseEarly(res, 409, { error: "busy" });
    try {
      const gate = passSandboxGate(res, kind, what);
      if (!gate) return;
      try {
        await saveBody(req, join(job.dir, input), limit);
      } catch (err) {
        if (err instanceof TooLarge) return refuseEarly(res, 413, { error: "too_large" });
        throw err;
      }
      releaseWhenClientGoes(res, job);
      if (res.destroyed) return;
      await work(job, gate);
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
          sandbox: sandboxState(),
          timeouts: {
            sliceSeconds: config.sliceTimeoutSeconds,
            scadSeconds: config.scadTimeoutSeconds,
            stepSeconds: config.stepTimeoutSeconds,
            uploadSeconds: UPLOAD_SECONDS,
          },
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
        return withBody(
          req,
          res,
          config.limits.scadBodyBytes,
          SCAD_INPUT,
          "render",
          "a render",
          async (job) => {
            if (res.destroyed) return;
            const r = await renderScad(config, job.dir, kind, job.track);
            if (r.ok) return sendBytes(res, kind === "png" ? "image/png" : "model/stl", r.bytes);
            return send(res, 422, { error: "render_failed", message: r.message });
          },
        );
      }
      // An STL's preview picture (issue #316): the body is saved as
      // input.stl, the server writes a .scad that imports it, and OpenSCAD
      // renders the PNG exactly as for /v1/scad/png: the same sandbox gate,
      // landrun rules, prlimit limits and time cap.
      case "POST /v1/stl/png":
        return withBody(
          req,
          res,
          config.limits.stlBodyBytes,
          STL_INPUT,
          "render",
          "an STL picture",
          async (job) => {
            // No triangles would render as a blank picture (stlProblem).
            const problem = stlProblem(job.dir);
            if (problem !== null) {
              return send(res, 422, { error: "render_failed", message: problem });
            }
            writeStlImport(job.dir);
            if (res.destroyed) return;
            const r = await renderScad(config, job.dir, "png", job.track);
            if (r.ok) return sendBytes(res, "image/png", r.bytes);
            return send(res, 422, { error: "render_failed", message: r.message });
          },
        );
      case "POST /v1/step/glb":
        return withBody(
          req,
          res,
          config.limits.stepBodyBytes,
          STEP_INPUT,
          "program",
          "a STEP conversion",
          async (job, gate) => {
            const r = await runStepWorker(
              {
                ...config,
                worker: config.stepWorker,
                timeoutSeconds: config.stepTimeoutSeconds,
                maxOutputBytes: config.limits.stepOutputBytes,
                sandboxed: gate === "run",
              },
              job.dir,
              job.track,
            );
            if (r.ok) return sendBytes(res, "model/gltf-binary", r.bytes);
            return send(res, 422, { error: "convert_failed", message: r.message });
          },
        );
      default:
        return refuseEarly(res, 404, { error: "not_found" });
    }
  }

  startSandboxCheck();

  // A handler that throws or rejects is answered 500, or its connection is
  // closed if the answer has started, and its job is undone (guard.ts).
  const server = createServer(requestTimeouts(config), guardRequests(handle, log));

  return {
    server,
    close: async () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      for (const kill of running) kill();
      running.clear();
      // The check a kill cut short releases its job and folder.
      await sandboxCheck;
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
