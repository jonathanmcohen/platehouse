// Pins the CI job that builds the gate image on GitHub, so the next image
// build failure is found there and not on Hades (run 2, 2026-11-08, failed at
// the fetch stage's first Node call). Read as text: the repo has no YAML
// parser and needs no install step. actionlint checks the syntax.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WORKFLOW = join(ROOT, ".github", "workflows", "ci.yml");
const text = () => readFileSync(WORKFLOW, "utf8");

test("the workflow runs on pull requests and pushes that touch the gate or the workflow", () => {
  const t = text();
  for (const event of ["pull_request", "push"]) {
    const block = t.slice(t.indexOf(`  ${event}:`)).split(/\n {2}\S/)[0];
    assert.ok(t.includes(`  ${event}:`), `on ${event}`);
    assert.match(block, /- "tools\/slicing-gate\/\*\*"/, `${event} paths include the gate`);
    assert.match(block, /- "\.github\/workflows\/ci\.yml"/, `${event} paths include the workflow`);
  }
});

test("the workflow reads the repo only, holds no secrets and pushes nothing", () => {
  const t = text();
  assert.match(t, /^permissions:\n {2}contents: read\n(?! {2}\S)/m, "top-level permissions are contents: read alone");
  assert.doesNotMatch(t, /secrets\./, "no secrets");
  assert.doesNotMatch(t, /docker (push|login)|--push\b|registry/i, "no push, no login, no registry");
  assert.match(t, /persist-credentials: false/, "checkout keeps no token on disk");
});

test("every job runs on ubuntu-24.04 with a timeout", () => {
  const t = text();
  const jobs = t.slice(t.indexOf("\njobs:\n"));
  const runsOn = [...jobs.matchAll(/runs-on: (.+)/g)].map((m) => m[1].trim());
  const timeouts = [...jobs.matchAll(/timeout-minutes: (\d+)/g)].map((m) => Number(m[1]));
  assert.ok(runsOn.length >= 1);
  for (const r of runsOn) assert.equal(r, "ubuntu-24.04");
  assert.equal(timeouts.length, runsOn.length, "one timeout per job");
  for (const m of timeouts) assert.ok(m > 0 && m <= 90, `timeout ${m}`);
});

// Engineering Lessons: actions pin to an exact release tag (Jon, 2026-09-05,
// locked), never a floating major such as @v7.
test("every action is pinned to an exact release tag", () => {
  const uses = [...text().matchAll(/uses: (\S+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 2, uses.join("\n"));
  for (const u of uses) assert.match(u, /^[\w.-]+\/[\w.-]+@v\d+\.\d+\.\d+$/, `not an exact release tag: ${u}`);
});

test("the job runs the gate tests on Node 26, then builds the image, then smoke-checks it", () => {
  const t = text();
  assert.match(t, /node-version: "26\.\d+\.\d+"/);
  // Reporter options may sit between node --test and the glob, across lines.
  const tests = t.search(/node --test (\\\s+|--\S+\s+)*'tools\/slicing-gate\/test\/\*\*\/\*\.test\.mjs'/);
  const build = t.search(/docker build --platform linux\/amd64 -t \S+ tools\/slicing-gate/);
  const smoke = t.indexOf("/opt/orca/AppRun --help");
  assert.ok(tests !== -1 && build !== -1 && smoke !== -1, "tests, build and smoke steps are present");
  assert.ok(tests < build && build < smoke, "in that order");
  for (const check of [
    "check-profile-version.mjs /opt/orca/resources/profiles/BBL.opc /opt/orca-profiles/BBL.json",
    "check-profile-version.mjs /opt/orca/resources/profiles/OrcaFilamentLibrary.opc /opt/orca-profiles/OrcaFilamentLibrary.json",
    "node --version",
    "/opt/openscad/AppRun --version",
    "landrun --version",
  ]) {
    assert.ok(t.includes(check), `smoke check: ${check}`);
  }
});

// The smoke containers run as the gate runs them on Hades, so a check that
// passes here does not lean on a network or a writable root.
test("the smoke checks run network-less on a read-only root", () => {
  const t = text();
  assert.match(t, /--network none/);
  assert.match(t, /--read-only/);
  assert.match(t, /--tmpfs \/work/);
});

// The run: block of one named step, with its YAML indentation removed.
function stepScript(t, stepName) {
  const at = t.indexOf(`- name: ${stepName}\n`);
  assert.ok(at !== -1, `a step named ${stepName}`);
  const rest = t.slice(at).split("\n");
  const runAt = rest.findIndex((l) => /^\s+run: \|$/.test(l));
  assert.ok(runAt !== -1, `${stepName} has a run: | block`);
  const body = [];
  let indent = null;
  for (const line of rest.slice(runAt + 1)) {
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    const lead = line.match(/^ */)[0].length;
    if (indent === null) indent = lead;
    if (lead < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

// Each shell function the script defines at its top level, by name.
function shellFunctions(script) {
  const out = {};
  for (const m of script.matchAll(/^([a-z_]+)\(\) \{\n[\s\S]*?\n\}$/gm)) out[m[1]] = m[0];
  return out;
}

// Issue #9: smoke() printed its output through head -n 8 under pipefail, so a
// check with more output than a pipe holds died of SIGPIPE (exit 141) after
// it had passed. GitHub runs a bash step as bash -e -o pipefail.
test("a smoke check with a lot of output still passes (issue #9)", () => {
  const fns = shellFunctions(stepScript(text(), "Smoke-check the image"));
  assert.ok(fns.smoke, "smoke() is defined in the smoke step");
  const script = [
    "set -eo pipefail",
    'IMAGE=platehouse-gate:ci',
    "docker() { seq 1 200000; }",
    ...Object.values(fns),
    'smoke "lots of output" /opt/orca/AppRun --help',
    "echo SURVIVED",
  ].join("\n");
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr.slice(-500)}`);
  assert.match(r.stdout, /== lots of output: ok\n1\n2\n3\n4\n5\n6\n7\n8\nSURVIVED\n$/);
});

test("a failing smoke check still prints its output and fails the step", () => {
  const fns = shellFunctions(stepScript(text(), "Smoke-check the image"));
  const script = [
    "set -eo pipefail",
    "IMAGE=platehouse-gate:ci",
    "docker() { echo 'the reason it failed'; return 3; }",
    ...Object.values(fns),
    'smoke "broken" /opt/orca/AppRun --help',
    "echo NOT-REACHED",
  ].join("\n");
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout, /the reason it failed/);
  assert.match(r.stdout, /::error::smoke check failed: broken/);
  assert.doesNotMatch(r.stdout, /NOT-REACHED/);
});

// Issue #8: with no branch filter, a push to a PR branch ran the job once for
// the push and once for the pull request. Pushes run it only on the branches
// that take merges; a PR runs it for its own branch.
test("pushes run the workflow only on main and release branches (issue #8)", () => {
  const t = text();
  const push = t.slice(t.indexOf("  push:")).split(/\n {2}\S|\npermissions:/)[0];
  const branches = push.match(/ {4}branches:\n((?: {6}- .+\n)+)/);
  assert.ok(branches, `push has a branches filter:\n${push}`);
  const list = branches[1].trim().split("\n").map((l) => l.replace(/^\s*- /, "").replace(/"/g, ""));
  assert.deepEqual(list, ["main", "release/**"]);
  const pr = t.slice(t.indexOf("  pull_request:")).split(/\n {2}\S/)[0];
  assert.doesNotMatch(pr, /branches:/, "pull requests into any branch still run it");
});

// Run 3's two gate bugs, proved in CI before the next Hades run: a crafted cube
// saved for one printer and sliced on the others (Orca code -3), with a control
// run that hides the new process_full folder and must fail the way run 3 did;
// and the landrun checks of report item (g).
test("the smoke step slices the crafted cube across printers, with and without process_full, and compares", () => {
  const s = stepScript(text(), "Smoke-check the image");
  assert.match(s, /node \/src\/smoke-gate\.mjs switch --out \/results\/fixed\.json/);
  assert.match(
    s,
    /--tmpfs \/opt\/orca\/resources\/profiles\/BBL\/process_full\S*[\s\S]*?node \/src\/smoke-gate\.mjs switch --control --out \/results\/control\.json/,
  );
  assert.match(s, /node tools\/slicing-gate\/smoke-gate\.mjs compare "\$results\/fixed\.json" "\$results\/control\.json"/);
  // The fixed run must not hide the folder.
  const fixedLine = s.split("\n").find((l) => l.includes("switch --out /results/fixed.json"));
  assert.doesNotMatch(fixedLine, /process_full/);
});

test("the smoke step runs the gate's checks step and judges landrun's item (g)", () => {
  const s = stepScript(text(), "Smoke-check the image");
  assert.match(s, /node \/src\/smoke-gate\.mjs checks\b/);
});

test("every smoke container keeps the gate's hardening", () => {
  // Line continuations joined, so each docker run is one line.
  const s = stepScript(text(), "Smoke-check the image").replace(/\\\n\s*/g, " ");
  const docker = s.match(/docker run[^\n]*/g) ?? [];
  assert.ok(docker.length >= 1);
  for (const d of docker) {
    for (const flag of ["--rm", "--network none", "--read-only", "--cap-drop ALL", "--security-opt no-new-privileges:true", "--tmpfs /work:"]) {
      assert.ok(d.includes(flag), `${flag} in: ${d}`);
    }
  }
  // Every container the step starts goes through that one helper.
  assert.equal((s.match(/docker run/g) ?? []).length, docker.length);
});
