// Pins ci.yml: the CI job that builds the gate image on GitHub, so the next
// image build failure is found there and not on Hades (run 2, 2026-11-08,
// failed at the fetch stage's first Node call), the changes job that decides
// when that job runs, and the workspace jobs with their zero-test guard (build
// plan Task 3). Read as text: the gate has no YAML parser and needs no install
// step. Shell steps are run in bash with their tools stubbed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WORKFLOW = join(ROOT, ".github", "workflows", "ci.yml");
const text = () => readFileSync(WORKFLOW, "utf8");

// The on: block, from "on:" up to the next top-level key.
const onBlock = (t) => t.slice(t.indexOf("\non:\n")).split(/\n(?=[a-z])/)[1];

// Issue #16: both triggers carried a paths filter for the gate and this file,
// so no CI ran on a product PR. The triggers now carry no paths filter; the
// gate job's own scoping lives in the changes job (tested below).
test("the workflow runs on every pull request and push, with no paths filter (issue #16)", () => {
  const t = text();
  const on = onBlock(t);
  assert.match(on, /^ {2}pull_request:/m, "on pull_request");
  assert.match(on, /^ {2}push:/m, "on push");
  assert.doesNotMatch(on, /paths(-ignore)?:/, `no paths filter on the triggers:\n${on}`);
});

test("the workflow reads the repo only, holds no secrets and pushes nothing", () => {
  const t = text();
  assert.match(t, /^permissions:\n {2}contents: read\n(?! {2}\S)/m, "top-level permissions are contents: read alone");
  assert.doesNotMatch(t, /secrets\./, "no secrets");
  assert.doesNotMatch(t, /docker (push|login)|--push\b|registry/i, "no push, no login, no registry");
  assert.match(t, /persist-credentials: false/, "checkout keeps no token on disk");
});

// The one exception is the app image job (build plan Task 24, approved by Jon
// 2026-11-13): it builds and runs the image for amd64 and arm64 natively, so
// its runs-on is its matrix's runner, and that matrix lists exactly
// ubuntu-24.04 and ubuntu-24.04-arm.
test("every job runs on ubuntu-24.04 with a timeout, the app image's arm64 leg on ubuntu-24.04-arm", () => {
  const t = text();
  const jobs = t.slice(t.indexOf("\njobs:\n"));
  const runsOn = [...jobs.matchAll(/runs-on: (.+)/g)].map((m) => m[1].trim());
  const timeouts = [...jobs.matchAll(/timeout-minutes: (\d+)/g)].map((m) => Number(m[1]));
  assert.ok(runsOn.length >= 1);
  const fromMatrix = "${{ matrix.runner }}";
  for (const r of runsOn) if (r !== fromMatrix) assert.equal(r, "ubuntu-24.04");
  assert.equal(runsOn.filter((r) => r === fromMatrix).length, 1, "one job takes its runner from a matrix");
  const app = jobBlock(t, "app-image");
  assert.ok(app.includes(`\n    runs-on: ${fromMatrix}\n`), "that job is the app image job");
  const runners = [...app.matchAll(/\n {12}runner: (.+)/g)].map((m) => m[1].trim());
  assert.deepEqual(runners, ["ubuntu-24.04", "ubuntu-24.04-arm"]);
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

// Jon, 2026-11-08 (build plan Task 3): every job takes its Node version from
// .node-version, the one the workspace pins, instead of a hardcoded one.
test("every setup-node step reads .node-version, which pins Node 26", () => {
  const t = text();
  const setups = t.split(/\n(?= {6}- )/).filter((s) => /uses: actions\/setup-node@/.test(s));
  assert.ok(setups.length >= 2, `setup-node steps: ${setups.length}`);
  for (const s of setups) assert.match(s, /node-version-file: \.node-version\n/, s);
  assert.doesNotMatch(t, /node-version: /, "no hardcoded node-version");
  assert.match(readFileSync(join(ROOT, ".node-version"), "utf8"), /^26\.\d+\.\d+\n?$/);
});

test("the job runs the gate tests, then builds the image, then smoke-checks it", () => {
  const t = text();
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

// One job's block under jobs:, by its id.
function jobBlock(t, id) {
  const jobs = t.slice(t.indexOf("\njobs:\n"));
  const at = jobs.indexOf(`\n  ${id}:\n`);
  assert.ok(at !== -1, `a job named ${id}`);
  return jobs.slice(at + 1).split(/\n(?= {2}[\w-]+:\n)/)[0];
}

// Build plan Task 3: lint, typecheck, unit and integration in a chain, and
// every job after the first carries its own !cancelled() condition, because a
// skip propagates down a needs chain (Engineering Lessons).
test("lint, typecheck, unit and integration run in a chain, each gated on the one before", () => {
  const t = text();
  assert.doesNotMatch(jobBlock(t, "lint"), /needs:/, "lint is the first job");
  assert.match(jobBlock(t, "lint"), /run: pnpm exec biome ci \.\n/);
  assert.match(jobBlock(t, "typecheck"), /run: pnpm exec tsc -b\n/);
  for (const [job, dep] of [
    ["typecheck", "lint"],
    ["unit", "typecheck"],
    ["integration", "unit"],
  ]) {
    const b = jobBlock(t, job);
    assert.match(b, new RegExp(`\\n {4}needs: ${dep}\\n`), `${job} needs ${dep}`);
    assert.ok(
      b.includes(`if: \${{ !cancelled() && needs.${dep}.result == 'success' }}`),
      `${job} runs only after ${dep} succeeded`,
    );
  }
  for (const job of ["lint", "typecheck", "unit", "integration"]) {
    const b = jobBlock(t, job);
    assert.match(b, /uses: pnpm\/action-setup@/, `${job} sets up pnpm`);
    assert.match(b, /run: pnpm install --frozen-lockfile\n/, `${job} installs from the lockfile`);
  }
  assert.match(jobBlock(t, "unit"), /vitest run --project unit --reporter=default --reporter=json --outputFile=report\.json/);
  assert.match(
    jobBlock(t, "integration"),
    /vitest run --project integration --reporter=default --reporter=json --outputFile=report\.json/,
  );
});

// The gate job builds a large image, so it runs only when the changes job finds
// the gate, this workflow or .node-version among the changed files.
test("the gate job runs only when the changes job says so", () => {
  const t = text();
  const gate = jobBlock(t, "gate-image");
  assert.match(gate, /\n {4}needs: changes\n/);
  assert.ok(
    gate.includes(
      "if: ${{ !cancelled() && needs.changes.result == 'success' && needs.changes.outputs.gate == 'true' }}",
    ),
    gate,
  );
  assert.match(jobBlock(t, "changes"), /gate: \$\{\{ steps\.diff\.outputs\.gate \}\}/);
  assert.match(jobBlock(t, "changes"), /fetch-depth: 0/);
  // No job depends on the gate job, so its skip reaches nothing else.
  assert.doesNotMatch(t, /needs: \[?[^\n]*gate-image/);
});

// Runs the changes job's script in bash with git stubbed, and returns the gate
// output it wrote. The git diff stub behaves as real git does with renames
// detected (diff.renames defaults to true): each moved [from, to] pair prints
// only its new path, unless the job passes --no-renames, which prints both.
function decideGate({ event, prBase = "", before = "", baseExists = true, changed = [], moved = [] }) {
  const dir = mkdtempSync(join(tmpdir(), "ci-changes-"));
  try {
    const out = join(dir, "github-output");
    writeFileSync(out, "");
    const script = [
      "set -eo pipefail",
      [
        "git() {",
        '  case "$1" in',
        '    cat-file) [ "$BASE_EXISTS" = 1 ];;',
        '    diff)',
        '      printf "%s" "$CHANGED"',
        '      case " $* " in *" --no-renames "*) printf "%s" "$MOVED_FROM";; esac',
        '      printf "%s" "$MOVED_TO";;',
        "    *) return 99;;",
        "  esac",
        "}",
      ].join("\n"),
      stepScript(text(), "Decide whether the gate job runs"),
    ].join("\n");
    const r = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        EVENT: event,
        PR_BASE: prBase,
        PUSH_BEFORE: before,
        BASE_EXISTS: baseExists ? "1" : "0",
        CHANGED: changed.map((f) => `${f}\n`).join(""),
        MOVED_FROM: moved.map(([from]) => `${from}\n`).join(""),
        MOVED_TO: moved.map(([, to]) => `${to}\n`).join(""),
        GITHUB_OUTPUT: out,
      },
    });
    assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    const m = readFileSync(out, "utf8").match(/^gate=(true|false)$/m);
    assert.ok(m, `gate output written: ${readFileSync(out, "utf8")}`);
    return m[1];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SHA = "3b2a20f0000000000000000000000000000000aa";

for (const [name, input, want] of [
  ["a PR touching only the server skips it", { event: "pull_request", prBase: SHA, changed: ["apps/server/src/config.ts"] }, "false"],
  ["a PR touching the gate runs it", { event: "pull_request", prBase: SHA, changed: ["apps/server/a.ts", "tools/slicing-gate/Dockerfile"] }, "true"],
  ["a PR touching this workflow runs it", { event: "pull_request", prBase: SHA, changed: [".github/workflows/ci.yml"] }, "true"],
  // The gate job takes its Node version from .node-version, so a bump to it
  // alone must run the gate tests and the image build on the new Node.
  ["a PR touching only .node-version runs it", { event: "pull_request", prBase: SHA, changed: [".node-version"] }, "true"],
  ["a push touching only .node-version runs it", { event: "push", before: SHA, changed: [".node-version"] }, "true"],
  ["a PR with no changed files skips it", { event: "pull_request", prBase: SHA, changed: [] }, "false"],
  [
    "look-alike paths skip it",
    {
      event: "pull_request",
      prBase: SHA,
      changed: [
        "tools/slicing-gate-old/x",
        "docs/tools/slicing-gate/x",
        ".github/workflows/ci.yml.orig",
        ".github/workflows/release.yml",
        "apps/server/.node-version",
        ".node-version.bak",
      ],
    },
    "false",
  ],
  ["a push touching only the README skips it", { event: "push", before: SHA, changed: ["README.md"] }, "false"],
  ["a push touching the gate runs it", { event: "push", before: SHA, changed: ["tools/slicing-gate/README.md"] }, "true"],
  // PR #17 review: git diff --name-only lists only the new path of a rename, so
  // a module moved out of the gate (say into packages/threemf/ in Task 6) left
  // no gate path in the list and the gate job was skipped. The job passes
  // --no-renames so a move lists its old path too.
  [
    "a PR moving a file out of the gate runs it",
    { event: "pull_request", prBase: SHA, moved: [["tools/slicing-gate/lib/zip.mjs", "packages/threemf/src/zip.mjs"]] },
    "true",
  ],
  [
    "a push moving a file out of the gate runs it",
    { event: "push", before: SHA, moved: [["tools/slicing-gate/lib/threemf.mjs", "packages/threemf/src/threemf.mjs"]] },
    "true",
  ],
  [
    "a PR moving a file into the gate runs it",
    { event: "pull_request", prBase: SHA, moved: [["packages/threemf/src/zip.mjs", "tools/slicing-gate/lib/zip.mjs"]] },
    "true",
  ],
  [
    "a PR moving a file between two non-gate paths skips it",
    { event: "pull_request", prBase: SHA, moved: [["apps/server/src/a.ts", "apps/server/src/b.ts"]] },
    "false",
  ],
  ["a new branch (all-zero before) runs it", { event: "push", before: "0".repeat(40), changed: [] }, "true"],
  ["a push with no before runs it", { event: "push", before: "", changed: [] }, "true"],
  ["a base commit that is gone (force-push) runs it", { event: "push", before: SHA, baseExists: false, changed: [] }, "true"],
  ["a PR with no base runs it", { event: "pull_request", prBase: "", changed: [] }, "true"],
]) {
  test(`gate job decision: ${name}`, () => {
    assert.equal(decideGate(input), want);
  });
}

// Runs one test job's step in bash with pnpm stubbed: the stub writes the given
// vitest JSON report (or none) and exits with the given status.
function runGuard(stepName, { report, status = 0 }) {
  const dir = mkdtempSync(join(tmpdir(), "ci-guard-"));
  try {
    const script = [
      "set -eo pipefail",
      'pnpm() { if [ -n "$REPORT" ]; then printf "%s" "$REPORT" > report.json; fi; return "$VITEST_STATUS"; }',
      stepScript(text(), stepName),
    ].join("\n");
    return spawnSync("bash", ["-c", script], {
      cwd: dir,
      encoding: "utf8",
      env: { PATH: process.env.PATH, REPORT: report ? JSON.stringify(report) : "", VITEST_STATUS: String(status) },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const vitestReport = (total, passed, failed, pending, todo = 0) => ({
  numTotalTests: total,
  numPassedTests: passed,
  numFailedTests: failed,
  numPendingTests: pending,
  numTodoTests: todo,
});

// AC-094: CI fails when zero tests ran. Measured with Vitest 5.1.0 on
// 2026-11-08: vitest run -t no-such-test skips all 65 tests, exits 0, and
// still reports numTotalTests 65, so a guard on numTotalTests alone passes.
for (const [stepName, label] of [
  ["Unit tests", "unit"],
  ["Integration tests", "integration"],
]) {
  test(`${label} guard: every test skipped by a filter fails with No tests ran`, () => {
    const r = runGuard(stepName, { report: vitestReport(65, 0, 0, 65) });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, new RegExp(`${label}: 0 tests ran, 65 skipped, 65 collected`));
    assert.match(r.stdout, /::error::No tests ran\n/);
  });

  test(`${label} guard: todo-only tests fail with No tests ran`, () => {
    const r = runGuard(stepName, { report: vitestReport(2, 0, 0, 0, 2) });
    assert.notEqual(r.status, 0);
    assert.match(r.stdout, /::error::No tests ran\n/);
  });

  test(`${label} guard: vitest passing with no report fails with No tests ran`, () => {
    const r = runGuard(stepName, { report: null, status: 0 });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /::error::No tests ran \(vitest wrote no report\)\n/);
  });

  // Issue #20: when vitest itself fails, the step reports that failure, with
  // vitest's own exit code, and never "No tests ran". A suite whose beforeAll
  // throws has every test marked skipped, so it fails with zero tests run.
  // Exit 7 tells vitest's code apart from the guard's own exit 1.
  test(`${label} guard: vitest failing with zero tests run exits with vitest's code, not No tests ran (issue #20)`, () => {
    const r = runGuard(stepName, { report: vitestReport(2, 0, 0, 2), status: 7 });
    assert.equal(r.status, 7, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`${label}: 0 tests ran, 2 skipped, 2 collected`));
    assert.match(r.stdout, /::error::Vitest failed \(exit 7\)/);
    assert.doesNotMatch(r.stdout, /No tests ran/);
  });

  test(`${label} guard: vitest failing with no report exits with vitest's code, not No tests ran (issue #20)`, () => {
    const r = runGuard(stepName, { report: null, status: 7 });
    assert.equal(r.status, 7, r.stdout + r.stderr);
    assert.match(r.stdout, /::error::Vitest failed \(exit 7\)/);
    assert.doesNotMatch(r.stdout, /No tests ran/);
  });

  test(`${label} guard: tests that ran and passed pass, with the count logged`, () => {
    const r = runGuard(stepName, { report: vitestReport(5, 3, 0, 2) });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`${label}: 3 tests ran, 2 skipped, 5 collected`));
    assert.doesNotMatch(r.stdout, /::error::/);
  });

  test(`${label} guard: a failing test still fails the step, with the count logged`, () => {
    const r = runGuard(stepName, { report: vitestReport(3, 2, 1, 0), status: 1 });
    assert.equal(r.status, 1);
    assert.match(r.stdout, new RegExp(`${label}: 3 tests ran, 0 skipped, 3 collected`));
    assert.match(r.stdout, /::error::Vitest failed \(exit 1\)/);
    assert.doesNotMatch(r.stdout, /No tests ran/);
  });
}
