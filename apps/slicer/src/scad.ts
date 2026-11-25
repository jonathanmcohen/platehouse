// OpenSCAD renders, with no TCP and no access to user, app or job data: POST /v1/scad/stl and
// /v1/scad/png. The .scad text is written alone into a fresh job folder and
// OpenSCAD 2026.11-RC0 renders it under prlimit and landrun (see
// sandbox.ts), with a time cap and OPENSCADPATH unset. What Landlock cannot
// restrict (UDP at any ABI, and a connect to a pathname Unix socket
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
  openSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type GroupResult,
  ledInMessage,
  MAX_RENDER_OUTPUT_BYTES,
  MIN_LANDLOCK_ABI,
  prlimitCommand,
  readLandlockAbi,
  readOutputFile,
  runGroup,
  type SandboxConfig,
  type ScadOutput,
  sandboxPaths,
  sandboxRules,
  scadArgs,
} from "./sandbox.js";

export interface ScadConfig extends SandboxConfig {
  openscadBin: string;
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

/** The name an STL to preview takes inside its job folder (POST /v1/stl/png). */
export const STL_INPUT = "input.stl";

/** What /v1/stl/png answers for a body stlProblem refuses. */
export const NOT_AN_STL =
  "The file is not an STL with at least one triangle, so there is nothing to render.";

/** How much of an STL stlProblem reads to find an ASCII STL's first facet. */
const STL_HEAD_BYTES = 64 * 1024;

/**
 * Why dir/STL_INPUT cannot be previewed, or null when it can. OpenSCAD
 * writes a PNG of an empty scene when an import gives it nothing to draw (as
 * the image did for a body of plain text, CI run 44975403164), so a body
 * with no triangles would come back as a blank picture. This passes an
 * ASCII STL ("solid", then a "facet" in its first 64 KiB) and a binary STL
 * with at least one whole 50-byte facet after its 84-byte header, whatever
 * its count field says, as the app's own STL check does
 * (apps/server/src/ingest/detect.ts); anything else is refused before
 * OpenSCAD runs. The file is read without following a symlink.
 */
export function stlProblem(dir: string): string | null {
  const fd = openSync(join(dir, STL_INPUT), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const { size } = fstatSync(fd);
    const head = Buffer.alloc(Math.min(size, STL_HEAD_BYTES));
    const read = readSync(fd, head, 0, head.length, 0);
    const text = head.subarray(0, read).toString("latin1");
    if (/^\s*solid/.test(text) && /\bfacet\b/.test(text)) return null;
    if (size > 84 && (size - 84) % 50 === 0) return null;
    return NOT_AN_STL;
  } finally {
    closeSync(fd);
  }
}

/**
 * Writes the .scad an STL preview renders: one import of STL_INPUT, beside
 * it in the same job folder (issue #316). The text is fixed, so nothing in
 * the request body is ever read as OpenSCAD code; the STL is only ever data
 * that import() reads, under the same sandbox as any render.
 */
export function writeStlImport(dir: string): void {
  writeFileSync(join(dir, SCAD_INPUT), `import(${JSON.stringify(STL_INPUT)});\n`);
}

const MIB = 1024 * 1024;

// The render output cap lives in sandbox.ts beside the prlimit limits it
// also sets; it is exported here too, where the server's tests read it.
export { MAX_RENDER_OUTPUT_BYTES };

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
  const rules = sandboxRules("openscad", sandboxPaths(config, dir));
  return runGroup(
    config.prlimitBin,
    prlimitCommand({
      program: "openscad",
      timeoutSeconds: config.scadTimeoutSeconds,
      landrun: { bin: config.landrunBin, rules, strict: opts.strict ?? false },
      command,
    }),
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
  // Never read through a link, or past the cap (readOutputFile says why).
  if (run.code === 0) {
    const read = readOutputFile(join(dir, outputName), MAX_RENDER_OUTPUT_BYTES);
    if (read.ok && read.bytes.length > 0) return { ok: true, bytes: read.bytes };
    if (!read.ok && "notRegular" in read) {
      return {
        ok: false,
        message: `OpenSCAD's ${kind.toUpperCase()} output was not a regular file, so it was not read.`,
        output,
      };
    }
    if (!read.ok && "size" in read) {
      return {
        ok: false,
        message: `OpenSCAD wrote a ${Math.ceil(read.size / MIB)} MiB ${kind.toUpperCase()}, over the ${MAX_RENDER_OUTPUT_BYTES / MIB} MiB limit for a render.`,
        output,
      };
    }
  }
  // OpenSCAD's output is always led in; its exit status is the slicer's own.
  return {
    ok: false,
    message:
      ledInMessage("OpenSCAD said: ", output) ||
      `OpenSCAD exited with ${run.signal ?? run.code} and wrote no ${kind.toUpperCase()}.`,
    output,
  };
}

export interface SandboxCheck {
  ok: boolean;
  detail: string;
  /**
   * Why a failed check failed: old_kernel exactly when landrun reported a
   * Landlock ABI below MIN_LANDLOCK_ABI, and check_failed for every other
   * failure, inconclusive ones included. null when the check passed.
   */
  reason: "old_kernel" | "check_failed" | null;
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
 * Proves the sandbox works; the server runs it at start-up. landrun runs best effort,
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
 * in plain words, and the server puts it in its log and in health.
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
      reason: "check_failed",
      detail: `the sandbox probe ${probe} is missing, so the sandbox cannot be checked`,
    };
  }
  try {
    accessSync(probe, constants.R_OK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "an error";
    return {
      ok: false,
      reason: "check_failed",
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
      reason: "check_failed",
      detail: `the check was inconclusive: landrun did not report the kernel's Landlock ABI (${abi.detail})`,
    };
  }
  if (abi.abi < MIN_LANDLOCK_ABI) {
    return {
      ok: false,
      reason: "old_kernel",
      detail: `the kernel's Landlock ABI is ${abi.abi}, below the ${MIN_LANDLOCK_ABI} this sandbox needs, so OpenSCAD would run with fewer restrictions than it is built for`,
    };
  }
  const abiText = `Landlock ABI ${abi.abi}${abi.atLeast ? " or newer" : ""}`;

  writeFileSync(join(dir, SCAD_INPUT), `import(${JSON.stringify(probe)});\n`);
  const r = await renderScad(config, dir, "stl", track);
  if (r.ok) {
    return {
      ok: false,
      reason: "check_failed",
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
      reason: null,
      detail: `${abiText}; landrun blocked a read of ${probe}: ${refusal.trim()}`,
    };
  }
  return {
    ok: false,
    reason: "check_failed",
    detail: `the check was inconclusive: OpenSCAD did not report that it could not open ${probe} (${r.message.split("\n").at(-1) ?? ""})`,
  };
}
