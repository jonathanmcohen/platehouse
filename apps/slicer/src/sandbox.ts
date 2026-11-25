// The sandbox of the three programs that open untrusted files, so none can
// read user, app or another job's data: OpenSCAD (a render), OrcaSlicer (a
// slice) and the STEP worker (a conversion). Each runs under landrun v0.1.17
// (Linux Landlock) with its own rules (sandboxRules): read and execute access
// only to what it needs to start, read-only access to the data it needs, and
// write access to its own job folder alone. No rule opens the network:
// landrun refuses every TCP bind and connect unless it is given a port.
// OpenSCAD's job folder holds the one .scad file, and OPENSCADPATH is never
// set, so no library folder is searched.
//
// Two lessons from the slicing gate (runs 3 and 4, 2026-11-08):
// - every path a binary is executed or mapped from needs --rox: the first
//   design's form with --ro on the OpenSCAD tree does not run (exit 1);
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
// Each program also runs under prlimit (prlimitArgs): kernel limits on CPU
// time, process count, file size and core-file size (and, for OpenSCAD,
// address space), a second line behind the server's wall-clock cap and the
// container's own limits. Slices and conversions share the renders'
// self-test: the sandbox they run in is the one it proves, and with the
// sandbox off they run only when SLICER_ALLOW_UNSANDBOXED is set, and then
// under prlimit alone (prlimitCommand with no landrun).
//
// runGroup, below, is how the server runs every external program (prlimit,
// then GNU time for a slice, then landrun, then the program): in its own
// process group, killed whole at its time cap.
import { spawn } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import { LIMITS } from "@platehouse/slicer-contract";
import { launcherEnv, scratchEnv } from "./orca.js";

/**
 * Paths each sandboxed program may run code from, besides its own tree
 * (OpenSCAD's or Orca's AppImage, or Node's folder): the multiarch library
 * folder, which holds every system library they link and Mesa's EGL and DRI
 * drivers for PNG renders, and the ELF loader (on Ubuntu 24.04 a link into
 * that folder, named so the rule says what it is for). Nothing else: no
 * /usr/bin or /bin, so none of them can start a shell or any of the system's
 * commands, and no /lib, which on Ubuntu 24.04 is a link to all of /usr/lib
 * (security review of PR #36, issue #47). The multiarch folder still holds a
 * few runnable helpers (WebKit's WebKitNetworkProcess and MiniBrowser,
 * GStreamer's gst-plugin-scanner and gst-ptp-helper, among others), and
 * they run under the same sandbox; none is setuid or setgid (the image
 * strips every such bit and its build fails if one is left), and Landlock
 * sets no-new-privileges besides (security review of PR #123, issue #153).
 * A .scad file alone cannot run anything. The container tests prove STL and
 * PNG renders, slices and STEP conversions still work with only these.
 */
const SYSTEM_EXEC = ["/usr/lib/x86_64-linux-gnu", "/lib64/ld-linux-x86-64.so.2"];
/**
 * Read-only data OpenSCAD needs, which Orca gets too: fonts; for PNG
 * renders EGL's glvnd vendor files (how libEGL finds Mesa) and Mesa's driver
 * config, without which a PNG render failed with "No EGL display found" (CI
 * run 42530496760); and glibc's locale data, where the C.UTF-8 locale
 * OpenSCAD runs with lives (readable through --rox /usr/lib until that was
 * narrowed).
 */
const READ_ONLY = [
  "/usr/share/fonts",
  "/etc/fonts",
  "/usr/share/fontconfig",
  "/usr/share/glvnd",
  "/usr/share/drirc.d",
  "/usr/lib/locale",
];

/** The programs that run in the sandbox: a render, a slice and a STEP conversion. */
export type SandboxedProgram = "openscad" | "orca" | "step";

/** Where a program's files are: its job folder, and the image's folders. */
export interface SandboxPaths {
  /**
   * The only folder the program may write: its job folder under WORK_DIR,
   * or for Orca its own folder inside the job folder (ORCA_FOLDER in
   * orca.ts), so files the server reads from the job folder stay out of
   * its reach.
   */
  dir: string;
  openscadDir: string;
  orcaDir: string;
  /** The flattened printer and filament profiles (PROFILES_DIR). */
  profilesDir: string;
  /** The folder of the Node that runs the STEP worker (bin/node inside it). */
  nodeDir: string;
  /** The built app: the STEP worker's step.js and occt-import-js. */
  appDir: string;
}

/** The server's settings every sandboxed run needs: the two wrappers and the image's folders. */
export interface SandboxConfig extends Omit<SandboxPaths, "dir"> {
  landrunBin: string;
  /** util-linux prlimit, which sets each program's resource limits. */
  prlimitBin: string;
}

/** The paths of one job: its folder, and the image's folders from the config. */
export function sandboxPaths(config: SandboxConfig, dir: string): SandboxPaths {
  return {
    dir,
    openscadDir: config.openscadDir,
    orcaDir: config.orcaDir,
    profilesDir: config.profilesDir,
    nodeDir: config.nodeDir,
    appDir: config.appDir,
  };
}

/** One program's landrun rules and the only environment it is given. */
export interface SandboxRules {
  /** Read and execute: every path a binary or library is run or mapped from. */
  rox: string[];
  /** Read only. */
  ro: string[];
  /** Read and write. */
  rw: string[];
  env: Record<string, string>;
}

/**
 * Each program's rules. Every one may write only paths.dir (its job folder,
 * or for Orca its own folder inside it), runs code only from its own tree,
 * the multiarch library folder and the loader (SYSTEM_EXEC), and gets no
 * network rule, so landrun refuses it every TCP bind and connect (Landlock
 * does not cover UDP; the container's internal network does):
 *
 * - openscad: reads READ_ONLY. These rules are exactly the ones the slicing
 *   gate and the container tests proved, and a unit test pins them.
 * - orca: reads the profiles (PROFILES_DIR, where the machine and filament
 *   files it loads are) and READ_ONLY (fonts, EGL's vendor files, Mesa's
 *   driver config and the locale data). Its presets and process_full are in
 *   its own tree. Its environment is scratchEnv's (HOME, TMPDIR and the XDG
 *   folders all in its own folder) plus what its AppImage launcher would set
 *   (launcherEnv in orca.ts, which says why Orca runs without the launcher).
 *   It needs nothing under /etc but the fonts' config, and nothing under
 *   /proc or /sys: OrcaSlicer 2.5.0's command line reads /proc/self/statm
 *   and /proc/version only for its log, and goes on without them
 *   (src/libslic3r/utils.cpp and Platform.cpp at the v2.5.0 commit). If it
 *   fails to start under these rules, the likeliest missing read-only paths
 *   are /usr/share/glib-2.0/schemas, /proc/self and /etc/ld.so.cache;
 *   landrun logs each denial with LANDRUN_LOG_LEVEL=debug.
 * - step: reads the app, where step.js and occt-import-js are, and runs
 *   Node from its own folder. OPENSSL_CONF is set empty, so Node loads no
 *   OpenSSL config file (Node's documented way past one it cannot read) and
 *   needs nothing under /etc. Without it Node opens /etc/ssl/openssl.cnf at
 *   start-up, and when the file exists but cannot be read it exits with
 *   "OpenSSL configuration error ... Permission denied" (CI run
 *   45323577150); a missing file is ignored. The worker does no crypto, so
 *   the file's settings are not needed.
 */
export function sandboxRules(program: SandboxedProgram, paths: SandboxPaths): SandboxRules {
  const { dir } = paths;
  switch (program) {
    case "openscad":
      return {
        rox: [paths.openscadDir, ...SYSTEM_EXEC],
        ro: [...READ_ONLY],
        rw: [dir],
        env: { HOME: dir, TMPDIR: dir, LANG: "C.UTF-8", PATH: "/usr/bin:/bin" },
      };
    case "orca":
      return {
        rox: [paths.orcaDir, ...SYSTEM_EXEC],
        ro: [paths.profilesDir, ...READ_ONLY],
        rw: [dir],
        env: { ...scratchEnv(dir), ...launcherEnv(paths.orcaDir) },
      };
    case "step":
      return {
        rox: [paths.nodeDir, ...SYSTEM_EXEC],
        ro: [paths.appDir],
        rw: [dir],
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          HOME: dir,
          TMPDIR: dir,
          LANG: "C.UTF-8",
          OPENSSL_CONF: "",
        },
      };
  }
}

/**
 * landrun's arguments for one run under `rules`. landrun passes the program
 * only the --env variables. `strict` drops --best-effort and nothing else:
 * landrun then asks for Landlock ABI 9 and, on an older kernel, refuses with
 * the kernel's ABI in its error, which is the only way landrun reports it
 * (readLandlockAbi).
 */
export function landrunArgs(opts: {
  rules: SandboxRules;
  command: string[];
  strict?: boolean;
}): string[] {
  const { rules, command, strict = false } = opts;
  const paths = (flag: string, list: string[]) => (list.length > 0 ? [flag, list.join(",")] : []);
  return [
    ...(strict ? [] : ["--best-effort"]),
    "--ignore-missing",
    ...paths("--rox", rules.rox),
    ...paths("--ro", rules.ro),
    ...paths("--rw", rules.rw),
    ...Object.entries(rules.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    "--",
    ...command,
  ];
}

/**
 * The lowest Landlock ABI the self-test accepts (the maintainer, 2026-11-11; the test
 * host runs kernel 6.17). ABI 6 is the first that also scopes signals and abstract
 * Unix sockets, on top of the TCP rules of ABI 4 and the filesystem rules
 * this sandbox is built on.
 *
 * Known limits, which only the container setup covers (security review of
 * PR #123, issue #153): below ABI 9, best effort drops the right that stops
 * a connect() to a pathname Unix socket (landrun sandbox.go, go-landlock
 * config.go), and the test host's kernel 6.17 is below ABI 9 (inferred from
 * the kernel's history; the first self-test line there records the ABI). And
 * Landlock restricts no UDP at any ABI. So OpenSCAD's sandbox relies on the
 * container having no Unix socket mounted and only its internal network
 * (a deploy checks both on its own host).
 */
export const MIN_LANDLOCK_ABI = 6;

/**
 * The landrun release apps/slicer/Dockerfile pins (ARG LANDRUN_URL). A test
 * reads the Dockerfile and compares, so a bump fails until the ABI below has
 * been checked against the new release.
 */
export const LANDRUN_VERSION = "0.1.17";

/**
 * The ABI landrun LANDRUN_VERSION asks for when it does not run best effort.
 * The value 9 was checked against landrun v0.1.17.
 */
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
 * CPUs the slicer container gets (--cpus 4 in the deploy, the gate's
 * sizing). CPU time adds up across a program's threads, so a render that
 * uses all of them for its whole wall-clock cap spends this many seconds of
 * CPU per second.
 */
const SLICER_CPUS = 4;
/** Added to the CPU-time limit so that the wall-clock cap always fires first. */
const CPU_MARGIN_SECONDS = 60;
/**
 * The address-space limit: the container's 4 GiB of memory. Virtual
 * reservations (thread stacks, malloc arenas, Mesa's buffers) count against
 * it as well as memory in use, so it is not set lower. It bounds what
 * OpenSCAD alone can reserve; it does not keep the kernel's OOM killer out.
 * The container's memory cgroup also counts the Node server and the /work
 * tmpfs, so a render that stays under this limit can still push the
 * container over its 4 GiB, and the OOM killer can act first (security
 * review of PR #123, issue #153). Setting it lower would need a measured
 * headroom for the server and /work, which has not been taken.
 */
export const OPENSCAD_ADDRESS_SPACE_BYTES = 4 * 1024 * 1024 * 1024;
/**
 * The process-count limit (RLIMIT_NPROC) of all three programs: far above
 * what a render, a slice or a conversion needs (OpenSCAD's and Orca's TBB and
 * Mesa llvmpipe start about one thread per host CPU; 8 on an 8-CPU host),
 * far below what a runaway fork could reach. RLIMIT_NPROC
 * counts every process and thread of the user, and with Docker's default of
 * no user-namespace remap that is per UID across the whole host, not per
 * container: the server's own threads count, and so would any other
 * container running as UID 10001, such as the slicing gate image, which
 * uses the same UID. Past the limit the program fails to start threads
 * (security review of PR #123, issues #138 and #153; a deploy checks that no
 * other container on its host runs as 10001). The container's pids_limit
 * (examples/docker-compose.yml) is the hard cap.
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
export const MAX_RENDER_OUTPUT_BYTES = LIMITS.renderOutputBytes;

/**
 * The file-size limit of a slice: Orca's output, scratch and data folder
 * live in the job folder on the 1 GiB /work tmpfs, so no single file it
 * writes can be larger.
 */
export const ORCA_FILE_SIZE_BYTES = 1024 * 1024 * 1024;

/**
 * prlimit's arguments, before its "--". The CPU-time limit is the program's
 * wall-clock cap on SLICER_CPUS CPUs plus CPU_MARGIN_SECONDS (540 s at a
 * 120 s cap), so it stops only a run the wall-clock kill somehow missed. The
 * process count is OPENSCAD_PROCESS_LIMIT for all three. The file-size limit
 * is each program's largest output: MAX_RENDER_OUTPUT_BYTES for a render,
 * ORCA_FILE_SIZE_BYTES for a slice, the contract's stepOutputBytes for a
 * conversion. Only OpenSCAD gets an address-space limit: Orca reserves far
 * more virtual memory than it uses, and Node's WebAssembly memory reserves
 * many GiB of address space up front, so the container's memory limit bounds
 * them instead. The core-file size is 0: SIGXFSZ, which the file-size limit
 * sends, dumps core by default, and a request can make a program's output
 * too big on purpose, so without it each such run could leave a core file
 * in /work. The limit stops a core file only when the host's core_pattern
 * names a file. When core_pattern starts with "|" the kernel ignores
 * RLIMIT_CORE (core(5)) and still pipes the dump to the host's handler;
 * whether that handler stores it depends on the handler honouring the limit
 * it is passed (%c), which this code cannot check. Each value sets the soft
 * and the hard limit.
 */
export function prlimitArgs(program: SandboxedProgram, timeoutSeconds: number): string[] {
  const cpu = `--cpu=${timeoutSeconds * SLICER_CPUS + CPU_MARGIN_SECONDS}`;
  const nproc = `--nproc=${OPENSCAD_PROCESS_LIMIT}`;
  switch (program) {
    case "openscad":
      return [
        cpu,
        `--as=${OPENSCAD_ADDRESS_SPACE_BYTES}`,
        nproc,
        `--fsize=${MAX_RENDER_OUTPUT_BYTES}`,
        "--core=0",
      ];
    case "orca":
      return [cpu, nproc, `--fsize=${ORCA_FILE_SIZE_BYTES}`, "--core=0"];
    case "step":
      return [cpu, nproc, `--fsize=${LIMITS.stepOutputBytes}`, "--core=0"];
  }
}

/**
 * prlimit's whole argument list for one run of `program`: its limits, then
 * `outside` (GNU time for a slice, which writes its report to the job
 * folder and so stays outside the sandbox), then landrun with its rules,
 * then the command. landrun applies the sandbox and runs the program in its
 * own place, so the program inherits both the limits and the sandbox, and
 * nothing outside the program runs inside it. With `landrun` null (a slice
 * or a conversion while the sandbox is off and SLICER_ALLOW_UNSANDBOXED is
 * set) the program runs under the limits alone.
 */
export function prlimitCommand(opts: {
  program: SandboxedProgram;
  timeoutSeconds: number;
  outside?: string[];
  landrun: { bin: string; rules: SandboxRules; strict?: boolean } | null;
  command: string[];
}): string[] {
  const { landrun, command } = opts;
  return [
    ...prlimitArgs(opts.program, opts.timeoutSeconds),
    "--",
    ...(opts.outside ?? []),
    ...(landrun
      ? [
          landrun.bin,
          ...landrunArgs({ rules: landrun.rules, command, strict: landrun.strict ?? false }),
        ]
      : command),
  ];
}

/** What readOutputFile found. */
export type OutputRead =
  | { ok: true; bytes: Buffer }
  /** A regular file over the limit, left unread. */
  | { ok: false; size: number }
  /** A link, FIFO, socket, folder or anything else that is not a regular file, left unread. */
  | { ok: false; notRegular: true }
  /** Nothing has that name. */
  | { ok: false; missing: true };

/**
 * Reads a file a sandboxed program left in a folder it can change: a
 * render's output, the STEP worker's mesh, Orca's result.json and statistics
 * file, and GNU time's report. It reports the size of a file over `limit`
 * without reading it. The size is taken from the open file, so the file read
 * is the file measured. The file is opened without following a symlink
 * (O_NOFOLLOW) and without blocking (O_NONBLOCK, so a FIFO cannot hang the
 * server), and anything fstat does not call a regular file is refused
 * unread: the program could swap its output for a link to any file the
 * server can read, and the server, which is not sandboxed, would send that
 * file back (issue #153). A name that cannot be opened at all, such as a
 * symlink (ELOOP) or a Unix socket (ENXIO on Linux), is refused the same way
 * rather than thrown, since a throw answers 500 and the app records that as
 * a slicer fault (PR #154 review). A name that is gone reads as missing,
 * from the same open, so there is no separate look first.
 */
export function readOutputFile(file: string, limit: number): OutputRead {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    // ELOOP: the name is a symlink; ENXIO: a Unix socket. EISDIR is not
    // raised for O_RDONLY, so a folder is caught by fstat below.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, missing: true };
    return { ok: false, notRegular: true };
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
 * How long runGroup waits for the program's pipes to close once it has
 * exited (or been killed at the time cap) before it stops reading them and
 * returns anyway.
 */
export const PIPE_GRACE_MS = 2_000;

/**
 * Runs a program in its own process group with a time cap. At the cap the
 * whole group is killed (SIGKILL), so a helper the program started cannot
 * outlive it; the group is killed again once the program exits, for the
 * same reason. `track` receives a kill function while the program runs, so
 * the server can stop it when it shuts down.
 *
 * It returns when the program's pipes close, which normally follows its exit
 * at once. A helper that called setsid() is outside the group the kills
 * reach and may keep the stdout and stderr it inherited open, so 'close'
 * never comes. So once the program has exited, or the time cap has fired,
 * runGroup waits at most pipeGraceMs (PIPE_GRACE_MS by default) for the
 * pipes, then destroys them and returns with the output read so far. Without
 * that, the job would never finish and would hold the heavy-job lock until
 * the container restarted; the helper itself is killed by reapLeftovers when
 * the job is released (issue #153 item 3).
 */
export function runGroup(
  cmd: string,
  args: string[],
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    track?: (kill: (() => void) | null) => void;
    pipeGraceMs?: number;
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
    let settled = false;
    let grace: NodeJS.Timeout | undefined;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      opts.track?.(null);
      resolvePromise({
        ...exit,
        timedOut,
        wallMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
        stdoutTail: stdout.toString("utf8"),
        stderrTail: stderr.toString("utf8"),
      });
    };
    // Started once, at the program's exit or the time cap, whichever is
    // first: a pipe a setsid() helper still holds cannot keep the job open.
    const waitForPipes = () => {
      if (grace !== undefined || settled) return;
      grace = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        settle();
      }, opts.pipeGraceMs ?? PIPE_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
      waitForPipes();
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
      waitForPipes();
    });
    child.on("close", settle);
  });
}

/** One process's parent and state, from its stat file; null when gone or unparsable. */
function readStat(procDir: string, pid: number): { ppid: number; state: string } | null {
  let stat: string;
  try {
    stat = readFileSync(join(procDir, String(pid), "stat"), "utf8");
  } catch {
    return null;
  }
  // After the last ")": the name in the parentheses may hold anything.
  const close = stat.lastIndexOf(")");
  if (close === -1) return null;
  const [state, ppid] = stat.slice(close + 2).split(" ");
  if (state === undefined || ppid === undefined || !/^[0-9]+$/.test(ppid)) return null;
  return { ppid: Number(ppid), state };
}

/**
 * Looks at every process under procDir once: the processes to leave alone
 * (PID 1, selfPid and the subtree of any process whose parent is 0, which is
 * what docker exec starts, the health check among them) and the rest, with
 * those already exited or exiting (state Z or X) left out, since there is
 * nothing left in them to signal.
 */
function scan(procDir: string, selfPid: number): { found: number[]; spared: Set<number> } {
  let names: string[];
  try {
    names = readdirSync(procDir);
  } catch {
    return { found: [], spared: new Set() };
  }
  const info = new Map<number, { ppid: number; state: string }>();
  for (const name of names) {
    if (!/^[1-9][0-9]*$/.test(name)) continue;
    const stat = readStat(procDir, Number(name));
    if (stat) info.set(Number(name), stat);
  }
  // Grow the spared set from each docker exec root (parent 0, but not PID 1
  // itself, whose parent is 0 too) down through every child, until a pass
  // adds none.
  const spared = new Set<number>();
  for (const [pid, { ppid }] of info) {
    if (ppid === 0 && pid !== 1 && pid !== selfPid) spared.add(pid);
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, { ppid }] of info) {
      if (!spared.has(pid) && spared.has(ppid) && pid !== selfPid) {
        spared.add(pid);
        grew = true;
      }
    }
  }
  const found: number[] = [];
  for (const [pid, { state }] of info) {
    if (pid === 1 || pid === selfPid || spared.has(pid)) continue;
    if (state === "Z" || state === "X") continue;
    found.push(pid);
  }
  return { found: found.sort((x, y) => x - y), spared };
}

/**
 * Every process a finished job may have left running: all of them except PID
 * 1, selfPid, the subtree of any process whose parent is 0 (docker exec's)
 * and those already exited (state Z or X), read from each
 * procDir/<pid>/stat. A program that calls setsid() leaves its job's process
 * group, so the kill at the time cap misses it; once its parent is gone it
 * is re-parented to PID 1, tini in the image (issue #153), and its own
 * children stay below it. The parent is read after the last ")" of the stat
 * line, since the name in the parentheses may hold anything, ")" and digits
 * included. A stat that is gone or does not parse is skipped.
 */
export function leftoverProcesses(procDir: string, selfPid: number): number[] {
  return scan(procDir, selfPid).found;
}

/**
 * Sends SIGKILL to the processes leftoverProcesses lists, and looks again
 * for as long as a pass finds a process it has not signalled before, at most
 * maxPasses (20) passes. Returns the ids it signalled. The server runs it
 * after each job, and nowhere else: when that job releases the lock, nothing
 * of it may still be running, so a setsid() child cannot outlive it holding
 * /work files open (issue #153 item 3). A kill that fails
 * (already gone, or not this user's) is skipped.
 *
 * Which processes are spared depends on the whole table (a docker exec
 * subtree is known only once every parent is read), so each pass reads it
 * first. To keep the gap between looking at a process and signalling it
 * short, each one is read again just before its signal, and is signalled
 * only if it is still there, still live and still outside the spared set.
 *
 * When the last pass still finds processes it has not signalled before, the
 * clean-up has not finished, and onOutrun runs: by default it logs one line
 * and exits the server with code 1, so tini exits and the container's
 * restart policy starts a fresh container.
 */
export function reapLeftovers(
  opts: {
    procDir?: string;
    selfPid?: number;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
    maxPasses?: number;
    onOutrun?: () => void;
  } = {},
): number[] {
  const procDir = opts.procDir ?? "/proc";
  const kill = opts.kill ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal));
  const maxPasses = opts.maxPasses ?? 20;
  const selfPid = opts.selfPid ?? process.pid;
  const onOutrun = opts.onOutrun ?? exitAfterUnfinishedReap;
  const tried = new Set<number>();
  const killed: number[] = [];
  let outrun = false;
  for (let pass = 0; pass < maxPasses; pass++) {
    const { found, spared } = scan(procDir, selfPid);
    const fresh = found.filter((pid) => !tried.has(pid));
    if (fresh.length === 0) break;
    if (pass === maxPasses - 1) outrun = true;
    for (const pid of fresh) {
      tried.add(pid);
      const now = readStat(procDir, pid);
      if (!now || now.state === "Z" || now.state === "X" || spared.has(now.ppid)) continue;
      try {
        kill(pid, "SIGKILL");
        killed.push(pid);
      } catch {
        // already gone, or not ours to signal
      }
    }
  }
  if (outrun) onOutrun();
  return killed;
}

/**
 * reapLeftovers' default onOutrun: one plain line, then exit 1. The server
 * runs under tini as PID 1 wherever it reaps, so the container stops and its
 * restart policy brings up a fresh one.
 */
function exitAfterUnfinishedReap(): never {
  process.stdout.write(
    `${new Date().toISOString()} processes left behind by a job were still appearing after the last clean-up pass; exiting so the container restarts\n`,
  );
  process.exit(1);
}

/**
 * True only where reapLeftovers is safe: on Linux, with the server's parent
 * PID 1 and PID 1 named tini, as in the image (its ENTRYPOINT). Anywhere
 * else (a developer machine, a CI runner, a test) PID 1 has other children
 * that are not the slicer's to kill.
 */
export function runsUnderTini(
  opts: { procDir?: string; ppid?: number; platform?: NodeJS.Platform } = {},
): boolean {
  if ((opts.platform ?? process.platform) !== "linux") return false;
  if ((opts.ppid ?? process.ppid) !== 1) return false;
  try {
    return readFileSync(join(opts.procDir ?? "/proc", "1", "comm"), "utf8").trim() === "tini";
  } catch {
    return false;
  }
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

/**
 * Control characters other than the line break (C0, DEL and C1), and the
 * direction-changing ones (U+202A to U+202E, U+2066 to U+2069).
 */
function isUnsafeChar(code: number): boolean {
  return (
    (code <= 0x1f && code !== 0x0a) ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * A program's output as a message: the lead-in naming the program, then the
 * output's last 20 lines on one line, joined with " / ", after the control
 * and direction-changing characters are removed. Program output is always
 * led in. At most `chars` characters of output are kept, cut from the front
 * before the lead-in is added. "" when no output is left, for the caller's
 * own sentence.
 */
export function ledInMessage(leadIn: string, text: string, lines = 20, chars = 2000): string {
  const one = [...text]
    .filter((ch) => !isUnsafeChar(ch.charCodeAt(0)))
    .join("")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .slice(-lines)
    .join(" / ");
  if (one.length === 0) return "";
  return `${leadIn}${one.length > chars ? one.slice(one.length - chars) : one}`;
}

export type ScadOutput = "stl" | "png";

/**
 * OpenSCAD's own arguments. STL uses the Manifold backend (the image ships
 * the Manifold build); gate item (f) proved --backend=manifold renders headless.
 * PNG is a fitted 800 x 800 image of the model.
 */
export function scadArgs(kind: ScadOutput, input: string, output: string): string[] {
  if (kind === "stl") return ["--backend=manifold", "-o", output, input];
  return ["--imgsize=800,800", "--viewall", "--autocenter", "-o", output, input];
}
