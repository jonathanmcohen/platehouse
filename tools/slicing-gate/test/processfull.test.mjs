// Hades run 3 (2026-11-08): 79 plates failed with Orca code -3 when a file was
// sliced on a printer other than its own. Orca's CLI (src/OrcaSlicer.cpp at
// v2.5.0, the machine_switch block) then loads the new printer's default
// process from <resources>/profiles/BBL/process_full/<default_print_profile>.json,
// with no flag to move it, and the 2.5.0 AppImage ships no such folder:
//   can not find setting file: /opt/orca/resources/profiles/BBL/process_full/0.20mm Standard @BBL A1.json
// The file must be a flattened preset: load_config_file only resolves an
// inherits chain through a vendor manifest (BBL.json) beside the vendor
// folder, which the AppImage does not ship, and the switch rejects any file
// whose type is not "process" or whose from is not "system".
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as flatten from "../flatten-profiles.mjs";
import { profileTree } from "./support/profiles.mjs";

const HERE = join(dirname(fileURLToPath(import.meta.url)), "..");
const freshDir = () => join(mkdtempSync(join(tmpdir(), "gate-pf-")), "process_full");

test("flatten-profiles exports writeProcessFull", () => {
  assert.equal(typeof flatten.writeProcessFull, "function");
});

test("every machine's default process is written flattened, named exactly as Orca builds the path", () => {
  const out = freshDir();
  const result = flatten.writeProcessFull(flatten.loadIndex(profileTree()), out);
  assert.deepEqual(readdirSync(out).sort(), ["0.20mm Standard @BBL A1.json", "0.20mm Standard @BBL X1C.json"]);
  assert.deepEqual(result.files, ["0.20mm Standard @BBL A1", "0.20mm Standard @BBL X1C"]);
  const x1c = JSON.parse(readFileSync(join(out, "0.20mm Standard @BBL X1C.json"), "utf8"));
  assert.equal(x1c.name, "0.20mm Standard @BBL X1C");
  // The two values Orca's machine switch checks before it uses the file.
  assert.equal(x1c.type, "process");
  assert.equal(x1c.from, "system");
  // No inherits, so load_config_file takes it as it is and asks no resolver.
  assert.equal("inherits" in x1c, false);
  // Keys from the parent are present, the child's own keys win.
  assert.equal(x1c.layer_height, "0.2");
  assert.equal(x1c.wall_loops, "2");
  assert.deepEqual(x1c.print_extruder_variant, ["Direct Drive Standard", "Direct Drive High Flow"]);
  const a1 = JSON.parse(readFileSync(join(out, "0.20mm Standard @BBL A1.json"), "utf8"));
  assert.deepEqual(a1.print_extruder_variant, ["Direct Drive Standard"]);
});

test("it never overwrites a file already in the folder", () => {
  const out = freshDir();
  const index = flatten.loadIndex(profileTree());
  flatten.writeProcessFull(index, out);
  assert.throws(() => flatten.writeProcessFull(index, out), /EEXIST|exists/);
});

test("a default process name that would leave the folder is refused and nothing is written", () => {
  const root = profileTree();
  writeFileSync(
    join(root, "BBL", "machine", "Odd 0.4 nozzle.json"),
    JSON.stringify({ type: "machine", name: "Odd 0.4 nozzle", from: "system", instantiation: "true", default_print_profile: "../escape" }),
  );
  const out = freshDir();
  assert.throws(() => flatten.writeProcessFull(flatten.loadIndex(root), out), /\.\.\/escape/);
  assert.equal(existsSync(join(dirname(out), "escape.json")), false);
  assert.equal(existsSync(out) ? readdirSync(out).length : 0, 0);
});

test("a default process the bundle does not have fails, naming it", () => {
  const root = profileTree();
  writeFileSync(
    join(root, "BBL", "machine", "Odd 0.4 nozzle.json"),
    JSON.stringify({ type: "machine", name: "Odd 0.4 nozzle", from: "system", instantiation: "true", default_print_profile: "No Such Process" }),
  );
  assert.throws(() => flatten.writeProcessFull(flatten.loadIndex(root), freshDir()), /No Such Process/);
});

test("the command line writes the folder with --process-full alone", () => {
  const out = freshDir();
  const r = spawnSync(process.execPath, [join(HERE, "flatten-profiles.mjs"), "--profiles", profileTree(), "--process-full", out], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /wrote 2 default process presets for 2 machine presets to .*; skipped 0 machine preset\(s\) that would not flatten/);
  assert.equal(readdirSync(out).length, 2);
});

// PR #11 review (processfull-silent-skip): a process whose parent is not in
// the bundle used to come back from flattenPreset without the parent's keys
// and be written anyway, so a cross-printer slice would quietly fall back to
// Orca's built-in defaults for the missing keys.
test("a default process whose parent is not in the bundle fails, naming both, and nothing is written", () => {
  const root = profileTree();
  writeFileSync(
    join(root, "BBL", "process", "0.20mm Orphan @BBL Odd.json"),
    JSON.stringify({ type: "process", name: "0.20mm Orphan @BBL Odd", from: "system", inherits: "fdm_process_gone", layer_height: "0.2" }),
  );
  writeFileSync(
    join(root, "BBL", "machine", "Odd 0.4 nozzle.json"),
    JSON.stringify({ type: "machine", name: "Odd 0.4 nozzle", from: "system", instantiation: "true", default_print_profile: "0.20mm Orphan @BBL Odd" }),
  );
  const out = freshDir();
  assert.throws(() => flatten.writeProcessFull(flatten.loadIndex(root), out), /0\.20mm Orphan @BBL Odd.*fdm_process_gone/);
  assert.equal(existsSync(out) ? readdirSync(out).length : 0, 0);
});

// A machine that will not flatten used to be dropped by a bare catch, so its
// default process was never written and nothing said so.
test("a machine preset that will not flatten is listed with its reason, not dropped silently", () => {
  const root = profileTree();
  writeFileSync(
    join(root, "BBL", "machine", "Loop 0.4 nozzle.json"),
    JSON.stringify({ type: "machine", name: "Loop 0.4 nozzle", from: "system", inherits: "Loop 0.4 nozzle", instantiation: "true" }),
  );
  const out = freshDir();
  const result = flatten.writeProcessFull(flatten.loadIndex(root), out);
  assert.deepEqual(result.files, ["0.20mm Standard @BBL A1", "0.20mm Standard @BBL X1C"]);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].name, "Loop 0.4 nozzle");
  assert.match(result.skipped[0].reason, /inheritance depth/);
});

test("templates and _common machine presets are excluded without being counted as skipped", () => {
  const result = flatten.writeProcessFull(flatten.loadIndex(profileTree()), freshDir());
  assert.deepEqual(result.skipped, []);
});

test("the command line prints the skipped count beside the written count, and each skipped machine", () => {
  const root = profileTree();
  writeFileSync(
    join(root, "BBL", "machine", "Loop 0.4 nozzle.json"),
    JSON.stringify({ type: "machine", name: "Loop 0.4 nozzle", from: "system", inherits: "Loop 0.4 nozzle", instantiation: "true" }),
  );
  const out = freshDir();
  const r = spawnSync(process.execPath, [join(HERE, "flatten-profiles.mjs"), "--profiles", root, "--process-full", out], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /wrote 2 default process presets for 2 machine presets to .*; skipped 1 machine preset\(s\) that would not flatten/);
  assert.match(r.stdout, /skipped machine "Loop 0\.4 nozzle": inheritance depth/);
});
