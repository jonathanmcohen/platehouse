// OpenSCAD's sandbox: landrun v0.1.17 around every render. The
// slicing gate proved two things on the test server (run 4, 2026-11-08):
// - paths a binary runs from need --rox; the first design's form with --ro on the
//   OpenSCAD tree does not run (exit 1);
// - landrun's flags must end with "--", or it reads OpenSCAD's own -o as a
//   landrun flag (run 3: "flag provided but not defined: -o").
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIMITS } from "@platehouse/slicer-contract";
import { afterEach, describe, expect, test } from "vitest";
import {
  LANDRUN_STRICT_ABI,
  landrunArgs,
  ledInMessage,
  leftoverProcesses,
  MAX_RENDER_OUTPUT_BYTES,
  MIN_LANDLOCK_ABI,
  prlimitArgs,
  prlimitCommand,
  readLandlockAbi,
  reapLeftovers,
  runGroup,
  runsUnderTini,
  sandboxRules,
  scadArgs,
} from "../src/sandbox.js";
import { removeTempDirs, tempDir } from "./support/tmp.js";

// runGroup settles on the program's exit, not only on its pipes closing. A
// helper that calls setsid() leaves the group the kills reach and can keep
// the stdout and stderr pipes it inherited open; Node's 'close' then never
// fires, and a job waiting on it would hold the heavy-job lock (and keep
// /v1/health at busy) until the container restarts. reapLeftovers, which kills
// such a helper, runs only after runGroup returns (release()).
describe("runGroup and a detached helper that keeps the pipes", () => {
  // A node program that starts a detached (setsid) helper sharing its stdout
  // and stderr, prints the helper's pid, and exits. `then` is what the
  // program does after starting the helper.
  const holderScript = (then: string) =>
    [
      'const { spawn } = require("node:child_process");',
      'const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });',
      "g.unref();",
      'process.stdout.write("holder " + g.pid + "\\n");',
      then,
    ].join("\n");
  const holderPid = (out: string) => Number(out.match(/holder (\d+)/)?.[1]);
  const killHolder = (pid: number) => {
    try {
      if (pid > 0) process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  };
  // Fails the test with a clear message instead of hanging until vitest's
  // own timeout.
  const within = <T>(p: Promise<T>, ms: number) =>
    Promise.race([
      p,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`runGroup did not settle within ${ms} ms`)), ms),
      ),
    ]);

  test("settles shortly after the program exits, though the helper still holds the pipes", async () => {
    let pid = 0;
    try {
      const r = await within(
        runGroup(process.execPath, ["-e", holderScript("")], {
          cwd: tmpdir(),
          env: process.env,
          timeoutMs: 60_000,
          pipeGraceMs: 200,
        }),
        5_000,
      );
      pid = holderPid(r.stdoutTail);
      expect(pid).toBeGreaterThan(0);
      expect(r.code).toBe(0);
      expect(r.timedOut).toBe(false);
      expect(r.wallMs).toBeLessThan(5_000);
    } finally {
      killHolder(pid);
    }
  }, 10_000);

  test("at the time cap the result still comes back, with timedOut set", async () => {
    let pid = 0;
    try {
      const r = await within(
        runGroup(process.execPath, ["-e", holderScript("setTimeout(() => {}, 120000);")], {
          cwd: tmpdir(),
          env: process.env,
          timeoutMs: 300,
          pipeGraceMs: 200,
        }),
        5_000,
      );
      pid = holderPid(r.stdoutTail);
      expect(pid).toBeGreaterThan(0);
      expect(r.timedOut).toBe(true);
      expect(r.signal).toBe("SIGKILL");
    } finally {
      killHolder(pid);
    }
  }, 10_000);

  test("a program with no helper still returns its whole output and exit code", async () => {
    const r = await runGroup(
      process.execPath,
      ["-e", 'process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 3;'],
      {
        cwd: tmpdir(),
        env: process.env,
        timeoutMs: 10_000,
      },
    );
    expect(r).toMatchObject({
      code: 3,
      signal: null,
      timedOut: false,
      stdoutTail: "out",
      stderrTail: "err",
    });
  });
});

// Issue #153 item 3: a program that calls setsid() leaves its job's process
// group, so the kill at the time cap misses it, and it is re-parented to
// tini (PID 1). After each job the server kills the processes left behind,
// sparing PID 1, itself and whatever docker exec started (the health check
// included, and anything that command's processes start): those have parent 0.
describe("processes left behind by a job", () => {
  /** A fake /proc holding one stat file per [pid, comm, ppid]. */
  function proc(
    entries: Array<[number, string, number]>,
    extra: Record<string, string> = {},
  ): string {
    const dir = tempDir("slicer-proc-");
    for (const [pid, comm, ppid] of entries) {
      mkdirSync(join(dir, String(pid)));
      writeFileSync(
        join(dir, String(pid), "stat"),
        `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194560 0\n`,
      );
      writeFileSync(join(dir, String(pid), "comm"), `${comm}\n`);
    }
    for (const [name, text] of Object.entries(extra)) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, "stat"), text);
    }
    writeFileSync(join(dir, "uptime"), "1.00 1.00\n");
    return dir;
  }

  const TREE: Array<[number, string, number]> = [
    [1, "tini", 0],
    [7, "node", 1], // the server
    [42, "sleep", 1], // escaped its job with setsid
    [43, "sh", 42], // a child of the orphan
    [44, "sleep", 43], // and its grandchild
    [50, "docker-exec", 0], // started by docker exec
    [51, "sh", 50], // its child
    [52, "sleep", 51], // its grandchild
    [60, "orca-slicer", 7], // a job's own program, still the server's child
  ];

  test("lists the processes left behind, sparing PID 1, the server and the subtree of a docker exec process", () => {
    expect(leftoverProcesses(proc(TREE), 7)).toEqual([42, 43, 44, 60]);
  });

  test("an orphan with a child and a grandchild is listed whole, and exec's subtree is not", () => {
    const dir = proc([
      [1, "tini", 0],
      [7, "node", 1],
      [20, "docker-exec", 0],
      [21, "sh", 20],
      [30, "sh", 1],
      [31, "sleep", 30],
      [32, "sleep", 31],
    ]);
    expect(leftoverProcesses(dir, 7)).toEqual([30, 31, 32]);
  });

  test("reads the parent after the last ) of the name, so a crafted name cannot fake it", () => {
    // A name that reads as parent 0 must not hide the process, and one that
    // reads as parent 1 must not change which tree it belongs to.
    const dir = proc([
      [1, "tini", 0],
      [7, "node", 1],
      [50, "docker-exec", 0],
      [51, "a) S 0 (b", 7],
      [52, "a) S 1 (b", 50],
    ]);
    expect(leftoverProcesses(dir, 7)).toEqual([51]);
  });

  test("skips a stat it cannot read or parse, and names that are not process ids", () => {
    const dir = proc(TREE, { "70": "garbage", self: "7 (node) S 1 7 7\n" });
    expect(leftoverProcesses(dir, 7)).toEqual([42, 43, 44, 60]);
  });

  test("a missing /proc lists nothing", () => {
    expect(leftoverProcesses(join(tmpdir(), "slicer-no-such-proc"), 7)).toEqual([]);
  });

  /** A kill for reapLeftovers that removes the process, as a real SIGKILL does. */
  function killing(dir: string, log: number[], then: (pid: number) => void = () => {}) {
    return (pid: number, signal: NodeJS.Signals) => {
      expect(signal).toBe("SIGKILL");
      log.push(pid);
      rmSync(join(dir, String(pid)), { recursive: true });
      then(pid);
    };
  }

  test("reapLeftovers signals each with SIGKILL and returns their ids; a kill that fails is skipped", () => {
    const dir = proc(TREE);
    const killed: number[] = [];
    const out = reapLeftovers({
      procDir: dir,
      selfPid: 7,
      kill: (pid, signal) => {
        if (pid === 44) throw Object.assign(new Error("gone"), { code: "ESRCH" });
        killing(dir, killed)(pid, signal);
      },
      maxPasses: 2,
    });
    expect(killed).toEqual([42, 43, 60]);
    expect(out).toEqual([42, 43, 60]);
  });

  test("reapLeftovers passes again while a pass finds something: one a kill spawns is caught", () => {
    const dir = proc(TREE);
    const killed: number[] = [];
    const out = reapLeftovers({
      procDir: dir,
      selfPid: 7,
      kill: killing(dir, killed, (pid) => {
        // killing 42 leaves a new process below PID 1
        if (pid === 42) {
          mkdirSync(join(dir, "99"));
          writeFileSync(join(dir, "99", "stat"), "99 (respawn) S 1 99 99 0 -1 4194560 0\n");
        }
      }),
    });
    expect(killed).toEqual([42, 43, 44, 60, 99]);
    expect(out).toEqual([42, 43, 44, 60, 99]);
    expect(leftoverProcesses(dir, 7)).toEqual([]);
  });

  /** A kill that leaves the process and starts one more orphan each time. */
  function spawning(dir: string, calls: number[]) {
    return (pid: number) => {
      calls.push(pid);
      const next = 100 + calls.length;
      mkdirSync(join(dir, String(next)));
      writeFileSync(join(dir, String(next), "stat"), `${next} (n) S 1 ${next} ${next} 0 -1 0 0\n`);
    };
  }
  const SMALL: Array<[number, string, number]> = [
    [1, "tini", 0],
    [7, "node", 1],
    [42, "sleep", 1],
  ];

  test("reapLeftovers stops after maxPasses", () => {
    const calls: number[] = [];
    const dir = proc(SMALL);
    reapLeftovers({
      procDir: dir,
      selfPid: 7,
      kill: spawning(dir, calls),
      maxPasses: 3,
      onOutrun: () => {},
    });
    expect(calls).toHaveLength(3);
  });

  test("reapLeftovers defaults to 20 passes", () => {
    const calls: number[] = [];
    const dir = proc(SMALL);
    reapLeftovers({ procDir: dir, selfPid: 7, kill: spawning(dir, calls), onOutrun: () => {} });
    expect(calls).toHaveLength(20);
  });

  // When the last pass still finds processes it has not signalled, the
  // clean-up did not finish: onOutrun runs (by default it logs one line and
  // exits the server, so the container restarts).
  test("reapLeftovers calls onOutrun once when its last pass still finds new processes", () => {
    const calls: number[] = [];
    const dir = proc(SMALL);
    let outruns = 0;
    reapLeftovers({
      procDir: dir,
      selfPid: 7,
      kill: spawning(dir, calls),
      maxPasses: 3,
      onOutrun: () => {
        outruns += 1;
      },
    });
    expect(outruns).toBe(1);
  });

  test("reapLeftovers that ends with nothing new found does not call onOutrun", () => {
    const dir = proc(TREE);
    const killed: number[] = [];
    let outruns = 0;
    reapLeftovers({
      procDir: dir,
      selfPid: 7,
      kill: killing(dir, killed),
      maxPasses: 2,
      onOutrun: () => {
        outruns += 1;
      },
    });
    expect(killed).toEqual([42, 43, 44, 60]);
    expect(outruns).toBe(0);
  });

  test("reapLeftovers looks again only while a pass finds a process it has not signalled", () => {
    const dir = proc(TREE);
    let calls = 0;
    const out = reapLeftovers({
      procDir: dir,
      selfPid: 7,
      kill: () => {
        calls += 1; // nothing goes away, and nothing new appears
      },
    });
    expect(calls).toBe(4);
    expect(out).toEqual([42, 43, 44, 60]);
  });

  test("a process that has exited (state Z or X) is not listed or signalled", () => {
    const dir = proc(SMALL, {
      "43": "43 (sleep) Z 1 43 43 0 -1 0 0\n",
      "44": "44 (sleep) X 1 44 44 0 -1 0 0\n",
      "45": "45 (sleep) S 1 45 45 0 -1 0 0\n",
    });
    expect(leftoverProcesses(dir, 7)).toEqual([42, 45]);
    const killed: number[] = [];
    expect(reapLeftovers({ procDir: dir, selfPid: 7, kill: (p) => killed.push(p) })).toEqual([
      42, 45,
    ]);
  });

  test("runsUnderTini holds only on Linux, with the server's parent PID 1 named tini", () => {
    const dir = proc(TREE);
    expect(runsUnderTini({ procDir: dir, ppid: 1, platform: "linux" })).toBe(true);
    expect(runsUnderTini({ procDir: dir, ppid: 2, platform: "linux" })).toBe(false);
    expect(runsUnderTini({ procDir: dir, ppid: 1, platform: "darwin" })).toBe(false);
    const other = proc([[1, "systemd", 0]]);
    expect(runsUnderTini({ procDir: other, ppid: 1, platform: "linux" })).toBe(false);
    expect(runsUnderTini({ procDir: join(other, "missing"), ppid: 1, platform: "linux" })).toBe(
      false,
    );
  });
});

const DIR = "/work/0b5f4c2e-6a7d-4d1b-9a3e-2b7c1d9e8f00";
const OPENSCAD = "/opt/openscad/AppRun";
/** The image's paths, as the server passes them for one job folder. */
const PATHS = {
  dir: DIR,
  openscadDir: "/opt/openscad",
  orcaDir: "/opt/orca",
  profilesDir: "/opt/platehouse/profiles",
  nodeDir: "/opt/node",
  appDir: "/opt/platehouse/app",
};

function split(args: string[]) {
  const at = args.indexOf("--");
  return { flags: args.slice(0, at), command: args.slice(at + 1), at };
}

function values(flags: string[], name: string): string[] {
  const out: string[] = [];
  flags.forEach((f, i) => {
    if (f === name) out.push(...(flags[i + 1] ?? "").split(","));
  });
  return out;
}

describe("landrun arguments", () => {
  const command = [OPENSCAD, ...scadArgs("stl", "input.scad", "out.stl")];
  const args = landrunArgs({ rules: sandboxRules("openscad", PATHS), command });

  test("landrun's flags end with -- and the whole command follows unchanged", () => {
    const { command: after, at } = split(args);
    expect(at).toBeGreaterThan(0);
    expect(after).toEqual(command);
    expect(args.filter((a) => a === "--")).toHaveLength(1);
  });

  test("the OpenSCAD tree and the system libraries are --rox, never --ro", () => {
    const { flags } = split(args);
    const rox = values(flags, "--rox");
    for (const p of ["/opt/openscad", "/usr/lib/x86_64-linux-gnu", "/lib64/ld-linux-x86-64.so.2"]) {
      expect(rox).toContain(p);
    }
    expect(values(flags, "--ro")).not.toContain("/opt/openscad");
  });

  // Security review of PR #36 (issue #47): OpenSCAD may run code only from
  // its own tree, the multiarch library folder its libraries and Mesa's EGL
  // drivers live in, and the ELF loader. No shell or system command: /usr/bin
  // and /bin are gone, and so is /lib, which on Ubuntu 24.04 is a link to all
  // of /usr/lib. (The multiarch folder still holds a few runnable helpers;
  // sandbox.ts says why that is accepted, issue #153.)
  test("--rox is only the OpenSCAD tree, the multiarch libraries and the loader", () => {
    const { flags } = split(args);
    expect(values(flags, "--rox").sort()).toEqual(
      ["/lib64/ld-linux-x86-64.so.2", "/opt/openscad", "/usr/lib/x86_64-linux-gnu"].sort(),
    );
    const everything = [...values(flags, "--rox"), ...values(flags, "--ro")];
    for (const p of ["/usr/bin", "/bin", "/usr/lib", "/lib", "/lib64", "/usr/lib64", "/usr/sbin"]) {
      expect(everything).not.toContain(p);
    }
  });

  test("fonts are read-only and the job folder is the only writable path", () => {
    const { flags } = split(args);
    expect(values(flags, "--ro")).toEqual(
      expect.arrayContaining(["/usr/share/fonts", "/etc/fonts"]),
    );
    expect(values(flags, "--rw")).toEqual([DIR]);
  });

  // PNG renders through EGL. libEGL (glvnd) finds Mesa through the vendor
  // files in /usr/share/glvnd, and Mesa reads its driver config from
  // /usr/share/drirc.d; without them a PNG render under landrun failed with
  // "No EGL display found" (CI run 42530496760) while STL rendered.
  test("EGL's vendor files and Mesa's driver config are read-only", () => {
    const { flags } = split(args);
    expect(values(flags, "--ro")).toEqual(
      expect.arrayContaining(["/usr/share/glvnd", "/usr/share/drirc.d"]),
    );
  });

  // OpenSCAD runs with LANG=C.UTF-8, whose data glibc reads from
  // /usr/lib/locale/C.utf8. It was readable through --rox /usr/lib before
  // that was narrowed; it is data, so it stays readable, not executable.
  test("glibc's locale data is read-only, not executable", () => {
    const { flags } = split(args);
    expect(values(flags, "--ro")).toContain("/usr/lib/locale");
    expect(values(flags, "--rox")).not.toContain("/usr/lib/locale");
  });

  test("nothing outside the job folder is readable: no /work, /opt or /tmp beyond OpenSCAD", () => {
    const { flags } = split(args);
    const readable = [
      ...values(flags, "--ro"),
      ...values(flags, "--rox"),
      ...values(flags, "--rw"),
    ];
    for (const p of readable) {
      expect(p === DIR || !p.startsWith("/work")).toBe(true);
      expect(p === "/opt/openscad" || !p.startsWith("/opt")).toBe(true);
      expect(p.startsWith("/tmp")).toBe(false);
      expect(p).not.toBe("/");
    }
  });

  // landrun v0.1.17 asks for Landlock ABI 9 unless it runs best effort, and
  // refuses an older kernel outright: GitHub's runner has ABI 8 (CI run
  // 42530006914, "Got Landlock ABI v8, wanted Landlock V9"). The gate proved
  // this form on the test server. The server's sandbox self-test (server.test.ts)
  // refuses every render when the kernel's Landlock ABI is below 6 or the
  // sandbox does not actually block a read outside the job folder.
  test("landrun runs best effort, as the gate proved it", () => {
    expect(split(args).flags).toContain("--best-effort");
  });

  // landrun reports the kernel's Landlock ABI only when it is not best
  // effort, so the self-test's ABI check runs it strict, with the same rules.
  test("the strict form drops --best-effort and nothing else", () => {
    const strict = landrunArgs({
      rules: sandboxRules("openscad", PATHS),
      command,
      strict: true,
    });
    expect(strict).not.toContain("--best-effort");
    expect(strict).toEqual(args.filter((a) => a !== "--best-effort"));
  });

  test("OpenSCAD gets a fixed environment with no OPENSCADPATH", () => {
    const { flags } = split(args);
    const env = values(flags, "--env");
    expect(env).toEqual(
      expect.arrayContaining([
        `HOME=${DIR}`,
        `TMPDIR=${DIR}`,
        "LANG=C.UTF-8",
        "PATH=/usr/bin:/bin",
      ]),
    );
    expect(env.some((e) => e.startsWith("OPENSCADPATH"))).toBe(false);
  });
});

// OpenSCAD's rules are the ones the slicing gate and the container tests
// proved; making the rules per program must not change a byte of them.
test("OpenSCAD's landrun and prlimit arguments are exactly what they were", () => {
  const command = [OPENSCAD, ...scadArgs("stl", "input.scad", "out.stl")];
  expect(landrunArgs({ rules: sandboxRules("openscad", PATHS), command })).toEqual([
    "--best-effort",
    "--ignore-missing",
    "--rox",
    "/opt/openscad,/usr/lib/x86_64-linux-gnu,/lib64/ld-linux-x86-64.so.2",
    "--ro",
    "/usr/share/fonts,/etc/fonts,/usr/share/fontconfig,/usr/share/glvnd,/usr/share/drirc.d,/usr/lib/locale",
    "--rw",
    DIR,
    "--env",
    `HOME=${DIR}`,
    "--env",
    `TMPDIR=${DIR}`,
    "--env",
    "LANG=C.UTF-8",
    "--env",
    "PATH=/usr/bin:/bin",
    "--",
    ...command,
  ]);
  expect(prlimitArgs("openscad", 120)).toEqual([
    "--cpu=540",
    "--as=4294967296",
    "--nproc=512",
    "--fsize=268435456",
    "--core=0",
  ]);
});

// OrcaSlicer runs as bin/orca-slicer itself, with the environment its
// AppImage launcher would set (launcherEnv in orca.ts says why), under the
// same landrun as OpenSCAD: it may run code only from its own tree and the
// system libraries, read the printer profiles and the read-only data
// OpenSCAD reads, and write only its job folder. Node cannot run under these
// rules, so the container tests cannot probe Orca's sandbox from inside;
// this pins its rules, and the kernel enforces them.
describe("OrcaSlicer's sandbox", () => {
  const command = ["/opt/orca/bin/orca-slicer", "--slice", "1", `${DIR}/input.3mf`];
  const rules = sandboxRules("orca", PATHS);

  test("its rules: its own tree and the system libraries to run, profiles and fonts to read, the job folder to write", () => {
    expect(rules).toEqual({
      rox: ["/opt/orca", "/usr/lib/x86_64-linux-gnu", "/lib64/ld-linux-x86-64.so.2"],
      ro: [
        "/opt/platehouse/profiles",
        "/usr/share/fonts",
        "/etc/fonts",
        "/usr/share/fontconfig",
        "/usr/share/glvnd",
        "/usr/share/drirc.d",
        "/usr/lib/locale",
      ],
      rw: [DIR],
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: `${DIR}/home`,
        TMPDIR: `${DIR}/tmp`,
        XDG_CONFIG_HOME: `${DIR}/home/.config`,
        XDG_CACHE_HOME: `${DIR}/home/.cache`,
        XDG_DATA_HOME: `${DIR}/home/.local/share`,
        XDG_RUNTIME_DIR: `${DIR}/tmp`,
        MESA_SHADER_CACHE_DISABLE: "true",
        LANG: "C.UTF-8",
        APPDIR: "/opt/orca",
        LC_ALL: "C",
        LD_LIBRARY_PATH: "/opt/orca/lib/orca-runtime:/opt/orca/bin",
      },
    });
  });

  test("landrun's arguments carry those rules, best effort, then the command after --", () => {
    expect(landrunArgs({ rules, command })).toEqual([
      "--best-effort",
      "--ignore-missing",
      "--rox",
      "/opt/orca,/usr/lib/x86_64-linux-gnu,/lib64/ld-linux-x86-64.so.2",
      "--ro",
      "/opt/platehouse/profiles,/usr/share/fonts,/etc/fonts,/usr/share/fontconfig,/usr/share/glvnd,/usr/share/drirc.d,/usr/lib/locale",
      "--rw",
      DIR,
      "--env",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "--env",
      `HOME=${DIR}/home`,
      "--env",
      `TMPDIR=${DIR}/tmp`,
      "--env",
      `XDG_CONFIG_HOME=${DIR}/home/.config`,
      "--env",
      `XDG_CACHE_HOME=${DIR}/home/.cache`,
      "--env",
      `XDG_DATA_HOME=${DIR}/home/.local/share`,
      "--env",
      `XDG_RUNTIME_DIR=${DIR}/tmp`,
      "--env",
      "MESA_SHADER_CACHE_DISABLE=true",
      "--env",
      "LANG=C.UTF-8",
      "--env",
      "APPDIR=/opt/orca",
      "--env",
      "LC_ALL=C",
      "--env",
      "LD_LIBRARY_PATH=/opt/orca/lib/orca-runtime:/opt/orca/bin",
      "--",
      ...command,
    ]);
  });

  test("prlimit: CPU time is the wall cap on 4 CPUs plus a minute, 512 processes, 1 GiB files, no core file, no address-space limit", () => {
    expect(prlimitArgs("orca", 180)).toEqual([
      "--cpu=780",
      "--nproc=512",
      "--fsize=1073741824",
      "--core=0",
    ]);
  });
});

// The STEP worker is this Node and step.js: it may run code only from Node's
// own folder and the system libraries, read the app (step.js and
// occt-import-js) and OpenSSL's config file, and write only its job folder.
describe("the STEP worker's sandbox", () => {
  const command = ["/opt/node/bin/node", "/opt/platehouse/app/apps/slicer/dist/src/step.js"];
  const rules = sandboxRules("step", PATHS);

  test("its rules: Node and the system libraries to run, the app and OpenSSL's config file to read, the job folder to write", () => {
    expect(rules).toEqual({
      rox: ["/opt/node", "/usr/lib/x86_64-linux-gnu", "/lib64/ld-linux-x86-64.so.2"],
      ro: ["/opt/platehouse/app", "/etc/ssl/openssl.cnf"],
      rw: [DIR],
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: DIR,
        TMPDIR: DIR,
        LANG: "C.UTF-8",
      },
    });
  });

  test("landrun's arguments carry those rules, best effort, then the command after --", () => {
    expect(landrunArgs({ rules, command })).toEqual([
      "--best-effort",
      "--ignore-missing",
      "--rox",
      "/opt/node,/usr/lib/x86_64-linux-gnu,/lib64/ld-linux-x86-64.so.2",
      "--ro",
      "/opt/platehouse/app,/etc/ssl/openssl.cnf",
      "--rw",
      DIR,
      "--env",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "--env",
      `HOME=${DIR}`,
      "--env",
      `TMPDIR=${DIR}`,
      "--env",
      "LANG=C.UTF-8",
      "--",
      ...command,
    ]);
  });

  test("prlimit: CPU time is the wall cap on 4 CPUs plus a minute, 512 processes, files up to the mesh cap, no core file, no address-space limit", () => {
    expect(prlimitArgs("step", 120)).toEqual([
      "--cpu=540",
      "--nproc=512",
      `--fsize=${LIMITS.stepOutputBytes}`,
      "--core=0",
    ]);
  });
});

describe("every program's sandbox", () => {
  const PROGRAMS = ["openscad", "orca", "step"] as const;

  test.each(PROGRAMS)("%s may write only its own job folder", (program) => {
    expect(sandboxRules(program, PATHS).rw).toEqual([DIR]);
    const args = landrunArgs({ rules: sandboxRules(program, PATHS), command: ["/x"] });
    expect(values(split(args).flags, "--rw")).toEqual([DIR]);
    expect(args).not.toContain("--rwx");
  });

  // No landrun flag opens the network or lifts a restriction, so every TCP
  // bind and connect is refused (landrun restricts both unless told not to).
  test.each(PROGRAMS)("%s gets no network rule and no unrestricted mode", (program) => {
    const { flags } = split(landrunArgs({ rules: sandboxRules(program, PATHS), command: ["/x"] }));
    for (const f of flags) {
      expect(f).not.toMatch(/^--(connect-tcp|bind-tcp|unix|unrestricted-.*|ldd|add-exec)$/);
    }
  });

  test.each(PROGRAMS)("%s can read nothing under /work but its own folder", (program) => {
    const r = sandboxRules(program, PATHS);
    for (const p of [...r.rox, ...r.ro, ...r.rw]) {
      expect(p === DIR || !p.startsWith("/work")).toBe(true);
      expect(p).not.toBe("/");
    }
  });
});

// prlimit comes first and sets the limits on itself; then GNU time for a
// slice, outside the sandbox so it can write its report; then landrun, which
// applies the sandbox and runs the program in its own place. Without landrun
// (SLICER_ALLOW_UNSANDBOXED while the sandbox is off) only the limits apply.
describe("prlimit's whole command", () => {
  const rules = sandboxRules("orca", PATHS);
  const command = ["/opt/orca/bin/orca-slicer", "--slice", "1"];
  const time = ["/usr/bin/time", "-v", "-o", `${DIR}/time.txt`];

  test("limits, then time, then landrun with the rules, then the program", () => {
    expect(
      prlimitCommand({
        program: "orca",
        timeoutSeconds: 180,
        outside: time,
        landrun: { bin: "/usr/local/bin/landrun", rules },
        command,
      }),
    ).toEqual([
      ...prlimitArgs("orca", 180),
      "--",
      ...time,
      "/usr/local/bin/landrun",
      ...landrunArgs({ rules, command }),
    ]);
  });

  test("without landrun: limits, then time, then the program", () => {
    expect(
      prlimitCommand({
        program: "orca",
        timeoutSeconds: 180,
        outside: time,
        landrun: null,
        command,
      }),
    ).toEqual([...prlimitArgs("orca", 180), "--", ...time, ...command]);
  });

  test("strict passes on to landrun, for the self-test's ABI check", () => {
    const r = sandboxRules("openscad", PATHS);
    expect(
      prlimitCommand({
        program: "openscad",
        timeoutSeconds: 30,
        landrun: { bin: "/usr/local/bin/landrun", rules: r, strict: true },
        command: [OPENSCAD, "--version"],
      }),
    ).toEqual([
      ...prlimitArgs("openscad", 30),
      "--",
      "/usr/local/bin/landrun",
      ...landrunArgs({ rules: r, command: [OPENSCAD, "--version"], strict: true }),
    ]);
  });
});

describe("OpenSCAD arguments", () => {
  test("STL renders with the Manifold backend and passes -o through to OpenSCAD", () => {
    expect(scadArgs("stl", "input.scad", "out.stl")).toEqual([
      "--backend=manifold",
      "-o",
      "out.stl",
      "input.scad",
    ]);
  });

  test("PNG renders a fitted preview image", () => {
    const args = scadArgs("png", "input.scad", "out.png");
    expect(args.slice(-3)).toEqual(["-o", "out.png", "input.scad"]);
    expect(args).toEqual(expect.arrayContaining(["--viewall", "--autocenter"]));
    expect(args.some((a) => /^--imgsize=\d+,\d+$/.test(a))).toBe(true);
  });
});

// prlimit runs OpenSCAD (through landrun) under kernel-enforced limits, a
// second line behind the server's wall-clock cap and the container's own
// memory and pids limits.
describe("prlimit arguments", () => {
  test("CPU time is the wall cap on 4 CPUs plus a minute, so the wall cap always stops a render first", () => {
    expect(prlimitArgs("openscad", 120)).toContain("--cpu=540");
    expect(prlimitArgs("openscad", 30)).toContain("--cpu=180");
  });

  test("address space is the container's 4 GiB, processes are capped at 512, files at 256 MiB and core files at 0", () => {
    expect(prlimitArgs("openscad", 120)).toEqual([
      "--cpu=540",
      "--as=4294967296",
      "--nproc=512",
      "--fsize=268435456",
      "--core=0",
    ]);
  });

  // SIGXFSZ, which the file-size limit sends, dumps core by default. With
  // the core-file size at 0 a render a request makes too big on purpose
  // leaves no core file when the host's core_pattern names a file. A piped
  // core_pattern ("|...") ignores the limit and still gets the dump; only a
  // handler that honours the limit drops it. No test here runs the kernel.
  test("the core-file size limit is 0, so a render the file-size limit stops writes no core file", () => {
    expect(prlimitArgs("openscad", 120)).toContain("--core=0");
    expect(prlimitArgs("openscad", 30)).toContain("--core=0");
  });

  // The file-size limit stops OpenSCAD while it writes past the render output
  // cap (the kernel sends SIGXFSZ), instead of only refusing the file after.
  test("the file-size limit is the render output cap, so a file the cap lets through is never stopped", () => {
    expect(MAX_RENDER_OUTPUT_BYTES).toBe(256 * 1024 * 1024);
    // The same cap the contract documents and the app streams answers under.
    expect(MAX_RENDER_OUTPUT_BYTES).toBe(LIMITS.renderOutputBytes);
    expect(prlimitArgs("openscad", 120)).toContain(`--fsize=${MAX_RENDER_OUTPUT_BYTES}`);
  });
});

// landrun v0.1.17 asks for Landlock ABI 9 unless it runs best effort; on an
// older kernel go-landlock refuses with "Got Landlock ABI vN, wanted ...".
describe("reading the kernel's Landlock ABI from a strict landrun run", () => {
  const run = (code: number | null, stderr: string, timedOut = false) => ({
    code,
    signal: null,
    timedOut,
    wallMs: 1,
    stdoutTail: "",
    stderrTail: stderr,
  });
  const refusal = (abi: number) =>
    `[landrun:error] 2026/11/11 00:00:00 Failed to apply sandbox: failed to apply Landlock restrictions: missing kernel Landlock support. Got Landlock ABI v${abi}, wanted {Landlock V9; FS: all; Net: all; Scoped: all}\n`;

  test("the minimum is ABI 6 (the maintainer, 2026-11-11) and landrun asks for 9", () => {
    expect(MIN_LANDLOCK_ABI).toBe(6);
    expect(LANDRUN_STRICT_ABI).toBe(9);
  });

  test.each([0, 5, 6, 7, 8])("a refusal naming ABI %i reads as exactly that ABI", (abi) => {
    expect(readLandlockAbi(run(1, refusal(abi)))).toEqual({ abi, atLeast: false });
  });

  test("a strict run that succeeds shows the kernel has at least the ABI landrun asked for", () => {
    expect(readLandlockAbi(run(0, ""))).toEqual({ abi: 9, atLeast: true });
  });

  test.each([
    ["a failure that names no ABI", run(1, "[landrun:error] something else\n")],
    ["a timeout", run(null, "", true)],
    ["a kill", run(null, "")],
    ["a success that ran past the cap", run(0, "", true)],
  ])("%s reads as unknown", (_label, r) => {
    expect(readLandlockAbi(r).abi).toBeNull();
  });
});

// Every fake /proc folder a test made.
afterEach(removeTempDirs);

// A program's output is always shown after a lead-in that names the program,
// on one line, with control and direction-changing characters removed.
describe("ledInMessage", () => {
  test("a multi-line output becomes one line that starts with the lead-in", () => {
    const out = ledInMessage("OpenSCAD said: ", "first\r\n\nsecond\n  \nthird\n");
    expect(out).toBe("OpenSCAD said: first / second / third");
    expect(out).not.toContain("\n");
  });

  test("control characters other than the line break and direction controls are removed", () => {
    const text = "a\u0000b\u001bc\u007fd\u0085e\u009ff\u202eg\u2066h\u2069i\tj\nk";
    expect(ledInMessage("X: ", text)).toBe("X: abcdefghij / k");
  });

  test("an output with nothing left is an empty string, for the caller's own sentence", () => {
    expect(ledInMessage("X: ", " \n\u0000\u202e\n")).toBe("");
  });

  test("keeps the last 20 lines and the last 2000 characters, cutting from the front", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
    const out = ledInMessage("X: ", lines);
    expect(out.startsWith("X: line 11 / ")).toBe(true);
    expect(out.endsWith("line 30")).toBe(true);
    const long = ledInMessage("X: ", `${"a".repeat(3000)}\nend`);
    expect(long.length).toBe("X: ".length + 2000);
    expect(long.startsWith("X: a")).toBe(true);
    expect(long.endsWith(" / end")).toBe(true);
  });
});
