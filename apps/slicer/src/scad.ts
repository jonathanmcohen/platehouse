// OpenSCAD renders (AC-052, build plan Task 11): POST /v1/scad/stl and
// /v1/scad/png. The .scad text is written alone into a fresh job folder and
// OpenSCAD 2026.11-RC0 renders it under prlimit and landrun (see
// sandbox.ts), with a time cap and OPENSCADPATH unset. What Landlock cannot
// restrict on Hades' kernel (UDP, and a connect to a pathname Unix socket
// below ABI 9) is left to the container: only its internal network and no
// socket mounted (MIN_LANDLOCK_ABI in sandbox.ts). A render that fails answers with the tail of
// OpenSCAD's own stderr. OpenSCAD's file-size limit is
// MAX_RENDER_OUTPUT_BYTES, so writing past it stops OpenSCAD, and an output
// over it that gets through anyway is refused.
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type GroupResult,
  landrunArgs,
  MAX_RENDER_OUTPUT_BYTES,
  MIN_LANDLOCK_ABI,
  prlimitArgs,
  readLandlockAbi,
  runGroup,
  type ScadOutput,
  scadArgs,
  tailLines,
} from "./sandbox.js";

export interface ScadConfig {
  landrunBin: string;
  /** util-linux prlimit, which sets OpenSCAD's resource limits (sandbox.ts). */
  prlimitBin: string;
  openscadBin: string;
  openscadDir: string;
  scadTimeoutSeconds: number;
}

export type RenderResult =
  | { ok: true; bytes: Buffer }
  | {
      ok: false;
      /** What the caller shows: the tail of OpenSCAD's output, or why it stopped. */
      message: string;
      /** Everything captured from stderr and stdout (up to 64 KiB of each). */
      output: string;
    };

/** The name the .scad takes inside its job folder. */
export const SCAD_INPUT = "input.scad";

const MIB = 1024 * 1024;

// The render output cap lives in sandbox.ts beside the prlimit limits it
// also sets; it is exported here too, where the server's tests read it.
export { MAX_RENDER_OUTPUT_BYTES };

/**
 * Reads a finished render's output, or reports its size when it is over
 * `limit` without reading it. The size is taken from the open file, so the
 * file read is the file measured. The file is opened without following a
 * symlink (O_NOFOLLOW) and without blocking (O_NONBLOCK, so a FIFO cannot
 * hang the server), and anything fstat does not call a regular file is
 * refused unread: code running inside OpenSCAD could swap its output for a
 * link to any file the server can read, and the server, which is not
 * sandboxed, would send that file back as the render (issue #153).
 */
export function readRenderOutput(
  file: string,
  limit: number,
): { ok: true; bytes: Buffer } | { ok: false; size: number } | { ok: false; notRegular: true } {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    // ELOOP: the name is a symlink. EISDIR is not raised for O_RDONLY, so a
    // folder is caught by fstat below.
    if ((err as NodeJS.ErrnoException).code === "ELOOP") return { ok: false, notRegular: true };
    throw err;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, notRegular: true };
    const { size } = st;
    if (size > limit) return { ok: false, size };
    const bytes = Buffer.alloc(size);
    let at = 0;
    while (at < size) {
      const n = readSync(fd, bytes, at, size - at, at);
      if (n === 0) break;
      at += n;
    }
    return { ok: true, bytes: bytes.subarray(0, at) };
  } finally {
    closeSync(fd);
  }
}

/** True when something, a symlink included, has this name. */
function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `command` (OpenSCAD and its arguments) in `dir` the way every render
 * runs it: prlimit sets the resource limits on itself and runs landrun,
 * which applies the sandbox and runs OpenSCAD in its place, so OpenSCAD
 * inherits both. prlimit comes first because nothing outside OpenSCAD's own
 * tree may run inside the sandbox. `strict` runs landrun without
 * --best-effort, for the self-test's Landlock ABI check.
 */
function runSandboxed(
  config: ScadConfig,
  dir: string,
  command: string[],
  opts: { timeoutMs: number; strict?: boolean; track?: (kill: (() => void) | null) => void },
): Promise<GroupResult> {
  const landrun = landrunArgs({
    dir,
    openscadDir: config.openscadDir,
    command,
    strict: opts.strict ?? false,
  });
  return runGroup(
    config.prlimitBin,
    [...prlimitArgs(config.scadTimeoutSeconds), "--", config.landrunBin, ...landrun],
    {
      cwd: dir,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: dir, TMPDIR: dir, LANG: "C.UTF-8" },
      timeoutMs: opts.timeoutMs,
      ...(opts.track ? { track: opts.track } : {}),
    },
  );
}

/**
 * Renders dir/input.scad (SCAD_INPUT), which the caller has already written,
 * so the server never holds the body in memory.
 */
export async function renderScad(
  config: ScadConfig,
  dir: string,
  kind: ScadOutput,
  track?: (kill: (() => void) | null) => void,
): Promise<RenderResult> {
  const input = SCAD_INPUT;
  const outputName = `output.${kind}`;
  const command = [config.openscadBin, ...scadArgs(kind, input, outputName)];
  const run = await runSandboxed(config, dir, command, {
    timeoutMs: config.scadTimeoutSeconds * 1000,
    ...(track ? { track } : {}),
  });
  const output = `${run.stderrTail}\n${run.stdoutTail}`;
  if (run.timedOut) {
    return {
      ok: false,
      message: `OpenSCAD took longer than ${config.scadTimeoutSeconds} s and was stopped.`,
      output,
    };
  }
  // prlimit's file-size limit: the kernel kills OpenSCAD with SIGXFSZ when
  // it writes past MAX_RENDER_OUTPUT_BYTES (landrun runs it in its own place,
  // and OpenSCAD's AppRun is the binary itself, so the signal reaches here).
  if (run.signal === "SIGXFSZ") {
    return {
      ok: false,
      message: `OpenSCAD's ${kind.toUpperCase()} went over the ${MAX_RENDER_OUTPUT_BYTES / MIB} MiB limit for a render, so it was stopped while writing it.`,
      output,
    };
  }
  const out = join(dir, outputName);
  // lstat, not stat: the output is looked at as it is, never through a link
  // (readRenderOutput says why).
  if (run.code === 0 && lexists(out)) {
    const read = readRenderOutput(out, MAX_RENDER_OUTPUT_BYTES);
    if (read.ok && read.bytes.length > 0) return { ok: true, bytes: read.bytes };
    if (!read.ok && "notRegular" in read) {
      return {
        ok: false,
        message: `OpenSCAD's ${kind.toUpperCase()} output was not a regular file, so it was not read.`,
        output,
      };
    }
    if (!read.ok) {
      return {
        ok: false,
        message: `OpenSCAD wrote a ${Math.ceil(read.size / MIB)} MiB ${kind.toUpperCase()}, over the ${MAX_RENDER_OUTPUT_BYTES / MIB} MiB limit for a render.`,
        output,
      };
    }
  }
  const message = tailLines(output);
  return {
    ok: false,
    message:
      message ||
      `OpenSCAD exited with ${run.signal ?? run.code} and wrote no ${kind.toUpperCase()}.`,
    output,
  };
}

export interface SandboxCheck {
  ok: boolean;
  detail: string;
}

/** OpenSCAD's warning for a file import() cannot open (src/io/import_stl.cc). */
const CANNOT_OPEN = "Can't open import file";

/**
 * The time cap of the Landlock ABI check: a strict landrun either refuses at
 * once or runs `openscad --version`, which takes well under a second once
 * the image's files are in the page cache.
 */
const ABI_CHECK_SECONDS = 30;

/**
 * Proves the sandbox works before a render runs. landrun runs best effort,
 * which would sandbox OpenSCAD with whatever an older kernel offers, or not
 * at all, so this checks three things, in order, and passes only when all
 * three do:
 *
 * 1. The probe, a file outside the job folder, exists, is not empty and can
 *    be read by the server. A missing or unreadable probe makes OpenSCAD
 *    print "Can't open import file" with or without a sandbox, so the
 *    import below would prove nothing: the check is inconclusive.
 * 2. The kernel's Landlock ABI is at least MIN_LANDLOCK_ABI. landrun reports
 *    it only when it runs without --best-effort, so this runs the same
 *    landrun rules strict, with `openscad --version` as the command. An ABI
 *    landrun does not report makes the check inconclusive.
 * 3. A .scad that imports the probe, rendered through the same prlimit and
 *    landrun call a real render uses, fails because OpenSCAD itself reports
 *    that it cannot open the probe: "Can't open import file" naming the
 *    probe's path. Any other failure (a timeout, a crash, landrun failing to
 *    start, a full /work) proves nothing, so it is inconclusive too.
 *
 * Every failure, inconclusive or not, refuses renders; the detail says why
 * in plain words, and the server puts it in its log and in the render's
 * error.
 */
export async function sandboxSelfTest(
  config: ScadConfig,
  dir: string,
  probe: string,
  track?: (kill: (() => void) | null) => void,
): Promise<SandboxCheck> {
  if (!existsSync(probe) || statSync(probe).size === 0) {
    return {
      ok: false,
      detail: `the sandbox probe ${probe} is missing, so the sandbox cannot be checked`,
    };
  }
  try {
    accessSync(probe, constants.R_OK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "an error";
    return {
      ok: false,
      detail: `the check was inconclusive: the sandbox probe ${probe} cannot be read by the server (${code}), so OpenSCAD failing to open it would prove nothing`,
    };
  }

  const abiRun = await runSandboxed(config, dir, [config.openscadBin, "--version"], {
    timeoutMs: ABI_CHECK_SECONDS * 1000,
    strict: true,
    ...(track ? { track } : {}),
  });
  const abi = readLandlockAbi(abiRun);
  if (abi.abi === null) {
    return {
      ok: false,
      detail: `the check was inconclusive: landrun did not report the kernel's Landlock ABI (${abi.detail})`,
    };
  }
  if (abi.abi < MIN_LANDLOCK_ABI) {
    return {
      ok: false,
      detail: `the kernel's Landlock ABI is ${abi.abi}, below the ${MIN_LANDLOCK_ABI} this sandbox needs, so OpenSCAD would run with fewer restrictions than it is built for`,
    };
  }
  const abiText = `Landlock ABI ${abi.abi}${abi.atLeast ? " or newer" : ""}`;

  writeFileSync(join(dir, SCAD_INPUT), `import(${JSON.stringify(probe)});\n`);
  const r = await renderScad(config, dir, "stl", track);
  if (r.ok) {
    return {
      ok: false,
      detail: `OpenSCAD read ${probe} from outside its job folder under landrun`,
    };
  }
  const paths = new Set([probe, realpathSync(probe)]);
  const refusal = r.output
    .split("\n")
    .find((line) => line.includes(CANNOT_OPEN) && [...paths].some((p) => line.includes(p)));
  if (refusal) {
    return {
      ok: true,
      detail: `${abiText}; landrun blocked a read of ${probe}: ${refusal.trim()}`,
    };
  }
  return {
    ok: false,
    detail: `the check was inconclusive: OpenSCAD did not report that it could not open ${probe} (${r.message.split("\n").at(-1) ?? ""})`,
  };
}
