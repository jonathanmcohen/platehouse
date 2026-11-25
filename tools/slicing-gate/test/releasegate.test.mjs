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
import { ciVerdict, highestRelease, isLatest, MAX_FETCH_ERRORS, NO_RUNS_MINUTES, WAIT_MINUTES, waitForCi } from "../../../.github/scripts/release-gate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const run = (status, conclusion, head_sha = SHA, event = "push") => ({ status, conclusion, head_sha, event });

test("ciVerdict: a completed success passes", () => {
  assert.equal(ciVerdict([run("completed", "success")], SHA), "pass");
});

test("ciVerdict: a workflow_dispatch run counts", () => {
  assert.equal(ciVerdict([run("completed", "success", SHA, "workflow_dispatch")], SHA), "pass");
});

test("ciVerdict: a pull_request success alone does not pass (it tested the merge ref)", () => {
  assert.equal(ciVerdict([run("completed", "success", SHA, "pull_request")], SHA), "fail");
});

test("ciVerdict: a fork pull request's success does not pass, nor does its running run make it wait", () => {
  assert.equal(ciVerdict([run("completed", "success", SHA, "pull_request_target")], SHA), "fail");
  assert.equal(ciVerdict([run("in_progress", null, SHA, "pull_request")], SHA), "fail");
});

test("ciVerdict: a pull_request success beside a push failure still fails", () => {
  assert.equal(ciVerdict([run("completed", "success", SHA, "pull_request"), run("completed", "failure")], SHA), "fail");
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

// The docs site (docs-pages.yml) names the highest release when it refuses
// to publish main.
test("highestRelease: the highest plain vX.Y.Z, past rcs and throwaway tags", () => {
  assert.equal(highestRelease(["v0.1.0", "v0.2.0-rc.1", "v0.1.1", "v0.0.0-test"]), "v0.1.1");
});

test("highestRelease: no plain release is null", () => {
  assert.equal(highestRelease(["v0.2.0-rc.1"]), null);
  assert.equal(highestRelease([]), null);
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

test("waitForCi: no runs yet waits NO_RUNS_MINUTES for the first, then passes if one shows up", async () => {
  const answers = [[], [], [run("completed", "success")]];
  const sleeps = [];
  const verdict = await waitForCi({ sha: SHA, fetchRuns: async () => answers.shift(), sleep: async (ms) => sleeps.push(ms) });
  assert.equal(verdict, "pass");
  assert.equal(sleeps.length, 2);
});

test("waitForCi: no runs at all fails after NO_RUNS_MINUTES, not WAIT_MINUTES", async () => {
  let slept = 0;
  const verdict = await waitForCi({
    sha: SHA,
    fetchRuns: async () => [],
    sleep: async (ms) => {
      slept += ms;
    },
  });
  assert.equal(verdict, "fail");
  assert.equal(NO_RUNS_MINUTES, 5);
  assert.equal(slept, NO_RUNS_MINUTES * 60 * 1000);
});

test("waitForCi: only a pull_request run counts as no runs", async () => {
  let slept = 0;
  const verdict = await waitForCi({
    sha: SHA,
    fetchRuns: async () => [run("completed", "success", SHA, "pull_request")],
    sleep: async (ms) => {
      slept += ms;
    },
  });
  assert.equal(verdict, "fail");
  assert.equal(slept, NO_RUNS_MINUTES * 60 * 1000);
});

test("waitForCi: an error fetching the runs is retried, and a later answer is used", async () => {
  const steps = [new Error("502"), new Error("502"), [run("completed", "success")]];
  const verdict = await waitForCi({
    sha: SHA,
    fetchRuns: async () => {
      const s = steps.shift();
      if (s instanceof Error) throw s;
      return s;
    },
    sleep: async () => {},
  });
  assert.equal(verdict, "pass");
});

test("waitForCi: errors that are not consecutive do not add up", async () => {
  const steps = [new Error("a"), new Error("b"), [run("in_progress", null)], new Error("c"), new Error("d"), [run("completed", "success")]];
  const verdict = await waitForCi({
    sha: SHA,
    fetchRuns: async () => {
      const s = steps.shift();
      if (s instanceof Error) throw s;
      return s;
    },
    sleep: async () => {},
  });
  assert.equal(verdict, "pass");
});

test("waitForCi: the MAX_FETCH_ERRORS-th error in a row is thrown", async () => {
  let calls = 0;
  await assert.rejects(
    waitForCi({
      sha: SHA,
      fetchRuns: async () => {
        calls += 1;
        throw new Error("boom");
      },
      sleep: async () => {},
    }),
    /boom/,
  );
  assert.equal(calls, MAX_FETCH_ERRORS);
});

const SCRIPT = fileURLToPath(new URL("../../../.github/scripts/release-gate.mjs", import.meta.url));
const cli = (args, input = "") => spawnSync(process.execPath, [SCRIPT, ...args], { input, encoding: "utf8" });

test("release-gate.mjs latest prints true or false from the tag list on stdin", () => {
  assert.equal(cli(["latest", "v0.1.1"], "v0.1.0\nv0.1.1\n").stdout, "true\n");
  assert.equal(cli(["latest", "v0.1.2"], "v0.2.0\nv0.1.2\n").stdout, "false\n");
  assert.equal(cli(["latest", "v0.2.0-rc.1"], "v0.1.0\n").stdout, "false\n");
});

test("release-gate.mjs latest says false when the tag list does not hold the tag", () => {
  assert.equal(cli(["latest", "v0.1.1"], "").stdout, "false\n");
  assert.equal(cli(["latest", "v0.1.1"], "v0.1.0\n").stdout, "false\n");
});

test("release-gate.mjs highest prints the highest release from the tag list on stdin, or nothing", () => {
  assert.equal(cli(["highest"], "v0.1.0\nv0.2.0-rc.1\nv0.1.1\nv0.0.0-test\n").stdout, "v0.1.1\n");
  const none = cli(["highest"], "");
  assert.equal(none.status, 0);
  assert.equal(none.stdout, "");
});

test("release-gate.mjs fails on a bad mode, and ci without a sha", () => {
  assert.notEqual(cli(["other"]).status, 0);
  assert.notEqual(cli(["ci"]).status, 0);
});

const workflow = (f) => readFileSync(resolve(ROOT, ".github/workflows", f), "utf8");
const jobText = (text, name) => {
  const start = text.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `job ${name}`);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};
const release = workflow("release.yml");
const gateJob = jobText(release, "gate");
const mergeJob = jobText(release, "merge");

// The gate steps both workflows share, as the text they must hold.
function assertGateJob(job, label) {
  assert.match(job, /fetch-depth: 0/, `${label}: full history`);
  assert.match(job, /persist-credentials: false/, `${label}: no stored credentials`);
  assert.match(job, /git branch -r --contains/, `${label}: branch check`);
  assert.match(job, /origin\/\(main\$\|release\/\)/, `${label}: main or release/`);
  assert.match(job, /release-gate\.mjs ci /, `${label}: ci check`);
  assert.match(job, /permissions:\s*\n\s+contents: read\s*\n\s+actions: read/, `${label}: actions: read`);
  assert.match(job, /GH_TOKEN: \$\{\{ github\.token \}\}/, `${label}: token`);
  assert.match(job, /timeout-minutes: 75/, `${label}: timeout beyond the wait`);
}

test("release.yml: the gate checks out full history, the branch and the CI run", () => {
  assertGateJob(gateJob, "release gate");
});

test("release.yml: the merge job works latest out again from the live tags before it tags", () => {
  assert.match(mergeJob, /needs: \[gate, build\]/);
  assert.match(mergeJob, /sparse-checkout: \|\s*\n\s+docker\s*\n\s+\.github\/scripts/);
  const latestAt = mergeJob.indexOf("id: latest");
  const metaAt = mergeJob.indexOf("name: Tags for this ref");
  assert.ok(latestAt > 0 && latestAt < metaAt, "the latest step comes before the tags step");
  const step = mergeJob.slice(latestAt, metaAt);
  assert.match(step, /git\/matching-refs\/tags\/v/);
  assert.match(step, /release-gate\.mjs latest /);
  assert.doesNotMatch(step.slice(step.indexOf("run:")), /\$\{\{/, "no expression inside run:");
});

test("release.yml: every metadata-action sets latest=false, and the tags step adds latest only when the live check says so", () => {
  const uses = [...release.matchAll(/uses: docker\/metadata-action@/g)].length;
  const flavors = [...release.matchAll(/^\s+flavor: \|\s*\n\s+latest=false$/gm)].length;
  assert.equal(uses, 3);
  assert.equal(flavors, uses, "latest=false on every metadata-action step");
  const tagsStep = release.slice(release.indexOf("name: Tags for this ref"), release.indexOf("name: Annotations for the index"));
  assert.ok(
    tagsStep.includes("type=raw,value=latest,enable=${{ steps.latest.outputs.latest == 'true' }}"),
    "the latest tag is gated on the live check",
  );
  assert.doesNotMatch(release, /needs\.gate\.outputs\.latest/, "no stale gate-time latest");
});

const slicer = workflow("slicer-image.yml");
const slicerGate = jobText(slicer, "gate");
const slicerDetect = jobText(slicer, "detect");
const slicerStable = jobText(slicer, "stable");

test("slicer-image.yml: a tag run passes the same gate before detect and build", () => {
  assertGateJob(slicerGate, "slicer gate");
  assert.match(slicerGate, /if: \$\{\{ github\.ref_type == 'tag' \}\}/);
  assert.match(slicerDetect, /needs: gate/);
  assert.match(slicerDetect, /needs\.gate\.result == 'success' \|\| needs\.gate\.result == 'skipped'/);
  const detectIf = slicerDetect.match(/\n    if: .*\n/)?.[0] ?? "";
  assert.match(detectIf, /!cancelled\(\)/);
  assert.match(jobText(slicer, "build"), /needs: detect/, "build waits for detect, which waits for the gate");
});

test("slicer-image.yml: detect leaves stable alone on a tag that is not the highest release", () => {
  assert.match(slicerDetect, /git\/matching-refs\/tags\/v/);
  assert.match(slicerDetect, /release-gate\.mjs latest /);
  assert.match(slicerDetect, /stable=false/);
});

test("slicer-image.yml: the stable job checks again, from the live tags, just before it moves stable", () => {
  assert.match(slicerStable, /sparse-checkout: \.github\/scripts/);
  assert.match(slicerStable, /git\/matching-refs\/tags\/v/);
  assert.match(slicerStable, /release-gate\.mjs latest /);
  assert.match(slicerStable, /steps\.recheck\.outputs\.move != 'false'/);
  assert.match(slicerStable, /permissions:\s*\n\s+contents: read\s*\n\s+packages: write/);
});
