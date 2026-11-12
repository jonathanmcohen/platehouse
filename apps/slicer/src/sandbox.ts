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
// outright: GitHub's runner has ABI 8 (CI run 42530006914). Best effort
// would sandbox OpenSCAD with whatever an older kernel offers, or not at all
// on a kernel with no Landlock, so the server does not trust it. Before it
// renders, its self-test (sandboxSelfTest in scad.ts) reads the kernel's
// Landlock ABI and refuses renders below MIN_LANDLOCK_ABI, then proves the
// sandbox blocks a read outside the job folder. Renders stay off until that
// check has passed.
//
// OpenSCAD also runs under prlimit (prlimitArgs): kernel limits on CPU
// time, address space, process count, file size and core-file size, a
// second line behind the server's wall-clock cap and the container's own
// limits.
//
// runGroup, below, is how the server runs every external program (Orca,
// prlimit and landrun with OpenSCAD, the STEP worker): in its own process
// group, killed whole at its time cap.
import { spawn } from "node:child_process";

/**
 * Paths OpenSCAD may run code from, besides its own AppImage tree: the
 * multiarch library folder, which holds every system library it links and
 * Mesa's EGL and DRI drivers for PNG renders, and the ELF loader (on Ubuntu
 * 24.04 a link into that folder, named so the rule says what it is for).
 * Nothing else: no /usr/bin or /bin, so OpenSCAD cannot start a shell or any
 * other program, and no /lib, which on Ubuntu 24.04 is a link to all of
 * /usr/lib (security review of PR #36, issue #47). The container tests prove
 * STL and PNG renders still work with only these.
 */
const SYSTEM_EXEC = ["/usr/lib/x86_64-linux-gnu", "/lib64/ld-linux-x86-64.so.2"];
/**
 * Read-only data OpenSCAD needs: fonts; for PNG renders EGL's glvnd vendor
 * files (how libEGL finds Mesa) and Mesa's driver config, without which a
 * PNG render failed with "No EGL display found" (CI run 42530496760); and
 * glibc's locale data, where the C.UTF-8 locale OpenSCAD runs with lives
 * (readable through --rox /usr/lib until that was narrowed).
 */
const READ_ONLY = [
  "/usr/share/fonts",
  "/etc/fonts",
  "/usr/share/fontconfig",
  "/usr/share/glvnd",
  "/usr/share/drirc.d",
  "/usr/lib/locale",
];

/**
 * landrun's arguments for one OpenSCAD run. `strict` drops --best-effort and
 * nothing else: landrun then asks for Landlock ABI 9 and, on an older
 * kernel, refuses with the kernel's ABI in its error, which is the only way
 * landrun reports it (readLandlockAbi).
 */
export function landrunArgs(opts: {
  dir: string;
  openscadDir: string;
  command: string[];
  strict?: boolean;
}): string[] {
  const { dir, openscadDir, command, strict = false } = opts;
  return [
    ...(strict ? [] : ["--best-effort"]),
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

/**
 * The lowest Landlock ABI the self-test accepts (Jon, 2026-11-11; Hades runs
 * kernel 6.17). ABI 6 is the first that also scopes signals and abstract
 * Unix sockets, on top of the TCP rules of ABI 4 and the filesystem rules
 * this sandbox is built on, so from 6 on best effort leaves out nothing it
 * counts on.
 */
export const MIN_LANDLOCK_ABI = 6;

/** The ABI landrun v0.1.17 asks for when it does not run best effort. */
export const LANDRUN_STRICT_ABI = 9;

/**
 * go-landlock's refusal when the kernel is older than the ABI asked for
 * (restrict.go): "missing kernel Landlock support. Got Landlock ABI v8,
 * wanted ...". landrun prints it as it exits 1.
 */
const ABI_REFUSAL = /Got Landlock ABI v(\d+)\b/;

export type AbiReading =
  /** atLeast: the kernel has at least `abi`, possibly more. */
  { abi: number; atLeast: boolean } | { abi: null; detail: string };

/**
 * Reads the kernel's Landlock ABI from a strict landrun run (landrunArgs
 * with strict). A refusal names the ABI; a run that succeeded shows the
 * kernel has at least LANDRUN_STRICT_ABI. Anything else (a timeout, a kill,
 * another error, or a newer landrun that words it differently) is unknown,
 * and the self-test treats unknown as a failed check.
 */
export function readLandlockAbi(run: GroupResult): AbiReading {
  const refusal = ABI_REFUSAL.exec(run.stderrTail);
  if (refusal) return { abi: Number(refusal[1]), atLeast: false };
  if (run.code === 0 && !run.timedOut) return { abi: LANDRUN_STRICT_ABI, atLeast: true };
  const why = run.timedOut
    ? "it ran past its time cap"
    : tailLines(`${run.stderrTail}\n${run.stdoutTail}`, 3, 300) ||
      `it exited with ${run.signal ?? run.code} and said nothing`;
  return { abi: null, detail: why };
}

/**
 * CPUs the slicer container gets (AC-035: --cpus 4 on Hades, the gate's
 * sizing). CPU time adds up across a program's threads, so a render that
 * uses all of them for its whole wall-clock cap spends this many seconds of
 * CPU per second.
 */
const SLICER_CPUS = 4;
/** Added to the CPU-time limit so that the wall-clock cap always fires first. */
const CPU_MARGIN_SECONDS = 60;
/**
 * The address-space limit: the container's 4 GiB of memory (AC-035). Virtual
 * reservations (thread stacks, malloc arenas, Mesa's buffers) count against
 * it as well as memory in use, so it is not set lower; at this value a
 * runaway render fails its own allocation instead of leaving the kernel's
 * OOM killer to choose a process in the container.
 */
export const OPENSCAD_ADDRESS_SPACE_BYTES = 4 * 1024 * 1024 * 1024;
/**
 * The process-count limit (RLIMIT_NPROC, which counts every process and
 * thread of the slicer user, the server's own included): far above what a
 * render needs (OpenSCAD's TBB and Mesa llvmpipe start about one thread per
 * host CPU; Hades has 8), far below what a runaway fork could reach. The
 * container's pids_limit (Task 26) is the hard cap.
 */
export const OPENSCAD_PROCESS_LIMIT = 512;

/**
 * The largest STL or PNG a render may answer with, and OpenSCAD's file-size
 * limit (RLIMIT_FSIZE). The server holds the output in memory to send it, so
 * an output over this is refused, never read. 256 MiB is about 5 million
 * triangles of binary STL, far more than a printable model needs (security
 * review of PR #36, issue #47). Under the file-size limit the kernel stops
 * OpenSCAD with SIGXFSZ when it writes past this, so the output never grows
 * past it in /work; a file of exactly this size passes both.
 */
export const MAX_RENDER_OUTPUT_BYTES = 256 * 1024 * 1024;

/**
 * prlimit's arguments, before its "--". The CPU-time limit is the wall-clock
 * cap on SLICER_CPUS CPUs plus CPU_MARGIN_SECONDS (540 s at the default 120 s
 * cap), so it stops only a render the wall-clock kill somehow missed. The
 * file-size limit is MAX_RENDER_OUTPUT_BYTES. The core-file size is 0:
 * SIGXFSZ, which the file-size limit sends, dumps core by default, and a
 * request can make a render too big on purpose, so without it each such
 * render could leave a core of up to the address-space limit in /work or
 * hand one to the host's core handler. Each value sets the soft and the
 * hard limit.
 */
export function prlimitArgs(timeoutSeconds: number): string[] {
  return [
    `--cpu=${timeoutSeconds * SLICER_CPUS + CPU_MARGIN_SECONDS}`,
    `--as=${OPENSCAD_ADDRESS_SPACE_BYTES}`,
    `--nproc=${OPENSCAD_PROCESS_LIMIT}`,
    `--fsize=${MAX_RENDER_OUTPUT_BYTES}`,
    "--core=0",
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
