// End to end without the image: select-sample writes selection.json, then
// gate.mjs plan and gate.mjs report run as commands against a synthetic
// profile tree and synthetic .3mf files. Orca is not run; slice results are
// written by the test in the shape gate.mjs slice writes them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build3mf, P1S_PROJECT, writeTmp } from "./support/fixtures.mjs";
import { profileTree } from "./support/profiles.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const GATE = join(here, "..", "gate.mjs");
const SELECT = join(here, "..", "select-sample.mjs");

function setup() {
  const root = mkdtempSync(join(tmpdir(), "gate-cli-"));
  const profiles = profileTree();
  writeFileSync(
    join(profiles, "BBL", "machine", "Bambu Lab X1 Carbon 0.4 nozzle.json"),
    JSON.stringify({
      type: "machine",
      name: "Bambu Lab X1 Carbon 0.4 nozzle",
      inherits: "fdm_bbl_3dp_001_common",
      from: "system",
      instantiation: "true",
    }),
  );
  const sample = join(root, "in", "sample");
  mkdirSync(sample, { recursive: true });
  const sliced = {
    index: 1,
    sliced: { prediction: 1000, weight: 10, modelId: "C12", nozzle: "0.4", filaments: [{ id: 1, type: "PLA", usedG: 10 }] },
  };
  writeTmp("a.3mf", build3mf({ plates: [sliced, { index: 2 }], project: { ...P1S_PROJECT, filament_type: ["PLA"] } }), sample);
  writeTmp("u.3mf", build3mf({ plates: [{ index: 1 }], project: { ...P1S_PROJECT, filament_type: ["PLA"] } }), sample);
  const out = join(root, "out");
  mkdirSync(out);
  const env = {
    ...process.env,
    GATE_IN: join(root, "in"),
    GATE_OUT: out,
    GATE_WORK: join(root, "work"),
    GATE_ORCA_PROFILES: profiles,
  };
  return { root, sample, out, env };
}

const node = (args, env) => spawnSync(process.execPath, args, { env, encoding: "utf8" });

function fakeResults(out, ids, over = {}) {
  for (const id of ids) {
    writeFileSync(
      join(out, "jobs", `${id}.json`),
      JSON.stringify({
        id,
        returnCode: 0,
        errorString: "Success.",
        timeSeconds: 1050,
        weightGrams: 10.5,
        filamentGrams: [{ slot: 1, grams: 10.5 }],
        wallSeconds: 12,
        peakRssBytes: 900 * 2 ** 20,
        exitStatus: 0,
        signal: null,
        timedOut: false,
        workBytes: 5 * 2 ** 20,
        result: { layerHeight: 0.2, wallLoops: 2, sparseInfillDensity: 15 },
        ...(over[id] ?? {}),
      }),
    );
  }
}

test("select-sample, plan and report run end to end and apply the pass rule", () => {
  const { root, sample, out, env } = setup();
  const sel = node([SELECT, sample, "--json", join(root, "in", "selection.json")], env);
  assert.equal(sel.status, 0, sel.stderr);

  const plan = node([GATE, "plan"], env);
  assert.equal(plan.status, 0, plan.stderr);
  const ids = readFileSync(join(out, "jobs.txt"), "utf8").trim().split("\n");
  // a.3mf 2 plates + u.3mf 1 plate, on 3 printers; a.3mf plate 1 on P1S is also the own-printer job
  assert.equal(ids.length, 9);
  const planJson = JSON.parse(readFileSync(join(out, "plan.json"), "utf8"));
  assert.deepEqual(planJson.errors, []);
  const p1sJob = planJson.jobs.find((j) => j.file === "a.3mf" && j.plate === 1 && j.printer.includes("P1S"));
  assert.deepEqual(p1sJob.kinds, ["selected", "own"]);
  const machine = JSON.parse(readFileSync(join(out, "profiles", p1sJob.machineFile), "utf8"));
  assert.equal(machine.name, "Bambu Lab P1S 0.4 nozzle");

  fakeResults(out, ids);
  // the report needs the checks step's file; with no checks.json the gate could not run
  const noChecks = node([GATE, "report"], env);
  assert.equal(noChecks.status, 2, noChecks.stderr);
  const noChecksSummary = readFileSync(join(out, "summary.txt"), "utf8");
  assert.match(noChecksSummary, /^Platehouse slicing gate: COULD-NOT-RUN/);
  assert.match(noChecksSummary, /incomplete: the checks step wrote no checks\.json/);
  writeFileSync(join(out, "checks.json"), JSON.stringify({ ranAt: "2026-11-07T00:00:00.000Z", openscad: null, landrun: null, step: null }));
  const pass = node([GATE, "report"], env);
  assert.equal(pass.status, 0, pass.stderr);
  const summary = readFileSync(join(out, "summary.txt"), "utf8");
  assert.match(summary, /^Platehouse slicing gate: PASS/);
  assert.match(summary, /\(b\) .* 1 of 1 plates compared/);
  assert.match(summary, /time: median \+5\.0%/);
  assert.match(summary, /\(h\) STEP: not run\./);
  assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(summary), "summary is ASCII only");
  const result = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
  assert.equal(result.plates.length, 9);

  fakeResults(out, [ids[3]], { [ids[3]]: { returnCode: -100, errorString: "Failed slicing", timeSeconds: null } });
  const fail = node([GATE, "report"], env);
  assert.equal(fail.status, 1);
  assert.match(readFileSync(join(out, "summary.txt"), "utf8"), /^Platehouse slicing gate: FAIL/);

  fakeResults(out, [ids[3]], { [ids[3]]: { returnCode: -63, errorString: "collision", timeSeconds: null } });
  assert.equal(node([GATE, "report"], env).status, 3);
});

test("a failed plate makes report exit 1 even when checks.json is missing", () => {
  const { root, sample, out, env } = setup();
  assert.equal(node([SELECT, sample, "--json", join(root, "in", "selection.json")], env).status, 0);
  assert.equal(node([GATE, "plan"], env).status, 0);
  const ids = readFileSync(join(out, "jobs.txt"), "utf8").trim().split("\n");
  // every plate but one finished; that one wrote no result, which is a crash
  fakeResults(out, ids.slice(1));
  const report = node([GATE, "report"], env);
  assert.equal(report.status, 1, report.stderr);
  const summary = readFileSync(join(out, "summary.txt"), "utf8");
  assert.match(summary, /^Platehouse slicing gate: FAIL/);
  assert.match(summary, /incomplete: the checks step wrote no checks\.json/);
});

test("a failed plate makes report exit 1 even when a machine preset is missing", () => {
  const { root, sample, out, env } = setup();
  rmSync(join(env.GATE_ORCA_PROFILES, "BBL", "machine", "Bambu Lab X1 Carbon 0.4 nozzle.json"));
  assert.equal(node([SELECT, sample, "--json", join(root, "in", "selection.json")], env).status, 0);
  assert.equal(node([GATE, "plan"], env).status, 0);
  const planJson = JSON.parse(readFileSync(join(out, "plan.json"), "utf8"));
  const ran = planJson.jobs.filter((j) => j.machineFile).map((j) => j.id);
  const missing = planJson.jobs.filter((j) => !j.machineFile).map((j) => j.id);
  assert.ok(missing.length > 0 && ran.length > 1);
  fakeResults(out, ran, { [ran[0]]: { returnCode: -100, errorString: "Failed slicing", timeSeconds: null } });
  for (const id of missing) writeFileSync(join(out, "jobs", `${id}.json`), JSON.stringify({ id, setupError: "no machine preset" }));
  writeFileSync(join(out, "checks.json"), JSON.stringify({ ranAt: "2026-11-07T00:00:00.000Z", openscad: null, landrun: null, step: null }));
  const report = node([GATE, "report"], env);
  assert.equal(report.status, 1, report.stderr);
  const summary = readFileSync(join(out, "summary.txt"), "utf8");
  assert.match(summary, /^Platehouse slicing gate: FAIL/);
  assert.match(summary, /setup error: no bundled machine preset named Bambu Lab X1 Carbon 0\.4 nozzle/);
});

test("a missing machine preset makes report exit 2, the gate could not run, not 1", () => {
  const { root, sample, out, env } = setup();
  rmSync(join(env.GATE_ORCA_PROFILES, "BBL", "machine", "Bambu Lab X1 Carbon 0.4 nozzle.json"));
  assert.equal(node([SELECT, sample, "--json", join(root, "in", "selection.json")], env).status, 0);
  const plan = node([GATE, "plan"], env);
  assert.equal(plan.status, 0, plan.stderr);
  const planJson = JSON.parse(readFileSync(join(out, "plan.json"), "utf8"));
  assert.ok(planJson.errors.some((e) => e.includes("X1 Carbon")), JSON.stringify(planJson.errors));
  // what gate.mjs slice writes for a job with no machine preset, and real results for the rest
  const missing = planJson.jobs.filter((j) => !j.machineFile).map((j) => j.id);
  assert.ok(missing.length > 0);
  fakeResults(out, planJson.jobs.filter((j) => j.machineFile).map((j) => j.id));
  for (const id of missing) writeFileSync(join(out, "jobs", `${id}.json`), JSON.stringify({ id, setupError: "no machine preset" }));
  const report = node([GATE, "report"], env);
  assert.equal(report.status, 2, report.stderr);
  const summary = readFileSync(join(out, "summary.txt"), "utf8");
  assert.match(summary, /^Platehouse slicing gate: COULD-NOT-RUN/);
  assert.match(summary, /setup error: no bundled machine preset named Bambu Lab X1 Carbon 0\.4 nozzle/);
});

test("plan stops with exit 2 when a selected file is not in the sample folder", () => {
  const { root, sample, env } = setup();
  assert.equal(node([SELECT, sample, "--json", join(root, "in", "selection.json")], env).status, 0);
  unlinkSync(join(sample, "u.3mf"));
  const plan = node([GATE, "plan"], env);
  assert.equal(plan.status, 2);
  assert.match(plan.stderr, /u\.3mf/);
});
