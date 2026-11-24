// Pins ci.yml: the CI job that builds the gate image on GitHub, so the next
// image build failure is found there and not on the test server (run 2, 2026-11-08,
// failed at the fetch stage's first Node call), the changes job that decides
// when that job runs, and the workspace jobs with their zero-test guard. Read as text: the gate has no YAML parser and needs no install
// step. Shell steps are run in bash with their tools stubbed. The tests at the
// end pin release.yml's pushed-image check and slicer-image.yml the same way.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
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

// The one exception is the app image job (approved by the maintainer
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

// Actions pin to a commit SHA with the exact release tag as a comment (issue
// #420; the maintainer locked exact tags on 2026-09-05), never a floating major
// such as @v7, so a moved tag cannot change a build. workflowpins.test.mjs holds
// every workflow to it; this holds ci.yml's tags to exact releases too.
test("every action is pinned to a commit SHA and an exact release tag", () => {
  const uses = [...text().matchAll(/uses: (\S+ # \S+)/g)].map((m) => m[1]);
  assert.ok(uses.length >= 2, uses.join("\n"));
  for (const u of uses) assert.match(u, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, `not a SHA pin with a release tag: ${u}`);
});

// The maintainer, 2026-11-08: every job takes its Node version from
// .node-version, the one the workspace pins, instead of a hardcoded one.
test("every setup-node step reads .node-version, which pins Node 26", () => {
  const t = text();
  const setups = t.split(/\n(?= {6}- )/).filter((s) => /uses: actions\/setup-node@/.test(s));
  assert.ok(setups.length >= 2, `setup-node steps: ${setups.length}`);
  for (const s of setups) assert.match(s, /node-version-file: \.node-version\n/, s);
  assert.doesNotMatch(t, /node-version: /, "no hardcoded node-version");
  assert.match(readFileSync(join(ROOT, ".node-version"), "utf8"), /^26\.\d+\.\d+\n?$/);
});

// Issue #222 split the gate job in two: gate-tests runs the gate tests, and
// gate-image, after it, builds the image and then smoke-checks it.
test("the gate tests job runs the tests, then the image job builds the image and smoke-checks it", () => {
  const t = text();
  // Reporter options may sit between node --test and the glob, across lines.
  const gateTests = /node --test (\\\s+|--\S+\s+)*'tools\/slicing-gate\/test\/\*\*\/\*\.test\.mjs'/;
  const gateBuild = /docker build --platform linux\/amd64 -t \S+ tools\/slicing-gate/;
  const tests = t.search(gateTests);
  const build = t.search(gateBuild);
  const smoke = t.indexOf("/opt/orca/AppRun --help");
  assert.ok(tests !== -1 && build !== -1 && smoke !== -1, "tests, build and smoke steps are present");
  assert.ok(tests < build && build < smoke, "in that order");
  assert.equal([...t.matchAll(/node --test/g)].length, 1, "the gate tests run once in the workflow");
  const testsJob = jobBlock(t, "gate-tests");
  const imageJob = jobBlock(t, "gate-image");
  assert.match(testsJob, gateTests, "the gate tests job runs the gate tests");
  assert.doesNotMatch(testsJob, /docker /, "the gate tests job builds and runs no image");
  assert.doesNotMatch(imageJob, /node --test/, "the image job does not run the tests again");
  const imageBuild = imageJob.search(gateBuild);
  const imageSmoke = imageJob.indexOf("/opt/orca/AppRun --help");
  assert.ok(imageBuild !== -1 && imageSmoke !== -1, "the image job builds and smoke-checks the image");
  assert.ok(imageBuild < imageSmoke, "it builds before it smoke-checks");
  for (const check of [
    "check-profile-version.mjs /opt/orca/resources/profiles/BBL.opc /opt/orca-profiles/BBL.json",
    "check-profile-version.mjs /opt/orca/resources/profiles/OrcaFilamentLibrary.opc /opt/orca-profiles/OrcaFilamentLibrary.json",
    "node --version",
    "/opt/openscad/AppRun --version",
    "landrun --version",
  ]) {
    assert.ok(imageJob.includes(check), `smoke check in the image job: ${check}`);
  }
});

// The smoke containers run as the gate runs them on the test server, so a check that
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

// Run 3's two gate bugs, proved in CI before the next gate run: a crafted cube
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

// Lint, typecheck, unit and integration in a chain, and
// every job after the first carries its own !cancelled() condition, because a
// skip propagates down a needs chain unless a job says otherwise.
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

// Issue #222: the gate tests run when the changes job finds the gate or any
// file they read among the changed files. The gate image is large, so its build
// runs only when the changes job finds the gate, this workflow or .node-version
// among them, and only after the gate tests passed.
test("the gate jobs run only when the changes job says so", () => {
  const t = text();
  const tests = jobBlock(t, "gate-tests");
  assert.match(tests, /\n {4}needs: changes\n/);
  assert.ok(
    tests.includes(
      "if: ${{ !cancelled() && needs.changes.result == 'success' && needs.changes.outputs.gate_tests == 'true' }}",
    ),
    tests,
  );
  const image = jobBlock(t, "gate-image");
  assert.match(image, /\n {4}needs: \[changes, gate-tests\]\n/);
  assert.ok(
    image.includes(
      "if: ${{ !cancelled() && needs.changes.result == 'success' && needs.changes.outputs.gate_image == 'true' && needs.gate-tests.result == 'success' }}",
    ),
    image,
  );
  assert.match(jobBlock(t, "changes"), /\n {6}gate_tests: \$\{\{ steps\.diff\.outputs\.tests \}\}\n/);
  assert.match(jobBlock(t, "changes"), /\n {6}gate_image: \$\{\{ steps\.diff\.outputs\.image \}\}\n/);
  assert.match(jobBlock(t, "changes"), /fetch-depth: 0/);
  // Only the image job depends on the tests job, and nothing depends on the
  // image job, so their skips reach nothing else.
  assert.deepEqual([...t.matchAll(/needs: \[?[^\n]*gate-tests/g)].map((m) => m[0]), ["needs: [changes, gate-tests"]);
  assert.doesNotMatch(t, /needs: \[?[^\n]*gate-image/);
});

// The release workflow's Trivy gate failed run 43661472697 (the v0.0.0-test
// tag) on a fixable zlib1g HIGH that no pull request had shown. The app image
// job now runs that same gate step on the image it builds, so a pull request
// fails on it before a tag does: the same action at the same tag, and the same
// inputs, read from release.yml, except image-ref, which is this job's image.
// It is the job's last step, so a Trivy failure never hides the image checks.
const RELEASE = join(ROOT, ".github", "workflows", "release.yml");
const TRIVY_GATE = "Trivy gate (fail on fixable OS HIGH/CRITICAL)";

// The step named name in a job (or workflow) block, from its "- name:" line up
// to the next step at the same indent.
function stepBlock(block, name) {
  const steps = block.split(/\n(?= {6}- )/).filter((s) => s.startsWith(`      - name: ${name}\n`));
  assert.equal(steps.length, 1, `one step named ${name}`);
  return steps[0];
}

// A step's uses: line and its with: inputs as a key -> value map.
function stepInputs(step) {
  const uses = step.match(/\n {8}uses: (\S+ # \S+)\n/)?.[1];
  const withAt = step.indexOf("\n        with:\n");
  assert.ok(withAt !== -1, `with: in\n${step}`);
  const inputs = {};
  for (const line of step.slice(withAt + "\n        with:\n".length).split("\n")) {
    const m = line.match(/^ {10}([\w-]+): (.+)$/);
    if (!m) break;
    inputs[m[1]] = m[2];
  }
  return { uses, inputs };
}

test("the app image job runs the release workflow's Trivy gate on the image it built, last", () => {
  const app = jobBlock(text(), "app-image");
  const release = readFileSync(RELEASE, "utf8");
  const ours = stepInputs(stepBlock(app, TRIVY_GATE));
  const theirs = stepInputs(stepBlock(release, TRIVY_GATE));
  assert.match(theirs.uses, /^aquasecurity\/trivy-action@[0-9a-f]{40} # v\d+\.\d+\.\d+$/, "release.yml's gate step");
  assert.equal(ours.uses, theirs.uses, "the same action at the same tag as release.yml");
  assert.equal(ours.inputs["image-ref"], "${{ env.IMAGE }}", "it scans the image this job built");
  const { "image-ref": _ours, ...oursRest } = ours.inputs;
  const { "image-ref": _theirs, ...theirsRest } = theirs.inputs;
  assert.deepEqual(oursRest, theirsRest, "every other input as release.yml has it");
  // The inputs that make it the gate, pinned here too, so a change to
  // release.yml that weakened both would still fail this test.
  for (const [k, v] of Object.entries({
    severity: "HIGH,CRITICAL",
    "ignore-unfixed": "true",
    "vuln-type": "os",
    "exit-code": '"1"',
    "cache-dir": "${{ runner.temp }}/trivy-cache",
  })) {
    assert.equal(ours.inputs[k], v, `${k}: ${v}`);
  }
  assert.doesNotMatch(stepBlock(app, TRIVY_GATE), /\n {8}(if|continue-on-error):/, "nothing softens the gate");
  // After both image checks, and the job's last step.
  const steps = app.split(/\n(?= {6}- )/).slice(1);
  assert.ok(steps.at(-1).startsWith(`      - name: ${TRIVY_GATE}\n`), "the gate is the last step");
  assert.ok(app.indexOf("test-app-image.sh \"$NO_WEB_IMAGE\" unhealthy") < app.indexOf(`name: ${TRIVY_GATE}`));
  assert.ok(app.indexOf("test-app-image.sh \"$IMAGE\" healthy") < app.indexOf(`name: ${TRIVY_GATE}`));
});

// Every Trivy step in both workflows (the gates, release.yml's full report and
// the CI slicer job's report) installs one exact Trivy version, the same in
// all of them, rather than the action's default, which lags (v0.36.0 of the
// action installs v0.70.0).
test("every Trivy step in ci.yml and release.yml sets the same exact Trivy version", () => {
  const steps = [text(), readFileSync(RELEASE, "utf8")].flatMap((t) =>
    t.split(/\n(?= {6}- )/).filter((s) => /\n {8}uses: aquasecurity\/trivy-action@/.test(s)),
  );
  assert.equal(steps.length, 4, "the CI gate, the CI slicer report, the release gate and the release full report");
  const versions = steps.map((s) => stepInputs(s).inputs.version);
  for (const v of versions) assert.match(v ?? "", /^v\d+\.\d+\.\d+$/, `an exact version: ${v}`);
  assert.equal(new Set(versions).size, 1, `one version in all of them: ${versions.join(", ")}`);
});

// Issue #219: a pull request that moves the Ubuntu snapshot (the apt-snapshot
// workflow) needs a scan of the new slicer image in its own CI. The slicer
// job ends with the same report slicer-image.yml makes before it publishes:
// the same action, tag and inputs, on the image the container tests built,
// and it can never fail the job (the maintainer, 2026-11-15 and 2026-11-21:
// report only).
// Issue #391: the leftover check, that no tracked file but the three pins
// names the Ubuntu snapshot pin or a later one, must run on every pull
// request, not only when the path-scoped gate tests run, or a copy of the pin
// added to, say, docs/ merges green and stops the next monthly run. So it is
// a job of its own that nothing scopes or gates, and it runs the very command
// the monthly workflow runs, from one shared script, so the two cannot drift.
const LEFTOVERS = "node .github/scripts/apt-snapshot.mjs leftovers";
test("the snapshot-pins job runs the shared leftover check on every pull request (issue #391)", () => {
  const t = text();
  const job = jobBlock(t, "snapshot-pins");
  assert.match(job, /\n {4}name: Ubuntu snapshot pin check\n/);
  assert.match(job, /\n {4}runs-on: ubuntu-24\.04\n/);
  assert.doesNotMatch(job, /\n {4}(needs|if):/, "no needs and no condition: it runs on every run");
  // The triggers carry no paths filter (tested above), so every pull request
  // starts it.
  assert.match(onBlock(t), /^ {2}pull_request:\n(?! {4})/m, "pull_request with nothing nested under it");
  const steps = jobSteps(job);
  assert.deepEqual(
    steps.map((s) => s.match(/^ {6}- name: (.+)$/m)[1]),
    ["Check out", "Set up Node", "No file but the pins names the snapshot pin"],
  );
  assert.equal(stepScript(job, "No file but the pins names the snapshot pin"), `${LEFTOVERS}\n`);
  assert.doesNotMatch(job, /run: .*(pnpm|npm|curl|wget)/, "no install and no network");
  // The monthly workflow runs the same command after its rewrite, from the
  // old pin, and has no grep of its own.
  const monthly = readFileSync(join(ROOT, ".github", "workflows", "apt-snapshot.yml"), "utf8");
  const pr = stepScript(jobBlock(monthly, "refresh"), "Push the branch and open the pull request");
  assert.ok(pr.includes(`${LEFTOVERS} "$OLD"`), "the monthly run calls the shared check");
  for (const [name, block] of [["the snapshot-pins job", job], ["apt-snapshot.yml", monthly]]) {
    assert.doesNotMatch(block, /git grep/, `${name} runs no grep of its own`);
  }
  // The shared script has the command.
  const script = readFileSync(join(ROOT, ".github", "scripts", "apt-snapshot.mjs"), "utf8");
  assert.match(script, /if \(cmd === "leftovers"\)/);
});

const SLICER_REPORT = "Trivy report (informational, does not fail the job)";
test("the CI slicer job ends with slicer-image.yml's Trivy report, which never fails the job", () => {
  const job = jobBlock(text(), "slicer-image");
  const ours = stepBlock(job, SLICER_REPORT);
  const theirs = stepBlock(jobBlock(readFileSync(join(ROOT, ".github", "workflows", "slicer-image.yml"), "utf8"), "build"), SLICER_REPORT);
  const a = stepInputs(ours);
  const b = stepInputs(theirs);
  assert.equal(a.uses, b.uses, "the same action at the same tag");
  assert.equal(a.inputs["image-ref"], "${{ env.SLICER_IMAGE }}", "the image the container tests built");
  assert.match(job, /\n {6}SLICER_IMAGE: platehouse-slicer:ci\n/);
  const { "image-ref": _a, ...restA } = a.inputs;
  const { "image-ref": _b, ...restB } = b.inputs;
  assert.deepEqual(restA, restB, "every other input as slicer-image.yml has it");
  assert.equal(a.inputs["exit-code"], '"0"');
  assert.match(ours, /\n {8}continue-on-error: true\n/);
  assert.doesNotMatch(ours, /\n {8}if:/, "it runs only when the steps before it passed");
  const steps = jobSteps(job);
  assert.ok(steps.at(-1).startsWith(`      - name: ${SLICER_REPORT}\n`), "the job's last step");
  assert.ok(job.indexOf("- name: Container tests\n") < job.indexOf(`- name: ${SLICER_REPORT}\n`));
});

// The build cache would otherwise keep the runtime stage's apt-get upgrade
// layer for as long as the base digest and that line stay the same, so later
// Debian fixes would never reach the image. OS_UPDATES_STAMP is used in that
// RUN, and a new value rebuilds it: release.yml passes one unique to the run
// (run id and attempt), so every release takes Debian's current fixes, and
// the CI App image job passes the UTC date plus the run attempt, so PR builds
// refresh daily, stay cached within a day, and a re-run of a failed job
// refreshes too.
const DOCKERFILE = join(ROOT, "docker", "app.Dockerfile");
const STAMP_CI = "OS_UPDATES_STAMP=${{ steps.os-updates.outputs.stamp }}";
const STAMP_RELEASE = "OS_UPDATES_STAMP=${{ github.run_id }}-${{ github.run_attempt }}";

// The steps of a job (or workflow) block that build docker/app.Dockerfile.
const appBuilds = (block) =>
  block
    .split(/\n(?= {6}- )/)
    .filter((s) => /\n {8}uses: docker\/build-push-action@/.test(s) && /\n {10}file: docker\/app\.Dockerfile\n/.test(s));

test("the runtime stage's apt-get upgrade uses OS_UPDATES_STAMP, so a new value rebuilds it", () => {
  const d = readFileSync(DOCKERFILE, "utf8");
  const runtimeAt = d.lastIndexOf("\nFROM ${BASE}\n");
  assert.ok(runtimeAt !== -1, "the runtime stage");
  const build = d.slice(0, runtimeAt);
  const runtime = d.slice(runtimeAt);
  assert.doesNotMatch(build, /\nARG OS_UPDATES_STAMP/, "the build stage does not take it");
  const argAt = runtime.search(/\nARG OS_UPDATES_STAMP(=\S*)?\n/);
  const upgradeAt = runtime.indexOf("apt-get -y upgrade");
  assert.ok(argAt !== -1 && upgradeAt !== -1 && argAt < upgradeAt, "declared in the runtime stage before the upgrade");
  // The RUN instruction holding the upgrade, joined across its continuations.
  const runAt = runtime.lastIndexOf("\nRUN ", upgradeAt);
  const run = runtime.slice(runAt, runtime.indexOf("\n\n", upgradeAt));
  assert.match(run, /\$\{?OS_UPDATES_STAMP\}?/, `the upgrade RUN uses it:\n${run}`);
});

test("the CI App image build passes the UTC date and run attempt as OS_UPDATES_STAMP, from a step run before it", () => {
  const app = jobBlock(text(), "app-image");
  const builds = appBuilds(app);
  assert.equal(builds.length, 1, "one app image build in the job");
  assert.equal(stepInputs(builds[0]).inputs["build-args"], STAMP_CI);
  const stamp = app.split(/\n(?= {6}- )/).filter((s) => /\n {8}id: os-updates\n/.test(s));
  assert.equal(stamp.length, 1, "one step with id os-updates");
  assert.ok(app.indexOf(stamp[0]) < app.indexOf(builds[0]), "it runs before the build");
  // Run its script and read what it wrote: today's UTC date and the run
  // attempt, YYYY-MM-DD-N. The attempt is what lets a re-run of a failed job
  // take Debian's current fixes instead of the day's cached upgrade layer (#216).
  const script = stamp[0].match(/\n {8}run: \|\n((?: {10}.*\n?)+)/)?.[1]?.replace(/^ {10}/gm, "");
  assert.ok(script, `a run: | script in\n${stamp[0]}`);
  const dir = mkdtempSync(join(tmpdir(), "ci-stamp-"));
  const run = (attempt) => {
    const out = join(dir, "github-output");
    writeFileSync(out, "");
    const env = { ...process.env, GITHUB_OUTPUT: out };
    delete env.GITHUB_RUN_ATTEMPT;
    if (attempt !== undefined) env.GITHUB_RUN_ATTEMPT = attempt;
    const r = spawnSync("bash", ["-eo", "pipefail", "-c", script], { env, encoding: "utf8" });
    return { r, written: readFileSync(out, "utf8").match(/^stamp=(.*)$/m)?.[1] };
  };
  try {
    for (const attempt of ["1", "3"]) {
      const before = new Date().toISOString().slice(0, 10);
      const { r, written } = run(attempt);
      const after = new Date().toISOString().slice(0, 10);
      assert.equal(r.status, 0, r.stderr);
      assert.match(written ?? "", /^\d{4}-\d{2}-\d{2}-\d+$/, `stamp=YYYY-MM-DD-N, got ${written}`);
      assert.ok(
        written === `${before}-${attempt}` || written === `${after}-${attempt}`,
        `today's UTC date and attempt ${attempt}, got ${written}`,
      );
    }
    // Without the attempt the step fails rather than writing a stamp that a
    // re-run would repeat.
    const { r, written } = run(undefined);
    assert.notEqual(r.status, 0, "fails when GITHUB_RUN_ATTEMPT is unset");
    assert.equal(written, undefined, "and writes no stamp");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("both release builds pass a per-run OS_UPDATES_STAMP, the same in each", () => {
  const builds = appBuilds(readFileSync(RELEASE, "utf8"));
  assert.equal(builds.length, 2, "the load build and the push by digest");
  for (const b of builds) assert.equal(stepInputs(b).inputs["build-args"], STAMP_RELEASE, b);
});

// The smoke test and the Trivy gate run on the load build, and the push by
// digest builds the image a second time. The apt-get upgrade layer talks to
// the network, so if it missed the cache in the second build, the pushed
// image would hold packages neither check saw. A step after the push compares
// the two builds' manifest digests (the digest output, which names the config
// and every layer) and fails the job, before the digest is recorded or
// uploaded, when they differ or either is missing. Not imageid: on a runner
// whose Docker loads through the OCI exporter, the load build reports no
// config digest and its imageid falls back to the manifest digest, while the
// push's imageid is the config digest, so identical images never matched
// (release run 43724090714, amd64).
// The first test below pins the wiring: both sides read outputs.digest and
// nothing reads imageid, so a revert fails it. The second feeds the step the
// build metadata that run 43724090714 reported from both exporters, so it
// shows the digest output agrees where imageid does not. Neither runs the
// exporters themselves; a live release run, where both arches must pass this
// step, is still the final proof.
const RELEASE_SAME_IMAGE = "Check the pushed image is the one tested";

test("the release build job fails when the pushed image is not the one it tested", () => {
  const job = jobBlock(readFileSync(RELEASE, "utf8"), "build");
  const steps = job.split(/\n(?= {6}- )/);
  const [load, push] = appBuilds(job);
  assert.match(load, /\n {8}id: load\n/, "the load build has id load");
  assert.match(stepInputs(load).inputs.load ?? "", /^true$/, "the step with id load is the load build");
  assert.match(push, /\n {8}id: push\n/, "the push build has id push");
  const check = stepBlock(job, RELEASE_SAME_IMAGE);
  assert.doesNotMatch(check, /\n {8}(if|continue-on-error):/, "nothing softens the check");
  const at = (s) => steps.indexOf(s);
  assert.ok(at(push) < at(check), "after the push");
  assert.ok(at(check) < at(stepBlock(job, "Record the digest")), "before the digest is recorded");
  assert.ok(at(check) < at(stepBlock(job, "Upload the digest")), "before the digest is uploaded");
  assert.match(check, /\n {10}TESTED: \$\{\{ steps\.load\.outputs\.digest \}\}\n/, "TESTED is the load build's manifest digest");
  assert.match(check, /\n {10}PUSHED: \$\{\{ steps\.push\.outputs\.digest \}\}\n/, "PUSHED is the push build's manifest digest");
  assert.doesNotMatch(check, /outputs\.imageid/, "imageid is a config or a manifest digest depending on the exporter");
  const script = check.match(/\n {8}run: \|\n((?: {10}.*\n?)+)/)?.[1]?.replace(/^ {10}/gm, "");
  assert.ok(script, `a run: | script in\n${check}`);
  const a = `sha256:${"a".repeat(64)}`;
  const b = `sha256:${"b".repeat(64)}`;
  const run = (env) =>
    spawnSync("bash", ["-eo", "pipefail", "-c", script], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
  assert.equal(run({ TESTED: a, PUSHED: a }).status, 0, "the same manifest digest passes");
  for (const [why, env] of [
    ["a different manifest digest", { TESTED: a, PUSHED: b }],
    ["no pushed manifest digest", { TESTED: a, PUSHED: "" }],
    ["no tested manifest digest", { TESTED: "", PUSHED: a }],
    ["neither manifest digest", { TESTED: "", PUSHED: "" }],
    ["manifest digests that are not sha256 digests", { TESTED: "x", PUSHED: "x" }],
  ]) {
    const r = run(env);
    assert.notEqual(r.status, 0, `${why} fails the job`);
    assert.match(r.stdout + r.stderr, /::error::/, `${why} prints an error annotation`);
  }
});

// The build metadata the four docker/build-push-action@v7.4.0 steps printed in
// release run 43724090714, trimmed to the keys the outputs come from, with the
// ImageID and Digest each step logged. amd64's load build went through the OCI
// exporter ("exporting to oci image format", Docker 29.4.2 with the containerd
// snapshotter), which reports no containerimage.config.digest. arm64's went
// through the docker exporter ("exporting to docker image format", Docker
// 28.0.4 on overlay2). Both pushes ran the image exporter. Every build of an
// arch exported the same manifest and config.
const MIXED_EXPORTER_RUN = {
  amd64: {
    load: {
      metadata: {
        "containerimage.digest": "sha256:6985fd73e73972ea6d05feb740e7649d7fbdaa3260d5af3d6be2784acd1dc0ba",
      },
      logged: {
        imageid: "sha256:6985fd73e73972ea6d05feb740e7649d7fbdaa3260d5af3d6be2784acd1dc0ba",
        digest: "sha256:6985fd73e73972ea6d05feb740e7649d7fbdaa3260d5af3d6be2784acd1dc0ba",
      },
    },
    push: {
      metadata: {
        "containerimage.config.digest": "sha256:adb0fe29105efd2ebe7463cf7ce9a012a920c1d9c0652fe9a39d0abe315da0ad",
        "containerimage.digest": "sha256:6985fd73e73972ea6d05feb740e7649d7fbdaa3260d5af3d6be2784acd1dc0ba",
      },
      logged: {
        imageid: "sha256:adb0fe29105efd2ebe7463cf7ce9a012a920c1d9c0652fe9a39d0abe315da0ad",
        digest: "sha256:6985fd73e73972ea6d05feb740e7649d7fbdaa3260d5af3d6be2784acd1dc0ba",
      },
    },
  },
  arm64: {
    load: {
      metadata: {
        "containerimage.config.digest": "sha256:5cf4fce122e4c35f1582d6b2cb8f696744eca8e7234689f65a56a9fae3fff3f1",
        "containerimage.digest": "sha256:d6bdd8291c0a8572aea4231464f9f66e900557c20f29ccaf4899f7a7d929bf92",
      },
      logged: {
        imageid: "sha256:5cf4fce122e4c35f1582d6b2cb8f696744eca8e7234689f65a56a9fae3fff3f1",
        digest: "sha256:d6bdd8291c0a8572aea4231464f9f66e900557c20f29ccaf4899f7a7d929bf92",
      },
    },
    push: {
      metadata: {
        "containerimage.config.digest": "sha256:5cf4fce122e4c35f1582d6b2cb8f696744eca8e7234689f65a56a9fae3fff3f1",
        "containerimage.digest": "sha256:d6bdd8291c0a8572aea4231464f9f66e900557c20f29ccaf4899f7a7d929bf92",
      },
      logged: {
        imageid: "sha256:5cf4fce122e4c35f1582d6b2cb8f696744eca8e7234689f65a56a9fae3fff3f1",
        digest: "sha256:d6bdd8291c0a8572aea4231464f9f66e900557c20f29ccaf4899f7a7d929bf92",
      },
    },
  },
};

// The two outputs as build-push-action v7.4.0 derives them from a build's
// metadata. digest is containerimage.digest (actions-toolkit 0.100.0,
// resolveDigest). imageid is the --iidfile that buildx writes from the same
// exporter response: the config digest, falling back to the manifest digest
// when the exporter reports no config digest (buildx commands/build.go,
// getImageID).
const buildOutputs = (metadata) => ({
  digest: metadata["containerimage.digest"],
  imageid: metadata["containerimage.config.digest"] ?? metadata["containerimage.digest"],
});

test("the pushed-image check passes one image built through the OCI and docker exporters (run 43724090714)", () => {
  const check = stepBlock(jobBlock(readFileSync(RELEASE, "utf8"), "build"), RELEASE_SAME_IMAGE);
  const wired = (side) => {
    const m = check.match(new RegExp(`\\n {10}${side}: \\$\\{\\{ steps\\.(\\w+)\\.outputs\\.(\\w+) \\}\\}\\n`));
    assert.ok(m, `${side} reads a step output in\n${check}`);
    return { step: m[1], output: m[2] };
  };
  const tested = wired("TESTED");
  const pushed = wired("PUSHED");
  assert.equal(tested.step, "load", "TESTED comes from the load build");
  assert.equal(pushed.step, "push", "PUSHED comes from the push build");
  const script = check.match(/\n {8}run: \|\n((?: {10}.*\n?)+)/)?.[1]?.replace(/^ {10}/gm, "");
  assert.ok(script, `a run: | script in\n${check}`);
  const run = (env) =>
    spawnSync("bash", ["-eo", "pipefail", "-c", script], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });

  const outputs = {};
  for (const [arch, builds] of Object.entries(MIXED_EXPORTER_RUN)) {
    outputs[arch] = {};
    for (const [build, { metadata, logged }] of Object.entries(builds)) {
      outputs[arch][build] = buildOutputs(metadata);
      assert.deepEqual(outputs[arch][build], logged, `the derived outputs are the ones ${arch} ${build} logged`);
    }
  }

  // The premise: the OCI exporter's load reports no config digest, so on amd64
  // imageid names the manifest on one side and the config on the other, while
  // the digest output names the manifest on both arches.
  assert.ok(!("containerimage.config.digest" in MIXED_EXPORTER_RUN.amd64.load.metadata), "the OCI load has no config digest");
  assert.notEqual(outputs.amd64.load.imageid, outputs.amd64.push.imageid, "imageid differs on amd64 for one image");
  assert.equal(outputs.arm64.load.imageid, outputs.arm64.push.imageid, "imageid agrees on arm64");
  for (const arch of ["amd64", "arm64"]) {
    assert.equal(outputs[arch].load.digest, outputs[arch].push.digest, `digest agrees on ${arch}`);
  }

  // The step as wired passes both arches. Wired to imageid it fails amd64,
  // which is how run 43724090714 failed.
  for (const arch of ["amd64", "arm64"]) {
    const env = { TESTED: outputs[arch].load[tested.output], PUSHED: outputs[arch].push[pushed.output] };
    const r = run(env);
    assert.equal(r.status, 0, `${arch} passes as wired (${tested.output}, ${pushed.output}):\n${r.stdout}${r.stderr}`);
  }
  const reverted = run({ TESTED: outputs.amd64.load.imageid, PUSHED: outputs.amd64.push.imageid });
  assert.notEqual(reverted.status, 0, "amd64 fails when the check reads imageid");
  assert.match(reverted.stdout + reverted.stderr, /::error::/, "with an error annotation");
});

// Runs the changes job's script in bash with git stubbed, and returns the two
// gate outputs it wrote, tests and image. The git diff stub behaves as real
// git does with renames detected (diff.renames defaults to true): each moved [from, to] pair prints
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
      stepScript(text(), "Decide whether the gate jobs run"),
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
    const written = readFileSync(out, "utf8");
    const value = (key) => {
      const all = [...written.matchAll(new RegExp(`^${key}=(.*)$`, "gm"))];
      assert.equal(all.length, 1, `one ${key} output written: ${written}`);
      assert.match(all[0][1], /^(true|false)$/, `${key} is true or false: ${written}`);
      return all[0][1];
    };
    return { tests: value("tests"), image: value("image") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const SHA = "3b2a20f0000000000000000000000000000000aa";

// Each case gives what the changes job decides for the gate tests job and for
// the gate image job. RUN is both, SKIP is neither, TESTS is the tests alone.
const RUN = { tests: "true", image: "true" };
const SKIP = { tests: "false", image: "false" };
const TESTS = { tests: "true", image: "false" };

for (const [name, input, want] of [
  ["a PR touching only the server skips both", { event: "pull_request", prBase: SHA, changed: ["apps/server/src/config.ts"] }, SKIP],
  ["a PR touching the gate runs both", { event: "pull_request", prBase: SHA, changed: ["apps/server/a.ts", "tools/slicing-gate/Dockerfile"] }, RUN],
  ["a PR touching this workflow runs both", { event: "pull_request", prBase: SHA, changed: [".github/workflows/ci.yml"] }, RUN],
  // The gate jobs take their Node version from .node-version, so a bump to it
  // alone must run the gate tests and the image build on the new Node.
  ["a PR touching only .node-version runs both", { event: "pull_request", prBase: SHA, changed: [".node-version"] }, RUN],
  ["a push touching only .node-version runs both", { event: "push", before: SHA, changed: [".node-version"] }, RUN],
  ["a PR with no changed files skips both", { event: "pull_request", prBase: SHA, changed: [] }, SKIP],
  [
    "look-alike paths skip both",
    {
      event: "pull_request",
      prBase: SHA,
      changed: [
        "tools/slicing-gate-old/x",
        "docs/tools/slicing-gate/x",
        ".github/workflows/ci.yml.orig",
        ".github/workflows/release.yml.orig",
        ".github/workflows/slicer-image.yml.orig",
        ".github/workflows/rc-tag.yml.orig",
        ".github/scripts/rc-target.mjs.bak",
        ".github/workflows/apt-snapshot.yml.orig",
        ".github/scripts/apt-snapshot.mjs.bak",
        ".github/scripts/other.mjs",
        "apps/server/.node-version",
        ".node-version.bak",
        "docs/README.md",
        "README.md.bak",
        "docs/CHANGELOG.md",
        "docker/app.Dockerfile.bak",
        "apps/server/docker/app.Dockerfile",
        "apps/slicer/Dockerfile.dev",
        "apps/slicer/test/container/other.test.ts",
        "apps/slicer/test/container/smoke.test.ts.snap",
        "apps/slicer/test/container/support/slicer.tsx",
      ],
    },
    SKIP,
  ],
  // ciworkflow.test.mjs reads README.md, so a README-only change runs the
  // tests; the image is not built from it, so the image build is skipped.
  ["a push touching only the README runs the tests, not the image build", { event: "push", before: SHA, changed: ["README.md"] }, TESTS],
  ["a push touching the gate runs both", { event: "push", before: SHA, changed: ["tools/slicing-gate/README.md"] }, RUN],
  // PR #17 review: git diff --name-only lists only the new path of a rename, so
  // a module moved out of the gate (say into packages/threemf/) left
  // no gate path in the list and the gate job was skipped. The job passes
  // --no-renames so a move lists its old path too.
  [
    "a PR moving a file out of the gate runs both",
    { event: "pull_request", prBase: SHA, moved: [["tools/slicing-gate/lib/zip.mjs", "packages/threemf/src/zip.mjs"]] },
    RUN,
  ],
  [
    "a push moving a file out of the gate runs both",
    { event: "push", before: SHA, moved: [["tools/slicing-gate/lib/threemf.mjs", "packages/threemf/src/threemf.mjs"]] },
    RUN,
  ],
  [
    "a PR moving a file into the gate runs both",
    { event: "pull_request", prBase: SHA, moved: [["packages/threemf/src/zip.mjs", "tools/slicing-gate/lib/zip.mjs"]] },
    RUN,
  ],
  [
    "a PR moving a file the gate tests read runs the tests",
    { event: "pull_request", prBase: SHA, moved: [["docker/app.Dockerfile", "docker/app2.Dockerfile"]] },
    TESTS,
  ],
  [
    "a PR moving a file between two non-gate paths skips both",
    { event: "pull_request", prBase: SHA, moved: [["apps/server/src/a.ts", "apps/server/src/b.ts"]] },
    SKIP,
  ],
  ["a new branch (all-zero before) runs both", { event: "push", before: "0".repeat(40), changed: [] }, RUN],
  ["a push with no before runs both", { event: "push", before: "", changed: [] }, RUN],
  ["a base commit that is gone (force-push) runs both", { event: "push", before: SHA, baseExists: false, changed: [] }, RUN],
  ["a PR with no base runs both", { event: "pull_request", prBase: "", changed: [] }, RUN],
  // Issue #219: the apt-snapshot workflow starts ci.yml by hand on its bot
  // branch. A run by hand has no base (github.event.before is empty), so both
  // gate jobs run, whatever changed.
  ["a run by hand runs both", { event: "workflow_dispatch", changed: ["apps/server/src/config.ts"] }, RUN],
]) {
  test(`gate jobs decision: ${name}`, () => {
    assert.deepEqual(decideGate(input), want);
  });
}

// Runs the changes job's docs step in bash with git stubbed, and returns the
// docs output it wrote.
function decideDocs({ event, prBase = "", before = "", changed = [] }) {
  const dir = mkdtempSync(join(tmpdir(), "ci-docs-"));
  try {
    const out = join(dir, "github-output");
    writeFileSync(out, "");
    const script = [
      "set -eo pipefail",
      'git() { case "$1" in cat-file) return 0;; diff) printf "%s" "$CHANGED";; *) return 99;; esac; }',
      stepScript(text(), "Decide whether the docs job runs"),
    ].join("\n");
    const r = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        EVENT: event,
        PR_BASE: prBase,
        PUSH_BEFORE: before,
        CHANGED: changed.map((f) => `${f}\n`).join(""),
        GITHUB_OUTPUT: out,
      },
    });
    assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    const all = [...readFileSync(out, "utf8").matchAll(/^docs=(.*)$/gm)];
    assert.equal(all.length, 1, "one docs output written");
    return all[0][1];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// PR #362 review: the docs site serves the ICO favicon, the Apple touch icon
// and the social card from apps/web/public (staticDirectories), so a change
// there alone must run the docs job, as a change to docs/ or apps/docs/ does.
for (const [name, changed, want] of [
  ["a PR touching only apps/web/public runs the docs job", ["apps/web/public/apple-touch-icon.png"], "true"],
  ["a PR touching only docs/ runs the docs job", ["docs/storage.md"], "true"],
  ["a PR touching only apps/docs/ runs the docs job", ["apps/docs/docusaurus.config.mjs"], "true"],
  ["a PR touching only the web app source skips the docs job", ["apps/web/src/main.tsx"], "false"],
  ["a look-alike of apps/web/public skips the docs job", ["apps/web/public-old/x.png", "apps/web/src/public/x.png"], "false"],
]) {
  test(`docs job decision: ${name}`, () => {
    assert.equal(decideDocs({ event: "pull_request", prBase: SHA, changed }), want);
  });
}

// Issue #219: a run by hand (the apt-snapshot workflow's bot branch) has no
// base commit, so the slicer job and the docs job run too, whatever changed.
// The slicer step is run here with git stubbed, as decideDocs runs the docs
// step.
test("a run by hand runs the slicer job and the docs job (issue #219)", () => {
  assert.equal(decideDocs({ event: "workflow_dispatch", changed: ["apps/server/src/config.ts"] }), "true");
  const dir = mkdtempSync(join(tmpdir(), "ci-slicer-"));
  try {
    const out = join(dir, "github-output");
    for (const [env, want] of [
      [{ EVENT: "workflow_dispatch", PR_BASE: "", PUSH_BEFORE: "" }, "true"],
      [{ EVENT: "pull_request", PR_BASE: SHA, PUSH_BEFORE: "" }, "false"],
    ]) {
      writeFileSync(out, "");
      const script = [
        "set -eo pipefail",
        'git() { case "$1" in cat-file) return 0;; diff) printf "apps/server/src/config.ts\\n";; *) return 99;; esac; }',
        stepScript(text(), "Decide whether the slicer job runs"),
      ].join("\n");
      const r = spawnSync("bash", ["-c", script], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, ...env },
      });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual([...readFileSync(out, "utf8").matchAll(/^slicer=(.*)$/gm)].map((m) => m[1]), [want], env.EVENT);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Issue #222: every file the gate tests read from outside tools/slicing-gate,
// alone in a PR, runs the gate tests. Only this workflow and .node-version,
// which the gate image job is built from, also run the image build.
for (const [file, want] of [
  [".github/workflows/ci.yml", RUN],
  [".node-version", RUN],
  [".github/workflows/release.yml", TESTS],
  [".github/workflows/slicer-image.yml", TESTS],
  [".github/workflows/rc-tag.yml", TESTS],
  [".github/scripts/rc-target.mjs", TESTS],
  [".github/workflows/apt-snapshot.yml", TESTS],
  [".github/scripts/apt-snapshot.mjs", TESTS],
  ["docker/app.Dockerfile", TESTS],
  ["docker/check-image-labels.sh", TESTS],
  ["apps/slicer/Dockerfile", TESTS],
  ["apps/slicer/test/container/smoke.test.ts", TESTS],
  ["apps/slicer/test/container/support/slicer.ts", TESTS],
  ["README.md", TESTS],
  ["CHANGELOG.md", TESTS],
]) {
  test(`gate jobs decision: a PR touching only ${file} runs the gate tests`, () => {
    assert.deepEqual(decideGate({ event: "pull_request", prBase: SHA, changed: [file] }), want);
  });
}

// PR #227 review: the table above is typed out by hand, so a gate test that
// starts reading a new file outside tools/slicing-gate, with no entry on the
// tests list, would skip on a PR changing only that file and still go green
// (issue #222 again). This scan finds every repo path the gate tests and their
// support files build from import.meta.url, through const X = join(Y, ...)
// chains, join(X, ...) calls and new URL("...", import.meta.url); every
// slicer-image.yml step a test runs with cwd: at the repo root, with the repo
// files that step names; and every module outside tools/slicing-gate the tests
// load, through the gate scripts they import and on through what that module
// imports (moduleImports). Each path outside tools/slicing-gate must make the
// Decide step run the gate tests.
// Known limits (PR #227 review, round 2): the scan does not see, and does not
// throw on, a read built with resolve(ROOT, ...), a template string such as
// `${ROOT}/x` or string concatenation; a join whose arguments hold a call, such
// as join(ROOT, "apps", pick(x)); require or createRequire; a repo-root file
// named with no slash in a cwd: step script (package.json, .node-version,
// pnpm-lock.yaml); a read other than an import in a gate script outside
// test/, as only the tests are scanned for reads and the scripts only for
// their imports; or a read other than an import in a module outside
// tools/slicing-gate that the tests import (issue #229), such as
// readFileSync(new URL("./table.bin", import.meta.url)) in packages/threemf,
// as moduleImports follows those modules for their imports only. A gate test,
// script or imported module that reads a file outside the gate in one of
// these forms must add it to the tests list in ci.yml by hand.
const GATE_DIR = join(ROOT, "tools", "slicing-gate");
const GATE_TEST_DIR = join(GATE_DIR, "test");
const insideGate = (p) => p === GATE_DIR || p.startsWith(`${GATE_DIR}/`);
const repoPath = (p) => relative(ROOT, p).split("\\").join("/");
// The helpers that run a workflow step with a cwd: option, and the workflow
// each one runs its step from.
const STEP_RUNNERS = {
  runSlicerStep: join(ROOT, ".github", "workflows", "slicer-image.yml"),
  runRcStep: join(ROOT, ".github", "workflows", "rc-tag.yml"),
};

function gateTestFiles(dir = GATE_TEST_DIR) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? gateTestFiles(join(dir, e.name)) : e.name.endsWith(".mjs") ? [join(dir, e.name)] : [],
  );
}

// The paths one source file builds from import.meta.url: bases maps each
// const X = dirname(fileURLToPath(import.meta.url)) or const X = join(Y, "a",
// ...) to its absolute path; at gives the file:line of an index in src; and
// resolveJoin resolves join(<base>, "a", "b", ...) to an absolute path, or null
// when the base is not one tracked here. resolveJoin throws when a non-literal
// argument follows a base outside the gate, as its file cannot be known.
function sourcePaths(file, src) {
  const at = (index) => `${repoPath(file)}:${src.slice(0, index).split("\n").length}`;
  const bases = new Map();
  const baseOf = (expr) =>
    /^dirname\(fileURLToPath\(import\.meta\.url\)\)$/.test(expr.trim()) ? dirname(file) : bases.get(expr.trim());
  const resolveJoin = (args, index) => {
    const parts = args.split(/,(?![^(]*\))/).map((a) => a.trim());
    const base = baseOf(parts[0]);
    if (base === undefined) return null;
    let p = base;
    for (const a of parts.slice(1)) {
      const lit = a.match(/^"([^"]*)"$/);
      if (!lit) {
        if (!insideGate(p)) throw new Error(`${at(index)}: join(${args}) builds a path outside tools/slicing-gate the scan cannot resolve`);
        return null;
      }
      p = resolve(p, lit[1]);
    }
    return p;
  };
  for (const m of src.matchAll(/\bconst (\w+) = (dirname\(fileURLToPath\(import\.meta\.url\)\))|\bconst (\w+) = join\(((?:dirname\(fileURLToPath\(import\.meta\.url\)\)|\w+)(?:, *"[^"]*")*)\);/g)) {
    if (m[1]) bases.set(m[1], dirname(file));
    else {
      const p = resolveJoin(m[4], m.index);
      if (p !== null) bases.set(m[3], p);
    }
  }
  return { at, bases, resolveJoin };
}

// Every module the gate tests load, followed from the test files through
// static imports, export ... from and dynamic imports into the gate scripts,
// and on into any module outside tools/slicing-gate and the modules it loads.
// Returns visited, every module reached, and outside, each one outside the
// gate as a repo-relative path with every place it is imported from. A .js
// import with no .js file but a .ts one is taken as the .ts file. Throws on an
// import it cannot follow: a package (a bare name that is not a Node builtin),
// a dynamic import whose argument is neither a string literal nor a path
// sourcePaths tracks, and a file that does not exist. readSource gives a
// file's text, or null when there is no such file.
const SOURCE_EXT = /\.(?:mjs|cjs|js|mts|cts|ts)$/;
const readIfExists = (f) => (existsSync(f) ? readFileSync(f, "utf8") : null);
function moduleImports(entries, readSource = readIfExists) {
  const outside = new Map();
  const visited = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    if (!SOURCE_EXT.test(file)) continue;
    const src = readSource(file) ?? "";
    const { at, bases } = sourcePaths(file, src);
    const loadPath = (abs, index) => {
      let target = abs;
      if (readSource(target) === null && target.endsWith(".js") && readSource(target.replace(/\.js$/, ".ts")) !== null) {
        target = target.replace(/\.js$/, ".ts");
      }
      if (readSource(target) === null) throw new Error(`${at(index)}: imports ${repoPath(target)}, which does not exist`);
      if (!insideGate(target)) {
        const rel = repoPath(target);
        outside.set(rel, [...(outside.get(rel) ?? []), at(index)]);
      }
      queue.push(target);
    };
    const load = (spec, index) => {
      if (spec.startsWith("node:") || builtinModules.includes(spec)) return;
      if (!/^\.{0,2}\//.test(spec)) {
        throw new Error(`${at(index)}: imports "${spec}", a package the scan cannot follow; teach moduleImports where it resolves`);
      }
      loadPath(resolve(dirname(file), spec), index);
    };
    // Static imports and re-exports start a line, so a string or a comment
    // naming one is not taken for one.
    for (const m of src.matchAll(/^[ \t]*(?:import|export)\b(?:[^"';]*?\bfrom)?\s*["']([^"']+)["']/gm)) load(m[1], m.index);
    // A dynamic import directly after a quote is text in a string (gate.mjs
    // writes OpenSCAD import calls), and one on a comment line is skipped.
    for (const m of src.matchAll(/(?<![\w$.'"`])import\(/g)) {
      const line = src.slice(src.lastIndexOf("\n", m.index) + 1, m.index);
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) continue;
      // The argument runs to the parenthesis that closes this one.
      let end = m.index + m[0].length;
      for (let depth = 1; end < src.length; end++) {
        if (src[end] === "(") depth++;
        else if (src[end] === ")" && --depth === 0) break;
      }
      const arg = src.slice(m.index + m[0].length, end).trim();
      const lit = arg.match(/^(["'])([^"'`\\]*)\1$/);
      if (lit) load(lit[2], m.index);
      else if (bases.has(arg)) loadPath(bases.get(arg), m.index);
      else throw new Error(`${at(m.index)}: a dynamic import of ${arg}, which the scan cannot resolve`);
    }
  }
  return { visited, outside };
}

// The step-runner call a cwd: option at index belongs to: { runner, job, step }.
// It is the call whose argument list holds the option, found by walking back
// from index by bracket depth to the "(" still open there (issue #232); an
// object or array literal open around the option is passed over. Throws
// unless that call is a STEP_RUNNERS helper named with its job and step as
// string literals; at gives the file:line of an index. Brackets inside a
// string are counted too, so an unbalanced one there makes it find the wrong
// "(", which then fails the literal check and throws rather than passing.
function stepRunnerCall(src, index, at) {
  const name = src.slice(index).match(/^cwd: (\w+)/)?.[1];
  let open = -1;
  for (let i = index - 1, depth = 0; i >= 0; i--) {
    const c = src[i];
    if (c === ")" || c === "]" || c === "}") depth++;
    else if (c === "(" || c === "[" || c === "{") {
      if (depth > 0) depth--;
      else if (c === "(") {
        open = i;
        break;
      }
    }
  }
  const runner = open < 0 ? undefined : src.slice(0, open).match(/\b(\w+)\s*$/)?.[1];
  const args = open < 0 ? null : src.slice(open + 1).match(/^\s*"([^"]+)",\s*"([^"]+)"/);
  const call = runner && args ? [null, runner, args[1], args[2]] : undefined;
  if (!call || !STEP_RUNNERS[call[1]]) {
    throw new Error(`${at(index)}: cwd: ${name} runs something outside tools/slicing-gate the scan does not know; add its helper to STEP_RUNNERS`);
  }
  return { runner: call[1], job: call[2], step: call[3] };
}

// Every path outside tools/slicing-gate the gate tests read, as repo-relative
// paths, each with every place it was found. Throws on a read it cannot
// resolve.
function gateTestReads() {
  const reads = new Map();
  const add = (abs, where) => {
    if (insideGate(abs)) return;
    const rel = repoPath(abs);
    reads.set(rel, [...(reads.get(rel) ?? []), where]);
  };
  for (const [rel, where] of moduleImports(gateTestFiles()).outside) reads.set(rel, [...(reads.get(rel) ?? []), ...where]);
  for (const file of gateTestFiles()) {
    const src = readFileSync(file, "utf8");
    const { at, bases, resolveJoin } = sourcePaths(file, src);
    for (const m of src.matchAll(/\bjoin\(((?:dirname\(fileURLToPath\(import\.meta\.url\)\)|\w+)(?:, *[^()]+?)*)\)/g)) {
      const p = resolveJoin(m[1], m.index);
      if (p !== null && p !== ROOT) add(p, at(m.index));
    }
    for (const m of src.matchAll(/new URL\(\s*"([^"]+)",\s*import\.meta\.url\s*\)/g)) add(resolve(dirname(file), m[1]), at(m.index));
    // A step run with its cwd at the repo root reads the repo files its script
    // names, relative to that root.
    for (const m of src.matchAll(/\bcwd: (\w+)/g)) {
      const cwd = bases.get(m[1]);
      if (cwd === undefined || insideGate(cwd)) continue;
      const call = stepRunnerCall(src, m.index, at);
      const workflow = STEP_RUNNERS[call.runner];
      add(workflow, at(m.index));
      const script = stepScript(jobBlock(readFileSync(workflow, "utf8"), call.job), call.step);
      for (const t of script.matchAll(/(?<![\w$./{}-])([\w.-]+(?:\/[\w.-]+)+)/g)) {
        const p = resolve(cwd, t[1]);
        if (existsSync(p)) add(p, `${at(m.index)} (${call.job} / ${call.step})`);
      }
    }
  }
  return reads;
}

test("gate jobs decision: every file the gate tests read outside tools/slicing-gate runs the gate tests (PR #227 review)", () => {
  const reads = gateTestReads();
  // The scan still sees the reads known today, the Orca pins step's included,
  // so a broken scan cannot pass by finding nothing.
  for (const known of [
    ".github/workflows/ci.yml",
    ".node-version",
    ".github/workflows/release.yml",
    ".github/workflows/slicer-image.yml",
    ".github/workflows/rc-tag.yml",
    ".github/scripts/rc-target.mjs",
    ".github/workflows/apt-snapshot.yml",
    ".github/scripts/apt-snapshot.mjs",
    "docker/app.Dockerfile",
    "docker/check-image-labels.sh",
    "apps/slicer/Dockerfile",
    "apps/slicer/test/container/smoke.test.ts",
    "apps/slicer/test/container/support/slicer.ts",
    "README.md",
    "CHANGELOG.md",
  ]) {
    assert.ok(reads.has(known), `the scan finds ${known}: ${[...reads.keys()].join(", ")}`);
  }
  for (const [file, where] of reads) {
    assert.equal(
      decideGate({ event: "pull_request", prBase: SHA, changed: [file] }).tests,
      "true",
      `${where.join(", ")} reads ${file}, but a PR changing only it skips the gate tests: add it to the tests list in ci.yml`,
    );
  }
});

// PR #227 review, round 2: an import from outside tools/slicing-gate is a read
// too, and the likeliest one, as gate modules are due to move to
// packages/threemf. The sources below are fakes handed to the scan.
// Each is one line with \n escapes, and the dynamic import is built by
// dynImport, so that the scan, reading this file, does not take them for real
// imports of its own.
const dynImport = (arg) => `${"import"}(${arg})`;
const fakeSources = (sources) => (f) => sources[repoPath(f)] ?? null;

test("gate jobs decision: the import scan follows imports out of tools/slicing-gate (PR #227 review)", () => {
  const entry = join(GATE_TEST_DIR, "fake.test.mjs");
  const { outside } = moduleImports(
    [entry],
    fakeSources({
      "tools/slicing-gate/test/fake.test.mjs": [
        'import {\n  openZip,\n} from "../../../packages/threemf/src/zip.mjs";',
        'import "node:fs";\nimport { join } from "path";',
        `const m = await ${dynImport('"../../../apps/server/src/load.mjs"')};`,
        'import { gate } from "../lib/fake.mjs";',
      ].join("\n"),
      // Followed on from a module outside the gate, its .js import naming a .ts file.
      "packages/threemf/src/zip.mjs": 'export { parse } from "./parse.js";\n',
      "packages/threemf/src/parse.ts": "export const parse = 1;\n",
      "apps/server/src/load.mjs": "",
      // A gate script outside test/ that imports from outside the gate.
      "tools/slicing-gate/lib/fake.mjs": "import { x } from '../../../packages/other/x.mjs';\n",
      "packages/other/x.mjs": "",
    }),
  );
  assert.deepEqual([...outside.keys()].sort(), [
    "apps/server/src/load.mjs",
    "packages/other/x.mjs",
    "packages/threemf/src/parse.ts",
    "packages/threemf/src/zip.mjs",
  ]);
  assert.deepEqual(outside.get("packages/threemf/src/zip.mjs"), ["tools/slicing-gate/test/fake.test.mjs:1"]);
});

test("gate jobs decision: the import scan throws on an import it cannot follow (PR #227 review)", () => {
  const entry = join(GATE_TEST_DIR, "fake.test.mjs");
  const scan = (src) => () => moduleImports([entry], fakeSources({ "tools/slicing-gate/test/fake.test.mjs": src }));
  assert.throws(scan('import { unzip } from "fflate";\n'), /fake\.test\.mjs:1: imports "fflate", a package/);
  assert.throws(scan(`const m = await ${dynImport("pick(x)")};\n`), /cannot resolve/);
  assert.throws(scan(`const m = await ${dynImport("`${ROOT}/x.mjs`")};\n`), /cannot resolve/);
  assert.throws(scan('import { x } from "../../../packages/gone.mjs";\n'), /packages\/gone\.mjs, which does not exist/);
});

test("gate jobs decision: the import scan reaches the gate scripts the tests load", () => {
  const visited = new Set([...moduleImports(gateTestFiles()).visited].map(repoPath));
  // smoke-gate.mjs is loaded only through a dynamic import of a joined path,
  // and lib/zip.mjs only through lib/threemf.mjs.
  for (const f of ["tools/slicing-gate/smoke-gate.mjs", "tools/slicing-gate/lib/zip.mjs", "tools/slicing-gate/gate.mjs"]) {
    assert.ok(visited.has(f), `the import scan reaches ${f}`);
  }
});

test("gate jobs decision: the scan finds the file the Orca pins step reads from its cwd: at the repo root", () => {
  const where = gateTestReads().get("apps/slicer/Dockerfile") ?? [];
  assert.ok(
    where.some((w) => w.endsWith("(detect / Resolve the Orca pins)")),
    `apps/slicer/Dockerfile is found through the Orca pins step: ${where.join(", ")}`,
  );
});

// Issue #232: a cwd: belongs to the call whose argument list holds it, not to
// the last literal step-runner call earlier in the file. The cwd option is
// built by cwdAt, so that the scan, reading this file, does not take these
// fake sources for steps of its own.
const cwdAt = (name) => `${"cwd"}: ${name}`;
const cwdCallIn = (src) => stepRunnerCall(src, src.indexOf(cwdAt("ROOT")), (i) => `fake:${i}`);

test("gate jobs decision: a cwd: is credited to the step-runner call that holds it (issue #232)", () => {
  const call = cwdCallIn(
    [
      'runSlicerStep("detect", "Old step", {});',
      'const r = runSlicerStep("detect", "Resolve the Orca pins", {',
      `  ${cwdAt("ROOT")},`,
      '  stubs: [...STUB, f(["a", "b"])],',
      '  env: { VERSION: version, ...env },',
      "});",
    ].join("\n"),
  );
  assert.deepEqual(call, { runner: "runSlicerStep", job: "detect", step: "Resolve the Orca pins" });
});

test("gate jobs decision: a cwd: on any other call throws, even after a literal step-runner call (issue #232)", () => {
  const earlier = 'runSlicerStep("detect", "Resolve the Orca pins", { env: {} });\n';
  for (const [name, later] of [
    ["a spawnSync with an array", `spawnSync("bash", ["-c", script], { ${cwdAt("ROOT")} });`],
    ["a helper given variables", `runReleaseStep(job, step, { ${cwdAt("ROOT")} });`],
    ["a step runner given variables", `runSlicerStep(job, "Resolve the Orca pins", { ${cwdAt("ROOT")} });`],
    ["an unknown helper given literals", `runOtherStep("detect", "Resolve the Orca pins", { ${cwdAt("ROOT")} });`],
  ]) {
    assert.throws(() => cwdCallIn(earlier + later), new RegExp(`fake:\\d+: ${cwdAt("ROOT")} runs something`), name);
  }
});

// One sample path per alternative of a Decide step regex: ^(a|b(c|d)\.e$|f/)
// gives a, bc.e, bd.e and f/x. Throws on any regex syntax beyond literals,
// escapes, groups, | and the two anchors, so a new form cannot pass unseen.
function regexSamples(re) {
  let i = 0;
  const alternation = () => {
    const out = [];
    let seq = [""];
    while (i < re.length && re[i] !== ")") {
      const c = re[i++];
      if (c === "|") {
        out.push(...seq);
        seq = [""];
      } else if (c === "(") {
        const inner = alternation();
        assert.equal(re[i++], ")", `unclosed group in ${re}`);
        seq = seq.flatMap((s) => inner.map((x) => s + x));
      } else if (c === "\\") {
        const next = re[i++];
        seq = seq.map((s) => s + next);
      }
      else if (c === "^" && i === 1) continue;
      else if (c === "$") seq = seq.map((s) => `${s}\0`);
      else if (".[]*+?{}".includes(c)) throw new Error(`cannot sample ${c} in ${re}`);
      else seq = seq.map((s) => s + c);
    }
    return [...out, ...seq];
  };
  const all = alternation();
  assert.equal(i, re.length, `unbalanced ) in ${re}`);
  return all.map((s) => (s.endsWith("\0") ? s.slice(0, -1) : s.endsWith("/") ? `${s}x` : s));
}

test("regexSamples gives one path per alternative", () => {
  assert.deepEqual(regexSamples("^(a|b(c|d)\\.e$|f/)"), ["a", "bc.e", "bd.e", "f/x"]);
  assert.throws(() => regexSamples("^(a.*)"), /cannot sample/);
});

// PR #227 review: the gate image job runs only after the gate tests job passed,
// so a path on the image list but not the tests list would set image=true and
// tests=false, skip both jobs and go green with no image built. Every path
// that makes the Decide step build the image must also make it run the tests.
test("gate jobs decision: every path that runs the gate image build also runs the gate tests (PR #227 review)", () => {
  const script = stepScript(text(), "Decide whether the gate jobs run");
  const lists = Object.fromEntries(
    [...script.matchAll(/if grep -Eq '([^']+)' <<<"\$changed"; then\n[\s\S]*?\n\s*else\n\s*(tests|image)=false\n/g)].map((m) => [m[2], m[1]]),
  );
  assert.ok(lists.tests && lists.image, `the step has a tests list and an image list:\n${script}`);
  const samples = regexSamples(lists.image);
  assert.ok(samples.length > 0);
  for (const file of samples) {
    const got = decideGate({ event: "pull_request", prBase: SHA, changed: [file] });
    assert.equal(got.image, "true", `${file} is on the image list`);
    assert.equal(got.tests, "true", `${file} runs the gate image build but not the gate tests, so the image job would skip: add it to the tests list`);
  }
});

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

// CI fails when zero tests ran. Measured with Vitest 5.1.0 on
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

// ---------------------------------------------------------------------------
// slicer-image.yml, which keeps the slicer image current. Watches OrcaSlicer's releases,
// builds apps/slicer/Dockerfile for a version, smoke-slices generated plates in
// the built image and, only on a pass, pushes orca-X.Y.Z, orca-X.Y.Z-r<run> and
// moves stable to that digest; on a failure it opens an issue. Each shell step
// is run in bash with gh, git, docker and pnpm stubbed. None of this runs the
// workflow on GitHub: a dispatch or a schedule needs the file on main, and the
// first manual run and a run forced to fail are the live proof.
const SLICER = join(ROOT, ".github", "workflows", "slicer-image.yml");
const slicerText = () => readFileSync(SLICER, "utf8");
const SLICER_DOCKERFILE = readFileSync(join(ROOT, "apps", "slicer", "Dockerfile"), "utf8");
const dockerfilePin = (name) => SLICER_DOCKERFILE.match(new RegExp(`^ARG ${name}=(\\S+)$`, "m"))?.[1];
const ORCA_ASSET = (v) => `OrcaSlicer_Linux_AppImage_Ubuntu2404_V${v}.AppImage`;
const sha = (c) => c.repeat(64);
const commit = (c) => c.repeat(40);

// The workflow's top-level env: block as a map.
function workflowEnv(t) {
  const m = t.match(/\nenv:\n((?: {2}\S.*\n)+)/);
  assert.ok(m, "a top-level env: block");
  return Object.fromEntries(
    m[1]
      .trimEnd()
      .split("\n")
      .map((l) => {
        const [, k, v] = l.match(/^ {2}([\w]+): (.+)$/);
        return [k, v];
      }),
  );
}

// Runs one step of slicer-image.yml in bash, after the given stub functions,
// with the workflow's env, a scratch RUNNER_TEMP, GITHUB_OUTPUT and
// GITHUB_STEP_SUMMARY, and CALLS, a file the stubs append to. Returns the exit
// status, the output, the step outputs, the summary, the stub calls, the logs
// the step kept in $RUNNER_TEMP/logs and the named files from its directory.
// runRcStep runs a step of rc-tag.yml the same way.
const runSlicerStep = (job, stepName, opts) => runWorkflowStep(SLICER, job, stepName, opts);
function runWorkflowStep(workflow, job, stepName, { env = {}, stubs = [], cwd, setup, files = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "workflow-step-"));
  try {
    const work = cwd ?? join(dir, "work");
    if (!cwd) mkdirSync(work);
    setup?.(work, dir);
    const out = join(dir, "github-output");
    const summary = join(dir, "step-summary");
    const calls = join(dir, "calls");
    for (const f of [out, summary, calls]) writeFileSync(f, "");
    const t = readFileSync(workflow, "utf8");
    const script = ["set -eo pipefail", ...stubs, stepScript(jobBlock(t, job), stepName)].join("\n");
    const r = spawnSync("bash", ["-c", script], {
      cwd: work,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        ...workflowEnv(t),
        RUNNER_TEMP: dir,
        GITHUB_OUTPUT: out,
        GITHUB_STEP_SUMMARY: summary,
        CALLS: calls,
        ...env,
      },
    });
    const outputs = {};
    for (const line of readFileSync(out, "utf8").split("\n")) {
      const i = line.indexOf("=");
      if (i > 0) outputs[line.slice(0, i)] = line.slice(i + 1);
    }
    const logsDir = join(dir, "logs");
    const logs = existsSync(logsDir)
      ? Object.fromEntries(readdirSync(logsDir).map((f) => [f, readFileSync(join(logsDir, f), "utf8")]))
      : {};
    const read = Object.fromEntries(
      files.map((f) => [f, existsSync(join(work, f)) ? readFileSync(join(work, f), "utf8") : null]),
    );
    return {
      status: r.status,
      log: `${r.stdout}${r.stderr}`,
      outputs,
      summary: readFileSync(summary, "utf8"),
      calls: readFileSync(calls, "utf8"),
      logs,
      files: read,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The steps of a job block, each from its "- name:" line.
const jobSteps = (block) => block.split(/\n(?= {6}- )/).slice(1);
const stepIds = (block) => [...block.matchAll(/\n {8}id: ([\w-]+)\n/g)].map((m) => m[1]);

// A step's multi-line build-args: | block as a list of lines.
function buildArgs(step) {
  const m = step.match(/\n {10}build-args: \|\n((?: {12}.+\n)+)/);
  assert.ok(m, `build-args: | in\n${step}`);
  return m[1].trimEnd().split("\n").map((l) => l.trim());
}

test("slicer-image: runs daily at 05:00 UTC, by hand with orca_version and force_fail, and on release tags", () => {
  const on = onBlock(slicerText());
  assert.match(on, /^ {2}schedule:\n {4}- cron: "0 5 \* \* \*"\n/m, `daily at 05:00 UTC:\n${on}`);
  assert.match(on, /^ {2}workflow_dispatch:\n/m);
  assert.match(
    on,
    /\n {6}orca_version:\n {8}description: .+\n {8}required: false\n {8}default: ""\n {8}type: string\n/,
    "orca_version is an optional string",
  );
  assert.match(
    on,
    /\n {6}force_fail:\n {8}description: .+\n {8}required: false\n {8}default: false\n {8}type: boolean\n/,
    "force_fail is a boolean, off by default",
  );
  assert.match(on, /^ {2}push:\n {4}tags:\n {6}- "v\*\.\*\.\*"\n(?! {6}- )/m, "push of a v*.*.* tag only");
  assert.doesNotMatch(on, /branches:|pull_request/, "no branch pushes and no pull requests");
});

// The workflow's permissions are contents: read, packages: write and issues: write.
// Each job takes only what it uses: the registry check reads packages, only
// the build job writes them, and only the failure report writes issues.
test("slicer-image: each job holds only the permissions it uses, within those three", () => {
  const t = slicerText();
  assert.match(t, /^permissions:\n {2}contents: read\n(?! {2}\S)/m, "top-level permissions are contents: read alone");
  const perms = (id) => {
    const m = jobBlock(t, id).match(/\n {4}permissions:\n((?: {6}\S.*\n)+)/);
    assert.ok(m, `${id} sets its own permissions`);
    return Object.fromEntries(m[1].trimEnd().split("\n").map((l) => l.trim().split(": ")));
  };
  assert.deepEqual(perms("gate"), { contents: "read", actions: "read" });
  assert.deepEqual(perms("detect"), { contents: "read", packages: "read" });
  assert.deepEqual(perms("build"), { contents: "read", packages: "write" });
  assert.deepEqual(perms("stable"), { contents: "read", packages: "write" });
  assert.deepEqual(perms("report-failure"), { issues: "write" });
  const jobs = [...t.slice(t.indexOf("\njobs:\n")).matchAll(/\n {2}([\w-]+):\n/g)].map((m) => m[1]);
  assert.deepEqual(jobs, ["gate", "detect", "build", "stable", "report-failure"]);
  assert.doesNotMatch(t.replace(jobBlock(t, "gate"), ""), /\bactions: (read|write)|\bwrite-all|\bread-all/, "nothing else is granted");
  for (const s of t.matchAll(/secrets\.(\w+)/g)) assert.equal(s[1], "GITHUB_TOKEN", "no secret but the job token");
});

// Exact release tags (the maintainer's locked rule), and the same tag as release.yml for
// every action release.yml also uses, else the same as ci.yml.
test("slicer-image: every action is pinned to the exact tag release.yml or ci.yml uses", () => {
  const pins = (t) => {
    const out = {};
    for (const [, u] of t.matchAll(/uses: (\S+ # \S+)/g)) {
      const [name, tag] = u.split("@");
      (out[name] ??= new Set()).add(tag);
    }
    return out;
  };
  const ours = pins(slicerText());
  const release = pins(readFileSync(RELEASE, "utf8"));
  const ci = pins(text());
  assert.ok(Object.keys(ours).length >= 7, Object.keys(ours).join(", "));
  for (const [name, tags] of Object.entries(ours)) {
    assert.equal(tags.size, 1, `${name} at one tag: ${[...tags].join(", ")}`);
    const [tag] = tags;
    assert.match(tag, /^[0-9a-f]{40} # v\d+\.\d+\.\d+$/, `${name}@${tag} is not a commit SHA with its release tag`);
    const theirs = release[name] ?? ci[name];
    assert.ok(theirs, `${name} is used by release.yml or ci.yml`);
    assert.deepEqual([...theirs], [tag], `${name} at the tag ${release[name] ? "release.yml" : "ci.yml"} uses`);
  }
});

test("slicer-image: jobs run on ubuntu-24.04 with timeouts, chained with !cancelled()", () => {
  const t = slicerText();
  for (const id of ["detect", "build", "stable", "report-failure"]) {
    const b = jobBlock(t, id);
    assert.match(b, /\n {4}runs-on: ubuntu-24\.04\n/, `${id} runs on ubuntu-24.04`);
    const m = b.match(/\n {4}timeout-minutes: (\d+)\n/);
    assert.ok(m && Number(m[1]) > 0 && Number(m[1]) <= 90, `${id} has a timeout`);
  }
  const build = jobBlock(t, "build");
  assert.match(build, /\n {4}needs: detect\n/);
  assert.ok(
    build.includes(
      "if: ${{ !cancelled() && needs.detect.result == 'success' && needs.detect.outputs.build == 'true' }}",
    ),
    "build runs only after detect succeeded and said to build",
  );
  const report = jobBlock(t, "report-failure");
  assert.match(report, /\n {4}needs: \[gate, detect, build, stable\]\n/);
  assert.ok(
    report.includes(
      "if: ${{ always() && (needs.gate.result == 'failure' || needs.detect.result == 'failure' || needs.build.result == 'failure' || needs.stable.result == 'failure' || (github.event_name == 'push' && (needs.gate.result == 'cancelled' || needs.detect.result == 'cancelled' || needs.build.result == 'cancelled' || needs.stable.result == 'cancelled'))) }}",
    ),
    "the report runs when a job failed, or was cancelled on a push (issue #451)",
  );
  // Issue #451: each ref has its own group, so a tag run is never the pending
  // run another trigger replaces; only moving stable is serialised across refs.
  assert.match(t, /\nconcurrency:\n {2}group: slicer-image-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: false\n/, "no publish is cancelled part way, and each ref has its own group");
  assert.match(jobBlock(t, "stable"), /\n {4}concurrency:\n {6}group: slicer-image-stable\n {6}cancel-in-progress: false\n/, "stable moves one run at a time");
  assert.equal([...t.matchAll(/^\s*concurrency:/gm)].length, 2, "the workflow and the stable job only");
  assert.doesNotMatch(t, /[^\x00-\x7F]/, "ASCII only");
});

// Pick the version: the latest release, or orca_version on a dispatch; the tag
// must be vX.Y.Z and the release published. A tag push must be semver.
const GH_RELEASES_STUB = [
  "gh() {",
  '  echo "gh $*" >> "$CALLS"',
  '  if [ "${GH_STATUS:-0}" != 0 ]; then echo "gh: Not Found (HTTP 404)" >&2; return "$GH_STATUS"; fi',
  '  case "$2" in',
  // The repository's tags (the release gate's live check); by default only the ref's own.
  '    --paginate) printf "%s" "${MATCHING_REFS-$REF}" ;;',
  '    repos/OrcaSlicer/OrcaSlicer/releases/latest) printf "%s" "$LATEST" ;;',
  '    repos/OrcaSlicer/OrcaSlicer/releases/tags/*) printf "%s" "$BYTAG" ;;',
  "    *) return 99 ;;",
  "  esac",
  "}",
];
// The pick step runs .github/scripts/release-gate.mjs from its cwd; copying it
// (and rc-target.mjs, which it imports) keeps the step out of the repo root.
const withGateScripts = (work) => {
  mkdirSync(join(work, ".github", "scripts"), { recursive: true });
  const to = join(work, ".github", "scripts");
  copyFileSync(join(ROOT, ".github", "scripts", "release-gate.mjs"), join(to, "release-gate.mjs"));
  copyFileSync(join(ROOT, ".github", "scripts", "rc-target.mjs"), join(to, "rc-target.mjs"));
};
const release = (tag, extra = {}) => JSON.stringify({ tag_name: tag, draft: false, prerelease: false, assets: [], ...extra });

for (const [name, env, want] of [
  ["a schedule builds the latest release", { EVENT: "schedule", LATEST: release("v2.5.1") }, { version: "2.5.1", call: "releases/latest", stable: "true" }],
  ["a plain tag push builds the latest release and moves stable", { EVENT: "push", REF: "refs/tags/v0.1.0", LATEST: release("v2.5.1") }, { version: "2.5.1", call: "releases/latest", stable: "true" }],
  ["a prerelease tag push builds but leaves stable alone", { EVENT: "push", REF: "refs/tags/v0.1.0-rc.1", LATEST: release("v2.5.1") }, { version: "2.5.1", call: "releases/latest", stable: "false" }],
  ["a prerelease tag with a hyphenated label leaves stable alone", { EVENT: "push", REF: "refs/tags/v0.0.0-test", LATEST: release("v2.5.1") }, { version: "2.5.1", call: "releases/latest", stable: "false" }],
  ["a dispatch with no version builds the latest release", { EVENT: "workflow_dispatch", INPUT_VERSION: "", LATEST: release("v2.5.1") }, { version: "2.5.1", call: "releases/latest", stable: "true" }],
  ["a dispatch with orca_version builds that release", { EVENT: "workflow_dispatch", INPUT_VERSION: "2.5.0", BYTAG: release("v2.5.0") }, { version: "2.5.0", call: "releases/tags/v2.5.0", stable: "true" }],
  ["a beta tag is refused", { EVENT: "schedule", LATEST: release("v2.6.0-beta1") }, { fail: /is not vX\.Y\.Z/ }],
  ["a release candidate tag is refused", { EVENT: "schedule", LATEST: release("v2.6.0-rc.1") }, { fail: /is not vX\.Y\.Z/ }],
  ["a tag without the v is refused", { EVENT: "schedule", LATEST: release("2.6.0") }, { fail: /is not vX\.Y\.Z/ }],
  ["a nightly tag is refused", { EVENT: "schedule", LATEST: release("nightly-builds") }, { fail: /is not vX\.Y\.Z/ }],
  ["a release marked prerelease is refused", { EVENT: "schedule", LATEST: release("v2.6.0", { prerelease: true }) }, { fail: /draft or a prerelease/ }],
  ["a draft is refused", { EVENT: "workflow_dispatch", INPUT_VERSION: "2.6.0", BYTAG: release("v2.6.0", { draft: true }) }, { fail: /draft or a prerelease/ }],
  ["a malformed orca_version is refused before any lookup", { EVENT: "workflow_dispatch", INPUT_VERSION: "2.5" }, { fail: /orca_version '2\.5' is not X\.Y\.Z/, noCall: true }],
  ["an orca_version with shell in it is refused", { EVENT: "workflow_dispatch", INPUT_VERSION: "2.5.0;id" }, { fail: /is not X\.Y\.Z/, noCall: true }],
  ["a release whose tag is not the one asked for is refused", { EVENT: "workflow_dispatch", INPUT_VERSION: "2.5.0", BYTAG: release("v2.5.1") }, { fail: /asked for v2\.5\.0/ }],
  ["a tag push that is not semver is refused", { EVENT: "push", REF: "refs/tags/v1.2.3.4" }, { fail: /is not a semver tag/, noCall: true }],
  ["a tag push of vtest.x.y is refused", { EVENT: "push", REF: "refs/tags/vtest.x.y" }, { fail: /is not a semver tag/, noCall: true }],
  // A run by hand builds the dispatched ref's apps/slicer and moves stable, so
  // it must start from main or a release tag, as release.yml's gate requires;
  // a dispatch from any other branch would publish unreviewed code.
  ["a dispatch from a feature branch is refused", { EVENT: "workflow_dispatch", INPUT_VERSION: "", REF: "refs/heads/fix/slicer-x", LATEST: release("v2.5.1") }, { fail: /refs\/heads\/fix\/slicer-x is not main or a release tag/, noCall: true }],
  ["a dispatch from the release branch is refused", { EVENT: "workflow_dispatch", INPUT_VERSION: "", REF: "refs/heads/release/v0.1.0", LATEST: release("v2.5.1") }, { fail: /is not main or a release tag/, noCall: true }],
  ["a dispatch from a branch named like main is refused", { EVENT: "workflow_dispatch", INPUT_VERSION: "", REF: "refs/heads/main-x", LATEST: release("v2.5.1") }, { fail: /is not main or a release tag/, noCall: true }],
  ["a dispatch from a tag that is not semver is refused", { EVENT: "workflow_dispatch", INPUT_VERSION: "", REF: "refs/tags/vtest", LATEST: release("v2.5.1") }, { fail: /is not a semver tag/, noCall: true }],
  ["a dispatch from a plain release tag moves stable", { EVENT: "workflow_dispatch", INPUT_VERSION: "", REF: "refs/tags/v0.1.0", LATEST: release("v2.5.1") }, { version: "2.5.1", call: "releases/latest", stable: "true" }],
  ["a dispatch from a prerelease tag leaves stable alone", { EVENT: "workflow_dispatch", INPUT_VERSION: "", REF: "refs/tags/v0.1.0-rc.1", LATEST: release("v2.5.1") }, { version: "2.5.1", call: "releases/latest", stable: "false" }],
  ["a failed API call fails the step", { EVENT: "schedule", GH_STATUS: "1" }, { fail: /HTTP 404/ }],
]) {
  test(`slicer-image version pick: ${name}`, () => {
    const r = runSlicerStep("detect", "Pick the version", { setup: withGateScripts, stubs: GH_RELEASES_STUB, env: { REF: "refs/heads/main", ...env } });
    if (want.fail) {
      assert.notEqual(r.status, 0, r.log);
      assert.match(r.log, want.fail);
      if (want.noCall) assert.equal(r.calls, "", "no API call");
      // The step's own log is kept for the failure issue.
      assert.match(r.logs["pick.log"] ?? "", want.fail);
    } else {
      assert.equal(r.status, 0, r.log);
      assert.equal(r.outputs.version, want.version);
      assert.equal(r.outputs.stable, want.stable, "whether stable moves");
      assert.equal(r.outputs.orca, want.stable, "orca-X.Y.Z moves exactly when stable does: a prerelease tag moves neither");
      assert.match(r.calls, new RegExp(`^gh api repos/OrcaSlicer/OrcaSlicer/${want.call.replace(/\./g, "\\.")}$`, "m"));
    }
  });
}

// A plain tag below a higher release (a backport) builds and gets its version
// tags but never moves stable, and a failed tag lookup fails the step.
test("slicer-image version pick: a backport tag leaves stable alone but still builds", () => {
  const r = runSlicerStep("detect", "Pick the version", {
    setup: withGateScripts,
    stubs: GH_RELEASES_STUB,
    env: { EVENT: "push", REF: "refs/tags/v0.1.2", LATEST: release("v2.5.1"), MATCHING_REFS: "refs/tags/v0.2.0\nrefs/tags/v0.1.2\n" },
  });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.outputs.stable, "false");
  assert.equal(r.outputs.orca, "false", "orca-X.Y.Z moves exactly when stable does");
  assert.equal(r.outputs.release, "0.1.2");
});

test("slicer-image version pick: a daily run and a run from main never look at the repository's tags", () => {
  for (const env of [{ EVENT: "schedule", REF: "refs/heads/main" }, { EVENT: "workflow_dispatch", INPUT_VERSION: "", REF: "refs/heads/main" }]) {
    const r = runSlicerStep("detect", "Pick the version", { setup: withGateScripts, stubs: GH_RELEASES_STUB, env: { LATEST: release("v2.5.1"), ...env } });
    assert.equal(r.status, 0, r.log);
    assert.doesNotMatch(r.calls, /matching-refs/);
    assert.equal(r.outputs.stable, "true");
  }
});

test("slicer-image version pick: a dispatch from a backport tag leaves stable alone", () => {
  const r = runSlicerStep("detect", "Pick the version", {
    setup: withGateScripts,
    stubs: GH_RELEASES_STUB,
    env: { EVENT: "workflow_dispatch", INPUT_VERSION: "", REF: "refs/tags/v0.1.2", LATEST: release("v2.5.1"), MATCHING_REFS: "refs/tags/v0.2.0\nrefs/tags/v0.1.2\n" },
  });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.outputs.stable, "false");
});

test("slicer-image version pick: a failed tag lookup on a plain tag fails the step, never moves stable", () => {
  const r = runSlicerStep("detect", "Pick the version", {
    setup: withGateScripts,
    stubs: ["gh() { echo boom >&2; return 1; }"],
    env: { EVENT: "push", REF: "refs/tags/v0.1.0", GITHUB_REPOSITORY: "o/r" },
  });
  assert.notEqual(r.status, 0, r.log);
  assert.equal(r.outputs.stable, undefined);
});

// The release's version tag (PR #360): a run started from a release tag, by
// a push, a re-run of it or a run by hand from it, tags the image with the
// release's version, so rc-tag.yml can find the build made for that release
// by the same name as the app image's. Daily runs and runs from main tag
// none. Any semver tag gets one, as release.yml's version tag does; only
// rc-tag.yml decides which of them rc may follow.
for (const [name, env, want] of [
  ["a pushed release candidate tag", { EVENT: "push", REF: "refs/tags/v0.2.0-rc.1" }, "0.2.0-rc.1"],
  ["a pushed plain release tag", { EVENT: "push", REF: "refs/tags/v0.2.0" }, "0.2.0"],
  ["a pushed throwaway tag", { EVENT: "push", REF: "refs/tags/v0.0.0-test" }, "0.0.0-test"],
  ["a run by hand from a release tag", { EVENT: "workflow_dispatch", INPUT_VERSION: "", REF: "refs/tags/v0.2.0-rc.1" }, "0.2.0-rc.1"],
  ["a run by hand from main", { EVENT: "workflow_dispatch", INPUT_VERSION: "", REF: "refs/heads/main" }, ""],
  ["a daily run", { EVENT: "schedule", REF: "refs/heads/main" }, ""],
]) {
  test(`slicer-image version pick: the release version for ${name} is '${want}'`, () => {
    const r = runSlicerStep("detect", "Pick the version", { setup: withGateScripts, stubs: GH_RELEASES_STUB, env: { LATEST: release("v2.5.1"), ...env } });
    assert.equal(r.status, 0, r.log);
    assert.equal(r.outputs.release, want);
  });
}

// Resolve the Orca pins: the asset's sha256 from GitHub's API, the tag's commit
// from git ls-remote, peeled when the tag is annotated; fail closed on
// anything else. For the Dockerfile's own version they must equal its pins.
const GIT_LSREMOTE_STUB = [
  "git() {",
  '  echo "git $*" >> "$CALLS"',
  '  [ "$1" = ls-remote ] || return 99',
  '  printf "%s" "$REFS"',
  "}",
];
const asset = (name, extra = {}) => ({ name, state: "uploaded", digest: `sha256:${sha("a")}`, ...extra });
const withAssets = (v, assets) => release(`v${v}`, { assets });

for (const [name, version, env, want] of [
  [
    "a lightweight tag gives the tag's commit",
    "2.5.1",
    { BYTAG: withAssets("2.5.1", [asset(ORCA_ASSET("2.5.1"))]), REFS: `${commit("c")}\trefs/tags/v2.5.1\n` },
    { sha256: sha("a"), src: commit("c") },
  ],
  [
    "an annotated tag gives the peeled commit",
    "2.5.1",
    {
      BYTAG: withAssets("2.5.1", [asset(ORCA_ASSET("2.5.1"))]),
      REFS: `${commit("d")}\trefs/tags/v2.5.1\n${commit("e")}\trefs/tags/v2.5.1^{}\n`,
    },
    { sha256: sha("a"), src: commit("e") },
  ],
  [
    "only the amd64 Ubuntu 24.04 asset is taken, never the aarch64 one",
    "2.5.1",
    {
      BYTAG: withAssets("2.5.1", [
        asset("OrcaSlicer_Linux_AppImage_Ubuntu2404_aarch64_V2.5.1.AppImage", { digest: `sha256:${sha("b")}` }),
        asset(ORCA_ASSET("2.5.1")),
      ]),
      REFS: `${commit("c")}\trefs/tags/v2.5.1\n`,
    },
    { sha256: sha("a"), src: commit("c") },
  ],
  [
    "no matching asset fails",
    "2.5.1",
    { BYTAG: withAssets("2.5.1", [asset("OrcaSlicer_Linux_AppImage_Ubuntu2404_aarch64_V2.5.1.AppImage")]), REFS: `${commit("c")}\trefs/tags/v2.5.1\n` },
    { fail: /no single asset named OrcaSlicer_Linux_AppImage_Ubuntu2404_V2\.5\.1\.AppImage/ },
  ],
  [
    "an asset still uploading fails",
    "2.5.1",
    { BYTAG: withAssets("2.5.1", [asset(ORCA_ASSET("2.5.1"), { state: "starter" })]), REFS: `${commit("c")}\trefs/tags/v2.5.1\n` },
    { fail: /is not fully uploaded/ },
  ],
  [
    "an asset with no digest fails",
    "2.5.1",
    { BYTAG: withAssets("2.5.1", [asset(ORCA_ASSET("2.5.1"), { digest: null })]), REFS: `${commit("c")}\trefs/tags/v2.5.1\n` },
    { fail: /records no sha256 digest/ },
  ],
  [
    "an asset digest that is not sha256 fails",
    "2.5.1",
    { BYTAG: withAssets("2.5.1", [asset(ORCA_ASSET("2.5.1"), { digest: `sha512:${sha("a")}` })]), REFS: `${commit("c")}\trefs/tags/v2.5.1\n` },
    { fail: /records no sha256 digest/ },
  ],
  [
    "a tag git cannot find fails",
    "2.5.1",
    { BYTAG: withAssets("2.5.1", [asset(ORCA_ASSET("2.5.1"))]), REFS: "" },
    { fail: /found no commit for refs\/tags\/v2\.5\.1/ },
  ],
  [
    "a look-alike ref does not count",
    "2.5.1",
    { BYTAG: withAssets("2.5.1", [asset(ORCA_ASSET("2.5.1"))]), REFS: `${commit("c")}\trefs/tags/x/refs/tags/v2.5.1\n` },
    { fail: /found no commit/ },
  ],
  [
    "a malformed commit fails",
    "2.5.1",
    { BYTAG: withAssets("2.5.1", [asset(ORCA_ASSET("2.5.1"))]), REFS: `${commit("c").slice(0, 12)}\trefs/tags/v2.5.1\n` },
    { fail: /found no commit/ },
  ],
  [
    "the Dockerfile's version passes when both pins match it",
    dockerfilePin("ORCA_VERSION"),
    {
      BYTAG: withAssets(dockerfilePin("ORCA_VERSION"), [asset(ORCA_ASSET(dockerfilePin("ORCA_VERSION")), { digest: `sha256:${dockerfilePin("ORCA_SHA256")}` })]),
      REFS: `${dockerfilePin("ORCA_SRC_SHA")}\trefs/tags/v${dockerfilePin("ORCA_VERSION")}\n`,
    },
    { sha256: dockerfilePin("ORCA_SHA256"), src: dockerfilePin("ORCA_SRC_SHA") },
  ],
  [
    "the Dockerfile's version fails when the asset digest differs from its pin",
    dockerfilePin("ORCA_VERSION"),
    {
      BYTAG: withAssets(dockerfilePin("ORCA_VERSION"), [asset(ORCA_ASSET(dockerfilePin("ORCA_VERSION")), { digest: `sha256:${sha("f")}` })]),
      REFS: `${dockerfilePin("ORCA_SRC_SHA")}\trefs/tags/v${dockerfilePin("ORCA_VERSION")}\n`,
    },
    { fail: /apps\/slicer\/Dockerfile pins/ },
  ],
  [
    "the Dockerfile's version fails when the tag moved off its pinned commit",
    dockerfilePin("ORCA_VERSION"),
    {
      BYTAG: withAssets(dockerfilePin("ORCA_VERSION"), [asset(ORCA_ASSET(dockerfilePin("ORCA_VERSION")), { digest: `sha256:${dockerfilePin("ORCA_SHA256")}` })]),
      REFS: `${commit("9")}\trefs/tags/v${dockerfilePin("ORCA_VERSION")}\n`,
    },
    { fail: /apps\/slicer\/Dockerfile pins/ },
  ],
]) {
  test(`slicer-image pins: ${name}`, () => {
    assert.match(version ?? "", /^\d+\.\d+\.\d+$/, "the Dockerfile pins a version");
    const r = runSlicerStep("detect", "Resolve the Orca pins", {
      cwd: ROOT,
      stubs: [...GH_RELEASES_STUB, ...GIT_LSREMOTE_STUB],
      env: { VERSION: version, ...env },
    });
    if (want.fail) {
      assert.notEqual(r.status, 0, r.log);
      assert.match(r.log, want.fail);
      assert.equal(r.outputs.orca_sha256, undefined, "no pin is written");
      assert.equal(r.outputs.orca_src_sha, undefined, "no pin is written");
    } else {
      assert.equal(r.status, 0, r.log);
      assert.equal(r.outputs.orca_sha256, want.sha256);
      assert.equal(r.outputs.orca_src_sha, want.src);
      assert.match(r.calls, new RegExp(`^gh api repos/OrcaSlicer/OrcaSlicer/releases/tags/v${version.replace(/\./g, "\\.")}$`, "m"));
      assert.match(r.calls, /^git ls-remote https:\/\/github\.com\/OrcaSlicer\/OrcaSlicer\.git /m);
    }
  });
}

// The registry is the state: a schedule stops when orca-X.Y.Z exists; a tag
// push or a dispatch always builds and never asks the registry, so GHCR's
// answer for a package that does not exist yet cannot block it (the maintainer,
// 2026-11-15). Only "not found" means the tag does not exist.
const DOCKER_INSPECT_STUB = [
  "docker() {",
  '  echo "docker $*" >> "$CALLS"',
  '  if [ "$INSPECT_STATUS" = 0 ]; then echo "sha256:1111111111111111111111111111111111111111111111111111111111111111"; return 0; fi',
  '  echo "$INSPECT_ERR" >&2',
  '  return "$INSPECT_STATUS"',
  "}",
];
const NOT_FOUND = "ERROR: ghcr.io/jonathanmcohen/platehouse-slicer:orca-2.5.1: not found";
for (const [name, env, want] of [
  ["a schedule stops when orca-X.Y.Z exists", { EVENT: "schedule", INSPECT_STATUS: "0" }, { build: "false", upToDate: true }],
  ["a schedule builds when orca-X.Y.Z is not found", { EVENT: "schedule", INSPECT_STATUS: "1", INSPECT_ERR: NOT_FOUND }, { build: "true" }],
  ["a tag push builds without asking the registry", { EVENT: "push", INSPECT_STATUS: "0" }, { build: "true", noCall: true }],
  ["a dispatch builds without asking the registry", { EVENT: "workflow_dispatch", INSPECT_STATUS: "0" }, { build: "true", noCall: true }],
  ["any other registry error fails a daily run", { EVENT: "schedule", INSPECT_STATUS: "1", INSPECT_ERR: "ERROR: denied: denied" }, { fail: /could not tell whether/ }],
  ["a registry that would deny does not block a tag push", { EVENT: "push", INSPECT_STATUS: "1", INSPECT_ERR: "ERROR: denied: denied" }, { build: "true", noCall: true }],
  ["a registry that would deny does not block a dispatch", { EVENT: "workflow_dispatch", INSPECT_STATUS: "1", INSPECT_ERR: "ERROR: unexpected status 500" }, { build: "true", noCall: true }],
]) {
  test(`slicer-image registry check: ${name}`, () => {
    const r = runSlicerStep("detect", "Check the registry", { stubs: DOCKER_INSPECT_STUB, env: { VERSION: "2.5.1", ...env } });
    if (want.noCall) assert.equal(r.calls, "", "the registry is not asked");
    else assert.match(r.calls, /^docker buildx imagetools inspect ghcr\.io\/jonathanmcohen\/platehouse-slicer:orca-2\.5\.1 /m);
    if (want.fail) {
      assert.notEqual(r.status, 0, r.log);
      assert.match(r.log, want.fail);
      assert.equal(r.outputs.build, undefined);
    } else {
      assert.equal(r.status, 0, r.log);
      assert.equal(r.outputs.build, want.build);
      if (want.upToDate) assert.match(r.summary, /Up to date/);
    }
  });
}

test("slicer-image: detect logs in to GHCR on daily runs only, and hands its stable decision to the tag step", () => {
  const detect = jobBlock(slicerText(), "detect");
  const login = stepBlock(detect, "Log in to GHCR");
  assert.match(login, /\n {8}if: \$\{\{ github\.event_name == 'schedule' \}\}\n/);
  assert.ok(detect.includes("\n      stable: ${{ steps.pick.outputs.stable }}\n"), "detect outputs stable");
  const stable = jobBlock(slicerText(), "stable");
  assert.ok(stable.includes("needs.detect.outputs.stable == 'true'"), "the stable job runs on detect's decision");
  const tag = stepBlock(jobBlock(slicerText(), "build"), "Tag the image");
  // The tag step checks the decision, so an empty one fails the build instead of skipping stable silently.
  assert.match(tag, /\n {10}MOVE_STABLE: \$\{\{ needs\.detect\.outputs\.stable \}\}\n/);
  assert.doesNotMatch(tag, /:stable/, "the tag step never moves stable");
  assert.ok(detect.includes("\n      release: ${{ steps.pick.outputs.release }}\n"), "detect outputs release");
  assert.match(tag, /\n {10}RELEASE: \$\{\{ needs\.detect\.outputs\.release \}\}\n/);
});

// The maintainer, 2026-11-15: a report-only Trivy scan of the built image before any
// push, at release.yml's action and Trivy version; it can never fail the job.
const SLICER_TRIVY = "Trivy report (informational, does not fail the job)";

test("slicer-image: the Trivy report runs before any push and cannot fail the job", () => {
  const job = jobBlock(slicerText(), "build");
  const step = stepBlock(job, SLICER_TRIVY);
  const ours = stepInputs(step);
  const gate = stepInputs(stepBlock(readFileSync(RELEASE, "utf8"), TRIVY_GATE));
  assert.equal(ours.uses, gate.uses, "the same action at the same tag as release.yml");
  assert.equal(ours.inputs.version, gate.inputs.version, "the same Trivy version as release.yml");
  assert.deepEqual(ours.inputs, {
    "image-ref": "${{ env.LOCAL }}",
    severity: "HIGH,CRITICAL",
    "ignore-unfixed": "true",
    "exit-code": '"0"',
    format: "table",
    "cache-dir": "${{ runner.temp }}/trivy-cache",
    version: gate.inputs.version,
  });
  // Two guards: findings never set a failing exit code, and an error in the
  // action itself (a database download) does not fail the job either.
  assert.match(step, /\n {8}continue-on-error: true\n/);
  assert.doesNotMatch(step, /\n {8}if:/, "it runs whenever the smoke slice passed");
  // No id: its outcome must never be taken for the step that failed the job.
  assert.doesNotMatch(step, /\n {8}id:/);
  const steps = jobSteps(job);
  const at = (name) => steps.findIndex((s) => s.startsWith(`      - name: ${name}\n`));
  assert.ok(at("Smoke slice") < at(SLICER_TRIVY), "after the smoke slice");
  assert.ok(at(SLICER_TRIVY) < at("Log in to GHCR"), "before the login");
  assert.ok(at(SLICER_TRIVY) < at("Push by digest"), "before the push");
  assert.equal(steps.filter((s) => /\n {8}uses: aquasecurity\/trivy-action@/.test(s)).length, 1, "one Trivy step, and no gate");
});

// Both builds take the version and the two resolved pins from detect; the load
// build is tagged locally, the push goes by digest with no tag.
test("slicer-image: both builds pass ORCA_VERSION, ORCA_SHA256 and ORCA_SRC_SHA from detect", () => {
  const job = jobBlock(slicerText(), "build");
  const builds = jobSteps(job).filter((s) => /\n {8}uses: docker\/build-push-action@/.test(s));
  assert.equal(builds.length, 2, "the load build and the push by digest");
  const [load, push] = builds;
  const want = [
    "ORCA_VERSION=${{ needs.detect.outputs.version }}",
    "ORCA_SHA256=${{ needs.detect.outputs.orca_sha256 }}",
    "ORCA_SRC_SHA=${{ needs.detect.outputs.orca_src_sha }}",
  ];
  for (const b of builds) {
    assert.deepEqual(buildArgs(b), want);
    const { inputs } = stepInputs(b);
    assert.equal(inputs.file, "apps/slicer/Dockerfile");
    assert.equal(inputs.context, ".");
    assert.equal(inputs.platforms, "linux/amd64", "amd64 only");
    assert.equal(inputs.provenance, "false", "no build attestation");
    // stepInputs stops at the multi-line build-args, so the cache lines are
    // read directly.
    assert.match(b, /\n {10}cache-from: type=gha,scope=slicer-image\n/);
    assert.match(b, /\n {10}cache-to: type=gha,mode=max,scope=slicer-image\n/);
  }
  assert.match(load, /\n {8}id: load\n/);
  assert.equal(stepInputs(load).inputs.load, "true");
  assert.equal(stepInputs(load).inputs.tags, "${{ env.LOCAL }}");
  assert.match(push, /\n {8}id: push\n/);
  assert.equal(
    stepInputs(push).inputs.outputs,
    "type=image,name=${{ env.IMAGE }},push-by-digest=true,name-canonical=true,push=true",
  );
  assert.equal(stepInputs(push).inputs.tags, undefined, "the push carries no tag");
  for (const [k, v] of [
    ["detect", "version: ${{ steps.pick.outputs.version }}"],
    ["detect", "orca_sha256: ${{ steps.pins.outputs.orca_sha256 }}"],
    ["detect", "orca_src_sha: ${{ steps.pins.outputs.orca_src_sha }}"],
    ["detect", "build: ${{ steps.registry.outputs.build }}"],
  ]) {
    assert.ok(jobBlock(slicerText(), k).includes(`\n      ${v}\n`), `${k} outputs ${v}`);
  }
});

// The slicer image's OCI labels (the 0.1.1-rc.1 live check): its
// org.opencontainers.image.version read 24.04, inherited from the Ubuntu
// base, and its revision was empty. Both builds now take the labels
// docker/metadata-action computes, as release.yml's app image does (issue
// #317): the version is the release's on a run from a release tag (the
// semver entry, as in release.yml) and the Orca version on any other run
// (the raw entry, enabled only when detect found no release tag). The title
// and description are the slicer's own, not the repository's.
const SLICER_LABELS = "Labels for this image";
const SLICER_LABEL_CHECK = "Check the labels";

test("slicer-image labels: both builds carry metadata-action's labels, the version from the release tag or the Orca version", () => {
  const job = jobBlock(slicerText(), "build");
  const step = stepBlock(job, SLICER_LABELS);
  assert.match(step, /\n {8}id: labels\n/);
  assert.match(step, /\n {8}uses: docker\/metadata-action@dc802804100637a589fabce1cb79ff13a1411302 # v6\.2\.0\n/, "the action and tag release.yml uses");
  assert.match(step, /\n {10}images: \$\{\{ env\.IMAGE \}\}\n/);
  const block = (key) => {
    const m = step.match(new RegExp(`\\n {10}${key}: \\|\\n((?: {12}.+\\n)+)`));
    assert.ok(m, `${key}: | in\n${step}`);
    return m[1].trimEnd().split("\n").map((l) => l.trim());
  };
  assert.deepEqual(block("tags"), [
    "type=semver,pattern={{version}}",
    "type=raw,value=${{ needs.detect.outputs.version }},enable=${{ needs.detect.outputs.release == '' }}",
  ]);
  const labels = block("labels");
  assert.deepEqual(
    labels.map((l) => l.split("=")[0]),
    ["org.opencontainers.image.title", "org.opencontainers.image.description"],
  );
  assert.equal(labels[0], "org.opencontainers.image.title=platehouse-slicer");
  assert.doesNotMatch(step, /\n {8}(if|continue-on-error):/);
  const builds = jobSteps(job).filter((s) => /\n {8}uses: docker\/build-push-action@/.test(s));
  assert.equal(builds.length, 2);
  for (const b of builds) {
    assert.equal(stepInputs(b).inputs.labels, "${{ steps.labels.outputs.labels }}", "the same labels on the tested build and the push");
  }
  const steps = jobSteps(job);
  const at = (name) => steps.findIndex((s) => s.startsWith(`      - name: ${name}\n`));
  assert.ok(at(SLICER_LABELS) < at("Build (load)"), "the labels are computed before the first build");
});

test("slicer-image labels: the loaded image's labels are checked after the smoke slice and before anything is pushed", () => {
  const job = jobBlock(slicerText(), "build");
  const step = stepBlock(job, SLICER_LABEL_CHECK);
  assert.match(step, /\n {8}id: labelcheck\n/);
  assert.doesNotMatch(step, /\n {8}(if|continue-on-error):/, "nothing softens the check");
  assert.match(step, /\n {10}LABELS_VERSION: \$\{\{ steps\.labels\.outputs\.version \}\}\n/);
  assert.match(step, /\n {10}RELEASE: \$\{\{ needs\.detect\.outputs\.release \}\}\n/);
  assert.match(stepScript(job, SLICER_LABEL_CHECK), /docker\/check-image-labels\.sh local "\$LOCAL" "\$want" "\$GITHUB_SHA"/);
  const ids = stepIds(job);
  assert.ok(ids.indexOf("smoke") < ids.indexOf("labelcheck"), "after the smoke slice");
  assert.ok(ids.indexOf("labelcheck") < ids.indexOf("login"), "before the login");
  assert.ok(ids.indexOf("labelcheck") < ids.indexOf("push"), "before the push");
});

// The check step, run in bash at the repo root with a stub docker (exported,
// so docker/check-image-labels.sh, a script of its own, runs it too) that
// answers the loaded image's labels.
const SLICER_SOURCE = "https://github.com/jonathanmcohen/platehouse";
const SLICER_REVISION = "0123456789abcdef0123456789abcdef01234567";
const slicerLabels = (version, over = {}) => ({
  "org.opencontainers.image.created": "2026-11-22T05:00:00.000Z",
  "org.opencontainers.image.description": "OrcaSlicer and OpenSCAD behind the Platehouse slicer API",
  "org.opencontainers.image.licenses": "AGPL-3.0",
  "org.opencontainers.image.revision": SLICER_REVISION,
  "org.opencontainers.image.source": SLICER_SOURCE,
  "org.opencontainers.image.title": "platehouse-slicer",
  "org.opencontainers.image.url": SLICER_SOURCE,
  "org.opencontainers.image.version": version,
  ...over,
});
// The step's name is written out, not SLICER_LABEL_CHECK, so the gate's path
// scan (STEP_RUNNERS) can read which step runs at the repo root.
const labelCheck = (env, labels) =>
  runSlicerStep("build", "Check the labels", {
    cwd: ROOT,
    stubs: [
      `docker() { echo "docker $*" >> "$CALLS"; printf '%s' '${JSON.stringify(labels)}'; }`,
      "export -f docker",
    ],
    env: {
      LOCAL: "platehouse-slicer:smoke",
      GITHUB_SHA: SLICER_REVISION,
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "jonathanmcohen/platehouse",
      ...env,
    },
  });

for (const [name, env, labels, want] of [
  ["a release tag's run passes with the release's version", { RELEASE: "0.1.1-rc.2", VERSION: "2.5.0", LABELS_VERSION: "0.1.1-rc.2" }, slicerLabels("0.1.1-rc.2"), { ok: true }],
  ["a daily run passes with the Orca version", { RELEASE: "", VERSION: "2.5.0", LABELS_VERSION: "2.5.0" }, slicerLabels("2.5.0"), { ok: true }],
  ["the Ubuntu base's 24.04 fails, naming the version label", { RELEASE: "0.1.1-rc.2", VERSION: "2.5.0", LABELS_VERSION: "0.1.1-rc.2" }, slicerLabels("24.04"), { fail: /org\.opencontainers\.image\.version is '24\.04', not '0\.1\.1-rc\.2'/ }],
  ["an empty revision fails, naming it", { RELEASE: "", VERSION: "2.5.0", LABELS_VERSION: "2.5.0" }, slicerLabels("2.5.0", { "org.opencontainers.image.revision": "" }), { fail: /org\.opencontainers\.image\.revision is '', not '0123456789abcdef/ }],
  ["a release tag's run whose labels say the Orca version fails before docker", { RELEASE: "0.1.1-rc.2", VERSION: "2.5.0", LABELS_VERSION: "2.5.0" }, slicerLabels("2.5.0"), { fail: /gave the version '2\.5\.0', not '0\.1\.1-rc\.2'/, noDocker: true }],
  ["no version from metadata-action fails before docker", { RELEASE: "", VERSION: "2.5.0", LABELS_VERSION: "" }, slicerLabels("2.5.0"), { fail: /gave the version '', not '2\.5\.0'/, noDocker: true }],
]) {
  test(`slicer-image label check: ${name}`, () => {
    const r = labelCheck(env, labels);
    if (want.ok) {
      assert.equal(r.status, 0, r.log);
      assert.match(r.calls, /^docker image inspect --format \{\{json \.Config\.Labels\}\} platehouse-slicer:smoke\n$/);
    } else {
      assert.notEqual(r.status, 0, r.log);
      assert.match(r.log, want.fail);
      if (want.noDocker) assert.equal(r.calls, "", "docker is not asked");
      assert.match(r.logs["labelcheck.log"] ?? "", want.fail, "the step keeps its log for the failure issue");
    }
  });
}

// Nothing reaches the registry before the smoke slice passed, test code never
// runs with registry credentials on disk, and no tag exists before the
// pushed-image check passed.
test("slicer-image: build, smoke slice, login, push, check, then tag, in that order", () => {
  const job = jobBlock(slicerText(), "build");
  const ids = stepIds(job);
  const order = ["load", "smoke", "login", "push", "check", "tag"];
  assert.deepEqual(
    ids.filter((i) => order.includes(i)),
    order,
  );
  const at = (id) => job.indexOf(`\n        id: ${id}\n`);
  for (let i = 1; i < order.length; i++) assert.ok(at(order[i - 1]) < at(order[i]), `${order[i - 1]} before ${order[i]}`);
  assert.equal((slicerText().match(/docker buildx imagetools create/g) ?? []).length, 2, "the tag step and the stable job alone create tags");
  const tag = stepBlock(job, "Tag the image");
  assert.equal((tag.match(/docker buildx imagetools create/g) ?? []).length, 1);
  for (const id of ["smoke", "check", "tag"]) {
    const s = jobSteps(job).find((x) => x.includes(`\n        id: ${id}\n`));
    assert.doesNotMatch(s, /\n {8}(if|continue-on-error):/, `nothing softens ${id}`);
  }
});

// New OrcaSlicer versions pass the whole container suite before anything is
// published (issue #440): the smoke step stays as it is, and a step after it
// fetches the STEP sample and runs every container test against the built image.
test("slicer-image: the whole container suite runs on the built image before anything is pushed (issue #440)", () => {
  const job = jobBlock(slicerText(), "build");
  const steps = jobSteps(job);
  const at = (name) => steps.findIndex((s) => s.startsWith(`      - name: ${name}\n`));
  // Comment lines between steps belong to the step before; drop them.
  const code = (b) => b.split("\n").filter((l) => !/^ {6}#/.test(l)).join("\n").trimEnd();
  const fetchStep = code(stepBlock(job, "Fetch the STEP sample"));
  const ciFetch = code(stepBlock(jobBlock(text(), "slicer-image"), "Fetch the STEP sample"));
  assert.equal(fetchStep, ciFetch, "the STEP sample is fetched exactly as ci.yml does");
  const suite = stepBlock(job, "Whole container suite");
  assert.match(suite, /\n {10}SLICER_IMAGE: \$\{\{ env\.LOCAL \}\}\n/);
  assert.match(suite, /\n {10}SLICER_IMAGE_PREBUILT: "1"\n/);
  // The suite checks the image reports the Orca version this run built, not
  // the Dockerfile's pin (apps/slicer/test/support/orca-version.ts).
  assert.match(suite, /\n {10}EXPECTED_ORCA_VERSION: \$\{\{ needs\.detect\.outputs\.version \}\}\n/);
  assert.match(suite, /vitest run --project container --reporter=default --reporter=json --outputFile=suite-report\.json/);
  assert.doesNotMatch(suite, /vitest run --project container \S*\.test\.ts/, "no file filter");
  assert.match(suite, /No tests ran \(vitest wrote no report\)/);
  assert.match(suite, /if \[ "\$ran" -eq 0 \]/);
  assert.doesNotMatch(suite, /\n {8}(if|continue-on-error):/);
  assert.ok(at("Smoke slice") < at("Fetch the STEP sample"), "after the smoke slice");
  assert.ok(at("Fetch the STEP sample") < at("Whole container suite"), "the sample is fetched first");
  for (const later of [SLICER_TRIVY, "Log in to GHCR", "Push by digest", "Tag the image"]) {
    assert.ok(at("Whole container suite") < at(later), `before ${later}`);
  }
  // The smoke step keeps force_fail.
  assert.match(stepBlock(job, "Smoke slice"), /FORCE_FAIL: \$\{\{ inputs\.force_fail \}\}/);
  assert.doesNotMatch(suite, /FORCE_FAIL/);
});

// The pushed-image check, as in release.yml: manifest digests from the digest
// output of both builds, never imageid (PR #217).
test("slicer-image: the push fails unless its manifest digest is the smoke-sliced build's", () => {
  const check = stepBlock(jobBlock(slicerText(), "build"), "Check the pushed image is the one tested");
  assert.match(check, /\n {10}TESTED: \$\{\{ steps\.load\.outputs\.digest \}\}\n/);
  assert.match(check, /\n {10}PUSHED: \$\{\{ steps\.push\.outputs\.digest \}\}\n/);
  assert.doesNotMatch(slicerText(), /outputs\.imageid/, "imageid is never read");
  const run = (env) => runSlicerStep("build", "Check the pushed image is the one tested", { env });
  const a = `sha256:${sha("a")}`;
  const b = `sha256:${sha("b")}`;
  assert.equal(run({ TESTED: a, PUSHED: a }).status, 0, "the same manifest digest passes");
  for (const [why, env] of [
    ["a different manifest digest", { TESTED: a, PUSHED: b }],
    ["no pushed manifest digest", { TESTED: a, PUSHED: "" }],
    ["no tested manifest digest", { TESTED: "", PUSHED: a }],
    ["manifest digests that are not sha256 digests", { TESTED: "x", PUSHED: "x" }],
  ]) {
    const r = run(env);
    assert.notEqual(r.status, 0, `${why} fails the job`);
    assert.match(r.log, /::error::/, `${why} prints an error annotation`);
  }
  // The digests release run 43724090714 logged for one image through the OCI
  // and docker exporters (amd64): the digest output agrees, imageid does not.
  const amd64 = MIXED_EXPORTER_RUN.amd64;
  assert.equal(
    run({ TESTED: buildOutputs(amd64.load.metadata).digest, PUSHED: buildOutputs(amd64.push.metadata).digest }).status,
    0,
  );
});

// Tagging: orca-X.Y.Z and orca-X.Y.Z-r<run> first, read back, then stable, read
// back; each a carbon copy of the pushed digest.
const DOCKER_TAG_STUB = [
  "docker() {",
  '  echo "docker $*" >> "$CALLS"',
  '  if [ "$1 $2 $3" = "buildx imagetools inspect" ]; then',
  '    case "$4" in',
  '      *:stable) echo "$D_STABLE" ;;',
  '      *:[0-9]*) echo "$D_RELEASE" ;;',
  '      *-r[0-9]*) echo "$D_RUN" ;;',
  '      *) echo "$D_ORCA" ;;',
  "    esac",
  "  fi",
  "}",
];
const IMG = "ghcr.io/jonathanmcohen/platehouse-slicer";
const DIGEST = `sha256:${sha("d")}`;
const tagRun = (env) =>
  runSlicerStep("build", "Tag the image", {
    stubs: DOCKER_TAG_STUB,
    env: { VERSION: "2.5.1", RUN_NUMBER: "42", RUN_ATTEMPT: "1", MOVE_ORCA: "true", MOVE_STABLE: "true", RELEASE: "", DIGEST, D_ORCA: DIGEST, D_RUN: DIGEST, D_RELEASE: DIGEST, ...env },
  });

// Issue #221: a re-run keeps github.run_number, so attempt 1 keeps
// orca-X.Y.Z-r<run> (the format existing tags and pins use) and a later
// attempt tags orca-X.Y.Z-r<run>.<attempt>, leaving the first attempt's tag on
// the image it named.
test("slicer-image tag: a re-run tags orca-X.Y.Z-r<run>.<attempt>, never the first attempt's tag (issue #221)", () => {
  const r = tagRun({ RUN_ATTEMPT: "2" });
  assert.equal(r.status, 0, r.log);
  assert.deepEqual(r.calls.trim().split("\n").slice(0, 3), [
    `docker buildx imagetools create --prefer-index=false -t ${IMG}:orca-2.5.1 -t ${IMG}:orca-2.5.1-r42.2 ${IMG}@${DIGEST}`,
    `docker buildx imagetools inspect ${IMG}:orca-2.5.1 --format {{.Manifest.Digest}}`,
    `docker buildx imagetools inspect ${IMG}:orca-2.5.1-r42.2 --format {{.Manifest.Digest}}`,
  ]);
  assert.doesNotMatch(r.calls, /orca-2\.5\.1-r42 /, "the first attempt's tag is not touched");
  assert.equal(r.outputs.tagged, "orca-2.5.1, orca-2.5.1-r42.2");
  assert.match(r.summary, /- tags: orca-2\.5\.1, orca-2\.5\.1-r42\.2\n/);
  assert.equal(tagRun({ RUN_ATTEMPT: "10" }).outputs.tagged, "orca-2.5.1, orca-2.5.1-r42.10");
});

test("slicer-image tag: a missing or malformed run attempt tags nothing", () => {
  for (const attempt of ["", "0", "x", "2;y", "02"]) {
    const r = tagRun({ RUN_ATTEMPT: attempt });
    assert.notEqual(r.status, 0, `attempt '${attempt}' fails`);
    assert.match(r.log, /::error::/);
    assert.equal(r.calls.trim(), "", `attempt '${attempt}' calls no docker`);
    assert.equal(r.outputs.tagged, undefined);
  }
});

test("slicer-image tag: the step reads the run attempt from github.run_attempt", () => {
  const tag = stepBlock(jobBlock(slicerText(), "build"), "Tag the image");
  assert.match(tag, /\n {10}RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}\n/);
});

test("slicer-image tag: the version tags are carbon copies of the tested digest, and stable is left to its own job", () => {
  const r = tagRun({});
  assert.equal(r.status, 0, r.log);
  const calls = r.calls.trim().split("\n");
  assert.deepEqual(calls, [
    `docker buildx imagetools create --prefer-index=false -t ${IMG}:orca-2.5.1 -t ${IMG}:orca-2.5.1-r42 ${IMG}@${DIGEST}`,
    `docker buildx imagetools inspect ${IMG}:orca-2.5.1 --format {{.Manifest.Digest}}`,
    `docker buildx imagetools inspect ${IMG}:orca-2.5.1-r42 --format {{.Manifest.Digest}}`,
  ]);
  assert.doesNotMatch(r.calls, /:stable/, "the tag step never touches stable");
  assert.match(r.summary, /- tags: orca-2\.5\.1, orca-2\.5\.1-r42\n/);
});

// The release's version tag goes in the same create as the orca tags, is
// read back, and is listed in tagged for the failure issue.
test("slicer-image tag: a run from a release tag also tags the release's version, read back", () => {
  const r = tagRun({ RELEASE: "0.2.0-rc.1" });
  assert.equal(r.status, 0, r.log);
  assert.deepEqual(r.calls.trim().split("\n"), [
    `docker buildx imagetools create --prefer-index=false -t ${IMG}:orca-2.5.1 -t ${IMG}:orca-2.5.1-r42 -t ${IMG}:0.2.0-rc.1 ${IMG}@${DIGEST}`,
    `docker buildx imagetools inspect ${IMG}:orca-2.5.1 --format {{.Manifest.Digest}}`,
    `docker buildx imagetools inspect ${IMG}:orca-2.5.1-r42 --format {{.Manifest.Digest}}`,
    `docker buildx imagetools inspect ${IMG}:0.2.0-rc.1 --format {{.Manifest.Digest}}`,
  ]);
  assert.equal(r.outputs.tagged, "orca-2.5.1, orca-2.5.1-r42, 0.2.0-rc.1");
  assert.match(r.summary, /- tags: orca-2\.5\.1, orca-2\.5\.1-r42, 0\.2\.0-rc\.1\n/);
  const plain = tagRun({ RELEASE: "0.2.0" });
  assert.equal(plain.status, 0, plain.log);
  assert.equal(plain.outputs.tagged, "orca-2.5.1, orca-2.5.1-r42, 0.2.0");
});

test("slicer-image tag: the release's version tag read back at another digest fails", () => {
  const r = tagRun({ RELEASE: "0.2.0-rc.1", D_RELEASE: `sha256:${sha("e")}` });
  assert.notEqual(r.status, 0, r.log);
  assert.match(r.log, /::error::.*:0\.2\.0-rc\.1 is sha256:e+, not/);
    assert.equal(r.outputs.tagged, "orca-2.5.1, orca-2.5.1-r42, 0.2.0-rc.1");
});

for (const release of ["v0.2.0", "0.2", "0.2.0;id", "01.2.0", "0.2.0 -t x", `0.2.0-${"a".repeat(130)}`]) {
  test(`slicer-image tag: a malformed release version '${release.slice(0, 20)}' tags nothing`, () => {
    const r = tagRun({ RELEASE: release });
    assert.notEqual(r.status, 0, r.log);
    assert.match(r.log, /::error::the release version .* is malformed/);
    assert.equal(r.calls, "", "no docker call");
    assert.equal(r.outputs.tagged, undefined);
  });
}

test("slicer-image tag: a prerelease tag's run pushes the run tag and the release version and leaves orca-X.Y.Z and stable alone", () => {
  const r = tagRun({ MOVE_ORCA: "false", RELEASE: "0.2.0-rc.1" });
  assert.equal(r.status, 0, r.log);
  assert.deepEqual(r.calls.trim().split("\n"), [
    `docker buildx imagetools create --prefer-index=false -t ${IMG}:orca-2.5.1-r42 -t ${IMG}:0.2.0-rc.1 ${IMG}@${DIGEST}`,
    `docker buildx imagetools inspect ${IMG}:orca-2.5.1-r42 --format {{.Manifest.Digest}}`,
    `docker buildx imagetools inspect ${IMG}:0.2.0-rc.1 --format {{.Manifest.Digest}}`,
  ]);
  assert.doesNotMatch(r.calls, /:stable/, "stable is neither moved nor read");
  assert.doesNotMatch(r.calls, /:orca-2\.5\.1[ \n]/, "orca-X.Y.Z is neither moved nor read");
  assert.match(r.summary, /- tags: orca-2\.5\.1-r42, 0\.2\.0-rc\.1\n- orca-2\.5\.1 and stable not moved \(a prerelease tag, or a release below the highest one\)/);
  // The summary says what will move them.
  assert.match(r.summary, /next daily run builds orca-2\.5\.1 if it does not exist yet/);
  assert.match(r.summary, /plain release tag or a run by hand/);
});

// Issue #435: an rc tag's run built the latest Orca release and moved
// orca-X.Y.Z, which a deployment pins, onto the rc's slicer. A prerelease tag
// now leaves orca-X.Y.Z alone as well as stable; a plain release tag, a run by
// hand and the daily run move it as before.
test("slicer-image: detect decides whether orca-X.Y.Z moves, and the tag step reads it (issue #435)", () => {
  const detect = jobBlock(slicerText(), "detect");
  assert.ok(detect.includes("\n      orca: ${{ steps.pick.outputs.orca }}\n"), "detect outputs orca");
  const pick = stepBlock(detect, "Pick the version");
  assert.match(pick, /echo "orca=\$\{orca\}" >>"\$GITHUB_OUTPUT"/, "the pick step writes orca= to GITHUB_OUTPUT");
  const prerelease = pick.slice(pick.indexOf("stable=false"));
  assert.match(prerelease.slice(0, prerelease.indexOf("fi")), /orca=false/, "the prerelease branch sets orca=false");
  const tag = stepBlock(jobBlock(slicerText(), "build"), "Tag the image");
  assert.match(tag, /\n {10}MOVE_ORCA: \$\{\{ needs\.detect\.outputs\.orca \}\}\n/);
  assert.doesNotMatch(tag, /-t "\$\{IMAGE\}:orca-\$\{VERSION\}"/, "the orca tag is never passed unconditionally");
});

test("slicer-image tag: a prerelease tag's run leaves orca-X.Y.Z alone and reads back only what it made (issue #435)", () => {
  const r = tagRun({ MOVE_ORCA: "false", RELEASE: "0.2.0-rc.1" });
  assert.equal(r.status, 0, r.log);
  assert.deepEqual(r.calls.trim().split("\n"), [
    `docker buildx imagetools create --prefer-index=false -t ${IMG}:orca-2.5.1-r42 -t ${IMG}:0.2.0-rc.1 ${IMG}@${DIGEST}`,
    `docker buildx imagetools inspect ${IMG}:orca-2.5.1-r42 --format {{.Manifest.Digest}}`,
    `docker buildx imagetools inspect ${IMG}:0.2.0-rc.1 --format {{.Manifest.Digest}}`,
  ]);
  assert.equal(r.outputs.tagged, "orca-2.5.1-r42, 0.2.0-rc.1");
  assert.match(r.summary, /- tags: orca-2\.5\.1-r42, 0\.2\.0-rc\.1\n/);
});

test("slicer-image tag: a plain release tag's run still moves orca-X.Y.Z", () => {
  const r = tagRun({ MOVE_ORCA: "true", RELEASE: "0.2.0" });
  assert.equal(r.status, 0, r.log);
  assert.match(r.calls, new RegExp(`-t ${IMG}:orca-2\\.5\\.1 -t ${IMG}:orca-2\\.5\\.1-r42 -t ${IMG}:0\\.2\\.0 `));
  assert.equal(r.outputs.tagged, "orca-2.5.1, orca-2.5.1-r42, 0.2.0");
});

for (const bad of ["", "yes"]) {
  test(`slicer-image tag: an orca decision of '${bad}' from detect tags nothing`, () => {
    const r = tagRun({ MOVE_ORCA: bad });
    assert.notEqual(r.status, 0, r.log);
    assert.match(r.log, /::error::detect gave no orca decision/);
    assert.equal(r.calls, "", "no docker call");
  });
}

// The tags the step pointed (or was pointing) at the digest, as the output the
// failure issue reads. Each is recorded before its imagetools create, so a
// create that fails part way still counts.
for (const [name, env, want] of [
  ["a full run records every tag", {}, "orca-2.5.1, orca-2.5.1-r42"],
  ["a prerelease run records the run tag and the release version", { MOVE_ORCA: "false", RELEASE: "0.2.0-rc.1" }, "orca-2.5.1-r42, 0.2.0-rc.1"],
  ["a version tag read back wrong records the two version tags", { D_ORCA: `sha256:${sha("e")}` }, "orca-2.5.1, orca-2.5.1-r42"],
  ["no digest records nothing", { DIGEST: "" }, undefined],
  ["no stable decision records nothing", { MOVE_STABLE: "" }, undefined],
]) {
  test(`slicer-image tag records what it tagged: ${name}`, () => {
    const r = tagRun(env);
    assert.equal(r.outputs.tagged, want, r.log);
  });
}

test("slicer-image: the build job hands the tags and digest to the failure issue", () => {
  const t = slicerText();
  const build = jobBlock(t, "build");
  assert.match(build, /\n {4}outputs:\n/);
  assert.ok(build.includes("\n      tagged: ${{ steps.tag.outputs.tagged }}\n"), "build outputs tagged");
  assert.ok(build.includes("\n      digest: ${{ steps.push.outputs.digest }}\n"), "build outputs digest");
  const issue = stepBlock(jobBlock(t, "report-failure"), "Open or update the issue");
  assert.ok(
    issue.includes("\n          TAGGED: ${{ needs.stable.outputs.tagged || needs.build.outputs.tagged }}\n"),
    "the stable job's list, which ends with stable, wins once it began",
  );
  assert.match(issue, /\n {10}DIGEST: \$\{\{ needs\.build\.outputs\.digest \}\}\n/);
  assert.match(issue, /\n {10}STABLE: \$\{\{ needs\.detect\.outputs\.stable \}\}\n/);
});

for (const [name, env, want] of [
  ["a version tag read back at another digest leaves stable alone", { D_ORCA: `sha256:${sha("e")}` }, { stable: false }],
  ["a run tag read back at another digest leaves stable alone", { D_RUN: `sha256:${sha("e")}` }, { stable: false }],
  ["no digest fails before any tag", { DIGEST: "" }, { stable: false, noCall: true }],
  ["a malformed version fails before any tag", { VERSION: "2.5.1-beta" }, { stable: false, noCall: true }],
  ["no stable decision from detect fails before any tag", { MOVE_STABLE: "" }, { stable: false, noCall: true }],
  ["a stable decision that is not true or false fails before any tag", { MOVE_STABLE: "yes" }, { stable: false, noCall: true }],
]) {
  test(`slicer-image tag: ${name}`, () => {
    const r = tagRun(env);
    assert.notEqual(r.status, 0, r.log);
    assert.match(r.log, /::error::/);
    assert.equal(r.calls.includes(`-t ${IMG}:stable`), want.stable, "whether stable was moved");
    if (want.noCall) assert.equal(r.calls, "", "no docker call");
  });
}

// Issue #451: stable moves in a job of its own, after the build and the tags,
// in a group shared by every ref, so two runs never move it together while a
// tag run no longer waits behind (or replaces) a scheduled one.
test("slicer-image: the stable job runs after a successful build that detect said moves stable (issue #451)", () => {
  const stable = jobBlock(slicerText(), "stable");
  assert.match(stable, /\n {4}needs: \[detect, build\]\n/);
  assert.ok(
    stable.includes("if: ${{ !cancelled() && needs.build.result == 'success' && needs.detect.outputs.stable == 'true' }}"),
    "only after the build succeeded, and only when detect says stable moves",
  );
  const move = stepBlock(stable, "Move stable");
  assert.match(move, /\n {10}DIGEST: \$\{\{ needs\.build\.outputs\.digest \}\}\n/);
  assert.ok(stepIds(stable).indexOf("login") < stepIds(stable).indexOf("move"), "log in before the move");
  assert.equal((stable.match(/docker buildx imagetools create/g) ?? []).length, 1, "one create, for stable");
  assert.doesNotMatch(move, /\n {8}continue-on-error:/, "nothing softens the move");
  assert.match(move, /\n {8}if: \$\{\{ steps\.recheck\.outputs\.move != 'false' \}\}\n/, "only the live highest-release check can skip it");
  // A failed move keeps its log tail for the issue, as the build does.
  assert.match(stepBlock(stable, "Keep the failing step's log tail"), /failure\/stable\.txt/);
  assert.match(stepBlock(stable, "Upload the log tail"), /\n {10}name: failure-stable\n {10}path: failure\/stable\.txt\n/);
  const issue = stepBlock(jobBlock(slicerText(), "report-failure"), "Open or update the issue");
  assert.ok(issue.includes("failure/detect.txt failure/build.txt failure/stable.txt"), "the issue reads the stable tail");
});

const stableRun = (env) =>
  runSlicerStep("stable", "Move stable", {
    stubs: DOCKER_TAG_STUB,
    env: { DIGEST, BUILD_TAGGED: "orca-2.5.1, orca-2.5.1-r42", D_STABLE: DIGEST, ...env },
  });

test("slicer-image stable: stable becomes a carbon copy of the tested digest, read back, and is listed for the failure issue", () => {
  const r = stableRun({});
  assert.equal(r.status, 0, r.log);
  assert.deepEqual(r.calls.trim().split("\n"), [
    `docker buildx imagetools create --prefer-index=false -t ${IMG}:stable ${IMG}@${DIGEST}`,
    `docker buildx imagetools inspect ${IMG}:stable --format {{.Manifest.Digest}}`,
  ]);
  assert.equal(r.outputs.tagged, "orca-2.5.1, orca-2.5.1-r42, stable");
  assert.match(r.summary, new RegExp(`stable now points at \`${DIGEST}\``));
});

// The recheck, from the live tags just before stable moves: a tag run moves
// stable only while it is still the highest release.
const recheck = (env) =>
  runSlicerStep("stable", "Still the highest release", {
    cwd: ROOT,
    stubs: GH_RELEASES_STUB,
    env: { TAG: "v0.2.0", REPO: "o/r", ...env },
  });

test("slicer-image stable: the recheck lets the highest release move stable", () => {
  const r = recheck({ MATCHING_REFS: "refs/tags/v0.1.0\nrefs/tags/v0.2.0\nrefs/tags/v0.3.0-rc.1\n" });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.outputs.move, "true");
});

test("slicer-image stable: the recheck stops a tag a higher release has passed since detect", () => {
  const r = recheck({ MATCHING_REFS: "refs/tags/v0.2.0\nrefs/tags/v0.3.0\n" });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.outputs.move, "false");
  assert.match(r.log, /no longer the highest release/);
});

test("slicer-image stable: a failed tag lookup fails the recheck, so nothing moves", () => {
  const r = recheck({ GH_STATUS: "1" });
  assert.notEqual(r.status, 0, r.log);
  assert.equal(r.outputs.move, undefined);
});

test("slicer-image stable: stable read back at another digest fails, and is still listed as touched", () => {
  const r = stableRun({ D_STABLE: `sha256:${sha("e")}` });
  assert.notEqual(r.status, 0, r.log);
  assert.match(r.log, /::error::.*:stable is sha256:e+, not/);
  assert.equal(r.outputs.tagged, "orca-2.5.1, orca-2.5.1-r42, stable");
});

for (const digest of ["", "sha256:abc", `${DIGEST};id`]) {
  test(`slicer-image stable: a digest of '${digest.slice(0, 12)}' moves nothing`, () => {
    const r = stableRun({ DIGEST: digest });
    assert.notEqual(r.status, 0, r.log);
    assert.match(r.log, /::error::/);
    assert.equal(r.calls, "", "no docker call");
    assert.equal(r.outputs.tagged, undefined);
  });
}

// The smoke slice: the container harness against the image the load build
// made, every plate of both generated fixtures; the same zero-test guard as
// ci.yml; force_fail fails it on purpose after it ran.
const PNPM_STUB = [
  "pnpm() {",
  '  echo "pnpm $*" >> "$CALLS"',
  '  echo "SLICER_IMAGE=$SLICER_IMAGE SLICER_IMAGE_PREBUILT=$SLICER_IMAGE_PREBUILT" >> "$CALLS"',
  '  if [ -n "$REPORT" ]; then printf "%s" "$REPORT" > smoke-report.json; fi',
  '  return "$VITEST_STATUS"',
  "}",
];
const smokeRun = (env) =>
  runSlicerStep("build", "Smoke slice", {
    stubs: PNPM_STUB,
    env: { VERSION: "2.5.1", SLICER_IMAGE: "platehouse-slicer:smoke", SLICER_IMAGE_PREBUILT: "1", FORCE_FAIL: "", VITEST_STATUS: "0", ...env },
  });

test("slicer-image smoke: the step runs the smoke test file against the image the load build made", () => {
  const job = jobBlock(slicerText(), "build");
  const smoke = stepBlock(job, "Smoke slice");
  assert.match(smoke, /\n {10}SLICER_IMAGE: \$\{\{ env\.LOCAL \}\}\n/);
  assert.match(smoke, /\n {10}SLICER_IMAGE_PREBUILT: "1"\n/);
  assert.match(smoke, /\n {10}FORCE_FAIL: \$\{\{ inputs\.force_fail \}\}\n/);
  assert.equal(stepInputs(stepBlock(job, "Build (load)")).inputs.tags, "${{ env.LOCAL }}", "the image the load build tagged");
  const r = smokeRun({ REPORT: JSON.stringify(vitestReport(5, 5, 0, 0)) });
  assert.equal(r.status, 0, r.log);
  assert.match(
    r.calls,
    /^pnpm exec vitest run --project container apps\/slicer\/test\/container\/smoke\.test\.ts --reporter=default --reporter=json --outputFile=smoke-report\.json$/m,
  );
  assert.match(r.calls, /^SLICER_IMAGE=platehouse-slicer:smoke SLICER_IMAGE_PREBUILT=1$/m);
  assert.match(r.log, /smoke: 5 tests ran, 0 skipped, 5 collected/);
  // The file the step names exists and slices both fixtures, and the harness
  // honours the switch that stops it building its own image.
  const smokeFile = join(ROOT, "apps", "slicer", "test", "container", "smoke.test.ts");
  assert.ok(existsSync(smokeFile), "apps/slicer/test/container/smoke.test.ts exists");
  const smokeTest = readFileSync(smokeFile, "utf8");
  assert.ok(smokeTest.includes("{ plates: 2, filaments: 2 }"), "the 2-plate, 2-filament fixture");
  assert.ok(smokeTest.includes("{ plates: 3, filaments: 4 }"), "the 3-plate, 4-filament fixture");
  const harness = readFileSync(join(ROOT, "apps", "slicer", "test", "container", "support", "slicer.ts"), "utf8");
  assert.ok(harness.includes('process.env.SLICER_IMAGE_PREBUILT === "1"'), "the harness reads SLICER_IMAGE_PREBUILT");
  assert.match(r.logs["smoke.log"] ?? "", /The smoke slice passed for OrcaSlicer 2\.5\.1/);
});

for (const [name, env, want] of [
  ["force_fail fails a passing smoke slice", { FORCE_FAIL: "true", REPORT: JSON.stringify(vitestReport(5, 5, 0, 0)) }, { status: 1, msg: /force_fail is set/ }],
  ["a failed plate fails with vitest's exit code", { VITEST_STATUS: "7", REPORT: JSON.stringify(vitestReport(5, 4, 1, 0)) }, { status: 7, msg: /the smoke slice failed \(vitest exit 7\)/ }],
  ["every test skipped fails with No tests ran", { REPORT: JSON.stringify(vitestReport(5, 0, 0, 5)) }, { status: 1, msg: /::error::No tests ran\n/ }],
  ["no report fails with No tests ran", { REPORT: "" }, { status: 1, msg: /No tests ran \(vitest wrote no report\)/ }],
  ["force_fail false passes", { FORCE_FAIL: "false", REPORT: JSON.stringify(vitestReport(5, 5, 0, 0)) }, { status: 0 }],
]) {
  test(`slicer-image smoke: ${name}`, () => {
    const r = smokeRun(env);
    assert.equal(r.status, want.status, r.log);
    if (want.msg) {
      assert.match(r.log, want.msg);
      assert.match(r.logs["smoke.log"] ?? "", want.msg, "the kept log has the error for the issue");
    }
  });
}

// The log tail for the issue: each job's failure step lists every step with an
// id, in order, and keeps the first failed one's tail.
for (const [job, failStep] of [
  ["detect", "Keep the failing step's log tail"],
  ["build", "Keep the failing step's log tail"],
]) {
  test(`slicer-image ${job}: the failure step covers every step with an id, in order`, () => {
    const b = jobBlock(slicerText(), job);
    const fail = stepBlock(b, failStep);
    assert.match(fail, /\n {8}if: \$\{\{ failure\(\) \}\}\n/);
    const listed = [...fail.matchAll(/\n {12}([\w-]+)=\$\{\{ steps\.([\w-]+)\.outcome \}\}/g)];
    for (const [, k, id] of listed) assert.equal(k, id);
    const before = b.slice(0, b.indexOf(`- name: ${failStep}\n`));
    assert.deepEqual(
      listed.map((m) => m[1]),
      stepIds(before),
    );
    const upload = stepBlock(b, "Upload the log tail");
    assert.match(upload, /\n {8}if: \$\{\{ failure\(\) \}\}\n/);
    assert.equal(stepInputs(upload).inputs.name, `failure-${job}`);
    assert.equal(stepInputs(upload).inputs.path, `failure/${job}.txt`);
  });
}

const tailRun = (job, outcomes, { logs = {}, stubs = [] } = {}) =>
  runSlicerStep(job, "Keep the failing step's log tail", {
    stubs,
    env: { JOB: job, OUTCOMES: outcomes },
    files: [`failure/${job}.txt`],
    setup: (_work, dir) => {
      mkdirSync(join(dir, "logs"));
      for (const [f, body] of Object.entries(logs)) writeFileSync(join(dir, "logs", f), body);
    },
  });

test("slicer-image failure tail: the first failed step's kept log, last 80 lines", () => {
  const lines = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join("\n");
  const r = tailRun("build", "load=success smoke=failure login=skipped push=skipped check=skipped tag=skipped", {
    logs: { "smoke.log": `${lines}\n` },
  });
  assert.equal(r.status, 0, r.log);
  const out = r.files["failure/build.txt"];
  assert.match(out, /^step: Smoke slice\n/);
  assert.match(out, /\nline 41\n/);
  assert.doesNotMatch(out, /\nline 40\n/);
  assert.match(out, /\nline 120\n$/);
});

test("slicer-image failure tail: a failed build step's tail comes from buildx history", () => {
  const stubs = [
    "timeout() { shift; \"$@\"; }",
    'docker() { echo "docker $*" >> "$CALLS"; echo "#14 ERROR: process did not complete successfully"; }',
  ];
  const r = tailRun("build", "load=failure smoke=skipped login=skipped push=skipped check=skipped tag=skipped", { stubs });
  assert.equal(r.status, 0, r.log);
  assert.match(r.calls, /^docker buildx history logs$/m);
  assert.match(r.files["failure/build.txt"], /^step: Build \(load\)\n#14 ERROR/);
});

test("slicer-image failure tail: a detect step with no kept log says so", () => {
  const r = tailRun("detect", "pick=success pins=success login=failure registry=skipped");
  assert.equal(r.status, 0, r.log);
  assert.match(r.files["failure/detect.txt"], /^step: Log in to GHCR\n\(no log was kept for this step; see the run's log\)\n$/);
});

// The issue: titled for the version, the tail in a code block, one open issue
// per title (a repeat failure comments on it).
const GH_ISSUE_STUB = [
  "gh() {",
  '  echo "gh $*" >> "$CALLS"',
  '  case "$1 $2" in',
  '    "issue list") printf "%s" "$ISSUES" ;;',
  '    "issue create"|"issue comment") cp body.md posted.md ;;',
  "    *) return 99 ;;",
  "  esac",
  "}",
];
const reportRun = (env, tails = {}) =>
  runSlicerStep("report-failure", "Open or update the issue", {
    stubs: GH_ISSUE_STUB,
    env: {
      REPO: "jonathanmcohen/platehouse",
      VERSION: "2.5.1",
      INPUT_VERSION: "",
      EVENT: "schedule",
      RUN_URL: "https://github.com/jonathanmcohen/platehouse/actions/runs/1",
      ISSUES: "[]",
      ...env,
    },
    files: ["posted.md"],
    setup: (work) => {
      if (Object.keys(tails).length) mkdirSync(join(work, "failure"));
      for (const [f, body] of Object.entries(tails)) writeFileSync(join(work, "failure", f), body);
    },
  });

test("slicer-image issue: opens 'Slicer image failed for OrcaSlicer X.Y.Z' with the failing step's tail", () => {
  const r = reportRun({}, { "build.txt": "step: Smoke slice\n::error::the smoke slice failed (vitest exit 1)\n" });
  assert.equal(r.status, 0, r.log);
  assert.match(
    r.calls,
    /^gh issue create --repo jonathanmcohen\/platehouse --title Slicer image failed for OrcaSlicer 2\.5\.1 --body-file body\.md$/m,
  );
  const body = r.files["posted.md"];
  assert.match(body, /No tag was created or moved, so stable still points at the last image that passed/);
  assert.match(body, /Run: https:\/\/github\.com\/jonathanmcohen\/platehouse\/actions\/runs\/1/);
  assert.match(body, /```text\nstep: Smoke slice\n::error::the smoke slice failed \(vitest exit 1\)\n```/);
  // A daily run that tagged nothing found no orca-X.Y.Z, so the next one retries.
  assert.match(body, /or let the next daily run retry it\./);
});

// Issue #451: a job cancelled on a release tag's push leaves the release
// without its slicer image, so the issue says so; a plain failure does not.
test("slicer-image issue: a cancelled job is named, and a plain failure does not mention cancelling (issue #451)", () => {
  const cancelled = reportRun({ EVENT: "push", CANCELLED: "true" });
  assert.equal(cancelled.status, 0, cancelled.log);
  assert.match(cancelled.files["posted.md"], /A job of this run was cancelled, by a person or by GitHub/);
  assert.match(cancelled.files["posted.md"], /Re-run the cancelled jobs/);
  const failed = reportRun({ EVENT: "push", CANCELLED: "false" });
  assert.equal(failed.status, 0, failed.log);
  assert.doesNotMatch(failed.files["posted.md"], /was cancelled/);
});

test("slicer-image: the report is told whether a job was cancelled", () => {
  const issue = stepBlock(jobBlock(slicerText(), "report-failure"), "Open or update the issue");
  assert.ok(issue.includes("\n          CANCELLED: ${{ contains(needs.*.result, 'cancelled') }}\n"));
});

// A failure after the tag step began: the orca tags may already point at the
// new digest, and the daily run will then see orca-X.Y.Z and never retry.
const TAG_FAIL = { "build.txt": "step: Tag the image\n::error::x\n" };
test("slicer-image issue: a failure after the version tags lists them and says the daily run will not retry", () => {
  const r = reportRun({ TAGGED: "orca-2.5.1, orca-2.5.1-r42", DIGEST: `sha256:${sha("d")}`, STABLE: "true" }, TAG_FAIL);
  assert.equal(r.status, 0, r.log);
  const body = r.files["posted.md"];
  assert.doesNotMatch(body, /No tag was created/);
  assert.doesNotMatch(body, /let the next daily run retry/);
  assert.match(body, new RegExp(`orca-2\\.5\\.1, orca-2\\.5\\.1-r42`));
  assert.match(body, new RegExp(`sha256:${sha("d")}`));
  assert.match(body, /stable was not touched/);
  assert.match(body, /run the workflow by hand \(Actions, slicer-image, Run workflow, orca_version 2\.5\.1\)/);
  assert.match(body, /daily run will not retry it once orca-2\.5\.1 is in the registry, as this run may have left it/);
});

test("slicer-image issue: a failure after stable was tagged says stable may have moved", () => {
  const r = reportRun({ TAGGED: "orca-2.5.1, orca-2.5.1-r42, stable", DIGEST: `sha256:${sha("d")}`, STABLE: "true" }, TAG_FAIL);
  assert.equal(r.status, 0, r.log);
  const body = r.files["posted.md"];
  assert.doesNotMatch(body, /stable was not touched/);
  assert.match(body, /stable may now point at that digest/);
  assert.match(body, /Rolling the slicer back/);
});

test("slicer-image issue: a prerelease tag's failure after tagging says Re-run failed jobs, which leaves stable alone", () => {
  const r = reportRun({ EVENT: "push", TAGGED: "orca-2.5.1, orca-2.5.1-r42", DIGEST: `sha256:${sha("d")}`, STABLE: "false" }, TAG_FAIL);
  assert.equal(r.status, 0, r.log);
  const body = r.files["posted.md"];
  assert.match(body, /\(Re-run failed jobs\)/);
  assert.match(body, /a run by hand would move stable/);
  assert.doesNotMatch(body, /let the next daily run retry/);
  // The tag step failing means detect succeeded. Re-run failed jobs re-runs
  // build and keeps detect's outputs (version, pins, stable=false), so it
  // builds 2.5.1 itself and leaves stable alone (PR #302 review).
  assert.match(body, /keeps detect's outputs, so it builds 2\.5\.1 again and leaves stable alone/);
  // A prerelease run never creates orca-X.Y.Z, so the daily run is not shut out of the version.
  assert.doesNotMatch(body, /may have left it/);
  assert.match(body, /does not move orca-2\.5\.1, so the daily run builds 2\.5\.1 itself if orca-2\.5\.1 is not in the registry yet/);
  // Issue #221: Re-run all jobs runs detect again, which reads Orca's latest
  // release, so the body warns against it.
  assert.match(body, /not Re-run all jobs/);
  assert.match(body, /reads OrcaSlicer's latest release again/);
  // A hand run is no longer the way to fix the named version, so the body has
  // no hand-run-and-roll-back steps.
  assert.doesNotMatch(body, /run the workflow by hand for 2\.5\.1 instead/);
  assert.doesNotMatch(body, /roll stable back/);
  // The re-run builds 2.5.1, so its tag is named for 2.5.1, inside a code span
  // so GitHub keeps the <run> placeholder (issue #306).
  assert.match(body, /its own `orca-2\.5\.1-r<run>\.<attempt>` tag/);
});

// GitHub renders the issue body as markdown and strips a bare <word> as an
// unknown HTML tag, so a placeholder such as <run> would vanish from the
// issue. Outside a code block or code span the body has no angle-bracket word.
const proseOnly = (md) => md.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
// A bare tag as GitHub strips it, a placeholder with a space in it (<run
// number>, read as a tag with an attribute) included, as the repo-wide rule in
// apps/web/test/markdown-placeholders.test.ts has it (issue #306).
const BARE_TAG = /<\/?[A-Za-z][^<>]*>/;
test("slicer-image issue: the bare-tag check catches a spaced placeholder and leaves code alone", () => {
  for (const bare of ["tags -r<run number> now", "tags -r<run>.<attempt>", "a </closing> tag"]) {
    assert.match(proseOnly(bare), BARE_TAG, bare);
  }
  for (const fine of ["tags `-r<run number>` now", "```text\n<tail>\n```", "a < b > c"]) {
    assert.doesNotMatch(proseOnly(fine), BARE_TAG, fine);
  }
});
for (const [name, env, tails] of [
  ["a daily failure", {}, { "build.txt": "step: Smoke slice\n<tail>\n" }],
  ["a failure after tagging", { TAGGED: "orca-2.5.1, orca-2.5.1-r42", DIGEST: `sha256:${sha("d")}`, STABLE: "true" }, TAG_FAIL],
  ["a failure after stable was tagged", { TAGGED: "orca-2.5.1, orca-2.5.1-r42, stable", STABLE: "true" }, TAG_FAIL],
  ["a prerelease failure after tagging", { EVENT: "push", TAGGED: "orca-2.5.1, orca-2.5.1-r42", STABLE: "false" }, TAG_FAIL],
  ["a run by hand", { EVENT: "workflow_dispatch" }, {}],
  ["a run with no version", { EVENT: "workflow_dispatch", VERSION: "", INPUT_VERSION: "" }, {}],
]) {
  test(`slicer-image issue: ${name} has no bare <word> GitHub would strip`, () => {
    const r = reportRun(env, tails);
    assert.equal(r.status, 0, r.log);
    assert.doesNotMatch(proseOnly(r.files["posted.md"]), BARE_TAG);
  });
}

test("slicer-image issue: a failed run that was not daily does not promise a daily retry", () => {
  const r = reportRun({ EVENT: "workflow_dispatch" }, { "build.txt": "step: Smoke slice\nx\n" });
  assert.equal(r.status, 0, r.log);
  const body = r.files["posted.md"];
  assert.match(body, /No tag was created or moved/);
  assert.doesNotMatch(body, /let the next daily run retry/);
  assert.match(body, /retries this version only if orca-2\.5\.1 is not in the registry yet/);
});

test("slicer-image issue: a repeat failure comments on the open issue with the same title", () => {
  const issues = JSON.stringify([
    { number: 3, title: "Slicer image failed for OrcaSlicer 2.5.0" },
    { number: 9, title: "Slicer image failed for OrcaSlicer 2.5.1" },
  ]);
  const r = reportRun({ ISSUES: issues }, { "build.txt": "step: Push by digest\nboom\n" });
  assert.equal(r.status, 0, r.log);
  assert.match(r.calls, /^gh issue comment 9 --repo jonathanmcohen\/platehouse --body-file body\.md$/m);
  assert.doesNotMatch(r.calls, /issue create/);
});

test("slicer-image issue: an open issue for another version does not count", () => {
  const issues = JSON.stringify([{ number: 3, title: "Slicer image failed for OrcaSlicer 2.5.0" }]);
  const r = reportRun({ ISSUES: issues }, { "detect.txt": "step: Check the registry\nx\n" });
  assert.equal(r.status, 0, r.log);
  assert.match(r.calls, /^gh issue create /m);
});

for (const [name, env, title] of [
  ["a detect failure before the version names the requested one", { VERSION: "", INPUT_VERSION: "2.6.0" }, "Slicer image failed for OrcaSlicer 2.6.0"],
  ["a malformed requested version is not put in the title", { VERSION: "", INPUT_VERSION: "2.6;x" }, "Slicer image failed for OrcaSlicer (version not found)"],
  ["no version at all says so", { VERSION: "", INPUT_VERSION: "" }, "Slicer image failed for OrcaSlicer (version not found)"],
]) {
  test(`slicer-image issue: ${name}`, () => {
    const r = reportRun(env, { "detect.txt": "step: Pick the version\nx\n" });
    assert.equal(r.status, 0, r.log);
    assert.ok(r.calls.includes(`--title ${title} --body-file`), r.calls);
  });
}

test("slicer-image issue: with no kept tail it says so, and a tail cannot break out of its code block", () => {
  const none = reportRun({});
  assert.equal(none.status, 0, none.log);
  assert.match(none.files["posted.md"], /no log tail was kept/);
  const fenced = reportRun({}, { "build.txt": "step: Smoke slice\n```\n# not a heading\n```\n" });
  assert.equal(fenced.status, 0, fenced.log);
  assert.equal((fenced.files["posted.md"].match(/```/g) ?? []).length, 2, "only the issue's own fence");
  const report = jobBlock(slicerText(), "report-failure");
  assert.match(stepBlock(report, "Download the log tail"), /\n {8}continue-on-error: true\n/);
  assert.doesNotMatch(stepBlock(report, "Open or update the issue"), /\n {8}(if|continue-on-error):/);
});

// The rollback the README gives, as a carbon copy so stable's
// digest is the old version's.
test("slicer-image: the README holds the rollback command, and the workflow points to it", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  assert.ok(
    readme.includes(
      [
        "docker buildx imagetools create --prefer-index=false \\",
        "  -t ghcr.io/jonathanmcohen/platehouse-slicer:stable \\",
        "  ghcr.io/jonathanmcohen/platehouse-slicer:orca-<previous>",
      ].join("\n"),
    ),
    "the rollback command",
  );
  assert.match(slicerText(), /^# Rollback: README\.md, "Slicer image"\./m);
  assert.match(readme, /^## Slicer image$/m);
});

// A failure in the tag step can leave the orca tags in place, and the daily run
// never builds a version whose orca-X.Y.Z exists, prerelease-published ones
// included. The README, the CHANGELOG and the workflow header must not say
// otherwise.
test("slicer-image: the docs do not claim a failure never tags, and say what the daily run will not do", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
  assert.doesNotMatch(readme, /When a run fails, no tag is created or moved/);
  assert.doesNotMatch(changelog, /A failure tags nothing/);
  assert.doesNotMatch(slicerText(), /On any failure stable is not touched/);
  const section = readme.slice(readme.indexOf("## Slicer image"), readme.indexOf("### Rolling the slicer back"));
  assert.match(section, /lists the tags it had already pointed at the new digest/);
  assert.match(section, /A prerelease tag leaves `orca-X\.Y\.Z` and `stable` where they were/);
  // Issue #221: the run tag rule, in both README sections.
  assert.match(section, /`orca-X\.Y\.Z-r<run number>\.<attempt>`/);
  assert.match(section, /reads OrcaSlicer's latest release again/);
  // A prerelease tag's tag-step failure is fixed with Re-run failed jobs,
  // which keeps the failed version and leaves stable alone (PR #302 review);
  // no hand run, so no rolling stable back.
  assert.match(section, /the issue suggests Re-run failed jobs/);
  assert.match(section, /warns against Re-run all jobs/);
  assert.doesNotMatch(section, /roll `stable` back/);
  const rollback = readme.slice(readme.indexOf("### Rolling the slicer back"), readme.indexOf("## Layout"));
  assert.match(rollback, /`orca-X\.Y\.Z-r<run number>` tag, or `orca-X\.Y\.Z-r<run number>\.<attempt>` for a re-run/);
  assert.match(changelog, /lists any tag the run had already pointed at the new digest/);
});

// PR #360: rc moves in one place, rc-tag.yml. The release workflows only
// publish their version tags; the slicer's failure issue keeps its old
// advice plus one line saying how rc catches up.
const RC_LINE =
  "rc is not moved by this workflow: the rc-tag workflow points it at the newest version with both images published after every run of slicer-image or release, so rc fixes itself on the next successful run of either workflow, or when rc-tag is run by hand (Actions, rc-tag, Run workflow).";
for (const [name, env, tails] of [
  ["a daily failure", {}, { "build.txt": "step: Smoke slice\nx\n" }],
  ["a failure after tagging", { TAGGED: "orca-2.5.1, orca-2.5.1-r42, 0.2.0", DIGEST: `sha256:${sha("d")}`, STABLE: "true", EVENT: "push" }, TAG_FAIL],
  ["a prerelease failure after tagging", { EVENT: "push", TAGGED: "orca-2.5.1, orca-2.5.1-r42, 0.2.0-rc.1", STABLE: "false" }, TAG_FAIL],
  ["a detect failure", { EVENT: "push", VERSION: "" }, { "detect.txt": "step: Check out\nx\n" }],
]) {
  test(`slicer-image issue: ${name} says rc catches up on its own, once`, () => {
    const r = reportRun(env, tails);
    assert.equal(r.status, 0, r.log);
    const body = r.files["posted.md"];
    assert.equal(body.split(RC_LINE).length - 1, 1, body);
    // Version strings such as 0.2.0-rc.1 aside.
    assert.doesNotMatch(body.replace(RC_LINE, "").replace(/-rc\.\d+/g, ""), /\brc\b/, "rc is mentioned in that line only");
  });
}

test("rc moves only in rc-tag.yml: neither release workflow writes or reads an rc tag", () => {
  for (const t of [readFileSync(RELEASE, "utf8"), slicerText()]) {
    assert.doesNotMatch(t, /:rc\b/);
    assert.doesNotMatch(t, /MOVE_RC|outputs\.rc\b|steps\.rc\b/);
  }
  assert.match(slicerText(), /This workflow never moves rc: \.github\/workflows\/rc-tag\.yml runs/);
});

// rc-tag.yml. Its steps run in bash at the repo root (the target step calls
// node .github/scripts/rc-target.mjs), with gh and docker stubbed.
const RC_TAG = join(ROOT, ".github", "workflows", "rc-tag.yml");
const rcText = () => readFileSync(RC_TAG, "utf8");
const runRcStep = (job, stepName, opts) => runWorkflowStep(RC_TAG, job, stepName, opts);
const RC_APP = "ghcr.io/jonathanmcohen/platehouse";
const RC_SLICER = "ghcr.io/jonathanmcohen/platehouse-slicer";

test("rc-tag: runs after every release or slicer-image run and by hand, one run at a time, never cancelled", () => {
  const t = rcText();
  const on = onBlock(t);
  assert.match(on, /^ {2}workflow_run:\n {4}workflows: \[release, slicer-image\]\n {4}types: \[completed\]\n/m);
  assert.match(on, /^ {2}workflow_dispatch:\n/m);
  assert.doesNotMatch(on, /push:|pull_request|schedule:|branches:/);
  // The names it waits on are the two workflows' names.
  assert.match(readFileSync(RELEASE, "utf8"), /^name: release$/m);
  assert.match(slicerText(), /^name: slicer-image$/m);
  assert.match(t, /\nconcurrency:\n {2}group: rc-tag\n {2}cancel-in-progress: false\n/);
  assert.match(t, /^permissions:\n {2}contents: read\n(?! {2}\S)/m);
  const jobs = [...t.slice(t.indexOf("\njobs:\n")).matchAll(/\n {2}([\w-]+):\n/g)].map((m) => m[1]);
  assert.deepEqual(jobs, ["rc"]);
  const job = jobBlock(t, "rc");
  assert.match(job, /\n {4}runs-on: ubuntu-24\.04\n/);
  assert.match(job, /\n {4}timeout-minutes: 15\n/);
  assert.match(job, /\n {4}permissions:\n {6}contents: read\n {6}packages: write\n(?! {6}\S)/);
  for (const s of t.matchAll(/secrets\.(\w+)/g)) assert.equal(s[1], "GITHUB_TOKEN", "no secret but the job token");
  // Never the triggering run's facts: no event payload, no head commit.
  assert.doesNotMatch(t, /github\.event\b|workflow_run\.|head_sha|github\.sha/);
  assert.doesNotMatch(stepBlock(job, "Check out"), /\n {10}ref:/, "checks out main, never another commit");
  assert.doesNotMatch(t, /[^\x00-\x7F]/, "ASCII only");
});

test("rc-tag: every action is pinned to the exact tag release.yml or ci.yml uses", () => {
  const pins = (t) => {
    const out = {};
    for (const [, u] of t.matchAll(/uses: (\S+ # \S+)/g)) {
      const [name, tag] = u.split("@");
      (out[name] ??= new Set()).add(tag);
    }
    return out;
  };
  const release = pins(readFileSync(RELEASE, "utf8"));
  const ci = pins(text());
  const ours = pins(rcText());
  assert.deepEqual(Object.keys(ours).sort(), ["actions/checkout", "actions/setup-node", "docker/login-action", "docker/setup-buildx-action"]);
  for (const [name, tags] of Object.entries(ours)) {
    const [tag] = tags;
    assert.equal(tags.size, 1);
    assert.match(tag, /^[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
    assert.deepEqual([...(release[name] ?? ci[name])], [tag], `${name}@${tag}`);
  }
  assert.equal(stepInputs(stepBlock(jobBlock(rcText(), "rc"), "Set up Node")).inputs["node-version-file"], ".node-version");
});

test("rc-tag: the main-only check runs first and refuses any other ref", () => {
  const steps = jobSteps(jobBlock(rcText(), "rc"));
  assert.ok(steps[0].startsWith("      - name: Run only from main\n"), steps[0]);
  assert.equal(runRcStep("rc", "Run only from main", { env: { REF: "refs/heads/main" } }).status, 0);
  for (const ref of ["refs/heads/feature", "refs/tags/v0.1.0", "refs/heads/main-x", ""]) {
    const r = runRcStep("rc", "Run only from main", { env: { REF: ref } });
    assert.notEqual(r.status, 0, ref);
    assert.match(r.log, /::error::.* is not main/);
  }
  const ids = stepIds(jobBlock(rcText(), "rc"));
  assert.deepEqual(ids, ["target", "point"]);
});

// The target step. gh returns the repository's tag refs; docker answers an
// inspect with a digest for a ref in PUBLISHED, an error for BROKEN, and
// GHCR's "not found" for anything else.
const RC_FIND_STUB = [
  "gh() {",
  '  echo "gh $*" >> "$CALLS"',
  '  printf "%s\\n" $REFS',
  "}",
  "docker() {",
  '  echo "docker $*" >> "$CALLS"',
  '  case " $PUBLISHED " in *" $4 "*) echo "sha256:1111111111111111111111111111111111111111111111111111111111111111"; return 0 ;; esac',
  '  if [ -n "$BROKEN" ] && [ "$4" = "$BROKEN" ]; then echo "ERROR: denied: denied" >&2; return 1; fi',
  '  echo "ERROR: $4: not found" >&2',
  "  return 1",
  "}",
];
const refs = (...tags) => tags.map((t) => `refs/tags/${t}`).join(" ");
const both = (...versions) => versions.flatMap((v) => [`${RC_APP}:${v}`, `${RC_SLICER}:${v}`]).join(" ");
const findRun = (env) =>
  runRcStep("rc", "Find the target", {
    cwd: ROOT,
    stubs: RC_FIND_STUB,
    env: { GH_TOKEN: "x", REPO: "jonathanmcohen/platehouse", BROKEN: "", ...env },
  });
const TODAY = refs("v0.1.0-rc.1", "v0.1.0-rc.2", "v0.1.0-rc.3", "v0.1.0-rc.4", "v0.1.0", "v0.0.0-test");

for (const [name, env, want] of [
  [
    "the highest tag with both version tags",
    { REFS: TODAY, PUBLISHED: `${both("0.1.0", "0.1.0-rc.4")} ${RC_APP}:0.0.0-test ${RC_SLICER}:0.0.0-test` },
    "v0.1.0",
  ],
  ["a newer candidate whose slicer is not published yet is passed over", { REFS: refs("v0.1.0", "v0.2.0-rc.1"), PUBLISHED: `${both("0.1.0")} ${RC_APP}:0.2.0-rc.1` }, "v0.1.0"],
  ["the newer candidate once both are published", { REFS: refs("v0.1.0", "v0.2.0-rc.1"), PUBLISHED: both("0.1.0", "0.2.0-rc.1") }, "v0.2.0-rc.1"],
  ["a backport release older than the newest candidate", { REFS: refs("v0.2.0-rc.1", "v0.1.1"), PUBLISHED: both("0.2.0-rc.1", "0.1.1") }, "v0.2.0-rc.1"],
  ["nothing qualifies yet (today: no slicer version tags exist)", { REFS: TODAY, PUBLISHED: `${RC_APP}:0.1.0 ${RC_APP}:0.1.0-rc.4` }, ""],
  ["no tags at all", { REFS: "", PUBLISHED: "" }, ""],
]) {
  test(`rc-tag target: ${name}`, () => {
    const r = findRun(env);
    assert.equal(r.status, 0, r.log);
    assert.equal(r.outputs.target, want);
    assert.match(r.calls, /^gh api --paginate repos\/jonathanmcohen\/platehouse\/git\/matching-refs\/tags\/v --jq \.\[\]\.ref$/m);
    // A tag that can never qualify is never asked about.
    assert.doesNotMatch(r.calls, /0\.0\.0-test/);
    assert.match(r.summary, /\| tag \| platehouse \| platehouse-slicer \|/);
  });
}

test("rc-tag target: the summary lists every candidate with what the registry said, highest first", () => {
  const r = findRun({ REFS: refs("v0.1.0", "v0.2.0-rc.1"), PUBLISHED: `${both("0.1.0")} ${RC_APP}:0.2.0-rc.1` });
  assert.equal(r.status, 0, r.log);
  assert.match(r.summary, /\| v0\.2\.0-rc\.1 \| true \| false \|\n\| v0\.1\.0 \| true \| true \|\n/);
});

test("rc-tag target: a registry error other than not found stops the run before anything is picked", () => {
  const r = findRun({ REFS: refs("v0.1.0", "v0.2.0-rc.1"), PUBLISHED: both("0.1.0"), BROKEN: `${RC_SLICER}:0.2.0-rc.1` });
  assert.notEqual(r.status, 0, r.log);
  assert.match(r.log, /::error::could not tell whether ghcr\.io\/jonathanmcohen\/platehouse-slicer:0\.2\.0-rc\.1 exists/);
  assert.equal(r.outputs.target, undefined);
});

// The point step. The registry is a file of ref=digest lines (the last line
// for a ref wins); create appends one unless CREATE_NOOP is 1 or the ref it
// tags, and an inspect of a ref with no line answers not found, or BROKEN's
// error. CREATE_FAIL lists ref#n tokens: the nth create of that ref fails.
// BROKEN_AFTER_CREATE is a ref whose inspect errors once it has been created.
const RC_POINT_STUB = [
  "docker() {",
  '  echo "docker $*" >> "$CALLS"',
  '  if [ "$1 $2 $3" = "buildx imagetools inspect" ]; then',
  '    if [ -n "$BROKEN" ] && [ "$4" = "$BROKEN" ]; then echo "ERROR: denied: denied" >&2; return 1; fi',
  '    if [ -n "$BROKEN_AFTER_CREATE" ] && [ "$4" = "$BROKEN_AFTER_CREATE" ] && grep -qF -- "-t $4 " "$CALLS"; then echo "ERROR: denied: denied" >&2; return 1; fi',
  '    local d',
  '    d="$(grep -F "$4=" "$REGISTRY" | sed -n "s|^$4=||p" | tail -n 1)"',
  '    if [ -n "$d" ]; then echo "$d"; return 0; fi',
  '    echo "ERROR: $4: not found" >&2',
  "    return 1",
  "  fi",
  '  if [ "$1 $2 $3" = "buildx imagetools create" ]; then',
  '    local n',
  '    n="$(grep -cF -- "-t $6 " "$CALLS")"',
  '    case " $CREATE_FAIL " in *" $6#$n "*) echo "ERROR: failed to push $6" >&2; return 1 ;; esac',
  '    if [ "$CREATE_NOOP" = 1 ] || [ "$CREATE_NOOP" = "$6" ]; then return 0; fi',
  '    echo "$6=${7#*@}" >> "$REGISTRY"',
  "  fi",
  "}",
];
const A_NEW = `sha256:${"a".repeat(64)}`;
const S_NEW = `sha256:${"b".repeat(64)}`;
const A_OLD = `sha256:${"c".repeat(64)}`;
const S_OLD = `sha256:${"e".repeat(64)}`;
const pointRun = (env, registry) =>
  runRcStep("rc", "Point rc at the target", {
    stubs: RC_POINT_STUB,
    env: { BROKEN: "", BROKEN_AFTER_CREATE: "", CREATE_NOOP: "", CREATE_FAIL: "", ...env },
    setup: (work) => writeFileSync(join(work, "registry"), registry.map(([k, v]) => `${k}=${v}\n`).join("")),
  });
// REGISTRY is relative to the step's directory, which setup writes into.
const pointEnv = (env = {}) => ({ REGISTRY: "registry", TARGET: "v0.2.0-rc.1", ...env });
const VERSION_TAGS = [
  [`${RC_APP}:0.2.0-rc.1`, A_NEW],
  [`${RC_SLICER}:0.2.0-rc.1`, S_NEW],
];
const createRc = (img, d) => `docker buildx imagetools create --prefer-index=false -t ${img}:rc ${img}@${d}`;
const inspect = (ref) => `docker buildx imagetools inspect ${ref} --format {{.Manifest.Digest}}`;

test("rc-tag point: no rc yet: both rc tags are pointed at the target's builds by digest and read back", () => {
  const r = pointRun(pointEnv(), VERSION_TAGS);
  assert.equal(r.status, 0, r.log);
  // All four tags are read before either rc tag is written.
  assert.deepEqual(r.calls.trim().split("\n"), [
    inspect(`${RC_APP}:0.2.0-rc.1`),
    inspect(`${RC_APP}:rc`),
    inspect(`${RC_SLICER}:0.2.0-rc.1`),
    inspect(`${RC_SLICER}:rc`),
    createRc(RC_APP, A_NEW),
    inspect(`${RC_APP}:rc`),
    createRc(RC_SLICER, S_NEW),
    inspect(`${RC_SLICER}:rc`),
  ]);
  assert.match(r.summary, /rc target: \*\*v0\.2\.0-rc\.1\*\*/);
  assert.match(r.summary, /platehouse:rc moved to v0\.2\.0-rc\.1/);
  assert.match(r.summary, /platehouse-slicer:rc moved to v0\.2\.0-rc\.1/);
});

test("rc-tag point: when T and both digests are unchanged nothing is written", () => {
  const r = pointRun(pointEnv(), [...VERSION_TAGS, [`${RC_APP}:rc`, A_NEW], [`${RC_SLICER}:rc`, S_NEW]]);
  assert.equal(r.status, 0, r.log);
  assert.doesNotMatch(r.calls, /imagetools create/);
  assert.match(r.summary, /platehouse:rc already at v0\.2\.0-rc\.1/);
  assert.match(r.summary, /platehouse-slicer:rc already at v0\.2\.0-rc\.1/);
});

test("rc-tag point: only the rc tag that is off its target build is moved", () => {
  const r = pointRun(pointEnv(), [...VERSION_TAGS, [`${RC_APP}:rc`, A_NEW], [`${RC_SLICER}:rc`, S_OLD]]);
  assert.equal(r.status, 0, r.log);
  assert.equal(r.calls.split("imagetools create").length - 1, 1);
  assert.ok(r.calls.includes(createRc(RC_SLICER, S_NEW)), r.calls);
});

test("rc-tag point: a target rebuilt by a later run of its own tag moves rc to the new build", () => {
  // The target's version tag now names a newer build of the same tag; rc
  // follows it, so rc stays the target's build.
  const r = pointRun(pointEnv(), [...VERSION_TAGS, [`${RC_APP}:rc`, A_OLD], [`${RC_SLICER}:rc`, S_NEW]]);
  assert.equal(r.status, 0, r.log);
  assert.ok(r.calls.includes(createRc(RC_APP, A_NEW)), r.calls);
});

test("rc-tag point: no target changes nothing", () => {
  const r = pointRun(pointEnv({ TARGET: "" }), []);
  assert.equal(r.status, 0, r.log);
  assert.equal(r.calls, "");
  assert.match(r.summary, /No vX\.Y\.Z or vX\.Y\.Z-rc\.N tag has both images published, so rc was left where it is\./);
});

for (const [name, env, registry, want] of [
  ["a read-back that does not match fails", { CREATE_NOOP: "1" }, VERSION_TAGS, { msg: /::error::ghcr\.io\/jonathanmcohen\/platehouse:rc is missing after the move/ }],
  ["a target whose version tag has gone fails before any move", {}, [[`${RC_SLICER}:0.2.0-rc.1`, S_NEW]], { msg: /:0\.2\.0-rc\.1 is gone since it was found/, noCreate: true }],
  ["a malformed target fails before any registry call", { TARGET: "v0.2.0-beta.1" }, VERSION_TAGS, { msg: /is not vX\.Y\.Z or vX\.Y\.Z-rc\.N/, noCall: true }],
  ["a target with shell in it fails before any registry call", { TARGET: "v0.2.0;id" }, VERSION_TAGS, { msg: /is not vX\.Y\.Z or vX\.Y\.Z-rc\.N/, noCall: true }],
  ["a registry error reading rc fails before any move", { BROKEN: `${RC_APP}:rc` }, VERSION_TAGS, { msg: /::error::could not read ghcr\.io\/jonathanmcohen\/platehouse:rc/, noCreate: true }],
  // The slicer's tags are read before the app's rc moves, so a failure
  // reading them moves nothing.
  ["a registry error reading the slicer's rc fails before any move", { BROKEN: `${RC_SLICER}:rc` }, VERSION_TAGS, { msg: /::error::could not read ghcr\.io\/jonathanmcohen\/platehouse-slicer:rc/, noCreate: true }],
  ["a registry error reading the slicer's version tag fails before any move", { BROKEN: `${RC_SLICER}:0.2.0-rc.1` }, VERSION_TAGS, { msg: /::error::could not read ghcr\.io\/jonathanmcohen\/platehouse-slicer:0\.2\.0-rc\.1/, noCreate: true }],
  ["a slicer version tag gone since it was found fails before any move", {}, [[`${RC_APP}:0.2.0-rc.1`, A_NEW]], { msg: /platehouse-slicer:0\.2\.0-rc\.1 is gone since it was found/, noCreate: true }],
]) {
  test(`rc-tag point: ${name}`, () => {
    const r = pointRun(pointEnv(env), registry);
    assert.notEqual(r.status, 0, r.log);
    assert.match(r.log, want.msg);
    if (want.noCreate) assert.doesNotMatch(r.calls, /imagetools create/);
    if (want.noCall) assert.equal(r.calls, "");
  });
}

// A failure in the slicer's turn after the app's rc moved puts the app's rc
// back on the build it had, so a failed run never leaves the two rc tags on
// different tags (PR #360 review).
const OLD_RC = [...VERSION_TAGS, [`${RC_APP}:rc`, A_OLD], [`${RC_SLICER}:rc`, S_OLD]];
const rcNow = (r, img) => {
  const calls = r.calls.trim().split("\n");
  return calls.filter((c) => c.startsWith(`docker buildx imagetools create --prefer-index=false -t ${img}:rc `)).map((c) => c.split("@")[1]);
};
for (const [name, env] of [
  ["the slicer's create fails", { CREATE_FAIL: `${RC_SLICER}:rc#1` }],
  ["the slicer's read-back does not match", { CREATE_NOOP: `${RC_SLICER}:rc` }],
]) {
  test(`rc-tag point: ${name} after the app's rc moved: the app's rc is put back`, () => {
    const r = pointRun(pointEnv(env), OLD_RC);
    assert.notEqual(r.status, 0, r.log);
    // The app's rc went to the new build, then back to the old one.
    assert.deepEqual(rcNow(r, RC_APP), [A_NEW, A_OLD], r.calls);
    const calls = r.calls.trim().split("\n");
    const back = calls.lastIndexOf(createRc(RC_APP, A_OLD));
    assert.equal(calls[back + 1], inspect(`${RC_APP}:rc`), "the put-back is read back");
    assert.match(r.log, /platehouse:rc is back on sha256:c{64}/);
    assert.match(r.log, /::error::rc-tag failed part way; every rc tag it had moved is back where it was/);
    assert.doesNotMatch(r.log, /different tags/);
    assert.match(r.summary, /failed part way/);
  });
}

test("rc-tag point: a registry error reading the slicer's rc back puts the app's rc back and says the slicer's could not be confirmed", () => {
  const r = pointRun(pointEnv({ BROKEN_AFTER_CREATE: `${RC_SLICER}:rc` }), OLD_RC);
  assert.notEqual(r.status, 0, r.log);
  assert.deepEqual(rcNow(r, RC_APP), [A_NEW, A_OLD], r.calls);
  assert.match(r.log, /platehouse:rc is back on sha256:c{64}/);
  // The slicer's rc is pointed back too, but the registry will not say
  // where it is, so the run cannot claim the tags agree.
  assert.deepEqual(rcNow(r, RC_SLICER), [S_NEW, S_OLD], r.calls);
  assert.match(r.log, /::error::could not put ghcr\.io\/jonathanmcohen\/platehouse-slicer:rc back on sha256:e{64}/);
  assert.match(r.log, /::error::the rc tags may now name builds of different tags/);
});

test("rc-tag point: a slicer rc that the failed create left alone is not rewritten", () => {
  const r = pointRun(pointEnv({ CREATE_FAIL: `${RC_SLICER}:rc#1` }), OLD_RC);
  assert.notEqual(r.status, 0, r.log);
  assert.deepEqual(rcNow(r, RC_SLICER), [S_NEW], "only the failed attempt");
  assert.match(r.log, /platehouse-slicer:rc is still on sha256:e{64}/);
});

test("rc-tag point: an app rc that did not exist before cannot be put back, and the run says the tags may differ", () => {
  const r = pointRun(pointEnv({ CREATE_FAIL: `${RC_SLICER}:rc#1` }), [...VERSION_TAGS, [`${RC_SLICER}:rc`, S_OLD]]);
  assert.notEqual(r.status, 0, r.log);
  assert.deepEqual(rcNow(r, RC_APP), [A_NEW]);
  assert.match(r.log, /::error::ghcr\.io\/jonathanmcohen\/platehouse:rc did not exist before this run, so it cannot be put back/);
  assert.match(r.log, /::error::the rc tags may now name builds of different tags/);
});

test("rc-tag point: a put-back that fails too says the tags may differ and how to fix them", () => {
  const r = pointRun(pointEnv({ CREATE_FAIL: `${RC_SLICER}:rc#1 ${RC_APP}:rc#2` }), OLD_RC);
  assert.notEqual(r.status, 0, r.log);
  assert.match(r.log, /::error::could not put ghcr\.io\/jonathanmcohen\/platehouse:rc back on sha256:c{64}/);
  assert.match(r.log, /::error::the rc tags may now name builds of different tags; run rc-tag by hand \(Actions, rc-tag, Run workflow\)/);
  assert.match(r.summary, /may now name builds of different tags/);
});

test("rc-tag point: a failure moving the app's rc, the first write, leaves the slicer's rc alone", () => {
  const r = pointRun(pointEnv({ CREATE_FAIL: `${RC_APP}:rc#1` }), OLD_RC);
  assert.notEqual(r.status, 0, r.log);
  assert.doesNotMatch(r.calls, new RegExp(`-t ${RC_SLICER}:rc `));
  assert.match(r.log, /::error::could not point ghcr\.io\/jonathanmcohen\/platehouse:rc at sha256:a{64}/);
  assert.match(r.log, /every rc tag it had moved is back where it was/);
});
