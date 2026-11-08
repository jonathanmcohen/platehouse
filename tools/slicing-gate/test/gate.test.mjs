import assert from "node:assert/strict";
import { test } from "node:test";
import { buildJobs, buildReport, orcaArgs } from "../gate.mjs";

const plates = (n, sliced = []) =>
  Array.from({ length: n }, (_, i) => ({
    index: i + 1,
    sliced: sliced.includes(i + 1),
    predictionSeconds: sliced.includes(i + 1) ? 1000 * (i + 1) : null,
    weightGrams: sliced.includes(i + 1) ? 10 * (i + 1) : null,
    filaments: sliced.includes(i + 1) ? [{ slot: 1, type: "PLA", grams: 10 * (i + 1) }] : [],
  }));
const project = (types) => ({ filamentTypes: types, layerHeight: "0.2", wallLoops: "2", sparseInfillDensity: "15%" });

const P1S = "Bambu Lab P1S 0.4 nozzle";
const X1C = "Bambu Lab X1 Carbon 0.4 nozzle";
const A1 = "Bambu Lab A1 0.4 nozzle";

const recipe = {
  printers: {
    [P1S]: { file: "machine/p1s.json" },
    [X1C]: { file: "machine/x1c.json" },
    [A1]: { file: "machine/a1.json" },
  },
  filaments: {
    [P1S]: { PLA: { name: "Generic PLA", file: "filament/pla.json" }, ASA: { name: "Generic ASA", file: "filament/asa.json" } },
    [X1C]: { PLA: { name: "Generic PLA", file: "filament/pla.json" }, ASA: null },
    [A1]: { PLA: { name: "Generic PLA @BBL A1", file: "filament/pla-a1.json" }, ASA: null },
  },
};

const selection = {
  sample: [
    { name: "a.3mf", roles: ["p1s-sliced"] },
    { name: "u.3mf", roles: ["unsliced"] },
  ],
  comparison: [{ name: "a.3mf", printer: P1S, slicedPlates: [1] }],
};
const metas = {
  "a.3mf": { plates: plates(2, [1]), project: project(["PLA", "ASA"]), inputBytes: 100 },
  "u.3mf": { plates: plates(1), project: project(["PLA"]), inputBytes: 50 },
};

test("buildJobs makes one job per sample file x selected printer x plate, plus own-printer plates, deduped", () => {
  const { jobs } = buildJobs(selection, metas, recipe);
  // a.3mf: 2 plates x 3 printers, u.3mf: 1 plate x 3 printers = 9; own-printer a.3mf plate 1 on P1S is a duplicate
  assert.equal(jobs.length, 9);
  assert.deepEqual(
    jobs.map((j) => j.id),
    ["j0001", "j0002", "j0003", "j0004", "j0005", "j0006", "j0007", "j0008", "j0009"],
  );
  const dup = jobs.find((j) => j.file === "a.3mf" && j.printer === P1S && j.plate === 1);
  assert.deepEqual(dup.kinds, ["selected", "own"]);
  assert.deepEqual(dup.bambu, { timeSeconds: 1000, weightGrams: 10, filaments: [{ slot: 1, type: "PLA", grams: 10 }] });
  const other = jobs.find((j) => j.file === "a.3mf" && j.printer === X1C && j.plate === 1);
  assert.equal(other.bambu, null);
});

test("buildJobs maps each filament slot to its generic preset and leaves unmapped types empty", () => {
  const { jobs } = buildJobs(selection, metas, recipe);
  const p1s = jobs.find((j) => j.file === "a.3mf" && j.printer === P1S);
  assert.deepEqual(p1s.filamentFiles, ["filament/pla.json", "filament/asa.json"]);
  assert.deepEqual(p1s.unmappedTypes, []);
  const x1c = jobs.find((j) => j.file === "a.3mf" && j.printer === X1C);
  assert.deepEqual(x1c.filamentFiles, ["filament/pla.json", ""]);
  assert.deepEqual(x1c.unmappedTypes, ["ASA"]);
  assert.equal(x1c.machineFile, "machine/x1c.json");
});

test("a comparison printer the bundle does not have becomes a setup error, not a silent skip", () => {
  const sel = { sample: [], comparison: [{ name: "a.3mf", printer: "Bambu Lab Q9 0.4 nozzle", slicedPlates: [1] }] };
  const { jobs, errors } = buildJobs(sel, metas, recipe);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].machineFile, null);
  assert.match(errors[0], /Q9/);
});

test("orcaArgs builds one --slice N --export-statistics call with --mstpp 600", () => {
  const job = { plate: 2, machineFile: "machine/x1c.json", filamentFiles: ["filament/pla.json", ""], file: "dir/a b.3mf" };
  const args = orcaArgs(job, { profiles: "/out/profiles", sample: "/in/sample", outDir: "/work/j/out", dataDir: "/work/j/data" });
  assert.deepEqual(args, [
    "--datadir",
    "/work/j/data",
    "--slice",
    "2",
    "--export-statistics",
    "--mstpp",
    "600",
    "--allow-newer-file",
    "--outputdir",
    "/work/j/out",
    "--load-settings",
    "/out/profiles/machine/x1c.json",
    "--load-filaments",
    "/out/profiles/filament/pla.json;",
    "/in/sample/dir/a b.3mf",
  ]);
  const own = orcaArgs({ ...job, filamentFiles: ["", ""] }, { profiles: "/p", sample: "/s", outDir: "/o", dataDir: "/d" });
  assert.equal(own.includes("--load-filaments"), false);
});

const res = (over) => ({
  returnCode: 0,
  errorString: "Success.",
  timeSeconds: 1100,
  weightGrams: 11,
  filamentGrams: [{ slot: 1, grams: 11 }],
  wallSeconds: 20,
  peakRssBytes: 2 ** 30,
  exitStatus: 0,
  signal: null,
  timedOut: false,
  workBytes: 10 * 2 ** 20,
  result: { layerHeight: 0.2, wallLoops: 2, sparseInfillDensity: 15 },
  ...over,
});

// what gate.mjs checks writes; buildReport only needs it to be there
const checks = { ranAt: "2026-11-07T00:00:00.000Z", openscad: null, landrun: null, step: null };

test("buildReport applies the pass rule and reports the Bambu gap, limits and process survival", () => {
  const { jobs } = buildJobs(selection, metas, recipe);
  const results = {};
  for (const j of jobs) results[j.id] = res();
  const x1cA2 = jobs.find((j) => j.file === "a.3mf" && j.printer === X1C && j.plate === 2);
  results[x1cA2.id] = res({ returnCode: -17, errorString: "not compatible", timeSeconds: null, weightGrams: null });
  const inspect = Object.entries(metas).map(([name, m]) => ({ name, project: m.project, keys: {} }));
  const report = buildReport({ plan: { jobs, errors: [], inspect, recipe }, results, hostExits: {}, checks });
  assert.equal(report.verdict, "PASS");
  assert.equal(report.counts.ok, 8);
  assert.equal(report.counts.refused, 1);
  assert.equal(report.plates.length, 9);
  assert.equal(report.bambuGap.time.count, 1);
  assert.equal(report.bambuGap.time.median, 10);
  assert.equal(report.bambuGap.weight.median, 10);
  assert.equal(report.limits.memory, "2g");
  assert.equal(report.recipe.processSurvival.refusedProcessNotCompatible, 1);
  assert.equal(report.recipe.processSurvival.kept, 8);
});

test("process survival counts a finished slice as unknown when any compared value is missing, not as changed", () => {
  const { jobs } = buildJobs(selection, metas, recipe);
  const selected = jobs.filter((j) => j.kinds.includes("selected"));
  const inspect = Object.entries(metas).map(([name, m]) => ({ name, project: m.project, keys: {} }));
  const survivalFor = (resultOver, projectOver = {}) => {
    const results = {};
    for (const j of jobs) results[j.id] = res({ result: { layerHeight: 0.2, wallLoops: 2, sparseInfillDensity: 15, ...resultOver } });
    const ins = inspect.map((i) => ({ ...i, project: { ...i.project, ...projectOver } }));
    return buildReport({ plan: { jobs, errors: [], inspect: ins, recipe }, results, hostExits: {}, checks }).recipe.processSurvival;
  };
  // a key Orca's result.json does not carry
  for (const key of ["layerHeight", "wallLoops", "sparseInfillDensity"]) {
    const s = survivalFor({ [key]: null });
    assert.equal(s.changed, 0, `result ${key} null`);
    assert.equal(s.unknown, selected.length, `result ${key} null`);
  }
  // a key the file's own project_settings lacks
  for (const key of ["layerHeight", "wallLoops", "sparseInfillDensity"]) {
    const s = survivalFor({}, { [key]: undefined });
    assert.equal(s.changed, 0, `project ${key} missing`);
    assert.equal(s.unknown, selected.length, `project ${key} missing`);
  }
  // all six present and one differs is a real change
  const changed = survivalFor({ wallLoops: 3 });
  assert.equal(changed.changed, selected.length);
  assert.equal(changed.unknown, 0);
  assert.equal(changed.kept, 0);
});

test("a run whose checks step wrote no checks.json could not run, even when every plate passed", () => {
  const { jobs } = buildJobs(selection, metas, recipe);
  const results = {};
  for (const j of jobs) results[j.id] = res();
  const report = buildReport({ plan: { jobs, errors: [], inspect: [], recipe }, results, hostExits: {}, checks: null });
  assert.equal(report.verdict, "COULD-NOT-RUN");
  assert.equal(report.counts.ok, 9, "the plates are still counted");
  assert.ok(report.incomplete.some((m) => /checks\.json/.test(m)), JSON.stringify(report.incomplete));
});

test("a missing job result after a host kill is a timeout failure; a job never run is a crash", () => {
  const { jobs } = buildJobs(selection, metas, recipe);
  const results = {};
  for (const j of jobs.slice(2)) results[j.id] = res();
  const report = buildReport({ plan: { jobs, errors: [], inspect: [], recipe }, results, hostExits: { j0001: 124 }, checks });
  assert.equal(report.verdict, "FAIL");
  assert.equal(report.plates.find((p) => p.id === "j0001").reason, "timeout");
  assert.equal(report.plates.find((p) => p.id === "j0002").reason, "crash");
});

test("a setup error means the gate could not run, not that it failed", () => {
  const { jobs } = buildJobs(selection, metas, recipe);
  const results = {};
  for (const j of jobs) results[j.id] = res();
  const report = buildReport({ plan: { jobs, errors: ["printer X missing"], inspect: [], recipe }, results, hostExits: {}, checks: null });
  assert.equal(report.verdict, "COULD-NOT-RUN");
  assert.deepEqual(report.setupErrors, ["printer X missing"]);
});

test("a plate failure outranks a setup error: one unexplained slicer error fails the gate", () => {
  const { jobs } = buildJobs(selection, metas, recipe);
  const results = {};
  for (const j of jobs) results[j.id] = res();
  results[jobs[0].id] = res({ returnCode: -100, errorString: "Failed slicing", timeSeconds: null, weightGrams: null });
  const report = buildReport({ plan: { jobs, errors: ["printer X missing"], inspect: [], recipe }, results, hostExits: {}, checks });
  assert.equal(report.verdict, "FAIL");
  assert.equal(report.counts.fail, 1, "the failed plate is still counted and listed");
  assert.deepEqual(report.setupErrors, ["printer X missing"], "the setup error is still reported");
});

test("a crashed plate fails the gate even when checks.json is missing", () => {
  const { jobs } = buildJobs(selection, metas, recipe);
  const results = {};
  for (const j of jobs.slice(1)) results[j.id] = res();
  const report = buildReport({ plan: { jobs, errors: [], inspect: [], recipe }, results, hostExits: {}, checks: null });
  assert.equal(report.plates.find((p) => p.id === jobs[0].id).reason, "crash");
  assert.equal(report.verdict, "FAIL");
  assert.ok(report.incomplete.some((m) => /checks\.json/.test(m)), "the missing checks are still reported");
});

test("a crashed plate fails the gate even when a setup error stopped other plates", () => {
  const { jobs } = buildJobs(selection, metas, recipe);
  const results = {};
  for (const j of jobs.slice(2)) results[j.id] = res();
  results[jobs[1].id] = { id: jobs[1].id, setupError: "no machine preset" };
  const report = buildReport({ plan: { jobs, errors: ["printer X missing"], inspect: [], recipe }, results, hostExits: {}, checks });
  assert.equal(report.plates.find((p) => p.id === jobs[0].id).reason, "crash");
  assert.equal(report.plates.find((p) => p.id === jobs[1].id).reason, "setup");
  assert.equal(report.verdict, "FAIL");
});

test("plates that never ran for a setup error are not failures: with nothing else failed the gate could not run", () => {
  const { jobs } = buildJobs(selection, metas, recipe);
  const results = {};
  for (const j of jobs.slice(1)) results[j.id] = res();
  results[jobs[0].id] = { id: jobs[0].id, setupError: "no machine preset" };
  const report = buildReport({ plan: { jobs, errors: ["printer X missing"], inspect: [], recipe }, results, hostExits: {}, checks });
  assert.equal(report.counts.fail, 1, "the setup plate is listed");
  assert.equal(report.verdict, "COULD-NOT-RUN");
});
