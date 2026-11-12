// OpenSCAD's sandbox (AC-052): landrun v0.1.17 around every render. The
// slicing gate proved two things on Hades (run 4, 2026-11-08):
// - paths a binary runs from need --rox; the plan's form with --ro on the
//   OpenSCAD tree does not run (exit 1);
// - landrun's flags must end with "--", or it reads OpenSCAD's own -o as a
//   landrun flag (run 3: "flag provided but not defined: -o").
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  LANDRUN_STRICT_ABI,
  landrunArgs,
  MAX_RENDER_OUTPUT_BYTES,
  MIN_LANDLOCK_ABI,
  orphansOfInit,
  prlimitArgs,
  readLandlockAbi,
  reapOrphans,
  runsUnderTini,
  scadArgs,
} from "../src/sandbox.js";

// Issue #153 item 3: a program that calls setsid() leaves its job's process
// group, so the kill at the time cap misses it, and it is re-parented to
// tini (PID 1). After each job the server kills every process whose parent
// is PID 1 other than itself. A process docker exec starts, the health
// check included, has parent 0 and is left alone.
describe("orphans re-parented to PID 1", () => {
  /** A fake /proc holding one stat file per [pid, comm, ppid]. */
  function proc(
    entries: Array<[number, string, number]>,
    extra: Record<string, string> = {},
  ): string {
    const dir = mkdtempSync(join(tmpdir(), "slicer-proc-"));
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
    [43, "orca-slicer", 7], // a job's own program, still the server's child
    [50, "node", 0], // the health check, started by docker exec
    [51, "a) S 1 (b", 7], // a name built to look like parent 1
  ];

  test("lists every process whose parent is PID 1, except the server itself", () => {
    expect(orphansOfInit(proc(TREE), 7)).toEqual([42]);
  });

  test("reads the parent after the last ) of the name, so a crafted name cannot fake it", () => {
    expect(orphansOfInit(proc(TREE), 7)).not.toContain(51);
  });

  test("skips a stat it cannot read or parse, and names that are not process ids", () => {
    const dir = proc(TREE, { "60": "garbage", self: "7 (node) S 1 7 7\n" });
    expect(orphansOfInit(dir, 7)).toEqual([42]);
  });

  test("reapOrphans sends SIGKILL to each and returns their ids; a kill that fails is skipped", () => {
    const dir = proc([...TREE, [44, "sleep", 1]]);
    const killed: Array<[number, string]> = [];
    const out = reapOrphans({
      procDir: dir,
      selfPid: 7,
      kill: (pid, signal) => {
        if (pid === 44) throw Object.assign(new Error("gone"), { code: "ESRCH" });
        killed.push([pid, signal]);
      },
    });
    expect(killed).toEqual([[42, "SIGKILL"]]);
    expect(out).toEqual([42]);
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
  const args = landrunArgs({ dir: DIR, openscadDir: "/opt/openscad", command });

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
  // this form on Hades. The server's sandbox self-test (server.test.ts)
  // refuses every render when the kernel's Landlock ABI is below 6 or the
  // sandbox does not actually block a read outside the job folder.
  test("landrun runs best effort, as the gate proved it", () => {
    expect(split(args).flags).toContain("--best-effort");
  });

  // landrun reports the kernel's Landlock ABI only when it is not best
  // effort, so the self-test's ABI check runs it strict, with the same rules.
  test("the strict form drops --best-effort and nothing else", () => {
    const strict = landrunArgs({ dir: DIR, openscadDir: "/opt/openscad", command, strict: true });
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
    expect(prlimitArgs(120)).toContain("--cpu=540");
    expect(prlimitArgs(30)).toContain("--cpu=180");
  });

  test("address space is the container's 4 GiB, processes are capped at 512, files at 256 MiB and core files at 0", () => {
    expect(prlimitArgs(120)).toEqual([
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
    expect(prlimitArgs(120)).toContain("--core=0");
    expect(prlimitArgs(30)).toContain("--core=0");
  });

  // The file-size limit stops OpenSCAD while it writes past the render output
  // cap (the kernel sends SIGXFSZ), instead of only refusing the file after.
  test("the file-size limit is the render output cap, so a file the cap lets through is never stopped", () => {
    expect(MAX_RENDER_OUTPUT_BYTES).toBe(256 * 1024 * 1024);
    expect(prlimitArgs(120)).toContain(`--fsize=${MAX_RENDER_OUTPUT_BYTES}`);
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

  test("the minimum is ABI 6 (Jon, 2026-11-11) and landrun asks for 9", () => {
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
