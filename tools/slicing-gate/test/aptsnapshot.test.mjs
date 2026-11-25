// Pins the monthly Ubuntu snapshot refresh (issue #219): the date logic in
// .github/scripts/apt-snapshot.mjs, and .github/workflows/apt-snapshot.yml,
// read as text like the other workflows (see ciworkflow.test.mjs), with its
// shell steps run in bash and git, gh and node stubbed. None of this runs the
// workflow on GitHub or asks snapshot.ubuntu.com anything: every request goes
// to a stand-in for fetch.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ATTEMPTS,
  DOCKERFILES,
  GATE_README,
  LOOKBACK_DAYS,
  SNAPSHOT_URL,
  SUITES,
  candidates,
  currentPin,
  dockerfilePin,
  findLeftovers,
  grepArgs,
  isSnapshot,
  label,
  leftovers,
  pickSnapshot,
  reachable,
  refresh,
  rewritePins,
  snapshotFor,
} from "../../../.github/scripts/apt-snapshot.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const WORKFLOW = join(ROOT, ".github", "workflows", "apt-snapshot.yml");
const SCRIPT = join(ROOT, ".github", "scripts", "apt-snapshot.mjs");
const CI = join(ROOT, ".github", "workflows", "ci.yml");
const RELEASE = join(ROOT, ".github", "workflows", "release.yml");
const SLICER_DOCKERFILE = join(ROOT, "apps", "slicer", "Dockerfile");
const GATE_DOCKERFILE = join(ROOT, "tools", "slicing-gate", "Dockerfile");
const GATE_README_FILE = join(ROOT, "tools", "slicing-gate", "README.md");
const text = () => readFileSync(WORKFLOW, "utf8");

// A stand-in job token for the stubbed steps; not a credential of any kind.
const FAKE_TOKEN = ["place", "holder"].join("-");

// The repo's own three pinned files, by the repo-relative names the script
// uses.
const repoTexts = () => ({
  "apps/slicer/Dockerfile": readFileSync(SLICER_DOCKERFILE, "utf8"),
  "tools/slicing-gate/Dockerfile": readFileSync(GATE_DOCKERFILE, "utf8"),
  "tools/slicing-gate/README.md": readFileSync(GATE_README_FILE, "utf8"),
});

// Small stand-ins for the three files, pinned at ts.
const fakeTexts = (ts, gateTs = ts, readmeTs = ts) => ({
  "apps/slicer/Dockerfile": `FROM x\n# about the snapshot\nARG APT_SNAPSHOT=${ts}\nARG ORCA_VERSION=2.5.0\nFROM y\nARG APT_SNAPSHOT\n`,
  "tools/slicing-gate/Dockerfile": `FROM x\nARG APT_SNAPSHOT=${gateTs}\nFROM y\nARG APT_SNAPSHOT\n`,
  "tools/slicing-gate/README.md": `| What | Version |\n|---|---|\n| apt packages | Ubuntu snapshot ${readmeTs} | signed snapshot index (apt) |\n`,
});

// Test dates and the leftover check. The workflow stops when any tracked
// file but the three pins names the old snapshot, and the pin only moves
// forward, so a snapshot written in this file must be one that can never be a
// pin: a 2020 date, long behind it. A snapshot beyond every candidate is
// computed here, a century from now, and never written in the file.
const FAR_YEAR = new Date().getUTCFullYear() + 100;
const FAR = snapshotFor(new Date(Date.UTC(FAR_YEAR, 11, 31)));
const FAR_EVE = snapshotFor(new Date(Date.UTC(FAR_YEAR, 11, 30)));

// A stand-in for fetch: answer(url, n) gives a status for the nth call, or
// throws. Every call is recorded.
function fakeFetch(answer) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { status: answer(url, calls.length) };
  };
  return { fn, calls };
}
const noSleep = async () => {};
const dayOf = (url) => url.slice(SNAPSHOT_URL.length + 1).split("/")[0];

// ---------------------------------------------------------------- the script

test("the script's files are the two Dockerfiles and the gate README's pins table", () => {
  assert.deepEqual(DOCKERFILES, ["apps/slicer/Dockerfile", "tools/slicing-gate/Dockerfile"]);
  assert.equal(GATE_README, "tools/slicing-gate/README.md");
  assert.deepEqual(SUITES, ["noble", "noble-updates", "noble-security"]);
  assert.equal(SNAPSHOT_URL, "https://snapshot.ubuntu.com/ubuntu");
});

// The two images must install from the same snapshot, so the refresh moves
// them together; today's repo must already agree.
test("the slicer image, the slicing gate image and the gate README pin one snapshot today", () => {
  const texts = repoTexts();
  const ts = currentPin(texts);
  assert.ok(isSnapshot(ts), ts);
  // Each file names a snapshot timestamp only once (a Dockerfile on its ARG
  // line), so the rewrite moves every stage: the stages read ${APT_SNAPSHOT}.
  for (const [name, t] of Object.entries(texts)) {
    const stamps = t.match(/\b\d{8}T\d{6}Z\b/g) ?? [];
    assert.deepEqual(stamps, [ts], `${name} names the snapshot once`);
  }
  for (const f of DOCKERFILES) {
    assert.match(texts[f], /APT::Snapshot \\"\$\{APT_SNAPSHOT\}\\"/, `${f} turns on the snapshot from the ARG`);
  }
});

for (const [s, want] of [
  ["20201107T000000Z", true],
  ["20201231T235959Z", true],
  ["20240229T000000Z", true],
  ["20250229T000000Z", false],
  ["20201301T000000Z", false],
  ["20201100T000000Z", false],
  ["20201107T240000Z", false],
  ["20201107T000000", false],
  ["2020-11-07T00:00:00Z", false],
  [" 20201107T000000Z", false],
  ["20201107T000000Z\n", false],
  ["", false],
  [undefined, false],
]) {
  test(`isSnapshot(${JSON.stringify(s)}) is ${want}`, () => {
    assert.equal(isSnapshot(s), want);
  });
}

test("label reads a snapshot as a date a person reads", () => {
  assert.equal(label("20201107T000000Z"), "7 November 2020");
  assert.equal(label("20210101T000000Z"), "1 January 2021");
  assert.throws(() => label("2020-11-07"), /not a snapshot timestamp/);
});

test("candidates: midnight UTC today, then each day before it, a week in all, newest first", () => {
  assert.equal(LOOKBACK_DAYS, 7);
  assert.deepEqual(candidates(new Date("2020-12-01T06:00:00Z")), [
    "20201201T000000Z",
    "20201130T000000Z",
    "20201129T000000Z",
    "20201128T000000Z",
    "20201127T000000Z",
    "20201126T000000Z",
    "20201125T000000Z",
  ]);
  // Across a year end, and at the last second of a day: still that UTC day.
  assert.deepEqual(candidates(new Date("2021-01-02T23:59:59Z")).slice(0, 3), [
    "20210102T000000Z",
    "20210101T000000Z",
    "20201231T000000Z",
  ]);
  assert.equal(snapshotFor(new Date("2020-03-09T00:00:00.000Z")), "20200309T000000Z");
  assert.throws(() => candidates(new Date("nope")), /not a date/);
});

// Every candidate is midnight UTC of a day that has begun, so it is never in
// the future when the run asks for it: a future timestamp would resolve to a
// different archive state on every build.
test("candidates: never later than now", () => {
  for (const iso of ["2020-12-01T00:00:00Z", "2020-12-01T00:00:01Z", "2020-12-01T23:59:59Z"]) {
    const now = new Date(iso);
    for (const ts of candidates(now)) {
      const t = Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8));
      assert.ok(t <= now.getTime(), `${ts} is not after ${iso}`);
    }
  }
});

test("dockerfilePin: exactly one ARG APT_SNAPSHOT= line holding a timestamp", () => {
  assert.equal(dockerfilePin("ARG APT_SNAPSHOT=20201107T000000Z\nARG APT_SNAPSHOT\n"), "20201107T000000Z");
  assert.throws(() => dockerfilePin("ARG APT_SNAPSHOT\n", "f"), /f has 0 ARG APT_SNAPSHOT= lines/);
  assert.throws(
    () => dockerfilePin("ARG APT_SNAPSHOT=20201107T000000Z\nARG APT_SNAPSHOT=20201108T000000Z\n", "f"),
    /f has 2 ARG APT_SNAPSHOT= lines/,
  );
  assert.throws(() => dockerfilePin("ARG APT_SNAPSHOT=latest\n", "f"), /not a snapshot timestamp/);
});

test("currentPin: the files must agree, and each must pin exactly once", () => {
  assert.equal(currentPin(fakeTexts("20201107T000000Z")), "20201107T000000Z");
  assert.throws(
    () => currentPin(fakeTexts("20201107T000000Z", "20201108T000000Z")),
    /disagree: apps\/slicer\/Dockerfile 20201107T000000Z, tools\/slicing-gate\/Dockerfile 20201108T000000Z/,
  );
  assert.throws(() => currentPin(fakeTexts("20201107T000000Z", "20201107T000000Z", "20201101T000000Z")), /disagree/);
  const two = fakeTexts("20201107T000000Z");
  two[GATE_README] += "| more | Ubuntu snapshot 20201107T000000Z |\n";
  assert.throws(() => currentPin(two), /lists 2 "Ubuntu snapshot" pins/);
  const missing = fakeTexts("20201107T000000Z");
  delete missing["tools/slicing-gate/Dockerfile"];
  assert.throws(() => currentPin(missing), /tools\/slicing-gate\/Dockerfile was not read/);
});

test("rewritePins changes the pin lines and nothing else", () => {
  const before = repoTexts();
  const from = currentPin(before);
  const to = FAR;
  const after = rewritePins(before, from, to);
  assert.equal(currentPin(after), to);
  for (const f of Object.keys(before)) {
    const a = before[f].split("\n");
    const b = after[f].split("\n");
    assert.equal(a.length, b.length, f);
    const diff = a.map((l, i) => [l, b[i]]).filter(([x, y]) => x !== y);
    assert.equal(diff.length, 1, `${f}: one line changed`);
    assert.equal(diff[0][1], diff[0][0].replace(from, to), `${f}: only the timestamp changed`);
  }
  assert.throws(() => rewritePins(before, from, "tomorrow"), /not a snapshot timestamp/);
});

test("reachable: ok when every suite's InRelease answers 200, asked with HEAD", async () => {
  const f = fakeFetch(() => 200);
  assert.deepEqual(await reachable("20201201T000000Z", f.fn, noSleep), { state: "ok", detail: "" });
  assert.deepEqual(
    f.calls.map((c) => c.url),
    SUITES.map((s) => `https://snapshot.ubuntu.com/ubuntu/20201201T000000Z/dists/${s}/InRelease`),
  );
  for (const c of f.calls) assert.equal(c.init.method, "HEAD");
});

test("reachable: a 404 for any suite means the snapshot is missing, without retrying", async () => {
  const f = fakeFetch((url) => (url.includes("noble-security") ? 404 : 200));
  const r = await reachable("20201201T000000Z", f.fn, noSleep);
  assert.equal(r.state, "missing");
  assert.match(r.detail, /noble-security\/InRelease answered 404/);
  assert.equal(f.calls.length, 3);
});

test("reachable: a passing 5xx or network error is retried", async () => {
  const f = fakeFetch((_url, n) => {
    if (n === 1) throw new Error("socket hang up");
    if (n === 2) return 503;
    return 200;
  });
  const slept = [];
  const r = await reachable("20201201T000000Z", f.fn, async (ms) => slept.push(ms));
  assert.equal(r.state, "ok");
  assert.equal(f.calls.length, 5, "noble three times, then the other two once");
  assert.deepEqual(slept, [5000, 10000]);
});

test("reachable: a suite that keeps erroring is an error, not a missing snapshot", async () => {
  for (const status of [503, 302, 500]) {
    const f = fakeFetch(() => status);
    const r = await reachable("20201201T000000Z", f.fn, noSleep);
    assert.equal(r.state, "error", String(status));
    assert.match(r.detail, new RegExp(`answered ${status} \\(${ATTEMPTS} attempts\\)$`));
    assert.equal(f.calls.length, ATTEMPTS);
  }
  const thrown = fakeFetch(() => {
    throw new Error("getaddrinfo ENOTFOUND");
  });
  const r = await reachable("20201201T000000Z", thrown.fn, noSleep);
  assert.equal(r.state, "error");
  assert.match(r.detail, /ENOTFOUND/);
});

const NOW = new Date("2020-12-01T06:00:00Z");

test("pickSnapshot: the newest day that exists, today when it does", async () => {
  const f = fakeFetch(() => 200);
  assert.equal(await pickSnapshot("20201107T000000Z", NOW, { fetchFn: f.fn, sleep: noSleep }), "20201201T000000Z");
});

test("pickSnapshot: a day the service does not have is passed over for the day before", async () => {
  const f = fakeFetch((url) => (dayOf(url) === "20201201T000000Z" ? 404 : 200));
  const logged = [];
  const ts = await pickSnapshot("20201107T000000Z", NOW, { fetchFn: f.fn, sleep: noSleep, log: (m) => logged.push(m) });
  assert.equal(ts, "20201130T000000Z");
  assert.match(logged.join("\n"), /20201201T000000Z is not on the service/);
});

test("pickSnapshot: an error from the service stops the refresh, never settling for an older day", async () => {
  const f = fakeFetch((url) => (dayOf(url) === "20201201T000000Z" ? 503 : 200));
  await assert.rejects(
    pickSnapshot("20201107T000000Z", NOW, { fetchFn: f.fn, sleep: noSleep }),
    /could not tell whether snapshot 20201201T000000Z exists: .* answered 503 \(4 attempts\); nothing was changed/,
  );
  assert.ok(f.calls.every((c) => dayOf(c.url) === "20201201T000000Z"), "no older day was asked");
});

test("pickSnapshot: only days newer than the pin count; none newer means nothing to do", async () => {
  const f = fakeFetch(() => 200);
  assert.equal(await pickSnapshot("20201201T000000Z", NOW, { fetchFn: f.fn, sleep: noSleep }), null);
  assert.equal(await pickSnapshot(FAR, NOW, { fetchFn: f.fn, sleep: noSleep }), null);
  assert.equal(f.calls.length, 0, "nothing was asked");
  // Pinned at 28 November: only 1 December, 30 and 29 November are newer.
  const missing = fakeFetch(() => 404);
  await assert.rejects(
    pickSnapshot("20201128T000000Z", NOW, { fetchFn: missing.fn, sleep: noSleep }),
    /no snapshot newer than 20201128T000000Z exists/,
  );
  assert.deepEqual(
    [...new Set(missing.calls.map((c) => dayOf(c.url)))],
    ["20201201T000000Z", "20201130T000000Z", "20201129T000000Z"],
  );
});

// The rule from issue #219's brief: a snapshot date that does not exist on
// snapshot.ubuntu.com is never written. The service is asked before any
// write.
function refreshWith(answer, texts = fakeTexts("20201107T000000Z")) {
  const written = {};
  const f = fakeFetch(answer);
  const run = refresh({
    now: NOW,
    fetchFn: f.fn,
    sleep: noSleep,
    read: (p) => {
      assert.ok(p in texts, `reads only the pinned files: ${p}`);
      return texts[p];
    },
    write: (p, t) => {
      assert.ok(f.calls.length > 0, "the service was asked before any write");
      written[p] = t;
    },
  });
  return { run, written, calls: f.calls };
}

test("refresh: moves all three pins to the new snapshot, asking the service first", async () => {
  const { run, written } = refreshWith(() => 200);
  assert.deepEqual(await run, { old: "20201107T000000Z", new: "20201201T000000Z" });
  assert.deepEqual(Object.keys(written).sort(), [...DOCKERFILES, GATE_README].sort());
  assert.equal(currentPin(written), "20201201T000000Z");
});

test("refresh: a date that does not exist on snapshot.ubuntu.com is not written", async () => {
  for (const answer of [
    () => 404,
    (url) => (url.includes("noble-updates") ? 404 : 200),
    (url) => (url.includes("noble-security") ? 404 : 200),
  ]) {
    const { run, written } = refreshWith(answer);
    await assert.rejects(run, /no snapshot newer than 20201107T000000Z exists/);
    assert.deepEqual(written, {}, "nothing was written");
  }
});

test("refresh: today missing but yesterday there writes yesterday, never today", async () => {
  const { run, written } = refreshWith((url) => (dayOf(url) === "20201201T000000Z" ? 404 : 200));
  assert.equal((await run).new, "20201130T000000Z");
  for (const t of Object.values(written)) assert.doesNotMatch(t, /20201201T000000Z/);
});

test("refresh: a service error writes nothing", async () => {
  const { run, written } = refreshWith(() => 502);
  await assert.rejects(run, /could not tell whether snapshot/);
  assert.deepEqual(written, {});
});

test("refresh: files that disagree stop it before the service is asked", async () => {
  const { run, written, calls } = refreshWith(() => 200, fakeTexts("20201107T000000Z", "20201108T000000Z"));
  await assert.rejects(run, /disagree/);
  assert.deepEqual(written, {});
  assert.equal(calls.length, 0);
});

test("refresh: already at the newest day changes nothing", async () => {
  const { run, written } = refreshWith(() => 200, fakeTexts("20201201T000000Z"));
  assert.deepEqual(await run, { old: "20201201T000000Z", new: null });
  assert.deepEqual(written, {});
});

// The command line, offline: pinned beyond every candidate, so it asks the
// service nothing and prints the up-to-date answer.
function inScratch(fn) {
  const dir = mkdtempSync(join(tmpdir(), "apt-snapshot-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function writeTree(dir, texts) {
  for (const [p, t] of Object.entries(texts)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), t);
  }
}

test("the command line prints old=, new=, old_label= and new_label= and changes nothing when up to date", () => {
  inScratch((dir) => {
    const texts = fakeTexts(FAR);
    writeTree(dir, texts);
    const r = spawnSync(process.execPath, [SCRIPT, "refresh"], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `old=${FAR}\nnew=\nold_label=31 December ${FAR_YEAR}\nnew_label=\n`);
    assert.match(r.stderr, new RegExp(`current snapshot: ${FAR}`));
    for (const [p, t] of Object.entries(texts)) assert.equal(readFileSync(join(dir, p), "utf8"), t, p);
  });
});

test("the command line fails with an error annotation, and prints no outputs, when the pins disagree", () => {
  inScratch((dir) => {
    writeTree(dir, fakeTexts(FAR, FAR_EVE));
    const r = spawnSync(process.execPath, [SCRIPT, "refresh"], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /^::error::the snapshot pins disagree/m);
  });
  const usage = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(usage.status, 2);
});

// -------------------------------------------------------------- the workflow

// The on: block, from "on:" up to the next top-level key.
const onBlock = (t) => t.slice(t.indexOf("\non:\n")).split(/\n(?=[a-z])/)[1];

// One job's block under jobs:, by its id.
function jobBlock(t, id) {
  const jobs = t.slice(t.indexOf("\njobs:\n"));
  const at = jobs.indexOf(`\n  ${id}:\n`);
  assert.ok(at !== -1, `a job named ${id}`);
  return jobs.slice(at + 1).split(/\n(?= {2}[\w-]+:\n)/)[0];
}

// The steps of a job block, each from its "- name:" line.
const jobSteps = (block) => block.split(/\n(?= {6}- )/).slice(1);

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

// The workflow's top-level env: block as a map.
function workflowEnv(t) {
  const m = t.match(/\nenv:\n((?: {2}\S.*\n)+)/);
  assert.ok(m, "a top-level env: block");
  return Object.fromEntries(
    m[1]
      .trimEnd()
      .split("\n")
      .map((l) => l.match(/^ {2}(\w+): (.+)$/).slice(1)),
  );
}

// Runs one step of apt-snapshot.yml in bash in a scratch folder, after the
// given stub functions, with the workflow's env, GITHUB_OUTPUT,
// GITHUB_STEP_SUMMARY and CALLS, a file the stubs append to. Returns the exit
// status, the output, the step outputs, the summary, the stub calls and the
// named files from the folder.
function runStep(job, stepName, { env = {}, stubs = [], setup, files = [] } = {}) {
  return inScratch((dir) => {
    const work = join(dir, "work");
    mkdirSync(work);
    setup?.(work);
    const out = join(dir, "github-output");
    const summary = join(dir, "step-summary");
    const calls = join(dir, "calls");
    for (const f of [out, summary, calls]) writeFileSync(f, "");
    const t = text();
    const script = ["set -eo pipefail", ...stubs, stepScript(jobBlock(t, job), stepName)].join("\n");
    const r = spawnSync("bash", ["-c", script], {
      cwd: work,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        ...workflowEnv(t),
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
    const read = Object.fromEntries(
      files.map((f) => [f, existsSync(join(work, f)) ? readFileSync(join(work, f), "utf8") : null]),
    );
    return {
      status: r.status,
      log: `${r.stdout}${r.stderr}`,
      outputs,
      summary: readFileSync(summary, "utf8"),
      calls: readFileSync(calls, "utf8"),
      files: read,
    };
  });
}

test("apt-snapshot: runs at 06:00 UTC on the 1st of each month and by hand, nothing else", () => {
  const on = onBlock(text());
  assert.match(on, /^ {2}schedule:\n {4}- cron: "0 6 1 \* \*"\n(?! {4}- )/m, `monthly:\n${on}`);
  assert.match(on, /^ {2}workflow_dispatch:$/m);
  assert.doesNotMatch(on, /push:|pull_request|workflow_run|inputs:/, "no other trigger, no inputs");
});

test("apt-snapshot: one concurrency group, never cancelled part way, so two bot PRs never race", () => {
  const t = text();
  assert.match(t, /\nconcurrency:\n {2}group: apt-snapshot\n {2}cancel-in-progress: false\n/);
  assert.equal([...t.matchAll(/^\s*concurrency:/gm)].length, 1, "no job sets its own group");
  assert.equal(workflowEnv(t).BRANCH, "bot/apt-snapshot", "one fixed branch");
});

// Least privilege: contents and pull-requests write only on the job that
// pushes and opens the PR, actions write only on the job that starts ci.yml.
test("apt-snapshot: each job holds only the permissions it uses", () => {
  const t = text();
  assert.match(t, /^permissions:\n {2}contents: read\n(?! {2}\S)/m, "top-level permissions are contents: read alone");
  const perms = (id) => {
    const m = jobBlock(t, id).match(/\n {4}permissions:\n((?: {6}\S.*\n)+)/);
    assert.ok(m, `${id} sets its own permissions`);
    return Object.fromEntries(m[1].trimEnd().split("\n").map((l) => l.trim().split(": ")));
  };
  const jobs = [...t.slice(t.indexOf("\njobs:\n")).matchAll(/\n {2}([\w-]+):\n/g)].map((m) => m[1]);
  assert.deepEqual(jobs, ["refresh", "dispatch-ci"]);
  assert.deepEqual(perms("refresh"), { contents: "write", "pull-requests": "write" });
  assert.deepEqual(perms("dispatch-ci"), { actions: "write" });
  assert.doesNotMatch(t, /write-all|read-all|packages:|issues:|id-token:/, "nothing else is granted");
  assert.doesNotMatch(t, /secrets\./, "no secret: the job token comes from github.token");
  assert.doesNotMatch(t, /persist-credentials: true/);
  assert.match(t, /persist-credentials: false/, "the checkout keeps no token on disk");
  assert.doesNotMatch(t, /[^\x00-\x7F]/, "ASCII only");
});

test("apt-snapshot: every action is pinned to the exact tag release.yml or ci.yml uses", () => {
  const pins = (t) => {
    const out = {};
    for (const [, u] of t.matchAll(/uses: (\S+ # \S+)/g)) {
      const [name, tag] = u.split("@");
      (out[name] ??= new Set()).add(tag);
    }
    return out;
  };
  const release = pins(readFileSync(RELEASE, "utf8"));
  const ci = pins(readFileSync(CI, "utf8"));
  const ours = pins(text());
  assert.deepEqual(Object.keys(ours).sort(), ["actions/checkout", "actions/setup-node"]);
  for (const [name, tags] of Object.entries(ours)) {
    const [tag] = tags;
    assert.equal(tags.size, 1);
    assert.match(tag, /^[0-9a-f]{40} # v\d+\.\d+\.\d+$/, `${name}@${tag} is a commit SHA with its release tag`);
    assert.deepEqual([...(release[name] ?? ci[name])], [tag], `${name}@${tag}`);
  }
  assert.match(jobBlock(text(), "refresh"), /\n {10}node-version-file: \.node-version\n/);
});

test("apt-snapshot: jobs run on ubuntu-24.04 with timeouts; dispatch-ci only after a refresh with news", () => {
  const t = text();
  for (const id of ["refresh", "dispatch-ci"]) {
    const b = jobBlock(t, id);
    assert.match(b, /\n {4}runs-on: ubuntu-24\.04\n/, id);
    assert.match(b, /\n {4}timeout-minutes: \d+\n/, id);
  }
  const d = jobBlock(t, "dispatch-ci");
  assert.match(d, /\n {4}needs: refresh\n/);
  assert.match(
    d,
    /\n {4}if: \$\{\{ !cancelled\(\) && needs\.refresh\.result == 'success' && needs\.refresh\.outputs\.ci == 'true' \}\}\n/,
  );
  assert.match(jobBlock(t, "refresh"), /\n {6}ci: \$\{\{ steps\.pr\.outputs\.ci \}\}\n/);
  assert.match(jobBlock(t, "refresh"), /\n {8}if: \$\{\{ steps\.snapshot\.outputs\.new != '' \}\}\n/);
});

test("apt-snapshot: the main-only check runs first and refuses any other ref", () => {
  const steps = jobSteps(jobBlock(text(), "refresh"));
  assert.ok(steps[0].startsWith("      - name: Run only from main\n"), steps[0]);
  assert.equal(runStep("refresh", "Run only from main", { env: { REF: "refs/heads/main" } }).status, 0);
  for (const ref of ["refs/heads/feature", "refs/heads/bot/apt-snapshot", "refs/tags/v0.1.0", "refs/heads/main-x", ""]) {
    const r = runStep("refresh", "Run only from main", { env: { REF: ref } });
    assert.notEqual(r.status, 0, ref);
    assert.match(r.log, /::error::.* is not main/);
  }
  const names = steps.map((s) => s.match(/^ {6}- name: (.+)$/m)[1]);
  assert.deepEqual(names, [
    "Run only from main",
    "Check out",
    "Set up Node",
    "Pick the new snapshot and rewrite the pins",
    "Push the branch and open the pull request",
  ]);
});

test("apt-snapshot pick: hands the script's answer to the outputs, and says when it is up to date", () => {
  const answer = (n) =>
    `node() { printf '%s\\n' old=20201107T000000Z new=${n} 'old_label=7 November 2020' 'new_label=${n ? "1 December 2020" : ""}'; }`;
  const moved = runStep("refresh", "Pick the new snapshot and rewrite the pins", { stubs: [answer("20201201T000000Z")] });
  assert.equal(moved.status, 0, moved.log);
  assert.deepEqual(moved.outputs, {
    old: "20201107T000000Z",
    new: "20201201T000000Z",
    old_label: "7 November 2020",
    new_label: "1 December 2020",
  });
  assert.equal(moved.summary, "");
  const same = runStep("refresh", "Pick the new snapshot and rewrite the pins", { stubs: [answer("")] });
  assert.equal(same.status, 0, same.log);
  assert.equal(same.outputs.new, "");
  assert.match(same.summary, /Up to date: the Ubuntu snapshot is `20201107T000000Z`; nothing was pushed/);
  const failed = runStep("refresh", "Pick the new snapshot and rewrite the pins", {
    stubs: ["node() { echo '::error::no snapshot' >&2; return 1; }"],
  });
  assert.equal(failed.status, 1);
  assert.deepEqual(failed.outputs, {}, "a failed pick hands nothing on");
});

// The pick step with the real script, offline: pinned beyond every candidate,
// so nothing is asked of the service.
test("apt-snapshot pick: runs the script at the repo root and passes its outputs through", () => {
  const r = runStep("refresh", "Pick the new snapshot and rewrite the pins", {
    setup: (work) => {
      writeTree(work, fakeTexts(FAR));
      mkdirSync(join(work, ".github", "scripts"), { recursive: true });
      copyFileSync(SCRIPT, join(work, ".github", "scripts", "apt-snapshot.mjs"));
    },
  });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.outputs.old, FAR);
  assert.equal(r.outputs.new, "");
  assert.match(r.summary, /Up to date/);
});

// The PR step. git, gh and node are stubs: git diff lists CHANGED,
// ls-remote gives REMOTE (empty: no branch yet), git show of the fetched
// branch's Dockerfile gives FETCHED_SNAPSHOT (unset: it fails), the fetched tree equals
// HEAD's when SAME_TREE is 1, push exits PUSH_STATUS; the leftover check
// (node) fails listing LEFT when it is set; gh pr list gives EXISTING or,
// when PRS is set, runs its own --jq filter with jq over PRS, a JSON list of
// open pull requests; gh pr create prints a URL or, with CREATE_ERROR, fails
// with that message. Every call is recorded, in order. The leftover check
// itself is tested against real git below.
const PR_STUBS = [
  "node() {",
  '  echo "node $*" >>"$CALLS"',
  '  if [ -n "$LEFT" ]; then echo "::error::these files name the Ubuntu snapshot $3 or a later one" >&2; printf "%s\\n" "$LEFT" >&2; return 1; fi',
  "}",
  "git() {",
  '  echo "git $*" >>"$CALLS"',
  '  case "$1" in',
  '    diff) printf "%s" "$CHANGED" ;;',
  "    commit) cat >commit-message.txt ;;",
  '    ls-remote) if [ -n "$REMOTE" ]; then printf "%s\\trefs/heads/bot/apt-snapshot\\n" "$REMOTE"; fi ;;',
  '    show) if [ -n "$FETCHED_SNAPSHOT" ]; then echo "ARG APT_SNAPSHOT=$FETCHED_SNAPSHOT"; else return 128; fi ;;',
  '    rev-parse) case "$2" in "FETCH_HEAD^{tree}") if [ "$SAME_TREE" = 1 ]; then echo tree1; else echo tree0; fi ;; "HEAD^{tree}") echo tree1 ;; *) echo headsha ;; esac ;;',
  '    push) return "${PUSH_STATUS:-0}" ;;',
  "    *) return 0 ;;",
  "  esac",
  "}",
  "gh() {",
  '  echo "gh $*" >>"$CALLS"',
  '  case "$1 $2" in',
  '    "pr list")',
  '      if [ -z "$PRS" ]; then printf "%s" "$EXISTING"; return 0; fi',
  '      filter=""; prev=""; for a in "$@"; do if [ "$prev" = --jq ]; then filter="$a"; fi; prev="$a"; done',
  '      jq -r "$filter" <<<"$PRS" ;;',
  '    "pr edit") cp body.md posted.md ;;',
  '    "pr create") cp body.md posted.md; if [ -n "$CREATE_ERROR" ]; then echo "$CREATE_ERROR" >&2; return 1; fi; echo "https://github.com/o/r/pull/412" ;;',
  "    *) return 0 ;;",
  "  esac",
  "}",
];
const THREE = "apps/slicer/Dockerfile\ntools/slicing-gate/Dockerfile\ntools/slicing-gate/README.md\n";
const prRun = (env = {}) =>
  runStep("refresh", "Push the branch and open the pull request", {
    stubs: PR_STUBS,
    files: ["posted.md", "commit-message.txt"],
    env: {
      GH_TOKEN: FAKE_TOKEN,
      REPO: "o/r",
      OLD: "20201107T000000Z",
      NEW: "20201201T000000Z",
      OLD_LABEL: "7 November 2020",
      NEW_LABEL: "1 December 2020",
      SERVER_URL: "https://github.com",
      RUN_URL: "https://github.com/o/r/actions/runs/99",
      CHANGED: THREE,
      LEFT: "",
      REMOTE: "",
      SAME_TREE: "0",
      EXISTING: "",
      PRS: "",
      CREATE_ERROR: "",
      FETCHED_SNAPSHOT: "",
      ...env,
    },
  });
const callLines = (r, prefix) => r.calls.split("\n").filter((l) => l.startsWith(prefix));
const TITLE = "Move the slicer's Ubuntu snapshot to 1 December 2020 for security fixes";

test("apt-snapshot pr: a first run pushes the branch and opens the pull request; ci runs", () => {
  const r = prRun();
  assert.equal(r.status, 0, r.log);
  assert.equal(r.outputs.ci, "true");
  assert.deepEqual(callLines(r, "git push"), ["git push -q origin HEAD:refs/heads/bot/apt-snapshot"]);
  assert.deepEqual(callLines(r, "gh pr close"), []);
  assert.deepEqual(callLines(r, "git switch"), ["git switch -q -C bot/apt-snapshot"]);
  assert.deepEqual(callLines(r, "git add"), [
    "git add apps/slicer/Dockerfile tools/slicing-gate/Dockerfile tools/slicing-gate/README.md",
  ]);
  assert.deepEqual(callLines(r, "gh pr create"), [
    `gh pr create --repo o/r --base main --head bot/apt-snapshot --title ${TITLE} --body-file body.md`,
  ]);
  assert.match(r.summary, /pull request: #412/);
  assert.match(r.files["commit-message.txt"], /^Move the Ubuntu snapshot to 20201201T000000Z\n\n/);
  assert.match(r.files["commit-message.txt"], /from the snapshot of 1 December 2020 instead of 7 November\s+2020/);
  assert.match(r.files["commit-message.txt"], /Made by https:\/\/github\.com\/o\/r\/actions\/runs\/99\n$/);
});

test("apt-snapshot pr: the body says what moved, why, and where the checks and the Trivy report are", () => {
  const body = prRun().files["posted.md"];
  assert.match(body, /from 7 November 2020 \(`20201107T000000Z`\) to 1 December 2020 \(`20201201T000000Z`\)/);
  assert.match(body, /only get Ubuntu's security fixes when the snapshot moves forward/);
  assert.match(
    body,
    /`APT_SNAPSHOT` in apps\/slicer\/Dockerfile and tools\/slicing-gate\/Dockerfile, and the pins table in tools\/slicing-gate\/README\.md/,
  );
  assert.match(body, /https:\/\/github\.com\/o\/r\/actions\/workflows\/ci\.yml\?query=branch%3Abot%2Fapt-snapshot/);
  assert.match(body, /"Slicer image and container tests" job ends with a Trivy report/);
  assert.match(body, /never fails the job/);
  assert.match(body, /Merging publishes nothing: the published slicer image gets the new packages with its next build/);
  assert.match(body, /fix it on another branch, because the next run replaces this one/);
  assert.doesNotMatch(body, /This replaces #/, "a first run replaces nothing");
  assert.match(body, /Opened by the apt-snapshot workflow: https:\/\/github\.com\/o\/r\/actions\/runs\/99/);
  assert.doesNotMatch(body, /[^\x00-\x7F]/, "ASCII only");
  // GitHub strips a bare <word> as an HTML tag.
  const prose = body.replace(/`[^`\n]*`/g, "");
  assert.doesNotMatch(prose, /<\/?[A-Za-z][^<>]*>/);
});

test("apt-snapshot pr: a branch already holding the change is not pushed, and its open PR is left alone", () => {
  const r = prRun({ REMOTE: "a".repeat(40), SAME_TREE: "1", EXISTING: "300" });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.outputs.ci, "false", "nothing new for CI");
  assert.deepEqual(callLines(r, "git push"), []);
  assert.deepEqual(callLines(r, "gh pr edit"), []);
  assert.deepEqual(callLines(r, "gh pr create"), []);
  assert.match(r.log, /already holds this change on this main; nothing is pushed/);
});

// The branch is replaced, never moved: a job token's push that moves a branch
// across changes to .github/workflows is refused by GitHub. The open PR is
// closed first, then the branch deleted (with a lease on what was read),
// pushed fresh, and a new PR opened that names the old one. At no point are
// two bot PRs open.
test("apt-snapshot pr: a newer change replaces the branch: close the open PR, delete, push fresh, open a new PR", () => {
  const remote = "b".repeat(40);
  const r = prRun({ REMOTE: remote, SAME_TREE: "0", EXISTING: "300" });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.outputs.ci, "true");
  const order = r.calls
    .split("\n")
    .filter((l) => /^(gh pr (close|create|edit)|git push)/.test(l))
    .map((l) => l.split(" --comment ")[0]);
  assert.deepEqual(order, [
    "gh pr close 300 --repo o/r",
    `git push -q --force-with-lease=refs/heads/bot/apt-snapshot:${remote} origin :refs/heads/bot/apt-snapshot`,
    "git push -q origin HEAD:refs/heads/bot/apt-snapshot",
    `gh pr create --repo o/r --base main --head bot/apt-snapshot --title ${TITLE} --body-file body.md`,
  ]);
  assert.match(callLines(r, "gh pr close")[0], /--comment Replaced by a newer snapshot, 1 December 2020 \(`20201201T000000Z`\)/);
  assert.match(callLines(r, "gh pr list")[0], /--head bot\/apt-snapshot --base main --state open/);
  assert.match(r.files["posted.md"], /This replaces #300, which proposed an older snapshot and was not merged\./);
  assert.match(r.summary, /replaced and closed: #300/);
  assert.deepEqual(callLines(r, "gh pr edit"), [], "no PR is moved onto a rewritten branch");
});

// Issue #390: run by hand twice on one UTC day with main moved in between,
// the open pull request proposes the same snapshot. It is replaced because
// main moved, and neither message calls it older.
test("apt-snapshot pr: a same-day rerun after main moved says main moved, not that a newer snapshot exists", () => {
  const same = prRun({ REMOTE: "c".repeat(40), SAME_TREE: "0", EXISTING: "300", FETCHED_SNAPSHOT: "20201201T000000Z" });
  assert.equal(same.status, 0, same.log);
  const comment = callLines(same, "gh pr close")[0];
  assert.match(comment, /--comment Replaced because main moved since it was opened: it proposed this same snapshot, 1 December 2020 \(`20201201T000000Z`\), on an older main/);
  assert.doesNotMatch(comment, /newer snapshot/);
  assert.match(same.files["posted.md"], /This replaces #300, which proposed the same snapshot on an older main and was not merged\./);
  assert.doesNotMatch(same.files["posted.md"], /older snapshot/);
  // An older snapshot on the branch keeps the newer-snapshot words.
  const older = prRun({ REMOTE: "c".repeat(40), SAME_TREE: "0", EXISTING: "300", FETCHED_SNAPSHOT: "20201107T000000Z" });
  assert.equal(older.status, 0, older.log);
  assert.match(callLines(older, "gh pr close")[0], /--comment Replaced by a newer snapshot, 1 December 2020/);
  assert.match(older.files["posted.md"], /which proposed an older snapshot and was not merged\./);
});

// gh pr list --head matches the branch name only, and anyone can open a
// pull request from a fork branch also named bot/apt-snapshot. Only a pull
// request from this repository is the bot's: a fork's is never closed, and
// never stands in for the bot's own.
test("apt-snapshot pr: a pull request from a fork's branch of the same name is never taken for the bot's", () => {
  const fork = { number: 301, isCrossRepository: true };
  const own = { number: 300, isCrossRepository: false };
  const remote = "e".repeat(40);
  const replaced = prRun({ REMOTE: remote, SAME_TREE: "0", PRS: JSON.stringify([fork, own]) });
  assert.equal(replaced.status, 0, replaced.log);
  assert.deepEqual(
    callLines(replaced, "gh pr close").map((l) => l.split(" --comment ")[0]),
    ["gh pr close 300 --repo o/r"],
  );
  assert.match(callLines(replaced, "gh pr list")[0], /--json number,isCrossRepository /);
  for (const env of [
    { REMOTE: "", SAME_TREE: "0" },
    { REMOTE: remote, SAME_TREE: "0" },
    { REMOTE: remote, SAME_TREE: "1" },
  ]) {
    const r = prRun({ ...env, PRS: JSON.stringify([fork]) });
    assert.equal(r.status, 0, r.log);
    assert.deepEqual(callLines(r, "gh pr close"), [], JSON.stringify(env));
    assert.doesNotMatch(r.log, /already proposes this change/, JSON.stringify(env));
    assert.equal(callLines(r, "gh pr create").length, 1, JSON.stringify(env));
    assert.doesNotMatch(r.files["posted.md"], /This replaces #/, JSON.stringify(env));
    assert.match(r.summary, /pull request: #412/, JSON.stringify(env));
  }
});

test("apt-snapshot pr: last month's branch with no open PR (merged) is deleted and pushed fresh", () => {
  const remote = "d".repeat(40);
  const r = prRun({ REMOTE: remote, SAME_TREE: "0", EXISTING: "" });
  assert.equal(r.status, 0, r.log);
  assert.deepEqual(callLines(r, "gh pr close"), []);
  assert.deepEqual(callLines(r, "git push"), [
    `git push -q --force-with-lease=refs/heads/bot/apt-snapshot:${remote} origin :refs/heads/bot/apt-snapshot`,
    "git push -q origin HEAD:refs/heads/bot/apt-snapshot",
  ]);
  assert.equal(callLines(r, "gh pr create").length, 1);
  assert.doesNotMatch(r.files["posted.md"], /This replaces #/);
});

test("apt-snapshot pr: a branch pushed earlier with no open PR gets one, and ci runs", () => {
  const r = prRun({ REMOTE: "c".repeat(40), SAME_TREE: "1", EXISTING: "" });
  assert.equal(r.status, 0, r.log);
  assert.deepEqual(callLines(r, "git push"), []);
  assert.equal(callLines(r, "gh pr create").length, 1);
  assert.equal(r.outputs.ci, "true");
});

test("apt-snapshot pr: when GitHub refuses to let Actions open PRs, the step fails and names the setting", () => {
  const r = prRun({
    CREATE_ERROR:
      "pull request create failed: GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)",
  });
  assert.equal(r.status, 1);
  assert.match(
    r.log,
    /::error::GitHub refused to let the workflow open the pull request\. Turn on Settings, Actions, General, Workflow permissions, "Allow GitHub Actions to create and approve pull requests"/,
  );
  assert.equal(r.outputs.ci, undefined, "no CI is started");
  const other = prRun({ CREATE_ERROR: "HTTP 502" });
  assert.equal(other.status, 1);
  assert.match(other.log, /::error::gh pr create failed \(exit 1\)/);
});

test("apt-snapshot pr: a failed push fails the step before any PR is opened", () => {
  const r = prRun({ PUSH_STATUS: "1" });
  assert.equal(r.status, 1);
  assert.deepEqual(callLines(r, "gh pr create"), []);
  assert.equal(r.outputs.ci, undefined);
});

test("apt-snapshot pr: malformed dates or unexpected changed files push nothing", () => {
  for (const env of [
    { NEW: "20201201" },
    { OLD: "" },
    { NEW: "20201201T000000Z; rm -rf /" },
    { CHANGED: "apps/slicer/Dockerfile\n" },
    { CHANGED: `${THREE}apps/server/src/x.ts\n` },
  ]) {
    const r = prRun(env);
    assert.equal(r.status, 1, JSON.stringify(env));
    assert.match(r.log, /::error::/);
    assert.deepEqual(callLines(r, "git push"), [], JSON.stringify(env));
    assert.deepEqual(callLines(r, "gh "), [], JSON.stringify(env));
  }
});

test("apt-snapshot pr: the shared leftover check, from the old pin, runs after the rewrite and stops the run", () => {
  const r = prRun({ LEFT: "docs/security.md 20201107T000000Z" });
  assert.equal(r.status, 1);
  assert.match(r.log, /::error::these files name the Ubuntu snapshot 20201107T000000Z or a later one/);
  assert.match(r.log, /docs\/security\.md 20201107T000000Z/);
  assert.match(r.log, /::error::the leftover check failed \(exit 1\); nothing is pushed/);
  assert.deepEqual(callLines(r, "git push"), []);
  assert.deepEqual(callLines(r, "gh pr create"), []);
  const ok = prRun();
  assert.deepEqual(callLines(ok, "node "), ["node .github/scripts/apt-snapshot.mjs leftovers 20201107T000000Z"]);
  // After the files check and before the commit.
  const calls = ok.calls.split("\n");
  const at = (prefix) => calls.findIndex((l) => l.startsWith(prefix));
  assert.ok(at("git diff") < at("node ") && at("node ") < at("git commit"), ok.calls);
  const step = stepScript(jobBlock(text(), "refresh"), "Push the branch and open the pull request");
  assert.doesNotMatch(step, /git grep/, "no check of its own beside the shared one");
});

// The leftover check (issue #391), shared by the monthly run and the ci
// workflow's snapshot-pins job: findLeftovers reads git grep's output.
test("findLeftovers: other files naming a snapshot at or after the pin; the pins, older dates and non-dates pass", () => {
  const since = "20201107T000000Z";
  const out = [
    "apps/slicer/Dockerfile:20201107T000000Z",
    "tools/slicing-gate/Dockerfile:20201107T000000Z",
    "tools/slicing-gate/README.md:20201107T000000Z",
    "docs/security.md:20201107T000000Z",
    "docs/security.md:20201107T000000Z",
    "apps/server/x.ts:20201201T000000Z",
    "apps/server/old.ts:20201106T235959Z",
    "apps/server/notdate.ts:20201399T000000Z",
    "odd:name.md:20211231T000000Z",
    "",
  ].join("\n");
  assert.deepEqual(findLeftovers(out, since), [
    "apps/server/x.ts 20201201T000000Z",
    "docs/security.md 20201107T000000Z",
    "odd:name.md 20211231T000000Z",
  ]);
  assert.deepEqual(findLeftovers("", since), []);
  assert.throws(() => findLeftovers(out, "2020-11-07"), /not a snapshot timestamp/);
});

// A refresh only ever writes midnight UTC (snapshotFor), so the grep matches
// only midnight timestamps, plus the exact one the check starts from, which a
// pin set by hand may not be at midnight. Any other compact ISO 8601 UTC time,
// such as an AWS SigV4 X-Amz-Date, is not a copy of the pin.
test("grepArgs: midnight timestamps and the exact one the check starts from, CHANGELOG.md left out", () => {
  assert.deepEqual(grepArgs("20201107T000000Z"), [
    "grep",
    "-o",
    "-E",
    "-e",
    "[0-9]{8}T000000Z",
    "-e",
    "20201107T000000Z",
    "--",
    ".",
    ":!CHANGELOG.md",
  ]);
  assert.deepEqual(grepArgs("20201107T120000Z").slice(3, 7), ["-e", "[0-9]{8}T000000Z", "-e", "20201107T120000Z"]);
  assert.throws(() => grepArgs("20201107"), /not a snapshot timestamp/);
});

// With real git: a time of day after the pin that is not midnight, such as a
// presigned URL's X-Amz-Date in a test fixture, passes; a midnight copy does
// not, nor does a copy of a pin set by hand off midnight. The later dates are
// computed (FAR), never written here, so this file stays clear of the check.
test("leftovers: a timestamp after the pin that is not midnight, such as an X-Amz-Date, is not a leftover", () => {
  const day = FAR.slice(0, 8);
  inScratch((dir) => {
    const git = (...a) => {
      const r = spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    };
    git("init", "-q");
    writeTree(dir, fakeTexts("20201107T000000Z"));
    writeTree(dir, {
      "fixture.ts": `const url = "https://bucket.example/x?X-Amz-Date=${day}T093015Z&X-Amz-Expires=300";\n`,
    });
    git("add", "-A");
    assert.deepEqual(leftovers(dir), { since: "20201107T000000Z", leftovers: [] });
    writeTree(dir, { "fixture.ts": `pinned ${FAR}\n` });
    git("add", "-A");
    assert.deepEqual(leftovers(dir).leftovers, [`fixture.ts ${FAR}`]);
  });
  inScratch((dir) => {
    const git = (...a) => {
      const r = spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    };
    git("init", "-q");
    writeTree(dir, fakeTexts("20201107T120000Z"));
    writeTree(dir, { "docs/security.md": "installs from 20201107T120000Z\n" });
    git("add", "-A");
    assert.deepEqual(leftovers(dir), {
      since: "20201107T120000Z",
      leftovers: ["docs/security.md 20201107T120000Z"],
    });
  });
});

// The rewrite moves only the ARG line and the pins cell, so a pinned file may
// name a snapshot at or after since once, in its pin; a second copy, such as
// a Dockerfile comment or a sentence in the gate README, is left behind.
test("findLeftovers: a pinned file naming the snapshot a second time, beside its pin, is a leftover", () => {
  const since = "20201107T000000Z";
  const out = [
    "apps/slicer/Dockerfile:20201107T000000Z",
    "apps/slicer/Dockerfile:20201107T000000Z",
    "tools/slicing-gate/Dockerfile:20201107T000000Z",
    "tools/slicing-gate/Dockerfile:20200101T000000Z",
    "tools/slicing-gate/README.md:20201201T000000Z",
    "tools/slicing-gate/README.md:20201107T000000Z",
    "",
  ].join("\n");
  assert.deepEqual(findLeftovers(out, since), [
    "apps/slicer/Dockerfile 20201107T000000Z",
    "tools/slicing-gate/README.md 20201107T000000Z",
    "tools/slicing-gate/README.md 20201201T000000Z",
  ]);
});

// The monthly run's case, with real git: a stale copy in each kind of pinned
// file survives the rewrite, and the check from the old pin finds both.
test("leftovers: a second copy of the pin inside a pinned file is found after the rewrite", () => {
  inScratch((dir) => {
    const git = (...a) => {
      const r = spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    };
    git("init", "-q");
    const before = fakeTexts("20201107T000000Z");
    before["apps/slicer/Dockerfile"] = before["apps/slicer/Dockerfile"].replace(
      "# about the snapshot\n",
      "# pinned 20201107T000000Z, see the gate README\n",
    );
    before["tools/slicing-gate/README.md"] += "\nThe images install from 20201107T000000Z.\n";
    writeTree(dir, before);
    git("add", "-A");
    assert.deepEqual(leftovers(dir).leftovers, [
      "apps/slicer/Dockerfile 20201107T000000Z",
      "tools/slicing-gate/README.md 20201107T000000Z",
    ]);
    writeTree(dir, rewritePins(before, "20201107T000000Z", "20201201T000000Z"));
    assert.deepEqual(leftovers(dir, "20201107T000000Z").leftovers, [
      "apps/slicer/Dockerfile 20201107T000000Z",
      "apps/slicer/Dockerfile 20201201T000000Z",
      "tools/slicing-gate/README.md 20201107T000000Z",
      "tools/slicing-gate/README.md 20201201T000000Z",
    ]);
    // With the copies gone, the pins alone pass.
    writeTree(dir, rewritePins(fakeTexts("20201107T000000Z"), "20201107T000000Z", "20201201T000000Z"));
    assert.deepEqual(leftovers(dir, "20201107T000000Z").leftovers, []);
  });
});

// The check with real git, over a scratch repo: tracked files only,
// CHANGELOG.md left out, the pin read from the pinned files by default.
test("leftovers: real git over a scratch repo finds the copy, not the CHANGELOG or untracked files", () => {
  inScratch((dir) => {
    const git = (...a) => {
      const r = spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    };
    git("init", "-q");
    writeTree(dir, fakeTexts("20201107T000000Z"));
    writeTree(dir, {
      "CHANGELOG.md": "moved from 20201107T000000Z\n",
      "docs/security.md": "an older 20200101T000000Z is fine\n",
    });
    git("add", "-A");
    writeTree(dir, { "untracked.md": "20201107T000000Z\n" });
    assert.deepEqual(leftovers(dir), { since: "20201107T000000Z", leftovers: [] });
    writeTree(dir, { "docs/security.md": "now 20201107T000000Z\n" });
    assert.deepEqual(leftovers(dir).leftovers, ["docs/security.md 20201107T000000Z"]);
    assert.deepEqual(leftovers(dir, "20201201T000000Z").leftovers, []);
    assert.throws(() => leftovers(dir, "soon"), /not a snapshot timestamp/);
  });
  inScratch((dir) => {
    writeTree(dir, fakeTexts("20201107T000000Z"));
    assert.throws(() => leftovers(dir), /git grep failed/, "not a git repo");
  });
});

// The two tests below run the shared check over this repo's own tree with
// real git. They reach the repo root with git -C, or a cd in a bash script,
// not a cwd: option, on purpose: the gate jobs scan in ciworkflow.test.mjs
// takes a cwd: at the repo root for a workflow step reading the files its
// script names, and these read the whole tree, which no path in the changes
// job's tests list can stand for. They run only when the gate tests run.
// Every pull request, whatever it changes, runs the same check in ci.yml's
// snapshot-pins job (issue #391), so a copy of the pin added anywhere fails
// that pull request rather than stopping the next monthly run.
test("leftovers: this repo's tree names the pin only in the three pinned files", () => {
  const pin = currentPin(repoTexts());
  assert.deepEqual(leftovers(ROOT), { since: pin, leftovers: [] });
  // The check sees the tree: from a 2020 date, this file's own fixtures count.
  const control = leftovers(ROOT, "20200101T000000Z").leftovers;
  assert.ok(
    control.some((l) => l.startsWith("tools/slicing-gate/test/aptsnapshot.test.mjs ")),
    `the control finds this file's 2020 fixtures: ${control.slice(0, 5).join(", ")}`,
  );
  assert.ok(!control.some((l) => DOCKERFILES.includes(l.split(" ")[0])), "the pinned files count only beside their pin");
});

// The command both workflows run, as they run it: at the repo root, with no
// argument (ci.yml) or with a timestamp (the monthly run).
test("the leftovers command exits 0 on this repo, 1 naming the files when one would stop the run, 2 on a bad argument", () => {
  const run = (...args) =>
    spawnSync("bash", ["-c", 'cd "$REPO_ROOT" && node "$SCRIPT" "$@"', "bash", ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, REPO_ROOT: ROOT, SCRIPT },
    });
  const pin = currentPin(repoTexts());
  const ok = run("leftovers");
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, "");
  assert.match(ok.stderr, new RegExp(`No file but the three pins names the snapshot ${pin} or a later one`));
  const hit = run("leftovers", "20200101T000000Z");
  assert.equal(hit.status, 1);
  assert.match(hit.stderr, /^::error::these files name the Ubuntu snapshot 20200101T000000Z or a later one/m);
  assert.match(hit.stderr, /^tools\/slicing-gate\/test\/aptsnapshot\.test\.mjs 2020\d{4}T\d{6}Z$/m);
  for (const bad of [["leftovers", "tomorrow"], ["leftovers", "20200101T000000Z", "x"], ["refresh", "x"]]) {
    assert.equal(run(...bad).status, 2, bad.join(" "));
  }
});

// The token reaches git only in the environment of the commands that need it.
test("apt-snapshot pr: the job token is never written to disk or onto a git command line", () => {
  const s = stepScript(jobBlock(text(), "refresh"), "Push the branch and open the pull request");
  assert.doesNotMatch(s, /git config [^\n]*extraheader|git remote set-url|https:\/\/[^\s"]*@github/);
  assert.doesNotMatch(s, /echo "?\$\{?GH_TOKEN|set -x/);
  assert.match(s, /echo "::add-mask::\$\{basic\}"/);
  const r = prRun();
  const header = Buffer.from(`x-access-token:${FAKE_TOKEN}`).toString("base64");
  for (const v of [FAKE_TOKEN, header]) {
    assert.ok(!r.calls.includes(v), "neither the token nor its header is a command argument");
  }
  assert.ok(!r.log.includes(FAKE_TOKEN));
});

test("apt-snapshot dispatch-ci: starts ci.yml on the bot branch and links its runs", () => {
  const r = runStep("dispatch-ci", "Start the ci workflow", {
    stubs: ['gh() { echo "gh $*" >>"$CALLS"; }'],
    env: { GH_TOKEN: FAKE_TOKEN, REPO: "o/r", SERVER_URL: "https://github.com" },
  });
  assert.equal(r.status, 0, r.log);
  assert.equal(r.calls, "gh workflow run ci.yml --repo o/r --ref bot/apt-snapshot\n");
  assert.match(r.summary, /actions\/workflows\/ci\.yml\?query=branch%3Abot%2Fapt-snapshot/);
});

// ci.yml must accept the dispatch, or dispatch-ci fails on every run.
test("apt-snapshot: ci.yml accepts workflow_dispatch, with no inputs and no branch filter", () => {
  const on = onBlock(readFileSync(CI, "utf8"));
  // Nothing nested under it: no inputs, no branch filter.
  assert.match(on, /^ {2}workflow_dispatch:\n(?! {4})/m, on);
  assert.match(text(), /gh workflow run ci\.yml /);
});
