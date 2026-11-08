// OpenSCAD's sandbox (AC-052, build plan Task 11). Every render runs under
// landrun v0.1.17 (Linux Landlock) with read and execute access only to what
// OpenSCAD needs to start, read-only fonts, and write access to its own job
// folder, which holds the one .scad file. OPENSCADPATH is never set, so no
// library folder is searched.
//
// Two lessons from the slicing gate (Hades runs 3 and 4, 2026-11-08):
// - every path a binary is executed or mapped from needs --rox: the plan's
//   form with --ro on the OpenSCAD tree does not run (exit 1);
// - landrun's flags must end with "--": landrun reads flags past the command
//   until it meets "--", so without it OpenSCAD's own -o was taken as a
//   landrun flag ("flag provided but not defined: -o").
//
// landrun runs with --best-effort, as the gate proved it. Without it,
// landrun v0.1.17 asks for Landlock ABI 9 and refuses any older kernel
// outright: GitHub's runner has ABI 8 (CI run 42530006914). The filesystem
// rules this sandbox relies on work from ABI 1. Best effort would also run
// OpenSCAD unsandboxed on a kernel with no Landlock at all, so the server
// does not trust it: before it renders it proves the sandbox blocks a read
// outside the job folder (sandboxSelfTest in scad.ts), and refuses to render
// until that check has passed.
//
// runGroup, below, is how the server runs every external program (Orca,
// landrun with OpenSCAD, the STEP worker): in its own process group, killed
// whole at its time cap.
import { spawn } from "node:child_process";

/** Paths OpenSCAD's AppImage tree and the system it links against run from. */
const SYSTEM_EXEC = ["/usr/lib", "/lib", "/lib64", "/usr/lib64", "/usr/bin", "/bin"];
/**
 * Read-only data OpenSCAD needs: fonts, and for PNG renders EGL's glvnd
 * vendor files (how libEGL finds Mesa) and Mesa's driver config. Without the
 * last two a PNG render failed with "No EGL display found" (CI run
 * 42530496760).
 */
const READ_ONLY = [
  "/usr/share/fonts",
  "/etc/fonts",
  "/usr/share/fontconfig",
  "/usr/share/glvnd",
  "/usr/share/drirc.d",
];

export function landrunArgs(opts: {
  dir: string;
  openscadDir: string;
  command: string[];
}): string[] {
  const { dir, openscadDir, command } = opts;
  return [
    "--best-effort",
    "--ignore-missing",
    "--rox",
    [openscadDir, ...SYSTEM_EXEC].join(","),
    "--ro",
    READ_ONLY.join(","),
    "--rw",
    dir,
    "--env",
    `HOME=${dir}`,
    "--env",
    `TMPDIR=${dir}`,
    "--env",
    "LANG=C.UTF-8",
    "--env",
    "PATH=/usr/bin:/bin",
    "--",
    ...command,
  ];
}

export interface GroupResult {
  /** Exit code, or null when killed by a signal. */
  code: number | null;
  signal: NodeJS.Signals | null;
  /** True when the time cap killed it. */
  timedOut: boolean;
  wallMs: number;
  stdoutTail: string;
  stderrTail: string;
}

const TAIL_BYTES = 64 * 1024;

function keepTail(prev: Buffer, chunk: Buffer): Buffer {
  const next = Buffer.concat([prev, chunk]);
  return next.length > TAIL_BYTES ? next.subarray(next.length - TAIL_BYTES) : next;
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // the group is already gone
  }
}

/**
 * Runs a program in its own process group with a time cap. At the cap the
 * whole group is killed (SIGKILL), so a helper the program started cannot
 * outlive it; the group is killed again once the program exits, for the
 * same reason. `track` receives a kill function while the program runs, so
 * the server can stop it when it shuts down.
 */
export function runGroup(
  cmd: string,
  args: string[],
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    track?: (kill: (() => void) | null) => void;
  },
): Promise<GroupResult> {
  const started = process.hrtime.bigint();
  return new Promise((resolvePromise) => {
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let timedOut = false;
    let exit: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null };
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const kill = () => killGroup(child.pid);
    opts.track?.(kill);
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    child.stdout.on("data", (c: Buffer) => {
      stdout = keepTail(stdout, c);
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr = keepTail(stderr, c);
    });
    child.on("error", (err) => {
      stderr = keepTail(stderr, Buffer.from(`${err.message}\n`));
    });
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      kill();
    });
    child.on("close", () => {
      clearTimeout(timer);
      opts.track?.(null);
      resolvePromise({
        ...exit,
        timedOut,
        wallMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
        stdoutTail: stdout.toString("utf8"),
        stderrTail: stderr.toString("utf8"),
      });
    });
  });
}

/** The last lines of a program's output, at most `chars` characters. */
export function tailLines(text: string, lines = 20, chars = 2000): string {
  const out = text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(-lines)
    .join("\n");
  return out.length > chars ? out.slice(out.length - chars) : out;
}

export type ScadOutput = "stl" | "png";

/**
 * OpenSCAD's own arguments. STL uses the Manifold backend (AC-052: the
 * Manifold build); gate item (f) proved --backend=manifold renders headless.
 * PNG is a fitted 800 x 800 image of the model.
 */
export function scadArgs(kind: ScadOutput, input: string, output: string): string[] {
  if (kind === "stl") return ["--backend=manifold", "-o", output, input];
  return ["--imgsize=800,800", "--viewall", "--autocenter", "-o", output, input];
}
