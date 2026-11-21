// Issue #4: each command-line script must do its work when it is started
// through a symlinked path, such as macOS /tmp (a link to /private/tmp). Node
// resolves import.meta.url to the real path while process.argv[1] keeps the
// link, so a plain URL comparison skipped main() and exited 0 with no output.
// Each test copies the tool into a real directory, starts the script through a
// symlink to that directory, and checks the script's own output.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { build3mf, P1S_PROJECT, writeTmp } from "./support/fixtures.mjs";
import { profileTree } from "./support/profiles.mjs";

const TOOL = join(dirname(fileURLToPath(import.meta.url)), "..");
const made = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** A real copy of the tool's scripts and lib/, and a symlink pointing at it. */
function linkedTool() {
  const root = mkdtempSync(join(tmpdir(), "gate-link-"));
  made.push(root);
  const real = join(root, "real");
  mkdirSync(real);
  for (const f of ["select-sample.mjs", "gate.mjs", "flatten-profiles.mjs"]) cpSync(join(TOOL, f), join(real, f));
  cpSync(join(TOOL, "lib"), join(real, "lib"), { recursive: true });
  const link = join(root, "link");
  symlinkSync(real, link, "dir");
  return { root, link };
}

const node = (args, env = process.env) => spawnSync(process.execPath, args, { env, encoding: "utf8" });

function sampleFolder(root) {
  const sample = join(root, "in", "sample");
  mkdirSync(sample, { recursive: true });
  writeTmp("u.3mf", build3mf({ plates: [{ index: 1 }], project: { ...P1S_PROJECT, filament_type: ["PLA"] } }), sample);
  return sample;
}

test("select-sample.mjs started through a symlink scans the folder and writes the selection", () => {
  const { root, link } = linkedTool();
  const sample = sampleFolder(root);
  const json = join(root, "selection.json");
  const r = node([join(link, "select-sample.mjs"), sample, "--json", json]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Scanned 1 \.3mf files/);
  assert.equal(existsSync(json), true, "selection.json was written");
});

test("flatten-profiles.mjs started through a symlink writes the recipe", () => {
  const { root, link } = linkedTool();
  const out = join(root, "flat");
  const r = node([
    join(link, "flatten-profiles.mjs"),
    "--profiles",
    profileTree(),
    "--out",
    out,
    "--printer",
    "Bambu Lab P1S 0.4 nozzle",
    "--types",
    "PLA",
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^wrote 1 machine preset\(s\) and recipe\.json/);
  assert.equal(existsSync(join(out, "recipe.json")), true, "recipe.json was written");
});

test("gate.mjs started through a symlink runs the plan step", () => {
  const { root, link } = linkedTool();
  const sample = sampleFolder(root);
  const sel = node([join(TOOL, "select-sample.mjs"), sample, "--json", join(root, "in", "selection.json")]);
  assert.equal(sel.status, 0, sel.stderr);
  const out = join(root, "out");
  mkdirSync(out);
  const env = {
    ...process.env,
    GATE_IN: join(root, "in"),
    GATE_OUT: out,
    GATE_WORK: join(root, "work"),
    GATE_ORCA_PROFILES: profileTree(),
  };
  const r = node([join(link, "gate.mjs"), "plan"], env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^gate plan: 1 files, /);
  assert.ok(readFileSync(join(out, "jobs.txt"), "utf8").startsWith("j0001"), "jobs.txt lists the jobs");
});

test("gate.mjs started through a symlink with no command prints its usage and exits 2", () => {
  const { link } = linkedTool();
  const r = node([join(link, "gate.mjs")]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: gate\.mjs/);
});
