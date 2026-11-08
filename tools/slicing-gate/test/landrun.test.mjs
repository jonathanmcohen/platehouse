// Hades run 3 (2026-11-08), report item (g): all three landrun calls failed
// with "flag provided but not defined: -o". landrun v0.1.17 parses its
// arguments with urfave/cli v3.6.2, whose command_parse.go keeps reading flags
// after the first positional argument and stops only at "--". So OpenSCAD's
// own -o, after the command, was read as a landrun flag. landrun's README
// (v0.1.17) writes every example as: landrun [flags] -- <command> [args].
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as gate from "../gate.mjs";

const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");

// landrun v0.1.17's flags (cmd/landrun/main.go), plus urfave/cli's own help
// and version flags. Value flags take the next argument.
const VALUE_FLAGS = new Set(["log-level", "ro", "rox", "rw", "rwx", "unix", "bind-tcp", "connect-tcp", "env"]);
const BOOL_FLAGS = new Set([
  "best-effort",
  "unrestricted-filesystem",
  "unrestricted-network",
  "unrestricted-scoped",
  "ignore-missing",
  "log-disable-originating",
  "log-enable-subprocesses",
  "log-disable-subdomains",
  "ldd",
  "add-exec",
  "help",
  "h",
  "version",
  "v",
]);

/**
 * The argument walk of urfave/cli v3.6.2 (command_parse.go parseFlags), cut
 * down to what landrun uses: "--" ends flag parsing; an argument that does not
 * start with "-" is positional and parsing goes on; anything else must be a
 * defined flag. Returns { command } or { error } with urfave's message.
 */
function parseLikeLandrun(args) {
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") return { command: [...positional, ...args.slice(i + 1)] };
    if (!a.startsWith("-") || a === "-") {
      positional.push(a);
      continue;
    }
    const name = a.replace(/^--?/, "").split("=")[0];
    if (VALUE_FLAGS.has(name)) {
      if (!a.includes("=")) i++;
      continue;
    }
    if (BOOL_FLAGS.has(name)) continue;
    return { error: `flag provided but not defined: -${name}` };
  }
  return { command: positional };
}

test("the parser model reproduces the run 3 failure on the old argument shape", () => {
  const old = ["--best-effort", "--rw", "/work/x", "/opt/openscad/AppRun", "-o", "inside.stl", "inside.scad"];
  assert.deepEqual(parseLikeLandrun(old), { error: "flag provided but not defined: -o" });
});

test("gate.mjs exports the landrun invocations the checks step runs", () => {
  assert.equal(typeof gate.landrunInvocations, "function");
});

test("every landrun call ends landrun's flags with -- and hands the whole command over", () => {
  const calls = gate.landrunInvocations("/work/scad-test");
  assert.deepEqual(
    calls.map((c) => c.name),
    ["inside", "escape", "planFormRo", "abi"],
  );
  for (const { name, args, command } of calls) {
    const sep = args.indexOf("--");
    assert.ok(sep > 0, `${name}: has -- after landrun's flags`);
    assert.deepEqual(args.slice(sep + 1), command, `${name}: everything after -- is the command`);
    const parsed = parseLikeLandrun(args);
    assert.equal(parsed.error, undefined, `${name}: ${parsed.error}`);
    assert.deepEqual(parsed.command, command, `${name}: landrun runs the command as given`);
  }
});

test("the OpenSCAD calls pass OpenSCAD's own -o through to OpenSCAD", () => {
  const byName = Object.fromEntries(gate.landrunInvocations("/work/scad-test").map((c) => [c.name, c]));
  assert.deepEqual(byName.inside.command, [gate.PATHS.openscad, "-o", "inside.stl", "inside.scad"]);
  assert.deepEqual(byName.escape.command, [gate.PATHS.openscad, "-o", "escape.stl", "escape.scad"]);
  assert.deepEqual(byName.planFormRo.command, [gate.PATHS.openscad, "-o", "planform.stl", "inside.scad"]);
  // The T11 form keeps --ro, not --rox, on the OpenSCAD tree: it is recorded
  // as evidence for T11, whatever it does.
  const sep = byName.planFormRo.args.indexOf("--");
  const flags = byName.planFormRo.args.slice(0, sep);
  assert.ok(flags.includes("--ro") && !flags.includes("--rox"), flags.join(" "));
});

test("the checks step runs landrun only through those invocations", () => {
  const source = readFileSync(join(HERE, "gate.mjs"), "utf8");
  assert.doesNotMatch(source, /run\(PATHS\.landrun, \[/, "no hand-built landrun argument list left in gate.mjs");
});
