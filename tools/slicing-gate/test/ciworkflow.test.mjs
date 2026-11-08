// Pins the CI job that builds the gate image on GitHub, so the next image
// build failure is found there and not on Hades (run 2, 2026-11-08, failed at
// the fetch stage's first Node call). Read as text: the repo has no YAML
// parser and needs no install step. actionlint checks the syntax.
import assert from "node:assert/strict";
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
  const tests = t.indexOf("node --test 'tools/slicing-gate/test/**/*.test.mjs'");
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
