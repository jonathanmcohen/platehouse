// OpenSCAD's sandbox (AC-052): landrun v0.1.17 around every render. The
// slicing gate proved two things on Hades (run 4, 2026-11-08):
// - paths a binary runs from need --rox; the plan's form with --ro on the
//   OpenSCAD tree does not run (exit 1);
// - landrun's flags must end with "--", or it reads OpenSCAD's own -o as a
//   landrun flag (run 3: "flag provided but not defined: -o").
import { describe, expect, test } from "vitest";
import { landrunArgs, scadArgs } from "../src/sandbox.js";

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
    for (const p of ["/opt/openscad", "/usr/lib", "/lib", "/usr/bin", "/bin"]) {
      expect(rox).toContain(p);
    }
    expect(values(flags, "--ro")).not.toContain("/opt/openscad");
  });

  test("fonts are read-only and the job folder is the only writable path", () => {
    const { flags } = split(args);
    expect(values(flags, "--ro")).toEqual(
      expect.arrayContaining(["/usr/share/fonts", "/etc/fonts"]),
    );
    expect(values(flags, "--rw")).toEqual([DIR]);
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
  // 42530006914, "Got Landlock ABI v8, wanted Landlock V9"). The filesystem
  // rules work from ABI 1, and the gate proved this form on Hades. The
  // server's sandbox self-test (server.test.ts) refuses every render if the
  // sandbox does not actually block a read outside the job folder.
  test("landrun runs best effort, as the gate proved it", () => {
    expect(split(args).flags).toContain("--best-effort");
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
