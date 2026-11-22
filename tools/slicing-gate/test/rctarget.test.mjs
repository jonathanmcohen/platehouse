// The rc tag (PR #360). Invariant: once every run has finished,
// platehouse:rc and platehouse-slicer:rc both point at the builds of the same
// tag T, where T is the highest version, by semver precedence, among the
// pushed vX.Y.Z-rc.N and plain vX.Y.Z tags whose app image AND slicer image
// were both published. Nothing else moves rc.
//
// The property test simulates random histories of pushes, re-runs,
// dispatches, daily runs and failures, finishing in random orders. It runs
// against the per-run design PR #360 first had (each workflow moving its own
// rc when its own run succeeds), where it fails, and against the design in
// rc-tag.yml, where pickTarget (.github/scripts/rc-target.mjs) decides T.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { candidates, compareTags, parseTag, pickTarget } from "../../../.github/scripts/rc-target.mjs";

// A seeded PRNG (mulberry32), so a failing seed can be replayed.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];

// The expected T, written independently of the code under test: a tag
// qualifies when it is exactly vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-rc.N
// (no leading zeros), and qualifying tags are ordered by the tuple
// [major, minor, patch, plain ? Infinity : N].
function expectedTarget(pushed, appPublished, slicerPublished) {
  let best = null;
  let bestKey = null;
  for (const tag of pushed) {
    const m = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/.exec(tag);
    if (!m || !appPublished.has(tag) || !slicerPublished.has(tag)) continue;
    const key = [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? Number.POSITIVE_INFINITY : Number(m[4])];
    const greater = bestKey === null || key.some((k, i) => key.slice(0, i).every((x, j) => x === bestKey[j]) && k > bestKey[i]);
    if (greater) {
      best = tag;
      bestKey = key;
    }
  }
  return best;
}

// A random history: tags pushed (each push starts an app run and a slicer
// run), re-runs of earlier tag runs (a re-run keeps the push event),
// dispatches of either workflow from a tag, and daily or dispatched-from-main
// slicer runs. Each run succeeds or fails, and the runs finish in a random
// order. Tags come from a small space so collisions, re-pushes of the same
// version and every ordering show up often.
const TAG_SPACE = [];
for (const v of ["0.1.0", "0.1.1", "0.2.0", "1.0.0"]) {
  TAG_SPACE.push(`v${v}`, `v${v}-rc.1`, `v${v}-rc.2`, `v${v}-rc.10`);
}
TAG_SPACE.push("v0.0.0-test", "v0.2.0-beta.1", "v0.2.0-rc.01", "v0.2.0-rc");

function history(seed) {
  const r = rng(seed);
  const pushed = [];
  const runs = [];
  const steps = 2 + Math.floor(r() * 10);
  for (let i = 0; i < steps; i++) {
    const roll = r();
    if (roll < 0.45 || pushed.length === 0) {
      const tag = pick(r, TAG_SPACE);
      if (!pushed.includes(tag)) pushed.push(tag);
      for (const workflow of ["app", "slicer"]) runs.push({ workflow, tag, event: "push", ok: r() < 0.8 });
    } else if (roll < 0.65) {
      const earlier = runs.filter((x) => x.event === "push");
      const base = pick(r, earlier);
      runs.push({ ...base, rerun: true, ok: r() < 0.8 });
    } else if (roll < 0.85) {
      runs.push({ workflow: pick(r, ["app", "slicer"]), tag: pick(r, pushed), event: "dispatch", ok: r() < 0.8 });
    } else {
      runs.push({ workflow: "slicer", tag: null, event: pick(r, ["schedule", "dispatch"]), ok: r() < 0.8 });
    }
  }
  // Finish order: a random permutation (Fisher-Yates).
  for (let i = runs.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [runs[i], runs[j]] = [runs[j], runs[i]];
  }
  return { pushed, runs, r };
}

// What a finished run publishes: a successful run started from a tag
// publishes that tag's build of its image (the app's version tag; the
// slicer's build for that tag). Daily runs and runs from main publish no
// tag's build.
function publish(run, appPublished, slicerPublished) {
  if (!run.ok || run.tag === null) return;
  (run.workflow === "app" ? appPublished : slicerPublished).add(run.tag);
}

// The per-run design: when its run succeeds, release.yml points the app's rc
// at its tag if the tag is vX.Y.Z or vX.Y.Z-rc.N (any event, a dispatch
// included), and slicer-image.yml points the slicer's rc at its tag on the
// same tags but only for a push (a re-run keeps the push event).
const RC_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-rc\.(0|[1-9]\d*))?$/;
function perRunDesign({ runs }) {
  const appPublished = new Set();
  const slicerPublished = new Set();
  let appRc = null;
  let slicerRc = null;
  for (const run of runs) {
    publish(run, appPublished, slicerPublished);
    if (!run.ok || run.tag === null || !RC_TAG.test(run.tag)) continue;
    if (run.workflow === "app") appRc = run.tag;
    else if (run.event === "push") slicerRc = run.tag;
  }
  return { appRc, slicerRc, appPublished, slicerPublished };
}

// Runs the property over many seeds and returns the first counterexample.
function firstCounterexample(design, seeds) {
  for (let seed = 1; seed <= seeds; seed++) {
    const h = history(seed);
    const { appRc, slicerRc, appPublished, slicerPublished } = design(h);
    const want = expectedTarget(h.pushed, appPublished, slicerPublished);
    if (appRc !== want || slicerRc !== want) {
      return { seed, want, appRc, slicerRc, runs: h.runs.map((x) => `${x.workflow} ${x.tag ?? "main"} ${x.event}${x.rerun ? " re-run" : ""} ${x.ok ? "ok" : "FAILED"}`) };
    }
  }
  return null;
}

// The negative control. Run against the per-run design before rc-target.mjs
// was written, this property failed on seed 1 and on 1260 of 2000 seeds (1022
// of them leaving the two rc tags on different tags): the slicer's rc ends on
// whichever qualifying push finished last. Kept, so a change to the
// simulation that stops it finding that is caught.
test("property: the per-run design breaks the invariant (negative control)", () => {
  const bad = firstCounterexample(perRunDesign, 2000);
  assert.notEqual(bad, null, "the simulation no longer finds the per-run design's failures");
  assert.equal(bad.seed, 1);
  assert.equal(bad.want, "v1.0.0");
  assert.equal(bad.slicerRc, "v0.2.0-rc.10", "the slicer rc follows the last push to finish");
});

// The design in rc-tag.yml: runs only publish their version tags, and after
// any run of either workflow finishes, one job (one global concurrency
// group, never cancelled part way) recomputes T from the pushed tags and the
// registry and points both rc tags at it. GitHub may drop a pending rc run
// when a newer one queues behind it, and an rc run may itself fail, so in
// the model the rc job runs after a random subset of finishes, sometimes
// failing (changing nothing); the run queued by the last finish always runs,
// and the property is judged after it succeeds, which is what settled means.
function rcJobDesign({ pushed, runs, r }) {
  const appPublished = new Set();
  const slicerPublished = new Set();
  const seen = [];
  let appRc = null;
  let slicerRc = null;
  const rcJob = () => {
    const entries = seen.map((tag) => ({ tag, app: appPublished.has(tag), slicer: slicerPublished.has(tag) }));
    const t = pickTarget(entries);
    if (t !== null) {
      appRc = t;
      slicerRc = t;
    }
  };
  runs.forEach((run, i) => {
    if (run.tag !== null && !seen.includes(run.tag)) seen.push(run.tag);
    publish(run, appPublished, slicerPublished);
    const last = i === runs.length - 1;
    if (last || (r() < 0.5 && r() < 0.8)) rcJob();
  });
  assert.deepEqual([...seen].sort(), [...new Set(runs.filter((x) => x.tag !== null).map((x) => x.tag))].sort());
  assert.ok(seen.every((t) => pushed.includes(t)), "every tag a run started from was pushed");
  return { appRc, slicerRc, appPublished, slicerPublished };
}

test("property: the rc job design keeps both rc tags on the highest fully published tag, for 5000 seeds", () => {
  assert.equal(firstCounterexample(rcJobDesign, 5000), null);
});

test("property: pickTarget agrees with the independent rule on random entry lists", () => {
  for (let seed = 1; seed <= 3000; seed++) {
    const r = rng(seed);
    const n = Math.floor(r() * 12);
    const entries = Array.from({ length: n }, () => ({ tag: pick(r, TAG_SPACE), app: r() < 0.6, slicer: r() < 0.6 }));
    const app = new Set(entries.filter((e) => e.app).map((e) => e.tag));
    const slicer = new Set(entries.filter((e) => e.slicer).map((e) => e.tag));
    // An entry list can hold a tag twice; the rule reads it as published when
    // any entry says so, while pickTarget needs one entry with both. Keep
    // only lists where the two readings agree, which is every list the
    // workflow builds (one entry per tag).
    const tags = entries.map((e) => e.tag);
    if (new Set(tags).size !== tags.length) continue;
    assert.equal(pickTarget(entries), expectedTarget(tags, app, slicer), `seed ${seed}: ${JSON.stringify(entries)}`);
  }
});

// Unit tests.
for (const [tag, want] of [
  ["v0.1.0", { major: "0", minor: "1", patch: "0", rc: null }],
  ["v0.2.0-rc.1", { major: "0", minor: "2", patch: "0", rc: "1" }],
  ["v10.20.30-rc.0", { major: "10", minor: "20", patch: "30", rc: "0" }],
  ["v0.0.0-test", null],
  ["v0.2.0-beta.1", null],
  ["v0.2.0-rc", null],
  ["v0.2.0-rc.01", null],
  ["v0.2.0-rc.1.1", null],
  ["v0.2.0-RC.1", null],
  ["v01.2.0", null],
  ["0.2.0", null],
  ["v0.2", null],
  ["v0.2.0+build.1", null],
  ["v0.2.0\n", null],
  ["refs/tags/v0.2.0", null],
  ["", null],
  [undefined, null],
]) {
  test(`parseTag(${JSON.stringify(tag)})`, () => {
    assert.deepEqual(parseTag(tag), want);
  });
}

test("compareTags orders by semver precedence: numbers as numbers, a release above its candidates", () => {
  const ascending = [
    "v0.1.0-rc.1",
    "v0.1.0-rc.2",
    "v0.1.0-rc.9",
    "v0.1.0-rc.10",
    "v0.1.0",
    "v0.1.1",
    "v0.2.0-rc.0",
    "v0.2.0",
    "v0.9.0",
    "v0.10.0",
    "v1.0.0-rc.1",
    "v1.0.0",
    "v12345678901234567890.0.0",
  ];
  for (let i = 0; i < ascending.length; i++) {
    for (let j = 0; j < ascending.length; j++) {
      assert.equal(Math.sign(compareTags(ascending[i], ascending[j])), Math.sign(i - j), `${ascending[i]} vs ${ascending[j]}`);
    }
  }
  assert.throws(() => compareTags("v0.1.0", "v0.0.0-test"), /not a vX\.Y\.Z or vX\.Y\.Z-rc\.N tag: v0\.0\.0-test/);
});

test("candidates keeps the qualifying tags once each, highest first", () => {
  assert.deepEqual(candidates(["v0.1.0-rc.1", "v0.0.0-test", "v0.1.0", "v0.2.0-rc.1", "v0.1.0", "v0.1.1", "x"]), [
    "v0.2.0-rc.1",
    "v0.1.1",
    "v0.1.0",
    "v0.1.0-rc.1",
  ]);
  assert.deepEqual(candidates([]), []);
});

for (const [name, entries, want] of [
  ["the highest tag with both images", [{ tag: "v0.1.0", app: true, slicer: true }, { tag: "v0.2.0-rc.1", app: true, slicer: true }], "v0.2.0-rc.1"],
  ["a higher tag missing its slicer image is passed over", [{ tag: "v0.1.0", app: true, slicer: true }, { tag: "v0.2.0-rc.1", app: true, slicer: false }], "v0.1.0"],
  ["a higher tag missing its app image is passed over", [{ tag: "v0.1.0", app: true, slicer: true }, { tag: "v0.2.0-rc.1", app: false, slicer: true }], "v0.1.0"],
  // A patch release cut while the next minor is in candidates is older than
  // the candidate, so rc stays on the candidate (by design).
  ["a backport release older than the newest candidate does not win", [{ tag: "v0.2.0-rc.1", app: true, slicer: true }, { tag: "v0.1.1", app: true, slicer: true }], "v0.2.0-rc.1"],
  ["the release beats its own candidates", [{ tag: "v0.2.0-rc.2", app: true, slicer: true }, { tag: "v0.2.0", app: true, slicer: true }], "v0.2.0"],
  ["rc.10 beats rc.9", [{ tag: "v0.2.0-rc.10", app: true, slicer: true }, { tag: "v0.2.0-rc.9", app: true, slicer: true }], "v0.2.0-rc.10"],
  ["a throwaway tag never qualifies, even when highest and published", [{ tag: "v9.0.0-test", app: true, slicer: true }, { tag: "v0.1.0", app: true, slicer: true }], "v0.1.0"],
  ["other prerelease kinds never qualify", [{ tag: "v0.2.0-beta.1", app: true, slicer: true }, { tag: "v0.2.0-rc.01", app: true, slicer: true }], null],
  ["nothing fully published gives null", [{ tag: "v0.1.0", app: true, slicer: false }], null],
  ["an empty list gives null", [], null],
  ["published means exactly true", [{ tag: "v0.1.0", app: "true", slicer: 1 }], null],
]) {
  test(`pickTarget: ${name}`, () => {
    assert.equal(pickTarget(entries), want);
  });
}

// The command line the workflow calls, run as a separate process.
const SCRIPT = fileURLToPath(new URL("../../../.github/scripts/rc-target.mjs", import.meta.url));
const cli = (mode, input) => spawnSync(process.execPath, [SCRIPT, mode], { input, encoding: "utf8" });

test("rc-target.mjs candidates prints the qualifying tags highest first", () => {
  const r = cli("candidates", "v0.1.0-rc.1\nv0.0.0-test\nv0.1.0\n\nv0.2.0-rc.3\n");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "v0.2.0-rc.3\nv0.1.0\nv0.1.0-rc.1\n");
  assert.equal(cli("candidates", "").stdout, "");
});

test("rc-target.mjs pick prints T, or nothing", () => {
  const lines = [
    { tag: "v0.2.0-rc.3", app: true, slicer: false },
    { tag: "v0.1.0", app: true, slicer: true },
    { tag: "v0.1.0-rc.1", app: true, slicer: true },
  ].map((e) => JSON.stringify(e));
  const r = cli("pick", `${lines.join("\n")}\n`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "v0.1.0\n");
  const none = cli("pick", `${JSON.stringify({ tag: "v0.1.0", app: false, slicer: true })}\n`);
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.stdout, "");
});

test("rc-target.mjs fails on a bad mode or a line that is not JSON", () => {
  assert.notEqual(cli("other", "").status, 0);
  const bad = cli("pick", "not json\n");
  assert.notEqual(bad.status, 0);
  assert.equal(bad.stdout, "");
});
