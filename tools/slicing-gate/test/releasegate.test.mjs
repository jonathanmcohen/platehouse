// The release gate (#450): a v* tag publishes only a commit CI proved, and
// `latest` goes only to the highest stable release. ciVerdict, isLatest and
// waitForCi are pure or take their I/O as arguments; the workflow wiring is
// read as text, like the other workflow tests.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ciVerdict, isLatest, WAIT_MINUTES, waitForCi } from "../../../.github/scripts/release-gate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const run = (status, conclusion, head_sha = SHA, event = "push") => ({ status, conclusion, head_sha, event });

test("ciVerdict: a completed success passes", () => {
  assert.equal(ciVerdict([run("completed", "success")], SHA), "pass");
});

test("ciVerdict: a pass on a pull_request run for the same commit counts too", () => {
  assert.equal(ciVerdict([run("completed", "success", SHA, "pull_request")], SHA), "pass");
});

test("ciVerdict: in progress waits, then a success passes", () => {
  assert.equal(ciVerdict([run("in_progress", null)], SHA), "wait");
  assert.equal(ciVerdict([run("queued", null)], SHA), "wait");
  assert.equal(ciVerdict([run("in_progress", null), run("completed", "success")], SHA), "pass");
});

test("ciVerdict: only a failure fails", () => {
  assert.equal(ciVerdict([run("completed", "failure")], SHA), "fail");
});

test("ciVerdict: only a cancelled run fails", () => {
  assert.equal(ciVerdict([run("completed", "cancelled")], SHA), "fail");
});

test("ciVerdict: no runs fails", () => {
  assert.equal(ciVerdict([], SHA), "fail");
});

test("ciVerdict: a run on another commit is ignored", () => {
  assert.equal(ciVerdict([run("completed", "success", OTHER)], SHA), "fail");
  assert.equal(ciVerdict([run("in_progress", null, OTHER)], SHA), "fail");
});

test("ciVerdict: a cancelled run followed by a successful re-run passes", () => {
  assert.equal(ciVerdict([run("completed", "cancelled"), run("completed", "success")], SHA), "pass");
});

test("ciVerdict: a failure with a run still going waits", () => {
  assert.equal(ciVerdict([run("completed", "failure"), run("queued", null)], SHA), "wait");
});

test("isLatest: a plain release above the old ones is latest", () => {
  assert.equal(isLatest("v0.1.1", ["v0.1.0"]), true);
});

test("isLatest: a backport after a higher release is not", () => {
  assert.equal(isLatest("v0.1.2", ["v0.2.0"]), false);
});

test("isLatest: an rc tag is never latest", () => {
  assert.equal(isLatest("v0.2.0-rc.1", ["v0.1.0"]), false);
  assert.equal(isLatest("v0.2.0-rc.1", []), false);
});

test("isLatest: the current highest is latest, with rcs and odd tags around it", () => {
  assert.equal(isLatest("v0.2.0", ["v0.2.0", "v0.1.0", "v0.3.0-rc.1", "v0.0.0-test"]), true);
  assert.equal(isLatest("v0.2.0", ["v0.1.9", "v0.2.0"]), true);
  assert.equal(isLatest("v0.2.0", ["v0.10.0"]), false);
});

test("isLatest: a tag that is not vX.Y.Z is not latest", () => {
  assert.equal(isLatest("v0.0.0-test", []), false);
  assert.equal(isLatest("nonsense", []), false);
});

test("waitForCi: waits while the run is going, then passes", async () => {
  const answers = [[run("queued", null)], [run("in_progress", null)], [run("completed", "success")]];
  const sleeps = [];
  const verdict = await waitForCi({
    sha: SHA,
    fetchRuns: async () => answers.shift(),
    sleep: async (ms) => sleeps.push(ms),
  });
  assert.equal(verdict, "pass");
  assert.deepEqual(sleeps, [30000, 30000]);
});

test("waitForCi: fails at once on a failed run", async () => {
  const verdict = await waitForCi({
    sha: SHA,
    fetchRuns: async () => [run("completed", "failure")],
    sleep: async () => assert.fail("must not sleep"),
  });
  assert.equal(verdict, "fail");
});

test("waitForCi: a run that never finishes times out as a failure", async () => {
  let slept = 0;
  const verdict = await waitForCi({
    sha: SHA,
    fetchRuns: async () => [run("in_progress", null)],
    sleep: async (ms) => {
      slept += ms;
    },
  });
  assert.equal(verdict, "fail");
  assert.equal(WAIT_MINUTES, 60);
  assert.equal(slept, WAIT_MINUTES * 60 * 1000);
});

const SCRIPT = fileURLToPath(new URL("../../../.github/scripts/release-gate.mjs", import.meta.url));
const cli = (args, input = "") => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: "utf8" });

test("release-gate.mjs latest prints true or false from the tag list on stdin", () => {
  assert.equal(cli(["latest", "v0.1.1"], "v0.1.0\nv0.1.1\n").stdout, "true\n");
  assert.equal(cli(["latest", "v0.1.2"], "v0.2.0\nv0.1.2\n").stdout, "false\n");
  assert.equal(cli(["latest", "v0.2.0-rc.1"], "v0.1.0\n").stdout, "false\n");
});

test("release-gate.mjs fails on a bad mode, and ci without a sha", () => {
  assert.notEqual(cli(["other"]).status, 0);
  assert.notEqual(cli(["ci"]).status, 0);
});

const release = readFileSync(resolve(ROOT, ".github/workflows/release.yml"), "utf8");
const gateJob = release.slice(release.indexOf("\n  gate:\n"), release.indexOf("\n  build:\n"));

test("release.yml: the gate checks out full history, the branch, the CI run, and outputs latest", () => {
  assert.match(gateJob, /fetch-depth: 0/);
  assert.match(gateJob, /persist-credentials: false/);
  assert.match(gateJob, /git branch -r --contains/);
  assert.match(gateJob, /origin\/main/);
  assert.match(gateJob, /origin\/release\//);
  assert.match(gateJob, /release-gate\.mjs ci /);
  assert.match(gateJob, /git tag -l 'v\*'/);
  assert.match(gateJob, /release-gate\.mjs latest /);
  assert.match(gateJob, /outputs:\s*\n\s+latest: \$\{\{ steps\.\w+\.outputs\.latest \}\}/);
});

test("release.yml: the gate token can read workflow runs", () => {
  assert.match(gateJob, /permissions:\s*\n\s+contents: read\s*\n\s+actions: read/);
  assert.match(gateJob, /GH_TOKEN: \$\{\{ github\.token \}\}/);
});

test("release.yml: every metadata-action sets latest=false, and the tags step adds latest only when the gate says so", () => {
  const uses = [...release.matchAll(/uses: docker\/metadata-action@/g)].length;
  const flavors = [...release.matchAll(/^\s+flavor: \|\s*\n\s+latest=false$/gm)].length;
  assert.equal(uses, 3);
  assert.equal(flavors, uses, "latest=false on every metadata-action step");
  const tagsStep = release.slice(release.indexOf("name: Tags for this ref"), release.indexOf("name: Annotations for the index"));
  assert.ok(
    tagsStep.includes("type=raw,value=latest,enable=${{ needs.gate.outputs.latest == 'true' }}"),
    "the latest tag is gated on the gate's output",
  );
  assert.match(release, /^  merge:\n(?:.*\n)*?    needs: \[gate, build\]$/m);
});
